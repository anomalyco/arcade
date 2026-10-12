import { PLAYER_RADIUS } from "../config"
import { type Vec, inRect } from "../geom"
import type { MapDef } from "../maps"
import type { Rng } from "../rng"

const CELL = 0.5
const BLOCKED = 1
const DOOR = 2

/**
 * Walkable grid for bots. Static solids (walls, windows, glass, furniture) are inflated by the player radius; doors are
 * walkable and bots open them on the way. Paths are A* over 8-connected cells, then string-pulled.
 */
export class Nav {
  readonly w: number
  readonly h: number
  readonly grid: Uint8Array
  private free: number[] = []

  constructor(readonly map: MapDef) {
    this.w = Math.ceil(map.size[0] / CELL)
    this.h = Math.ceil(map.size[1] / CELL)
    this.grid = new Uint8Array(this.w * this.h)
    const pad = PLAYER_RADIUS + 0.06
    const solid = [...map.walls.map((w) => w.rect), ...map.windows, ...map.glass.map((g) => g.rect), ...map.props.filter((p) => p.solid).map((p) => p.rect)]
    for (let cy = 0; cy < this.h; cy++)
      for (let cx = 0; cx < this.w; cx++) {
        const x = (cx + 0.5) * CELL
        const y = (cy + 0.5) * CELL
        const i = cy * this.w + cx
        if (solid.some((r) => inRect(x, y, r, pad))) this.grid[i] = BLOCKED
        else if (map.doors.some((d) => inRect(x, y, d.rect, pad))) this.grid[i] = DOOR
        else this.free.push(i)
      }
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
    let best = this.free[0]!
    let bd = Infinity
    for (const f of this.free) {
      const c = this.center(f)
      const d = (c.x - p.x) ** 2 + (c.y - p.y) ** 2
      if (d < bd) {
        bd = d
        best = f
      }
    }
    return this.center(best)
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
    const n = this.w * this.h
    const g = new Float32Array(n).fill(Infinity)
    const came = new Int32Array(n).fill(-1)
    const closed = new Uint8Array(n)
    const heap = new Heap()
    const gx = goal % this.w
    const gy = Math.floor(goal / this.w)
    const h = (i: number) => {
      const dx = Math.abs((i % this.w) - gx)
      const dy = Math.abs(Math.floor(i / this.w) - gy)
      return Math.max(dx, dy) + 0.414 * Math.min(dx, dy)
    }
    g[start] = 0
    heap.push(start, h(start))
    while (heap.size) {
      const cur = heap.pop()
      if (cur === goal) break
      if (closed[cur]) continue
      closed[cur] = 1
      const cx = cur % this.w
      const cy = Math.floor(cur / this.w)
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue
          const nx = cx + dx
          const ny = cy + dy
          if (nx < 0 || ny < 0 || nx >= this.w || ny >= this.h) continue
          const ni = ny * this.w + nx
          if (this.grid[ni] === BLOCKED || closed[ni]) continue
          // No corner cutting.
          if (dx && dy && (this.grid[cy * this.w + nx] === BLOCKED || this.grid[ny * this.w + cx] === BLOCKED)) continue
          const cost = (dx && dy ? 1.414 : 1) * (this.grid[ni] === DOOR ? 1.5 : 1)
          const ng = g[cur]! + cost
          if (ng < g[ni]!) {
            g[ni] = ng
            came[ni] = cur
            heap.push(ni, ng + h(ni))
          }
        }
    }
    if (came[goal] === -1) return null
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
}

class Heap {
  private ids: number[] = []
  private keys: number[] = []

  get size() {
    return this.ids.length
  }

  push(id: number, key: number) {
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

  private swap(a: number, b: number) {
    ;[this.ids[a], this.ids[b]] = [this.ids[b]!, this.ids[a]!]
    ;[this.keys[a], this.keys[b]] = [this.keys[b]!, this.keys[a]!]
  }
}

const cache = new Map<string, Nav>()
export function navFor(map: MapDef): Nav {
  let n = cache.get(map.id)
  if (!n) {
    n = new Nav(map)
    cache.set(map.id, n)
  }
  return n
}
