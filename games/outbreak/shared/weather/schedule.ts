import { dayCycle } from "../day-cycle"

/**
 * The weather over a run (AR-71): clear spells, drizzle, rain and the odd storm, seeded per town and changing slowly.
 *
 * Everything here is a pure function of the town seed, the simulation clock (`sim.time`, seconds) and the hour, which
 * every co-op snapshot already carries, so the room and each client compute the same weather with no wire fields.
 *
 * Time is cut into fronts `weatherFrontMinutes` long. Each front rolls once: most are dry, some rain, and some of the
 * rainy ones are strong enough to storm. A front eases into the next over the last `FRONT_BLEND` of its length, so
 * rain builds and fades over a minute or two rather than switching. A storm front only storms in the dark (by day it
 * is heavy rain with the odd flash), so storms come mostly at night. The opening `weatherCalmMinutes` stay dry.
 *
 * Wetness is the rain soaked into the ground: a leaky integral of past rain, soaking in over `weatherSoakSeconds` and
 * drying over `weatherDrySeconds`, evaluated over a fixed window of past samples so it stays a pure function too.
 */
export type WeatherTuning = {
  /** 1: the seeded weather cycle. 0: Today (always clear, dry ground). */
  weatherCycle: number
  /** -1 follows the cycle; 0..3 holds clear, drizzle, rain or storm (Lab and `arcade cmd weather.set`). */
  weatherOverride: number
  /** Real minutes per weather front (a day is 12 minutes at the default clock). */
  weatherFrontMinutes: number
  /** Share of fronts that bring rain at all. */
  weatherRainChance: number
  /** Share of rainy fronts strong enough to storm (in the dark). */
  weatherStormChance: number
  /** The opening stays dry this many real minutes. */
  weatherCalmMinutes: number
  /** Seconds of steady rain to soak the ground about two thirds of the way. */
  weatherSoakSeconds: number
  /** Seconds for wet ground to lose about two thirds of its water once the rain stops. */
  weatherDrySeconds: number
  /** Lightning strikes per minute at full storm. */
  weatherLightningPerMinute: number
  /** Share of the dead's hearing lost under full rain (rain masks footsteps and doors). */
  rainHearingMask: number
  /** Share of the dead's sight range lost under full rain. */
  rainSightLoss: number
}

export const DEFAULT_WEATHER_TUNING: WeatherTuning = {
  weatherCycle: 1,
  weatherOverride: -1,
  weatherFrontMinutes: 4,
  weatherRainChance: 0.42,
  weatherStormChance: 0.45,
  weatherCalmMinutes: 3,
  weatherSoakSeconds: 45,
  weatherDrySeconds: 200,
  weatherLightningPerMinute: 4,
  rainHearingMask: 0.3,
  rainSightLoss: 0.12,
}

export const WEATHER_STATES = ["clear", "drizzle", "rain", "storm"] as const
export type WeatherStateName = (typeof WEATHER_STATES)[number]

export function weatherStateIndex(name: string): number {
  const i = (WEATHER_STATES as readonly string[]).indexOf(name.trim().toLowerCase())
  return i
}

/** One moment's weather. */
export type WeatherSample = {
  state: WeatherStateName
  /** Rainfall 0..1 (0.1–0.4 drizzle, 1 a downpour). */
  rain: number
  /** Storm strength 0..1: drives lightning, wind and the heaviest rain. */
  storm: number
  /** Ground wetness 0..1 (soaks in during rain, dries after). */
  wetness: number
  /** Standing water 0..1: puddles fill once the ground is soaked. */
  puddles: number
  /** Lightning strikes per minute right now. */
  lightningPerMinute: number
  /** Multiplier on the dead's hearing (1 = dry). */
  hearing: number
  /** Multiplier on the dead's sight range (1 = dry). */
  sight: number
}

/** Fixed rain and storm per override state. */
const OVERRIDE_LEVELS: readonly (readonly [rain: number, storm: number])[] = [
  [0, 0],
  [0.3, 0],
  [0.78, 0],
  [1, 1],
]

const FRONT_BLEND = 0.4
const HISTORY_STEP = 10
const HISTORY_TAPS = 72

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
const smoothstep = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a))
  return t * t * (3 - 2 * t)
}

/** Deterministic 0..1 hash of (seed, slot, salt). */
export function weatherHash(seed: number, slot: number, salt: number): number {
  let h = Math.imul((seed ^ 0x51ed27a3) >>> 0, 0x9e3779b1) ^ Math.imul(slot | 0, 0x85ebca6b) ^ Math.imul(salt + 0x27d4eb2f, 0xc2b2ae35)
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39)
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296
}

/** One front's roll: rainfall 0..1 and whether it can storm (0..1). */
function front(seed: number, n: number, t: WeatherTuning): readonly [rain: number, stormCap: number] {
  if (n < 0) return [0, 0]
  const u = weatherHash(seed, n, 1)
  const wetShare = clamp01(t.weatherRainChance)
  if (u < 1 - wetShare || wetShare <= 0) return [0, 0]
  const r = (u - (1 - wetShare)) / wetShare
  const rain = 0.18 + 0.82 * r
  const stormCap = smoothstep(1 - clamp01(t.weatherStormChance), 1 - clamp01(t.weatherStormChance) + 0.08, r)
  return [rain, stormCap]
}

const frontScratch: [number, number] = [0, 0]

/** Rainfall and storm capability at `time`, blended across fronts and held dry through the opening calm. */
function frontLevels(seed: number, time: number, t: WeatherTuning, out: [number, number]): [number, number] {
  const period = Math.max(20, t.weatherFrontMinutes * 60)
  const x = Math.max(0, time) / period
  const n = Math.floor(x)
  const f = x - n
  const a = front(seed, n, t)
  const b = front(seed, n + 1, t)
  const w = smoothstep(1 - FRONT_BLEND, 1, f)
  const calm = Math.max(0, t.weatherCalmMinutes) * 60
  const open = calm > 0 ? smoothstep(calm, calm + 60, time) : 1
  out[0] = (a[0] + (b[0] - a[0]) * w) * open
  out[1] = (a[1] + (b[1] - a[1]) * w) * open
  return out
}

/** How dark it is for storms: 0 by day, 1 at night. */
export function stormNight(hour: number): number {
  return smoothstep(0.55, 0.95, dayCycle(hour).darkness)
}

function rainAt(seed: number, time: number, t: WeatherTuning): number {
  return frontLevels(seed, time, t, frontScratch)[0]
}

/** Soaked-in water 0..1 from the past `HISTORY_TAPS × HISTORY_STEP` seconds of rain. */
export function wetnessAt(seed: number, time: number, t: WeatherTuning): number {
  if (!(t.weatherCycle >= 1)) return 0
  const soak = Math.max(1, t.weatherSoakSeconds)
  const dry = Math.max(1, t.weatherDrySeconds)
  if (t.weatherOverride >= 0) {
    const rain = OVERRIDE_LEVELS[Math.min(3, Math.round(t.weatherOverride))]![0]
    return 1 - Math.exp(-(rain * dry) / soak)
  }
  let sum = 0
  const k = HISTORY_STEP / soak
  for (let i = 0; i < HISTORY_TAPS; i++) {
    const at = time - i * HISTORY_STEP
    if (at < 0) break
    sum += rainAt(seed, at, t) * k * Math.exp((-i * HISTORY_STEP) / dry)
  }
  return 1 - Math.exp(-sum)
}

/** Classifies rain and storm into a named state. */
export function weatherStateOf(rain: number, storm: number): WeatherStateName {
  if (storm > 0.45 && rain > 0.5) return "storm"
  if (rain > 0.5) return "rain"
  if (rain > 0.08) return "drizzle"
  return "clear"
}

const CLEAR: WeatherSample = Object.freeze({
  state: "clear",
  rain: 0,
  storm: 0,
  wetness: 0,
  puddles: 0,
  lightningPerMinute: 0,
  hearing: 1,
  sight: 1,
}) as WeatherSample

/** Rain and storm right now (no wetness): the cheap half of `sampleWeather`, used per lightning slot. */
export function weatherLevels(seed: number, time: number, hour: number, t: WeatherTuning, out: [number, number] = [0, 0]): [number, number] {
  if (!(t.weatherCycle >= 1)) {
    out[0] = 0
    out[1] = 0
    return out
  }
  if (t.weatherOverride >= 0) {
    const lv = OVERRIDE_LEVELS[Math.min(3, Math.max(0, Math.round(t.weatherOverride)))]!
    out[0] = lv[0]
    out[1] = lv[1]
    return out
  }
  frontLevels(seed, time, t, out)
  // By day a storm front is heavy rain with the odd flash; in the dark it storms.
  out[1] = out[1] * (0.12 + 0.88 * stormNight(hour)) * smoothstep(0.35, 0.7, out[0])
  return out
}

const levelScratch: [number, number] = [0, 0]

/** The weather at `time` (sim seconds) and `hour` for a town seed. */
export function sampleWeather(seed: number, time: number, hour: number, t: WeatherTuning = DEFAULT_WEATHER_TUNING, out?: WeatherSample): WeatherSample {
  const target = out ?? { ...CLEAR }
  if (!(t.weatherCycle >= 1)) return Object.assign(target, CLEAR)
  const [rain, storm] = weatherLevels(seed, time, hour, t, levelScratch)
  const wetness = wetnessAt(seed, time, t)
  const heavy = clamp01(rain * (1 + 0.25 * storm))
  target.state = weatherStateOf(rain, storm)
  target.rain = rain
  target.storm = storm
  target.wetness = wetness
  target.puddles = smoothstep(0.35, 0.95, wetness)
  target.lightningPerMinute = storm > 0.05 ? Math.max(0, t.weatherLightningPerMinute) * storm : 0
  target.hearing = 1 - clamp01(t.rainHearingMask) * heavy
  target.sight = 1 - clamp01(t.rainSightLoss) * heavy
  return target
}

const TUNING_KEYS = Object.keys(DEFAULT_WEATHER_TUNING) as (keyof WeatherTuning)[]

/**
 * `sampleWeather` into `out` at most once a sim second (wetness walks a window of past rain), and again at once when the
 * seed, the hour (to a tenth) or any tuning value changes. `key` holds what `out` was sampled for between calls.
 */
export function sampleWeatherCached(seed: number, time: number, hour: number, t: WeatherTuning, key: number[], out: WeatherSample): WeatherSample {
  const second = Math.floor(time)
  const tenth = Math.floor(hour * 10)
  let same = key.length === TUNING_KEYS.length + 3 && key[0] === seed && key[1] === second && key[2] === tenth
  for (let i = 0; same && i < TUNING_KEYS.length; i++) same = key[i + 3] === t[TUNING_KEYS[i]!]
  if (same) return out
  key.length = 0
  key.push(seed, second, tenth)
  for (const k of TUNING_KEYS) key.push(t[k])
  return sampleWeather(seed, time, hour, t, out)
}

/** Resolves the weather tuning from the features' resolved tuning (`resolved.features.weather`). */
export function weatherTuning(features: Readonly<Record<string, Record<string, unknown>>> | undefined): WeatherTuning {
  return (features?.weather as WeatherTuning | undefined) ?? DEFAULT_WEATHER_TUNING
}

/** Lab controls for the shared half (Backquote › Weather); the values live in the weather settings and apply live. */
export const weatherCycleControls = [
  {
    key: "weather.weatherCycle",
    field: "weatherCycle",
    label: "Weather",
    group: "Weather",
    options: [
      { label: "Today (always clear)", value: 0 },
      { label: "Seeded cycle", value: 1 },
    ],
  },
  {
    key: "weather.weatherOverride",
    field: "weatherOverride",
    label: "Weather state",
    group: "Weather",
    options: [
      { label: "Follow the cycle", value: -1 },
      { label: "Clear", value: 0 },
      { label: "Drizzle", value: 1 },
      { label: "Rain", value: 2 },
      { label: "Storm", value: 3 },
    ],
  },
  { key: "weather.weatherFrontMinutes", field: "weatherFrontMinutes", label: "Front length", group: "Weather", min: 1, max: 12, step: 0.5, unit: "min" },
  { key: "weather.weatherRainChance", field: "weatherRainChance", label: "Fronts that rain", group: "Weather", min: 0, max: 1, step: 0.02, unit: "" },
  { key: "weather.weatherStormChance", field: "weatherStormChance", label: "Rain fronts that storm", group: "Weather", min: 0, max: 1, step: 0.02, unit: "" },
  { key: "weather.weatherCalmMinutes", field: "weatherCalmMinutes", label: "Dry opening", group: "Weather", min: 0, max: 12, step: 0.5, unit: "min" },
  { key: "weather.weatherSoakSeconds", field: "weatherSoakSeconds", label: "Ground soaks in", group: "Weather", min: 5, max: 240, step: 5, unit: "s" },
  { key: "weather.weatherDrySeconds", field: "weatherDrySeconds", label: "Ground dries in", group: "Weather", min: 20, max: 600, step: 10, unit: "s" },
  { key: "weather.weatherLightningPerMinute", field: "weatherLightningPerMinute", label: "Lightning rate (full storm)", group: "Weather", min: 0, max: 20, step: 0.5, unit: "/min" },
  { key: "weather.rainHearingMask", field: "rainHearingMask", label: "Rain masks noise", group: "Weather", min: 0, max: 0.8, step: 0.05, unit: "×" },
  { key: "weather.rainSightLoss", field: "rainSightLoss", label: "Rain shortens zombie sight", group: "Weather", min: 0, max: 0.5, step: 0.02, unit: "×" },
] as const
