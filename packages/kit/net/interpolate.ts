/**
 * Snapshot interpolation for remote entities. Snapshots are stamped with server time; the buffer estimates the
 * offset between server and local clocks (biased towards the fastest arrival, so jitter only adds delay) and samples
 * the two snapshots bracketing `server now − delay`. Rendering always lands between two real states instead of
 * chasing the latest one, so a 20 Hz stream draws smoothly at any frame rate.
 */
export type Bracket<S> = { a: S; b: S; t: number }

export class SnapshotBuffer<S> {
  private times: number[] = []
  private snaps: S[] = []
  private offset: number | null = null

  constructor(
    /** Seconds behind the newest estimated server time to render (about two snapshot intervals). */
    public delay = 0.1,
    private readonly capacity = 32,
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
  }

  /** `serverTime` and `localTime` in seconds. Out-of-order snapshots are dropped. */
  push(serverTime: number, snap: S, localTime: number): void {
    const last = this.times[this.times.length - 1]
    if (last !== undefined && serverTime <= last) return
    const sample = localTime - serverTime
    if (this.offset === null || sample < this.offset) this.offset = sample
    else this.offset += (sample - this.offset) * 0.02
    this.times.push(serverTime)
    this.snaps.push(snap)
    if (this.snaps.length > this.capacity) {
      this.times.shift()
      this.snaps.shift()
    }
  }

  /** Server time to render at local time `localTime`. */
  renderTime(localTime: number): number {
    return localTime - (this.offset ?? 0) - this.delay
  }

  /** The two snapshots around the render time and the blend factor (clamped: no extrapolation). */
  sample(localTime: number): Bracket<S> | null {
    const n = this.snaps.length
    if (!n) return null
    const t = this.renderTime(localTime)
    if (n === 1 || t <= this.times[0]!) return { a: this.snaps[0]!, b: this.snaps[0]!, t: 0 }
    for (let i = n - 1; i > 0; i--) {
      const t0 = this.times[i - 1]!
      if (t >= t0) {
        const t1 = this.times[i]!
        return { a: this.snaps[i - 1]!, b: this.snaps[i]!, t: Math.min(1, (t - t0) / Math.max(1e-6, t1 - t0)) }
      }
    }
    return { a: this.snaps[0]!, b: this.snaps[0]!, t: 0 }
  }
}

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t

export function lerpAngle(a: number, b: number, t: number): number {
  const d = Math.atan2(Math.sin(b - a), Math.cos(b - a))
  return a + d * t
}
