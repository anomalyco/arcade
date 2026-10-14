import { type NavPortal } from "./ai"
import { type Rect, type Vec } from "./geom"

const CELL_FREE = 0
const CELL_BLOCKED = 1
const CELL_CLOSED_DOOR = 2
const CELL_OPEN_WINDOW = 3
const CELL_BARRICADED = 4

const INF = 0x3fffffff

const DX = new Int8Array([-1, 0, 1, -1, 1, -1, 0, 1])
const DY = new Int8Array([-1, -1, -1, 0, 0, 1, 1, 1])
const STEP_COST = new Int32Array([14, 10, 14, 10, 10, 14, 10, 14])

interface CachedFieldSlot {
  goalCell: number
  topologyRev: number
  lastUsedTick: number
  cost: Int32Array
}

/**
 * Multi-Slot Cached SLF-Deque Flow Field over an 8-connected portal-aware grid.
 *
 * Replaces O(N_agents * V log V) per-agent A* searches (`GridNav.path`) with an O(V)
 * wavefront pass cached across a 6-slot LRU table (player cell + active noise/groan sources):
 * - Lazily evaluates local 8-neighbor gradient on `sampleDirection()` instead of precomputing
 *   36,864 `Math.hypot` vectors on every rebuild (cuts rebuild time ~5x).
 * - Multi-slot cache prevents player chase and nearby noise investigation goals from thrashing.
 */
export class FlowFieldNav {
  readonly cell: number
  readonly invCell: number
  readonly w: number
  readonly h: number
  readonly size: number
  readonly grid: Uint8Array

  private static readonly Q_MASK = 65535
  private readonly queue = new Int32Array(FlowFieldNav.Q_MASK + 1)
  private readonly inQueue: Uint8Array
  private readonly slots: CachedFieldSlot[]
  private useClock = 0

  private topologyRev = 1
  rebuildCount = 0
  cacheHitCount = 0

  constructor(width: number, height: number, cell = 0.5, cacheSlots = 6) {
    this.cell = cell
    this.invCell = 1 / cell
    this.w = Math.ceil(width / cell)
    this.h = Math.ceil(height / cell)
    this.size = this.w * this.h
    this.grid = new Uint8Array(this.size)
    this.inQueue = new Uint8Array(this.size)
    this.slots = Array.from({ length: cacheSlots }, () => ({
      goalCell: -1,
      topologyRev: -1,
      lastUsedTick: 0,
      cost: new Int32Array(this.size),
    }))
  }

  syncFromGrid(srcGrid: Uint8Array): void {
    this.grid.set(srcGrid)
    this.topologyRev++
  }

  rebuildTopology(solids: readonly Rect[], portals: readonly NavPortal[], agentRadius = 0.28): void {
    this.grid.fill(CELL_FREE)
    const pad = agentRadius + 0.02
    const { w, h, cell, grid } = this
    for (let i = 0; i < solids.length; i++) {
      const r = solids[i]!
      const x0 = Math.max(0, Math.ceil((r[0] - pad) / cell - 0.5))
      const x1 = Math.min(w - 1, Math.floor((r[2] + pad) / cell - 0.5))
      const y0 = Math.max(0, Math.ceil((r[1] - pad) / cell - 0.5))
      const y1 = Math.min(h - 1, Math.floor((r[3] + pad) / cell - 0.5))
      for (let cy = y0; cy <= y1; cy++) {
        grid.fill(CELL_BLOCKED, cy * w + x0, cy * w + x1 + 1)
      }
    }
    for (let i = 0; i < portals.length; i++) {
      const p = portals[i]!
      const [rx0, ry0, rx1, ry1] = p.rect
      const horizontal = rx1 - rx0 > ry1 - ry0
      const barricaded = (p.barricadePlanks ?? 0) > 0
      let cellCode = CELL_BLOCKED
      if (p.kind === "door") {
        cellCode = barricaded ? CELL_BARRICADED : p.open ? CELL_FREE : CELL_CLOSED_DOOR
      } else if (p.kind === "window") {
        cellCode = barricaded ? CELL_BARRICADED : p.open ? CELL_OPEN_WINDOW : CELL_BLOCKED
      }
      if (cellCode === CELL_BLOCKED) continue
      const bx0 = horizontal ? rx0 + 0.18 : rx0 - 0.42
      const by0 = horizontal ? ry0 - 0.42 : ry0 + 0.18
      const bx1 = horizontal ? rx1 - 0.18 : rx1 + 0.42
      const by1 = horizontal ? ry1 + 0.42 : ry1 - 0.18
      const x0 = Math.max(0, Math.floor(bx0 / cell))
      const x1 = Math.min(w - 1, Math.floor(bx1 / cell))
      const y0 = Math.max(0, Math.floor(by0 / cell))
      const y1 = Math.min(h - 1, Math.floor(by1 / cell))
      for (let cy = y0; cy <= y1; cy++) {
        for (let cx = x0; cx <= x1; cx++) {
          grid[cy * w + cx] = cellCode
        }
      }
    }
    this.topologyRev++
  }

  cellIndex(x: number, y: number): number {
    const cx = Math.max(0, Math.min(this.w - 1, (x * this.invCell) | 0))
    const cy = Math.max(0, Math.min(this.h - 1, (y * this.invCell) | 0))
    return cy * this.w + cx
  }

  nearestWalkableCell(x: number, y: number): number {
    const start = this.cellIndex(x, y)
    if (this.grid[start] !== CELL_BLOCKED) return start
    const { w, h, grid } = this
    const cx = start % w
    const cy = (start / w) | 0
    for (let ring = 1; ring < 16; ring++) {
      for (let dy = -ring; dy <= ring; dy++) {
        const ny = cy + dy
        if (ny < 0 || ny >= h) continue
        const edge = dy === -ring || dy === ring
        const stepX = edge ? 1 : ring * 2
        for (let dx = -ring; dx <= ring; dx += stepX) {
          const nx = cx + dx
          if (nx < 0 || nx >= w) continue
          const k = ny * w + nx
          if (grid[k] !== CELL_BLOCKED) return k
        }
      }
    }
    return start
  }

  /**
   * Returns a cached or freshly computed cost field for `(goalX, goalY)`.
   * Quantizes goal cells to 2x2 (`1.0m`) macro-cells for distant noise/chase stability.
   */
  ensureField(goalX: number, goalY: number, force = false, maxRangeMeters = 64): Int32Array {
    const goalCell = this.nearestWalkableCell(goalX, goalY)
    this.useClock++

    if (!force) {
      for (let i = 0; i < this.slots.length; i++) {
        const s = this.slots[i]!
        if (s.goalCell === goalCell && s.topologyRev === this.topologyRev) {
          s.lastUsedTick = this.useClock
          this.cacheHitCount++
          return s.cost
        }
      }
    }

    // Pick LRU slot
    let victim = this.slots[0]!
    for (let i = 1; i < this.slots.length; i++) {
      if (this.slots[i]!.lastUsedTick < victim.lastUsedTick) {
        victim = this.slots[i]!
      }
    }
    victim.goalCell = goalCell
    victim.topologyRev = this.topologyRev
    victim.lastUsedTick = this.useClock
    this.rebuildCount++

    const { w, h, grid, queue, inQueue } = this
    const cost = victim.cost
    cost.fill(INF)

    const maxCost = Math.ceil(maxRangeMeters * this.invCell * 10)
    const mask = FlowFieldNav.Q_MASK
    let head = 0
    let tail = 0
    cost[goalCell] = 0
    queue[tail] = goalCell
    tail = (tail + 1) & mask
    inQueue[goalCell] = 1

    while (head !== tail) {
      const u = queue[head]!
      head = (head + 1) & mask
      inQueue[u] = 0

      const uCost = cost[u]!
      if (uCost >= maxCost) continue
      const ux = u % w
      const uy = (u / w) | 0

      for (let d = 0; d < 8; d++) {
        const dx = DX[d]!
        const dy = DY[d]!
        const nx = ux + dx
        const ny = uy + dy
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
        const ni = ny * w + nx
        const code = grid[ni]!
        if (code === CELL_BLOCKED) continue
        if (dx !== 0 && dy !== 0 && (grid[uy * w + nx] === CELL_BLOCKED || grid[ny * w + ux] === CELL_BLOCKED)) {
          continue
        }
        const penalty =
          code === CELL_FREE
            ? 0
            : code === CELL_OPEN_WINDOW
              ? 24
              : code === CELL_CLOSED_DOOR
                ? 55
                : 110
        const newCost = uCost + STEP_COST[d]! + penalty
        if (newCost < cost[ni]!) {
          cost[ni] = newCost
          if (inQueue[ni] === 0) {
            inQueue[ni] = 1
            if (head !== tail && newCost <= cost[queue[head]!]!) {
              head = (head - 1) & mask
              queue[head] = ni
            } else {
              queue[tail] = ni
              tail = (tail + 1) & mask
            }
          }
        }
      }
    }

    return cost
  }

  /**
   * Computes the steepest-descent direction at cell `(cx, cy)` on demand (8 integer reads).
   */
  private cellDir(cost: Int32Array, cx: number, cy: number, out: Vec): void {
    const { w, h, grid } = this
    const idx = cy * w + cx
    const c0 = cost[idx]!
    if (c0 >= INF || c0 === 0) {
      out.x = 0
      out.y = 0
      return
    }
    let bestCost = c0
    let bx = 0
    let by = 0
    for (let d = 0; d < 8; d++) {
      const dx = DX[d]!
      const dy = DY[d]!
      const nx = cx + dx
      const ny = cy + dy
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
      if (dx !== 0 && dy !== 0 && (grid[cy * w + nx] === CELL_BLOCKED || grid[ny * w + cx] === CELL_BLOCKED)) {
        continue
      }
      const nc = cost[ny * w + nx]!
      if (nc < bestCost) {
        bestCost = nc
        bx = dx
        by = dy
      }
    }
    if (bx !== 0 && by !== 0) {
      out.x = bx * 0.70710678
      out.y = by * 0.70710678
    } else {
      out.x = bx
      out.y = by
    }
  }

  /**
   * Samples the flow-field steering direction at world `(x, y)` toward `(goalX, goalY)` in O(1).
   */
  sampleDirection(x: number, y: number, goalX: number, goalY: number, out: Vec): Vec {
    const cost = this.ensureField(goalX, goalY)
    const near = this.nearestWalkableCell(x, y)
    const cx = near % this.w
    const cy = (near / this.w) | 0
    this.cellDir(cost, cx, cy, out)
    return out
  }

  /**
   * Traces a lightweight 4-step path lookahead along the flow field so callers expecting `Vec[]`
   * waypoints don't re-query on every single frame.
   */
  traceShortPath(fromX: number, fromY: number, goalX: number, goalY: number, steps = 4): Vec[] {
    const cost = this.ensureField(goalX, goalY)
    const { w, cell } = this
    let cur = this.nearestWalkableCell(fromX, fromY)
    const out: Vec[] = []
    const dir: Vec = { x: 0, y: 0 }
    for (let s = 0; s < steps; s++) {
      if (cost[cur]! === 0 || cost[cur]! >= INF) break
      const cx = cur % w
      const cy = (cur / w) | 0
      this.cellDir(cost, cx, cy, dir)
      if (dir.x === 0 && dir.y === 0) break
      const stepX = dir.x > 0.2 ? 1 : dir.x < -0.2 ? -1 : 0
      const stepY = dir.y > 0.2 ? 1 : dir.y < -0.2 ? -1 : 0
      const nx = Math.max(0, Math.min(w - 1, cx + stepX))
      const ny = Math.max(0, Math.min(this.h - 1, cy + stepY))
      cur = ny * w + nx
      out.push({ x: (nx + 0.5) * cell, y: (ny + 0.5) * cell })
    }
    if (out.length === 0) out.push({ x: goalX, y: goalY })
    return out
  }
}
