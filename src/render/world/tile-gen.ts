// Pure tile/tree/shore generators shared by the terrain worker and the main-thread fallback.
// No three.js / DOM imports so it can run inside a Web Worker.
import {
  AIRBASES, MESH_CELL, SEA_FLOOR, TILE_SIZE, WORLD_HALF, WORLD_SIZE,
  noise2, terrainHeight, terrainMeshHeight,
} from "../../sim/geography"

export interface TileData {
  tx: number; tz: number; segments: number
  positions: Float32Array
  normals: Int8Array
  /** 0..255 forest cover, shared by the terrain shader and tree placement. */
  forest: Uint8Array
  minY: number; maxY: number
}

/** Forest cover 0..1 at a point (h = terrain height, slope = rise/run). */
export function forestCover(x: number, z: number, h: number, slope: number): number {
  const d = noise2(x * 0.0019, z * 0.0019, 0x7a11) * 0.65 + noise2(x * 0.0083, z * 0.0083, 0x7a12) * 0.35
  const t = d + (h - 120) / 1400
  const f = t <= -0.05 ? 0 : t >= 0.2 ? 1 : (t + 0.05) / 0.25
  const lo = h <= 26 ? 0 : h >= 70 ? 1 : (h - 26) / 44
  const hi = h <= 640 ? 1 : h >= 780 ? 0 : (780 - h) / 140
  const st = slope <= 0.6 ? 1 : slope >= 0.95 ? 0 : (0.95 - slope) / 0.35
  return f * lo * hi * st
}

export const TREE_KINDS = 3 // 0 palm, 1 broadleaf, 2 pine
export interface TreeData {
  tx: number; tz: number
  /** Per kind: 16-float instance matrices (tile-local translation). */
  matrices: Float32Array[]
  colors: Float32Array[]
  counts: number[]
}

const NORMAL_EPS = 6

/** Vertex grid + skirts. Indices are shared per segment count (see buildTileIndex). */
export function generateTile(tx: number, tz: number, segments: number): TileData {
  const edge = segments + 1, core = edge * edge, total = core + edge * 4
  const positions = new Float32Array(total * 3)
  const normals = new Int8Array(total * 3)
  const forest = new Uint8Array(total)
  const step = TILE_SIZE / segments
  const ox = tx * TILE_SIZE, oz = tz * TILE_SIZE
  let minY = Infinity, maxY = -Infinity
  for (let z = 0; z <= segments; z++) {
    for (let x = 0; x <= segments; x++) {
      const wx = ox + x * step, wz = oz + z * step
      const h = terrainHeight(wx, wz)
      const i = (z * edge + x) * 3
      positions[i] = x * step; positions[i + 1] = h; positions[i + 2] = z * step
      const dx = (terrainHeight(wx + NORMAL_EPS, wz) - terrainHeight(wx - NORMAL_EPS, wz)) / (2 * NORMAL_EPS)
      const dz = (terrainHeight(wx, wz + NORMAL_EPS) - terrainHeight(wx, wz - NORMAL_EPS)) / (2 * NORMAL_EPS)
      const inv = 127 / Math.sqrt(dx * dx + dz * dz + 1)
      normals[i] = Math.round(-dx * inv); normals[i + 1] = Math.round(inv); normals[i + 2] = Math.round(-dz * inv)
      forest[i / 3] = Math.round(forestCover(wx, wz, h, Math.sqrt(dx * dx + dz * dz)) * 255)
      if (h < minY) minY = h
      if (h > maxY) maxY = h
    }
  }
  // Skirts hang below each border vertex to hide LOD cracks.
  let cursor = core
  for (const border of tileBorders(segments)) {
    for (const top of border) {
      const a = top * 3, b = cursor++ * 3
      positions[b] = positions[a]; positions[b + 1] = Math.max(SEA_FLOOR - 20, positions[a + 1] - 120); positions[b + 2] = positions[a + 2]
      normals[b] = normals[a]; normals[b + 1] = normals[a + 1]; normals[b + 2] = normals[a + 2]
      forest[b / 3] = forest[a / 3]
    }
  }
  return { tx, tz, segments, positions, normals, forest, minY: Math.max(SEA_FLOOR - 20, minY - 120), maxY }
}

function tileBorders(segments: number): number[][] {
  const edge = segments + 1, core = edge * edge
  const range = (f: (i: number) => number) => Array.from({ length: edge }, (_, i) => f(i))
  return [
    range(i => i),
    range(i => i * edge + segments),
    range(i => core - 1 - i),
    range(i => (segments - i) * edge),
  ]
}

/** Triangle indices for a tile grid. Diagonal runs (x+1,z)→(x,z+1), matching terrainMeshHeight. */
export function buildTileIndex(segments: number): Uint16Array | Uint32Array {
  const edge = segments + 1, core = edge * edge
  const count = segments * segments * 6 + segments * 4 * 6
  const indices = core + edge * 4 > 65535 ? new Uint32Array(count) : new Uint16Array(count)
  let n = 0
  for (let z = 0; z < segments; z++) for (let x = 0; x < segments; x++) {
    const a = z * edge + x, b = a + 1, c = a + edge, d = c + 1
    indices[n++] = a; indices[n++] = c; indices[n++] = b
    indices[n++] = b; indices[n++] = c; indices[n++] = d
  }
  let cursor = core
  for (const border of tileBorders(segments)) {
    const start = cursor
    cursor += edge
    for (let i = 0; i < segments; i++) {
      indices[n++] = border[i]; indices[n++] = border[i + 1]; indices[n++] = start + i
      indices[n++] = border[i + 1]; indices[n++] = start + i + 1; indices[n++] = start + i
    }
  }
  return indices
}

// ---------------------------------------------------------------------------------------------
// Trees

const TREE_SPACING = 21

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
    if (a > -1560 && a < 1560 && c > -170 && c < 500) return true
    if (a > -2400 && a < 2800 && c > -170 && c < 170) return true
  }
  return false
}

/** Deterministic tree placement for a tile. maxPerTile caps the count (quality). */
export function generateTrees(tx: number, tz: number, maxPerTile: number): TreeData {
  const ox = tx * TILE_SIZE, oz = tz * TILE_SIZE
  const n = Math.floor(TILE_SIZE / TREE_SPACING)
  const lists: number[][] = [[], [], []]
  const colorLists: number[][] = [[], [], []]
  let accepted = 0
  // Visit candidates in a hashed order so the cap thins evenly instead of truncating a corner.
  const order: number[] = []
  for (let i = 0; i < n * n; i++) order.push(i)
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(hash01(i, tx * 131 + tz, 0x7ee5) * (i + 1))
    const t = order[i]; order[i] = order[j]; order[j] = t
  }
  for (const idx of order) {
    if (accepted >= maxPerTile) break
    const gx = idx % n, gz = (idx / n) | 0
    const cx = Math.floor(ox / TREE_SPACING) + gx, cz = Math.floor(oz / TREE_SPACING) + gz
    const x = ox + (gx + 0.15 + hash01(cx, cz, 1) * 0.7) * TREE_SPACING
    const z = oz + (gz + 0.15 + hash01(cx, cz, 2) * 0.7) * TREE_SPACING
    const h = terrainHeight(x, z)
    if (h < 2.2 || h > 820) continue
    const e = 5
    const sx = (terrainHeight(x + e, z) - terrainHeight(x - e, z)) / (2 * e)
    const sz = (terrainHeight(x, z + e) - terrainHeight(x, z - e)) / (2 * e)
    const slope = Math.sqrt(sx * sx + sz * sz)
    if (slope > 0.85) continue
    const coastal = h < 40
    const cover = forestCover(x, z, h, slope)
    const chance = coastal ? 0.22 + cover * 0.5 : 0.04 + cover * 0.9
    if (hash01(cx, cz, 3) > chance) continue
    if (baseBlocksTrees(x, z)) continue
    const y = terrainMeshHeight(x, z, MESH_CELL) - 0.6
    const r = hash01(cx, cz, 4)
    const kind = h < 26 + r * 24 ? 0 : h > 430 + r * 160 ? 2 : (r < 0.12 && h < 160 ? 0 : 1)
    const scale = (kind === 0 ? 0.85 : kind === 1 ? 0.8 : 0.75) + hash01(cx, cz, 5) * 0.55
    const tall = 0.85 + hash01(cx, cz, 6) * 0.35
    const rot = hash01(cx, cz, 7) * Math.PI * 2
    const lean = kind === 0 ? (hash01(cx, cz, 8) - 0.5) * 0.35 : 0
    lists[kind].push(x - ox, y, z - oz, scale, scale * tall, rot, lean)
    const v = 0.82 + hash01(cx, cz, 9) * 0.3, w = hash01(cx, cz, 10) * 0.12
    colorLists[kind].push(v - w * 0.5, v, v - w)
    accepted++
  }
  const matrices: Float32Array[] = [], colors: Float32Array[] = [], counts: number[] = []
  for (let k = 0; k < TREE_KINDS; k++) {
    const src = lists[k], count = src.length / 7
    const m = new Float32Array(count * 16)
    for (let i = 0; i < count; i++) {
      const [x, y, z, s, sy, rot, lean] = src.slice(i * 7, i * 7 + 7)
      // M = T * Ry(rot) * Rz(lean) * S(s, sy, s)
      const cr = Math.cos(rot), sr = Math.sin(rot), cl = Math.cos(lean), sl = Math.sin(lean)
      const o = i * 16
      // Rz(lean) columns: [cl, sl, 0], [-sl, cl, 0], [0,0,1]; then Ry.
      const c0x = cr * cl, c0y = sl, c0z = -sr * cl
      const c1x = -cr * sl, c1y = cl, c1z = sr * sl
      const c2x = sr, c2y = 0, c2z = cr
      m[o] = c0x * s; m[o + 1] = c0y * s; m[o + 2] = c0z * s; m[o + 3] = 0
      m[o + 4] = c1x * sy; m[o + 5] = c1y * sy; m[o + 6] = c1z * sy; m[o + 7] = 0
      m[o + 8] = c2x * s; m[o + 9] = c2y * s; m[o + 10] = c2z * s; m[o + 11] = 0
      m[o + 12] = x; m[o + 13] = y; m[o + 14] = z; m[o + 15] = 1
    }
    matrices.push(m); colors.push(new Float32Array(colorLists[k])); counts.push(count)
  }
  return { tx, tz, matrices, colors, counts }
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
      const h = terrainHeight(wx, wz)
      const t = (h - SHORE_MIN) / (SHORE_MAX - SHORE_MIN)
      out[(z - z0) * size + x] = Math.round(Math.max(0, Math.min(1, t)) * 255)
    }
  }
  return out
}

