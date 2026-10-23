import { mat4 } from "wgpu-matrix"
import type { FinalPass } from "../renderer"

/**
 * Camera shutter blur on fast turns, as a final pass (`FinalPassChain`): each pixel is smeared along where the view's
 * rotation carried it during the shutter, with no depth or velocity buffer. Walking adds nothing (only rotation is
 * reprojected), so the woods stay sharp until you whip round. Off (`strength` 0) builds nothing.
 */
export type CameraBlurSettings = {
  /** 0 off, 1 a 1/50 s shutter. */
  strength: number
  /** Screen widths per second of turn below which nothing smears (a slow pan stays sharp). */
  threshold: number
  /** Longest smear, as a share of the screen width. */
  maxLength: number
}
export const CAMERA_BLUR_DEFAULTS: CameraBlurSettings = { strength: 0, threshold: 0.35, maxLength: 0.04 }

const SHUTTER = 1 / 50
const UNIFORM_FLOATS = 24

/**
 * Previous rotation-only clip from current rotation-only NDC: `prevVP · T(prevEye) · (curVP · T(curEye))⁻¹`. Every point
 * along a pixel's ray lands on the same previous pixel, because neither matrix translates. `cur`/`prev` hold a
 * column-major viewProj at 0..15 and the eye at 16..18 (the renderer's frame layout).
 */
export function rotationReprojection(cur: Float32Array, prev: Float32Array, out = new Float32Array(16)): Float32Array {
  const c = mat4.multiply(cur.subarray(0, 16), mat4.translation([cur[16]!, cur[17]!, cur[18]!]))
  const p = mat4.multiply(prev.subarray(0, 16), mat4.translation([prev[16]!, prev[17]!, prev[18]!]))
  return mat4.multiply(p, mat4.inverse(c), out) as Float32Array
}

export const CAMERA_BLUR_WGSL = /* wgsl */ `
struct U { m: mat4x4f, a: vec4f, b: vec4f }  // a: width, height, scale (shutter / dt × strength), max length (uv); b: threshold (uv per frame)
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
struct V { @builtin(position) pos: vec4f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> V {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: V;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  return o;
}
@fragment fn fs(v: V) -> @location(0) vec4f {
  let uv = v.pos.xy / u.a.xy;
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  let q = u.m * vec4f(ndc, 0.5, 1.0);
  var d = vec2f(0.0);
  if (q.w > 1e-4) {
    let prev = q.xy / q.w;
    d = (ndc - prev) * vec2f(0.5, -0.5);
  }
  // Per-frame travel to shutter travel; slow turns stay sharp, the longest smear is capped.
  let l = length(d);
  let keep = max(l - u.b.x, 0.0);
  var s = vec2f(0.0);
  if (l > 1e-6) { s = d / l * min(keep * u.a.z, u.a.w); }
  if (dot(s * u.a.xy, s * u.a.xy) < 0.25) { return textureSampleLevel(src, samp, uv, 0.0); }
  var c = vec3f(0.0);
  for (var i = 0; i < 9; i++) {
    c += textureSampleLevel(src, samp, uv - s * (f32(i) / 8.0 - 0.5), 0.0).rgb;
  }
  return vec4f(c / 9.0, 1.0);
}
`

export class CameraBlur implements FinalPass {
  readonly settings: CameraBlurSettings
  /** Multiplies `strength` for this frame (a raised map, reduced motion). */
  scale = 1
  private targets: { width: number; height: number; source: GPUTexture; view: GPUTextureView } | null = null
  private pipe: GPURenderPipeline | null = null
  private group: GPUBindGroup | null = null
  private uniform: GPUBuffer | null = null
  private sampler: GPUSampler | null = null
  private readonly data = new Float32Array(UNIFORM_FLOATS)
  private readonly prev = new Float32Array(20)
  private readonly m = new Float32Array(16)
  private valid = false
  private lastTime = 0

  constructor(private readonly device: GPUDevice, private readonly format: GPUTextureFormat, settings: CameraBlurSettings = { ...CAMERA_BLUR_DEFAULTS }) {
    this.settings = settings
  }

  get active(): boolean {
    const on = this.settings.strength * this.scale > 0.001
    if (!on) this.valid = false
    return on
  }

  source(width: number, height: number): GPUTextureView {
    if (!this.targets || this.targets.width !== width || this.targets.height !== height) {
      this.targets?.source.destroy()
      const source = this.device.createTexture({ label: "camera blur source", size: [width, height], format: this.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING })
      this.targets = { width, height, source, view: source.createView() }
      this.group = null
    }
    return this.targets.view
  }

  encode(encoder: GPUCommandEncoder, target: GPUTextureView, frame: Float32Array): void {
    const t = this.targets
    if (!t) return
    this.ensure()
    const time = frame[19]!, dt = time - this.lastTime
    const continuous = this.valid && dt > 1e-4 && dt < 0.25
    if (continuous) rotationReprojection(frame, this.prev, this.m)
    else mat4.identity(this.m)
    this.prev.set(frame.subarray(0, 20))
    const s = this.settings
    const k = Math.max(0, s.strength * this.scale)
    this.data.set(this.m, 0)
    this.data.set([t.width, t.height, continuous ? (SHUTTER / dt) * k : 0, s.maxLength, continuous ? s.threshold * dt : 1, 0, 0, 0], 16)
    this.device.queue.writeBuffer(this.uniform!, 0, this.data)
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }] })
    pass.setPipeline(this.pipe!)
    pass.setBindGroup(0, this.group!)
    pass.draw(3)
    pass.end()
    this.valid = true
    this.lastTime = time
  }

  dispose(): void {
    this.targets?.source.destroy()
    this.uniform?.destroy()
    this.targets = null
    this.group = null
  }

  private ensure() {
    const d = this.device
    if (!this.pipe) {
      const module = d.createShaderModule({ label: "camera blur", code: CAMERA_BLUR_WGSL })
      this.pipe = d.createRenderPipeline({ label: "camera blur", layout: "auto", vertex: { module, entryPoint: "vs" }, fragment: { module, entryPoint: "fs", targets: [{ format: this.format }] }, primitive: { topology: "triangle-list" } })
      this.sampler = d.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" })
      this.uniform = d.createBuffer({ label: "camera blur", size: UNIFORM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    }
    if (!this.group) {
      this.group = d.createBindGroup({ layout: this.pipe.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: this.uniform! } },
        { binding: 1, resource: this.targets!.view },
        { binding: 2, resource: this.sampler! },
      ] })
    }
  }
}
