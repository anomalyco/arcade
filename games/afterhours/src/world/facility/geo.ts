import * as THREE from "three/webgpu"
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js"
import { material, type MaterialName } from "../../render/materials"

// Static geometry accumulator for the facility: every piece is added in world space under a material, and `flush`
// merges each material's pieces into one mesh. Boxes get UVs in metres taken from world coordinates, so concrete
// boards and joints run continuously across separate pieces of the same wall.

export type Mat = MaterialName | THREE.Material

/** Faces to skip on a box: bit 0 -X, 1 +X, 2 -Y, 3 +Y, 4 -Z, 5 +Z. */
export const SKIP_BOTTOM = 1 << 2

type Bucket = { material: THREE.Material; geos: THREE.BufferGeometry[]; shadow: boolean }

const tmpV = new THREE.Vector3()

export class Batch {
  private buckets = new Map<THREE.Material, Bucket>()

  private bucket(mat: Mat, shadow = true) {
    const m = typeof mat === "string" ? material(mat) : mat
    let b = this.buckets.get(m)
    if (!b) {
      b = { material: m, geos: [], shadow }
      this.buckets.set(m, b)
    }
    return b
  }

  /** Axis-aligned box with world-metre UVs on every face. */
  box(mat: Mat, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, skip = 0) {
    if (x1 < x0) [x0, x1] = [x1, x0]
    if (y1 < y0) [y0, y1] = [y1, y0]
    if (z1 < z0) [z0, z1] = [z1, z0]
    if (x1 - x0 < 1e-4 || y1 - y0 < 1e-4 || z1 - z0 < 1e-4) return
    const pos: number[] = []
    const nor: number[] = []
    const uv: number[] = []
    const idx: number[] = []
    const face = (
      a: [number, number, number],
      b: [number, number, number],
      c: [number, number, number],
      d: [number, number, number],
      n: [number, number, number],
      uvOf: (p: [number, number, number]) => [number, number],
    ) => {
      const base = pos.length / 3
      for (const p of [a, b, c, d]) {
        pos.push(p[0], p[1], p[2])
        nor.push(n[0], n[1], n[2])
        uv.push(...uvOf(p))
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
    }
    // Each face is wound counter-clockwise seen from outside.
    if (!(skip & 1)) face([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], (p) => [p[2], p[1]])
    if (!(skip & 2)) face([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0], (p) => [-p[2], p[1]])
    if (!(skip & 4)) face([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0], (p) => [p[0], p[2]])
    if (!(skip & 8)) face([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0], (p) => [p[0], -p[2]])
    if (!(skip & 16)) face([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1], (p) => [-p[0], p[1]])
    if (!(skip & 32)) face([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], (p) => [p[0], p[1]])
    const g = new THREE.BufferGeometry()
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3))
    g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3))
    g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2))
    g.setIndex(idx)
    this.bucket(mat).geos.push(g)
  }

  /** Any geometry, transformed into world space. UVs are scaled by `uvScale` (use it to bring unit UVs to metres). */
  add(mat: Mat, geo: THREE.BufferGeometry, matrix?: THREE.Matrix4, uvScale: number | [number, number] = 1, shadow = true) {
    let g = geo.index ? geo : geo.toNonIndexed()
    if (!g.index) {
      const n = g.attributes.position!.count
      const idx = new Array<number>(n)
      for (let i = 0; i < n; i++) idx[i] = i
      g.setIndex(idx)
    }
    for (const name of Object.keys(g.attributes)) if (name !== "position" && name !== "normal" && name !== "uv") g.deleteAttribute(name)
    if (!g.attributes.normal) g.computeVertexNormals()
    if (!g.attributes.uv) g.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position!.count * 2), 2))
    if (matrix) g.applyMatrix4(matrix)
    const [su, sv] = typeof uvScale === "number" ? [uvScale, uvScale] : uvScale
    if (su !== 1 || sv !== 1) {
      const uv = g.attributes.uv!
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv)
    }
    this.bucket(mat, shadow).geos.push(g)
  }

  /** A square-section member from `a` to `b` (truss chords, struts, rails). */
  strut(mat: Mat, a: THREE.Vector3, b: THREE.Vector3, thickness: number, round = false) {
    const len = a.distanceTo(b)
    if (len < 1e-4) return
    const g = round ? new THREE.CylinderGeometry(thickness / 2, thickness / 2, len, 6, 1, true) : new THREE.BoxGeometry(thickness, len, thickness)
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), tmpV.subVectors(b, a).normalize())
    m.compose(new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1))
    this.add(mat, g, m, [thickness * 3, len])
  }

  /** Vertical cylinder standing on (x, y0, z). */
  cylinder(mat: Mat, x: number, y0: number, z: number, r: number, h: number, seg = 12, rTop = r) {
    const g = new THREE.CylinderGeometry(rTop, r, h, seg)
    this.add(mat, g, new THREE.Matrix4().makeTranslation(x, y0 + h / 2, z), [Math.PI * 2 * r, h])
  }

  /** Merge every bucket into one mesh per material, add them to `parent`, and clear the batch. */
  flush(parent: THREE.Object3D, opts: { castShadow?: boolean; receiveShadow?: boolean; name?: string } = {}) {
    const meshes: THREE.Mesh[] = []
    for (const b of this.buckets.values()) {
      if (!b.geos.length) continue
      const merged = mergeGeometries(b.geos, false)
      for (const g of b.geos) g.dispose()
      if (!merged) continue
      merged.computeBoundingSphere()
      const mesh = new THREE.Mesh(merged, b.material)
      mesh.name = `${opts.name ?? "facility"}:${b.material.name}`
      mesh.castShadow = (opts.castShadow ?? true) && b.shadow
      mesh.receiveShadow = opts.receiveShadow ?? true
      mesh.matrixAutoUpdate = false
      mesh.updateMatrix()
      parent.add(mesh)
      meshes.push(mesh)
    }
    this.buckets.clear()
    return meshes
  }
}

/** Deterministic pseudo-random sequence so the facility looks the same on every load. */
export function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Builds a non-standard-attribute geometry from quads (lit windows, stain decals). */
export class QuadBuilder {
  pos: number[] = []
  nor: number[] = []
  uv: number[] = []
  extra: number[] = []
  idx: number[] = []
  constructor(readonly extraSize: number) {}

  /** Quad from corner `o` spanning `u` and `v`, facing `n`; uv runs (0,0)…(uMax,vMax); `extra` per-quad attribute. */
  quad(o: THREE.Vector3, u: THREE.Vector3, v: THREE.Vector3, n: THREE.Vector3, uvMax: [number, number], extra: number[], uvMin: [number, number] = [0, 0]) {
    const base = this.pos.length / 3
    const corners: [number, number, number, number][] = [
      [0, 0, uvMin[0], uvMin[1]],
      [1, 0, uvMax[0], uvMin[1]],
      [1, 1, uvMax[0], uvMax[1]],
      [0, 1, uvMin[0], uvMax[1]],
    ]
    for (const [a, b, s, t] of corners) {
      this.pos.push(o.x + u.x * a + v.x * b, o.y + u.y * a + v.y * b, o.z + u.z * a + v.z * b)
      this.nor.push(n.x, n.y, n.z)
      this.uv.push(s, t)
      this.extra.push(...extra)
    }
    // Wind so the face points along n.
    const cross = new THREE.Vector3().crossVectors(u, v).dot(n) > 0
    if (cross) this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
    else this.idx.push(base, base + 2, base + 1, base, base + 3, base + 2)
  }

  geometry(extraName: string) {
    const g = new THREE.BufferGeometry()
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3))
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.nor, 3))
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2))
    g.setAttribute(extraName, new THREE.Float32BufferAttribute(this.extra, this.extraSize))
    g.setIndex(this.idx)
    g.computeBoundingSphere()
    return g
  }
}
