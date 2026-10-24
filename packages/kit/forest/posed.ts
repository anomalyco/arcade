/**
 * Posed trees: a standing forest tree cut at a height, its stump left in place and the rest turned over a hinge (a
 * felled tree falling, lying, its crown bending and shaking). CPU side only: the pass hides the tree's instance and
 * draws these world-space triangles through its baked pipelines, so they shade, shadow and fog like the forest.
 */
import type { ForestTree, Vec3 } from "../sim/forest-world"
import { MAT, SPECIES, TREE_SINK, intSeed, treePlacement, type ChunkMeshes, type ForestTemplate } from "./build"
import { toHalf } from "./mesh"

/** One tree's pose this frame. The world's `trees[tree]`, cut at `cut` m above its base, its log turned by `angle`. */
export type ForestTreePose = {
  /** Index into the world's `trees`. */
  tree: number
  /** Height of the cut above the ground (m): everything below stays as the stump. */
  cut: number
  /** Plan direction the top falls towards (x, z; need not be unit). */
  dir: readonly [number, number]
  /** Rotation from upright about the hinge (rad): 0 standing, π/2 lying flat. */
  angle: number
  /** Extra turn at the tip, growing with the square of the height share (rad): the crown lagging (−) or whipping (+). */
  bend?: number
  /** Sideways throw of the crown at the tip (m), across the fall line, same square law. */
  shake?: number
  /** Where the hinge sits from the trunk's centre along `dir` (m): the uncut holding wood on the fall side. */
  hinge?: number
  /** Branches, needles and the trunk never pass below the ground plus this (m). Omit for no ground clamp. */
  ground?: number
}

function fromHalf(h: number): number {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff
  if (e === 0) return s * m * 2 ** -24
  if (e === 31) return m ? NaN : s * Infinity
  return s * (1 + m / 1024) * 2 ** (e - 15)
}

export type SplitTree = {
  /** Stump in world space, ready to draw. */
  stump: ChunkMeshes
  /** The log in the tree's own placed space (yaw and scale applied, origin at the instance base), unposed. */
  log: ChunkMeshes
  /** World position of the instance base (x, y, z). */
  base: Vec3
  /** Tree height as placed (m). */
  height: number
  /** Mean radius of the bark where the cut crosses it (m): the size of the fresh face on the stump and the butt. */
  cutRadius: number
}

/**
 * Places a tree's near template as `vsTree` would (packed trunk scale on trunk bark, crown scale on the rest, height
 * scale, yaw, the instance's tint folded into aux) and clips it at `cut` into the stump below and the log above. The
 * cut faces stay open: the game draws the fresh wood (it knows the kerf, the hinge and the torn fibres).
 */
export function splitTree(t: ForestTree, template: ForestTemplate, groundY: number, cut: number): SplitTree {
  const p = treePlacement({ ...t, seed: intSeed(t.seed) })
  const param = p.trunkPacked - Math.floor(p.trunkPacked)
  const c = Math.cos(p.yaw), s = Math.sin(p.yaw)
  const base: Vec3 = [t.x, groundY - TREE_SINK, t.z]
  const localCut = cut + TREE_SINK
  const barkHalf = toHalf(MAT.bark)
  const split = (src: ArrayBuffer) => {
    const n = src.byteLength / 32
    const placed = src.slice(0)
    const f = new Float32Array(placed), v = new DataView(placed)
    for (let i = 0; i < n; i++) {
      const o = i * 32, fo = o / 4
      const trunk = v.getUint16(o + 20, true) === barkHalf && v.getUint8(o + 18) === 0
      const sxz = trunk ? p.trunkScale : p.crownScale
      const qx = f[fo]! * sxz, qy = f[fo + 1]! * p.heightScale, qz = f[fo + 2]! * sxz
      f[fo] = qx * c - qz * s; f[fo + 1] = qy; f[fo + 2] = qx * s + qz * c
      const nx = v.getInt8(o + 12) / 127 / sxz, ny = v.getInt8(o + 13) / 127 / p.heightScale, nz = v.getInt8(o + 14) / 127 / sxz
      const rx = nx * c - nz * s, rz = nx * s + nz * c, l = Math.hypot(rx, ny, rz) || 1
      v.setInt8(o + 12, Math.round((rx / l) * 127)); v.setInt8(o + 13, Math.round((ny / l) * 127)); v.setInt8(o + 14, Math.round((rz / l) * 127))
      v.setUint16(o + 22, toHalf(Math.floor(fromHalf(v.getUint16(o + 22, true)) + 0.001) + param * 0.9), true)
    }
    // Each triangle is clipped against the cut plane (Sutherland–Hodgman), so the stump keeps the bark right up to the
    // cut and the log starts exactly there: nothing stretches or opens a gap when the log turns.
    const tris = n / 3
    const below = new Writer(tris * 2), above = new Writer(tris * 2)
    const poly = new DataView(new ArrayBuffer(4 * 32))
    const pv = new DataView(placed)
    for (let tri = 0; tri < tris; tri++) {
      const o = tri * 96
      const y0 = f[tri * 24 + 1]!, y1 = f[tri * 24 + 9]!, y2 = f[tri * 24 + 17]!
      if (y0 <= localCut && y1 <= localCut && y2 <= localCut) { below.copy(pv, o, 3); continue }
      if (y0 >= localCut && y1 >= localCut && y2 >= localCut) { above.copy(pv, o, 3); continue }
      const trunk = v.getUint16(o + 20, true) === barkHalf
      for (const side of [below, above]) {
        const keepBelow = side === below
        let m = 0
        for (let j = 0; j < 3; j++) {
          const a = o + j * 32, b = o + ((j + 1) % 3) * 32
          const ya = pv.getFloat32(a + 4, true), yb = pv.getFloat32(b + 4, true)
          const ina = keepBelow ? ya <= localCut : ya >= localCut, inb = keepBelow ? yb <= localCut : yb >= localCut
          if (ina) copyVertex(pv, a, poly, m++ * 32)
          if (ina !== inb) {
            lerpVertex(pv, a, b, (localCut - ya) / (yb - ya), poly, m * 32)
            poly.setFloat32(m * 32 + 4, localCut, true)
            if (trunk && keepBelow) { cutR.sum += Math.hypot(poly.getFloat32(m * 32, true), poly.getFloat32(m * 32 + 8, true)); cutR.n++ }
            m++
          }
        }
        for (let k = 1; k + 1 < m; k++) side.tri(poly, 0, k * 32, (k + 1) * 32)
      }
    }
    const stump = below.finish()
    const sf = new Float32Array(stump)
    for (let i = 0; i < sf.length; i += 8) { sf[i] = sf[i]! + base[0]; sf[i + 1] = sf[i + 1]! + base[1]; sf[i + 2] = sf[i + 2]! + base[2] }
    return { stump, log: above.finish() }
  }
  const cutR = { sum: 0, n: 0 }
  const o = split(template.near.opaque), m = split(template.near.masked)
  return { stump: { opaque: o.stump, masked: m.stump }, log: { opaque: o.log, masked: m.log }, base, height: SPECIES[t.species].h * p.heightScale, cutRadius: cutR.n ? cutR.sum / cutR.n : t.r }
}

function copyVertex(src: DataView, a: number, dst: DataView, d: number) {
  for (let j = 0; j < 32; j += 4) dst.setUint32(d + j, src.getUint32(a + j, true), true)
}

/** Vertex a + (b − a)·k: position, normal, colour and uv blend; material and aux come from the nearer end. */
function lerpVertex(src: DataView, a: number, b: number, k: number, dst: DataView, d: number) {
  const l = (x: number, y: number) => x + (y - x) * k
  for (const j of [0, 4, 8, 24, 28]) dst.setFloat32(d + j, l(src.getFloat32(a + j, true), src.getFloat32(b + j, true)), true)
  for (let j = 12; j < 16; j++) dst.setInt8(d + j, Math.round(l(src.getInt8(a + j), src.getInt8(b + j))))
  for (let j = 16; j < 20; j++) dst.setUint8(d + j, Math.round(l(src.getUint8(a + j), src.getUint8(b + j))))
  dst.setUint32(d + 20, src.getUint32((k < 0.5 ? a : b) + 20, true), true)
}

class Writer {
  private buf: ArrayBuffer
  private view: DataView
  private count = 0
  constructor(tris: number) { this.buf = new ArrayBuffer(Math.max(1, tris) * 96); this.view = new DataView(this.buf) }
  copy(src: DataView, o: number, verts: number) { for (let i = 0; i < verts; i++) copyVertex(src, o + i * 32, this.view, this.count++ * 32) }
  tri(src: DataView, a: number, b: number, c: number) { for (const o of [a, b, c]) copyVertex(src, o, this.view, this.count++ * 32) }
  finish(): ArrayBuffer { return this.buf.slice(0, this.count * 32) }
}

/**
 * Writes the log of `split` posed by `pose` into `out` (same size as `src`), world space. Grows `box`
 * (x0, y0, z0, x1, y1, z1) over what it wrote.
 */
export function poseLog(src: ArrayBuffer, out: ArrayBuffer, split: SplitTree, pose: ForestTreePose, height: (x: number, z: number) => number, box: number[]) {
  const sf = new Float32Array(src), sv = new DataView(src)
  const of = new Float32Array(out), ov = new DataView(out)
  new Uint8Array(out).set(new Uint8Array(src))
  const dl = Math.hypot(pose.dir[0], pose.dir[1]) || 1
  const dx = pose.dir[0] / dl, dz = pose.dir[1] / dl
  // Axis k = (dz, 0, −dx): turning +y about it by θ leans the top towards (dx, dz).
  const kx = dz, kz = -dx
  const hinge = pose.hinge ?? 0
  const px = dx * hinge, py = pose.cut + TREE_SINK, pz = dz * hinge
  const span = Math.max(1, split.height - pose.cut)
  const bend = pose.bend ?? 0, shake = pose.shake ?? 0
  const [bx, by, bz] = split.base
  const ground = pose.ground
  const n = src.byteLength / 32
  for (let i = 0; i < n; i++) {
    const o = i * 32, fo = o / 4
    const rx = sf[fo]! - px, ry = sf[fo + 1]! - py, rz = sf[fo + 2]! - pz
    const share = Math.max(0, Math.min(1, ry / span))
    const sq = share * share
    const a = pose.angle + bend * sq
    const ca = Math.cos(a), sa = Math.sin(a)
    // Rodrigues about horizontal k: v cos + (k × v) sin + k (k·v)(1 − cos).
    const kv = kx * rx + kz * rz
    const cx = -kz * ry, cy = kz * rx - kx * rz, cz = kx * ry
    let wx = rx * ca + cx * sa + kx * kv * (1 - ca)
    let wy = ry * ca + cy * sa
    let wz = rz * ca + cz * sa + kz * kv * (1 - ca)
    wx += kx * shake * sq; wz += kz * shake * sq
    wx += bx + px; wy += by + py; wz += bz + pz
    if (ground !== undefined) wy = Math.max(wy, height(wx, wz) + ground)
    of[fo] = wx; of[fo + 1] = wy; of[fo + 2] = wz
    const nx = sv.getInt8(o + 12), ny = sv.getInt8(o + 13), nz = sv.getInt8(o + 14)
    const nk = kx * nx + kz * nz
    ov.setInt8(o + 12, Math.round(Math.max(-127, Math.min(127, nx * ca + -kz * ny * sa + kx * nk * (1 - ca)))))
    ov.setInt8(o + 13, Math.round(Math.max(-127, Math.min(127, ny * ca + (kz * nx - kx * nz) * sa))))
    ov.setInt8(o + 14, Math.round(Math.max(-127, Math.min(127, nz * ca + kx * ny * sa + kz * nk * (1 - ca)))))
    if (wx < box[0]!) box[0] = wx
    if (wy < box[1]!) box[1] = wy
    if (wz < box[2]!) box[2] = wz
    if (wx > box[3]!) box[3] = wx
    if (wy > box[4]!) box[4] = wy
    if (wz > box[5]!) box[5] = wz
  }
}

/** Same pose to the nearest tenth of a milliradian and millimetre: no re-pose, no shadow re-render. */
export const poseKey = (p: ForestTreePose) =>
  `${p.cut.toFixed(3)},${p.dir[0].toFixed(3)},${p.dir[1].toFixed(3)},${p.angle.toFixed(4)},${(p.bend ?? 0).toFixed(4)},${(p.shake ?? 0).toFixed(3)},${(p.hinge ?? 0).toFixed(3)},${p.ground ?? "-"}`
