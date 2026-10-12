// World geography — owned by the World agent. Pure, deterministic, dependency-free (server safe).
//
// A 16 × 16 km procedurally generated archipelago (ISLANDERS-style terraced islands). On first use
// the module bakes a heightmap on a jittered triangle grid (MESH_CELL spacing):
//   seeded island masks (domain-warped) → fBm + ridged mountains + a couple of central peaks →
//   carved canyons → droplet erosion + thermal smoothing → terracing → flat airbase plateaus.
// The rendered LOD0 mesh uses exactly these vertices and triangles, and every physics query
// interpolates the same triangles, so collision always matches what players see.
import type { TeamId, Vec3, VehicleKind, WorldQuery } from "./types"

export const WORLD_SIZE = 16_000
export const WORLD_HALF = WORLD_SIZE / 2
export const WATER_LEVEL = 0
export const CEILING = 4_000
export const WORLD_SEED = 0x57494e47 // "WING"

/** Ocean floor depth far from land. */
export const SEA_FLOOR = -40
/** Grid spacing of the collision/LOD0 mesh (vertices are jittered by up to JITTER × cell). */
export const MESH_CELL = 25
export const MESH_SEGMENTS = WORLD_SIZE / MESH_CELL // 640 cells per side
/** Fraction of a cell each vertex may be displaced in x/z (irregular low-poly facets). */
export const JITTER = 0.26
/** Safe zone: everything within safeRadius of the runway centre-line, under a dome SAFE_ZONE_HEIGHT tall. */
export const SAFE_ZONE_HEIGHT = 400
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
  /** Protected distance from the runway centre-line segment (capsule), see inSafeZone. */
  safeRadius: number
  /** Helipad positions (y = pad elevation). */
  helipads: Vec3[]
}

const BASE_DISTANCE = 5_500
const BASE_ELEVATION = 20

/** Paved areas in base-local coordinates: a = along takeoff direction (+a toward map center), c = to the right. */
export interface PavedRect { a0: number; a1: number; c0: number; c1: number; kind: "runway" | "taxiway" | "apron" }
export const BASE_LAYOUT = {
  runway: { a0: -700, a1: 700, c0: -30, c1: 30, kind: "runway" } as PavedRect,
  paved: [
    { a0: -650, a1: 650, c0: 130, c1: 152, kind: "taxiway" },
    { a0: -650, a1: -628, c0: 30, c1: 152, kind: "taxiway" },
    { a0: 628, a1: 650, c0: 30, c1: 152, kind: "taxiway" },
    { a0: -11, a1: 11, c0: 30, c1: 152, kind: "taxiway" },
    { a0: -420, a1: 160, c0: 152, c1: 310, kind: "apron" },
    { a0: 200, a1: 500, c0: 152, c1: 280, kind: "apron" },
  ] as PavedRect[],
  /** Helipad centers (a, c) and radius. */
  helipads: [[240, 216], [310, 216], [380, 216], [450, 216]] as [number, number][],
  helipadRadius: 15,
  /** Perfectly flat plateau around the runway, aprons and buildings. */
  flat: { a0: -900, a1: 900, c0: -200, c1: 520 },
}

export const AIRBASES: Airbase[] = ([0, 1, 2, 3] as TeamId[]).map(team => {
  // Team 0 south (+Z), 1 north (-Z), 2 west (-X), 3 east (+X); runways point toward the center.
  const dir = [[0, 1], [0, -1], [-1, 0], [1, 0]][team]
  const center: Vec3 = [dir[0] * BASE_DISTANCE, BASE_ELEVATION, dir[1] * BASE_DISTANCE]
  const heading = Math.atan2(dir[0], dir[1]) // yaw so that -Z (nose) faces the center
  const base: Airbase = { team, center, heading, runwayLength: 1_400, runwayWidth: 60, safeRadius: 500, helipads: [] }
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
// Headings are exact multiples of π/2, so sin/cos are cached per team.
const BASE_SIN = [0, 0, -1, 1], BASE_COS = [1, -1, 0, 0]
function worldToBaseA(base: Airbase, x: number, z: number): number {
  return -(x - base.center[0]) * BASE_SIN[base.team] - (z - base.center[2]) * BASE_COS[base.team]
}
function worldToBaseC(base: Airbase, x: number, z: number): number {
  return (x - base.center[0]) * BASE_COS[base.team] - (z - base.center[2]) * BASE_SIN[base.team]
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

function fbm(x: number, z: number, seed: number, octaves: number): number {
  let sum = 0, amp = 0.5, f = 1
  for (let o = 0; o < octaves; o++) { sum += noise2(x * f, z * f, seed + o * 101) * amp; f *= 2.03; amp *= 0.5 }
  return sum
}

function ridged(x: number, z: number, seed: number, octaves: number): number {
  let sum = 0, amp = 0.5, f = 1, w = 1
  for (let o = 0; o < octaves; o++) {
    let n = 1 - Math.abs(noise2(x * f, z * f, seed + o * 131))
    n *= n * w
    w = Math.min(1, n * 2)
    sum += n * amp; f *= 2.1; amp *= 0.5
  }
  return sum
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
// Island layout (cheap, computed eagerly)

export interface IslandInfo { name: string; x: number; z: number; radius: number; height: number }
interface Blob { x: number; z: number; r: number; amp: number }
interface Peak { x: number; z: number; r: number; h: number }

function nearBase(x: number, z: number, margin: number): boolean {
  for (const b of AIRBASES) if (Math.hypot(x - b.center[0], z - b.center[2]) < margin) return true
  return false
}

function layout(seed: number) {
  const rand = seededRandom(seed ^ 0x15a7d)
  const blobs: Blob[] = []
  const names: IslandInfo[] = []
  // Big central island, made of a few overlapping lobes.
  blobs.push({ x: 0, z: 0, r: 2500, amp: 1 })
  for (let i = 0; i < 3; i++) {
    const a = rand() * Math.PI * 2, d = 700 + rand() * 900
    blobs.push({ x: Math.cos(a) * d, z: Math.sin(a) * d, r: 1100 + rand() * 700, amp: 0.85 })
  }
  names.push({ name: "Mainland", x: 0, z: 0, radius: 2600, height: 0 })
  // Medium islands on the diagonals between bases, plus a couple on the axes.
  const mediums = 7 + Math.floor(rand() * 2)
  for (let i = 0; i < mediums; i++) {
    for (let tries = 0; tries < 40; tries++) {
      const a = (i / mediums) * Math.PI * 2 + Math.PI / 4 + (rand() - 0.5) * 0.7
      const d = 3600 + rand() * 1700
      const x = Math.cos(a) * d, z = Math.sin(a) * d
      const r = 800 + rand() * 700
      if (nearBase(x, z, 1400 + r)) continue
      if (Math.abs(x) > WORLD_HALF - r - 400 || Math.abs(z) > WORLD_HALF - r - 400) continue
      blobs.push({ x, z, r, amp: 0.75 + rand() * 0.3 })
      names.push({ name: `Isle ${names.length}`, x, z, radius: r, height: 0 })
      break
    }
  }
  // Islets scattered everywhere except the runways.
  for (let i = 0, tries = 0; i < 26 && tries < 2000; tries++) {
    const x = (rand() * 2 - 1) * (WORLD_HALF - 700), z = (rand() * 2 - 1) * (WORLD_HALF - 700)
    const r = 180 + rand() * 380
    if (nearBase(x, z, 1300 + r)) continue
    if (Math.hypot(x, z) < 2600) continue
    blobs.push({ x, z, r, amp: 0.45 + rand() * 0.45 })
    i++
  }
  // Low base islands: a chain of blobs along each runway (flattened later).
  for (const b of AIRBASES) {
    for (const a of [-750, -250, 250, 750]) {
      const [x, z] = baseToWorld(b, a + (rand() - 0.5) * 200, 160 + (rand() - 0.5) * 380)
      blobs.push({ x, z, r: 560 + rand() * 260, amp: 0.5 })
    }
  }
  // A couple of tall peaks near the centre.
  const peaks: Peak[] = []
  for (let i = 0; i < 2; i++) {
    // On the diagonals, so the four departure corridors (cardinal axes) stay low.
    const a = Math.PI / 4 + (Math.floor(rand() * 4) + i * 2) * Math.PI / 2 + (rand() - 0.5) * 0.2, d = 1750 + rand() * 350
    peaks.push({ x: Math.cos(a) * d, z: Math.sin(a) * d, r: 1050 + rand() * 300, h: 470 - i * 90 + rand() * 90 })
  }
  return { blobs, peaks, names }
}

let layoutSeed = WORLD_SEED
let LAYOUT = layout(layoutSeed)
/** Named islands for minimaps / labels. */
export const ISLANDS: IslandInfo[] = LAYOUT.names

// ---------------------------------------------------------------------------------------------
// Heightmap bake (lazy, cached)

const N = MESH_SEGMENTS
const STRIDE = N + 1
const BOUND_BLOCK = 500
const BN = WORLD_SIZE / BOUND_BLOCK

interface Baked {
  seed: number
  /** Vertex heights. */
  h: Float32Array
  /** Vertex world x/z (jittered). */
  vx: Float32Array
  vz: Float32Array
  /** Per-cell diagonal: 0 = b–c (triangles a,c,b / b,c,d), 1 = a–d (a,c,d / a,d,b). */
  diag: Uint8Array
  /** Max surface height per 500 m block. */
  bound: Float32Array
  ms: number
}

let baked: Baked | null = null

/** Rebuild the world for another seed (e.g. per room). Clears the cached heightmap. */
export function setWorldSeed(seed: number) {
  if (seed === layoutSeed && LAYOUT) return
  layoutSeed = seed | 0
  LAYOUT = layout(layoutSeed)
  ISLANDS.length = 0
  ISLANDS.push(...LAYOUT.names)
  baked = null
}

/** Base plateau metrics: signed distance (m) outside the flat rectangle of the nearest base. */
function baseFlatDistance(x: number, z: number): number {
  let best = Infinity
  const F = BASE_LAYOUT.flat
  for (const b of AIRBASES) {
    const dx = x - b.center[0], dz = z - b.center[2]
    if (dx * dx + dz * dz > 2500 * 2500) continue
    const a = worldToBaseA(b, x, z), c = worldToBaseC(b, x, z)
    const da = Math.max(F.a0 - a, a - F.a1, 0), dc = Math.max(F.c0 - c, c - F.c1, 0)
    const d = da === 0 && dc === 0 ? -Math.min(a - F.a0, F.a1 - a, c - F.c0, F.c1 - c) : Math.hypot(da, dc)
    if (d < best) best = d
  }
  return best
}

/** Corridor glide-slope: terrain within ±CORRIDOR_HALF of a runway's extended centre-line, out to
 * CORRIDOR_LENGTH from the base centre, stays below corridorFloor(d). */
export const CORRIDOR_HALF = 300
export const CORRIDOR_LENGTH = 7_000
export function corridorFloor(d: number): number {
  return BASE_ELEVATION + 0.05 * Math.max(0, d - 900)
}
const corridorScratch = { hard: Infinity }
function corridorLimit(x: number, z: number) {
  corridorScratch.hard = Infinity
  for (const b of AIRBASES) {
    const a = worldToBaseA(b, x, z)
    if (a < 600 || a > CORRIDOR_LENGTH + 600) continue
    const c = Math.abs(worldToBaseC(b, x, z))
    const floor = corridorFloor(a) - 6
    // Hard band a little wider than the corridor so interpolated triangles stay below the floor.
    if (c < CORRIDOR_HALF + 2 * MESH_CELL) corridorScratch.hard = Math.min(corridorScratch.hard, floor)
  }
  return corridorScratch
}

/** 0 inside a departure corridor, rising to 1 over a broad, noise-warped valley shoulder. */
function corridorOpen(x: number, z: number, seed: number): { t: number; floor: number } {
  let t = 1, floor = Infinity
  for (const b of AIRBASES) {
    const a = worldToBaseA(b, x, z)
    if (a < 300 || a > CORRIDOR_LENGTH + 1500) continue
    let c = Math.abs(worldToBaseC(b, x, z)) - CORRIDOR_HALF - 2 * MESH_CELL
    if (c > 0) c += noise2(x * 0.0015, z * 0.0015, seed + 61 + b.team) * 260 * smooth(0, 300, c)
    // Ease out of the corridor beyond its far end and near the runway.
    const ends = Math.max(smooth(CORRIDOR_LENGTH, CORRIDOR_LENGTH + 1500, a), 1 - smooth(300, 900, a))
    const tt = Math.max(ends, smooth(0, 650, c))
    if (tt < t) { t = tt; floor = corridorFloor(a) - 8 }
  }
  return { t, floor }
}

const TERRACES = [3.5, 22, 52, 95, 150, 225, 320, 440, 590, 760]

function terrace(h: number, wobble: number): number {
  if (h <= TERRACES[0]) return h
  const hh = h + wobble
  for (let k = 0; k < TERRACES.length - 1; k++) {
    const lo = TERRACES[k], hi = TERRACES[k + 1]
    if (hh < hi) {
      const f = (hh - lo) / (hi - lo)
      // Mostly flat shelf, then a steep riser to the next level.
      return Math.max(TERRACES[0], lo + (hi - lo) * (0.15 * f + 0.85 * smooth(0.55, 0.98, f)) - wobble * 0.1)
    }
  }
  return hh
}

function bake(seed: number): Baked {
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now()
  const { blobs, peaks } = LAYOUT
  const h = new Float32Array(STRIDE * STRIDE)
  const vx = new Float32Array(STRIDE * STRIDE)
  const vz = new Float32Array(STRIDE * STRIDE)
  const diag = new Uint8Array(N * N)
  const land = new Float32Array(STRIDE * STRIDE)

  // Coarse blob index (500 m blocks): ocean vertices skip all the noise work.
  const IB = 500, IN = WORLD_SIZE / IB
  const blobIndex: Blob[][] = []
  for (let bz = 0; bz < IN; bz++) for (let bx = 0; bx < IN; bx++) {
    const cx = -WORLD_HALF + (bx + 0.5) * IB, cz = -WORLD_HALF + (bz + 0.5) * IB
    // Warp displacement ≤ 0.94 × 800 m; block half-diagonal ≈ 354 m.
    blobIndex.push(blobs.filter(B => Math.hypot(cx - B.x, cz - B.z) < B.r * 1.2 + 760 + 360))
  }
  // 1. Jittered vertex positions + base elevation field.
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      const k = j * STRIDE + i
      const edge = i === 0 || j === 0 || i === N || j === N
      const jx = edge ? 0 : (hash2(i, j, seed ^ 0x1111) - 0.5) * 2 * JITTER * MESH_CELL
      const jz = edge ? 0 : (hash2(i, j, seed ^ 0x2222) - 0.5) * 2 * JITTER * MESH_CELL
      const x = -WORLD_HALF + i * MESH_CELL + jx, z = -WORLD_HALF + j * MESH_CELL + jz
      vx[k] = x; vz[k] = z
      const near = blobIndex[Math.min(IN - 1, Math.floor((z + WORLD_HALF) / IB)) * IN + Math.min(IN - 1, Math.floor((x + WORLD_HALF) / IB))]
      if (near.length === 0) { h[k] = SEA_FLOOR; continue }
      // Domain-warped island mask.
      const wx = x + fbm(x * 0.00045, z * 0.00045, seed + 7, 4) * 800
      const wz = z + fbm(x * 0.00045 + 31.7, z * 0.00045 - 12.3, seed + 9, 4) * 800
      let m = 0
      for (let b = 0; b < near.length; b++) {
        const B = near[b]
        const dx = wx - B.x, dz = wz - B.z
        const d2 = (dx * dx + dz * dz) / (B.r * B.r)
        if (d2 >= 1.44) continue
        const v = (1 - smooth(0.25, 1.2, Math.sqrt(d2))) * B.amp
        if (v > m) m = v
      }
      // Bays and headlands: carve the mask with mid-frequency noise.
      if (m > 0) m -= (fbm(x * 0.0016, z * 0.0016, seed + 13, 3) * 0.5 + 0.25) * 0.42 * smooth(0, 0.6, m) * (1 - smooth(0.6, 1, m) * 0.5)
      if (m <= 0.001) { h[k] = SEA_FLOOR; continue }
      land[k] = m
      // Rolling hills + ridged mountains growing toward island cores.
      const hills = (fbm(x * 0.0011, z * 0.0011, seed + 21, 4) * 0.5 + 0.5) * 120
      const mtn = ridged(wx * 0.0005, wz * 0.0005, seed + 33, 4) * 260 * smooth(0.45, 1, m)
      let e = -30 + m * 95 + (hills + mtn) * smooth(0.2, 0.75, m)
      for (const P of peaks) {
        const d = Math.hypot(x - P.x, z - P.z) / P.r
        if (d < 1) { const f = 1 - d; e += P.h * f * f * (3 - 2 * f) * (0.8 + 0.4 * ridged(x * 0.002, z * 0.002, seed + 41, 2)) }
      }
      // Canyons: warped ridged-noise channels carved down to sea level (fly-through fjords).
      const cn = Math.abs(noise2(wx * 0.00042 + 5.1, wz * 0.00042 - 2.7, seed + 55))
      const ch = 1 - smooth(0.035, 0.09, cn)
      if (ch > 0 && e > -2) e = e + (Math.min(e, -4 + cn * 120) - e) * ch * smooth(0.25, 0.5, m)
      const co = corridorOpen(x, z, seed)
      if (co.t < 1 && e > co.floor) e = co.floor + (e - co.floor) * co.t
      h[k] = Math.max(SEA_FLOOR, e)
    }
  }
  // 2. Droplet hydraulic erosion (gullies, softened slopes), on land only.
  erode(h, land, seed)
  // 3. One thermal pass to knock down single-vertex spikes.
  const talus = 38
  for (let j = 1; j < N; j++) for (let i = 1; i < N; i++) {
    const k = j * STRIDE + i
    const avg = (h[k - 1] + h[k + 1] + h[k - STRIDE] + h[k + STRIDE]) * 0.25
    if (h[k] - avg > talus) h[k] = avg + talus
  }
  // 3b. Two smoothing passes on land so terrace edges come out as clean, sweeping contours.
  const tmp = new Float32Array(h.length)
  for (let pass = 0; pass < 2; pass++) {
    tmp.set(h)
    for (let j = 1; j < N; j++) for (let i = 1; i < N; i++) {
      const k = j * STRIDE + i
      if (tmp[k] <= 0) continue
      h[k] = tmp[k] * 0.4 + (tmp[k - 1] + tmp[k + 1] + tmp[k - STRIDE] + tmp[k + STRIDE]) * 0.15
    }
  }
  // 4. Terraces + airbase plateaus.
  for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
    const k = j * STRIDE + i
    const x = vx[k], z = vz[k]
    let y = h[k]
    // Departure corridors: soft valley along each runway's extended centre-line.
    const lim = corridorLimit(x, z)
    if (y > 0) y = terrace(y, noise2(x * 0.0009, z * 0.0009, seed + 77) * 9)
    if (y > lim.hard) y = lim.hard
    const bd = baseFlatDistance(x, z)
    if (bd < 420) {
      if (bd <= 0) y = BASE_ELEVATION
      else {
        // Grassy plateau shoulder easing into the natural island around it.
        const t = smooth(60, 420, bd + noise2(x * 0.006, z * 0.006, seed + 91) * 50)
        y = BASE_ELEVATION + (y - BASE_ELEVATION) * t
        if (bd < 60) y = BASE_ELEVATION
      }
    }
    h[k] = y
  }
  // 5. Triangulation diagonals and coarse bounds.
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) diag[j * N + i] = hash2(i, j, seed ^ 0x3333) < 0.5 ? 0 : 1
  const bound = new Float32Array(BN * BN).fill(WATER_LEVEL)
  for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
    const k = j * STRIDE + i
    const bx = Math.min(BN - 1, Math.floor((vx[k] + WORLD_HALF) / BOUND_BLOCK))
    const bz = Math.min(BN - 1, Math.floor((vz[k] + WORLD_HALF) / BOUND_BLOCK))
    // A vertex can shape triangles reaching into neighbouring blocks.
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const X = bx + dx, Z = bz + dz
      if (X < 0 || Z < 0 || X >= BN || Z >= BN) continue
      const o = Z * BN + X
      if (h[k] > bound[o]) bound[o] = h[k]
    }
  }
  const ms = (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0
  return { seed, h, vx, vz, diag, bound, ms }
}

function erode(h: Float32Array, land: Float32Array, seed: number) {
  const rand = seededRandom(seed ^ 0xe40d)
  const drops = 26_000
  const inertia = 0.3, capacityK = 3, depositK = 0.3, erodeK = 0.25, evap = 0.03, gravity = 4, maxSteps = 40
  const hAt = (x: number, y: number) => {
    const i = x | 0, j = y | 0, u = x - i, v = y - j, k = j * STRIDE + i
    return h[k] * (1 - u) * (1 - v) + h[k + 1] * u * (1 - v) + h[k + STRIDE] * (1 - u) * v + h[k + STRIDE + 1] * u * v
  }
  for (let d = 0; d < drops; d++) {
    let x = 1 + rand() * (N - 2), y = 1 + rand() * (N - 2)
    if (land[(y | 0) * STRIDE + (x | 0)] < 0.3) continue
    let dx = 0, dy = 0, speed = 1, water = 1, sediment = 0
    for (let s = 0; s < maxSteps; s++) {
      const i = x | 0, j = y | 0, u = x - i, v = y - j, k = j * STRIDE + i
      const h00 = h[k], h10 = h[k + 1], h01 = h[k + STRIDE], h11 = h[k + STRIDE + 1]
      const gx = (h10 - h00) * (1 - v) + (h11 - h01) * v
      const gy = (h01 - h00) * (1 - u) + (h11 - h10) * u
      const hOld = h00 * (1 - u) * (1 - v) + h10 * u * (1 - v) + h01 * (1 - u) * v + h11 * u * v
      dx = dx * inertia - gx * (1 - inertia)
      dy = dy * inertia - gy * (1 - inertia)
      const len = Math.hypot(dx, dy)
      if (len < 1e-6) break
      dx /= len; dy /= len
      x += dx; y += dy
      if (x < 1 || y < 1 || x >= N - 1 || y >= N - 1) break
      const hNew = hAt(x, y)
      const dh = hNew - hOld
      if (hOld < -2) break
      const cap = Math.max(-dh * speed * water * capacityK, 0.01)
      if (sediment > cap || dh > 0) {
        const amt = dh > 0 ? Math.min(dh, sediment) : (sediment - cap) * depositK
        sediment -= amt
        h[k] += amt * (1 - u) * (1 - v); h[k + 1] += amt * u * (1 - v); h[k + STRIDE] += amt * (1 - u) * v; h[k + STRIDE + 1] += amt * u * v
      } else {
        const amt = Math.min((cap - sediment) * erodeK, -dh)
        h[k] -= amt * (1 - u) * (1 - v); h[k + 1] -= amt * u * (1 - v); h[k + STRIDE] -= amt * (1 - u) * v; h[k + STRIDE + 1] -= amt * u * v
        sediment += amt
      }
      speed = Math.sqrt(Math.max(0, speed * speed - dh * gravity))
      water *= 1 - evap
    }
  }
}

function world(): Baked {
  if (!baked || baked.seed !== layoutSeed) baked = bake(layoutSeed)
  return baked
}

/** Force the heightmap bake now (e.g. behind a loading screen). Returns bake time in ms. */
export function bakeWorld(): number {
  return world().ms
}

/** Raw baked mesh data for renderers (shared, do not mutate). */
export function worldMesh() {
  const w = world()
  return { n: N, stride: STRIDE, cell: MESH_CELL, h: w.h, vx: w.vx, vz: w.vz, diag: w.diag, bakeMs: w.ms }
}

// ---------------------------------------------------------------------------------------------
// Surface queries

const triScratch = { h: 0 }

/** Height of triangle (p0,p1,p2) at (x,z) if inside (with tolerance), stored in triScratch. */
function inTri(w: Baked, k0: number, k1: number, k2: number, x: number, z: number): boolean {
  const x0 = w.vx[k0], z0 = w.vz[k0], x1 = w.vx[k1], z1 = w.vz[k1], x2 = w.vx[k2], z2 = w.vz[k2]
  const det = (z1 - z2) * (x0 - x2) + (x2 - x1) * (z0 - z2)
  const l0 = ((z1 - z2) * (x - x2) + (x2 - x1) * (z - z2)) / det
  const l1 = ((z2 - z0) * (x - x2) + (x0 - x2) * (z - z2)) / det
  const l2 = 1 - l0 - l1
  const e = -1e-6
  if (l0 < e || l1 < e || l2 < e) return false
  const h2 = w.h[k2]
  // Relative form: exact on flat triangles (runways read exactly BASE_ELEVATION).
  triScratch.h = h2 + l0 * (w.h[k0] - h2) + l1 * (w.h[k1] - h2)
  return true
}

function cellHeight(w: Baked, i: number, j: number, x: number, z: number): boolean {
  if (i < 0 || j < 0 || i >= N || j >= N) return false
  const a = j * STRIDE + i, b = a + 1, c = a + STRIDE, d = c + 1
  if (w.diag[j * N + i] === 0) return inTri(w, a, c, b, x, z) || inTri(w, b, c, d, x, z)
  return inTri(w, a, c, d, x, z) || inTri(w, a, d, b, x, z)
}

const SEARCH = [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]]

/** Height of the rendered LOD0 terrain mesh (terrain or seabed) at x,z. */
export function terrainMeshHeight(x: number, z: number): number {
  if (!(x > -WORLD_HALF && x < WORLD_HALF && z > -WORLD_HALF && z < WORLD_HALF)) return SEA_FLOOR
  const w = world()
  const gx = (x + WORLD_HALF) / MESH_CELL, gz = (z + WORLD_HALF) / MESH_CELL
  const i = Math.floor(gx), j = Math.floor(gz)
  // Probe the nearest neighbour cells first.
  const sx = gx - i < 0.5 ? -1 : 1, sz = gz - j < 0.5 ? -1 : 1
  if (cellHeight(w, i, j, x, z)) return triScratch.h
  if (cellHeight(w, i + sx, j, x, z)) return triScratch.h
  if (cellHeight(w, i, j + sz, x, z)) return triScratch.h
  if (cellHeight(w, i + sx, j + sz, x, z)) return triScratch.h
  for (const [di, dj] of SEARCH) if (cellHeight(w, i + di, j + dj, x, z)) return triScratch.h
  // Numerical fallback: nearest vertex.
  const k = Math.min(N, Math.max(0, Math.round(gz))) * STRIDE + Math.min(N, Math.max(0, Math.round(gx)))
  return w.h[k]
}

/** Terrain height (same surface as the mesh; kept for API compatibility). */
export function terrainHeight(x: number, z: number): number {
  return terrainMeshHeight(x, z)
}

/** Solid surface height (terrain mesh or water) used by physics. */
export function groundHeight(x: number, z: number): number {
  if (!(x > -WORLD_HALF && x < WORLD_HALF && z > -WORLD_HALF && z < WORLD_HALF)) return WATER_LEVEL
  const w = world()
  const bi = Math.floor((x + WORLD_HALF) / BOUND_BLOCK), bj = Math.floor((z + WORLD_HALF) / BOUND_BLOCK)
  if (w.bound[bj * BN + bi] <= WATER_LEVEL) return WATER_LEVEL
  const h = terrainMeshHeight(x, z)
  return h > WATER_LEVEL ? h : WATER_LEVEL
}

/** Conservative upper bound of the solid surface in the 500 m block containing x,z (≥ WATER_LEVEL). */
export function heightBound(x: number, z: number): number {
  if (!(x > -WORLD_HALF && x < WORLD_HALF && z > -WORLD_HALF && z < WORLD_HALF)) return WATER_LEVEL
  const w = world()
  return w.bound[Math.floor((z + WORLD_HALF) / BOUND_BLOCK) * BN + Math.floor((x + WORLD_HALF) / BOUND_BLOCK)]
}

/** True where the surface at x,z is open water. */
export function isWater(x: number, z: number): boolean {
  return terrainMeshHeight(x, z) <= WATER_LEVEL
}

function nearestBase(x: number, z: number): Airbase | null {
  for (const b of AIRBASES) if (Math.abs(x - b.center[0]) < 1600 && Math.abs(z - b.center[2]) < 1600) return b
  return null
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
  const e = MESH_CELL
  const sx = (terrainMeshHeight(x + e, z) - terrainMeshHeight(x - e, z)) / (2 * e)
  const sz = (terrainMeshHeight(x, z + e) - terrainMeshHeight(x, z - e)) / (2 * e)
  if (Math.hypot(sx, sz) > 0.9 || h > 600) return "rock"
  return h > 120 ? "forest" : "grass"
}

/** Distance (m) from x,z to the base's runway centre-line segment. */
function runwayDistance(base: Airbase, x: number, z: number): number {
  const a = worldToBaseA(base, x, z), c = worldToBaseC(base, x, z)
  const half = base.runwayLength / 2
  const da = a < -half ? -half - a : a > half ? a - half : 0
  return Math.hypot(da, c)
}

/**
 * Inside the team's protected zone: a capsule-shaped dome around the runway, safeRadius out from the
 * runway centre-line and SAFE_ZONE_HEIGHT tall (ellipsoidal profile).
 */
export function inSafeZone(team: TeamId, p: Vec3): boolean {
  const base = AIRBASES[team]
  if (!base) return false
  const d = runwayDistance(base, p[0], p[2]) / base.safeRadius
  const y = Math.max(0, p[1] - base.center[1]) / SAFE_ZONE_HEIGHT
  return d * d + y * y < 1
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
 * Jets line up two abreast from the runway threshold (12 slots, then wrap); helicopters use helipads,
 * spilling onto the helipad apron beyond four.
 */
export function spawnPoint(team: TeamId, kind: VehicleKind, index: number): SpawnPoint {
  const base = AIRBASES[team]
  const i = Math.max(0, Math.floor(index))
  if (kind === "apache") {
    const pads = BASE_LAYOUT.helipads
    const slot = i % 8
    const [pa, pc] = pads[slot % pads.length]
    const [x, z] = baseToWorld(base, pa, slot < pads.length ? pc : pc + 44)
    return { position: [x, BASE_ELEVATION + SPAWN_CLEARANCE.heli, z], yaw: base.heading, onGround: true }
  }
  const slot = i % 12
  const a = BASE_LAYOUT.runway.a0 + 60 + Math.floor(slot / 2) * 60 + (slot % 2) * 25
  const c = slot % 2 === 0 ? -13 : 13
  const [x, z] = baseToWorld(base, a, c)
  return { position: [x, BASE_ELEVATION + SPAWN_CLEARANCE.jet, z], yaw: base.heading, onGround: true }
}

// ---------------------------------------------------------------------------------------------
// Segment test

/** Steepest mesh gradient we expect (rise/run); used for safe adaptive marching. */
const MAX_SLOPE = 9

/** Fraction [0,1] along segment a→b where it first goes below the ground surface, or null. */
export function segmentHitsGround(a: Vec3, b: Vec3): number | null {
  const ax = a[0], ay = a[1], az = a[2]
  const dx = b[0] - ax, dy = b[1] - ay, dz = b[2] - az
  const minY = ay < b[1] ? ay : b[1]
  const horiz = Math.sqrt(dx * dx + dz * dz)
  if (minY > WATER_LEVEL) {
    let bound = Math.max(heightBound(ax, az), heightBound(b[0], b[2]))
    if (horiz > BOUND_BLOCK * 0.5) {
      const n = Math.ceil(horiz / (BOUND_BLOCK * 0.5))
      for (let i = 1; i < n; i++) bound = Math.max(bound, heightBound(ax + dx * i / n, az + dz * i / n))
    }
    if (minY > bound) return null
  }
  const g0 = ay - groundHeight(ax, az)
  if (g0 <= 0) return 0
  const len = Math.sqrt(horiz * horiz + dy * dy)
  if (len < 1e-9) return null
  const vert = Math.abs(dy) / Math.max(horiz, 1e-9)
  const minStep = Math.min(1, 1.5 / len)
  let t = 0, gap = g0
  while (t < 1) {
    let step = horiz > 1e-9 ? gap / (MAX_SLOPE + vert) / horiz : gap / Math.max(Math.abs(dy), 1e-9)
    if (step < minStep) step = minStep
    let t1 = t + step
    if (t1 > 1) t1 = 1
    const g1 = ay + dy * t1 - groundHeight(ax + dx * t1, az + dz * t1)
    if (g1 <= 0) {
      let lo = t, hi = t1
      for (let k = 0; k < 18; k++) {
        const mid = (lo + hi) * 0.5
        if (ay + dy * mid - groundHeight(ax + dx * mid, az + dz * mid) <= 0) hi = mid
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
