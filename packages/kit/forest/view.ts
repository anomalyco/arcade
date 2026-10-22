/**
 * `createForestView`: the photoreal night-forest renderer as a drop-in world view. A game hands it a plain-data
 * `ForestWorld` (`@arcade/kit/sim/forest-world`) and, every frame, the camera and every player's torch; it owns the
 * kit `Renderer`, the forest passes, the torch's spot shadow, the mist and the camera model. See
 * `docs/game-notes.md` (Woods look) for what each trick buys and costs.
 */
import { reactivePipelineDescriptor } from "../gpu/reactive"
import { Renderer, TEMPORAL_DEFAULTS, type Batch, type FrameInput } from "../gpu/renderer"
import { makeSceneShader, spriteShader } from "../gpu/shaders"
import { compileShaderModuleWithLog, type PassContext, type ScenePass } from "../gpu/pass-graph"
import { TEXTURED_VERTEX_LAYOUT } from "../gpu/textured-mesh"
import { flatLighting, newSceneFrame, packSceneFrame, SceneLights, type SceneLight } from "../gpu/scene-frame"
import { SpotShadows, type SpotCandidate, type SpotShadowCaster, type SpotShadowMask } from "../gpu/shadows/spot-shadows"
import { FogScatter, createFogSettings, fogScatterVolume, frustumPlanes, packLampGlow, type FogLamp } from "../gpu/fog-scatter"
import { Ssr, createSsrSettings, ssrVolume } from "../gpu/reflections/ssr"
import { WET_DEFAULTS } from "../gpu/reflections/wet"
import { packBeamProfile } from "../gpu/lights/beam"
import type { ForestWorld, Vec3 } from "../sim/forest-world"
import { loadForestModels, loadForestTextures, type ForestTextures } from "./assets"
import { buildForest, CHUNK, forestHeightGrid, INSTANCE_FLOATS, type ForestBuild } from "./build"
import { ForestBuilder } from "./offthread"
import { ALPHA_COVERAGE_BASE } from "./alpha-coverage"
import { GROUND_CELL, GROUND_CELLS, WOODS_FLOATS, batchHooks, cutoutDepthWgsl, forestHooks, forestShadowInstanceWgsl, moteShader, skyShader, treeVertexWgsl, woodsUniformWgsl } from "./shaders"
import { forestPost } from "./post"
import { FOREST_WIND_DIR } from "./wind"
import { stepForestExposure, forestExposureTarget } from "./exposure"
import { indexForestMesh } from "./index-mesh"
import { FOREST_QUALITY, createForestLookSettings, forestLookControls, kelvinColor, torchProfile, type ForestLookSettings, type ForestQuality } from "./settings"
import type { QualityTier } from "../quality"
import type { LabControl } from "../lab-navigation"

export type ForestTorch = {
  /** Stable per player. */
  id: number
  /** Lens position and unit beam axis. */
  pos: Vec3
  dir: Vec3
  on: boolean
  /** The viewer's own torch gets the shadow map and drives exposure and bounce. */
  kind?: "local" | "remote"
  /** Output share (battery sag, flicker); default 1. */
  level?: number
}

/** A small bright source seen as a point: its core sprite and the glow the air puts round it (a mast beacon). */
export type ForestGlow = { x: number; y: number; z: number; color: readonly [number, number, number]; radius: number }

export type ForestFrameInput = {
  eye: Vec3
  /** Unjittered view-projection (column-major, WebGPU clip z 0..1). */
  viewProj: Float32Array
  width: number
  height: number
  /** Seconds (wind, mist, stars) and the frame step. */
  time: number
  dt: number
  /** Vertical field of view (rad), for star and mote sizes. */
  fovY: number
  torches: readonly ForestTorch[]
  /** Anything else the game draws with the renderer's models (players, gear). */
  batches?: Batch[]
  /** The game's own sprites (`FrameParts.alpha`/`add` with their counts). */
  sprites?: { alpha: Float32Array<ArrayBuffer>; alphaCount: number; add: Float32Array; addCount: number }
  /** Extra place lights on surfaces and in the air (beacons, lanterns), beside the forest's own camp lights. */
  lights?: readonly SceneLight[]
  fogLamps?: readonly FogLamp[]
  glows?: readonly ForestGlow[]
  /** Moving torch-shadow casters the game draws itself (skinned people); their slots re-render while there are any. */
  casters?: readonly SpotShadowCaster[]
}

export type ForestViewOptions = {
  /** URL of the folder holding `tex/` and `models/` (`scripts/woods/fetch-assets.ts`). */
  assetRoot: string
  quality?: QualityTier
  /** Prefix of the boot phases' performance marks (\`<prefix>:assets\`, \`<prefix>:build\`); default "forest". */
  markPrefix?: string
  /** Software-GPU smoke: no mist, reflections or shadows, a single fog lamp. */
  smoke?: boolean
  settings?: Partial<ForestLookSettings>
}

export type ForestView = {
  readonly renderer: Renderer
  readonly settings: ForestLookSettings
  readonly build: ForestBuild
  /** Rebuilds the static forest for a new world (same textures and models). */
  setWorld(world: ForestWorld): void
  /** Snap to the new scene's exposure after a camera cut, teleport or respawn. */
  resetExposure(): void
  /** Typed LabPanel rows for every look setting. */
  controls(prefix?: string): LabControl[]
  quality: ForestQuality
  setQuality(tier: QualityTier): void
  resize(width: number, height: number): void
  /** Prepares and draws one frame: `update` then `draw`. */
  frame(input: ForestFrameInput): void
  /** Prepares a frame (lights, shadows, mist, uniforms) without drawing it. */
  update(input: ForestFrameInput): void
  /** Draws the last prepared frame to the canvas. */
  draw(): void
  /** Encodes the last frame offscreen (automation stepping): the caller copies the canvas in the same task. */
  drawTo(view?: GPUTextureView): void
  /** Median GPU ms of the last frame's input over `n` timed frames. */
  measure(n?: number): Promise<{ median: number; samples: number[] } | null>
  stats(): Record<string, number | string>
  /** Exposure the camera has settled on (× base) and the torch's hit distance (m). */
  readonly camera: { exposure: number; hit: number }
  /** Profiling switches (automation only). */
  readonly debug: Record<string, boolean>
}

const TAU = Math.PI * 2

/** The forest's fog volume: mist pools in the hollows (the bank sits at absolute heights) and thickens over the lake. */
export const forestFogVolume = (smoke: boolean) => fogScatterVolume({
  declarations: woodsUniformWgsl + (smoke ? "" : woodsBankWgsl + /* wgsl */ `
fn woodsTorchScatter(p: vec3f, eye: vec3f) -> f32 {
  if (N.pad.x < 0.5) { return 1.0; }
  return mix(N.pad.w, 1.0, smoothstep(3.0, 12.0, distance(p, eye)));
}
// Integral of a linear 12 m density ramp, clear before N.pad.z. Both lamp and eye
// legs use it; source scattering uses its derivative. This is an artistic clear
// near field, not a spatially uniform physical atmosphere.
fn fogDistanceDepth(a: vec3f, b: vec3f) -> f32 {
  let d = max(0.0, distance(a, b) - N.pad.z);
  let ramp = min(d, 12.0);
  return N.pad.y * (ramp * ramp / 24.0 + max(0.0, d - 12.0));
}
fn fogDistanceSigma(p: vec3f, eye: vec3f) -> f32 {
  return N.pad.y * clamp((distance(p, eye) - N.pad.z) / 12.0, 0.0, 1.0);
}
fn fogDistanceColor() -> vec3f { return vec3f(0.000015, 0.00002, 0.00003); }
`), atmosphere: !smoke, bankLocal: "woodsBankLocal(p)", bankExtinction: true, torches: true,
  ...(!smoke ? { torchScatter: "woodsTorchScatter(ro + rd * (s0 + h * tan(t)), ro)", distanceFog: true } : {}),
  // Only glossy ground mirrors the lamps (water, wet boards, shore mud); dry litter and the camp's dirt do not.
  cutoff: "0.4", spotShadows: !smoke, surface: !smoke, reflectionSamples: 2, reflectionCap: "3.0",
  bankMask: "1.0 + 0.6 * (1.0 - smoothstep(0.85, 1.5, length((p.xz - N.lake.xy) / N.lake.zw)))",
})

/**
 * The mist bank's floor, height and density at p: it lies on the ground (or the lake), deepens and thickens in
 * hollows (lower than the ground 12 m round), and breaks into pockets and clear stretches over ~45 m.
 */
const woodsBankWgsl = /* wgsl */ `
fn woodsBankLocal(p: vec3f) -> vec3f {
  let g = max(woodsGround(p.xz), N.camp.w);
  let around = (woodsGround(p.xz + vec2f(12.0, 0.0)) + woodsGround(p.xz - vec2f(12.0, 0.0)) + woodsGround(p.xz + vec2f(0.0, 12.0)) + woodsGround(p.xz - vec2f(0.0, 12.0))) * 0.25;
  let hollow = clamp((around - g) * 0.8, 0.0, 1.0);
  let pocket = smoothstep(0.3, 0.75, fogNoise2(p.xz / 45.0 + vec2f(3.1, 7.7)) * 0.7 + fogNoise2(p.xz / 17.0 + vec2f(1.3, 4.2)) * 0.3);
  return vec3f(g - 0.3, mix(0.55, 1.25, pocket) + hollow * 0.9, mix(0.3, 1.2, pocket) + hollow * 1.2);
}
`

export async function createForestView(gpu: { device: GPUDevice; context: GPUCanvasContext; format: GPUTextureFormat }, world: ForestWorld, opts: ForestViewOptions): Promise<ForestView> {
  const { device } = gpu
  const smoke = !!opts.smoke
  let quality = FOREST_QUALITY[opts.quality ?? "balanced"]
  const settings = createForestLookSettings(opts.settings)
  const lakeOf = (w: ForestWorld) => w.lake ?? { x: 0, z: 0, rx: 1, rz: 1, level: -100 }
  const fogBaseOf = (w: ForestWorld) => Math.min(lakeOf(w).level, ...[0, 1, 2, 3].map(i => w.height(Math.cos(i) * 10, Math.sin(i) * 10) - 2))
  let lake = lakeOf(world), fogBase = fogBaseOf(world)

  const fogVolume = forestFogVolume(smoke)
  const ssr = new Ssr(createSsrSettings({ mode: smoke ? "today" : "ssr", strength: 1.6, maxDistance: 60, cutoff: 0.4, streak: 0.8, maxLuminance: 20, historyMoving: 0.4 }))
  const renderer = new Renderer(device, gpu.context, gpu.format, {
    scene: makeSceneShader(batchHooks), sprite: spriteShader(), post: forestPost,
    volume: smoke ? [fogVolume] : [ssrVolume(), fogVolume],
  })
  renderer.setTemporal({ ...TEMPORAL_DEFAULTS, mode: "taa", sharpen: 0.15 })
  // Auto exposure meters the frame as drawn (every beam, the fog they light, friends' lenses), not a guess at it.
  if (!smoke) renderer.setMeter(true)
  renderer.setLevel({ chunks: [], glass: [], ...flatLighting(0, 0, [0, 0, 0]) })
  renderer.setBloomLevels(quality.bloomLevels)

  // The build runs on a worker while the page decodes and uploads the textures. The worker's script and the models fetch
  // first: the browser opens a few connections per host, and they must not queue behind the images. The ground is
  // sampled meanwhile.
  const mark = (phase: string, startTime?: number) => performance.mark(`${opts.markPrefix ?? "forest"}:${phase}`, startTime === undefined ? undefined : { startTime })
  const t0 = performance.now()
  const builder = new ForestBuilder()
  const modelsLoading = loadForestModels(opts.assetRoot)
  const texturesLoading = loadForestTextures(device, opts.assetRoot, quality.textureSize)
  texturesLoading.then(() => mark("textures"), () => {})
  const ground = forestHeightGrid(world)
  mark("grid")
  let models = await modelsLoading
  mark("models")
  const t1 = performance.now()
  const buildOpts = () => ({ scatter: 1, fernDensity: settings.fernDensity, litter: settings.litter, smoothTrunks: settings.smoothTrunks })
  // A worker that dies mid-build takes the models it was handed: fetch them again and build here.
  const built = await builder.build(world, models, buildOpts(), ground, (time) => mark("worker", time)).catch(async (error) => {
    console.warn("forest: building on the main thread:", error)
    const again = await loadForestModels(opts.assetRoot)
    return { build: buildForest(world, again, buildOpts(), ground), models: again }
  })
  let build = built.build
  models = built.models
  let buildMs = performance.now() - t1
  mark("build")
  const textures = await texturesLoading
  const loadMs = performance.now() - t0
  mark("assets")

  let pass = new ForestPass(renderer.passContext, build, textures, world)
  renderer.addPass("sky", new SkyPass(renderer.passContext))
  renderer.addPass("opaque", pass)
  const motes = new MotePass(renderer.passContext)
  renderer.addPass("alpha", motes)

  const fog = new FogScatter(createFogSettings())
  const spots = new SpotShadows(device, { count: smoke ? 0 : 1, size: quality.shadowSize, bias: 1.2 }, forestShadowInstanceWgsl)
  renderer.setSpotShadows(spots.bindings())
  const lights = new SceneLights()
  const frameData = newSceneFrame()
  const custom = new Float32Array(WOODS_FLOATS)
  const empty = new Float32Array(0)
  let sprites: Float32Array<ArrayBuffer> = new Float32Array(12 * 32)
  const unjitteredInv = new Float32Array(16)
  const maskView = textures.base.createView({ dimension: "2d-array" })
  const foliageMask: SpotShadowMask = { view: maskView, cutoff: 0.45, layerFromAux: true, lod: 1 }
  const cam = { exposure: 1, hit: 40, stops: 0, pending: true, wait: 0 }
  let previousEye: Vec3 | null = null
  function resetExposure() {
    Object.assign(cam, { exposure: 1, hit: 40, stops: 0, pending: true, wait: 0 })
    previousEye = null
    bounce.ready = false; bounce.power = 0
    renderer.resetSceneMeter()
    renderer.resetTemporalHistory()
  }
  const bounce = { x: 0, y: 0, z: 0, power: 0, color: [1, 1, 1] as [number, number, number], ready: false }
  let lastFrame: FrameInput | null = null
  let debug = pass.debug as Record<string, boolean>
  let lastInput: ForestFrameInput | null = null
  // Eye-centred coarse ground for the mist bank's floor (GROUND_CELLS², snapped to whole cells so it doesn't swim).
  const groundGrid = new Float32Array(GROUND_CELLS * GROUND_CELLS)
  let groundKey = ""
  let groundMax = 0
  const updateGround = (eye: Vec3) => {
    const x0 = (Math.round(eye[0] / GROUND_CELL) - GROUND_CELLS / 2) * GROUND_CELL, z0 = (Math.round(eye[2] / GROUND_CELL) - GROUND_CELLS / 2) * GROUND_CELL
    const key = `${x0},${z0}`
    if (key === groundKey) return
    groundKey = key
    groundMax = -Infinity
    for (let j = 0; j < GROUND_CELLS; j++) for (let i = 0; i < GROUND_CELLS; i++) {
      const h = world.height(x0 + (i + 0.5) * GROUND_CELL, z0 + (j + 0.5) * GROUND_CELL)
      groundGrid[j * GROUND_CELLS + i] = h
      groundMax = Math.max(groundMax, h)
    }
    custom.set([x0, z0, 1 / GROUND_CELL, 0], 80)
    custom.set(groundGrid, 84)
  }
  // Sky openness round the eye (the field map's red, 24 m disc), eased: under the canopy the airglow lighting the mist
  // is blocked as much as it is for surfaces, so the mist dims with it instead of glowing behind black trunks.
  let openAround = -1
  const opennessAt = (eye: Vec3) => {
    const n = build.fieldSize, reach = world.half + 50, texel = (2 * reach) / n
    let sum = 0, count = 0
    for (let dz = -24; dz <= 24; dz += 6) for (let dx = -24; dx <= 24; dx += 6) {
      if (dx * dx + dz * dz > 24 * 24) continue
      const i = Math.floor((eye[0] + dx + reach) / texel), j = Math.floor((eye[2] + dz + reach) / texel)
      if (i < 0 || j < 0 || i >= n || j >= n) { sum += 1; count++; continue }
      sum += build.field[(j * n + i) * 4]! / 255; count++
    }
    return sum / Math.max(count, 1)
  }

  const applyQuality = () => {
    spots.settings.size = settings.shadowSize === 2048 && quality.shadowSize < 2048 ? quality.shadowSize : Math.min(settings.shadowSize, quality.shadowSize) as 512 | 1024 | 2048
    renderer.setBloomLevels(quality.bloomLevels)
  }
  applyQuality()

  function frame(f: ForestFrameInput) {
    // Catch authoritative respawns/corrections as well as explicit automation teleports.
    if (previousEye && Math.hypot(...f.eye.map((v, i) => v - previousEye![i]!)) > 3) resetExposure()
    previousEye = [...f.eye]
    lastInput = f
    const s = settings
    const local = f.torches.find(t => t.kind !== "remote" && t.on) ?? null
    const halfAngle = (s.torchAngle * Math.PI) / 180
    const torchColor = kelvinColor(s.torchKelvin)
    const profile = torchProfile(s)
    const torchPower = s.torchPower
    motes.count = smoke ? 0 : Math.max(0, Math.round(s.dustCount))

    // ---- Where the beam lands: drives the bounce light and the exposure.
    if (local) {
      const hit = pass.raycast(local.pos, local.dir, s.torchReach)
      cam.hit = hit.d
      const k = 1 - Math.exp(-f.dt * 10)
      const target = hit.hit ? hit.point.map((v, i) => v + hit.normal[i]! * 0.3 - local.dir[i]! * 0.15) : local.pos.map((v, i) => v + local.dir[i]! * s.torchReach)
      if (!bounce.ready) { [bounce.x, bounce.y, bounce.z] = target; bounce.ready = true }
      bounce.x += (target[0]! - bounce.x) * k; bounce.y += (target[1]! - bounce.y) * k; bounce.z += (target[2]! - bounce.z) * k
      // A Lambertian spot re-emits I·tan²θ·albedo whatever its distance; the light fades as the spot does past reach.
      const fade = hit.hit ? 1 - Math.max(0, (hit.d - s.torchReach * 0.6) / (s.torchReach * 0.4)) : 0
      const p = torchPower * Math.tan(halfAngle) ** 2 * hit.albedoLum * s.bounce * 1.6 * Math.max(0, fade)
      bounce.power += (p - bounce.power) * k
      for (let i = 0; i < 3; i++) bounce.color[i] = bounce.color[i]! + (hit.albedo[i]! / Math.max(hit.albedoLum, 1e-3) * torchColor[i]! - bounce.color[i]!) * k
    } else bounce.power *= Math.exp(-f.dt * 10)

    // ---- Auto exposure from the scene-referred meter, a few frames late.
    // After a cut briefly hold for a live meter; absent, stalled or failed meters use the fallback.
    const coverage = Math.min(1, (Math.tan(halfAngle * 1.3) / Math.tan(f.fovY / 2)) ** 2)
    const spot = local ? (torchPower * 5 * 0.2) / (Math.PI * Math.max(cam.hit, 0.4) ** 2) * coverage : 0
    const metered = renderer.sceneMeter
    // The compensation follows your torch, not the whole night: camp with your torch off keeps its exposure law.
    const targetStops = forestExposureTarget(metered, spot + 0.004 * s.sky + 0.0005, s, s.clearAir && !smoke && local ? -0.25 : 0)
    stepForestExposure(cam, renderer.sceneMeterStatus, targetStops, f.dt, s)
    cam.exposure = Math.pow(2, cam.stops)

    // ---- Lights.
    const frameLights: SceneLight[] = []
    for (const t of f.torches) {
      if (!t.on) continue
      frameLights.push({ id: 1000 + t.id, x: t.pos[0], y: t.pos[2], h: t.pos[1], r: s.torchReach, color: torchColor, power: torchPower * (t.level ?? 1), size: 0.02, unshadowed: true, beam: { axis: t.dir, halfAngle } })
    }
    if (local && bounce.power > 0.01) frameLights.push({ id: 2000, x: bounce.x, y: bounce.z, h: bounce.y, r: 9, color: bounce.color, power: bounce.power, size: 0.6, unshadowed: true })
    for (const [i, l] of build.campLights.entries()) {
      const k = l.kind === "bulb" ? s.stringLights : s.windows
      if (k <= 0) continue
      frameLights.push({ id: 3000 + i, x: l.x, y: l.z, h: l.y, r: l.range, color: l.color, power: l.power * k, size: l.kind === "window" ? 0.5 : 0.05, unshadowed: true,
        ...(l.cosOuter > 0 ? { spot: { axis: l.axis, cosOuter: l.cosOuter, cosInner: Math.min(0.999, l.cosOuter + 0.35) } } : {}) })
    }
    for (const l of f.lights ?? []) frameLights.push(l)
    lights.update(frameLights, [])

    // ---- Spot shadow of the local torch (and, on High, the nearest other one).
    spots.settings.count = smoke || s.torchShadows === "off" ? 0 : quality.tier === "high" ? 2 : 1
    const candidates: SpotCandidate[] = f.torches.filter(t => t.on).map(t => ({ id: 1000 + t.id, pos: t.pos, axis: t.dir, cosOuter: Math.cos(Math.min(1.2, halfAngle * 2.2)), range: s.torchReach, intensity: torchPower * (t === local ? 100 : 1) }))
    pass.update(f.eye, f.viewProj, quality, s)
    const enc = device.createCommandEncoder()
    const casters = local && spots.settings.count > 0 ? pass.casters(local.pos, s.torchReach, quality.fernNear, s.foliageShadows && quality.foliageShadows ? foliageMask : null) : []
    if (casters.length && f.casters?.length) { casters.push(...f.casters); spots.invalidate() }
    if (spots.update(enc, candidates, f.eye, f.dt, id => lights.indexOf(id), casters)) renderer.setSpotShadows(spots.bindings())
    // Moving torches re-render every frame: the picker only knows a light moved, the world is static.
    device.queue.submit([enc.finish()])

    // ---- Fog, mist and the beams in it.
    const heading = Math.atan2(0.47, 0.88)
    updateGround(f.eye)
    const open = opennessAt(f.eye)
    openAround = openAround < 0 ? open : openAround + (open - openAround) * (1 - Math.exp(-f.dt / 1.5))
    // The mist's own glow follows the canopy; the ambient it feeds surfaces (skylight) stays as it was.
    const canopy = 1 - s.canopyMist * (1 - Math.min(1, openAround * 1.4))
    Object.assign(fog.settings, {
      mode: "scatter", density: s.fogDensity, falloff: s.fogFalloff, base: fogBase, hue: s.fogHue, saturation: 0.3, brightness: s.fogBrightness * s.sky * canopy,
      skyDark: 0.55, horizonGlow: 0.5, ground: 0.08, skylight: 1 / Math.max(canopy, 0.05), strength: s.beamAir, leak: 0.015, coneLength: s.torchReach * 2, phaseG: s.phaseG, phaseFloor: s.phaseFloor,
      samples: quality.fogSamples, lamps: smoke ? 1 : 16, history: 0.12, historyMoving: 0.45, halfRes: true, reflection: 1.5 * s.water, glint: 1.5 * s.water, streak: 0.6,
      bank: s.mist === "drift" && !smoke ? "drift" : "today", bankDensity: s.mistDensity, bankHeight: s.mistHeight, bankRelief: groundMax - fogBase + s.mistHeight * 1.6, bankScale: s.mistScale,
      bankThreshold: s.mistGaps, bankUndulation: 0.55, bankWind: s.mistDrift, bankWindHeading: (heading * 180) / Math.PI, bankSteps: quality.mistSteps, bankDistance: 90,
      bankBrightness: s.depthMist ? 0 : 0.35, bankGlow: 0.7, bankLamp: s.beamMist, blur: "depth", blurStrength: 0.35, blurReach: 0.8, glowSpread: 10,
    })
    const fogLamps: FogLamp[] = []
    for (const t of f.torches) {
      if (!t.on) continue
      const id = lights.indexOf(1000 + t.id)
      fogLamps.push({ id: 1000 + t.id, x: t.pos[0], y: t.pos[1], z: t.pos[2], range: s.torchReach, color: torchColor, intensity: torchPower * 5 * (t.level ?? 1), axis: t.dir, cosOuter: Math.cos(halfAngle * 1.6), cosInner: Math.cos(halfAngle * 0.5), size: t === local ? s.beamNear * 2 : 0.8, beam: halfAngle, uplight: 0, ...(t === local && s.shafts && spots.settings.count > 0 && id >= 0 ? { shadow: id } : {}) })
    }
    for (const [i, l] of build.campLights.entries()) {
      const k = l.kind === "bulb" ? s.stringLights : s.windows
      if (k <= 0) continue
      // A string bulb is a few candela: a faint halo, not a ball of fog.
      fogLamps.push({ id: 3000 + i, x: l.x, y: l.y, z: l.z, range: l.kind === "window" ? 9 : 4, color: l.color, intensity: l.power * k * (l.kind === "window" ? 3 : l.kind === "bulb" ? 1.2 : 5), size: l.kind === "window" ? 1 : 0.1,
        ...(l.cosOuter > 0 ? { axis: l.axis, cosOuter: l.cosOuter, cosInner: Math.min(0.999, l.cosOuter + 0.3) } : {}), uplight: 0.5 })
    }

    for (const l of f.fogLamps ?? []) fogLamps.push(l)

    // ---- Glare of other players' lenses when their beam points at the camera.
    let spriteCount = 0
    let glare = 0
    for (const t of f.torches) {
      if (!t.on || t === local) continue
      const to = [f.eye[0] - t.pos[0], f.eye[1] - t.pos[1], f.eye[2] - t.pos[2]]
      const d = Math.hypot(to[0]!, to[1]!, to[2]!) || 1
      const cosT = (to[0]! * t.dir[0] + to[1]! * t.dir[1] + to[2]! * t.dir[2]) / d
      const ang = Math.acos(Math.max(-1, Math.min(1, cosT))) / halfAngle
      // The lens is seen only from in front (the body hides it from behind); its radiance follows the beam profile at
      // the eye's angle, so the sprite (a 2 cm core) holds its brightness and shrinks with distance.
      const prof = cosT > 0 ? beamProfileCpu(ang, profile) : 0
      if (prof <= 0.002 || spriteCount >= 8) continue
      const intensity = torchPower * 5 * prof * (t.level ?? 1)
      glare += (intensity / (d * d)) * 0.004
      // A lens-sized source (6 cm quad, same energy as the old 40 cm one): the glare round it is the bloom's, in screen
      // space, so a friend aiming at you flares without whiting out their body.
      const k = intensity * 0.15 * (0.4 / 0.06) ** 2
      packLampGlow(sprites, spriteCount * 12, { x: t.pos[0], y: t.pos[1], z: t.pos[2] }, 0.06, [torchColor[0] * k, torchColor[1] * k, torchColor[2] * k], f.eye, { density: s.fogDensity, falloff: s.fogFalloff, base: fogBase })
      spriteCount++
    }
    // The game's additive sprites, then point sources (a beacon is a core and a tight glow, not a blob of fog).
    const extra = f.sprites ? f.sprites.addCount : 0
    if ((spriteCount + extra + (f.glows?.length ?? 0)) * 12 > sprites.length) {
      const grown = new Float32Array((spriteCount + extra + (f.glows?.length ?? 0) + 32) * 12)
      grown.set(sprites.subarray(0, spriteCount * 12))
      sprites = grown
    }
    if (f.sprites && extra) { sprites.set(f.sprites.add.subarray(0, extra * 12), spriteCount * 12); spriteCount += extra }
    for (const g of f.glows ?? []) {
      packLampGlow(sprites, spriteCount * 12, g, g.radius, g.color, f.eye, { density: s.fogDensity, falloff: s.fogFalloff, base: fogBase })
      spriteCount++
    }
    // Veiling glare: a decent lens scatters about 1.5% of the light reaching it evenly over the frame.
    if (local) glare += spot * 0.015
    glare = Math.min(glare, 0.5) * s.glare

    // ---- Custom uniforms.
    const wind = FOREST_WIND_DIR
    const moonH = (s.moonHeading * Math.PI) / 180, moonE = (s.moonElevation * Math.PI) / 180
    custom.set([wind[0]!, wind[1]!, s.wind, s.gust], 0)
    // w: the exposure the post pass applies (fluorescent tape keeps its hue under it).
    custom.set([s.trunkSway, s.branchSway, s.flutter, s.exposure * cam.exposure], 4)
    custom.set([Math.cos(moonE) * Math.cos(moonH), Math.sin(moonE), Math.cos(moonE) * Math.sin(moonH), s.moon], 8)
    custom.set([s.sky, s.stars, s.skylight, s.moss], 12)
    custom.set([s.windows, s.stringLights, s.water, lake.level], 16)
    custom.set([lake.x, lake.z, lake.rx, lake.rz], 20)
    const reach = world.half + 50
    custom.set([-reach, -reach, 1 / (2 * reach), 0], 24)
    custom.set(local ? [local.pos[0], local.pos[1], local.pos[2], 1] : [0, -1000, 0, 0], 28)
    custom.set(local ? [local.dir[0], local.dir[1], local.dir[2], halfAngle] : [0, -1, 0, halfAngle], 32)
    custom.set([torchColor[0] * torchPower * 5, torchColor[1] * torchPower * 5, torchColor[2] * torchPower * 5, s.torchReach], 36)
    custom.set([smoke ? 0 : s.motes, (2 * Math.tan(f.fovY / 2)) / f.height, local && spots.settings.count > 0 ? lights.indexOf(1000 + local.id) : -1, 0], 40)
    custom.set([1, 1, 1, profile.spill], 44)
    packBeamProfile(profile, custom, 48)
    invert(f.viewProj, unjitteredInv)
    custom.set(unjitteredInv, 56)
    custom.set([textures.size, 0.5, Math.log2(ALPHA_COVERAGE_BASE / textures.size), 0], 72)
    custom.set([s.clearAir && !smoke ? 1 : 0, s.depthMist && !smoke ? s.depthDensity : 0, s.depthStart, s.nearScatter], 76)
    renderer.setCustomUniforms(custom)

    packSceneFrame(frameData, { viewProj: f.viewProj, eye: f.eye, time: f.time, width: f.width, height: f.height, lightCount: lights.lightCount, ambient: [0, 0, 0, 0], mapSize: [1, 1], ao: 0 })
    const volumes = smoke ? [fog.volumeInput()] : [debug.ssr === false ? null : ssr.volumeInput({ indoor: false, wet: { ...WET_DEFAULTS, wetness: 1, puddles: 1, ripple: 0.15 } }), fog.volumeInput()]
    lastFrame = {
      frame: frameData, lights: lights.lights, lightCount: lights.lightCount, shadowLightCount: lights.shadowLightCount,
      occluders: lights.occ, occluderCount: 0, lampPower: lights.power, lampCount: 0,
      view: [-reach, -reach, reach, reach], batches: f.batches ?? [], alphaSprites: f.sprites?.alpha ?? empty, alphaCount: f.sprites?.alphaCount ?? 0, addSprites: sprites, addCount: spriteCount,
      grade: [f.time, s.noise, s.vignette, s.exposure * cam.exposure],
      postParams: [s.aberration, s.halation, s.bloom],
      postCustom: [s.chromaNoise, glare, Math.pow(2, Math.max(0, cam.stops)) * Math.sqrt(s.exposure / 1.6), Number(s.nightDesaturate) + 2 * Number(s.nightPurkinje)],
      postExtra: s.nightAcuity,
      fog: fog.update({ eye: f.eye, viewProj: f.viewProj, lamps: fogLamps, time: f.time, beam: profile }),
      volume: volumes, fogBlur: fog.blurInput(),
    }
  }

  return {
    renderer, settings,
    get build() { return build },
    setWorld(next: ForestWorld) {
      const t = performance.now()
      build = buildForest(next, models, buildOpts())
      buildMs = performance.now() - t
      const old = pass
      renderer.removePass(old)
      pass = new ForestPass(renderer.passContext, build, textures, next)
      Object.assign(pass.debug, old.debug)
      debug = pass.debug as Record<string, boolean>
      renderer.addPass("opaque", pass)
      old.dispose()
      world = next
      lake = lakeOf(next); fogBase = fogBaseOf(next)
      groundKey = ""; openAround = -1
      resetExposure()
    },
    resetExposure,
    controls: (prefix = "woods.") => forestLookControls(settings, prefix),
    get quality() { return quality },
    set quality(q: ForestQuality) { quality = q; applyQuality() },
    setQuality(tier: QualityTier) { quality = FOREST_QUALITY[tier]; applyQuality() },
    resize(width: number, height: number) { renderer.resize(width, height) },
    frame(input: ForestFrameInput) {
      frame(input)
      renderer.render(lastFrame!)
    },
    update: frame,
    draw() { if (lastFrame) renderer.render(lastFrame) },
    drawTo(view?: GPUTextureView) { if (lastFrame) renderer.drawTo(lastFrame, view) },
    async measure(n = 24) {
      if (!lastFrame) return null
      const samples: number[] = []
      for (let i = 0; i < n; i++) { for (let w = 0; w < 3; w++) renderer.render(lastFrame); samples.push(await renderer.measure(lastFrame)) }
      samples.sort((a, b) => a - b)
      return { median: samples[Math.floor(samples.length / 2)]!, samples }
    },
    stats: () => ({ ...build.stats, ...pass.stats, loadMs: Math.round(loadMs), buildMs: Math.round(buildMs), shadowLayers: spots.rendered, lights: lights.lightCount, exposure: +cam.exposure.toFixed(3), meter: +(renderer.sceneMeter?.centre ?? -1).toPrecision(3), hit: +cam.hit.toFixed(2), tier: quality.tier, frames: lastInput ? 1 : 0 }),
    camera: cam,
    get debug() { return debug },
  }
}

function beamProfileCpu(t: number, p: { inner: number; core: number; coreWidth: number; spill: number; spillWidth: number; rings: number }): number {
  const spillW = Math.max(p.spillWidth, 1)
  if (t >= spillW * 1.7) return 0
  const bell = (x: number) => 1 / (1 + x * x * (1 + 0.35 * x * x))
  const lor = (x: number) => 1 / (1 + x * x * (1 + 0.48 * x * x))
  const ss = (a: number, b: number, x: number) => { const u = Math.max(0, Math.min(1, (x - a) / (b - a))); return u * u * (3 - 2 * u) }
  const coreW = Math.max(p.coreWidth, 0.05)
  const rings = 1 + p.rings * (0.2 * bell((t - 0.84) * 12.5) - 0.18 * bell((t - coreW * 1.35) * 9))
  return (1 - ss(p.inner, 1, t)) * rings + p.core * lor(t / Math.max(coreW, 0.04)) + p.spill * lor(t / spillW)
}

function invert(m: ArrayLike<number>, out: Float32Array) {
  const a = Array.from(m)
  const inv = new Array(16).fill(0)
  inv[0] = a[5]! * a[10]! * a[15]! - a[5]! * a[11]! * a[14]! - a[9]! * a[6]! * a[15]! + a[9]! * a[7]! * a[14]! + a[13]! * a[6]! * a[11]! - a[13]! * a[7]! * a[10]!
  inv[4] = -a[4]! * a[10]! * a[15]! + a[4]! * a[11]! * a[14]! + a[8]! * a[6]! * a[15]! - a[8]! * a[7]! * a[14]! - a[12]! * a[6]! * a[11]! + a[12]! * a[7]! * a[10]!
  inv[8] = a[4]! * a[9]! * a[15]! - a[4]! * a[11]! * a[13]! - a[8]! * a[5]! * a[15]! + a[8]! * a[7]! * a[13]! + a[12]! * a[5]! * a[11]! - a[12]! * a[7]! * a[9]!
  inv[12] = -a[4]! * a[9]! * a[14]! + a[4]! * a[10]! * a[13]! + a[8]! * a[5]! * a[14]! - a[8]! * a[6]! * a[13]! - a[12]! * a[5]! * a[10]! + a[12]! * a[6]! * a[9]!
  inv[1] = -a[1]! * a[10]! * a[15]! + a[1]! * a[11]! * a[14]! + a[9]! * a[2]! * a[15]! - a[9]! * a[3]! * a[14]! - a[13]! * a[2]! * a[11]! + a[13]! * a[3]! * a[10]!
  inv[5] = a[0]! * a[10]! * a[15]! - a[0]! * a[11]! * a[14]! - a[8]! * a[2]! * a[15]! + a[8]! * a[3]! * a[14]! + a[12]! * a[2]! * a[11]! - a[12]! * a[3]! * a[10]!
  inv[9] = -a[0]! * a[9]! * a[15]! + a[0]! * a[11]! * a[13]! + a[8]! * a[1]! * a[15]! - a[8]! * a[3]! * a[13]! - a[12]! * a[1]! * a[11]! + a[12]! * a[3]! * a[9]!
  inv[13] = a[0]! * a[9]! * a[14]! - a[0]! * a[10]! * a[13]! - a[8]! * a[1]! * a[14]! + a[8]! * a[2]! * a[13]! + a[12]! * a[1]! * a[10]! - a[12]! * a[2]! * a[9]!
  inv[2] = a[1]! * a[6]! * a[15]! - a[1]! * a[7]! * a[14]! - a[5]! * a[2]! * a[15]! + a[5]! * a[3]! * a[14]! + a[13]! * a[2]! * a[7]! - a[13]! * a[3]! * a[6]!
  inv[6] = -a[0]! * a[6]! * a[15]! + a[0]! * a[7]! * a[14]! + a[4]! * a[2]! * a[15]! - a[4]! * a[3]! * a[14]! - a[12]! * a[2]! * a[7]! + a[12]! * a[3]! * a[6]!
  inv[10] = a[0]! * a[5]! * a[15]! - a[0]! * a[7]! * a[13]! - a[4]! * a[1]! * a[15]! + a[4]! * a[3]! * a[13]! + a[12]! * a[1]! * a[7]! - a[12]! * a[3]! * a[5]!
  inv[14] = -a[0]! * a[5]! * a[14]! + a[0]! * a[6]! * a[13]! + a[4]! * a[1]! * a[14]! - a[4]! * a[2]! * a[13]! - a[12]! * a[1]! * a[6]! + a[12]! * a[2]! * a[5]!
  inv[3] = -a[1]! * a[6]! * a[11]! + a[1]! * a[7]! * a[10]! + a[5]! * a[2]! * a[11]! - a[5]! * a[3]! * a[10]! - a[9]! * a[2]! * a[7]! + a[9]! * a[3]! * a[6]!
  inv[7] = a[0]! * a[6]! * a[11]! - a[0]! * a[7]! * a[10]! - a[4]! * a[2]! * a[11]! + a[4]! * a[3]! * a[10]! + a[8]! * a[2]! * a[7]! - a[8]! * a[3]! * a[6]!
  inv[11] = -a[0]! * a[5]! * a[11]! + a[0]! * a[7]! * a[9]! + a[4]! * a[1]! * a[11]! - a[4]! * a[3]! * a[9]! - a[8]! * a[1]! * a[7]! + a[8]! * a[3]! * a[5]!
  inv[15] = a[0]! * a[5]! * a[10]! - a[0]! * a[6]! * a[9]! - a[4]! * a[1]! * a[10]! + a[4]! * a[2]! * a[9]! + a[8]! * a[1]! * a[6]! - a[8]! * a[2]! * a[5]!
  const det = a[0]! * inv[0] + a[1]! * inv[4] + a[2]! * inv[8] + a[3]! * inv[12]
  for (let i = 0; i < 16; i++) out[i] = inv[i] / (det || 1)
}

// ------------------------------------------------------------------ passes

type GpuMesh = { buffer: GPUBuffer; count: number; indexed?: { vertices: GPUBuffer; indices: GPUBuffer } } | null
const gpuMesh = (device: GPUDevice, data: ArrayBuffer, indexed = false): GpuMesh => {
  if (!data.byteLength) return null
  const buffer = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
  device.queue.writeBuffer(buffer, 0, data)
  // Shadow casters still consume the expanded buffer; indexing is raster-only.
  const mesh: NonNullable<GpuMesh> = { buffer, count: data.byteLength / 32 }
  if (indexed) {
    const packed = indexForestMesh(data)
    const vertices = device.createBuffer({ size: packed.vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    const indices = device.createBuffer({ size: packed.indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST })
    device.queue.writeBuffer(vertices, 0, packed.vertices); device.queue.writeBuffer(indices, 0, packed.indices)
    mesh.indexed = { vertices, indices }
  }
  return mesh
}

const INSTANCE_LAYOUT: GPUVertexBufferLayout = { arrayStride: INSTANCE_FLOATS * 4, stepMode: "instance", attributes: [{ shaderLocation: 8, offset: 0, format: "float32x4" }, { shaderLocation: 9, offset: 16, format: "float32x4" }] }

/**
 * Draws the forest: baked chunk geometry (terrain, logs, camp) near or far by distance, every template's visible
 * instances near or far, and the water, through four pipelines (baked or instanced × opaque or cut-out with
 * alpha-to-coverage) over one bind group of texture arrays.
 */
class ForestPass implements ScenePass {
  private pipes: Record<"opaque" | "masked" | "maskedDepth" | "treeOpaque" | "treeMasked" | "treeMaskedDepth" | "maskedSingle" | "treeMaskedSingle", GPURenderPipeline>
  private group: GPUBindGroup
  private templates: { near: { opaque: GpuMesh; masked: GpuMesh }; far: { opaque: GpuMesh; masked: GpuMesh } | null; nearDist: number; maxDist: number; kind: string }[]
  private chunks: { box: readonly number[]; cx: number; cz: number; near: { opaque: GpuMesh; masked: GpuMesh }; far: { opaque: GpuMesh; masked: GpuMesh }; groups: { template: number; data: Float32Array }[] }[]
  private water: GpuMesh
  private instanceBuf: GPUBuffer
  private field: GPUTexture
  private instanceData = new Float32Array(INSTANCE_FLOATS * 4096)
  private draws: { mesh: NonNullable<GpuMesh>; masked: boolean; first: number; count: number; hidden: number; prefix: { d: number; end: number }[]; template: number; near: boolean; kind: string }[] = []
  private statics: { mesh: NonNullable<GpuMesh>; masked: boolean; near: boolean; chunk: number; d: number; inView: boolean }[] = []
  private trunkGrid = new Map<number, number[]>()
  readonly stats = { chunks: 0, instances: 0, drawCalls: 0, triangles: 0 }
  /** Profiling switches (automation only): draw statics, and each template kind. */
  readonly debug = { statics: true, tree: true, fern: true, rock: true, floor: true, prepass: true, indexed: true }

  constructor(private ctx: PassContext, private build: ForestBuild, textures: ForestTextures, private world: ForestWorld) {
    const d = ctx.device
    const code = makeSceneShader(forestHooks) + treeVertexWgsl + cutoutDepthWgsl
    const module = compileShaderModuleWithLog(d, code, "forest scene")
    const layout = d.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: "2d-array" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: "2d-array" } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: "2d-array" } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      { binding: 5, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
    ] })
    const pipelineLayout = d.createPipelineLayout({ bindGroupLayouts: [ctx.frameLayout, layout] })
    // Cut-outs draw twice: a depth prepass with their coverage, then shading at depth "equal" (no overdraw shading).
    const pipe = (entry: string, instanced: boolean, mode: "opaque" | "depth" | "shade" | "single") => d.createRenderPipeline({
      label: `forest ${entry} ${mode}`,
      layout: pipelineLayout,
      vertex: { module, entryPoint: entry, buffers: instanced ? [TEXTURED_VERTEX_LAYOUT, INSTANCE_LAYOUT] : [TEXTURED_VERTEX_LAYOUT] },
      fragment: { module, entryPoint: mode === "depth" ? "fsCut" : "fsSolid", targets: [{ format: ctx.color, ...(mode === "depth" ? { writeMask: 0 } : {}) }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: { format: ctx.depth, depthWriteEnabled: mode !== "shade", depthCompare: mode === "shade" ? "equal" : ctx.depthCompare ?? "less-equal" },
      multisample: { count: ctx.samples, alphaToCoverageEnabled: mode !== "opaque" && ctx.samples > 1 },
    })
    this.pipes = {
      opaque: pipe("vsStatic", false, "opaque"), masked: pipe("vsStatic", false, "shade"), maskedDepth: pipe("vsStatic", false, "depth"),
      treeOpaque: pipe("vsTree", true, "opaque"), treeMasked: pipe("vsTree", true, "shade"), treeMaskedDepth: pipe("vsTree", true, "depth"),
      maskedSingle: pipe("vsStatic", false, "single"), treeMaskedSingle: pipe("vsTree", true, "single"),
    }
    const field = this.field = d.createTexture({ size: [build.fieldSize, build.fieldSize], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST })
    d.queue.writeTexture({ texture: field }, build.field as Uint8Array<ArrayBuffer>, { bytesPerRow: build.fieldSize * 4 }, [build.fieldSize, build.fieldSize])
    this.group = d.createBindGroup({ layout, entries: [
      { binding: 0, resource: textures.base.createView({ dimension: "2d-array" }) },
      { binding: 1, resource: textures.normal.createView({ dimension: "2d-array" }) },
      { binding: 2, resource: textures.orm.createView({ dimension: "2d-array" }) },
      { binding: 3, resource: d.createSampler({ magFilter: "linear", minFilter: "linear", mipmapFilter: "linear", addressModeU: "repeat", addressModeV: "repeat", maxAnisotropy: 8 }) },
      { binding: 4, resource: field.createView() },
      { binding: 5, resource: d.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" }) },
    ] })
    const pair = (m: { opaque: ArrayBuffer; masked: ArrayBuffer }, indexed = false) => ({ opaque: gpuMesh(d, m.opaque, indexed), masked: gpuMesh(d, m.masked, indexed) })
    this.templates = build.templates.map(t => ({ near: pair(t.near, true), far: t.far ? pair(t.far, true) : null, nearDist: t.nearDist, maxDist: t.maxDist, kind: t.kind }))
    this.chunks = build.chunks.map(c => ({ box: c.box, cx: c.x + CHUNK / 2, cz: c.z + CHUNK / 2, near: pair(c.near), far: pair(c.far), groups: c.groups }))
    this.water = gpuMesh(d, build.water)
    this.instanceBuf = d.createBuffer({ size: this.instanceData.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    for (let i = 0; i < build.trunks.length; i += 4) {
      const k = this.cell(build.trunks[i]!, build.trunks[i + 1]!)
      let list = this.trunkGrid.get(k)
      if (!list) this.trunkGrid.set(k, (list = []))
      list.push(i)
    }
  }

  private cell(x: number, z: number) { return (Math.floor(x / 4) + 1000) * 4096 + Math.floor(z / 4) + 1000 }

  dispose() {
    this.instanceBuf.destroy()
    this.field.destroy()
    const meshes = [this.water, ...this.templates.flatMap(t => [t.near.opaque, t.near.masked, t.far?.opaque ?? null, t.far?.masked ?? null]), ...this.chunks.flatMap(c => [c.near.opaque, c.near.masked, c.far.opaque, c.far.masked])]
    for (const m of meshes) { m?.buffer.destroy(); m?.indexed?.vertices.destroy(); m?.indexed?.indices.destroy() }
  }

  /**
   * Picks what to draw from `eye`: chunks in the view frustum, each template's instances near or far. Each draw's
   * instances are sorted nearest chunk first and keep a distance prefix, so shadow casters can take only the near ones.
   */
  update(eye: Vec3, viewProj: Float32Array, q: ForestQuality, s: ForestLookSettings) {
    const planes = frustumPlanes(viewProj)
    const lists = this.templates.map(() => ({ near: [] as { d: number; data: Float32Array }[], far: [] as { d: number; data: Float32Array }[] }))
    this.statics.length = 0
    let visible = 0
    const scatterShare = q.scatter * Math.min(1, s.fernDensity)
    for (let ci = 0; ci < this.chunks.length; ci++) {
      const c = this.chunks[ci]!
      const dx = Math.max(Math.abs(eye[0] - c.cx) - CHUNK / 2, 0), dz = Math.max(Math.abs(eye[2] - c.cz) - CHUNK / 2, 0)
      const d = Math.hypot(dx, dz)
      // Chunks round the eye stay in even when out of view: they cast the torch's shadows into it.
      const inView = boxInFrustum(planes, c.box)
      if (!inView && d > 0) continue
      if (d > q.far + 260) continue
      if (inView) visible++
      const nearStatic = d < 70 && (c.near.opaque || c.near.masked)
      const set = nearStatic ? c.near : c.far
      if (set.opaque) this.statics.push({ mesh: set.opaque, masked: false, near: !!nearStatic, chunk: ci, d, inView })
      if (set.masked) this.statics.push({ mesh: set.masked, masked: true, near: !!nearStatic, chunk: ci, d, inView })
      for (const g of c.groups) {
        const t = this.templates[g.template]!
        // Trees past ~240 m (High) are behind trunks and mist; the terrain still runs to the horizon.
        if (d > (t.kind === "tree" ? q.far + 100 : t.maxDist * (t.kind === "fern" || t.kind === "floor" ? Math.max(0.6, q.near / 35) : 1))) continue
        const near = !t.far || (t.kind === "tree" ? d < q.near : t.kind === "fern" ? d < q.fernNear : true)
        let data = g.data
        if ((t.kind === "fern" && scatterShare < 0.999) || (t.kind === "floor" && q.scatter < 0.999)) {
          // Thin the scatter by each instance's phase: the same ferns stay as density changes.
          const keep: number[] = []
          const share = t.kind === "fern" ? scatterShare : q.scatter
          for (let i = 0; i < data.length; i += INSTANCE_FLOATS) if ((data[i + 6]! * 7.13) % 1 < share) for (let k = 0; k < INSTANCE_FLOATS; k++) keep.push(data[i + k]!)
          data = new Float32Array(keep)
        }
        if (t.kind === "fern" && !near && d > q.fernNear + 6) {
          // Past the full-detail ring, keep about half the clumps and grow them: the floor stays covered in the dark.
          const keep: number[] = []
          for (let i = 0; i < data.length; i += INSTANCE_FLOATS) if ((data[i + 6]! * 3.71) % 1 < 0.55) {
            for (let k = 0; k < INSTANCE_FLOATS; k++) keep.push(data[i + k]! * (k === 4 || k === 5 ? 1.25 : 1))
          }
          data = new Float32Array(keep)
        }
        if (!data.length) continue
        ;(near ? lists[g.template]!.near : lists[g.template]!.far).push({ d: inView ? d : -1, data })
      }
    }
    let total = 0
    for (const l of lists) for (const p of [...l.near, ...l.far]) total += p.data.length / INSTANCE_FLOATS
    if (total * INSTANCE_FLOATS > this.instanceData.length) {
      this.instanceData = new Float32Array(Math.ceil(total * 1.5) * INSTANCE_FLOATS)
      this.instanceBuf.destroy()
      this.instanceBuf = this.ctx.device.createBuffer({ size: this.instanceData.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    }
    this.draws.length = 0
    let at = 0, tris = 0
    for (let ti = 0; ti < lists.length; ti++) {
      const l = lists[ti]!, t = this.templates[ti]!
      for (const near of [true, false]) {
        const parts = near ? l.near : l.far
        if (!parts.length) continue
        // Out-of-view chunks (d = −1, shadow casters only) first, then nearest first.
        parts.sort((a, b) => a.d - b.d)
        const first = at
        const prefix: { d: number; end: number }[] = []
        let hidden = 0
        for (const p of parts) {
          this.instanceData.set(p.data, at * INSTANCE_FLOATS)
          at += p.data.length / INSTANCE_FLOATS
          if (p.d < 0) hidden = at - first
          prefix.push({ d: Math.max(0, p.d), end: at - first })
        }
        const count = at - first
        const set = near ? t.near : t.far!
        for (const [mesh, masked] of [[set.opaque, false], [set.masked, true]] as const) {
          if (!mesh) continue
          this.draws.push({ mesh, masked, first, count, hidden, prefix, template: ti, near, kind: t.kind })
          tris += mesh.count / 3 * (count - hidden)
        }
      }
    }
    if (at) this.ctx.device.queue.writeBuffer(this.instanceBuf, 0, this.instanceData.buffer, 0, at * INSTANCE_FLOATS * 4)
    for (const st of this.statics) if (st.inView) tris += st.mesh.count / 3
    Object.assign(this.stats, { chunks: visible, instances: at, drawCalls: this.draws.length + this.statics.length + 1, triangles: Math.round(tris) })
  }

  draw(pass: GPURenderPassEncoder) {
    pass.setBindGroup(1, this.group)
    pass.setVertexBuffer(1, this.instanceBuf)
    const drawn = (d: (typeof this.draws)[number]) => d.count > d.hidden && (this.debug as Record<string, boolean>)[d.kind] !== false
    const phases = this.debug.prepass ? ["opaque", "depth", "shade"] as const : ["opaque", "single"] as const
    for (const phase of phases) {
      const masked = phase !== "opaque"
      pass.setPipeline(phase === "opaque" ? this.pipes.opaque : phase === "depth" ? this.pipes.maskedDepth : phase === "single" ? this.pipes.maskedSingle : this.pipes.masked)
      if (this.debug.statics) for (const s of this.statics) if (s.masked === masked && s.inView) { pass.setVertexBuffer(0, s.mesh.buffer); pass.draw(s.mesh.count) }
      if (phase === "opaque" && this.water) { pass.setVertexBuffer(0, this.water.buffer); pass.draw(this.water.count) }
      pass.setPipeline(phase === "opaque" ? this.pipes.treeOpaque : phase === "depth" ? this.pipes.treeMaskedDepth : phase === "single" ? this.pipes.treeMaskedSingle : this.pipes.treeMasked)
      for (const d of this.draws) if (d.masked === masked && drawn(d)) {
        const indexed = this.debug.indexed ? d.mesh.indexed : undefined
        pass.setVertexBuffer(0, indexed?.vertices ?? d.mesh.buffer)
        if (indexed) pass.setIndexBuffer(indexed.indices, "uint32")
        if (indexed) pass.drawIndexed(d.mesh.count, d.count - d.hidden, 0, 0, d.first + d.hidden)
        else pass.draw(d.mesh.count, d.count - d.hidden, 0, d.first + d.hidden)
      }
    }
  }

  /**
   * Shadow casters for a torch at `pos` (about the eye): baked chunks and instances within reach, ferns, saplings and
   * floor scatter only within `smallReach` (their shadows are short and their triangles many).
   */
  casters(pos: Vec3, reach: number, smallReach: number, mask: SpotShadowMask | null): SpotShadowCaster[] {
    const out: SpotShadowCaster[] = []
    for (const s of this.statics) {
      if (!s.near || (s.masked && !mask)) continue
      const c = this.chunks[s.chunk]!
      if (Math.hypot(Math.max(Math.abs(pos[0] - c.cx) - CHUNK / 2, 0), Math.max(Math.abs(pos[2] - c.cz) - CHUNK / 2, 0)) > reach) continue
      out.push({ buffer: s.mesh.buffer, count: s.mesh.count, stride: 32, ...(s.masked ? { mask: mask! } : {}) })
    }
    for (const d of this.draws) {
      if (!d.near || (d.masked && !mask)) continue
      const limit = d.kind === "tree" || d.kind === "rock" ? reach : smallReach
      let n = 0
      for (const p of d.prefix) { if (p.d > limit) break; n = p.end }
      if (!n) continue
      out.push({ buffer: d.mesh.buffer, count: d.mesh.count, stride: 32, instances: { buffer: this.instanceBuf, count: n, first: d.first }, ...(d.masked ? { mask: mask! } : {}) })
    }
    return out
  }

  /** First thing the ray from `o` along unit `dir` meets within `reach`: terrain, a trunk or a rock. */
  raycast(o: Vec3, dir: Vec3, reach: number) {
    const H = this.world.height
    const tr = this.build.trunks, rk = this.build.rocks
    const ground: [number, number, number] = [0.16, 0.13, 0.1]
    const step = 0.2
    let prev = 0
    for (let t = 0.1; t < reach; t += step * (1 + t * 0.04)) {
      const x = o[0] + dir[0] * t, y = o[1] + dir[1] * t, z = o[2] + dir[2] * t
      const list = this.trunkGrid.get(this.cell(x, z))
      if (list) for (const i of list) {
        const dx = x - tr[i]!, dz = z - tr[i + 1]!, r = tr[i + 2]! * 1.1
        if (dx * dx + dz * dz < r * r && y < tr[i + 3]!) {
          const l = Math.hypot(dx, dz) || 1
          return { hit: true, d: t, point: [x, y, z] as Vec3, normal: [dx / l, 0, dz / l] as Vec3, albedo: [0.2, 0.15, 0.11] as Vec3, albedoLum: 0.155 }
        }
      }
      for (let i = 0; i < rk.length; i += 4) {
        const dx = x - rk[i]!, dy = y - rk[i + 1]!, dz = z - rk[i + 2]!, r = rk[i + 3]!
        if (Math.abs(dx) < r && Math.abs(dz) < r && dx * dx + dy * dy + dz * dz < r * r) {
          const l = Math.hypot(dx, dy, dz) || 1
          return { hit: true, d: t, point: [x, y, z] as Vec3, normal: [dx / l, dy / l, dz / l] as Vec3, albedo: [0.2, 0.21, 0.16] as Vec3, albedoLum: 0.205 }
        }
      }
      const h = H(x, z)
      if (y < h) {
        // Refine between the last step and this one.
        let a = prev, b = t
        for (let k = 0; k < 6; k++) { const m = (a + b) / 2; if (o[1] + dir[1] * m < H(o[0] + dir[0] * m, o[2] + dir[2] * m)) b = m; else a = m }
        const px = o[0] + dir[0] * b, pz = o[2] + dir[2] * b
        const nx = H(px - 0.3, pz) - H(px + 0.3, pz), nz = H(px, pz - 0.3) - H(px, pz + 0.3), l = Math.hypot(nx, 0.6, nz)
        return { hit: true, d: b, point: [px, H(px, pz), pz] as Vec3, normal: [nx / l, 0.6 / l, nz / l] as Vec3, albedo: ground, albedoLum: 0.135 }
      }
      prev = t
    }
    return { hit: false, d: reach, point: [o[0] + dir[0] * reach, o[1] + dir[1] * reach, o[2] + dir[2] * reach] as Vec3, normal: [0, 1, 0] as Vec3, albedo: ground, albedoLum: 0.135 }
  }
}

function boxInFrustum(planes: number[][], b: readonly number[]): boolean {
  for (const p of planes) {
    const x = p[0]! >= 0 ? b[3]! : b[0]!, y = p[1]! >= 0 ? b[4]! : b[1]!, z = p[2]! >= 0 ? b[5]! : b[2]!
    if (p[0]! * x + p[1]! * y + p[2]! * z + p[3]! < 0) return false
  }
  return true
}

class SkyPass implements ScenePass {
  private pipe: GPURenderPipeline
  constructor(ctx: PassContext) {
    const d = ctx.device
    const module = compileShaderModuleWithLog(d, skyShader, "forest sky")
    this.pipe = d.createRenderPipeline({
      layout: d.createPipelineLayout({ bindGroupLayouts: [ctx.frameLayout] }),
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: [{ format: ctx.color }] },
      primitive: { topology: "triangle-list" },
      depthStencil: { format: ctx.depth, depthWriteEnabled: false, depthCompare: "always" },
      multisample: { count: ctx.samples },
    })
  }
  draw(pass: GPURenderPassEncoder) { pass.setPipeline(this.pipe); pass.draw(3) }
}

class MotePass implements ScenePass {
  private pipe: GPURenderPipeline
  private reactivePipe?: GPURenderPipeline
  private readonly descriptor: GPURenderPipelineDescriptor
  count = 700
  constructor(private readonly ctx: PassContext) {
    const d = ctx.device
    const module = compileShaderModuleWithLog(d, moteShader, "forest motes")
    this.descriptor = {
      layout: d.createPipelineLayout({ bindGroupLayouts: [ctx.frameLayout] }),
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: [{ format: ctx.color, blend: { color: { srcFactor: "one", dstFactor: "one" }, alpha: { srcFactor: "zero", dstFactor: "one" } } }] },
      primitive: { topology: "triangle-list" },
      depthStencil: { format: ctx.depth, depthWriteEnabled: false, depthCompare: ctx.depthCompare ?? "less-equal" },
      multisample: { count: ctx.samples },
    }
    this.pipe = d.createRenderPipeline(this.descriptor)
  }
  draw(pass: GPURenderPassEncoder) { pass.setPipeline(this.pipe); pass.draw(6, this.count) }
  /** Dust drifts independently: under TAA it goes into the reactive mask, so it doesn't ghost. */
  drawReactive(pass: GPURenderPassEncoder) {
    if (this.count <= 0) return
    this.reactivePipe ??= this.ctx.device.createRenderPipeline(reactivePipelineDescriptor(this.descriptor))
    pass.setPipeline(this.reactivePipe)
    pass.draw(6, this.count)
  }
}

export { TAU }
