import { ACCESS_ROAD, BOOTH, COUNTY_ROAD, FENCE, NORTH_TRACK, WORLD_HALF, accessRoadSamples, countyRoadSamples, northTrackDistance, type Vec2 } from "./layout"

// Terrain height. Roads and the compound sit on flat ground at y = 0; rolling hills rise away from them, with gravel
// shoulders, a shallow drainage ditch beside every road and small hummocks on the forest floor.
//
//   height = hills (baked grid, already faded to 0 near roads/compound)
//          + ditch profile (analytic, from the baked distance-to-road-edge grid)
//          + micro relief (a baked 64 m periodic tile, sampled twice to hide the repeat)
//
// The same three grids are uploaded to the GPU so the terrain's near clipmap (terrain.ts) evaluates exactly this
// function per vertex. Keep `heightAt` and `terrainHeightNode` in step.

export const GRID_N = 512
export const GRID_CELL = (WORLD_HALF * 2) / (GRID_N - 1)
/** Distances to the road edge are clamped to this (metres); the grid is only filled within it. */
export const ROAD_DIST_MAX = 96
export const MICRO_N = 256
export const MICRO_SIZE = 64

/** Shoulder width kept flat beside the asphalt before the verge drops into the ditch. */
export const SHOULDER = 1.5
export const DITCH = { center: SHOULDER + 2.3, halfWidth: 1.9, depth: 0.42 }

/** Flat apron around the gate and guard booth, outside the fence (min x, min z, max x, max z). */
export const GATE_APRON = [-16, FENCE.max[1], Math.max(16, BOOTH.x + BOOTH.w / 2 + 5), BOOTH.z + BOOTH.d / 2 + 6] as const

/** Hills: `HILL_AMP` metres of fbm, faded in between these distances from the road edge / compound. */
export const HILL = { amp: 19, roadFade: [7, 48] as const, compoundFade: [12, 70] as const }

export const coarse = new Float32Array(GRID_N * GRID_N)
export const roadDist = new Float32Array(GRID_N * GRID_N)
export const micro = new Float32Array(MICRO_N * MICRO_N)

/** Milliseconds the bake took (reported in the Lab and by the shot harness logs). */
export let bakeMs = 0

// ---------------------------------------------------------------------------------------------------------------
// Noise (integer hash lattice, fast and deterministic)

function ihash(x: number, z: number, seed: number) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(z | 0, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

function valueNoise(x: number, z: number, seed: number, period = 0) {
  const xi = Math.floor(x)
  const zi = Math.floor(z)
  const fx = x - xi
  const fz = z - zi
  const u = fx * fx * (3 - 2 * fx)
  const v = fz * fz * (3 - 2 * fz)
  let x0 = xi
  let z0 = zi
  let x1 = xi + 1
  let z1 = zi + 1
  if (period) {
    x0 = ((x0 % period) + period) % period
    z0 = ((z0 % period) + period) % period
    x1 = ((x1 % period) + period) % period
    z1 = ((z1 % period) + period) % period
  }
  const a = ihash(x0, z0, seed)
  const b = ihash(x1, z0, seed)
  const c = ihash(x0, z1, seed)
  const d = ihash(x1, z1, seed)
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
}

/** Fractal value noise in roughly [-1, 1]. Shared with forest placement. */
export function fbm(x: number, z: number, octaves: number, freq: number, seed = 1) {
  let sum = 0
  let amp = 1
  let norm = 0
  for (let i = 0; i < octaves; i++) {
    sum += (valueNoise(x * freq, z * freq, seed + i * 17) - 0.5) * amp
    norm += amp
    amp *= 0.5
    freq *= 2.03
  }
  return (sum / norm) * 2
}

export function smoothstep(a: number, b: number, x: number) {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1)
  return t * t * (3 - 2 * t)
}

// ---------------------------------------------------------------------------------------------------------------
// Bake

function stampRoad(samples: Vec2[], halfWidth: number) {
  const R = ROAD_DIST_MAX
  for (let s = 0; s < samples.length - 1; s++) {
    const [ax, az] = samples[s]!
    const [bx, bz] = samples[s + 1]!
    const abx = bx - ax
    const abz = bz - az
    const len2 = abx * abx + abz * abz || 1
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - R + WORLD_HALF) / GRID_CELL))
    const i1 = Math.min(GRID_N - 1, Math.ceil((Math.max(ax, bx) + R + WORLD_HALF) / GRID_CELL))
    const j0 = Math.max(0, Math.floor((Math.min(az, bz) - R + WORLD_HALF) / GRID_CELL))
    const j1 = Math.min(GRID_N - 1, Math.ceil((Math.max(az, bz) + R + WORLD_HALF) / GRID_CELL))
    for (let j = j0; j <= j1; j++) {
      const z = -WORLD_HALF + j * GRID_CELL
      const row = j * GRID_N
      for (let i = i0; i <= i1; i++) {
        const x = -WORLD_HALF + i * GRID_CELL
        let t = ((x - ax) * abx + (z - az) * abz) / len2
        t = t < 0 ? 0 : t > 1 ? 1 : t
        const dx = x - ax - abx * t
        const dz = z - az - abz * t
        const d = Math.sqrt(dx * dx + dz * dz) - halfWidth
        if (d < roadDist[row + i]!) roadDist[row + i] = d
      }
    }
  }
}

function bake() {
  const t0 = performance.now()
  roadDist.fill(ROAD_DIST_MAX)
  stampRoad(accessRoadSamples(3), ACCESS_ROAD.width / 2)
  stampRoad(countyRoadSamples(-WORLD_HALF - 8, WORLD_HALF + 8, 4), COUNTY_ROAD.width / 2)

  for (let j = 0; j < GRID_N; j++) {
    const z = -WORLD_HALF + j * GRID_CELL
    for (let i = 0; i < GRID_N; i++) {
      const x = -WORLD_HALF + i * GRID_CELL
      const k = j * GRID_N + i
      const mask = hillMask(roadDist[k]!, compoundDistance(x, z))
      // Broad ridges plus finer rolling ground; slightly lifted so roads tend to sit in shallow cuts.
      coarse[k] = mask > 0 ? (fbm(x, z, 5, 1 / 230, 3) * HILL.amp + 2.2) * mask : 0
    }
  }

  // Periodic micro relief: hummocks (8 m), root mounds (2-4 m) and lumps (0.5-1 m), normalised to about [-1, 1].
  const P = MICRO_SIZE
  for (let j = 0; j < MICRO_N; j++) {
    for (let i = 0; i < MICRO_N; i++) {
      const x = (i / MICRO_N) * P
      const z = (j / MICRO_N) * P
      let h = 0
      let amp = 1
      let cells = 8
      for (let o = 0; o < 5; o++) {
        h += (valueNoise((x / P) * cells, (z / P) * cells, 91 + o, cells) - 0.5) * amp
        amp *= 0.5
        cells *= 2
      }
      micro[j * MICRO_N + i] = h * 2
    }
  }
  bakeMs = performance.now() - t0
}

export function hillMask(road: number, compound: number) {
  return smoothstep(HILL.roadFade[0], HILL.roadFade[1], road) * smoothstep(HILL.compoundFade[0], HILL.compoundFade[1], compound)
}

/** Signed distance (metres) to the fenced compound plus the gate apron; negative inside. */
export function compoundDistance(x: number, z: number) {
  return Math.min(boxSdf(x, z, FENCE.min[0], FENCE.min[1], FENCE.max[0], FENCE.max[1]), boxSdf(x, z, ...GATE_APRON))
}

function boxSdf(x: number, z: number, x0: number, z0: number, x1: number, z1: number) {
  const cx = (x0 + x1) / 2
  const cz = (z0 + z1) / 2
  const qx = Math.abs(x - cx) - (x1 - x0) / 2
  const qz = Math.abs(z - cz) - (z1 - z0) / 2
  return Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0)
}

/** Ditch profile below road grade, as a function of distance from the asphalt edge and from the compound. */
export function ditchAt(road: number, compound: number) {
  const t = (road - DITCH.center) / DITCH.halfWidth
  if (t <= -1 || t >= 1) return 0
  const b = 1 - t * t
  return -DITCH.depth * b * b * smoothstep(2, 9, compound)
}

/** How much micro relief shows: none on the shoulders and in the compound, full in the woods. */
export function microMask(road: number, compound: number) {
  return smoothstep(SHOULDER + 0.6, SHOULDER + 5, road) * smoothstep(1, 8, compound)
}

/** Raw micro relief (two rotated taps of the periodic tile), metres. */
export function microAt(x: number, z: number) {
  const a = sampleMicro(x, z)
  const b = sampleMicro(x * 0.6 - z * 0.8 + 17.3, x * 0.8 + z * 0.6 - 5.1)
  return a * 0.11 + b * 0.16
}

function sampleMicro(x: number, z: number) {
  const s = MICRO_N / MICRO_SIZE
  const gx = x * s
  const gz = z * s
  const fi = Math.floor(gx)
  const fj = Math.floor(gz)
  const fx = gx - fi
  const fz = gz - fj
  const i0 = fi & (MICRO_N - 1)
  const j0 = fj & (MICRO_N - 1)
  const i1 = (i0 + 1) & (MICRO_N - 1)
  const j1 = (j0 + 1) & (MICRO_N - 1)
  const a = micro[j0 * MICRO_N + i0]!
  const b = micro[j0 * MICRO_N + i1]!
  const c = micro[j1 * MICRO_N + i0]!
  const d = micro[j1 * MICRO_N + i1]!
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz
}

function sampleGrid(grid: Float32Array, x: number, z: number) {
  const gx = Math.min(Math.max((x + WORLD_HALF) / GRID_CELL, 0), GRID_N - 1.001)
  const gz = Math.min(Math.max((z + WORLD_HALF) / GRID_CELL, 0), GRID_N - 1.001)
  const i = Math.floor(gx)
  const j = Math.floor(gz)
  const fx = gx - i
  const fz = gz - j
  const k = j * GRID_N + i
  const a = grid[k]!
  const b = grid[k + 1]!
  const c = grid[k + GRID_N]!
  const d = grid[k + GRID_N + 1]!
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz
}

/** Distance (metres) from the nearest asphalt edge; negative on the road, clamped to `ROAD_DIST_MAX`. */
export function roadEdgeDistance(x: number, z: number) {
  return sampleGrid(roadDist, x, z)
}

bake()

export function heightAt(x: number, z: number) {
  const road = sampleGrid(roadDist, x, z)
  const comp = compoundDistance(x, z)
  let h = sampleGrid(coarse, x, z)
  if (road > DITCH.center - DITCH.halfWidth) h += ditchAt(road, comp)
  let m = microMask(road, comp)
  // The gravel north track gets a smooth bed (its ribbon follows this height a few cm up), easing into the hummocks.
  if (m > 0) m *= smoothstep(NORTH_TRACK.width / 2 + 0.2, NORTH_TRACK.width / 2 + 2.5, northTrackDistance(x, z))
  if (m > 0) h += microAt(x, z) * m
  return h
}
