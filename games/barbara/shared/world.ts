import type { Rect } from "@arcade/kit/sim/geom"

/**
 * The forest as plain data: terrain, lake, camp, trees, rocks, survey markers and the ridge light. Everything here is
 * generated from `WorldParams` alone (no Math.sin/cos/random), so a server and every client build the same world.
 * The renderer reads it through `src/world-view.ts`; the sim reads it for collisions and reach.
 *
 * Axes: x east, z south (north is −z), y up, metres. The playable square is ±`half` on x and z.
 */

export type WorldParams = {
  seed: number
  /** Half the side of the square forest (m). */
  half: number
  /** Trees per 100 m² of open forest. */
  trunkDensity: number
  /** Survey markers hidden in the woods. */
  markerCount: number
}

export const WORLD_DEFAULTS: WorldParams = { seed: 1987, half: 200, trunkDensity: 4.5, markerCount: 4 }

export type TreeSpecies = "pine" | "fir" | "birch" | "snag"
export type Tree = {
  id: number
  x: number
  z: number
  /** Ground height at the trunk (m). */
  y: number
  species: TreeSpecies
  /** Trunk radius at breast height (m). */
  radius: number
  /** Total height (m). */
  height: number
  /** 0..1 per-tree variation for the look (lean, crown shape, tint). */
  seed: number
}
export type Rock = { id: number; x: number; z: number; y: number; w: number; d: number; h: number; yaw: number; seed: number }
export type Building = {
  kind: "cabin" | "mess-hall" | "dock" | "canoe" | "mast" | "table"
  /** Footprint, axis-aligned (m). */
  rect: Rect
  /** Floor (bottom) height and wall height (m). */
  y: number
  h: number
  /** Which faces carry lit windows (`mess-hall` only): n, s, e, w. */
  windows?: string
}
/** A light that belongs to the place, not to a player. */
export type WorldLamp = {
  kind: "window" | "string" | "ridge" | "porch"
  x: number
  y: number
  z: number
  color: readonly [number, number, number]
  /** On-axis intensity in the scene's light units, before the Lab's camp/ridge gain. */
  power: number
  range: number
}
export type Marker = { id: number; x: number; z: number; y: number }
export type Lake = { x: number; z: number; rx: number; rz: number; depth: number; level: number }
export type Trail = { points: readonly (readonly [number, number])[] }

export type WoodsWorld = {
  params: WorldParams
  terrain: TerrainSpec
  lake: Lake
  camp: { x: number; z: number; radius: number; spawn: { x: number; z: number; yaw: number } }
  trail: Trail
  trees: Tree[]
  rocks: Rock[]
  buildings: Building[]
  lamps: WorldLamp[]
  /** Posts the string lights hang between (top of each post); bulbs sag 0.45 m mid-span. */
  stringPosts: (readonly [number, number, number])[]
  markers: Marker[]
  /** The radio mast's blinking red light, the landmark on the north ridge. */
  ridgeLight: { x: number; y: number; z: number }
  /** Spatial hash of `trees` by `GRID` m cells, for collisions and reach. */
  grid: Map<number, number[]>
}

export type TerrainSpec = {
  seed: number
  half: number
  lake: Lake
  camp: { x: number; z: number; radius: number }
  /** Ridge along the north edge: rises from z0 to z1 by `height`. */
  ridge: { z0: number; z1: number; height: number }
  /** Rolling ground amplitude (m) and wavelength (m). */
  roll: number
  wave: number
}

// ---------------------------------------------------------------- deterministic noise (no trig, no Math.random)

function hashU(a: number, b: number, seed: number): number {
  let h = (Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1)) >>> 0
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}
const smooth = (t: number) => t * t * (3 - 2 * t)
function valueNoise(x: number, z: number, seed: number): number {
  const ix = Math.floor(x), iz = Math.floor(z)
  const fx = smooth(x - ix), fz = smooth(z - iz)
  const a = hashU(ix, iz, seed), b = hashU(ix + 1, iz, seed), c = hashU(ix, iz + 1, seed), d = hashU(ix + 1, iz + 1, seed)
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz
}
/** Fractal value noise in −1..1. */
function fbm(x: number, z: number, seed: number, octaves = 3): number {
  let sum = 0, amp = 1, norm = 0
  for (let o = 0; o < octaves; o++) {
    sum += (valueNoise(x, z, seed + o * 101) * 2 - 1) * amp
    norm += amp
    amp *= 0.5
    x *= 2.03
    z *= 2.03
  }
  return sum / norm
}
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))
const smoothstep = (a: number, b: number, v: number) => smooth(clamp((v - a) / (b - a), 0, 1))

/** Seeded generator whose state is one number, so it can live in plain data. */
export function nextRandom(state: { seed: number }): number {
  let t = (state.seed = (state.seed + 0x6d2b79f5) | 0)
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

// ---------------------------------------------------------------- terrain (single source of truth for ground height)

/** Elliptical distance from the lake centre: 1 on the shoreline. */
export function lakeDistance(lake: Lake, x: number, z: number): number {
  return Math.hypot((x - lake.x) / lake.rx, (z - lake.z) / lake.rz)
}

/**
 * Ground height (m) at (x, z). Every system that stands something on the ground uses this: the camera, people, trees,
 * tapes, markers, the terrain mesh and the map's contours.
 */
export function terrainHeight(t: TerrainSpec, x: number, z: number): number {
  const w = t.wave
  let h = 1.6 + t.roll * fbm(x / w, z / w, t.seed, 3) + t.roll * 0.35 * fbm(x / (w * 0.35), z / (w * 0.35), t.seed + 7, 2)
  // North ridge, with a ragged crest.
  const r = smoothstep(t.ridge.z0, t.ridge.z1, -z)
  h += r * t.ridge.height * (0.8 + 0.3 * fbm(x / 70, 3.1, t.seed + 13, 2))
  // Camp terrace: flatten towards a gentle slope down to the water.
  const dc = Math.hypot(x - t.camp.x, z - t.camp.z)
  const flat = 1 - smoothstep(t.camp.radius * 0.55, t.camp.radius * 1.15, dc)
  const campY = 1.1 + clamp((t.camp.z - z) * 0.03, -0.6, 0.8)
  h += (campY - h) * flat
  // Lake basin: shore at the water line, bowl below it.
  const d = lakeDistance(t.lake, x, z)
  if (d < 1.6) {
    const shore = t.lake.level + 0.35
    const bowl = t.lake.level - t.lake.depth * (1 - Math.min(d, 1) ** 2) + 0.35 * d
    const k = smoothstep(1.6, 1.0, d)
    h = h + (Math.min(h, shore) - h) * k
    if (d < 1.05) h = Math.min(h, bowl)
  }
  return h
}

export const groundHeight = (world: WoodsWorld, x: number, z: number) => terrainHeight(world.terrain, x, z)

/** The dock you are standing on at (x, z), if any. */
export function dockAt(world: WoodsWorld, x: number, z: number): Building | undefined {
  return world.buildings.find((b) => b.kind === "dock" && x >= b.rect[0] && x <= b.rect[2] && z >= b.rect[1] && z <= b.rect[3])
}

/** Height a person's feet rest at: the ground, or the dock's deck over the water. */
export function standHeight(world: WoodsWorld, x: number, z: number): number {
  const g = groundHeight(world, x, z)
  const dock = dockAt(world, x, z)
  return dock ? Math.max(g, dock.y + dock.h) : g
}

/** Water deeper than this is not walkable (m). */
export const WADE_DEPTH = 0.45
export function isDeepWater(world: WoodsWorld, x: number, z: number): boolean {
  return lakeDistance(world.lake, x, z) < 1.1 && groundHeight(world, x, z) < world.lake.level - WADE_DEPTH && !dockAt(world, x, z)
}

// ---------------------------------------------------------------- generation

export const GRID = 10
const cellKey = (ix: number, iz: number) => (ix + 512) * 1024 + (iz + 512)

function distToSegment(px: number, pz: number, a: readonly [number, number], b: readonly [number, number]) {
  const vx = b[0] - a[0], vz = b[1] - a[1]
  const t = clamp(((px - a[0]) * vx + (pz - a[1]) * vz) / (vx * vx + vz * vz || 1), 0, 1)
  return { d: Math.hypot(px - a[0] - vx * t, pz - a[1] - vz * t), t }
}
/** Distance to the trail and how far along it (0 at camp, 1 at its end). */
export function trailDistance(trail: Trail, x: number, z: number): { d: number; along: number } {
  let best = Infinity, along = 0
  const n = trail.points.length - 1
  for (let i = 0; i < n; i++) {
    const s = distToSegment(x, z, trail.points[i]!, trail.points[i + 1]!)
    if (s.d < best) { best = s.d; along = (i + s.t) / n }
  }
  return { d: best, along }
}

export function makeWorld(params: Partial<WorldParams> = {}): WoodsWorld {
  const p: WorldParams = { ...WORLD_DEFAULTS, ...params }
  const { half, seed } = p
  const lake: Lake = { x: -30, z: 118, rx: 58, rz: 40, depth: 3.2, level: 0 }
  const campZ = lake.z - lake.rz - 16
  const camp = { x: lake.x + 4, z: campZ, radius: 34 }
  const terrain: TerrainSpec = { seed, half, lake, camp, ridge: { z0: 70, z1: 185, height: 24 }, roll: 3.2, wave: 75 }
  const rng = { seed: seed * 7919 + 17 }
  const ground = (x: number, z: number) => terrainHeight(terrain, x, z)

  // An old footpath out of camp that fades into the trees.
  const trail: Trail = { points: [[camp.x + 2, camp.z - 22], [camp.x + 10, camp.z - 52], [camp.x + 4, camp.z - 82], [camp.x + 22, camp.z - 110], [camp.x + 38, camp.z - 140], [camp.x + 36, camp.z - 165]] }

  // Camp: a row of cabins facing the lake, the mess hall at the west end, a dock into the water.
  const buildings: Building[] = []
  const lamps: WorldLamp[] = []
  const cabinZ = camp.z - 6
  const cabinXs = [-2, 9, 20]
  for (const cx of cabinXs) {
    const x = camp.x + cx
    buildings.push({ kind: "cabin", rect: [x - 2.2, cabinZ - 2.8, x + 2.2, cabinZ + 2.8], y: ground(x, cabinZ) - 0.2, h: 2.6 })
  }
  const messX = camp.x - 18, messZ = camp.z - 4
  buildings.push({ kind: "mess-hall", rect: [messX - 6.5, messZ - 4.5, messX + 6.5, messZ + 4.5], y: ground(messX, messZ) - 0.25, h: 3.4, windows: "nsew" })
  const dockX = camp.x + 4, shoreZ = lake.z - lake.rz
  buildings.push({ kind: "dock", rect: [dockX - 1.1, shoreZ - 3, dockX + 1.1, shoreZ + 13], y: lake.level + 0.35, h: 0.18 })
  buildings.push({ kind: "canoe", rect: [dockX + 3, shoreZ - 4.5, dockX + 3.8, shoreZ - 0.5], y: ground(dockX + 3.4, shoreZ - 2.5), h: 0.35 })
  buildings.push({ kind: "canoe", rect: [dockX + 4.6, shoreZ - 5, dockX + 5.4, shoreZ - 1], y: ground(dockX + 5, shoreZ - 3), h: 0.35 })
  buildings.push({ kind: "table", rect: [camp.x + 5, camp.z + 4, camp.x + 7.2, camp.z + 5], y: ground(camp.x + 6, camp.z + 4.5), h: 0.75 })
  // Light spilling from the mess hall's lit windows: one source just outside each pair of panes.
  for (const [wx, wz] of [[-3.2, -5.3], [3.2, -5.3], [-3.2, 5.3], [3.2, 5.3], [-7.3, 0], [7.3, 0]] as const)
    lamps.push({ kind: "window", x: messX + wx, y: ground(messX, messZ) + 1.5, z: messZ + wz, color: [1, 0.55, 0.22], power: 3, range: 16 })
  // String lights along the cabin fronts, sagging between posts; a few bulbs are dead.
  const stringPosts: (readonly [number, number, number])[] = []
  const sx0 = camp.x - 9, sx1 = camp.x + 24, sz = cabinZ + 4.4
  for (let i = 0, n = 22; i <= n; i++) {
    const t = i / n, x = sx0 + (sx1 - sx0) * t, span = (t * 4) % 1
    if (hashU(i, 3, seed) < 0.2) continue
    lamps.push({ kind: "string", x, y: ground(x, sz) + 2.7 - 0.45 * 4 * span * (1 - span), z: sz, color: [1, 0.7, 0.35], power: 0.22, range: 5 })
  }
  for (let k = 0; k <= 4; k++) { const x = sx0 + ((sx1 - sx0) * k) / 4; stringPosts.push([x, ground(x, sz) + 2.7, sz]) }
  for (const cx of cabinXs) lamps.push({ kind: "porch", x: camp.x + cx, y: ground(camp.x + cx, cabinZ + 3) + 2.4, z: cabinZ + 3.1, color: [1, 0.62, 0.3], power: 0.5, range: 7 })

  // The ridge mast and its red light.
  const mastX = 62, mastZ = -178
  const mastY = ground(mastX, mastZ)
  buildings.push({ kind: "mast", rect: [mastX - 0.6, mastZ - 0.6, mastX + 0.6, mastZ + 0.6], y: mastY, h: 48 })
  const ridgeLight = { x: mastX, y: mastY + 48.5, z: mastZ }

  // Survey markers: well out from camp and from each other.
  const markers: Marker[] = []
  for (let tries = 0; markers.length < p.markerCount && tries < 4000; tries++) {
    const x = (nextRandom(rng) * 2 - 1) * (half - 22)
    const z = (nextRandom(rng) * 2 - 1) * (half - 22)
    if (Math.hypot(x - camp.x, z - camp.z) < 105 || lakeDistance(lake, x, z) < 1.4) continue
    if (markers.some((m) => Math.hypot(m.x - x, m.z - z) < 120)) continue
    if (Math.hypot(x - mastX, z - mastZ) < 30) continue
    markers.push({ id: markers.length + 1, x, z, y: ground(x, z) })
  }

  // Trees on a jittered grid, thinned by clearings, the camp, the lake and the trail.
  const trees: Tree[] = []
  const spacing = Math.sqrt(100 / Math.max(0.3, p.trunkDensity))
  const n = Math.ceil((half * 2) / spacing)
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const x = -half + (i + 0.15 + 0.7 * hashU(i, j, seed + 1)) * spacing
    const z = -half + (j + 0.15 + 0.7 * hashU(i, j, seed + 2)) * spacing
    const keep = hashU(i, j, seed + 3)
    // Low-frequency clearings and thickets, so density varies but no place is a landmark.
    const thick = valueNoise(x / 38, z / 38, seed + 5)
    if (keep < 0.12 + 0.22 * smoothstep(0.55, 0.15, thick)) continue
    if (lakeDistance(lake, x, z) < 1.12) continue
    if (Math.hypot(x - camp.x, z - camp.z) < camp.radius) continue
    const tr = trailDistance(trail, x, z)
    if (tr.d < 1.9 && keep < 1.15 - tr.along) continue
    if (markers.some((m) => Math.hypot(m.x - x, m.z - z) < 2.2)) continue
    if (Math.hypot(x - mastX, z - mastZ) < 4) continue
    const s = hashU(i, j, seed + 4)
    const y = ground(x, z)
    const species: TreeSpecies = s < 0.5 ? "pine" : s < 0.8 ? "fir" : s < 0.92 ? "birch" : "snag"
    const size = 0.75 + 0.5 * hashU(i, j, seed + 6)
    const height = (species === "birch" ? 13 : species === "snag" ? 9 : species === "fir" ? 17 : 22) * size
    const radius = (species === "birch" ? 0.13 : species === "fir" ? 0.24 : species === "snag" ? 0.2 : 0.26) * (0.75 + 0.5 * hashU(i, j, seed + 8))
    trees.push({ id: trees.length, x, z, y, species, radius, height, seed: hashU(i, j, seed + 9) })
  }

  const rocks: Rock[] = []
  for (let k = 0; rocks.length < 420 && k < 4000; k++) {
    const x = (nextRandom(rng) * 2 - 1) * half, z = (nextRandom(rng) * 2 - 1) * half
    if (lakeDistance(lake, x, z) < 1.15 || Math.hypot(x - camp.x, z - camp.z) < camp.radius * 0.8) continue
    if (trailDistance(trail, x, z).d < 2.5) continue
    const big = nextRandom(rng)
    const w = 0.5 + 2.2 * big * big, d = w * (0.6 + 0.6 * nextRandom(rng)), h = 0.25 + 1.1 * big * nextRandom(rng)
    rocks.push({ id: rocks.length, x, z, y: ground(x, z), w, d, h, yaw: nextRandom(rng) * Math.PI, seed: nextRandom(rng) })
  }

  const grid = new Map<number, number[]>()
  for (const t of trees) {
    const key = cellKey(Math.floor(t.x / GRID), Math.floor(t.z / GRID))
    let list = grid.get(key)
    if (!list) grid.set(key, (list = []))
    list.push(t.id)
  }

  return {
    params: p, terrain, lake, trail, trees, rocks, buildings, lamps, stringPosts, markers, ridgeLight, grid,
    // You start on the lakefront under the string lights, facing the cabins, the mess hall and the woods behind them.
    camp: { ...camp, spawn: { x: camp.x + 3, z: camp.z + 2, yaw: 0.4 } },
  }
}

/** Trees whose trunks lie within `r` of (x, z). */
export function treesNear(world: WoodsWorld, x: number, z: number, r: number, out: Tree[] = []): Tree[] {
  out.length = 0
  const x0 = Math.floor((x - r) / GRID), x1 = Math.floor((x + r) / GRID)
  const z0 = Math.floor((z - r) / GRID), z1 = Math.floor((z + r) / GRID)
  for (let i = x0; i <= x1; i++) for (let j = z0; j <= z1; j++) {
    const list = world.grid.get(cellKey(i, j))
    if (!list) continue
    for (const id of list) {
      const t = world.trees[id]!
      if (Math.hypot(t.x - x, t.z - z) <= r + t.radius) out.push(t)
    }
  }
  return out
}

/**
 * The state forest's boundary fence runs this far inside the map's edge all round (`boundaryLine`): a rusted wire fence
 * with posted signs, the line you can't cross, drawn on the held map as the boundary.
 */
export const BOUNDARY_INSET = 3
/** Where the boundary fence stands: |x| and |z| up to this. */
export const boundaryLine = (world: WoodsWorld) => world.params.half - BOUNDARY_INSET

/** Solid footprints near (x, z) for `stepBody`: trunks, rocks, buildings and the boundary fence. */
export function solidsNear(world: WoodsWorld, x: number, z: number, r = 4): Rect[] {
  const out: Rect[] = []
  for (const t of treesNear(world, x, z, r)) {
    const s = t.radius * 0.9
    out.push([t.x - s, t.z - s, t.x + s, t.z + s])
  }
  for (const k of world.rocks) {
    if (k.h < 0.45 || Math.abs(k.x - x) > r + k.w || Math.abs(k.z - z) > r + k.w) continue
    const e = Math.max(k.w, k.d) * 0.42
    out.push([k.x - e, k.z - e, k.x + e, k.z + e])
  }
  for (const b of world.buildings) {
    if (b.kind === "dock" || b.kind === "canoe") continue
    const [x0, z0, x1, z1] = b.rect
    if (x < x0 - r || x > x1 + r || z < z0 - r || z > z1 + r) continue
    out.push(b.rect)
  }
  const h = boundaryLine(world)
  if (x < -h + r) out.push([-h - 2, -h - 2, -h, h + 2])
  if (x > h - r) out.push([h, -h - 2, h + 2, h + 2])
  if (z < -h + r) out.push([-h - 2, -h - 2, h + 2, -h])
  if (z > h - r) out.push([-h - 2, h, h + 2, h + 2])
  return out
}
