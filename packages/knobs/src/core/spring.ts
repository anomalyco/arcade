// Springs are integrated in fixed 480 Hz substeps so motion is identical at 60 and 120 Hz,
// and they carry velocity across retargets so every gesture is interruptible.
export class Spring {
  v = 0
  target: number
  /** A retarget waiting for its turn in a cascade (performance.now() ms). */
  private next: { target: number; at: number } | undefined
  constructor(
    public x: number,
    public omega = 24,
    public zeta = 0.86,
    public eps = 0.005,
  ) {
    this.target = x
  }
  /** With a `delay` (ms) the new target applies later; repeating the same target is a no-op. */
  set(target: number, delay = 0) {
    if (delay > 0) {
      if (target !== (this.next?.target ?? this.target))
        this.next = { target, at: performance.now() + delay }
      return this
    }
    this.next = undefined
    this.target = target
    return this
  }
  snap(x: number) {
    this.next = undefined
    this.x = this.target = x
    this.v = 0
    return this
  }
  step(dt: number) {
    if (this.next && performance.now() >= this.next.at) {
      this.target = this.next.target
      this.next = undefined
    }
    if (this.x === this.target && this.v === 0) return this.x
    const clampedDt = Math.min(dt, 0.1)
    const h = 1 / 480
    for (let t = 0; t < clampedDt; t += h) {
      const k = Math.min(h, clampedDt - t)
      const a =
        -this.omega * this.omega * (this.x - this.target) - 2 * this.zeta * this.omega * this.v
      this.v += a * k
      this.x += this.v * k
    }
    if (this.resting) {
      this.x = this.target
      this.v = 0
    }
    return this.x
  }
  get resting() {
    return (
      !this.next && Math.abs(this.x - this.target) < this.eps && Math.abs(this.v) < this.eps * 4
    )
  }
}

/** A SwiftUI-style `.spring(duration:bounce:)`: perceptual duration in seconds, bounce -1…1. */
export interface SpringValue {
  readonly duration: number
  readonly bounce: number
}

/** SwiftUI's mapping: ω = 2π / duration; ζ = 1 − bounce, or 1 / (1 + bounce) below zero. */
export function springMotion({ duration, bounce }: SpringValue): { omega: number; zeta: number } {
  return {
    omega: (2 * Math.PI) / Math.max(0.01, duration),
    zeta: bounce >= 0 ? 1 - bounce : 1 / (1 + bounce),
  }
}

/** The step response (0 → 1) sampled every `dt` seconds for `seconds`. */
export function springResponse(omega: number, zeta: number, seconds: number, dt = 1 / 60) {
  const s = new Spring(0, omega, zeta).set(1)
  const out = [0]
  for (let t = dt; t < seconds + dt / 2; t += dt) out.push(s.step(dt))
  return out
}

/** The step response as a CSS `linear()` easing plus its settle time (ms). */
export function springEasing(omega: number, zeta: number): { easing: string; ms: number } {
  const s = new Spring(0, omega, zeta).set(1)
  const points = ["0"]
  const dt = 1 / 60
  let t = 0
  while (t < 4 && !(Math.abs(s.x - 1) < 0.002 && Math.abs(s.v) < 0.05)) {
    s.step(dt)
    t += dt
    points.push(String(Math.round(s.x * 1000) / 1000))
  }
  points[points.length - 1] = "1"
  return { easing: `linear(${points.join(",")})`, ms: Math.round(t * 1000) }
}

/** A spring field's value as CSS: `transition: transform ${duration}ms ${easing}`. */
export function springCss(value: SpringValue): { easing: string; duration: number } {
  const { omega, zeta } = springMotion(value)
  const { easing, ms } = springEasing(omega, zeta)
  return { easing, duration: ms }
}
