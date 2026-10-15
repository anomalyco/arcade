import { LookUniformsStruct, type LookSettings, createLookSettings, packLookUniforms } from "@arcade/kit/gpu/look"
import { Mesh, VERT_BYTES, packVerts } from "@arcade/kit/gpu/mesh"
import { postShader } from "@arcade/kit/gpu/shaders"
import { BloomPyramid } from "@arcade/kit/gpu/targets"
import { ParticleRenderer } from "@arcade/kit/fx/particle-renderer"
import type { Particles } from "@arcade/kit/fx/particles"
import { FRAME_FLOATS, MAX_LIGHTS, backdropShader, compositeShader, quadShader, sceneShader, shaftShader } from "./shaders"

const HDR: GPUTextureFormat = "rgba16float"
const DEPTH: GPUTextureFormat = "depth24plus"
const SAMPLES = 4
/** Floats per part instance: position + scale, three axes (+ emissive, retention, flash), tint. */
export const INST_FLOATS = 20
/** Floats per quad: centre + half width, half height/rotation/kind, colour, extra. */
export const QUAD_FLOATS = 16

export type Model = { first: number; count: number }

/** Everything one frame needs; the game fills it, the renderer only draws. */
export type SceneFrame = {
  viewProj: Float32Array
  eye: readonly [number, number, number]
  time: number
  /** Light core of the fog backdrop: uv x, y, size, strength. */
  sun: readonly [number, number, number, number]
  /** Fog density behind the plane, ground-mist height falloff, ground-mist strength, ambient. */
  fog: readonly [number, number, number, number]
  /** Sky brightness, rim, shafts, hurt flash, slow-motion desaturation. */
  skyBrightness: number
  rim: number
  shafts: number
  hurt: number
  desat: number
  tint: readonly [number, number, number]
  lights: Float32Array
  lightCount: number
  /** Part instances grouped by model id. */
  parts: Map<number, number[]>
  /** Opaque triangles rebuilt each frame (scarves, strings, thorns). */
  dynamic: Mesh
  mist: Float32Array
  mistCount: number
  alpha: Float32Array
  alphaCount: number
  add: Float32Array
  addCount: number
  particles: Particles | null
}

/**
 * The noir side-view renderer: a fog backdrop, static silhouette layers and instanced archers into 4× MSAA HDR with
 * a second target that records where the bright fog shows through (for god rays and the silhouette rim), kit
 * particles, quads, then half-res radial light shafts, kit bloom and a composite through the kit look grade.
 */
export class Renderer {
  width = 1
  height = 1
  look: LookSettings = createLookSettings("noir_silhouette")
  private frameBuf: GPUBuffer
  private frameData = new Float32Array(FRAME_FLOATS)
  private lookBuf: GPUBuffer
  private lookData = LookUniformsStruct.createBuffer()
  private frameGroup: GPUBindGroup
  private frameLayout: GPUBindGroupLayout
  private pipes: Record<string, GPURenderPipeline> = {}
  private modelVerts: number[] = []
  private modelBuf: GPUBuffer | null = null
  private modelDirty = false
  private models: Model[] = []
  private staticBuf: GPUBuffer | null = null
  private staticCount = 0
  private dynBuf: GPUBuffer | null = null
  private dynCap = 0
  private instBuf: GPUBuffer | null = null
  private instCap = 0
  private quadBuf: GPUBuffer | null = null
  private quadCap = 0
  private instScratch = new Float32Array(0)
  private particles: ParticleRenderer
  private bloom: BloomPyramid
  private sampler: GPUSampler
  private postLayout: GPUBindGroupLayout
  private texLayout: GPUBindGroupLayout
  private compLayout: GPUBindGroupLayout
  private t: {
    msaa: GPUTexture; msaaShaft: GPUTexture; depth: GPUTexture; hdr: GPUTexture; shaftSrc: GPUTexture; shaft: GPUTexture
    shaftGroup: GPUBindGroup; compGroup: GPUBindGroup
  } | null = null
  /** GPU frame time (ms) when timestamp queries are available. */
  gpuMs = 0

  constructor(readonly device: GPUDevice, readonly context: GPUCanvasContext, readonly format: GPUTextureFormat) {
    const d = device
    this.frameBuf = d.createBuffer({ size: FRAME_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.lookBuf = d.createBuffer({ size: this.lookData.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.frameLayout = d.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }] })
    this.frameGroup = d.createBindGroup({ layout: this.frameLayout, entries: [{ binding: 0, resource: { buffer: this.frameBuf } }] })
    this.sampler = d.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" })
    this.texLayout = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    })
    this.compLayout = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      ],
    })
    this.postLayout = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      ],
    })
    this.bloom = new BloomPyramid(d, { levels: 5, format: HDR })
    this.particles = new ParticleRenderer(d, { depthFormat: DEPTH, samples: SAMPLES })
    this.buildPipelines()
  }

  private buildPipelines(): void {
    const d = this.device
    const scene = d.createShaderModule({ code: sceneShader, label: "archers scene" })
    const back = d.createShaderModule({ code: backdropShader, label: "archers backdrop" })
    const quad = d.createShaderModule({ code: quadShader, label: "archers quads" })
    const shaft = d.createShaderModule({ code: shaftShader, label: "archers shafts" })
    const comp = d.createShaderModule({ code: compositeShader, label: "archers composite" })
    const post = d.createShaderModule({ code: postShader(false), label: "kit bloom" })
    const frameOnly = d.createPipelineLayout({ bindGroupLayouts: [this.frameLayout] })
    const vert: GPUVertexBufferLayout = {
      arrayStride: VERT_BYTES,
      attributes: [
        { shaderLocation: 0, offset: 0, format: "float32x3" },
        { shaderLocation: 1, offset: 12, format: "snorm8x4" },
        { shaderLocation: 2, offset: 16, format: "unorm8x4" },
        { shaderLocation: 3, offset: 20, format: "float16x2" },
      ],
    }
    const inst: GPUVertexBufferLayout = {
      arrayStride: INST_FLOATS * 4,
      stepMode: "instance",
      attributes: [4, 5, 6, 7, 8].map((loc, i) => ({ shaderLocation: loc, offset: i * 16, format: "float32x4" as const })),
    }
    const quadLayout: GPUVertexBufferLayout = {
      arrayStride: QUAD_FLOATS * 4,
      stepMode: "instance",
      attributes: [0, 1, 2, 3].map((loc) => ({ shaderLocation: loc, offset: loc * 16, format: "float32x4" as const })),
    }
    const ms: GPUMultisampleState = { count: SAMPLES }
    const opaque: GPUColorTargetState[] = [{ format: HDR }, { format: HDR }]
    const depthOn: GPUDepthStencilState = { format: DEPTH, depthWriteEnabled: true, depthCompare: "less" }
    const depthRead: GPUDepthStencilState = { format: DEPTH, depthWriteEnabled: false, depthCompare: "less" }
    this.pipes.backdrop = d.createRenderPipeline({
      layout: frameOnly,
      vertex: { module: back, entryPoint: "vs" },
      fragment: { module: back, entryPoint: "fs", targets: opaque },
      depthStencil: { format: DEPTH, depthWriteEnabled: false, depthCompare: "always" },
      multisample: ms,
    })
    this.pipes.static = d.createRenderPipeline({
      layout: frameOnly,
      vertex: { module: scene, entryPoint: "vsStatic", buffers: [vert] },
      fragment: { module: scene, entryPoint: "fs", targets: opaque },
      primitive: { cullMode: "none" },
      depthStencil: depthOn,
      multisample: ms,
    })
    this.pipes.inst = d.createRenderPipeline({
      layout: frameOnly,
      vertex: { module: scene, entryPoint: "vsInst", buffers: [vert, inst] },
      fragment: { module: scene, entryPoint: "fs", targets: opaque },
      primitive: { cullMode: "none" },
      depthStencil: depthOn,
      multisample: ms,
    })
    const premul: GPUBlendState = { color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" }, alpha: { srcFactor: "zero", dstFactor: "one-minus-src-alpha" } }
    const additive: GPUBlendState = { color: { srcFactor: "one", dstFactor: "one" }, alpha: { operation: "max", srcFactor: "one", dstFactor: "one" } }
    const keepShaft: GPUColorTargetState = { format: HDR, writeMask: 0 }
    this.pipes.alpha = d.createRenderPipeline({
      layout: frameOnly,
      vertex: { module: quad, entryPoint: "vs", buffers: [quadLayout] },
      fragment: { module: quad, entryPoint: "fsAlpha", targets: [{ format: HDR, blend: premul }, keepShaft] },
      depthStencil: depthRead,
      multisample: ms,
    })
    this.pipes.add = d.createRenderPipeline({
      layout: frameOnly,
      vertex: { module: quad, entryPoint: "vs", buffers: [quadLayout] },
      fragment: { module: quad, entryPoint: "fsAdd", targets: [{ format: HDR, blend: additive }, keepShaft] },
      depthStencil: depthRead,
      multisample: ms,
    })
    this.pipes.shaft = d.createRenderPipeline({
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.frameLayout, this.texLayout] }),
      vertex: { module: shaft, entryPoint: "vs" },
      fragment: { module: shaft, entryPoint: "fs", targets: [{ format: HDR }] },
    })
    this.pipes.comp = d.createRenderPipeline({
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.frameLayout, this.compLayout] }),
      vertex: { module: comp, entryPoint: "vs" },
      fragment: { module: comp, entryPoint: "fs", targets: [{ format: this.format }] },
    })
    const postLayout = d.createPipelineLayout({ bindGroupLayouts: [this.postLayout] })
    this.pipes.down = d.createRenderPipeline({ layout: postLayout, vertex: { module: post, entryPoint: "vs" }, fragment: { module: post, entryPoint: "down", targets: [{ format: HDR }] } })
    this.pipes.up = d.createRenderPipeline({
      layout: postLayout,
      vertex: { module: post, entryPoint: "vs" },
      fragment: { module: post, entryPoint: "up", targets: [{ format: HDR, blend: { color: { srcFactor: "one", dstFactor: "one" }, alpha: { srcFactor: "one", dstFactor: "one" } } }] },
    })
  }

  /** Registers a part mesh; returns its model id. */
  addModel(m: Mesh): number {
    const first = this.modelVerts.length / 11
    for (const v of m.v) this.modelVerts.push(v)
    this.models.push({ first, count: m.v.length / 11 })
    this.modelDirty = true
    return this.models.length - 1
  }

  setStatic(m: Mesh): void {
    this.staticBuf?.destroy()
    const data = packVerts(m.v)
    this.staticCount = m.v.length / 11
    this.staticBuf = this.device.createBuffer({ size: Math.max(16, data.byteLength), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    this.device.queue.writeBuffer(this.staticBuf, 0, data)
  }

  resize(w: number, h: number): void {
    if (w === this.width && h === this.height && this.t) return
    this.width = w
    this.height = h
    const d = this.device
    if (this.t) for (const k of ["msaa", "msaaShaft", "depth", "hdr", "shaftSrc", "shaft"] as const) this.t[k].destroy()
    const RA = GPUTextureUsage.RENDER_ATTACHMENT, TB = GPUTextureUsage.TEXTURE_BINDING
    const msaa = d.createTexture({ size: [w, h], format: HDR, sampleCount: SAMPLES, usage: RA })
    const msaaShaft = d.createTexture({ size: [w, h], format: HDR, sampleCount: SAMPLES, usage: RA })
    const depth = d.createTexture({ size: [w, h], format: DEPTH, sampleCount: SAMPLES, usage: RA })
    const hdr = d.createTexture({ size: [w, h], format: HDR, usage: RA | TB })
    const shaftSrc = d.createTexture({ size: [w, h], format: HDR, usage: RA | TB })
    const shaft = d.createTexture({ size: [Math.max(1, w >> 1), Math.max(1, h >> 1)], format: HDR, usage: RA | TB })
    this.bloom.resize({ hdr, hdrView: hdr.createView(), layout: this.postLayout, sampler: this.sampler })
    const shaftGroup = d.createBindGroup({ layout: this.texLayout, entries: [{ binding: 0, resource: shaftSrc.createView() }, { binding: 1, resource: this.sampler }] })
    const compGroup = d.createBindGroup({
      layout: this.compLayout,
      entries: [
        { binding: 0, resource: hdr.createView() },
        { binding: 1, resource: this.bloom.views[0]! },
        { binding: 2, resource: shaft.createView() },
        { binding: 3, resource: shaftSrc.createView() },
        { binding: 4, resource: this.sampler },
        { binding: 5, resource: { buffer: this.lookBuf } },
      ],
    })
    this.t = { msaa, msaaShaft, depth, hdr, shaftSrc, shaft, shaftGroup, compGroup }
  }

  private ensure(buf: GPUBuffer | null, cap: number, need: number, usage: number): [GPUBuffer, number] {
    if (buf && cap >= need) return [buf, cap]
    buf?.destroy()
    const size = Math.max(256, Math.ceil(need * 1.5 / 256) * 256)
    return [this.device.createBuffer({ size, usage: usage | GPUBufferUsage.COPY_DST }), size]
  }

  render(f: SceneFrame): void {
    const d = this.device
    const t = this.t
    if (!t) return
    if (this.modelDirty) {
      this.modelBuf?.destroy()
      const data = packVerts(this.modelVerts)
      this.modelBuf = d.createBuffer({ size: Math.max(16, data.byteLength), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
      d.queue.writeBuffer(this.modelBuf, 0, data)
      this.modelDirty = false
    }
    // Frame uniform.
    const u = this.frameData
    u.set(f.viewProj, 0)
    u.set([f.eye[0], f.eye[1], f.eye[2], f.time], 16)
    u.set([this.width, this.height, 1 / this.width, 1 / this.height], 20)
    u.set(f.sun, 24)
    u.set(f.fog, 28)
    u.set([f.rim, Math.min(MAX_LIGHTS, f.lightCount), 1, f.skyBrightness], 32)
    u.set([f.rim, f.shafts, f.hurt, f.desat], 36)
    u.set([f.tint[0], f.tint[1], f.tint[2], 1], 40)
    u.set(f.lights.subarray(0, MAX_LIGHTS * 8), 44)
    d.queue.writeBuffer(this.frameBuf, 0, u)
    packLookUniforms(this.look, this.lookData, 0, { forceActive: true })
    d.queue.writeBuffer(this.lookBuf, 0, this.lookData)

    // Instances: one contiguous upload, one draw per model.
    let total = 0
    for (const list of f.parts.values()) total += list.length
    if (this.instScratch.length < total) this.instScratch = new Float32Array(Math.ceil(total * 1.5))
    const draws: [number, number, number][] = []
    let o = 0
    for (const [model, list] of f.parts) {
      if (!list.length) continue
      this.instScratch.set(list, o)
      draws.push([model, o / INST_FLOATS, list.length / INST_FLOATS])
      o += list.length
    }
    if (o) {
      ;[this.instBuf, this.instCap] = this.ensure(this.instBuf, this.instCap, o * 4, GPUBufferUsage.VERTEX)
      d.queue.writeBuffer(this.instBuf, 0, this.instScratch.buffer, 0, o * 4)
    }
    const dynVerts = f.dynamic.v.length / 11
    if (dynVerts) {
      const data = packVerts(f.dynamic.v)
      ;[this.dynBuf, this.dynCap] = this.ensure(this.dynBuf, this.dynCap, data.byteLength, GPUBufferUsage.VERTEX)
      d.queue.writeBuffer(this.dynBuf, 0, data)
    }
    const quadFloats = (f.mistCount + f.alphaCount + f.addCount) * QUAD_FLOATS
    if (quadFloats) {
      ;[this.quadBuf, this.quadCap] = this.ensure(this.quadBuf, this.quadCap, quadFloats * 4, GPUBufferUsage.VERTEX)
      let qo = 0
      for (const [arr, n] of [[f.mist, f.mistCount], [f.alpha, f.alphaCount], [f.add, f.addCount]] as const) {
        if (n) d.queue.writeBuffer(this.quadBuf, qo * 4, arr.buffer, arr.byteOffset, n * QUAD_FLOATS * 4)
        qo += n * QUAD_FLOATS
      }
    }
    if (f.particles) {
      this.particles.setFrame({ vp: f.viewProj, eye: f.eye, ambient: [0.05, 0.05, 0.055], lights: f.lights, lightCount: f.lightCount, lightStride: 8 })
      this.particles.upload(f.particles)
    }

    const enc = d.createCommandEncoder()
    const pass = enc.beginRenderPass({
      colorAttachments: [
        { view: t.msaa.createView(), resolveTarget: t.hdr.createView(), loadOp: "clear", storeOp: "discard", clearValue: { r: 0, g: 0, b: 0, a: 0 } },
        { view: t.msaaShaft.createView(), resolveTarget: t.shaftSrc.createView(), loadOp: "clear", storeOp: "discard", clearValue: { r: 0, g: 0, b: 0, a: 0 } },
      ],
      depthStencilAttachment: { view: t.depth.createView(), depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "discard" },
    })
    pass.setBindGroup(0, this.frameGroup)
    pass.setPipeline(this.pipes.backdrop!)
    pass.draw(3)
    if (this.staticBuf && this.staticCount) {
      pass.setPipeline(this.pipes.static!)
      pass.setVertexBuffer(0, this.staticBuf)
      pass.draw(this.staticCount)
    }
    if (dynVerts && this.dynBuf) {
      pass.setPipeline(this.pipes.static!)
      pass.setVertexBuffer(0, this.dynBuf)
      pass.draw(dynVerts)
    }
    if (draws.length && this.modelBuf && this.instBuf) {
      pass.setPipeline(this.pipes.inst!)
      pass.setVertexBuffer(0, this.modelBuf)
      pass.setVertexBuffer(1, this.instBuf)
      for (const [model, first, count] of draws) {
        const m = this.models[model]
        if (m) pass.draw(m.count, count, m.first, first)
      }
    }
    if (this.quadBuf && f.mistCount) {
      pass.setPipeline(this.pipes.alpha!)
      pass.setVertexBuffer(0, this.quadBuf)
      pass.draw(6, f.mistCount, 0, 0)
    }
    if (f.particles) this.particles.draw(pass, true)
    if (this.quadBuf && (f.alphaCount || f.addCount)) {
      pass.setBindGroup(0, this.frameGroup)
      pass.setVertexBuffer(0, this.quadBuf)
      if (f.alphaCount) {
        pass.setPipeline(this.pipes.alpha!)
        pass.draw(6, f.alphaCount, 0, f.mistCount)
      }
      if (f.addCount) {
        pass.setPipeline(this.pipes.add!)
        pass.draw(6, f.addCount, 0, f.mistCount + f.alphaCount)
      }
    }
    pass.end()

    const sp = enc.beginRenderPass({ colorAttachments: [{ view: t.shaft.createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }] })
    sp.setPipeline(this.pipes.shaft!)
    sp.setBindGroup(0, this.frameGroup)
    sp.setBindGroup(1, t.shaftGroup)
    sp.draw(3)
    sp.end()

    this.bloom.encode(enc, this.pipes.down!, this.pipes.up!)

    const cp = enc.beginRenderPass({ colorAttachments: [{ view: this.context.getCurrentTexture().createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }] })
    cp.setPipeline(this.pipes.comp!)
    cp.setBindGroup(0, this.frameGroup)
    cp.setBindGroup(1, t.compGroup)
    cp.draw(3)
    cp.end()
    d.queue.submit([enc.finish()])
  }
}
