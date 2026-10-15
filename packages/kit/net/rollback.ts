/**
 * Rollback for a deterministic fixed-step game behind an input-relay room. The room is the input authority: it
 * decides which input every seat ran on every tick (a stand-in repeats the seat's last input when the real one is
 * late) and broadcasts that confirmed frame. Each client steps its own copy of the confirmed state with those frames,
 * and draws a prediction ahead of it: the confirmed state re-simulated to the client's head tick with its own inputs
 * as typed and everyone else's last confirmed input held. Your own controls apply on the frame you press them; other
 * players are drawn where they will most likely be, corrected when their real inputs arrive.
 *
 * `RollbackClient` keeps the two states and the event dedupe; `TickPacer` keeps the head far enough ahead that inputs
 * reach the room just before it needs them, from the room's measure of how early they arrive.
 *
 * Pure: no timers, sockets or DOM, so tests drive it with `./link-sim`.
 */

export type RollbackSim<S, F, E> = {
  clone(s: S): S
  /** Runs one tick of `frame` on `s` and returns the tick's events. */
  step(s: S, frame: F): E[]
  /** The frame for a tick the room hasn't confirmed: `last` confirmed frame's held inputs with this client's `own`. */
  predict(last: F, own: number | undefined): F
  /**
   * Who an event is about (`kill:p2`, `stick:41`): the same event seen again within `dedupeTicks` of when it was
   * shown is a re-simulation of it, not a new one. Without it every event shows once per tick it is simulated on.
   */
  sig?(e: E): string
}

export type RollbackOptions = {
  /** An event re-simulated this many ticks from where it was shown is the same event (default 4). */
  dedupeTicks?: number
  /** Furthest the prediction runs past the confirmed tick; beyond it the head waits (default 36, 0.6 s at 60 Hz). */
  maxAhead?: number
}

export class RollbackClient<S, F, E> {
  private confirmedState: S | null = null
  private lastFrame: F | null = null
  private predicted: S | null = null
  private predictedTick = 0
  private dirty = true
  private own = new Map<number, number>()
  private shown = new Map<number, Set<string>>()
  private readonly dedupeTicks: number
  readonly maxAhead: number
  /** The confirmed tick. */
  tick = 0
  /** Ticks re-simulated by the last `advance` (0 when it only stepped forward). */
  resimulated = 0

  constructor(
    private readonly sim: RollbackSim<S, F, E>,
    opts: RollbackOptions = {},
  ) {
    this.dedupeTicks = opts.dedupeTicks ?? 4
    this.maxAhead = opts.maxAhead ?? 36
  }

  get ready(): boolean {
    return this.confirmedState !== null
  }

  /** The confirmed state (read only). */
  get confirmed(): S {
    return this.confirmedState!
  }

  /** The prediction at `headTick`, the state to draw (read only). */
  get state(): S {
    return this.predicted ?? this.confirmedState!
  }

  get headTick(): number {
    return this.predicted ? this.predictedTick : this.tick
  }

  /** The room's state after `tick` (joining, reconnecting, or a resync after a desync); `last` is that tick's frame. */
  reset(state: S, tick: number, last: F): void {
    this.confirmedState = state
    this.lastFrame = last
    this.tick = tick
    this.predicted = null
    this.dirty = true
    for (const t of this.own.keys()) if (t <= tick) this.own.delete(t)
  }

  /** Records this client's input for `tick` (it predicts with it until the room confirms the tick). */
  input(tick: number, buttons: number): void {
    this.own.set(tick, buttons)
  }

  /**
   * The room's frame for `tick`. Returns that tick's events not already shown by a prediction, or "gap" when a frame
   * was missed (the caller asks for a resync). An old frame is ignored.
   */
  confirm(tick: number, frame: F): E[] | "gap" {
    if (!this.confirmedState || tick <= this.tick) return []
    if (tick !== this.tick + 1) return "gap"
    const events = this.sim.step(this.confirmedState, frame)
    this.tick = tick
    this.lastFrame = frame
    this.own.delete(tick)
    this.dirty = true
    for (const t of this.shown.keys()) if (t < tick - 4 * this.dedupeTicks) this.shown.delete(t)
    return this.fresh(tick, events)
  }

  /**
   * Brings the prediction to `head` (no further than `maxAhead` past the confirmed tick), re-simulating from the
   * confirmed state when a frame arrived since the last call. `after(state, tick)` hears each step's result.
   * Returns the events not already shown.
   */
  advance(head: number, after?: (s: S, tick: number) => void): E[] {
    if (!this.confirmedState || !this.lastFrame) return []
    const target = Math.min(head, this.tick + this.maxAhead)
    const out: E[] = []
    this.resimulated = 0
    if (this.dirty || !this.predicted || this.predictedTick < this.tick) {
      const reached = this.predicted ? this.predictedTick : this.tick
      this.predicted = this.sim.clone(this.confirmedState)
      this.predictedTick = this.tick
      this.dirty = false
      this.resimulated = Math.max(0, Math.min(reached, target) - this.tick)
    }
    while (this.predictedTick < target) {
      const t = this.predictedTick + 1
      const events = this.sim.step(this.predicted, this.sim.predict(this.lastFrame, this.own.get(t)))
      this.predictedTick = t
      after?.(this.predicted, t)
      out.push(...this.fresh(t, events))
    }
    return out
  }

  private fresh(tick: number, events: E[]): E[] {
    const sig = this.sim.sig
    if (!sig) return events
    const out: E[] = []
    for (const e of events) {
      const key = sig(e)
      let seen = false
      for (let t = tick - this.dedupeTicks; t <= tick + this.dedupeTicks && !seen; t++) seen = !!this.shown.get(t)?.has(key)
      if (seen) continue
      let set = this.shown.get(tick)
      if (!set) this.shown.set(tick, (set = new Set()))
      set.add(key)
      out.push(e)
    }
    return out
  }
}

/**
 * The room half: what each seat runs on each tick. A seat's input for tick `t` applies at `t` when it arrives in
 * time; a late one applies on the next tick the room runs (a press is delayed, never lost). With nothing new the seat
 * holds its last input, which is also what every client predicts for it. Each arrival is measured: `slack` is how
 * many ticks early inputs arrive at the `quantile` over the last `window` ticks, the number the client's `TickPacer`
 * steers by. Not the minimum: over TCP one lost segment holds everything behind it for 200 ms, and chasing those would
 * keep every input a dozen ticks early (and every prediction that much further ahead) for a few late ones.
 */
export class InputRelay<K> {
  private seats = new Map<K, { held: number; queue: [number, number][]; samples: [number, number][] }>()

  constructor(
    readonly window = 120,
    readonly quantile = 0.2,
  ) {}

  private seat(key: K) {
    let s = this.seats.get(key)
    if (!s) this.seats.set(key, (s = { held: 0, queue: [], samples: [] }))
    return s
  }

  /** `buttons` for `tick` arrived while the room's last run tick was `ran`. */
  receive(key: K, tick: number, buttons: number, ran: number): void {
    if (!Number.isInteger(tick)) return
    const s = this.seat(key)
    s.samples.push([ran, tick - (ran + 1)])
    while (s.samples.length && s.samples[0]![0] < ran - this.window) s.samples.shift()
    const at = Math.max(tick, ran + 1)
    const q = s.queue
    let i = q.length
    while (i > 0 && q[i - 1]![0] > at) i--
    if (i > 0 && q[i - 1]![0] === at) q[i - 1]![1] = buttons
    else q.splice(i, 0, [at, buttons])
    // A client far ahead can't queue without bound.
    if (q.length > 240) q.splice(0, q.length - 240)
  }

  /** The input `key` runs on `tick` (call once per tick, in order). */
  take(key: K, tick: number): number {
    const s = this.seat(key)
    while (s.queue.length && s.queue[0]![0] <= tick) s.held = s.queue.shift()![1]
    return s.held
  }

  /** Ticks early at the quantile over the window as of tick `ran` (negative: late), or null with no recent arrivals. */
  slack(key: K, ran: number): number | null {
    const s = this.seats.get(key)
    if (!s) return null
    const v: number[] = []
    for (const [at, early] of s.samples) if (at >= ran - this.window) v.push(early)
    if (!v.length) return null
    v.sort((a, b) => a - b)
    return v[Math.floor((v.length - 1) * this.quantile)]!
  }

  /** The seat dropped or left: it holds nothing from the next tick. */
  release(key: K): void {
    const s = this.seat(key)
    s.held = 0
    s.queue = []
    s.samples = []
  }

  delete(key: K): void {
    this.seats.delete(key)
  }
}

export type PacerOptions = {
  /** Ticks early an input should reach the room, at the room's quantile (default 1). */
  target?: number
  /** Rate change per tick of error, and the most it may change (default 0.02 and 0.06: 0.94x to 1.06x). */
  gain?: number
  maxSlew?: number
  /** Inputs this many ticks late: jump the head forward instead of slewing (default 4)... */
  jump?: number
  /** ...at most once per this many ticks, since reports already in flight still show the old lateness (default 120). */
  jumpEvery?: number
}

/**
 * The client's head tick: the room's tick plus the one-way trip plus a margin, kept there by running the local fixed
 * step slightly fast or slow from the room's report of how early this client's inputs arrive (`slack`, the fewest
 * ticks early at the room's quantile). Slewing keeps steps even; only a large, lasting shortfall jumps.
 */
export class TickPacer {
  private head = 0
  private rate = 1
  private readonly target: number
  private readonly gain: number
  private readonly maxSlew: number
  private readonly jump: number
  private readonly jumpEvery: number
  private jumpedAt = -Infinity

  constructor(
    readonly tickMs: number,
    opts: PacerOptions = {},
  ) {
    this.target = opts.target ?? 1
    this.gain = opts.gain ?? 0.02
    this.maxSlew = opts.maxSlew ?? 0.06
    this.jump = opts.jump ?? 4
    this.jumpEvery = opts.jumpEvery ?? 120
  }

  /** The room was at `tick` when it sent something that took `rttMs` to come back. */
  start(tick: number, rttMs: number): void {
    this.head = tick + rttMs / this.tickMs + this.target + 1
    this.rate = 1
  }

  /** The head tick (whole ticks to have simulated). */
  get tick(): number {
    return Math.floor(this.head)
  }

  /** How far into the next tick the head is, for drawing between ticks. */
  get fraction(): number {
    return this.head - Math.floor(this.head)
  }

  get speed(): number {
    return this.rate
  }

  /** The room's latest measure of how many ticks early this client's inputs arrive. */
  slack(ticks: number): void {
    const err = ticks - this.target
    if (err <= -this.jump && this.head - this.jumpedAt > this.jumpEvery) {
      this.head -= err
      this.jumpedAt = this.head
      this.rate = 1
      return
    }
    this.rate = 1 - Math.max(-this.maxSlew, Math.min(this.maxSlew, err * this.gain))
  }

  /** Never behind the confirmed tick: a client can't predict the past. */
  atLeast(tick: number): void {
    if (this.head < tick + 1) this.head = tick + 1
  }

  update(dtMs: number): number {
    this.head += (dtMs / this.tickMs) * this.rate
    return this.tick
  }
}
