/**
 * Adaptive input jitter buffer (playout schedule), generalised from Wings's `room-engine.ts`.
 *
 * Input `seq` is due at tick `seq + offset`, where `offset` is set on the first arrival to hold about `target` ticks.
 * `take(tick)` normally returns exactly one input per tick:
 * - a dry tick repeats the last input without its one-shot edges (`standIn`) and advances `ack`, so the late
 *   original is never applied twice; its edges are carried into the next input instead of being dropped;
 * - repeated underruns grow the buffer by one tick; a window with spare depth, or depth above target + margin,
 *   shrinks it, and that tick returns two inputs (the caller applies both, so client prediction still matches);
 * - with `lateQuantile` the target instead follows how late inputs arrive: over each window, that quantile of
 *   arrival lateness (behind the fastest arrival). Over TCP, rare retransmit and Wi-Fi stalls then don't hold every
 *   later input back: stand-ins bridge them and the buffer stays as deep as ordinary jitter needs;
 * - inputs dropped by the hard cap, or arriving after their stand-in, give their edges to the next applied input.
 */
export type InputOps<T> = {
  /** `later` with any one-shot edges (fire, interact…) of `earlier` OR-ed in. */
  merge(earlier: T, later: T): T
  /** A copy of `last` for a dry tick: same held movement, no one-shot edges. */
  standIn(last: T): T
  /** Whether the input carries a one-shot edge worth keeping when it would otherwise be discarded. */
  hasEdges(input: T): boolean
}

export type JitterConfig = {
  initialTarget: number
  minTarget: number
  maxTarget: number
  /** Ticks per adaptation window. */
  window: number
  catchupMargin: number
  /** Most consecutive stand-ins before treating the sender as idle. */
  maxSynth: number
  /** Contiguous inputs needed before stand-ins are allowed. */
  streamMin: number
  queueMax: number
  /** Ticks without an arrival after which no stand-ins are made. */
  staleTicks: number
  /**
   * Size the buffer from this quantile (0-1) of arrival lateness over the last `window` arrivals, growing only at a
   * tick that already needs a stand-in and shrinking when the quantile allows. Off (underrun-driven) when unset.
   */
  lateQuantile?: number
}

export const DEFAULT_JITTER: JitterConfig = {
  initialTarget: 2,
  minTarget: 1,
  maxTarget: 6,
  window: 180,
  catchupMargin: 2,
  maxSynth: 4,
  streamMin: 10,
  queueMax: 30,
  staleTicks: 60,
}

/**
 * For inputs over a WebSocket at `tickHz`. TCP never reorders or loses, but turns a lost segment (a ~200 ms
 * retransmit) or a Wi-Fi stall into a hold on everything behind it followed by a burst. Buffering for those would
 * delay every input; instead the depth covers `quantile` of arrivals' ordinary jitter (at most ~67 ms), stand-ins
 * bridge a stall for up to `bridgeMs`, and a burst drains at once.
 *
 * Rooms that step each input separately (Outbreak) catch up exactly, so a short bridge (then a pause and catch-up)
 * keeps prediction exact; rooms that merge two inputs into one tick lose a tick of movement per catch-up, so a long
 * bridge suits them better.
 */
export function socketJitter(tickHz: number, { quantile = 0.9, bridgeMs = 270 } = {}): JitterConfig {
  return {
    // Start shallow: growing happens at a tick that needs a stand-in anyway, shrinking costs a merged tick.
    initialTarget: 0,
    minTarget: 0,
    maxTarget: Math.max(2, Math.round(0.067 * tickHz)),
    window: 3 * tickHz,
    // Two inputs landing in one tick is ordinary jitter, not a backlog: merging them would cost a tick of movement.
    catchupMargin: Math.max(2, Math.round(0.1 * tickHz)),
    maxSynth: Math.max(1, Math.round((bridgeMs / 1000) * tickHz)),
    streamMin: 10,
    queueMax: tickHz,
    staleTicks: 2 * tickHz,
    lateQuantile: quantile,
  }
}

export type JitterStats = { late: number; dropped: number; synthesized: number; caughtUp: number; target: number; depth: number }

type Queued<T> = { seq: number; at: number; input: T }

export class JitterBuffer<T> {
  /** Highest sequence applied (or stood in for). */
  ack = -1
  private seq = -1
  private queue: Queued<T>[] = []
  private last: T | null = null
  private carry: T | null = null
  private primed = false
  private offset = 0
  private target: number
  private streak = 0
  private starveRun = 0
  private windowTicks = 0
  private windowMinSlack = Infinity
  private windowUnderruns = 0
  private lastArrival = -Infinity
  /** Arrival tick minus sequence, for the last `window` arrivals (lateQuantile mode). */
  private readonly arrivals: number[] = []
  private arrivalAt = 0
  private want: number
  /** Smallest arrival tick minus sequence over the last window: where a zero-depth schedule would sit. */
  private fastest = 0
  private readonly out: T[] = []
  readonly stats = { late: 0, dropped: 0, synthesized: 0, caughtUp: 0 }

  constructor(
    private readonly ops: InputOps<T>,
    private readonly config: JitterConfig = DEFAULT_JITTER,
  ) {
    this.target = config.initialTarget
    this.want = config.initialTarget
  }

  get depth(): number {
    return this.queue.length
  }

  snapshot(): JitterStats {
    return { ...this.stats, target: this.target, depth: this.queue.length }
  }

  /**
   * Accepts input `seq`, arriving in time for `take(tick)` at the earliest. Out-of-order or duplicate sequences are
   * ignored.
   */
  push(seq: number, input: T, tick: number): void {
    if (!Number.isSafeInteger(seq) || seq < 0 || seq <= this.seq) return
    const gap = seq - this.seq
    this.streak = gap === 1 ? this.streak + 1 : gap <= 6 && this.streak >= this.config.streamMin ? this.streak : 0
    this.seq = seq
    this.lastArrival = tick
    if (this.config.lateQuantile !== undefined) {
      if (this.arrivals.length < this.config.window) this.arrivals.push(tick - seq)
      else this.arrivals[this.arrivalAt++ % this.config.window] = tick - seq
    }
    if (seq <= this.ack) {
      // Already stood in for while the buffer ran dry: never apply it twice, but keep its presses.
      this.stats.late++
      this.stash(input)
      return
    }
    this.queue.push({ seq, at: tick, input })
    while (this.queue.length > this.config.queueMax) {
      const dropped = this.queue.shift()!
      this.ack = dropped.seq
      this.last = dropped.input
      this.stash(dropped.input)
      this.stats.dropped++
    }
  }

  /** The inputs to apply this tick, in order (usually one; two while catching up; none before priming or when idle). */
  take(tick: number): readonly T[] {
    const out = this.out
    out.length = 0
    const q = this.queue
    const c = this.config
    while (q.length && q[0]!.seq <= this.ack) {
      this.stash(q.shift()!.input)
      this.stats.late++
    }
    if (!this.primed) {
      if (!q.length) return out
      // Re-priming after a stall keeps the schedule measured before it: the burst that ends a stall arrives late.
      if (c.lateQuantile === undefined || this.arrivals.length < 10) this.fastest = q[0]!.at - q[0]!.seq
      this.offset = this.fastest + this.target
      this.primed = true
      this.starveRun = 0
    }
    if (++this.windowTicks >= c.window) {
      if (c.lateQuantile !== undefined) {
        this.retarget(c.lateQuantile)
        if (this.want < this.target) this.target--
        // Shrinking (or a client clock running fast) leaves the schedule deeper than the target: catch up a tick.
        if (this.offset > this.fastest + this.target) {
          this.offset--
          this.stats.caughtUp++
        }
      } else if (this.windowUnderruns === 0 && this.windowMinSlack >= 1 && this.windowMinSlack !== Infinity) {
        if (this.target > c.minTarget) this.target--
        this.offset--
      }
      this.windowTicks = 0
      this.windowMinSlack = Infinity
      this.windowUnderruns = 0
    }
    if (q.length > this.target + c.catchupMargin) {
      this.offset--
      this.stats.caughtUp++
    }
    const due = tick - this.offset
    while (out.length < 2 && q.length && q[0]!.seq <= due) {
      const next = q.shift()!
      let input = next.input
      if (this.carry) {
        input = this.ops.merge(this.carry, input)
        this.carry = null
      }
      this.ack = next.seq
      this.last = next.input
      out.push(input)
    }
    if (out.length) {
      this.starveRun = 0
      if (q.length < this.windowMinSlack) this.windowMinSlack = q.length
      return out
    }
    if (this.ack >= due) return out
    if (this.starveRun === 0) this.windowUnderruns++
    if (
      this.starveRun < c.maxSynth &&
      this.ack >= 0 &&
      this.last &&
      this.streak >= c.streamMin &&
      tick - this.lastArrival <= c.staleTicks
    ) {
      this.starveRun++
      this.stats.synthesized++
      this.ack++
      this.windowMinSlack = 0
      if (c.lateQuantile !== undefined) {
        // Grow only at a tick that already needs a stand-in, so it costs no extra correction.
        if (this.want > this.target && this.target < c.maxTarget) this.target++
        if (this.offset < this.fastest + this.target) this.offset++
      } else if ((this.starveRun >= 2 || this.windowUnderruns >= 2) && this.target < c.maxTarget) {
        this.target++
        this.offset++
        this.windowUnderruns = 0
      }
      let input = this.ops.standIn(this.last)
      if (this.carry) {
        input = this.ops.merge(this.carry, input)
        this.carry = null
      }
      out.push(input)
      return out
    }
    // Long gap (sender idle): re-prime on the next arrival.
    this.starveRun = 0
    this.primed = false
    return out
  }

  /** The buffer depth that covers `q` of recent arrivals (each measured behind the fastest of them). */
  private retarget(q: number): void {
    const a = this.arrivals
    if (a.length < 10) return
    let fastest = Infinity
    for (const v of a) fastest = Math.min(fastest, v)
    const late = a.map((v) => v - fastest).sort((x, y) => x - y)
    const at = late[Math.min(late.length - 1, Math.floor(q * late.length))]!
    this.fastest = fastest
    this.want = Math.max(this.config.minTarget, Math.min(this.config.maxTarget, Math.ceil(at)))
  }

  private stash(input: T): void {
    if (!this.ops.hasEdges(input)) return
    this.carry = this.carry ? this.ops.merge(this.carry, input) : input
  }

}
