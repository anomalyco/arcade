import { FLOATS_PER_VERT, type Mesh } from "./mesh"
import { ATLAS_SIZE } from "./atlas"
import { MAX_LIGHTS, beamShader, litShader, postShader, shadowShader, spriteShader } from "./shaders"

const SAMPLES = 4
const SHADOW_SIZE = 2048
const HDR: GPUTextureFormat = "rgba16float"
export const FRAME_FLOATS = 16 * 2 + 4 * 8
export const INST_FLOATS = 12
export const SPRITE_FLOATS = 12
const MAX_SPRITES = 6000
const BLOOM_LEVELS = 5

type Model = { vbuf: GPUBuffer; count: number }

/** One instanced draw: a model and its packed instance data. */
export type InstanceBatch = { model: number; data: Float32Array; count: number; ghost?: boolean }

export class Renderer {
  private frameBuf: GPUBuffer
  private lightBuf: GPUBuffer
  private instBuf: GPUBuffer
  private ghostBuf: GPUBuffer
  private spriteBuf: GPUBuffer
  private shadowTex: GPUTexture
  private mainGroup: GPUBindGroup
  private shadowGroup: GPUBindGroup
  private pipes: Record<string, GPURenderPipeline> = {}
  private city: Model | null = null
  private beams: { buf: GPUBuffer; count: number; cap: number } | null = null
  private atlas: GPUTexture
  private models: Model[] = []
  private msaa!: GPUTexture
  private depth!: GPUTexture
  private hdr!: GPUTexture
  private bloom: GPUTexture[] = []
  private postGroups: { down: GPUBindGroup[]; up: GPUBindGroup[]; composite: GPUBindGroup } | null = null
  private postParams: GPUBuffer[] = []
  private compositeParams: GPUBuffer
  private postLayout: GPUBindGroupLayout
  private sampler: GPUSampler
  private width = 1
  private height = 1
  private maxInst = 512

  constructor(
    private device: GPUDevice,
    private context: GPUCanvasContext,
    private format: GPUTextureFormat,
  ) {
    const d = device
    this.frameBuf = d.createBuffer({ size: FRAME_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.lightBuf = d.createBuffer({ size: MAX_LIGHTS * 12 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
    this.instBuf = d.createBuffer({ size: this.maxInst * INST_FLOATS * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    this.ghostBuf = d.createBuffer({ size: this.maxInst * INST_FLOATS * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    this.spriteBuf = d.createBuffer({ size: MAX_SPRITES * SPRITE_FLOATS * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    this.compositeParams = d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.shadowTex = d.createTexture({ size: [SHADOW_SIZE, SHADOW_SIZE], format: "depth32float", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING })
    this.sampler = d.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" })

    this.atlas = d.createTexture({
      size: [ATLAS_SIZE, ATLAS_SIZE],
      format: "rgba8unorm",
      mipLevelCount: Math.log2(ATLAS_SIZE) + 1,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    })
    d.queue.writeTexture({ texture: this.atlas }, new Uint8Array(16 * 16 * 4).fill(255), { bytesPerRow: 16 * 4 }, [16, 16])
    const vis = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT
    const mainLayout = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: vis, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth" } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "comparison" } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    })
    this.mainGroup = d.createBindGroup({
      layout: mainLayout,
      entries: [
        { binding: 0, resource: { buffer: this.frameBuf } },
        { binding: 1, resource: { buffer: this.lightBuf } },
        { binding: 2, resource: this.shadowTex.createView() },
        { binding: 3, resource: d.createSampler({ compare: "less", magFilter: "linear", minFilter: "linear" }) },
        { binding: 4, resource: this.atlas.createView() },
        { binding: 5, resource: d.createSampler({ magFilter: "linear", minFilter: "linear", mipmapFilter: "linear", maxAnisotropy: 8 }) },
      ],
    })
    const shadowLayout = d.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } }] })
    this.shadowGroup = d.createBindGroup({ layout: shadowLayout, entries: [{ binding: 0, resource: { buffer: this.frameBuf } }] })
    this.postLayout = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      ],
    })

    const meshLayout: GPUVertexBufferLayout = {
      arrayStride: FLOATS_PER_VERT * 4,
      attributes: [
        { shaderLocation: 0, offset: 0, format: "float32x3" },
        { shaderLocation: 1, offset: 12, format: "float32x3" },
        { shaderLocation: 2, offset: 24, format: "float32x3" },
        { shaderLocation: 3, offset: 36, format: "float32" },
        { shaderLocation: 7, offset: 40, format: "float32x2" },
      ],
    }
    const meshPosOnly: GPUVertexBufferLayout = { arrayStride: FLOATS_PER_VERT * 4, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] }
    const instLayout: GPUVertexBufferLayout = {
      arrayStride: INST_FLOATS * 4,
      stepMode: "instance",
      attributes: [
        { shaderLocation: 4, offset: 0, format: "float32x4" },
        { shaderLocation: 5, offset: 16, format: "float32x4" },
        { shaderLocation: 6, offset: 32, format: "float32x4" },
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

    const main = d.createPipelineLayout({ bindGroupLayouts: [mainLayout] })
    const lit = d.createShaderModule({ code: litShader })
    // Cars write stencil 1 where they are visible; the silhouette pass draws only hidden car pixels (depth greater, stencil != 1).
    const scene = (
      vs: string,
      fs: string,
      buffers: GPUVertexBufferLayout[],
      opts: { blend?: GPUBlendState; depthWrite?: boolean; compare?: GPUCompareFunction; cull?: GPUCullMode; stencil?: GPUStencilFaceState } = {},
      module = lit,
    ) =>
      d.createRenderPipeline({
        layout: main,
        vertex: { module, entryPoint: vs, buffers },
        fragment: { module, entryPoint: fs, targets: [{ format: HDR, blend: opts.blend }] },
        primitive: { topology: "triangle-list", cullMode: opts.cull ?? "back" },
        depthStencil: {
          format: "depth24plus-stencil8",
          depthWriteEnabled: opts.depthWrite ?? true,
          depthCompare: opts.compare ?? "less",
          stencilFront: opts.stencil,
          stencilBack: opts.stencil,
        },
        multisample: { count: SAMPLES },
      })
    const alpha: GPUBlendState = {
      color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
      alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
    }
    const additive: GPUBlendState = { color: { srcFactor: "one", dstFactor: "one" }, alpha: { srcFactor: "one", dstFactor: "one" } }
    const sprite = d.createShaderModule({ code: spriteShader })
    const shadowMod = d.createShaderModule({ code: shadowShader })
    const shadowPipe = (vs: string, buffers: GPUVertexBufferLayout[]) =>
      d.createRenderPipeline({
        layout: d.createPipelineLayout({ bindGroupLayouts: [shadowLayout] }),
        vertex: { module: shadowMod, entryPoint: vs, buffers },
        primitive: { topology: "triangle-list", cullMode: "none" },
        depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "less", depthBias: 2, depthBiasSlopeScale: 2 },
      })
    const post = d.createShaderModule({ code: postShader })
    const postLayout = d.createPipelineLayout({ bindGroupLayouts: [this.postLayout] })
    const postPipe = (fs: string, format: GPUTextureFormat, blend?: GPUBlendState) =>
      d.createRenderPipeline({ layout: postLayout, vertex: { module: post, entryPoint: "vs" }, fragment: { module: post, entryPoint: fs, targets: [{ format, blend }] }, primitive: { topology: "triangle-list" } })
    this.pipes = {
      city: scene("vsStatic", "fs", [meshLayout]),
      inst: scene("vsInst", "fs", [meshLayout, instLayout], { stencil: { compare: "always", passOp: "replace" } }),
      ghost: scene("vsGhost", "fsGhost", [meshLayout, instLayout], { blend: alpha, depthWrite: false, compare: "greater", cull: "back", stencil: { compare: "not-equal", passOp: "keep" } }),
      beam: scene("vs", "fs", [meshLayout], { blend: additive, depthWrite: false, cull: "none" }, d.createShaderModule({ code: beamShader })),
      spriteAlpha: scene("vs", "fs", [spriteLayout], { blend: alpha, depthWrite: false, cull: "none" }, sprite),
      spriteAdd: scene("vs", "fs", [spriteLayout], { blend: additive, depthWrite: false, cull: "none" }, sprite),
      shadowCity: shadowPipe("vsStatic", [meshPosOnly]),
      shadowInst: shadowPipe("vsInst", [meshPosOnly, instLayout]),
      down: postPipe("down", HDR),
      up: postPipe("up", HDR, additive),
      composite: postPipe("composite", format),
    }
    for (let i = 0; i < BLOOM_LEVELS; i++) this.postParams.push(d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }))
  }

  private upload(data: Float32Array) {
    const b = this.device.createBuffer({ size: Math.max(16, data.byteLength), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST, mappedAtCreation: true })
    new Float32Array(b.getMappedRange()).set(data)
    b.unmap()
    return b
  }

  setCity(mesh: Mesh) {
    this.city = { vbuf: this.upload(mesh.toArray()), count: mesh.count }
  }

  /** Uploads the decal atlas and builds its mip chain on the CPU (box filter, alpha-weighted). */
  setAtlas(img: ImageData) {
    let w = img.width
    let level = new Uint8Array(img.data.buffer.slice(0))
    for (let mip = 0; w >= 1; mip++) {
      this.device.queue.writeTexture({ texture: this.atlas, mipLevel: mip }, level, { bytesPerRow: w * 4 }, [w, w])
      if (w === 1) break
      const n = w >> 1
      const next = new Uint8Array(n * n * 4)
      for (let y = 0; y < n; y++)
        for (let x = 0; x < n; x++) {
          let r = 0, g = 0, b = 0, a = 0
          for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
            const i = ((y * 2 + dy!) * w + x * 2 + dx!) * 4
            const al = level[i + 3]!
            r += level[i]! * al
            g += level[i + 1]! * al
            b += level[i + 2]! * al
            a += al
          }
          const o = (y * n + x) * 4
          next[o] = a ? r / a : 0
          next[o + 1] = a ? g / a : 0
          next[o + 2] = a ? b / a : 0
          next[o + 3] = Math.min(255, (a / 4) * 1.1)
        }
      level = next
      w = n
    }
  }

  /** World-space beam geometry (heli spotlight cone, extraction column), rewritten every frame. */
  setBeams(data: Float32Array<ArrayBuffer>, count: number) {
    if (!this.beams || this.beams.cap < data.byteLength) {
      this.beams?.buf.destroy()
      const cap = Math.max(4096, data.byteLength * 2)
      this.beams = { buf: this.device.createBuffer({ size: cap, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST }), count: 0, cap }
    }
    if (count) this.device.queue.writeBuffer(this.beams.buf, 0, data.buffer, data.byteOffset, count * FLOATS_PER_VERT * 4)
    this.beams.count = count
  }

  addModel(mesh: Mesh) {
    this.models.push({ vbuf: this.upload(mesh.toArray()), count: mesh.count })
    return this.models.length - 1
  }

  resize(w: number, h: number) {
    if (w === this.width && h === this.height && this.hdr) return
    this.width = w
    this.height = h
    this.msaa?.destroy()
    this.depth?.destroy()
    this.hdr?.destroy()
    for (const b of this.bloom) b.destroy()
    const d = this.device
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    this.msaa = d.createTexture({ size: [w, h], format: HDR, sampleCount: SAMPLES, usage: GPUTextureUsage.RENDER_ATTACHMENT })
    this.depth = d.createTexture({ size: [w, h], format: "depth24plus-stencil8", sampleCount: SAMPLES, usage: GPUTextureUsage.RENDER_ATTACHMENT })
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
    this.postGroups = { down, up, composite: group(this.hdr, this.compositeParams, this.bloom[0]!) }
  }

  private ensureInstances(n: number) {
    if (n <= this.maxInst) return
    this.maxInst = Math.ceil(n * 1.5)
    this.instBuf.destroy()
    this.ghostBuf.destroy()
    this.instBuf = this.device.createBuffer({ size: this.maxInst * INST_FLOATS * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    this.ghostBuf = this.device.createBuffer({ size: this.maxInst * INST_FLOATS * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
  }

  render(opts: {
    frame: Float32Array<ArrayBuffer>
    lights: Float32Array<ArrayBuffer>
    batches: InstanceBatch[]
    ghosts: InstanceBatch[]
    sprites: { alpha: Float32Array<ArrayBuffer>; alphaCount: number; add: Float32Array<ArrayBuffer>; addCount: number }
    bloom: number
    flash: number
  }) {
    const d = this.device
    d.queue.writeBuffer(this.frameBuf, 0, opts.frame)
    d.queue.writeBuffer(this.lightBuf, 0, opts.lights)
    d.queue.writeBuffer(this.compositeParams, 0, new Float32Array([0, 0, opts.bloom, opts.flash]))

    // Pack all instance batches into one buffer.
    const total = opts.batches.reduce((s, b) => s + b.count, 0)
    const ghostTotal = opts.ghosts.reduce((s, b) => s + b.count, 0)
    this.ensureInstances(Math.max(total, ghostTotal))
    const ranges: { model: number; first: number; count: number }[] = []
    let off = 0
    for (const b of opts.batches) {
      if (!b.count) continue
      d.queue.writeBuffer(this.instBuf, off * INST_FLOATS * 4, b.data.buffer, b.data.byteOffset, b.count * INST_FLOATS * 4)
      ranges.push({ model: b.model, first: off, count: b.count })
      off += b.count
    }
    const ghostRanges: { model: number; first: number; count: number }[] = []
    off = 0
    for (const b of opts.ghosts) {
      if (!b.count) continue
      d.queue.writeBuffer(this.ghostBuf, off * INST_FLOATS * 4, b.data.buffer, b.data.byteOffset, b.count * INST_FLOATS * 4)
      ghostRanges.push({ model: b.model, first: off, count: b.count })
      off += b.count
    }
    const alphaCount = Math.min(opts.sprites.alphaCount, MAX_SPRITES / 2)
    const addCount = Math.min(opts.sprites.addCount, MAX_SPRITES / 2)
    if (alphaCount) d.queue.writeBuffer(this.spriteBuf, 0, opts.sprites.alpha.buffer, 0, alphaCount * SPRITE_FLOATS * 4)
    const addOffset = (MAX_SPRITES / 2) * SPRITE_FLOATS * 4
    if (addCount) d.queue.writeBuffer(this.spriteBuf, addOffset, opts.sprites.add.buffer, 0, addCount * SPRITE_FLOATS * 4)

    const enc = d.createCommandEncoder()
    const sp = enc.beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: { view: this.shadowTex.createView(), depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" },
    })
    sp.setBindGroup(0, this.shadowGroup)
    if (this.city) {
      sp.setPipeline(this.pipes.shadowCity!)
      sp.setVertexBuffer(0, this.city.vbuf)
      sp.draw(this.city.count)
    }
    sp.setPipeline(this.pipes.shadowInst!)
    sp.setVertexBuffer(1, this.instBuf)
    for (const r of ranges) {
      const m = this.models[r.model]!
      sp.setVertexBuffer(0, m.vbuf)
      sp.draw(m.count, r.count, 0, r.first)
    }
    sp.end()

    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: this.msaa.createView(), resolveTarget: this.hdr.createView(), clearValue: { r: 0.02, g: 0.025, b: 0.04, a: 1 }, loadOp: "clear", storeOp: "discard" }],
      depthStencilAttachment: {
        view: this.depth.createView(),
        depthClearValue: 1,
        depthLoadOp: "clear",
        depthStoreOp: "discard",
        stencilClearValue: 0,
        stencilLoadOp: "clear",
        stencilStoreOp: "discard",
      },
    })
    pass.setBindGroup(0, this.mainGroup)
    pass.setStencilReference(1)
    if (this.city) {
      pass.setPipeline(this.pipes.city!)
      pass.setVertexBuffer(0, this.city.vbuf)
      pass.draw(this.city.count)
    }
    pass.setPipeline(this.pipes.inst!)
    pass.setVertexBuffer(1, this.instBuf)
    for (const r of ranges) {
      const m = this.models[r.model]!
      pass.setVertexBuffer(0, m.vbuf)
      pass.draw(m.count, r.count, 0, r.first)
    }
    if (alphaCount) {
      pass.setPipeline(this.pipes.spriteAlpha!)
      pass.setVertexBuffer(0, this.spriteBuf, 0)
      pass.draw(6, alphaCount)
    }
    if (addCount) {
      pass.setPipeline(this.pipes.spriteAdd!)
      pass.setVertexBuffer(0, this.spriteBuf, addOffset)
      pass.draw(6, addCount)
    }
    if (this.beams?.count) {
      pass.setPipeline(this.pipes.beam!)
      pass.setVertexBuffer(0, this.beams.buf)
      pass.draw(this.beams.count)
    }
    if (ghostRanges.length) {
      pass.setPipeline(this.pipes.ghost!)
      pass.setVertexBuffer(1, this.ghostBuf)
      for (const r of ghostRanges) {
        const m = this.models[r.model]!
        pass.setVertexBuffer(0, m.vbuf)
        pass.draw(m.count, r.count, 0, r.first)
      }
    }
    pass.end()

    // Bloom: threshold + downsample chain, then additive upsample back to half resolution.
    const g = this.postGroups!
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      const p = enc.beginRenderPass({ colorAttachments: [{ view: this.bloom[i]!.createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }] })
      p.setPipeline(this.pipes.down!)
      p.setBindGroup(0, g.down[i]!)
      p.draw(3)
      p.end()
    }
    for (let k = 0; k < BLOOM_LEVELS - 1; k++) {
      const target = this.bloom[BLOOM_LEVELS - 2 - k]!
      const p = enc.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: "load", storeOp: "store" }] })
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
