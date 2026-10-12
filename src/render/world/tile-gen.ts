// Pure cluster/tree/shore generators shared by the terrain worker and the main-thread fallback.
// No three.js / DOM imports so it can run inside a Web Worker.
//
// Terrain is flat-shaded, non-indexed triangles with one colour per face (ISLANDERS-style):
// bright terrace tops, warm sandstone cliffs, soft beaches, darker faces in valleys. LOD0 uses exactly the
// baked jittered vertices + diagonals from geography.ts, i.e. the physics surface.
import {
  AIRBASES, BASE_LAYOUT, MESH_CELL, SEA_FLOOR, WORLD_HALF, WORLD_SIZE, noise2, terrainMeshHeight, worldMesh,
} from "../../sim/geography"
import { PALETTE_RGB } from "./palette"

/** Terrain is streamed in 4 × 4 km clusters (4 × 4 over the map) — one draw call each. */
export const CLUSTER_SIZE = 4_000
export const CLUSTER_N = WORLD_SIZE / CLUSTER_SIZE
const CLUSTER_CELLS = CLUSTER_SIZE / MESH_CELL // 160
/** Vertex stride per LOD level; level 0 is the collision mesh. */
export const LOD_STEPS = [1, 2, 4, 8]

export interface ClusterData {
  cx: number; cz: number; lod: number
  /** Non-indexed, world-space positions. */
  positions: Float32Array
  /** Per-vertex RGB (same for all three vertices of a face), linear bytes. */
  colors: Uint8Array
  /** Ink line segments (pairs of world-space points) along terrace lips and ridges; LOD 0–1 only. */
  lines: Float32Array
  minY: number; maxY: number
}

export function clusterOrigin(cx: number, cz: number): [number, number] {
  return [-WORLD_HALF + cx * CLUSTER_SIZE, -WORLD_HALF + cz * CLUSTER_SIZE]
}

function hash01(x: number, z: number, s: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(z | 0, 0x165667b1) ^ s
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

// Blurred height field (≈150 m box) for cheap valley occlusion; built once per thread.
let blurred: Float32Array | null = null
function blurField(): Float32Array {
  if (blurred) return blurred
  const m = worldMesh()
  const S = m.stride, R = 6
  const tmp = new Float32Array(S * S), out = new Float32Array(S * S)
  for (let j = 0; j < S; j++) {
    let acc = 0
    for (let i = -R; i <= R; i++) acc += m.h[j * S + Math.min(S - 1, Math.max(0, i))]
    for (let i = 0; i < S; i++) {
      tmp[j * S + i] = acc / (2 * R + 1)
      acc += m.h[j * S + Math.min(S - 1, i + R + 1)] - m.h[j * S + Math.max(0, i - R)]
    }
  }
  for (let i = 0; i < S; i++) {
    let acc = 0
    for (let j = -R; j <= R; j++) acc += tmp[Math.min(S - 1, Math.max(0, j)) * S + i]
    for (let j = 0; j < S; j++) {
      out[j * S + i] = acc / (2 * R + 1)
      acc += tmp[Math.min(S - 1, j + R + 1) * S + i] - tmp[Math.max(0, j - R) * S + i]
    }
  }
  blurred = out
  return out
}

/** Forest cover 0..1 at a point. Big, smooth patches on the gentle middle terraces. */
export function forestCover(x: number, z: number, h: number, slope: number): number {
  const d = noise2(x * 0.0019, z * 0.0019, 0x7a11) * 0.7 + noise2(x * 0.007, z * 0.007, 0x7a12) * 0.3
  const f = d <= 0 ? 0 : d >= 0.18 ? 1 : d / 0.18
  const lo = h <= 10 ? 0 : h >= 24 ? 1 : (h - 10) / 14
  const hi = h <= 380 ? 1 : h >= 470 ? 0 : (470 - h) / 90
  const st = slope <= 0.45 ? 1 : slope >= 0.7 ? 0 : (0.7 - slope) / 0.25
  return f * lo * hi * st
}

type RGB = [number, number, number]
const C = PALETTE_RGB
const mixRGB = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
const step = (a: number, b: number, x: number) => { const t = x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a); return t * t * (3 - 2 * t) }

/** Top colour by height: soft palette steps from beach to high plateaus. */
function topColor(h: number): RGB {
  if (h < 3) return C.sand
  if (h < 6) return mixRGB(C.sand, C.meadow, (h - 3) / 3)
  if (h < 90) return mixRGB(C.meadow, C.grass, step(30, 90, h))
  if (h < 260) return mixRGB(C.grass, C.highland, step(160, 260, h))
  if (h < 520) return mixRGB(C.highland, C.ochre, step(380, 520, h))
  return mixRGB(C.ochre, C.peak, step(560, 680, h))
}

/** Final face colour (linear 0..255). One colour per triangle — no per-pixel blending. */
function faceColor(h: number, slope: number, ao: number, x: number, z: number, varSeed: number, forested: boolean): RGB {
  let col: RGB
  if (h < -1) col = C.seabed
  else {
    const top = forested ? mixRGB(topColor(h), C.forestFloor, 0.55) : topColor(h)
    // Warm sandstone cliffs; darker in occluded valleys; cool wet rock only right at the coast.
    let cliff = h > 400 ? C.cliffHigh : mixRGB(C.cliff, C.cliffShade, ao)
    if (h < 14) cliff = mixRGB(C.wetRock, cliff, step(6, 14, h))
    // Beach faces stay sandy even when steep-ish; moderate slopes keep grass on the ledges.
    const t = h < 3.5 ? step(1.4, 2.2, slope) : step(0.8, 1.35, slope)
    col = mixRGB(top, cliff, t)
  }
  // Valley occlusion tints toward lilac (never grey), plus slight per-face value variation.
  col = mixRGB(col, [col[0] * C.lilacShade[0] / 255, col[1] * C.lilacShade[1] / 255, col[2] * C.lilacShade[2] / 255], ao * 0.6)
  const shade = (1 - 0.12 * ao) * (0.965 + 0.07 * varSeed)
  return [Math.min(255, col[0] * shade), Math.min(255, col[1] * shade), Math.min(255, col[2] * shade)]
}

export function generateCluster(cx: number, cz: number, lod: number): ClusterData {
  const m = worldMesh(), blur = blurField()
  const S = m.stride, s = LOD_STEPS[lod]
  const n = CLUSTER_CELLS / s
  const i0 = cx * CLUSTER_CELLS, j0 = cz * CLUSTER_CELLS
  const deep = -8
  const maxFaces = n * n * 2 + n * 8
  const positions = new Float32Array(maxFaces * 9)
  const colors = new Uint8Array(maxFaces * 9)
  let v = 0, minY = Infinity, maxY = -Infinity
  const put = (k: number, y: number, col: RGB) => {
    const o = v * 3
    positions[o] = m.vx[k]; positions[o + 1] = y; positions[o + 2] = m.vz[k]
    colors[o] = col[0]; colors[o + 1] = col[1]; colors[o + 2] = col[2]
    v++
  }
  // Per cell triangle: unit normal (for ink creases).
  const fn = new Float32Array(n * n * 2 * 3)
  let curFace = 0
  const face = (k0: number, k1: number, k2: number, seed: number) => {
    const y0 = m.h[k0], y1 = m.h[k1], y2 = m.h[k2]
    {
      const ax = m.vx[k1] - m.vx[k0], ay = y1 - y0, az = m.vz[k1] - m.vz[k0]
      const bx = m.vx[k2] - m.vx[k0], by = y2 - y0, bz = m.vz[k2] - m.vz[k0]
      let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx
      if (ny < 0) { nx = -nx; ny = -ny; nz = -nz }
      const l = Math.hypot(nx, ny, nz) || 1
      fn[curFace * 3] = nx / l; fn[curFace * 3 + 1] = ny / l; fn[curFace * 3 + 2] = nz / l
    }
    if (y0 < deep && y1 < deep && y2 < deep) return
    const ux = m.vx[k1] - m.vx[k0], uy = y1 - y0, uz = m.vz[k1] - m.vz[k0]
    const wx = m.vx[k2] - m.vx[k0], wy = y2 - y0, wz = m.vz[k2] - m.vz[k0]
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx
    const slope = Math.sqrt(nx * nx + nz * nz) / Math.max(Math.abs(ny), 1e-6)
    const h = (y0 + y1 + y2) / 3
    const fx = (m.vx[k0] + m.vx[k1] + m.vx[k2]) / 3, fz = (m.vz[k0] + m.vz[k1] + m.vz[k2]) / 3
    const valley = ((blur[k0] + blur[k1] + blur[k2]) / 3 - h) / 40
    const ao = valley <= 0 ? 0 : valley >= 1 ? 1 : valley
    const forested = forestCover(fx, fz, h, slope) > 0.55
    const col = faceColor(h, slope, ao, fx, fz, hash01(seed, k0, 0x51ed), forested)
    put(k0, y0, col); put(k1, y1, col); put(k2, y2, col)
    if (y0 < minY) minY = y0; if (y1 < minY) minY = y1; if (y2 < minY) minY = y2
    if (y0 > maxY) maxY = y0; if (y1 > maxY) maxY = y1; if (y2 > maxY) maxY = y2
  }
  for (let J = 0; J < n; J++) for (let I = 0; I < n; I++) {
    const i = i0 + I * s, j = j0 + J * s
    const a = j * S + i, b = a + s, c = a + s * S, d = c + s
    const dg = s === 1 ? m.diag[j * m.n + i] : (hash01(i, j, s) < 0.5 ? 0 : 1)
    curFace = (J * n + I) * 2
    if (dg === 0) { face(a, c, b, 0); curFace++; face(b, c, d, 1) }
    else { face(a, c, d, 0); curFace++; face(a, d, b, 1) }
  }
  const lines = lod <= 1 ? creaseLines(m, fn, n, s, i0, j0) : new Float32Array(0)
  // Skirts below every border edge (hide cracks against neighbours at other LODs).
  const border = (k: number): number => {
    const side = Math.floor(k / n), t = k % n
    const [I, J] = side === 0 ? [t, 0] : side === 1 ? [n, t] : side === 2 ? [n - t, n] : [0, n - t]
    return (j0 + J * s) * S + (i0 + I * s)
  }
  for (let k = 0; k < n * 4; k++) {
    const p = border(k), q = border(k + 1 === n * 4 ? 0 : k + 1)
    if (m.h[p] < deep && m.h[q] < deep) continue
    const col = faceColor((m.h[p] + m.h[q]) / 2, 0, 0, 0, 0, 0.5, false)
    const pt = m.h[p] - 0.6, qt = m.h[q] - 0.6
    const pb = Math.max(SEA_FLOOR - 10, m.h[p] - 120), qb = Math.max(SEA_FLOOR - 10, m.h[q] - 120)
    put(p, pt, col); put(q, qt, col); put(p, pb, col)
    put(q, qt, col); put(q, qb, col); put(p, pb, col)
  }
  if (!Number.isFinite(minY)) { minY = 0; maxY = 0 }
  return { cx, cz, lod, positions: positions.subarray(0, v * 3), colors: colors.subarray(0, v * 3), lines, minY: minY - 120, maxY }
}

/**
 * Ink along terrain creases: terrace lips (flat ledge meeting a steep riser) and sharp ridges/valleys.
 * Edge ownership per cell (see generateCluster's triangulation): left → tri0, right → tri1,
 * top → diag0 ? tri0 : tri1, bottom → diag0 ? tri1 : tri0.
 */
function creaseLines(m: ReturnType<typeof worldMesh>, fn: Float32Array, n: number, s: number, i0: number, j0: number): Float32Array {
  const S = m.stride
  const out: number[] = []
  const slopeOf = (f: number) => Math.sqrt(Math.max(0, 1 - fn[f * 3 + 1] ** 2)) / Math.max(fn[f * 3 + 1], 1e-3)
  const diagOf = (I: number, J: number) => {
    const i = i0 + I * s, j = j0 + J * s
    return s === 1 ? m.diag[j * m.n + i] : (hash01(i, j, s) < 0.5 ? 0 : 1)
  }
  const test = (f1: number, f2: number, ka: number, kb: number) => {
    if (m.h[ka] < 2 && m.h[kb] < 2) return
    const dot = fn[f1 * 3] * fn[f2 * 3] + fn[f1 * 3 + 1] * fn[f2 * 3 + 1] + fn[f1 * 3 + 2] * fn[f2 * 3 + 2]
    const s1 = slopeOf(f1), s2 = slopeOf(f2)
    const lip = Math.min(s1, s2) < 0.32 && Math.max(s1, s2) > 1.0
    const ridge = dot < 0.45
    if (!lip && !ridge) return
    out.push(m.vx[ka], m.h[ka], m.vz[ka], m.vx[kb], m.h[kb], m.vz[kb])
  }
  for (let J = 0; J < n; J++) for (let I = 0; I < n; I++) {
    const i = i0 + I * s, j = j0 + J * s
    const a = j * S + i, b = a + s, c = a + s * S, d = c + s
    const dg = diagOf(I, J)
    const t0 = (J * n + I) * 2, t1 = t0 + 1
    // Diagonal (shared by both triangles of this cell).
    if (dg === 0) test(t0, t1, b, c)
    else test(t0, t1, a, d)
    // Right edge b–d with the right neighbour's left edge (its tri0).
    if (I + 1 < n) test(t1, (J * n + I + 1) * 2, b, d)
    // Bottom edge c–d with the lower neighbour's top edge.
    if (J + 1 < n) {
      const mine = dg === 0 ? t1 : t0
      const nd = diagOf(I, J + 1)
      const theirs = (((J + 1) * n + I) * 2) + (nd === 0 ? 0 : 1)
      test(mine, theirs, c, d)
    }
  }
  return new Float32Array(out)
}

// ---------------------------------------------------------------------------------------------
// Trees

export const TREE_KINDS = 3 // 0 palm, 1 round, 2 cypress cone
export interface TreeData {
  cx: number; cz: number
  /** Per kind: 16-float instance matrices (cluster-local translation). */
  matrices: Float32Array[]
  colors: Float32Array[]
  counts: number[]
}

const TREE_SPACING = 26

/** True where airbase operations need clear ground (runway corridor, apron, buildings). */
function baseBlocksTrees(x: number, z: number): boolean {
  const F = BASE_LAYOUT.flat
  for (const base of AIRBASES) {
    const dx = x - base.center[0], dz = z - base.center[2]
    if (dx * dx + dz * dz > 2200 * 2200) continue
    const sn = Math.sin(base.heading), k = Math.cos(base.heading)
    const a = -dx * sn - dz * k, c = dx * k - dz * sn
    if (a > F.a0 - 60 && a < F.a1 + 60 && c > F.c0 - 60 && c < F.c1 + 60) return true
    if (a > -1500 && a < 1900 && c > -150 && c < 150) return true
  }
  return false
}

const GREENS = [PALETTE_RGB.treeLight, PALETTE_RGB.treeMid, PALETTE_RGB.treeDeep]

/** Deterministic tree placement for a cluster. maxCount caps the count (quality). */
export function generateTrees(cx: number, cz: number, maxCount: number): TreeData {
  const [ox, oz] = clusterOrigin(cx, cz)
  const n = Math.floor(CLUSTER_SIZE / TREE_SPACING)
  const lists: number[][] = [[], [], []]
  const colorLists: number[][] = [[], [], []]
  const order = new Uint32Array(n * n)
  for (let i = 0; i < order.length; i++) order[i] = i
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(hash01(i, cx * 131 + cz, 0x7ee5) * (i + 1))
    const t = order[i]; order[i] = order[j]; order[j] = t
  }
  let accepted = 0
  for (let k = 0; k < order.length && accepted < maxCount; k++) {
    const idx = order[k]
    const gx = idx % n, gz = (idx / n) | 0
    const ix = Math.round(ox / TREE_SPACING) + gx, iz = Math.round(oz / TREE_SPACING) + gz
    const x = ox + (gx + 0.15 + hash01(ix, iz, 1) * 0.7) * TREE_SPACING
    const z = oz + (gz + 0.15 + hash01(ix, iz, 2) * 0.7) * TREE_SPACING
    const h = terrainMeshHeight(x, z)
    if (h < 3.5 || h > 470) continue
    const e = 8
    const sx = (terrainMeshHeight(x + e, z) - terrainMeshHeight(x - e, z)) / (2 * e)
    const sz = (terrainMeshHeight(x, z + e) - terrainMeshHeight(x, z - e)) / (2 * e)
    const slope = Math.sqrt(sx * sx + sz * sz)
    if (slope > 0.55) continue
    const cover = forestCover(x, z, h, slope)
    const coastal = h < 12
    const chance = cover > 0.55 ? 0.5 : coastal ? 0.08 : 0.015
    if (hash01(ix, iz, 3) > chance) continue
    if (baseBlocksTrees(x, z)) continue
    const y = h - 1
    const r = hash01(ix, iz, 4)
    const kind = coastal && cover < 0.55 ? 0 : r < 0.55 ? 2 : 1
    const scale = 1.1 + hash01(ix, iz, 5) * 0.6
    const tall = kind === 2 ? 0.9 + hash01(ix, iz, 6) * 0.6 : 0.85 + hash01(ix, iz, 6) * 0.3
    const rot = hash01(ix, iz, 7) * Math.PI * 2
    const lean = kind === 0 ? (hash01(ix, iz, 8) - 0.5) * 0.3 : 0
    lists[kind].push(x - ox, y, z - oz, scale, scale * tall, rot, lean)
    const col = GREENS[kind === 2 ? (r < 0.3 ? 2 : 1) : kind === 0 ? 0 : (hash01(ix, iz, 9) < 0.5 ? 0 : 1)]
    colorLists[kind].push(col[0] / 255, col[1] / 255, col[2] / 255)
    accepted++
  }
  const matrices: Float32Array[] = [], colors: Float32Array[] = [], counts: number[] = []
  for (let k = 0; k < TREE_KINDS; k++) {
    const src = lists[k], count = src.length / 7
    const mm = new Float32Array(count * 16)
    for (let i = 0; i < count; i++) {
      const b = i * 7
      const x = src[b], y = src[b + 1], z = src[b + 2], s = src[b + 3], sy = src[b + 4], rot = src[b + 5], lean = src[b + 6]
      const cr = Math.cos(rot), sr = Math.sin(rot), cl = Math.cos(lean), sl = Math.sin(lean)
      const o = i * 16
      mm[o] = cr * cl * s; mm[o + 1] = sl * s; mm[o + 2] = -sr * cl * s; mm[o + 3] = 0
      mm[o + 4] = -cr * sl * sy; mm[o + 5] = cl * sy; mm[o + 6] = sr * sl * sy; mm[o + 7] = 0
      mm[o + 8] = sr * s; mm[o + 9] = 0; mm[o + 10] = cr * s; mm[o + 11] = 0
      mm[o + 12] = x; mm[o + 13] = y; mm[o + 14] = z; mm[o + 15] = 1
    }
    matrices.push(mm); colors.push(new Float32Array(colorLists[k])); counts.push(count)
  }
  return { cx, cz, matrices, colors, counts }
}

// ---------------------------------------------------------------------------------------------
// Shore / depth map for the water shader

export const SHORE_SIZE = 1024
export const SHORE_MIN = -40
export const SHORE_MAX = 10

/** Rows [z0, z1) of the depth map covering the world square (R8, height mapped SHORE_MIN..SHORE_MAX). */
export function generateShoreRows(z0: number, z1: number): Uint8Array {
  const size = SHORE_SIZE
  const out = new Uint8Array((z1 - z0) * size)
  for (let z = z0; z < z1; z++) {
    const wz = (z + 0.5) / size * WORLD_SIZE - WORLD_HALF
    for (let x = 0; x < size; x++) {
      const wx = (x + 0.5) / size * WORLD_SIZE - WORLD_HALF
      const h = terrainMeshHeight(wx, wz)
      const t = (h - SHORE_MIN) / (SHORE_MAX - SHORE_MIN)
      out[(z - z0) * size + x] = Math.round(Math.max(0, Math.min(1, t)) * 255)
    }
  }
  return out
}
