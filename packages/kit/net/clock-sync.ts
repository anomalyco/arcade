// NTP-style estimate of a remote clock from ping round trips, plus a smooth, monotonic view of it for rendering.
// Pure (no timers, no DOM): the caller passes every timestamp, so tests can drive it with a simulated network.

export type ClockOptions = {
  /** Round trips kept. */
  window?: number
  /** Largest rate change while correcting: 0.05 runs the clock between 0.95x and 1.05x. */
  slew?: number
  /** When the shown time falls this many ms behind the estimate (a sleeping laptop), jump forward instead of slewing. */
  snap?: number
  /** Assumed worst relative drift between the two clocks; widens an old sample's error bound by its age times this. */
  drift?: number
  /** Ms added to both sides of every interval for timer resolution (integer Date.now, coarsened performance.now). */
  slack?: number
}

/** One round trip. The server read its clock between our send and receive, so the offset (remote - local) is in [lo, hi]. */
type Sample = { lo: number; hi: number; at: number }

export class ClockSync {
  private readonly window: number
  private readonly slew: number
  private readonly snap: number
  private readonly drift: number
  private readonly slack: number
  private samples: Sample[] = []
  private est: number | null = null
  private shownLocal = 0
  private shown = Number.NaN

  constructor(opts: ClockOptions = {}) {
    this.window = opts.window ?? 16
    this.slew = opts.slew ?? 0.05
    this.snap = opts.snap ?? 1000
    this.drift = opts.drift ?? 1e-4
    this.slack = opts.slack ?? 2
  }

  /** Round trips currently kept. */
  get count(): number {
    return this.samples.length
  }

  /** Best estimate of remote - local in ms, or null before the first sample. */
  offset(): number | null {
    return this.est
  }

  /** Records a round trip: sent and received on the local clock, `remote` read by the server in between. */
  add(sent: number, remote: number, received: number): void {
    if (!Number.isFinite(sent) || !Number.isFinite(remote) || !Number.isFinite(received) || received < sent) return
    const s: Sample = { lo: remote - received - this.slack, hi: remote - sent + this.slack, at: received }
    // Every genuine interval contains the true offset, so one that misses the newest (allowing for drift since) was
    // taken before a clock step. Forget those.
    this.samples = this.samples.filter((o) => {
      const d = Math.max(0, received - o.at) * this.drift
      return o.lo - d <= s.hi && o.hi + d >= s.lo
    })
    this.samples.push(s)
    if (this.samples.length > this.window) this.samples.shift()
    this.est = this.estimate(received)
  }

  /** Midpoint of the intersection of the intervals, newest first, each widened for the drift since it was taken. An
   *  interval that would empty the intersection (a step, or drift beyond the assumption) ends the walk. */
  private estimate(now: number): number {
    let lo = -Infinity
    let hi = Infinity
    for (let i = this.samples.length - 1; i >= 0; i--) {
      const o = this.samples[i]!
      const d = Math.max(0, now - o.at) * this.drift
      const nlo = Math.max(lo, o.lo - d)
      const nhi = Math.min(hi, o.hi + d)
      if (nlo > nhi) break
      lo = nlo
      hi = nhi
    }
    return (lo + hi) / 2
  }

  /**
   * Remote time for local time `local`: snaps to the estimate on the first call after a sample, then never steps back,
   * only runs up to `slew` faster or slower until it meets the estimate (or jumps forward when `snap` behind). NaN
   * before the first sample.
   */
  now(local: number): number {
    if (this.est === null) return Number.NaN
    const target = local + this.est
    if (Number.isNaN(this.shown)) {
      this.shownLocal = local
      this.shown = target
      return target
    }
    const dt = local - this.shownLocal
    if (!(dt > 0)) return this.shown
    const free = this.shown + dt
    const err = target - free
    const limit = this.slew * dt
    this.shown = err > this.snap ? target : free + Math.max(-limit, Math.min(limit, err))
    this.shownLocal = local
    return this.shown
  }
}
