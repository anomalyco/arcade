import { STATIC_Y0, STATIC_Y1, frustumGroundRect } from "./camera"
import { FRAME, FRAME_FLOATS } from "./frame"
import { LIT_WGSL, createLitPipelines, splitFoliage, type LitPipelines } from "./lit"
import { VERT_BYTES } from "./mesh"
import { Post, type Grade } from "./post"

export type { Grade } from "./post"

const SAMPLES = 4
const HDR: GPUTextureFormat = "rgba16float"
const DEPTH: GPUTextureFormat = "depth32float"

export type PassContext = {
  device: GPUDevice
  /** Group 0: the Frame uniform, visible to vertex + fragment. */
  frameLayout: GPUBindGroupLayout
  /** "rgba16float" HDR target. */
  color: GPUTextureFormat
  /** "depth32float", REVERSED Z: clear 0, depthCompare "greater-equal" (far plane ~40 km). */
  depth: GPUTextureFormat
  /** 4 (MSAA). */
  samples: number
}

export interface ScenePass {
  /** Called inside the main HDR render pass with group 0 (Frame) already bound. Set your own pipeline and group 1+. */
  draw(pass: GPURenderPassEncoder): void
  /** Optional: encode work (compute, offscreen passes) before the main HDR pass begins. */
  prepare?(enc: GPUCommandEncoder): void
}

export type Slot = "sky" | "opaque" | "alpha"
export type StaticChunk = { data: ArrayBuffer; box: [x0: number, z0: number, x1: number, z1: number] }

type Range = { first: number; count: number; box: readonly [number, number, number, number] }
type Stream = { buf: GPUBuffer; ranges: Range[] }

/**
 * WebGPU renderer. Per frame: one MSAA HDR pass (reversed-Z depth) drawing the sky passes, the static world (chunks
 * culled against the view and merged into contiguous draws, solid and foliage pipelines), the opaque passes, then the
 * alpha passes; then five-level bloom and a tone-mapped, graded composite to the canvas.
 */
export class Renderer {
  readonly context: PassContext
  /** Static chunks drawn last frame, for diagnostics. */
  drawnChunks = 0
  width = 0
  height = 0
  private frameBuf: GPUBuffer
  private frameGroup: GPUBindGroup
  private lit: LitPipelines
  private post: Post
  private passes: Record<Slot, ScenePass[]> = { sky: [], opaque: [], alpha: [] }
  private solid: Stream | null = null
  private foliage: Stream | null = null
  private view: [number, number, number, number] = [0, 0, 0, 0]
  private msaa: GPUTexture | null = null
  private depthTex: GPUTexture | null = null
  private hdr: GPUTexture | null = null
  private clear: GPUColorDict = { r: 0, g: 0, b: 0, a: 1 }
  private colorAttachment: GPURenderPassColorAttachment | null = null
  private depthAttachment: GPURenderPassDepthStencilAttachment | null = null
  private mainPass: GPURenderPassDescriptor | null = null

  constructor(
    private device: GPUDevice,
    private canvas: GPUCanvasContext,
    format: GPUTextureFormat,
  ) {
    const d = device
    this.frameBuf = d.createBuffer({ label: "frame", size: FRAME_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    const frameLayout = d.createBindGroupLayout({
      label: "frame",
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }],
    })
    this.frameGroup = d.createBindGroup({ layout: frameLayout, entries: [{ binding: 0, resource: { buffer: this.frameBuf } }] })
    this.context = { device: d, frameLayout, color: HDR, depth: DEPTH, samples: SAMPLES }
    this.lit = createLitPipelines(this.context, this.module(LIT_WGSL, "lit"))
    this.post = new Post(d, HDR, format, (code, label) => this.module(code, label))
  }

  /** Compiles a shader module and reports any compile errors with their line. */
  module(code: string, label: string): GPUShaderModule {
    const m = this.device.createShaderModule({ code, label })
    void m.getCompilationInfo().then((info) => {
      for (const msg of info.messages) if (msg.type === "error") console.error(`[wgsl ${label}:${msg.lineNum}:${msg.linePos}] ${msg.message}`)
    })
    return m
  }

  /** Drawn in slot order sky → opaque → alpha, each slot in insertion order. The static world opens the opaque slot. */
  addPass(slot: Slot, pass: ScenePass): void {
    this.passes[slot].push(pass)
  }

  /** Replaces the static world. Each chunk is packed `Mesh` data with its plan bounds. */
  setStatic(chunks: StaticChunk[]): void {
    const total = chunks.reduce((s, c) => s + c.data.byteLength, 0)
    const solid = new Uint8Array(total)
    const foliage = new Uint8Array(total)
    const solidRanges: Range[] = []
    const foliageRanges: Range[] = []
    let s = 0
    let f = 0
    for (const c of chunks) {
      const [sn, fn] = splitFoliage(c.data, solid, s, foliage, f)
      if (sn) solidRanges.push({ first: s / VERT_BYTES, count: sn / VERT_BYTES, box: c.box })
      if (fn) foliageRanges.push({ first: f / VERT_BYTES, count: fn / VERT_BYTES, box: c.box })
      s += sn
      f += fn
    }
    this.solid?.buf.destroy()
    this.foliage?.buf.destroy()
    this.solid = s ? this.stream(solid.subarray(0, s), solidRanges, "static-solid") : null
    this.foliage = f ? this.stream(foliage.subarray(0, f), foliageRanges, "static-foliage") : null
  }

  private stream(data: Uint8Array<ArrayBuffer>, ranges: Range[], label: string): Stream {
    const buf = this.device.createBuffer({ label, size: data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    this.device.queue.writeBuffer(buf, 0, data)
    return { buf, ranges }
  }

  resize(w: number, h: number): void {
    if (w === this.width && h === this.height) return
    this.width = w
    this.height = h
    this.msaa?.destroy()
    this.depthTex?.destroy()
    this.hdr?.destroy()
    const d = this.device
    this.msaa = d.createTexture({ label: "msaa", size: [w, h], format: HDR, sampleCount: SAMPLES, usage: GPUTextureUsage.RENDER_ATTACHMENT })
    this.depthTex = d.createTexture({ label: "depth", size: [w, h], format: DEPTH, sampleCount: SAMPLES, usage: GPUTextureUsage.RENDER_ATTACHMENT })
    this.hdr = d.createTexture({ label: "hdr", size: [w, h], format: HDR, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING })
    const hdrView = this.hdr.createView()
    this.colorAttachment = { view: this.msaa.createView(), resolveTarget: hdrView, clearValue: this.clear, loadOp: "clear", storeOp: "discard" }
    this.depthAttachment = { view: this.depthTex.createView(), depthClearValue: 0, depthLoadOp: "clear", depthStoreOp: "discard" }
    this.mainPass = { colorAttachments: [this.colorAttachment], depthStencilAttachment: this.depthAttachment }
    this.post.resize(this.hdr, hdrView, HDR)
  }

  private pendingFrame: Float32Array | null = null
  private pendingGrade: Grade | null = null
  private scheduled = false
  private inflight = 0

  /**
   * Queues a frame. Calls within one task collapse to the last (callers reuse their arrays, so the latest input is
   * always consistent), and at most two frames are in flight: a slow GPU drops frames instead of building an unbounded
   * backlog. A dropped frame is drawn once the GPU catches up, so the latest state always reaches the screen.
   */
  render(frame: Float32Array, grade: Grade): void {
    this.pendingFrame = frame
    this.pendingGrade = grade
    this.schedule()
  }

  private schedule(): void {
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(this.flush)
  }

  private flush = (): void => {
    this.scheduled = false
    const f = this.pendingFrame
    const g = this.pendingGrade
    if (!f || !g || this.inflight >= 2 || !this.mainPass) return
    this.pendingFrame = null
    this.pendingGrade = null
    this.draw(f, g)
    this.inflight++
    void this.device.queue.onSubmittedWorkDone().then(this.done)
  }

  private done = (): void => {
    this.inflight--
    if (this.pendingFrame) this.schedule()
  }

  private draw(frame: Float32Array, grade: Grade): void {
    const d = this.device
    d.queue.writeBuffer(this.frameBuf, 0, frame.buffer, frame.byteOffset, FRAME_FLOATS * 4)
    this.clear.r = frame[FRAME.horizon]!
    this.clear.g = frame[FRAME.horizon + 1]!
    this.clear.b = frame[FRAME.horizon + 2]!
    // viewProj is the Frame's first 16 floats, so the Frame itself serves as the matrix.
    frustumGroundRect(frame, STATIC_Y0, STATIC_Y1, this.view)

    const enc = d.createCommandEncoder()
    for (const slot of SLOTS) for (const p of this.passes[slot]) p.prepare?.(enc)
    const pass = enc.beginRenderPass(this.mainPass!)
    pass.setBindGroup(0, this.frameGroup)
    for (const p of this.passes.sky) p.draw(pass)
    this.drawnChunks = 0
    if (this.solid) this.drawStatic(pass, this.solid, this.lit.solid)
    if (this.foliage) this.drawStatic(pass, this.foliage, this.lit.foliage)
    for (const p of this.passes.opaque) p.draw(pass)
    for (const p of this.passes.alpha) p.draw(pass)
    pass.end()
    this.post.encode(enc, this.canvas.getCurrentTexture().createView(), grade, frame[FRAME.eye + 3]!)
    d.queue.submit([enc.finish()])
  }

  /** Culls chunks against the view rect and merges runs of visible, adjacent chunks into single draws. */
  private drawStatic(pass: GPURenderPassEncoder, s: Stream, pipe: GPURenderPipeline): void {
    const [vx0, vz0, vx1, vz1] = this.view
    pass.setPipeline(pipe)
    pass.setVertexBuffer(0, s.buf)
    let first = 0
    let count = 0
    for (const r of s.ranges) {
      const b = r.box
      if (b[0] > vx1 || b[2] < vx0 || b[1] > vz1 || b[3] < vz0) continue
      this.drawnChunks++
      if (count && r.first === first + count) count += r.count
      else {
        if (count) pass.draw(count, 1, first)
        first = r.first
        count = r.count
      }
    }
    if (count) pass.draw(count, 1, first)
  }
}

const SLOTS: readonly Slot[] = ["sky", "opaque", "alpha"]
