import { lakeDistance, terrainHeight, treesNear, type Tree, type WoodsWorld } from "../../shared/world"

/**
 * Where the listener is, as sound sees it: how exposed to the wind, how much canopy is around, how deep in the woods,
 * whether indoors, where the nearest shore is. Pure functions of the world and a position, so they are testable and
 * the same for live play and the offline proof render.
 */

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))
const smooth = (a: number, b: number, v: number) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t) }

/** Ring of offsets for local relief (unit circle, 8 points). */
const RING = [[1, 0], [0.7071, 0.7071], [0, 1], [-0.7071, 0.7071], [-1, 0], [-0.7071, -0.7071], [0, -1], [0.7071, -0.7071]] as const

/**
 * Wind exposure, about 0.25 (a hollow) to 1.5 (the ridge): height over the ground 35 m around, plus overall height
 * (the north ridge rises 24 m), plus open water.
 */
export function windExposure(world: WoodsWorld, x: number, z: number): number {
  const h = terrainHeight(world.terrain, x, z)
  let ring = 0
  for (const [dx, dz] of RING) ring += terrainHeight(world.terrain, x + dx * 35, z + dz * 35)
  const relief = h - ring / RING.length
  const lake = smooth(1.6, 1.0, lakeDistance(world.lake, x, z)) * 0.25
  return clamp(0.7 + relief / 5 + (h - 2) / 40 + lake, 0.25, 1.5)
}

const nearScratch: Tree[] = []
/** Canopy around (x, z), 0 (open water, the camp clearing) to about 1 (thick woods). */
export function canopyDensity(world: WoodsWorld, x: number, z: number, r = 14): number {
  const n = treesNear(world, x, z, r, nearScratch).length
  // Default density is 4.5 trees per 100 m², about 28 inside 14 m once clearings thin it.
  return clamp(n / 24, 0, 1.2)
}

/** Crickets: full at camp and on the clearings by the lake, thinning to a few deep in the woods. */
export function insectLevel(world: WoodsWorld, x: number, z: number): number {
  const camp = Math.sqrt((x - world.camp.x) ** 2 + (z - world.camp.z) ** 2)
  const shore = smooth(2.2, 1.2, lakeDistance(world.lake, x, z))
  return clamp(1 - 0.88 * smooth(25, 140, camp) + 0.5 * shore, 0.12, 1)
}

/** The building you are inside, if any (cabins, the mess hall). */
export function indoorsAt(world: WoodsWorld, x: number, z: number) {
  return world.buildings.find((b) => (b.kind === "cabin" || b.kind === "mess-hall") && x > b.rect[0] && x < b.rect[2] && z > b.rect[1] && z < b.rect[3])
}

/** Nearest point on the shoreline (the lake ellipse), by a few Newton-free refinement steps on the angle. */
export function nearestShore(world: WoodsWorld, x: number, z: number): { x: number; z: number; d: number } {
  const L = world.lake
  let best = { x: L.x + L.rx, z: L.z, d: Infinity }
  const test = (a: number) => {
    const sx = L.x + Math.cos(a) * L.rx, sz = L.z + Math.sin(a) * L.rz
    const d = Math.hypot(sx - x, sz - z)
    if (d < best.d) best = { x: sx, z: sz, d }
    return d
  }
  let a0 = 0, bestD = Infinity
  for (let i = 0; i < 32; i++) { const a = (i / 32) * Math.PI * 2; const d = test(a); if (d < bestD) { bestD = d; a0 = a } }
  let step = Math.PI / 32
  for (let k = 0; k < 10; k++) { const l = test(a0 - step), r = test(a0 + step); if (l < bestD) { bestD = l; a0 -= step } else if (r < bestD) { bestD = r; a0 += step }; step /= 2 }
  return best
}

/** Nearest bulb on the camp's string of lights. */
export function nearestStringLight(world: WoodsWorld, x: number, z: number): { x: number; y: number; z: number; d: number } | null {
  let best: { x: number; y: number; z: number; d: number } | null = null
  for (const l of world.lamps) {
    if (l.kind !== "string") continue
    const d = Math.hypot(l.x - x, l.z - z)
    if (!best || d < best.d) best = { x: l.x, y: l.y, z: l.z, d }
  }
  return best
}

/** Smooth 1-D value noise in 0..1. */
function noise1(x: number, seed: number): number {
  const i = Math.floor(x), f = x - i
  const h = (n: number) => { let v = Math.imul((n + seed) | 0, 0x27d4eb2d) >>> 0; v = Math.imul(v ^ (v >>> 15), 0x85ebca6b) >>> 0; return ((v ^ (v >>> 13)) >>> 0) / 4294967296 }
  const u = f * f * (3 - 2 * f)
  return h(i) + (h(i + 1) - h(i)) * u
}

/** The way gust fronts travel (unit, x east, z south): out of the west-north-west. */
export const WIND_DIR = [0.894, 0.447] as const
/** Gust fronts travel at this speed over the forest (m/s). */
export const GUST_SPEED = 7

/**
 * Gust strength at (x, z) at time t, about 0.2..1: slow swells (a minute or so) times gusts (5–15 s) that sweep
 * downwind across the trees, so a gust heard to the west reaches you a few seconds later and moves on east.
 */
export function gustAt(x: number, z: number, t: number, seed = 1987): number {
  const s = x * WIND_DIR[0] + z * WIND_DIR[1] - GUST_SPEED * t
  const swell = noise1(s / 420, seed)
  const gust = noise1(s / 75, seed + 31) * 0.6 + noise1(s / 29, seed + 77) * 0.4
  return clamp(0.18 + 0.82 * (0.4 + 0.6 * swell) * smooth(0.1, 0.9, gust), 0.08, 1)
}
