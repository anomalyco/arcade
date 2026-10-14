import { archBlobs, DEEP, newPolar, stampBlobSeabed, type Archipelago } from "./islands"

/**
 * Seabed bake for the ocean shader: a square RGBA8 texture over the archipelago bounds plus a margin.
 * R = water depth / 40 m (clamped; 0 on land), G = 255 on land, B = distance to the shoreline / 300 m (clamped; on
 * land it is the distance to the water), A = coral cover (0 = sand, 255 = coral heads; only on reef shelves and in
 * lagoons, 0 on land and in deep water). Texel centres sit at x0 + (i + 0.5) * size / res.
 */

export type Seabed = { x0: number; z0: number; size: number; res: number; data: Uint8Array<ArrayBuffer> }

export const SEABED_DEPTH = 40
export const SEABED_SHORE = 300
export const SEABED_MARGIN = 400

const INF = 1e20

/** Exact 1D squared Euclidean distance transform (Felzenszwalb & Huttenlocher) of f into d. */
function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0
  v[0] = 0
  z[0] = -INF
  z[1] = INF
  for (let q = 1; q < n; q++) {
    let s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!)
    while (s <= z[k]!) {
      k--
      s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!)
    }
    k++
    v[k] = q
    z[k] = s
    z[k + 1] = INF
  }
  k = 0
  for (let q = 0; q < n; q++) {
    while (z[k + 1]! < q) k++
    const dq = q - v[k]!
    d[q] = dq * dq + f[v[k]!]!
  }
}

/** Squared distance (in texels) from every texel to the nearest texel where `seed` is true. */
function edt2d(seed: Uint8Array, res: number, defaultSeedVal: number): Float64Array {
  const out = new Float64Array(res * res)
  const f = new Float64Array(res)
  const d = new Float64Array(res)
  const v = new Int32Array(res)
  const z = new Float64Array(res + 1)
  for (let x = 0; x < res; x++) {
    let allDefault = true
    for (let y = 0; y < res; y++) {
      const sv = seed[y * res + x]!
      if (sv !== defaultSeedVal) allDefault = false
      f[y] = sv ? 0 : INF
    }
    if (allDefault) {
      if (!defaultSeedVal) for (let y = 0; y < res; y++) out[y * res + x] = INF
      continue
    }
    edt1d(f, res, d, v, z)
    for (let y = 0; y < res; y++) out[y * res + x] = d[y]!
  }
  for (let y = 0; y < res; y++) {
    const row = y * res
    let allZero = true
    for (let x = 0; x < res; x++) {
      const val = out[row + x]!
      if (val !== 0) allZero = false
      f[x] = val
    }
    if (allZero) continue
    edt1d(f, res, d, v, z)
    for (let x = 0; x < res; x++) out[row + x] = d[x]!
  }
  return out
}

export function bakeSeabed(arch: Archipelago, res = 1024): Seabed {
  const [bx0, bz0, bx1, bz1] = arch.bounds
  const size = Math.max(bx1 - bx0, bz1 - bz0) + SEABED_MARGIN * 2
  const x0 = (bx0 + bx1) / 2 - size / 2
  const z0 = (bz0 + bz1) / 2 - size / 2
  const texel = size / res
  const n = res * res
  const heights = new Float32Array(n).fill(DEEP)
  const land = new Uint8Array(n)
  const water = new Uint8Array(n).fill(1)
  const coral = new Uint8Array(n)
  const blobs = archBlobs(arch)
  const o = newPolar()
  for (let bi = 0; bi < blobs.length; bi++) {
    stampBlobSeabed(blobs[bi]!, x0, z0, texel, res, heights, land, water, coral, o)
  }
  const toLand = edt2d(land, res, 0)
  const toWater = edt2d(water, res, 1)
  const data = new Uint8Array(n * 4)
  const u32 = new Uint32Array(data.buffer)
  const maxTexelDist = (SEABED_SHORE * (254.5 / 255)) / texel + 0.5
  const maxSqDist = maxTexelDist * maxTexelDist
  for (let k = 0; k < n; k++) {
    const h = heights[k]!
    const isLand = land[k] === 1
    const sq = isLand ? toWater[k]! : toLand[k]!
    if (!isLand && h <= -SEABED_DEPTH && sq >= maxSqDist) {
      u32[k] = 0x00ff00ff
      continue
    }
    // The shoreline lies between texel centres, half a texel short of the nearest opposite texel.
    const dist = Math.max(0, Math.sqrt(sq) - 0.5) * texel
    const oIdx = k * 4
    data[oIdx] = isLand ? 0 : Math.min(255, Math.round((-h / SEABED_DEPTH) * 255))
    data[oIdx + 1] = isLand ? 255 : 0
    data[oIdx + 2] = Math.min(255, Math.round((dist / SEABED_SHORE) * 255))
    data[oIdx + 3] = !isLand && h > -20 ? coral[k]! : 0
  }
  return { x0, z0, size, res, data }
}

/** Bilinear sample of the bake at (x, z). Outside the bake it is deep, open sea. */
export function seabedAt(bed: Seabed, x: number, z: number): { depth: number; land: boolean; shore: number; coral: number } {
  const { res, data } = bed
  const fx = ((x - bed.x0) / bed.size) * res - 0.5
  const fz = ((z - bed.z0) / bed.size) * res - 0.5
  if (fx < -0.5 || fz < -0.5 || fx > res - 0.5 || fz > res - 0.5) return { depth: SEABED_DEPTH, land: false, shore: SEABED_SHORE, coral: 0 }
  const cx = Math.min(Math.max(fx, 0), res - 1)
  const cz = Math.min(Math.max(fz, 0), res - 1)
  const i0 = Math.min(Math.floor(cx), res - 2)
  const j0 = Math.min(Math.floor(cz), res - 2)
  const tx = cx - i0
  const tz = cz - j0
  const a = (j0 * res + i0) * 4
  const b = a + 4
  const c = a + res * 4
  const d = c + 4
  const lerp = (ch: number) => {
    const top = data[a + ch]! + (data[b + ch]! - data[a + ch]!) * tx
    const bot = data[c + ch]! + (data[d + ch]! - data[c + ch]!) * tx
    return (top + (bot - top) * tz) / 255
  }
  return { depth: lerp(0) * SEABED_DEPTH, land: lerp(1) > 0.5, shore: lerp(2) * SEABED_SHORE, coral: lerp(3) }
}
