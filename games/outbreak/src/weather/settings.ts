import type { LabControl } from "@arcade/kit/lab-panel"
import {
  WEATHER_PRESETS,
  WEATHER_PRESET_IDS,
  createWeatherSettings,
  randomizeWeatherSettings,
  resolveWeatherPresetId,
  weatherSettings,
  type WeatherPresetId,
  type WeatherSettings,
} from "@arcade/kit/weather"
import { DEFAULT_WEATHER_TUNING, weatherCycleControls, type WeatherTuning } from "../../shared/weather/schedule"

/**
 * Outbreak's weather settings: the shared cycle's tuning (`shared/weather/schedule.ts`, read by the sim through the
 * `weather` tuning namespace), how the cycle looks and sounds (rain streaks, wet ground, lightning, thunder), and the
 * older manual look (`weatherEnabled` + a kit preset, for fog and snow), which replaces the cycle while it is on.
 */
export type OutbreakWeatherSettings = WeatherTuning & {
  /** Overcast trim on the day cycle (Lab › Day cycle). */
  weather: number
  /** Rain intensity trim on the cycle's rain (presentation). */
  weatherRainScale: number
  /** Ground wetness: below 0 follows the cycle, 0..1 holds it. */
  weatherWetnessOverride: number
  /** Rain streak density, length and width trims. */
  weatherStreakDensity: number
  weatherStreakLength: number
  weatherStreakSize: number
  /** 1: rain only shows where light falls (Darkwood); 0: rain shows everywhere. */
  weatherStreakLitOnly: number
  /** Wet-ground gloss in light (flashlight, lamps): 0 dull, 1 shipped, 2 strong. */
  weatherWetGloss: number
  /** How far a lightning flash lifts the sight shroud and the night (0..1). */
  weatherFlashLift: number
  /** Lightning flash brightness. */
  weatherFlashBrightness: number
  /** 1: a flash shows the dead in line of sight beyond the cone, and they linger as ghosts. */
  weatherFlashReveal: number
  /** Thunder delay scale (1 = speed of sound). */
  weatherThunderDelay: number
  /** Manual look: replaces the cycle with a kit preset and the knobs below (fog, snow, look studies). */
  weatherEnabled: boolean
  weatherPreset: WeatherPresetId
  weatherIntensity: number
  weatherDensity: number
  weatherDropSize: number
  weatherDropLength: number
  weatherDropSpeed: number
  weatherLitOnly: number
  weatherSplashRate: number
  weatherWetness: number
  weatherPuddleCoverage: number
  weatherWindSpeed: number
  weatherWindDir: number
  weatherWindGust: number
  weatherMist: number
  weatherLightningRate: number
  weatherSnowMode: boolean
  weatherTuningSeed: number
}

const clearBase = createWeatherSettings("clear")
const CLEAR_SHARED: Readonly<WeatherSettings> = Object.freeze(createWeatherSettings("clear"))

export const DEFAULT_OUTBREAK_WEATHER: OutbreakWeatherSettings = {
  ...DEFAULT_WEATHER_TUNING,
  weather: 0,
  weatherRainScale: 1,
  weatherWetnessOverride: -0.05,
  weatherStreakDensity: 1,
  weatherStreakLength: 1,
  weatherStreakSize: 1,
  weatherStreakLitOnly: 0.86,
  weatherWetGloss: 1,
  weatherFlashLift: 0.8,
  weatherFlashBrightness: 1,
  weatherFlashReveal: 1,
  weatherThunderDelay: 1,
  weatherEnabled: false,
  weatherPreset: "clear",
  weatherIntensity: clearBase.intensity,
  weatherDensity: clearBase.density,
  weatherDropSize: clearBase.dropSize,
  weatherDropLength: clearBase.dropLength,
  weatherDropSpeed: clearBase.dropSpeed,
  weatherLitOnly: clearBase.litOnly,
  weatherSplashRate: clearBase.splashRate,
  weatherWetness: clearBase.wetness,
  weatherPuddleCoverage: clearBase.puddleCoverage,
  weatherWindSpeed: clearBase.windSpeed,
  weatherWindDir: clearBase.windDir,
  weatherWindGust: clearBase.windGust,
  weatherMist: clearBase.mist,
  weatherLightningRate: clearBase.lightningRate,
  weatherSnowMode: clearBase.snowMode,
  weatherTuningSeed: 73,
}

/** The manual look as kit weather settings (clear when the manual look is off). */
export function toSharedWeatherSettings(s: Readonly<OutbreakWeatherSettings>, densityScale = 1): WeatherSettings {
  if (!s.weatherEnabled && s.weatherPreset === "clear") {
    return CLEAR_SHARED as WeatherSettings
  }
  return weatherSettings({
    preset: s.weatherPreset,
    intensity: s.weatherEnabled ? s.weatherIntensity : 0,
    density: s.weatherDensity * densityScale,
    dropSize: s.weatherDropSize,
    dropLength: s.weatherDropLength,
    dropSpeed: s.weatherDropSpeed,
    litOnly: s.weatherLitOnly,
    splashRate: s.weatherSplashRate * densityScale,
    wetness: s.weatherEnabled ? s.weatherWetness : 0,
    puddleCoverage: s.weatherEnabled ? s.weatherPuddleCoverage : 0,
    windSpeed: s.weatherWindSpeed,
    windDir: s.weatherWindDir,
    windGust: s.weatherWindGust,
    mist: s.weatherEnabled ? s.weatherMist : 0,
    lightningRate: s.weatherEnabled ? s.weatherLightningRate : 0,
    snowMode: s.weatherSnowMode,
  })
}

/** The cycle's states, by name, for `weather.set` and `weather.preset`. */
const CYCLE_STATES: Readonly<Record<string, number>> = { cycle: -1, auto: -1, clear: 0, drizzle: 1, rain: 2, storm: 3 }

/** Holds the cycle at a state (`clear`, `drizzle`, `rain`, `storm`) or lets it run (`cycle`); turns the manual look off. */
export function setOutbreakWeatherState(target: OutbreakWeatherSettings, state: string): number | null {
  const key = state.trim().toLowerCase()
  const id = resolveWeatherPresetId(key)
  const value = CYCLE_STATES[key] ?? (id && id in CYCLE_STATES ? CYCLE_STATES[id] : undefined)
  if (value === undefined) return null
  target.weatherCycle = 1
  target.weatherOverride = value
  target.weatherEnabled = false
  target.weatherPreset = "clear"
  return value
}

/**
 * Applies a kit preset. Clear, drizzle, rain and storm hold the cycle at that state; fog and snow (which the cycle
 * does not make) turn the manual look on.
 */
export function applyOutbreakWeatherPreset(
  target: OutbreakWeatherSettings & { weather?: number },
  preset: WeatherPresetId | string,
): WeatherSettings {
  const pid = resolveWeatherPresetId(preset) ?? "clear"
  if (pid !== "fog" && pid !== "snow") {
    setOutbreakWeatherState(target, pid)
    return toSharedWeatherSettings(target)
  }
  const src = WEATHER_PRESETS[pid].settings
  target.weatherPreset = pid
  target.weatherEnabled = true
  target.weatherIntensity = src.intensity
  target.weatherDensity = src.density
  target.weatherDropSize = src.dropSize
  target.weatherDropLength = src.dropLength
  target.weatherDropSpeed = src.dropSpeed
  target.weatherLitOnly = src.litOnly
  target.weatherSplashRate = src.splashRate
  target.weatherWetness = src.wetness
  target.weatherPuddleCoverage = src.puddleCoverage
  target.weatherWindSpeed = src.windSpeed
  target.weatherWindDir = src.windDir
  target.weatherWindGust = src.windGust
  target.weatherMist = src.mist
  target.weatherLightningRate = src.lightningRate
  target.weatherSnowMode = src.snowMode
  if (typeof target.weather === "number") {
    target.weather = Math.min(1, src.intensity * 0.65 + src.mist * 0.2)
  }
  return toSharedWeatherSettings(target)
}

export function randomizeOutbreakWeather(
  target: OutbreakWeatherSettings & { weather?: number },
  explicitSeed?: number,
): WeatherSettings {
  const seed = Math.max(1, Math.min(9999, Math.round(explicitSeed ?? (target.weatherTuningSeed || 73))))
  const base = toSharedWeatherSettings({
    ...target,
    weatherEnabled: true,
    weatherPreset: target.weatherPreset === "clear" ? "rain" : target.weatherPreset,
  })
  const next = randomizeWeatherSettings(base, seed, "all")
  target.weatherEnabled = true
  if (target.weatherPreset === "clear") target.weatherPreset = "rain"
  target.weatherIntensity = next.intensity
  target.weatherDensity = next.density
  target.weatherDropSize = next.dropSize
  target.weatherDropLength = next.dropLength
  target.weatherDropSpeed = next.dropSpeed
  target.weatherLitOnly = next.litOnly
  target.weatherSplashRate = next.splashRate
  target.weatherWetness = next.wetness
  target.weatherPuddleCoverage = next.puddleCoverage
  target.weatherWindSpeed = next.windSpeed
  target.weatherWindDir = next.windDir
  target.weatherWindGust = next.windGust
  target.weatherMist = next.mist
  target.weatherLightningRate = next.lightningRate
  target.weatherTuningSeed = (seed % 9999) + 1
  if (typeof target.weather === "number") {
    target.weather = Math.min(1, next.intensity * 0.65 + next.mist * 0.2)
  }
  return toSharedWeatherSettings(target)
}

const MANUAL = "Weather · Manual look"

/** The cycle's look and sound (Backquote › Weather), after the shared cycle's own controls. */
export const outbreakWeatherLookControls: LabControl[] = [
  { key: "weatherRainScale", label: "Rain intensity", group: "Weather", min: 0, max: 2, step: 0.05, unit: "×" },
  { key: "weatherWetnessOverride", label: "Ground wetness (below 0 = cycle)", group: "Weather", min: -0.05, max: 1, step: 0.05, unit: "" },
  { key: "weatherStreakDensity", label: "Rain streak density", group: "Weather", min: 0, max: 3, step: 0.05, unit: "×" },
  { key: "weatherStreakLength", label: "Rain streak length", group: "Weather", min: 0.2, max: 3, step: 0.05, unit: "×" },
  { key: "weatherStreakSize", label: "Rain streak width", group: "Weather", min: 0.2, max: 2.5, step: 0.05, unit: "×" },
  { key: "weatherStreakLitOnly", label: "Rain only in light", group: "Weather", min: 0, max: 1, step: 0.02, unit: "" },
  { key: "weatherWetGloss", label: "Wet gloss in light", group: "Weather", min: 0, max: 2, step: 0.05, unit: "×" },
  { key: "weatherFlashBrightness", label: "Lightning brightness", group: "Weather", min: 0, max: 2, step: 0.05, unit: "×" },
  { key: "weatherFlashLift", label: "Lightning lifts the shroud", group: "Weather", min: 0, max: 1, step: 0.05, unit: "" },
  {
    key: "weatherFlashReveal",
    label: "Lightning shows the dead",
    group: "Weather",
    options: [
      { label: "Off", value: 0 },
      { label: "In line of sight", value: 1 },
    ],
  },
  { key: "weatherThunderDelay", label: "Thunder delay", group: "Weather", min: 0, max: 3, step: 0.05, unit: "×" },
]

/** The manual look (kit presets with every knob), for fog, snow and look studies; it replaces the cycle while on. */
export const outbreakWeatherControls: LabControl[] = [
  { key: "weatherEnabled", label: "Manual look (replaces the cycle)", group: MANUAL, type: "toggle" },
  {
    key: "weatherPreset",
    label: "Weather preset",
    group: MANUAL,
    options: WEATHER_PRESET_IDS.map((id) => ({ label: WEATHER_PRESETS[id].label, value: id })),
  },
  { key: "weatherIntensity", label: "Weather intensity", group: MANUAL, min: 0, max: 1, step: 0.02, unit: "" },
  { key: "weatherDensity", label: "Drop density", group: MANUAL, min: 0, max: 3, step: 0.05, unit: "×" },
  { key: "weatherDropSize", label: "Drop size", group: MANUAL, min: 0.2, max: 2.5, step: 0.05, unit: "×" },
  { key: "weatherDropLength", label: "Streak length", group: MANUAL, min: 0.2, max: 3, step: 0.05, unit: "×" },
  { key: "weatherDropSpeed", label: "Fall speed", group: MANUAL, min: 1, max: 20, step: 0.2, unit: "m/s" },
  { key: "weatherLitOnly", label: "Lit-only visibility", group: MANUAL, min: 0, max: 1, step: 0.02, unit: "" },
  { key: "weatherSnowMode", label: "Snow mode", group: MANUAL, type: "toggle" },
  { key: "weatherSplashRate", label: "Splash & drip rate", group: MANUAL, min: 0, max: 3, step: 0.05, unit: "×" },
  { key: "weatherWetness", label: "Surface wetness", group: MANUAL, min: 0, max: 1, step: 0.02, unit: "" },
  { key: "weatherPuddleCoverage", label: "Puddle coverage", group: MANUAL, min: 0, max: 1.5, step: 0.02, unit: "×" },
  { key: "weatherWindSpeed", label: "Wind speed", group: MANUAL, min: 0, max: 24, step: 0.5, unit: "m/s" },
  { key: "weatherWindDir", label: "Wind direction", group: MANUAL, min: -180, max: 180, step: 5, unit: "°" },
  { key: "weatherWindGust", label: "Wind gustiness", group: MANUAL, min: 0, max: 2, step: 0.05, unit: "×" },
  { key: "weatherMist", label: "Mist & fog banks", group: MANUAL, min: 0, max: 1.5, step: 0.02, unit: "×" },
  { key: "weatherLightningRate", label: "Lightning rate", group: MANUAL, min: 0, max: 1, step: 0.02, unit: "" },
  { key: "weatherTuningSeed", label: "Weather tuning seed", group: MANUAL, min: 1, max: 9999, step: 1, unit: "" },
]

/** Every weather control, cycle first. */
export const outbreakAllWeatherControls: LabControl[] = [
  ...(weatherCycleControls as readonly LabControl[]),
  ...outbreakWeatherLookControls,
  ...outbreakWeatherControls,
]
