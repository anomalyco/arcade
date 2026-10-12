// World geography — owned by the World agent. Pure, deterministic, dependency-free (server safe).
//
// A 16 × 16 km procedurally generated archipelago of smooth, natural islands, with the four team
// carrier strike groups (fleet.ts) at sea. Ship hulls/decks/islands are part of the solid surface. On first use
// the module bakes a heightmap on a jittered triangle grid (MESH_CELL spacing):
//   seeded island masks (domain-warped) → fBm + ridged mountains + a couple of central peaks →
//   carved canyons → droplet erosion + thermal smoothing → open water around every strike group.
// The rendered LOD0 mesh uses exactly these vertices and triangles, and every physics query
// interpolates the same triangles, so collision always matches what players see.
import { AA_RANGE, FLEET, SHIP_SPECS, type Ship, shipToWorld, worldToShip } from "./fleet"
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
/** Assumed height of the aircraft origin above the wheels' contact point. */
export const SPAWN_CLEARANCE: Record<"jet" | "heli", number> = { jet: 2.2, heli: 1.9 }
/** Open water kept around every fleet ship and along each carrier's launch path (m). */
export const FLEET_CLEARANCE = 2_500

/**
 * A team's home: derived from its carrier (kept for minimap/HUD consumers).
 * center = carrier at flight-deck height, runway = the flight deck, safeRadius = AA_RANGE.
 */
export interface Airbase {
  team: TeamId
  /** Carrier position, y = flight-deck height. */
  center: Vec3
  /** Carrier heading (yaw; bow = launch direction, toward the map centre). */
  heading: number
  runwayLength: number
  runwayWidth: number
  /** Strike-group air-defence radius (AA_RANGE). */
  safeRadius: number
  /** Helicopter spots on the flight deck (y = deck height). */
  helipads: Vec3[]
}

const CARRIER = SHIP_SPECS.carrier
/** Carrier deck spots in ship-local (x, z): two bow catapult lanes (3 slots each) and aft helo spots. */
export const DECK_LAYOUT = {
  catapults: [[-14, 40], [6, 52], [-14, 78], [6, 90], [-14, 116], [6, 128]] as [number, number][],
  heloSpots: [[-27, 92], [-27, 124], [-27, 154], [24, 120], [24, 150]] as [number, number][],
}

export function carrierOf(team: TeamId): Ship {
  return FLEET.find(s => s.team === team && s.kind === "carrier")!
}

export const AIRBASES: Airbase[] = ([0, 1, 2, 3] as TeamId[]).map(team => {
  const c = carrierOf(team)
  return {
    team, heading: c.heading,
    center: [c.position[0], CARRIER.deckHeight, c.position[2]] as Vec3,
    runwayLength: CARRIER.halfLength * 2, runwayWidth: CARRIER.halfWidth * 2, safeRadius: AA_RANGE,
    helipads: DECK_LAYOUT.heloSpots.slice(0, 4).map(([x, z]) => shipToWorld(c, [x, CARRIER.deckHeight, z])),
  }
})

/** Base-local (a along the bow, c to starboard) → world [x, z]. Yaw 0 = bow toward -Z. */
export function baseToWorld(base: Airbase, a: number, c: number): [number, number] {
  const s = Math.sin(base.heading), k = Math.cos(base.heading)
  return [base.center[0] - s * a + k * c, base.center[2] - k * a - s * c]
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

/** Carrier launch lane: open water ±LAUNCH_LANE_HALF wide, out to LAUNCH_LANE_LENGTH ahead of the carrier. */
export const LAUNCH_LANE_HALF = 450
export const LAUNCH_LANE_LENGTH = 3_800

/**
 * Signed clearance (m) of x,z from the strike groups' keep-out areas: FLEET_CLEARANCE around every
 * ship plus each carrier's launch lane. ≤ 0 inside a keep-out area.
 */
export function fleetClearance(x: number, z: number): number {
  let best = Infinity
  for (const s of FLEET) {
    const dx = x - s.position[0], dz = z - s.position[2]
    let d = Math.hypot(dx, dz) - FLEET_CLEARANCE
    if (s.kind === "carrier") {
      const fx = -Math.sin(s.heading), fz = -Math.cos(s.heading)
      const t = Math.max(0, Math.min(LAUNCH_LANE_LENGTH, dx * fx + dz * fz))
      d = Math.min(d, Math.hypot(dx - fx * t, dz - fz * t) - LAUNCH_LANE_HALF)
    }
    if (d < best) best = d
  }
  return best
}

function nearBase(x: number, z: number, margin: number): boolean {
  return fleetClearance(x, z) < margin
}

function layout(seed: number) {
  const rand = seededRandom(seed ^ 0x15a7d)
  const blobs: Blob[] = []
  const names: IslandInfo[] = []
  // Big central island, made of a few overlapping lobes.
  blobs.push({ x: 0, z: 0, r: 2200, amp: 1 })
  for (let i = 0; i < 3; i++) {
    // Lobes lean toward the diagonals, away from the strike groups on the axes.
    const a = Math.PI / 4 + Math.floor(rand() * 4) * Math.PI / 2 + (rand() - 0.5) * 0.6, d = 700 + rand() * 900
    blobs.push({ x: Math.cos(a) * d, z: Math.sin(a) * d, r: 1000 + rand() * 600, amp: 0.85 })
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
      if (nearBase(x, z, r * 1.3 + 700)) continue
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
    if (nearBase(x, z, r * 1.3 + 700)) continue
    if (Math.hypot(x, z) < 2600) continue
    blobs.push({ x, z, r, amp: 0.45 + rand() * 0.45 })
    i++
  }
  // A couple of tall peaks near the centre.
  const peaks: Peak[] = []
  for (let i = 0; i < 2; i++) {
    // On the diagonals, away from the strike groups on the axes.
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
  // 3b. A few smoothing passes on land for soft, rounded forms.
  const tmp = new Float32Array(h.length)
  for (let pass = 0; pass < 3; pass++) {
    tmp.set(h)
    for (let j = 1; j < N; j++) for (let i = 1; i < N; i++) {
      const k = j * STRIDE + i
      if (tmp[k] <= 0) continue
      h[k] = tmp[k] * 0.4 + (tmp[k - 1] + tmp[k + 1] + tmp[k - STRIDE] + tmp[k + STRIDE]) * 0.15
    }
  }
  // 4. Guaranteed open water around every strike group (and the carriers' launch paths).
  for (let k = 0; k < h.length; k++) {
    if (h[k] <= -12) continue
    const d = fleetClearance(vx[k], vz[k])
    if (d < 700) {
      const t = smooth(0, 700, d)
      h[k] = Math.min(h[k], -12 + (h[k] + 12) * t)
    }
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
  for (const sh of FLEET) {
    const sp = SHIP_SPECS[sh.kind]
    const top = Math.max(sp.deckHeight, sp.island.center[1] + sp.island.half[1]) + 1
    const r = Math.hypot(sp.halfLength, sp.halfWidth) + 5
    for (let bz = Math.floor((sh.position[2] - r + WORLD_HALF) / BOUND_BLOCK); bz <= Math.floor((sh.position[2] + r + WORLD_HALF) / BOUND_BLOCK); bz++)
      for (let bx = Math.floor((sh.position[0] - r + WORLD_HALF) / BOUND_BLOCK); bx <= Math.floor((sh.position[0] + r + WORLD_HALF) / BOUND_BLOCK); bx++)
        if (bx >= 0 && bz >= 0 && bx < BN && bz < BN) bound[bz * BN + bx] = Math.max(bound[bz * BN + bx], top)
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
  // Relative form: exact on flat triangles.
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

// ---------------------------------------------------------------------------------------------
// Ships as solid ground

const SHIP_BIN = 400
/** Ship whose hull footprint contains x,z (or null). */
export function shipAt(x: number, z: number): Ship | null {
  for (const sh of FLEET) {
    const sp = SHIP_SPECS[sh.kind]
    const dx = x - sh.position[0], dz = z - sh.position[2]
    if (dx > SHIP_BIN || dx < -SHIP_BIN || dz > SHIP_BIN || dz < -SHIP_BIN) continue
    const l = worldToShip(sh, [x, 0, z])
    if (Math.abs(l[0]) <= sp.halfWidth && Math.abs(l[2]) <= sp.halfLength) return sh
  }
  return null
}

/** Ship surface height at x,z (deck, or superstructure top), or -Infinity off ships. */
export function shipHeight(x: number, z: number): number {
  const sh = shipAt(x, z)
  if (!sh) return -Infinity
  const sp = SHIP_SPECS[sh.kind]
  const l = worldToShip(sh, [x, 0, z])
  const I = sp.island
  if (Math.abs(l[0] - I.center[0]) <= I.half[0] && Math.abs(l[2] - I.center[2]) <= I.half[2]) return I.center[1] + I.half[1]
  return sp.deckHeight
}

/** Solid surface height (terrain mesh, water, or ship deck/superstructure) used by physics. */
export function groundHeight(x: number, z: number): number {
  if (!(x > -WORLD_HALF && x < WORLD_HALF && z > -WORLD_HALF && z < WORLD_HALF)) return WATER_LEVEL
  const w = world()
  const bi = Math.floor((x + WORLD_HALF) / BOUND_BLOCK), bj = Math.floor((z + WORLD_HALF) / BOUND_BLOCK)
  if (w.bound[bj * BN + bi] <= WATER_LEVEL) return WATER_LEVEL
  const h = Math.max(terrainMeshHeight(x, z), WATER_LEVEL)
  const s = shipHeight(x, z)
  return s > h ? s : h
}

/** Terrain/water only (no ships). */
function terrainGround(x: number, z: number): number {
  const h = terrainMeshHeight(x, z)
  return h > WATER_LEVEL ? h : WATER_LEVEL
}

/** Conservative upper bound of the solid surface in the 500 m block containing x,z (≥ WATER_LEVEL). */
export function heightBound(x: number, z: number): number {
  if (!(x > -WORLD_HALF && x < WORLD_HALF && z > -WORLD_HALF && z < WORLD_HALF)) return WATER_LEVEL
  const w = world()
  return w.bound[Math.floor((z + WORLD_HALF) / BOUND_BLOCK) * BN + Math.floor((x + WORLD_HALF) / BOUND_BLOCK)]
}

/** True where the surface at x,z is open water (false on ship decks). */
export function isWater(x: number, z: number): boolean {
  if (shipAt(x, z)) return false
  return terrainMeshHeight(x, z) <= WATER_LEVEL
}

/** True on a carrier's flight deck (not on the island). Wheels roll here without damage. */
export function onRunway(x: number, z: number): boolean {
  const sh = shipAt(x, z)
  if (!sh || sh.kind !== "carrier") return false
  return shipHeight(x, z) === CARRIER.deckHeight
}

export type SurfaceType = "water" | "sand" | "grass" | "forest" | "rock" | "snow" | "paved"
/** Coarse surface classification (for effects, audio, bots). Ship decks are "paved". */
export function surfaceType(x: number, z: number): SurfaceType {
  if (shipAt(x, z)) return "paved"
  const h = terrainMeshHeight(x, z)
  if (h <= WATER_LEVEL) return "water"
  if (h < 4) return "sand"
  const e = MESH_CELL
  const sx = (terrainMeshHeight(x + e, z) - terrainMeshHeight(x - e, z)) / (2 * e)
  const sz = (terrainMeshHeight(x, z + e) - terrainMeshHeight(x, z - e)) / (2 * e)
  if (Math.hypot(sx, sz) > 0.9 || h > 600) return "rock"
  return h > 120 ? "forest" : "grass"
}

/** Inside the team's own strike-group air-defence umbrella (within AA_RANGE of any own ship). */
export function inSafeZone(team: TeamId, p: Vec3): boolean {
  if (p[1] > CEILING) return false
  for (const sh of FLEET) {
    if (sh.team !== team) continue
    if (Math.hypot(p[0] - sh.position[0], p[2] - sh.position[2]) < AA_RANGE) return true
  }
  return false
}

export interface SpawnPoint {
  position: Vec3
  /** Yaw (rad); 0 = nose toward -Z. */
  yaw: number
  /** True = start on the deck with gear down; false = air start. */
  onGround: boolean
}

/**
 * Spawn slot for a team's vehicle. Jets stagger along the carrier's two bow catapult lanes (6 slots,
 * then wrap), facing the bow; helicopters use the aft helo spots.
 */
export function spawnPoint(team: TeamId, kind: VehicleKind, index: number): SpawnPoint {
  const c = carrierOf(team)
  const i = Math.max(0, Math.floor(index))
  const deck = CARRIER.deckHeight
  if (kind === "apache") {
    const spots = DECK_LAYOUT.heloSpots
    const [x, z] = spots[i % spots.length]
    return { position: shipToWorld(c, [x, deck + SPAWN_CLEARANCE.heli, z]), yaw: c.heading, onGround: true }
  }
  const cats = DECK_LAYOUT.catapults
  const [x, z] = cats[i % cats.length]
  return { position: shipToWorld(c, [x, deck + SPAWN_CLEARANCE.jet, z]), yaw: c.heading, onGround: true }
}

/** Slab test of segment a→b against a ship-local box; returns entry fraction or null. */
function segmentBox(sh: Ship, a: Vec3, b: Vec3, center: Vec3, half: Vec3): number | null {
  const la = worldToShip(sh, a), lb = worldToShip(sh, b)
  let t0 = 0, t1 = 1
  for (let k = 0; k < 3; k++) {
    const d = lb[k] - la[k], lo = center[k] - half[k], hi = center[k] + half[k]
    if (Math.abs(d) < 1e-9) { if (la[k] < lo || la[k] > hi) return null; continue }
    let u0 = (lo - la[k]) / d, u1 = (hi - la[k]) / d
    if (u0 > u1) { const t = u0; u0 = u1; u1 = t }
    if (u0 > t0) t0 = u0
    if (u1 < t1) t1 = u1
    if (t0 > t1) return null
  }
  return t0
}

/** First hit of segment a→b with any ship hull or superstructure (fraction), or null. */
export function segmentHitsShip(a: Vec3, b: Vec3): number | null {
  let best: number | null = null
  for (const sh of FLEET) {
    const sp = SHIP_SPECS[sh.kind]
    const r = sp.halfLength + 80
    const px = sh.position[0], pz = sh.position[2]
    if (Math.max(a[0], b[0]) < px - r || Math.min(a[0], b[0]) > px + r || Math.max(a[2], b[2]) < pz - r || Math.min(a[2], b[2]) > pz + r) continue
    if (Math.min(a[1], b[1]) > sp.island.center[1] + sp.island.half[1]) continue
    const hull = segmentBox(sh, a, b, [0, (sp.deckHeight - 15) / 2, 0], [sp.halfWidth, (sp.deckHeight + 15) / 2, sp.halfLength])
    const isl = segmentBox(sh, a, b, sp.island.center, sp.island.half)
    for (const t of [hull, isl]) if (t !== null && (best === null || t < best)) best = t
  }
  return best
}

// ---------------------------------------------------------------------------------------------
// Segment test

/** Steepest mesh gradient we expect (rise/run); used for safe adaptive marching. */
const MAX_SLOPE = 9

/** Fraction [0,1] along segment a→b where it first hits terrain, water or a ship, or null. */
export function segmentHitsGround(a: Vec3, b: Vec3): number | null {
  const t = segmentHitsTerrain(a, b), s = segmentHitsShip(a, b)
  return t === null ? s : s === null ? t : Math.min(t, s)
}

function segmentHitsTerrain(a: Vec3, b: Vec3): number | null {
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
  const g0 = ay - terrainGround(ax, az)
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
    const g1 = ay + dy * t1 - terrainGround(ax + dx * t1, az + dz * t1)
    if (g1 <= 0) {
      let lo = t, hi = t1
      for (let k = 0; k < 18; k++) {
        const mid = (lo + hi) * 0.5
        if (ay + dy * mid - terrainGround(ax + dx * mid, az + dz * mid) <= 0) hi = mid
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
