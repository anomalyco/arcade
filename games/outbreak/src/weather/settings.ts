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

export type OutbreakWeatherSettings = {
  weather: number
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
  weather: 0,
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

export function applyOutbreakWeatherPreset(
  target: OutbreakWeatherSettings & { weather?: number },
  preset: WeatherPresetId | string,
): WeatherSettings {
  const pid = resolveWeatherPresetId(preset) ?? "clear"
  const src = WEATHER_PRESETS[pid].settings
  target.weatherPreset = pid
  target.weatherEnabled = pid !== "clear"
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
    target.weather = pid === "clear" ? 0 : Math.min(1, src.intensity * 0.65 + src.mist * 0.2)
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

export const outbreakWeatherControls: LabControl[] = [
  { key: "weatherEnabled", label: "Enable weather", group: "Weather", type: "toggle" },
  {
    key: "weatherPreset",
    label: "Weather preset",
    group: "Weather",
    options: WEATHER_PRESET_IDS.map((id) => ({ label: WEATHER_PRESETS[id].label, value: id })),
  },
  { key: "weatherIntensity", label: "Weather intensity", group: "Weather", min: 0, max: 1, step: 0.02, unit: "" },
  { key: "weatherDensity", label: "Drop density", group: "Weather", min: 0, max: 3, step: 0.05, unit: "×" },
  { key: "weatherDropSize", label: "Drop size", group: "Weather", min: 0.2, max: 2.5, step: 0.05, unit: "×" },
  { key: "weatherDropLength", label: "Streak length", group: "Weather", min: 0.2, max: 3, step: 0.05, unit: "×" },
  { key: "weatherDropSpeed", label: "Fall speed", group: "Weather", min: 1, max: 20, step: 0.2, unit: "m/s" },
  { key: "weatherLitOnly", label: "Lit-only visibility", group: "Weather", min: 0, max: 1, step: 0.02, unit: "" },
  { key: "weatherSnowMode", label: "Snow mode", group: "Weather", type: "toggle" },
  { key: "weatherSplashRate", label: "Splash & drip rate", group: "Weather", min: 0, max: 3, step: 0.05, unit: "×" },
  { key: "weatherWetness", label: "Surface wetness", group: "Weather", min: 0, max: 1, step: 0.02, unit: "" },
  { key: "weatherPuddleCoverage", label: "Puddle coverage", group: "Weather", min: 0, max: 1.5, step: 0.02, unit: "×" },
  { key: "weatherWindSpeed", label: "Wind speed", group: "Weather", min: 0, max: 24, step: 0.5, unit: "m/s" },
  { key: "weatherWindDir", label: "Wind direction", group: "Weather", min: -180, max: 180, step: 5, unit: "°" },
  { key: "weatherWindGust", label: "Wind gustiness", group: "Weather", min: 0, max: 2, step: 0.05, unit: "×" },
  { key: "weatherMist", label: "Mist & fog banks", group: "Weather", min: 0, max: 1.5, step: 0.02, unit: "×" },
  { key: "weatherLightningRate", label: "Lightning rate", group: "Weather", min: 0, max: 1, step: 0.02, unit: "" },
  { key: "weatherTuningSeed", label: "Weather tuning seed", group: "Weather", min: 1, max: 9999, step: 1, unit: "" },
]
