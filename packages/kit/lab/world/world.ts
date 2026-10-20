import { LOOK_PRESETS, LOOK_PRESET_IDS, applyLookPreset, createLookSettings, resolveLookPresetId, type LookSettings } from "../../gpu/look"
import { applyFoliagePreset, cloneFoliageParams, type FoliageKind, type FoliageParams } from "../../gpu/foliage"
import { lampFlicker } from "../../gpu/lights/flicker"
import { packPhysicalLightKnobs, physicalLightHooks, type LightModel } from "../../gpu/lights/physical"
import { Renderer, type FrameInput } from "../../gpu/renderer"
import { SpotShadows, type SpotCandidate } from "../../gpu/shadows/spot-shadows"
import { VERT_BYTES } from "../../gpu/mesh"
import { SceneLights, newSceneFrame, packSceneFrame, type SceneLight } from "../../gpu/scene-frame"
import { makeSceneShader, spriteShader } from "../../gpu/shaders"
import { WEATHER_PRESET_IDS, WeatherSimulation, applyWeatherPreset, createWeatherSettings, resolveWeatherPresetId, type WeatherLight, type WeatherSettings } from "../../weather"
import type { LabContext } from "../types"
import { CAR_PAINTS, FLOOR, LAMP, LAMP_COUNT, WALL_PAINTS, WORLD_CAMERA, WORLD_FOCUS, buildWorld, worldClock, worldLights, type CarPaint, type WallPaint, type WorldFlicker, type WorldGeometry } from "./scene"

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
  /** Shared lamp flicker and failure (`gpu/lights/flicker.ts`): streetlamp sodium, porch tube, lamp inside a bulb. */
  flicker: number
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
  flicker: 0,
}

/** World keys whose change rebuilds the mesh (everything else is per frame). */
const STRUCTURAL = new Set<string>(["street", "walk", "path", "floor", "wall", "car", "tree", "bush", "grass", "seed"])

export type DebugWorld = {
  readonly state: WorldState
  readonly look: LookSettings
  readonly weather: WeatherSettings
  readonly vegetation: FoliageParams
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
  const vegetation = cloneFoliageParams()
  applyFoliagePreset("tree", "oak", vegetation)
  applyFoliagePreset("bush", "hedge", vegetation)
  applyFoliagePreset("grass", "lawn", vegetation)

  const renderers: Partial<Record<LightModel, Renderer>> = {}
  const drawn = new Map<Renderer, WorldGeometry>()
  let geometry: WorldGeometry | null = null
  let dirty = true
  let time = 0
  const lights = new SceneLights()
  const frame = newSceneFrame()
  const lampPower = new Float32Array(8)
  const sim = new WeatherSimulation(7)
  const focusXZ: [number, number] = [WORLD_FOCUS[0], WORLD_FOCUS[2]]
  const emptySprites = new Float32Array(0) as Float32Array<ArrayBuffer>

  const knobs = new Float32Array(4) as Float32Array<ArrayBuffer>
  const ensureRenderer = () => {
    const model = state.lightModel
    const have = renderers[model]
    if (have) return have
    const format = navigator.gpu.getPreferredCanvasFormat()
    const canvas = document.createElement("canvas")
    canvas.width = 16
    canvas.height = 16
    const ctx = canvas.getContext("webgpu")!
    ctx.configure({ device, format, alphaMode: "opaque" })
    // Physical swaps only the scene shader; Today's baseline is the same shader without the hooks.
    const physical = physicalLightHooks({ knobs: "PK.k", spotShadows: true })
    const r = model === "physical"
      ? new Renderer(device, ctx, format, {
          scene: makeSceneShader({ ...physical, declarations: `struct PhysicalKnobs { k: vec4f }\n@group(0) @binding(13) var<uniform> PK: PhysicalKnobs;\n${physical.declarations}`, lampGrid: false }, false),
          sprite: spriteShader(),
        })
      : new Renderer(device, ctx, format)
    renderers[model] = r
    return r
  }

  let spots: SpotShadows | null = null
  let casters: { buffer: GPUBuffer; count: number; stride: number } | null = null
  const spotBound = new Set<Renderer>()
  const rebuild = () => {
    geometry = buildWorld({ ...state, vegetation })
    lights.setBoxes(geometry.boxes)
    casters?.buffer.destroy()
    casters = null
    spots?.picker.invalidate()
    dirty = false
  }

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
      if (!l.spot || l.id === undefined) continue
      candidates.push({ id: l.id, pos: [l.x, l.h, l.y], axis: l.spot.axis, cosOuter: l.spot.cosOuter, range: l.r, intensity: l.r * l.r })
    }
    const enc = device.createCommandEncoder({ label: "world spot shadows" })
    const rebind = spots.update(enc, candidates, [stage.eye[0]!, stage.eye[1]!, stage.eye[2]!], 1 / 60, (id) => lights.indexOf(id), [casters])
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
      out.push({ x: l.x, y: l.z, h: Math.max(0.3, l.y), r: Math.max(2, l.radius), color: [l.r, l.g, l.b], power: Math.min(3, l.power * 0.6), size: 0.4, unshadowed: true })
    }
    return out
  }

  const world: DebugWorld = {
    state,
    look,
    weather,
    vegetation,
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
      if (!key || STRUCTURAL.has(key) || key in vegetation) dirty = true
    },
    reset() {
      Object.assign(state, WORLD_DEFAULTS)
      applyLookPreset(look, "current")
      applyWeatherPreset(weather, "clear")
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
      if (state.timeScale > 0) state.hour = (state.hour + (dt * state.timeScale) / 3600) % 24
      sim.step(dt, weather, [stage.eye[0]!, stage.eye[1]!, stage.eye[2]!], focusXZ)
    },
    render(width, height, outputView, measure) {
      const r = ensureRenderer()
      if (dirty || !geometry) rebuild()
      if (drawn.get(r) !== geometry) {
        r.setLevel(geometry!.level)
        drawn.set(r, geometry!)
      }
      r.resize(width, height)
      const clock = worldClock(state.hour)
      const flick = worldFlicker(state.flicker, time)
      const scene = [
        ...worldLights(clock, { lampPower: state.lampPower, headlights: state.headlights, flashlight: state.flashlight, porch: state.porch, flicker: flick, physical: state.lightModel === "physical" }),
        ...extraLights(),
      ]
      if (state.lightModel === "physical") {
        packPhysicalLightKnobs({ model: "physical", specularAA: state.specularAA, sphereLights: state.sphereLights, envSpecular: state.envSpecular, spill: 0 }, knobs)
        r.setCustomUniforms(knobs)
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
      sim.step(0, weather, [stage.eye[0]!, stage.eye[1]!, stage.eye[2]!], focusXZ)
      const raining = weather.preset !== "clear" || sim.state.flash > 0.001
      const weatherLights: WeatherLight[] = scene.slice(1, 7).map(l => ({ x: l.x, y: l.h, z: l.y, radius: l.r, r: l.color[0], g: l.color[1], b: l.color[2], power: l.power * 1.3, ...(l.cone ? { dx: l.cone[0], dz: l.cone[1], cosHalf: l.cone[2], isCone: true } : {}) }))
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
        grade: [time, 0, sim.state.flash * 0.4, clock.exposure],
        look: look.preset === "current" ? null : look,
      }
      r.drawTo(input, outputView)
      return measure ? r.measure(input) : null
    },
    telemetry() {
      const clock = worldClock(state.hour)
      return `World · ${LOOK_PRESETS[look.preset]?.label ?? look.preset} · ${weather.preset} · ${clock.hour.toFixed(1)} h {"lights":${lights.lightCount},"vertices":${geometry?.vertices ?? 0},"particles":${context.particles.count ?? 0}}`
    },
  }
  return world
}

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
