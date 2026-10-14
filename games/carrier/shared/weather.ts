/**
 * Deterministic weather: a pure function of (room seed, sea time, room override), like the sea itself, so every client
 * (and the Durable Object) sees the same rain, wind and waves at the same moment without syncing any weather state
 * beyond an occasional override.
 *
 * Timeline. Sea time is cut into slots of WEATHER_SLOT seconds (each boundary jittered by up to ±WEATHER_JITTER). Every
 * slot holds one kind (clear, light, medium or heavy rain) drawn from a Markov chain that only ever steps to a
 * neighbouring kind, so storms build and ease through the middle kinds. The chain is evaluated by coupling from the past:
 * the lowest and highest start states run WEATHER_LOOKBACK slots on the same hashed random numbers; the update is
 * monotone, so once the two coalesce every start state agrees and the slot's kind is exact and O(1). The first
 * WEATHER_CALM_SLOTS slots of a room are always clear (players arrive to the sunny concept look). At each boundary the
 * parameters cross-fade over 60-120 s with a smootherstep, so every output is continuous in time.
 *
 * Overrides. A host or dev can force the weather: from sea time `at` the room fades from whatever it was (`from`, the
 * full parameter set, computed and rounded by the server) to a target (a kind's preset or any custom parameter set), or
 * back to the timeline (`to: null`). See `overrideTo` and `weatherNow`.
 *
 * Sea coupling. `makeWeatherSea(sea)` returns a Sea view whose wave amplitudes (and Gerstner steepness) follow the
 * weather: wavelengths, frequencies, directions and phases never change, so phases stay continuous and every existing
 * Sea function (seaHeight for buoyancy, packSea for the GPU) works on the view unchanged. See `seaScales`.
 *
 * No DOM or Worker APIs: this runs in the Durable Object and the browser.
 */
import { mulberry32 } from "./rng"
import { SEA_GRAVITY, SEA_MAX_WAVES, type Sea, type Wave } from "./sea"

export const WEATHER_KINDS = ["clear", "light", "medium", "heavy"] as const
export type WeatherKind = (typeof WEATHER_KINDS)[number]

/**
 * Every weather parameter. All blend linearly, so a transition is a straight line between two of these. Physics reads
 * only `sea` and `swell`; the rest is presentation.
 */
export type Weather = {
  /** Rain intensity 0..1: streak density, splashes, surface roughness. */
  rain: number
  /** Wind speed 0..1, WIND_KNOTS[0]..WIND_KNOTS[1] knots. */
  wind: number
  /** Degrees the rain and foam streaks' wind is turned from the sea's wind (waves keep the sea's directions). */
  windDir: number
  /** Sea state 0..1: 0 is the seed's sunny sea exactly, 1 a full storm (see seaScales). */
  sea: number
  /** Swell vs chop balance 0..1: 0.5 lets both kick up fully, 0 only the chop, 1 only the swell. */
  swell: number
  /** Extra whitecaps and wind foam 0..1 (0 = the sunny sea's crest foam). */
  foam: number
  /** Cloud cover 0..1: 0 the concept's scattered cumulus, 1 a solid overcast deck. */
  cloud: number
  /** Cloud darkness 0..1. */
  dark: number
  /** Fog 0..1: visibility from the clear sky's ~40 km down to ~1.2 km (log scale). */
  fog: number
  /** Sun intensity multiplier 0..1. */
  sun: number
  /** Lightning rate 0..1, up to LIGHTNING_PER_MIN strikes per minute. */
  lightning: number
  /** Rain streak length multiplier (1 = motion-blur length of a real drop). */
  streak: number
  /** Rain streak density multiplier. */
  density: number
  /** Splash amount multiplier on the water. */
  splash: number
  /** Grade: desaturation 0..1. */
  desat: number
  /** Grade: darkening 0..1. */
  darken: number
}

/** Field order for the compact wire form (packWeather). Append only. */
export const WEATHER_KEYS = ["rain", "wind", "windDir", "sea", "swell", "foam", "cloud", "dark", "fog", "sun", "lightning", "streak", "density", "splash", "desat", "darken"] as const satisfies readonly (keyof Weather)[]

/** Valid range per field (sliders and network validation). */
export const WEATHER_RANGE: Record<keyof Weather, readonly [number, number]> = {
  rain: [0, 1],
  wind: [0, 1],
  windDir: [-180, 180],
  sea: [0, 1],
  swell: [0, 1],
  foam: [0, 1],
  cloud: [0, 1],
  dark: [0, 1],
  fog: [0, 1],
  sun: [0, 1],
  lightning: [0, 1],
  streak: [0, 3],
  density: [0, 3],
  splash: [0, 3],
  desat: [0, 1],
  darken: [0, 1],
}

export const WEATHER_PRESETS: Record<WeatherKind, Readonly<Weather>> = {
  clear: { rain: 0, wind: 0.18, windDir: 0, sea: 0, swell: 0.5, foam: 0, cloud: 0, dark: 0, fog: 0, sun: 1, lightning: 0, streak: 1, density: 1, splash: 1, desat: 0, darken: 0 },
  light: { rain: 0.3, wind: 0.36, windDir: 0, sea: 0.25, swell: 0.5, foam: 0.2, cloud: 0.55, dark: 0.25, fog: 0, sun: 0.55, lightning: 0, streak: 1, density: 1, splash: 1, desat: 0.25, darken: 0.12 },
  medium: { rain: 0.62, wind: 0.62, windDir: 0, sea: 0.55, swell: 0.5, foam: 0.5, cloud: 0.85, dark: 0.55, fog: 0, sun: 0.28, lightning: 0.08, streak: 1, density: 1, splash: 1, desat: 0.45, darken: 0.3 },
  heavy: { rain: 1, wind: 1, windDir: 0, sea: 1, swell: 0.5, foam: 1, cloud: 1, dark: 0.85, fog: 0, sun: 0.1, lightning: 0.7, streak: 1, density: 1, splash: 1, desat: 0.6, darken: 0.5 },
}

/** Wind speed in knots at weather.wind = 0 and 1. */
export const WIND_KNOTS: readonly [number, number] = [6, 50]
export const windKnots = (w: Weather): number => WIND_KNOTS[0] + (WIND_KNOTS[1] - WIND_KNOTS[0]) * w.wind
export const windMs = (w: Weather): number => windKnots(w) * 0.514444

/** Nearest kind by rain intensity (for readouts). */
export function kindOf(w: Weather): WeatherKind {
  let best: WeatherKind = "clear"
  let bd = Infinity
  for (const k of WEATHER_KINDS) {
    const d = Math.abs(WEATHER_PRESETS[k].rain - w.rain)
    if (d < bd) {
      bd = d
      best = k
    }
  }
  return best
}

export const makeWeather = (from: Readonly<Weather> = WEATHER_PRESETS.clear): Weather => ({ ...from })

export function copyWeather(from: Readonly<Weather>, out: Weather): Weather {
  for (const k of WEATHER_KEYS) out[k] = from[k]
  return out
}

/** out = a + (b - a) · u for every field (exactly a at u <= 0 and b at u >= 1). */
export function mixWeather(a: Readonly<Weather>, b: Readonly<Weather>, u: number, out: Weather): Weather {
  if (u <= 0) return copyWeather(a, out)
  if (u >= 1) return copyWeather(b, out)
  for (const k of WEATHER_KEYS) out[k] = a[k] + (b[k] - a[k]) * u
  return out
}

/** C2-continuous ease for every transition (zero first and second derivative at both ends). */
export function weatherEase(u: number): number {
  const x = u <= 0 ? 0 : u >= 1 ? 1 : u
  return x * x * x * (x * (x * 6 - 15) + 10)
}

// ---------------------------------------------------------------------------------------------------------------
// Seeded timeline
// ---------------------------------------------------------------------------------------------------------------

/** Mean slot length (s). A kind holds for one or more slots. */
export const WEATHER_SLOT = 270
/** Each slot boundary moves by up to ± this (s), so dwell times vary. */
export const WEATHER_JITTER = 50
/** Cross-fade length range at a boundary (s), centred on it. */
export const WEATHER_FADE: readonly [number, number] = [60, 120]
/** Slots of a new room that are always clear. */
export const WEATHER_CALM_SLOTS = 2
/** Coupling-from-the-past window (slots). */
export const WEATHER_LOOKBACK = 64
/**
 * Chain probabilities per slot, by kind index. Steps are to neighbours only. Monotone coupling needs
 * P_UP[i] + P_DOWN[i + 1] <= 1. Stationary shares (detailed balance): clear ~46%, light ~26%, medium ~18%, heavy ~10%;
 * a clear spell lasts ~22 min on average, a storm episode (light and up) ~25 min, heavy ~8 min.
 */
export const WEATHER_P_UP: readonly number[] = [0.2, 0.25, 0.3, 0]
export const WEATHER_P_DOWN: readonly number[] = [0, 0.35, 0.35, 0.55]

function hash(seed: number, a: number, salt: number): number {
  let h = Math.imul((seed ^ 0x3c6ef372) >>> 0, 0x9e3779b1) ^ Math.imul(a | 0, 0x85ebca6b) ^ Math.imul(salt + 0x632be5ab, 0xc2b2ae35)
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39)
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296
}

/** The chain's update: kind index x to the next slot's, given that slot's uniform u. Monotone in x. */
export const weatherStep = (x: number, u: number): number => (u < WEATHER_P_DOWN[x]! ? x - 1 : u >= 1 - WEATHER_P_UP[x]! ? x + 1 : x)
const step = weatherStep

/** The chain's random number for slot k. */
export const slotUniform = (seed: number, k: number): number => hash(seed, k, 2)

/** Sea time where slot k begins. */
export function slotStart(seed: number, k: number): number {
  return k * WEATHER_SLOT + (hash(seed, k, 1) * 2 - 1) * WEATHER_JITTER
}

/** Cross-fade length at the start of slot k. */
export function slotFade(seed: number, k: number): number {
  return WEATHER_FADE[0] + (WEATHER_FADE[1] - WEATHER_FADE[0]) * hash(seed, k, 3)
}

const kindCache = new Map<number, number>()
let cacheSeed = -1

/** Kind index of slot k (0 clear .. 3 heavy). */
export function slotKind(seed: number, k: number): number {
  if (k < WEATHER_CALM_SLOTS) return 0
  if (cacheSeed !== seed) {
    kindCache.clear()
    cacheSeed = seed
  }
  const hit = kindCache.get(k)
  if (hit !== undefined) return hit
  // The calm start is a known state: run exactly from there when it is inside the window.
  const from = k - WEATHER_LOOKBACK
  let lo = 0
  let hi = from < WEATHER_CALM_SLOTS ? 0 : 3
  for (let j = Math.max(from, WEATHER_CALM_SLOTS); j <= k; j++) {
    const u = slotUniform(seed, j)
    lo = step(lo, u)
    hi = lo === hi ? lo : step(hi, u)
  }
  // Not coalesced (vanishingly rare, see tests): fall back to the calmer trajectory, still deterministic.
  const kind = lo
  if (kindCache.size > 256) kindCache.clear()
  kindCache.set(k, kind)
  return kind
}

/** Slot index containing sea time t. */
export function slotAt(seed: number, t: number): number {
  const k = Math.floor(t / WEATHER_SLOT)
  if (t < slotStart(seed, k)) return k - 1
  if (t >= slotStart(seed, k + 1)) return k + 1
  return k
}

/** The seeded timeline at sea time t (no override). */
export function weatherAt(seed: number, t: number, out: Weather = makeWeather()): Weather {
  const k = slotAt(seed, t)
  const kind = slotKind(seed, k)
  const start = slotStart(seed, k)
  const fadeIn = slotFade(seed, k)
  if (t < start + fadeIn / 2) {
    const prev = slotKind(seed, k - 1)
    if (prev !== kind) return mixWeather(PRESET[prev]!, PRESET[kind]!, weatherEase((t - start + fadeIn / 2) / fadeIn), out)
  } else {
    const end = slotStart(seed, k + 1)
    const fadeOut = slotFade(seed, k + 1)
    if (t > end - fadeOut / 2) {
      const next = slotKind(seed, k + 1)
      if (next !== kind) return mixWeather(PRESET[kind]!, PRESET[next]!, weatherEase((t - end + fadeOut / 2) / fadeOut), out)
    }
  }
  return copyWeather(PRESET[kind]!, out)
}
const PRESET = WEATHER_KINDS.map((k) => WEATHER_PRESETS[k])

export type WeatherSpan = { kind: WeatherKind; start: number; end: number }

/** Upcoming schedule from sea time t: consecutive spans of one kind (boundaries at the middle of each fade). */
export function weatherSchedule(seed: number, t: number, spans = 6): WeatherSpan[] {
  const k = slotAt(seed, t)
  let kind = slotKind(seed, k)
  // Walk back to where the current kind began, so the strip shows the current span's true start.
  let first = k
  while (first > 0 && k - first < 64 && slotKind(seed, first - 1) === kind) first--
  let start = slotStart(seed, first)
  const out: WeatherSpan[] = []
  for (let j = k + 1; out.length < spans && j < k + 2000; j++) {
    const next = slotKind(seed, j)
    if (next === kind) continue
    const end = slotStart(seed, j)
    out.push({ kind: WEATHER_KINDS[kind]!, start, end })
    start = end
    kind = next
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------------
// Overrides (room state)
// ---------------------------------------------------------------------------------------------------------------

/**
 * A room's weather override: from sea time `at`, fade over `fade` seconds from `from` to `to` (or back to the seeded
 * timeline when `to` is null). The server builds it with `overrideTo` (so `from` is exactly what every client was
 * showing at `at`) and sends it in `welcome` and in a `weather` message whenever it changes.
 */
export type WeatherOverride = { at: number; fade: number; from: Weather; to: Weather | null }

/** Default fade for an override (s). */
export const WEATHER_OVERRIDE_FADE = 90
/** The server starts an override this far ahead of its own sea time, so every client receives it before it begins. */
export const WEATHER_OVERRIDE_LEAD = 1

/** The room's weather at sea time t: the timeline, or the override's fade from its snapshot toward its target. */
export function weatherNow(seed: number, t: number, o: WeatherOverride | null, out: Weather = makeWeather()): Weather {
  if (!o || t <= o.at) return weatherAt(seed, t, out)
  const u = o.fade > 0 ? weatherEase((t - o.at) / o.fade) : 1
  const target = o.to ?? weatherAt(seed, t, scratchTarget)
  return mixWeather(o.from, target, u, out)
}
const scratchTarget = makeWeather()

/**
 * A room's override history as a client holds it: the latest override and the one it replaced, because a new one
 * arrives up to WEATHER_OVERRIDE_LEAD seconds before it begins and the old one still rules until then.
 */
export class RoomWeather {
  prev: WeatherOverride | null = null
  cur: WeatherOverride | null = null

  constructor(public seed = 0) {}

  /** A new override from the room (null: none). */
  set(o: WeatherOverride | null): void {
    if (o && this.cur && o.at >= this.cur.at) this.prev = this.cur
    else this.prev = null
    this.cur = o
  }

  /** The override in force at sea time t. */
  active(t: number): WeatherOverride | null {
    return this.cur && t <= this.cur.at ? this.prev : this.cur
  }

  at(t: number, out: Weather = makeWeather()): Weather {
    return weatherNow(this.seed, t, this.active(t), out)
  }
}

/**
 * The override that starts at sea time `at` and fades (over `fade` s) from whatever the room shows then (timeline or
 * the previous override `prev`) to `to` (null = back to the timeline). `from` is rounded like the wire form, so the
 * server's copy equals what clients decode.
 */
export function overrideTo(seed: number, prev: WeatherOverride | null, at: number, to: Readonly<Weather> | WeatherKind | null, fade = WEATHER_OVERRIDE_FADE): WeatherOverride {
  const from = roundWeather(weatherNow(seed, at, prev))
  const target = to === null ? null : typeof to === "string" ? makeWeather(WEATHER_PRESETS[to]) : roundWeather(clampWeather(makeWeather(to)))
  return { at, fade: Math.max(0, fade), from, to: target }
}

export function clampWeather(w: Weather): Weather {
  for (const k of WEATHER_KEYS) {
    const [lo, hi] = WEATHER_RANGE[k]
    w[k] = Math.min(hi, Math.max(lo, w[k]))
  }
  return w
}

const roundWeather = (w: Weather): Weather => {
  for (const k of WEATHER_KEYS) w[k] = Math.round(w[k] * 1e4) / 1e4
  return w
}

/** Compact wire form: the fields in WEATHER_KEYS order, rounded to 1e-4. */
export const packWeather = (w: Readonly<Weather>): number[] => WEATHER_KEYS.map((k) => Math.round(w[k] * 1e4) / 1e4)

/** Validates the wire form (wrong length or non-finite numbers: null) and clamps every field to its range. */
export function unpackWeather(v: unknown): Weather | null {
  if (!Array.isArray(v) || v.length !== WEATHER_KEYS.length) return null
  const w = makeWeather()
  for (let i = 0; i < WEATHER_KEYS.length; i++) {
    const n: unknown = v[i]
    if (typeof n !== "number" || !Number.isFinite(n)) return null
    w[WEATHER_KEYS[i]!] = n
  }
  return clampWeather(w)
}

/** Wire form of an override: [at, fade, ...from, ...to] (to omitted for "back to the timeline"). */
export const packOverride = (o: WeatherOverride): number[] => [o.at, o.fade, ...packWeather(o.from), ...(o.to ? packWeather(o.to) : [])]

export function unpackOverride(v: unknown): WeatherOverride | null {
  const n = WEATHER_KEYS.length
  if (!Array.isArray(v) || (v.length !== 2 + n && v.length !== 2 + 2 * n)) return null
  const [at, fade] = v as unknown[]
  if (typeof at !== "number" || !Number.isFinite(at) || typeof fade !== "number" || !Number.isFinite(fade) || fade < 0 || fade > 3600) return null
  const from = unpackWeather(v.slice(2, 2 + n))
  if (!from) return null
  if (v.length === 2 + n) return { at, fade, from, to: null }
  const to = unpackWeather(v.slice(2 + n))
  return to ? { at, fade, from, to } : null
}

// ---------------------------------------------------------------------------------------------------------------
// Lightning
// ---------------------------------------------------------------------------------------------------------------

/** Strikes per minute at weather.lightning = 1. */
export const LIGHTNING_PER_MIN = 9
/** Strike slot (s): at most one strike starts per slot. */
export const LIGHTNING_SLOT = 0.5
/** A flash (with its restrikes) is over after this long (s). */
export const LIGHTNING_LIFE = 0.9
export const SOUND_SPEED = 343

/** One lightning strike: when, how bright, and where (plan bearing from north, clockwise, and distance from the camera). */
export type Strike = { t: number; power: number; bearing: number; dist: number; seed: number }

/** Strike in slot n, if any. `rate` is the lightning parameter at the slot start. */
function strikeIn(seed: number, n: number, rate: number, out: Strike): Strike | null {
  const p = ((rate * LIGHTNING_PER_MIN) / 60) * LIGHTNING_SLOT
  if (p <= 0 || hash(seed, n, 7) >= p) return null
  out.t = (n + 0.1 + 0.8 * hash(seed, n, 8)) * LIGHTNING_SLOT
  out.power = 0.45 + 0.55 * hash(seed, n, 9)
  out.bearing = hash(seed, n, 10) * Math.PI * 2
  out.dist = 900 + 7000 * hash(seed, n, 11) ** 1.5
  out.seed = Math.floor(hash(seed, n, 12) * 0xffffff)
  return out
}

/** Brightness 0..1 of a strike `dt` seconds after it began: a main stroke and one to three restrikes. */
export function strikeFlash(s: Strike, dt: number): number {
  if (dt < 0 || dt > LIGHTNING_LIFE) return 0
  const rise = Math.min(1, dt / 0.015)
  let f = rise * Math.exp(-dt / 0.06)
  const n = 1 + (s.seed % 3)
  for (let i = 0; i < n; i++) {
    const at = 0.09 + 0.17 * i + 0.05 * (((s.seed >> (4 + i * 3)) & 7) / 7)
    const d = dt - at
    if (d > 0) f += (0.75 - 0.18 * i) * Math.min(1, d / 0.012) * Math.exp(-d / 0.05)
  }
  // Fade the tail to exactly zero at the end of the life.
  return Math.min(1, f * s.power * Math.min(1, (LIGHTNING_LIFE - dt) / 0.2))
}

const strikeTmp: Strike = { t: 0, power: 0, bearing: 0, dist: 0, seed: 0 }
const rateTmp = makeWeather()

/** Strikes that begin in [t0, t1), in order (for thunder and the lab). */
export function strikesBetween(seed: number, t0: number, t1: number, o: WeatherOverride | null): Strike[] {
  const out: Strike[] = []
  for (let n = Math.floor(t0 / LIGHTNING_SLOT); n * LIGHTNING_SLOT < t1; n++) {
    const rate = weatherNow(seed, n * LIGHTNING_SLOT, o, rateTmp).lightning
    const s = strikeIn(seed, n, rate, strikeTmp)
    if (s && s.t >= t0 && s.t < t1) out.push({ ...s })
  }
  return out
}

/** Lightning flash 0..1 at sea time t (the brightest live strike), and that strike in `strike` if any. */
export function lightningAt(seed: number, t: number, o: WeatherOverride | null, strike?: Strike): number {
  let best = 0
  const last = Math.floor(t / LIGHTNING_SLOT)
  for (let n = last - Math.ceil(LIGHTNING_LIFE / LIGHTNING_SLOT); n <= last; n++) {
    const rate = weatherNow(seed, n * LIGHTNING_SLOT, o, rateTmp).lightning
    const s = strikeIn(seed, n, rate, strikeTmp)
    if (!s) continue
    const f = strikeFlash(s, t - s.t)
    if (f > best) {
      best = f
      if (strike) Object.assign(strike, s)
    }
  }
  return best
}

// ---------------------------------------------------------------------------------------------------------------
// Sea coupling
// ---------------------------------------------------------------------------------------------------------------

/** Full-storm amplitude multipliers per wave class (at weather.sea = 1 and swell balance 0.5). */
export const STORM_SEA = {
  /**
   * Primary swell (λ > 50 m within 25° of the swell direction), by wavelength: ×`swell` at `swellLambda[0]` and
   * below, rising (log λ) to ×`swellLong` at `swellLambda[1]` and above. The long components cost the least steepness
   * per metre of height and are what lifts a 330 m hull, so they grow most: big sets reach 15-22 m crest to trough.
   */
  swell: 1.9,
  swellLong: 2.02,
  swellLambda: [200, 450] as readonly [number, number],
  /** Secondary swell (other λ > 40 m): the cross sea gets confused. */
  secondary: 2.6,
  /** Chop travelling with the wind. */
  chopAlong: 3.4,
  /** Chop across the wind. */
  chopCross: 1.8,
  /** Cosmetic detail band (makeSeaDetail): renderer only. */
  detail: 3,
  /** Response curve: multiplier = 1 + (max - 1) · sea^curve, so light rain barely moves the sea and storms kick up. */
  curve: 2.7,
  /** Σ Q k A over the whole sea never exceeds this (det J > 0: the surface never loops). */
  steepCap: 0.9,
  /**
   * When the cap bites, the chop, secondary swell and storm waves give up Gerstner Q first (down to this share of
   * their own), so the big swell keeps its sharp crests; only then does the swell's Q drop.
   */
  otherQFloor: 0.35,
  /** Storm wind-sea components: full-storm kA, Gerstner Q, λ range, spread around the wind. */
  stormKA: [0.045, 0.06] as readonly [number, number],
  stormQ: 0.8,
  stormLambda: [30, 46] as readonly [number, number],
  stormSpread: 25,
  /** At most this many storm components (they use free slots up to SEA_MAX_WAVES). */
  stormMax: 3,
}

/** Wave classes of a sea, robust to recipe changes (classified by wavelength and direction only). */
export const WaveClass = { Swell: 0, Secondary: 1, Chop: 2, Storm: 3 } as const
export type WaveClass = (typeof WaveClass)[keyof typeof WaveClass]

export function classifyWaves(sea: Sea): WaveClass[] {
  const cosSwell = Math.cos((25 * Math.PI) / 180)
  return sea.waves.map((w): WaveClass => {
    const lambda = (2 * Math.PI) / w.k
    if (lambda > 50 && w.dirX * sea.swell[0] + w.dirZ * sea.swell[1] > cosSwell) return WaveClass.Swell
    if (lambda > 40) return WaveClass.Secondary
    return WaveClass.Chop
  })
}

/**
 * Storm wind-sea components: up to STORM_SEA.stormMax waves (as many free slots as the sea leaves below
 * SEA_MAX_WAVES), λ 30-46 m within ±25° of the wind, at their FULL-storm amplitude. They run (phase-continuous) at all
 * times; the weather view scales them from 0 in calm weather to 1 in a full storm. Seeded from `seed ^ 0x570a11`.
 */
export function stormWaves(sea: Sea): Wave[] {
  const n = Math.max(0, Math.min(STORM_SEA.stormMax, SEA_MAX_WAVES - sea.waves.length))
  const rnd = mulberry32(sea.seed ^ 0x570a11)
  const wind = Math.atan2(sea.wind[1], sea.wind[0])
  const [lo, hi] = STORM_SEA.stormLambda
  const out: Wave[] = []
  for (let i = 0; i < n; i++) {
    let lambda = Math.exp(Math.log(lo) + ((Math.log(hi) - Math.log(lo)) / n) * (i + 0.15 + 0.7 * rnd()))
    // Never share a wavelength with an existing wave (the pattern would tile).
    for (const w of sea.waves) if (Math.abs((2 * Math.PI) / w.k / lambda - 1) < 0.003) lambda *= 1.007
    const k = (2 * Math.PI) / lambda
    const angle = wind + (rnd() * 2 - 1) * ((STORM_SEA.stormSpread * Math.PI) / 180)
    const ka = STORM_SEA.stormKA[0] + (STORM_SEA.stormKA[1] - STORM_SEA.stormKA[0]) * rnd()
    out.push({ dirX: Math.cos(angle), dirZ: Math.sin(angle), k, omega: Math.sqrt(SEA_GRAVITY * k), amp: ka / k, steep: STORM_SEA.stormQ, phase: rnd() * Math.PI * 2 })
  }
  return out
}

/** Amplitude multipliers per class for a weather (swell: at the short and long ends), plus the detail band's. */
export type SeaScales = { swell: number; swellLong: number; secondary: number; chopAlong: number; chopCross: number; storm: number; detail: number }

export function seaScales(w: Readonly<Weather>, out: SeaScales = { swell: 1, swellLong: 1, secondary: 1, chopAlong: 1, chopCross: 1, storm: 0, detail: 1 }): SeaScales {
  const s = Math.max(0, Math.min(1, w.sea)) ** STORM_SEA.curve
  const bal = Math.max(0, Math.min(1, w.swell))
  const swellGain = Math.min(1, 2 * bal)
  const chopGain = Math.min(1, 2 * (1 - bal))
  out.swell = 1 + (STORM_SEA.swell - 1) * s * swellGain
  out.swellLong = 1 + (STORM_SEA.swellLong - 1) * s * swellGain
  out.secondary = 1 + (STORM_SEA.secondary - 1) * s * swellGain
  out.chopAlong = 1 + (STORM_SEA.chopAlong - 1) * s * chopGain
  out.chopCross = 1 + (STORM_SEA.chopCross - 1) * s * chopGain
  out.storm = s * chopGain
  out.detail = 1 + (STORM_SEA.detail - 1) * s * chopGain
  return out
}

/**
 * A Sea whose amplitudes follow the weather. `sea` is a stable object (its waves are mutated in place by `set`), so
 * hand it once to the renderer and the ship simulation; call `set(weather)` whenever the weather changes (once per frame
 * or per tick). Wavelengths, ω, directions and phases are the base sea's, so phases are continuous whatever the weather
 * does. When Σ Q k A would pass STORM_SEA.steepCap, Q drops on the chop first, then on the swell.
 */
export type WeatherSea = {
  readonly base: Sea
  readonly sea: Sea
  readonly classes: readonly WaveClass[]
  /** Current amplitude multiplier of each of `sea.waves` (storm waves: 0..1 of their full-storm amplitude). */
  readonly scale: Float64Array
  /** Current Q multipliers of the swell and of everything else (1 unless the steepness cap bites). */
  steep: number
  steepOther: number
  readonly scales: SeaScales
  set(w: Readonly<Weather>): void
}

export function makeWeatherSea(base: Sea): WeatherSea {
  const storm = stormWaves(base)
  const all = [...base.waves.map((w) => ({ ...w })), ...storm.map((w) => ({ ...w, amp: 0 }))]
  const full = [...base.waves, ...storm]
  const classes = [...classifyWaves(base), ...storm.map(() => WaveClass.Storm)]
  const along = full.map((w) => Math.max(0, w.dirX * base.wind[0] + w.dirZ * base.wind[1]))
  // Where each swell component sits between the short and long ends of the swell scaling (0..1, log wavelength).
  const [l0, l1] = STORM_SEA.swellLambda
  const longness = full.map((w) => Math.min(1, Math.max(0, Math.log((2 * Math.PI) / w.k / l0) / Math.log(l1 / l0))))
  const sea: Sea = { ...base, waves: all }
  const scale = new Float64Array(all.length)
  const view: WeatherSea = {
    base,
    sea,
    classes,
    scale,
    steep: 1,
    steepOther: 1,
    scales: seaScales(WEATHER_PRESETS.clear),
    set(w) {
      const sc = seaScales(w, view.scales)
      let swell = 0
      let other = 0
      for (let i = 0; i < all.length; i++) {
        const c = classes[i]!
        const m =
          c === WaveClass.Swell
            ? sc.swell * (sc.swellLong / sc.swell) ** longness[i]!
            : c === WaveClass.Secondary
              ? sc.secondary
              : c === WaveClass.Storm
                ? sc.storm
                : sc.chopCross + (sc.chopAlong - sc.chopCross) * along[i]!
        scale[i] = m
        const f = full[i]!
        all[i]!.amp = f.amp * m
        const qka = f.steep * f.k * f.amp * m
        if (c === WaveClass.Swell) swell += qka
        else other += qka
      }
      const cap = STORM_SEA.steepCap
      let qo = 1
      let qs = 1
      if (swell + other > cap) {
        qo = other > 0 ? Math.max(STORM_SEA.otherQFloor, Math.min(1, (cap - swell) / other)) : 1
        if (swell + qo * other > cap) qs = (cap - qo * other) / swell
      }
      view.steep = qs
      view.steepOther = qo
      for (let i = 0; i < all.length; i++) all[i]!.steep = full[i]!.steep * (classes[i] === WaveClass.Swell ? qs : qo)
    },
  }
  view.set(WEATHER_PRESETS.clear)
  return view
}
