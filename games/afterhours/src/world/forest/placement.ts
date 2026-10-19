import { compoundDistance, fbm, heightAt, roadEdgeDistance, smoothstep } from "../height"
import { ACCESS_ROAD, POWER, WORLD_HALF, accessRoadSamples } from "../layout"
import { hash3 } from "./rng"
import type { Kind } from "./species"

// Deterministic tree placement: jittered grids per layer (mature canopy, young trees, saplings) gated by a density
// noise (clearings and thickets), species stands, and clearances from roads, the compound and the power line.

export const VARIANTS: { kind: Kind; seed: number }[] = [
  { kind: "fir", seed: 101 },
  { kind: "fir", seed: 102 },
  { kind: "fir", seed: 103 },
  { kind: "firEdge", seed: 201 },
  { kind: "firEdge", seed: 202 },
  { kind: "pine", seed: 301 },
  { kind: "pine", seed: 302 },
  { kind: "young", seed: 401 },
  { kind: "young", seed: 402 },
  { kind: "sapling", seed: 501 },
  { kind: "snag", seed: 601 },
]
const byKind = (k: Kind) => VARIANTS.flatMap((v, i) => (v.kind === k ? [i] : []))
const KIND_VARIANTS: Record<Kind, number[]> = {
  fir: byKind("fir"),
  firEdge: byKind("firEdge"),
  pine: byKind("pine"),
  young: byKind("young"),
  sapling: byKind("sapling"),
  snag: byKind("snag"),
}

export type Trees = {
  count: number
  x: Float32Array
  y: Float32Array
  z: Float32Array
  scale: Float32Array
  yaw: Float32Array
  tint: Float32Array
  phase: Float32Array
  variant: Uint8Array
  /** Spatial grid: trees sorted by cell, `cellStart[c]..cellStart[c+1]` indexes into `order`. */
  grid: { size: number; n: number; cellStart: Uint32Array; order: Uint32Array }
}

export type Settings = { density: number; seed: number }

/** Horizontal distance to the power line (poles east of the access road). */
function powerLineDistance(): (x: number, z: number) => number {
  const s = accessRoadSamples(6)
  const pts: [number, number][] = []
  for (let i = 0; i < s.length; i++) {
    const a = s[Math.max(0, i - 1)]!
    const b = s[Math.min(s.length - 1, i + 1)]!
    const dx = b[0] - a[0]
    const dz = b[1] - a[1]
    const l = Math.hypot(dx, dz) || 1
    // Right-hand normal when heading north (-z) points east (+x).
    pts.push([s[i]![0] - (dz / l) * POWER.offset, s[i]![1] + (dx / l) * POWER.offset])
  }
  return (x, z) => {
    let best = 1e9
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, az] = pts[i]!
      const [bx, bz] = pts[i + 1]!
      const abx = bx - ax
      const abz = bz - az
      let t = ((x - ax) * abx + (z - az) * abz) / (abx * abx + abz * abz || 1)
      t = Math.max(0, Math.min(1, t))
      const d = Math.hypot(x - ax - abx * t, z - az - abz * t)
      if (d < best) best = d
    }
    return best
  }
}

export function placeTrees(settings: Settings): Trees {
  const seed = settings.seed
  const powerDist = powerLineDistance()
  // The power line only matters near the access road; skip the polyline test elsewhere.
  const nearAccess = (x: number, z: number) => z > 40 && z < 450 && Math.abs(x) < 60 + ACCESS_ROAD.width
  const cap = 160_000
  const X = new Float32Array(cap)
  const Y = new Float32Array(cap)
  const Z = new Float32Array(cap)
  const S = new Float32Array(cap)
  const R = new Float32Array(cap)
  const T = new Float32Array(cap)
  const P = new Float32Array(cap)
  const V = new Uint8Array(cap)
  let n = 0

  // Occupancy hash for spacing between layers (2 m cells holding the largest trunk radius of nearby trees).
  const OCC = 2
  const occN = Math.ceil((WORLD_HALF * 2) / OCC)
  const occ = new Uint8Array(occN * occN)
  const occAt = (x: number, z: number) => {
    const i = Math.floor((x + WORLD_HALF) / OCC)
    const j = Math.floor((z + WORLD_HALF) / OCC)
    return i >= 0 && j >= 0 && i < occN && j < occN ? j * occN + i : -1
  }
  const mark = (x: number, z: number, r: number, level: number) => {
    const c = Math.ceil(r / OCC)
    const i0 = Math.floor((x + WORLD_HALF) / OCC)
    const j0 = Math.floor((z + WORLD_HALF) / OCC)
    for (let j = j0 - c; j <= j0 + c; j++)
      for (let i = i0 - c; i <= i0 + c; i++) {
        if (i < 0 || j < 0 || i >= occN || j >= occN) continue
        const cx = -WORLD_HALF + (i + 0.5) * OCC
        const cz = -WORLD_HALF + (j + 0.5) * OCC
        if (Math.hypot(cx - x, cz - z) <= r + OCC * 0.5) occ[j * occN + i] = Math.max(occ[j * occN + i]!, level)
      }
  }

  const add = (x: number, z: number, variant: number, scale: number, h: number) => {
    if (n >= cap) return
    X[n] = x
    Y[n] = heightAt(x, z)
    Z[n] = z
    S[n] = scale
    R[n] = h * Math.PI * 2
    T[n] = 0.78 + hash3(x * 7, z * 7, seed + 5) * 0.4
    P[n] = hash3(x * 3, z * 3, seed + 6) * 100
    V[n] = variant
    n++
  }
  const pick = (k: Kind, h: number) => {
    const list = KIND_VARIANTS[k]
    return list[Math.floor(h * list.length) % list.length]!
  }
  const density = settings.density

  // Layer 1: mature canopy on a 6 m jittered grid.
  const M = 6
  const steps = Math.floor((WORLD_HALF * 2) / M)
  for (let j = 0; j < steps; j++) {
    for (let i = 0; i < steps; i++) {
      const h0 = hash3(i, j, seed)
      if (h0 > 0.95 * density) continue
      const x = -WORLD_HALF + (i + 0.5 + (hash3(i, j, seed + 1) - 0.5) * 0.85) * M
      const z = -WORLD_HALF + (j + 0.5 + (hash3(i, j, seed + 2) - 0.5) * 0.85) * M
      const road = roadEdgeDistance(x, z)
      const comp = compoundDistance(x, z)
      const clear = 5.2 + hash3(i, j, seed + 3) * 3.5
      // Treeline 6–12 m outside the fence, wavering with low-frequency noise so the cut isn't straight.
      const lineWobble = fbm(x, z, 2, 1 / 45, seed + 41) * 3
      if (road < clear || comp < 7 + lineWobble + hash3(i, j, seed + 4) * 4) continue
      if (nearAccess(x, z) && powerDist(x, z) < 5.5) continue
      const D = fbm(x, z, 3, 1 / 120, seed + 7) * 0.5 + 0.5
      const p = Math.min(0.97, Math.max(0.05, (D - 0.12) * 1.8)) * density
      if (h0 > p) continue
      const stand = fbm(x, z, 2, 1 / 190, seed + 9) * 0.5 + 0.5
      const edge = 1 - smoothstep(6, 22, Math.min(road, comp - 6))
      const hk = hash3(i, j, seed + 10)
      let kind: Kind
      if (hk < 0.045) kind = "snag"
      else if (stand > 0.6 && hk < 0.25 + (stand - 0.6) * 2.5) kind = "pine"
      else if (edge > 0.3 && hk < 0.4 + edge * 0.5) kind = "firEdge"
      else kind = "fir"
      const big = hash3(i, j, seed + 11)
      const scale = 0.8 + big * 0.32 + (big > 0.93 ? 0.15 : 0)
      add(x, z, pick(kind, hash3(i, j, seed + 12)), scale, hash3(i, j, seed + 13))
      mark(x, z, kind === "pine" ? 2.2 : 2.8, 2)
    }
  }

  // Layer 2: young trees filling gaps and crowding the edges.
  const Yg = 4
  const ys = Math.floor((WORLD_HALF * 2) / Yg)
  for (let j = 0; j < ys; j++) {
    for (let i = 0; i < ys; i++) {
      const h0 = hash3(i, j, seed + 20)
      if (h0 > 0.55 * density) continue
      const x = -WORLD_HALF + (i + 0.5 + (hash3(i, j, seed + 21) - 0.5) * 0.9) * Yg
      const z = -WORLD_HALF + (j + 0.5 + (hash3(i, j, seed + 22) - 0.5) * 0.9) * Yg
      const o = occAt(x, z)
      if (o < 0 || occ[o]! >= 1) continue
      const road = roadEdgeDistance(x, z)
      const comp = compoundDistance(x, z)
      if (road < 4 + hash3(i, j, seed + 23) * 2.5 || comp < 4.5 + fbm(x, z, 2, 1 / 45, seed + 41) * 2.5 + hash3(i, j, seed + 27) * 2) continue
      if (nearAccess(x, z) && powerDist(x, z) < 3.5) continue
      const edge = 1 - smoothstep(5, 20, Math.min(road, comp - 5))
      const D = fbm(x, z, 3, 1 / 120, seed + 7) * 0.5 + 0.5
      const p = (0.16 + edge * 0.4 + (1 - Math.abs(D - 0.45) * 2.2) * 0.14) * density
      if (h0 > p) continue
      const s = 0.45 + hash3(i, j, seed + 24) * 0.85
      add(x, z, pick("young", hash3(i, j, seed + 25)), s, hash3(i, j, seed + 26))
      mark(x, z, 1.4, 1)
    }
  }

  // Layer 3: saplings.
  const Sg = 3
  const ss = Math.floor((WORLD_HALF * 2) / Sg)
  for (let j = 0; j < ss; j++) {
    for (let i = 0; i < ss; i++) {
      const h0 = hash3(i, j, seed + 30)
      if (h0 > 0.3 * density) continue
      const x = -WORLD_HALF + (i + 0.5 + (hash3(i, j, seed + 31) - 0.5) * 0.9) * Sg
      const z = -WORLD_HALF + (j + 0.5 + (hash3(i, j, seed + 32) - 0.5) * 0.9) * Sg
      const o = occAt(x, z)
      if (o < 0 || occ[o]! >= 1) continue
      const road = roadEdgeDistance(x, z)
      const comp = compoundDistance(x, z)
      if (road < 3.4 || comp < 2.5 + hash3(i, j, seed + 36) * 2) continue
      const edge = 1 - smoothstep(4, 16, Math.min(road, comp - 3))
      if (h0 > (0.08 + edge * 0.22) * density) continue
      add(x, z, pick("sapling", hash3(i, j, seed + 33)), 0.45 + hash3(i, j, seed + 34) * 1.1, hash3(i, j, seed + 35))
    }
  }

  return { count: n, x: X, y: Y, z: Z, scale: S, yaw: R, tint: T, phase: P, variant: V, grid: buildGrid(X, Z, n) }
}

export const GRID_SIZE = 16

function buildGrid(X: Float32Array, Z: Float32Array, n: number) {
  const size = GRID_SIZE
  const gn = Math.ceil((WORLD_HALF * 2) / size)
  const cellOf = new Uint32Array(n)
  const counts = new Uint32Array(gn * gn + 1)
  for (let k = 0; k < n; k++) {
    const i = Math.min(gn - 1, Math.max(0, Math.floor((X[k]! + WORLD_HALF) / size)))
    const j = Math.min(gn - 1, Math.max(0, Math.floor((Z[k]! + WORLD_HALF) / size)))
    cellOf[k] = j * gn + i
    counts[j * gn + i + 1]!++
  }
  for (let c = 1; c <= gn * gn; c++) counts[c]! += counts[c - 1]!
  const cursor = counts.slice(0, gn * gn)
  const order = new Uint32Array(n)
  for (let k = 0; k < n; k++) order[cursor[cellOf[k]!]!++] = k
  return { size, n: gn, cellStart: counts, order }
}
