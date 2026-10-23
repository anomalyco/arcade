// Sea routes for bot helms (server/bot-match.ts): a coarse grid of open water over the play area, baked once per world,
// A* across it and the path pulled tight. A carrier draws ~11 m and is 330 m long, so a cell is open only when water
// deeper than OPEN covers it and its neighbours. Pure and deterministic.

import { type Archipelago, terrainHeight } from "../shared/islands"

/** Water deeper than this (m) is open to a carrier (shared/objective.ts zones use the same). */
export const OPEN = -14
const CELL = 150
const EXTENT = 7800

export type NavGrid = { n: number; x0: number; open: Uint8Array }

const grids = new WeakMap<Archipelago, NavGrid>()

/** The world's grid (baked on first use). */
export function navGrid(arch: Archipelago): NavGrid {
  const had = grids.get(arch)
  if (had) return had
  const n = Math.ceil((EXTENT * 2) / CELL)
  const x0 = -EXTENT
  const wet = new Uint8Array(n * n)
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const x = x0 + (i + 0.5) * CELL
      const z = x0 + (j + 0.5) * CELL
      const h = CELL * 0.45
      wet[j * n + i] = terrainHeight(arch, x, z) < OPEN && terrainHeight(arch, x - h, z - h) < OPEN && terrainHeight(arch, x + h, z - h) < OPEN && terrainHeight(arch, x - h, z + h) < OPEN && terrainHeight(arch, x + h, z + h) < OPEN ? 1 : 0
    }
  // Keep a cell's width of clearance from every shore.
  const open = new Uint8Array(n * n)
  for (let j = 1; j < n - 1; j++)
    for (let i = 1; i < n - 1; i++) {
      let ok = 1
      for (let dj = -1; dj <= 1 && ok; dj++) for (let di = -1; di <= 1; di++) if (!wet[(j + dj) * n + i + di]) ok = 0
      open[j * n + i] = ok
    }
  const g = { n, x0, open }
  grids.set(arch, g)
  return g
}

const cellOf = (g: NavGrid, v: number) => Math.max(0, Math.min(g.n - 1, Math.floor((v - g.x0) / CELL)))
const centre = (g: NavGrid, i: number) => g.x0 + (i + 0.5) * CELL

/** Whether the straight line between two points stays on open cells. */
export function clearLine(g: NavGrid, ax: number, az: number, bx: number, bz: number): boolean {
  const d = Math.hypot(bx - ax, bz - az)
  const steps = Math.ceil(d / (CELL * 0.5))
  for (let k = 1; k < steps; k++) {
    const u = k / steps
    if (!g.open[cellOf(g, az + (bz - az) * u) * g.n + cellOf(g, ax + (bx - ax) * u)]) return false
  }
  return true
}

/** The nearest open cell to (i, j) (itself if open), or -1. */
function nearestOpen(g: NavGrid, i: number, j: number): number {
  for (let r = 0; r < 12; r++)
    for (let dj = -r; dj <= r; dj++)
      for (let di = -r; di <= r; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue
        const ii = i + di
        const jj = j + dj
        if (ii >= 0 && jj >= 0 && ii < g.n && jj < g.n && g.open[jj * g.n + ii]) return jj * g.n + ii
      }
  return -1
}

/**
 * A route of waypoints from (sx, sz) to (gx, gz) over open water, pulled tight (each waypoint the farthest the line
 * of sight reaches), ending at the goal. Empty when no route exists (then steer straight and let the feelers cope).
 */
export function findRoute(g: NavGrid, sx: number, sz: number, gx: number, gz: number): { x: number; z: number }[] {
  const n = g.n
  const start = nearestOpen(g, cellOf(g, sx), cellOf(g, sz))
  const goal = nearestOpen(g, cellOf(g, gx), cellOf(g, gz))
  if (start < 0 || goal < 0) return []
  const cost = new Float32Array(n * n).fill(Infinity)
  const from = new Int32Array(n * n).fill(-1)
  const closed = new Uint8Array(n * n)
  // A binary heap of [f, cell].
  const heap: number[] = []
  const push = (f: number, c: number) => {
    heap.push(f, c)
    let k = heap.length / 2 - 1
    while (k > 0) {
      const p = (k - 1) >> 1
      if (heap[p * 2]! <= heap[k * 2]!) break
      ;[heap[p * 2], heap[k * 2]] = [heap[k * 2]!, heap[p * 2]!]
      ;[heap[p * 2 + 1], heap[k * 2 + 1]] = [heap[k * 2 + 1]!, heap[p * 2 + 1]!]
      k = p
    }
  }
  const pop = (): number => {
    const c = heap[1]!
    const lf = heap.pop()!
    const lf0 = heap.pop()!
    if (heap.length) {
      heap[0] = lf0
      heap[1] = lf
      let k = 0
      const m = heap.length / 2
      for (;;) {
        const l = k * 2 + 1
        const r = l + 1
        let s = k
        if (l < m && heap[l * 2]! < heap[s * 2]!) s = l
        if (r < m && heap[r * 2]! < heap[s * 2]!) s = r
        if (s === k) break
        ;[heap[s * 2], heap[k * 2]] = [heap[k * 2]!, heap[s * 2]!]
        ;[heap[s * 2 + 1], heap[k * 2 + 1]] = [heap[k * 2 + 1]!, heap[s * 2 + 1]!]
        k = s
      }
    }
    return c
  }
  const gi = goal % n
  const gj = Math.floor(goal / n)
  const h = (c: number) => {
    const dx = Math.abs((c % n) - gi)
    const dz = Math.abs(Math.floor(c / n) - gj)
    return Math.max(dx, dz) + 0.4142 * Math.min(dx, dz)
  }
  cost[start] = 0
  push(h(start), start)
  while (heap.length) {
    const c = pop()
    if (closed[c]) continue
    closed[c] = 1
    if (c === goal) break
    const ci = c % n
    const cj = Math.floor(c / n)
    for (let dj = -1; dj <= 1; dj++)
      for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue
        const ii = ci + di
        const jj = cj + dj
        if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue
        const nc = jj * n + ii
        if (!g.open[nc] || closed[nc]) continue
        const step = di && dj ? 1.4142 : 1
        const v = cost[c]! + step
        if (v < cost[nc]!) {
          cost[nc] = v
          from[nc] = c
          push(v + h(nc), nc)
        }
      }
  }
  if (from[goal] < 0 && goal !== start) return []
  const cells: { x: number; z: number }[] = []
  for (let c = goal; c >= 0; c = from[c]!) {
    cells.push({ x: centre(g, c % n), z: centre(g, Math.floor(c / n)) })
    if (c === start) break
  }
  cells.reverse()
  cells[cells.length - 1] = { x: gx, z: gz }
  // Pull it tight: from where we are, jump to the farthest waypoint in sight.
  const out: { x: number; z: number }[] = []
  let ax = sx
  let az = sz
  let k = 0
  while (k < cells.length) {
    let far = k
    for (let m = cells.length - 1; m > k; m--)
      if (clearLine(g, ax, az, cells[m]!.x, cells[m]!.z)) {
        far = m
        break
      }
    out.push(cells[far]!)
    ax = cells[far]!.x
    az = cells[far]!.z
    k = far + 1
  }
  return out
}
