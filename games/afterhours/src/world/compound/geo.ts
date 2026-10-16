import * as THREE from "three/webgpu"
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js"

// Small geometry kit for the compound: primitives with UVs in metres and a batch that merges everything added with
// the same material into one mesh, so hundreds of posts, curbs and props cost a handful of draw calls.

const tmpM = new THREE.Matrix4()
const tmpQ = new THREE.Quaternion()
const tmpE = new THREE.Euler()
const tmpS = new THREE.Vector3()
const tmpP = new THREE.Vector3()

/** Box centred on the origin with every face's UVs in metres. */
export function box(w: number, h: number, d: number) {
  const g = new THREE.BoxGeometry(w, h, d)
  const uv = g.attributes.uv!
  // Face order: +x, -x, +y, -y, +z, -z; 4 vertices each.
  const dims: [number, number][] = [
    [d, h],
    [d, h],
    [w, d],
    [w, d],
    [w, h],
    [w, h],
  ]
  for (let f = 0; f < 6; f++) {
    const [su, sv] = dims[f]!
    for (let i = 0; i < 4; i++) {
      const k = f * 4 + i
      uv.setXY(k, uv.getX(k) * su, uv.getY(k) * sv)
    }
  }
  return g
}

/** Vertical cylinder centred on the origin, UVs in metres (u around the circumference). */
export function cyl(rTop: number, rBottom: number, h: number, seg = 8, open = false) {
  const g = new THREE.CylinderGeometry(rTop, rBottom, h, seg, 1, open)
  const uv = g.attributes.uv!
  const c = Math.PI * (rTop + rBottom)
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * c, uv.getY(i) * h)
  return g
}

/** A sphere (or part of one) with UVs scaled to metres. */
export function sphere(r: number, ws = 10, hs = 6, thetaStart = 0, thetaLength = Math.PI) {
  const g = new THREE.SphereGeometry(r, ws, hs, 0, Math.PI * 2, thetaStart, thetaLength)
  const uv = g.attributes.uv!
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * Math.PI * 2 * r, uv.getY(i) * Math.PI * r)
  return g
}

/** Horizontal plane facing +Y, UVs in metres. */
export function plane(w: number, d: number) {
  const g = new THREE.PlaneGeometry(w, d)
  g.rotateX(-Math.PI / 2)
  const uv = g.attributes.uv!
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w, uv.getY(i) * d)
  return g
}

/** Tube along a curve with UVs in metres. */
export function tube(curve: THREE.Curve<THREE.Vector3>, r: number, seg: number, radial = 6) {
  const g = new THREE.TubeGeometry(curve, seg, r, radial, false)
  const uv = g.attributes.uv!
  const len = curve.getLength()
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * len, uv.getY(i) * Math.PI * 2 * r)
  return g
}

/** Cylinder of radius r spanning from a to b. */
export function rod(a: THREE.Vector3Like, b: THREE.Vector3Like, r: number, seg = 5) {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const dz = b.z - a.z
  const len = Math.hypot(dx, dy, dz)
  const g = cyl(r, r, len, seg, true)
  tmpP.set(dx / len, dy / len, dz / len)
  tmpQ.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tmpP)
  tmpM.compose(new THREE.Vector3((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2), tmpQ, tmpS.set(1, 1, 1))
  g.applyMatrix4(tmpM)
  return g
}

/**
 * Side silhouette in the XY plane: a straight bottom at y0 from x0 to x1 with wheel-arch cut-outs, then the `top`
 * outline from front (x1) back to rear (x0). Used for car bodies, wood panels and truck beds.
 */
export function sideShape(
  x0: number,
  x1: number,
  y0: number,
  top: [number, number][],
  arches: { x: number; y: number; r: number }[] = [],
) {
  const s = new THREE.Shape()
  s.moveTo(x0, y0)
  for (const a of [...arches].sort((p, q) => p.x - q.x)) {
    const dy = y0 - a.y
    if (Math.abs(dy) >= a.r) continue
    const dx = Math.sqrt(a.r * a.r - dy * dy)
    if (a.x - dx < x0 || a.x + dx > x1) continue
    s.lineTo(a.x - dx, y0)
    const t = Math.asin(dy / a.r)
    s.absarc(a.x, a.y, a.r, Math.PI - t, t, true)
  }
  s.lineTo(x1, y0)
  for (const p of top) s.lineTo(p[0], p[1])
  s.lineTo(x0, y0)
  return s
}

/** Extrudes a side shape across `width` (centred on z = 0) with a rounded bevel. */
export function extrudeSide(shape: THREE.Shape, width: number, bevel = 0.03, curveSegments = 10) {
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(width - bevel * 2, 0.001),
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 2,
    curveSegments,
  })
  g.translate(0, 0, -(width - bevel * 2) / 2)
  return g
}

export function matrix(x: number, y: number, z: number, ry = 0, rx = 0, rz = 0, s = 1) {
  tmpE.set(rx, ry, rz, "YXZ")
  tmpQ.setFromEuler(tmpE)
  return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), tmpQ, new THREE.Vector3(s, s, s))
}

function normalise(g: THREE.BufferGeometry) {
  for (const name of Object.keys(g.attributes)) if (name !== "position" && name !== "normal" && name !== "uv") g.deleteAttribute(name)
  if (!g.attributes.uv) g.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position!.count * 2), 2))
  if (!g.attributes.normal) g.computeVertexNormals()
  if (!g.index) {
    const n = g.attributes.position!.count
    const idx = n > 65535 ? new Uint32Array(n) : new Uint16Array(n)
    for (let i = 0; i < n; i++) idx[i] = i
    g.setIndex(new THREE.BufferAttribute(idx, 1))
  }
  g.clearGroups()
  return g
}

/** Collects geometry per material and merges it into one mesh per material. */
export class Batch {
  private parts = new Map<THREE.Material, THREE.BufferGeometry[]>()

  constructor(private parent?: THREE.Matrix4) {}

  add(mat: THREE.Material, geo: THREE.BufferGeometry, m?: THREE.Matrix4) {
    const g = normalise(geo)
    if (m) g.applyMatrix4(m)
    if (this.parent) g.applyMatrix4(this.parent)
    let list = this.parts.get(mat)
    if (!list) this.parts.set(mat, (list = []))
    list.push(g)
    return this
  }

  at(mat: THREE.Material, geo: THREE.BufferGeometry, x: number, y: number, z: number, ry = 0, rx = 0, rz = 0) {
    return this.add(mat, geo, matrix(x, y, z, ry, rx, rz))
  }

  /** A child batch whose additions are first transformed by `m` (in this batch's space). */
  child(m: THREE.Matrix4) {
    const sub = new Batch(this.parent ? this.parent.clone().multiply(m) : m.clone())
    sub.parts = this.parts
    return sub
  }

  build(parent: THREE.Object3D, opts: { castShadow?: boolean | ((m: THREE.Material) => boolean); receiveShadow?: boolean; name?: string } = {}) {
    const meshes: THREE.Mesh[] = []
    for (const [mat, list] of this.parts) {
      const geo = mergeGeometries(list, false)
      if (!geo) continue
      geo.computeBoundingSphere()
      const mesh = new THREE.Mesh(geo, mat)
      mesh.name = `${opts.name ?? "compound"}:${mat.name}`
      mesh.castShadow = typeof opts.castShadow === "function" ? opts.castShadow(mat) : (opts.castShadow ?? false)
      mesh.receiveShadow = opts.receiveShadow ?? true
      mesh.matrixAutoUpdate = false
      parent.add(mesh)
      meshes.push(mesh)
      for (const g of list) g.dispose()
    }
    this.parts.clear()
    return meshes
  }
}
