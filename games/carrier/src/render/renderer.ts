import { STATIC_Y0, STATIC_Y1, frustumGroundRect } from "./camera"
import { FRAME, FRAME_FLOATS } from "./frame"
import { LIT_WGSL, createLitPipelines, splitFoliage, type LitPipelines } from "./lit"
import { VERT_BYTES } from "./mesh"
import { Post, type Grade } from "./post"
import { boxIntersectsRect2D, drawContiguousChunks } from "@arcade/kit/gpu/cull"
import {
  PassList,
  compileShaderModuleWithLog,
  depthConfigForMode,
  type PassContext,
  type PassSlot,
  type ScenePass,
} from "@arcade/kit/gpu/pass-graph"
import { SceneTargets } from "@arcade/kit/gpu/targets"
import { installFramePacer } from "@arcade/kit/gpu-perf"

export type { Grade } from "./post"
export type { PassContext, ScenePass }
export type Slot = PassSlot

const SAMPLES = 4
const HDR: GPUTextureFormat = "rgba16float"
const DEPTH_CFG = depthConfigForMode("reversed-z")
const DEPTH: GPUTextureFormat = DEPTH_CFG.format

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
  private passes = new PassList()
  private solid: Stream | null = null
  private foliage: Stream | null = null
  private view: [number, number, number, number] = [0, 0, 0, 0]
  private targets: SceneTargets

  constructor(
    private device: GPUDevice,
    private canvas: GPUCanvasContext,
    format: GPUTextureFormat,
  ) {
    const d = device
    this.notifyPacer = installFramePacer(() => this.inflight === 0, () => false, d)
    this.frameBuf = d.createBuffer({ label: "frame", size: FRAME_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    const frameLayout = d.createBindGroupLayout({
      label: "frame",
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }],
    })
    this.frameGroup = d.createBindGroup({ layout: frameLayout, entries: [{ binding: 0, resource: { buffer: this.frameBuf } }] })
    this.context = {
      device: d,
      frameLayout,
      color: HDR,
      depth: DEPTH,
      depthMode: DEPTH_CFG.mode,
      depthCompare: DEPTH_CFG.compare,
      depthClearValue: DEPTH_CFG.clearValue,
      samples: SAMPLES,
    }
    this.targets = new SceneTargets(d, {
      hdrFormat: HDR,
      depthFormat: DEPTH,
      samples: SAMPLES,
      depthTextureBinding: false,
      depthClearValue: DEPTH_CFG.clearValue,
    })
    this.lit = createLitPipelines(this.context, this.module(LIT_WGSL, "lit"))
    this.post = new Post(d, HDR, format, (code, label) => this.module(code, label))
  }

  setBloomLevels(levels: number): void {
    this.post.bloomLevels = levels
  }

  /** Heat shimmer sources the composite applies (post.ts HEAT_FLOATS layout, pixels); written by src/flight/juice.ts. */
  get heat(): Float32Array {
    return this.post.heat
  }

  /** Compiles a shader module and reports any compile errors with their line. */
  module(code: string, label: string): GPUShaderModule {
    return compileShaderModuleWithLog(this.device, code, label)
  }

  /** Drawn in slot order sky → opaque → alpha, each slot in insertion order. The static world opens the opaque slot. */
  addPass(slot: Slot, pass: ScenePass): void {
    this.passes.add(slot, pass)
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
    if (!this.targets.resize(w, h)) return
    this.width = w
    this.height = h
    this.post.resize(this.targets.hdr, this.targets.hdrView, HDR)
  }

  private pendingFrame: Float32Array | null = null
  private pendingGrade: Grade | null = null
  readonly currentFrame = new Float32Array(FRAME_FLOATS)
  private scheduled = false
  private inflight = 0
  private readonly notifyPacer: () => void

  /**
   * Queues a frame. Calls within one task collapse to the last (callers reuse their arrays, so the latest input is
   * always consistent), and at most one frame is in flight: a slow GPU drops frames instead of building an unbounded
   * backlog or submitting out-of-band in microtasks.
   */
  render(frame: Float32Array, grade: Grade): void {
    this.currentFrame.set(frame.subarray(0, FRAME_FLOATS))
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
    if (!f || !g || this.inflight >= 1 || !this.targets.hdr) return
    this.pendingFrame = null
    this.pendingGrade = null
    this.draw(f, g)
    this.inflight++
    // A lost device rejects and stays in flight, so drawing stops.
    this.device.queue.onSubmittedWorkDone().then(this.done, () => undefined)
  }

  private done = (): void => {
    this.inflight--
    this.notifyPacer()
  }

  private draw(frame: Float32Array, grade: Grade): void {
    const d = this.device
    this.currentFrame.set(frame.subarray(0, FRAME_FLOATS))
    d.queue.writeBuffer(this.frameBuf, 0, frame.buffer, frame.byteOffset, FRAME_FLOATS * 4)
    this.targets.clearColor.r = frame[FRAME.horizon]!
    this.targets.clearColor.g = frame[FRAME.horizon + 1]!
    this.targets.clearColor.b = frame[FRAME.horizon + 2]!
    // viewProj is the Frame's first 16 floats, so the Frame itself serves as the matrix.
    frustumGroundRect(frame, STATIC_Y0, STATIC_Y1, this.view)

    const enc = d.createCommandEncoder()
    this.passes.prepareAll(enc)
    const pass = enc.beginRenderPass(this.targets.mainPass)
    pass.setBindGroup(0, this.frameGroup)
    this.passes.drawSlot("sky", pass)
    this.drawnChunks = 0
    if (this.solid) this.drawStatic(pass, this.solid, this.lit.solid)
    if (this.foliage) this.drawStatic(pass, this.foliage, this.lit.foliage)
    this.passes.drawSlot("opaque", pass)
    this.passes.drawSlot("alpha", pass)
    pass.end()
    this.post.encode(enc, this.canvas.getCurrentTexture().createView(), grade, frame[FRAME.eye + 3]!)
    d.queue.submit([enc.finish()])
  }

  /** Culls chunks against the view rect and merges runs of visible, adjacent chunks into single draws. */
  private drawStatic(pass: GPURenderPassEncoder, s: Stream, pipe: GPURenderPipeline): void {
    pass.setPipeline(pipe)
    pass.setVertexBuffer(0, s.buf)
    const stats = drawContiguousChunks(pass, s.ranges, (r) => boxIntersectsRect2D(r.box, this.view))
    this.drawnChunks += stats.chunksDrawn
  }
}
