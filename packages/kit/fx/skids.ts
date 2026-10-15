/** Ground a tyre can mark: 0 asphalt and concrete, 1 dirt and grass, 2 wet road. Callers map their own terrain. */
export type SkidSurface = 0 | 1 | 2
export const SKID_SURFACES = { asphalt: 0, dirt: 1, wet: 2 } as const

/** Per segment: a.xyz width | b.xyz birth | multiply rgb strength | life fade distance-at-a 0. */
export const SKID_STRIDE = 16

export type SkidSettings = {
  /** Seconds a mark stays at full strength plus its fade. */
  life: number
  /** Seconds of fade at the end of a mark's life. */
  fade: number
  /** Tread width in metres on asphalt; dirt widens it. */
  width: number
  /** Overall darkness, 0–1. */
  strength: number
}
export const SKID_DEFAULTS: SkidSettings = { life: 180, fade: 30, width: 0.17, strength: 0.75 }

/** Surface multiply colour (what a fully dark mark leaves) and per-surface width, life and strength scales. */
const SURFACE = [
  { tint: [0.16, 0.16, 0.17], width: 1, life: 1, strength: 1 },
  { tint: [0.42, 0.32, 0.22], width: 1.45, life: 0.6, strength: 0.9 },
  { tint: [0.5, 0.52, 0.56], width: 0.9, life: 0.08, strength: 0.6 },
] as const

/**
 * Persistent tyre marks: a ring buffer of decal strips laid by `segment`, faded by age on the GPU.
 * Writes are incremental: `dirty` holds the slot range written since the last upload.
 * No per-frame work or allocation; expired slots just stop drawing.
 */
export class SkidMarks {
  readonly data: Float32Array<ArrayBuffer>
  readonly settings: SkidSettings
  /** Slots holding a mark, ever written (≤ capacity). */
  count = 0
  /** Total segments ever written; the next slot is `written % capacity`. */
  written = 0
  /** Presentation clock in seconds; advance with `update(dt)`. */
  time = 0
  /** `written` at the last upload; slots written since then are dirty. */
  uploaded = 0
  /** Bumped by `clear()` so renderers know to drop everything. */
  generation = 0

  constructor(readonly capacity = 4096, settings: Partial<SkidSettings> = {}) {
    this.data = new Float32Array(capacity * SKID_STRIDE)
    this.settings = { ...SKID_DEFAULTS, ...settings }
  }

  update(dt: number) { this.time += dt }

  clear() {
    this.data.fill(0)
    this.count = this.written = this.uploaded = 0
    this.generation++
  }

  /** `SkidSink` adapter: `alpha` is mark strength 0–1, `y` the ground height of `a` (and `b` when `by` is omitted). */
  skidSegment(ax: number, az: number, bx: number, bz: number, alpha: number, y = 0, surface: number = 0, by = y, along = 0) {
    this.segment(ax, y, az, bx, by, bz, alpha, surface as SkidSurface, along)
  }

  /** One strip from a to b on the ground (heights in world Y). `along` is tread distance at a for the pattern. */
  segment(ax: number, ay: number, az: number, bx: number, by: number, bz: number, alpha: number, surface: SkidSurface = 0, along = 0) {
    const length = Math.hypot(bx - ax, bz - az)
    if (length < 0.015 || length > 8 || !(alpha > 0)) return
    const s = SURFACE[surface] ?? SURFACE[0], c = this.settings
    const slot = this.written % this.capacity, o = slot * SKID_STRIDE, d = this.data
    this.written++
    this.count = Math.min(this.capacity, this.count + 1)
    d[o] = ax; d[o + 1] = ay; d[o + 2] = az; d[o + 3] = c.width * s.width
    d[o + 4] = bx; d[o + 5] = by; d[o + 6] = bz; d[o + 7] = this.time
    d[o + 8] = s.tint[0]; d[o + 9] = s.tint[1]; d[o + 10] = s.tint[2]; d[o + 11] = Math.min(1, alpha) * c.strength * s.strength
    d[o + 12] = c.life * s.life; d[o + 13] = Math.min(c.fade, c.life * s.life); d[o + 14] = along; d[o + 15] = 0
  }

  /** Visible segments right now (alive and unexpired), for telemetry and tests. */
  alive() {
    let n = 0
    for (let i = 0; i < this.count; i++) {
      const o = i * SKID_STRIDE
      if (this.time - this.data[o + 7]! < this.data[o + 12]!) n++
    }
    return n
  }

  /** Strength a segment would draw with now: full until its fade, then linearly to zero. */
  opacity(slot: number) {
    const o = slot * SKID_STRIDE, d = this.data, age = this.time - d[o + 7]!, life = d[o + 12]!, fade = d[o + 13]!
    if (slot >= this.count || age >= life) return 0
    return d[o + 11]! * Math.min(1, (life - age) / Math.max(1e-3, fade))
  }

  /** Slot ranges [from, to) written since the last call, at most two (the ring wraps once). */
  readonly dirty: [number, number][] = [[0, 0], [0, 0]]
  /** Fills `dirty` and returns how many ranges it holds; marks them uploaded. */
  takeDirty(): number {
    const n = this.written - this.uploaded, cap = this.capacity, r = this.dirty
    this.uploaded = this.written
    if (n <= 0) return 0
    if (n >= cap) { r[0]![0] = 0; r[0]![1] = cap; return 1 }
    const from = (this.written - n) % cap, to = this.written % cap
    if (from < to) { r[0]![0] = from; r[0]![1] = to; return 1 }
    r[0]![0] = from; r[0]![1] = cap
    if (to === 0) return 1
    r[1]![0] = 0; r[1]![1] = to
    return 2
  }
}
