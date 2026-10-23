import { LOOK_PRESETS, LOOK_PRESET_IDS, applyLookPreset, createLookSettings, resolveLookPresetId, type LookSettings } from "../../gpu/look"
import { applyFoliagePreset, cloneFoliageParams, type FoliageKind, type FoliageParams } from "../../gpu/foliage"
import { lampFlicker } from "../../gpu/lights/flicker"
import { createSkySettings, SKY_DEFAULTS, type SkySettings } from "../../sky/settings"
import { attachSky } from "../../sky/controller"
import { EyeAdaptation, EXPOSURE_DEFAULTS, type ExposureSettings } from "../../weather/exposure"
import { RAIN_LIGHTING_DEFAULTS, type RainLightingSettings } from "../../weather/rain-lighting"
import { BEAM_PROFILES, beamReach, packBeamProfile, type BeamProfileId } from "../../gpu/lights/beam"
import { packPhysicalLightKnobs, physicalLightHooks, type LightModel } from "../../gpu/lights/physical"
import { Renderer, type FrameInput } from "../../gpu/renderer"
import { SpotShadows, type SpotCandidate } from "../../gpu/shadows/spot-shadows"
import { VERT_BYTES } from "../../gpu/mesh"
import { SceneLights, flatLighting, newSceneFrame, packSceneFrame, type SceneLight } from "../../gpu/scene-frame"
import { makeSceneShader, postShader, spriteShader, type SceneHooks } from "../../gpu/shaders"
import { customPostGradeWgsl } from "../../gpu/post-uniform"
import { WEAR_DEFAULTS, type WearSettings } from "../../gpu/materials/wear"
import { loadFinishScans, type FinishScanArray } from "../../gpu/materials/wear-scans"
import { LAB_FINISH_FLOATS, LAB_SCANS, labFinishHooks, packLabFinish } from "./finish"
import { WEATHER_PRESET_IDS, WeatherSimulation, applyWeatherPreset, createWeatherSettings, resolveWeatherPresetId, type WeatherLight, type WeatherSettings } from "../../weather"
import type { LabContext } from "../types"
import { cagedBulb, fluorescentTube, ledIndicator } from "../../gpu/lights/practicals"
import { ScreenDisplay, ScreenQuadPass } from "../../gpu/screen/display"
import { screenBounceSource, screenSceneLight } from "../../gpu/screen/light"
import { ScreenProgramme, type ProgrammeKind } from "../../gpu/screen/programme"
import { createScreenDisplaySettings, type ScreenDisplaySettings } from "../../gpu/screen/settings"
import { BAKED_GI_STRUCT_FIELDS_WGSL, BAKED_GI_UNIFORM_FLOATS, HOUSE_LIGHTMAP_META, bakedLightmapHooks, packBakedLightmapUniforms, uploadBakedLightmapTexture, type BakedGiMode, type BakedLightmapGpu } from "../../gpu/gi/lightmap"
import { CAR_PAINTS, FLOOR, LAMP, LAMP_COUNT, SCREEN_AT, SCREEN_BAKE_REFERENCE, SCREEN_BULB, SCREEN_LEDS, SCREEN_LIGHT_ID, SCREEN_ROOM, SCREEN_TUBE, WALL_PAINTS, WORLD_CAMERA, WORLD_BOUNCE, WORLD_FOCUS, WORLD_LIGHT_ID, buildWorld, worldClock, worldLights, type CarPaint, type WallPaint, type WorldClock, type WorldFlicker, type WorldGeometry } from "./scene"
export { SCREEN_LIGHT_ID } from "./scene"

/**
 * The Lab's base debug world, drawn by the kit `Renderer` (the one Brawl and Blackout ship) with the kit look,
 * weather and floor materials and the production foliage generators. One instance per Lab: the Look and world lab
 * edits it and the Effects lab draws its particles and smoke into it, so every look, light, weather and effect is
 * judged on the same few metres of street.
 */
export type WorldState = {
  hour: number
  playing: boolean
  timeScale: number
  lampPower: number
  porch: boolean
  headlights: boolean
  flashlight: boolean
  street: number
  walk: number
  path: number
  floor: number
  wall: WallPaint
  car: CarPaint
  tree: boolean
  bush: boolean
  grass: boolean
  seed: number
  /** Today (the kit's top-down light model) or physical lights and surfaces (`gpu/lights/physical.ts`). */
  lightModel: LightModel
  envSpecular: number
  sphereLights: number
  specularAA: number
  /** Perspective shadow maps for the nearest spot lights under Physical (`gpu/shadows/spot-shadows.ts`); 0 is Today. */
  spotShadows: number
  /** The flashlight's torch profile under Physical (`gpu/lights/beam.ts`). */
  beamProfile: BeamProfileId
  /** Shared lamp flicker and failure (`gpu/lights/flicker.ts`): streetlamp sodium, porch tube, lamp inside a bulb. */
  flicker: number
  /** Sun or moon and sky light, × (0 for a room lit only by its own lamps). */
  skyLight: number
  /** Camera exposure compensation, stops. */
  exposureEV: number
  /**
   * The grade's navy shadow lift (`postShader`), × (Physical only). 1 is the kit's grade; the screen bench's dark room
   * sets 0 so unlit corners read black instead of a milky navy.
   */
  shadowLift: number
  /** The lens bloom's strength, × (Physical only). The screen bench turns it down so a bright picture glows round its glass, not across the room. */
  lensBloom: number
  /** The screen bench inside the house (`gpu/screen/`): a CRT on a workbench, its picture lighting the room. */
  screen: boolean
  /** What the screen bench's television shows. */
  programme: ProgrammeKind
  /** A failing fluorescent tube over the bench (`gpu/lights/practicals.ts`). */
  tube: boolean
  /** A caged bulb on the wall beside the bench. */
  bulb: boolean
  /** A row of finished props on the driveway, one per wear look (`gpu/finish`); with the albedo check, the world draws its finish variant. */
  finishProps: boolean
  /** Today (flat bounce fill) or Cycles per-light baked lightmaps + L1 SH probes (`gpu/gi/lightmap.ts`). */
  giMode: BakedGiMode
  giIntensity: number
  giProbes: number
}

export const WORLD_DEFAULTS: Readonly<WorldState> = {
  hour: 13,
  playing: true,
  timeScale: 0,
  lampPower: 1,
  porch: true,
  headlights: false,
  flashlight: false,
  street: FLOOR.wetAsphalt,
  walk: FLOOR.sidewalk,
  path: FLOOR.flagstone,
  floor: FLOOR.planks,
  wall: "clapboard",
  car: "red",
  tree: true,
  bush: true,
  grass: true,
  seed: 7,
  lightModel: "today",
  envSpecular: 1,
  sphereLights: 1,
  specularAA: 1,
  spotShadows: 0,
  beamProfile: "darkwood",
  flicker: 0,
  skyLight: 1,
  exposureEV: 0,
  shadowLift: 1,
  lensBloom: 1,
  screen: false,
  programme: "show",
  tube: false,
  bulb: false,
  finishProps: false,
  giMode: "today",
  giIntensity: 1,
  giProbes: 1,
}

/** World keys whose change rebuilds the mesh (everything else is per frame). */
const STRUCTURAL = new Set<string>(["street", "walk", "path", "floor", "wall", "car", "tree", "bush", "grass", "seed", "screen", "tube", "bulb", "finishProps", "giMode"])

/** Scales the sun or moon and the sky ambient (the screen bench's dark room turns them down). */
function skyScaled(clock: WorldClock, k: number): WorldClock {
  if (k === 1) return clock
  return { ...clock, ambient: [clock.ambient[0] * k, clock.ambient[1] * k, clock.ambient[2] * k, clock.ambient[3] * k], key: { ...clock.key, power: clock.key.power * k } }
}

export type DebugWorld = {
  readonly state: WorldState
  readonly look: LookSettings
  readonly weather: WeatherSettings
  readonly sky: SkySettings
  readonly exposure: ExposureSettings
  readonly rainLighting: RainLightingSettings
  readonly vegetation: FoliageParams
  /** The screen bench television's display settings (the Screen tab). */
  readonly screen: ScreenDisplaySettings
  /** Wear knobs and the albedo validator for the finish variant (`finish.ts`). */
  readonly wear: WearSettings
  /** Runs the television's degauss coil. */
  degauss(): void
  setLook(preset: string): void
  setWeather(preset: string): void
  setVegetation(kind: FoliageKind, preset: string): void
  /** Marks the mesh for a rebuild before the next frame (structural keys, vegetation). */
  invalidate(key?: string): void
  /** Restores every knob to the defaults: Clear day, Current look, Oak, Lawn. */
  reset(): void
  /** Fires a lightning strike now (Weather). */
  strike(): void
  /** Points the Lab camera at the set, or at a spot in it (an effect's origin). */
  frame(at?: { x: number; z: number; dist?: number }): void
  update(dt: number): void
  /**
   * `Stage.customRender`: draws the world (and the Lab's particles and smoke) into the Stage output. With `measure`,
   * also times one isolated frame with the renderer's timestamp queries and returns its GPU ms.
   */
  render(width: number, height: number, outputView: GPUTextureView, measure?: boolean): Promise<number | null> | null
  telemetry(): string
}

export function createDebugWorld(context: LabContext): DebugWorld {
  const { device, stage } = context
  const state: WorldState = { ...WORLD_DEFAULTS }
  const look = createLookSettings("current")
  const weather = createWeatherSettings("clear")
  const sky = createSkySettings()
  const exposure = { ...EXPOSURE_DEFAULTS }, rainLighting = { ...RAIN_LIGHTING_DEFAULTS }
  const eyeAdaptation = new EyeAdaptation()
  let exposureMultiplier = 1
  const vegetation = cloneFoliageParams()
  applyFoliagePreset("tree", "oak", vegetation)
  applyFoliagePreset("bush", "hedge", vegetation)
  applyFoliagePreset("grass", "lawn", vegetation)

  const wear: WearSettings = { ...WEAR_DEFAULTS }
  // The finish variant (wear and the albedo validator) compiles only while something needs it.
  const finishOn = () => state.finishProps || wear.albedoCheck
  const renderers: Partial<Record<`${LightModel}${"" | "+finish" | ":baked"}`, Renderer>> = {}
  const skies = new Map<Renderer, ReturnType<typeof attachSky>>()
  const drawn = new Map<Renderer, WorldGeometry>()
  // The `skyLight` each renderer's flat bounce fill was last scaled for (the level uploads it at 1).
  const bounceScale = new Map<Renderer, number>()
  let geometry: WorldGeometry | null = null
  let dirty = true
  let time = 0
  const lights = new SceneLights()
  const frame = newSceneFrame()
  const lampPower = new Float32Array(8)
  const sim = new WeatherSimulation(7)
  const focusXZ: [number, number] = [WORLD_FOCUS[0], WORLD_FOCUS[2]]
  const emptySprites = new Float32Array(0) as Float32Array<ArrayBuffer>

  const knobs = new Float32Array(12) as Float32Array<ArrayBuffer>
  const knobsGi = new Float32Array(BAKED_GI_UNIFORM_FLOATS) as Float32Array<ArrayBuffer>
  let bakedGi: BakedLightmapGpu | null = null
  const ensureBakedGi = () => {
    if (!bakedGi) bakedGi = uploadBakedLightmapTexture(device)
    return bakedGi
  }
  const finishKnobs = new Float32Array(LAB_FINISH_FLOATS) as Float32Array<ArrayBuffer>
  // The props' CC0 scans, loaded on the first finish renderer and bound to every one.
  let scans: FinishScanArray | null = null
  let scansLoading = false
  const finishRenderers = new Set<Renderer>()
  const screenSettings = createScreenDisplaySettings()
  let display: ScreenDisplay | null = null
  let programme: ScreenProgramme | null = null
  const quads = new Map<Renderer, ScreenQuadPass>()
  let screenDt = 0
  // The display clock when the programme last started from the top (a reset or preset restarts the show).
  let showFrom = 0
  const ensureDisplay = () => {
    if (!display) {
      display = new ScreenDisplay(device, { settings: screenSettings, label: "lab screen" })
      programme = new ScreenProgramme(state.programme)
      display.setSource(programme.source)
    }
    return display
  }
  const ensureRenderer = () => {
    const model = state.lightModel, finish = finishOn()
    const useBakedGi = !finish && model === "physical" && state.giMode === "baked"
    const key = finish ? (`${model}+finish` as const) : useBakedGi ? ("physical:baked" as const) : model
    const have = renderers[key]
    if (have) return have
    const format = navigator.gpu.getPreferredCanvasFormat()
    const canvas = document.createElement("canvas")
    canvas.width = 16
    canvas.height = 16
    const ctx = canvas.getContext("webgpu")!
    ctx.configure({ device, format, alphaMode: "opaque" })
    // Physical swaps only the scene shader; Today's baseline is the same shader without the hooks.
    const physical = physicalLightHooks({ knobs: "PK.k", spotShadows: true, beam: { a: "PK.beamA", b: "PK.beamB" }, rect: true, panel: true })
    const physicalScene: SceneHooks = { ...physical, lampGrid: false }
    const r = finish
      ? new Renderer(device, ctx, format, {
          scene: makeSceneShader(model === "physical" ? labFinishHooks(physicalScene, true) : labFinishHooks({ lampGrid: false }, false), false),
          sprite: spriteShader(),
          ...(model === "physical" ? { post: WORLD_POST } : {}),
        })
      : useBakedGi
      ? new Renderer(device, ctx, format, {
          scene: makeSceneShader(
            bakedLightmapHooks({
              ...physicalScene,
              declarations: `struct PhysicalKnobs { k: vec4f, beamA: vec4f, beamB: vec4f, ${BAKED_GI_STRUCT_FIELDS_WGSL} }\n@group(0) @binding(13) var<uniform> PK: PhysicalKnobs;\n${physical.declarations}`,
            }),
            false,
          ),
          sprite: spriteShader(),
          post: WORLD_POST,
        })
      : model === "physical"
      ? new Renderer(device, ctx, format, {
          scene: makeSceneShader({ ...physicalScene, declarations: `struct PhysicalKnobs { k: vec4f, beamA: vec4f, beamB: vec4f }\n@group(0) @binding(13) var<uniform> PK: PhysicalKnobs;\n${physical.declarations}` }, false),
          sprite: spriteShader(),
          post: WORLD_POST,
        })
      : new Renderer(device, ctx, format)
    renderers[key] = r
    if (useBakedGi) {
      r.setDetailTextureArray(ensureBakedGi().view)
    } else if (finish) {
      finishRenderers.add(r)
      if (scans) r.setDetailTextureArray(scans.view)
      else if (!scansLoading) {
        scansLoading = true
        void loadFinishScans(device, LAB_SCANS).then(s => {
          scans = s
          for (const fr of finishRenderers) fr.setDetailTextureArray(s.view)
        }, err => console.warn("finish scans failed to load; wear draws without scan detail", err))
      }
    }
    skies.set(r, attachSky(r, sky))
    return r
  }

  let spots: SpotShadows | null = null
  let casters: { buffer: GPUBuffer; count: number; stride: number } | null = null
  const spotBound = new Set<Renderer>()
  let lastSpotUpdate = 0
  let bakedRoom = false
  const rebuild = () => {
    if (state.giMode === "baked") bakedRoom = true
    geometry = buildWorld({ ...state, vegetation, bakedRoom })
    lights.setBoxes(geometry.boxes)
    casters?.buffer.destroy()
    casters = null
    spots?.picker.invalidate()
    dirty = false
  }

  const spotTelemetry = () => (spots && state.lightModel === "physical" && state.spotShadows > 0
    ? JSON.stringify({ slots: spots.picker.slots.map((s) => s.id), rendered: spots.rendered })
    : "0")

  const shadowSpots = (r: Renderer, scene: readonly SceneLight[]) => {
    if (!spots) spots = new SpotShadows(device, { count: state.spotShadows })
    spots.settings.count = state.spotShadows
    if (!casters) {
      const data = geometry!.level.chunks[0]!.data
      const buffer = device.createBuffer({ size: Math.max(64, data.byteLength), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST, label: "world spot shadow casters" })
      device.queue.writeBuffer(buffer, 0, data)
      casters = { buffer, count: data.byteLength / VERT_BYTES, stride: VERT_BYTES }
    }
    const candidates: SpotCandidate[] = []
    for (const l of scene) {
      if (l.id === undefined) continue
      const pos = [l.x, l.h, l.y] as const
      // Wide lobes (a screen's cosine spot) have no useful perspective map.
      if (l.spot && l.spot.cosOuter > 0.17) candidates.push({ id: l.id, pos, axis: l.spot.axis, cosOuter: l.spot.cosOuter, range: l.r, intensity: l.r * l.r })
      else if (l.beam) candidates.push({ id: l.id, pos, axis: l.beam.axis, cosOuter: Math.cos(Math.min(beamReach(l.beam.halfAngle, BEAM_PROFILES[state.beamProfile]), 1.45)), range: l.r, intensity: l.r * l.r })
    }
    const enc = device.createCommandEncoder({ label: "world spot shadows" })
    const now = performance.now()
    const dt = Math.min(Math.max((now - lastSpotUpdate) / 1000, 0), 0.25)
    lastSpotUpdate = now
    const rebind = spots.update(enc, candidates, [stage.eye[0]!, stage.eye[1]!, stage.eye[2]!], dt, (id) => lights.indexOf(id), [casters])
    device.queue.submit([enc.finish()])
    if (rebind) spotBound.clear()
    if (!spotBound.has(r)) {
      r.setSpotShadows(spots.bindings())
      spotBound.add(r)
    }
  }

  const extraLights = (): SceneLight[] => {
    // Effect flashes (explosions, muzzle fire) the Effects section hands the Stage, as extra point lights.
    const out: SceneLight[] = []
    for (const l of stage.dynamicLights ?? []) {
      if (l.power <= 0.01 || out.length >= 6) continue
      out.push({ x: l.x, y: l.z, h: Math.max(l.shadowed ? 0.05 : 0.3, l.y), r: Math.max(2, l.radius), color: [l.r, l.g, l.b], power: Math.min(3, l.power * 0.6), size: l.shadowed ? 0.08 : 0.4, ...(l.shadowed ? {} : { unshadowed: true }) })
    }
    return out
  }

  const bench = { tube: 0, bulb: 0, tvLed: 0, deckLed: 0 }
  /** The screen bench's lights this frame (and its fixtures' glow), and its glass drawn into renderer `r`. */
  const screenBench = (r: Renderer): SceneLight[] => {
    bench.tube = bench.bulb = bench.tvLed = bench.deckLed = 0
    for (const [renderer, quad] of quads) quad.visible = state.screen && renderer === r
    if (!state.screen) return []
    const d = ensureDisplay()
    if (!quads.has(r)) {
      const quad = new ScreenQuadPass(r.passContext, d, { ...SCREEN_AT, room: SCREEN_ROOM })
      r.addPass("opaque", quad)
      quads.set(r, quad)
    }
    programme!.kind = state.programme
    programme!.paint(d.time - showFrom)
    d.update(screenDt)
    screenDt = 0
    const model = state.lightModel === "physical" ? "physical" : "today"
    const out: SceneLight[] = []
    const add = (l: SceneLight | null, id: number) => { if (l) out.push({ ...l, id }) }
    add(screenSceneLight(d, SCREEN_AT, { model }), SCREEN_LIGHT_ID.screen)
    if (state.tube) {
      const t = fluorescentTube(SCREEN_TUBE, time, model)
      add(t.light, SCREEN_LIGHT_ID.tube)
      bench.tube = t.emissive
    }
    if (state.bulb) {
      const b = cagedBulb(SCREEN_BULB, time)
      add(b.light, SCREEN_LIGHT_ID.bulb)
      bench.bulb = b.emissive
    }
    const tv = ledIndicator(SCREEN_LEDS.tv, time), deck = ledIndicator(SCREEN_LEDS.deck, time), act = ledIndicator(SCREEN_LEDS.deckActivity, time)
    bench.tvLed = screenSettings.power ? tv.emissive : 0
    bench.deckLed = Math.max(deck.emissive, act.emissive)
    if (screenSettings.power) add(tv.light, SCREEN_LIGHT_ID.tvLed)
    add(deck.light, SCREEN_LIGHT_ID.deckLed)
    add(act.light, SCREEN_LIGHT_ID.deckActivity)
    return out
  }

  const world: DebugWorld = {
    state,
    look,
    weather,
    sky,
    exposure,
    rainLighting,
    vegetation,
    screen: screenSettings,
    wear,
    degauss() {
      display?.degauss()
    },
    setLook(preset) {
      const id = resolveLookPresetId(preset)
      if (!id) throw new Error(`Unknown look preset "${preset}". Valid presets: ${LOOK_PRESET_IDS.join(", ")}.`)
      applyLookPreset(look, id)
    },
    setWeather(preset) {
      const id = resolveWeatherPresetId(preset)
      if (!id) throw new Error(`Unknown weather preset "${preset}". Valid presets: ${WEATHER_PRESET_IDS.join(", ")}.`)
      applyWeatherPreset(weather, id)
    },
    setVegetation(kind, preset) {
      applyFoliagePreset(kind, preset, vegetation)
      dirty = true
    },
    invalidate(key) {
      if (state.giMode === "baked") bakedRoom = true
      if (!key || STRUCTURAL.has(key) || key in vegetation) dirty = true
    },
    reset() {
      Object.assign(state, WORLD_DEFAULTS)
      bakedRoom = false
      applyLookPreset(look, "current")
      applyWeatherPreset(weather, "clear")
      Object.assign(sky, SKY_DEFAULTS)
      Object.assign(exposure, EXPOSURE_DEFAULTS)
      Object.assign(rainLighting, RAIN_LIGHTING_DEFAULTS)
      eyeAdaptation.reset(); exposureMultiplier = 1
      Object.assign(screenSettings, createScreenDisplaySettings())
      Object.assign(wear, WEAR_DEFAULTS)
      display?.power.reset(screenSettings.power)
      showFrom = display?.time ?? 0
      Object.assign(vegetation, cloneFoliageParams())
      applyFoliagePreset("tree", "oak", vegetation)
      applyFoliagePreset("bush", "hedge", vegetation)
      applyFoliagePreset("grass", "lawn", vegetation)
      dirty = true
    },
    strike() {
      sim.strikeNow()
    },
    frame(at) {
      stage.camYaw = WORLD_CAMERA.yaw
      stage.camPitch = WORLD_CAMERA.pitch
      if (at) stage.frameTarget(at.x, 0.9, at.z, at.dist ?? 15)
      else stage.frameTarget(WORLD_FOCUS[0], WORLD_FOCUS[1], WORLD_FOCUS[2], WORLD_CAMERA.dist)
    },
    update(dt) {
      if (!state.playing) return
      time += dt
      screenDt += dt
      if (state.timeScale > 0) state.hour = (state.hour + (dt * state.timeScale) / 3600) % 24
      sim.step(dt, weather, [stage.eye[0]!, stage.eye[1]!, stage.eye[2]!], focusXZ)
      // Relative flash stimulus, not measured scene luminance. No shadow lift by default.
      exposureMultiplier = eyeAdaptation.step({ dt, luminance: 1 + sim.state.flash * 48, referenceLuminance: 1 }, exposure).multiplier
    },
    render(width, height, outputView, measure) {
      const r = ensureRenderer()
      if (dirty || !geometry) rebuild()
      if (drawn.get(r) !== geometry) {
        r.setLevel(geometry!.level)
        drawn.set(r, geometry!)
        bounceScale.set(r, 1)
      }
      if (bounceScale.get(r) !== state.skyLight) {
        // The fill is daylight returned off the ground, so it dims with the sky (the shader squares the map).
        const k = Math.sqrt(Math.max(0, state.skyLight))
        const { bounce } = flatLighting(0, 1, WORLD_BOUNCE.map(v => Math.min(1, v * k)) as [number, number, number])
        r.updateBounce(bounce.data as Uint8Array<ArrayBuffer>, bounce.w, bounce.h)
        bounceScale.set(r, state.skyLight)
      }
      r.resize(width, height)
      const clock = skyScaled(worldClock(state.hour), state.skyLight)
      skies.get(r)!.update({ time, localHour: state.hour, daylight: clock.day, sceneUnitsPerCdM2: 1 })
      if (state.giMode === "baked") bakedRoom = true
      const flick = worldFlicker(state.flicker, time)
      const scene = [
        ...worldLights(clock, { lampPower: state.lampPower, headlights: state.headlights, flashlight: state.flashlight, porch: state.porch, flicker: flick, physical: state.lightModel === "physical", bakedRoom }),
        ...extraLights(),
        ...screenBench(r),
      ]
      if (state.lightModel === "physical") {
        if (state.giMode === "baked" && !finishRenderers.has(r)) {
          packPhysicalLightKnobs({ model: "physical", specularAA: state.specularAA, sphereLights: state.sphereLights, envSpecular: state.envSpecular, spill: 0 }, knobsGi)
          packBeamProfile(BEAM_PROFILES[state.beamProfile] ?? BEAM_PROFILES.darkwood, knobsGi, 4)
          const crtBounce = state.screen && display
            ? screenBounceSource(display, SCREEN_LIGHT_ID.screen, SCREEN_BAKE_REFERENCE)
            : { id: SCREEN_LIGHT_ID.screen, scale: () => 0, color: () => [0, 0, 0] as const }
          packBakedLightmapUniforms(knobsGi, HOUSE_LIGHTMAP_META, scene, state, [crtBounce])
          r.setCustomUniforms(knobsGi)
        } else {
          packPhysicalLightKnobs({ model: "physical", specularAA: state.specularAA, sphereLights: state.sphereLights, envSpecular: state.envSpecular, spill: 0 }, knobs)
          packBeamProfile(BEAM_PROFILES[state.beamProfile] ?? BEAM_PROFILES.darkwood, knobs, 4)
          if (!finishRenderers.has(r)) r.setCustomUniforms(knobs)
        }
      }
      lights.update(scene, geometry!.casters)
      if (state.lightModel === "physical") shadowSpots(r, scene)
      packSceneFrame(frame, {
        viewProj: stage.viewProj,
        eye: [stage.eye[0]!, stage.eye[1]!, stage.eye[2]!],
        time,
        width,
        height,
        lightCount: lights.lightCount,
        ambient: clock.ambient,
        mapSize: [40, 40],
        ao: 0.45,
      })
      const lampsOn = clock.lamps * state.lampPower
      lampPower[LAMP.porch] = state.porch ? lampsOn * flick.porch.level : 0
      lampPower[LAMP.street] = lampsOn * flick.street.level
      lampPower[LAMP.interior] = lampsOn * flick.interior.level
      lampPower[LAMP.headlights] = state.headlights ? 1 : 0
      lampPower[LAMP.tube] = bench.tube
      lampPower[LAMP.bulb] = bench.bulb
      lampPower[LAMP.tvLed] = bench.tvLed
      lampPower[LAMP.deckLed] = bench.deckLed
      sim.step(0, weather, [stage.eye[0]!, stage.eye[1]!, stage.eye[2]!], focusXZ)
      // Live switches to Today also reset sensitivity while the Lab's simulation is paused.
      exposureMultiplier = eyeAdaptation.step({ dt: 0, luminance: 1 + sim.state.flash * 48, referenceLuminance: 1 }, exposure).multiplier
      const exposureScale = clock.exposure * exposureMultiplier * 2 ** state.exposureEV
      if (finishRenderers.has(r)) {
        finishKnobs.set(knobs)
        packLabFinish(finishKnobs, wear, exposureScale, scans?.layers ?? null)
        r.setCustomUniforms(finishKnobs)
      }
      const raining = weather.preset !== "clear" || sim.state.flash > 0.001
      const weatherLights: WeatherLight[] = scene.slice(1, 7).map(l => ({ x: l.x, y: l.h, z: l.y, radius: l.r, r: l.color[0], g: l.color[1], b: l.color[2], power: l.power * 1.3, ...(l.cone ? { dx: l.cone[0], dz: l.cone[1], cosHalf: l.cone[2], isCone: true } : {}),
        ...(rainLighting.mode === "volume" ? l.spot || l.beam
          ? { axis: l.spot?.axis ?? l.beam?.axis, isCone: true, cosHalf: l.spot?.cosOuter ?? Math.cos(l.beam!.halfAngle) }
          : l.id === WORLD_LIGHT_ID.street || l.id === WORLD_LIGHT_ID.porch
            ? { axis: [0, -1, 0] as const, cosHalf: Math.cos(l.id === WORLD_LIGHT_ID.street ? 1.1 : 1.3) } : {} : {}) }))
      const effLift = bakedRoom && state.shadowLift === 1 ? 0 : Math.max(0, state.shadowLift)
      const effBloom = bakedRoom && state.lensBloom === 1 ? 0.25 : Math.max(0, state.lensBloom)
      const input: FrameInput = {
        frame,
        lights: lights.lights as Float32Array<ArrayBuffer>,
        lightCount: lights.lightCount,
        shadowLightCount: lights.shadowLightCount,
        occluders: lights.occ as Float32Array<ArrayBuffer>,
        occluderCount: lights.occCount,
        lampPower: lampPower as Float32Array<ArrayBuffer>,
        lampCount: LAMP_COUNT,
        view: [-40, -40, 40, 40],
        batches: [],
        alphaSprites: emptySprites,
        alphaCount: 0,
        addSprites: emptySprites,
        addCount: 0,
        fxParticles: context.particles,
        smoke: context.volume,
        smokeEnabled: true,
        weather: raining
          ? {
              settings: weather,
              rainLighting,
              state: sim.state,
              viewProj: stage.viewProj,
              eye: stage.eye,
              focusXZ,
              viewportWidth: width,
              viewportHeight: height,
              fovYRad: 0.65,
              groundY: 0,
              ambientLum: 0.05 + clock.day * 0.6,
              lights: weatherLights,
              cameraDist: stage.camDist,
            }
          : null,
        grade: [time, 0, sim.state.flash * 0.4, exposureScale],
        look: look.preset === "current" ? null : look,
        ...(effLift !== 1 || effBloom !== 1 ? { postCustom: [1, effLift, effBloom, 0] as const } : {}),
      }
      r.drawTo(input, outputView)
      return measure ? r.measure(input) : null
    },
    telemetry() {
      const clock = worldClock(state.hour)
      const screen = state.screen && display ? `,"screen":{"power":${screenSettings.power},"light":[${display.emission().map(v => v.toFixed(3)).join(",")}],"readbacks":${display.light.samples}}` : ""
      return `World · ${LOOK_PRESETS[look.preset]?.label ?? look.preset} · ${weather.preset} · ${clock.hour.toFixed(1)} h {"lights":${lights.lightCount},"vertices":${geometry?.vertices ?? 0},"particles":${context.particles.count ?? 0},"spotShadows":${spotTelemetry()}${screen}}`
    },
  }
  return world
}

const LIFT = "vec3f(0.006, 0.011, 0.028) * (1.0 - smoothstep(0.0, 0.25, l))"
const BLOOM = "hdr = hdr + bloom * 0.32;"
/**
 * The kit's default composite with its shadow lift and bloom strength scalable per frame (`FrameInput.postCustom`: x > 0.5
 * overrides, y the lift, z the bloom). Without the override it picks the same constants, so every other preset draws as
 * before.
 */
export const WORLD_POST = (() => {
  const base = postShader(false)
  if (!base.includes(LIFT) || !base.includes(BLOOM)) throw new Error("postShader's shadow lift or bloom moved; update WORLD_POST")
  return base
    .replace("@group(0) @binding(4) var<uniform> G: vec4f;", customPostGradeWgsl)
    .replace(/\bG\./g, "grade.frame.")
    .replace(LIFT, "select(vec3f(0.006, 0.011, 0.028), vec3f(0.006, 0.011, 0.028) * grade.custom.y, grade.custom.x > 0.5) * (1.0 - smoothstep(0.0, 0.25, l))")
    .replace(BLOOM, "hdr = hdr + bloom * (0.32 * select(1.0, grade.custom.z, grade.custom.x > 0.5));")
})()

/** The world's three practical lamps under the shared flicker: a dying sodium streetlamp, a porch tube, a bulb inside. */
export function worldFlicker(amount: number, time: number): WorldFlicker {
  return {
    street: lampFlicker("sodium", 11, time, amount),
    porch: lampFlicker("fluorescent", 12, time, amount),
    interior: lampFlicker("incandescent", 13, time, amount),
  }
}

export const WALL_PAINT_OPTIONS = Object.entries(WALL_PAINTS).map(([value, p]) => ({ value, label: p.label }))
export const CAR_PAINT_OPTIONS = Object.entries(CAR_PAINTS).map(([value, p]) => ({ value, label: p.label }))
