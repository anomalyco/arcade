import { describe, expect, test } from "bun:test"
import { makeTown } from "../shared/map"
import { DEFAULT_OUTBREAK_LIGHTING, packOutbreakLightingUniforms } from "../src/lighting"
import { OutbreakWeatherController } from "../src/weather/controller"
import {
  DEFAULT_OUTBREAK_WEATHER,
  applyOutbreakWeatherPreset,
  randomizeOutbreakWeather,
  toSharedWeatherSettings,
} from "../src/weather/settings"

describe("Outbreak weather integration", () => {
  test("defaults to Clear (off by default) with zero uniform or draw overhead", () => {
    const s = { ...DEFAULT_OUTBREAK_WEATHER, weather: 0 }
    expect(s.weatherEnabled).toBe(false)
    expect(s.weatherPreset).toBe("clear")
    const shared = toSharedWeatherSettings(s)
    expect(shared.intensity).toBe(0)
    expect(shared.wetness).toBe(0)

    const ctrl = new OutbreakWeatherController()
    const town = makeTown(7, 7, 0.22)
    const out = ctrl.stepAndPrepare({
      dt: 1 / 60,
      town,
      settings: s,
      viewProj: new Float32Array(16),
      eye: [30, 22, 55],
      playerX: 30,
      playerY: 41,
      playerGroundY: 0,
      canvasWidth: 1000,
      canvasHeight: 680,
      zoom: 42,
      lights: new Float32Array(64),
      lightCount: 1,
      ambientLum: 0.2,
    })
    expect(out.prepareInput).toBeNull()
  })

  test("applying presets and randomizing updates wetness, puddles, and lighting uniform u7", () => {
    const s = { ...DEFAULT_OUTBREAK_WEATHER, weather: 0 }
    applyOutbreakWeatherPreset(s, "rain")
    expect(s.weatherEnabled).toBe(true)
    expect(s.weatherPreset).toBe("rain")
    expect(s.weatherWetness).toBeGreaterThan(0.7)
    expect(s.weatherPuddleCoverage).toBeGreaterThan(0.7)

    const ctrl = new OutbreakWeatherController()
    const town = makeTown(7, 7, 0.22)
    const lights = new Float32Array(32)
    // Slot 1: flashlight cone
    lights.set([30, 1.2, 41, 6.4, 1, 0.9, 0.8, 2.5, 0, -1, 0.85, 1, 0, 10, 0.06, -1], 16)
    const out = ctrl.stepAndPrepare({
      dt: 1 / 60,
      town,
      settings: s,
      viewProj: new Float32Array(16),
      eye: [30, 22, 55],
      playerX: 30,
      playerY: 41,
      playerGroundY: 0,
      canvasWidth: 1000,
      canvasHeight: 680,
      zoom: 42,
      lights,
      lightCount: 2,
      ambientLum: 0.2,
    })
    expect(out.prepareInput).not.toBeNull()
    expect(out.prepareInput!.excludeRects?.length).toBe(town.buildings.length)
    expect(out.prepareInput!.eaves?.length).toBeGreaterThan(0)
    expect(out.prepareInput!.lights?.some(l => l.isCone)).toBe(true)

    const u = packOutbreakLightingUniforms(
      {
        settings: {
          ...DEFAULT_OUTBREAK_LIGHTING,
          flashlightIntensity: 1.5,
          flashlightRange: 7,
          flashlightCone: 48,
          flashlightWarmth: 0.3,
        },
        playerX: 30,
        playerY: 41,
        playerH: 0,
        playerAim: -Math.PI / 2,
        flashlightOutput: 1,
        flashlightSlot: 1,
        inInteriorView: false,
        streetHead: [36.86, 6.18, 47.49],
        zombies: [-999, -999, -999, -999],
        weather: {
          wetness: out.state.wetness,
          puddleCoverage: out.state.puddleCoverage,
          rippleIntensity: out.state.rippleIntensity,
          snowAmount: out.state.snowAmount,
        },
      },
      [1, 0.9, 0.8],
    )
    expect(u[33]).toBeCloseTo(out.state.wetness, 4)
    expect(u[34]).toBeCloseTo(out.state.puddleCoverage, 4)
    expect(u[35]).toBe(0)

    const r1 = randomizeOutbreakWeather({ ...s }, 55)
    const r2 = randomizeOutbreakWeather({ ...s }, 55)
    expect(r1).toEqual(r2)
  })
})
