// World geography — owned by the World agent. Pure, deterministic, dependency-free (server safe).
//
// The world is a 30 × 30 km tropical archipelago. Heights come from a small set of hand-placed and
// seeded descriptors (islands with peaks, karst spires, carved canyons, four airbase plateaus) looked
// up through a 1 km spatial index, so a height sample touches only the few features nearby.
//
// Collision surface == rendered surface: the renderer triangulates `terrainHeight` on a regular grid
// (LOD0 cell = MESH_CELL) and `groundHeight` interpolates exactly the same triangles.
import type { TeamId, Vec3, VehicleKind, WorldQuery } from "./types"

export const WORLD_SIZE = 30_000
export const WORLD_HALF = WORLD_SIZE / 2
export const WATER_LEVEL = 0
export const CEILING = 6_000
export const WORLD_SEED = 0x57494e47 // "WING"

/** Ocean floor depth used far from any island. */
export const SEA_FLOOR = -60
/** Render/stream tile size and finest mesh resolution. Collision uses the LOD0 triangles. */
export const TILE_SIZE = 1_000
export const MESH_SEGMENTS = 32
export const MESH_CELL = TILE_SIZE / MESH_SEGMENTS // 31.25 m — big low-poly facets
/** Safe zone is an ellipsoidal dome: safeRadius horizontally, SAFE_ZONE_HEIGHT above the runway. */
export const SAFE_ZONE_HEIGHT = 1_500
/** Assumed height of the aircraft origin above the wheels' contact point. */
export const SPAWN_CLEARANCE: Record<"jet" | "heli", number> = { jet: 2.2, heli: 1.9 }

export interface Airbase {
  team: TeamId
  /** Center of the base (runway midpoint), y = runway elevation. */
  center: Vec3
  /** Runway heading as yaw (rad), direction a jet rolls for takeoff, pointing toward the map center. */
  heading: number
  runwayLength: number
  runwayWidth: number
  /** Protected radius around center (no damage taken/dealt by this team's aircraft inside). */
  safeRadius: number
  /** Helipad positions (y = pad elevation). */
  helipads: Vec3[]
}

const BASE_DISTANCE = 12_000
const BASE_ELEVATION = 20

/** Paved areas in base-local coordinates: a = along takeoff direction (+a toward map center), c = to the right. */
export interface PavedRect { a0: number; a1: number; c0: number; c1: number; kind: "runway" | "taxiway" | "apron" }
export const BASE_LAYOUT = {
  runway: { a0: -1200, a1: 1200, c0: -30, c1: 30, kind: "runway" } as PavedRect,
  paved: [
    { a0: -1140, a1: 1140, c0: 140, c1: 164, kind: "taxiway" },
    { a0: -1140, a1: -1116, c0: 30, c1: 164, kind: "taxiway" },
    { a0: 1116, a1: 1140, c0: 30, c1: 164, kind: "taxiway" },
    { a0: -12, a1: 12, c0: 30, c1: 164, kind: "taxiway" },
    { a0: -480, a1: 260, c0: 164, c1: 340, kind: "apron" },
    { a0: 300, a1: 640, c0: 164, c1: 300, kind: "apron" },
  ] as PavedRect[],
  /** Helipad centers (a, c) and radius. */
  helipads: [[360, 232], [440, 232], [520, 232], [600, 232]] as [number, number][],
  helipadRadius: 15,
  /** Perfectly flat plateau (rounded later by the coastline). */
  flat: { a0: -1500, a1: 1500, c0: -300, c1: 620 },
}

export const AIRBASES: Airbase[] = ([0, 1, 2, 3] as TeamId[]).map(team => {
  // Team 0 south (+Z), 1 north (-Z), 2 west (-X), 3 east (+X); runways point toward the center.
  const dir = [[0, 1], [0, -1], [-1, 0], [1, 0]][team]
  const center: Vec3 = [dir[0] * BASE_DISTANCE, BASE_ELEVATION, dir[1] * BASE_DISTANCE]
  const heading = Math.atan2(dir[0], dir[1]) // yaw so that -Z (nose) faces the center
  const base: Airbase = { team, center, heading, runwayLength: 2_400, runwayWidth: 60, safeRadius: 2_200, helipads: [] }
  base.helipads = BASE_LAYOUT.helipads.map(([a, c]) => {
    const [x, z] = baseToWorld(base, a, c)
    return [x, BASE_ELEVATION, z] as Vec3
  })
  return base
})

/** Base-local (a along takeoff, c right) → world [x, z]. Yaw 0 = nose toward -Z. */
export function baseToWorld(base: Airbase, a: number, c: number): [number, number] {
  const s = Math.sin(base.heading), k = Math.cos(base.heading)
  // forward = (-sin, -cos), right = (cos, -sin)
  return [base.center[0] - s * a + k * c, base.center[2] - k * a - s * c]
}

function worldToBaseA(base: Airbase, x: number, z: number): number {
  const s = Math.sin(base.heading), k = Math.cos(base.heading)
  return -(x - base.center[0]) * s - (z - base.center[2]) * k
}
function worldToBaseC(base: Airbase, x: number, z: number): number {
  const s = Math.sin(base.heading), k = Math.cos(base.heading)
  return (x - base.center[0]) * k - (z - base.center[2]) * s
}

// ---------------------------------------------------------------------------------------------
// Noise

function hash2(x: number, z: number, seed: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(z | 0, 668265263) ^ seed
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/** Smooth value noise in [-1, 1]. */
export function noise2(x: number, z: number, seed = WORLD_SEED): number {
  const ix = Math.floor(x), iz = Math.floor(z)
  const fx = x - ix, fz = z - iz
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz)
  const a = hash2(ix, iz, seed), b = hash2(ix + 1, iz, seed)
  const c = hash2(ix, iz + 1, seed), d = hash2(ix + 1, iz + 1, seed)
  return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * 2 - 1
}

function smooth(a: number, b: number, x: number): number {
  const t = x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a)
  return t * t * (3 - 2 * t)
}

/** Deterministic PRNG (mulberry32). */
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------------------------------------------------------------------------------------------
// Feature descriptors

export interface Peak {
  /** Island-local normalized position and radius (fraction of island radii). */
  u: number; v: number; r: number
  h: number
  /** Volcano crater radius (normalized to r), 0 = none. */
  crater?: number
}

export interface Island {
  id: number
  name: string
  x: number; z: number
  rx: number; rz: number
  rot: number
  /** Rolling hill height on the interior. */
  hill: number
  peaks: Peak[]
  /** Terrace step height for mesa-style islands (0 = none). */
  terrace: number
  /** Ridged-noise strength on mountains (0..1). */
  rugged: number
  // derived
  cos: number; sin: number; reach: number; seed: number; maxHeight: number
}

interface Spire { x: number; z: number; r: number; h: number; seed: number }
interface CanyonSeg {
  ax: number; az: number; bx: number; bz: number
  /** Half-width at a and b. */
  wa: number; wb: number
  floor: number
  slope: number
  minX: number; maxX: number; minZ: number; maxZ: number
}

function makeIsland(id: number, name: string, x: number, z: number, rx: number, rz: number, rot: number, hill: number, peaks: Peak[], terrace = 0, rugged = 0.6): Island {
  let peakSum = 0
  for (const p of peaks) peakSum = Math.max(peakSum, p.h)
  // Overlapping peaks can stack; bound conservatively.
  let stack = 0
  for (const p of peaks) stack += p.h
  return {
    id, name, x, z, rx, rz, rot, hill, peaks, terrace, rugged,
    cos: Math.cos(rot), sin: Math.sin(rot), reach: Math.max(rx, rz) * 1.5 + 200,
    seed: (WORLD_SEED + id * 7919) | 0,
    maxHeight: 6 + hill + Math.min(stack, peakSum * 1.6) * 1.12 + 22 + terrace,
  }
}

function buildFeatures() {
  const islands: Island[] = []
  const add = (name: string, x: number, z: number, rx: number, rz: number, rot: number, hill: number, peaks: Peak[], terrace = 0, rugged = 0.6) => {
    islands.push(makeIsland(islands.length, name, x, z, rx, rz, rot, hill, peaks, terrace, rugged))
  }
  // Central volcano island — the main combat landmark, split by Serpent Gorge.
  add("Tamaru", -500, -200, 4300, 3100, 0.35, 70, [
    { u: -0.28, v: -0.18, r: 0.62, h: 1270, crater: 0.13 },
    { u: 0.42, v: 0.32, r: 0.38, h: 560 },
    { u: 0.12, v: -0.62, r: 0.3, h: 420 },
    { u: -0.62, v: 0.5, r: 0.3, h: 360 },
  ], 0, 0.55)
  // East ridge: a long serrated spine with passes.
  add("Kaimana Spine", 6600, 1400, 2900, 1000, -0.95, 50, [
    { u: -0.62, v: 0.0, r: 0.42, h: 640 },
    { u: -0.08, v: 0.05, r: 0.42, h: 860 },
    { u: 0.5, v: -0.05, r: 0.38, h: 720 },
  ], 0, 0.95)
  // West mesas: terraced tablelands cut by a dry canyon.
  add("Tablelands", -6600, -1600, 2500, 2100, 0.5, 40, [
    { u: 0.05, v: 0.0, r: 0.95, h: 470 },
    { u: 0.45, v: -0.45, r: 0.45, h: 220 },
  ], 70, 0.35)
  // North twin peaks with a green valley between.
  add("Twin Sisters", 1400, -6900, 2300, 1600, 0.2, 60, [
    { u: -0.4, v: 0.0, r: 0.5, h: 960 },
    { u: 0.42, v: 0.1, r: 0.46, h: 780 },
  ], 0, 0.75)
  // South-west rolling jungle island.
  add("Verdant", -4600, 5600, 2100, 1500, -0.4, 120, [
    { u: 0.1, v: 0.1, r: 0.7, h: 420 },
    { u: -0.5, v: -0.2, r: 0.35, h: 260 },
  ], 0, 0.4)
  // North-east highlands.
  add("Ember Rise", 5600, -5200, 1900, 1400, 0.8, 60, [
    { u: 0.0, v: 0.0, r: 0.7, h: 680 },
    { u: 0.55, v: 0.3, r: 0.3, h: 300 },
  ], 0, 0.8)
  // South lagoon islands among the karst spires.
  add("Lagoon Key", 2600, 6200, 1300, 700, 0.3, 30, [{ u: 0.2, v: 0, r: 0.6, h: 140 }], 0, 0.3)
  add("Coral Cay", -800, 5200, 900, 500, -0.6, 25, [{ u: 0, v: 0, r: 0.6, h: 70 }], 0, 0.2)
  // Corner outposts (one per quadrant) so the outer ring is not totally empty.
  add("Pele Rock", 9300, 9100, 1500, 1000, 0.7, 50, [{ u: 0, v: 0, r: 0.7, h: 520 }], 0, 0.8)
  add("Mist Isle", -9200, -9300, 1500, 1100, -0.7, 50, [{ u: 0, v: 0.1, r: 0.7, h: 560 }], 0, 0.7)
  add("Turtle Isle", -9400, 9000, 1400, 1100, 0.2, 80, [{ u: 0.1, v: 0, r: 0.8, h: 300 }], 50, 0.4)
  add("Anvil", 9100, -9300, 1300, 1000, -0.3, 40, [{ u: 0, v: 0, r: 0.8, h: 380 }], 60, 0.4)

  // Seeded islets scattered in the inner theater, kept off the base approaches.
  const rand = seededRandom(WORLD_SEED ^ 0x1517)
  let tries = 0
  while (islands.length < 34 && tries++ < 4000) {
    const ang = rand() * Math.PI * 2
    const dist = 2500 + rand() * 8200
    const x = Math.cos(ang) * dist, z = Math.sin(ang) * dist
    const rx = 220 + rand() * 520, rz = rx * (0.45 + rand() * 0.45)
    if (AIRBASES.some(b => Math.hypot(x - b.center[0], z - b.center[2]) < 4200 + rx)) continue
    if (Math.abs(x) > WORLD_HALF - 1500 || Math.abs(z) > WORLD_HALF - 1500) continue
    if (islands.some(i => Math.hypot(x - i.x, z - i.z) < (Math.max(rx, rz) + Math.max(i.rx, i.rz)) * 1.05 + 250)) continue
    const h = 40 + rand() * 220
    add(`Islet ${islands.length}`, x, z, rx, rz, rand() * Math.PI, 15 + rand() * 25,
      [{ u: (rand() - 0.5) * 0.4, v: (rand() - 0.5) * 0.4, r: 0.6 + rand() * 0.3, h }], rand() < 0.25 ? 30 : 0, 0.3 + rand() * 0.5)
  }

  // Karst spires — tall pillars rising out of the southern lagoon.
  const spires: Spire[] = []
  const srand = seededRandom(WORLD_SEED ^ 0x5b17e)
  for (let i = 0; i < 16; i++) {
    const ang = -0.3 + (i / 16) * Math.PI * 1.25 + (srand() - 0.5) * 0.25
    const rad = 1300 + srand() * 1200
    spires.push({ x: 1800 + Math.cos(ang) * rad * 1.4, z: 5900 + Math.sin(ang) * rad * 0.7, r: 85 + srand() * 70, h: 160 + srand() * 230, seed: (WORLD_SEED + 31 * i) | 0 })
  }

  // Canyons as polylines: [x, z, halfWidth] points.
  const canyonDefs: { pts: [number, number, number][]; floor: number; slope: number }[] = [
    // Serpent Gorge: a sea-level fjord through Tamaru, east of the volcano.
    { pts: [[-2600, 3600, 150], [-1500, 2200, 120], [-200, 1500, 95], [900, 900, 110], [1500, -300, 90], [2000, -1700, 120], [3300, -2900, 170]], floor: -10, slope: 3.2 },
    // Dry canyon through the Tablelands mesas.
    { pts: [[-9200, -600, 120], [-7600, -1200, 90], [-6500, -1500, 70], [-5600, -2300, 85], [-4000, -3200, 130]], floor: 28, slope: 2.6 },
    // Green valley between the Twin Sisters.
    { pts: [[1300, -9100, 200], [1350, -7600, 170], [1600, -6500, 160], [1500, -4700, 220]], floor: 34, slope: 1.1 },
    // Pass through the Kaimana Spine.
    { pts: [[5000, 260, 120], [6350, 1150, 70], [7900, 2200, 120]], floor: 70, slope: 2.4 },
  ]
  const canyons: CanyonSeg[] = []
  for (const def of canyonDefs) {
    for (let i = 0; i < def.pts.length - 1; i++) {
      const [ax, az, wa] = def.pts[i], [bx, bz, wb] = def.pts[i + 1]
      const m = Math.max(wa, wb) + 1400 / def.slope + 120
      canyons.push({ ax, az, bx, bz, wa, wb, floor: def.floor, slope: def.slope,
        minX: Math.min(ax, bx) - m, maxX: Math.max(ax, bx) + m, minZ: Math.min(az, bz) - m, maxZ: Math.max(az, bz) + m })
    }
  }
  return { islands, spires, canyons }
}

const FEATURES = buildFeatures()

export interface IslandInfo { name: string; x: number; z: number; radius: number; height: number }
/** Named islands for minimaps / labels. */
export const ISLANDS: readonly IslandInfo[] = FEATURES.islands.map(i => ({
  name: i.name, x: i.x, z: i.z, radius: Math.max(i.rx, i.rz),
  height: i.peaks.reduce((m, p) => Math.max(m, p.h), 0) + i.hill,
}))

// ---------------------------------------------------------------------------------------------
// Spatial index: 1 km buckets covering the map.

const BUCKET = 1_000
const BN = WORLD_SIZE / BUCKET // 30
interface Bucket { islands: Island[]; spires: Spire[]; canyons: CanyonSeg[]; base: Airbase | null; bound: number }
const buckets: Bucket[] = []
for (let i = 0; i < BN * BN; i++) buckets.push({ islands: [], spires: [], canyons: [], base: null, bound: WATER_LEVEL })

function eachBucket(minX: number, maxX: number, minZ: number, maxZ: number, fn: (b: Bucket) => void) {
  const x0 = Math.max(0, Math.floor((minX + WORLD_HALF) / BUCKET)), x1 = Math.min(BN - 1, Math.floor((maxX + WORLD_HALF) / BUCKET))
  const z0 = Math.max(0, Math.floor((minZ + WORLD_HALF) / BUCKET)), z1 = Math.min(BN - 1, Math.floor((maxZ + WORLD_HALF) / BUCKET))
  for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) fn(buckets[z * BN + x])
}
for (const island of FEATURES.islands) {
  eachBucket(island.x - island.reach, island.x + island.reach, island.z - island.reach, island.z + island.reach, b => {
    b.islands.push(island); b.bound = Math.max(b.bound, island.maxHeight)
  })
}
for (const s of FEATURES.spires) {
  eachBucket(s.x - s.r * 1.6, s.x + s.r * 1.6, s.z - s.r * 1.6, s.z + s.r * 1.6, b => { b.spires.push(s); b.bound = Math.max(b.bound, s.h + 10) })
}
for (const c of FEATURES.canyons) eachBucket(c.minX, c.maxX, c.minZ, c.maxZ, b => b.canyons.push(c))
const BASE_REACH = 2_300
for (const base of AIRBASES) {
  eachBucket(base.center[0] - BASE_REACH, base.center[0] + BASE_REACH, base.center[2] - BASE_REACH, base.center[2] + BASE_REACH, b => {
    b.base = base; b.bound = Math.max(b.bound, BASE_ELEVATION + 170)
  })
}

function bucketAt(x: number, z: number): Bucket | null {
  if (!(x > -WORLD_HALF && x < WORLD_HALF && z > -WORLD_HALF && z < WORLD_HALF)) return null
  return buckets[Math.floor((z + WORLD_HALF) / BUCKET) * BN + Math.floor((x + WORLD_HALF) / BUCKET)]
}

/** Conservative upper bound of the solid surface inside the 1 km cell containing x,z (≥ WATER_LEVEL). */
export function heightBound(x: number, z: number): number {
  const b = bucketAt(x, z)
  return b ? b.bound : WATER_LEVEL
}

/** True if the 1 km tile (tx, tz in tile units, origin at world origin) may contain land or shallows. */
export function tileHasTerrain(tx: number, tz: number): boolean {
  const b = bucketAt(tx * TILE_SIZE + TILE_SIZE / 2, tz * TILE_SIZE + TILE_SIZE / 2)
  return !!b && (b.islands.length > 0 || b.spires.length > 0 || b.base !== null)
}

// ---------------------------------------------------------------------------------------------
// Height functions

function islandHeight(I: Island, x: number, z: number): number {
  const dx = x - I.x, dz = z - I.z
  if (dx > I.reach || dx < -I.reach || dz > I.reach || dz < -I.reach) return SEA_FLOOR
  const u = (dx * I.cos + dz * I.sin) / I.rx
  const v = (-dx * I.sin + dz * I.cos) / I.rz
  const r = Math.sqrt(u * u + v * v)
  if (r > 1.45) return SEA_FLOOR
  const warp = noise2(u * 2.3 + 11.1, v * 2.3 - 3.7, I.seed) * 0.2 + noise2(u * 6.1, v * 6.1, I.seed + 1) * 0.06
  const coast = 1 - r + warp
  const rmin = I.rx < I.rz ? I.rx : I.rz
  const meters = coast * rmin // approximate signed distance to the shoreline
  if (meters < 0) {
    // Gentle turquoise shelf, then dropping to the ocean floor.
    const h = -1.2 + meters * 0.09 + meters * meters * -0.00012
    return h < SEA_FLOOR ? SEA_FLOOR : h
  }
  // Beach (≈0 – 3 m over the first ~50 m), then interior.
  let h = -1.2 + Math.min(meters, 50) * 0.08
  const inland = smooth(30, 30 + rmin * 0.35, meters)
  if (inland <= 0) return h
  const hills = I.hill * inland * (0.55 + 0.45 * noise2(x * 0.0021, z * 0.0021, I.seed + 2))
  let m = 0, volcano = 0
  for (let i = 0; i < I.peaks.length; i++) {
    const p = I.peaks[i]
    const pu = (u - p.u) / p.r, pv = (v - p.v) / p.r
    const t2 = pu * pu + pv * pv
    if (t2 >= 1) continue
    const d = Math.sqrt(t2)
    const f = 1 - d
    if (p.crater) {
      // Cartoon volcano: concave cone, radial ridges, rim and a bowl-shaped crater.
      const c = p.crater
      let ph = p.h * Math.pow(f, 1.6) * (1 + 0.6 * d)
      const ang = Math.atan2(pv, pu)
      const ribs = Math.sin(ang * 13 + noise2(pu * 3, pv * 3, I.seed + 8) * 2.5)
      ph *= 1 + 0.05 * ribs * smooth(c * 1.5, 0.5, d) * (1 - smooth(0.6, 1, d))
      if (d < c * 1.8) {
        const k = d / c
        const rimH = p.h * 0.93
        const inner = rimH - p.h * 0.17 * (1 - k * k)
        ph = k < 1 ? inner : rimH + (ph - rimH) * smooth(1, 1.8, k)
      }
      volcano += ph
      continue
    }
    m += p.h * f * f * (3 - 2 * f)
  }
  if (m > 0) {
    const ridged = 1 - Math.abs(noise2(x * 0.0024 + 7.3, z * 0.0024 - 1.9, I.seed + 3))
    const gully = 1 - Math.abs(noise2(x * 0.0061, z * 0.0061, I.seed + 4))
    m *= 1 - I.rugged * 0.32 + I.rugged * (0.42 * ridged * ridged + 0.12 * gully * gully)
    m *= inland
  }
  m += volcano * inland
  let land = hills + m
  if (I.terrace > 0 && land > 25) {
    const s = land / I.terrace, fl = Math.floor(s), fr = s - fl
    land = (fl + smooth(0.62, 0.95, fr)) * I.terrace * 0.85 + land * 0.15
  }
  h += land + noise2(x * 0.011, z * 0.011, I.seed + 5) * 3.5 * inland
  return h
}

function spireHeight(s: Spire, x: number, z: number): number {
  const dx = x - s.x, dz = z - s.z
  const d = Math.sqrt(dx * dx + dz * dz) / s.r
  if (d > 1.6) return SEA_FLOOR
  const wob = noise2(dx * 0.03, dz * 0.03, s.seed) * 0.12
  const k = d + wob
  // Steep, slightly bulging walls with a rounded jungle cap, and a skirt of rubble at the base.
  const body = 1 - smooth(0.62, 1.0, k)
  const cap = 1 - 0.18 * k * k
  const foot = (1 - smooth(0.9, 1.6, k)) * 14
  return Math.max(-3 + foot, s.h * body * cap)
}

function canyonCarve(c: CanyonSeg, x: number, z: number, h: number): number {
  if (x < c.minX || x > c.maxX || z < c.minZ || z > c.maxZ) return h
  const ex = c.bx - c.ax, ez = c.bz - c.az
  const len2 = ex * ex + ez * ez
  let t = ((x - c.ax) * ex + (z - c.az) * ez) / len2
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const px = x - (c.ax + ex * t), pz = z - (c.az + ez * t)
  const w = c.wa + (c.wb - c.wa) * t
  const d = Math.sqrt(px * px + pz * pz) + noise2(x * 0.007, z * 0.007, WORLD_SEED + 77) * w * 0.35
  const e = d - w
  const carved = e <= 0 ? c.floor : c.floor + c.slope * (e * e) / (e + 30)
  return carved < h ? carved : h
}

/** Airbase island: exactly flat plateau at BASE_ELEVATION, falling to beaches, plus a couple of hills. */
function baseHeight(base: Airbase, x: number, z: number): number {
  const a = worldToBaseA(base, x, z), c = worldToBaseC(base, x, z)
  const F = BASE_LAYOUT.flat
  const da = a < F.a0 ? F.a0 - a : a > F.a1 ? a - F.a1 : 0
  const dc = c < F.c0 ? F.c0 - c : c > F.c1 ? c - F.c1 : 0
  if (da === 0 && dc === 0) return BASE_ELEVATION
  let d = Math.sqrt(da * da + dc * dc)
  d += noise2(x * 0.0035, z * 0.0035, WORLD_SEED + 900 + base.team) * 140 * smooth(0, 260, d)
  let h: number
  if (d < 110) h = BASE_ELEVATION - smooth(0, 110, d) * 13
  else if (d < 200) h = 7 - smooth(110, 200, d) * 8.2
  else h = Math.max(SEA_FLOOR, -1.2 - (d - 200) * 0.09 - (d - 200) * (d - 200) * 0.00012)
  // Two grassy hills on the outboard (left) side, clear of the flight paths.
  const hills: [number, number, number, number][] = [[520, -760, 360, 150], [-640, -700, 300, 110]]
  for (const [ha, hc, hr, hh] of hills) {
    const q = Math.hypot(a - ha, c - hc) / hr
    if (q < 1) {
      const f = 1 - q
      h = Math.max(h, BASE_ELEVATION - 6 + hh * f * f * (3 - 2 * f))
    }
  }
  return h
}

/** Continuous terrain/seabed height (may be below water). */
export function terrainHeight(x: number, z: number): number {
  const b = bucketAt(x, z)
  if (!b) return SEA_FLOOR
  let h = SEA_FLOOR
  if (b.base) {
    const bh = baseHeight(b.base, x, z)
    if (bh === BASE_ELEVATION) return bh
    h = bh
  }
  const islands = b.islands
  for (let i = 0; i < islands.length; i++) {
    const ih = islandHeight(islands[i], x, z)
    if (ih > h) h = ih
  }
  const spires = b.spires
  for (let i = 0; i < spires.length; i++) {
    const sh = spireHeight(spires[i], x, z)
    if (sh > h) h = sh
  }
  if (h > -12) {
    const canyons = b.canyons
    for (let i = 0; i < canyons.length; i++) h = canyonCarve(canyons[i], x, z, h)
  }
  return h
}

// Direct-mapped cache of LOD0 grid vertex heights. Pure memoization: results are identical with or
// without it, it just makes repeated physics queries around the same aircraft cheap.
const CACHE_BITS = 16
const CACHE_MASK = (1 << CACHE_BITS) - 1
const cacheKey = new Int32Array(1 << CACHE_BITS).fill(-0x7fffffff)
const cacheVal = new Float64Array(1 << CACHE_BITS)
const GRID_OFFSET = 4096

function vertexHeight(ix: number, iz: number): number {
  const key = ((ix + GRID_OFFSET) << 13) | (iz + GRID_OFFSET)
  const slot = (Math.imul(key, 0x9e3779b1) >>> (32 - CACHE_BITS)) & CACHE_MASK
  if (cacheKey[slot] === key) return cacheVal[slot]
  const h = terrainHeight(ix * MESH_CELL, iz * MESH_CELL)
  cacheKey[slot] = key
  cacheVal[slot] = h
  return h
}

/**
 * Height of the rendered LOD0 terrain mesh at x,z: exact interpolation of the grid triangles
 * (cell MESH_CELL, diagonal from (x0+1, z0) to (x0, z0+1)). Pass a coarser cell to match other LODs.
 */
export function terrainMeshHeight(x: number, z: number, cell = MESH_CELL): number {
  if (!(x > -WORLD_HALF && x < WORLD_HALF && z > -WORLD_HALF && z < WORLD_HALF)) return SEA_FLOOR
  const gx = x / cell, gz = z / cell
  const ix = Math.floor(gx), iz = Math.floor(gz)
  const u = gx - ix, v = gz - iz
  let a: number, b: number, c: number, d: number
  if (cell === MESH_CELL) {
    b = vertexHeight(ix + 1, iz); c = vertexHeight(ix, iz + 1)
    if (u + v <= 1) { a = vertexHeight(ix, iz); return a + (b - a) * u + (c - a) * v }
    d = vertexHeight(ix + 1, iz + 1); return d + (c - d) * (1 - u) + (b - d) * (1 - v)
  }
  const x0 = ix * cell, z0 = iz * cell
  b = terrainHeight(x0 + cell, z0); c = terrainHeight(x0, z0 + cell)
  if (u + v <= 1) { a = terrainHeight(x0, z0); return a + (b - a) * u + (c - a) * v }
  d = terrainHeight(x0 + cell, z0 + cell); return d + (c - d) * (1 - u) + (b - d) * (1 - v)
}

/** Solid surface height (terrain mesh or water) used by physics. */
export function groundHeight(x: number, z: number): number {
  const b = bucketAt(x, z)
  // Open ocean: no feature within reach of this cell.
  if (!b || (b.islands.length === 0 && b.spires.length === 0 && b.base === null)) return WATER_LEVEL
  const h = terrainMeshHeight(x, z)
  return h > WATER_LEVEL ? h : WATER_LEVEL
}

/** True where the surface at x,z is open water (sea or flooded canyon), per the LOD0 mesh. */
export function isWater(x: number, z: number): boolean {
  const b = bucketAt(x, z)
  if (!b || (b.islands.length === 0 && b.spires.length === 0 && b.base === null)) return true
  return terrainMeshHeight(x, z) <= WATER_LEVEL
}

function nearestBase(x: number, z: number): Airbase | null {
  const b = bucketAt(x, z)
  return b ? b.base : null
}

function inRect(r: { a0: number; a1: number; c0: number; c1: number }, a: number, c: number): boolean {
  const e = 0.01
  return a >= r.a0 - e && a <= r.a1 + e && c >= r.c0 - e && c <= r.c1 + e
}

/** True on runway, taxiways, aprons and helipads. */
export function onRunway(x: number, z: number): boolean {
  const base = nearestBase(x, z)
  if (!base) return false
  const a = worldToBaseA(base, x, z), c = worldToBaseC(base, x, z)
  if (inRect(BASE_LAYOUT.runway, a, c)) return true
  for (const r of BASE_LAYOUT.paved) if (inRect(r, a, c)) return true
  const pr = BASE_LAYOUT.helipadRadius
  for (const [ha, hc] of BASE_LAYOUT.helipads) if ((a - ha) ** 2 + (c - hc) ** 2 <= pr * pr + 0.01) return true
  return false
}

export type SurfaceType = "water" | "sand" | "grass" | "forest" | "rock" | "snow" | "paved"
/** Coarse surface classification (for effects, audio, bots). */
export function surfaceType(x: number, z: number): SurfaceType {
  if (onRunway(x, z)) return "paved"
  const h = terrainMeshHeight(x, z)
  if (h <= WATER_LEVEL) return "water"
  if (h < 4) return "sand"
  if (h > 980) return "snow"
  const e = 6
  const sx = (terrainHeight(x + e, z) - terrainHeight(x - e, z)) / (2 * e)
  const sz = (terrainHeight(x, z + e) - terrainHeight(x, z - e)) / (2 * e)
  const slope = Math.sqrt(sx * sx + sz * sz)
  if (slope > 1.1 || h > 720) return "rock"
  return h > 80 ? "forest" : "grass"
}

/** Inside the team's ellipsoidal safe-zone dome (safeRadius wide, SAFE_ZONE_HEIGHT tall). */
export function inSafeZone(team: TeamId, p: Vec3): boolean {
  const base = AIRBASES[team]
  if (!base) return false
  const dx = (p[0] - base.center[0]) / base.safeRadius
  const dz = (p[2] - base.center[2]) / base.safeRadius
  const dy = Math.max(0, p[1] - base.center[1]) / SAFE_ZONE_HEIGHT
  return dx * dx + dz * dz + dy * dy < 1
}

export interface SpawnPoint {
  position: Vec3
  /** Yaw (rad); 0 = nose toward -Z. */
  yaw: number
  /** True = start on the runway/helipad with gear down; false = air start. */
  onGround: boolean
}

/**
 * Spawn slot for a team's vehicle. index lets multiple vehicles spawn without overlap.
 * Jets line up two abreast from the runway threshold (16 slots, then wrap); helicopters use helipads,
 * spilling onto the helipad apron beyond four.
 */
export function spawnPoint(team: TeamId, kind: VehicleKind, index: number): SpawnPoint {
  const base = AIRBASES[team]
  const i = Math.max(0, Math.floor(index))
  if (kind === "apache") {
    const pads = BASE_LAYOUT.helipads
    const slot = i % 8
    const [pa, pc] = pads[slot % pads.length]
    const [x, z] = baseToWorld(base, pa, slot < pads.length ? pc : pc + 50)
    return { position: [x, BASE_ELEVATION + SPAWN_CLEARANCE.heli, z], yaw: base.heading, onGround: true }
  }
  const slot = i % 16
  const a = BASE_LAYOUT.runway.a0 + 70 + Math.floor(slot / 2) * 75
  const c = slot % 2 === 0 ? -13 : 13
  const [x, z] = baseToWorld(base, a + (slot % 2) * 30, c)
  return { position: [x, BASE_ELEVATION + SPAWN_CLEARANCE.jet, z], yaw: base.heading, onGround: true }
}

// ---------------------------------------------------------------------------------------------
// Segment test

/** Steepest terrain gradient we expect (rise/run); used for safe adaptive marching. */
const MAX_SLOPE = 6

/** Fraction [0,1] along segment a→b where it first goes below the ground surface, or null. */
export function segmentHitsGround(a: Vec3, b: Vec3): number | null {
  const ax = a[0], ay = a[1], az = a[2]
  const dx = b[0] - ax, dy = b[1] - ay, dz = b[2] - az
  const minY = ay < b[1] ? ay : b[1]
  // Fast reject: entire segment above every bound it can touch.
  if (minY > WATER_LEVEL) {
    const horiz = Math.sqrt(dx * dx + dz * dz)
    if (minY > 1300) return null
    let bound = Math.max(heightBound(ax, az), heightBound(b[0], b[2]))
    if (horiz > BUCKET * 0.5) {
      const n = Math.ceil(horiz / (BUCKET * 0.5))
      for (let i = 1; i < n; i++) bound = Math.max(bound, heightBound(ax + dx * i / n, az + dz * i / n))
    }
    if (minY > bound) return null
  }
  const g0 = ay - groundHeight(ax, az)
  if (g0 <= 0) return 0
  const horiz = Math.sqrt(dx * dx + dz * dz)
  const len = Math.sqrt(horiz * horiz + dy * dy)
  if (len < 1e-9) return null
  // Adaptive march: the clearance limits how far we can move before possibly touching the surface.
  const vert = Math.abs(dy) / Math.max(horiz, 1e-9)
  const minStep = Math.min(1, 2 / len)
  let t = 0, gap = g0
  while (t < 1) {
    const safeHoriz = gap / (MAX_SLOPE + vert)
    let step = horiz > 1e-9 ? safeHoriz / horiz : 1
    if (horiz <= 1e-9) step = gap / Math.max(Math.abs(dy), 1e-9) // vertical segment
    if (step < minStep) step = minStep
    let t1 = t + step
    if (t1 > 1) t1 = 1
    const g1 = ay + dy * t1 - groundHeight(ax + dx * t1, az + dz * t1)
    if (g1 <= 0) {
      let lo = t, hi = t1
      for (let k = 0; k < 18; k++) {
        const mid = (lo + hi) * 0.5
        const gm = ay + dy * mid - groundHeight(ax + dx * mid, az + dz * mid)
        if (gm <= 0) hi = mid
        else lo = mid
      }
      return hi
    }
    t = t1
    gap = g1
  }
  return null
}

export const worldQuery: WorldQuery = { groundHeight, onRunway, isWater, half: WORLD_HALF, ceiling: CEILING }
