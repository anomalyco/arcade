import { compileShaderModuleWithLog } from "./pass-graph"

/** Blocks the frame reduces to (64 × 36: one 512-byte row of rgba16f per row, a 16:9 grid). */
const W = 64
const H = 36
const TAPS = 6

export type SceneMeterStatus = "off" | "pending" | "ready" | "failed"

/** What the meter last read from the scene-referred image (before exposure, after the fog). */
export type SceneMeter = {
  /** Mean luminance over the frame. */
  mean: number
  /** Mean luminance with the centre weighted (a cos² falloff to 0.25 at the corners). */
  centre: number
  /** Geometric mean (log average) luminance. */
  logMean: number
  /** The 95th percentile of block luminance. */
  p95: number
  /** Frames since the image it read (2–4 with readback latency). */
  age: number
}

/**
 * A scene luminance meter for auto exposure: reduces the HDR image to 64 × 36 block means (6 × 6 taps each), copies
 * them to a ring of mappable buffers and reads them a few frames later, so it never stalls the GPU.
 */
export class LuminanceMeter {
  private target: GPUTexture
  private pipe: GPURenderPipeline
  private layout: GPUBindGroupLayout
  private group: GPUBindGroup | null = null
  private source: GPUTextureView | null = null
  private ring: { buf: GPUBuffer; busy: boolean; frame: number }[]
  private frame = 0
  private pending: number | null = null
  private generation = 0
  private failed = false
  last: SceneMeter | null = null

  get status(): SceneMeterStatus { return this.failed ? "failed" : this.last ? "ready" : "pending" }

  constructor(private device: GPUDevice) {
    this.target = device.createTexture({ size: [W, H], format: "rgba16float", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC })
    this.layout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float" } }] })
    const module = compileShaderModuleWithLog(device, /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(src));
  let cell = size / vec2f(${W}.0, ${H}.0);
  var sum = 0.0;
  var logSum = 0.0;
  for (var j = 0; j < ${TAPS}; j++) {
    for (var i = 0; i < ${TAPS}; i++) {
      let uv = (floor(pos.xy) + (vec2f(f32(i), f32(j)) + 0.5) / ${TAPS}.0) * cell;
      let c = textureLoad(src, vec2i(clamp(uv, vec2f(0.0), size - 1.0)), 0).rgb;
      let l = clamp(dot(c, vec3f(0.2126, 0.7152, 0.0722)), 0.0, 6e4);
      sum += select(l, 0.0, l != l);
      logSum += log2(max(select(l, 0.0, l != l), 1e-5));
    }
  }
  let n = f32(${TAPS * TAPS});
  return vec4f(sum / n, logSum / n, 0.0, 1.0);
}`, "luminance meter")
    this.pipe = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: [{ format: "rgba16float" }] },
      primitive: { topology: "triangle-list" },
    })
    this.ring = Array.from({ length: 3 }, () => ({ buf: device.createBuffer({ size: W * 8 * H, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }), busy: false, frame: 0 }))
  }

  /** Reduce `view` (an rgba16f image) and queue its copy into a free ring buffer; skips the frame if none is free. */
  encode(enc: GPUCommandEncoder, view: GPUTextureView): void {
    this.frame++
    this.pending = null
    const slot = this.ring.findIndex((r) => !r.busy)
    if (slot < 0) return
    if (this.source !== view) { this.source = view; this.group = this.device.createBindGroup({ layout: this.layout, entries: [{ binding: 0, resource: view }] }) }
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: this.target.createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }] })
    pass.setPipeline(this.pipe)
    pass.setBindGroup(0, this.group!)
    pass.draw(3)
    pass.end()
    enc.copyTextureToBuffer({ texture: this.target }, { buffer: this.ring[slot]!.buf, bytesPerRow: W * 8 }, [W, H])
    this.pending = slot
  }

  /** After the frame's submit: map the buffer it copied into and read it when the GPU is done. */
  afterSubmit(): void {
    if (this.pending === null) return
    const r = this.ring[this.pending]!
    this.pending = null
    r.busy = true
    r.frame = this.frame
    const generation = this.generation
    r.buf.mapAsync(GPUMapMode.READ).then(() => {
      if (generation === this.generation) this.read(new Uint16Array(r.buf.getMappedRange()), this.frame - r.frame)
      r.buf.unmap()
      r.busy = false
    }, () => {
      if (generation === this.generation) { this.failed = true; this.last = null }
      r.busy = false
    })
  }

  /** Discard the old scene, including readbacks that are still in flight. */
  reset(): void {
    this.generation++
    this.pending = null
    this.last = null
    this.failed = false
  }

  private read(px: Uint16Array, age: number): void {
    this.failed = false
    const lum = new Float32Array(W * H)
    let sum = 0, logSum = 0, wsum = 0, wtot = 0
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const k = y * W + x, l = half(px[k * 4]!), lg = half(px[k * 4 + 1]!)
      lum[k] = l
      sum += l
      logSum += lg
      const dx = (x + 0.5) / W - 0.5, dy = (y + 0.5) / H - 0.5
      const w = 0.25 + 0.75 * Math.cos(Math.min(1, Math.hypot(dx, dy) * 1.6) * Math.PI / 2) ** 2
      wsum += l * w
      wtot += w
    }
    lum.sort()
    const n = W * H
    this.last = { mean: sum / n, centre: wsum / wtot, logMean: 2 ** (logSum / n), p95: lum[Math.floor(n * 0.95)]!, age }
  }

  destroy(): void {
    this.target.destroy()
    for (const r of this.ring) r.buf.destroy()
  }
}

function half(h: number): number {
  const e = (h >> 10) & 31, m = h & 1023, s = h & 0x8000 ? -1 : 1
  if (e === 0) return s * m * 2 ** -24
  if (e === 31) return m ? 0 : s * 6e4
  return s * (1 + m / 1024) * 2 ** (e - 15)
}
