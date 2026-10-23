/**
 * The forest as ground for a long-legged creature (world metres): terrain heights; feet kept out of trunks, rocks and
 * the lake; and the body, riding metres above the floor, kept off trunks only. Rocks and logs sit under a body
 * slung that high, so they constrain the feet, never the body: when they also pushed the body, a route straight at a
 * boulder stalled it against the rock for 14 s on the Lab loop.
 *
 * A body pushed out of a trunk keeps the step it lost and spends it round the edge, on the side it was heading (ties
 * go left), so walking straight at a trunk skirts it instead of stopping dead.
 */
import type { CreatureSurface } from "../sim/creature-motion"
import type { ForestWorld } from "../sim/forest-world"

type Solid = { x: number; z: number; r: number }
const CELL = 6

function grid(solids: readonly Solid[]) {
  const cells = new Map<number, Solid[]>()
  const key = (gx: number, gz: number) => (gx + 500) * 1000 + gz + 500
  for (const s of solids) {
    const k = key(Math.floor(s.x / CELL), Math.floor(s.z / CELL))
    const list = cells.get(k)
    if (list) list.push(s)
    else cells.set(k, [s])
  }
  return function* near(x: number, z: number) {
    const gx = Math.floor(x / CELL), gz = Math.floor(z / CELL)
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) yield* cells.get(key(gx + i, gz + j)) ?? []
  }
}

/** `bodyRadius` (metres) is read each step, so a resize applies at once. */
export function forestCreatureSurface(world: Pick<ForestWorld, "height" | "trees" | "rocks" | "lake">, bodyRadius: () => number): CreatureSurface {
  const trunks = world.trees.map(t => ({ x: t.x, z: t.z, r: t.r + 0.12 }))
  const feet = grid([...trunks, ...world.rocks.map(r => ({ x: r.x, z: r.z, r: r.r * 0.9 }))])
  const body = grid(trunks)
  const lake = world.lake
  return {
    heightAt: (x, z) => world.height(x, z),
    walkable: (x, z) => {
      if (lake && world.height(x, z) < lake.level + 0.05) return false
      for (const s of feet(x, z)) if ((x - s.x) ** 2 + (z - s.z) ** 2 < s.r * s.r) return false
      return true
    },
    constrain: (fx, fz, tx, tz) => {
      const R = bodyRadius()
      const step = Math.hypot(tx - fx, tz - fz)
      let x = tx, z = tz
      for (const s of body(x, z)) {
        const dx = x - s.x, dz = z - s.z, d = Math.hypot(dx, dz), min = s.r + R
        if (d >= min || d < 1e-6) continue
        const nx = dx / d, nz = dz / d
        const ex = s.x + nx * min, ez = s.z + nz * min
        // Round the edge by what the push took off the step, then back onto the edge.
        const side = (tx - fx) * -nz + (tz - fz) * nx >= 0 ? 1 : -1
        const lost = Math.max(0, step - Math.hypot(ex - fx, ez - fz))
        const sx = ex - nz * side * lost - s.x, sz = ez + nx * side * lost - s.z, sl = Math.hypot(sx, sz) || 1
        x = s.x + (sx / sl) * min
        z = s.z + (sz / sl) * min
      }
      return [x, z]
    },
  }
}
