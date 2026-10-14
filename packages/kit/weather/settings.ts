import type { LabControl } from "../lab-panel"
import { Rng } from "../sim/rng"

export const WEATHER_PRESET_IDS = ["clear", "drizzle", "rain", "storm", "fog", "snow"] as const
export type WeatherPresetId = (typeof WEATHER_PRESET_IDS)[number]

export const WEATHER_GROUPS = ["precipitation", "splashes_wetness", "wind_atmosphere"] as const
export type WeatherGroup = (typeof WEATHER_GROUPS)[number]

/**
 * Canonical weather parameters shared across the Lab (`/arcade/lab`) and game adapters.
 *
 * Update boundaries (per docs/lab.md):
 * - All controls are **Live uniform / continuous-phase values**: `WeatherSimulation` integrates
 *   drop drift and wind phase incrementally over `dt`, so scrubbing `windSpeed`, `windDir`,
 *   `dropSpeed`, `density`, `litOnly`, `wetness`, `puddleCoverage`, `mist`, or `snowMode`
 *   updates immediately without clearing particles or jumping phase.
 */
export type WeatherSettings = {
  preset: WeatherPresetId
  /** Master weather intensity 0..1 (scales precipitation, splashes, wetness, and overcast). */
  intensity: number
  /** Precipitation particle density multiplier 0..3×. */
  density: number
  /** Streak width / snowflake radius multiplier 0.2..2.5×. */
  dropSize: number
  /** Streak motion-blur exposure / length multiplier 0.2..3.0×. */
  dropLength: number
  /** Terminal fall speed in m/s (1..20 m/s; slower in snowMode). */
  dropSpeed: number
  /**
   * Lit-only visibility 0..1:
   * - 0 = rain/snow is uniformly visible in ambient sky light and shadow.
   * - 1 = rain/snow outside practical lamp pools & flashlight cones fades into the dark while
   *   droplets inside light cones/pools flare brightly (the noir money shot).
   */
  litOnly: number
  /** Ground splash rings, impact crowns, and roof-eave drip rate multiplier 0..3×. */
  splashRate: number
  /** Surface wetness 0..1 (porous albedo darkening + roughness drop). */
  wetness: number
  /** Puddle coverage & mirror reflection sheen 0..1.5×. */
  puddleCoverage: number
  /** Mean horizontal wind speed in m/s (0..24 m/s). */
  windSpeed: number
  /** Wind direction in plan degrees (-180..180°, 0° = +X east, 90° = +Z south). */
  windDir: number
  /** Wind gust amplitude multiplier 0..2×. */
  windGust: number
  /** Low-lying mist & fog bank density 0..1.5×. */
  mist: number
  /** Lightning strike rate 0..1 (up to ~10 strikes/min in full storm). */
  lightningRate: number
  /** Snow mode: switches velocity-stretched rain streaks & puddles to fluttering 3D snowflakes & surface frost. */
  snowMode: boolean
}

export type WeatherNumericKey = Exclude<keyof WeatherSettings, "preset" | "snowMode">

export const weatherDefaults: WeatherSettings = {
  preset: "clear",
  intensity: 0,
  density: 1.0,
  dropSize: 1.0,
  dropLength: 1.0,
  dropSpeed: 11.0,
  litOnly: 0.78,
  splashRate: 0,
  wetness: 0,
  puddleCoverage: 0,
  windSpeed: 2.0,
  windDir: -28,
  windGust: 0.35,
  mist: 0,
  lightningRate: 0,
  snowMode: false,
}

export const weatherRanges: Record<
  WeatherNumericKey,
  readonly [min: number, max: number, step: number, unit: string, group: string, label: string]
> = {
  intensity: [0, 1, 0.02, "", "Precipitation", "Weather intensity"],
  density: [0, 3, 0.05, "×", "Precipitation", "Drop density"],
  dropSize: [0.2, 2.5, 0.05, "×", "Precipitation", "Drop size"],
  dropLength: [0.2, 3.0, 0.05, "×", "Precipitation", "Streak length"],
  dropSpeed: [1.0, 20.0, 0.2, "m/s", "Precipitation", "Fall speed"],
  litOnly: [0, 1, 0.02, "", "Precipitation", "Lit-only visibility"],
  splashRate: [0, 3, 0.05, "×", "Splashes & Wetness", "Splash & drip rate"],
  wetness: [0, 1, 0.02, "", "Splashes & Wetness", "Surface wetness"],
  puddleCoverage: [0, 1.5, 0.02, "×", "Splashes & Wetness", "Puddle coverage"],
  windSpeed: [0, 24, 0.5, "m/s", "Wind & Atmosphere", "Wind speed"],
  windDir: [-180, 180, 5, "°", "Wind & Atmosphere", "Wind direction"],
  windGust: [0, 2.0, 0.05, "×", "Wind & Atmosphere", "Wind gustiness"],
  mist: [0, 1.5, 0.02, "×", "Wind & Atmosphere", "Mist & fog banks"],
  lightningRate: [0, 1, 0.02, "", "Wind & Atmosphere", "Lightning rate"],
}

export function isWeatherPresetId(v: unknown): v is WeatherPresetId {
  return typeof v === "string" && (WEATHER_PRESET_IDS as readonly string[]).includes(v)
}

export function resolveWeatherPresetId(raw: unknown): WeatherPresetId | null {
  if (typeof raw !== "string") return null
  const s = raw.trim().toLowerCase().replace(/[\s-]+/g, "_")
  if (isWeatherPresetId(s)) return s
  if (s === "none" || s === "off" || s === "dry") return "clear"
  if (s === "light" || s === "light_rain") return "drizzle"
  if (s === "medium" || s === "downpour" || s === "noir_rain") return "rain"
  if (s === "heavy" || s === "thunderstorm" || s === "tempest") return "storm"
  if (s === "mist" || s === "haze") return "fog"
  if (s === "blizzard" || s === "winter" || s === "flurry") return "snow"
  return null
}

export function weatherSettings(input: Partial<WeatherSettings> = {}): WeatherSettings {
  const out: WeatherSettings = { ...weatherDefaults }
  if (input.preset && isWeatherPresetId(input.preset)) {
    out.preset = input.preset
  }
  for (const key of Object.keys(weatherRanges) as WeatherNumericKey[]) {
    const val = input[key]
    const [min, max] = weatherRanges[key]
    if (typeof val === "number" && Number.isFinite(val)) {
      out[key] = Math.max(min, Math.min(max, val))
    }
  }
  if (typeof input.snowMode === "boolean") {
    out.snowMode = input.snowMode
  }
  return out
}

export const WEATHER_PRESETS: Readonly<
  Record<
    WeatherPresetId,
    { readonly id: WeatherPresetId; readonly label: string; readonly description: string; readonly settings: Readonly<WeatherSettings> }
  >
> = {
  clear: {
    id: "clear",
    label: "Clear",
    description: "Dry street and clear air; zero weather draw overhead.",
    settings: weatherSettings({
      preset: "clear",
      intensity: 0,
      density: 1.0,
      dropSize: 1.0,
      dropLength: 1.0,
      dropSpeed: 11.0,
      litOnly: 0.78,
      splashRate: 0,
      wetness: 0,
      puddleCoverage: 0,
      windSpeed: 2.0,
      windDir: -28,
      windGust: 0.35,
      mist: 0,
      lightningRate: 0,
      snowMode: false,
    }),
  },
  drizzle: {
    id: "drizzle",
    label: "Drizzle",
    description: "Fine misting rain, damp pavement sheen, and subtle ripples in light pools.",
    settings: weatherSettings({
      preset: "drizzle",
      intensity: 0.42,
      density: 0.75,
      dropSize: 0.82,
      dropLength: 0.80,
      dropSpeed: 8.8,
      litOnly: 0.82,
      splashRate: 0.65,
      wetness: 0.54,
      puddleCoverage: 0.48,
      windSpeed: 4.0,
      windDir: -22,
      windGust: 0.50,
      mist: 0.32,
      lightningRate: 0,
      snowMode: false,
    }),
  },
  rain: {
    id: "rain",
    label: "Rain",
    description: "Steady noir rainfall lit by streetlamps and flashlights, with wet asphalt puddles and eave drips.",
    settings: weatherSettings({
      preset: "rain",
      intensity: 0.82,
      density: 1.45,
      dropSize: 1.08,
      dropLength: 1.22,
      dropSpeed: 11.8,
      litOnly: 0.78,
      splashRate: 1.40,
      wetness: 0.86,
      puddleCoverage: 0.96,
      windSpeed: 7.5,
      windDir: -28,
      windGust: 0.85,
      mist: 0.52,
      lightningRate: 0.08,
      snowMode: false,
    }),
  },
  storm: {
    id: "storm",
    label: "Storm",
    description: "Driving wind-slanted downpour, heavy splash crowns, flooded puddles, gusting mist, and lightning.",
    settings: weatherSettings({
      preset: "storm",
      intensity: 1.0,
      density: 2.25,
      dropSize: 1.26,
      dropLength: 1.62,
      dropSpeed: 15.0,
      litOnly: 0.70,
      splashRate: 2.25,
      wetness: 1.0,
      puddleCoverage: 1.32,
      windSpeed: 15.5,
      windDir: -36,
      windGust: 1.45,
      mist: 0.88,
      lightningRate: 0.68,
      snowMode: false,
    }),
  },
  fog: {
    id: "fog",
    label: "Fog",
    description: "Thick ground-hugging mist banks inscattered by streetlamps and flashlight beams over damp pavement.",
    settings: weatherSettings({
      preset: "fog",
      intensity: 0.28,
      density: 0.22,
      dropSize: 0.70,
      dropLength: 0.55,
      dropSpeed: 5.8,
      litOnly: 0.88,
      splashRate: 0.15,
      wetness: 0.44,
      puddleCoverage: 0.38,
      windSpeed: 2.5,
      windDir: -18,
      windGust: 0.40,
      mist: 1.40,
      lightningRate: 0,
      snowMode: false,
    }),
  },
  snow: {
    id: "snow",
    label: "Snow",
    description: "Wind-drifted, fluttering snowflakes catching light cones with cool frost accumulation on roofs and turf.",
    settings: weatherSettings({
      preset: "snow",
      intensity: 0.85,
      density: 1.65,
      dropSize: 1.42,
      dropLength: 0.45,
      dropSpeed: 2.4,
      litOnly: 0.65,
      splashRate: 0.30,
      wetness: 0.32,
      puddleCoverage: 0.22,
      windSpeed: 6.5,
      windDir: -25,
      windGust: 0.95,
      mist: 0.56,
      lightningRate: 0,
      snowMode: true,
    }),
  },
}

export const weatherPresetOptions: readonly { value: WeatherPresetId; label: string }[] = WEATHER_PRESET_IDS.map(id => ({
  value: id,
  label: WEATHER_PRESETS[id].label,
}))

export function createWeatherSettings(preset: WeatherPresetId = "clear"): WeatherSettings {
  return { ...WEATHER_PRESETS[preset].settings }
}

export function applyWeatherPreset(target: WeatherSettings, preset: WeatherPresetId): WeatherSettings {
  const src = WEATHER_PRESETS[preset]?.settings ?? WEATHER_PRESETS.clear.settings
  Object.assign(target, src)
  return target
}

/** True when weather is completely off / clear, allowing renderers to skip weather draws with zero GPU cost. */
export function isClearWeather(s: Readonly<WeatherSettings>): boolean {
  return (
    s.intensity <= 0.001 &&
    s.wetness <= 0.001 &&
    s.puddleCoverage <= 0.001 &&
    s.mist <= 0.001 &&
    s.lightningRate <= 0.001
  )
}

export function resolveWeatherGroup(raw: string): WeatherGroup | "all" | null {
  const s = raw.trim().toLowerCase().replace(/[\s&-]+/g, "_")
  if (!s || s === "all") return "all"
  if (s.includes("precip") || s.includes("drop") || s.includes("rain") || s.includes("snow")) return "precipitation"
  if (s.includes("splash") || s.includes("wet") || s.includes("puddle")) return "splashes_wetness"
  if (s.includes("wind") || s.includes("atmos") || s.includes("mist") || s.includes("fog") || s.includes("light")) return "wind_atmosphere"
  return null
}

/**
 * Deterministic parameter randomization using an isolated `tuningSeed`.
 * Respects `min`/`max`/`step` and leaves room/world seeds untouched per `docs/lab.md`.
 */
export function randomizeWeatherSettings(
  current: Readonly<WeatherSettings>,
  tuningSeed: number,
  group: WeatherGroup | "all" = "all",
): WeatherSettings {
  const rng = new Rng(((Math.trunc(tuningSeed) || 1) ^ 0x6a09e667) >>> 0)
  const next: WeatherSettings = { ...current }
  const snap = (key: WeatherNumericKey, u: number, loFrac = 0.18, hiFrac = 0.85): number => {
    const [min, max, step] = weatherRanges[key]
    const span = max - min
    const raw = min + span * (loFrac + u * (hiFrac - loFrac))
    const stepped = min + Math.round((raw - min) / step) * step
    return Number(Math.max(min, Math.min(max, stepped)).toFixed(4))
  }

  if (group === "all" || group === "precipitation") {
    next.intensity = snap("intensity", rng.next(), 0.35, 0.98)
    next.density = snap("density", rng.next(), 0.5, 2.4)
    next.dropSize = snap("dropSize", rng.next(), 0.65, 1.65)
    next.dropLength = next.snowMode
      ? snap("dropLength", rng.next(), 0.3, 0.75)
      : snap("dropLength", rng.next(), 0.65, 1.85)
    next.dropSpeed = next.snowMode
      ? snap("dropSpeed", rng.next(), 0.05, 0.22)
      : snap("dropSpeed", rng.next(), 0.35, 0.82)
    next.litOnly = snap("litOnly", rng.next(), 0.45, 0.92)
  }

  if (group === "all" || group === "splashes_wetness") {
    next.splashRate = next.snowMode
      ? snap("splashRate", rng.next(), 0.05, 0.35)
      : snap("splashRate", rng.next(), 0.4, 2.2)
    next.wetness = snap("wetness", rng.next(), 0.35, 1.0)
    next.puddleCoverage = snap("puddleCoverage", rng.next(), 0.25, 1.25)
  }

  if (group === "all" || group === "wind_atmosphere") {
    next.windSpeed = snap("windSpeed", rng.next(), 0.1, 0.75)
    next.windDir = snap("windDir", rng.next(), 0.25, 0.75)
    next.windGust = snap("windGust", rng.next(), 0.25, 1.6)
    next.mist = snap("mist", rng.next(), 0.15, 1.15)
    next.lightningRate = next.snowMode ? 0 : snap("lightningRate", rng.next(), 0, 0.65)
  }

  return next
}

export type CreateWeatherControlsOptions = {
  includePresetPicker?: boolean
  groupPrefix?: string
  folded?: boolean
  onChange?: (key: keyof WeatherSettings, value: number | string | boolean) => void
  onRandomizeGroup?: (group: WeatherGroup) => void
  onTriggerLightning?: () => void
}

export function createWeatherControls(
  _target: Record<string, string | number | boolean>,
  options: CreateWeatherControlsOptions = {},
): LabControl[] {
  const prefix = options.groupPrefix ? `${options.groupPrefix} · ` : ""
  const controls: LabControl[] = []

  if (options.includePresetPicker !== false) {
    controls.push({
      key: "preset",
      label: "Weather preset",
      group: `${prefix}Precipitation`,
      type: "select",
      options: weatherPresetOptions,
      folded: options.folded,
      change: val => options.onChange?.("preset", val),
    })
  }

  for (const key of Object.keys(weatherRanges) as WeatherNumericKey[]) {
    const [min, max, step, unit, baseGroup, label] = weatherRanges[key]
    controls.push({
      key,
      label,
      group: `${prefix}${baseGroup}`,
      type: "range",
      min,
      max,
      step,
      unit,
      folded: options.folded,
      change: val => options.onChange?.(key, val),
    })
    if (key === "litOnly") {
      controls.push({
        key: "snowMode",
        label: "Snow mode",
        group: `${prefix}Precipitation`,
        type: "toggle",
        folded: options.folded,
        change: val => options.onChange?.("snowMode", Boolean(val)),
      })
      if (options.onRandomizeGroup) {
        controls.push({
          key: "randomizePrecipitation",
          label: "Randomize Precipitation",
          group: `${prefix}Precipitation`,
          type: "action",
          folded: options.folded,
          run: () => options.onRandomizeGroup!("precipitation"),
        })
      }
    }
    if (key === "puddleCoverage" && options.onRandomizeGroup) {
      controls.push({
        key: "randomizeSplashesWetness",
        label: "Randomize Splashes & Wetness",
        group: `${prefix}Splashes & Wetness`,
        type: "action",
        folded: options.folded,
        run: () => options.onRandomizeGroup!("splashes_wetness"),
      })
    }
    if (key === "lightningRate") {
      if (options.onTriggerLightning) {
        controls.push({
          key: "triggerLightning",
          label: "Trigger lightning strike",
          group: `${prefix}Wind & Atmosphere`,
          type: "action",
          folded: options.folded,
          run: () => options.onTriggerLightning!(),
        })
      }
      if (options.onRandomizeGroup) {
        controls.push({
          key: "randomizeWindAtmosphere",
          label: "Randomize Wind & Atmosphere",
          group: `${prefix}Wind & Atmosphere`,
          type: "action",
          folded: options.folded,
          run: () => options.onRandomizeGroup!("wind_atmosphere"),
        })
      }
    }
  }

  return controls
}

export type WeatherPresetV1 = {
  version: 1
  kind: "weather"
  preset: WeatherPresetId
  tuningSeed: number
  roomSeed: number
  settings: WeatherSettings
}

export function exportWeatherPreset(
  settings: Readonly<WeatherSettings>,
  seeds: { tuningSeed?: number; roomSeed?: number } = {},
): WeatherPresetV1 {
  const clean = weatherSettings(settings)
  return {
    version: 1,
    kind: "weather",
    preset: clean.preset,
    tuningSeed: Math.max(1, Math.min(9999, Math.round(seeds.tuningSeed ?? 73))),
    roomSeed: Math.max(1, Math.min(999, Math.round(seeds.roomSeed ?? 7))),
    settings: clean,
  }
}

export function importWeatherPreset(
  raw: string | unknown,
): { ok: true; value: WeatherPresetV1 } | { ok: false; error: string } {
  let parsed: unknown = raw
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { ok: false, error: "Invalid JSON syntax in weather preset." }
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "Weather preset must be a JSON object." }
  }
  const obj = parsed as Record<string, unknown>
  if (obj.version !== 1) {
    return { ok: false, error: `Unsupported weather preset version: ${String(obj.version)} (expected 1).` }
  }
  const rawSettings =
    obj.settings && typeof obj.settings === "object" && !Array.isArray(obj.settings)
      ? (obj.settings as Record<string, unknown>)
      : obj
  const pid = resolveWeatherPresetId(rawSettings.preset ?? obj.preset ?? "rain")
  if (!pid) {
    return { ok: false, error: `Invalid weather preset ID: "${String(rawSettings.preset ?? obj.preset)}".` }
  }
  const candidate: Partial<WeatherSettings> = { ...WEATHER_PRESETS[pid].settings, preset: pid }
  for (const key of Object.keys(weatherRanges) as WeatherNumericKey[]) {
    if (key in rawSettings) {
      const v = rawSettings[key]
      if (typeof v !== "number" || !Number.isFinite(v)) {
        return { ok: false, error: `Weather setting "${key}" must be a finite number.` }
      }
      candidate[key] = v
    }
  }
  if ("snowMode" in rawSettings) {
    if (typeof rawSettings.snowMode !== "boolean") {
      return { ok: false, error: `Weather setting "snowMode" must be a boolean.` }
    }
    candidate.snowMode = rawSettings.snowMode
  }
  const validated = weatherSettings(candidate)
  const tuningSeed =
    typeof obj.tuningSeed === "number" && Number.isFinite(obj.tuningSeed)
      ? Math.max(1, Math.min(9999, Math.round(obj.tuningSeed)))
      : typeof rawSettings.tuningSeed === "number" && Number.isFinite(rawSettings.tuningSeed)
        ? Math.max(1, Math.min(9999, Math.round(rawSettings.tuningSeed)))
        : 73
  const roomSeed =
    typeof obj.roomSeed === "number" && Number.isFinite(obj.roomSeed)
      ? Math.max(1, Math.min(999, Math.round(obj.roomSeed)))
      : typeof rawSettings.roomSeed === "number" && Number.isFinite(rawSettings.roomSeed)
        ? Math.max(1, Math.min(999, Math.round(rawSettings.roomSeed)))
        : 7
  return {
    ok: true,
    value: {
      version: 1,
      kind: "weather",
      preset: validated.preset,
      tuningSeed,
      roomSeed,
      settings: validated,
    },
  }
}
