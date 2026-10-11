// Pure cluster/tree/shore generators shared by the terrain worker and the main-thread fallback.
// No three.js / DOM imports so it can run inside a Web Worker.
//
// Terrain is rendered as flat-shaded, non-indexed triangles with one palette colour per face
// (ISLANDERS-style). Triangles follow the same grid + diagonal as `terrainMeshHeight`, so LOD0
// is exactly the physics surface.
import {
  AIRBASES, MESH_CELL, SEA_FLOOR, WORLD_HALF, WORLD_SIZE, noise2, terrainHeight, terrainMeshHeight,
} from "../../sim/geography"
import { PALETTE_RGB } from "./palette"

/** Terrain is streamed in 3 × 3 km clusters (10 × 10 over the map) — one draw call each. */
export const CLUSTER_SIZE = 3_000
export const CLUSTER_N = WORLD_SIZE / CLUSTER_SIZE
/** Cell size per LOD level; level 0 is the collision mesh. */
export const LOD_CELLS = [MESH_CELL, MESH_CELL * 2, MESH_CELL * 4, MESH_CELL * 8]

export interface ClusterData {
  cx: number; cz: number; lod: number
  /** Non-indexed, world-space positions. */
  positions: Float32Array
  /** Per-vertex RGB (same for all three vertices of a face). */
  colors: Uint8Array
  minY: number; maxY: number
}

export function clusterOrigin(cx: number, cz: number): [number, number] {
  return [-WORLD_HALF + cx * CLUSTER_SIZE, -WORLD_HALF + cz * CLUSTER_SIZE]
}

/** Forest cover 0..1 at a point (h = terrain height, slope = rise/run). Big, smooth patches. */
export function forestCover(x: number, z: number, h: number, slope: number): number {
  const d = noise2(x * 0.0016, z * 0.0016, 0x7a11) * 0.7 + noise2(x * 0.0055, z * 0.0055, 0x7a12) * 0.3
  const t = d + (h - 150) / 1600
  const f = t <= -0.02 ? 0 : t >= 0.12 ? 1 : (t + 0.02) / 0.14
  const lo = h <= 24 ? 0 : h >= 50 ? 1 : (h - 24) / 26
  const hi = h <= 620 ? 1 : h >= 700 ? 0 : (700 - h) / 80
  const st = slope <= 0.65 ? 1 : slope >= 0.9 ? 0 : (0.9 - slope) / 0.25
  return f * lo * hi * st
}

/** Palette index for a terrain face — hard height/slope bands, no blending. */
function faceColor(h: number, slope: number, x: number, z: number): number {
  if (h < 2.4) return P.sand
  if (slope > 1.3) return h > 980 ? P.rockLight : P.cliff
  if (h > 1000 && slope < 0.9) return P.snow
  if (h > 700) return slope > 0.75 ? P.rock : P.rockLight
  if (slope > (h < 300 ? 0.95 : 0.8)) return P.rock
  if (h > 620) return P.highland
  if (h < 5.5 && slope < 0.25) return P.sand
  if (forestCover(x, z, h, slope) > 0.5) return P.forest
  return h < 90 ? P.meadow : P.grass
}

const P = {
  sand: 0, meadow: 1, grass: 2, forest: 3, highland: 4, rock: 5, rockLight: 6, cliff: 7, snow: 8, seabed: 9,
}
const TERRAIN_COLORS: [number, number, number][] = [
  PALETTE_RGB.sand, PALETTE_RGB.meadow, PALETTE_RGB.grass, PALETTE_RGB.forest, PALETTE_RGB.highland,
  PALETTE_RGB.rock, PALETTE_RGB.rockLight, PALETTE_RGB.cliff, PALETTE_RGB.snow, PALETTE_RGB.sand,
]

export function clusterHasTerrain(cx: number, cz: number, has: (tx: number, tz: number) => boolean): boolean {
  const [x0, z0] = clusterOrigin(cx, cz)
  const per = CLUSTER_SIZE / 1000
  for (let j = 0; j < per; j++) for (let i = 0; i < per; i++) if (has(x0 / 1000 + i, z0 / 1000 + j)) return true
  return false
}

export function generateCluster(cx: number, cz: number, lod: number): ClusterData {
  const cell = LOD_CELLS[lod]
  const n = Math.round(CLUSTER_SIZE / cell)
  const [ox, oz] = clusterOrigin(cx, cz)
  const edge = n + 1
  const hs = new Float64Array(edge * edge)
  let minY = Infinity, maxY = -Infinity
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
    const h = terrainHeight(ox + i * cell, oz + j * cell)
    hs[j * edge + i] = h
    if (h > maxY) maxY = h
    if (h < minY) minY = h
  }
  // Skip faces that are entirely deep under the (opaque) sea.
  const deep = -6
  let faces = 0
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const a = hs[j * edge + i], b = hs[j * edge + i + 1], c = hs[(j + 1) * edge + i], d = hs[(j + 1) * edge + i + 1]
    if (a > deep || b > deep || c > deep) faces++
    if (b > deep || c > deep || d > deep) faces++
  }
  const skirtFaces = n * 4 * 2
  const total = (faces + skirtFaces) * 3
  const positions = new Float32Array(total * 3)
  const colors = new Uint8Array(total * 3)
  let v = 0
  const put = (x: number, y: number, z: number, col: [number, number, number]) => {
    // World-space positions: neighbouring clusters share bit-identical edge vertices (no seams).
    const o = v * 3
    positions[o] = ox + x; positions[o + 1] = y; positions[o + 2] = oz + z
    colors[o] = col[0]; colors[o + 1] = col[1]; colors[o + 2] = col[2]
    v++
  }
  // One palette colour per grid quad (both triangles), classified from the quad's mean height and
  // plane slope so band edges form clean low-poly steps instead of a triangle-by-triangle zigzag.
  const quadCol = new Uint8Array(n * n)
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const a = hs[j * edge + i], b = hs[j * edge + i + 1], c = hs[(j + 1) * edge + i], d = hs[(j + 1) * edge + i + 1]
    // Slope over a wider stencil than the quad itself, so bands form coherent patches.
    const qx = ox + (i + 0.5) * cell, qz = oz + (j + 0.5) * cell, e = Math.max(cell * 1.5, 45)
    const sx = (terrainHeight(qx + e, qz) - terrainHeight(qx - e, qz)) / (2 * e)
    const sz = (terrainHeight(qx, qz + e) - terrainHeight(qx, qz - e)) / (2 * e)
    const px = (b + d - a - c) / (2 * cell), pz = (c + d - a - b) / (2 * cell)
    const local = Math.sqrt(px * px + pz * pz)
    quadCol[j * n + i] = faceColor((a + b + c + d) / 4, Math.max(Math.sqrt(sx * sx + sz * sz), local > 1.5 ? local : 0), qx, qz)
  }
  const tri = (x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, x3: number, y3: number, z3: number, col: [number, number, number]) => {
    put(x1, y1, z1, col); put(x2, y2, z2, col); put(x3, y3, z3, col)
  }
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const x0 = i * cell, z0 = j * cell, x1 = x0 + cell, z1 = z0 + cell
    const a = hs[j * edge + i], b = hs[j * edge + i + 1], c = hs[(j + 1) * edge + i], d = hs[(j + 1) * edge + i + 1]
    const col = TERRAIN_COLORS[quadCol[j * n + i]]
    // Same triangulation as terrainMeshHeight: (a, c, b) and (b, c, d).
    if (a > deep || b > deep || c > deep) tri(x0, a, z0, x0, c, z1, x1, b, z0, col)
    if (b > deep || c > deep || d > deep) tri(x1, b, z0, x0, c, z1, x1, d, z1, col)
  }
  // Skirts hang below every border edge to hide cracks against neighbours at other LODs.
  const drop = (y: number) => Math.max(SEA_FLOOR - 20, y - 160)
  const border = (k: number): [number, number, number] => {
    // Perimeter walk (outward-facing winding): top row →, right column ↓, bottom row ←, left column ↑.
    const side = Math.floor(k / n), t = k % n
    const [i, j] = side === 0 ? [t, 0] : side === 1 ? [n, t] : side === 2 ? [n - t, n] : [0, n - t]
    return [i * cell, hs[j * edge + i], j * cell]
  }
  // Skirts take the colour of the quad they hang from, so any sub-pixel seam is invisible.
  const borderQuad = (k: number) => {
    const side = Math.floor(k / n), t = k % n
    const [i, j] = side === 0 ? [t, 0] : side === 1 ? [n - 1, t] : side === 2 ? [n - 1 - t, n - 1] : [0, n - 1 - t]
    return quadCol[j * n + i]
  }
  for (let k = 0; k < n * 4; k++) {
    const p = border(k), q = border(k + 1 === n * 4 ? 0 : k + 1)
    const col = TERRAIN_COLORS[borderQuad(k)]
    // Top edge sits slightly below the surface so the vertical skirt never z-fights the seam.
    const pt = p[1] - 0.6, qt = q[1] - 0.6
    put(p[0], pt, p[2], col); put(q[0], qt, q[2], col); put(p[0], drop(p[1]), p[2], col)
    put(q[0], qt, q[2], col); put(q[0], drop(q[1]), q[2], col); put(p[0], drop(p[1]), p[2], col)
  }
  return { cx, cz, lod, positions: positions.subarray(0, v * 3), colors: colors.subarray(0, v * 3), minY: Math.max(SEA_FLOOR - 20, minY - 160), maxY }
}

// ---------------------------------------------------------------------------------------------
// Trees

export const TREE_KINDS = 3 // 0 palm, 1 round, 2 cone
export interface TreeData {
  cx: number; cz: number
  /** Per kind: 16-float instance matrices (cluster-local translation). */
  matrices: Float32Array[]
  colors: Float32Array[]
  counts: number[]
}

const TREE_SPACING = 30

function hash01(x: number, z: number, s: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(z | 0, 0x165667b1) ^ s
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/** True where airbase operations need clear ground (runway corridor, apron, buildings). */
function baseBlocksTrees(x: number, z: number): boolean {
  for (const base of AIRBASES) {
    const dx = x - base.center[0], dz = z - base.center[2]
    if (dx * dx + dz * dz > 3000 * 3000) continue
    const s = Math.sin(base.heading), k = Math.cos(base.heading)
    const a = -dx * s - dz * k, c = dx * k - dz * s
    if (a > -1560 && a < 1560 && c > -170 && c < 520) return true
    if (a > -2400 && a < 2800 && c > -170 && c < 170) return true
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
  // Hashed visiting order so the cap thins evenly instead of truncating one side.
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
    const h = terrainHeight(x, z)
    if (h < 3 || h > 700) continue
    const e = 6
    const sx = (terrainHeight(x + e, z) - terrainHeight(x - e, z)) / (2 * e)
    const sz = (terrainHeight(x, z + e) - terrainHeight(x, z - e)) / (2 * e)
    const slope = Math.sqrt(sx * sx + sz * sz)
    if (slope > 0.75) continue
    const cover = forestCover(x, z, h, slope)
    const coastal = h < 30
    const chance = cover > 0.5 ? 0.62 : coastal ? 0.1 : 0.025
    if (hash01(ix, iz, 3) > chance) continue
    if (baseBlocksTrees(x, z)) continue
    const y = terrainMeshHeight(x, z, MESH_CELL) - 1.2
    const r = hash01(ix, iz, 4)
    const kind = coastal && cover < 0.5 ? 0 : h > 380 + r * 160 ? 2 : r < 0.3 ? 2 : 1
    const scale = 1.15 + hash01(ix, iz, 5) * 0.6
    const tall = 0.85 + hash01(ix, iz, 6) * 0.35
    const rot = hash01(ix, iz, 7) * Math.PI * 2
    const lean = kind === 0 ? (hash01(ix, iz, 8) - 0.5) * 0.3 : 0
    lists[kind].push(x - ox, y, z - oz, scale, scale * tall, rot, lean)
    const g = kind === 2 ? (r < 0.6 ? 2 : 1) : kind === 0 ? 0 : (hash01(ix, iz, 9) < 0.5 ? 0 : 1)
    const col = GREENS[g]
    colorLists[kind].push(col[0] / 255, col[1] / 255, col[2] / 255)
    accepted++
  }
  const matrices: Float32Array[] = [], colors: Float32Array[] = [], counts: number[] = []
  for (let k = 0; k < TREE_KINDS; k++) {
    const src = lists[k], count = src.length / 7
    const m = new Float32Array(count * 16)
    for (let i = 0; i < count; i++) {
      const b = i * 7
      const x = src[b], y = src[b + 1], z = src[b + 2], s = src[b + 3], sy = src[b + 4], rot = src[b + 5], lean = src[b + 6]
      // M = T * Ry(rot) * Rz(lean) * S(s, sy, s)
      const cr = Math.cos(rot), sr = Math.sin(rot), cl = Math.cos(lean), sl = Math.sin(lean)
      const o = i * 16
      m[o] = cr * cl * s; m[o + 1] = sl * s; m[o + 2] = -sr * cl * s; m[o + 3] = 0
      m[o + 4] = -cr * sl * sy; m[o + 5] = cl * sy; m[o + 6] = sr * sl * sy; m[o + 7] = 0
      m[o + 8] = sr * s; m[o + 9] = 0; m[o + 10] = cr * s; m[o + 11] = 0
      m[o + 12] = x; m[o + 13] = y; m[o + 14] = z; m[o + 15] = 1
    }
    matrices.push(m); colors.push(new Float32Array(colorLists[k])); counts.push(count)
  }
  return { cx, cz, matrices, colors, counts }
}

// ---------------------------------------------------------------------------------------------
// Shore / depth map for the water shader

export const SHORE_SIZE = 2048
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
      // Sample the rendered LOD0 surface so the foam line hugs the visible coast facets.
      const h = terrainMeshHeight(wx, wz)
      const t = (h - SHORE_MIN) / (SHORE_MAX - SHORE_MIN)
      out[(z - z0) * size + x] = Math.round(Math.max(0, Math.min(1, t)) * 255)
    }
  }
  return out
}
