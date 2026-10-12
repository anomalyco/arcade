// Pure cluster/tree/shore generators shared by the terrain worker and the main-thread fallback.
// No three.js / DOM imports so it can run inside a Web Worker.
//
// Terrain is a smooth-shaded indexed mesh with soft vertex-colour gradients. LOD0 uses exactly the
// baked jittered vertices + diagonals from geography.ts, i.e. the physics surface.
import {
  MESH_CELL, SEA_FLOOR, WORLD_HALF, WORLD_SIZE, noise2, terrainMeshHeight, worldMesh,
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
  /** World-space vertex positions. */
  positions: Float32Array
  /** Smooth vertex normals (normalized bytes). */
  normals: Int8Array
  /** Per-vertex RGB, linear bytes. */
  colors: Uint8Array
  index: Uint16Array | Uint32Array
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

/**
 * Smooth vertex colour: soft gradients from wet sand → beach → lush greens → rock on steep slopes →
 * a little snow on the highest ground, with gentle large-scale variation so fields aren't flat.
 */
function vertexColor(h: number, slope: number, ao: number, x: number, z: number): RGB {
  if (h < -0.5) return C.seabed
  const v1 = noise2(x * 0.0011, z * 0.0011, 0x51a7) * 0.5 + 0.5
  const v2 = noise2(x * 0.0047, z * 0.0047, 0x51a8) * 0.5 + 0.5
  // Grass: small value steps only (light / base / deep), no hue shifts.
  let col = mixRGB(C.grassLight, C.grass, step(0.25, 0.75, v1))
  col = mixRGB(col, C.grassDeep, step(80, 360, h) * 0.6 + step(0.6, 0.9, v2) * 0.3)
  col = mixRGB(col, C.forestFloor, step(0.35, 0.8, forestCover(x, z, h, slope)) * 0.5)
  const beach = 1 - step(2.5, 5.5 + (1 - Math.min(1, slope * 3)) * 3, h)
  col = mixRGB(col, C.sand, beach)
  col = mixRGB(col, C.sandWet, 1 - step(0.2, 1.4, h))
  const rockT = Math.max(step(0.55, 0.95, slope), step(380, 520, h) * step(0.25, 0.6, slope))
  const rock = mixRGB(C.rockDark, C.rockLight, step(0.2, 0.8, v2))
  col = mixRGB(col, rock, rockT * (1 - beach * 0.7))
  col = mixRGB(col, C.snow, step(400, 440, h + v2 * 20) * (1 - step(0.7, 1.0, slope)) * 0.85)
  const shade = 1 - 0.14 * ao
  return [col[0] * shade, col[1] * shade, col[2] * shade]
}

/**
 * Indexed, smooth-shaded cluster mesh. LOD0 uses exactly the baked vertices and diagonals from
 * geography.ts (the physics surface); normals come from the surrounding grid for soft shading.
 */
export function generateCluster(cx: number, cz: number, lod: number): ClusterData {
  const m = worldMesh(), blur = blurField()
  const S = m.stride, s = LOD_STEPS[lod]
  const n = CLUSTER_CELLS / s
  const i0 = cx * CLUSTER_CELLS, j0 = cz * CLUSTER_CELLS
  const edge = n + 1
  const core = edge * edge
  const total = core + n * 4 + 4
  const positions = new Float32Array(total * 3)
  const normals = new Int8Array(total * 3)
  const colors = new Uint8Array(total * 3)
  let minY = Infinity, maxY = -Infinity
  const vh = (i: number, j: number) => m.h[Math.min(m.n, Math.max(0, j)) * S + Math.min(m.n, Math.max(0, i))]
  for (let J = 0; J <= n; J++) for (let I = 0; I <= n; I++) {
    const i = i0 + I * s, j = j0 + J * s, k = j * S + i, o = (J * edge + I) * 3
    const y = m.h[k]
    positions[o] = m.vx[k]; positions[o + 1] = y; positions[o + 2] = m.vz[k]
    // Normal from a ±1-step (LOD) central difference on the grid.
    const span = 2 * s * m.cell
    const dx = (vh(i + s, j) - vh(i - s, j)) / span, dz = (vh(i, j + s) - vh(i, j - s)) / span
    const inv = 127 / Math.sqrt(dx * dx + dz * dz + 1)
    normals[o] = Math.round(-dx * inv); normals[o + 1] = Math.round(inv); normals[o + 2] = Math.round(-dz * inv)
    const slope = Math.sqrt(dx * dx + dz * dz)
    const valley = (blur[k] - y) / 45
    const col = vertexColor(y, slope, valley <= 0 ? 0 : valley >= 1 ? 1 : valley, m.vx[k], m.vz[k])
    colors[o] = Math.min(255, col[0]); colors[o + 1] = Math.min(255, col[1]); colors[o + 2] = Math.min(255, col[2])
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  const deep = -8
  const idx: number[] = []
  const hv = (I: number, J: number) => positions[(J * edge + I) * 3 + 1]
  for (let J = 0; J < n; J++) for (let I = 0; I < n; I++) {
    const a = J * edge + I, b = a + 1, c = a + edge, d = c + 1
    const i = i0 + I * s, j = j0 + J * s
    const dg = s === 1 ? m.diag[j * m.n + i] : (hash01(i, j, s) < 0.5 ? 0 : 1)
    const ya = hv(I, J), yb = hv(I + 1, J), yc = hv(I, J + 1), yd = hv(I + 1, J + 1)
    if (dg === 0) {
      if (ya > deep || yb > deep || yc > deep) idx.push(a, c, b)
      if (yb > deep || yc > deep || yd > deep) idx.push(b, c, d)
    } else {
      if (ya > deep || yc > deep || yd > deep) idx.push(a, c, d)
      if (ya > deep || yd > deep || yb > deep) idx.push(a, d, b)
    }
  }
  // Skirts: a duplicated, lowered copy of the border ring (same normal/colour) hides LOD cracks.
  const ring: number[] = []
  for (let I = 0; I < n; I++) ring.push(I)
  for (let J = 0; J < n; J++) ring.push(J * edge + n)
  for (let I = n; I > 0; I--) ring.push(n * edge + I)
  for (let J = n; J > 0; J--) ring.push(J * edge)
  let v = core
  const skirtStart = v
  for (const r of ring) {
    const o = v * 3, src = r * 3
    positions[o] = positions[src]; positions[o + 1] = Math.max(SEA_FLOOR - 10, positions[src + 1] - 120); positions[o + 2] = positions[src + 2]
    normals[o] = normals[src]; normals[o + 1] = normals[src + 1]; normals[o + 2] = normals[src + 2]
    colors[o] = colors[src]; colors[o + 1] = colors[src + 1]; colors[o + 2] = colors[src + 2]
    v++
  }
  for (let q = 0; q < ring.length; q++) {
    const p0 = ring[q], p1 = ring[(q + 1) % ring.length]
    if (positions[p0 * 3 + 1] < deep && positions[p1 * 3 + 1] < deep) continue
    const s0 = skirtStart + q, s1 = skirtStart + (q + 1) % ring.length
    idx.push(p0, p1, s0, p1, s1, s0)
  }
  if (!Number.isFinite(minY)) { minY = 0; maxY = 0 }
  const index = v > 65535 ? new Uint32Array(idx) : new Uint16Array(idx)
  return {
    cx, cz, lod,
    positions: positions.subarray(0, v * 3), normals: normals.subarray(0, v * 3), colors: colors.subarray(0, v * 3), index,
    minY: minY - 120, maxY,
  }
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

const TREE_SPACING = 17

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
    const chance = cover > 0.55 ? 0.72 : coastal ? 0.12 : 0.06
    if (hash01(ix, iz, 3) > chance) continue
    const y = h - 1
    const r = hash01(ix, iz, 4)
    const kind = coastal && cover < 0.55 ? 0 : r < 0.55 ? 2 : 1
    const scale = 0.95 + hash01(ix, iz, 5) * 0.55
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
