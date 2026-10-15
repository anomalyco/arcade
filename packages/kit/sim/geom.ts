/** Axis-aligned rectangle on the floor plan: [x0, y0, x1, y1] in metres with x0 < x1 and y0 < y1. */
export type Rect = readonly [number, number, number, number]
export type Vec = { x: number; y: number }

/**
 * Distance along a unit ray from (ox, oy) in direction (dx, dy) to where it enters the rectangle, or Infinity when it
 * misses within maxT. An origin inside the rectangle returns 0. The WGSL shadow pass uses the same slab test.
 */
export function rayRect(ox: number, oy: number, dx: number, dy: number, r: Rect, maxT: number): number {
  let t0 = 0
  let t1 = maxT
  if (Math.abs(dx) < 1e-9) {
    if (ox < r[0] || ox > r[2]) return Infinity
  } else {
    let a = (r[0] - ox) / dx
    let b = (r[2] - ox) / dx
    if (a > b) { const t = a; a = b; b = t }
    t0 = Math.max(t0, a)
    t1 = Math.min(t1, b)
    if (t0 > t1) return Infinity
  }
  if (Math.abs(dy) < 1e-9) {
    if (oy < r[1] || oy > r[3]) return Infinity
  } else {
    let a = (r[1] - oy) / dy
    let b = (r[3] - oy) / dy
    if (a > b) { const t = a; a = b; b = t }
    t0 = Math.max(t0, a)
    t1 = Math.min(t1, b)
    if (t0 > t1) return Infinity
  }
  return t0
}

/** Below this many rects a linear scan beats building and walking a grid. */
const GRID_MIN = 48
const GRID_CELL = 2

/**
 * Uniform-grid broadphase over a fixed list of rects. Each cell lists the indices of the rects touching it, ascending,
 * so a query visits candidates in the same order a linear scan would.
 */
export class RectGrid {
  readonly x0: number
  readonly y0: number
  readonly cell: number
  readonly nx: number
  readonly ny: number
  private readonly rawNx: number
  private readonly rawNy: number
  private readonly hashed: boolean
  private readonly boundsRect: Rect
  private start: Int32Array
  private items: Int32Array
  private stamp: Uint32Array
  private gen = 0

  constructor(readonly rects: readonly Rect[]) {
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const r of rects) {
      x0 = Math.min(x0, r[0])
      y0 = Math.min(y0, r[1])
      x1 = Math.max(x1, r[2])
      y1 = Math.max(y1, r[3])
    }
    this.x0 = x0 - 1
    this.y0 = y0 - 1
    const spanX = Math.max(1, x1 + 1 - this.x0)
    const spanY = Math.max(1, y1 + 1 - this.y0)
    this.rawNx = Math.max(1, Math.ceil(spanX / GRID_CELL))
    this.rawNy = Math.max(1, Math.ceil(spanY / GRID_CELL))
    this.boundsRect = [this.x0, this.y0, this.x0 + this.rawNx * GRID_CELL, this.y0 + this.rawNy * GRID_CELL]
    // For wide streaming worlds (>256 m span), use a 4096-bucket spatial hash at 2 m cell resolution so
    // cell queries remain ultra-local (1-3 rects) without allocating a multi-megabyte dense grid.
    this.hashed = this.rawNx * this.rawNy > 16384
    this.cell = GRID_CELL
    this.nx = this.hashed ? 64 : this.rawNx
    this.ny = this.hashed ? 64 : this.rawNy
    const numBuckets = this.nx * this.ny
    const counts = new Int32Array(numBuckets + 1)
    const span = (r: Rect, f: (c: number) => void) => {
      const [a, b, c, d] = this.cells(r[0] - 1e-6, r[1] - 1e-6, r[2] + 1e-6, r[3] + 1e-6)
      for (let y = b; y <= d; y++) {
        for (let x = a; x <= c; x++) {
          const bucket = this.hashed ? ((Math.imul(x, 73856093) ^ Math.imul(y, 19349663)) & 4095) : y * this.nx + x
          f(bucket)
        }
      }
    }
    for (const r of rects) span(r, (c) => counts[c + 1]!++)
    for (let i = 1; i < counts.length; i++) counts[i]! += counts[i - 1]!
    this.start = counts.slice()
    this.items = new Int32Array(counts[counts.length - 1]!)
    rects.forEach((r, i) => span(r, (c) => (this.items[counts[c]!++] = i)))
    this.stamp = new Uint32Array(rects.length)
  }

  /** Clamped cell bounds [cx0, cy0, cx1, cy1] covering a box. */
  cells(x0: number, y0: number, x1: number, y1: number): [number, number, number, number] {
    const c = (v: number, n: number) => Math.max(0, Math.min(n - 1, Math.floor(v / GRID_CELL)))
    return [c(x0 - this.x0, this.rawNx), c(y0 - this.y0, this.rawNy), c(x1 - this.x0, this.rawNx), c(y1 - this.y0, this.rawNy)]
  }

  /** Indices of rects that may touch the box, ascending, written into `out`. */
  query(x0: number, y0: number, x1: number, y1: number, out: number[]): number[] {
    out.length = 0
    const g = this.next()
    const [a, b, c, d] = this.cells(x0, y0, x1, y1)
    for (let y = b; y <= d; y++)
      for (let x = a; x <= c; x++) {
        const k = this.hashed ? ((Math.imul(x, 73856093) ^ Math.imul(y, 19349663)) & 4095) : y * this.nx + x
        for (let j = this.start[k]!; j < this.start[k + 1]!; j++) {
          const i = this.items[j]!
          if (this.stamp[i] === g) continue
          this.stamp[i] = g
          out.push(i)
        }
      }
    if (out.length > 1) out.sort((p, q) => p - q)
    return out
  }

  /** Nearest hit along a ray within maxT, walking the grid cells the ray crosses. Matches a linear raycast. */
  raycast(ox: number, oy: number, dx: number, dy: number, maxT: number): number {
    const cell = GRID_CELL
    const enter = rayRect(ox, oy, dx, dy, this.boundsRect, maxT)
    if (enter === Infinity) return Infinity
    const g = this.next()
    const px = ox + dx * enter - this.x0
    const py = oy + dy * enter - this.y0
    let cx = Math.max(0, Math.min(this.rawNx - 1, Math.floor(px / cell)))
    let cy = Math.max(0, Math.min(this.rawNy - 1, Math.floor(py / cell)))
    const sx = dx > 0 ? 1 : -1
    const sy = dy > 0 ? 1 : -1
    const ddx = Math.abs(dx) < 1e-12 ? Infinity : cell / Math.abs(dx)
    const ddy = Math.abs(dy) < 1e-12 ? Infinity : cell / Math.abs(dy)
    let tx = ddx === Infinity ? Infinity : enter + ((dx > 0 ? (cx + 1) * cell - px : px - cx * cell) / Math.abs(dx))
    let ty = ddy === Infinity ? Infinity : enter + ((dy > 0 ? (cy + 1) * cell - py : py - cy * cell) / Math.abs(dy))
    let best = maxT
    let hit = false
    for (;;) {
      const k = this.hashed ? ((Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663)) & 4095) : cy * this.nx + cx
      for (let j = this.start[k]!; j < this.start[k + 1]!; j++) {
        const i = this.items[j]!
        if (this.stamp[i] === g) continue
        this.stamp[i] = g
        const t = rayRect(ox, oy, dx, dy, this.rects[i]!, best)
        if (t < best || (t === best && !hit && t !== Infinity)) {
          best = t
          hit = true
        }
      }
      const tn = Math.min(tx, ty)
      if (tn > best || tn > maxT) break
      if (tx < ty) {
        cx += sx
        tx += ddx
      } else {
        cy += sy
        ty += ddy
      }
      if (cx < 0 || cy < 0 || cx >= this.rawNx || cy >= this.rawNy) break
    }
    return hit ? best : Infinity
  }

  private next(): number {
    if (++this.gen > 0xfffffff0) {
      this.gen = 1
      this.stamp.fill(0)
    }
    return this.gen
  }
}

const grids = new WeakMap<readonly Rect[], RectGrid>()

/**
 * The broadphase grid for a rect list, built on first use and cached by array identity, or null for short lists.
 * Lists handed to the hot paths (World.solids, World.blockers) are built once per map and never mutated.
 */
export function gridOf(rects: readonly Rect[]): RectGrid | null {
  if (rects.length < GRID_MIN) return null
  let g = grids.get(rects)
  if (!g || g.rects.length !== rects.length) {
    g = new RectGrid(rects)
    grids.set(rects, g)
  }
  return g
}

/** Nearest hit along a ray within maxT, or Infinity. */
export function raycast(ox: number, oy: number, dx: number, dy: number, rects: readonly Rect[], maxT: number): number {
  const grid = gridOf(rects)
  if (grid) return grid.raycast(ox, oy, dx, dy, maxT)
  let best = maxT
  let hit = false
  for (const r of rects) {
    const t = rayRect(ox, oy, dx, dy, r, best)
    if (t < best || (t === best && !hit && t !== Infinity)) {
      best = t
      hit = true
    }
  }
  return hit ? best : Infinity
}

/** True when nothing blocks the straight segment from a to b. */
export function clearLine(ax: number, ay: number, bx: number, by: number, rects: readonly Rect[]): boolean {
  const dx = bx - ax
  const dy = by - ay
  const len = Math.hypot(dx, dy)
  if (len < 1e-6) return true
  return raycast(ax, ay, dx / len, dy / len, rects, len - 1e-4) === Infinity
}

/** Pushes a circle out of any rectangle it overlaps. Two passes settle corners. */
export function pushOut(p: Vec, radius: number, rects: readonly Rect[]): void {
  const grid = gridOf(rects)
  // Pushes move the body by at most a radius per rect, so a margin of a few radii catches everything it can reach.
  const m = radius * 4 + 0.5
  const near = grid ? grid.query(p.x - m, p.y - m, p.x + m, p.y + m, scratch) : null
  const n = near ? near.length : rects.length
  for (let pass = 0; pass < 2; pass++) {
    for (let k = 0; k < n; k++) {
      const r = rects[near ? near[k]! : k]!
      const cx = Math.max(r[0], Math.min(p.x, r[2]))
      const cy = Math.max(r[1], Math.min(p.y, r[3]))
      const dx = p.x - cx
      const dy = p.y - cy
      const d2 = dx * dx + dy * dy
      if (d2 >= radius * radius) continue
      if (d2 > 1e-12) {
        const d = Math.sqrt(d2)
        p.x += (dx / d) * (radius - d)
        p.y += (dy / d) * (radius - d)
        continue
      }
      const left = p.x - r[0]
      const right = r[2] - p.x
      const up = p.y - r[1]
      const down = r[3] - p.y
      const m = Math.min(left, right, up, down)
      if (m === left) p.x = r[0] - radius
      else if (m === right) p.x = r[2] + radius
      else if (m === up) p.y = r[1] - radius
      else p.y = r[3] + radius
    }
  }
}

const scratch: number[] = []

export function inRect(x: number, y: number, r: Rect, pad = 0): boolean {
  return x >= r[0] - pad && x <= r[2] + pad && y >= r[1] - pad && y <= r[3] + pad
}

export function distToRect(x: number, y: number, r: Rect): number {
  const dx = x < r[0] ? r[0] - x : x > r[2] ? x - r[2] : 0
  const dy = y < r[1] ? r[1] - y : y > r[3] ? y - r[3] : 0
  return dx === 0 ? dy : dy === 0 ? dx : Math.sqrt(dx * dx + dy * dy)
}

export const rectCenter = (r: Rect): Vec => ({ x: (r[0] + r[2]) / 2, y: (r[1] + r[3]) / 2 })

export function angleDiff(a: number, b: number): number {
  let d = a - b
  while (d > Math.PI) d -= Math.PI * 2
  while (d < -Math.PI) d += Math.PI * 2
  return d
}

/** Binary min-heap of integer IDs ordered by numeric key (for A* and Dijkstra searches). */
export class MinHeap {
  private ids: number[] = []
  private keys: number[] = []

  get size(): number {
    return this.ids.length
  }

  clear(): void {
    this.ids.length = 0
    this.keys.length = 0
  }

  peekKey(): number {
    return this.keys[0]!
  }

  push(id: number, key: number): void {
    this.ids.push(id)
    this.keys.push(key)
    let i = this.ids.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (this.keys[p]! <= key) break
      this.swap(i, p)
      i = p
    }
  }

  pop(): number {
    const top = this.ids[0]!
    const lastId = this.ids.pop()!
    const lastKey = this.keys.pop()!
    if (this.ids.length) {
      this.ids[0] = lastId
      this.keys[0] = lastKey
      let i = 0
      for (;;) {
        const l = i * 2 + 1
        const r = l + 1
        let m = i
        if (l < this.ids.length && this.keys[l]! < this.keys[m]!) m = l
        if (r < this.ids.length && this.keys[r]! < this.keys[m]!) m = r
        if (m === i) break
        this.swap(i, m)
        i = m
      }
    }
    return top
  }

  private swap(a: number, b: number): void {
    const tmpId = this.ids[a]!
    this.ids[a] = this.ids[b]!
    this.ids[b] = tmpId
    const tmpKey = this.keys[a]!
    this.keys[a] = this.keys[b]!
    this.keys[b] = tmpKey
  }
}
