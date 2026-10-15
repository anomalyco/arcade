import { CELL_BARRICADED, CELL_BLOCKED, CELL_CLOSED_DOOR, CELL_FREE, CELL_OPEN_WINDOW, type GridNav } from "./ai"
import type { Vec } from "./geom"

/** Unreachable (or beyond the field's window) in a `FlowField` cost table. */
export const FLOW_UNREACHED = 0xffff

const MAX_COST = 0xfff0
const STEP = 10
const DIAG = 14
/** Extra cost of entering a cell, in tenths of a cell: the same weights as `GridNav.path` (5.5, 2.4, 11 cells). */
const PENALTY = new Uint8Array([0, 0, 55, 24, 110])
const BUCKETS = 128

const DX = new Int8Array([1, -1, 0, 0, 1, -1, 1, -1])
const DY = new Int8Array([0, 0, 1, -1, 1, -1, -1, 1])

export type FlowFieldOptions = {
  /** Half-size of each field's square window in cells (default 112: a 112 m square at 0.5 m cells). */
  radiusCells?: number
  /**
   * Goal quantum in cells near a target anchor; goals in the same quantum share one field (default 4: 2 m at 0.5 m
   * cells). It doubles for goals 12 m or more from every anchor and doubles again past 30 m: far goals (perimeter
   * prowling, old last-known positions) need less precision, and the last metres are walked on the agent's own A*.
   */
  quantumCells?: number
  /** Goals within this many metres of a moving target's anchor use the anchor's field (default 3). */
  anchorSnap?: number
  /** A target's anchor follows it once it strays this many metres (default 1.5). */
  anchorStep?: number
  /** Cached fields kept across ticks (least recently used is reused). */
  slots?: number
  /** Distinct goals a tick may ask for; later goals wait a tick. Bounds the worst-case build cost per tick. */
  maxGoalsPerTick?: number
}

/**
 * Integer shortest-path cost to one goal over a square window of the nav grid, stitched from the flat grid or the
 * streaming chunk tiles. Costs are tenths of a cell (10 straight, 14 diagonal) plus portal penalties, so a field is
 * a pure function of the goal quantum and the walkable cells: rebuilding it always gives the same numbers.
 */
export class FlowField {
  key = 0
  revision = -1
  lastUsed = 0
  /** Global cell of the window's first column/row and the window size. */
  gx0 = 0
  gy0 = 0
  readonly size: number
  /** Seed cell (cost 0) in global cells, or -1 on a goal with no walkable cell nearby. */
  seedGx = 0
  seedGy = 0
  readonly codes: Uint8Array
  readonly cost: Uint16Array
  builds = 0

  constructor(readonly cell: number, readonly radius: number) {
    this.size = radius * 2
    this.codes = new Uint8Array(this.size * this.size)
    this.cost = new Uint16Array(this.size * this.size)
  }

  /** Cost at global cell `(gx, gy)`, or `FLOW_UNREACHED` outside the window or where no path exists. */
  costAtCell(gx: number, gy: number): number {
    const lx = gx - this.gx0
    const ly = gy - this.gy0
    if (lx < 0 || ly < 0 || lx >= this.size || ly >= this.size) return FLOW_UNREACHED
    return this.cost[ly * this.size + lx]!
  }

  costAt(x: number, y: number): number {
    return this.costAtCell(Math.floor(x / this.cell), Math.floor(y / this.cell))
  }

  /** Lowest-cost neighbour of local cell `i` (same corner rule as A*), or -1 at the goal or a dead end. */
  private downhill(i: number): number {
    const { size, codes, cost } = this
    const c0 = cost[i]!
    if (c0 === 0 || c0 === FLOW_UNREACHED) return -1
    const x = i % size
    const y = (i / size) | 0
    let best = -1
    let bestCost = c0
    for (let d = 0; d < 8; d++) {
      const nx = x + DX[d]!
      const ny = y + DY[d]!
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue
      if (d >= 4 && (codes[y * size + nx] === CELL_BLOCKED || codes[ny * size + x] === CELL_BLOCKED)) continue
      const n = ny * size + nx
      const c = cost[n]!
      if (c < bestCost) {
        bestCost = c
        best = n
      }
    }
    return best
  }

  /**
   * Walks downhill from `(x, y)` for up to `maxCells` cells and writes the farthest cell centre that `clear` accepts
   * from the start into `out`. Stops early at a portal cell (doors and windows are walked to, never cut across).
   * Returns false when `(x, y)` is outside the field or has no way down.
   */
  waypoint(x: number, y: number, maxCells: number, clear: (tx: number, ty: number) => boolean, out: Vec): boolean {
    const { size, cell } = this
    let lx = Math.floor(x / cell) - this.gx0
    let ly = Math.floor(y / cell) - this.gy0
    if (lx < 0 || ly < 0 || lx >= size || ly >= size) return false
    let i = ly * size + lx
    if (this.cost[i] === FLOW_UNREACHED) {
      // Pushed into a wall-padding cell: start from the cheapest walkable neighbour.
      let best = -1
      let bestCost = FLOW_UNREACHED
      for (let d = 0; d < 8; d++) {
        const nx = lx + DX[d]!
        const ny = ly + DY[d]!
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue
        const c = this.cost[ny * size + nx]!
        if (c < bestCost) {
          bestCost = c
          best = ny * size + nx
        }
      }
      if (best < 0) return false
      i = best
      lx = i % size
      ly = (i / size) | 0
      out.x = (this.gx0 + lx + 0.5) * cell
      out.y = (this.gy0 + ly + 0.5) * cell
      return true
    }
    const trail = waypointTrail
    let n = 0
    let cur = i
    const steps = Math.min(maxCells, trail.length)
    for (let s = 0; s < steps; s++) {
      const next = this.downhill(cur)
      if (next < 0) break
      trail[n++] = next
      cur = next
      if (this.codes[next] !== CELL_FREE) break
    }
    if (n === 0) return false
    // Farthest clear cell first, halving back toward the first step (which is always adjacent and taken as-is).
    let pick = 0
    for (let k = n - 1; k > 0; k = k >> 1) {
      const c = trail[k]!
      const tx = (this.gx0 + (c % size) + 0.5) * cell
      const ty = (this.gy0 + ((c / size) | 0) + 0.5) * cell
      if (clear(tx, ty)) {
        pick = k
        break
      }
    }
    const c = trail[pick]!
    out.x = (this.gx0 + (c % size) + 0.5) * cell
    out.y = (this.gy0 + ((c / size) | 0) + 0.5) * cell
    return true
  }

  /** Unit downhill direction at world `(x, y)` (zero at the goal, outside the window or on a dead end). */
  direction(x: number, y: number, out: Vec): Vec {
    out.x = 0
    out.y = 0
    const lx = Math.floor(x / this.cell) - this.gx0
    const ly = Math.floor(y / this.cell) - this.gy0
    if (lx < 0 || ly < 0 || lx >= this.size || ly >= this.size) return out
    const i = ly * this.size + lx
    const n = this.downhill(i)
    if (n < 0) return out
    const dx = (n % this.size) - lx
    const dy = ((n / this.size) | 0) - ly
    const len = Math.hypot(dx, dy)
    out.x = dx / len
    out.y = dy / len
    return out
  }
}

const waypointTrail = new Int32Array(64)
/** Past anchor positions remembered per target. */
const ANCHOR_TRAIL = 6

/**
 * Shared flow fields for a crowd: one integer cost field per goal quantum, built by Dial's bucket queue over a window
 * of the nav grid and reused by every agent heading the same way until the walkable cells change (`GridNav.revision`).
 *
 * Determinism: what an agent gets never depends on what is cached. Fields are pure functions of goal and grid, and the
 * per-tick goal budget counts distinct goals asked for (cached or not), so a restored simulation replays bit for bit.
 */
export type FlowAnchor = { id: string; x: number; y: number }

export class FlowFieldCache {
  readonly radius: number
  readonly quantum: number
  readonly maxGoalsPerTick: number
  readonly anchorSnap: number
  readonly anchorStep: number
  /**
   * One anchor per moving target (survivor): the goal its hunters share. It only moves once the target strays
   * `anchorStep`, so a running survivor costs a field every couple of metres instead of one per agent per cell.
   * Anchors are simulation state: snapshot and restore them with the crowd.
   */
  anchors: FlowAnchor[] = []
  private readonly fields: FlowField[]
  private readonly tickKeys: number[] = []
  private readonly tickFields: FlowField[] = []
  private clock = 0
  private entryNode = new Int32Array(1 << 16)
  private entryNext = new Int32Array(1 << 16)
  private readonly bucketHead = new Int32Array(BUCKETS)
  /** Fields built since construction (cache misses), for benchmarks and the Lab readout. */
  builds = 0
  /** Requests answered from cache. */
  hits = 0
  /** Requests refused because the tick's goal budget was spent. */
  deferred = 0

  constructor(readonly nav: GridNav, options: FlowFieldOptions = {}) {
    this.radius = options.radiusCells ?? 112
    this.quantum = Math.max(1, options.quantumCells ?? 4)
    this.maxGoalsPerTick = options.maxGoalsPerTick ?? 3
    this.anchorSnap = options.anchorSnap ?? 3
    this.anchorStep = options.anchorStep ?? 1.5
    this.fields = Array.from({ length: options.slots ?? 12 }, () => new FlowField(nav.cell, this.radius))
  }

  /**
   * Starts a simulation tick: resets the per-tick goal budget and moves target anchors that fell behind. A moved
   * anchor leaves a trail of its last few positions, which is where hunters' last-known positions cluster.
   */
  beginTick(targets?: readonly { id: string; x: number; y: number }[]): void {
    this.tickKeys.length = 0
    this.tickFields.length = 0
    if (!targets) return
    const next: FlowAnchor[] = []
    for (const t of targets) {
      const prev = this.anchors.find((a) => a.id === t.id)
      if (prev && Math.hypot(t.x - prev.x, t.y - prev.y) < this.anchorStep) {
        next.push(prev)
        for (const a of this.anchors) if (a.id.startsWith(`${t.id}~`)) next.push(a)
        continue
      }
      next.push({ id: t.id, x: t.x, y: t.y })
      if (prev) next.push({ id: `${t.id}~1`, x: prev.x, y: prev.y })
      for (let k = 1; k < ANCHOR_TRAIL; k++) {
        const old = this.anchors.find((a) => a.id === `${t.id}~${k}`)
        if (old) next.push({ id: `${t.id}~${k + 1}`, x: old.x, y: old.y })
      }
    }
    this.anchors = next
  }

  /** Cached fields that are valid for the current grid (for overlays). */
  activeFields(): readonly FlowField[] {
    return this.fields.filter((f) => f.revision === this.nav.revision)
  }

  /** Quantum (cells) for a goal at world `(x, y)`: finer near target anchors. */
  quantumAt(x: number, y: number): number {
    let d2 = Infinity
    for (const a of this.anchors) d2 = Math.min(d2, (x - a.x) * (x - a.x) + (y - a.y) * (y - a.y))
    return d2 < 12 * 12 || this.anchors.length === 0 ? this.quantum : d2 < 30 * 30 ? this.quantum * 2 : this.quantum * 4
  }

  /** Goal quantum key for world `(x, y)` with quantum `q` cells. */
  keyOf(x: number, y: number, q = this.quantumAt(x, y)): number {
    const qx = Math.floor(Math.floor(x / this.nav.cell) / q)
    const qy = Math.floor(Math.floor(y / this.nav.cell) / q)
    return q * 0x100000000 + ((((qx & 0xffff) << 16) | (qy & 0xffff)) >>> 0)
  }

  /**
   * The field leading to the goal quantum containing `(x, y)`, or null when this tick's goal budget is spent
   * (the caller keeps its current heading and asks again next tick).
   */
  field(x: number, y: number): FlowField | null {
    const snap2 = this.anchorSnap * this.anchorSnap
    for (const a of this.anchors) {
      const dx = x - a.x
      const dy = y - a.y
      if (dx * dx + dy * dy <= snap2) {
        x = a.x
        y = a.y
        break
      }
    }
    const q = this.quantumAt(x, y)
    const key = this.keyOf(x, y, q)
    const keys = this.tickKeys
    for (let i = 0; i < keys.length; i++) if (keys[i] === key) return this.tickFields[i]!
    if (keys.length >= this.maxGoalsPerTick) {
      this.deferred++
      return null
    }
    const f = this.lookup(key, q, x, y)
    keys.push(key)
    this.tickFields.push(f)
    return f
  }

  private lookup(key: number, q: number, x: number, y: number): FlowField {
    const rev = this.nav.revision
    this.clock++
    let victim = this.fields[0]!
    for (const f of this.fields) {
      if (f.key === key && f.revision === rev) {
        f.lastUsed = this.clock
        this.hits++
        return f
      }
      // Prefer a field from an older grid, then the least recently used.
      const fStale = f.revision !== rev
      const vStale = victim.revision !== rev
      if (fStale !== vStale ? fStale : f.lastUsed < victim.lastUsed) victim = f
    }
    this.build(victim, key, q, x, y)
    victim.lastUsed = this.clock
    return victim
  }

  private build(f: FlowField, key: number, q: number, x: number, y: number): void {
    this.builds++
    f.builds++
    f.key = key
    f.revision = this.nav.revision
    const cell = this.nav.cell
    const qx = Math.floor(Math.floor(x / cell) / q)
    const qy = Math.floor(Math.floor(y / cell) / q)
    const cgx = qx * q + (q >> 1)
    const cgy = qy * q + (q >> 1)
    const size = f.size
    f.gx0 = cgx - this.radius
    f.gy0 = cgy - this.radius
    const { codes, cost } = f
    this.nav.copyCodes(f.gx0, f.gy0, size, size, codes)
    cost.fill(FLOW_UNREACHED)

    // Seed: the walkable cell nearest the quantum centre (a pure function of the key and the grid).
    const lcx = cgx - f.gx0
    const lcy = cgy - f.gy0
    let seed = -1
    for (let ring = 0; ring < 24 && seed < 0; ring++) {
      let bestD = Infinity
      for (let yy = lcy - ring; yy <= lcy + ring; yy++) {
        if (yy < 0 || yy >= size) continue
        const edge = yy === lcy - ring || yy === lcy + ring
        for (let xx = lcx - ring; xx <= lcx + ring; xx += edge || ring === 0 ? 1 : ring * 2) {
          if (xx < 0 || xx >= size) continue
          if (codes[yy * size + xx] === CELL_BLOCKED) continue
          const d = (xx - lcx) * (xx - lcx) + (yy - lcy) * (yy - lcy)
          if (d < bestD) {
            bestD = d
            seed = yy * size + xx
          }
        }
      }
    }
    if (seed < 0) {
      f.seedGx = -1
      f.seedGy = -1
      return
    }
    f.seedGx = f.gx0 + (seed % size)
    f.seedGy = f.gy0 + ((seed / size) | 0)

    // Dial's algorithm: integer costs with edges under BUCKETS, so a circular bucket queue pops cells in cost order.
    // The window's border ring is walled off so the inner loop needs no bounds checks.
    const last = size - 1
    codes.fill(CELL_BLOCKED, 0, size)
    codes.fill(CELL_BLOCKED, last * size, size * size)
    for (let yy = 1; yy < last; yy++) {
      codes[yy * size] = CELL_BLOCKED
      codes[yy * size + last] = CELL_BLOCKED
    }
    if (codes[seed] === CELL_BLOCKED) {
      f.seedGx = -1
      f.seedGy = -1
      return
    }
    const head = this.bucketHead
    head.fill(-1)
    const capacity = size * size * 8
    if (this.entryNode.length < capacity) {
      this.entryNode = new Int32Array(capacity)
      this.entryNext = new Int32Array(capacity)
    }
    const nodes = this.entryNode
    const nexts = this.entryNext
    let top = 0
    let pending = 1
    cost[seed] = 0
    nodes[0] = seed
    nexts[0] = -1
    head[0] = top++
    for (let cur = 0; pending > 0; cur++) {
      const b = cur & (BUCKETS - 1)
      while (head[b] !== -1) {
        const e = head[b]!
        head[b] = nexts[e]!
        pending--
        const u = nodes[e]!
        if (cost[u] !== cur) continue
        for (let d = 0; d < 8; d++) {
          const ox = DX[d]!
          const oy = DY[d]!
          const n = u + ox + oy * size
          const code = codes[n]!
          if (code === CELL_BLOCKED) continue
          if (d >= 4 && (codes[u + ox] === CELL_BLOCKED || codes[u + oy * size] === CELL_BLOCKED)) continue
          const nc = cur + (d >= 4 ? DIAG : STEP) + PENALTY[code]!
          if (nc < cost[n]! && nc <= MAX_COST && top < capacity) {
            cost[n] = nc
            const nb = nc & (BUCKETS - 1)
            nodes[top] = n
            nexts[top] = head[nb]!
            head[nb] = top++
            pending++
          }
        }
      }
    }
  }
}

export { CELL_BARRICADED, CELL_BLOCKED, CELL_CLOSED_DOOR, CELL_FREE, CELL_OPEN_WINDOW }
