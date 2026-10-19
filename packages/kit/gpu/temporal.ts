/**
 * Temporal anti-aliasing and upscaling (TAA / TAAU) for the shared renderer, after three.js r186's `TRAANode` and
 * `TAAUNode` (examples/jsm/tsl/display) and FSR1's RCAS sharpen.
 *
 * The scene renders at an internal resolution (render scale per axis) with a Halton(2,3) sub-pixel jitter on the
 * view-projection. The resolve reconstructs each output pixel from the 3×3 jittered input taps around it (Gaussian
 * Blackman-Harris weights), reprojects the history by depth (the closest of the 3×3 taps, so edges follow the
 * foreground), rejects it where the previous frame's depth disagrees (disocclusion) or it falls off screen, clips it
 * to the YCoCg variance box of the neighbourhood (tighter when moving), and blends in a reversible tone-compressed
 * space so bright sparks don't dominate. A reactive mask (sprites re-drawn without depth) raises the current weight
 * where alpha and additive effects move without depth. History stays unsharpened; RCAS runs on the way out.
 *
 * Reprojection is camera-only: the world, which is most of a top-down frame, reprojects exactly; moving actors without
 * a velocity buffer fall back to the disocclusion test and the clip, and keep their MSAA edges.
 */
import { mat4 } from "wgpu-matrix"

export type AntiAliasingMode = "msaa" | "taa" | "taau"

export type TemporalSettings = {
  /** "msaa": today's 4× MSAA only. "taa": MSAA + temporal resolve at native size. "taau": temporal upscale. */
  mode: AntiAliasingMode
  /** Internal render scale per axis for "taau" (0.5..1). "taa" always renders at 1. */
  renderScale: number
  /** RCAS sharpen after the resolve: 0 off .. 1 strongest. */
  sharpen: number
  /** Weight of the reprojected history in a still, fully valid pixel (0.5..0.98). */
  history: number
}

export const TEMPORAL_DEFAULTS: TemporalSettings = { mode: "msaa", renderScale: 0.67, sharpen: 0.35, history: 0.9 }

/** Relative linear-depth mismatch above which the history is treated as disoccluded. */
export const TEMPORAL_DEPTH_REJECT = 0.012
/** Mask value that makes a pixel fully reactive (mask × gain, saturated). */
export const TEMPORAL_REACTIVE_GAIN = 2.5
/** Eye jump (world units) between frames that counts as a camera cut and drops the history. */
export const TEMPORAL_CUT_DISTANCE = 4

export function temporalEnabled(s: TemporalSettings | null | undefined): s is TemporalSettings {
  return !!s && s.mode !== "msaa"
}

/** Internal render scale per axis for these settings (1 unless upscaling). */
export function temporalScale(s: TemporalSettings | null | undefined): number {
  if (!s || s.mode !== "taau") return 1
  return Math.min(1, Math.max(0.5, s.renderScale))
}

export function internalSize(w: number, h: number, scale: number): [number, number] {
  return [Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale))]
}

export function halton(index: number, base: number): number {
  let f = 1
  let r = 0
  let i = index
  while (i > 0) {
    f /= base
    r += f * (i % base)
    i = Math.floor(i / base)
  }
  return r
}

/** Jitter phases: enough that each output pixel sees ~8 distinct input samples (8 at native, 18 at 0.67, 32 at 0.5). */
export function jitterPhases(scale: number): number {
  return Math.min(32, Math.max(8, Math.ceil(8 / (scale * scale))))
}

/** Sub-pixel jitter (input pixels, x right, y down) for frame `index`, each in (-0.5, 0.5). */
export function temporalJitter(index: number, phases: number): [number, number] {
  const k = (index % phases) + 1
  return [halton(k, 2) - 0.5, halton(k, 3) - 0.5]
}

/**
 * Offsets a column-major view-projection in place by (jx, jy) pixels of a w×h target, so a world point that projected
 * to pixel position u now lands at u + (jx, jy).
 */
export function jitterViewProj(vp: Float32Array, jx: number, jy: number, w: number, h: number): void {
  const ox = (2 * jx) / w
  const oy = (-2 * jy) / h
  for (let c = 0; c < 4; c++) {
    vp[c * 4] = vp[c * 4]! + ox * vp[c * 4 + 3]!
    vp[c * 4 + 1] = vp[c * 4 + 1]! + oy * vp[c * 4 + 3]!
  }
}

/** Uniform block shared by every temporal pass (48 floats). */
export const TEMPORAL_UNIFORM_FLOATS = 48

const uniformStruct = /* wgsl */ `
struct Temporal {
  reproject: mat4x4f, // previous view-projection × inverse(current), both unjittered: current NDC -> previous clip
  invCur: mat4x4f,    // inverse(current view-projection), unjittered
  jitter: vec4f,      // jitter px x, y (input pixels, y down), base current weight, history valid (0/1)
  sizes: vec4f,       // input w, h, output w, h
  params: vec4f,      // depth reject (relative), RCAS strength, reactive gain, unused
}
struct VO { @builtin(position) pos: vec4f }
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: VO;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  return o;
}
// Reversible max-channel tone curve: bright HDR samples don't dominate the filter, the clip or the blend.
fn compress(c: vec3f) -> vec3f { return c / (1.0 + max(c.r, max(c.g, c.b))); }
fn expand(c: vec3f) -> vec3f { return c / max(1.0 - max(c.r, max(c.g, c.b)), 1.0 / 4096.0); }
// Unjittered NDC of input texel q's sample (it shows the scene at pixel position q + 0.5 - jitter).
fn sampleNdc(q: vec2i) -> vec2f {
  let s = vec2f(q) + 0.5 - U.jitter.xy;
  return vec2f(s.x / U.sizes.x * 2.0 - 1.0, 1.0 - s.y / U.sizes.y * 2.0);
}
`

function depthDecl(samples: number): string {
  return samples > 1 ? "texture_depth_multisampled_2d" : "texture_depth_2d"
}

/** Resolve: current input, depth, previous linear depth, history, reactive mask -> new history (and output). */
export function temporalResolveShader(samples: number): string {
  return /* wgsl */ `
@group(0) @binding(0) var curTex: texture_2d<f32>;
@group(0) @binding(1) var depthTex: ${depthDecl(samples)};
@group(0) @binding(2) var prevLinTex: texture_2d<f32>;
@group(0) @binding(3) var historyTex: texture_2d<f32>;
@group(0) @binding(4) var linearSamp: sampler;
@group(0) @binding(5) var reactiveTex: texture_2d<f32>;
@group(0) @binding(6) var<uniform> U: Temporal;
${uniformStruct}
fn toYCoCg(c: vec3f) -> vec3f {
  return vec3f(0.25 * c.r + 0.5 * c.g + 0.25 * c.b, 0.5 * c.r - 0.5 * c.b, -0.25 * c.r + 0.5 * c.g - 0.25 * c.b);
}
fn fromYCoCg(c: vec3f) -> vec3f {
  let t = c.x - c.z;
  return vec3f(t + c.y, c.x + c.z, t - c.y);
}
// Bicubic Catmull-Rom in 5 bilinear taps: keeps the history sharp while it is resampled every frame.
fn sampleHistory(uv: vec2f) -> vec4f {
  let size = U.sizes.zw;
  let pos = uv * size;
  let c = floor(pos - 0.5) + 0.5;
  let f = pos - c;
  let w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  let w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  let w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  let w3 = f * f * (-0.5 + 0.5 * f);
  let w12 = w1 + w2;
  let t0 = (c - 1.0) / size;
  let t3 = (c + 2.0) / size;
  let t12 = (c + w2 / w12) / size;
  let a = w12.x * w0.y;
  let b = w0.x * w12.y;
  let m = w12.x * w12.y;
  let d = w3.x * w12.y;
  let e = w12.x * w3.y;
  let r = textureSampleLevel(historyTex, linearSamp, vec2f(t12.x, t0.y), 0.0) * a
    + textureSampleLevel(historyTex, linearSamp, vec2f(t0.x, t12.y), 0.0) * b
    + textureSampleLevel(historyTex, linearSamp, t12, 0.0) * m
    + textureSampleLevel(historyTex, linearSamp, vec2f(t3.x, t12.y), 0.0) * d
    + textureSampleLevel(historyTex, linearSamp, vec2f(t12.x, t3.y), 0.0) * e;
  return max(r / (a + b + m + d + e), vec4f(0.0));
}
fn clipToBox(h: vec3f, lo: vec3f, hi: vec3f) -> vec3f {
  let centre = 0.5 * (hi + lo);
  let extent = 0.5 * (hi - lo) + 1e-6;
  let v = h - centre;
  let u = abs(v / extent);
  let m = max(u.x, max(u.y, u.z));
  return select(h, centre + v / m, m > 1.0);
}
fn resolveAt(frag: vec2f) -> vec4f {
  let inSize = U.sizes.xy;
  let outSize = U.sizes.zw;
  let uv = frag / outSize;
  let pIn = uv * inSize;
  let maxTap = vec2i(inSize) - 1;
  let centre = clamp(vec2i(round(pIn - 0.5 + U.jitter.xy)), vec2i(0), maxTap);
  // Two reconstructions of the current frame: a tight kernel in output pixels to accumulate (sharp once converged)
  // and a wider one in input pixels for pixels without history (disoccluded or reactive), where one sample shows.
  var sum = vec4f(0.0);
  var wsum = 0.0;
  var soft = vec4f(0.0);
  var wsoft = 0.0;
  var m1 = vec3f(0.0);
  var m2 = vec3f(0.0);
  var lo = vec4f(1e9);
  var hi = vec4f(-1e9);
  var closest = 2.0;
  var closestTap = centre;
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let q = clamp(centre + vec2i(dx, dy), vec2i(0), maxTap);
      let raw = textureLoad(curTex, q, 0);
      let c = vec4f(compress(max(raw.rgb, vec3f(0.0))), clamp(raw.a, 0.0, 1.0));
      let y = vec4f(toYCoCg(c.rgb), c.a);
      let delta = pIn - (vec2f(q) + 0.5 - U.jitter.xy);
      let deltaOut = delta * outSize / inSize;
      let w = exp(-2.29 * dot(deltaOut, deltaOut));
      sum += c * w;
      wsum += w;
      let ws = exp(-2.29 * dot(delta, delta));
      soft += c * ws;
      wsoft += ws;
      m1 += y.xyz;
      m2 += y.xyz * y.xyz;
      lo = min(lo, y);
      hi = max(hi, y);
      let z = textureLoad(depthTex, q, 0);
      if (z < closest) {
        closest = z;
        closestTap = q;
      }
    }
  }
  let sharp = sum / max(wsum, 1e-5);
  let wide = soft / max(wsoft, 1e-5);

  // Reproject the closest tap by depth (camera motion), and test the previous frame's depth there.
  let ndc = sampleNdc(closestTap);
  let p4 = vec4f(ndc, closest, 1.0);
  let world = U.invCur * p4;
  let prevClip = U.reproject * p4;
  let prevNdc = prevClip.xy / prevClip.w;
  let historyUv = uv + (prevNdc - ndc) * vec2f(0.5, -0.5);
  let expectedLin = prevClip.w / world.w;
  var valid = U.jitter.w > 0.5 && prevClip.w > 1e-6 && expectedLin > 0.0
    && all(historyUv >= vec2f(0.0)) && all(historyUv <= vec2f(1.0));
  if (valid) {
    let base = vec2i(floor(historyUv * inSize - 0.5));
    var best = 1e9;
    for (var k = 0; k < 4; k++) {
      let q = clamp(base + vec2i(k & 1, k >> 1), vec2i(0), maxTap);
      let prevLin = textureLoad(prevLinTex, q, 0).r;
      best = min(best, abs(prevLin - expectedLin) / expectedLin);
    }
    valid = best < U.params.x;
  }

  // Variance clip in YCoCg: generous when still (stable), tighter when moving.
  let motionPx = length((historyUv - uv) * outSize);
  let moving = saturate(motionPx / 24.0);
  let mean = m1 / 9.0;
  let sigma = sqrt(max(m2 / 9.0 - mean * mean, vec3f(0.0)));
  let gamma = mix(1.0, 0.75, moving);
  let boxLo = mean - gamma * sigma;
  let boxHi = mean + gamma * sigma;
  let history = sampleHistory(historyUv);
  let hc = compress(history.rgb);
  let hy = clipToBox(toYCoCg(hc), boxLo, boxHi);
  let ha = clamp(history.a, lo.w, hi.w);

  let rm = textureLoad(reactiveTex, centre, 0);
  let reactive = saturate(max(max(rm.r, rm.g), max(rm.b, rm.a)) * U.params.z);
  var cw = U.jitter.z + 0.2 * saturate(motionPx / 48.0);
  cw = mix(cw, 0.8, reactive);
  cw = select(1.0, saturate(cw), valid);
  let current = mix(sharp, wide, select(1.0, reactive, valid));
  let outY = mix(hy, toYCoCg(current.rgb), cw);
  return vec4f(expand(max(fromYCoCg(outY), vec3f(0.0))), mix(ha, current.a, cw));
}
@fragment fn resolve(o: VO) -> @location(0) vec4f {
  return resolveAt(o.pos.xy);
}
struct Both { @location(0) history: vec4f, @location(1) output: vec4f }
@fragment fn resolveBoth(o: VO) -> Both {
  let c = resolveAt(o.pos.xy);
  return Both(c, c);
}
`
}

/** Linear depth (clip w) of this frame's samples, read as the previous depth next frame. */
export function temporalLinearizeShader(samples: number): string {
  return /* wgsl */ `
@group(0) @binding(1) var depthTex: ${depthDecl(samples)};
@group(0) @binding(6) var<uniform> U: Temporal;
${uniformStruct}
@fragment fn linearize(o: VO) -> @location(0) vec4f {
  let q = vec2i(o.pos.xy);
  let z = textureLoad(depthTex, q, 0);
  let w = U.invCur * vec4f(sampleNdc(q), z, 1.0);
  return vec4f(select(1e9, 1.0 / w.w, w.w > 1e-9), 0.0, 0.0, 1.0);
}
`
}

/** RCAS (FSR1's robust contrast-adaptive sharpen) on the tone-compressed history. */
export const temporalSharpenShader = /* wgsl */ `
@group(0) @binding(3) var srcTex: texture_2d<f32>;
@group(0) @binding(6) var<uniform> U: Temporal;
${uniformStruct}
fn tap(p: vec2i) -> vec3f {
  return compress(max(textureLoad(srcTex, clamp(p, vec2i(0), vec2i(U.sizes.zw) - 1), 0).rgb, vec3f(0.0)));
}
@fragment fn sharpen(o: VO) -> @location(0) vec4f {
  let p = vec2i(o.pos.xy);
  let centre = textureLoad(srcTex, p, 0);
  let e = compress(max(centre.rgb, vec3f(0.0)));
  let b = tap(p + vec2i(0, -1));
  let d = tap(p + vec2i(-1, 0));
  let f = tap(p + vec2i(1, 0));
  let h = tap(p + vec2i(0, 1));
  let mn4 = min(min(b, d), min(f, h));
  let mx4 = max(max(b, d), max(f, h));
  let hitMin = min(mn4, e) / max(4.0 * mx4, vec3f(1e-5));
  let hitMax = (1.0 - max(mx4, e)) / min(4.0 * mn4 - 4.0, vec3f(-1e-5));
  let lobeRgb = max(-hitMin, hitMax);
  let lobe = max(-0.1875, min(max(lobeRgb.r, max(lobeRgb.g, lobeRgb.b)), 0.0)) * U.params.y;
  let r = (lobe * (b + d + f + h) + e) / (4.0 * lobe + 1.0);
  return vec4f(expand(max(r, vec3f(0.0))), centre.a);
}
`

const TEX_RENDER = globalThis.GPUTextureUsage?.RENDER_ATTACHMENT ?? 0x10
const TEX_BIND = globalThis.GPUTextureUsage?.TEXTURE_BINDING ?? 0x04
const TEX_COPY_SRC = globalThis.GPUTextureUsage?.COPY_SRC ?? 0x01

export type TemporalState = {
  mode: AntiAliasingMode
  scale: number
  input: [number, number]
  output: [number, number]
  phase: number
  phases: number
  historyValid: boolean
  resets: number
}

/**
 * GPU side of the temporal resolve: history ping-pong and output at the output size, previous linear depth and the
 * reactive mask at the input size, and the resolve, sharpen and linearize passes.
 */
export class TemporalResolve {
  outW = 0
  outH = 0
  inW = 0
  inH = 0
  output!: GPUTexture
  outputView!: GPUTextureView
  reactive!: GPUTexture
  reactiveView!: GPUTextureView
  /** History resets so far (cuts, resizes, mode changes); for telemetry. */
  resets = 0
  private history: GPUTexture[] = []
  private historyViews: GPUTextureView[] = []
  private prevLin!: GPUTexture
  private prevLinView!: GPUTextureView
  private parity = 0
  private valid = false
  private frameIndex = 0
  private phases = 8
  private readonly uniforms = new Float32Array(TEMPORAL_UNIFORM_FLOATS)
  private readonly uniformBuf: GPUBuffer
  private readonly sampler: GPUSampler
  private readonly resolveLayout: GPUBindGroupLayout
  private readonly resolvePipe: GPURenderPipeline
  private readonly resolveBothPipe: GPURenderPipeline
  private readonly linearizePipe: GPURenderPipeline
  private readonly sharpenPipe: GPURenderPipeline
  private readonly prevVP = new Float32Array(16)
  private readonly invCur = new Float32Array(16)
  private readonly reproject = new Float32Array(16)
  private readonly lastEye = new Float32Array(3)
  private hasPrev = false
  private groups: { input: GPUTextureView; depth: GPUTextureView; resolve: GPUBindGroup[]; linearize: GPUBindGroup; sharpen: GPUBindGroup[] } | null = null

  constructor(
    private readonly device: GPUDevice,
    private readonly format: GPUTextureFormat,
    private readonly samples: number,
  ) {
    const d = device
    const S = GPUShaderStage
    this.uniformBuf = d.createBuffer({ size: TEMPORAL_UNIFORM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.sampler = d.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" })
    this.resolveLayout = d.createBindGroupLayout({
      label: "temporal resolve",
      entries: [
        { binding: 0, visibility: S.FRAGMENT, texture: { sampleType: "unfilterable-float" } },
        { binding: 1, visibility: S.FRAGMENT, texture: { sampleType: "depth", multisampled: samples > 1 } },
        { binding: 2, visibility: S.FRAGMENT, texture: { sampleType: "unfilterable-float" } },
        { binding: 3, visibility: S.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 4, visibility: S.FRAGMENT, sampler: { type: "filtering" } },
        { binding: 5, visibility: S.FRAGMENT, texture: { sampleType: "unfilterable-float" } },
        { binding: 6, visibility: S.FRAGMENT, buffer: { type: "uniform" } },
      ],
    })
    const resolveMod = d.createShaderModule({ label: "temporal resolve", code: temporalResolveShader(samples) })
    const layout = d.createPipelineLayout({ bindGroupLayouts: [this.resolveLayout] })
    this.resolvePipe = d.createRenderPipeline({
      label: "temporal resolve",
      layout,
      vertex: { module: resolveMod, entryPoint: "vs" },
      fragment: { module: resolveMod, entryPoint: "resolve", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
    })
    this.resolveBothPipe = d.createRenderPipeline({
      label: "temporal resolve + output",
      layout,
      vertex: { module: resolveMod, entryPoint: "vs" },
      fragment: { module: resolveMod, entryPoint: "resolveBoth", targets: [{ format }, { format }] },
      primitive: { topology: "triangle-list" },
    })
    const linMod = d.createShaderModule({ label: "temporal linearize", code: temporalLinearizeShader(samples) })
    this.linearizePipe = d.createRenderPipeline({
      label: "temporal linearize",
      layout: "auto",
      vertex: { module: linMod, entryPoint: "vs" },
      fragment: { module: linMod, entryPoint: "linearize", targets: [{ format: "r32float" }] },
      primitive: { topology: "triangle-list" },
    })
    const sharpMod = d.createShaderModule({ label: "temporal sharpen", code: temporalSharpenShader })
    this.sharpenPipe = d.createRenderPipeline({
      label: "temporal sharpen",
      layout: "auto",
      vertex: { module: sharpMod, entryPoint: "vs" },
      fragment: { module: sharpMod, entryPoint: "sharpen", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
    })
  }

  /** (Re)allocates for an output and input size; returns true if anything changed (history is then dropped). */
  resize(outW: number, outH: number, inW: number, inH: number): boolean {
    if (outW === this.outW && outH === this.outH && inW === this.inW && inH === this.inH && this.output) return false
    const d = this.device
    for (const t of this.history) t.destroy()
    this.output?.destroy()
    this.prevLin?.destroy()
    this.reactive?.destroy()
    this.outW = outW
    this.outH = outH
    this.inW = inW
    this.inH = inH
    this.history = [0, 1].map((i) => d.createTexture({ label: `temporal history ${i}`, size: [outW, outH], format: this.format, usage: TEX_RENDER | TEX_BIND }))
    this.historyViews = this.history.map((t) => t.createView())
    this.output = d.createTexture({ label: "temporal output", size: [outW, outH], format: this.format, usage: TEX_RENDER | TEX_BIND | TEX_COPY_SRC })
    this.outputView = this.output.createView()
    this.prevLin = d.createTexture({ label: "temporal previous depth", size: [inW, inH], format: "r32float", usage: TEX_RENDER | TEX_BIND })
    this.prevLinView = this.prevLin.createView()
    this.reactive = d.createTexture({ label: "temporal reactive", size: [inW, inH], format: "rgba8unorm", usage: TEX_RENDER | TEX_BIND })
    this.reactiveView = this.reactive.createView()
    this.groups = null
    this.reset()
    return true
  }

  /** Drops the history: the next frame shows only the current samples (camera cut, teleport, new level). */
  reset(): void {
    if (this.valid || this.hasPrev) this.resets++
    this.valid = false
    this.hasPrev = false
  }

  /**
   * Starts a frame from the game's unjittered view-projection (`frame[0..15]`, eye at `frame[16..18]`): detects cuts,
   * computes the reprojection and writes the uniforms. Returns this frame's jitter in input pixels.
   */
  begin(frame: Float32Array, s: TemporalSettings, reactive: boolean): [number, number] {
    const eye = frame.subarray(16, 19)
    if (this.hasPrev && Math.hypot(eye[0]! - this.lastEye[0]!, eye[1]! - this.lastEye[1]!, eye[2]! - this.lastEye[2]!) > TEMPORAL_CUT_DISTANCE) this.reset()
    this.lastEye.set(eye)
    this.phases = jitterPhases(this.inW / Math.max(1, this.outW))
    const [jx, jy] = temporalJitter(this.frameIndex++, this.phases)
    const cur = frame.subarray(0, 16)
    mat4.inverse(cur, this.invCur)
    mat4.multiply(this.hasPrev ? this.prevVP : cur, this.invCur, this.reproject)
    this.prevVP.set(cur)
    const u = this.uniforms
    u.set(this.reproject, 0)
    u.set(this.invCur, 16)
    u[32] = jx
    u[33] = jy
    u[34] = 1 - Math.min(0.98, Math.max(0.5, s.history))
    u[35] = this.valid && this.hasPrev ? 1 : 0
    u[36] = this.inW
    u[37] = this.inH
    u[38] = this.outW
    u[39] = this.outH
    u[40] = TEMPORAL_DEPTH_REJECT
    u[41] = Math.min(1, Math.max(0, s.sharpen))
    u[42] = reactive ? TEMPORAL_REACTIVE_GAIN : 0
    u[43] = 0
    this.device.queue.writeBuffer(this.uniformBuf, 0, u)
    this.hasPrev = true
    return [jx, jy]
  }

  /** Resolve into the history, sharpen into `output`, and keep this frame's linear depth for the next one. */
  encode(enc: GPUCommandEncoder, input: GPUTextureView, depth: GPUTextureView, sharpen: boolean): void {
    const g = this.bindGroups(input, depth)
    const next = this.parity ^ 1
    const rp = enc.beginRenderPass({
      label: "temporal resolve",
      colorAttachments: sharpen
        ? [{ view: this.historyViews[next]!, loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] }]
        : [
            { view: this.historyViews[next]!, loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] },
            { view: this.outputView, loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] },
          ],
    })
    rp.setPipeline(sharpen ? this.resolvePipe : this.resolveBothPipe)
    rp.setBindGroup(0, g.resolve[this.parity]!)
    rp.draw(3)
    rp.end()
    if (sharpen) {
      const sp = enc.beginRenderPass({
        label: "temporal sharpen",
        colorAttachments: [{ view: this.outputView, loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] }],
      })
      sp.setPipeline(this.sharpenPipe)
      sp.setBindGroup(0, g.sharpen[next]!)
      sp.draw(3)
      sp.end()
    }
    const lp = enc.beginRenderPass({
      label: "temporal linearize",
      colorAttachments: [{ view: this.prevLinView, loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 0] }],
    })
    lp.setPipeline(this.linearizePipe)
    lp.setBindGroup(0, g.linearize)
    lp.draw(3)
    lp.end()
    this.parity = next
    this.valid = true
  }

  state(mode: AntiAliasingMode): TemporalState {
    return {
      mode,
      scale: this.outW ? this.inW / this.outW : 1,
      input: [this.inW, this.inH],
      output: [this.outW, this.outH],
      phase: this.frameIndex % this.phases,
      phases: this.phases,
      historyValid: this.valid,
      resets: this.resets,
    }
  }

  private bindGroups(input: GPUTextureView, depth: GPUTextureView) {
    if (this.groups && this.groups.input === input && this.groups.depth === depth) return this.groups
    const d = this.device
    const resolve = [0, 1].map((p) =>
      d.createBindGroup({
        layout: this.resolveLayout,
        entries: [
          { binding: 0, resource: input },
          { binding: 1, resource: depth },
          { binding: 2, resource: this.prevLinView },
          { binding: 3, resource: this.historyViews[p]! },
          { binding: 4, resource: this.sampler },
          { binding: 5, resource: this.reactiveView },
          { binding: 6, resource: { buffer: this.uniformBuf } },
        ],
      }),
    )
    const sharpen = [0, 1].map((p) =>
      d.createBindGroup({
        layout: this.sharpenPipe.getBindGroupLayout(0),
        entries: [
          { binding: 3, resource: this.historyViews[p]! },
          { binding: 6, resource: { buffer: this.uniformBuf } },
        ],
      }),
    )
    const linearize = d.createBindGroup({
      layout: this.linearizePipe.getBindGroupLayout(0),
      entries: [
        { binding: 1, resource: depth },
        { binding: 6, resource: { buffer: this.uniformBuf } },
      ],
    })
    this.groups = { input, depth, resolve, sharpen, linearize }
    return this.groups
  }
}
