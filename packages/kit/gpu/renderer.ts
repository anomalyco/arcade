import { MAX_LIGHTS, MAX_MAP_LIGHTS, MAX_OCCLUDERS, POLAR_RAYS, LIGHT_FLOATS, OCC_FLOATS } from "./limits"
import { directionalMask, type LevelData } from "./level"
import { VERT_BYTES, type Mesh } from "./mesh"
import { mat4 } from "wgpu-matrix"
import { VolumeRenderer } from "@arcade/kit/fx/volume-renderer"
import type { SmokeVolumes } from "@arcade/kit/fx/volume"
import type { Particles } from "@arcade/kit/fx/particles"
import { ParticleRenderer } from "@arcade/kit/fx/particle-renderer"
import { FrameTimer } from "@arcade/kit/fx/frame-timer"
import { installFramePacer } from "../gpu-perf"
import { MotionHistory, motionSettings, type MotionKey } from "./motion"
import type { Splatter } from "@arcade/kit/fx/splatter"
import { SplatterRenderer, type SplatterLightingInput } from "@arcade/kit/fx/splatter-renderer"
import { WeatherRenderer, type WeatherPrepareInput } from "../weather"
import {
  LOOK_UNIFORM_FLOATS,
  createLookSettings,
  isIdentityLook,
  packLookUniforms,
  resolveLookPresetId,
  type LookCompareMode,
  type LookPresetId,
  type LookSettings,
} from "./look"
import {
  FRAME_FLOATS,
  makeLookPostShader,
  makeLookSceneShader,
  polarShader,
  postShader,
  resolveLookVariant,
  sceneShader,
  spriteShader,
  common,
  type LookVariantMode,
} from "./shaders"
import { SmokeRenderer } from "@arcade/kit/vehicle/smoke-renderer"
import type { SmokeTrail } from "@arcade/kit/vehicle/smoke-trail"
import { SURFACE_TEX_UNIFORM_FLOATS, packSurfaceTexUniforms, type SurfaceTexUniformInput } from "./surface-materials"
import { createFallbackMaterialTextureArray, createMaterialSampler, loadMaterialTextureArray } from "../textures/loader"

const SAMPLES = 4
const HDR: GPUTextureFormat = "rgba16float"
const DEPTH: GPUTextureFormat = "depth24plus"
export { LIGHT_FLOATS }
export const INST_FLOATS = 12
export const SPRITE_FLOATS = 12
/** Size of the game's custom uniform block at binding 13. */
export const CUSTOM_UNIFORM_BYTES = 1024
const MAX_SPRITES = 8192
const BLOOM_LEVELS = 5
const SLOTS = MAX_LIGHTS

type Buf = { buf: GPUBuffer; count: number; cap: number }
type Chunk = { first: number; count: number; box: readonly [number, number, number, number]; cutBox?: readonly number[]; customCutaway?: boolean | "outside" | "a2c" }

/** Conservative screen bounds of cuttable geometry. The cutaway is screen-space, not a fixed world-space box. */
function intersectsCutaway(box: readonly number[] | undefined, f: Float32Array, custom = false): boolean {
  if (custom) {
    if (!box) return true
    return f[24]! > box[0]! && f[24]! < box[3]! && f[25]! > box[2]! && f[25]! < box[5]!
  }
  const peeking = f[26]! > 1.001
  if (!box || f[26]! < 0.5 || box[4]! < f[34]! || (!peeking && box[5]! < f[25]! + 0.25)) return false
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
/**
 * Optional game compute pass run after the polar shadow pass: `code` reads the frame (0), lights (1), polar map (2) and
 * custom uniforms (13), keeps per-texel state in a read-write buffer of `size * size` vec2f (14) and writes a
 * `size * size` rgba8unorm texture (15) that scene shaders sample at binding 14. It runs `dispatch * dispatch`
 * invocations in 8x8 workgroups; the shader picks which texels they cover.
 */
export type VisibilityFieldShader = { code: string; size: number; dispatch: number }

export type Batch = { model: number; data: Float32Array<ArrayBuffer>; count: number; alpha?: boolean; motionKeys?: (MotionKey | undefined)[] }

export type FrameInput = {
  splatter?:Splatter
  splatterLegacy?:boolean
  fxParticles?: Particles
  weather?: WeatherPrepareInput | null
  smoke?: SmokeVolumes
  smokeEnabled?: boolean
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
  addMotionKeys?: (MotionKey | undefined)[]
  /** time, desaturate, flash, exposure */
  grade: [number, number, number, number]
  /** Optional game-feel post-processing burst: [blurX, blurY, radialBlur, chromaticBoost] */
  feel?: readonly [number, number, number, number]
  /** Optional opt-in rendering style ("Look"). When omitted or "Current" identity, baseline pipelines run unchanged. */
  look?: LookSettings | null
  lookCompare?: { mode?: LookCompareMode; wipeSplit?: number }
}

/**
 * WebGPU renderer. Per frame: (1) a compute pass casts POLAR_RAYS rays from each culled light against the occluders
 * within its reach (walls, furniture with heights, people), (2) an MSAA HDR pass draws the level chunks in view,
 * instanced characters, glass and light haze, and sprites, all lit through that polar shadow map, (3) bloom, then a
 * tone-mapped composite with grade, vignette and grain.
 */
export class Renderer {
  private splatterRenderer?:SplatterRenderer
  private particleRenderer?:ParticleRenderer
  private weatherRenderer?:WeatherRenderer
  private readonly splatterEye=new Float32Array(3)
  readonly smokeRenderer: VolumeRenderer
  private readonly smokeMatrix = new Float32Array(16)
  private readonly smokeInverse = new Float32Array(16)
  private timer: FrameTimer | null = null
  private timing = false
  private measureTarget:GPUTexture|null=null
  private measureView!:GPUTextureView
  private readonly vehicleSmoke: SmokeRenderer
  private frameBuf: GPUBuffer
  private lightBuf: GPUBuffer
  private occBuf: GPUBuffer
  private polarBuf: GPUBuffer
  private lampBuf: GPUBuffer
  private gradeBuf: GPUBuffer
  private customBuf: GPUBuffer
  private sceneLayout: GPUBindGroupLayout
  private floorTex: GPUTexture
  private moonTex: GPUTexture
  private visibilityTex: GPUTexture
  private fieldTex: GPUTexture
  private field: { pipe: GPUComputePipeline; group: GPUBindGroup; state: GPUBuffer; dispatch: number } | null = null
  private bounceTex: GPUTexture
  private floorSampler: GPUSampler
  private materialTex: GPUTexture
  private materialTexView: GPUTextureView
  private materialSampler: GPUSampler
  private surfaceTexBuf: GPUBuffer
  private surfaceTexData = new Float32Array(SURFACE_TEX_UNIFORM_FLOATS)
  private surfaceTexInput: SurfaceTexUniformInput = { enabled: 1 }
  private texturesLoaded = false
  readonly texturesReady: Promise<void>
  private chunks: Chunk[] = []
  private glassChunks: Chunk[] = []
  private sceneGroup!: GPUBindGroup
  private computeGroup: GPUBindGroup
  private polarPipe: GPUComputePipeline
  private pipes: Record<string, GPURenderPipeline> = {}
  private baselinePipes: Record<string, GPURenderPipeline> = {}
  private motionPipes: Record<string, GPURenderPipeline> = {}
  private lookPipesByVariant = new Map<LookVariantMode, Record<string, GPURenderPipeline>>()
  private activeLook: LookSettings | null = null
  private activeLookCompare: { mode?: LookCompareMode; wipeSplit?: number } = {}
  private lookSceneData = new Float32Array(LOOK_UNIFORM_FLOATS)
  private motionBuf: GPUBuffer
  private previousInst: GPUBuffer
  private previousSprites: GPUBuffer
  private history = new MotionHistory()
  private previousFrame: Float32Array | null = null
  private motionData = new Float32Array(20)
  private previousData = new Float32Array(4096 * INST_FLOATS)
  private spriteHistory = new Float32Array(MAX_SPRITES * SPRITE_FLOATS)
  private velocity: GPUTexture | null = null
  private velocityMSAA: GPUTexture | null = null
  private velocityView!: GPUTextureView
  private velocityMSAAView!: GPUTextureView
  private motionPostLayout: GPUBindGroupLayout
  private motionComposite!: GPUBindGroup
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
  private gradeData = new Float32Array(8 + LOOK_UNIFORM_FLOATS)
  private postLayout: GPUBindGroupLayout
  private postGroups: { down: GPUBindGroup[]; up: GPUBindGroup[]; composite: GPUBindGroup } | null = null
  private postParams: GPUBuffer[] = []
  private sampler: GPUSampler
  /** Level chunks drawn last frame, for diagnostics. */
  drawnChunks = 0
  /** Successfully submitted frames, not draw requests or confirmed screen presentations. */
  submittedFrames = 0
  width = 0
  height = 0

  constructor(
    private device: GPUDevice,
    private context: GPUCanvasContext,
    private readonly format: GPUTextureFormat,
    private shaders?: {
      scene: string
      sprite: string
      post?: string
      lookScene?: string
      lookPost?: string
      lookSceneVariant?: (variant: LookVariantMode) => string
      lookPostVariant?: (variant: LookVariantMode) => string
      visField?: VisibilityFieldShader
    },
  ) {
    const d = device
    this.notifyPacer = installFramePacer(
      () => this.inflight === 0,
      () => this.onIdle !== null,
      d,
    )
    this.smokeRenderer = new VolumeRenderer(d)
    this.splatterRenderer = new SplatterRenderer(d)
    this.particleRenderer = new ParticleRenderer(d, DEPTH, SAMPLES)
    const U = GPUBufferUsage
    this.frameBuf = d.createBuffer({ size: FRAME_FLOATS * 4, usage: U.UNIFORM | U.COPY_DST })
    this.motionBuf = d.createBuffer({ size: Math.max(80, LOOK_UNIFORM_FLOATS * 4), usage: U.UNIFORM | U.COPY_DST })
    this.previousInst = d.createBuffer({ size: this.previousData.byteLength, usage: U.VERTEX | U.COPY_DST })
    this.previousSprites = d.createBuffer({ size: this.spriteHistory.byteLength, usage: U.VERTEX | U.COPY_DST })
    this.lightBuf = d.createBuffer({ size: MAX_LIGHTS * LIGHT_FLOATS * 4, usage: U.STORAGE | U.COPY_DST })
    this.occBuf = d.createBuffer({ size: MAX_OCCLUDERS * OCC_FLOATS * 4, usage: U.STORAGE | U.COPY_DST })
    this.polarBuf = d.createBuffer({ size: SLOTS * POLAR_RAYS * 32, usage: U.STORAGE })
    this.lampBuf = d.createBuffer({ size: MAX_MAP_LIGHTS * 4, usage: U.STORAGE | U.COPY_DST })
    this.floorTex = d.createTexture({ size: [1, 1], format: "rg8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST })
    this.moonTex = d.createTexture({ size: [1, 1], format: "r8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST })
    this.visibilityTex = d.createTexture({ size: [1, 1], format: "r8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST })
    this.bounceTex = d.createTexture({ size: [1, 1], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST })
    this.fieldTex = d.createTexture({ size: [shaders?.visField?.size ?? 1, shaders?.visField?.size ?? 1], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING })
    this.floorSampler = d.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" })
    const fallbackMaterials = createFallbackMaterialTextureArray(d)
    this.materialTex = fallbackMaterials.texture
    this.materialTexView = fallbackMaterials.view
    this.materialSampler = createMaterialSampler(d)
    this.surfaceTexBuf = d.createBuffer({ size: SURFACE_TEX_UNIFORM_FLOATS * 4, usage: U.UNIFORM | U.COPY_DST })
    packSurfaceTexUniforms({ ...this.surfaceTexInput, enabled: 0 }, this.surfaceTexData)
    d.queue.writeBuffer(this.surfaceTexBuf, 0, this.surfaceTexData)
    this.gradeBuf = d.createBuffer({ size: this.gradeData.byteLength, usage: U.UNIFORM | U.COPY_DST })
    this.customBuf = d.createBuffer({ size: CUSTOM_UNIFORM_BYTES, usage: U.UNIFORM | U.COPY_DST })
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
        { binding: 1, visibility: S.VERTEX | S.FRAGMENT, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: S.FRAGMENT, buffer: { type: "read-only-storage" } },
        { binding: 3, visibility: S.FRAGMENT, buffer: { type: "read-only-storage" } },
        { binding: 4, visibility: S.FRAGMENT, texture: {} },
        { binding: 5, visibility: S.FRAGMENT, sampler: {} },
        { binding: 6, visibility: S.FRAGMENT, texture: {} },
        { binding: 7, visibility: S.VERTEX | S.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 8, visibility: S.FRAGMENT, texture: {} },
        { binding: 9, visibility: S.FRAGMENT, texture: {} },
        { binding: 10, visibility: S.FRAGMENT, texture: { viewDimension: "2d-array" } },
        { binding: 11, visibility: S.FRAGMENT, sampler: {} },
        { binding: 12, visibility: S.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 13, visibility: S.VERTEX | S.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 14, visibility: S.FRAGMENT, texture: {} },
      ],
    })
    this.sceneLayout = sceneLayout
    this.vehicleSmoke = new SmokeRenderer(d, sceneLayout, common,
      "if (li.cone.w > 0.5) { a *= smoothstep(li.cone.z, min(1.0, li.cone.z + 0.08), dot(normalize(-d.xz), li.cone.xy)); }", "depth24plus")
    this.postLayout = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: S.FRAGMENT, texture: {} },
        { binding: 1, visibility: S.FRAGMENT, sampler: {} },
        { binding: 2, visibility: S.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 3, visibility: S.FRAGMENT, texture: {} },
        { binding: 4, visibility: S.FRAGMENT, buffer: { type: "uniform" } },
      ],
    })
    this.motionPostLayout = d.createBindGroupLayout({ entries: [
      { binding: 0, visibility: S.FRAGMENT, texture: {} },
      { binding: 1, visibility: S.FRAGMENT, sampler: {} },
      { binding: 2, visibility: S.FRAGMENT, buffer: { type: "uniform" } },
      { binding: 3, visibility: S.FRAGMENT, texture: {} },
      { binding: 4, visibility: S.FRAGMENT, buffer: { type: "uniform" } },
      { binding: 5, visibility: S.FRAGMENT, texture: {} },
    ] })
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
    if (shaders?.visField) {
      const vf = shaders.visField
      const fieldLayout = d.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: S.COMPUTE, buffer: { type: "uniform" } },
          { binding: 1, visibility: S.COMPUTE, buffer: { type: "read-only-storage" } },
          { binding: 2, visibility: S.COMPUTE, buffer: { type: "read-only-storage" } },
          { binding: 13, visibility: S.COMPUTE, buffer: { type: "uniform" } },
          { binding: 14, visibility: S.COMPUTE, buffer: { type: "storage" } },
          { binding: 15, visibility: S.COMPUTE, storageTexture: { access: "write-only", format: "rgba8unorm" } },
        ],
      })
      const state = d.createBuffer({ size: vf.size * vf.size * 8, usage: U.STORAGE | U.COPY_DST })
      this.field = {
        pipe: d.createComputePipeline({
          layout: d.createPipelineLayout({ bindGroupLayouts: [fieldLayout] }),
          compute: { module: this.module(vf.code, "visibility field"), entryPoint: "main" },
        }),
        group: d.createBindGroup({
          layout: fieldLayout,
          entries: [
            { binding: 0, resource: { buffer: this.frameBuf } },
            { binding: 1, resource: { buffer: this.lightBuf } },
            { binding: 2, resource: { buffer: this.polarBuf } },
            { binding: 13, resource: { buffer: this.customBuf } },
            { binding: 14, resource: { buffer: state } },
            { binding: 15, resource: this.fieldTex.createView() },
          ],
        }),
        state,
        dispatch: vf.dispatch,
      }
    }

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
    const scene = this.module(shaders?.scene ?? sceneShader(), "scene")
    const baselineScene = shaders ? scene : this.module(sceneShader(false), "scene baseline")
    const sprite = this.module(shaders?.sprite ?? spriteShader(), "sprite")
    const pipe = (module: GPUShaderModule, vs: string, buffers: GPUVertexBufferLayout[], blend?: GPUBlendState, depthWrite = true, cullMode: GPUCullMode = "back", fs = "fs", motion = false, alphaToCoverage = false) =>
      d.createRenderPipeline({
        layout,
        vertex: { module, entryPoint: vs, buffers },
        fragment: { module, entryPoint: fs, targets: [{ format: HDR, blend }, ...(motion ? [{ format: HDR, blend: blend ? premul : undefined }] : [])] },
        primitive: { topology: "triangle-list", cullMode },
        depthStencil: { format: DEPTH, depthWriteEnabled: depthWrite, depthCompare: "less-equal" },
        multisample: { count: SAMPLES, alphaToCoverageEnabled: alphaToCoverage && !blend && !motion },
      })
    this.pipes.level = pipe(scene, "vsStatic", [meshLayout], undefined, true, "none", "fsSolid")
    this.pipes.levelCut = pipe(scene, "vsStatic", [meshLayout], undefined, true, "none", "fs")
    this.pipes.glass = pipe(scene, "vsStatic", [meshLayout], premul, false, "none", shaders ? "fsSolid" : "fs")
    this.pipes.inst = pipe(scene, "vsInst", [meshLayout, instLayout], undefined, true, "none", shaders ? "fsSolid" : "fs")
    this.pipes.instAlpha = pipe(scene, "vsInst", [meshLayout, instLayout], premul, false, "none", "fs")
    // Keep the all-off shader's arithmetic identical, including compiler rounding.
    this.baselinePipes.level = pipe(baselineScene, "vsStatic", [meshLayout], undefined, true, "none", "fsSolid")
    this.baselinePipes.levelCut = pipe(baselineScene, "vsStatic", [meshLayout], undefined, true, "none", "fs")
    this.baselinePipes.glass = pipe(baselineScene, "vsStatic", [meshLayout], premul, false, "none", "fs")
    this.baselinePipes.inst = pipe(baselineScene, "vsInst", [meshLayout, instLayout], undefined, true, "none", "fs")
    this.baselinePipes.instAlpha = pipe(baselineScene, "vsInst", [meshLayout, instLayout], premul, false, "none", "fs")
    this.pipes.spriteAlpha = pipe(sprite, "vs", [spriteLayout], premul, false, "none")
    this.pipes.spriteAdd = pipe(sprite, "vs", [spriteLayout], additive, false, "none")
    const moving = this.module(sceneShader(true, true), "scene motion")
    const movingSprite = this.module(spriteShader(true), "sprite motion")
    const oldLayout: GPUVertexBufferLayout = { ...instLayout, attributes: [...instLayout.attributes].map(a => ({ ...a, shaderLocation: a.shaderLocation + 3 })) }
    const oldSprite: GPUVertexBufferLayout = { arrayStride: SPRITE_FLOATS * 4, stepMode: "instance", attributes: [{ shaderLocation: 3, offset: 0, format: "float32x4" }] }
    this.motionPipes.level = pipe(moving, "vsStatic", [meshLayout], undefined, true, "none", "fsSolid", true)
    this.motionPipes.levelCut = pipe(moving, "vsStatic", [meshLayout], undefined, true, "none", "fs", true)
    this.motionPipes.glass = pipe(moving, "vsStatic", [meshLayout], premul, false, "none", "fs", true)
    this.motionPipes.inst = pipe(moving, "vsInst", [meshLayout, instLayout, oldLayout], undefined, true, "none", "fs", true)
    this.motionPipes.instAlpha = pipe(moving, "vsInst", [meshLayout, instLayout, oldLayout], premul, false, "none", "fs", true)
    this.motionPipes.spriteAlpha = pipe(movingSprite, "vs", [spriteLayout, oldSprite], premul, false, "none", "fs", true)
    this.motionPipes.spriteAdd = pipe(movingSprite, "vs", [spriteLayout, oldSprite], additive, false, "none", "fs", true)

    const post = this.module(shaders?.post ?? postShader(), "post")
    const baselinePost = this.module(shaders?.post ?? postShader(false), "post baseline")
    const postPipeLayout = d.createPipelineLayout({ bindGroupLayouts: [this.postLayout] })
    const postPipe = (fs: string, fmt: GPUTextureFormat, blend?: GPUBlendState, baseline = false) =>
      d.createRenderPipeline({ layout: postPipeLayout, vertex: { module: post, entryPoint: "vs" }, fragment: { module: baseline ? baselinePost : post, entryPoint: fs, targets: [{ format: fmt, blend }] }, primitive: { topology: "triangle-list" } })
    this.pipes.down = postPipe("down", HDR)
    this.pipes.up = postPipe("up", HDR, additive)
    this.pipes.composite = postPipe("composite", format)
    this.baselinePipes.composite = postPipe("composite", format, undefined, true)
    const motionPost = this.module(postShader(true, true), "post motion")
    this.motionPipes.composite = d.createRenderPipeline({
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.motionPostLayout] }),
      vertex: { module: motionPost, entryPoint: "vs" },
      fragment: { module: motionPost, entryPoint: "composite", targets: [{ format }] },
    })
    for (let i = 0; i < BLOOM_LEVELS; i++) this.postParams.push(d.createBuffer({ size: 16, usage: U.UNIFORM | U.COPY_DST }))
    this.texturesReady = this.initMaterialTextures()
  }

  private async initMaterialTextures(): Promise<void> {
    const loaded = await loadMaterialTextureArray(this.device)
    if (!loaded) return
    this.materialTex.destroy()
    this.materialTex = loaded.texture
    this.materialTexView = loaded.view
    this.texturesLoaded = true
    packSurfaceTexUniforms(this.surfaceTexInput, this.surfaceTexData)
    this.device.queue.writeBuffer(this.surfaceTexBuf, 0, this.surfaceTexData)
    this.makeSceneGroup()
  }

  setSurfaceTexUniforms(input: SurfaceTexUniformInput): void {
    this.surfaceTexInput = { ...this.surfaceTexInput, ...input }
    packSurfaceTexUniforms(
      { ...this.surfaceTexInput, enabled: this.texturesLoaded ? (this.surfaceTexInput.enabled ?? 1) : 0 },
      this.surfaceTexData,
    )
    this.device.queue.writeBuffer(this.surfaceTexBuf, 0, this.surfaceTexData)
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
        { binding: 7, resource: { buffer: this.motionBuf } },
        { binding: 8, resource: this.moonTex.createView() },
        { binding: 9, resource: this.visibilityTex.createView() },
        { binding: 10, resource: this.materialTexView },
        { binding: 11, resource: this.materialSampler },
        { binding: 12, resource: { buffer: this.surfaceTexBuf } },
        { binding: 13, resource: { buffer: this.customBuf } },
        { binding: 14, resource: this.fieldTex.createView() },
      ],
    })
  }

  /** Forgets everything the visibility field remembers (new level or session). */
  clearVisibilityField(): void {
    if (!this.field) return
    const enc = this.device.createCommandEncoder()
    enc.clearBuffer(this.field.state)
    this.device.queue.submit([enc.finish()])
  }

  setCustomUniforms(data: Float32Array<ArrayBuffer>): void {
    this.device.queue.writeBuffer(this.customBuf, 0, data.buffer, data.byteOffset, Math.min(CUSTOM_UNIFORM_BYTES, data.byteLength))
  }

  private levelStaging = new Uint8Array(0)
  private glassStaging = new Uint8Array(0)
  private readonly streamSlotKeys: string[] = ["", "", "", "", "", "", "", "", ""]
  private readonly streamSlotChunks: Chunk[][] = [[], [], [], [], [], [], [], [], []]

  private upload(data: ArrayBuffer, prev: Buf | null, byteLength = data.byteLength): Buf {
    const needed = Math.max(64, byteLength)
    let buf = prev?.buf
    let cap = prev?.cap ?? 0
    if (!buf || cap < needed) {
      buf?.destroy()
      cap = prev ? Math.max(needed, Math.ceil((needed * 1.25) / 65536) * 65536) : needed
      buf = this.device.createBuffer({ size: cap, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    }
    if (byteLength > 0) this.device.queue.writeBuffer(buf, 0, data, 0, byteLength)
    return { buf, count: byteLength / VERT_BYTES, cap }
  }

  /** Static level: opaque chunks (each culled against the view), translucent glass and haze chunks, and the baked floor map. */
  setLevel(level: LevelData): void {
    this.previousFrame = null
    const STREAM_SLOT_BYTES = 768 * 1024
    const isStreamedSlots =
      level.chunks.length > 0 &&
      level.chunks.every((c) => c.streamSlot !== undefined && c.streamKey !== undefined)

    if (isStreamedSlots) {
      const totalCap = 9 * STREAM_SLOT_BYTES
      if (!this.level || this.level.cap < totalCap) {
        this.level?.buf.destroy()
        this.level = {
          buf: this.device.createBuffer({ size: totalCap, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST }),
          count: totalCap / VERT_BYTES,
          cap: totalCap,
        }
        this.streamSlotKeys.fill("")
      }
      const bySlot: LevelData["chunks"][] = [[], [], [], [], [], [], [], [], []]
      for (let i = 0; i < level.chunks.length; i++) {
        const c = level.chunks[i]!
        bySlot[c.streamSlot!]!.push(c)
      }
      let slotOverflow = false
      for (let s = 0; s < 9; s++) {
        const list = bySlot[s]!
        const key = list[0]?.streamKey ?? "empty"
        if (key === this.streamSlotKeys[s]) continue
        let slotBytes = 0
        for (let i = 0; i < list.length; i++) slotBytes += list[i]!.byteLength ?? list[i]!.data.byteLength
        if (slotBytes > STREAM_SLOT_BYTES) {
          slotOverflow = true
          break
        }
        const slotBase = s * STREAM_SLOT_BYTES
        const slotOut: Chunk[] = []
        let off = 0
        for (let i = 0; i < list.length; i++) {
          const c = list[i]!
          const len = c.byteLength ?? c.data.byteLength
          if (len > 0) {
            this.device.queue.writeBuffer(this.level.buf, slotBase + off, c.data, 0, len)
          }
          slotOut.push({
            first: (slotBase + off) / VERT_BYTES,
            count: len / VERT_BYTES,
            box: c.box,
            cutBox: c.cutBox,
            customCutaway: c.customCutaway,
          })
          off += len
        }
        this.streamSlotKeys[s] = key
        this.streamSlotChunks[s] = slotOut
      }
      if (!slotOverflow) {
        const mergedChunks: Chunk[] = []
        for (let s = 0; s < 9; s++) {
          const sc = this.streamSlotChunks[s]!
          for (let i = 0; i < sc.length; i++) mergedChunks.push(sc[i]!)
        }
        this.chunks = mergedChunks
        this.level.count = totalCap / VERT_BYTES
      } else {
        this.streamSlotKeys.fill("")
        const [lvlBuf, lvlBytes, lvlChunks] = this.packChunks(level.chunks, false)
        this.chunks = lvlChunks
        this.level = this.upload(lvlBuf, this.level, lvlBytes)
      }
    } else {
      this.streamSlotKeys.fill("")
      const [lvlBuf, lvlBytes, lvlChunks] = this.packChunks(level.chunks, false)
      this.chunks = lvlChunks
      this.level = this.upload(lvlBuf, this.level, lvlBytes)
    }
    const [glsBuf, glsBytes, glsChunks] = this.packChunks(level.glass, true)
    this.glassChunks = glsChunks
    this.glass = this.upload(glsBuf, this.glass, glsBytes)
    const f = level.floor
    let rebound = false
    if (this.floorTex.width !== f.w || this.floorTex.height !== f.h) {
      this.floorTex.destroy()
      this.floorTex = this.device.createTexture({ size: [f.w, f.h], format: "rg8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST })
      rebound = true
    }
    this.device.queue.writeTexture({ texture: this.floorTex }, f.data, { bytesPerRow: f.w * 2 }, [f.w, f.h])
    const moon = directionalMask(f)
    if (this.moonTex.width !== moon.w || this.moonTex.height !== moon.h) {
      this.moonTex.destroy()
      this.moonTex = this.device.createTexture({ size: [moon.w, moon.h], format: "r8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST })
      rebound = true
    }
    this.device.queue.writeTexture({ texture: this.moonTex }, moon.data, { bytesPerRow: moon.w }, [moon.w, moon.h])
    const b = level.bounce
    if (this.bounceTex.width !== b.w || this.bounceTex.height !== b.h) {
      this.bounceTex.destroy()
      this.bounceTex = this.device.createTexture({ size: [b.w, b.h], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST })
      rebound = true
    }
    this.device.queue.writeTexture({ texture: this.bounceTex }, b.data, { bytesPerRow: b.w * 4 }, [b.w, b.h])
    if (rebound) this.makeSceneGroup()
  }

  private packChunks(list: LevelData["chunks"], isGlass: boolean): [ArrayBuffer, number, Chunk[]] {
    let total = 0
    for (let i = 0; i < list.length; i++) {
      const c = list[i]!
      total += c.byteLength ?? c.data.byteLength
    }
    let staging = isGlass ? this.glassStaging : this.levelStaging
    if (staging.byteLength < total) {
      staging = new Uint8Array(Math.ceil((total * 1.25) / 65536) * 65536)
      if (isGlass) this.glassStaging = staging
      else this.levelStaging = staging
    }
    const out: Chunk[] = []
    let off = 0
    for (let i = 0; i < list.length; i++) {
      const c = list[i]!
      const len = c.byteLength ?? c.data.byteLength
      staging.set(new Uint8Array(c.data, 0, len), off)
      out.push({ first: off / VERT_BYTES, count: len / VERT_BYTES, box: c.box, cutBox: c.cutBox, customCutaway: c.customCutaway })
      off += len
    }
    return [staging.buffer, total, out]
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
    this.measureTarget?.destroy();this.measureTarget=null
    this.previousFrame = null
    this.velocity?.destroy()
    this.velocityMSAA?.destroy()
    this.velocity = this.velocityMSAA = null
    this.msaa?.destroy()
    this.depth?.destroy()
    this.hdr?.destroy()
    for (const b of this.bloom) b.destroy()
    const d = this.device
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
    this.msaa = d.createTexture({ size: [w, h], format: HDR, sampleCount: SAMPLES, usage: GPUTextureUsage.RENDER_ATTACHMENT })
    this.msaaView = this.msaa.createView()
    this.depth = d.createTexture({ size: [w, h], format: DEPTH, sampleCount: SAMPLES, usage })
    this.depthView = this.depth.createView()
    this.smokeRenderer.resize(w,h,this.depthView)
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

  setVisibility(data: Uint8Array<ArrayBuffer>, w: number, h: number): void {
    if (this.visibilityTex.width !== w || this.visibilityTex.height !== h) {
      this.visibilityTex.destroy()
      this.visibilityTex = this.device.createTexture({ size: [w, h], format: "r8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST })
      this.makeSceneGroup()
    }
    this.device.queue.writeTexture({ texture: this.visibilityTex }, data, { bytesPerRow: w }, [w, h])
  }

  private prepareMotion(): void {
    if (this.velocity) return
    const d = this.device, size = [this.width, this.height]
    this.velocity = d.createTexture({ size, format: HDR, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING })
    this.velocityMSAA = d.createTexture({ size, format: HDR, sampleCount: SAMPLES, usage: GPUTextureUsage.RENDER_ATTACHMENT })
    this.velocityView = this.velocity.createView()
    this.velocityMSAAView = this.velocityMSAA.createView()
    this.motionComposite = d.createBindGroup({ layout: this.motionPostLayout, entries: [
      { binding: 0, resource: this.hdrView }, { binding: 1, resource: this.sampler },
      { binding: 2, resource: { buffer: this.postParams[0]! } },
      { binding: 3, resource: this.bloomViews[0]! },
      { binding: 4, resource: { buffer: this.gradeBuf } }, { binding: 5, resource: this.velocityView },
    ] })
  }

  private pending: FrameInput | null = null
  private scheduled = false
  inflight = 0
  onIdle: (() => void) | null = null
  private readonly notifyPacer: () => void

  /**
   * Queues a frame. Calls within one task collapse to the last (Game reuses its arrays, so the latest input is always
   * consistent), and at most two frames are in flight: a slow GPU (SwiftShader) drops frames instead of building an
   * unbounded backlog. A dropped frame is drawn once the GPU catches up, so the latest state always reaches the screen.
   */
  setSmoke(trail: SmokeTrail, visible: boolean): void { this.vehicleSmoke.upload(trail, visible) }

  /**
   * Opt-in hook for applying a shared `LookSettings` preset or custom look to this Renderer.
   * Passing `null` or `"current"` (identity) restores the exact baseline pipelines.
   */
  setLook(look: LookSettings | LookPresetId | null, compare?: { mode?: LookCompareMode; wipeSplit?: number }): void {
    if (typeof look === "string") {
      const pid = resolveLookPresetId(look) ?? "current"
      this.activeLook = createLookSettings(pid)
    } else {
      this.activeLook = look ? { ...look } : null
    }
    if (compare) this.activeLookCompare = { ...compare }
  }

  getLook(): LookSettings | null {
    return this.activeLook ? { ...this.activeLook } : null
  }

  get compiledLookVariants(): LookVariantMode[] {
    return [...this.lookPipesByVariant.keys()]
  }

  private ensureLookPipes(variant: LookVariantMode = "generic"): Record<string, GPURenderPipeline> {
    const cached = this.lookPipesByVariant.get(variant)
    if (cached) return cached
    const d = this.device
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
    const premul: GPUBlendState = { color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" }, alpha: { srcFactor: "zero", dstFactor: "one" } }
    const layout = d.createPipelineLayout({ bindGroupLayouts: [this.sceneLayout] })
    const sceneCode =
      this.shaders?.lookSceneVariant?.(variant) ??
      (variant === "generic" && this.shaders?.lookScene ? this.shaders.lookScene : makeLookSceneShader(undefined, variant))
    const lookSceneMod = this.module(sceneCode, `scene look (${variant})`)
    const pipe = (vs: string, buffers: GPUVertexBufferLayout[], blend?: GPUBlendState, depthWrite = true, fs = "fs") =>
      d.createRenderPipeline({
        layout,
        vertex: { module: lookSceneMod, entryPoint: vs, buffers },
        fragment: { module: lookSceneMod, entryPoint: fs, targets: [{ format: HDR, blend }] },
        primitive: { topology: "triangle-list", cullMode: "none" },
        depthStencil: { format: DEPTH, depthWriteEnabled: depthWrite, depthCompare: "less-equal" },
        multisample: { count: SAMPLES },
      })
    const postCode =
      this.shaders?.lookPostVariant?.(variant) ??
      (variant === "generic" && this.shaders?.lookPost ? this.shaders.lookPost : makeLookPostShader(undefined, variant))
    const lookPostMod = this.module(postCode, `post look (${variant})`)
    const postPipeLayout = d.createPipelineLayout({ bindGroupLayouts: [this.postLayout] })
    const pipes = {
      level: pipe("vsStatic", [meshLayout], undefined, true, "fsSolid"),
      levelCut: pipe("vsStatic", [meshLayout], undefined, true, "fs"),
      glass: pipe("vsStatic", [meshLayout], premul, false, this.shaders ? "fsSolid" : "fs"),
      inst: pipe("vsInst", [meshLayout, instLayout], undefined, true, this.shaders ? "fsSolid" : "fs"),
      instAlpha: pipe("vsInst", [meshLayout, instLayout], premul, false, "fs"),
      composite: d.createRenderPipeline({
        layout: postPipeLayout,
        vertex: { module: lookPostMod, entryPoint: "vs" },
        fragment: { module: lookPostMod, entryPoint: "composite", targets: [{ format: this.format }] },
        primitive: { topology: "triangle-list" },
      }),
      compositeFast: d.createRenderPipeline({
        layout: postPipeLayout,
        vertex: { module: lookPostMod, entryPoint: "vs" },
        fragment: { module: lookPostMod, entryPoint: "compositeFast", targets: [{ format: this.format }] },
        primitive: { topology: "triangle-list" },
      }),
    }
    this.lookPipesByVariant.set(variant, pipes)
    return pipes
  }

  render(f: FrameInput): void {
    this.pending = f
    this.schedule()
  }

  /** Immediate synchronous render for Lab sections that share a Stage output texture. */
  drawTo(f: FrameInput, targetView?: GPUTextureView): void {
    this.draw(f, targetView)
  }

  get hasPending(): boolean {
    return this.pending !== null
  }

  private schedule(): void {
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      this.flushPending()
    })
  }

  private flushPending(): void {
    const f = this.pending
    if (!f || this.inflight >= 1) return
    this.pending = null
    this.draw(f)
    this.inflight++
    void this.device.queue.onSubmittedWorkDone().then(() => {
      this.inflight--
      this.onIdle?.()
      this.notifyPacer()
    })
  }

  private draw(f: FrameInput, targetView?: GPUTextureView): void {
    const d = this.device
    const motion = !this.shaders && !!(f.frame[45]! & 1024)
    const effectiveLook = f.look !== undefined ? f.look : this.activeLook
    const effectiveCompare = f.lookCompare ?? this.activeLookCompare
    const useLookPipes = !motion && Boolean(effectiveLook) && (!isIdentityLook(effectiveLook) || effectiveCompare.mode === 2)
    if (f.splatter) {
      this.splatterRenderer ??= new SplatterRenderer(d)
      for (let i = 0; i < 3; i++) this.splatterEye[i] = f.frame[16 + i]!
      const noirMode = Boolean(useLookPipes && effectiveLook && (effectiveLook.preset === "noir" || effectiveLook.selectiveColor > 0.5))
      let flashlight: SplatterLightingInput["flashlight"] = null
      let pointLight: SplatterLightingInput["pointLight"] = null
      let bestPointPower = 0
      for (let i = 0; i < f.lightCount; i++) {
        const k = i * LIGHT_FLOATS
        const power = f.lights[k + 7]!
        if (power <= 0.001) continue
        if (!flashlight && f.lights[k + 11]! > 0.5 && f.lights[k + 15]! < -0.5) {
          flashlight = {
            x: f.lights[k]!,
            y: f.lights[k + 1]!,
            z: f.lights[k + 2]!,
            range: f.lights[k + 3]!,
            color: [f.lights[k + 4]!, f.lights[k + 5]!, f.lights[k + 6]!] as const,
            power,
            dirX: f.lights[k + 8]!,
            dirZ: f.lights[k + 9]!,
            cosHalf: f.lights[k + 10]!,
          }
        } else if (power > bestPointPower) {
          bestPointPower = power
          pointLight = {
            x: f.lights[k]!,
            y: f.lights[k + 1]!,
            z: f.lights[k + 2]!,
            radius: f.lights[k + 3]!,
            color: [f.lights[k + 4]!, f.lights[k + 5]!, f.lights[k + 6]!] as const,
            power,
          }
        }
      }
      this.splatterRenderer.prepare(f.splatter, f.frame, this.splatterEye, motion, {
        ambient: [Math.max(0.14, f.frame[28]!), Math.max(0.15, f.frame[29]!), Math.max(0.18, f.frame[30]!)],
        noirMode,
        legacy: f.splatterLegacy,
        flashlight,
        pointLight,
      })
    }
    if (f.fxParticles && f.fxParticles.count > 0) {
      this.particleRenderer ??= new ParticleRenderer(d, DEPTH, SAMPLES)
      this.particleRenderer.setFrame({
        vp: f.frame,
        eye: [f.frame[16]!, f.frame[17]!, f.frame[18]!],
        debug: 0,
        ambient: [Math.max(0.18, f.frame[28]!), Math.max(0.2, f.frame[29]!), Math.max(0.24, f.frame[30]!)],
        lights: f.lights,
        lightCount: f.lightCount,
        lightStride: LIGHT_FLOATS,
      })
      this.particleRenderer.upload(f.fxParticles)
    }
    if (f.weather) {
      this.weatherRenderer ??= new WeatherRenderer(d, HDR, DEPTH, SAMPLES)
      this.weatherRenderer.prepare(f.weather)
    }
    if (motion) this.prepareMotion()
    const lookVariant: LookVariantMode = useLookPipes
      ? this.shaders && !this.shaders.lookSceneVariant
        ? "generic"
        : resolveLookVariant(effectiveLook, effectiveCompare)
      : "generic"
    const scenePipes = motion
      ? this.motionPipes
      : useLookPipes
        ? this.ensureLookPipes(lookVariant)
        : this.shaders || ((f.frame[45]! & ~1025) && f.frame[46]!) || (f.frame[45]! & 512)
          ? this.pipes
          : this.baselinePipes
    const old = this.previousFrame
    const elapsed = old ? f.frame[19]! - old[19]! : 0
    const continuous = !!old && elapsed > 0 && elapsed < 0.1 && Math.hypot(f.frame[16]! - old[16]!, f.frame[17]! - old[17]!, f.frame[18]! - old[18]!) < 4
    this.history.begin(continuous)
    if (motion) {
      this.motionData.set((continuous ? old! : f.frame).subarray(0, 16))
      // A 1/60 s exposure. The shader suppresses subpixel camera drift and caps fast trails.
      this.motionData[16] = continuous ? Math.min(2, 1 / (60 * elapsed)) * motionSettings.strength * motionSettings.shutter : 0
      d.queue.writeBuffer(this.motionBuf, 0, this.motionData)
    } else if (useLookPipes && effectiveLook) {
      packLookUniforms(effectiveLook, this.lookSceneData, 0, {
        compareMode: effectiveCompare.mode ?? 1,
        wipeSplit: effectiveCompare.wipeSplit ?? 0.5,
      })
      d.queue.writeBuffer(this.motionBuf, 0, this.lookSceneData)
    }
    this.previousFrame = motion ? f.frame.slice() : null
    d.queue.writeBuffer(this.frameBuf, 0, f.frame)
    if (f.lightCount) d.queue.writeBuffer(this.lightBuf, 0, f.lights.buffer, f.lights.byteOffset, f.lightCount * LIGHT_FLOATS * 4)
    if (f.occluderCount) d.queue.writeBuffer(this.occBuf, 0, f.occluders.buffer, f.occluders.byteOffset, Math.min(f.occluderCount, MAX_OCCLUDERS) * OCC_FLOATS * 4)
    if (f.lampCount) d.queue.writeBuffer(this.lampBuf, 0, f.lampPower.buffer, f.lampPower.byteOffset, Math.min(f.lampCount, MAX_MAP_LIGHTS) * 4)
    this.gradeData.set(f.grade)
    const feel = f.feel
    if (useLookPipes && effectiveLook) {
      this.gradeData[4] = feel ? feel[0]! : 0
      this.gradeData[5] = feel ? feel[1]! : 0
      this.gradeData[6] = feel ? feel[2]! : 0
      this.gradeData[7] = feel ? feel[3]! : 0
      packLookUniforms(effectiveLook, this.gradeData, 8, {
        compareMode: effectiveCompare.mode ?? 1,
        wipeSplit: effectiveCompare.wipeSplit ?? 0.5,
      })
      d.queue.writeBuffer(this.gradeBuf, 0, this.gradeData)
    } else {
      this.gradeData[4] = (f.frame[45]! & 1) + (feel ? Math.min(0.48, Math.max(0, feel[3]!)) : 0)
      this.gradeData[5] = feel ? feel[0]! : 0
      this.gradeData[6] = feel ? feel[1]! : 0
      this.gradeData[7] = feel ? feel[2]! : 0
      d.queue.writeBuffer(this.gradeBuf, 0, this.gradeData.buffer, this.gradeData.byteOffset, 32)
    }

    const total = f.batches.reduce((s, b) => s + b.count, 0)
    if (motion && total * INST_FLOATS > this.previousData.length) {
      this.previousData = new Float32Array(total * INST_FLOATS * 2)
      this.previousInst.destroy()
      this.previousInst = d.createBuffer({ size: this.previousData.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    }
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
      if (motion) for (let i = 0; i < b.count; i++) this.history.write(this.previousData, (off + i) * INST_FLOATS, b.data, i * INST_FLOATS, b.motionKeys?.[i])
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
    if (motion && off) d.queue.writeBuffer(this.previousInst, 0, this.previousData.buffer, 0, off * INST_FLOATS * 4)
    const alphaCount = Math.min(f.alphaCount, half)
    const addCount = Math.min(f.addCount, half)
    if (alphaCount) d.queue.writeBuffer(this.sprites, 0, f.alphaSprites.buffer, 0, alphaCount * SPRITE_FLOATS * 4)
    const addOffset = half * SPRITE_FLOATS * 4
    if (addCount) d.queue.writeBuffer(this.sprites, addOffset, f.addSprites.buffer, 0, addCount * SPRITE_FLOATS * 4)
    if (motion) {
      this.spriteHistory.set(f.alphaSprites.subarray(0, alphaCount * SPRITE_FLOATS))
      for (let i = 0; i < alphaCount; i++) this.spriteHistory[i * SPRITE_FLOATS + 3] = 0
      for (let i = 0; i < addCount; i++) {
        const key = f.addMotionKeys?.[i]
        const at = (half + i) * SPRITE_FLOATS
        this.history.write(this.spriteHistory, at, f.addSprites, i * SPRITE_FLOATS, key)
        this.spriteHistory[at + 3] = key?.initial ? 1 : 0
      }
      d.queue.writeBuffer(this.previousSprites, 0, this.spriteHistory)
    }

    const enc = d.createCommandEncoder()
    if (f.shadowLightCount) {
      const cp = enc.beginComputePass({ timestampWrites: this.timing ? this.timer!.start : undefined })
      cp.setPipeline(this.polarPipe)
      cp.setBindGroup(0, this.computeGroup)
      cp.dispatchWorkgroups(Math.ceil((Math.min(f.shadowLightCount, SLOTS) * POLAR_RAYS) / 64))
      if (this.field) {
        cp.setPipeline(this.field.pipe)
        cp.setBindGroup(0, this.field.group)
        cp.dispatchWorkgroups(Math.ceil(this.field.dispatch / 8), Math.ceil(this.field.dispatch / 8))
      }
      cp.end()
    }

    const hasSmoke = !!(f.smoke && f.smokeEnabled && f.smoke.count)
    const pass = enc.beginRenderPass({
      timestampWrites: this.timing && !f.shadowLightCount ? this.timer!.start : undefined,
      colorAttachments: [{ view: this.msaaView, resolveTarget: this.hdrView, clearValue: { r: 0.004, g: 0.006, b: 0.014, a: 1 }, loadOp: "clear", storeOp: "discard" }, ...(motion ? [{ view: this.velocityMSAAView, resolveTarget: this.velocityView, clearValue: { r: 0, g: 0, b: 1000, a: 1 }, loadOp: "clear" as const, storeOp: "discard" as const }] : [])],
      depthStencilAttachment: { view: this.depthView, depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: hasSmoke ? "store" : "discard" },
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
        const insideCustom = c.customCutaway ? intersectsCutaway(c.cutBox, f.frame, true) : false
        const peeking = f.frame[26]! > 1.001
        if (c.customCutaway === "outside" && insideCustom && !peeking) continue
        drawn++
        const next = c.customCutaway ? (insideCustom && peeking) : intersectsCutaway(c.cutBox, f.frame)
        if (cut !== next) {
          cut = next
          pass.setPipeline(cut ? scenePipes.levelCut! : scenePipes.level!)
        }
        pass.draw(c.count, 1, c.first)
      }
      this.drawnChunks = drawn
    }
    pass.setVertexBuffer(1, this.inst.buf)
    if (motion) pass.setVertexBuffer(2, this.previousInst)
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
      pass.setPipeline((motion ? this.motionPipes : this.pipes).spriteAlpha!)
      pass.setVertexBuffer(0, this.sprites, 0)
      if (motion) pass.setVertexBuffer(1, this.previousSprites, 0)
      pass.draw(6, alphaCount)
    }
    this.vehicleSmoke.draw(pass, motion)
    if (addCount) {
      pass.setPipeline((motion ? this.motionPipes : this.pipes).spriteAdd!)
      pass.setVertexBuffer(0, this.sprites, addOffset)
      if (motion) pass.setVertexBuffer(1, this.previousSprites, addOffset)
      pass.draw(6, addCount)
    }
    if(f.splatter)this.splatterRenderer!.draw(pass,motion)
    if(f.fxParticles&&f.fxParticles.count>0)this.particleRenderer!.draw(pass,motion)
    if(f.weather)this.weatherRenderer!.draw(pass,motion)
    pass.end()

    if (f.smoke && f.smokeEnabled && f.smoke.count) {
      for (let i = 0; i < 16; i++) this.smokeMatrix[i] = f.frame[i]!
      mat4.inverse(this.smokeMatrix, this.smokeInverse)
      this.smokeRenderer.setFrame({
        inverse: this.smokeInverse,
        eye: [f.frame[16]!, f.frame[17]!, f.frame[18]!],
        ambient: [0.09, 0.105, 0.14],
        lights: f.lights,
        lightCount: f.lightCount,
        lightStride: LIGHT_FLOATS,
        volumes: f.smoke,
      })
      this.smokeRenderer.render(enc, this.hdrView, f.smoke)
    }

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
    const output = this.timing ? this.measureView : (targetView ?? this.context.getCurrentTexture().createView())
    const fp = enc.beginRenderPass({ colorAttachments: [{ view: output, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }] })
    const hasFeelBurst =
      Boolean(f.feel) &&
      (Math.abs(f.feel![0]!) > 0.00018 ||
        Math.abs(f.feel![1]!) > 0.00018 ||
        f.feel![2]! > 0.00018 ||
        f.feel![3]! > 0.002)
    const useFastLookPost =
      !hasFeelBurst &&
      useLookPipes &&
      effectiveLook &&
      (effectiveCompare.mode ?? 1) === 1 &&
      effectiveLook.painterlySmooth <= 0.01 &&
      effectiveLook.outlineStrength <= 0.001 &&
      Math.round(effectiveLook.tonemap) !== 2
    fp.setPipeline(
      motion
        ? this.motionPipes.composite!
        : useLookPipes
          ? (useFastLookPost
              ? this.ensureLookPipes(lookVariant).compositeFast!
              : this.ensureLookPipes(lookVariant).composite!)
          : f.frame[45]! & 1
            ? this.pipes.composite!
            : this.baselinePipes.composite!,
    )
    fp.setBindGroup(0, motion ? this.motionComposite : g.composite)
    fp.draw(3)
    fp.end()
    if(this.timing) this.timer!.finish(enc,output)
    d.queue.submit([enc.finish()])
    this.submittedFrames++
  }

  /** Isolated proof caller owns scheduling. One complete dependent GPU interval, never pass sums. */
  async measure(f:FrameInput) {
    await this.device.queue.onSubmittedWorkDone()
    this.timer ??= new FrameTimer(this.device)
    if(!this.measureTarget){this.measureTarget=this.device.createTexture({size:[this.width,this.height],format:this.format,usage:GPUTextureUsage.RENDER_ATTACHMENT});this.measureView=this.measureTarget.createView()}
    this.timing=true;this.draw(f);this.timing=false
    return this.timer.collect()
  }
}
