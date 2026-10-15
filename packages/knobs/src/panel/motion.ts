import { Spring } from "../core/spring.js"

export { Spring, springEasing } from "../core/spring.js"

/** The slider fill, and its rubber band springing back from past an end. */
export const FILL = { omega: 30, zeta: 0.88 }
export const RELEASE = { omega: 32, zeta: 0.65 }
export const LEAD = { omega: 34, zeta: 0.86 }
export const TRAIL = { omega: 25, zeta: 1 }
/** How far the trailing edge lags at a `--k-blur` strength (0 keeps both edges together). */
export const trailScale = (blur: number) => 0.6 + 0.4 * clamp(blur, 0, 2)

/**
 * A sliding shape's two edges (like iOS's page-dot thumb): the edge facing the motion leads on a
 * snappy spring and the other trails on a softer one, so the shape stretches toward its
 * destination and settles back to size.
 */
export class Edges {
  readonly start: Spring
  readonly end: Spring
  constructor(start = 0, end = 0) {
    this.start = new Spring(start, LEAD.omega, LEAD.zeta, 0.05)
    this.end = new Spring(end, LEAD.omega, LEAD.zeta, 0.05)
  }
  to(start: number, end: number, delay = 0, trail = 1) {
    const pending = start !== this.start.target || end !== this.end.target
    if (pending && delay <= 0) {
      const forward = start + end > this.start.target + this.end.target
      const [lead, tail] = forward ? [this.end, this.start] : [this.start, this.end]
      lead.omega = LEAD.omega
      lead.zeta = LEAD.zeta
      tail.omega = TRAIL.omega / trail
      tail.zeta = TRAIL.zeta
    }
    this.start.set(start, delay)
    this.end.set(end, delay)
    return this
  }
  /** Moves both edges and their targets by the same distance, keeping any motion in flight. */
  shift(ds: number, de: number) {
    this.start.x += ds
    this.start.target += ds
    this.end.x += de
    this.end.target += de
    return this
  }
  snap(start: number, end: number) {
    this.start.snap(start)
    this.end.snap(end)
    return this
  }
  step(dt: number) {
    this.start.step(dt)
    this.end.step(dt)
    return this
  }
  get resting() {
    return this.start.resting && this.end.resting
  }
  /** Signed travel speed (px/s) of the shape's centre. */
  get velocity() {
    return (this.start.v + this.end.v) / 2
  }
}

export const POP_MS = 360
/** Decile pop: a critically damped kick that swells to `peak` at 55 ms and settles (t in ms). */
export function popScale(t: number, peak = 0.04): number {
  if (t <= 0 || t >= POP_MS) return 1
  const u = t / 55
  return 1 + peak * u * Math.exp(1 - u)
}

export class VelocityTracker {
  private samples: { t: number; x: number; y: number }[] = []
  add(x: number, y: number, t = performance.now()) {
    this.samples.push({ t, x, y })
    while (this.samples.length > 2 && t - this.samples[0]!.t > 100) this.samples.shift()
  }
  reset() {
    this.samples = []
  }
  get velocity(): [number, number] {
    const s = this.samples
    if (s.length < 2) return [0, 0]
    const a = s[0]!,
      b = s[s.length - 1]!
    const dt = (b.t - a.t) / 1000
    if (dt <= 0 || performance.now() - b.t > 60) return [0, 0]
    return [(b.x - a.x) / dt, (b.y - a.y) / dt]
  }
}

export const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x))

/**
 * Time-based critically damped motion, the same curve @kitlangton/rolling-number samples for
 * its reels: settles in `duration`, carries velocity across retargets, and never overshoots.
 */
export class Roll {
  private from: number
  private to = 0
  private inherited = 0
  private start = 0
  private duration = 0
  constructor(position: number) {
    this.from = this.to = position
  }
  get target() {
    return this.to
  }
  sample(now: number): { position: number; velocity: number } {
    const t = now - this.start
    if (this.duration <= 0 || t >= this.duration) return { position: this.to, velocity: 0 }
    if (t <= 0) return { position: this.from, velocity: 0 }
    const seconds = this.duration / 1000
    const tau = t / this.duration
    const d = this.from - this.to
    const e = Math.exp(-10 * tau)
    return {
      position: this.to + (d + (this.inherited + 10 * d) * tau) * e,
      velocity: (e * (this.inherited - 10 * (this.inherited + 10 * d) * tau)) / seconds,
    }
  }
  /** Retarget from wherever the motion is now; `delay` holds the current position first. */
  set(target: number, duration: number, now: number, delay = 0) {
    const { position, velocity } = this.sample(now)
    if (duration <= 0) return this.snap(target)
    const seconds = duration / 1000
    const distance = position - target
    // Bound inherited energy after huge updates, as the library does.
    const limit = (Math.max(Math.abs(distance), 1) * 12) / seconds
    this.inherited = clamp(delay > 0 ? 0 : velocity, -limit, limit) * seconds
    this.from = position
    this.to = target
    this.start = now + delay
    this.duration = duration
    return this
  }
  snap(position: number) {
    this.from = this.to = position
    this.duration = 0
    this.inherited = 0
    return this
  }
  resting(now: number) {
    return this.duration <= 0 || now - this.start >= this.duration
  }
  /** Positions the current motion covers, like rolling-number's reel: faces outside never show. */
  span(now: number): [number, number] {
    if (this.resting(now)) return [this.to, this.to]
    return [Math.min(this.from, this.to), Math.max(this.from, this.to)]
  }
}

/** Nearest wheel position showing `digit`, honoring the trend (from rolling-number). */
export function rollTarget(position: number, digit: number, trend: number): number {
  let target = Math.floor(position / 10) * 10 + digit
  if (trend > 0 && target < position - 0.001) target += 10
  else if (trend < 0 && target > position + 0.001) target -= 10
  else if (trend === 0) target += Math.round((position - target) / 10) * 10
  return target
}

export const numeral = (position: number) => String(((position % 10) + 10) % 10)

/** New glyphs hold briefly, then rise into their slot (rolling-number's `entrance`). Returns 0..1 of a face height. */
export function entranceOffset(elapsed: number, duration: number, hold = 0.14): number {
  if (duration <= 0 || elapsed >= duration) return 0
  const p = clamp((elapsed / duration - hold) / (1 - hold), 0, 1)
  return (1 + 10 * p) * Math.exp(-10 * p)
}
