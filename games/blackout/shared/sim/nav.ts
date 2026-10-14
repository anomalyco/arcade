import { PLAYER_RADIUS } from "../config"
import { MinHeap, type Vec, inRect } from "../geom"
import type { MapDef } from "../maps"
import type { Rng } from "../rng"

const CELL = 0.5
const BLOCKED = 1

/**
 * Walkable grid for bots. Solids (walls, windows, glass, furniture) are inflated by the player radius. Paths are A* over
 * 8-connected cells, then string-pulled.
 */
export class Nav {
  readonly w: number
  readonly h: number
  readonly grid: Uint8Array
  private free: number[] = []
  private g: Float32Array
  private came: Int32Array
  /** A* bookkeeping is valid for a cell when seen[i] >= stamp; closed cells hold stamp + 1. */
  private seen: Uint32Array
  private stamp = 0
  private heap = new MinHeap()

  constructor(readonly map: MapDef) {
    this.w = Math.ceil(map.size[0] / CELL)
    this.h = Math.ceil(map.size[1] / CELL)
    this.grid = new Uint8Array(this.w * this.h)
    const pad = PLAYER_RADIUS + 0.02
    const solid = [...map.walls.map((w) => w.rect), ...map.windows, ...map.glass, ...map.props.filter((p) => p.solid).map((p) => p.rect)]
    // A cell is blocked when its centre lies within `pad` of a solid.
    for (const r of solid) {
      const x0 = Math.max(0, Math.ceil((r[0] - pad) / CELL - 0.5))
      const x1 = Math.min(this.w - 1, Math.floor((r[2] + pad) / CELL - 0.5))
      const y0 = Math.max(0, Math.ceil((r[1] - pad) / CELL - 0.5))
      const y1 = Math.min(this.h - 1, Math.floor((r[3] + pad) / CELL - 0.5))
      for (let cy = y0; cy <= y1; cy++) this.grid.fill(BLOCKED, cy * this.w + x0, cy * this.w + x1 + 1)
    }
    // Outside the building: cells whose centres lie in a void, out to the grid's edge where it meets the map's.
    const [W, H] = map.size
    for (const r of map.voids ?? []) {
      const x0 = r[0] <= 0.01 ? 0 : Math.max(0, Math.ceil(r[0] / CELL - 0.5))
      const x1 = r[2] >= W - 0.01 ? this.w - 1 : Math.min(this.w - 1, Math.floor(r[2] / CELL - 0.5))
      const y0 = r[1] <= 0.01 ? 0 : Math.max(0, Math.ceil(r[1] / CELL - 0.5))
      const y1 = r[3] >= H - 0.01 ? this.h - 1 : Math.min(this.h - 1, Math.floor(r[3] / CELL - 0.5))
      for (let cy = y0; cy <= y1; cy++) this.grid.fill(BLOCKED, cy * this.w + x0, cy * this.w + x1 + 1)
    }
    for (let i = 0; i < this.grid.length; i++) if (this.grid[i] !== BLOCKED) this.free.push(i)
    const n = this.w * this.h
    this.g = new Float32Array(n)
    this.came = new Int32Array(n)
    this.seen = new Uint32Array(n)
  }

  private idx(p: Vec): number {
    const cx = Math.max(0, Math.min(this.w - 1, Math.floor(p.x / CELL)))
    const cy = Math.max(0, Math.min(this.h - 1, Math.floor(p.y / CELL)))
    return cy * this.w + cx
  }

  private center(i: number): Vec {
    return { x: ((i % this.w) + 0.5) * CELL, y: (Math.floor(i / this.w) + 0.5) * CELL }
  }

  walkable(p: Vec): boolean {
    return this.grid[this.idx(p)] !== BLOCKED
  }

  /** Nearest walkable cell centre to p. */
  nearest(p: Vec): Vec {
    const i = this.idx(p)
    if (this.grid[i] !== BLOCKED) return p
    const cx = i % this.w
    const cy = Math.floor(i / this.w)
    let best = -1
    let bd = Infinity
    // Grow square rings until the best hit so far can't be beaten by a farther ring.
    for (let ring = 1; ring < Math.max(this.w, this.h); ring++) {
      if (best >= 0 && (ring - 1) * CELL > Math.sqrt(bd)) break
      for (let y = cy - ring; y <= cy + ring; y++) {
        if (y < 0 || y >= this.h) continue
        const edge = y === cy - ring || y === cy + ring
        for (let x = cx - ring; x <= cx + ring; x += edge ? 1 : ring * 2) {
          if (x < 0 || x >= this.w) continue
          const k = y * this.w + x
          if (this.grid[k] === BLOCKED) continue
          const c = this.center(k)
          const d = (c.x - p.x) ** 2 + (c.y - p.y) ** 2
          if (d < bd) {
            bd = d
            best = k
          }
        }
      }
    }
    return best >= 0 ? this.center(best) : p
  }

  /** Cells reachable on foot from p, as a mask over the grid. */
  reachable(p: Vec): Uint8Array {
    const seen = new Uint8Array(this.w * this.h)
    const start = this.idx(this.nearest(p))
    const queue = [start]
    seen[start] = 1
    while (queue.length) {
      const c = queue.pop()!
      const cx = c % this.w
      const cy = Math.floor(c / this.w)
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = cx + dx
        const ny = cy + dy
        if (nx < 0 || ny < 0 || nx >= this.w || ny >= this.h) continue
        const n = ny * this.w + nx
        if (seen[n] || this.grid[n] === BLOCKED) continue
        seen[n] = 1
        queue.push(n)
      }
    }
    return seen
  }

  /** Whether p is in a cell marked in a mask from reachable(). */
  inMask(mask: Uint8Array, p: Vec): boolean {
    return mask[this.idx(p)] === 1
  }

  randomFree(rng: Rng): Vec {
    return this.center(this.free[rng.int(this.free.length)]!)
  }

  /** True when a body can walk straight from a to b. */
  straight(a: Vec, b: Vec): boolean {
    const d = Math.hypot(b.x - a.x, b.y - a.y)
    const n = Math.ceil(d / (CELL * 0.4))
    for (let k = 1; k <= n; k++) {
      const t = k / n
      if (this.grid[this.idx({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })] === BLOCKED) return false
    }
    return true
  }

  path(from: Vec, to: Vec): Vec[] | null {
    const start = this.idx(this.nearest(from))
    const goal = this.idx(this.nearest(to))
    if (start === goal) return [to]
    if (this.stamp > 0xfffffff0) {
      this.stamp = 0
      this.seen.fill(0)
    }
    const open = (this.stamp += 2)
    const shut = open + 1
    const { g, came, seen, grid, w } = this
    const heap = this.heap
    heap.clear()
    const gx = goal % w
    const gy = Math.floor(goal / w)
    const h = (i: number) => {
      const dx = Math.abs((i % w) - gx)
      const dy = Math.abs(Math.floor(i / w) - gy)
      return Math.max(dx, dy) + 0.414 * Math.min(dx, dy)
    }
    g[start] = 0
    came[start] = -1
    seen[start] = open
    heap.push(start, h(start))
    let found = false
    while (heap.size) {
      const cur = heap.pop()
      if (cur === goal) {
        found = true
        break
      }
      if (seen[cur] === shut) continue
      seen[cur] = shut
      const cx = cur % w
      const cy = Math.floor(cur / w)
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue
          const nx = cx + dx
          const ny = cy + dy
          if (nx < 0 || ny < 0 || nx >= w || ny >= this.h) continue
          const ni = ny * w + nx
          if (grid[ni] === BLOCKED || seen[ni] === shut) continue
          // No corner cutting.
          if (dx && dy && (grid[cy * w + nx] === BLOCKED || grid[ny * w + cx] === BLOCKED)) continue
          const ng = g[cur]! + (dx && dy ? 1.414 : 1)
          if (seen[ni] !== open || ng < g[ni]!) {
            seen[ni] = open
            g[ni] = ng
            came[ni] = cur
            heap.push(ni, ng + h(ni))
          }
        }
    }
    if (!found) return null
    const cells: Vec[] = []
    for (let c = goal; c !== start && c !== -1; c = came[c]!) cells.push(this.center(c))
    cells.reverse()
    cells[cells.length - 1] = this.walkable(to) ? to : cells[cells.length - 1]!
    const out: Vec[] = []
    let anchor = from
    for (let i = 0; i < cells.length; i++) {
      const next = cells[i + 1]
      if (next && this.straight(anchor, next)) continue
      out.push(cells[i]!)
      anchor = cells[i]!
    }
    return out
  }

  /** Walking distance in metres along the grid from p to every cell (Infinity where unreachable). */
  distances(p: Vec): Float32Array {
    const d = new Float32Array(this.w * this.h).fill(Infinity)
    const start = this.idx(this.nearest(p))
    d[start] = 0
    const queue = new Int32Array(this.w * this.h)
    let head = 0
    let tail = 0
    queue[tail++] = start
    while (head < tail) {
      const c = queue[head++]!
      const cx = c % this.w
      const cy = Math.floor(c / this.w)
      for (let k = 0; k < 4; k++) {
        const nx = cx + (k === 0 ? 1 : k === 1 ? -1 : 0)
        const ny = cy + (k === 2 ? 1 : k === 3 ? -1 : 0)
        if (nx < 0 || ny < 0 || nx >= this.w || ny >= this.h) continue
        const n = ny * this.w + nx
        if (this.grid[n] === BLOCKED || d[n] !== Infinity) continue
        d[n] = d[c]! + CELL
        queue[tail++] = n
      }
    }
    return d
  }

  /** Cell index of a point, for indexing masks and distance fields. */
  cellOf(p: Vec): number {
    return this.idx(p)
  }
}

const cache = new Map<string, Nav>()
/** Nav grids for the few most recent maps. */
export function navFor(map: MapDef): Nav {
  let n = cache.get(map.id)
  if (!n) {
    n = new Nav(map)
    cache.set(map.id, n)
    if (cache.size > 4) cache.delete(cache.keys().next().value!)
  }
  return n
}
