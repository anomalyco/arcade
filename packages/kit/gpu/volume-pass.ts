/**
 * The renderer's volumetric-light slots (`shaders.volume`). Each slot marches its shader at 1/`downscale` of the
 * internal size and adds the result into the HDR target: under temporal AA after the resolve (it never enters the TAA
 * history), otherwise into the resolved scene before smoke and bloom.
 *
 * A shader with `depth` also reads the stored scene depth and the unjittered `VolumeFrame` (binding 4); with `history`
 * it accumulates in its own half-resolution history (reprojected by depth through the previous unjittered
 * viewProj, clamped to the current 3×3 range padded by 25 %, reset on a cut) and comes back through a 4-tap
 * depth-aware upsample instead of the bilinear one, so poles and fences keep a clean edge.
 *
 * A shader with `color` also reads this frame's scene colour before the resolve (`sceneColor`, binding 20, internal
 * size, alpha carries the reflective-surface roughness of `@arcade/kit/gpu/reflections/surface`); one with `filter`
 * runs that pass over the march result before the history (screen-space reflections streak there). A slot's
 * `VolumeInput.params` reach both as `volumeParams` (binding 21).
 */

export type VolumeLightShader = {
  /** `@vertex fn vs` (fullscreen triangle) and `@fragment fn fs`: rgb in-scatter, a how much to restore colour. */
  code: string
  /** Bind the scene depth (`sceneDepth`, binding 3) and `VolumeFrame` (binding 4); the renderer keeps depth stored. */
  depth?: boolean
  /** Accumulate in an own history and upsample by depth (needs `depth`). */
  history?: boolean
  /** Bind this frame's scene colour before the temporal resolve (`sceneColor`, binding 20; needs `depth`). */
  color?: boolean
  /**
   * A fullscreen pass between the march and the history (`vs`, `fs`): reads the march as `volumeRaw` (binding 0) with
   * `volumeSamp` (1), plus `sceneDepth` (3), `V` (4), custom uniforms (13) and `volumeParams` (21). Needs `depth`.
   */
  filter?: string
  /**
   * Keep a copy of the scene's view depth (clip w; 1e9 for sky) at the slot's own resolution, the nearest of each
   * block, as `volumeLowDepth` (binding 22, r32float): a cheap, cache-friendly buffer to march rays against. Needs `depth`.
   */
  lowDepth?: boolean
}

/** Floats in a slot's own uniform (`VolumeInput.params`, binding 21: `array<vec4f, 8>`). */
export const VOLUME_PARAM_FLOATS = 32
export const VOLUME_COLOR_BINDING = 20
export const VOLUME_PARAMS_BINDING = 21
export const VOLUME_LOW_DEPTH_BINDING = 22
/** WGSL declaration of `volumeLowDepth` for shaders with `lowDepth`. */
export const volumeLowDepthWgsl = /* wgsl */ `@group(0) @binding(${VOLUME_LOW_DEPTH_BINDING}) var volumeLowDepth: texture_2d<f32>;`
/** WGSL declaration of `volumeParams` for shaders that read `VolumeInput.params`. */
export const volumeParamsWgsl = /* wgsl */ `@group(0) @binding(${VOLUME_PARAMS_BINDING}) var<uniform> volumeParams: array<vec4f, ${VOLUME_PARAM_FLOATS / 4}>;`

/** One slot's per-frame input (`FrameInput.volume`). */
export type VolumeInput = {
  downscale: number
  /** Screen rect [x0, y0, x1, y1] in 0..1 (top-left origin) that bounds the light; both passes skip the rest. */
  rect?: readonly [number, number, number, number]
  /** History response: the share of the new frame (default 0.1). */
  history?: number
  /** The slot's own uniforms (up to `VOLUME_PARAM_FLOATS`), `volumeParams` at binding 21. */
  params?: Float32Array
}

export const VOLUME_FRAME_FLOATS = 60

/** `VolumeFrame` (binding 4) and the depth helpers every depth-reading volume shader shares. */
export const volumeFrameWgsl = /* wgsl */ `
struct VolumeFrame {
  invViewProj: mat4x4f,   // unjittered
  viewProj: mat4x4f,      // unjittered
  prevViewProj: mat4x4f,  // unjittered, last frame
  eye: vec4f,             // eye xyz, frame index (0 without history: a static jitter)
  size: vec4f,            // volume target w, h, scene depth w, h
  params: vec4f,          // history response, history valid, depth clear value, downscale
}
@group(0) @binding(3) var sceneDepth: texture_depth_multisampled_2d;
@group(0) @binding(4) var<uniform> V: VolumeFrame;
fn volumeDepthAt(uv: vec2f) -> f32 {
  let s = vec2i(V.size.zw);
  return textureLoad(sceneDepth, clamp(vec2i(uv * V.size.zw), vec2i(0), s - 1), 0);
}
/** Nearest of the 2×2 scene-depth texels around uv. */
fn volumeDepth(uv: vec2f) -> f32 {
  let s = vec2i(V.size.zw);
  let p = vec2i(floor(uv * V.size.zw - 0.5));
  let a = textureLoad(sceneDepth, clamp(p, vec2i(0), s - 1), 0);
  let b = textureLoad(sceneDepth, clamp(p + vec2i(1, 0), vec2i(0), s - 1), 0);
  let c = textureLoad(sceneDepth, clamp(p + vec2i(0, 1), vec2i(0), s - 1), 0);
  let d = textureLoad(sceneDepth, clamp(p + vec2i(1, 1), vec2i(0), s - 1), 0);
  if (V.params.z < 0.5) { return max(max(a, b), max(c, d)); }
  return min(min(a, b), min(c, d));
}
/** The scene-depth texel under uv. Pixel centres of a 1/2 or 1/4 target land exactly on depth-texel edges, so derive
 * positions from the texel actually loaded (\`volumeWorldAtTexel\`), never from uv and a neighbour's depth. */
fn volumeTexel(uv: vec2f) -> vec2i { return clamp(vec2i(floor(uv * V.size.zw + 1e-3)), vec2i(0), vec2i(V.size.zw) - 1); }
fn volumeWorldAtTexel(t: vec2i) -> vec3f {
  let s = vec2i(V.size.zw);
  let c = clamp(t, vec2i(0), s - 1);
  let d = textureLoad(sceneDepth, c, 0);
  let uv = (vec2f(c) + 0.5) / V.size.zw;
  let h = V.invViewProj * vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, d, 1.0);
  return h.xyz / h.w;
}
/** Unit normal of the depth buffer at a texel: per axis the neighbour on the same surface (central difference unless
 * one side jumps by more than twice the other), facing the eye. */
fn volumeNormalAtTexel(t: vec2i, eye: vec3f) -> vec3f {
  let p = volumeWorldAtTexel(t);
  let ax = volumeWorldAtTexel(t + vec2i(1, 0)) - p;
  let bx = p - volumeWorldAtTexel(t - vec2i(1, 0));
  let ay = volumeWorldAtTexel(t + vec2i(0, 1)) - p;
  let by = p - volumeWorldAtTexel(t - vec2i(0, 1));
  let lx = dot(ax, ax) / max(dot(bx, bx), 1e-12);
  let ly = dot(ay, ay) / max(dot(by, by), 1e-12);
  let tx = select(select(bx, ax, lx < 1.0), (ax + bx) * 0.5, lx > 0.25 && lx < 4.0);
  let ty = select(select(by, ay, ly < 1.0), (ay + by) * 0.5, ly > 0.25 && ly < 4.0);
  var n = normalize(cross(ty, tx));
  if (dot(n, p - eye) > 0.0) { n = -n; }
  return n;
}
fn volumeIsSky(d: f32) -> bool { return select(d >= 0.999999, d <= 1e-6, V.params.z < 0.5); }
fn volumeUnproject(uv: vec2f, d: f32) -> vec3f {
  let h = V.invViewProj * vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, d, 1.0);
  return h.xyz / h.w;
}
/** View distance of the scene at uv (sky pushed to 3000 m). */
fn volumeDistance(uv: vec2f, d: f32) -> f32 {
  return select(length(volumeUnproject(uv, d) - V.eye.xyz), 3000.0, volumeIsSky(d));
}
`

const fullscreen = /* wgsl */ `
struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f }
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: VO;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}
`

export const volumeBilinearShader = /* wgsl */ `
@group(0) @binding(0) var volumeTex: texture_2d<f32>;
@group(0) @binding(1) var volumeSamp: sampler;
${fullscreen}
@fragment fn fs(o: VO) -> @location(0) vec4f {
  return textureSampleLevel(volumeTex, volumeSamp, o.uv, 0.0);
}
`

/** Temporal accumulation at the volume's own resolution. */
export const volumeAccumulateShader = /* wgsl */ `
@group(0) @binding(0) var curTex: texture_2d<f32>;
@group(0) @binding(1) var histTex: texture_2d<f32>;
@group(0) @binding(2) var histSamp: sampler;
${volumeFrameWgsl}
${fullscreen}
@fragment fn fs(o: VO) -> @location(0) vec4f {
  let size = vec2i(textureDimensions(curTex));
  let px = vec2i(o.pos.xy);
  let cur = textureLoad(curTex, px, 0);
  var mn = cur;
  var mx = cur;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let c = textureLoad(curTex, clamp(px + vec2i(x, y), vec2i(0), size - 1), 0);
      mn = min(mn, c);
      mx = max(mx, c);
    }
  }
  let uv = (vec2f(px) + 0.5) / vec2f(size);
  let d = volumeDepth(uv);
  var world = volumeUnproject(uv, d);
  if (volumeIsSky(d)) { world = V.eye.xyz + normalize(world - V.eye.xyz) * 3000.0; }
  let pc = V.prevViewProj * vec4f(world, 1.0);
  let puv = vec2f(pc.x / pc.w * 0.5 + 0.5, 0.5 - pc.y / pc.w * 0.5);
  let inside = pc.w > 0.0 && all(puv >= vec2f(0.0)) && all(puv <= vec2f(1.0));
  // The box spans the per-pixel jitter noise, so the history may average it; the pad lets a moving beam fade, not snap.
  let pad = (mx - mn) * 0.25;
  let prev = clamp(textureSampleLevel(histTex, histSamp, puv, 0.0), mn - pad, mx + pad);
  let motion = length((puv - uv) * vec2f(size));
  let a = select(1.0, mix(V.params.x, 1.0, clamp(motion / 2.0, 0.0, 1.0)), inside && V.params.y > 0.5);
  return mix(prev, cur, a);
}
`

/** Joint bilateral 4-tap upsample guided by the scene depth: 10 % apart in view distance is another surface. */
export const volumeUpsampleShader = /* wgsl */ `
@group(0) @binding(0) var volumeTex: texture_2d<f32>;
${volumeFrameWgsl}
${fullscreen}
@fragment fn fs(o: VO) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(volumeTex));
  let p = o.uv * size - 0.5;
  let base = floor(p);
  let f = p - base;
  // Sparse slots (reflections on the ground only) are zero over most of the screen: skip the depth weights there.
  var peak = 0.0;
  for (var y = 0; y < 2; y++) {
    for (var x = 0; x < 2; x++) {
      let v = textureLoad(volumeTex, clamp(vec2i(base) + vec2i(x, y), vec2i(0), vec2i(size) - 1), 0);
      peak = max(peak, max(max(abs(v.r), abs(v.g)), max(abs(v.b), abs(v.a))));
    }
  }
  if (peak == 0.0) { return vec4f(0.0); }
  let centre = volumeDistance(o.uv, volumeDepthAt(o.uv));
  var sum = vec4f(0.0);
  var wsum = 0.0;
  for (var y = 0; y < 2; y++) {
    for (var x = 0; x < 2; x++) {
      let at = clamp(vec2i(base) + vec2i(x, y), vec2i(0), vec2i(size) - 1);
      let tuv = (vec2f(at) + 0.5) / size;
      let dz = volumeDistance(tuv, volumeDepthAt(tuv));
      let bw = select(1.0 - f.x, f.x, x == 1) * select(1.0 - f.y, f.y, y == 1);
      let w = bw * exp(-abs(dz - centre) / (0.1 * centre + 0.05)) + 1e-4;
      sum += textureLoad(volumeTex, at, 0) * w;
      wsum += w;
    }
  }
  return sum / wsum;
}
`

/** Nearest view depth (clip w) of each block of scene-depth texels under one slot texel; sky is 1e9. */
export const volumeLowDepthShader = /* wgsl */ `
${volumeFrameWgsl}
${fullscreen}
@fragment fn fs(o: VO) -> @location(0) vec4f {
  let s = vec2i(V.size.zw);
  let k = max(1, i32(ceil(V.params.w)));
  let t0 = vec2i(floor(o.pos.xy * V.size.zw / V.size.xy));
  var w = 1e9;
  for (var y = 0; y < k; y++) {
    for (var x = 0; x < k; x++) {
      let t = clamp(t0 + vec2i(x, y), vec2i(0), s - 1);
      let d = textureLoad(sceneDepth, t, 0);
      if (!volumeIsSky(d)) {
        let uv = (vec2f(t) + 0.5) / V.size.zw;
        let h = V.invViewProj * vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, d, 1.0);
        w = min(w, 1.0 / h.w);
      }
    }
  }
  return vec4f(w, 0.0, 0.0, 0.0);
}
`

/** Buffers and sampler the renderer shares with every slot. */
export type VolumeShared = {
  frame: GPUBuffer
  lights: GPUBuffer
  polar: GPUBuffer
  custom: GPUBuffer
  fog: GPUBuffer
  fogLamps: GPUBuffer
  sampler: GPUSampler
  format: GPUTextureFormat
  compile: (code: string, label: string) => GPUShaderModule
}

/** Per-frame camera state for the depth-reading slots (all unjittered). */
export type VolumeView = {
  invViewProj: Float32Array
  viewProj: Float32Array
  prevViewProj: Float32Array
  eye: readonly [number, number, number]
  frame: number
  /** False on a cut: history restarts. */
  continuous: boolean
  depthView: GPUTextureView
  depthWidth: number
  depthHeight: number
  depthClear: number
  /** This frame's scene colour at the internal size, before the resolve (`color` slots). */
  colorView: GPUTextureView
}

const U = () => GPUBufferUsage
const T = () => GPUTextureUsage
const additiveKeepAlpha: GPUBlendState = { color: { srcFactor: "one", dstFactor: "one" }, alpha: { srcFactor: "zero", dstFactor: "one-minus-src-alpha" } }

export class VolumeSlot {
  readonly usesDepth: boolean
  readonly usesHistory: boolean
  readonly usesColor: boolean
  private readonly filterPipe: GPURenderPipeline | null = null
  private readonly filterLayout: GPUBindGroupLayout | null = null
  private filterGroup: GPUBindGroup | null = null
  private filtered: GPUTexture | null = null
  private readonly paramsBuf: GPUBuffer | null = null
  private boundColor: GPUTextureView | null = null
  private readonly lowDepthPipe: GPURenderPipeline | null = null
  private readonly lowDepthLayout: GPUBindGroupLayout | null = null
  private lowDepthGroup: GPUBindGroup | null = null
  private lowDepthTex: GPUTexture | null = null
  private readonly march: GPURenderPipeline
  private readonly marchLayout: GPUBindGroupLayout
  private readonly compositePipe: GPURenderPipeline
  private readonly compositeLayout: GPUBindGroupLayout
  private readonly accumulatePipe: GPURenderPipeline | null = null
  private readonly accumulateLayout: GPUBindGroupLayout | null = null
  private readonly frameBuf: GPUBuffer | null = null
  private readonly frameData = new Float32Array(VOLUME_FRAME_FLOATS)
  private tex: GPUTexture | null = null
  private hist: GPUTexture[] = []
  private histIndex = 0
  private histValid = false
  private boundDepth: GPUTextureView | null = null
  private marchGroup: GPUBindGroup | null = null
  private compositeGroups: GPUBindGroup[] = []
  private accumulateGroups: GPUBindGroup[] = []

  constructor(private readonly device: GPUDevice, shader: VolumeLightShader, private readonly shared: VolumeShared, index: number) {
    const d = device
    const S = GPUShaderStage
    this.usesDepth = !!shader.depth || !!shader.history || !!shader.color || !!shader.filter || !!shader.lowDepth
    this.usesHistory = !!shader.history
    this.usesColor = !!shader.color
    const entries: GPUBindGroupLayoutEntry[] = [
      { binding: 0, visibility: S.FRAGMENT, buffer: { type: "uniform" } },
      { binding: 1, visibility: S.FRAGMENT, buffer: { type: "read-only-storage" } },
      { binding: 2, visibility: S.FRAGMENT, buffer: { type: "read-only-storage" } },
      { binding: 13, visibility: S.FRAGMENT, buffer: { type: "uniform" } },
    ]
    if (this.usesDepth) {
      entries.push(
        { binding: 3, visibility: S.FRAGMENT, texture: { sampleType: "depth", multisampled: true } },
        { binding: 4, visibility: S.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 18, visibility: S.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 19, visibility: S.FRAGMENT, buffer: { type: "read-only-storage" } },
      )
      this.frameBuf = d.createBuffer({ label: `volume ${index} frame`, size: VOLUME_FRAME_FLOATS * 4, usage: U().UNIFORM | U().COPY_DST })
      this.paramsBuf = d.createBuffer({ label: `volume ${index} params`, size: VOLUME_PARAM_FLOATS * 4, usage: U().UNIFORM | U().COPY_DST })
      entries.push({ binding: VOLUME_PARAMS_BINDING, visibility: S.FRAGMENT, buffer: { type: "uniform" } })
      if (this.usesColor) entries.push({ binding: VOLUME_COLOR_BINDING, visibility: S.FRAGMENT, texture: { sampleType: "unfilterable-float" } })
      if (shader.lowDepth) entries.push({ binding: VOLUME_LOW_DEPTH_BINDING, visibility: S.FRAGMENT, texture: { sampleType: "unfilterable-float" } })
    }
    if (shader.lowDepth) {
      this.lowDepthLayout = d.createBindGroupLayout({
        entries: [
          { binding: 3, visibility: S.FRAGMENT, texture: { sampleType: "depth", multisampled: true } },
          { binding: 4, visibility: S.FRAGMENT, buffer: { type: "uniform" } },
        ],
      })
      const lm = shared.compile(volumeLowDepthShader, "volume low depth")
      this.lowDepthPipe = d.createRenderPipeline({
        label: `volume ${index} low depth`,
        layout: d.createPipelineLayout({ bindGroupLayouts: [this.lowDepthLayout] }),
        vertex: { module: lm, entryPoint: "vs" },
        fragment: { module: lm, entryPoint: "fs", targets: [{ format: "r32float" }] },
        primitive: { topology: "triangle-list" },
      })
    }
    this.marchLayout = d.createBindGroupLayout({ entries })
    const mod = shared.compile(shader.code, `volume light ${index}`)
    this.march = d.createRenderPipeline({
      label: `volume ${index} march`,
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.marchLayout] }),
      vertex: { module: mod, entryPoint: "vs" },
      fragment: { module: mod, entryPoint: "fs", targets: [{ format: shared.format }] },
      primitive: { topology: "triangle-list" },
    })
    if (shader.filter) {
      this.filterLayout = d.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: S.FRAGMENT, texture: {} },
          { binding: 1, visibility: S.FRAGMENT, sampler: {} },
          { binding: 3, visibility: S.FRAGMENT, texture: { sampleType: "depth", multisampled: true } },
          { binding: 4, visibility: S.FRAGMENT, buffer: { type: "uniform" } },
          { binding: 13, visibility: S.FRAGMENT, buffer: { type: "uniform" } },
          { binding: VOLUME_PARAMS_BINDING, visibility: S.FRAGMENT, buffer: { type: "uniform" } },
        ],
      })
      const fm = shared.compile(shader.filter, `volume ${index} filter`)
      this.filterPipe = d.createRenderPipeline({
        label: `volume ${index} filter`,
        layout: d.createPipelineLayout({ bindGroupLayouts: [this.filterLayout] }),
        vertex: { module: fm, entryPoint: "vs" },
        fragment: { module: fm, entryPoint: "fs", targets: [{ format: shared.format }] },
        primitive: { topology: "triangle-list" },
      })
    }
    if (this.usesHistory) {
      this.accumulateLayout = d.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: S.FRAGMENT, texture: {} },
          { binding: 1, visibility: S.FRAGMENT, texture: {} },
          { binding: 2, visibility: S.FRAGMENT, sampler: {} },
          { binding: 3, visibility: S.FRAGMENT, texture: { sampleType: "depth", multisampled: true } },
          { binding: 4, visibility: S.FRAGMENT, buffer: { type: "uniform" } },
        ],
      })
      const acc = shared.compile(volumeAccumulateShader, "volume accumulate")
      this.accumulatePipe = d.createRenderPipeline({
        label: `volume ${index} accumulate`,
        layout: d.createPipelineLayout({ bindGroupLayouts: [this.accumulateLayout] }),
        vertex: { module: acc, entryPoint: "vs" },
        fragment: { module: acc, entryPoint: "fs", targets: [{ format: shared.format }] },
        primitive: { topology: "triangle-list" },
      })
    }
    this.compositeLayout = d.createBindGroupLayout({
      entries: this.usesDepth
        ? [
            { binding: 0, visibility: S.FRAGMENT, texture: {} },
            { binding: 3, visibility: S.FRAGMENT, texture: { sampleType: "depth", multisampled: true } },
            { binding: 4, visibility: S.FRAGMENT, buffer: { type: "uniform" } },
          ]
        : [
            { binding: 0, visibility: S.FRAGMENT, texture: {} },
            { binding: 1, visibility: S.FRAGMENT, sampler: {} },
          ],
    })
    const comp = shared.compile(this.usesDepth ? volumeUpsampleShader : volumeBilinearShader, this.usesDepth ? "volume upsample" : "volume composite")
    this.compositePipe = d.createRenderPipeline({
      label: `volume ${index} composite`,
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.compositeLayout] }),
      vertex: { module: comp, entryPoint: "vs" },
      fragment: { module: comp, entryPoint: "fs", targets: [{ format: shared.format, blend: additiveKeepAlpha }] },
      primitive: { topology: "triangle-list" },
    })
  }

  /** Drops the history (camera cut, new level, resize). */
  resetHistory(): void {
    this.histValid = false
  }

  private ensureTargets(w: number, h: number, view: VolumeView | null): void {
    const d = this.device
    const resized = !this.tex || this.tex.width !== w || this.tex.height !== h
    if (resized) {
      this.tex?.destroy()
      this.filtered?.destroy()
      for (const t of this.hist) t.destroy()
      const usage = T().RENDER_ATTACHMENT | T().TEXTURE_BINDING
      this.tex = d.createTexture({ label: "volume", size: [w, h], format: this.shared.format, usage })
      this.filtered = this.filterPipe ? d.createTexture({ label: "volume filtered", size: [w, h], format: this.shared.format, usage }) : null
      this.lowDepthTex?.destroy()
      this.lowDepthTex = this.lowDepthPipe ? d.createTexture({ label: "volume low depth", size: [w, h], format: "r32float", usage }) : null
      this.hist = this.usesHistory ? [0, 1].map(() => d.createTexture({ label: "volume history", size: [w, h], format: this.shared.format, usage })) : []
      this.histValid = false
    }
    const depth = view?.depthView ?? null
    const color = this.usesColor ? (view?.colorView ?? null) : null
    if (!resized && this.marchGroup && depth === this.boundDepth && color === this.boundColor) return
    this.boundDepth = depth
    this.boundColor = color
    const sh = this.shared
    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: sh.frame } },
      { binding: 1, resource: { buffer: sh.lights } },
      { binding: 2, resource: { buffer: sh.polar } },
      { binding: 13, resource: { buffer: sh.custom } },
    ]
    if (this.usesDepth) {
      entries.push(
        { binding: 3, resource: depth! },
        { binding: 4, resource: { buffer: this.frameBuf! } },
        { binding: 18, resource: { buffer: sh.fog } },
        { binding: 19, resource: { buffer: sh.fogLamps } },
        { binding: VOLUME_PARAMS_BINDING, resource: { buffer: this.paramsBuf! } },
      )
      if (color) entries.push({ binding: VOLUME_COLOR_BINDING, resource: color })
      if (this.lowDepthTex) entries.push({ binding: VOLUME_LOW_DEPTH_BINDING, resource: this.lowDepthTex.createView() })
    }
    if (this.lowDepthPipe) {
      this.lowDepthGroup = d.createBindGroup({
        layout: this.lowDepthLayout!,
        entries: [
          { binding: 3, resource: depth! },
          { binding: 4, resource: { buffer: this.frameBuf! } },
        ],
      })
    }
    this.marchGroup = d.createBindGroup({ layout: this.marchLayout, entries })
    if (this.filterPipe) {
      this.filterGroup = d.createBindGroup({
        layout: this.filterLayout!,
        entries: [
          { binding: 0, resource: this.tex!.createView() },
          { binding: 1, resource: sh.sampler },
          { binding: 3, resource: depth! },
          { binding: 4, resource: { buffer: this.frameBuf! } },
          { binding: 13, resource: { buffer: sh.custom } },
          { binding: VOLUME_PARAMS_BINDING, resource: { buffer: this.paramsBuf! } },
        ],
      })
    }
    if (this.usesHistory) {
      // Group k reads history k and writes history 1 - k; the composite then reads what was written.
      this.accumulateGroups = [0, 1].map((k) =>
        d.createBindGroup({
          layout: this.accumulateLayout!,
          entries: [
            { binding: 0, resource: (this.filtered ?? this.tex!).createView() },
            { binding: 1, resource: this.hist[k]!.createView() },
            { binding: 2, resource: sh.sampler },
            { binding: 3, resource: depth! },
            { binding: 4, resource: { buffer: this.frameBuf! } },
          ],
        }),
      )
    }
    const sources = this.usesHistory ? this.hist : [this.filtered ?? this.tex!]
    this.compositeGroups = sources.map((t) =>
      d.createBindGroup({
        layout: this.compositeLayout,
        entries: this.usesDepth
          ? [
              { binding: 0, resource: t.createView() },
              { binding: 3, resource: depth! },
              { binding: 4, resource: { buffer: this.frameBuf! } },
            ]
          : [
              { binding: 0, resource: t.createView() },
              { binding: 1, resource: sh.sampler },
            ],
      }),
    )
  }

  /**
   * Marches the slot at 1/`input.downscale` of `internalWidth` × `internalHeight`, accumulates when it keeps a history,
   * and adds it into `target` (`tw` × `th`).
   */
  draw(
    enc: GPUCommandEncoder,
    input: VolumeInput,
    internalWidth: number,
    internalHeight: number,
    view: VolumeView | null,
    target: GPUTextureView,
    tw: number,
    th: number,
  ): void {
    const downscale = Math.max(1, input.downscale)
    const w = Math.max(1, Math.ceil(internalWidth / downscale))
    const h = Math.max(1, Math.ceil(internalHeight / downscale))
    if (this.usesDepth && !view) return
    this.ensureTargets(w, h, view)
    const r = input.rect ?? [0, 0, 1, 1]
    if (r[2] <= r[0] || r[3] <= r[1]) {
      this.histValid = false
      return
    }
    if (this.usesDepth && view) {
      if (!view.continuous) this.histValid = false
      const f = this.frameData
      f.set(view.invViewProj, 0)
      f.set(view.viewProj, 16)
      f.set(view.prevViewProj, 32)
      f.set([view.eye[0], view.eye[1], view.eye[2], this.usesHistory ? view.frame % 64 : 0], 48)
      f.set([w, h, view.depthWidth, view.depthHeight], 52)
      f.set([Math.min(1, Math.max(0.01, input.history ?? 0.1)), this.histValid ? 1 : 0, view.depthClear, downscale], 56)
      this.device.queue.writeBuffer(this.frameBuf!, 0, f)
      if (input.params) this.device.queue.writeBuffer(this.paramsBuf!, 0, input.params.buffer, input.params.byteOffset, Math.min(input.params.byteLength, VOLUME_PARAM_FLOATS * 4))
    }
    const scissor = (pass: GPURenderPassEncoder, sw: number, sh: number) => {
      const x0 = Math.max(0, Math.floor(r[0] * sw))
      const y0 = Math.max(0, Math.floor(r[1] * sh))
      const x1 = Math.min(sw, Math.ceil(r[2] * sw))
      const y1 = Math.min(sh, Math.ceil(r[3] * sh))
      pass.setScissorRect(x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0))
    }
    if (this.lowDepthPipe) {
      const lp = enc.beginRenderPass({ colorAttachments: [{ view: this.lowDepthTex!.createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 1e9, g: 0, b: 0, a: 0 } }] })
      scissor(lp, w, h)
      lp.setPipeline(this.lowDepthPipe)
      lp.setBindGroup(0, this.lowDepthGroup!)
      lp.draw(3)
      lp.end()
    }
    const march = enc.beginRenderPass({ colorAttachments: [{ view: this.tex!.createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }] })
    scissor(march, w, h)
    march.setPipeline(this.march)
    march.setBindGroup(0, this.marchGroup!)
    march.draw(3)
    march.end()
    if (this.filterPipe) {
      const fp = enc.beginRenderPass({ colorAttachments: [{ view: this.filtered!.createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }] })
      scissor(fp, w, h)
      fp.setPipeline(this.filterPipe)
      fp.setBindGroup(0, this.filterGroup!)
      fp.draw(3)
      fp.end()
    }
    let source = 0
    if (this.usesHistory) {
      const read = this.histIndex
      const write = 1 - read
      const acc = enc.beginRenderPass({ colorAttachments: [{ view: this.hist[write]!.createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }] })
      acc.setPipeline(this.accumulatePipe!)
      acc.setBindGroup(0, this.accumulateGroups[read]!)
      acc.draw(3)
      acc.end()
      this.histIndex = write
      this.histValid = true
      source = write
    }
    const add = enc.beginRenderPass({ colorAttachments: [{ view: target, loadOp: "load", storeOp: "store" }] })
    scissor(add, tw, th)
    add.setPipeline(this.compositePipe)
    add.setBindGroup(0, this.compositeGroups[source]!)
    add.draw(3)
    add.end()
  }

  destroy(): void {
    this.tex?.destroy()
    this.filtered?.destroy()
    this.lowDepthTex?.destroy()
    for (const t of this.hist) t.destroy()
    this.frameBuf?.destroy()
    this.paramsBuf?.destroy()
  }
}
