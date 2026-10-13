import { MAX_LIGHTS, MAX_MAP_LIGHTS, MAX_OCCLUDERS, POLAR_RAYS } from "../../shared/config"
import type { LevelData } from "./level-mesh"
import { LIGHT_FLOATS, OCC_FLOATS } from "./lighting"
import { VERT_BYTES, type Mesh } from "./mesh"
import { FRAME_FLOATS, polarShader, postShader, sceneShader, spriteShader } from "./shaders"

const SAMPLES = 4
const HDR: GPUTextureFormat = "rgba16float"
const DEPTH: GPUTextureFormat = "depth24plus"
export { LIGHT_FLOATS }
export const INST_FLOATS = 12
export const SPRITE_FLOATS = 12
const MAX_SPRITES = 8192
const BLOOM_LEVELS = 5
const SLOTS = MAX_LIGHTS

type Buf = { buf: GPUBuffer; count: number; cap: number }
type Chunk = { first: number; count: number; box: readonly [number, number, number, number]; cutBox?: readonly number[] }

/** Conservative screen bounds of cuttable geometry. The cutaway is screen-space, not a fixed world-space box. */
function intersectsCutaway(box: readonly number[] | undefined, f: Float32Array): boolean {
  if (!box || f[26]! < 0.5 || box[4]! < f[34]! || box[5]! < f[25]! + 0.25) return false
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (let i = 0; i < 8; i++) {
    const x = box[i & 1 ? 3 : 0]!, y = box[i & 2 ? 4 : 1]!, z = box[i & 4 ? 5 : 2]!
    const w = f[3]! * x + f[7]! * y + f[11]! * z + f[15]!
    if (w <= 0) return true
    const sx = (f[0]! * x + f[4]! * y + f[8]! * z + f[12]!) / w
    const sy = (f[1]! * x + f[5]! * y + f[9]! * z + f[13]!) / w
    x0 = Math.min(x0, sx); x1 = Math.max(x1, sx)
    y0 = Math.min(y0, sy); y1 = Math.max(y1, sy)
  }
  const radius = f[27]! + 0.002
  const rx = radius * f[21]! / f[20]!
  return x0 <= f[32]! + rx && x1 >= f[32]! - rx && y0 <= f[33]! + radius && y1 >= f[33]! - radius
}

/** One instanced draw: a registered model and its packed instances. */
export type Batch = { model: number; data: Float32Array<ArrayBuffer>; count: number; alpha?: boolean }

export type FrameInput = {
  frame: Float32Array<ArrayBuffer>
  lights: Float32Array<ArrayBuffer>
  lightCount: number
  shadowLightCount: number
  occluders: Float32Array<ArrayBuffer>
  occluderCount: number
  /** Brightness of every map light's fixture (0..1), indexed by map light id. */
  lampPower: Float32Array<ArrayBuffer>
  lampCount: number
  /** Plan rect in view, for culling level chunks. */
  view: readonly [number, number, number, number]
  batches: Batch[]
  alphaSprites: Float32Array<ArrayBuffer>
  alphaCount: number
  addSprites: Float32Array<ArrayBuffer>
  addCount: number
  /** time, desaturate, flash, exposure */
  grade: [number, number, number, number]
}

/**
 * WebGPU renderer. Per frame: (1) a compute pass casts POLAR_RAYS rays from each culled light against the occluders
 * within its reach (walls, furniture with heights, people), (2) an MSAA HDR pass draws the level chunks in view,
 * instanced characters, glass and light haze, and sprites, all lit through that polar shadow map, (3) bloom, then a
 * tone-mapped composite with grade, vignette and grain.
 */
export class Renderer {
  private frameBuf: GPUBuffer
  private lightBuf: GPUBuffer
  private occBuf: GPUBuffer
  private polarBuf: GPUBuffer
  private lampBuf: GPUBuffer
  private gradeBuf: GPUBuffer
  private sceneLayout: GPUBindGroupLayout
  private floorTex: GPUTexture
  private bounceTex: GPUTexture
  private floorSampler: GPUSampler
  private chunks: Chunk[] = []
  private glassChunks: Chunk[] = []
  private sceneGroup!: GPUBindGroup
  private computeGroup: GPUBindGroup
  private polarPipe: GPUComputePipeline
  private pipes: Record<string, GPURenderPipeline> = {}
  private baselinePipes: Record<string, GPURenderPipeline> = {}
  private level: Buf | null = null
  private glass: Buf | null = null
  private models: Buf[] = []
  private inst: Buf
  private sprites: GPUBuffer
  private msaa!: GPUTexture
  private msaaView!: GPUTextureView
  private depth!: GPUTexture
  private depthView!: GPUTextureView
  private hdr!: GPUTexture
  private hdrView!: GPUTextureView
  private bloom: GPUTexture[] = []
  private bloomViews: GPUTextureView[] = []
  private gradeData = new Float32Array(8)
  private postLayout: GPUBindGroupLayout
  private postGroups: { down: GPUBindGroup[]; up: GPUBindGroup[]; composite: GPUBindGroup } | null = null
  private postParams: GPUBuffer[] = []
  private sampler: GPUSampler
  /** Level chunks drawn last frame, for diagnostics. */
  drawnChunks = 0
  width = 0
  height = 0

  constructor(
    private device: GPUDevice,
    private context: GPUCanvasContext,
    format: GPUTextureFormat,
  ) {
    const d = device
    const U = GPUBufferUsage
    this.frameBuf = d.createBuffer({ size: FRAME_FLOATS * 4, usage: U.UNIFORM | U.COPY_DST })
    this.lightBuf = d.createBuffer({ size: MAX_LIGHTS * LIGHT_FLOATS * 4, usage: U.STORAGE | U.COPY_DST })
    this.occBuf = d.createBuffer({ size: MAX_OCCLUDERS * OCC_FLOATS * 4, usage: U.STORAGE | U.COPY_DST })
    this.polarBuf = d.createBuffer({ size: SLOTS * POLAR_RAYS * 32, usage: U.STORAGE })
    this.lampBuf = d.createBuffer({ size: MAX_MAP_LIGHTS * 4, usage: U.STORAGE | U.COPY_DST })
    this.floorTex = d.createTexture({ size: [1, 1], format: "rg8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST })
    this.bounceTex = d.createTexture({ size: [1, 1], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST })
    this.floorSampler = d.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" })
    this.gradeBuf = d.createBuffer({ size: 32, usage: U.UNIFORM | U.COPY_DST })
    this.inst = { buf: d.createBuffer({ size: 4096 * INST_FLOATS * 4, usage: U.VERTEX | U.COPY_DST }), count: 0, cap: 4096 }
    this.sprites = d.createBuffer({ size: MAX_SPRITES * SPRITE_FLOATS * 4, usage: U.VERTEX | U.COPY_DST })
    this.sampler = d.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" })

    const S = GPUShaderStage
    const computeLayout = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: S.COMPUTE, buffer: { type: "uniform" } },
        { binding: 1, visibility: S.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 3, visibility: S.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 4, visibility: S.COMPUTE, buffer: { type: "storage" } },
      ],
    })
    const sceneLayout = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: S.VERTEX | S.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: S.FRAGMENT, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: S.FRAGMENT, buffer: { type: "read-only-storage" } },
        { binding: 3, visibility: S.FRAGMENT, buffer: { type: "read-only-storage" } },
        { binding: 4, visibility: S.FRAGMENT, texture: {} },
        { binding: 5, visibility: S.FRAGMENT, sampler: {} },
        { binding: 6, visibility: S.FRAGMENT, texture: {} },
      ],
    })
    this.sceneLayout = sceneLayout
    this.postLayout = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: S.FRAGMENT, texture: {} },
        { binding: 1, visibility: S.FRAGMENT, sampler: {} },
        { binding: 2, visibility: S.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 3, visibility: S.FRAGMENT, texture: {} },
        { binding: 4, visibility: S.FRAGMENT, buffer: { type: "uniform" } },
      ],
    })
    this.computeGroup = d.createBindGroup({
      layout: computeLayout,
      entries: [
        { binding: 0, resource: { buffer: this.frameBuf } },
        { binding: 1, resource: { buffer: this.lightBuf } },
        { binding: 3, resource: { buffer: this.occBuf } },
        { binding: 4, resource: { buffer: this.polarBuf } },
      ],
    })
    this.makeSceneGroup()

    this.polarPipe = d.createComputePipeline({
      layout: d.createPipelineLayout({ bindGroupLayouts: [computeLayout] }),
      compute: { module: this.module(polarShader, "polar"), entryPoint: "main" },
    })

    const meshLayout: GPUVertexBufferLayout = {
      arrayStride: VERT_BYTES,
      attributes: [
        { shaderLocation: 0, offset: 0, format: "float32x3" },
        { shaderLocation: 1, offset: 12, format: "snorm8x4" },
        { shaderLocation: 2, offset: 16, format: "unorm8x4" },
        { shaderLocation: 3, offset: 20, format: "float16x2" },
      ],
    }
    const instLayout: GPUVertexBufferLayout = {
      arrayStride: INST_FLOATS * 4,
      stepMode: "instance",
      attributes: [
        { shaderLocation: 5, offset: 0, format: "float32x4" },
        { shaderLocation: 6, offset: 16, format: "float32x4" },
        { shaderLocation: 7, offset: 32, format: "float32x4" },
      ],
    }
    const spriteLayout: GPUVertexBufferLayout = {
      arrayStride: SPRITE_FLOATS * 4,
      stepMode: "instance",
      attributes: [
        { shaderLocation: 0, offset: 0, format: "float32x4" },
        { shaderLocation: 1, offset: 16, format: "float32x4" },
        { shaderLocation: 2, offset: 32, format: "float32x4" },
      ],
    }
    const premul: GPUBlendState = { color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" } }
    const additive: GPUBlendState = { color: { srcFactor: "one", dstFactor: "one" }, alpha: { srcFactor: "one", dstFactor: "one" } }
    const layout = d.createPipelineLayout({ bindGroupLayouts: [sceneLayout] })
    const scene = this.module(sceneShader(), "scene")
    const baselineScene = this.module(sceneShader(false), "scene baseline")
    const sprite = this.module(spriteShader, "sprite")
    const pipe = (module: GPUShaderModule, vs: string, buffers: GPUVertexBufferLayout[], blend?: GPUBlendState, depthWrite = true, cullMode: GPUCullMode = "back", fs = "fs") =>
      d.createRenderPipeline({
        layout,
        vertex: { module, entryPoint: vs, buffers },
        fragment: { module, entryPoint: fs, targets: [{ format: HDR, blend }] },
        primitive: { topology: "triangle-list", cullMode },
        depthStencil: { format: DEPTH, depthWriteEnabled: depthWrite, depthCompare: "less-equal" },
        multisample: { count: SAMPLES },
      })
    this.pipes.level = pipe(scene, "vsStatic", [meshLayout], undefined, true, "none", "fsSolid")
    this.pipes.levelCut = pipe(scene, "vsStatic", [meshLayout], undefined, true, "none", "fs")
    this.pipes.glass = pipe(scene, "vsStatic", [meshLayout], premul, false, "none", "fs")
    this.pipes.inst = pipe(scene, "vsInst", [meshLayout, instLayout], undefined, true, "none", "fs")
    this.pipes.instAlpha = pipe(scene, "vsInst", [meshLayout, instLayout], premul, false, "none", "fs")
    // Keep the all-off shader's arithmetic identical, including compiler rounding.
    this.baselinePipes.level = pipe(baselineScene, "vsStatic", [meshLayout], undefined, true, "none", "fsSolid")
    this.baselinePipes.levelCut = pipe(baselineScene, "vsStatic", [meshLayout], undefined, true, "none", "fs")
    this.baselinePipes.glass = pipe(baselineScene, "vsStatic", [meshLayout], premul, false, "none", "fs")
    this.baselinePipes.inst = pipe(baselineScene, "vsInst", [meshLayout, instLayout], undefined, true, "none", "fs")
    this.baselinePipes.instAlpha = pipe(baselineScene, "vsInst", [meshLayout, instLayout], premul, false, "none", "fs")
    this.pipes.spriteAlpha = pipe(sprite, "vs", [spriteLayout], premul, false, "none")
    this.pipes.spriteAdd = pipe(sprite, "vs", [spriteLayout], additive, false, "none")

    const post = this.module(postShader(), "post")
    const baselinePost = this.module(postShader(false), "post baseline")
    const postPipeLayout = d.createPipelineLayout({ bindGroupLayouts: [this.postLayout] })
    const postPipe = (fs: string, fmt: GPUTextureFormat, blend?: GPUBlendState, baseline = false) =>
      d.createRenderPipeline({ layout: postPipeLayout, vertex: { module: post, entryPoint: "vs" }, fragment: { module: baseline ? baselinePost : post, entryPoint: fs, targets: [{ format: fmt, blend }] }, primitive: { topology: "triangle-list" } })
    this.pipes.down = postPipe("down", HDR)
    this.pipes.up = postPipe("up", HDR, additive)
    this.pipes.composite = postPipe("composite", format)
    this.baselinePipes.composite = postPipe("composite", format, undefined, true)
    for (let i = 0; i < BLOOM_LEVELS; i++) this.postParams.push(d.createBuffer({ size: 16, usage: U.UNIFORM | U.COPY_DST }))
  }

  /** Compiles a shader module and reports any compile errors with their line. */
  private module(code: string, label: string): GPUShaderModule {
    const m = this.device.createShaderModule({ code, label })
    void m.getCompilationInfo().then((info) => {
      for (const msg of info.messages) if (msg.type === "error") console.error(`[wgsl ${label}:${msg.lineNum}:${msg.linePos}] ${msg.message}`)
    })
    return m
  }

  private makeSceneGroup(): void {
    this.sceneGroup = this.device.createBindGroup({
      layout: this.sceneLayout,
      entries: [
        { binding: 0, resource: { buffer: this.frameBuf } },
        { binding: 1, resource: { buffer: this.lightBuf } },
        { binding: 2, resource: { buffer: this.polarBuf } },
        { binding: 3, resource: { buffer: this.lampBuf } },
        { binding: 4, resource: this.floorTex.createView() },
        { binding: 5, resource: this.floorSampler },
        { binding: 6, resource: this.bounceTex.createView() },
      ],
    })
  }

  private upload(data: ArrayBuffer, prev: Buf | null): Buf {
    prev?.buf.destroy()
    const buf = this.device.createBuffer({ size: Math.max(64, data.byteLength), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    if (data.byteLength) this.device.queue.writeBuffer(buf, 0, data)
    return { buf, count: data.byteLength / VERT_BYTES, cap: data.byteLength }
  }

  /** Static level: opaque chunks (each culled against the view), translucent glass and haze chunks, and the baked floor map. */
  setLevel(level: LevelData): void {
    const packChunks = (list: LevelData["chunks"]): [ArrayBuffer, Chunk[]] => {
      const total = list.reduce((s, c) => s + c.data.byteLength, 0)
      const all = new Uint8Array(total)
      const out: Chunk[] = []
      let off = 0
      for (const c of list) {
        all.set(new Uint8Array(c.data), off)
        out.push({ first: off / VERT_BYTES, count: c.data.byteLength / VERT_BYTES, box: c.box, cutBox: c.cutBox })
        off += c.data.byteLength
      }
      return [all.buffer, out]
    }
    const [lvlBuf, lvlChunks] = packChunks(level.chunks)
    this.chunks = lvlChunks
    this.level = this.upload(lvlBuf, this.level)
    const [glsBuf, glsChunks] = packChunks(level.glass)
    this.glassChunks = glsChunks
    this.glass = this.upload(glsBuf, this.glass)
    const f = level.floor
    this.floorTex.destroy()
    this.floorTex = this.device.createTexture({ size: [f.w, f.h], format: "rg8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST })
    this.device.queue.writeTexture({ texture: this.floorTex }, f.data, { bytesPerRow: f.w * 2 }, [f.w, f.h])
    const b = level.bounce
    this.bounceTex.destroy()
    this.bounceTex = this.device.createTexture({ size: [b.w, b.h], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST })
    this.device.queue.writeTexture({ texture: this.bounceTex }, b.data, { bytesPerRow: b.w * 4 }, [b.w, b.h])
    this.makeSceneGroup()
  }

  addModel(mesh: Mesh): number {
    this.models.push(this.upload(mesh.pack(), null))
    return this.models.length - 1
  }

  updateBounce(data: Uint8Array<ArrayBuffer>, w: number, h: number): void {
    this.device.queue.writeTexture({ texture: this.bounceTex }, data, { bytesPerRow: w * 4 }, [w, h])
  }

  resize(w: number, h: number): void {
    if (w === this.width && h === this.height) return
    this.width = w
    this.height = h
    this.msaa?.destroy()
    this.depth?.destroy()
    this.hdr?.destroy()
    for (const b of this.bloom) b.destroy()
    const d = this.device
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    this.msaa = d.createTexture({ size: [w, h], format: HDR, sampleCount: SAMPLES, usage: GPUTextureUsage.RENDER_ATTACHMENT })
    this.msaaView = this.msaa.createView()
    this.depth = d.createTexture({ size: [w, h], format: DEPTH, sampleCount: SAMPLES, usage: GPUTextureUsage.RENDER_ATTACHMENT })
    this.depthView = this.depth.createView()
    this.hdr = d.createTexture({ size: [w, h], format: HDR, usage })
    this.hdrView = this.hdr.createView()
    this.bloom = []
    this.bloomViews = []
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      const s = 2 ** (i + 1)
      const tex = d.createTexture({ size: [Math.max(1, Math.floor(w / s)), Math.max(1, Math.floor(h / s))], format: HDR, usage })
      this.bloom.push(tex)
      this.bloomViews.push(tex.createView())
    }
    const group = (srcView: GPUTextureView, params: GPUBuffer, extraView: GPUTextureView = srcView) =>
      d.createBindGroup({
        layout: this.postLayout,
        entries: [
          { binding: 0, resource: srcView },
          { binding: 1, resource: this.sampler },
          { binding: 2, resource: { buffer: params } },
          { binding: 3, resource: extraView },
          { binding: 4, resource: { buffer: this.gradeBuf } },
        ],
      })
    const down: GPUBindGroup[] = []
    const up: GPUBindGroup[] = []
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      const src = i === 0 ? this.hdr : this.bloom[i - 1]!
      const srcView = i === 0 ? this.hdrView : this.bloomViews[i - 1]!
      down.push(group(srcView, this.postParams[i]!))
      d.queue.writeBuffer(this.postParams[i]!, 0, new Float32Array([1 / src.width, 1 / src.height, i === 0 ? 1 : 0, 0]))
    }
    for (let i = BLOOM_LEVELS - 1; i > 0; i--) up.push(group(this.bloomViews[i]!, this.postParams[i]!))
    this.postGroups = { down, up, composite: group(this.hdrView, this.postParams[0]!, this.bloomViews[0]!) }
  }

  private pending: FrameInput | null = null
  private scheduled = false
  private inflight = 0

  /**
   * Queues a frame. Calls within one task collapse to the last (Game reuses its arrays, so the latest input is always
   * consistent), and at most two frames are in flight: a slow GPU (SwiftShader) drops frames instead of building an
   * unbounded backlog. A dropped frame is drawn once the GPU catches up, so the latest state always reaches the screen.
   */
  render(f: FrameInput): void {
    this.pending = f
    this.schedule()
  }

  private schedule(): void {
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      const f = this.pending
      if (!f || this.inflight >= 2) return
      this.pending = null
      this.draw(f)
      this.inflight++
      void this.device.queue.onSubmittedWorkDone().then(() => {
        this.inflight--
        if (this.pending) this.schedule()
      })
    })
  }

  private draw(f: FrameInput): void {
    const d = this.device
    const scenePipes = (f.frame[45]! & ~1) && f.frame[46]! ? this.pipes : this.baselinePipes
    d.queue.writeBuffer(this.frameBuf, 0, f.frame)
    if (f.lightCount) d.queue.writeBuffer(this.lightBuf, 0, f.lights.buffer, f.lights.byteOffset, f.lightCount * LIGHT_FLOATS * 4)
    if (f.occluderCount) d.queue.writeBuffer(this.occBuf, 0, f.occluders.buffer, f.occluders.byteOffset, Math.min(f.occluderCount, MAX_OCCLUDERS) * OCC_FLOATS * 4)
    if (f.lampCount) d.queue.writeBuffer(this.lampBuf, 0, f.lampPower.buffer, f.lampPower.byteOffset, Math.min(f.lampCount, MAX_MAP_LIGHTS) * 4)
    this.gradeData.set(f.grade)
    this.gradeData[4] = f.frame[45]! & 1
    d.queue.writeBuffer(this.gradeBuf, 0, this.gradeData)

    const total = f.batches.reduce((s, b) => s + b.count, 0)
    if (total > this.inst.cap) {
      this.inst.buf.destroy()
      this.inst.cap = Math.ceil(total * 1.5)
      this.inst.buf = d.createBuffer({ size: this.inst.cap * INST_FLOATS * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    }
    const ranges: { model: number; first: number; count: number; alpha: boolean }[] = []
    let off = 0
    let firstBuf: ArrayBuffer | null = null
    let firstByteOff = 0
    let contiguous = true
    for (const b of f.batches) {
      if (!b.count) continue
      if (firstBuf === null) {
        firstBuf = b.data.buffer
        firstByteOff = b.data.byteOffset
      } else if (b.data.buffer !== firstBuf || b.data.byteOffset !== firstByteOff + off * INST_FLOATS * 4) {
        contiguous = false
      }
      ranges.push({ model: b.model, first: off, count: b.count, alpha: !!b.alpha })
      off += b.count
    }
    if (off > 0) {
      if (contiguous && firstBuf) {
        d.queue.writeBuffer(this.inst.buf, 0, firstBuf, firstByteOff, off * INST_FLOATS * 4)
      } else {
        let cur = 0
        for (const b of f.batches) {
          if (!b.count) continue
          d.queue.writeBuffer(this.inst.buf, cur * INST_FLOATS * 4, b.data.buffer, b.data.byteOffset, b.count * INST_FLOATS * 4)
          cur += b.count
        }
      }
    }
    const half = MAX_SPRITES / 2
    const alphaCount = Math.min(f.alphaCount, half)
    const addCount = Math.min(f.addCount, half)
    if (alphaCount) d.queue.writeBuffer(this.sprites, 0, f.alphaSprites.buffer, 0, alphaCount * SPRITE_FLOATS * 4)
    const addOffset = half * SPRITE_FLOATS * 4
    if (addCount) d.queue.writeBuffer(this.sprites, addOffset, f.addSprites.buffer, 0, addCount * SPRITE_FLOATS * 4)

    const enc = d.createCommandEncoder()
    if (f.shadowLightCount) {
      const cp = enc.beginComputePass()
      cp.setPipeline(this.polarPipe)
      cp.setBindGroup(0, this.computeGroup)
      cp.dispatchWorkgroups(Math.ceil((Math.min(f.shadowLightCount, SLOTS) * POLAR_RAYS) / 64))
      cp.end()
    }

    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: this.msaaView, resolveTarget: this.hdrView, clearValue: { r: 0.004, g: 0.006, b: 0.014, a: 1 }, loadOp: "clear", storeOp: "discard" }],
      depthStencilAttachment: { view: this.depthView, depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "discard" },
    })
    pass.setBindGroup(0, this.sceneGroup)
    const [vx0, vy0, vx1, vy1] = f.view
    if (this.level?.count) {
      pass.setPipeline(scenePipes.level!)
      pass.setVertexBuffer(0, this.level.buf)
      let drawn = 0
      let cut = false
      for (const c of this.chunks) {
        if (c.box[0] > vx1 || c.box[2] < vx0 || c.box[1] > vy1 || c.box[3] < vy0) continue
        drawn++
        const next = intersectsCutaway(c.cutBox, f.frame)
        if (cut !== next) {
          cut = next
          pass.setPipeline(cut ? scenePipes.levelCut! : scenePipes.level!)
        }
        pass.draw(c.count, 1, c.first)
      }
      this.drawnChunks = drawn
    }
    pass.setVertexBuffer(1, this.inst.buf)
    for (const alpha of [false, true]) {
      pass.setPipeline(alpha ? scenePipes.instAlpha! : scenePipes.inst!)
      for (const r of ranges) {
        if (r.alpha !== alpha) continue
        const m = this.models[r.model]!
        pass.setVertexBuffer(0, m.buf)
        pass.draw(m.count, r.count, 0, r.first)
      }
      if (!alpha && this.glass?.count) {
        pass.setPipeline(scenePipes.glass!)
        pass.setVertexBuffer(0, this.glass.buf)
        for (const c of this.glassChunks) {
          if (c.box[0] > vx1 || c.box[2] < vx0 || c.box[1] > vy1 || c.box[3] < vy0) continue
          pass.draw(c.count, 1, c.first)
        }
        pass.setVertexBuffer(1, this.inst.buf)
      }
    }
    if (alphaCount) {
      pass.setPipeline(this.pipes.spriteAlpha!)
      pass.setVertexBuffer(0, this.sprites, 0)
      pass.draw(6, alphaCount)
    }
    if (addCount) {
      pass.setPipeline(this.pipes.spriteAdd!)
      pass.setVertexBuffer(0, this.sprites, addOffset)
      pass.draw(6, addCount)
    }
    pass.end()

    const g = this.postGroups!
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      const p = enc.beginRenderPass({ colorAttachments: [{ view: this.bloomViews[i]!, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }] })
      p.setPipeline(this.pipes.down!)
      p.setBindGroup(0, g.down[i]!)
      p.draw(3)
      p.end()
    }
    for (let k = 0; k < BLOOM_LEVELS - 1; k++) {
      const p = enc.beginRenderPass({ colorAttachments: [{ view: this.bloomViews[BLOOM_LEVELS - 2 - k]!, loadOp: "load", storeOp: "store" }] })
      p.setPipeline(this.pipes.up!)
      p.setBindGroup(0, g.up[k]!)
      p.draw(3)
      p.end()
    }
    const fp = enc.beginRenderPass({ colorAttachments: [{ view: this.context.getCurrentTexture().createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }] })
    fp.setPipeline((f.frame[45]! & 1 ? this.pipes : this.baselinePipes).composite!)
    fp.setBindGroup(0, g.composite)
    fp.draw(3)
    fp.end()
    d.queue.submit([enc.finish()])
  }
}
