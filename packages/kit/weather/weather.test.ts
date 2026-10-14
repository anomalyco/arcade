import { describe, expect, test } from "bun:test"
import {
  WEATHER_PRESETS,
  WEATHER_PRESET_IDS,
  applyWeatherPreset,
  computeWeatherLod,
  createWeatherSettings,
  evaluateWeatherGust,
  evaluateWeatherLightning,
  exportWeatherPreset,
  importWeatherPreset,
  isClearWeather,
  randomizeWeatherSettings,
  resolveWeatherPresetId,
  WeatherSimulation,
  weatherSettings,
} from "./index"

describe("@arcade/kit/weather", () => {
  test("presets cover Clear, Drizzle, Rain, Storm, Fog, and Snow", () => {
    expect(WEATHER_PRESET_IDS).toEqual(["clear", "drizzle", "rain", "storm", "fog", "snow"])
    expect(isClearWeather(WEATHER_PRESETS.clear.settings)).toBe(true)
    expect(isClearWeather(WEATHER_PRESETS.rain.settings)).toBe(false)
    expect(WEATHER_PRESETS.snow.settings.snowMode).toBe(true)
    expect(WEATHER_PRESETS.storm.settings.lightningRate).toBeGreaterThan(0.5)
    expect(resolveWeatherPresetId("noir_rain")).toBe("rain")
    expect(resolveWeatherPresetId("thunderstorm")).toBe("storm")
    expect(resolveWeatherPresetId("blizzard")).toBe("snow")
  })

  test("randomizeWeatherSettings is deterministic by tuningSeed and preserves preset/snowMode", () => {
    const base = createWeatherSettings("rain")
    const r1 = randomizeWeatherSettings(base, 42, "all")
    const r2 = randomizeWeatherSettings(base, 42, "all")
    const r3 = randomizeWeatherSettings(base, 99, "all")
    expect(r1).toEqual(r2)
    expect(r1).not.toEqual(r3)
    expect(r1.snowMode).toBe(false)
  })

  test("exportWeatherPreset and importWeatherPreset validate version, ranges, and types", () => {
    const s = createWeatherSettings("storm")
    const exported = exportWeatherPreset(s, { tuningSeed: 108, roomSeed: 7 })
    const imported = importWeatherPreset(JSON.stringify(exported))
    expect(imported.ok).toBe(true)
    if (imported.ok) {
      expect(imported.value.preset).toBe("storm")
      expect(imported.value.tuningSeed).toBe(108)
      expect(imported.value.roomSeed).toBe(7)
      expect(imported.value.settings.intensity).toBe(s.intensity)
    }
    const badVersion = importWeatherPreset({ version: 2, preset: "rain" })
    expect(badVersion.ok).toBe(false)
    const badNumber = importWeatherPreset({ version: 1, preset: "rain", settings: { intensity: "fast" } })
    expect(badNumber.ok).toBe(false)
  })

  test("WeatherSimulation integrates drift continuously and supports strikeNow()", () => {
    const sim = new WeatherSimulation(7)
    const rain = createWeatherSettings("rain")
    const st1 = sim.step(1 / 60, rain, [10, 12, 10])
    expect(st1.active).toBe(true)
    expect(st1.wetness).toBeCloseTo(rain.wetness, 4)
    expect(st1.rippleIntensity).toBeGreaterThan(0.2)

    const prevDriftX = st1.driftX
    // Changing windSpeed mid-stream should advance from prevDriftX without teleporting phase
    const gusty = weatherSettings({ ...rain, windSpeed: 18 })
    const st2 = sim.step(1 / 60, gusty, [10, 12, 10])
    expect(Math.abs(st2.driftX - prevDriftX)).toBeLessThan(1.0)

    sim.strikeNow(123)
    const stFlash = sim.step(0.02, gusty, [10, 12, 10])
    expect(stFlash.flash).toBeGreaterThan(0.5)
  })

  test("computeWeatherLod enforces hard instance budgets across presets", () => {
    const clearLod = computeWeatherLod(WEATHER_PRESETS.clear.settings, 34, true)
    expect(clearLod.nearCount).toBe(0)
    expect(clearLod.farCount).toBe(0)
    expect(clearLod.splashCount).toBe(0)

    const stormLod = computeWeatherLod(WEATHER_PRESETS.storm.settings, 34, true)
    expect(stormLod.nearCount).toBeLessThanOrEqual(1800)
    expect(stormLod.farCount).toBeLessThanOrEqual(1400)
    expect(stormLod.splashCount).toBeLessThanOrEqual(520)
    expect(stormLod.dripCount).toBeLessThanOrEqual(144)
    expect(stormLod.mistCount).toBeLessThanOrEqual(36)

    const gust = evaluateWeatherGust(1.5, 20, 30, -28, 1.2)
    expect(gust).toBeGreaterThanOrEqual(0.15)
    expect(gust).toBeLessThanOrEqual(2.3)
    expect(evaluateWeatherLightning(7, 10, 0)).toBe(0)
  })
})
