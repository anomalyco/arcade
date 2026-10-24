import type { Box, Floor, WorldContext } from "../../world/context"
import type { DoorHandle } from "../../world/doors"
import { BUILDING, CORE, storeyY } from "../../world/layout"
import { ST } from "../../world/interior/core"
import { interiorRooms } from "../../world/interior/registry"
import { heightAt } from "../../world/height"
import type { Rect } from "../../world/interior/plan"

// The hunter's navigation over the real building, derived (never hand-placed) from what the world registered:
//  - one occupancy grid per storey (0.25 m cells over the main block and the core tower): walkable where a floor slab at
//    that storey's height covers the cell and no collider between knee and head height comes within the creature's
//    clearance (0.3 m); the moving lift car is left out; locked doors are walls;
//  - doorways: every door leaf of the shared door system (`ctx.doors`) marks the cells of its closed opening, so a route
//    knows which doors it crosses (and the hunter opens them);
//  - stairs: the core stair's flights (core.ts `ST`) link each storey's landing to the next as stair waypoints;
//  - rooms: the interior registry's rooms (`interiorRooms`), each with a probe point inside and "hiding-spot-like"
//    cells next to furniture and walls, plus its doors.
// Routes are A* over a storey's grid (cells near walls cost a little more, so paths keep off them), string-pulled to
// straight segments, chained across storeys through the stair. Line-of-sight and wall counts ray-test the colliders
// (hashed in 2 m buckets) and the door leaves at their current pose.

export const CELL = 0.25
/** The grid: the main block and the core tower, plus (ground floor only) a strip west of the building and the dock
 *  court north of it, out to the motor-pool shed (the escape: src/game/escape/places.ts `SHED`). */
const X0 = -60
const X1 = 34.65
const Z0 = -46
const Z1 = 25.0
export const NX = Math.ceil((X1 - X0) / CELL)
export const NZ = Math.ceil((Z1 - Z0) / CELL)
const N = NX * NZ
/** Creature clearance (m): colliders are grown by this much. */
const R = 0.3
export const STOREYS = BUILDING.main.storeys
/** Body band (above the storey floor) whose colliders block walking. */
const KNEE = 0.42
const HEAD = 1.7
const BUCKET = 2

/** The door system's leaf internals the hunter reads (public fields of `Door` in world/doors.ts). */
export type DoorInternals = DoorHandle & {
  readonly hx: number
  readonly hy: number
  readonly hz: number
  readonly yaw0: number
  readonly xa: number
  readonly xb: number
  readonly height: number
  readonly spec: { double?: string; slide?: unknown; sound?: string }
  readonly driven?: boolean
  ray(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): number
}

export type NavDoor = {
  index: number
  id: string
  h: DoorInternals
  s: number
  /** Closed opening: segment a → b, its centre and unit normal. */
  ax: number
  az: number
  bx: number
  bz: number
  cx: number
  cz: number
  nx: number
  nz: number
  sound: string
  partner: number
}

export type NavRoom = { key: string; id: string; name: string; s: number; rect: Rect; px: number; pz: number; doors: number[]; spots: [number, number][] }

export type StoreyGrid = {
  s: number
  /** World y of the finished floor. */
  y: number
  walk: Uint8Array
  /** Door index whose opening the cell is in, or -1. */
  door: Int16Array
  comp: Int32Array
  /** Cells to the nearest blocked cell (0 blocked … 4+). */
  clear: Uint8Array
  /** The component reachable from the stair (the building). */
  main: number
}

export type Waypoint = { x: number; z: number; s: number; stair?: boolean }
export type Route = { pts: Waypoint[]; cum: number[]; length: number; doors: { door: number; along: number }[] }

export const cellX = (ix: number) => X0 + (ix + 0.5) * CELL
export const cellZ = (iz: number) => Z0 + (iz + 0.5) * CELL
const ixOf = (x: number) => Math.floor((x - X0) / CELL)
const izOf = (z: number) => Math.floor((z - Z0) / CELL)
export const inGrid = (x: number, z: number) => x > X0 && x < X1 && z > Z0 && z < Z1
export const GRID = { X0, X1, Z0, Z1, NX, NZ }

/** Storey of a world height (feet). */
export const storeyOf = (y: number) => Math.max(0, Math.min(STOREYS - 1, Math.round((y - BUILDING.floorY) / BUILDING.main.storeyHeight)))

const bkey = (bx: number, bz: number) => (bx + 1000) * 4096 + (bz + 1000)

export class NavGraph {
  readonly grids: StoreyGrid[] = []
  readonly doors: NavDoor[] = []
  readonly rooms: NavRoom[] = []
  /** Stair waypoints from storey s up to s + 1 (first on storey s, last on s + 1). */
  readonly stairs: Waypoint[][] = []
  /** Lift lobby and stair landing per storey (ambush spots). */
  readonly chokepoints: Waypoint[] = []
  readonly buildMs: number
  private floorHash = new Map<number, Floor[]>()
  private boxHash = new Map<number, number[]>()
  private boxes: readonly Box[]
  private stamp: Uint32Array
  private gen = 1
  // A* scratch.
  private g = new Float32Array(N)
  private parent = new Int32Array(N)
  private seen = new Uint32Array(N)
  private closed = new Uint32Array(N)
  private search = 1
  private heapI = new Int32Array(N)
  private heapF = new Float32Array(N)

  constructor(private ctx: WorldContext) {
    const t0 = performance.now()
    this.boxes = ctx.colliders
    this.stamp = new Uint32Array(ctx.colliders.length)
    for (const f of ctx.floors) {
      for (let bx = Math.floor(f.min[0] / BUCKET); bx <= Math.floor(f.max[0] / BUCKET); bx++)
        for (let bz = Math.floor(f.min[1] / BUCKET); bz <= Math.floor(f.max[1] / BUCKET); bz++) {
          const k = bkey(bx, bz)
          let l = this.floorHash.get(k)
          if (!l) this.floorHash.set(k, (l = []))
          l.push(f)
        }
    }
    ctx.colliders.forEach((b, i) => {
      // Huge boxes (terrain skirts, whole-building volumes) would fill every bucket: they're never between two
      // points inside the building that matter here, except the shell walls, which are long but thin.
      if ((b.max[0] - b.min[0]) * (b.max[2] - b.min[2]) > 4000) return
      for (let bx = Math.floor(b.min[0] / BUCKET); bx <= Math.floor(b.max[0] / BUCKET); bx++)
        for (let bz = Math.floor(b.min[2] / BUCKET); bz <= Math.floor(b.max[2] / BUCKET); bz++) {
          const k = bkey(bx, bz)
          let l = this.boxHash.get(k)
          if (!l) this.boxHash.set(k, (l = []))
          l.push(i)
        }
    })
    this.collectDoors()
    for (let s = 0; s < STOREYS; s++) this.grids.push(this.buildGrid(s))
    this.buildStairs()
    for (const g of this.grids) this.components(g)
    this.buildRooms()
    this.buildMs = performance.now() - t0
  }

  // ------------------------------------------------------------------------------------------------- build

  refreshStoreys(storeys: Iterable<number>) {
    for (const s of storeys) { this.grids[s] = this.buildGrid(s); this.components(this.grids[s]!) }
    this.rooms.length = 0
    this.buildRooms()
  }

  private collectDoors() {
    const all = this.ctx.doors.all() as readonly DoorInternals[]
    for (const h of all) {
      if (h.spec.slide || h.height < 1.2) continue
      const s = storeyOf(h.hy)
      if (Math.abs(h.hy - storeyY(s)) > 0.5) continue
      const c = Math.cos(h.yaw0)
      const sn = Math.sin(h.yaw0)
      const ax = h.hx + h.xa * c
      const az = h.hz - h.xa * sn
      const bx = h.hx + h.xb * c
      const bz = h.hz - h.xb * sn
      const cx = (ax + bx) / 2
      const cz = (az + bz) / 2
      if (!inGrid(cx, cz)) continue
      this.doors.push({ index: this.doors.length, id: h.id, h, s, ax, az, bx, bz, cx, cz, nx: sn, nz: c, sound: h.spec.sound ?? "steel", partner: -1 })
    }
    const byId = new Map(this.doors.map((d) => [d.id, d]))
    for (const d of this.doors) d.partner = d.h.spec.double ? (byId.get(d.h.spec.double)?.index ?? -1) : -1
  }

  private fill(arr: Uint8Array, x0: number, z0: number, x1: number, z1: number, v: number) {
    const i0 = Math.max(0, Math.ceil((x0 - X0) / CELL - 0.5))
    const i1 = Math.min(NX - 1, Math.floor((x1 - X0) / CELL - 0.5))
    const k0 = Math.max(0, Math.ceil((z0 - Z0) / CELL - 0.5))
    const k1 = Math.min(NZ - 1, Math.floor((z1 - Z0) / CELL - 0.5))
    for (let k = k0; k <= k1; k++) arr.fill(v, k * NX + i0, k * NX + i1 + 1)
  }

  /** Cells whose centre is within `w` of segment a–b (and within its length, ± `ext`). */
  private segCells(ax: number, az: number, bx: number, bz: number, w: number, ext: number, fn: (i: number) => void) {
    const dx = bx - ax
    const dz = bz - az
    const len = Math.hypot(dx, dz) || 1
    const ux = dx / len
    const uz = dz / len
    const i0 = Math.max(0, ixOf(Math.min(ax, bx) - w - ext))
    const i1 = Math.min(NX - 1, ixOf(Math.max(ax, bx) + w + ext))
    const k0 = Math.max(0, izOf(Math.min(az, bz) - w - ext))
    const k1 = Math.min(NZ - 1, izOf(Math.max(az, bz) + w + ext))
    for (let k = k0; k <= k1; k++)
      for (let i = i0; i <= i1; i++) {
        const px = cellX(i) - ax
        const pz = cellZ(k) - az
        const u = px * ux + pz * uz
        if (u < -ext || u > len + ext) continue
        if (Math.abs(-px * uz + pz * ux) <= w) fn(k * NX + i)
      }
  }

  private buildGrid(s: number): StoreyGrid {
    const y = storeyY(s) + 0.01
    const walk = new Uint8Array(N)
    for (const f of this.ctx.floors) {
      if (Math.abs(f.y - y) > 0.25) continue
      if (f.max[0] < X0 || f.min[0] > X1 || f.max[1] < Z0 || f.min[1] > Z1) continue
      this.fill(walk, f.min[0], f.min[1], f.max[0], f.max[1], 1)
    }
    // Ground floor, outdoors: the court and the strip west of the building, walkable where the terrain is level with
    // the floor (the dock platform, 1.1 m up, and anything else off that level stays out).
    if (s === 0) {
      const M = BUILDING.main
      for (let k = 0; k < NZ; k++) {
        const z = cellZ(k)
        for (let i = 0; i < NX; i++) {
          const x = cellX(i)
          if (x > M.min[0] && x < M.max[0] && z > M.min[1] && z < M.max[1]) continue
          const c = k * NX + i
          if (walk[c]) continue
          const h = heightAt(x, z)
          if (h > y - 0.55 && h < y + 0.4) walk[c] = 1
        }
      }
    }
    this.fill(walk, CORE.lift.min[0], CORE.lift.min[1], CORE.lift.max[0], CORE.lift.max[1], 0)
    for (const b of this.boxes) {
      if (b.max[1] <= y + KNEE || b.min[1] >= y + HEAD) continue
      if (b.max[0] < X0 - 1 || b.min[0] > X1 + 1 || b.max[2] < Z0 - 1 || b.min[2] > Z1 + 1) continue
      this.fill(walk, b.min[0] - R, b.min[2] - R, b.max[0] + R, b.max[2] + R, 0)
    }
    const door = new Int16Array(N).fill(-1)
    for (const d of this.doors) {
      if (d.s !== s) continue
      if (d.h.locked) this.segCells(d.ax, d.az, d.bx, d.bz, R, 0, (i) => (walk[i] = 0))
      else this.segCells(d.ax, d.az, d.bx, d.bz, 0.4, 0.05, (i) => walk[i] && (door[i] = d.index))
    }
    // Clearance: chamfer distance (in cells) to the nearest blocked cell, capped at 4.
    const clear = new Uint8Array(N)
    for (let i = 0; i < N; i++) clear[i] = walk[i] ? 4 : 0
    for (let pass = 0; pass < 2; pass++) {
      for (let k = 0; k < NZ; k++)
        for (let i = 0; i < NX; i++) {
          const c = pass === 0 ? k * NX + i : N - 1 - (k * NX + i)
          if (!clear[c]) continue
          const ci = c % NX
          const ck = (c / NX) | 0
          const step = pass === 0 ? -1 : 1
          let m = clear[c]!
          const a = ci + step >= 0 && ci + step < NX ? clear[c + step]! : 0
          const b = ck + step >= 0 && ck + step < NZ ? clear[c + step * NX]! : 0
          m = Math.min(m, a + 1, b + 1)
          clear[c] = m
        }
    }
    return { s, y, walk, door, comp: new Int32Array(N).fill(-1), clear, main: -1 }
  }

  private buildStairs() {
    const cxW = (ST.x0 + ST.wellX0) / 2
    const cxE = (ST.wellX1 + ST.x1) / 2
    const zLand = ST.zFlight - 0.35
    const zMid = (ST.zMid + ST.z1) / 2
    for (let s = 0; s < STOREYS - 1; s++) {
      const a = this.snapRaw(s, cxW, zLand, 1.2) ?? { x: cxW, z: zLand }
      const b = this.snapRaw(s + 1, cxE, zLand, 1.2) ?? { x: cxE, z: zLand }
      this.stairs.push([
        { x: a.x, z: a.z, s },
        { x: cxW, z: ST.zFlight + 0.3, s, stair: true },
        { x: cxW, z: zMid, s, stair: true },
        { x: cxE, z: zMid, s, stair: true },
        { x: cxE, z: ST.zFlight + 0.3, s, stair: true },
        { x: b.x, z: b.z, s: s + 1 },
      ])
    }
    for (let s = 0; s < STOREYS; s++) {
      const p = s < STOREYS - 1 ? this.stairs[s]![0]! : this.stairs[s - 1]![5]!
      this.chokepoints.push({ x: p.x, z: p.z, s })
      const l = this.snapRaw(s, (CORE.liftLobby.min[0] + CORE.liftLobby.max[0]) / 2, (CORE.liftLobby.min[1] + CORE.liftLobby.max[1]) / 2, 1.5)
      if (l) this.chokepoints.push({ x: l.x, z: l.z, s })
    }
  }

  private components(g: StoreyGrid) {
    const { walk, comp } = g
    const queue = new Int32Array(N)
    let id = 0
    const sizes: number[] = []
    for (let start = 0; start < N; start++) {
      if (!walk[start] || comp[start]! >= 0) continue
      let head = 0
      let tail = 0
      queue[tail++] = start
      comp[start] = id
      while (head < tail) {
        const c = queue[head++]!
        this.neighbours(g, c, (n) => {
          if (comp[n]! < 0) {
            comp[n] = id
            queue[tail++] = n
          }
        })
      }
      sizes.push(tail)
      id++
    }
    // The building: the component the stair landing is in (else the largest).
    const p = g.s < STOREYS - 1 ? this.stairs[g.s]?.[0] : this.stairs[g.s - 1]?.[5]
    const at = p ? this.cellAt(p.x, p.z) : -1
    g.main = at >= 0 && comp[at]! >= 0 ? comp[at]! : sizes.indexOf(Math.max(...sizes))
  }

  /** 8-neighbours that can be stepped to (diagonals only past two open orthogonals). */
  private neighbours(g: StoreyGrid, c: number, fn: (n: number, cost: number) => void) {
    const w = g.walk
    const i = c % NX
    const L = i > 0 && w[c - 1]
    const Rr = i < NX - 1 && w[c + 1]
    const U = c >= NX && w[c - NX]
    const D = c < N - NX && w[c + NX]
    if (L) fn(c - 1, 1)
    if (Rr) fn(c + 1, 1)
    if (U) fn(c - NX, 1)
    if (D) fn(c + NX, 1)
    if (L && U && w[c - NX - 1]) fn(c - NX - 1, Math.SQRT2)
    if (Rr && U && w[c - NX + 1]) fn(c - NX + 1, Math.SQRT2)
    if (L && D && w[c + NX - 1]) fn(c + NX - 1, Math.SQRT2)
    if (Rr && D && w[c + NX + 1]) fn(c + NX + 1, Math.SQRT2)
  }

  private buildRooms() {
    const doorById = new Map(this.doors.map((d) => [d.id, d.index]))
    for (const r of interiorRooms) {
      const g = this.grids[r.storey]
      if (!g) continue
      const rect = r.rect
      // Probe: the most open main-component cell near the centre; hiding spots: cells hugging furniture or walls.
      let best = -1
      let bestScore = -Infinity
      const hug: number[] = []
      const cx = (rect.x0 + rect.x1) / 2
      const cz = (rect.z0 + rect.z1) / 2
      for (let k = Math.max(0, izOf(rect.z0 + 0.2)); k <= Math.min(NZ - 1, izOf(rect.z1 - 0.2)); k++)
        for (let i = Math.max(0, ixOf(rect.x0 + 0.2)); i <= Math.min(NX - 1, ixOf(rect.x1 - 0.2)); i++) {
          const c = k * NX + i
          if (g.comp[c] !== g.main) continue
          const score = Math.min(3, g.clear[c]!) - 0.15 * Math.hypot(cellX(i) - cx, cellZ(k) - cz)
          if (score > bestScore) {
            bestScore = score
            best = c
          }
          if (g.clear[c] === 1 && g.door[c]! < 0) hug.push(c)
        }
      if (best < 0) continue
      const spots: [number, number][] = []
      for (let n = 0; n < 6 && hug.length; n++) {
        const c = hug.splice(Math.floor(((n * 0.618 + 0.31) % 1) * hug.length), 1)[0]!
        spots.push([cellX(c % NX), cellZ((c / NX) | 0)])
      }
      const doors = new Set<number>()
      for (const id of r.doors) {
        const d = doorById.get(id)
        if (d !== undefined) doors.add(d)
      }
      for (const d of this.doors)
        if (d.s === r.storey && d.cx > rect.x0 - 0.3 && d.cx < rect.x1 + 0.3 && d.cz > rect.z0 - 0.3 && d.cz < rect.z1 + 0.3) doors.add(d.index)
      this.rooms.push({ key: `${r.storey}:${r.id}`, id: r.id, name: r.name, s: r.storey, rect, px: cellX(best % NX), pz: cellZ((best / NX) | 0), doors: [...doors], spots })
    }
  }

  // ------------------------------------------------------------------------------------------------- queries

  cellAt(x: number, z: number) {
    const i = ixOf(x)
    const k = izOf(z)
    if (i < 0 || i >= NX || k < 0 || k >= NZ) return -1
    return k * NX + i
  }

  walkable(s: number, x: number, z: number) {
    const g = this.grids[s]
    const c = this.cellAt(x, z)
    return !!g && c >= 0 && g.comp[c] === g.main
  }

  private snapRaw(s: number, x: number, z: number, maxR: number) {
    const g = this.grids[s]
    if (!g) return null
    const ci = ixOf(x)
    const ck = izOf(z)
    const rr = Math.ceil(maxR / CELL)
    let best = -1
    let bd = Infinity
    for (let k = Math.max(0, ck - rr); k <= Math.min(NZ - 1, ck + rr); k++)
      for (let i = Math.max(0, ci - rr); i <= Math.min(NX - 1, ci + rr); i++) {
        const c = k * NX + i
        if (!g.walk[c] || (g.main >= 0 && g.comp[c] !== g.main)) continue
        const d = (cellX(i) - x) ** 2 + (cellZ(k) - z) ** 2 - 0.02 * Math.min(2, g.clear[c]!)
        if (d < bd) {
          bd = d
          best = c
        }
      }
    return best < 0 ? null : { x: cellX(best % NX), z: cellZ((best / NX) | 0) }
  }

  /** Nearest walkable point of the building on storey `s` within `maxR` of (x, z), or null. */
  snap(s: number, x: number, z: number, maxR = 3) {
    return this.snapRaw(s, x, z, maxR)
  }

  /** Highest floor at (x, z) between `minY` and `maxY` (outside the main block, the terrain counts too), or NaN. */
  groundAt(x: number, z: number, maxY: number, minY = -Infinity) {
    const l = this.floorHash.get(bkey(Math.floor(x / BUCKET), Math.floor(z / BUCKET)))
    let g = NaN
    if (l)
      for (const f of l) {
        if (x < f.min[0] || x > f.max[0] || z < f.min[1] || z > f.max[1] || f.y > maxY || f.y < minY) continue
        if (!(f.y <= g)) g = f.y
      }
    const M = BUILDING.main
    if (!(x > M.min[0] && x < M.max[0] && z > M.min[1] && z < M.max[1])) {
      const h = heightAt(x, z)
      if (h <= maxY && h >= minY && !(h <= g)) g = h
    }
    return g
  }

  /**
   * World y of the ceiling over (x, z) for a body standing at height `y`: the suspended ceiling 2.94 m over the storey's
   * floor (kit CEIL_Y − FLOOR_Y), except in the open stairwell (no ceiling), where it is the underside of the flight or
   * landing above (the lowest walking surface over it, less the slab or soffit, 0.25 m).
   */
  ceilingAt(x: number, z: number, y: number) {
    if (x >= ST.x0 - 0.05 && x <= ST.x1 + 0.05 && z >= ST.z0 && z <= ST.z1 + 0.05) {
      const l = this.floorHash.get(bkey(Math.floor(x / BUCKET), Math.floor(z / BUCKET)))
      let c = Infinity
      if (l) for (const f of l) if (f.y > y + 1.2 && f.y < c && x >= f.min[0] && x <= f.max[0] && z >= f.min[1] && z <= f.max[1]) c = f.y
      return Number.isFinite(c) ? c - 0.25 : y + 3.6
    }
    return storeyY(storeyOf(y + 0.3)) + 0.01 + 2.94
  }

  /**
   * Colliders the segment a → b passes through (boxes containing either end don't count), up to `max`. `tall`: only
   * wall-height solids (≥ 1.9 m), for counting walls between a noise and the listener.
   */
  hits(ax: number, ay: number, az: number, bx: number, by: number, bz: number, max = 1, tall = false) {
    const dx = bx - ax
    const dy = by - ay
    const dz = bz - az
    const len = Math.hypot(dx, dz)
    const gen = ++this.gen
    let n = 0
    const dynamic = this.ctx.interactions?.world.colliders
    if (dynamic) for (const b of dynamic) {
      if (tall && b.max[1] - b.min[1] < 1.9) continue
      if (segBox(ax, ay, az, dx, dy, dz, b) && ++n >= max) return n
    }
    let lastKey = NaN
    const steps = Math.max(1, Math.ceil(len / 0.5))
    for (let k = 0; k <= steps; k++) {
      const t = k / steps
      const key = bkey(Math.floor((ax + dx * t) / BUCKET), Math.floor((az + dz * t) / BUCKET))
      if (key === lastKey) continue
      lastKey = key
      const l = this.boxHash.get(key)
      if (!l) continue
      for (const i of l) {
        if (this.stamp[i] === gen) continue
        this.stamp[i] = gen
        const b = this.boxes[i]!
        if (dynamic?.has(b)) continue
        if (tall && b.max[1] - b.min[1] < 1.9) continue
        if (segBox(ax, ay, az, dx, dy, dz, b)) {
          if (++n >= max) return n
        }
      }
    }
    return n
  }

  /** A closed or swung door leaf on the segment (on storey `s`). */
  doorBlocks(s: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number) {
    const dx = bx - ax
    const dy = by - ay
    const dz = bz - az
    const len = Math.hypot(dx, dy, dz) || 1
    const x0 = Math.min(ax, bx) - 1.2
    const x1 = Math.max(ax, bx) + 1.2
    const z0 = Math.min(az, bz) - 1.2
    const z1 = Math.max(az, bz) + 1.2
    for (const d of this.doors) {
      if (d.s !== s || d.cx < x0 || d.cx > x1 || d.cz < z0 || d.cz > z1) continue
      const t = d.h.ray(ax, ay, az, dx / len, dy / len, dz / len)
      if (t >= 0 && t <= len) return true
    }
    return false
  }

  /** Clear line of sight between two points on storey `s` (walls, furniture, door leaves). */
  sees(s: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number) {
    return this.hits(ax, ay, az, bx, by, bz, 1) === 0 && !this.doorBlocks(s, ax, ay, az, bx, by, bz)
  }

  roomAt(s: number, x: number, z: number) {
    for (const r of this.rooms) if (r.s === s && x >= r.rect.x0 && x <= r.rect.x1 && z >= r.rect.z0 && z <= r.rect.z1) return r
    return null
  }

  /** Straight walkable line between two points of a storey (every cell on it walkable). */
  lineWalkable(g: StoreyGrid, ax: number, az: number, bx: number, bz: number) {
    const len = Math.hypot(bx - ax, bz - az)
    const steps = Math.max(1, Math.ceil(len / (CELL * 0.5)))
    for (let k = 1; k < steps; k++) {
      const t = k / steps
      const c = this.cellAt(ax + (bx - ax) * t, az + (bz - az) * t)
      if (c < 0 || g.comp[c] !== g.main) return false
    }
    return true
  }

  /** A* on storey `s` between two walkable points; null when unreachable. String-pulled waypoints (start excluded). */
  gridPath(s: number, ax: number, az: number, bx: number, bz: number): Waypoint[] | null {
    const g = this.grids[s]!
    const a0 = this.snapRaw(s, ax, az, 1.5)
    const b0 = this.snapRaw(s, bx, bz, 2.5)
    if (!a0 || !b0) return null
    const start = this.cellAt(a0.x, a0.z)
    const goal = this.cellAt(b0.x, b0.z)
    if (start === goal) return [{ x: b0.x, z: b0.z, s }]
    const gen = ++this.search
    const gs = this.g
    const par = this.parent
    const seen = this.seen
    const closed = this.closed
    const hi = this.heapI
    const hf = this.heapF
    let size = 0
    const gx = goal % NX
    const gz = (goal / NX) | 0
    const h = (c: number) => {
      const dx = Math.abs((c % NX) - gx)
      const dz = Math.abs(((c / NX) | 0) - gz)
      return Math.max(dx, dz) + (Math.SQRT2 - 1) * Math.min(dx, dz)
    }
    const push = (c: number, f: number) => {
      let i = size++
      while (i > 0) {
        const p = (i - 1) >> 1
        if (hf[p]! <= f) break
        hi[i] = hi[p]!
        hf[i] = hf[p]!
        i = p
      }
      hi[i] = c
      hf[i] = f
    }
    const pop = () => {
      const top = hi[0]!
      const lastI = hi[--size]!
      const lastF = hf[size]!
      let i = 0
      for (;;) {
        let c = 2 * i + 1
        if (c >= size) break
        if (c + 1 < size && hf[c + 1]! < hf[c]!) c++
        if (hf[c]! >= lastF) break
        hi[i] = hi[c]!
        hf[i] = hf[c]!
        i = c
      }
      hi[i] = lastI
      hf[i] = lastF
      return top
    }
    seen[start] = gen
    gs[start] = 0
    par[start] = -1
    push(start, h(start))
    let found = false
    let expanded = 0
    while (size > 0) {
      const c = pop()
      if (closed[c] === gen) continue
      closed[c] = gen
      if (c === goal) {
        found = true
        break
      }
      if (++expanded > 60000) break
      const gc = gs[c]!
      // The 8 neighbours inline (no closure per expanded cell); diagonals only past two open orthogonals.
      const wk = g.walk
      const ci = c % NX
      const L = ci > 0 && wk[c - 1] === 1
      const Rt = ci < NX - 1 && wk[c + 1] === 1
      const U = c >= NX && wk[c - NX] === 1
      const D = c < N - NX && wk[c + NX] === 1
      for (let k = 0; k < 8; k++) {
        let n: number
        let cost = 1
        if (k === 0) n = L ? c - 1 : -1
        else if (k === 1) n = Rt ? c + 1 : -1
        else if (k === 2) n = U ? c - NX : -1
        else if (k === 3) n = D ? c + NX : -1
        else {
          cost = Math.SQRT2
          n = k === 4 ? (L && U ? c - NX - 1 : -1) : k === 5 ? (Rt && U ? c - NX + 1 : -1) : k === 6 ? (L && D ? c + NX - 1 : -1) : Rt && D ? c + NX + 1 : -1
          if (n >= 0 && wk[n] !== 1) n = -1
        }
        if (n < 0 || closed[n] === gen) continue
        // Keep off walls and furniture: cells right next to them cost more.
        const cl = g.clear[n]!
        const ng = gc + cost * (cl <= 1 ? 1.6 : cl === 2 ? 1.15 : 1)
        if (seen[n] !== gen || ng < gs[n]!) {
          seen[n] = gen
          gs[n] = ng
          par[n] = c
          push(n, ng + h(n))
        }
      }
    }
    if (!found) return null
    const cells: number[] = []
    for (let c = goal; c >= 0; c = par[c]!) cells.push(c)
    cells.reverse()
    // String-pull: from each kept point, the farthest cell still reachable in a straight walkable line.
    const out: Waypoint[] = []
    let i = 0
    let px = cellX(start % NX)
    let pz = cellZ((start / NX) | 0)
    while (i < cells.length - 1) {
      let j = i + 1
      let k = Math.min(cells.length - 1, i + 2)
      while (k < cells.length) {
        const c = cells[k]!
        if (!this.lineWalkable(g, px, pz, cellX(c % NX), cellZ((c / NX) | 0))) break
        j = k
        k++
      }
      const c = cells[j]!
      px = cellX(c % NX)
      pz = cellZ((c / NX) | 0)
      out.push({ x: px, z: pz, s })
      i = j
    }
    return out
  }

  /** Route between two points anywhere in the building (through the stair between storeys), or null. */
  route(from: { x: number; z: number; s: number }, to: { x: number; z: number; s: number }): Route | null {
    const pts: Waypoint[] = [{ x: from.x, z: from.z, s: from.s }]
    let cur = { x: from.x, z: from.z, s: from.s }
    let guard = 0
    while (cur.s !== to.s && guard++ < STOREYS) {
      const up = to.s > cur.s
      const flight = up ? this.stairs[cur.s] : this.stairs[cur.s - 1]
      if (!flight) return null
      const seq = up ? flight : [...flight].reverse()
      const leg = this.gridPath(cur.s, cur.x, cur.z, seq[0]!.x, seq[0]!.z)
      if (!leg) return null
      pts.push(...leg, ...seq.slice(1))
      const end = seq[seq.length - 1]!
      cur = { x: end.x, z: end.z, s: end.s }
    }
    const leg = this.gridPath(cur.s, cur.x, cur.z, to.x, to.z)
    if (!leg) return null
    pts.push(...leg)
    const cum = [0]
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1]! + Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.z - pts[i - 1]!.z))
    // Doors the route crosses (grid legs only), with the distance along the route where it enters each opening.
    const doors: Route["doors"] = []
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!
      const b = pts[i]!
      if (b.stair || a.s !== b.s) continue
      this.lineDoors(a.s, a.x, a.z, b.x, b.z, cum[i - 1]!, doors)
    }
    return { pts, cum, length: cum[cum.length - 1]!, doors }
  }

  /** Doors whose openings the straight line a → b on storey `s` crosses, appended with their distance along. */
  lineDoors(s: number, ax: number, az: number, bx: number, bz: number, along0: number, out: Route["doors"]) {
    const g = this.grids[s]!
    const len = Math.hypot(bx - ax, bz - az)
    const steps = Math.max(1, Math.ceil(len / 0.1))
    let prev = -1
    for (let k = 0; k <= steps; k++) {
      const t = k / steps
      const c = this.cellAt(ax + (bx - ax) * t, az + (bz - az) * t)
      const d = c >= 0 ? g.door[c]! : -1
      if (d >= 0 && d !== prev && !out.some((e) => e.door === d && Math.abs(e.along - along0 - len * t) < 2)) out.push({ door: d, along: along0 + len * t })
      prev = d
    }
    return out
  }
}

/** Segment (origin o, delta d, t ∈ (0.02, 0.98)) vs box. No allocation (it runs per collider per ray). */
const SLAB = { t0: 0, t1: 1 }
function segBox(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, b: Box) {
  const r = SLAB
  r.t0 = 0
  r.t1 = 1
  if (!slabAxis(ox, dx, b.min[0], b.max[0], r) || !slabAxis(oy, dy, b.min[1], b.max[1], r) || !slabAxis(oz, dz, b.min[2], b.max[2], r)) return false
  return r.t0 > 0.02 && r.t1 < 0.98
}

function slabAxis(o: number, d: number, lo: number, hi: number, r: { t0: number; t1: number }) {
  if (Math.abs(d) < 1e-9) return o >= lo && o <= hi
  let a = (lo - o) / d
  let c = (hi - o) / d
  if (a > c) {
    const t = a
    a = c
    c = t
  }
  if (a > r.t0) r.t0 = a
  if (c < r.t1) r.t1 = c
  return r.t0 <= r.t1
}
