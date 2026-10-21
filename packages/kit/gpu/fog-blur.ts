/**
 * Fog-depth blur (`FrameInput.fogBlur`): what the fog hides goes soft, so far trees, the dish and the building read as
 * dark masses and halos grow with depth (three.js `webgpu_custom_fog_scattering`, MIT: a blurred copy of the scene
 * mixed in by the fog factor). The bloom pyramid can't stand in for the blurred scene because its first level is
 * gated to emitters (`bloomGate`), so this keeps its own half- and quarter-resolution chain, the quarter with the
 * bloom's 13-tap kernel (Jimenez 2014).
 *
 * - **Half:** four bilinear taps, each weighted by its own fog amount, 1 − exp(−reach · τ), with τ the height fog's closed-form
 *   optical depth plus the fog bank's mean (`fogBlurAmount` on the CPU). Stored premultiplied, so an unfogged trunk
 *   never bleeds into the fogged sky behind it.
 * - **Quarter:** the same kernel on the premultiplied half.
 * - **Mix:** at full output resolution, half and quarter blend by the pixel's fog amount and are mixed into the image
 *   with weight strength · amount (alpha blend, HDR alpha untouched). Runs after the fog volume, before bloom.
 */
import { fogParamsWgsl, FOG_UNIFORM_BINDING, type FogBlurInput } from "./fog-scatter"

export type { FogBlurInput }

/** Floats in the blur's frame uniform: unjittered invViewProj, eye + strength, sizes, params. */
export const FOG_BLUR_FRAME_FLOATS = 28

const common = /* wgsl */ `
${fogParamsWgsl}
struct BlurFrame {
  invViewProj: mat4x4f,
  eye: vec4f,      // eye xyz, strength
  sizes: vec4f,    // depth w, h, depth clear value, reach
  params: vec4f,
}
@group(0) @binding(0) var<uniform> B: BlurFrame;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var sceneDepth: texture_depth_multisampled_2d;

struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f }
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: VO;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}

fn clean(c: vec4f) -> vec4f {
  let bad = any(c != c) || any(abs(c) > vec4f(6e4));
  return select(min(c, vec4f(64.0)), vec4f(0.0), bad);
}

/** Fog amount at uv: 1 − exp(−reach · (height fog + mean bank optical depth)); the sky counts as fully fogged. */
fn blurAmount(uv: vec2f) -> f32 {
  let s = vec2i(B.sizes.xy);
  let d = textureLoad(sceneDepth, clamp(vec2i(uv * B.sizes.xy), vec2i(0), s - 1), 0);
  let sky = select(d >= 0.999999, d <= 1e-6, B.sizes.z < 0.5);
  if (sky) { return 1.0; }
  let h = B.invViewProj * vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, d, 1.0);
  let p = h.xyz / h.w;
  let eye = B.eye.xyz;
  var tau = fogOpticalDepth(eye, p);
  if (FOG.bank.w > 0.5) {
    let len = length(p - eye);
    let rd = (p - eye) / max(len, 1e-4);
    let base = FOG.medium.z;
    let dy = select(min(rd.y, -1e-5), max(rd.y, 1e-5), rd.y >= 0.0);
    let ta = (base - eye.y) / dy;
    let tb = (base + FOG.bank.y - eye.y) / dy;
    let t0 = max(min(ta, tb), 0.0);
    let t1 = min(min(max(ta, tb), len), FOG.bank2.y);
    if (t1 > t0) {
      let y = eye.y + rd.y * (t0 + t1) * 0.5;
      let hh = (y - base) / FOG.bank.y;
      tau += FOG.bank.x * 0.5 * (1.0 - FOG.bank2.x) * pow(clamp(1.0 - hh, 0.0, 1.0), 1.2) * (t1 - t0);
    }
  }
  return 1.0 - exp(-B.sizes.w * tau);
}
`

const offsets = [[-2, -2, 0.03125], [0, -2, 0.0625], [2, -2, 0.03125], [-2, 0, 0.0625], [0, 0, 0.125], [2, 0, 0.0625], [-2, 2, 0.03125], [0, 2, 0.0625], [2, 2, 0.03125], [-1, -1, 0.125], [1, -1, 0.125], [-1, 1, 0.125], [1, 1, 0.125]] as const

/**
 * First level: four bilinear taps (a 4×4 texel box) of the full image, each weighted by its fog amount; rgb
 * premultiplied, a = mean amount. The quarter level's 13 taps do the wide smoothing, so the depth reads stay at four.
 */
export const fogBlurDownWgsl = /* wgsl */ `
${common}
@fragment fn first(o: VO) -> @location(0) vec4f {
  let t = 1.0 / vec2f(textureDimensions(src));
  var acc = vec4f(0.0);
${[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([x, y]) => `  {
    let uv = o.uv + t * vec2f(${x!.toFixed(1)}, ${y!.toFixed(1)});
    let a = blurAmount(uv);
    acc += vec4f(clean(textureSampleLevel(src, samp, uv, 0.0)).rgb * a, a) * 0.25;
  }`).join("\n")}
  return acc;
}
/** Further levels: the same kernel on the premultiplied level above. */
@fragment fn down(o: VO) -> @location(0) vec4f {
  let t = 1.0 / vec2f(textureDimensions(src));
  var acc = vec4f(0.0);
${offsets.map(([x, y, w]) => `  acc += textureSampleLevel(src, samp, o.uv + t * vec2f(${x.toFixed(1)}, ${y.toFixed(1)}), 0.0) * ${w};`).join("\n")}
  return acc;
}
`

/** Mix into the image: half and quarter by the pixel's own fog amount, weight strength · amount. */
export const fogBlurMixWgsl = /* wgsl */ `
${common}
@group(0) @binding(4) var quarter: texture_2d<f32>;
@fragment fn mixBlur(o: VO) -> @location(0) vec4f {
  let a = blurAmount(o.uv);
  let h = textureSampleLevel(src, samp, o.uv, 0.0);
  let q = textureSampleLevel(quarter, samp, o.uv, 0.0);
  let hc = h.rgb / max(h.a, 1e-4);
  let qc = q.rgb / max(q.a, 1e-4);
  let blurred = mix(hc, qc, smoothstep(0.35, 0.9, a) * smoothstep(0.0, 0.05, q.a));
  return vec4f(blurred, B.eye.w * a * smoothstep(0.0, 0.05, h.a));
}
`

const U = () => GPUBufferUsage

export class FogBlur {
  private readonly frame: GPUBuffer
  private readonly data = new Float32Array(FOG_BLUR_FRAME_FLOATS)
  private readonly layout: GPUBindGroupLayout
  private readonly mixLayout: GPUBindGroupLayout
  private readonly firstPipe: GPURenderPipeline
  private readonly downPipe: GPURenderPipeline
  private readonly mixPipe: GPURenderPipeline
  private half: GPUTexture | null = null
  private quarter: GPUTexture | null = null
  private groups: { first: GPUBindGroup; down: GPUBindGroup; mix: GPUBindGroup } | null = null
  private bound: { source: GPUTextureView; depth: GPUTextureView } | null = null

  constructor(
    private readonly device: GPUDevice,
    private readonly format: GPUTextureFormat,
    private readonly fog: GPUBuffer,
    private readonly sampler: GPUSampler,
    compile: (code: string, label: string) => GPUShaderModule,
  ) {
    const d = device
    const S = GPUShaderStage
    this.frame = d.createBuffer({ label: "fog blur frame", size: FOG_BLUR_FRAME_FLOATS * 4, usage: U().UNIFORM | U().COPY_DST })
    const base: GPUBindGroupLayoutEntry[] = [
      { binding: 0, visibility: S.FRAGMENT, buffer: { type: "uniform" } },
      { binding: 1, visibility: S.FRAGMENT, texture: {} },
      { binding: 2, visibility: S.FRAGMENT, sampler: {} },
      { binding: 3, visibility: S.FRAGMENT, texture: { sampleType: "depth", multisampled: true } },
      { binding: FOG_UNIFORM_BINDING, visibility: S.FRAGMENT, buffer: { type: "uniform" } },
    ]
    this.layout = d.createBindGroupLayout({ label: "fog blur", entries: base })
    this.mixLayout = d.createBindGroupLayout({ label: "fog blur mix", entries: [...base, { binding: 4, visibility: S.FRAGMENT, texture: {} }] })
    const down = compile(fogBlurDownWgsl, "fog blur down")
    const mix = compile(fogBlurMixWgsl, "fog blur mix")
    const pipe = (module: GPUShaderModule, entryPoint: string, layout: GPUBindGroupLayout, blend?: GPUBlendState) =>
      d.createRenderPipeline({
        label: `fog blur ${entryPoint}`,
        layout: d.createPipelineLayout({ bindGroupLayouts: [layout] }),
        vertex: { module, entryPoint: "vs" },
        fragment: { module, entryPoint, targets: [{ format, ...(blend ? { blend } : {}) }] },
        primitive: { topology: "triangle-list" },
      })
    this.firstPipe = pipe(down, "first", this.layout)
    this.downPipe = pipe(down, "down", this.layout)
    this.mixPipe = pipe(mix, "mixBlur", this.mixLayout, {
      color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
      alpha: { srcFactor: "zero", dstFactor: "one" },
    })
  }

  /**
   * Blurs `source` (`width` × `height`, the image after the fog volume) by its fog and mixes the result back into
   * `target` (the same image). `invViewProj` is unjittered; `depth` is the stored scene depth (`depthWidth` ×
   * `depthHeight`, cleared to `depthClear`).
   */
  draw(
    enc: GPUCommandEncoder,
    input: FogBlurInput,
    source: GPUTextureView,
    target: GPUTextureView,
    width: number,
    height: number,
    depth: GPUTextureView,
    depthWidth: number,
    depthHeight: number,
    depthClear: number,
    invViewProj: Float32Array,
    eye: readonly [number, number, number],
  ): void {
    const d = this.device
    const hw = Math.max(1, Math.ceil(width / 2)), hh = Math.max(1, Math.ceil(height / 2))
    const qw = Math.max(1, Math.ceil(hw / 2)), qh = Math.max(1, Math.ceil(hh / 2))
    if (!this.half || this.half.width !== hw || this.half.height !== hh) {
      this.half?.destroy()
      this.quarter?.destroy()
      const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
      this.half = d.createTexture({ label: "fog blur half", size: [hw, hh], format: this.format, usage })
      this.quarter = d.createTexture({ label: "fog blur quarter", size: [qw, qh], format: this.format, usage })
      this.groups = null
    }
    if (!this.groups || this.bound?.source !== source || this.bound.depth !== depth) {
      this.bound = { source, depth }
      const entries = (tex: GPUTextureView): GPUBindGroupEntry[] => [
        { binding: 0, resource: { buffer: this.frame } },
        { binding: 1, resource: tex },
        { binding: 2, resource: this.sampler },
        { binding: 3, resource: depth },
        { binding: FOG_UNIFORM_BINDING, resource: { buffer: this.fog } },
      ]
      const halfView = this.half.createView()
      this.groups = {
        first: d.createBindGroup({ layout: this.layout, entries: entries(source) }),
        down: d.createBindGroup({ layout: this.layout, entries: entries(halfView) }),
        mix: d.createBindGroup({ layout: this.mixLayout, entries: [...entries(halfView), { binding: 4, resource: this.quarter!.createView() }] }),
      }
    }
    const f = this.data
    f.set(invViewProj.subarray(0, 16), 0)
    f.set([eye[0], eye[1], eye[2], Math.max(0, Math.min(1, input.strength))], 16)
    f.set([depthWidth, depthHeight, depthClear, Math.max(0, input.reach)], 20)
    d.queue.writeBuffer(this.frame, 0, f)
    const run = (view: GPUTextureView, pipe: GPURenderPipeline, group: GPUBindGroup, load: boolean) => {
      const pass = enc.beginRenderPass({ colorAttachments: [{ view, loadOp: load ? "load" : "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }] })
      pass.setPipeline(pipe)
      pass.setBindGroup(0, group)
      pass.draw(3)
      pass.end()
    }
    run(this.half.createView(), this.firstPipe, this.groups.first, false)
    run(this.quarter!.createView(), this.downPipe, this.groups.down, false)
    run(target, this.mixPipe, this.groups.mix, true)
  }

  destroy(): void {
    this.half?.destroy()
    this.quarter?.destroy()
    this.frame.destroy()
  }
}
