/**
 * Deterministic time of day: a pure function of (room seed, sea time, room override), like the weather, so every
 * client sees the same sun, moon and stars without syncing anything but an occasional override. Physics never reads it.
 *
 * Phase. Time of day is an unbounded phase in cycles: `floor(phase)` counts days (it picks the moon's offset), and
 * `frac(phase)` maps to the clock through a monotone spline. One day lasts DAY_CYCLE seconds of sea time, and the
 * clock does not run evenly through it: most of a day is daylight, and dusk, night and dawn pass quicker (DAY_KNOTS).
 * A room starts in the morning (DAY_START hours, seeded), so players arrive to the sunny look and their first sunset
 * comes after about two minutes.
 *
 * Overrides. A host or dev can set the clock: from sea time `at` the room blends, over `fade` s, from its old course
 * (`from` phase, running at `fromSpeed`) to the new one (`to` phase, then running at `speed` × normal; 0 freezes it).
 * `to` is always at or ahead of `from`, so a fade runs the sky forward through the hours in between. Built by
 * `timeOverride` (the server rounds `from` like the wire form, so its copy equals what clients decode).
 *
 * Sky. `sunDir`/`moonDir` follow a stylised, not astronomical, path chosen for the views players get: the sun rises
 * in the north at 06:00, stands SUN_PEAK degrees up toward the north-north-east at noon (the concepts' sun bearing)
 * and sets in the north-east at 18:00, so from the spawn, looking north at the islands, dawn, golden hour and sunset
 * all happen ahead (the evening sun ahead and to the right, as the concepts paint it). The moon runs roughly opposite in time (up all night, nearly
 * full), offset per day, on the same bearings. Stars turn on a tilted axis (`celestial`). How the renderer bends these
 * for its look (a low painted disc, softer light) is render-side.
 *
 * No DOM or Worker APIs: this runs in the Durable Object and the browser.
 */

/** Seconds of sea time per full day at speed 1 (5 min). */
export const DAY_CYCLE = 300

/**
 * The clock's course through one cycle: phase (fraction of DAY_CYCLE) → clock hour. Between knots the clock runs
 * evenly; the spline through them keeps the rate changes smooth. 2.5 min of dawn (04:30-07:00), 14 min of day
 * (07:00-17:00), 2.5 min of golden hour, sunset and dusk (17:00-19:30) and 5 min of night (19:30-04:30).
 */
export const DAY_KNOTS: readonly (readonly [phase: number, hour: number])[] = [
  [0, 4.5],
  [2.5 / 24, 7],
  [16.5 / 24, 17],
  [19 / 24, 19.5],
  [1, 28.5],
]

/** Rooms start between these clock hours (seeded). */
export const DAY_START: readonly [number, number] = [9, 11]

/** The sun's elevation (degrees) at noon; the moon's at the top of its path. */
export const SUN_PEAK = 60
export const MOON_PEAK = 55
/** Compass bearing (degrees clockwise from north) of the noon sun: the concepts paint it ahead and right of north. */
export const NOON_AZIMUTH = 26
/** Degrees the bearing swings either side of noon's by 06:00 and 18:00 (rises at 26 − 25 = 1°, sets at 51°). */
export const SUN_SWING = 25
/** Degrees the star field's axis leans from the zenith (it turns once a day). */
export const STAR_TILT = 30
/** Largest daily offset (radians of hour angle) of the moon from opposite the sun. */
export const MOON_SPREAD = 0.35

/** Default fade for an override (s): long enough to watch the sky run through the hours between. */
export const TIME_OVERRIDE_FADE = 8
/** The server starts an override this far ahead of its own sea time, so every client receives it before it begins. */
export const TIME_OVERRIDE_LEAD = 1
/** Fastest allowed clock speed in an override (× normal). */
export const TIME_SPEED_MAX = 120

function hash(seed: number, a: number, salt: number): number {
  let h = Math.imul(seed ^ 0x6d2b79f5, 0x85ebca6b) ^ Math.imul(a + 0x3c6ef372, 0xc2b2ae35) ^ Math.imul(salt + 0x1b873593, 0x27d4eb2f)
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39)
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296
}

const frac = (x: number) => x - Math.floor(x)
const wrapHour = (h: number) => ((h % 24) + 24) % 24

// ---------------------------------------------------------------------------------------------------------------
// Clock: a periodic monotone cubic (Fritsch-Butland tangents) through DAY_KNOTS
// ---------------------------------------------------------------------------------------------------------------

const K = DAY_KNOTS.length - 1
const slopes = DAY_KNOTS.slice(0, K).map(([p, h], i) => (DAY_KNOTS[i + 1]![1] - h) / (DAY_KNOTS[i + 1]![0] - p))
/** Tangent at each knot: harmonic mean of the neighbouring slopes (monotone), wrapping at the ends. */
const tangents = DAY_KNOTS.map((_, i) => {
  const a = slopes[(i - 1 + K) % K]!
  const b = slopes[i % K]!
  return (2 * a * b) / (a + b)
})

/** Clock hour (0 ≤ h < 24) at a phase. */
export function hourOfPhase(phase: number): number {
  const p = frac(phase)
  let i = 0
  while (i < K - 1 && p >= DAY_KNOTS[i + 1]![0]) i++
  const [p0, h0] = DAY_KNOTS[i]!
  const [p1, h1] = DAY_KNOTS[i + 1]!
  const d = p1 - p0
  const u = (p - p0) / d
  const u2 = u * u
  const u3 = u2 * u
  const h = (2 * u3 - 3 * u2 + 1) * h0 + (u3 - 2 * u2 + u) * d * tangents[i]! + (-2 * u3 + 3 * u2) * h1 + (u3 - u2) * d * tangents[i + 1]!
  return wrapHour(h)
}

/** Phase in [0, 1) showing clock hour h (the inverse of hourOfPhase). */
export function phaseOfHour(hour: number): number {
  // Unwrap the hour into the knots' range [4.5, 28.5), then bisect the monotone spline.
  const h0 = DAY_KNOTS[0]![1]
  const target = h0 + wrapHour(hour - h0)
  const unwrapped = (p: number) => {
    const h = hourOfPhase(p)
    return h < h0 - 1e-9 ? h + 24 : h
  }
  let lo = 0
  let hi = 1
  for (let k = 0; k < 48; k++) {
    const mid = (lo + hi) / 2
    if (unwrapped(mid) < target) lo = mid
    else hi = mid
  }
  return frac((lo + hi) / 2)
}

/** The first phase at or after `from` that shows clock hour h. */
export function nextPhaseOf(from: number, hour: number): number {
  const p = Math.floor(from) + phaseOfHour(hour)
  return p < from - 1e-9 ? p + 1 : p
}

/** Phase of a room's seeded timeline at sea time t (no override). */
export function timelinePhase(seed: number, t: number): number {
  const start = DAY_START[0] + (DAY_START[1] - DAY_START[0]) * hash(seed, 0, 11)
  return phaseOfHour(start) + t / DAY_CYCLE
}

// ---------------------------------------------------------------------------------------------------------------
// Overrides
// ---------------------------------------------------------------------------------------------------------------

/**
 * From sea time `at`, run over `fade` s from the old course (`from`, running at `fromSpeed`) to phase `to` at the end of
 * the fade, then on at `speed`.
 */
export type TimeOverride = { at: number; fade: number; from: number; fromSpeed: number; to: number; speed: number }

const ease = (u: number): number => {
  const x = u <= 0 ? 0 : u >= 1 ? 1 : u
  return x * x * x * (x * (x * 6 - 15) + 10)
}
/** Integral of `ease` from 0 to u (1/2 at u = 1). */
const easeArea = (u: number): number => {
  const x = u <= 0 ? 0 : u >= 1 ? 1 : u
  return x * x * x * x * (x * (x - 3) + 2.5)
}

/** Phase the clock covers on its own during a fade (its speed eases from fromSpeed to speed). */
const fadeRun = (fade: number, fromSpeed: number, speed: number) => (fade * (fromSpeed + speed)) / 2 / DAY_CYCLE

/**
 * The room's phase at sea time t under override o (null: the seeded timeline). During the fade the clock's own speed
 * eases from the old to the new one, and the jump to `to` is added on a smootherstep, so the phase and its rate are
 * continuous and never run backwards.
 */
export function phaseNow(seed: number, t: number, o: TimeOverride | null): number {
  if (!o || t <= o.at) return timelinePhase(seed, t)
  const dt = t - o.at
  if (o.fade <= 0 || dt >= o.fade) return o.to + ((dt - Math.max(0, o.fade)) * o.speed) / DAY_CYCLE
  const u = dt / o.fade
  const run = (o.fromSpeed * dt + (o.speed - o.fromSpeed) * o.fade * easeArea(u)) / DAY_CYCLE
  const jump = o.to - o.from - fadeRun(o.fade, o.fromSpeed, o.speed)
  return o.from + run + jump * ease(u)
}

/** Clock speed (× normal) of the room's course at sea time t, for chaining overrides. */
export function speedNow(t: number, o: TimeOverride | null): number {
  return !o || t <= o.at ? 1 : o.speed
}

/**
 * The override starting at sea time `at`: from wherever the room's sky is then (timeline or `prev`) to clock hour
 * `hour` when the fade ends (null: back to the seeded timeline's hour, running normally), then running at `speed` ×
 * normal. The sky always runs forward to get there.
 */
export function timeOverride(seed: number, prev: TimeOverride | null, at: number, hour: number | null, speed = 1, fade = TIME_OVERRIDE_FADE): TimeOverride {
  const from = round(phaseNow(seed, at, prev))
  const fromSpeed = speedNow(at, prev)
  const s = hour === null ? 1 : clampSpeed(speed)
  const f = Math.min(600, Math.max(0, fade))
  // The clock covers this much on its own during the fade; `to` (the phase when the fade ends) is the first phase after
  // that showing the hour. Back to the timeline: the timeline's hour when the fade ends (then it runs in step with it).
  const min = from + fadeRun(f, fromSpeed, s)
  const target = hour === null ? hourOfPhase(timelinePhase(seed, at + f)) : wrapHour(hour)
  return { at, fade: f, from, fromSpeed, to: round(Math.max(min, nextPhaseOf(min, target))), speed: s }
}

const round = (v: number) => Math.round(v * 1e7) / 1e7
const clampSpeed = (s: number) => (Number.isFinite(s) ? Math.min(TIME_SPEED_MAX, Math.max(0, s)) : 1)

/**
 * A room's override history as a client holds it: the latest override and the one it replaced, because a new one
 * arrives up to TIME_OVERRIDE_LEAD seconds before it begins and the old one still rules until then.
 */
export class RoomTime {
  prev: TimeOverride | null = null
  cur: TimeOverride | null = null

  constructor(public seed = 0) {}

  set(o: TimeOverride | null): void {
    if (o && this.cur && o.at >= this.cur.at) this.prev = this.cur
    else this.prev = null
    this.cur = o
  }

  active(t: number): TimeOverride | null {
    return this.cur && t <= this.cur.at ? this.prev : this.cur
  }

  phase(t: number): number {
    return phaseNow(this.seed, t, this.active(t))
  }
}

/** Wire form: [at, fade, from, fromSpeed, to, speed]. */
export const packTime = (o: TimeOverride): number[] => [o.at, o.fade, o.from, o.fromSpeed, o.to, o.speed]

export function unpackTime(v: unknown): TimeOverride | null {
  if (!Array.isArray(v) || v.length !== 6 || !v.every((n) => typeof n === "number" && Number.isFinite(n))) return null
  const [at, fade, from, fromSpeed, to, speed] = v as number[]
  if (fade! < 0 || fade! > 600 || to! < from! - 1e-6 || to! - from! > 1 + (fade! * TIME_SPEED_MAX) / DAY_CYCLE + 1e-6) return null
  if (fromSpeed! < 0 || fromSpeed! > TIME_SPEED_MAX || speed! < 0 || speed! > TIME_SPEED_MAX) return null
  return { at: at!, fade: fade!, from: from!, fromSpeed: fromSpeed!, to: to!, speed: speed! }
}

// ---------------------------------------------------------------------------------------------------------------
// Sky geometry
// ---------------------------------------------------------------------------------------------------------------

type Vec3 = [number, number, number]
const DEG = Math.PI / 180

/**
 * Column-major 3x3 rotation of the star field (celestial frame → world: x east, y up, z south) for hour angle `ha`
 * (radians): the field turns about an axis leaning `tilt` degrees from the zenith toward NOON_AZIMUTH.
 */
export function celestial(ha: number, tilt = STAR_TILT, out: number[] = new Array(9)): number[] {
  // M = Ry(-azimuth) · Rx(-tilt) · Rz(ha)
  const ch = Math.cos(ha)
  const sh = Math.sin(ha)
  const ct = Math.cos(-tilt * DEG)
  const st = Math.sin(-tilt * DEG)
  const ca = Math.cos(-NOON_AZIMUTH * DEG)
  const sa = Math.sin(-NOON_AZIMUTH * DEG)
  // Columns of Rz(ha): x' = (ch, sh, 0), y' = (-sh, ch, 0), z' = (0, 0, 1). Then Rx, then Ry.
  const col = (x: number, y: number, z: number, i: number) => {
    const y1 = y * ct - z * st
    const z1 = y * st + z * ct
    out[i] = x * ca + z1 * sa
    out[i + 1] = y1
    out[i + 2] = -x * sa + z1 * ca
  }
  col(ch, sh, 0, 0)
  col(-sh, ch, 0, 3)
  col(0, 0, 1, 6)
  return out
}

/** Hour angle of the sun (radians, 0 at noon). */
export const sunHourAngle = (hour: number) => ((hour - 12) / 24) * 2 * Math.PI

/** Unit vector along the stylised path at hour angle `ha`: elevation asin(sin(peak) cos ha), bearing swinging east to west. */
function pathDir(ha: number, peak: number, out: Vec3): Vec3 {
  const e = Math.asin(Math.sin(peak * DEG) * Math.cos(ha))
  const az = (NOON_AZIMUTH + SUN_SWING * Math.sin(ha)) * DEG
  out[0] = Math.cos(e) * Math.sin(az)
  out[1] = Math.sin(e)
  out[2] = -Math.cos(e) * Math.cos(az)
  return out
}

/** Unit vector toward the sun at a clock hour. */
export function sunDir(hour: number, out: Vec3 = [0, 0, 0]): Vec3 {
  return pathDir(sunHourAngle(hour), SUN_PEAK, out)
}

/** The moon's hour angle offset from opposite the sun on day `day` (radians, within ±MOON_SPREAD). */
export const moonOffset = (seed: number, day: number) => (hash(seed, day, 23) * 2 - 1) * MOON_SPREAD

/** Unit vector toward the moon at a phase. */
export function moonDir(seed: number, phase: number, out: Vec3 = [0, 0, 0]): Vec3 {
  return pathDir(sunHourAngle(hourOfPhase(phase)) + Math.PI + moonOffset(seed, Math.floor(phase)), MOON_PEAK, out)
}

/** Elevation (degrees) of a unit direction. */
export const elevation = (d: readonly number[]) => Math.asin(Math.max(-1, Math.min(1, d[1]!))) / DEG

/** The sky at a phase: clock hour, day, sun and moon directions, the moon's lit fraction, and the stars' hour angle. */
export type Sky = { hour: number; day: number; sun: Vec3; moon: Vec3; moonLit: number; starAngle: number }

export function skyAt(seed: number, phase: number, out: Sky = { hour: 0, day: 0, sun: [0, 0, 0], moon: [0, 0, 0], moonLit: 1, starAngle: 0 }): Sky {
  out.hour = hourOfPhase(phase)
  out.day = Math.floor(phase)
  sunDir(out.hour, out.sun)
  moonDir(seed, phase, out.moon)
  // Lit fraction from the hour-angle gap (the stylised path is not a sphere: the directions' angle would mislead).
  out.moonLit = (1 + Math.cos(moonOffset(seed, out.day))) / 2
  out.starAngle = sunHourAngle(out.hour)
  return out
}

/** "07:30". */
export function clockText(hour: number): string {
  const m = Math.floor(wrapHour(hour) * 60 + 1e-6)
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`
}
