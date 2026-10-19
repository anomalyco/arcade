import { describe, expect, test } from "bun:test"
import { makeTown } from "../shared/map"
import { DEFAULT_OUTBREAK_LIGHTING, packOutbreakLightingUniforms } from "../src/lighting"
import { OutbreakWeatherController } from "../src/weather/controller"
import {
  DEFAULT_OUTBREAK_WEATHER,
  applyOutbreakWeatherPreset,
  randomizeOutbreakWeather,
  setOutbreakWeatherState,
  toSharedWeatherSettings,
} from "../src/weather/settings"

const frame = (settings: typeof DEFAULT_OUTBREAK_WEATHER, extra: Partial<{ simTime: number; hour: number; lights: Float32Array; lightCount: number }> = {}) => ({
  dt: 1 / 60,
  town: makeTown(7, 7, 0.22),
  settings,
  viewProj: new Float32Array(16),
  eye: [30, 22, 55] as [number, number, number],
  playerX: 30,
  playerY: 41,
  playerGroundY: 0,
  canvasWidth: 1000,
  canvasHeight: 680,
  zoom: 42,
  lights: extra.lights ?? new Float32Array(64 * 16),
  lightCount: extra.lightCount ?? 1,
  maxLights: 64,
  ambientLum: 0.2,
  simTime: extra.simTime ?? 10,
  hour: extra.hour ?? 22,
})

describe("Outbreak weather integration", () => {
  test("Today (cycle off) and the dry opening draw nothing", () => {
    const today = { ...DEFAULT_OUTBREAK_WEATHER, weatherCycle: 0 }
    expect(today.weatherEnabled).toBe(false)
    expect(toSharedWeatherSettings(today).intensity).toBe(0)
    expect(new OutbreakWeatherController().stepAndPrepare(frame(today)).prepareInput).toBeNull()
    // The cycle's first minutes are dry.
    const opening = new OutbreakWeatherController().stepAndPrepare(frame({ ...DEFAULT_OUTBREAK_WEATHER }, { simTime: 30 }))
    expect(opening.prepareInput).toBeNull()
  })

  test("weather.set holds a state; rain wets the ground, a storm lights up", () => {
    const s = { ...DEFAULT_OUTBREAK_WEATHER }
    expect(setOutbreakWeatherState(s, "rain")).toBe(2)
    expect(setOutbreakWeatherState(s, "tornado")).toBeNull()
    const lights = new Float32Array(64 * 16)
    // Slot 1: flashlight cone
    lights.set([30, 1.2, 41, 6.4, 1, 0.9, 0.8, 2.5, 0, -1, 0.85, 1, 0, 10, 0.06, -1], 16)
    const ctrl = new OutbreakWeatherController()
    const town = makeTown(7, 7, 0.22)
    const out = ctrl.stepAndPrepare({ ...frame(s, { lights, lightCount: 2 }), town })
    expect(out.prepareInput).not.toBeNull()
    expect(ctrl.sample.state).toBe("rain")
    expect(ctrl.surface.wetness).toBeGreaterThan(0.8)
    expect(ctrl.surface.puddles).toBeGreaterThan(0.5)
    expect(out.prepareInput!.excludeRects?.length).toBe(town.buildings.length)
    expect(out.prepareInput!.eaves?.length).toBeGreaterThan(0)
    expect(out.prepareInput!.lights?.some((l) => l.isCone)).toBe(true)

    const u = packOutbreakLightingUniforms(
      {
        settings: { ...DEFAULT_OUTBREAK_LIGHTING, flashlightIntensity: 1.5, flashlightRange: 7, flashlightCone: 48, flashlightWarmth: 0.3 },
        playerX: 30,
        playerY: 41,
        playerH: 0,
        playerAim: -Math.PI / 2,
        flashlightOutput: 1,
        flashlightSlot: 1,
        inInteriorView: false,
        streetHead: [36.86, 6.18, 47.49],
        zombies: [-999, -999, -999, -999],
        weather: { wetness: ctrl.surface.wetness, puddleCoverage: ctrl.surface.puddles, rippleIntensity: ctrl.surface.ripple, snowAmount: 0 },
      },
      [1, 0.9, 0.8],
    )
    expect(u[33]).toBeCloseTo(ctrl.surface.wetness, 4)
    expect(u[34]).toBeCloseTo(ctrl.surface.puddles, 4)
    expect(u[35]).toBe(0)
  })

  test("a forced near strike flashes, lifts the shroud, lights its spot and throws sparks", () => {
    const s = { ...DEFAULT_OUTBREAK_WEATHER }
    setOutbreakWeatherState(s, "storm")
    const ctrl = new OutbreakWeatherController()
    ctrl.stepAndPrepare(frame(s))
    ctrl.endFrame()
    ctrl.flashNow({ near: true, seed: 5 })
    expect(ctrl.strikes.length).toBe(1)
    const sprites = new Float32Array(512 * 12)
    const out = ctrl.stepAndPrepare({ ...frame(s), sprites, spriteCount: 0 })
    expect(ctrl.flash).toBeGreaterThan(0.2)
    expect(ctrl.shroudLift).toBeGreaterThan(0.1)
    expect(ctrl.reveal).toBeGreaterThan(0.2)
    expect(ctrl.marks.length).toBe(1)
    expect(out.spriteCount).toBeGreaterThan(10)
    // Its light goes in with the map's extra lights (before the lamp grid), not after the frame's lights.
    expect(out.lightCount).toBe(1)
    const lights = new Float32Array(16 * 4)
    expect(ctrl.writeLights(lights, 1, 4)).toBe(2)
    expect(lights[16 + 7]).toBeGreaterThan(1)
    ctrl.endFrame()
    expect(ctrl.strikes.length).toBe(0)
  })

  test("presets: the cycle's four hold the cycle, fog and snow switch to the manual look", () => {
    const s = { ...DEFAULT_OUTBREAK_WEATHER, weather: 0 }
    applyOutbreakWeatherPreset(s, "storm")
    expect(s.weatherEnabled).toBe(false)
    expect(s.weatherOverride).toBe(3)
    applyOutbreakWeatherPreset(s, "fog")
    expect(s.weatherEnabled).toBe(true)
    expect(s.weatherPreset).toBe("fog")
    expect(s.weatherMist).toBeGreaterThan(1)
    const r1 = randomizeOutbreakWeather({ ...s }, 55)
    const r2 = randomizeOutbreakWeather({ ...s }, 55)
    expect(r1).toEqual(r2)
  })
})
