import { SmokeRenderer } from "./smoke"
import { FrameTimer } from "@arcade/kit/fx/frame-timer"
import type { Particles } from "@arcade/kit/fx/particles"
import { ParticleRenderer } from "@arcade/kit/fx/particle-renderer"
import type { SmokeVolumes } from "@arcade/kit/fx/volume"
import { VolumeRenderer } from "@arcade/kit/fx/volume-renderer"
import type { SmokeTrail } from "../game/smoke-trail"
import { FLOATS_PER_VERT, type Mesh } from "./mesh"
import { ATLAS_SIZE } from "./atlas"
import { type CityChunk, partitionCityMesh } from "./city-mesh"
import { GetawayFrameStruct, GetawayLightStruct, MAX_LIGHTS, beamShader, litShader, postShader, shadowShader, spriteShader } from "./shaders"
import { aabbInFrustum, drawContiguousChunks, extractFrustumPlanes } from "@arcade/kit/gpu/cull"
import {
  DirectionalShadowPass,
  PassList,
  STENCIL_GHOST_FACE,
  STENCIL_OCCLUDER_FACE,
  compileShaderModuleWithLog,
  depthConfigForMode,
  type PassSlot,
  type ScenePass,
} from "@arcade/kit/gpu/pass-graph"
import {
  BloomPyramid,
  DEFAULT_BLOOM_LEVELS,
  GrowableInstanceBuffer,
  SceneTargets,
  uploadAlphaWeightedMipChain,
  uploadSplitSprites,
} from "@arcade/kit/gpu/targets"
import { MotionBlur, PreviousTransforms } from '@arcade/kit/gpu/motion-blur'
import { motionBlur, vehicleVelocityPipeline, particleVelocityPipeline, spriteMotionKeys } from './motion'
import { mat4 } from 'wgpu-matrix'

const SAMPLES = 4
const SHADOW_SIZE = 2048
const HDR: GPUTextureFormat = "rgba16float"
const DEPTH_CFG = depthConfigForMode("stencil")
export const FRAME_FLOATS = GetawayFrameStruct.floatCount
export const LIGHT_FLOATS = GetawayLightStruct.floatCount
const LIGHT_VP_OFFSET = GetawayFrameStruct.offsetOf("lightViewProj")
const CAM_OFFSET = GetawayFrameStruct.offsetOf("cam")
const SCREEN_OFFSET = GetawayFrameStruct.offsetOf("screen")
export const INST_FLOATS = 12
export const SPRITE_FLOATS = 12
const MAX_SPRITES = 6000
const BLOOM_LEVELS = DEFAULT_BLOOM_LEVELS

type Model = { vbuf: GPUBuffer; count: number; castsShadow: boolean }
type CityModel = { vbuf: GPUBuffer; count: number; chunks: CityChunk[] }

/** One instanced draw: a model and its packed instance data. */
export type InstanceBatch = { model: number; data: Float32Array; count: number; keys?: (string | number | undefined)[]; ghostCount?: number; noShadow?: boolean }

export class Renderer {
  private timer: FrameTimer | null = null
  /** Passes the quality tier allows (off on Low); the effect settings still decide within them. */
  readonly tier = { motionBlur: true, volumes: true }
  measure = false
  measureNextFrame() {
    if (!this.device.features.has("timestamp-query")) throw new Error("Total GPU timing requires timestamp-query")
    this.timer ??= new FrameTimer(this.device)
    this.measure = true
  }
  totalGpuMs() { return this.timer!.collect() }
  private blur:MotionBlur
  private velocityPipeline:GPURenderPipeline
  private particleVelocity:GPURenderPipeline
  private particleHistory=new PreviousTransforms()
  private previousSprites=new Float32Array(MAX_SPRITES*12)
  private previousSpriteBuffer:GPUBuffer
  private history=new PreviousTransforms()
  private previousInstances=new Float32Array(512*12)
  private previousBuffer:GPUBuffer
  private previousVP=mat4.identity()
  private lastVP=mat4.identity()
  private inverseVP=mat4.identity()
  private lastEye=new Float32Array(3)
  private motionReady=false
  private motionValid=false
  private motionDt=1/60
  private motionGroups:{down:GPUBindGroup;composite:GPUBindGroup}|null=null
  private timingTarget!:GPUTexture
  private timingView!:GPUTextureView
  private timingGroup!:GPUBindGroup
  resetMotion(){this.motionReady=false;this.motionValid=false;this.history.reset();this.particleHistory.reset()}
  private readonly smoke: SmokeRenderer
  private readonly fxParticles: ParticleRenderer
  private readonly fxVolumes: VolumeRenderer
  private frameBuf: GPUBuffer
  private lightBuf: GPUBuffer
  private inst: GrowableInstanceBuffer
  private spriteBuf: GPUBuffer
  private shadowPass: DirectionalShadowPass
  private mainGroup: GPUBindGroup
  private pipes: Record<string, GPURenderPipeline> = {}
  private city: CityModel | null = null
  private beams: { buf: GPUBuffer; count: number; cap: number } | null = null
  private atlas: GPUTexture
  private models: Model[] = []
  private targets: SceneTargets
  private bloomPyramid: BloomPyramid
  private passes = new PassList()
  private compositeParams: GPUBuffer
  private compositeData = new Float32Array(4)
  private camPlanes = new Float32Array(24)
  private shadowPlanes = new Float32Array(24)
  private postLayout: GPUBindGroupLayout
  private sampler: GPUSampler
  private width = 1
  private height = 1
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
    private readonly format: GPUTextureFormat,
  ) {
    const d = device
    this.blur=new MotionBlur(d)
    this.velocityPipeline=vehicleVelocityPipeline(d,this.blur)
    this.particleVelocity=particleVelocityPipeline(d,this.blur)
    this.previousSpriteBuffer=d.createBuffer({size:this.previousSprites.byteLength,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST})
    this.previousBuffer=d.createBuffer({size:this.previousInstances.byteLength,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST})
    this.frameBuf = d.createBuffer({ size: FRAME_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.lightBuf = d.createBuffer({ size: MAX_LIGHTS * 12 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
    this.inst = new GrowableInstanceBuffer(d, 512, INST_FLOATS)
    this.spriteBuf = d.createBuffer({ size: MAX_SPRITES * SPRITE_FLOATS * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    this.compositeParams = d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
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
    this.shadowPass = new DirectionalShadowPass({
      device: d,
      frameBuf: this.frameBuf,
      shadowShaderCode: shadowShader,
      meshPosLayout: meshPosOnly,
      instLayout,
      size: SHADOW_SIZE,
      label: "getaway-shadow",
    })
    this.sampler = d.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" })
    this.targets = new SceneTargets(d, {
      hdrFormat: HDR,
      depthFormat: DEPTH_CFG.format,
      samples: SAMPLES,
      depthTextureBinding: true,
      clearValue: { r: 0.02, g: 0.025, b: 0.04, a: 1 },
      depthClearValue: DEPTH_CFG.clearValue,
      hasStencil: DEPTH_CFG.hasStencil,
    })
    this.bloomPyramid = new BloomPyramid(d, { levels: BLOOM_LEVELS, format: HDR, upTexelSource: "source" })

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
        { binding: 2, resource: this.shadowPass.view },
        { binding: 3, resource: this.shadowPass.sampler },
        { binding: 4, resource: this.atlas.createView() },
        { binding: 5, resource: d.createSampler({ magFilter: "linear", minFilter: "linear", mipmapFilter: "linear", maxAnisotropy: 8 }) },
      ],
    })
    this.smoke = new SmokeRenderer(d, mainLayout)
    this.fxParticles = new ParticleRenderer(d, DEPTH_CFG.format, SAMPLES)
    this.fxVolumes = new VolumeRenderer(d)
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
    const lit = compileShaderModuleWithLog(d, litShader, "getaway-lit")
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
          format: DEPTH_CFG.format,
          depthWriteEnabled: opts.depthWrite ?? true,
          depthCompare: opts.compare ?? DEPTH_CFG.compare,
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
    const sprite = compileShaderModuleWithLog(d, spriteShader, "getaway-sprite")
    const post = compileShaderModuleWithLog(d, postShader, "getaway-post")
    const postLayout = d.createPipelineLayout({ bindGroupLayouts: [this.postLayout] })
    const postPipe = (fs: string, format: GPUTextureFormat, blend?: GPUBlendState) =>
      d.createRenderPipeline({ layout: postLayout, vertex: { module: post, entryPoint: "vs" }, fragment: { module: post, entryPoint: fs, targets: [{ format, blend }] }, primitive: { topology: "triangle-list" } })
    this.pipes = {
      city: scene("vsStatic", "fs", [meshLayout]),
      inst: scene("vsInst", "fs", [meshLayout, instLayout], { stencil: STENCIL_OCCLUDER_FACE }),
      ghost: scene("vsGhost", "fsGhost", [meshLayout, instLayout], { blend: alpha, depthWrite: false, compare: "greater", cull: "back", stencil: STENCIL_GHOST_FACE }),
      beam: scene("vs", "fs", [meshLayout], { blend: additive, depthWrite: false, cull: "none" }, compileShaderModuleWithLog(d, beamShader, "getaway-beam")),
      spriteAlpha: scene("vs", "fs", [spriteLayout], { blend: alpha, depthWrite: false, cull: "none" }, sprite),
      spriteAdd: scene("vs", "fs", [spriteLayout], { blend: additive, depthWrite: false, cull: "none" }, sprite),
      down: postPipe("down", HDR),
      up: postPipe("up", HDR, additive),
      composite: postPipe("composite", format),
      present:postPipe('present',format),
    }
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
    uploadAlphaWeightedMipChain(this.device, this.atlas, img)
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
    model.vbuf.destroy(); model.vbuf = vbuf; model.count = mesh.count
  }
  setSmoke(trail: SmokeTrail, visible: boolean) { this.smoke.upload(trail, visible) }

  addPass(slot: PassSlot, pass: ScenePass): void {
    this.passes.add(slot, pass)
  }

  removePass(pass: ScenePass): boolean {
    return this.passes.remove(pass)
  }

  resize(w: number, h: number) {
    if (!this.targets.resize(w, h)) return
    this.width = w
    this.height = h
    this.resetMotion()
    this.timingTarget?.destroy()
    const d = this.device
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    this.timingTarget = d.createTexture({ size: [w, h], format: this.format, usage })
    this.timingView = this.timingTarget.createView()
    const depthOnlyView = this.targets.depth.createView({ aspect: "depth-only" })
    this.blur.resize(w, h, this.targets.hdrView, depthOnlyView)
    this.fxVolumes.resize(w, h, depthOnlyView)
    this.bloomPyramid.resize({
      hdr: this.targets.hdr,
      hdrView: this.targets.hdrView,
      layout: this.postLayout,
      sampler: this.sampler,
      compositeParams: this.compositeParams,
    })
    this.motionGroups = {
      down: this.bloomPyramid.makeBindGroup(this.postLayout, this.sampler, this.blur.output, this.bloomPyramid.downParams[0]!),
      composite: this.bloomPyramid.makeBindGroup(
        this.postLayout,
        this.sampler,
        this.blur.output,
        this.compositeParams,
        this.bloomPyramid.views[0]!,
      ),
    }
    this.timingGroup = this.bloomPyramid.makeBindGroup(this.postLayout, this.sampler, this.timingView, this.compositeParams)
  }

  private ensureInstances(n: number) {
    if (!this.inst.ensureCapacity(n)) return
    this.previousBuffer.destroy()
    this.previousInstances = new Float32Array(this.inst.cap * 12)
    this.previousBuffer = this.device.createBuffer({
      size: this.previousInstances.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    })
    this.resetMotion()
  }

  render(opts: {
    frame: Float32Array<ArrayBuffer>
    lights: Float32Array<ArrayBuffer>
    batches: InstanceBatch[]
    sprites: { alpha: Float32Array<ArrayBuffer>; alphaCount: number; add: Float32Array<ArrayBuffer>; addCount: number }
    fxParticles?: Particles
    fxVolumes?: SmokeVolumes
    bloom: number
    flash: number
    dt?:number
    rush?:number
  }) {
    const d = this.device
    d.queue.writeBuffer(this.frameBuf, 0, opts.frame)
    d.queue.writeBuffer(this.lightBuf, 0, opts.lights)
    this.compositeData[2] = opts.bloom
    this.compositeData[3] = opts.flash
    d.queue.writeBuffer(this.compositeParams, 0, this.compositeData)

    // Pack all instance batches into one buffer (reusing inst.buf for ghost silhouettes).
    let total = 0
    for (let i = 0; i < opts.batches.length; i++) total += opts.batches[i]!.count
    this.ensureInstances(total)
    const dt=opts.dt??1/60
    const advance=dt>0||!this.motionReady
    if(advance){
      this.motionValid=this.motionReady&&dt>0&&dt<.1&&Math.hypot(opts.frame[CAM_OFFSET]!-this.lastEye[0]!,opts.frame[CAM_OFFSET+1]!-this.lastEye[1]!,opts.frame[CAM_OFFSET+2]!-this.lastEye[2]!)<20
      this.previousVP.set(this.motionValid?this.lastVP:opts.frame.subarray(0,16))
      this.lastVP.set(opts.frame.subarray(0,16));this.lastEye.set(opts.frame.subarray(CAM_OFFSET,CAM_OFFSET+3));this.motionDt=Math.max(dt,1/240)
      if(!this.motionValid){this.history.reset();this.particleHistory.reset()}
      this.history.begin();this.particleHistory.begin();this.motionReady=true
    }
    mat4.inverse(opts.frame.subarray(0,16),this.inverseVP)
    const blurOn=this.tier.motionBlur&&motionBlur.enabled&&motionBlur.strength>0&&motionBlur.shutter>0
    this.blur.update(opts.frame,this.inverseVP,this.previousVP,this.motionDt,motionBlur.strength*(1+(opts.rush??0)*.8),motionBlur.shutter,this.motionValid)

    const ranges: { model: number; first: number; count: number; noShadow?: boolean }[] = []
    const ghostRanges: { model: number; first: number; count: number }[] = []
    let off = 0
    for (let i = 0; i < opts.batches.length; i++) {
      const b = opts.batches[i]!
      if (!b.count) continue
      if(advance)for(let j=0;j<b.count;j++){
        const key=b.keys?.[j]
        if(key!==undefined)this.history.write(key,b.data,j*12,this.previousInstances,(off+j)*12)
        else for(let k=0;k<12;k++)this.previousInstances[(off+j)*12+k]=b.data[j*12+k]!
      }
      ranges.push({ model: b.model, first: off, count: b.count, noShadow: b.noShadow })
      if (b.ghostCount && b.ghostCount > 0) {
        ghostRanges.push({ model: b.model, first: off, count: b.ghostCount })
      }
      off += b.count
    }
    this.inst.uploadBatches(opts.batches)
    if(total)d.queue.writeBuffer(this.previousBuffer,0,this.previousInstances.buffer,0,total*48)
    const {
      alphaCount,
      addCount,
      addByteOffset: addOffset,
    } = uploadSplitSprites(
      d,
      this.spriteBuf,
      MAX_SPRITES,
      SPRITE_FLOATS,
      opts.sprites.alpha,
      opts.sprites.alphaCount,
      opts.sprites.add,
      opts.sprites.addCount,
    )
    if(advance)for(const [data,count,start] of [[opts.sprites.alpha,alphaCount,0],[opts.sprites.add,addCount,MAX_SPRITES/2]] as const){
      const keys=spriteMotionKeys.get(data)
      for(let i=0;i<count;i++){
        const key=keys?.[i]
        if(key)this.particleHistory.write(key,data,i*12,this.previousSprites,(start+i)*12)
        else for(let k=0;k<12;k++)this.previousSprites[(start+i)*12+k]=data[i*12+k]!
      }
    }
    if(blurOn){
      if(alphaCount)d.queue.writeBuffer(this.previousSpriteBuffer,0,this.previousSprites.buffer,0,alphaCount*48)
      if(addCount)d.queue.writeBuffer(this.previousSpriteBuffer,addOffset,this.previousSprites.buffer,addOffset,addCount*48)
    }

    extractFrustumPlanes(opts.frame, 0, this.camPlanes)
    extractFrustumPlanes(opts.frame, LIGHT_VP_OFFSET, this.shadowPlanes)

    const hasFxParticles = Boolean(opts.fxParticles && opts.fxParticles.count > 0)
    const hasFxVolumes = this.tier.volumes && Boolean(opts.fxVolumes && opts.fxVolumes.count > 0)
    if (hasFxParticles && opts.fxParticles) {
      this.fxParticles.setFrame({
        vp: opts.frame,
        eye: [opts.frame[CAM_OFFSET]!, opts.frame[CAM_OFFSET + 1]!, opts.frame[CAM_OFFSET + 2]!],
        debug: 0,
        ambient: [0.22, 0.25, 0.36],
        lights: opts.lights,
        lightCount: Math.min(MAX_LIGHTS, Math.round(opts.frame[SCREEN_OFFSET + 2] ?? 0)),
        lightStride: LIGHT_FLOATS,
        minLightPower: 0.01,
      })
      this.fxParticles.upload(opts.fxParticles)
    }

    const enc = d.createCommandEncoder()
    this.passes.prepareAll(enc)
    const { vertsDrawn: shadowCityVerts, chunksDrawn: shadowChunks } = this.shadowPass.encode(enc, {
      staticMesh: this.city,
      shadowPlanes: this.shadowPlanes,
      camPlanes: this.camPlanes,
      instBuf: this.inst.buf,
      models: this.models,
      ranges,
      timestampWrites: this.measure ? this.timer!.start : undefined,
    })

    const pass = enc.beginRenderPass(this.targets.configureMainPass({ storeDepth: blurOn || hasFxVolumes }))
    pass.setBindGroup(0, this.mainGroup)
    this.passes.drawSlot("sky", pass)
    pass.setStencilReference(1)
    let mainCityVerts = 0
    let mainChunks = 0
    if (this.city) {
      pass.setPipeline(this.pipes.city!)
      pass.setVertexBuffer(0, this.city.vbuf)
      const mainStats = drawContiguousChunks(pass, this.city.chunks, (c) =>
        aabbInFrustum(this.camPlanes, c.minX, c.minY, c.minZ, c.maxX, c.maxY, c.maxZ),
      )
      mainCityVerts = mainStats.vertsDrawn
      mainChunks = mainStats.chunksDrawn
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
    pass.setVertexBuffer(1, this.inst.buf)
    for (let i = 0; i < ranges.length; i++) {
      const r = ranges[i]!
      const m = this.models[r.model]!
      pass.setVertexBuffer(0, m.vbuf)
      pass.draw(m.count, r.count, 0, r.first)
    }
    this.passes.drawSlot("opaque", pass)
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
      pass.setVertexBuffer(1, this.inst.buf)
      for (let i = 0; i < ghostRanges.length; i++) {
        const r = ghostRanges[i]!
        const m = this.models[r.model]!
        pass.setVertexBuffer(0, m.vbuf)
        pass.draw(m.count, r.count, 0, r.first)
      }
    }
    if (hasFxParticles) {
      this.fxParticles.draw(pass)
      pass.setBindGroup(0, this.mainGroup)
    }
    this.passes.drawSlot("alpha", pass)
    pass.end()

    if (hasFxVolumes && opts.fxVolumes) {
      this.fxVolumes.setFrame({
        inverse: this.inverseVP,
        eye: [opts.frame[CAM_OFFSET]!, opts.frame[CAM_OFFSET + 1]!, opts.frame[CAM_OFFSET + 2]!],
        ambient: [0.12, 0.14, 0.22],
        lights: opts.lights,
        lightCount: Math.min(MAX_LIGHTS, Math.round(opts.frame[SCREEN_OFFSET + 2] ?? 0)),
        lightStride: LIGHT_FLOATS,
        minLightPower: 0.01,
      })
      this.fxVolumes.render(enc, this.targets.hdrView, opts.fxVolumes)
    }

    if(blurOn)this.blur.encode(enc,p=>{
      p.setPipeline(this.velocityPipeline);p.setBindGroup(0,this.blur.group)
      p.setVertexBuffer(1,this.inst.buf);p.setVertexBuffer(2,this.previousBuffer)
      for(const r of ranges){const m=this.models[r.model]!;p.setVertexBuffer(0,m.vbuf);p.draw(m.count,r.count,0,r.first)}
      p.setPipeline(this.particleVelocity)
      if(alphaCount){p.setVertexBuffer(0,this.spriteBuf);p.setVertexBuffer(1,this.previousSpriteBuffer);p.draw(6,alphaCount)}
      if(addCount){p.setVertexBuffer(0,this.spriteBuf,addOffset);p.setVertexBuffer(1,this.previousSpriteBuffer,addOffset);p.draw(6,addCount)}
    })

    // Bloom: threshold + downsample chain, then additive upsample back to half resolution.
    this.bloomPyramid.encode(enc, this.pipes.down!, this.pipes.up!, blurOn ? this.motionGroups!.down : undefined)
    const screen=this.context.getCurrentTexture().createView()
    const fp = enc.beginRenderPass({ colorAttachments: [{ view: this.measure?this.timingView:screen, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }] })
    fp.setPipeline(this.pipes.composite!)
    fp.setBindGroup(0, blurOn?this.motionGroups!.composite:this.bloomPyramid.compositeGroup)
    fp.draw(3)
    fp.end()
    if (this.measure) {
      this.timer!.finish(enc,this.timingView)
      const copy=enc.beginRenderPass({colorAttachments:[{view:screen,loadOp:'clear',storeOp:'store',clearValue:[0,0,0,1]}]})
      copy.setPipeline(this.pipes.present!);copy.setBindGroup(0,this.timingGroup);copy.draw(3);copy.end()
    }
    this.measure = false
    d.queue.submit([enc.finish()])
  }
}
