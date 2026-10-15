/**
 * Game-agnostic per-recipient interest management, priority accumulation, acked-snapshot history,
 * and adaptive snapshot rate pacing for authoritative multiplayer rooms.
 */

export type InterestConfig = {
  /** Half-width/height of the recipient's interest bubble in metres (entities outside are culled). */
  bubbleHalfExtent: number
  /** Distance within which entities update at full snapshot rate (stride 1). */
  nearRange: number
  /** Distance within which non-urgent entities update at half snapshot rate (stride 2). */
  midRange: number
  /** Snapshot stride for distant or idle non-urgent entities inside the bubble (e.g. 4 = 5 Hz at 20 Hz base). */
  farStride: number
}

export const DEFAULT_INTEREST: InterestConfig = {
  bubbleHalfExtent: 64,
  nearRange: 20,
  midRange: 36,
  farStride: 4,
}

/** True when `(x, y)` lies inside the axis-aligned interest bubble centred at `(cx, cy)`. */
export function inInterestBubble(
  x: number,
  y: number,
  cx: number,
  cy: number,
  halfExtent = DEFAULT_INTEREST.bubbleHalfExtent,
): boolean {
  return Math.abs(x - cx) <= halfExtent && Math.abs(y - cy) <= halfExtent
}

/**
 * Computes the update stride (1, 2, or `farStride`) for an entity at `dist` metres from the nearest viewer in the
 * bubble. Urgent entities (attacking, chasing close, taking damage, changing state) always return stride 1.
 */
export function selectInterestStride(
  dist: number,
  urgent: boolean,
  idle: boolean,
  config: InterestConfig = DEFAULT_INTEREST,
): number {
  if (urgent) return 1
  if (dist > config.midRange) return config.farStride
  if (dist > config.nearRange || idle) return 2
  return 1
}

/** Deterministic staggered schedule so entities with `stride > 1` spread evenly across consecutive snapshots. */
export function isScheduledOnSnapshot(snapIndex: number, entityId: number, stride: number): boolean {
  if (stride <= 1) return true
  return (snapIndex + Math.imul(entityId, 7)) % stride === 0
}

/**
 * Stateful per-recipient priority accumulator.
 * Entities accumulate priority each snapshot proportional to relevance (`1 / stride`); when `priority >= 1`,
 * the entity is selected for transmission and its accumulator wraps by `-1`.
 */
export class PriorityAccumulator<Id extends number | string = number> {
  private readonly acc = new Map<Id, number>()

  constructor(private readonly config: InterestConfig = DEFAULT_INTEREST) {}

  /** Advances priority for `id` and returns true when the entity should emit an update this snapshot. */
  step(id: Id, dist: number, urgent: boolean, idle = false): boolean {
    if (urgent) {
      this.acc.set(id, 0)
      return true
    }
    const stride = selectInterestStride(dist, false, idle, this.config)
    const gain = 1 / stride
    const prev = this.acc.get(id) ?? ((typeof id === "number" ? (id * 0.37) % 1 : 0.5))
    const next = prev + gain
    if (next >= 1 - 1e-6) {
      this.acc.set(id, next - 1)
      return true
    }
    this.acc.set(id, next)
    return false
  }

  delete(id: Id): void {
    this.acc.delete(id)
  }

  clear(): void {
    this.acc.clear()
  }
}

/**
 * Bounded ring buffer of recent snapshots keyed by server `tick`, used on both the server (to look up the
 * baseline snapshot acknowledged by a client) and the client (to reconstruct delta snapshots from `baseTick`).
 */
export class AckHistory<S> {
  private readonly ticks: Int32Array
  private readonly states: (S | undefined)[]
  private head = 0
  private count = 0

  constructor(readonly capacity = 32) {
    this.ticks = new Int32Array(capacity).fill(-1)
    this.states = new Array<S | undefined>(capacity)
  }

  get size(): number {
    return this.count
  }

  record(tick: number, state: S): void {
    this.ticks[this.head] = tick
    this.states[this.head] = state
    this.head = (this.head + 1) % this.capacity
    if (this.count < this.capacity) this.count++
  }

  get(tick: number): S | undefined {
    if (tick <= 0) return undefined
    for (let i = 0; i < this.count; i++) {
      const idx = (this.head - 1 - i + this.capacity) % this.capacity
      if (this.ticks[idx] === tick) return this.states[idx]
    }
    return undefined
  }

  latest(): { tick: number; state: S } | undefined {
    if (this.count === 0) return undefined
    const idx = (this.head - 1 + this.capacity) % this.capacity
    return { tick: this.ticks[idx]!, state: this.states[idx]! }
  }

  clear(): void {
    this.ticks.fill(-1)
    this.states.fill(undefined)
    this.head = 0
    this.count = 0
  }
}

/**
 * Per-recipient rolling bandwidth tracker that adapts the snapshot tick stride when outgoing byte rate
 * exceeds `targetBytesPerSec`.
 */
export class BandwidthPacer {
  private windowStart = 0
  private windowBytes = 0
  ewmaBytesPerSec = 0

  constructor(
    readonly baseStride = 3,
    readonly maxStride = 9,
    readonly targetBytesPerSec = 22 * 1024,
  ) {}

  record(bytes: number, nowSec: number): void {
    if (this.windowStart === 0) this.windowStart = nowSec
    this.windowBytes += bytes
    const elapsed = nowSec - this.windowStart
    if (elapsed >= 0.2) {
      const rate = this.windowBytes / elapsed
      this.ewmaBytesPerSec = this.ewmaBytesPerSec === 0 ? rate : this.ewmaBytesPerSec * 0.5 + rate * 0.5
      this.windowStart = nowSec
      this.windowBytes = 0
    }
  }

  stride(): number {
    if (this.ewmaBytesPerSec <= this.targetBytesPerSec) return this.baseStride
    const scaled = Math.ceil((this.baseStride * this.ewmaBytesPerSec) / this.targetBytesPerSec)
    return Math.min(this.maxStride, Math.max(this.baseStride + 1, scaled))
  }
}
