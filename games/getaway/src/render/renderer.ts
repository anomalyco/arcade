import { SmokeRenderer } from "./smoke"
import type { SmokeTrail } from "../game/smoke-trail"
import { FLOATS_PER_VERT, type Mesh } from "./mesh"
import { ATLAS_SIZE } from "./atlas"
import { type CityChunk, partitionCityMesh } from "./city-mesh"
import { MAX_LIGHTS, beamShader, litShader, postShader, shadowShader, spriteShader } from "./shaders"

const SAMPLES = 4
const SHADOW_SIZE = 2048
const HDR: GPUTextureFormat = "rgba16float"
export const FRAME_FLOATS = 16 * 2 + 4 * 8
export const INST_FLOATS = 12
export const SPRITE_FLOATS = 12
const MAX_SPRITES = 6000
const BLOOM_LEVELS = 5

type Model = { vbuf: GPUBuffer; count: number; castsShadow: boolean }
type CityModel = { vbuf: GPUBuffer; count: number; chunks: CityChunk[] }

/** One instanced draw: a model and its packed instance data. */
export type InstanceBatch = { model: number; data: Float32Array; count: number; ghost?: boolean; ghostCount?: number; noShadow?: boolean }

/** Extracts the 6 clip-space frustum planes (Left, Right, Bottom, Top, Near, Far) from a column-major 4x4 matrix at `mOff`. */
function extractFrustumPlanes(m: Float32Array, mOff: number, out: Float32Array) {
  const m0 = m[mOff]!,
    m1 = m[mOff + 1]!,
    m2 = m[mOff + 2]!,
    m3 = m[mOff + 3]!
  const m4 = m[mOff + 4]!,
    m5 = m[mOff + 5]!,
    m6 = m[mOff + 6]!,
    m7 = m[mOff + 7]!
  const m8 = m[mOff + 8]!,
    m9 = m[mOff + 9]!,
    m10 = m[mOff + 10]!,
    m11 = m[mOff + 11]!
  const m12 = m[mOff + 12]!,
    m13 = m[mOff + 13]!,
    m14 = m[mOff + 14]!,
    m15 = m[mOff + 15]!
  // Left
  out[0] = m3 + m0
  out[1] = m7 + m4
  out[2] = m11 + m8
  out[3] = m15 + m12
  // Right
  out[4] = m3 - m0
  out[5] = m7 - m4
  out[6] = m11 - m8
  out[7] = m15 - m12
  // Bottom
  out[8] = m3 + m1
  out[9] = m7 + m5
  out[10] = m11 + m9
  out[11] = m15 + m13
  // Top
  out[12] = m3 - m1
  out[13] = m7 - m5
  out[14] = m11 - m9
  out[15] = m15 - m13
  // Near (WebGPU 0..1 depth)
  out[16] = m2
  out[17] = m6
  out[18] = m10
  out[19] = m14
  // Far
  out[20] = m3 - m2
  out[21] = m7 - m6
  out[22] = m11 - m10
  out[23] = m15 - m14
}

function aabbInFrustum(
  planes: Float32Array,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
): boolean {
  for (let i = 0; i < 24; i += 4) {
    const px = planes[i]!,
      py = planes[i + 1]!,
      pz = planes[i + 2]!,
      pw = planes[i + 3]!
    const vx = px >= 0 ? maxX : minX
    const vy = py >= 0 ? maxY : minY
    const vz = pz >= 0 ? maxZ : minZ
    if (px * vx + py * vy + pz * vz + pw < 0) return false
  }
  return true
}

export class Renderer {
  private readonly smoke: SmokeRenderer
  private frameBuf: GPUBuffer
  private lightBuf: GPUBuffer
  private instBuf: GPUBuffer
  private spriteBuf: GPUBuffer
  private shadowTex: GPUTexture
  private shadowView: GPUTextureView
  private mainGroup: GPUBindGroup
  private shadowGroup: GPUBindGroup
  private pipes: Record<string, GPURenderPipeline> = {}
  private city: CityModel | null = null
  private beams: { buf: GPUBuffer; count: number; cap: number } | null = null
  private atlas: GPUTexture
  private models: Model[] = []
  private msaa!: GPUTexture
  private msaaView!: GPUTextureView
  private depth!: GPUTexture
  private depthView!: GPUTextureView
  private hdr!: GPUTexture
  private hdrView!: GPUTextureView
  private bloom: GPUTexture[] = []
  private bloomViews: GPUTextureView[] = []
  private postGroups: { down: GPUBindGroup[]; up: GPUBindGroup[]; composite: GPUBindGroup } | null = null
  private postParams: GPUBuffer[] = []
  private upParams: GPUBuffer[] = []
  private compositeParams: GPUBuffer
  private compositeData = new Float32Array(4)
  private camPlanes = new Float32Array(24)
  private shadowPlanes = new Float32Array(24)
  private postLayout: GPUBindGroupLayout
  private sampler: GPUSampler
  private width = 1
  private height = 1
  private maxInst = 512
  stats = {
    cityVertsDrawn: 0,
    mainCityVertsDrawn: 0,
    shadowCityVertsDrawn: 0,
    chunksDrawn: 0,
    mainChunksDrawn: 0,
    shadowChunksDrawn: 0,
    totalChunks: 1,
  }

  constructor(
    private device: GPUDevice,
    private context: GPUCanvasContext,
    private format: GPUTextureFormat,
  ) {
    const d = device
    this.frameBuf = d.createBuffer({ size: FRAME_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.lightBuf = d.createBuffer({ size: MAX_LIGHTS * 12 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
    this.instBuf = d.createBuffer({ size: this.maxInst * INST_FLOATS * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    this.spriteBuf = d.createBuffer({ size: MAX_SPRITES * SPRITE_FLOATS * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    this.compositeParams = d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.shadowTex = d.createTexture({ size: [SHADOW_SIZE, SHADOW_SIZE], format: "depth32float", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING })
    this.shadowView = this.shadowTex.createView()
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
        { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
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
        { binding: 2, resource: this.shadowView },
        { binding: 3, resource: d.createSampler({ compare: "less", magFilter: "linear", minFilter: "linear" }) },
        { binding: 4, resource: this.atlas.createView() },
        { binding: 5, resource: d.createSampler({ magFilter: "linear", minFilter: "linear", mipmapFilter: "linear", maxAnisotropy: 8 }) },
      ],
    })
    this.smoke = new SmokeRenderer(d, mainLayout)
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
        depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "less", depthBias: 1, depthBiasSlopeScale: 1.2 },
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
    for (let i = 0; i < BLOOM_LEVELS - 1; i++) this.upParams.push(d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }))
  }

  private upload(data: Float32Array) {
    const b = this.device.createBuffer({ size: Math.max(16, data.byteLength), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST, mappedAtCreation: true })
    new Float32Array(b.getMappedRange()).set(data)
    b.unmap()
    return b
  }

  setCity(mesh: Mesh) {
    const part = partitionCityMesh(mesh, 64)
    this.city = { vbuf: this.upload(part.data), count: part.count, chunks: part.chunks }
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

  addModel(mesh: Mesh, castsShadow = true) {
    this.models.push({ vbuf: this.upload(mesh.toArray()), count: mesh.count, castsShadow })
    return this.models.length - 1
  }

  replaceModel(id: number, mesh: Mesh) {
    const model = this.models[id]!
    const vbuf = this.upload(mesh.toArray())
    model.vbuf.destroy()
    model.vbuf = vbuf
    model.count = mesh.count
  }

  setSmoke(trail: SmokeTrail, visible: boolean) { this.smoke.upload(trail, visible) }

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
    this.msaaView = this.msaa.createView()
    this.depth = d.createTexture({ size: [w, h], format: "depth24plus-stencil8", sampleCount: SAMPLES, usage: GPUTextureUsage.RENDER_ATTACHMENT })
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
    for (let i = BLOOM_LEVELS - 1; i > 0; i--) {
      const bTex = this.bloom[i]!
      const upBuf = this.upParams[i - 1]!
      d.queue.writeBuffer(upBuf, 0, new Float32Array([1 / bTex.width, 1 / bTex.height, 0, 0]))
      up.push(group(this.bloomViews[i]!, upBuf))
    }
    this.postGroups = { down, up, composite: group(this.hdrView, this.compositeParams, this.bloomViews[0]!) }
  }

  private ensureInstances(n: number) {
    if (n <= this.maxInst) return
    this.maxInst = Math.ceil(n * 1.5)
    this.instBuf.destroy()
    this.instBuf = this.device.createBuffer({ size: this.maxInst * INST_FLOATS * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
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
    this.compositeData[2] = opts.bloom
    this.compositeData[3] = opts.flash
    d.queue.writeBuffer(this.compositeParams, 0, this.compositeData)

    // Pack all instance batches into one buffer (reusing instBuf for ghost silhouettes).
    let total = 0
    for (let i = 0; i < opts.batches.length; i++) total += opts.batches[i]!.count
    let extraGhostTotal = 0
    for (let i = 0; i < opts.ghosts.length; i++) extraGhostTotal += opts.ghosts[i]!.count
    this.ensureInstances(total + extraGhostTotal)

    const ranges: { model: number; first: number; count: number; noShadow?: boolean }[] = []
    const ghostRanges: { model: number; first: number; count: number }[] = []
    let off = 0
    for (let i = 0; i < opts.batches.length; i++) {
      const b = opts.batches[i]!
      if (!b.count) continue
      d.queue.writeBuffer(this.instBuf, off * INST_FLOATS * 4, b.data.buffer, b.data.byteOffset, b.count * INST_FLOATS * 4)
      ranges.push({ model: b.model, first: off, count: b.count, noShadow: b.noShadow })
      if (b.ghostCount && b.ghostCount > 0) {
        ghostRanges.push({ model: b.model, first: off, count: b.ghostCount })
      }
      off += b.count
    }
    for (let i = 0; i < opts.ghosts.length; i++) {
      const b = opts.ghosts[i]!
      if (!b.count) continue
      d.queue.writeBuffer(this.instBuf, off * INST_FLOATS * 4, b.data.buffer, b.data.byteOffset, b.count * INST_FLOATS * 4)
      ghostRanges.push({ model: b.model, first: off, count: b.count })
      off += b.count
    }
    const alphaCount = Math.min(opts.sprites.alphaCount, MAX_SPRITES / 2)
    const addCount = Math.min(opts.sprites.addCount, MAX_SPRITES / 2)
    if (alphaCount) d.queue.writeBuffer(this.spriteBuf, 0, opts.sprites.alpha.buffer, 0, alphaCount * SPRITE_FLOATS * 4)
    const addOffset = (MAX_SPRITES / 2) * SPRITE_FLOATS * 4
    if (addCount) d.queue.writeBuffer(this.spriteBuf, addOffset, opts.sprites.add.buffer, 0, addCount * SPRITE_FLOATS * 4)

    extractFrustumPlanes(opts.frame, 0, this.camPlanes)
    extractFrustumPlanes(opts.frame, 16, this.shadowPlanes)

    const enc = d.createCommandEncoder()
    const sp = enc.beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: { view: this.shadowView, depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" },
    })
    sp.setBindGroup(0, this.shadowGroup)
    let shadowCityVerts = 0
    let shadowChunks = 0
    if (this.city) {
      sp.setPipeline(this.pipes.shadowCity!)
      sp.setVertexBuffer(0, this.city.vbuf)
      const chunks = this.city.chunks
      let runFirst = -1
      let runCount = 0
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i]!
        // Only cast shadows above ground level, and only if the chunk or its moon shadow intersects the camera frustum.
        const sweep = Math.max(0, c.maxY) * 0.92
        const vis =
          c.maxY > 0.05 &&
          aabbInFrustum(this.shadowPlanes, c.minX, c.minY, c.minZ, c.maxX, c.maxY, c.maxZ) &&
          aabbInFrustum(this.camPlanes, c.minX, 0, c.minZ, c.maxX + sweep, c.maxY, c.maxZ + sweep)
        if (vis) {
          shadowCityVerts += c.count
          shadowChunks++
          if (runFirst >= 0 && runFirst + runCount === c.first) {
            runCount += c.count
          } else {
            if (runCount > 0) sp.draw(runCount, 1, runFirst, 0)
            runFirst = c.first
            runCount = c.count
          }
        }
      }
      if (runCount > 0) sp.draw(runCount, 1, runFirst, 0)
    }
    sp.setPipeline(this.pipes.shadowInst!)
    sp.setVertexBuffer(1, this.instBuf)
    for (let i = 0; i < ranges.length; i++) {
      const r = ranges[i]!
      if (r.noShadow) continue
      const m = this.models[r.model]!
      if (!m.castsShadow) continue
      sp.setVertexBuffer(0, m.vbuf)
      sp.draw(m.count, r.count, 0, r.first)
    }
    sp.end()

    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: this.msaaView, resolveTarget: this.hdrView, clearValue: { r: 0.02, g: 0.025, b: 0.04, a: 1 }, loadOp: "clear", storeOp: "discard" }],
      depthStencilAttachment: {
        view: this.depthView,
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
    let mainCityVerts = 0
    let mainChunks = 0
    if (this.city) {
      pass.setPipeline(this.pipes.city!)
      pass.setVertexBuffer(0, this.city.vbuf)
      const chunks = this.city.chunks
      let runFirst = -1
      let runCount = 0
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i]!
        if (aabbInFrustum(this.camPlanes, c.minX, c.minY, c.minZ, c.maxX, c.maxY, c.maxZ)) {
          mainCityVerts += c.count
          mainChunks++
          if (runFirst >= 0 && runFirst + runCount === c.first) {
            runCount += c.count
          } else {
            if (runCount > 0) pass.draw(runCount, 1, runFirst, 0)
            runFirst = c.first
            runCount = c.count
          }
        }
      }
      if (runCount > 0) pass.draw(runCount, 1, runFirst, 0)
    }
    this.stats = {
      cityVertsDrawn: shadowCityVerts + mainCityVerts,
      mainCityVertsDrawn: mainCityVerts,
      shadowCityVertsDrawn: shadowCityVerts,
      chunksDrawn: shadowChunks + mainChunks,
      mainChunksDrawn: mainChunks,
      shadowChunksDrawn: shadowChunks,
      totalChunks: this.city?.chunks.length ?? 1,
    }
    pass.setPipeline(this.pipes.inst!)
    pass.setVertexBuffer(1, this.instBuf)
    for (let i = 0; i < ranges.length; i++) {
      const r = ranges[i]!
      const m = this.models[r.model]!
      pass.setVertexBuffer(0, m.vbuf)
      pass.draw(m.count, r.count, 0, r.first)
    }
    if (alphaCount) {
      pass.setPipeline(this.pipes.spriteAlpha!)
      pass.setVertexBuffer(0, this.spriteBuf, 0)
      pass.draw(6, alphaCount)
    }
    this.smoke.draw(pass)
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
      pass.setVertexBuffer(1, this.instBuf)
      for (let i = 0; i < ghostRanges.length; i++) {
        const r = ghostRanges[i]!
        const m = this.models[r.model]!
        pass.setVertexBuffer(0, m.vbuf)
        pass.draw(m.count, r.count, 0, r.first)
      }
    }
    pass.end()

    // Bloom: threshold + downsample chain, then additive upsample back to half resolution.
    const g = this.postGroups!
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      const p = enc.beginRenderPass({ colorAttachments: [{ view: this.bloomViews[i]!, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }] })
      p.setPipeline(this.pipes.down!)
      p.setBindGroup(0, g.down[i]!)
      p.draw(3)
      p.end()
    }
    for (let k = 0; k < BLOOM_LEVELS - 1; k++) {
      const targetView = this.bloomViews[BLOOM_LEVELS - 2 - k]!
      const p = enc.beginRenderPass({ colorAttachments: [{ view: targetView, loadOp: "load", storeOp: "store" }] })
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
