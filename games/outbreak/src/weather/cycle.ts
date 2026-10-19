import { WEATHER_PRESETS, weatherDefaults, type WeatherSettings } from "@arcade/kit/weather"
import type { WeatherSample } from "../../shared/weather/schedule"
import type { OutbreakWeatherSettings } from "./settings"

const DRIZZLE = WEATHER_PRESETS.drizzle.settings
const RAIN = WEATHER_PRESETS.rain.settings
const STORM = WEATHER_PRESETS.storm.settings

const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

/**
 * The kit renderer's settings for one moment of the cycle: the drizzle, rain and storm presets blended by rainfall and
 * storm strength, with the Lab's streak trims on top. Wetness and puddles come from the cycle (they lag the rain), and
 * the kit's own lightning stays off: the cycle's strikes drive the flash.
 */
export function cycleWeatherSettings(
  sample: Readonly<WeatherSample>,
  look: Readonly<OutbreakWeatherSettings>,
  particleScale: number,
  out: WeatherSettings = { ...weatherDefaults },
): WeatherSettings {
  const rain = clamp01(sample.rain * look.weatherRainScale)
  // 0 at drizzle, 1 at steady rain; the storm pushes on to the storm preset.
  const toRain = clamp01((rain - 0.25) / 0.55)
  const storm = clamp01(sample.storm)
  const pick = (key: keyof Omit<WeatherSettings, "preset" | "snowMode">) => {
    const base = lerp(DRIZZLE[key], RAIN[key], toRain)
    return lerp(base, STORM[key], storm)
  }
  out.preset = storm > 0.5 ? "storm" : toRain > 0.5 ? "rain" : "drizzle"
  out.snowMode = false
  out.intensity = rain > 0.01 ? clamp01(pick("intensity") * Math.min(1, rain / 0.25)) : 0
  out.density = pick("density") * look.weatherStreakDensity * particleScale
  out.dropSize = pick("dropSize") * look.weatherStreakSize
  out.dropLength = pick("dropLength") * look.weatherStreakLength
  out.dropSpeed = pick("dropSpeed")
  out.litOnly = clamp01(look.weatherStreakLitOnly)
  out.splashRate = pick("splashRate") * Math.min(1, rain / 0.2) * particleScale
  const wet = look.weatherWetnessOverride >= 0 ? clamp01(look.weatherWetnessOverride) : sample.wetness
  out.wetness = wet
  out.puddleCoverage = look.weatherWetnessOverride >= 0 ? Math.max(0, (wet - 0.35) / 0.6) : sample.puddles
  out.windSpeed = lerp(2, pick("windSpeed"), Math.min(1, rain * 2))
  out.windDir = pick("windDir")
  out.windGust = pick("windGust")
  out.mist = pick("mist") * Math.min(1, rain * 1.6)
  out.lightningRate = 0
  return out
}
