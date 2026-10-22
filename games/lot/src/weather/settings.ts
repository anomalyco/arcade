import type { LabControl } from "@arcade/kit/lab-panel"
import { resolveWeatherPresetId } from "@arcade/kit/weather/settings"

/** Backquote › Weather. Today is the dry night the Lot always had; the rest share the kit's weather presets. */
export type LotWeatherMode = "today" | "drizzle" | "rain" | "storm"
export type LotFlashes = "full" | "reduced" | "off"
export const LOT_WEATHER_MODES = ["today", "drizzle", "rain", "storm"] as const

/** Per-mode Lot tuning on top of the kit presets: lightning a minute, wind sway, glass rain, ground mist. */
export const LOT_WEATHER = {
  today: { strikes: 0, wind: 0, glass: 0, mist: 0, puddles: 0 },
  drizzle: { strikes: 0, wind: 0.25, glass: 0.35, mist: 0.15, puddles: 0.15 },
  rain: { strikes: 0.6, wind: 0.5, glass: 0.75, mist: 0.35, puddles: 0.35 },
  storm: { strikes: 3, wind: 1, glass: 1, mist: 0.85, puddles: 0.6 },
} as const satisfies Record<LotWeatherMode, Record<string, number>>

export type LotWeatherSettings = {
  weather: LotWeatherMode
  /** Lightning strikes a minute (Storm 3, Rain 0.6). */
  strikes: number
  /** Scene flash brightness (×). */
  flash: number
  /** Share of strikes that are cloud to cloud. */
  cloud: number
  /**
   * Lightning flashes: Full (one scene-light pulse per strike, the channel flickers with its restrikes), Reduced (slow,
   * dim, one soft swell; the default with prefers-reduced-motion) or Off (no bolt, no flash; thunder stays).
   */
  flashes: LotFlashes
  /** Tree sway and rain slant in gusts (×). */
  wind: number
  /** Rain running down the booth and lobby glass (×). */
  glass: number
  /** Extra standing water as the rain gets heavier (×). */
  puddles: number
  /** Ground mist and spray (×). */
  mist: number
  rainVolume: number
  thunderVolume: number
  windVolume: number
}

const reduced = () => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false

export function applyLotWeather(s: LotWeatherSettings, mode: LotWeatherMode) {
  const p = LOT_WEATHER[mode]
  Object.assign(s, { weather: mode, strikes: p.strikes, wind: p.wind, glass: p.glass, mist: p.mist, puddles: p.puddles })
  return s
}

/** `?weather=storm` (automation and deep links) starts in that mode; otherwise Today. */
export function lotWeatherDefaults(query?: URLSearchParams): LotWeatherSettings {
  const s: LotWeatherSettings = { weather: "today", strikes: 0, flash: 1, cloud: 0.25, flashes: reduced() ? "reduced" : "full", wind: 0, glass: 0, puddles: 0, mist: 0, rainVolume: 0.8, thunderVolume: 0.8, windVolume: 0.7 }
  const id = resolveWeatherPresetId(query?.get("weather"))
  const mode: LotWeatherMode = id === "drizzle" || id === "rain" || id === "storm" ? id : "today"
  return applyLotWeather(s, mode)
}

export function lotWeatherControls(s: LotWeatherSettings, strike: () => void): LabControl[] {
  const group = "Weather"
  const range = (key: keyof LotWeatherSettings, label: string, min: number, max: number, step: number, unit: string, subsection?: string): LabControl =>
    ({ key: `weather.${key}`, field: key, label, group, min, max, step, unit, ...(subsection ? { subsection } : {}), enabled: () => s.weather !== "today" })
  return [
    { key: "weather.weather", field: "weather", label: "Weather", group, type: "select",
      options: [{ value: "today", label: "Today" }, { value: "drizzle", label: "Drizzle" }, { value: "rain", label: "Rain" }, { value: "storm", label: "Storm" }],
      change: value => applyLotWeather(s, value as LotWeatherMode) },
    { key: "weather.strike", label: "Strike now", group, type: "action", run: strike },
    { key: "weather.flashes", field: "flashes", label: "Lightning flashes", group, type: "select",
      options: [{ value: "full", label: "Full" }, { value: "reduced", label: "Reduced" }, { value: "off", label: "Off" }] },
    range("strikes", "Lightning", 0, 12, 0.1, "/min", "Lightning"),
    range("flash", "Flash brightness", 0, 2, 0.05, "×", "Lightning"),
    range("cloud", "Cloud to cloud", 0, 1, 0.05, "share", "Lightning"),
    range("wind", "Wind", 0, 2, 0.05, "×", "Rain"),
    range("glass", "Rain on glass", 0, 1.5, 0.05, "×", "Rain"),
    range("puddles", "Extra puddles", 0, 1, 0.05, "×", "Rain"),
    range("mist", "Ground mist", 0, 1.5, 0.05, "×", "Rain"),
    range("rainVolume", "Rain", 0, 1.5, 0.05, "×", "Sound"),
    range("thunderVolume", "Thunder", 0, 1.5, 0.05, "×", "Sound"),
    range("windVolume", "Wind", 0, 1.5, 0.05, "×", "Sound"),
  ]
}
