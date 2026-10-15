/**
 * Game-agnostic server-side position history ring buffer for lag-compensated hitscan rewind.
 *
 * Records authoritative entity positions at each simulation tick using preallocated typed arrays (zero per-tick
 * object allocations) and temporarily rewinds them to the timestamp the shooting client was rendering
 * (`clamp(viewTime, now - maxRewind, now)`) during hitscan evaluation.
 */

export type RewindPose = { x: number; y: number }

/** One recorded tick as plain JSON: ids and their float32 positions, oldest frame first. */
export type RewindFrameSnapshot<Id extends string | number = number> = {
  tick: number
  time: number
  ids: Id[]
  xs: number[]
  ys: number[]
}

type Frame<Id extends string | number> = {
  tick: number
  time: number
  count: number
  ids: Id[]
  xs: Float32Array
  ys: Float32Array
}

export class RewindHistory<Id extends string | number = number> {
  private readonly frames: Frame<Id>[] = []

  constructor(
    /** Maximum ticks retained in the ring buffer (e.g. 24 ticks = 400 ms at 60 Hz or 800 ms at 30 Hz). */
    readonly capacity = 24,
    /** Hard cap on how far back a hitscan query may rewind, in seconds ("favor the shooter" ceiling). */
    readonly maxRewindSeconds = 0.2,
  ) {}

  record<E extends { id: Id; x: number; y: number }>(
    tick: number,
    time: number,
    entities: readonly E[],
    include?: (e: E) => boolean,
  ): void {
    const needed = entities.length
    let frame: Frame<Id>
    if (this.frames.length >= this.capacity) {
      frame = this.frames.shift()!
      frame.tick = tick
      frame.time = time
      if (frame.xs.length < needed) {
        const cap = Math.max(64, Math.ceil(needed * 1.5))
        frame.xs = new Float32Array(cap)
        frame.ys = new Float32Array(cap)
      }
    } else {
      const cap = Math.max(64, needed)
      frame = { tick, time, count: 0, ids: [], xs: new Float32Array(cap), ys: new Float32Array(cap) }
    }
    let k = 0
    const { ids, xs, ys } = frame
    for (let i = 0; i < needed; i++) {
      const e = entities[i]!
      if (include && !include(e)) continue
      ids[k] = e.id
      xs[k] = e.x
      ys[k] = e.y
      k++
    }
    frame.count = k
    this.frames.push(frame)
  }

  /** Interpolates entity positions at `targetTime` (clamped within `maxRewindSeconds` of the latest frame). */
  sampleAtTime(targetTime: number): Map<Id, RewindPose> | null {
    const n = this.frames.length
    if (n === 0) return null
    const latest = this.frames[n - 1]!
    const minTime = latest.time - this.maxRewindSeconds
    const t = Math.max(minTime, Math.min(latest.time, targetTime))
    const toMap = (f: Frame<Id>) => {
      const m = new Map<Id, RewindPose>()
      for (let i = 0; i < f.count; i++) m.set(f.ids[i]!, { x: f.xs[i]!, y: f.ys[i]! })
      return m
    }
    if (n === 1 || t >= latest.time - 1e-6) return toMap(latest)
    const oldest = this.frames[0]!
    if (t <= oldest.time) return toMap(oldest)
    for (let i = n - 1; i > 0; i--) {
      const a = this.frames[i - 1]!
      const b = this.frames[i]!
      if (t >= a.time) {
        const u = Math.max(0, Math.min(1, (t - a.time) / Math.max(1e-6, b.time - a.time)))
        const mapA = new Map<Id, number>()
        for (let k = 0; k < a.count; k++) mapA.set(a.ids[k]!, k)
        const out = new Map<Id, RewindPose>()
        for (let k = 0; k < b.count; k++) {
          const id = b.ids[k]!
          const bx = b.xs[k]!
          const by = b.ys[k]!
          const ia = mapA.get(id)
          if (ia === undefined) {
            out.set(id, { x: bx, y: by })
          } else {
            const ax = a.xs[ia]!
            const ay = a.ys[ia]!
            if (Math.hypot(bx - ax, by - ay) > 4) out.set(id, { x: bx, y: by })
            else out.set(id, { x: ax + (bx - ax) * u, y: ay + (by - ay) * u })
          }
        }
        return out
      }
    }
    return toMap(latest)
  }

  /**
   * Temporarily rewinds `entities` in-place to `targetTime` (skipping `skipId` so an attacker stays at their
   * current tick position), runs `fn()`, and restores their current authoritative positions (preserving any knockback
   * delta applied to an entity during `fn()`).
   */
  withRewoundPositions<E extends { id: Id; x: number; y: number }, R>(
    entities: readonly E[],
    targetTime: number,
    fn: () => R,
    skipId?: Id,
  ): R {
    const poses = this.sampleAtTime(targetTime)
    if (!poses) return fn()
    const savedX = new Float64Array(entities.length)
    const savedY = new Float64Array(entities.length)
    const rewoundX = new Float64Array(entities.length)
    const rewoundY = new Float64Array(entities.length)
    for (let i = 0; i < entities.length; i++) {
      const e = entities[i]!
      savedX[i] = e.x
      savedY[i] = e.y
      const p = skipId !== undefined && e.id === skipId ? undefined : poses.get(e.id)
      if (p) {
        e.x = p.x
        e.y = p.y
      }
      rewoundX[i] = e.x
      rewoundY[i] = e.y
    }
    try {
      return fn()
    } finally {
      for (let i = 0; i < entities.length; i++) {
        const e = entities[i]!
        e.x = savedX[i]! + (e.x - rewoundX[i]!)
        e.y = savedY[i]! + (e.y - rewoundY[i]!)
      }
    }
  }

  clear(): void {
    this.frames.length = 0
  }

  /** Recorded frames as plain JSON, oldest first. Positions are float32 values, so they round-trip exactly. */
  snapshot(): RewindFrameSnapshot<Id>[] {
    return this.frames.map((f) => ({
      tick: f.tick,
      time: f.time,
      ids: f.ids.slice(0, f.count),
      xs: Array.from(f.xs.subarray(0, f.count)),
      ys: Array.from(f.ys.subarray(0, f.count)),
    }))
  }

  /** Replaces the history with `frames` from `snapshot()`; later queries and records match the recorded history. */
  restore(frames: readonly RewindFrameSnapshot<Id>[]): void {
    this.frames.length = 0
    for (const f of frames.slice(-this.capacity)) {
      const count = f.ids.length
      const cap = Math.max(64, count)
      const xs = new Float32Array(cap)
      const ys = new Float32Array(cap)
      xs.set(f.xs)
      ys.set(f.ys)
      this.frames.push({ tick: f.tick, time: f.time, count, ids: f.ids.slice(), xs, ys })
    }
  }
}
