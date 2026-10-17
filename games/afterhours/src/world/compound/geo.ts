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

/** Surface of revolution about +Y through `profile` [radius, y] points (bottom to top), UVs in metres. */
export function lathe(profile: [number, number][], seg = 20) {
  const g = new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), seg)
  const uv = g.attributes.uv!
  const rMax = Math.max(...profile.map((p) => p[0]))
  const h = profile[profile.length - 1]![1] - profile[0]![1]
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * Math.PI * 2 * rMax, uv.getY(i) * h)
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
