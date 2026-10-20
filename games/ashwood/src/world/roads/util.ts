import * as THREE from "three/webgpu"
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js"
import type { Vec2 } from "../layout"
import { material, type MaterialName, type SurfaceMaterial } from "../../render/materials"

// Shared helpers for the road builders: a resampled centre line with arc length, deterministic noise, a small
// indexed mesh builder, metre-UV primitives and a per-material merge bucket so the whole road network is a handful
// of draw calls.

export type LinePoint = { x: number; z: number; tx: number; tz: number; s: number }

/** A polyline centre line with arc length. Positive `u` offsets go along n = (-tz, tx): east on a road heading
 *  north, south on a road heading east. */
export class Line {
  readonly pts: LinePoint[]
  readonly length: number

  constructor(samples: readonly Vec2[]) {
    const pts: LinePoint[] = []
    let s = 0
    for (let i = 0; i < samples.length; i++) {
      const p = samples[i]!
      if (i > 0) {
        const q = samples[i - 1]!
        const d = Math.hypot(p[0] - q[0], p[1] - q[1])
        if (d < 1e-4) continue
        s += d
      }
      pts.push({ x: p[0], z: p[1], tx: 0, tz: 0, s })
    }
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(i - 1, 0)]!
      const b = pts[Math.min(i + 1, pts.length - 1)]!
      const l = Math.hypot(b.x - a.x, b.z - a.z) || 1
      pts[i]!.tx = (b.x - a.x) / l
      pts[i]!.tz = (b.z - a.z) / l
    }
    this.pts = pts
    this.length = s
  }

  at(s: number): LinePoint {
    const p = this.pts
    if (s <= 0) return { ...p[0]!, s: Math.max(s, 0) }
    if (s >= this.length) return { ...p[p.length - 1]! }
    let lo = 0
    let hi = p.length - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (p[mid]!.s <= s) lo = mid
      else hi = mid
    }
    const a = p[lo]!
    const b = p[hi]!
    const t = (s - a.s) / (b.s - a.s || 1)
    const tx = a.tx + (b.tx - a.tx) * t
    const tz = a.tz + (b.tz - a.tz) * t
    const l = Math.hypot(tx, tz) || 1
    return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, tx: tx / l, tz: tz / l, s }
  }

  /** World x/z of the point `u` metres to the side of the centre line at arc length `s`. */
  offset(s: number, u: number): [number, number] {
    const p = this.at(s)
    return [p.x - p.tz * u, p.z + p.tx * u]
  }

  /** Arc lengths of the stored samples inside (s0, s1), bracketed by s0 and s1. */
  stations(s0: number, s1: number, minStep = 0): number[] {
    const out = [s0]
    for (const p of this.pts) if (p.s > s0 + minStep && p.s < s1 - minStep * 0.5) out.push(p.s)
    out.push(s1)
    return out
  }
}

export function hash(i: number, seed: number) {
  const s = Math.sin(i * 127.1 + seed * 311.7) * 43758.5453
  return s - Math.floor(s)
}

/** Smooth 1D value noise in 0..1. */
export function noise1(x: number, seed: number) {
  const i = Math.floor(x)
  const f = x - i
  const u = f * f * (3 - 2 * f)
  return hash(i, seed) + (hash(i + 1, seed) - hash(i, seed)) * u
}

/** Smooth 2D value noise in 0..1. */
export function noise2(x: number, y: number, seed: number) {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const fx = x - xi
  const fy = y - yi
  const u = fx * fx * (3 - 2 * fx)
  const v = fy * fy * (3 - 2 * fy)
  const h = (a: number, b: number) => hash(a * 57.31 + b * 113.7, seed)
  const a = h(xi, yi)
  const b = h(xi + 1, yi)
  const c = h(xi, yi + 1)
  const d = h(xi + 1, yi + 1)
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
}

export function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Indexed triangle soup with optional grey vertex colour. Triangles (a, b, c) wind counter-clockwise seen from
 *  their front, matching three.js. */
export class MeshBuilder {
  pos: number[] = []
  uv: number[] = []
  col: number[] = []
  idx: number[] = []

  get count() {
    return this.pos.length / 3
  }

  vert(x: number, y: number, z: number, u: number, v: number, c = 1) {
    this.pos.push(x, y, z)
    this.uv.push(u, v)
    this.col.push(c, c, c)
    return this.count - 1
  }

  tri(a: number, b: number, c: number) {
    this.idx.push(a, b, c)
  }

  /** a-b along one row, c-d the next row (a→c and b→d along the line). */
  quad(a: number, b: number, c: number, d: number) {
    this.idx.push(a, b, c, b, d, c)
  }

  geometry(colors = false) {
    const g = new THREE.BufferGeometry()
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3))
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2))
    if (colors) g.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3))
    g.setIndex(this.idx)
    g.computeVertexNormals()
    return g
  }
}

/** Box with UVs in metres on every face. */
export function boxM(w: number, h: number, d: number) {
  const g = new THREE.BoxGeometry(w, h, d)
  const uv = g.attributes.uv!
  const sizes: [number, number][] = [
    [d, h],
    [d, h],
    [w, d],
    [w, d],
    [w, h],
    [w, h],
  ]
  for (let f = 0; f < 6; f++) {
    const [su, sv] = sizes[f]!
    for (let k = 0; k < 4; k++) {
      const i = f * 4 + k
      uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv)
    }
  }
  return g
}

/** Cylinder (Y axis, centred) with UVs in metres around and along. */
export function cylM(rTop: number, rBottom: number, h: number, seg = 8, open = false) {
  const g = new THREE.CylinderGeometry(rTop, rBottom, h, seg, 1, open)
  const circ = Math.PI * (rTop + rBottom)
  const uv = g.attributes.uv!
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * circ, uv.getY(i) * h)
  if (open) return g
  // Drop the cap groups so every primitive merges cleanly.
  g.clearGroups()
  return g
}

const Y = new THREE.Vector3(0, 1, 0)

/** A box of cross-section w × d stretched between two points. */
export function beam(a: THREE.Vector3, b: THREE.Vector3, w: number, d: number) {
  const dir = new THREE.Vector3().subVectors(b, a)
  const len = dir.length()
  const g = boxM(w, len, d)
  const q = new THREE.Quaternion().setFromUnitVectors(Y, dir.normalize())
  g.applyMatrix4(new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1)))
  return g
}

/** A round tube with `sides` faces through `pts`, appended to a builder (used for wires and curved arms). */
export function tubeInto(mb: MeshBuilder, pts: readonly THREE.Vector3[], r: number, sides = 4) {
  const t = new THREE.Vector3()
  const side = new THREE.Vector3()
  const up = new THREE.Vector3()
  let along = 0
  let first = -1
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!
    const a = pts[Math.max(i - 1, 0)]!
    const b = pts[Math.min(i + 1, pts.length - 1)]!
    t.subVectors(b, a).normalize()
    side.crossVectors(t, Y)
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0)
    side.normalize()
    up.crossVectors(side, t).normalize()
    if (i > 0) along += p.distanceTo(pts[i - 1]!)
    const base = mb.count
    if (i === 0) first = base
    for (let k = 0; k < sides; k++) {
      const ang = (k / sides) * Math.PI * 2
      const c = Math.cos(ang) * r
      const s = Math.sin(ang) * r
      mb.vert(p.x + side.x * c + up.x * s, p.y + side.y * c + up.y * s, p.z + side.z * c + up.z * s, (k / sides) * r * 6.28, along)
    }
    if (i > 0) {
      const prev = base - sides
      for (let k = 0; k < sides; k++) {
        const k1 = (k + 1) % sides
        mb.idx.push(prev + k, base + k, prev + k1, prev + k1, base + k, base + k1)
      }
    }
  }
  return first
}

/** Collects geometry per material and merges each bucket into one static mesh. */
export class Parts {
  private buckets = new Map<string, { mat: THREE.Material; geos: THREE.BufferGeometry[] }>()

  add(mat: MaterialName | THREE.Material, geo: THREE.BufferGeometry, m?: THREE.Matrix4) {
    if (m) geo.applyMatrix4(m)
    const key = typeof mat === "string" ? mat : mat.uuid
    let b = this.buckets.get(key)
    if (!b) {
      b = { mat: typeof mat === "string" ? material(mat) : mat, geos: [] }
      this.buckets.set(key, b)
    }
    for (const k of Object.keys(geo.attributes)) if (k !== "position" && k !== "normal" && k !== "uv") geo.deleteAttribute(k)
    b.geos.push(geo.index ? geo : geo.setIndex([...Array(geo.attributes.position!.count).keys()]))
  }

  build(parent: THREE.Object3D, name: string, opts: { castShadow?: boolean; receiveShadow?: boolean } = {}) {
    for (const [key, b] of this.buckets) {
      const geos = b.geos
      const merged = mergeGeometries(geos, false)
      if (!merged) throw new Error(`roads: could not merge ${name}/${key}`)
      merged.computeBoundingSphere()
      const mesh = new THREE.Mesh(merged, b.mat)
      mesh.name = `${name}:${b.mat.name || key}`
      mesh.castShadow = opts.castShadow ?? false
      mesh.receiveShadow = opts.receiveShadow ?? true
      mesh.matrixAutoUpdate = false
      mesh.updateMatrix()
      parent.add(mesh)
      for (const g of geos) g.dispose()
    }
  }
}

/** +1 with a reversed depth buffer (greater depth = nearer), -1 with a standard one. three r186 passes
 *  `polygonOffset*` straight to WebGPU's depthBias without flipping it for reversed-Z, so a negative offset there
 *  pushes the decal *behind* the surface it sits on, and the slope-scaled part grows at grazing angles until distant
 *  paint loses to the asphalt and only near paint draws. */
let towardCamera = -1
export function setDepthBiasDirection(renderer: THREE.WebGPURenderer) {
  const p = (renderer.backend as { parameters?: { reversedDepthBuffer?: boolean } }).parameters
  towardCamera = p?.reversedDepthBuffer ? 1 : -1
}

/** A vertex-coloured, polygon-offset copy of a library material for road surfaces and paint. All callers set the same
 *  flags, so every copy shares one shader; only the (pipeline-state) bias strength differs. `strength` is how far
 *  towards the camera to pull: the paint also has a real geometric lift, so this only settles depth ties. */
export function decalMaterial(name: MaterialName, strength = 2) {
  const m = material(name).clone()
  m.polygonOffset = true
  m.polygonOffsetFactor = towardCamera * strength * 0.5
  m.polygonOffsetUnits = towardCamera * strength * 2
  m.vertexColors = true
  m.name = `${name}_road`
  return m
}

let poleWoodMat: THREE.Material | null = null
/** Creosoted pole wood: the library wood scan tinted darker (same shader, only the per-material tint differs). */
export function poleWood() {
  if (poleWoodMat) return poleWoodMat
  const m = material("wood_pole").clone() as SurfaceMaterial
  // Scan class: p1.rgb is the albedo tint.
  if (m.surfaceParams) for (let i = 4; i < 7; i++) m.surfaceParams[i]! *= 0.5
  m.name = "wood_pole_dark"
  poleWoodMat = m
  return m
}
