import { MAX_LIGHTS, MAX_OCCLUDERS, POLAR_RAYS } from "../../shared/config"
import { FLOATS_PER_VERT, type Mesh } from "./mesh"
import { FRAME_FLOATS, polarShader, postShader, sceneShader, spriteShader } from "./shaders"

const SAMPLES = 4
const HDR: GPUTextureFormat = "rgba16float"
const DEPTH: GPUTextureFormat = "depth24plus"
export const LIGHT_FLOATS = 16
export const INST_FLOATS = 12
export const SPRITE_FLOATS = 12
const MAX_SPRITES = 8192
const BLOOM_LEVELS = 5
const SLOTS = MAX_LIGHTS

type Buf = { buf: GPUBuffer; count: number; cap: number }

/** One instanced draw: a registered model and its packed instances. */
export type Batch = { model: number; data: Float32Array<ArrayBuffer>; count: number; alpha?: boolean }

export type FrameInput = {
  frame: Float32Array<ArrayBuffer>
  lights: Float32Array<ArrayBuffer>
  batches: Batch[]
  alphaSprites: Float32Array<ArrayBuffer>
  alphaCount: number
  addSprites: Float32Array<ArrayBuffer>
  addCount: number
  /** time, desaturate, flash, exposure */
  grade: [number, number, number, number]
}

/**
 * WebGPU renderer. Per frame: (1) a compute pass casts POLAR_RAYS rays from every light and from the local player
 * against the 2D occluders (the same walls and doors the server tests), (2) an MSAA HDR pass draws the static level,
 * instanced characters and doors, glass and sprites, all lit through that polar shadow map, (3) bloom, then a
 * tone-mapped composite with grade, vignette and grain.
 */
export class Renderer {
  private frameBuf: GPUBuffer
  private lightBuf: GPUBuffer
  private occBuf: GPUBuffer
  private polarBuf: GPUBuffer
  private gradeBuf: GPUBuffer
  private sceneGroup: GPUBindGroup
  private computeGroup: GPUBindGroup
  private polarPipe: GPUComputePipeline
  private pipes: Record<string, GPURenderPipeline> = {}
  private level: Buf | null = null
  private glass: Buf | null = null
  private models: Buf[] = []
  private inst: Buf
  private sprites: GPUBuffer
  private msaa!: GPUTexture
  private depth!: GPUTexture
  private hdr!: GPUTexture
  private bloom: GPUTexture[] = []
  private postLayout: GPUBindGroupLayout
  private postGroups: { down: GPUBindGroup[]; up: GPUBindGroup[]; composite: GPUBindGroup } | null = null
  private postParams: GPUBuffer[] = []
  private sampler: GPUSampler
  private occCount = 0
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
    this.occBuf = d.createBuffer({ size: MAX_OCCLUDERS * 16, usage: U.STORAGE | U.COPY_DST })
    this.polarBuf = d.createBuffer({ size: SLOTS * POLAR_RAYS * 4, usage: U.STORAGE })
    this.gradeBuf = d.createBuffer({ size: 16, usage: U.UNIFORM | U.COPY_DST })
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
      ],
    })
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
    this.sceneGroup = d.createBindGroup({
      layout: sceneLayout,
      entries: [
        { binding: 0, resource: { buffer: this.frameBuf } },
        { binding: 1, resource: { buffer: this.lightBuf } },
        { binding: 2, resource: { buffer: this.polarBuf } },
      ],
    })

    this.polarPipe = d.createComputePipeline({
      layout: d.createPipelineLayout({ bindGroupLayouts: [computeLayout] }),
      compute: { module: d.createShaderModule({ code: polarShader }), entryPoint: "main" },
    })

    const meshLayout: GPUVertexBufferLayout = {
      arrayStride: FLOATS_PER_VERT * 4,
      attributes: [
        { shaderLocation: 0, offset: 0, format: "float32x3" },
        { shaderLocation: 1, offset: 12, format: "float32x3" },
        { shaderLocation: 2, offset: 24, format: "float32x3" },
        { shaderLocation: 3, offset: 36, format: "float32" },
        { shaderLocation: 4, offset: 40, format: "float32" },
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
    const scene = d.createShaderModule({ code: sceneShader })
    const sprite = d.createShaderModule({ code: spriteShader })
    const pipe = (module: GPUShaderModule, vs: string, buffers: GPUVertexBufferLayout[], blend?: GPUBlendState, depthWrite = true) =>
      d.createRenderPipeline({
        layout,
        vertex: { module, entryPoint: vs, buffers },
        fragment: { module, entryPoint: "fs", targets: [{ format: HDR, blend }] },
        primitive: { topology: "triangle-list", cullMode: "none" },
        depthStencil: { format: DEPTH, depthWriteEnabled: depthWrite, depthCompare: "less-equal" },
        multisample: { count: SAMPLES },
      })
    this.pipes.level = pipe(scene, "vsStatic", [meshLayout])
    this.pipes.glass = pipe(scene, "vsStatic", [meshLayout], premul, false)
    this.pipes.inst = pipe(scene, "vsInst", [meshLayout, instLayout])
    this.pipes.instAlpha = pipe(scene, "vsInst", [meshLayout, instLayout], premul, false)
    this.pipes.spriteAlpha = pipe(sprite, "vs", [spriteLayout], premul, false)
    this.pipes.spriteAdd = pipe(sprite, "vs", [spriteLayout], additive, false)

    const post = d.createShaderModule({ code: postShader })
    const postPipeLayout = d.createPipelineLayout({ bindGroupLayouts: [this.postLayout] })
    const postPipe = (fs: string, fmt: GPUTextureFormat, blend?: GPUBlendState) =>
      d.createRenderPipeline({ layout: postPipeLayout, vertex: { module: post, entryPoint: "vs" }, fragment: { module: post, entryPoint: fs, targets: [{ format: fmt, blend }] }, primitive: { topology: "triangle-list" } })
    this.pipes.down = postPipe("down", HDR)
    this.pipes.up = postPipe("up", HDR, additive)
    this.pipes.composite = postPipe("composite", format)
    for (let i = 0; i < BLOOM_LEVELS; i++) this.postParams.push(d.createBuffer({ size: 16, usage: U.UNIFORM | U.COPY_DST }))
  }

  private upload(mesh: Mesh, prev: Buf | null): Buf {
    prev?.buf.destroy()
    const data = mesh.toArray()
    const buf = this.device.createBuffer({ size: Math.max(64, data.byteLength), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    if (data.byteLength) this.device.queue.writeBuffer(buf, 0, data)
    return { buf, count: mesh.count, cap: data.byteLength }
  }

  setLevel(opaque: Mesh, glass: Mesh): void {
    this.level = this.upload(opaque, this.level)
    this.glass = this.upload(glass, this.glass)
  }

  addModel(mesh: Mesh): number {
    this.models.push(this.upload(mesh, null))
    return this.models.length - 1
  }

  /** Plan-space rectangles that block light and sight: walls and closed doors. */
  setOccluders(rects: readonly (readonly [number, number, number, number])[]): void {
    const n = Math.min(MAX_OCCLUDERS, rects.length)
    const data = new Float32Array(Math.max(4, n * 4))
    for (let i = 0; i < n; i++) data.set(rects[i]!, i * 4)
    this.device.queue.writeBuffer(this.occBuf, 0, data)
    this.occCount = n
  }

  get occluderCount(): number {
    return this.occCount
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
    this.depth = d.createTexture({ size: [w, h], format: DEPTH, sampleCount: SAMPLES, usage: GPUTextureUsage.RENDER_ATTACHMENT })
    this.hdr = d.createTexture({ size: [w, h], format: HDR, usage })
    this.bloom = []
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      const s = 2 ** (i + 1)
      this.bloom.push(d.createTexture({ size: [Math.max(1, Math.floor(w / s)), Math.max(1, Math.floor(h / s))], format: HDR, usage }))
    }
    const group = (src: GPUTexture, params: GPUBuffer, extra: GPUTexture = src) =>
      d.createBindGroup({
        layout: this.postLayout,
        entries: [
          { binding: 0, resource: src.createView() },
          { binding: 1, resource: this.sampler },
          { binding: 2, resource: { buffer: params } },
          { binding: 3, resource: extra.createView() },
          { binding: 4, resource: { buffer: this.gradeBuf } },
        ],
      })
    const down: GPUBindGroup[] = []
    const up: GPUBindGroup[] = []
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      const src = i === 0 ? this.hdr : this.bloom[i - 1]!
      down.push(group(src, this.postParams[i]!))
      d.queue.writeBuffer(this.postParams[i]!, 0, new Float32Array([1 / src.width, 1 / src.height, i === 0 ? 1 : 0, 0]))
    }
    for (let i = BLOOM_LEVELS - 1; i > 0; i--) up.push(group(this.bloom[i]!, this.postParams[i]!))
    this.postGroups = { down, up, composite: group(this.hdr, this.postParams[0]!, this.bloom[0]!) }
  }

  render(f: FrameInput): void {
    const d = this.device
    d.queue.writeBuffer(this.frameBuf, 0, f.frame)
    d.queue.writeBuffer(this.lightBuf, 0, f.lights)
    d.queue.writeBuffer(this.gradeBuf, 0, new Float32Array(f.grade))

    const total = f.batches.reduce((s, b) => s + b.count, 0)
    if (total > this.inst.cap) {
      this.inst.buf.destroy()
      this.inst.cap = Math.ceil(total * 1.5)
      this.inst.buf = d.createBuffer({ size: this.inst.cap * INST_FLOATS * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    }
    const ranges: { model: number; first: number; count: number; alpha: boolean }[] = []
    let off = 0
    for (const b of f.batches) {
      if (!b.count) continue
      d.queue.writeBuffer(this.inst.buf, off * INST_FLOATS * 4, b.data.buffer, b.data.byteOffset, b.count * INST_FLOATS * 4)
      ranges.push({ model: b.model, first: off, count: b.count, alpha: !!b.alpha })
      off += b.count
    }
    const half = MAX_SPRITES / 2
    const alphaCount = Math.min(f.alphaCount, half)
    const addCount = Math.min(f.addCount, half)
    if (alphaCount) d.queue.writeBuffer(this.sprites, 0, f.alphaSprites.buffer, 0, alphaCount * SPRITE_FLOATS * 4)
    const addOffset = half * SPRITE_FLOATS * 4
    if (addCount) d.queue.writeBuffer(this.sprites, addOffset, f.addSprites.buffer, 0, addCount * SPRITE_FLOATS * 4)

    const enc = d.createCommandEncoder()
    const cp = enc.beginComputePass()
    cp.setPipeline(this.polarPipe)
    cp.setBindGroup(0, this.computeGroup)
    cp.dispatchWorkgroups(Math.ceil((SLOTS * POLAR_RAYS) / 64))
    cp.end()

    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: this.msaa.createView(), resolveTarget: this.hdr.createView(), clearValue: { r: 0.004, g: 0.006, b: 0.014, a: 1 }, loadOp: "clear", storeOp: "discard" }],
      depthStencilAttachment: { view: this.depth.createView(), depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "discard" },
    })
    pass.setBindGroup(0, this.sceneGroup)
    if (this.level?.count) {
      pass.setPipeline(this.pipes.level!)
      pass.setVertexBuffer(0, this.level.buf)
      pass.draw(this.level.count)
    }
    pass.setVertexBuffer(1, this.inst.buf)
    for (const alpha of [false, true]) {
      pass.setPipeline(alpha ? this.pipes.instAlpha! : this.pipes.inst!)
      for (const r of ranges) {
        if (r.alpha !== alpha) continue
        const m = this.models[r.model]!
        pass.setVertexBuffer(0, m.buf)
        pass.draw(m.count, r.count, 0, r.first)
      }
      if (!alpha && this.glass?.count) {
        pass.setPipeline(this.pipes.glass!)
        pass.setVertexBuffer(0, this.glass.buf)
        pass.draw(this.glass.count)
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
      const p = enc.beginRenderPass({ colorAttachments: [{ view: this.bloom[i]!.createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }] })
      p.setPipeline(this.pipes.down!)
      p.setBindGroup(0, g.down[i]!)
      p.draw(3)
      p.end()
    }
    for (let k = 0; k < BLOOM_LEVELS - 1; k++) {
      const p = enc.beginRenderPass({ colorAttachments: [{ view: this.bloom[BLOOM_LEVELS - 2 - k]!.createView(), loadOp: "load", storeOp: "store" }] })
      p.setPipeline(this.pipes.up!)
      p.setBindGroup(0, g.up[k]!)
      p.draw(3)
      p.end()
    }
    const fp = enc.beginRenderPass({ colorAttachments: [{ view: this.context.getCurrentTexture().createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }] })
    fp.setPipeline(this.pipes.composite!)
    fp.setBindGroup(0, g.composite)
    fp.draw(3)
    fp.end()
    d.queue.submit([enc.finish()])
  }
}
