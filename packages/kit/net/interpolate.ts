/**
 * Snapshot interpolation for remote entities. Snapshots are stamped with server time; the buffer estimates the
 * offset between server and local clocks (biased towards the fastest arrival, so jitter only adds delay) and samples
 * the two snapshots bracketing `server now − delay`. Rendering always lands between two real states instead of
 * chasing the latest one, so a 15–20 Hz stream draws smoothly at any frame rate.
 *
 * Includes `hermite2` (cubic Hermite interpolation through snapshot velocities with chord fallback and bounded
 * velocity coasting through TCP retransmit stalls) and `Glide` (decaying offset that blends out the resume jump after
 * a stall).
 */
export type Bracket<S> = {
  a: S
  b: S
  t: number
  /** Seconds between `a` and `b` on the server clock. */
  span: number
  /** Seconds past `b` when the stream stalls (clamped to `maxCoast`). */
  over: number
}

export type AdaptiveDelay = { min: number; max: number }

export class SnapshotBuffer<S> {
  private times: number[] = []
  private snaps: S[] = []
  private offset: number | null = null
  private shift: number | null = null
  private lastLocal = Number.NaN
  /** Exponential moving average of arrival jitter above the minimum clock offset (seconds). */
  jitter = 0

  constructor(
    /** Seconds behind the newest estimated server time to render (about two snapshot intervals). */
    public delay = 0.1,
    private readonly capacity = 32,
    /** Maximum seconds to coast past the newest snapshot during a stall. */
    public maxCoast = 0.25,
    /** Optional adaptive delay bounds (`clamp(min + jitter * 2.5, min, max)`). */
    public adaptive: AdaptiveDelay | null = null,
  ) {}

  get size(): number {
    return this.snaps.length
  }

  get latest(): S | undefined {
    return this.snaps[this.snaps.length - 1]
  }

  clear(): void {
    this.times.length = 0
    this.snaps.length = 0
    this.offset = null
    this.shift = null
    this.lastLocal = Number.NaN
    this.jitter = 0
  }

  /** `serverTime` and `localTime` in seconds. Out-of-order snapshots are dropped. */
  push(serverTime: number, snap: S, localTime: number): void {
    const last = this.times[this.times.length - 1]
    if (last !== undefined && serverTime <= last) return
    const sample = localTime - serverTime
    if (this.offset === null || sample < this.offset) {
      this.offset = sample
    } else {
      const dev = sample - this.offset
      this.jitter += (Math.min(dev, 0.08) - this.jitter) * 0.12
      this.offset += Math.min(dev, 0.02) * 0.01
    }
    if (this.shift === null) {
      this.shift = this.offset + this.effectiveDelay()
      this.lastLocal = localTime
    }
    this.times.push(serverTime)
    this.snaps.push(snap)
    if (this.snaps.length > this.capacity) {
      this.times.shift()
      this.snaps.shift()
    }
  }

  /** Active interpolation delay in seconds (fixed `delay` unless `adaptive` is configured). */
  effectiveDelay(): number {
    if (!this.adaptive) return this.delay
    return Math.max(this.adaptive.min, Math.min(this.adaptive.max, this.adaptive.min + this.jitter * 1.5))
  }

  /** Server time to render at local time `localTime` (time-stretched so clock/delay updates never jump a frame). */
  renderTime(localTime: number): number {
    const target = (this.offset ?? 0) + this.effectiveDelay()
    if (this.shift === null || Number.isNaN(this.lastLocal) || Math.abs(target - this.shift) > 0.5) {
      this.shift = target
      this.lastLocal = localTime
    } else if (localTime > this.lastLocal) {
      const dt = localTime - this.lastLocal
      this.lastLocal = localTime
      const diff = target - this.shift
      const maxStep = 0.02 * dt
      const eased = diff * (1 - Math.exp(-dt * 2))
      this.shift += Math.max(-maxStep, Math.min(maxStep, eased))
    }
    return localTime - this.shift
  }

  /** The two snapshots around the render time, the blend factor `t`, their time `span`, and stall `over`. */
  sample(localTime: number): Bracket<S> | null {
    const n = this.snaps.length
    if (!n) return null
    const t = this.renderTime(localTime)
    if (n === 1 || t <= this.times[0]!) return { a: this.snaps[0]!, b: this.snaps[0]!, t: 0, span: 0, over: 0 }
    const newestTime = this.times[n - 1]!
    const over = Math.min(this.maxCoast, Math.max(0, t - newestTime))
    for (let i = n - 1; i > 0; i--) {
      const t0 = this.times[i - 1]!
      if (t >= t0) {
        const t1 = this.times[i]!
        const span = Math.max(1e-6, t1 - t0)
        return { a: this.snaps[i - 1]!, b: this.snaps[i]!, t: Math.min(1, (t - t0) / span), span: t1 - t0, over }
      }
    }
    return { a: this.snaps[0]!, b: this.snaps[0]!, t: 0, span: 0, over: 0 }
  }
}

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t

export function lerpAngle(a: number, b: number, t: number): number {
  const d = Math.atan2(Math.sin(b - a), Math.cos(b - a))
  return a + d * t
}

export type Moving2D = { x: number; y: number; vx: number; vy: number }

/**
 * Position and velocity on the cubic Hermite curve from `a` to `b` (`span` seconds apart) at blend `t`, coasting
 * `over` seconds past `b` when a stream stalls. Tangents more than `tangentSlack` m/s off the chord (an actor pushing
 * into a wall) fall back to the chord velocity so the curve never bulges.
 */
export function hermite2(a: Moving2D, b: Moving2D, span: number, t: number, over = 0, tangentSlack = 2): Moving2D {
  if (span <= 0 || t >= 1) return { x: b.x + b.vx * over, y: b.y + b.vy * over, vx: b.vx, vy: b.vy }
  const cx = (b.x - a.x) / span
  const cy = (b.y - a.y) / span
  const ax = Math.hypot(a.vx - cx, a.vy - cy) > tangentSlack ? cx : a.vx
  const ay = Math.hypot(a.vx - cx, a.vy - cy) > tangentSlack ? cy : a.vy
  const bx = Math.hypot(b.vx - cx, b.vy - cy) > tangentSlack ? cx : b.vx
  const by = Math.hypot(b.vx - cx, b.vy - cy) > tangentSlack ? cy : b.vy
  const t2 = t * t
  const t3 = t2 * t
  const h00 = 2 * t3 - 3 * t2 + 1
  const h10 = t3 - 2 * t2 + t
  const h01 = -2 * t3 + 3 * t2
  const h11 = t3 - t2
  const d00 = 6 * t2 - 6 * t
  const d10 = 3 * t2 - 4 * t + 1
  const d01 = -6 * t2 + 6 * t
  const d11 = 3 * t2 - 2 * t
  return {
    x: h00 * a.x + h10 * span * ax + h01 * b.x + h11 * span * bx,
    y: h00 * a.y + h10 * span * ay + h01 * b.y + h11 * span * by,
    vx: (d00 * a.x + d01 * b.x) / span + d10 * ax + d11 * bx,
    vy: (d00 * a.y + d01 * b.y) / span + d10 * ay + d11 * by,
  }
}

/**
 * Hides the jump when a stalled snapshot stream resumes after coasting: any displacement beyond `(vx * dt, vy * dt)`
 * becomes a decaying visual offset (`rate` per second), while a teleport larger than `jump` resets immediately.
 */
export class Glide {
  x = 0
  y = 0
  private lx = Number.NaN
  private ly = Number.NaN

  constructor(
    public rate = 10,
    private readonly jump = 4,
  ) {}

  /** The drawn position for target `(tx, ty)` moving at `(vx, vy)`. */
  step(tx: number, ty: number, vx: number, vy: number, dt: number): { x: number; y: number } {
    if (!Number.isNaN(this.lx)) {
      const jx = tx - this.lx - vx * dt
      const jy = ty - this.ly - vy * dt
      const j = Math.hypot(jx, jy)
      if (j > this.jump) this.x = this.y = 0
      else if (j > 0.01) {
        this.x -= jx
        this.y -= jy
      }
    }
    this.lx = tx
    this.ly = ty
    const k = Math.exp(-dt * this.rate)
    this.x *= k
    this.y *= k
    return { x: tx + this.x, y: ty + this.y }
  }

  reset(): void {
    this.x = this.y = 0
    this.lx = this.ly = Number.NaN
  }
}
