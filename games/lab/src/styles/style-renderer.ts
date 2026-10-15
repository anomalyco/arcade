import { mat4, vec4 } from "wgpu-matrix"
import { Camera } from "@arcade/kit/client/camera"
import { FrameTimer } from "@arcade/kit/fx/frame-timer"
import { LIGHT_FLOATS, MAX_LIGHTS, MAX_OCCLUDERS, OCC_FLOATS } from "@arcade/kit/limits"
import { FLOATS_PER_VERT, packVerts, VERT_BYTES, type Mesh } from "@arcade/kit/gpu/mesh"
import { INST_FLOATS, Renderer, type Batch, type FrameInput } from "@arcade/kit/gpu/renderer"
import { FRAME_FLOATS } from "@arcade/kit/gpu/shaders"
import { applyLookPreset, createLookSettings, type LookSettings } from "@arcade/kit/look"
import { MATERIAL_RECIPES, packMaterialParams } from "@arcade/kit/gpu/surface-materials"
import { dayCycle } from "../../../outbreak/shared/day-cycle"
import { flashlightColor } from "../../../outbreak/shared/flashlight"
import { propShape, sightRects, SIZE } from "../../../outbreak/shared/map"
import { SceneryMemory } from "../../../outbreak/shared/scenery-memory"
import { supportHeight } from "../../../outbreak/shared/terrain"
import { FOG_SIZE } from "../../../outbreak/shared/vision"
import {
  VIGNETTE_DIRECTIONS,
  VIGNETTE_SURFACES,
  VIGNETTE_SURFACE_IDS,
  buildVignetteLevel,
  kelvinToRgb,
} from "../../../outbreak/src/vignette/presets"
import { vignetteShaders } from "../../../outbreak/src/vignette/shaders"
import { STYLE_MODULES, STYLE_UNIFORM_FLOATS, buildStylePostShaderWgsl } from "./index"
import { StyleMinimalPeople, type StyledBatch } from "./minimal-people"
import type { StylePlaygroundSim } from "./sim-loop"
import type { PeopleStyleId, StyleCameraViewId, StyleId, StyleRecipe } from "./types"

const auxGbufferWgsl = /* wgsl */ `
struct AuxFrame {
  viewProj: mat4x4f,
  eye: vec4f,
}
@group(0) @binding(0) var<uniform> AF: AuxFrame;

struct VIn {
  @location(0) pos: vec3f,
  @location(1) normal: vec4f,
  @location(2) color: vec4f,
  @location(3) matAux: vec2f,
}

struct Inst {
  @location(5) posYaw: vec4f,
  @location(6) tint: vec4f,
  @location(7) extra: vec4f,
}

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) @interpolate(flat) mat: f32,
  @location(3) @interpolate(flat) role: f32,
  @location(4) @interpolate(flat) flash: f32,
}

struct FragOut {
  @location(0) normalDepth: vec4f,
  @location(1) aux: vec4f,
}

@vertex fn vsStatic(v: VIn) -> VOut {
  var o: VOut;
  o.world = v.pos;
  o.pos = AF.viewProj * vec4f(v.pos, 1.0);
  o.normal = v.normal.xyz;
  o.mat = v.matAux.x;
  o.role = 0.0;
  o.flash = 0.0;
  return o;
}

fn partRotate(p: vec3f, inst: Inst) -> vec3f {
  let cp = cos(inst.extra.x);
  let sp = sin(inst.extra.x);
  var q = vec3f(p.x * cp - p.y * sp, p.x * sp + p.y * cp, p.z);
  let cr = cos(inst.extra.y);
  let sr = sin(inst.extra.y);
  q = vec3f(q.x, q.y * cr - q.z * sr, q.y * sr + q.z * cr);
  let c = cos(inst.posYaw.w);
  let s = sin(inst.posYaw.w);
  return vec3f(q.x * c - q.z * s, q.y, q.x * s + q.z * c);
}

@vertex fn vsInst(v: VIn, inst: Inst) -> VOut {
  var o: VOut;
  o.world = partRotate(v.pos * inst.tint.w, inst) + inst.posYaw.xyz;
  o.pos = AF.viewProj * vec4f(o.world, 1.0);
  o.normal = partRotate(v.normal.xyz, inst);
  o.mat = v.matAux.x;
  o.role = inst.tint.x;
  o.flash = inst.extra.w;
  return o;
}

@fragment fn fsAux(o: VOut) -> FragOut {
  let n = normalize(o.normal);
  let dist = length(o.world - AF.eye.xyz);
  var out: FragOut;
  out.normalDepth = vec4f(n * 0.5 + 0.5, dist);
  out.aux = vec4f(clamp(o.mat / 32.0, 0.0, 1.0), o.role, clamp(o.flash, 0.0, 1.0), 1.0);
  return out;
}
`

export const STYLE_CAMERA_PRESETS: Record<
  StyleCameraViewId,
  { focus: [number, number, number]; pitch: number; dist: number; label: string }
> = {
  room: {
    label: "Room cutaway (Target)",
    focus: [29.45, 0.2, 30.55],
    pitch: 1.1,
    dist: 26.2,
  },
  action: {
    label: "Action close-up",
    focus: [28.9, 0.35, 32.2],
    pitch: 1.04,
    dist: 16.5,
  },
  wide: {
    label: "Wide lot cutaway",
    focus: [28.8, 0.3, 33.8],
    pitch: 1.1,
    dist: 32.0,
  },
}

function projectWorldToUv(viewProj: Float32Array, x: number, y: number, z: number): [number, number] {
  const cx = viewProj[0]! * x + viewProj[4]! * y + viewProj[8]! * z + viewProj[12]!
  const cy = viewProj[1]! * x + viewProj[5]! * y + viewProj[9]! * z + viewProj[13]!
  const cw = viewProj[3]! * x + viewProj[7]! * y + viewProj[11]! * z + viewProj[15]!
  if (cw <= 0.001) return [0.5, 0.5]
  return [Math.max(0, Math.min(1, (cx / cw + 1) * 0.5)), Math.max(0, Math.min(1, (1 - cy / cw) * 0.5))]
}

export class StylePlaygroundRenderer {
  readonly renderer: Renderer
  readonly people: StyleMinimalPeople
  readonly cam = new Camera()
  private readonly scenery = new SceneryMemory()
  private readonly lookSettings: LookSettings
  private readonly frame = new Float32Array(FRAME_FLOATS)
  private readonly lights = new Float32Array(MAX_LIGHTS * LIGHT_FLOATS)
  private readonly occluders = new Float32Array(MAX_OCCLUDERS * OCC_FLOATS)
  private readonly lampPower = new Float32Array(MAX_LIGHTS)
  private readonly empty = new Float32Array(0)
  private readonly vignetteUniforms = new Float32Array(128)
  private readonly styleUniformData = new Float32Array(STYLE_UNIFORM_FLOATS)
  private readonly auxFrameData = new Float32Array(20)

  private readonly modelBuffers: { buf: GPUBuffer; count: number }[] = []
  private auxStaticBuf: GPUBuffer | null = null
  private auxStaticCount = 0
  private readonly auxInstBuf: GPUBuffer
  private readonly auxInstScratch = new Float32Array(512 * INST_FLOATS)
  private readonly auxFrameBuf: GPUBuffer
  private readonly auxBindGroup: GPUBindGroup
  private readonly auxStaticPipe: GPURenderPipeline
  private readonly auxInstPipe: GPURenderPipeline

  private readonly styleUniformBuf: GPUBuffer
  private readonly styleBindLayout: GPUBindGroupLayout
  private readonly stylePipeline: GPURenderPipeline
  private readonly linearSampler: GPUSampler
  private readonly styleTimer: FrameTimer | null

  private sceneTex: GPUTexture | null = null
  private sceneTexView: GPUTextureView | null = null
  private normalDepthTex: GPUTexture | null = null
  private normalDepthView: GPUTextureView | null = null
  private auxTex: GPUTexture | null = null
  private auxView: GPUTextureView | null = null
  private auxDepthTex: GPUTexture | null = null
  private auxDepthView: GPUTextureView | null = null
  private styleBindGroup: GPUBindGroup | null = null

  private texW = 0
  private texH = 0
  private builtSeed = -1
  private lightOccluders = 0
  private cachedSceneSignature = ""
  private timerBusy = false
  lastStyleGpuMs: number | null = null
  readonly perStyleGpuMs = new Map<StyleId, number>()

  constructor(
    private readonly device: GPUDevice,
    private readonly format: GPUTextureFormat,
  ) {
    const dummyCanvas = document.createElement("canvas")
    dummyCanvas.width = 16
    dummyCanvas.height = 16
    const dummyCtx = dummyCanvas.getContext("webgpu")!
    dummyCtx.configure({ device, format, alphaMode: "opaque" })

    this.renderer = new Renderer(device, dummyCtx, format, vignetteShaders)
    // Intercept addModel so our auxiliary normal/depth/role pass shares exact model vertex buffers
    const origAddModel = this.renderer.addModel.bind(this.renderer)
    this.renderer.addModel = (mesh: Mesh): number => {
      const id = origAddModel(mesh)
      const packed = packVerts(mesh.v)
      const buf = device.createBuffer({
        size: Math.max(24, packed.byteLength),
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      })
      device.queue.writeBuffer(buf, 0, packed)
      this.modelBuffers[id] = { buf, count: mesh.v.length / FLOATS_PER_VERT }
      return id
    }

    this.people = new StyleMinimalPeople(this.renderer)
    this.lookSettings = createLookSettings("current")
    applyLookPreset(this.lookSettings, "current")
    this.packDefaultVignetteSurfaces()

    // Auxiliary MRT pass setup
    this.auxFrameBuf = device.createBuffer({
      size: 80,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    this.auxInstBuf = device.createBuffer({
      size: this.auxInstScratch.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    })
    const auxLayout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }],
    })
    this.auxBindGroup = device.createBindGroup({
      layout: auxLayout,
      entries: [{ binding: 0, resource: { buffer: this.auxFrameBuf } }],
    })
    const auxMod = device.createShaderModule({ code: auxGbufferWgsl, label: "Style playground aux MRT" })
    const vLayout: GPUVertexBufferLayout = {
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
    const targets: GPUColorTargetState[] = [{ format: "rgba16float" }, { format: "rgba8unorm" }]
    const pipeLayout = device.createPipelineLayout({ bindGroupLayouts: [auxLayout] })
    this.auxStaticPipe = device.createRenderPipeline({
      layout: pipeLayout,
      vertex: { module: auxMod, entryPoint: "vsStatic", buffers: [vLayout] },
      fragment: { module: auxMod, entryPoint: "fsAux", targets },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less-equal" },
    })
    this.auxInstPipe = device.createRenderPipeline({
      layout: pipeLayout,
      vertex: { module: auxMod, entryPoint: "vsInst", buffers: [vLayout, instLayout] },
      fragment: { module: auxMod, entryPoint: "fsAux", targets },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less-equal" },
    })

    // Style presentation fullscreen pipeline
    this.styleUniformBuf = device.createBuffer({
      size: STYLE_UNIFORM_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    this.linearSampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    })
    this.styleBindLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      ],
    })
    const styleMod = device.createShaderModule({
      code: buildStylePostShaderWgsl(),
      label: "Style playground 9-style presentation",
    })
    this.stylePipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.styleBindLayout] }),
      vertex: { module: styleMod, entryPoint: "vs" },
      fragment: { module: styleMod, entryPoint: "fsStyle", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
    })
    this.styleTimer = device.features.has("timestamp-query") ? new FrameTimer(device) : null
  }

  private packDefaultVignetteSurfaces(): void {
    const dir = VIGNETTE_DIRECTIONS[3] // Noir lighting & surface balance matching ref-outbreak-room.png
    this.vignetteUniforms.fill(0)
    const getSurf = (id: (typeof VIGNETTE_SURFACE_IDS)[number]) => ({
      ...VIGNETTE_SURFACES[id].defaults,
      ...(dir.surfaces[id] ?? {}),
    })
    packMaterialParams(getSurf("wood_floor"), this.vignetteUniforms, 0 * 12)
    packMaterialParams(MATERIAL_RECIPES.cobblestone.defaults, this.vignetteUniforms, 1 * 12)
    packMaterialParams(getSurf("plaster"), this.vignetteUniforms, 2 * 12)
    packMaterialParams(getSurf("asphalt"), this.vignetteUniforms, 3 * 12)
    packMaterialParams(getSurf("concrete"), this.vignetteUniforms, 4 * 12)
    packMaterialParams(getSurf("grass"), this.vignetteUniforms, 5 * 12)
    packMaterialParams(getSurf("siding"), this.vignetteUniforms, 6 * 12)
    packMaterialParams(getSurf("shingles"), this.vignetteUniforms, 7 * 12)
    // Cutaway mode 1 (living room + kitchen + bedroom cutaway), balanced ambientFill
    this.vignetteUniforms[96] = 0
    this.vignetteUniforms[97] = 0.5
    this.vignetteUniforms[98] = 1
    this.vignetteUniforms[99] = 0.12
    this.vignetteUniforms[100] = 0.28
    this.vignetteUniforms[101] = -0.55
    this.vignetteUniforms[102] = -0.65
    this.vignetteUniforms[103] = 0.15
  }

  private ensureTargets(w: number, h: number): void {
    if (this.sceneTex && this.texW === w && this.texH === h) return
    this.sceneTex?.destroy()
    this.normalDepthTex?.destroy()
    this.auxTex?.destroy()
    this.auxDepthTex?.destroy()
    this.texW = w
    this.texH = h
    this.cachedSceneSignature = ""

    this.sceneTex = this.device.createTexture({
      size: [w, h],
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    })
    this.sceneTexView = this.sceneTex.createView()

    this.normalDepthTex = this.device.createTexture({
      size: [w, h],
      format: "rgba16float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    })
    this.normalDepthView = this.normalDepthTex.createView()

    this.auxTex = this.device.createTexture({
      size: [w, h],
      format: "rgba8unorm",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    })
    this.auxView = this.auxTex.createView()

    this.auxDepthTex = this.device.createTexture({
      size: [w, h],
      format: "depth24plus",
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    })
    this.auxDepthView = this.auxDepthTex.createView()

    this.styleBindGroup = this.device.createBindGroup({
      layout: this.styleBindLayout,
      entries: [
        { binding: 0, resource: { buffer: this.styleUniformBuf } },
        { binding: 1, resource: this.sceneTexView },
        { binding: 2, resource: this.linearSampler },
        { binding: 3, resource: this.normalDepthView },
        { binding: 4, resource: this.auxView },
      ],
    })
  }

  private ensureLevelBuilt(sim: StylePlaygroundSim): void {
    if (this.builtSeed === sim.seed && this.auxStaticBuf) return
    this.builtSeed = sim.seed
    this.cachedSceneSignature = ""
    const town = sim.view.town
    const blockers = sightRects(town)
    this.occluders.fill(0)
    blockers.forEach((r, i) => this.occluders.set([...r, 2.8, 0, 0, 0], i * OCC_FLOATS))
    let occCount = blockers.length
    for (const b of town.barriers) {
      if (b.kind === "window") this.occluders.set([...b.rect, 0.85, 0, 0, 0], occCount++ * OCC_FLOATS)
    }
    for (const p of town.props) {
      const sh = propShape(p)
      if (sh) this.occluders.set([...sh.rect, sh.height, 0, 0, 0], occCount++ * OCC_FLOATS)
    }
    this.lightOccluders = occCount

    const data = buildVignetteLevel(town)
    this.renderer.setLevel(data)
    this.scenery.mask.fill(255)
    this.renderer.setVisibility(this.scenery.mask, FOG_SIZE, FOG_SIZE)

    // Build concatenated non-roof static vertex buffer for the auxiliary normal/depth/role pass
    const nonRoof = data.chunks.filter(c => !c.customCutaway)
    const totalBytes = nonRoof.reduce((sum, c) => sum + c.data.byteLength, 0)
    const merged = new Uint8Array(Math.max(24, totalBytes))
    let offset = 0
    for (const c of nonRoof) {
      merged.set(new Uint8Array(c.data), offset)
      offset += c.data.byteLength
    }
    this.auxStaticBuf?.destroy()
    this.auxStaticBuf = this.device.createBuffer({
      size: merged.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    })
    this.device.queue.writeBuffer(this.auxStaticBuf, 0, merged)
    this.auxStaticCount = Math.floor(totalBytes / VERT_BYTES)
  }

  render(opts: {
    sim: StylePlaygroundSim
    styleId: StyleId
    recipe: StyleRecipe
    peopleStyle: PeopleStyleId
    focus: readonly [number, number, number]
    camPitch: number
    camDist: number
    width: number
    height: number
    outputView: GPUTextureView
    measure?: boolean
    forceSceneRebuild?: boolean
  }): Promise<number | null> | number | null {
    const { sim, styleId, recipe, peopleStyle, focus, camPitch, camDist, width, height, outputView, measure } = opts
    const w = Math.max(16, Math.floor(width))
    const h = Math.max(16, Math.floor(height))
    this.ensureTargets(w, h)
    this.ensureLevelBuilt(sim)

    // Update camera (with optional world-space pixel-grid snapping when not sharing a multi-style grid)
    let fx = focus[0]
    let fz = focus[2]
    if (recipe.pixelSnap && opts.forceSceneRebuild) {
      const worldStep = Math.max(0.02, camDist / Math.max(48, recipe.pixelSize * 1.6))
      fx = Math.round(fx / worldStep) * worldStep
      fz = Math.round(fz / worldStep) * worldStep
    }
    this.cam.x = fx
    this.cam.z = fz
    this.cam.pitch = camPitch
    this.cam.dist = camDist
    this.cam.zoomOffset = 0
    this.cam.update(w / Math.max(1, h))
    const invVp = mat4.inverse(this.cam.viewProj)

    const shot = sim.activeShotSummary()
    const sceneSig = `${sim.seed}:${sim.tick}:${w}x${h}:${peopleStyle}:${fx.toFixed(3)},${fz.toFixed(3)},${camPitch.toFixed(3)},${camDist.toFixed(3)}`

    if (opts.forceSceneRebuild || sceneSig !== this.cachedSceneSignature) {
      this.cachedSceneSignature = sceneSig
      const batches = this.people.buildBatches(sim, peopleStyle, shot)
      this.renderBaseSceneAndAux(sim, batches, shot, w, h)
    }

    // Pack StyleUniforms for the chosen style module
    const mod = STYLE_MODULES[styleId] ?? STYLE_MODULES["tiny-pixel"]
    const u = this.styleUniformData
    u.fill(0)
    u[0] = w
    u[1] = h
    u[2] = 1 / w
    u[3] = 1 / h

    u[4] = mod.index
    u[5] = recipe.pixelSize
    u[6] = recipe.palette
    u[7] = recipe.outlineWidth

    u[8] = recipe.dither
    u[9] = recipe.halftoneSize
    u[10] = recipe.rampSteps
    u[11] = recipe.fxPunch

    u[12] = sim.view.time
    u[13] = recipe.pixelSnap ? 1 : 0
    u[14] = 0
    u[15] = camDist

    const p = sim.view.player
    const py = supportHeight(sim.view.town, p.x, p.y)
    u[16] = p.x
    u[17] = p.y
    u[18] = p.aim
    u[19] = p.recoil

    const [pUvX, pUvY] = projectWorldToUv(this.cam.viewProj, p.x, py + 0.9, p.y)
    const [fromUvX, fromUvY] = projectWorldToUv(this.cam.viewProj, shot.fromX, py + 1.24, shot.fromZ)
    const [toUvX, toUvY] = projectWorldToUv(this.cam.viewProj, shot.toX, py + 1.15, shot.toZ)
    u[20] = pUvX
    u[21] = pUvY
    u[22] = fromUvX
    u[23] = fromUvY

    u[24] = shot.fromX
    u[25] = shot.fromZ
    u[26] = shot.toX
    u[27] = shot.toZ

    u[28] = fromUvX
    u[29] = fromUvY
    u[30] = toUvX
    u[31] = toUvY

    u[32] = shot.shotIntensity
    u[33] = shot.hitIntensity
    u[34] = shot.killed ? 1 : 0
    u[35] = shot.seed

    for (let i = 0; i < 4; i++) {
      const z = sim.view.zombies[i]
      const wOff = 36 + i * 4
      const sOff = 52 + i * 4
      if (z) {
        const stateCode = z.state === "dead" ? 0 : z.state === "stagger" ? 2 : 1
        u[wOff] = z.x
        u[wOff + 1] = z.y
        u[wOff + 2] = stateCode
        u[wOff + 3] = z.hitFlash
        const zy = supportHeight(sim.view.town, z.x, z.y) + (z.state === "dead" ? 0.25 : 0.95)
        const [zUvX, zUvY] = projectWorldToUv(this.cam.viewProj, z.x, zy, z.y)
        u[sOff] = zUvX
        u[sOff + 1] = zUvY
        u[sOff + 2] = pUvX
        u[sOff + 3] = pUvY
      }
    }

    u[68] = this.cam.eye[0]!
    u[69] = this.cam.eye[1]!
    u[70] = this.cam.eye[2]!
    u[71] = 1
    // Note: StyleUniforms has 80 floats: indices 0..63 are the vec4f fields, wait: let's check exact offsets!
    // Let's verify exact float offsets in StyleUniforms:
    // 0: viewport (4)
    // 4: params0 (4)
    // 8: params1 (4)
    // 12: params2 (4)
    // 16: playerWorld (4)
    // 20: playerScreen (4)
    // 24: shotWorld (4)
    // 28: shotScreen (4)
    // 32: shotMeta (4)
    // 36: zombiesWorld (16: 36..51)
    // 52: zombiesScreen (16: 52..67)
    // 68: eye (4: 68..71)
    // 72: invViewProj (16: 72..87 -> total 88 floats!)
    return this.submitStylePass(invVp, outputView, styleId, Boolean(measure))
  }

  private submitStylePass(
    invVp: Float32Array,
    outputView: GPUTextureView,
    styleId: StyleId,
    measure: boolean,
  ): number | null {
    // Write invViewProj at offset 72 (ensure buffer is 88 floats)
    this.device.queue.writeBuffer(this.styleUniformBuf, 0, this.styleUniformData)
    this.device.queue.writeBuffer(this.styleUniformBuf, 72 * 4, invVp.buffer, invVp.byteOffset, 64)

    const enc = this.device.createCommandEncoder()
    const timed = Boolean(measure && this.styleTimer && !this.timerBusy)
    const pass = enc.beginRenderPass({
      colorAttachments: [
        {
          view: outputView,
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0.03, g: 0.04, b: 0.06, a: 1 },
        },
      ],
      timestampWrites: timed ? this.styleTimer!.start : undefined,
    })
    pass.setPipeline(this.stylePipeline)
    pass.setBindGroup(0, this.styleBindGroup!)
    pass.draw(3)
    pass.end()
    if (timed) {
      this.styleTimer!.finish(enc, outputView)
    }
    this.device.queue.submit([enc.finish()])

    if (timed) {
      this.timerBusy = true
      void this.styleTimer!
        .collect()
        .then(ms => {
          if (ms !== null) {
            this.lastStyleGpuMs = ms
            this.perStyleGpuMs.set(styleId, ms)
          }
        })
        .catch(() => {})
        .finally(() => {
          this.timerBusy = false
        })
    }
    return this.perStyleGpuMs.get(styleId) ?? this.lastStyleGpuMs
  }

  private renderBaseSceneAndAux(
    sim: StylePlaygroundSim,
    batches: StyledBatch[],
    shot: ReturnType<StylePlaygroundSim["activeShotSummary"]>,
    w: number,
    h: number,
  ): void {
    const view = sim.view
    const town = view.town
    const p = view.player
    const r = this.renderer

    r.resize(w, h)
    r.setSurfaceTexUniforms({ enabled: 1, globalScale: 1.0, globalContrast: 1.1, globalRoughness: 0.0 })
    this.vignetteUniforms[104] = p.x
    this.vignetteUniforms[105] = p.y
    this.vignetteUniforms[106] = 1.0
    this.vignetteUniforms[107] = 1.0

    const day = dayCycle(22.2)
    const groundY = supportHeight(town, p.x, p.y)
    const blockers = sightRects(town)

    this.lights.fill(0)
    this.lights.set([p.x, 1.65 + groundY, p.y, 27, 0, 0, 0, 0, 0, 0, 0, 0, 0, blockers.length, 0.01, -1], 0)
    let count = 1

    for (const [i, lamp] of town.lamps.entries()) {
      let mult = lamp.kind === "room" ? 1.35 : lamp.kind === "porch" ? 0.55 : lamp.kind === "window" ? 0.45 : 0.0
      if (lamp.kind === "room" && lamp.x < 26 && lamp.y < 28) mult = 1.65 // Bedroom nightstand lamp
      else if (lamp.kind === "room" && lamp.x > 30 && lamp.y > 29) mult = 1.55 // Dining table lamp
      else if (lamp.kind === "room" && lamp.x < 25 && lamp.y > 32) mult = 1.45 // Living room lamp
      const power = lamp.power * mult
      this.lampPower[i] = mult
      if (power <= 0.001) continue
      const color =
        lamp.kind === "room"
          ? kelvinToRgb(2650)
          : lamp.kind === "porch"
            ? kelvinToRgb(2500)
            : kelvinToRgb(2400)
      const cone =
        lamp.kind === "window"
          ? [0, 1, -0.15, 1]
          : lamp.kind === "porch"
            ? [0, 1, -0.35, 1]
            : [0, 0, 0, lamp.kind === "room" ? -1 : 0]
      this.lights.set(
        [lamp.x, lamp.h, lamp.y, lamp.radius * 1.15, ...color, power, ...cone, 0, this.lightOccluders, 0.16, i],
        count++ * LIGHT_FLOATS,
      )
    }

    // Player flashlight cone
    const fCol = flashlightColor(0.68)
    const dirX = Math.cos(p.aim)
    const dirZ = Math.sin(p.aim)
    const fx = p.x + dirX * 0.25
    const fz = p.y + dirZ * 0.25
    const flashSlot = count
    this.lights.set(
      [
        fx,
        groundY + 1.1,
        fz,
        7.5,
        fCol[0],
        fCol[1],
        fCol[2],
        1.65,
        dirX,
        dirZ,
        Math.cos((26 * Math.PI) / 180),
        1,
        0,
        this.lightOccluders,
        0.06,
        -1,
      ],
      count++ * LIGHT_FLOATS,
    )

    // Dynamic gunshot muzzle + hit flash light when a shot is active
    if (shot.shotIntensity > 0.05 && count < MAX_LIGHTS) {
      this.lights.set(
        [
          shot.fromX + dirX * 0.4,
          groundY + 1.25,
          shot.fromZ + dirZ * 0.4,
          5.6,
          1.0,
          0.74,
          0.28,
          2.1 * shot.shotIntensity,
          0,
          0,
          0,
          -1,
          0,
          this.lightOccluders,
          0.12,
          -1,
        ],
        count++ * LIGHT_FLOATS,
      )
    }

    this.vignetteUniforms[108] = fx
    this.vignetteUniforms[109] = fz
    this.vignetteUniforms[110] = dirX
    this.vignetteUniforms[111] = dirZ
    this.vignetteUniforms[112] = Math.tan((26 * Math.PI) / 180)
    this.vignetteUniforms[113] = 7.5
    this.vignetteUniforms[114] = 0.65
    this.vignetteUniforms[115] = flashSlot
    this.vignetteUniforms[116] = 1
    this.vignetteUniforms[117] = 0.85
    this.vignetteUniforms[118] = 0.62
    this.vignetteUniforms[119] = 0
    r.setCustomUniforms(this.vignetteUniforms)

    // Cutaway probe inside Ash House (29.5, 30.0) so living room + kitchen + bedroom roof is cut away
    const cutX = 29.5
    const cutZ = 30.0
    this.frame.set(this.cam.viewProj, 0)
    this.frame.set([this.cam.eye[0]!, this.cam.eye[1]!, this.cam.eye[2]!, view.time], 16)
    this.frame.set([w, h, count, town.lamps.length], 20)
    this.frame.set([cutX, cutZ, 0, 0.48], 24)
    this.frame.set([day.ambient[0] * 0.22, day.ambient[1] * 0.22, day.ambient[2] * 0.30, day.strength * 0.22], 28)
    const cutClip = vec4.transformMat4([cutX, 1, cutZ, 1], this.cam.viewProj)
    const cw = cutClip[3] || 1
    this.frame.set([cutClip[0] / cw, cutClip[1] / cw, 1.0, count], 32)
    this.frame.set([...day.direction, day.sun], 36)
    this.frame.set([1 / SIZE, 1 / SIZE, 0, SIZE], 40)
    this.frame.set([p.aim, Math.cos((110 * Math.PI) / 360), 2.5, 0.32], 44)

    r.setLook(this.lookSettings, { mode: 0, wipeSplit: 0.5 })
    const renderInput: FrameInput = {
      frame: this.frame,
      lights: this.lights,
      lightCount: count,
      shadowLightCount: count,
      occluders: this.occluders,
      occluderCount: this.lightOccluders,
      lampPower: this.lampPower,
      lampCount: town.lamps.length,
      view: [14, 18, 44, 46],
      batches: batches as Batch[],
      alphaSprites: this.empty,
      alphaCount: 0,
      addSprites: this.empty,
      addCount: 0,
      grade: [view.time, 0, 0, 0.94],
      look: this.lookSettings,
      lookCompare: { mode: 0, wipeSplit: 0.5 },
    }
    r.drawTo(renderInput, this.sceneTexView!)

    // Render auxiliary MRT pass (tNormalDepth + tAux)
    this.auxFrameData.set(this.cam.viewProj, 0)
    this.auxFrameData.set([this.cam.eye[0]!, this.cam.eye[1]!, this.cam.eye[2]!, 1], 16)
    this.device.queue.writeBuffer(this.auxFrameBuf, 0, this.auxFrameData)

    const instRanges: { model: number; first: number; count: number }[] = []
    let instCursor = 0
    for (const b of batches) {
      if (b.count <= 0 || instCursor + b.count > 512) continue
      const first = instCursor
      for (let i = 0; i < b.count; i++) {
        const srcOff = i * INST_FLOATS
        const dstOff = instCursor * INST_FLOATS
        this.auxInstScratch.set(b.data.subarray(srcOff, srcOff + INST_FLOATS), dstOff)
        // Encode semantic actorRole (0, 0.25, 0.50, 0.75) in tint.x for the aux pass
        this.auxInstScratch[dstOff + 4] = b.actorRole * 0.25
        instCursor++
      }
      instRanges.push({ model: b.model, first, count: b.count })
    }
    if (instCursor > 0) {
      this.device.queue.writeBuffer(this.auxInstBuf, 0, this.auxInstScratch.buffer, 0, instCursor * INST_FLOATS * 4)
    }

    const enc = this.device.createCommandEncoder()
    const auxPass = enc.beginRenderPass({
      colorAttachments: [
        {
          view: this.normalDepthView!,
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0.5, g: 1.0, b: 0.5, a: 0.0 },
        },
        {
          view: this.auxView!,
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 0.0 },
        },
      ],
      depthStencilAttachment: {
        view: this.auxDepthView!,
        depthLoadOp: "clear",
        depthStoreOp: "discard",
        depthClearValue: 1.0,
      },
    })
    auxPass.setBindGroup(0, this.auxBindGroup)
    if (this.auxStaticBuf && this.auxStaticCount > 0) {
      auxPass.setPipeline(this.auxStaticPipe)
      auxPass.setVertexBuffer(0, this.auxStaticBuf)
      auxPass.draw(this.auxStaticCount)
    }
    if (instRanges.length > 0) {
      auxPass.setPipeline(this.auxInstPipe)
      auxPass.setVertexBuffer(1, this.auxInstBuf)
      for (const rng of instRanges) {
        const mb = this.modelBuffers[rng.model]
        if (!mb) continue
        auxPass.setVertexBuffer(0, mb.buf)
        auxPass.draw(mb.count, rng.count, 0, rng.first)
      }
    }
    auxPass.end()
    this.device.queue.submit([enc.finish()])
  }
}
