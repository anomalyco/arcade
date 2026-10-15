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
  /** Lead change per tick of slack error, per report (default 0.01; reports come every tick). */
  gain?: number
  /** Most the local step runs fast to catch up with its target (default 0.08: 1.08x). Slowing goes down to 0.5x: a
   *  room whose clock runs slow has to be followed, and holding back is less visible than racing ahead. */
  maxSlew?: number
  /** Further ahead than this from its target and the head jumps instead of slewing (default 8 ticks). */
  snap?: number
  /** Frames this recent (ms) estimate the room's tick (default 500). */
  window?: number
}

/**
 * The client's head tick: where the room's tick is now, estimated from the frames it sends (the least delayed in the
 * last half second; this follows a room whose clock runs slow or stalls), plus a lead. The lead is learned from the
 * room's report of how early this client's inputs arrive (`slack`, at the room's quantile): too late and it grows,
 * too early and it shrinks, so it settles at the uplink delay plus `target`. The head slews toward that so steps stay
 * even (catching up at most `maxSlew` faster, holding back down to half speed), jumping forward only when far behind.
 */
export class TickPacer {
  private head = 0
  private last = Number.NaN
  private rate = 1
  private lead = 0
  /** Recent frames as [local ms, room tick minus local ticks]. */
  private offsets: [number, number][] = []
  private readonly target: number
  private readonly gain: number
  private readonly maxSlew: number
  private readonly snap: number
  private readonly window: number

  constructor(
    readonly tickMs: number,
    opts: PacerOptions = {},
  ) {
    this.target = opts.target ?? 1
    this.gain = opts.gain ?? 0.01
    this.maxSlew = opts.maxSlew ?? 0.08
    this.snap = opts.snap ?? 8
    this.window = opts.window ?? 500
  }

  /** The room sent its state at `tick`, received at local `now` after a round trip of `rttMs`. */
  start(tick: number, rttMs: number, now: number): void {
    const oneWay = rttMs / 2 / this.tickMs
    this.offsets = [[now, tick + oneWay - now / this.tickMs]]
    this.lead = oneWay + this.target + 1
    this.head = this.room(now) + this.lead
    this.last = now
    this.rate = 1
  }

  /** The room's frame for `tick` arrived at local `now`. */
  frame(tick: number, now: number): void {
    this.offsets.push([now, tick - now / this.tickMs])
    while (this.offsets.length > 1 && this.offsets[0]![0] < now - this.window) this.offsets.shift()
  }

  /** The room's tick at local `now`, as seen through the fastest recent frame. */
  room(now: number): number {
    let best = -Infinity
    for (const [, o] of this.offsets) if (o > best) best = o
    return best + now / this.tickMs
  }

  /** The room's latest measure of how many ticks early this client's inputs arrive. */
  slack(ticks: number): void {
    this.lead = Math.max(0, Math.min(60, this.lead + (this.target - ticks) * this.gain))
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

  /** Ticks the head runs ahead of the room's estimated tick. */
  get ahead(): number {
    return this.lead
  }

  /** Never behind the confirmed tick: a client can't predict the past. */
  atLeast(tick: number): void {
    if (this.head < tick + 1) this.head = tick + 1
  }

  /** Advances to local time `now`; returns the head tick. */
  update(now: number): number {
    const dt = Number.isNaN(this.last) ? 0 : Math.max(0, now - this.last)
    this.last = now
    const err = this.room(now) + this.lead - this.head
    if (err > this.snap) {
      this.head += err
      this.rate = 1
    } else {
      this.rate = 1 + Math.max(-0.5, Math.min(this.maxSlew, err * 0.05))
      this.head += (dt / this.tickMs) * this.rate
    }
    return this.tick
  }
}
