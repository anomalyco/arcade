import { MAX_LIGHTS, MAX_MAP_LIGHTS, MAX_OCCLUDERS, POLAR_RAYS, LIGHT_FLOATS, OCC_FLOATS } from "../limits"
import { directionalMask, type LevelData } from "./level"
import { VERT_BYTES, type Mesh } from "./mesh"
import { mat4 } from "wgpu-matrix"
import { VolumeRenderer } from "@arcade/kit/fx/volume-renderer"
import type { SmokeVolumes } from "@arcade/kit/fx/volume"
import type { Particles } from "@arcade/kit/fx/particles"
import { ParticleRenderer } from "@arcade/kit/fx/particle-renderer"
import { FrameTimer } from "@arcade/kit/fx/frame-timer"
import { SPOT_SHADOW_BINDINGS, SPOT_SHADOW_UNIFORM_FLOATS } from "./shadows/spot-shadows"
import { CAPSULE_SHADOW_BINDING, CapsuleShadows } from "./shadows/capsule-shadows"
import { installFramePacer } from "../gpu-perf"
import {
  MotionBlur,
  MotionHistory,
  motionSettings,
  type MotionBlurBurst,
  type MotionBlurSettings,
  type MotionKey,
} from "./motion"
import type { Splatter } from "@arcade/kit/fx/splatter"
import { SplatterRenderer, type SplatterLightingInput } from "@arcade/kit/fx/splatter-renderer"
import type { SkidMarks } from "@arcade/kit/fx/skids"
import { SkidRenderer } from "@arcade/kit/fx/skid-renderer"
import { WeatherRenderer, type WeatherCamera, type WeatherPrepareInput } from "../weather"
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
import { LampGrid } from "./lamp-grid"
export { LAMP_GRID_CELL, LAMP_GRID_DIM, LAMP_GRID_SLOTS, LampGrid, scoreLampAtCell } from "./lamp-grid"
import { SmokeRenderer } from "@arcade/kit/vehicle/smoke-renderer"
import type { SmokeTrail } from "@arcade/kit/vehicle/smoke-trail"
import { SURFACE_TEX_UNIFORM_FLOATS, packSurfaceTexUniforms, type SurfaceTexUniformInput } from "./surface-materials"
import { createFallbackMaterialTextureArray, createMaterialSampler, loadMaterialTextureArray } from "../textures/loader"
import { boxIntersectsRect2D, drawContiguousChunks, drawContiguousChunksByMode } from "./cull"
import {
  PassList,
  compileShaderModuleWithLog,
  depthConfigForMode,
  type PassContext,
  type PassSlot,
  type ScenePass,
} from "./pass-graph"
import { BloomPyramid, DEFAULT_BLOOM_LEVELS, GrowableInstanceBuffer, SceneTargets, uploadSplitSprites } from "./targets"
import {
  TemporalResolve,
  internalSize,
  jitterViewProj,
  temporalEnabled,
  temporalScale,
  type TemporalSettings,
  type TemporalState,
} from "./temporal"
import { REACTIVE_COVERAGE_WGSL, REACTIVE_TARGET } from "./reactive"
import { VolumeSlot, type VolumeInput, type VolumeLightShader, type VolumeView } from "./volume-pass"
import { POST_CUSTOM_OFFSET, POST_UNIFORM_FLOATS } from "./post-uniform"
import { FOG_GLOW_FLOATS, FOG_GLOW_OFFSET, FOG_LAMP_BUFFER_FLOATS, FOG_LAMP_FLOATS, FOG_UNIFORM_FLOATS, MAX_FOG_LAMPS, type FogFrame } from "./fog-scatter"
import { FogBlur, type FogBlurInput } from "./fog-blur"
import { PLAN_BOUNCE_BINDINGS, PLAN_BOUNCE_UNIFORM_FLOATS, PlanBounce, type PlanBounceInput, type PlanBounceShader } from "./gi/plan-bounce"

export type { PassContext, PassSlot, ScenePass }
export type { AntiAliasingMode, TemporalSettings, TemporalState } from "./temporal"
export { TEMPORAL_DEFAULTS } from "./temporal"

const SAMPLES = 4
const HDR: GPUTextureFormat = "rgba16float"
const DEPTH_CFG = depthConfigForMode("standard")
const DEPTH: GPUTextureFormat = DEPTH_CFG.format
export { LIGHT_FLOATS }
export const INST_FLOATS = 12
export const SPRITE_FLOATS = 12
const MESH_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: VERT_BYTES,
  attributes: [
    { shaderLocation: 0, offset: 0, format: "float32x3" },
    { shaderLocation: 1, offset: 12, format: "snorm8x4" },
    { shaderLocation: 2, offset: 16, format: "unorm8x4" },
    { shaderLocation: 3, offset: 20, format: "float16x2" },
  ],
}
const INST_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: INST_FLOATS * 4,
  stepMode: "instance",
  attributes: [
    { shaderLocation: 5, offset: 0, format: "float32x4" },
    { shaderLocation: 6, offset: 16, format: "float32x4" },
    { shaderLocation: 7, offset: 32, format: "float32x4" },
  ],
}
const SPRITE_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: SPRITE_FLOATS * 4,
  stepMode: "instance",
  attributes: [
    { shaderLocation: 0, offset: 0, format: "float32x4" },
    { shaderLocation: 1, offset: 16, format: "float32x4" },
    { shaderLocation: 2, offset: 32, format: "float32x4" },
  ],
}
/** Size of the game's custom uniform block at binding 13. */
export const CUSTOM_UNIFORM_BYTES = 2048
const MAX_SPRITES = 8192
const BLOOM_LEVELS = DEFAULT_BLOOM_LEVELS
const SLOTS = MAX_LIGHTS

type Buf = { buf: GPUBuffer; count: number; cap: number }
type Chunk = { first: number; count: number; box: readonly [number, number, number, number]; cutBox?: readonly number[]; customCutaway?: boolean | "outside" | "a2c" | "fade" }

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

/**
 * Optional game volumetric-light passes (`shaders.volume`, one shader or several). Each `code` provides
 * `@vertex fn vs` (fullscreen triangle) and `@fragment fn fs` bound to the frame (0), lights (1), polar map (2) and
 * custom uniforms (13); with `depth` also the scene depth (3), the unjittered `VolumeFrame` (4), `FogParams` (18) and
 * the fog lamps (19). It renders at 1/`FrameInput.volume` resolution into rgba16float: rgb is in-scattered radiance,
 * a how much it should restore selective colour. The renderer adds rgb into the HDR target and multiplies its alpha by
 * 1 - a (`@arcade/kit/gpu/volume-pass`).
 */
export type { VolumeInput, VolumeLightShader }

/**
 * `reactive` marks instances that move on their own (flying debris, thrown items): under temporal AA they are redrawn
 * into the reactive mask (`@arcade/kit/gpu/reactive`) so the resolve doesn't trail them. Leave it off for actors.
 */
export type Batch = { model: number; data: Float32Array<ArrayBuffer>; count: number; alpha?: boolean; reactive?: boolean; motionKeys?: (MotionKey | undefined)[] }

export type FrameInput = {
  splatter?:Splatter
  /** Persistent tyre marks (`@arcade/kit/fx/skids`), multiplied onto the lit ground after opaque geometry. */
  skids?: SkidMarks
  skidsVisible?: boolean
  splatterLegacy?:boolean
  fxParticles?: Particles
  /**
   * How `fxParticles` are lit and composited; omitted keeps the defaults (the frame ambient with a floor, the first
   * eight frame lights as points, alpha composited over). `lights` uses the frame's `LIGHT_FLOATS` stride.
   */
  fxLighting?: {
    ambient?: readonly [number, number, number]
    lights?: Float32Array
    lightCount?: number
    /** Spot lights only light particles inside their plan cone (`cone.xyz`, spot when 0.5 < `cone.w`). */
    spotCones?: boolean
    /** Lower HDR alpha by particle coverage (Looks that read alpha as one minus a colour mask keep fire in colour). */
    keepColour?: boolean
  }
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
  /**
   * Volumetric-light pass (renderer `shaders.volume`): resolution divisor and optional screen rect [x0, y0, x1, y1]
   * in 0..1 (top-left origin) that bounds the light, so both passes skip the rest of the screen. Omit or null to skip.
   */
  volume?: VolumeInput | readonly (VolumeInput | null | undefined)[] | null
  /** Fog uniforms and scatter lamps (`FogScatter.update`), read by `fogSceneWgsl` and `fogScatterVolume`. */
  fog?: FogFrame | null
  /** Fog-depth blur after the fog volume (`FogScatter.blurInput`, `@arcade/kit/gpu/fog-blur`); needs `fog`. */
  fogBlur?: FogBlurInput | null
  /** time, desaturate, flash, exposure */
  grade: [number, number, number, number]
  /** Optional shared screen-space shutter + impulse motion blur (`@arcade/kit/gpu/motion-blur`). */
  motionBlur?: {
    settings: MotionBlurSettings
    burst?: MotionBlurBurst
    dt?: number
  }
  /** Optional opt-in rendering style ("Look"). When omitted or "Current" identity, baseline pipelines run unchanged. */
  look?: LookSettings | null
  lookCompare?: { mode?: LookCompareMode; wipeSplit?: number }
  /** Optional game post-process uniform tuple packed into GL.pad.yzw (gradeData[5..7]). */
  postParams?: readonly [number, number, number]
  /** Optional independent vec4 after the grade/Look blocks; see `customPostGradeWgsl`. Zero when omitted. */
  postCustom?: readonly [number, number, number, number]
  /** Optional fourth game post-process float, packed into GL.pad.x on the look pipes only. */
  postExtra?: number
  /** Optional 2D static lamp light-list grid (`uLampGrid`) for `lights[directLightCount .. lightCount)`. */
  lampGrid?: LampGrid | null
  /**
   * One-bounce plan-space light (`@arcade/kit/gpu/gi/plan-bounce`; the renderer needs `shaders.planBounce`). Null or a
   * zero strength skips its passes and the scene's `planBounceAt` returns nothing.
   */
  planBounce?: PlanBounceInput | null
}

/**
 * A screen-space pass after the composite (camera filters, `@arcade/kit/gpu/post/camcorder`). While `active`, the
 * composite draws into `source()` and the pass draws that to the canvas; `frame` holds the unjittered viewProj, eye
 * and time at 0..19. Inactive passes cost nothing.
 */
export interface FinalPass {
  readonly active: boolean
  source(width: number, height: number): GPUTextureView
  encode(encoder: GPUCommandEncoder, target: GPUTextureView, frame: Float32Array): void
}

/**
 * WebGPU renderer. Per frame: (1) a compute pass casts POLAR_RAYS rays from each culled light against the occluders
 * within its reach (walls, furniture with heights, people), (2) an MSAA HDR pass draws the level chunks in view,
 * instanced characters, glass and light haze, and sprites, all lit through that polar shadow map, (3) bloom, then a
 * tone-mapped composite with grade, vignette and grain.
 */
export class Renderer {
  private splatterRenderer?:SplatterRenderer
  private skidRenderer?: SkidRenderer
  private particleRenderer?:ParticleRenderer
  private weatherRenderer?:WeatherRenderer
  private readonly weatherCamera: WeatherCamera = { viewProj: [], width: 1, height: 1 }
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
  private spotShadow: { view: GPUTextureView; sampler: GPUSampler; uniform: GPUBuffer }
  private capsuleShadowBuf: GPUBuffer
  private sceneLayout: GPUBindGroupLayout
  private floorTex: GPUTexture
  private moonTex: GPUTexture
  private visibilityTex: GPUTexture
  private fieldTex: GPUTexture
  private lampGridTex: GPUTexture
  private field: { pipe: GPUComputePipeline; group: GPUBindGroup; state: GPUBuffer; dispatch: number } | null = null
  private volumes: VolumeSlot[] = []
  private fogBuf: GPUBuffer
  private fogLampBuf: GPUBuffer
  private fogGlowVersion = -1
  private fogBlur: FogBlur | null = null
  private readonly fogBlurInv = new Float32Array(16)
  private readonly volumeInv = new Float32Array(16)
  private readonly volumeVP = new Float32Array(16)
  private readonly volumePrevVP = new Float32Array(16)
  private readonly volumeEye: [number, number, number] = [0, 0, 0]
  private volumeFrame = 0
  private volumeReady = false
  private bounceTex: GPUTexture
  private planBounce: PlanBounce | null = null
  /** Bounce pipelines compile on the first frame that asks for bounce, so a game that leaves it off pays nothing. */
  private readonly planBounceShader: PlanBounceShader | null
  private planBounceVersion = -1
  private planBounceFallback: { view: GPUTextureView; uniform: GPUBuffer }
  private floorSampler: GPUSampler
  private materialTex: GPUTexture
  private materialTexView: GPUTextureView
  private materialSampler: GPUSampler
  /** Game-owned texture array at binding 15 (Outbreak's baked rugs); a 1×1 placeholder until a game sets one. */
  private detailView: GPUTextureView
  private detailSampler: GPUSampler
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
  private finalPass: FinalPass | null = null
  private baselinePipes: Record<string, GPURenderPipeline> = {}
  private motionPipes: Record<string, GPURenderPipeline> = {}
  private lookPipesByVariant = new Map<LookVariantMode, Record<string, GPURenderPipeline>>()
  private lookCompositeBuilders = new Map<LookVariantMode, (fs: "composite" | "compositeFast") => GPURenderPipeline>()
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
  private velocityAttachment: GPURenderPassColorAttachment | null = null
  private motionPostLayout: GPUBindGroupLayout
  private motionComposite!: GPUBindGroup
  private sharedBlur: MotionBlur | null = null
  private sharedBlurGroups: { down0: GPUBindGroup; composite: GPUBindGroup; w: number; h: number } | null = null
  private readonly blurPrevVP = new Float32Array(16)
  private readonly blurLastVP = new Float32Array(16)
  private readonly blurInverseVP = new Float32Array(16)
  private readonly blurLastEye = new Float32Array(3)
  private blurLastTime = -1
  private blurReady = false
  private level: Buf | null = null
  private glass: Buf | null = null
  private models: Buf[] = []
  private inst: GrowableInstanceBuffer
  private sprites: GPUBuffer
  private targets: SceneTargets
  private bloomPyramid: BloomPyramid
  private passes = new PassList()
  readonly passContext: PassContext
  private gradeData = new Float32Array(POST_UNIFORM_FLOATS)
  private postLayout: GPUBindGroupLayout
  private sampler: GPUSampler
  /** Level chunks drawn last frame, for diagnostics. */
  drawnChunks = 0
  /** Coalesced level chunk draw calls issued last frame. */
  drawnChunkDraws = 0
  /** Level chunks currently resident, for diagnostics. */
  get levelChunkCount(): number {
    return this.chunks.length
  }
  /** Successfully submitted frames, not draw requests or confirmed screen presentations. */
  submittedFrames = 0
  width = 0
  height = 0
  /** Most recent GPU queue-completion latency (ms) from flushPending. */
  lastGpuMs = 0
  /** Exponential moving average of GPU queue-completion latency (ms). */
  emaGpuMs = 0
  private bloomLevels = BLOOM_LEVELS
  private temporalSettings: TemporalSettings | null = null
  private temporal: TemporalResolve | null = null
  private bloomSource: GPUTexture | null = null
  private spriteModule!: GPUShaderModule
  private reactivePipe: GPURenderPipeline | null = null
  private reactiveInstPipe: GPURenderPipeline | null = null
  private sceneModuleCache: GPUShaderModule | null = null
  private buildScenePipes: (() => void) | null = null
  private buildBaselinePipes: (() => void) | null = null
  private buildComposite!: (baseline: boolean) => GPURenderPipeline
  private readonly unjittered = new Float32Array(22)
  /** Size the scene renders at: the output size, or smaller under temporal upscaling. */
  internalWidth = 0
  internalHeight = 0
  private readonly drawRanges: { model: number; first: number; count: number; alpha: boolean; reactive: boolean }[] = []

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
      volume?: VolumeLightShader | readonly VolumeLightShader[]
      /** One-bounce plan-space light (`FrameInput.planBounce`), with the game's light attenuation for its emission. */
      planBounce?: PlanBounceShader
      /** Unlit tyre smoke and dust colour (WGSL vec3f over the scene Frame), e.g. from `F.ambient` under Noir. */
      tyreSmoke?: { base?: string; dust?: string }
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
    this.lampGridTex = d.createTexture({ size: [1, 1], format: "rgba8uint", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST })
    this.fieldTex = d.createTexture({ size: [shaders?.visField?.size ?? 1, shaders?.visField?.size ?? 1], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING })
    this.floorSampler = d.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" })
    const fallbackMaterials = createFallbackMaterialTextureArray(d)
    this.materialTex = fallbackMaterials.texture
    this.materialTexView = fallbackMaterials.view
    this.materialSampler = createMaterialSampler(d)
    const detail = d.createTexture({ size: [1, 1, 1], format: "rgba8unorm-srgb", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST })
    this.detailView = detail.createView({ dimension: "2d-array" })
    this.detailSampler = d.createSampler({ label: "detail-anisotropic", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge", magFilter: "linear", minFilter: "linear", mipmapFilter: "linear", maxAnisotropy: 16 })
    this.surfaceTexBuf = d.createBuffer({ size: SURFACE_TEX_UNIFORM_FLOATS * 4, usage: U.UNIFORM | U.COPY_DST })
    packSurfaceTexUniforms({ ...this.surfaceTexInput, enabled: 0 }, this.surfaceTexData)
    d.queue.writeBuffer(this.surfaceTexBuf, 0, this.surfaceTexData)
    this.gradeBuf = d.createBuffer({ size: this.gradeData.byteLength, usage: U.UNIFORM | U.COPY_DST })
    this.customBuf = d.createBuffer({ size: CUSTOM_UNIFORM_BYTES, usage: U.UNIFORM | U.COPY_DST })
    this.spotShadow = {
      view: d.createTexture({ size: [1, 1, 1], format: "depth32float", usage: GPUTextureUsage.TEXTURE_BINDING }).createView({ dimension: "2d-array" }),
      sampler: d.createSampler({ compare: "less" }),
      uniform: d.createBuffer({ size: SPOT_SHADOW_UNIFORM_FLOATS * 4, usage: U.UNIFORM }),
    }
    this.capsuleShadowBuf = d.createBuffer({ label: "capsule shadows (off)", size: 64, usage: U.STORAGE })
    this.fogBuf = d.createBuffer({ label: "fog params", size: FOG_UNIFORM_FLOATS * 4, usage: U.UNIFORM | U.COPY_DST })
    this.fogLampBuf = d.createBuffer({ label: "fog lamps", size: FOG_LAMP_BUFFER_FLOATS * 4, usage: U.STORAGE | U.COPY_DST })
    this.inst = new GrowableInstanceBuffer(d, 4096, INST_FLOATS)
    this.sprites = d.createBuffer({ size: MAX_SPRITES * SPRITE_FLOATS * 4, usage: U.VERTEX | U.COPY_DST })
    this.sampler = d.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" })
    this.targets = new SceneTargets(d, {
      hdrFormat: HDR,
      depthFormat: DEPTH,
      samples: SAMPLES,
      depthTextureBinding: true,
      clearValue: { r: 0.004, g: 0.006, b: 0.014, a: 1 },
      depthClearValue: DEPTH_CFG.clearValue,
    })
    this.bloomPyramid = new BloomPyramid(d, { levels: BLOOM_LEVELS, format: HDR, upTexelSource: "target" })

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
        { binding: 15, visibility: S.FRAGMENT, texture: { viewDimension: "2d-array" } },
        { binding: 16, visibility: S.FRAGMENT, sampler: {} },
        { binding: 17, visibility: S.FRAGMENT, texture: { sampleType: "uint" } },
        { binding: SPOT_SHADOW_BINDINGS.map, visibility: S.FRAGMENT, texture: { sampleType: "depth", viewDimension: "2d-array" } },
        { binding: SPOT_SHADOW_BINDINGS.sampler, visibility: S.FRAGMENT, sampler: { type: "comparison" } },
        { binding: SPOT_SHADOW_BINDINGS.uniform, visibility: S.FRAGMENT, buffer: { type: "uniform" } },
        { binding: CAPSULE_SHADOW_BINDING, visibility: S.FRAGMENT, buffer: { type: "read-only-storage" } },
        { binding: 18, visibility: S.VERTEX | S.FRAGMENT, buffer: { type: "uniform" } },
        { binding: PLAN_BOUNCE_BINDINGS.texture, visibility: S.FRAGMENT, texture: {} },
        { binding: PLAN_BOUNCE_BINDINGS.uniform, visibility: S.FRAGMENT, buffer: { type: "uniform" } },
      ],
    })
    this.sceneLayout = sceneLayout
    this.passContext = {
      device: d,
      frameLayout: sceneLayout,
      color: HDR,
      depth: DEPTH,
      depthMode: DEPTH_CFG.mode,
      depthCompare: DEPTH_CFG.compare,
      depthClearValue: DEPTH_CFG.clearValue,
      samples: SAMPLES,
    }
    this.vehicleSmoke = new SmokeRenderer(d, sceneLayout, common,
      "if (li.cone.w > 0.5 && li.cone.w < 2.5) { a *= smoothstep(li.cone.z, min(1.0, li.cone.z + 0.08), dot(normalize(-d.xz), li.cone.xy)); }", "depth24plus",
      shaders?.tyreSmoke?.base, shaders?.tyreSmoke?.dust)
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
    this.planBounceFallback = {
      view: d.createTexture({ size: [1, 1], format: "rgba16float", usage: GPUTextureUsage.TEXTURE_BINDING }).createView(),
      uniform: d.createBuffer({ size: PLAN_BOUNCE_UNIFORM_FLOATS * 4, usage: U.UNIFORM }),
    }
    this.planBounceShader = shaders?.planBounce ?? null
    this.makeSceneGroup()

    this.polarPipe = d.createComputePipeline({
      layout: d.createPipelineLayout({ bindGroupLayouts: [computeLayout] }),
      compute: { module: this.module(polarShader, "polar"), entryPoint: "main" },
    })
    const volumeShaders = shaders?.volume ? (Array.isArray(shaders.volume) ? shaders.volume : [shaders.volume as VolumeLightShader]) : []
    this.volumes = volumeShaders.map((v, i) => new VolumeSlot(d, v, {
      frame: this.frameBuf, lights: this.lightBuf, polar: this.polarBuf, custom: this.customBuf,
      fog: this.fogBuf, fogLamps: this.fogLampBuf, sampler: this.sampler, format: HDR,
      compile: (code, label) => this.module(code, label),
    }, i))
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

    const premul: GPUBlendState = { color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" } }
    const additive: GPUBlendState = { color: { srcFactor: "one", dstFactor: "one" }, alpha: { srcFactor: "one", dstFactor: "one" } }
    const layout = d.createPipelineLayout({ bindGroupLayouts: [sceneLayout] })
    const sprite = this.module(shaders?.sprite ?? spriteShader(), "sprite")
    this.spriteModule = sprite
    const pipe = (module: GPUShaderModule, vs: string, buffers: GPUVertexBufferLayout[], blend?: GPUBlendState, depthWrite = true, cullMode: GPUCullMode = "back", fs = "fs", motion = false, alphaToCoverage = false) =>
      d.createRenderPipeline({
        layout,
        vertex: { module, entryPoint: vs, buffers },
        fragment: { module, entryPoint: fs, targets: [{ format: HDR, blend }, ...(motion ? [{ format: HDR, blend: blend ? premul : undefined }] : [])] },
        primitive: { topology: "triangle-list", cullMode },
        depthStencil: { format: DEPTH, depthWriteEnabled: depthWrite, depthCompare: "less-equal" },
        multisample: { count: SAMPLES, alphaToCoverageEnabled: alphaToCoverage && !blend && !motion },
      })
    // The scene shader's own pipelines (and the all-off baseline's) are built on first draw: a renderer that draws
    // through a look never uses them, and on a software GPU each one costs seconds before the first frame.
    this.buildScenePipes = () => {
      const scene = this.sceneModule
      this.pipes.level = pipe(scene, "vsStatic", [MESH_LAYOUT], undefined, true, "none", "fsSolid")
      this.pipes.levelCut = pipe(scene, "vsStatic", [MESH_LAYOUT], undefined, true, "none", "fs")
      this.pipes.glass = pipe(scene, "vsStatic", [MESH_LAYOUT], premul, false, "none", shaders ? "fsSolid" : "fs")
      this.pipes.inst = pipe(scene, "vsInst", [MESH_LAYOUT, INST_LAYOUT], undefined, true, "none", shaders ? "fsSolid" : "fs")
      this.pipes.instAlpha = pipe(scene, "vsInst", [MESH_LAYOUT, INST_LAYOUT], premul, false, "none", "fs")
    }
    this.buildBaselinePipes = () => {
      if (shaders) {
        this.ensureScenePipes()
        this.baselinePipes.level = this.pipes.level!
        this.baselinePipes.levelCut = this.pipes.levelCut!
        this.baselinePipes.glass = this.pipes.glass!
        this.baselinePipes.inst = this.pipes.inst!
        this.baselinePipes.instAlpha = this.pipes.instAlpha!
        return
      }
      // Keep the all-off shader's arithmetic identical, including compiler rounding.
      const baselineScene = this.module(sceneShader(false), "scene baseline")
      this.baselinePipes.level = pipe(baselineScene, "vsStatic", [MESH_LAYOUT], undefined, true, "none", "fsSolid")
      this.baselinePipes.levelCut = pipe(baselineScene, "vsStatic", [MESH_LAYOUT], undefined, true, "none", "fs")
      this.baselinePipes.glass = pipe(baselineScene, "vsStatic", [MESH_LAYOUT], premul, false, "none", "fs")
      this.baselinePipes.inst = pipe(baselineScene, "vsInst", [MESH_LAYOUT, INST_LAYOUT], undefined, true, "none", "fs")
      this.baselinePipes.instAlpha = pipe(baselineScene, "vsInst", [MESH_LAYOUT, INST_LAYOUT], premul, false, "none", "fs")
    }
    this.pipes.spriteAlpha = pipe(sprite, "vs", [SPRITE_LAYOUT], premul, false, "none")
    this.pipes.spriteAdd = pipe(sprite, "vs", [SPRITE_LAYOUT], additive, false, "none")

    const post = this.module(shaders?.post ?? postShader(), "post")
    const postPipeLayout = d.createPipelineLayout({ bindGroupLayouts: [this.postLayout] })
    const postPipe = (fs: string, fmt: GPUTextureFormat, blend?: GPUBlendState, module = post) =>
      d.createRenderPipeline({ layout: postPipeLayout, vertex: { module: post, entryPoint: "vs" }, fragment: { module, entryPoint: fs, targets: [{ format: fmt, blend }] }, primitive: { topology: "triangle-list" } })
    this.pipes.down = postPipe("down", HDR)
    this.pipes.up = postPipe("up", HDR, additive)
    this.buildComposite = (baseline) =>
      !baseline ? postPipe("composite", format)
        : shaders?.post ? this.composite(false)
        : postPipe("composite", format, undefined, this.module(postShader(false), "post baseline"))
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
    return compileShaderModuleWithLog(this.device, code, label)
  }

  private get sceneModule(): GPUShaderModule {
    return (this.sceneModuleCache ??= this.module(this.shaders?.scene ?? sceneShader(), "scene"))
  }

  private ensureScenePipes(): Record<string, GPURenderPipeline> {
    const build = this.buildScenePipes
    this.buildScenePipes = null
    build?.()
    return this.pipes
  }

  private ensureBaselinePipes(): Record<string, GPURenderPipeline> {
    const build = this.buildBaselinePipes
    this.buildBaselinePipes = null
    build?.()
    return this.baselinePipes
  }

  private composite(baseline: boolean): GPURenderPipeline {
    const pipes = baseline ? this.baselinePipes : this.pipes
    return (pipes.composite ??= this.buildComposite(baseline))
  }

  /** Registers an optional `ScenePass` plugin in the `"sky"`, `"opaque"`, or `"alpha"` slot. */
  addPass(slot: PassSlot, pass: ScenePass): void {
    this.passes.add(slot, pass)
  }

  removePass(pass: ScenePass): boolean {
    return this.passes.remove(pass)
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
        { binding: 15, resource: this.detailView },
        { binding: 16, resource: this.detailSampler },
        { binding: 17, resource: this.lampGridTex.createView() },
        { binding: SPOT_SHADOW_BINDINGS.map, resource: this.spotShadow.view },
        { binding: SPOT_SHADOW_BINDINGS.sampler, resource: this.spotShadow.sampler },
        { binding: SPOT_SHADOW_BINDINGS.uniform, resource: { buffer: this.spotShadow.uniform } },
        { binding: CAPSULE_SHADOW_BINDING, resource: { buffer: this.capsuleShadowBuf } },
        { binding: 18, resource: { buffer: this.fogBuf } },
        { binding: PLAN_BOUNCE_BINDINGS.texture, resource: this.planBounce?.view ?? this.planBounceFallback.view },
        { binding: PLAN_BOUNCE_BINDINGS.uniform, resource: { buffer: this.planBounce?.uniform ?? this.planBounceFallback.uniform } },
      ],
    })
  }

  /** Binds spot shadow maps (`@arcade/kit/gpu/shadows/spot-shadows` `SpotShadows.bindings()`) at scene bindings 20–22. */
  setSpotShadows(b: { view: GPUTextureView; sampler: GPUSampler; uniform: GPUBuffer }): void {
    this.spotShadow = b
    this.makeSceneGroup()
  }

  /** Binds soft capsule shadows (`@arcade/kit/gpu/shadows/capsule-shadows` `CapsuleShadows.buffer`) at scene binding 25. */
  setCapsuleShadows(buffer: GPUBuffer): void {
    this.capsuleShadowBuf = buffer
    this.makeSceneGroup()
  }

  private capsules: CapsuleShadows | null = null

  /** The scene's soft capsule shadows, made and bound on first use (fill it each frame with `begin`/add/`upload`). */
  capsuleShadows(): CapsuleShadows {
    if (!this.capsules) {
      this.capsules = new CapsuleShadows(this.device)
      this.setCapsuleShadows(this.capsules.buffer)
    }
    return this.capsules
  }

  /** Binds a game's texture array at `@binding(15)` (sampled with the anisotropic clamp sampler at 16). */
  setDetailTextureArray(view: GPUTextureView): void {
    this.detailView = view
    this.makeSceneGroup()
  }

  /** Each volume slot's input this frame: a single `FrameInput.volume` object feeds slot 0. */
  private volumeInput(f: FrameInput, i: number): VolumeInput | null {
    const v = f.volume
    if (!v) return null
    if (Array.isArray(v)) return (v as readonly (VolumeInput | null | undefined)[])[i] ?? null
    return i === 0 ? (v as VolumeInput) : null
  }

  /** True when a slot that reads depth runs this frame, so the scene pass keeps its depth. */
  private volumeNeedsDepth(f: FrameInput): boolean {
    for (let i = 0; i < this.volumes.length; i++) if (this.volumes[i]!.usesDepth && this.volumeInput(f, i)) return true
    return false
  }

  /**
   * Marches the volume slots at the internal size and adds them into `target` (`tw` × `th`): the resolved scene, or
   * the temporal output so the light never enters the TAA history. `vp` is this frame's unjittered viewProj.
   */
  private drawVolumes(enc: GPUCommandEncoder, f: FrameInput, vp: Float32Array, eye: readonly [number, number, number], target: GPUTextureView, tw: number, th: number): void {
    let view: VolumeView | null = null
    for (let i = 0; i < this.volumes.length; i++) {
      const slot = this.volumes[i]!
      const input = this.volumeInput(f, i)
      if (!input) {
        slot.resetHistory()
        continue
      }
      if (slot.usesDepth && !view) {
        this.volumeVP.set(vp.subarray(0, 16))
        mat4.inverse(this.volumeVP, this.volumeInv)
        const jump = Math.hypot(eye[0] - this.volumeEye[0], eye[1] - this.volumeEye[1], eye[2] - this.volumeEye[2])
        const continuous = this.volumeReady && jump < 1.5
        if (!continuous) this.volumePrevVP.set(this.volumeVP)
        view = {
          invViewProj: this.volumeInv,
          viewProj: this.volumeVP,
          prevViewProj: this.volumePrevVP,
          eye,
          frame: this.volumeFrame,
          continuous,
          depthView: this.targets.depthView,
          depthWidth: this.targets.width,
          depthHeight: this.targets.height,
          depthClear: DEPTH_CFG.clearValue,
          colorView: this.targets.hdrView,
        }
      }
      slot.draw(enc, input, this.targets.width, this.targets.height, view, target, tw, th)
    }
    if (view) {
      // This frame's camera becomes next frame's reprojection source once every slot has read it.
      this.volumePrevVP.set(this.volumeVP)
      this.volumeEye[0] = eye[0]
      this.volumeEye[1] = eye[1]
      this.volumeEye[2] = eye[2]
      this.volumeFrame++
      this.volumeReady = true
    } else {
      this.volumeReady = false
    }
  }

  /** Blurs the image after the fog volume by its fog (`FrameInput.fogBlur`) and mixes it back into `target`. */
  private drawFogBlur(enc: GPUCommandEncoder, f: FrameInput, vp: Float32Array, target: GPUTextureView, tw: number, th: number): void {
    if (!f.fogBlur || !f.fog || f.fogBlur.strength <= 0) return
    this.fogBlur ??= new FogBlur(this.device, HDR, this.fogBuf, this.sampler, (code, label) => this.module(code, label))
    mat4.inverse(vp.subarray(0, 16), this.fogBlurInv)
    this.fogBlur.draw(enc, f.fogBlur, target, target, tw, th, this.targets.depthView, this.targets.width, this.targets.height, DEPTH_CFG.clearValue, this.fogBlurInv, [f.frame[16]!, f.frame[17]!, f.frame[18]!])
  }

  private resetVolumeHistory(): void {
    this.volumeReady = false
    for (const v of this.volumes) v.resetHistory()
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
  private streamSlotBytes = 768 * 1024
  private readonly streamSlotKeys: string[] = Array.from({ length: 25 }, () => "")
  private readonly streamSlotChunks: Chunk[][] = Array.from({ length: 25 }, () => [])

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
    this.temporal?.reset()
    this.resetVolumeHistory()
    const STREAM_SLOT_COUNT = 25
    const isStreamedSlots =
      level.chunks.length > 0 &&
      level.chunks.every((c) => c.streamSlot !== undefined && c.streamKey !== undefined)

    if (isStreamedSlots) {
      // Slots grow (never shrink) to the largest chunk seen, in 768 KB steps (a whole number of vertices), so a dense
      // chunk never forces the whole-level fallback below. Growing re-uploads every slot once.
      const slotBytes = new Array<number>(STREAM_SLOT_COUNT).fill(0)
      for (let i = 0; i < level.chunks.length; i++) {
        const c = level.chunks[i]!
        slotBytes[c.streamSlot!] += c.byteLength ?? c.data.byteLength
      }
      const needed = Math.ceil(Math.max(...slotBytes) / (768 * 1024)) * 768 * 1024
      if (needed > this.streamSlotBytes) {
        this.streamSlotBytes = needed
        this.streamSlotKeys.fill("")
      }
      const STREAM_SLOT_BYTES = this.streamSlotBytes
      const totalCap = STREAM_SLOT_COUNT * STREAM_SLOT_BYTES
      if (!this.level || this.level.cap < totalCap) {
        this.level?.buf.destroy()
        this.level = {
          buf: this.device.createBuffer({ size: totalCap, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST }),
          count: totalCap / VERT_BYTES,
          cap: totalCap,
        }
        this.streamSlotKeys.fill("")
      }
      const bySlot: LevelData["chunks"][] = Array.from({ length: STREAM_SLOT_COUNT }, () => [])
      for (let i = 0; i < level.chunks.length; i++) {
        const c = level.chunks[i]!
        bySlot[c.streamSlot!]!.push(c)
      }
      let slotOverflow = false
      for (let s = 0; s < STREAM_SLOT_COUNT; s++) {
        const list = bySlot[s]!
        if (list.length === 0) continue
        const key = list[0]!.streamKey!
        if (key === this.streamSlotKeys[s]) {
          const sc = this.streamSlotChunks[s]!
          for (let i = 0; i < sc.length && i < list.length; i++) {
            sc[i]!.customCutaway = list[i]!.customCutaway
          }
          continue
        }
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
        for (let s = 0; s < STREAM_SLOT_COUNT; s++) {
          if (bySlot[s]!.length === 0) continue
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
    if (level.geometryOnly && this.floorTex.width === f.w && this.floorTex.height === f.h) {
      return
    }
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

  /** Replaces a registered model's vertices, reusing its buffer when the new mesh fits. */
  setModel(index: number, mesh: Mesh): void {
    this.models[index] = this.upload(mesh.pack(), this.models[index] ?? null)
  }

  updateBounce(data: Uint8Array<ArrayBuffer>, w: number, h: number): void {
    this.device.queue.writeTexture({ texture: this.bounceTex }, data, { bytesPerRow: w * 4 }, [w, h])
  }

  /** Output (canvas) size. The scene renders at `internalWidth` × `internalHeight`, smaller under temporal upscaling. */
  resize(w: number, h: number): void {
    if (w === this.width && h === this.height && this.targets.width) return
    this.width = w
    this.height = h
    this.measureTarget?.destroy()
    this.measureTarget = null
    this.applyInternalSize()
  }

  private applyInternalSize(): void {
    const [iw, ih] = internalSize(this.width, this.height, temporalScale(this.temporalSettings))
    this.internalWidth = iw
    this.internalHeight = ih
    if (this.temporalSettings) {
      this.temporal ??= new TemporalResolve(this.device, HDR, SAMPLES)
      this.temporal.resize(this.width, this.height, iw, ih)
    }
    if (!this.targets.resize(iw, ih)) return
    this.sharedBlurGroups = null
    this.blurReady = false
    this.previousFrame = null
    this.velocity?.destroy()
    this.velocityMSAA?.destroy()
    this.velocity = this.velocityMSAA = null
    this.velocityAttachment = null
    this.smokeRenderer.resize(iw, ih, this.targets.depthView)
    this.bloomSource = null
  }

  /**
   * Opt-in temporal anti-aliasing (`"taa"`) or upscaling (`"taau"`); `null` or `"msaa"` is today's MSAA-only path.
   * Cheap to call every frame: only a change of mode or render scale reallocates.
   */
  setTemporal(settings: TemporalSettings | null): void {
    const next = temporalEnabled(settings) ? { ...settings } : null
    const prev = this.temporalSettings
    this.temporalSettings = next
    if (!next || !prev) this.temporal?.reset()
    if (temporalScale(prev) !== temporalScale(next) || !next !== !prev) {
      if (this.width) this.applyInternalSize()
    }
  }

  /** A pass after the composite (camera filters); null removes it. */
  setFinalPass(pass: FinalPass | null): void {
    this.finalPass = pass
  }

  getTemporal(): TemporalSettings | null {
    return this.temporalSettings ? { ...this.temporalSettings } : null
  }

  /** Drops the temporal history (camera cut or teleport the eye-jump check would miss). */
  resetTemporalHistory(): void {
    this.temporal?.reset()
    this.resetVolumeHistory()
  }

  /** Temporal resolve telemetry, or null when it is off. */
  get temporalState(): TemporalState | null {
    return this.temporalSettings && this.temporal ? this.temporal.state(this.temporalSettings.mode) : null
  }

  /** Points bloom and the composite at the image they should read: the temporal output or the resolved scene. */
  private syncBloomSource(src: GPUTexture, view: GPUTextureView): void {
    if (this.bloomSource === src) return
    this.bloomSource = src
    this.bloomPyramid.resize({ hdr: src, hdrView: view, layout: this.postLayout, sampler: this.sampler, gradeBuffer: this.gradeBuf })
    // Both hold views of the bloom chain just rebuilt.
    this.sharedBlurGroups = null
    this.velocity?.destroy()
    this.velocityMSAA?.destroy()
    this.velocity = this.velocityMSAA = null
    this.velocityAttachment = null
  }

  /** Alpha and additive sprites re-drawn without depth into the temporal reactive mask. */
  private ensureReactivePipe(): GPURenderPipeline {
    if (this.reactivePipe) return this.reactivePipe
    const layout = this.device.createPipelineLayout({ bindGroupLayouts: [this.sceneLayout] })
    this.reactivePipe = this.device.createRenderPipeline({
        label: "temporal reactive sprites",
        layout,
        vertex: { module: this.spriteModule, entryPoint: "vs", buffers: [SPRITE_LAYOUT] },
        fragment: { module: this.spriteModule, entryPoint: "fs", targets: [REACTIVE_TARGET] },
        primitive: { topology: "triangle-list", cullMode: "none" },
      })
    return this.reactivePipe
  }

  /** `reactive` batches re-drawn through the scene's instanced vertex stage, at full coverage, into the reactive mask. */
  private ensureReactiveInstPipe(): GPURenderPipeline {
    if (this.reactiveInstPipe) return this.reactiveInstPipe
    const d = this.device
    this.reactiveInstPipe = d.createRenderPipeline({
      label: "temporal reactive batches",
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.sceneLayout] }),
      vertex: { module: this.sceneModule, entryPoint: "vsInst", buffers: [MESH_LAYOUT, INST_LAYOUT] },
      fragment: { module: d.createShaderModule({ label: "reactive coverage", code: REACTIVE_COVERAGE_WGSL }), entryPoint: "fs", targets: [REACTIVE_TARGET] },
      primitive: { topology: "triangle-list", cullMode: "none" },
    })
    return this.reactiveInstPipe
  }

  setVisibility(data: Uint8Array<ArrayBuffer>, w: number, h: number): void {
    if (this.visibilityTex.width !== w || this.visibilityTex.height !== h) {
      this.visibilityTex.destroy()
      this.visibilityTex = this.device.createTexture({ size: [w, h], format: "r8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST })
      this.makeSceneGroup()
    }
    this.device.queue.writeTexture({ texture: this.visibilityTex }, data, { bytesPerRow: w }, [w, h])
  }

  private ensureMotionPipes(): void {
    if (this.motionPipes.level) return
    const d = this.device
    const premul: GPUBlendState = {
      color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
      alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
    }
    const additive: GPUBlendState = {
      color: { srcFactor: "one", dstFactor: "one" },
      alpha: { srcFactor: "one", dstFactor: "one" },
    }
    const layout = d.createPipelineLayout({ bindGroupLayouts: [this.sceneLayout] })
    const pipe = (
      module: GPUShaderModule,
      vs: string,
      buffers: GPUVertexBufferLayout[],
      blend?: GPUBlendState,
      depthWrite = true,
      cullMode: GPUCullMode = "back",
      fs = "fs",
    ) =>
      d.createRenderPipeline({
        layout,
        vertex: { module, entryPoint: vs, buffers },
        fragment: {
          module,
          entryPoint: fs,
          targets: [{ format: HDR, blend }, { format: HDR, blend: blend ? premul : undefined }],
        },
        primitive: { topology: "triangle-list", cullMode },
        depthStencil: { format: DEPTH, depthWriteEnabled: depthWrite, depthCompare: "less-equal" },
        multisample: { count: SAMPLES },
      })
    const moving = this.module(sceneShader(true, true), "scene motion")
    const movingSprite = this.module(spriteShader(true), "sprite motion")
    const oldLayout: GPUVertexBufferLayout = {
      ...INST_LAYOUT,
      attributes: [...INST_LAYOUT.attributes].map((a) => ({ ...a, shaderLocation: a.shaderLocation + 3 })),
    }
    const oldSprite: GPUVertexBufferLayout = {
      arrayStride: SPRITE_FLOATS * 4,
      stepMode: "instance",
      attributes: [{ shaderLocation: 3, offset: 0, format: "float32x4" }],
    }
    this.motionPipes.level = pipe(moving, "vsStatic", [MESH_LAYOUT], undefined, true, "none", "fsSolid")
    this.motionPipes.levelCut = pipe(moving, "vsStatic", [MESH_LAYOUT], undefined, true, "none", "fs")
    this.motionPipes.glass = pipe(moving, "vsStatic", [MESH_LAYOUT], premul, false, "none", "fs")
    this.motionPipes.inst = pipe(moving, "vsInst", [MESH_LAYOUT, INST_LAYOUT, oldLayout], undefined, true, "none", "fs")
    this.motionPipes.instAlpha = pipe(moving, "vsInst", [MESH_LAYOUT, INST_LAYOUT, oldLayout], premul, false, "none", "fs")
    this.motionPipes.spriteAlpha = pipe(movingSprite, "vs", [SPRITE_LAYOUT, oldSprite], premul, false, "none", "fs")
    this.motionPipes.spriteAdd = pipe(movingSprite, "vs", [SPRITE_LAYOUT, oldSprite], additive, false, "none", "fs")
    const motionPost = this.module(postShader(true, true), "post motion")
    this.motionPipes.composite = d.createRenderPipeline({
      layout: d.createPipelineLayout({ bindGroupLayouts: [this.motionPostLayout] }),
      vertex: { module: motionPost, entryPoint: "vs" },
      fragment: { module: motionPost, entryPoint: "composite", targets: [{ format: this.format }] },
    })
  }

  private prepareMotion(): void {
    this.ensureMotionPipes()
    if (this.velocity) return
    const d = this.device, size = [this.targets.width, this.targets.height]
    this.velocity = d.createTexture({ size, format: HDR, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING })
    this.velocityMSAA = d.createTexture({ size, format: HDR, sampleCount: SAMPLES, usage: GPUTextureUsage.RENDER_ATTACHMENT })
    this.velocityView = this.velocity.createView()
    this.velocityMSAAView = this.velocityMSAA.createView()
    this.velocityAttachment = {
      view: this.velocityMSAAView,
      resolveTarget: this.velocityView,
      clearValue: { r: 0, g: 0, b: 1000, a: 1 },
      loadOp: "clear",
      storeOp: "discard",
    }
    this.motionComposite = d.createBindGroup({ layout: this.motionPostLayout, entries: [
      { binding: 0, resource: this.targets.hdrView }, { binding: 1, resource: this.sampler },
      { binding: 2, resource: { buffer: this.bloomPyramid.downParams[0]! } },
      { binding: 3, resource: this.bloomPyramid.views[0]! },
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
    const pipes: Record<string, GPURenderPipeline> = {
      level: pipe("vsStatic", [MESH_LAYOUT], undefined, true, "fsSolid"),
      levelCut: pipe("vsStatic", [MESH_LAYOUT], undefined, true, "fs"),
      glass: pipe("vsStatic", [MESH_LAYOUT], premul, false, this.shaders ? "fsSolid" : "fs"),
      inst: pipe("vsInst", [MESH_LAYOUT, INST_LAYOUT], undefined, true, this.shaders ? "fsSolid" : "fs"),
      instAlpha: pipe("vsInst", [MESH_LAYOUT, INST_LAYOUT], premul, false, "fs"),
    }
    // Only the composite a frame draws with is compiled (most looks never use the full one).
    this.lookCompositeBuilders.set(variant, (fs) =>
      d.createRenderPipeline({
        layout: postPipeLayout,
        vertex: { module: lookPostMod, entryPoint: "vs" },
        fragment: { module: lookPostMod, entryPoint: fs, targets: [{ format: this.format }] },
        primitive: { topology: "triangle-list" },
      }),
    )
    this.lookPipesByVariant.set(variant, pipes)
    return pipes
  }

  private lookComposite(variant: LookVariantMode, fs: "composite" | "compositeFast"): GPURenderPipeline {
    const pipes = this.ensureLookPipes(variant)
    return (pipes[fs] ??= this.lookCompositeBuilders.get(variant)!(fs))
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

  setBloomLevels(levels: number): void {
    this.bloomLevels = Math.max(1, Math.min(BLOOM_LEVELS, Math.round(levels)))
  }

  private flushPending(): void {
    const f = this.pending
    if (!f || this.inflight >= 1) return
    this.pending = null
    const submitAt = performance.now()
    this.draw(f)
    this.inflight++
    void this.device.queue.onSubmittedWorkDone().then(() => {
      const gpuMs = Math.max(0, performance.now() - submitAt)
      this.lastGpuMs = gpuMs
      this.emaGpuMs = this.emaGpuMs > 0 ? this.emaGpuMs + (gpuMs - this.emaGpuMs) * 0.2 : gpuMs
      this.inflight--
      if (this.pending) this.schedule()
      this.onIdle?.()
      this.notifyPacer()
    })
  }

  /**
   * Draws one frame. Under temporal AA the game's view-projection and screen size are swapped, for this frame only, for
   * the jittered matrix and the internal size, so every pass that reads the frame (scene, sprites, splatter, particles,
   * skids, volume) renders jittered at the internal size; the game's array is restored afterwards.
   */
  private draw(f: FrameInput, targetView?: GPUTextureView): void {
    const s = this.temporalSettings
    const motion = !this.shaders && !!(f.frame[45]! & 1024)
    const taa = s && this.temporal && !motion ? this.temporal : null
    if (!taa || !s) return this.encodeFrame(f, targetView, null)
    const fr = f.frame
    this.unjittered.set(fr.subarray(0, 22))
    // The reactive mask is cleared and drawn every temporal frame, so the resolve always reads it.
    const [jx, jy] = taa.begin(fr, s, true)
    jitterViewProj(fr, jx, jy, this.internalWidth, this.internalHeight)
    fr[20] = this.internalWidth
    fr[21] = this.internalHeight
    try {
      this.encodeFrame(f, targetView, taa)
    } finally {
      fr.set(this.unjittered, 0)
    }
  }

  private encodeFrame(f: FrameInput, targetView: GPUTextureView | undefined, taa: TemporalResolve | null): void {
    const d = this.device
    const motion = !this.shaders && !!(f.frame[45]! & 1024)
    if (taa) this.syncBloomSource(taa.output, taa.outputView)
    else this.syncBloomSource(this.targets.hdr, this.targets.hdrView)
    const effectiveLook = f.look !== undefined ? f.look : this.activeLook
    const effectiveCompare = f.lookCompare ?? this.activeLookCompare
    const hasPostParams = Boolean(f.postParams && f.postParams[0] > 0.5)
    const useLookPipes = !motion && Boolean(effectiveLook) && (!isIdentityLook(effectiveLook) || effectiveCompare.mode === 2 || hasPostParams)
    if (f.skids) {
      this.skidRenderer ??= new SkidRenderer(d, f.skids.capacity, { depthFormat: DEPTH, depthCompare: DEPTH_CFG.compare, samples: SAMPLES, color: HDR })
      this.skidRenderer.prepare(f.skids, f.frame, f.skidsVisible ?? true)
    }
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
      const fl = f.fxLighting
      this.particleRenderer.setFrame({
        vp: f.frame,
        eye: [f.frame[16]!, f.frame[17]!, f.frame[18]!],
        debug: 0,
        ambient: fl?.ambient ?? [Math.max(0.18, f.frame[28]!), Math.max(0.2, f.frame[29]!), Math.max(0.24, f.frame[30]!)],
        lights: fl?.lights ?? f.lights,
        lightCount: fl?.lights ? (fl.lightCount ?? 0) : f.lightCount,
        lightStride: LIGHT_FLOATS,
        spotCones: fl?.spotCones,
      })
      this.particleRenderer.upload(f.fxParticles)
    }
    if (f.weather) {
      this.weatherRenderer ??= new WeatherRenderer(d, HDR, DEPTH, SAMPLES)
      // Under temporal AA rain takes the frame's jittered camera and internal size, like every pass in the scene.
      if (taa) {
        const c = this.weatherCamera
        c.viewProj = f.frame
        c.width = this.internalWidth
        c.height = this.internalHeight
      }
      this.weatherRenderer.prepare(f.weather, taa ? this.weatherCamera : undefined)
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
          ? this.ensureScenePipes()
          : this.ensureBaselinePipes()
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
    const lg = f.lampGrid
    const useLampGrid = !!lg && lg.directLightCount < lg.lightCount
    if (useLampGrid) {
      if (this.lampGridTex.width !== lg.width || this.lampGridTex.height !== lg.height) {
        this.lampGridTex.destroy()
        this.lampGridTex = d.createTexture({
          size: [lg.width, lg.height],
          format: "rgba8uint",
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        })
        lg.markAllDirty()
        this.makeSceneGroup()
      }
      if (lg.dirtyRows) {
        const { minRow, rowCount } = lg.dirtyRows
        const rowBytes = lg.width * 4
        d.queue.writeTexture(
          { texture: this.lampGridTex, origin: [0, minRow, 0] },
          lg.data,
          { offset: minRow * rowBytes, bytesPerRow: rowBytes, rowsPerImage: rowCount },
          [lg.width, rowCount, 1],
        )
        lg.markUploaded()
      }
    }
    const prevFocusW = f.frame[35]!
    if (useLampGrid) f.frame[35] = -(lg.directLightCount + 1)
    d.queue.writeBuffer(this.frameBuf, 0, f.frame)
    if (useLampGrid) f.frame[35] = prevFocusW
    if (f.lightCount) d.queue.writeBuffer(this.lightBuf, 0, f.lights.buffer, f.lights.byteOffset, f.lightCount * LIGHT_FLOATS * 4)
    if (f.occluderCount) d.queue.writeBuffer(this.occBuf, 0, f.occluders.buffer, f.occluders.byteOffset, Math.min(f.occluderCount, MAX_OCCLUDERS) * OCC_FLOATS * 4)
    if (f.fog) {
      d.queue.writeBuffer(this.fogBuf, 0, f.fog.uniforms)
      if (f.fog.lampCount) d.queue.writeBuffer(this.fogLampBuf, 0, f.fog.lamps.buffer, f.fog.lamps.byteOffset, Math.min(f.fog.lampCount, MAX_FOG_LAMPS) * FOG_LAMP_FLOATS * 4)
      if (f.fog.glow && f.fog.glowVersion !== undefined && f.fog.glowVersion !== this.fogGlowVersion) {
        this.fogGlowVersion = f.fog.glowVersion
        d.queue.writeBuffer(this.fogLampBuf, FOG_GLOW_OFFSET * 4, f.fog.glow.buffer, f.fog.glow.byteOffset, FOG_GLOW_FLOATS * 4)
      }
    }
    if (f.lampCount) d.queue.writeBuffer(this.lampBuf, 0, f.lampPower.buffer, f.lampPower.byteOffset, Math.min(f.lampCount, MAX_MAP_LIGHTS) * 4)
    this.gradeData.set(f.grade)
    this.gradeData.fill(0,POST_CUSTOM_OFFSET)
    if(f.postCustom)this.gradeData.set(f.postCustom,POST_CUSTOM_OFFSET)
    if (useLookPipes && effectiveLook) {
      this.gradeData[4] = f.postExtra ?? 0
      this.gradeData[5] = f.postParams?.[0] ?? 0
      this.gradeData[6] = f.postParams?.[1] ?? 0
      this.gradeData[7] = f.postParams?.[2] ?? 0
      packLookUniforms(effectiveLook, this.gradeData, 8, {
        compareMode: effectiveCompare.mode ?? 1,
        wipeSplit: effectiveCompare.wipeSplit ?? 0.5,
      })
      d.queue.writeBuffer(this.gradeBuf, 0, this.gradeData)
    } else {
      this.gradeData[4] = f.frame[45]! & 1
      this.gradeData[5] = f.postParams?.[0] ?? 0
      this.gradeData[6] = f.postParams?.[1] ?? 0
      this.gradeData[7] = f.postParams?.[2] ?? 0
      d.queue.writeBuffer(this.gradeBuf, 0, this.gradeData)
    }

    const mb = f.motionBlur
    const frameTime = f.frame[19]!
    const rawBlurDt = mb?.dt ?? (this.blurLastTime >= 0 ? frameTime - this.blurLastTime : 1 / 60)
    const blurDt = Math.max(1 / 240, rawBlurDt > 0 && rawBlurDt < 0.25 ? rawBlurDt : 1 / 60)
    const eyeMove = this.blurReady
      ? Math.hypot(
          f.frame[16]! - this.blurLastEye[0]!,
          f.frame[17]! - this.blurLastEye[1]!,
          f.frame[18]! - this.blurLastEye[2]!,
        )
      : 0
    const blurValid = this.blurReady && eyeMove < 8
    this.blurPrevVP.set(blurValid ? this.blurLastVP : f.frame.subarray(0, 16))
    this.blurLastVP.set(f.frame.subarray(0, 16))
    this.blurLastEye[0] = f.frame[16]!
    this.blurLastEye[1] = f.frame[17]!
    this.blurLastEye[2] = f.frame[18]!
    this.blurLastTime = frameTime
    this.blurReady = true
    const mbContinuous = Boolean(mb?.settings.enabled && mb.settings.strength > 0.001 && mb.settings.shutter > 0.001)
    const mbBurst = Boolean(mb?.settings.enabled && mb.settings.burst > 0.001 && mb.burst?.active)
    const runSharedBlur = !motion && (mbContinuous || mbBurst)

    let total = 0
    for (let i = 0; i < f.batches.length; i++) total += f.batches[i]!.count
    if (motion && total * INST_FLOATS > this.previousData.length) {
      this.previousData = new Float32Array(total * INST_FLOATS * 2)
      this.previousInst.destroy()
      this.previousInst = d.createBuffer({ size: this.previousData.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    }
    this.inst.ensureCapacity(total)
    const ranges = this.drawRanges
    let rangeCount = 0
    let off = 0
    for (let bIdx = 0; bIdx < f.batches.length; bIdx++) {
      const b = f.batches[bIdx]!
      if (!b.count) continue
      const existing = ranges[rangeCount]
      if (existing) {
        existing.model = b.model
        existing.first = off
        existing.count = b.count
        existing.alpha = !!b.alpha
        existing.reactive = !!b.reactive
      } else {
        ranges.push({ model: b.model, first: off, count: b.count, alpha: !!b.alpha, reactive: !!b.reactive })
      }
      rangeCount++
      if (motion) for (let i = 0; i < b.count; i++) this.history.write(this.previousData, (off + i) * INST_FLOATS, b.data, i * INST_FLOATS, b.motionKeys?.[i])
      off += b.count
    }
    this.inst.uploadBatches(f.batches)
    if (motion && off) d.queue.writeBuffer(this.previousInst, 0, this.previousData.buffer, 0, off * INST_FLOATS * 4)
    const {
      alphaCount,
      addCount,
      addByteOffset: addOffset,
      halfCap: half,
    } = uploadSplitSprites(
      d,
      this.sprites,
      MAX_SPRITES,
      SPRITE_FLOATS,
      f.alphaSprites,
      f.alphaCount,
      f.addSprites,
      f.addCount,
    )
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
    this.passes.prepareAll(enc)
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
    // The frame timer starts at the first pass: the polar pass, else the bounce, else the main pass.
    let timerStarted = !!f.shadowLightCount
    if (!this.planBounce && this.planBounceShader && f.planBounce && f.planBounce.strength > 0 && f.lightCount > 0) {
      this.planBounce = new PlanBounce(d, { frame: this.frameBuf, lights: this.lightBuf, polar: this.polarBuf, compile: (code, label) => this.module(code, label) }, this.planBounceShader)
    }
    if (this.planBounce) {
      const start = this.timing && !timerStarted ? this.timer!.start : undefined
      if (this.planBounce.encode(enc, f.planBounce, f.occluders, Math.min(f.occluderCount, MAX_OCCLUDERS), Math.min(f.lightCount, MAX_LIGHTS), Math.min(f.shadowLightCount, SLOTS), start)) timerStarted = true
      if (this.planBounce.version !== this.planBounceVersion) {
        this.planBounceVersion = this.planBounce.version
        this.makeSceneGroup()
      }
    }

    const hasSmoke = !!(f.smoke && f.smokeEnabled && f.smoke.count)
    const pass = enc.beginRenderPass(
      this.targets.configureMainPass({
        storeDepth: hasSmoke || runSharedBlur || !!taa || this.volumeNeedsDepth(f) || !!(f.fogBlur && f.fog),
        timestampWrites: this.timing && !timerStarted ? this.timer!.start : undefined,
        extraColorAttachment: motion ? this.velocityAttachment : null,
      }),
    )
    pass.setBindGroup(0, this.sceneGroup)
    this.passes.drawSlot("sky", pass)
    if (this.level?.count) {
      pass.setPipeline(scenePipes.level!)
      pass.setVertexBuffer(0, this.level.buf)
      const levelStats = drawContiguousChunksByMode(
        pass,
        this.chunks,
        (c) => {
          if (!boxIntersectsRect2D(c.box, f.view)) return null
          const isFade = c.customCutaway === "fade"
          const insideCustom = c.customCutaway && !isFade ? intersectsCutaway(c.cutBox, f.frame, true) : false
          const peeking = f.frame[26]! > 1.001
          if (c.customCutaway === "outside" && insideCustom && !peeking) return null
          return isFade ? true : c.customCutaway ? insideCustom && peeking : intersectsCutaway(c.cutBox, f.frame)
        },
        (cut) => pass.setPipeline(cut ? scenePipes.levelCut! : scenePipes.level!),
        false,
      )
      this.drawnChunks = levelStats.chunksDrawn
      this.drawnChunkDraws = levelStats.drawCalls
    }
    pass.setVertexBuffer(1, this.inst.buf)
    if (motion) pass.setVertexBuffer(2, this.previousInst)
    for (const alpha of [false, true]) {
      pass.setPipeline(alpha ? scenePipes.instAlpha! : scenePipes.inst!)
      for (let rIdx = 0; rIdx < rangeCount; rIdx++) {
        const r = ranges[rIdx]!
        if (r.alpha !== alpha) continue
        const m = this.models[r.model]!
        pass.setVertexBuffer(0, m.buf)
        pass.draw(m.count, r.count, 0, r.first)
      }
      if (!alpha) {
        if (f.skids) this.skidRenderer!.draw(pass, motion)
        this.passes.drawSlot("opaque", pass)
        pass.setBindGroup(0, this.sceneGroup)
      }
      if (!alpha && this.glass?.count) {
        pass.setPipeline(scenePipes.glass!)
        pass.setVertexBuffer(0, this.glass.buf)
        drawContiguousChunks(pass, this.glassChunks, (c) => boxIntersectsRect2D(c.box, f.view))
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
    if(f.fxParticles&&f.fxParticles.count>0)this.particleRenderer!.draw(pass,motion,Boolean(f.fxLighting?.keepColour))
    if(f.weather)this.weatherRenderer!.draw(pass,motion)
    if (this.passes.count("alpha")) {
      // Splatter, particles and weather bind their own groups; alpha plugins get the scene's back.
      pass.setBindGroup(0, this.sceneGroup)
      this.passes.drawSlot("alpha", pass)
    }
    pass.end()

    if (taa) {
      // Everything that moves on its own redraws into the reactive mask: sprites, tyre smoke, reactive batches,
      // splatter drops, kit particles, rain and the alpha plugins (`@arcade/kit/gpu/reactive`).
      const rp = enc.beginRenderPass({
        label: "temporal reactive",
        colorAttachments: [{ view: taa.reactiveView, loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 0] }],
      })
      rp.setBindGroup(0, this.sceneGroup)
      if (alphaCount || addCount) {
        rp.setPipeline(this.ensureReactivePipe())
        if (alphaCount) {
          rp.setVertexBuffer(0, this.sprites, 0)
          rp.draw(6, alphaCount)
        }
        if (addCount) {
          rp.setVertexBuffer(0, this.sprites, addOffset)
          rp.draw(6, addCount)
        }
      }
      this.vehicleSmoke.drawReactive(rp)
      let instPipe = false
      for (let rIdx = 0; rIdx < rangeCount; rIdx++) {
        const r = ranges[rIdx]!
        if (!r.reactive) continue
        if (!instPipe) {
          rp.setPipeline(this.ensureReactiveInstPipe())
          rp.setVertexBuffer(1, this.inst.buf)
          instPipe = true
        }
        const m = this.models[r.model]!
        rp.setVertexBuffer(0, m.buf)
        rp.draw(m.count, r.count, 0, r.first)
      }
      if (f.splatter) this.splatterRenderer!.drawReactive(rp)
      if (f.fxParticles && f.fxParticles.count > 0) this.particleRenderer!.drawReactive(rp)
      if (f.weather) this.weatherRenderer!.drawReactive(rp)
      if (this.passes.count("alpha")) {
        rp.setBindGroup(0, this.sceneGroup)
        this.passes.drawReactiveSlot("alpha", rp)
      }
      rp.end()
    }

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
      this.smokeRenderer.render(enc, this.targets.hdrView, f.smoke)
    }

    if (this.volumes.length && !taa) this.drawVolumes(enc, f, f.frame, [f.frame[16]!, f.frame[17]!, f.frame[18]!], this.targets.hdrView, this.targets.width, this.targets.height)
    if (!taa) this.drawFogBlur(enc, f, f.frame, this.targets.hdrView, this.targets.width, this.targets.height)

    let activeDown0: GPUBindGroup | undefined
    let activeComposite = this.bloomPyramid.compositeGroup
    if (runSharedBlur && mb) {
      this.sharedBlur ??= new MotionBlur(d, HDR, true)
      const tw = this.targets.width, th = this.targets.height
      if (!this.sharedBlurGroups || this.sharedBlurGroups.w !== tw || this.sharedBlurGroups.h !== th) {
        this.sharedBlur.resize(tw, th, this.targets.hdrView, this.targets.depthView)
        const down0Param = this.bloomPyramid.downParams[0]!
        this.sharedBlurGroups = {
          down0: this.bloomPyramid.makeBindGroup(
            this.postLayout,
            this.sampler,
            this.sharedBlur.output,
            down0Param,
            this.sharedBlur.output,
            this.gradeBuf,
          ),
          composite: this.bloomPyramid.makeBindGroup(
            this.postLayout,
            this.sampler,
            this.sharedBlur.output,
            down0Param,
            this.bloomPyramid.views[0]!,
            this.gradeBuf,
          ),
          w: tw,
          h: th,
        }
      }
      const curVP = f.frame.subarray(0, 16)
      mat4.inverse(curVP, this.blurInverseVP)
      if (mb.burst) {
        this.sharedBlur.burst.dx = mb.burst.dx
        this.sharedBlur.burst.dy = mb.burst.dy
        this.sharedBlur.burst.radial = mb.burst.radial
        this.sharedBlur.burst.shutterBoost = mb.burst.shutterBoost
      } else {
        this.sharedBlur.burst.reset()
      }
      this.sharedBlur.update(
        curVP,
        this.blurInverseVP,
        this.blurPrevVP,
        blurDt,
        mb.settings.strength,
        mb.settings.shutter,
        blurValid,
        32,
        mb.settings.burst,
      )
      this.sharedBlur.encode(enc)
      if (!taa) {
        activeDown0 = this.sharedBlurGroups.down0
        activeComposite = this.sharedBlurGroups.composite
      }
    }
    if (taa) {
      // Blur (when on) runs on the internal image first; the beam is added after the resolve, never into the history.
      taa.encode(enc, runSharedBlur ? this.sharedBlur!.output : this.targets.hdrView, this.targets.depthView, this.temporalSettings!.sharpen > 0.001)
      if (this.volumes.length) this.drawVolumes(enc, f, this.unjittered, [f.frame[16]!, f.frame[17]!, f.frame[18]!], taa.outputView, this.width, this.height)
      this.drawFogBlur(enc, f, this.unjittered, taa.outputView, this.width, this.height)
    }
    this.bloomPyramid.encode(enc, this.pipes.down!, this.pipes.up!, activeDown0, this.bloomLevels)
    const finalPass = this.finalPass?.active ? this.finalPass : null
    const dest = this.timing ? this.measureView : (targetView ?? this.context.getCurrentTexture().createView())
    const output = finalPass ? finalPass.source(this.width, this.height) : dest
    const fp = enc.beginRenderPass({ colorAttachments: [{ view: output, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }] })
    const useFastLookPost =
      useLookPipes &&
      effectiveLook &&
      (effectiveCompare.mode ?? 1) === 1 &&
      effectiveLook.painterlySmooth <= 0.01 &&
      effectiveLook.outlineStrength <= 0.001
    fp.setPipeline(
      motion
        ? this.motionPipes.composite!
        : useLookPipes
          ? this.lookComposite(lookVariant, useFastLookPost ? "compositeFast" : "composite")
          : this.composite(!(f.frame[45]! & 1)),
    )
    fp.setBindGroup(0, motion ? this.motionComposite : activeComposite)
    fp.draw(3)
    fp.end()
    if (finalPass) finalPass.encode(enc, dest, taa ? this.unjittered : f.frame)
    if(this.timing) this.timer!.finish(enc,dest)
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
