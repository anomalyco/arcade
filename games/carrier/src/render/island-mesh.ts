import {
  archBlobs,
  blobPolar,
  blobWorld,
  coastAt,
  coastStops,
  coveAt,
  CONE,
  interiorHeight,
  newPolar,
  sectorAt,
  seaHeight,
  seawardRadius,
  terrainProbe,
  wallColumns,
  type Archipelago,
  type Blob,
  type Polar,
  type Probe,
} from "../../shared/islands"
import { noise2 } from "../../shared/noise"
import { hash3, Rng } from "../../shared/rng"
import { FLOATS_PER_VERT, MAT, Mesh, VERT_BYTES, type Rgb } from "./mesh"

/**
 * Static island geometry (look: concept/island-1..5).
 *
 * Terrain: every blob (see shared/islands.ts) is meshed in its own polar frame. Coastal rings sit on the blob's profile
 * stops, so the wet sand, the beach and the forest edge are continuous bands of big quads, and cliff strata are rings
 * of vertical faces and ledges sharing columns. Interior rings shrink toward the centre; volcano rings put their
 * vertices on the ridge spokes so the slopes read as long radial facets. The mesh reaches a few metres under the sea.
 *
 * Props: a few prototype meshes (canopy blobs, palms, boulders) placed as instances (position, yaw, scale, tint).
 * `buildIslandProps` returns them for an instancing renderer; `buildIslandMesh` merges everything into chunks.
 */

export type StaticChunk = { data: ArrayBuffer; box: [x0: number, z0: number, x1: number, z1: number] }

export const CHUNK_SIZE = 512
/** Forest canopy is thinned evenly once the whole archipelago would exceed this many triangles. */
export const TRI_BUDGET = 900_000
/** Floats per instance: x, y, z, yaw, scale, r, g, b (tint multiplying the prototype's vertex colours). */
export const INSTANCE_FLOATS = 8

export type IslandProps = {
  /** Packed `Mesh` vertices in prototype space (y up, origin at the base). */
  protos: { name: string; data: ArrayBuffer; tris: number }[]
  /** Per prototype, INSTANCE_FLOATS floats per instance. Foliage aux phase = fract(x * 0.0137 + z * 0.0071). */
  instances: Float32Array[]
}

type V3 = [number, number, number]

// Albedo (sRGB; the shader decodes with pow 2.2).
const UNDER: Rgb = [0.78, 0.74, 0.58]
const WET: Rgb = [0.9, 0.82, 0.64]
const SAND: Rgb = [1.0, 0.93, 0.76]
const DARK_SAND: Rgb = [0.3, 0.28, 0.27]
const EDGE: Rgb = [0.58, 0.64, 0.3]
const FOREST: Rgb = [0.24, 0.45, 0.12]
const OLIVE: Rgb = [0.42, 0.62, 0.18]
const OLIVE_DRY: Rgb = [0.5, 0.56, 0.27]
const VOLC_ROCK: Rgb = [0.42, 0.38, 0.35]
const CRATER: Rgb = [0.27, 0.24, 0.23]
const PLATEAU: Rgb = [0.5, 0.7, 0.22]
const PLATEAU_B: Rgb = [0.42, 0.62, 0.18]
const SANDSTONE: Rgb = [0.9, 0.68, 0.45]
const CLIFF_GREY: Rgb = [0.56, 0.51, 0.46]
const LEDGE: Rgb = [0.62, 0.58, 0.48]
const STACK: Rgb = [0.58, 0.53, 0.47]
const STACK_WARM: Rgb = [0.68, 0.58, 0.46]
const TUFT: Rgb = [0.34, 0.54, 0.17]
const MOSS: Rgb = [0.34, 0.4, 0.26]
const FOOT_ROCK: Rgb = [0.5, 0.47, 0.44]

/** Broadleaf clump greens: a few dark, mostly mid, plenty of yellow-greens (island-2). */
const CANOPY: Rgb[] = [
  [0.15, 0.34, 0.09],
  [0.2, 0.43, 0.11],
  [0.25, 0.5, 0.12],
  [0.31, 0.57, 0.13],
  [0.37, 0.62, 0.14],
  [0.45, 0.66, 0.15],
  [0.53, 0.7, 0.18],
  [0.24, 0.49, 0.17],
  [0.4, 0.63, 0.11],
]
const BOULDER: Rgb = [0.62, 0.61, 0.6]
const LAVA: Rgb = [0.27, 0.25, 0.25]

function tint(c: Rgb, k: number): Rgb {
  return [c[0] * k, c[1] * k, c[2] * k]
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

function normalOf(a: readonly number[], b: readonly number[], c: readonly number[]): V3 {
  const ux = b[0]! - a[0]!
  const uy = b[1]! - a[1]!
  const uz = b[2]! - a[2]!
  const wx = c[0]! - a[0]!
  const wy = c[1]! - a[1]!
  const wz = c[2]! - a[2]!
  const nx = uy * wz - uz * wy
  const ny = uz * wx - ux * wz
  const nz = ux * wy - uy * wx
  const l = Math.hypot(nx, ny, nz) || 1
  return [nx / l, ny / l, nz / l]
}

// ---------------------------------------------------------------------------------------------------------------------
// Chunks

class Chunks {
  readonly terrain = new Map<number, Mesh>()
  constructor(
    readonly x0: number,
    readonly z0: number,
    readonly n: number,
  ) {}

  key(x: number, z: number): number {
    const ci = Math.max(0, Math.min(this.n - 1, Math.floor((x - this.x0) / CHUNK_SIZE)))
    const cj = Math.max(0, Math.min(this.n - 1, Math.floor((z - this.z0) / CHUNK_SIZE)))
    return cj * this.n + ci
  }

  mesh(x: number, z: number): Mesh {
    const k = this.key(x, z)
    let m = this.terrain.get(k)
    if (!m) {
      m = new Mesh()
      this.terrain.set(k, m)
    }
    return m
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Terrain

const SEG: Record<Blob["kind"], number> = { cay: 8, jungle: 13, volcanic: 17, cliff: 11, stack: 5.5, reef: 0, bank: 0 }
const INTERIOR: Record<Blob["kind"], number[]> = {
  cay: [0.5],
  jungle: [0.8, 0.6, 0.42, 0.26, 0.12],
  volcanic: [0.92, CONE, 0.66, 0.5, 0.37, 0.26, 0.17],
  cliff: [0.72, 0.42, 0.15],
  stack: [0.5],
  reef: [],
  bank: [],
}
const INTERIOR_SEG: Record<Blob["kind"], number> = { cay: 14, jungle: 30, volcanic: 30, cliff: 34, stack: 6, reef: 0, bank: 0 }
/** Seaward skirt: sampled from the shelf profile until it is this deep, then tucked under. */

type Ring = { xs: Float64Array; ys: Float64Array; zs: Float64Array; th: Float64Array; n: number; cls: number }

function ring(n: number, cls: number): Ring {
  return { xs: new Float64Array(n), ys: new Float64Array(n), zs: new Float64Array(n), th: new Float64Array(n), n, cls }
}

/** Band classes (the colour of the band between a ring and the next one inward). */
const C_SKIRT = 0
const C_WET = 1
const C_BEACH = 2
const C_EDGE = 3
const C_FACE = 4
const C_LEDGE = 5
const C_INTERIOR = 6
const C_FOOT = 7

function blobTerrain(b: Blob, chunks: Chunks): void {
  if (b.kind === "reef" || b.kind === "bank") return
  const o = newPolar()
  const D = new Float64Array(32)
  const H = new Float64Array(32)
  const w = [0, 0]
  const perim = Math.PI * 2 * b.R * ((b.sx + b.sy) / 2)
  const wall = b.kind === "cliff" || b.kind === "stack"
  const N = wall ? wallColumns(b) : Math.max(14, Math.round(perim / SEG[b.kind]))
  const ths = new Float64Array(N)
  for (let i = 0; i < N; i++) ths[i] = ((i + (wall ? 0 : (hash3(i, b.seed, 0x51ed) - 0.5) * 0.5)) / N) * Math.PI * 2 - Math.PI

  // Seaward skirt rings at fixed distances from the waterline; their heights follow the seabed per vertex.
  const sea = [4, 12, 24]
  const nStops = coastStops(b, 0, D, H)
  const rings: Ring[] = []
  for (let k = sea.length - 1; k >= 0; k--) rings.push(ring(N, C_SKIRT))
  for (let k = 0; k < nStops; k++) rings.push(ring(N, k === nStops - 1 ? C_INTERIOR : classOf(b, k)))

  for (let i = 0; i < N; i++) {
    const th = ths[i]!
    coastAt(b, th, o)
    coastStops(b, th, D, H)
    const cs = Math.cos(th)
    const sn = Math.sin(th)
    let r = 0
    for (let k = 0; k < sea.length; k++) {
      const R = rings[sea.length - 1 - k]!
      const rp = seawardRadius(b, th, sea[k]!, o)
      blobWorld(b, rp * cs, rp * sn, w)
      R.xs[i] = w[0]!
      R.zs[i] = w[1]!
      R.ys[i] = Math.min(seaHeight(b, sea[k]!, th, w[0]!, w[1]!), k === sea.length - 1 ? -5 : -0.3)
      R.th[i] = th
    }
    coastAt(b, th, o)
    for (let k = 0; k < nStops; k++) {
      const R = rings[sea.length + k]!
      const d = D[k]!
      const rp = o.C - d * o.G
      blobWorld(b, rp * cs, rp * sn, w)
      R.xs[i] = w[0]!
      R.zs[i] = w[1]!
      R.ys[i] = H[k]!
      R.th[i] = th
      r = rp
    }
    void r
  }

  // Interior rings.
  const rhos = INTERIOR[b.kind]
  for (const rho of rhos) {
    let n: number
    let angles: Float64Array
    if (b.kind === "volcanic" && rho <= CONE) {
      // Vertices on the ridge spokes (and halfway between them on the wide lower cone): long radial facets.
      const sp = Float64Array.from(b.spokes, (a) => (a > Math.PI ? a - Math.PI * 2 : a)).sort()
      const sub = rho > 0.45 ? 2 : 1
      angles = new Float64Array(sp.length * sub)
      for (let i = 0; i < sp.length; i++) {
        const a0 = sp[i]!
        const a1 = i + 1 < sp.length ? sp[i + 1]! : sp[0]! + Math.PI * 2
        for (let k = 0; k < sub; k++) angles[i * sub + k] = a0 + ((a1 - a0) * k) / sub
      }
      for (let i = 0; i < angles.length; i++) if (angles[i]! > Math.PI) angles[i]! -= Math.PI * 2
      angles.sort()
      n = angles.length
    } else {
      n = Math.max(6, Math.round((perim * rho) / INTERIOR_SEG[b.kind]))
      angles = new Float64Array(n)
      for (let i = 0; i < n; i++) angles[i] = ((i + (hash3(i, b.seed + Math.round(rho * 1000), 0x2c9) - 0.5) * 0.5) / n) * Math.PI * 2 - Math.PI
    }
    const R = ring(n, C_INTERIOR)
    for (let i = 0; i < n; i++) {
      const th = angles[i]!
      coastAt(b, th, o)
      const ns = coastStops(b, th, D, H)
      const rin = o.C - D[ns - 1]! * o.G
      const rp = rho * rin
      const up = rp * Math.cos(th)
      const vp = rp * Math.sin(th)
      blobWorld(b, up, vp, w)
      R.xs[i] = w[0]!
      R.zs[i] = w[1]!
      R.ys[i] = interiorHeight(b, rho, th, up, vp, H[ns - 1]!)
      R.th[i] = th
    }
    rings.push(R)
  }
  if (b.kind === "volcanic") {
    // Crater: rim ring on the spokes, then a floor ring.
    for (const rho of [b.crater, b.crater * 0.5]) {
      const angles = Float64Array.from(b.spokes, (a) => (a > Math.PI ? a - Math.PI * 2 : a)).sort()
      const R = ring(angles.length, C_INTERIOR)
      for (let i = 0; i < angles.length; i++) {
        const th = angles[i]!
        coastAt(b, th, o)
        const ns = coastStops(b, th, D, H)
        const rp = rho * (o.C - D[ns - 1]! * o.G)
        const up = rp * Math.cos(th)
        const vp = rp * Math.sin(th)
        blobWorld(b, up, vp, w)
        R.xs[i] = w[0]!
        R.zs[i] = w[1]!
        R.ys[i] = interiorHeight(b, rho, th, up, vp, H[ns - 1]!)
        R.th[i] = th
      }
      rings.push(R)
    }
  }
  const centre = ring(1, C_INTERIOR)
  coastStops(b, 0, D, H)
  blobWorld(b, 0, 0, w)
  centre.xs[0] = w[0]!
  centre.zs[0] = w[1]!
  centre.ys[0] = interiorHeight(b, 0, 0, 0, 0, H[coastStops(b, 0, D, H) - 1]!)
  rings.push(centre)

  // Orientation: emit so that beach quads face up.
  const r0 = rings[sea.length]!
  const r1 = rings[sea.length + 1]!
  const flip = normalOf([r0.xs[0]!, 0, r0.zs[0]!], [r0.xs[1]!, 0, r0.zs[1]!], [r1.xs[1]!, 0, r1.zs[1]!])[1] < 0

  const tri = (a: V3, bb: V3, c: V3, cls: number, k: number, i: number) => {
    const p = flip ? [a, c, bb] : [a, bb, c]
    const n = normalOf(p[0]!, p[1]!, p[2]!)
    const cx = (a[0] + bb[0] + c[0]) / 3
    const cy = (a[1] + bb[1] + c[1]) / 3
    const cz = (a[2] + bb[2] + c[2]) / 3
    const col = terrainColor(b, cls, k, i, cx, cy, cz, n[1], o)
    chunks.mesh(cx, cz).facet(p[0]!, p[1]!, p[2]!, col)
  }
  const P = (R: Ring, i: number): V3 => [R.xs[i]!, R.ys[i]!, R.zs[i]!]

  for (let k = 0; k + 1 < rings.length; k++) {
    const A = rings[k]!
    const B = rings[k + 1]!
    const cls = A.cls
    const stop = k - sea.length
    if (A.n === B.n && B.n === N) {
      for (let i = 0; i < N; i++) {
        const j = (i + 1) % N
        const a = P(A, i)
        const bb = P(A, j)
        const c = P(B, j)
        const d = P(B, i)
        // Split along the shorter diagonal for cleaner facets.
        if (Math.hypot(a[0] - c[0], a[2] - c[2]) <= Math.hypot(bb[0] - d[0], bb[2] - d[2])) {
          tri(a, bb, c, cls, stop, i)
          tri(a, c, d, cls, stop, i)
        } else {
          tri(a, bb, d, cls, stop, i)
          tri(bb, c, d, cls, stop, i)
        }
      }
    } else if (B.n === 1) {
      const c = P(B, 0)
      for (let i = 0; i < A.n; i++) tri(P(A, i), P(A, (i + 1) % A.n), c, cls, stop, i)
    } else zip(A, B, (a, bb, c, i) => tri(a, bb, c, cls, stop, i), P)
  }
}

/** Triangulates the band between two closed rings sorted by angle (outer A, inner B). */
function zip(A: Ring, B: Ring, emit: (a: V3, b: V3, c: V3, i: number) => void, P: (R: Ring, i: number) => V3): void {
  const TAU = Math.PI * 2
  // Start both rings at their smallest angle (they are sorted, starting near -π).
  let i = 0
  let j = 0
  const ang = (R: Ring, k: number) => R.th[k % R.n]! + Math.floor(k / R.n) * TAU
  while (i < A.n || j < B.n) {
    const nextA = i < A.n ? ang(A, i + 1) : Infinity
    const nextB = j < B.n ? ang(B, j + 1) : Infinity
    if (nextA <= nextB) {
      emit(P(A, i % A.n), P(A, (i + 1) % A.n), P(B, j % B.n), i)
      i++
    } else {
      emit(P(A, i % A.n), P(B, (j + 1) % B.n), P(B, j % B.n), i)
      j++
    }
  }
}

function classOf(b: Blob, k: number): number {
  switch (b.kind) {
    case "cay":
      return k === 0 ? C_WET : C_BEACH
    case "jungle":
    case "volcanic":
      return k === 0 ? C_WET : k === 1 ? C_BEACH : C_EDGE
    case "cliff":
    case "stack":
      return k === 0 ? C_FOOT : k === 1 ? C_FACE : (k - 2) % 2 === 0 ? C_LEDGE : C_FACE
    case "reef":
    case "bank":
      return C_SKIRT
  }
}

function terrainColor(b: Blob, cls: number, stop: number, i: number, x: number, y: number, z: number, ny: number, o: Polar): Rgb {
  const v = hash3(i * 7 + stop, b.seed, Math.round(x * 3 + z * 7))
  const jit = 0.95 + v * 0.1
  switch (cls) {
    case C_SKIRT:
      return tint(UNDER, jit)
    case C_WET: {
      blobPolar(b, x, z, o)
      return b.kind === "volcanic" && sectorAt(b, o.th) > 0.5 ? tint(DARK_SAND, 0.85) : tint(WET, jit)
    }
    case C_BEACH: {
      if (b.kind === "volcanic") {
        blobPolar(b, x, z, o)
        const s = sectorAt(b, o.th)
        if (s > 0.02) return tint(mix(SAND, DARK_SAND, Math.min(1, s * 1.4)), jit)
      }
      return tint(SAND, 0.98 + v * 0.04)
    }
    case C_EDGE:
      return tint(mix(EDGE, FOREST, 0.35 + v * 0.3), 1)
    case C_FOOT: {
      if (b.kind === "cliff") {
        blobPolar(b, x, z, o)
        if (sectorAt(b, o.th) > 0.3) return tint(SAND, 0.98 + v * 0.04)
      }
      return tint(FOOT_ROCK, jit)
    }
    case C_FACE: {
      const band = Math.floor((stop - 1) / 2)
      const col = hash3(i, band, b.seed)
      if (b.kind === "stack") return tint(mix(STACK, STACK_WARM, col * 0.8), 0.92 + 0.16 * hash3(i, b.seed, 3))
      // Warm sandstone columns streaked with grey ones; the upper band is warmer.
      const warm = Math.min(1, Math.max(0, (col < 0.45 ? 0.1 : 0.8) + band * 0.06))
      return tint(mix(CLIFF_GREY, SANDSTONE, warm), 0.82 + 0.24 * hash3(i, band + 9, b.seed))
    }
    case C_LEDGE:
      return b.kind === "stack" ? tint(mix(STACK_WARM, TUFT, v * 0.35), jit) : tint(mix(LEDGE, SANDSTONE, 0.4 + v * 0.3), 1.05)
    default:
      break
  }
  // Interior.
  switch (b.kind) {
    case "cay":
      return tint(SAND, 0.95 + v * 0.05)
    case "jungle":
      return tint(FOREST, ny < 0.62 ? jit * 0.9 : jit)
    case "volcanic": {
      const f = (y - 5.5) / (b.peak - 5.5)
      blobPolar(b, x, z, o)
      if (o.r < b.crater * o.C * 0.98) return tint(CRATER, jit)
      const jag = 0.07 * noise2(b.n[6]!, o.th * 3, 0.5) + 0.04 * (v - 0.5)
      if (lavaFlow(b, o.th, f) > 0.5) return tint(VOLC_ROCK, jit * 0.92)
      if (f < b.treeline + jag) return tint(FOREST, jit)
      const rock = 0.6 + jag * 2.5
      if (f < rock) return tint(mix(OLIVE, OLIVE_DRY, Math.min(1, Math.max(0, (f - b.treeline) / (rock - b.treeline) + (v - 0.5) * 0.4))), jit)
      return tint(mix(VOLC_ROCK, [0.48, 0.42, 0.38], v), jit)
    }
    case "cliff":
      return tint(v < 0.5 ? PLATEAU : PLATEAU_B, 0.94 + v * 0.12)
    case "stack":
      return tint(mix(STACK_WARM, TUFT, 0.55 + v * 0.3), jit)
    case "reef":
    case "bank":
      return UNDER
  }
}

/** A dark lava tongue down the volcano's flank toward its dark-sand sector, widening downhill. 0..1. */
function lavaFlow(b: Blob, th: number, f: number): number {
  let d = th - b.sector
  d -= Math.PI * 2 * Math.round(d / (Math.PI * 2))
  const w = b.sectorW * (0.12 + 0.3 * (1 - Math.min(1, f / 0.6)))
  return Math.abs(d) < w ? 1 : 0
}

// ---------------------------------------------------------------------------------------------------------------------
// Prototypes

type Proto = { name: string; kind: "crown" | "palm" | "boulder"; v: number[]; tris: number }

function protoCrown(seed: number): Proto {
  const r = new Rng(seed)
  const m = new Mesh()
  const sides = 5
  const rot = r.range(0, Math.PI * 2)
  const hTop = r.range(0.95, 1.15)
  const top = [r.range(-0.1, 0.1), hTop, r.range(-0.1, 0.1)]
  const bot = [0, -0.55, 0]
  const A: number[][] = []
  const B: number[][] = []
  for (let i = 0; i < sides; i++) {
    const a = rot + (i / sides) * Math.PI * 2
    const ra = r.range(0.72, 0.9)
    A.push([Math.cos(a) * ra, hTop * r.range(0.56, 0.66), Math.sin(a) * ra])
    const b2 = a + Math.PI / sides
    const rb = r.range(0.92, 1.08)
    B.push([Math.cos(b2) * rb, r.range(0.04, 0.16), Math.sin(b2) * rb])
  }
  const g = (k: number): Rgb => [k, k, k]
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides
    m.facet(top, A[j]!, A[i]!, g(r.range(1.05, 1.15)))
    m.facet(A[i]!, A[j]!, B[i]!, g(r.range(0.92, 1.02)))
    m.facet(A[j]!, B[j]!, B[i]!, g(r.range(0.9, 1)))
    m.facet(B[i]!, B[j]!, bot, g(0.72))
  }
  fixWinding(m, [0, 0.35, 0])
  return { name: `crown-${seed}`, kind: "crown", v: m.v, tris: m.count / 3 }
}

function protoBoulder(seed: number): Proto {
  const r = new Rng(seed)
  const t = (1 + Math.sqrt(5)) / 2
  const base = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ]
  const faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ]
  const sy = r.range(0.62, 0.8)
  const sxz = r.range(0.9, 1.15)
  const rot = r.range(0, Math.PI)
  const pts = base.map((p) => {
    const l = Math.hypot(p[0]!, p[1]!, p[2]!)
    const k = r.range(0.8, 1.15) / l
    const x = p[0]! * k * sxz
    const z = p[2]! * k
    let y = p[1]! * k * sy
    if (y > 0.45) y = 0.45 + (y - 0.45) * 0.5
    return [x * Math.cos(rot) - z * Math.sin(rot), y, x * Math.sin(rot) + z * Math.cos(rot)]
  })
  const m = new Mesh()
  for (const f of faces) {
    const k = r.range(0.9, 1.08)
    m.facet(pts[f[0]!]!, pts[f[1]!]!, pts[f[2]!]!, [k, k, k])
  }
  fixWinding(m, [0, 0, 0])
  return { name: `boulder-${seed}`, kind: "boulder", v: m.v, tris: m.count / 3 }
}

function protoPalm(seed: number): Proto {
  const r = new Rng(seed)
  const m = new Mesh()
  const H = r.range(15, 20)
  const bend = r.range(0.18, 0.34) * H
  const segs = 3
  const sides = 4
  const rot = r.range(0, Math.PI)
  const rings: number[][][] = []
  const axis: number[][] = []
  for (let s = 0; s <= segs; s++) {
    const f = s / segs
    const cx = bend * f * f
    const cy = -0.6 + (H + 0.6) * f
    const rad = 0.5 - 0.22 * f
    axis.push([cx, cy, 0])
    rings.push(Array.from({ length: sides }, (_, q) => {
      const a = rot + (q / sides) * Math.PI * 2 + s * 0.4
      return [cx + Math.cos(a) * rad, cy, Math.sin(a) * rad]
    }))
  }
  const trunkA: Rgb = [0.72, 0.6, 0.44]
  const trunkB: Rgb = [0.62, 0.5, 0.36]
  for (let s = 0; s < segs; s++) {
    const col = s % 2 === 0 ? trunkA : trunkB
    for (let q = 0; q < sides; q++) {
      const q1 = (q + 1) % sides
      const a0 = rings[s]![q]!
      const a1 = rings[s]![q1]!
      const b0 = rings[s + 1]![q]!
      const b1 = rings[s + 1]![q1]!
      const ref = [(axis[s]![0]! + axis[s + 1]![0]!) / 2, (axis[s]![1]! + axis[s + 1]![1]!) / 2, 0]
      outward(m, a0, a1, b1, ref, col)
      outward(m, a0, b1, b0, ref, col)
    }
  }
  const T = axis[segs]!
  const nf = 7 + r.int(3)
  const a0 = r.range(0, Math.PI * 2)
  for (let f = 0; f < nf; f++) {
    const a = a0 + (f / nf) * Math.PI * 2 + r.range(-0.25, 0.25)
    const L = r.range(9, 11)
    const dx = Math.cos(a)
    const dz = Math.sin(a)
    const up = r.range(0.4, 1.2)
    const droop = r.range(1.8, 3.2)
    const w = r.range(2.4, 3)
    const base = [T[0]!, T[1]! + 0.2, T[2]!]
    const mid = [T[0]! + dx * L * 0.5, T[1]! + up, T[2]! + dz * L * 0.5]
    const tip = [T[0]! + dx * L, T[1]! - droop, T[2]! + dz * L]
    const left = [mid[0]! - dz * w, mid[1]! - 0.45, mid[2]! + dx * w]
    const right = [mid[0]! + dz * w, mid[1]! - 0.45, mid[2]! - dx * w]
    const k = r.range(0.88, 1.1)
    // Lighter, yellower than the broadleaf canopy so the palm ring reads in front of it.
    const col: Rgb = [0.56 * k, 0.78 * k, 0.2 * k]
    const colB: Rgb = [0.42 * k, 0.64 * k, 0.15 * k]
    m.facet(base, mid, left, col, MAT.foliage)
    m.facet(base, right, mid, colB, MAT.foliage)
    m.facet(mid, tip, left, col, MAT.foliage)
    m.facet(mid, right, tip, colB, MAT.foliage)
  }
  return { name: `palm-${seed}`, kind: "palm", v: m.v, tris: m.count / 3 }
}

function outward(m: Mesh, a: number[], b: number[], c: number[], ref: number[], col: Rgb): void {
  const n = normalOf(a, b, c)
  const d = ((a[0]! + b[0]! + c[0]!) / 3 - ref[0]!) * n[0] + ((a[1]! + b[1]! + c[1]!) / 3 - ref[1]!) * n[1] + ((a[2]! + b[2]! + c[2]!) / 3 - ref[2]!) * n[2]
  if (d >= 0) m.facet(a, b, c, col)
  else m.facet(a, c, b, col)
}

/** Rewinds every triangle of a convex-ish prototype so it faces away from `ref`. */
function fixWinding(m: Mesh, ref: number[]): void {
  const v = m.v
  const F = FLOATS_PER_VERT
  for (let t = 0; t < v.length; t += F * 3) {
    const a = [v[t]!, v[t + 1]!, v[t + 2]!]
    const b = [v[t + F]!, v[t + F + 1]!, v[t + F + 2]!]
    const c = [v[t + 2 * F]!, v[t + 2 * F + 1]!, v[t + 2 * F + 2]!]
    const n = normalOf(a, b, c)
    const d = ((a[0]! + b[0]! + c[0]!) / 3 - ref[0]!) * n[0] + ((a[1]! + b[1]! + c[1]!) / 3 - ref[1]!) * n[1] + ((a[2]! + b[2]! + c[2]!) / 3 - ref[2]!) * n[2]
    const fl = d < 0 ? -1 : 1
    if (fl < 0) {
      for (let k = 0; k < F; k++) {
        const tmp = v[t + F + k]!
        v[t + F + k] = v[t + 2 * F + k]!
        v[t + 2 * F + k] = tmp
      }
    }
    for (let q = 0; q < 3; q++) {
      v[t + q * F + 3] = n[0] * fl
      v[t + q * F + 4] = n[1] * fl
      v[t + q * F + 5] = n[2] * fl
    }
  }
}

/** A tall faceted crag: a boulder stretched upward with a flattish, tilted top (rock outcrops, cliff faces). */
function protoCrag(seed: number): Proto {
  const p = protoBoulder(seed)
  const r = new Rng(seed ^ 77)
  const sy = r.range(1.7, 2.3)
  const tilt = r.range(0.15, 0.35)
  const m = new Mesh()
  for (let q = 0; q < p.v.length; q += FLOATS_PER_VERT) {
    const x = p.v[q]!
    const z = p.v[q + 2]!
    let y = p.v[q + 1]!
    y = y > 0 ? y * sy + x * tilt : y * 1.2
    m.vert([x * 0.95, y, z * 0.8], [0, 1, 0], [p.v[q + 6]!, p.v[q + 7]!, p.v[q + 8]!], MAT.lit)
  }
  fixWinding(m, [0, 0.3, 0])
  return { name: `crag-${seed}`, kind: "boulder", v: m.v, tris: m.count / 3 }
}

let protoCache: Proto[] | null = null

/** Prototype order: 6 crowns, 4 palms, 6 boulders, 3 crags. */
function protos(): Proto[] {
  if (!protoCache) {
    protoCache = [
      ...[11, 23, 37, 41, 59, 67].map(protoCrown),
      ...[101, 113, 127, 131].map(protoPalm),
      ...[201, 211, 223, 227, 229, 233].map(protoBoulder),
      ...[301, 307, 311].map(protoCrag),
    ]
  }
  return protoCache
}
const CROWN0 = 0
const PALM0 = 6
const BOULDER0 = 10
const CRAG0 = 16

// ---------------------------------------------------------------------------------------------------------------------
// Scatter

type Inst = { proto: number; x: number; y: number; z: number; yaw: number; scale: number; c: Rgb; tier: number; pri: number }

type Scatter = { arch: Archipelago; out: Inst[]; probe: Probe; o: Polar; D: Float64Array; H: Float64Array }

function ground(S: Scatter, x: number, z: number): number {
  return terrainProbe(S.arch, x, z, S.probe).h
}

function downhill(S: Scatter, x: number, z: number, r: Rng): number {
  const e = 3
  const gx = ground(S, x + e, z) - ground(S, x - e, z)
  const gz = ground(S, x, z + e) - ground(S, x, z - e)
  if (Math.hypot(gx, gz) < 0.02) return r.range(0, Math.PI * 2)
  return Math.atan2(-gz, -gx) + r.range(-0.55, 0.55)
}

/**
 * Toward the sun of src/render/atmosphere.ts (azimuth 32°, elevation 38°). Canopy hides the ground, and the renderer
 * has no shadows, so each crown's tint carries a little of its hillside's sun/shade to keep the hills readable.
 */
const SUN: V3 = [Math.cos(0.663) * Math.sin(0.559), Math.sin(0.663), -Math.cos(0.663) * Math.cos(0.559)]

function slopeShade(S: Scatter, x: number, z: number): number {
  const e = 6
  const gx = (ground(S, x + e, z) - ground(S, x - e, z)) / (2 * e)
  const gz = (ground(S, x, z + e) - ground(S, x, z - e)) / (2 * e)
  const l = Math.hypot(gx, 1, gz)
  const ndl = (-gx * SUN[0] + SUN[1] - gz * SUN[2]) / l
  return Math.min(1.12, Math.max(0.7, 0.48 + 0.72 * ndl))
}

function addCrown(S: Scatter, r: Rng, x: number, y: number, z: number, rad: number, col: Rgb, tier: number): void {
  const k = r.range(0.92, 1.08) * (tier >= 3 ? slopeShade(S, x, z) : 1)
  S.out.push({ proto: CROWN0 + r.int(6), x, y: y + rad * 0.22, z, yaw: r.range(0, Math.PI * 2), scale: rad, c: tint(col, k), tier, pri: r.next() })
}

function addPalm(S: Scatter, r: Rng, x: number, y: number, z: number): void {
  S.out.push({ proto: PALM0 + r.int(4), x, y, z, yaw: downhill(S, x, z, r), scale: r.range(1.35, 1.75), c: tint([1, 1, 1], r.range(0.95, 1.1)), tier: 1, pri: r.next() })
}

/** Places a boulder of radius s whose base is embedded in the ground; skips ones that would sit fully underwater. */
function addBoulder(S: Scatter, r: Rng, x: number, z: number, s: number, col: Rgb): void {
  const h = ground(S, x, z)
  const y = h + 0.18 * s
  if (y + 0.55 * s < 0.35) return
  S.out.push({ proto: BOULDER0 + r.int(6), x, y, z, yaw: r.range(0, Math.PI * 2), scale: s, c: tint(col, r.range(0.85, 1.12)), tier: 0, pri: r.next() })
}

function canopyColour(r: Rng, x: number, z: number): Rgb {
  // Mostly per clump, with a gentle regional bias so patches of lighter and darker forest show.
  const g = noise2(911, x / 90, z / 90)
  const k = Math.max(0, Math.min(CANOPY.length - 1, Math.floor(r.next() * CANOPY.length + g * 2)))
  return tint(CANOPY[k]!, r.range(0.95, 1.08))
}

function scatterBlob(S: Scatter, b: Blob): void {
  if (b.kind === "reef" || b.kind === "bank") return
  const r = new Rng(b.seed ^ 0x68e31da4)
  const o = S.o
  const W = [0, 0]
  const E = b.extent + 30
  const grid = (cell: number, fn: (x: number, z: number) => void) => {
    const n = Math.ceil((E * 2) / cell)
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = b.x - E + (i + r.next()) * cell
        const z = b.z - E + (j + r.next()) * cell
        fn(x, z)
      }
    }
  }
  const own = (x: number, z: number) => terrainProbe(S.arch, x, z, S.probe).owner === b.index
  const stops = (th: number) => {
    const n = coastStops(b, th, S.D, S.H)
    return S.D[n - 1]!
  }
  const beachW = (th: number) => (b.kind === "cliff" || b.kind === "stack" ? 0 : (coastStops(b, th, S.D, S.H), S.D[2]!))

  // Rock outcrops first (the canopy keeps clear of them): 2-3 big grey crag groups on the upper slopes.
  const crags: [number, number, number][] = []
  if (b.kind === "jungle" || (b.kind === "volcanic" && b.R > 0)) {
    const cand: [number, number, number][] = []
    grid(24, (x, z) => {
      if (!own(x, z)) return
      const h = S.probe.h
      const f = h / b.peak
      if (f < 0.4 || f > (b.kind === "volcanic" ? b.treeline * 1.4 : 0.95)) return
      const e = 5
      const sl = Math.hypot(ground(S, x + e, z) - ground(S, x - e, z), ground(S, x, z + e) - ground(S, x, z - e)) / (2 * e)
      cand.push([sl + r.next() * 0.25, x, z])
    })
    cand.sort((p, q) => q[0] - p[0])
    const n = b.kind === "jungle" ? Math.min(cand.length, b.R > 200 ? 2 + r.int(2) : 1 + r.int(2)) : Math.min(cand.length, 1 + r.int(2))
    for (const [, x, z] of cand) {
      if (crags.length >= n) break
      if (crags.some(([cx, cz]) => Math.hypot(x - cx, z - cz) < b.R * 0.45)) continue
      const size = r.range(20, 30) * Math.min(1.3, 0.7 + b.R / 600)
      crags.push([x, z, size])
      // Downhill direction: the face looks down the slope.
      const yaw = downhill(S, x, z, r)
      const k = 3 + r.int(3)
      for (let q = 0; q < k; q++) {
        const off = q === 0 ? 0 : size * r.range(0.6, 1.1)
        const a = yaw + Math.PI / 2 + r.range(-0.6, 0.6) + (q % 2 ? Math.PI : 0)
        const bx = x + Math.cos(a) * off
        const bz = z + Math.sin(a) * off
        const sz = size * (q === 0 ? 1 : r.range(0.5, 0.8))
        S.out.push({ proto: CRAG0 + r.int(3), x: bx, y: ground(S, bx, bz) - 0.15 * sz, z: bz, yaw: -yaw + r.range(-0.3, 0.3), scale: sz, c: tint(BOULDER, r.range(1, 1.2)), tier: 0, pri: r.next() })
      }
    }
  }
  const nearCrag = (x: number, z: number) => crags.some(([cx, cz, sz]) => Math.hypot(x - cx, z - cz) < sz * 1.1)

  // Canopy: closed jungle of clumps in mixed sizes; a few emergent giants give the skyline its bumps.
  if (b.kind === "jungle" || b.kind === "volcanic") {
    const cell = b.kind === "volcanic" ? 14.5 : 12.5
    const clump = () => {
      const t = r.next()
      return t < 0.7 ? r.range(6.5, 9.5) : t < 0.94 ? r.range(10, 14) : r.range(15, 20)
    }
    grid(cell, (x, z) => {
      if (r.next() > 0.95) return
      blobPolar(b, x, z, o)
      const B = beachW(o.th)
      if (o.d < B + 14 + 5 * noise2(b.n[7]!, x / 40, z / 40)) return
      if (!own(x, z) || nearCrag(x, z)) return
      const h = S.probe.h
      if (b.kind === "volcanic") {
        const f = (h - 5.5) / (b.peak - 5.5)
        const line = b.treeline + 0.07 * noise2(b.n[6]!, o.th * 3, 0.5)
        if (lavaFlow(b, o.th, f) > 0.5) return
        // Dense jungle at the foot, thinning up the green slopes, none on the bare cone.
        if (f > line && r.next() > 0.6 * (1 - ss01((f - line) / 0.22))) return
      }
      const big = b.kind === "volcanic" ? 1.15 : 1
      const rad = clump() * big
      // Bigger clumps stand taller, so they break the canopy line.
      addCrown(S, r, x, h + (rad > 12 ? rad * 0.25 : 0), z, rad, canopyColour(r, x, z), rad > 12 ? 2 : 3)
      // Steep ground has more surface per plan cell: add a second, offset crown so the canopy stays closed.
      const e = 4
      const slope = Math.hypot(ground(S, x + e, z) - ground(S, x - e, z), ground(S, x, z + e) - ground(S, x, z - e)) / (2 * e)
      const extra = Math.floor(slope * 1.6 + r.next())
      for (let q = 0; q < extra; q++) {
        const a = r.range(0, Math.PI * 2)
        const x2 = x + Math.cos(a) * cell * r.range(0.3, 0.6)
        const z2 = z + Math.sin(a) * cell * r.range(0.3, 0.6)
        if (!nearCrag(x2, z2)) addCrown(S, r, x2, ground(S, x2, z2), z2, r.range(6.5, 10) * big, canopyColour(r, x2, z2), 4)
      }
    })
  }
  if (b.kind === "cliff") {
    grid(11, (x, z) => {
      blobPolar(b, x, z, o)
      const din = stops(o.th)
      if (o.d < din + 3) return
      const cl = noise2(b.n[7]!, x / 60, z / 60)
      if (r.next() > 0.25 + 0.6 * Math.max(0, cl)) return
      if (!own(x, z)) return
      addCrown(S, r, x, S.probe.h, z, r.range(4, 6.5), canopyColour(r, x, z), 2)
    })
  }
  if (b.kind === "stack") {
    grid(5, (x, z) => {
      blobPolar(b, x, z, o)
      const din = stops(o.th)
      const top = o.d > din + 1
      if (r.next() > (top ? 0.35 : 0.05) || o.d < 3) return
      if (!own(x, z)) return
      addCrown(S, r, x, S.probe.h - 1, z, top ? r.range(3.5, 5.5) : r.range(2.2, 3.2), canopyColour(r, x, z), 2)
    })
  }

  // Palms: clustered fringe on beaches, a grove on cays, a few mixed into the forest edge.
  if (b.kind !== "stack") {
    grid(11, (x, z) => {
      blobPolar(b, x, z, o)
      const cl = noise2(b.n[4]!, x / 55, z / 55)
      let p = 0
      if (b.kind === "cay") {
        const B = beachW(o.th)
        if (o.d < B * 0.5) return
        // A palm grove over most of the cay (spread along bent motus), thinning toward the beach.
        const grove = b.bend > 0 ? Math.cos(o.u / 30 + b.hPhase) > -0.1 : o.r < Math.min(o.C * 0.4, 30)
        p = grove ? (b.bend > 0 ? 0.4 : 0.6) : 0.03
      } else if (b.kind === "cliff") {
        const din = stops(o.th)
        if (sectorAt(b, o.th) < 0.4 || o.d < 6 || o.d > din - 18) return
        p = 0.4
      } else {
        const B = beachW(o.th)
        if (o.d < B * 0.3 || o.d > B * 0.9) return
        if (b.kind === "volcanic" && sectorAt(b, o.th) > 0.3) return
        // Clusters of palms standing out on the sand in front of the forest, open sand between clusters.
        p = cl > -0.05 ? 0.7 : cl > -0.25 ? 0.25 : 0.03
      }
      if (r.next() > p) return
      if (!own(x, z)) return
      addPalm(S, r, x, S.probe.h, z)
    })
  }
  if (b.kind === "cay") {
    grid(9, (x, z) => {
      blobPolar(b, x, z, o)
      if (o.r > o.C * 0.5 || r.next() > 0.2) return
      if (!own(x, z)) return
      addCrown(S, r, x, S.probe.h, z, r.range(1.8, 3.2), mix(CANOPY[4]!, CANOPY[6]!, r.next()), 2)
    })
  }

  // Boulders.
  const along = (th: number, d: number) => {
    coastAt(b, th, o)
    const rp = o.C - d * o.G
    return blobWorld(b, rp * Math.cos(th), rp * Math.sin(th), W)
  }
  if (b.kind === "cay" || b.kind === "jungle" || b.kind === "volcanic") {
    // Cluster sites: headlands (between coves), both ends of every bay's beach, and the most protruding points.
    const sites: number[] = []
    const V = b.coves
    for (let k = 0; k < V.length; k += 3) {
      sites.push(V[k]! + V[k + 1]! * 0.85, V[k]! - V[k + 1]! * 0.85)
    }
    const cand: [number, number][] = []
    for (let i = 0; i < 48; i++) {
      const th = (i / 48) * Math.PI * 2 - Math.PI
      coastAt(b, th, o)
      cand.push([o.C * (1 - coveAt(b, th)) + r.range(0, b.R * 0.04), th])
    }
    cand.sort((p, q) => q[0] - p[0])
    const extra = b.kind === "cay" ? (b.bend > 0 ? r.int(2) : 2 + r.int(2)) : Math.round(3 + b.R / 70)
    for (let c = 0; c < extra; c++) sites.push(cand[(c * 7) % cand.length]![1])
    // Fewer, bigger, light grey rounded rocks: a few large ones on the sand at each site, smaller ones around them at
    // the waterline, hardly any out on the reef.
    const big = b.kind === "cay" ? [9, 14] : [16, 26]
    const scale = b.kind === "cay" ? 0.85 : Math.min(1.2, 0.65 + b.R / 450)
    for (const th0 of sites) {
      const n = b.kind === "cay" ? 3 + r.int(3) : 4 + r.int(5)
      const spread = (b.kind === "cay" ? 14 : 30) / Math.max(30, b.R)
      for (let q = 0; q < n; q++) {
        const th = th0 + r.range(-spread, spread) * (q < 2 ? 0.4 : 1)
        const B = beachW(th)
        const d = q < 2 ? r.range(0, B * 0.45) : r.range(-8, B * 0.3)
        const p = along(th, d)
        if (!own(p[0]!, p[1]!)) continue
        const s = q < 2 ? r.range(big[0]!, big[1]!) * (q === 0 ? 1 : 0.7) * scale : r.range(5, 10) * scale
        addBoulder(S, r, p[0]!, p[1]!, s, BOULDER)
      }
    }
    // A few loose rocks along the beaches and right at the waterline.
    const loose = Math.round((b.R / 30) * (b.kind === "cay" ? 0.4 : 1))
    for (let q = 0; q < loose; q++) {
      const th = r.range(-Math.PI, Math.PI)
      const p = along(th, r.range(-6, beachW(th) * 0.5))
      if (own(p[0]!, p[1]!)) addBoulder(S, r, p[0]!, p[1]!, r.range(4, 8) * scale, BOULDER)
    }
  }
  if (b.kind === "volcanic") {
    grid(12, (x, z) => {
      blobPolar(b, x, z, o)
      const s = sectorAt(b, o.th)
      if (s < 0.2) return
      const B = beachW(o.th)
      if (o.d < -30 || o.d > B + 30 || r.next() > 0.3 * s * s) return
      if (!own(x, z)) return
      addBoulder(S, r, x, z, r.range(6, 14), LAVA)
    })
  }
  if (b.kind === "cliff" || b.kind === "stack") {
    const perim = Math.PI * 2 * b.R * ((b.sx + b.sy) / 2)
    const n = Math.round(perim / (b.kind === "cliff" ? 9 : 5))
    for (let i = 0; i < n; i++) {
      const th = (i / n) * Math.PI * 2 - Math.PI + r.range(-0.3, 0.3) / n
      const cove = b.kind === "cliff" ? sectorAt(b, th) : 0
      if (r.next() > (b.kind === "cliff" ? 0.6 : 0.5) * (1 - cove * 0.85)) continue
      const p = along(th, r.range(b.kind === "cliff" ? -14 : -9, b.kind === "cliff" ? 3 : 1))
      if (!own(p[0]!, p[1]!)) continue
      addBoulder(S, r, p[0]!, p[1]!, b.kind === "cliff" ? r.range(3.5, 9) : r.range(2.5, 6), FOOT)
    }
  }
}

const FOOT: Rgb = [0.5, 0.47, 0.44]

function ss01(t: number): number {
  const c = Math.min(1, Math.max(0, t))
  return c * c * (3 - 2 * c)
}

function scatter(arch: Archipelago): Inst[] {
  const S: Scatter = { arch, out: [], probe: { h: 0, owner: -1 }, o: newPolar(), D: new Float64Array(32), H: new Float64Array(32) }
  for (const b of archBlobs(arch)) scatterBlob(S, b)
  return S.out
}

/** Drops the lowest-priority canopy so terrain plus props stay within TRI_BUDGET. */
function thin(insts: Inst[], terrainTris: number): Inst[] {
  const P = protos()
  let tris = terrainTris
  for (const i of insts) tris += P[i.proto]!.tris
  if (tris <= TRI_BUDGET) return insts
  const order = insts.map((_, k) => k).filter((k) => insts[k]!.tier >= 3).sort((a, b) => insts[b]!.tier - insts[a]!.tier || insts[a]!.pri - insts[b]!.pri)
  const drop = new Uint8Array(insts.length)
  for (const k of order) {
    if (tris <= TRI_BUDGET) break
    drop[k] = 1
    tris -= P[insts[k]!.proto]!.tris
  }
  return insts.filter((_, k) => !drop[k])
}

// ---------------------------------------------------------------------------------------------------------------------
// Packing

const f16buf = new Float32Array(1)
const f16bits = new Uint32Array(f16buf.buffer)
function toHalf(v: number): number {
  f16buf[0] = v
  const x = f16bits[0]!
  const sign = (x >>> 16) & 0x8000
  let exp = ((x >>> 23) & 0xff) - 127 + 15
  const mant = x & 0x7fffff
  if (exp <= 0) return sign
  if (exp >= 31) return sign | 0x7c00
  let m = mant >> 13
  if (mant & 0x1000) {
    m++
    if (m === 0x400) {
      m = 0
      exp++
    }
  }
  return sign | (exp << 10) | m
}

const byte = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)))
const snorm = (v: number) => Math.max(-127, Math.min(127, Math.round(v * 127)))

/** Writes one instance of a prototype into packed vertex memory at vertex offset `at`. Returns the next offset. */
function writeInstance(p: Proto, inst: Inst, f: Float32Array, i8: Int8Array, u8: Uint8Array, u16: Uint16Array, at: number, box: Float64Array): number {
  const c = Math.cos(inst.yaw)
  const s = Math.sin(inst.yaw)
  const k = inst.scale
  const v = p.v
  const F = FLOATS_PER_VERT
  const aux = toHalf((((inst.x * 0.0137 + inst.z * 0.0071) % 1) + 1) % 1)
  for (let q = 0; q < v.length; q += F) {
    const lx = v[q]! * k
    const lz = v[q + 2]! * k
    const x = lx * c - lz * s + inst.x
    const z = lx * s + lz * c + inst.z
    const o = at * VERT_BYTES
    f[o / 4] = x
    f[o / 4 + 1] = v[q + 1]! * k + inst.y
    f[o / 4 + 2] = z
    const nx = v[q + 3]!
    const nz = v[q + 5]!
    i8[o + 12] = snorm(nx * c - nz * s)
    i8[o + 13] = snorm(v[q + 4]!)
    i8[o + 14] = snorm(nx * s + nz * c)
    i8[o + 15] = 0
    u8[o + 16] = byte(v[q + 6]! * inst.c[0])
    u8[o + 17] = byte(v[q + 7]! * inst.c[1])
    u8[o + 18] = byte(v[q + 8]! * inst.c[2])
    u8[o + 19] = 255
    u16[(o + 20) / 2] = toHalf(v[q + 9]!)
    u16[(o + 22) / 2] = v[q + 9] === MAT.foliage ? aux : 0
    if (x < box[0]!) box[0] = x
    if (z < box[1]!) box[1] = z
    if (x > box[2]!) box[2] = x
    if (z > box[3]!) box[3] = z
    at++
  }
  return at
}

function terrainChunks(arch: Archipelago): Chunks {
  const [bx0, bz0, bx1, bz1] = arch.bounds
  const side = Math.max(bx1 - bx0, bz1 - bz0)
  const chunks = new Chunks(bx0, bz0, Math.ceil(side / CHUNK_SIZE))
  for (const b of archBlobs(arch)) blobTerrain(b, chunks)
  return chunks
}

function terrainTriangles(chunks: Chunks): number {
  let n = 0
  for (const m of chunks.terrain.values()) n += m.count / 3
  return n
}

/** Prototypes and instance lists for an instancing renderer (terrain comes from `buildIslandMesh(arch, { props: false })`). */
export function buildIslandProps(arch: Archipelago): IslandProps {
  const P = protos()
  const insts = thin(scatter(arch), terrainTriangles(terrainChunks(arch)))
  const lists: number[][] = P.map(() => [])
  for (const i of insts) lists[i.proto]!.push(i.x, i.y, i.z, i.yaw, i.scale, i.c[0], i.c[1], i.c[2])
  const proto = (p: Proto) => {
    const m = new Mesh()
    m.v.push(...p.v)
    return { name: p.name, data: m.pack(), tris: p.tris }
  }
  return { protos: P.map(proto), instances: lists.map((l) => Float32Array.from(l)) }
}

/** Chunked static geometry: terrain and (unless `props: false`) every prop merged in. */
export function buildIslandMesh(arch: Archipelago, opts: { props?: boolean } = {}): StaticChunk[] {
  const chunks = terrainChunks(arch)
  const P = protos()
  const insts = opts.props === false ? [] : thin(scatter(arch), terrainTriangles(chunks))
  const perChunk = new Map<number, Inst[]>()
  for (const i of insts) {
    const k = chunks.key(i.x, i.z)
    let l = perChunk.get(k)
    if (!l) perChunk.set(k, (l = []))
    l.push(i)
  }
  const keys = [...new Set([...chunks.terrain.keys(), ...perChunk.keys()])].sort((a, b) => a - b)
  const out: StaticChunk[] = []
  for (const key of keys) {
    const m = chunks.terrain.get(key)
    const list = perChunk.get(key) ?? []
    const tv = m ? m.count : 0
    let pv = 0
    for (const i of list) pv += P[i.proto]!.v.length / FLOATS_PER_VERT
    if (tv + pv === 0) continue
    const buf = new ArrayBuffer((tv + pv) * VERT_BYTES)
    const u8 = new Uint8Array(buf)
    const box = new Float64Array([Infinity, Infinity, -Infinity, -Infinity])
    if (m) {
      u8.set(new Uint8Array(m.pack()), 0)
      for (let q = 0; q < m.v.length; q += FLOATS_PER_VERT) {
        const x = m.v[q]!
        const z = m.v[q + 2]!
        if (x < box[0]!) box[0] = x
        if (z < box[1]!) box[1] = z
        if (x > box[2]!) box[2] = x
        if (z > box[3]!) box[3] = z
      }
    }
    const f = new Float32Array(buf)
    const i8 = new Int8Array(buf)
    const u16 = new Uint16Array(buf)
    let at = tv
    for (const i of list) at = writeInstance(P[i.proto]!, i, f, i8, u8, u16, at, box)
    out.push({ data: buf, box: [Math.floor(box[0]!), Math.floor(box[1]!), Math.ceil(box[2]!), Math.ceil(box[3]!)] })
  }
  return out
}

export function countTriangles(chunks: readonly StaticChunk[]): number {
  let n = 0
  for (const c of chunks) n += c.data.byteLength / (VERT_BYTES * 3)
  return n
}
