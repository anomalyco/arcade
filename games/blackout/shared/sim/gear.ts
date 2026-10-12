import { DT, FRAG } from "../config"
import { type Rect, distToRect, gridOf } from "../geom"
import type { MapDef } from "../maps"

/** A frag in flight or rolling: floor-plan position, height above the floor, and when it goes off. */
export type Grenade = { id: number; by: string; x: number; y: number; z: number; vx: number; vy: number; vz: number; at: number }

/** A planted claymore facing `aim`. It arms at `armAt`; once tripped it blows at `blowAt` (0 until then). */
export type Claymore = { id: number; by: string; x: number; y: number; aim: number; armAt: number; blowAt: number }

const near: number[] = []

/** True when a circle overlaps any rect. */
export function overlaps(x: number, y: number, r: number, rects: readonly Rect[]): boolean {
  const grid = gridOf(rects)
  if (!grid) return rects.some((rc) => distToRect(x, y, rc) < r)
  for (const i of grid.query(x - r, y - r, x + r, y + r, near)) if (distToRect(x, y, rects[i]!) < r) return true
  return false
}

/**
 * The launch state for a throw from (x, y) along `aim` toward a point `dist` metres away: an arc that comes down near
 * that point, then bounces and rolls on.
 */
export function launch(x: number, y: number, aim: number, dist: number): Pick<Grenade, "x" | "y" | "z" | "vx" | "vy" | "vz"> {
  // It skips and rolls on after landing, so aim the first bounce short of the mark.
  const d = Math.max(FRAG.minThrow, Math.min(FRAG.maxThrow, dist)) * 0.72
  const t = 0.4 + d * 0.06
  const v = d / t
  return { x, y, z: FRAG.release, vx: Math.cos(aim) * v, vy: Math.sin(aim) * v, vz: (FRAG.size - FRAG.release + 0.5 * FRAG.gravity * t * t) / t }
}

/** Solid furniture is about desk height: frags fly over it and can land on it. */
export const PROP_TOP = 0.78

/** What a frag can hit: rects with their heights. It sails over anything lower than itself and lands on wide tops. */
export type Obstacles = { rects: readonly Rect[]; h: readonly number[] }

export function obstaclesOf(map: MapDef): Obstacles {
  const solid = map.props.filter((p) => p.solid)
  const glass = [...map.windows, ...map.glass]
  return {
    rects: [...map.walls.map((w) => w.rect), ...glass, ...solid.map((p) => p.rect)],
    h: [...map.walls.map((w) => w.h), ...glass.map(() => 9), ...solid.map(() => PROP_TOP)],
  }
}

/** Deepest overlap of the frag's circle with an obstacle taller than it, or 0. */
function pen(x: number, y: number, z: number, r: number, o: Obstacles): number {
  const grid = gridOf(o.rects)
  const list = grid ? grid.query(x - r, y - r, x + r, y + r, near) : null
  const n = list ? list.length : o.rects.length
  let worst = 0
  for (let k = 0; k < n; k++) {
    const i = list ? list[k]! : k
    if (z >= o.h[i]!) continue
    const d = distToRect(x, y, o.rects[i]!)
    if (d < r) worst = Math.max(worst, r - d)
  }
  return worst
}

/** Height of the surface under a point: the floor, or the top of a wide piece of furniture. */
function floorAt(x: number, y: number, z: number, o: Obstacles): number {
  const grid = gridOf(o.rects)
  const list = grid ? grid.query(x, y, x, y, near) : null
  const n = list ? list.length : o.rects.length
  let top = 0
  for (let k = 0; k < n; k++) {
    const i = list ? list[k]! : k
    const rc = o.rects[i]!
    const h = o.h[i]!
    if (h <= z + 0.05 && rc[2] - rc[0] > 0.3 && rc[3] - rc[1] > 0.3 && x >= rc[0] && x <= rc[2] && y >= rc[1] && y <= rc[3]) top = Math.max(top, h)
  }
  return top
}

/**
 * Advances a grenade: gravity, damped bounces off whatever is taller than it, off the floor and furniture tops, then
 * rolling friction. Returns the speed of the hardest bounce this step (0 for none), for the clink. Runs on the server
 * and, for smooth drawing, on clients.
 */
export function stepGrenade(g: Grenade, o: Obstacles, dt = DT): number {
  const r = FRAG.size
  let bump = 0
  // A move is blocked when it digs deeper into something; one already overlapping can always back out.
  const hits = (x: number, y: number) => {
    const p = pen(x, y, g.z, r, o)
    return p > 0 && p > pen(g.x, g.y, g.z, r, o) - 1e-9
  }
  const n = Math.max(1, Math.ceil((Math.hypot(g.vx, g.vy, g.vz) * dt) / 0.06))
  const h = dt / n
  for (let i = 0; i < n; i++) {
    const nx = g.x + g.vx * h
    if (hits(nx, g.y)) {
      bump = Math.max(bump, Math.abs(g.vx))
      g.vx = -g.vx * 0.45
      g.vy *= 0.75
    } else g.x = nx
    const ny = g.y + g.vy * h
    if (hits(g.x, ny)) {
      bump = Math.max(bump, Math.abs(g.vy))
      g.vy = -g.vy * 0.45
      g.vx *= 0.75
    } else g.y = ny
    g.vz -= FRAG.gravity * h
    g.z += g.vz * h
    const floor = r + floorAt(g.x, g.y, g.z - r, o)
    if (g.z <= floor) {
      g.z = floor
      if (g.vz < -1.4) {
        bump = Math.max(bump, -g.vz)
        g.vz = -g.vz * 0.32
        g.vx *= 0.55
        g.vy *= 0.55
      } else {
        g.vz = 0
        const f = Math.exp(-5 * h)
        g.vx *= f
        g.vy *= f
      }
    }
  }
  return bump
}
