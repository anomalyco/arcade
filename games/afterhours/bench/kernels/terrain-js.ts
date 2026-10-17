// Frozen copy of the game's terrain CPU work (src/world/height.ts bake + heightAt, src/world/terrain.ts near-patch
// fill and far mesh) so it can be run repeatedly and compared with the Rust/WASM port in bench/wasm. `check()` in
// bench/gen-bench.ts verifies this copy still reproduces the live module's grids.
//
// Inputs that come from layout.ts are passed in as plain numbers/Float64Arrays so both ports get identical data.

export const GRID_N = 512
export const MICRO_N = 256
export const MICRO_SIZE = 64
export const ROAD_DIST_MAX = 96
export const SHOULDER = 1.5
export const DITCH = { center: SHOULDER + 2.3, halfWidth: 1.9, depth: 0.42 }
export const HILL = { amp: 19, roadFade: [7, 48] as const, compoundFade: [12, 70] as const }
export const NEAR_SPACING = 0.5
export const NEAR_HALF = 64
export const NEAR_N = Math.round((NEAR_HALF * 2) / NEAR_SPACING) + 1
export const FAR_SEGMENTS = 320

export type TerrainInput = {
  worldHalf: number
  /** Polylines as flat [x0, z0, x1, z1, ...]. */
  access: Float64Array
  accessHalfWidth: number
  county: Float64Array
  countyHalfWidth: number
  /** Boxes (x0, z0, x1, z1): fence and gate apron. */
  fence: [number, number, number, number]
  apron: [number, number, number, number]
}

export function createTerrain(input: TerrainInput) {
  const WH = input.worldHalf
  const CELL = (WH * 2) / (GRID_N - 1)
  const coarse = new Float32Array(GRID_N * GRID_N)
  const roadDist = new Float32Array(GRID_N * GRID_N)
  const micro = new Float32Array(MICRO_N * MICRO_N)
  const [f0, f1, f2, f3] = input.fence
  const [a0, a1, a2, a3] = input.apron

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
  function fbm(x: number, z: number, octaves: number, freq: number, seed = 1) {
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
  const smoothstep = (a: number, b: number, x: number) => {
    const t = Math.min(Math.max((x - a) / (b - a), 0), 1)
    return t * t * (3 - 2 * t)
  }
  function stampRoad(s: Float64Array, halfWidth: number) {
    const R = ROAD_DIST_MAX
    for (let k = 0; k < s.length / 2 - 1; k++) {
      const ax = s[k * 2]!
      const az = s[k * 2 + 1]!
      const bx = s[k * 2 + 2]!
      const bz = s[k * 2 + 3]!
      const abx = bx - ax
      const abz = bz - az
      const len2 = abx * abx + abz * abz || 1
      const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - R + WH) / CELL))
      const i1 = Math.min(GRID_N - 1, Math.ceil((Math.max(ax, bx) + R + WH) / CELL))
      const j0 = Math.max(0, Math.floor((Math.min(az, bz) - R + WH) / CELL))
      const j1 = Math.min(GRID_N - 1, Math.ceil((Math.max(az, bz) + R + WH) / CELL))
      for (let j = j0; j <= j1; j++) {
        const z = -WH + j * CELL
        const row = j * GRID_N
        for (let i = i0; i <= i1; i++) {
          const x = -WH + i * CELL
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
  function boxSdf(x: number, z: number, x0: number, z0: number, x1: number, z1: number) {
    const cx = (x0 + x1) / 2
    const cz = (z0 + z1) / 2
    const qx = Math.abs(x - cx) - (x1 - x0) / 2
    const qz = Math.abs(z - cz) - (z1 - z0) / 2
    return Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0)
  }
  const compoundDistance = (x: number, z: number) => Math.min(boxSdf(x, z, f0, f1, f2, f3), boxSdf(x, z, a0, a1, a2, a3))
  const hillMask = (road: number, comp: number) =>
    smoothstep(HILL.roadFade[0], HILL.roadFade[1], road) * smoothstep(HILL.compoundFade[0], HILL.compoundFade[1], comp)
  function ditchAt(road: number, comp: number) {
    const t = (road - DITCH.center) / DITCH.halfWidth
    if (t <= -1 || t >= 1) return 0
    const b = 1 - t * t
    return -DITCH.depth * b * b * smoothstep(2, 9, comp)
  }
  const microMask = (road: number, comp: number) => smoothstep(SHOULDER + 0.6, SHOULDER + 5, road) * smoothstep(1, 8, comp)
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
  const microAt = (x: number, z: number) => sampleMicro(x, z) * 0.11 + sampleMicro(x * 0.6 - z * 0.8 + 17.3, x * 0.8 + z * 0.6 - 5.1) * 0.16
  function sampleGrid(grid: Float32Array, x: number, z: number) {
    const gx = Math.min(Math.max((x + WH) / CELL, 0), GRID_N - 1.001)
    const gz = Math.min(Math.max((z + WH) / CELL, 0), GRID_N - 1.001)
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
  function heightAt(x: number, z: number) {
    const road = sampleGrid(roadDist, x, z)
    const comp = compoundDistance(x, z)
    let h = sampleGrid(coarse, x, z)
    if (road > DITCH.center - DITCH.halfWidth) h += ditchAt(road, comp)
    const m = microMask(road, comp)
    if (m > 0) h += microAt(x, z) * m
    return h
  }
  function surfaceWeights(x: number, z: number, road: number, comp: number, out: Float32Array, o: number) {
    const n = microAt(x * 0.37 + 11, z * 0.37 - 7) * 6
    const dirt = Math.max(1 - smoothstep(SHOULDER - 0.3, SHOULDER + 0.9 + n * 0.3, road), (ditchAt(road, comp) / -DITCH.depth) * 0.45)
    let grass = smoothstep(SHOULDER - 0.2, SHOULDER + 1.2, road) * (1 - smoothstep(5.5 + n, 9.5 + n * 1.5, road))
    grass = Math.max(grass, 1 - smoothstep(1 + n * 0.5, 7 + n, comp))
    out[o] = grass
    out[o + 1] = dirt
  }

  function bake() {
    roadDist.fill(ROAD_DIST_MAX)
    stampRoad(input.access, input.accessHalfWidth)
    stampRoad(input.county, input.countyHalfWidth)
    for (let j = 0; j < GRID_N; j++) {
      const z = -WH + j * CELL
      for (let i = 0; i < GRID_N; i++) {
        const x = -WH + i * CELL
        const k = j * GRID_N + i
        const mask = hillMask(roadDist[k]!, compoundDistance(x, z))
        coarse[k] = mask > 0 ? (fbm(x, z, 5, 1 / 230, 3) * HILL.amp + 2.2) * mask : 0
      }
    }
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
  }

  const P = NEAR_N + 2
  const heights = new Float32Array(P * P)
  const patch = {
    pos: new Float32Array(NEAR_N * NEAR_N * 3),
    nor: new Float32Array(NEAR_N * NEAR_N * 3),
    uv: new Float32Array(NEAR_N * NEAR_N * 2),
    surf: new Float32Array(NEAR_N * NEAR_N * 2),
  }
  /** terrain.ts fillPatch without the yields: the near patch rebuilt around (cx, cz). */
  function fillPatch(cx: number, cz: number) {
    const x0 = cx - NEAR_HALF
    const z0 = cz - NEAR_HALF
    for (let j = 0; j < P; j++) {
      const z = z0 + (j - 1) * NEAR_SPACING
      for (let i = 0; i < P; i++) heights[j * P + i] = heightAt(x0 + (i - 1) * NEAR_SPACING, z)
    }
    const { pos, nor, uv, surf } = patch
    const inv = 1 / (2 * NEAR_SPACING)
    for (let j = 0; j < NEAR_N; j++) {
      const z = z0 + j * NEAR_SPACING
      for (let i = 0; i < NEAR_N; i++) {
        const x = x0 + i * NEAR_SPACING
        const k = j * NEAR_N + i
        const h = (j + 1) * P + i + 1
        pos[k * 3] = x
        pos[k * 3 + 1] = heights[h]!
        pos[k * 3 + 2] = z
        const dx = (heights[h + 1]! - heights[h - 1]!) * inv
        const dz = (heights[h + P]! - heights[h - P]!) * inv
        const l = 1 / Math.sqrt(dx * dx + 1 + dz * dz)
        nor[k * 3] = -dx * l
        nor[k * 3 + 1] = l
        nor[k * 3 + 2] = -dz * l
        uv[k * 2] = x
        uv[k * 2 + 1] = -z
        surfaceWeights(x, z, sampleGrid(roadDist, x, z), compoundDistance(x, z), surf, k * 2)
      }
    }
    return patch
  }
  const farN = FAR_SEGMENTS + 1
  const far = { pos: new Float32Array(farN * farN * 3), surf: new Float32Array(farN * farN * 2) }
  /** terrain.ts buildFar's CPU loop (positions + surface weights; normals/index excluded). */
  function fillFar() {
    const size = WH * 2
    for (let j = 0; j < farN; j++)
      for (let i = 0; i < farN; i++) {
        const k = j * farN + i
        const x = -WH + (i / FAR_SEGMENTS) * size
        const z = -WH + (j / FAR_SEGMENTS) * size
        far.pos[k * 3] = x
        far.pos[k * 3 + 1] = heightAt(x, z)
        far.pos[k * 3 + 2] = z
        surfaceWeights(x, z, sampleGrid(roadDist, x, z), compoundDistance(x, z), far.surf, k * 2)
      }
    return far
  }
  return { coarse, roadDist, micro, bake, fillPatch, fillFar, heightAt }
}
