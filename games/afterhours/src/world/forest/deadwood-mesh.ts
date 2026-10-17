import * as THREE from "three/webgpu"
import { attribute, float, mix, mx_noise_float, normalGeometry, positionGeometry, smoothstep, vec3, varying } from "three/tsl"
import { material, type SurfaceMaterial } from "../../render/materials"
import { rng, range } from "./rng"
import { solidMaterial } from "./render"

// Fallen-log and stump meshes: tapered, lumpy, slightly bowed trunks with splintered broken ends. Each mesh has two
// groups: weathered bark (group 0) and end grain (group 1). The bark is the library bark class retuned darker and
// deeper-furrowed through its parameters, plus moss on upward faces; the end grain is a plain member of the library
// scan class (wood_pole scan, pale and silvered), so it shares the tree-trunk shader.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any

type Mesh = { pos: number[]; uv: number[]; idx: number[]; sides: number }

function finish(m: Mesh) {
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.Float32BufferAttribute(m.pos, 3))
  g.setAttribute("uv", new THREE.Float32BufferAttribute(m.uv, 2))
  g.setAttribute("flex", new THREE.Float32BufferAttribute(new Float32Array(m.pos.length / 3), 1))
  g.setIndex(m.idx)
  g.addGroup(0, m.sides, 0)
  g.addGroup(m.sides, m.idx.length - m.sides, 1)
  g.computeVertexNormals()
  return g
}

/**
 * Jagged, splintered cap closing a ring of rim points (n + 1 with a seam duplicate), pushed out along `axis`. UVs are
 * (arc length, distance from the centre) so the wood scan's grain runs radially, like the checks in a weathered end.
 */
function brokenCap(m: Mesh, ringPts: number[][], center: number[], axis: number[], spike: number, r: () => number) {
  const n = ringPts.length - 1
  const rad = (p: number[]) => {
    const d = [p[0]! - center[0]!, p[1]! - center[1]!, p[2]! - center[2]!]
    const along = d[0]! * axis[0]! + d[1]! * axis[1]! + d[2]! * axis[2]!
    return Math.hypot(d[0]! - axis[0]! * along, d[1]! - axis[1]! * along, d[2]! - axis[2]! * along)
  }
  const R = ringPts.reduce((s, p) => s + rad(p), 0) / ringPts.length
  const push = (p: number[], u: number, v: number) => {
    m.pos.push(p[0]!, p[1]!, p[2]!)
    m.uv.push(u, v)
  }
  const base = m.pos.length / 3
  ringPts.forEach((p, i) => push(p, (i / n) * Math.PI * 2 * R, rad(p)))
  // Splinters standing proud of the break between the rim and the heart; the last duplicates the first for the seam.
  const mid = m.pos.length / 3
  const outs = Array.from({ length: n }, () => range(r, -0.25, 1) * spike)
  for (let i = 0; i <= n; i++) {
    const a = ringPts[i]!
    const t = 0.55
    const out = outs[i % n]!
    push(
      [a[0]! + (center[0]! - a[0]!) * t + axis[0]! * out, a[1]! + (center[1]! - a[1]!) * t + axis[1]! * out, a[2]! + (center[2]! - a[2]!) * t + axis[2]! * out],
      (i / n) * Math.PI * 2 * R,
      R * (1 - t),
    )
  }
  const c = m.pos.length / 3
  const cs = range(r, -0.3, 0.6) * spike
  push([center[0]! + axis[0]! * cs, center[1]! + axis[1]! * cs, center[2]! + axis[2]! * cs], Math.PI * R, 0)
  for (let i = 0; i < n; i++) m.idx.push(base + i, base + i + 1, mid + i, base + i + 1, mid + i + 1, mid + i, mid + i, mid + i + 1, c)
}

/** A fallen trunk along local +X, centred on the origin, butt (wider) at -X. */
export function logGeometry(len: number, radius: number, seed: number) {
  const r = rng(seed)
  const m: Mesh = { pos: [], uv: [], idx: [], sides: 0 }
  const radial = 12
  const rings = Math.max(4, Math.min(18, Math.round(len / 0.7)))
  const taper = range(r, 0.25, 0.5)
  const bowY = range(r, -0.06, 0.03) * len * 0.1
  const bowZ = range(r, -0.06, 0.06) * len * 0.1
  const lumpPhase = r() * 10
  // Ragged ends: each rim vertex is pulled along the axis by a different amount.
  const rag = (end: number) => Array.from({ length: radial }, () => range(r, 0, end))
  const ragA = rag(radius * 0.5)
  const ragB = rag(radius * 1.4)
  const ringA: number[][] = []
  const ringB: number[][] = []
  for (let j = 0; j <= rings; j++) {
    const t = j / rings
    const x0 = (t - 0.5) * len
    const rr = radius * (1 - taper * t) * (1 + 0.1 * Math.sin(t * 9 + lumpPhase) * Math.sin(t * 23))
    const cy = -Math.sin(t * Math.PI) * bowY
    const cz = Math.sin(t * Math.PI) * bowZ
    for (let i = 0; i <= radial; i++) {
      const a = (i / radial) * Math.PI * 2
      const ii = i % radial
      // Irregular, slightly flattened cross-section; flatter on the bottom where it rests.
      let k = 1 + 0.07 * Math.sin(a * 3 + lumpPhase + t * 4) + 0.04 * Math.sin(a * 5 + t * 11)
      if (Math.sin(a) < -0.5) k *= 0.92
      const x = x0 + (j === 0 ? -ragA[ii]! : j === rings ? ragB[ii]! : 0)
      const p = [x, cy + Math.sin(a) * rr * k, cz + Math.cos(a) * rr * k]
      m.pos.push(p[0]!, p[1]!, p[2]!)
      m.uv.push((i / radial) * Math.PI * 2 * radius, x)
      if (j === 0) ringA.push(p)
      if (j === rings) ringB.push(p)
    }
  }
  const cols = radial + 1
  for (let j = 0; j < rings; j++)
    for (let i = 0; i < radial; i++) {
      const a = j * cols + i
      m.idx.push(a, a + cols, a + 1, a + 1, a + cols, a + cols + 1)
    }
  m.sides = m.idx.length
  const cA = [-len / 2 - radius * 0.2, 0, 0]
  const cB = [len / 2 + radius * 0.6, 0, 0]
  brokenCap(m, ringA, cA, [-1, 0, 0], radius * 0.6, r)
  brokenCap(m, [...ringB].reverse(), cB, [1, 0, 0], radius * 1.6, r)
  return finish(m)
}

/** A stump: root flare at the base and either a snapped, splintered top (0) or an old, rounded-off cut (1). */
export function stumpGeometry(shape: number, seed: number) {
  const r = rng(seed)
  const m: Mesh = { pos: [], uv: [], idx: [], sides: 0 }
  const radial = 14
  const R = 0.42
  const H = shape === 0 ? 1.1 : 0.55
  const rings = [-0.35, -0.05, 0.12, 0.3, H * 0.7, H]
  const roots = 4 + Math.floor(r() * 3)
  const rootPhase = r() * 6
  const top = Array.from({ length: radial }, () => (shape === 0 ? range(r, -0.35, 0.3) : range(r, -0.06, 0.04)))
  const ring: number[][] = []
  rings.forEach((y, j) => {
    const flare = Math.max(0, 1 - (y + 0.05) / 0.45)
    for (let i = 0; i <= radial; i++) {
      const a = (i / radial) * Math.PI * 2
      const lobe = Math.pow(Math.max(0, Math.cos(a * roots + rootPhase)), 3)
      const rr = R * (1 + flare * (0.35 + lobe * 0.9)) * (1 + 0.05 * Math.sin(a * 5 + y * 7))
      const yy = j === rings.length - 1 ? y + top[i % radial]! : y
      const p = [Math.cos(a) * rr, yy, Math.sin(a) * rr]
      m.pos.push(p[0]!, p[1]!, p[2]!)
      m.uv.push((i / radial) * Math.PI * 2 * R, yy)
      if (j === rings.length - 1) ring.push(p)
    }
  })
  const cols = radial + 1
  for (let j = 0; j < rings.length - 1; j++)
    for (let i = 0; i < radial; i++) {
      const a = j * cols + i
      m.idx.push(a, a + cols, a + 1, a + 1, a + cols, a + cols + 1)
    }
  m.sides = m.idx.length
  brokenCap(m, [...ring].reverse(), [0, H, 0], [0, 1, 0], shape === 0 ? 0.45 : 0.04, r)
  return finish(m)
}

/** Sets scan-class parameters on a clone: p0 (size, antiTile, sat, normalScale), p1 (tint rgb), p2 (roughA, roughB), p5.w contrast. */
function retune(m: SurfaceMaterial, o: { size: number; sat: number; normalScale: number; tint: [number, number, number]; rough: [number, number]; contrast: number }) {
  const p = m.surfaceParams
  p[0] = o.size
  p[1] = 1
  p[2] = o.sat
  p[3] = o.normalScale
  p.set(o.tint, 4)
  p[8] = o.rough[0]
  p[9] = o.rough[1]
  p[23] = o.contrast
}

/** [weathered bark with moss, end grain] for the two groups of every log and stump mesh. */
export function deadwoodMaterials(): [THREE.Material, THREE.Material] {
  // Smaller, deeper furrows and a much darker, greyer bark than live trunks; anti-tiled so long logs don't repeat.
  const bark = solidMaterial(material("bark")) as SurfaceMaterial
  retune(bark, { size: 0.85, sat: 0.3, normalScale: 2.6, tint: [0.2, 0.19, 0.18], rough: [0.25, 0.74], contrast: 2.2 })
  const baseColor: N = bark.colorNode
  const ny = varying(normalGeometry.y, "vDeadUp") as N
  const inst = attribute("iB", "vec4") as N
  const phase = varying(inst.w, "vDeadPhase") as N
  const tint = varying(inst.z, "vDeadTint") as N
  const p = (positionGeometry as N).add(vec3(phase, phase.mul(0.37), 0))
  const n1 = mx_noise_float(p.mul(1.6)) as N
  const n2 = mx_noise_float(p.mul(7.3)) as N
  const mossMask = smoothstep(0.3, 0.9, ny.add(n1.mul(0.4)).add(n2.mul(0.25))).mul(smoothstep(-0.2, 0.35, n1)).mul(0.85)
  const moss = mix(vec3(0.018, 0.022, 0.009), vec3(0.035, 0.04, 0.016), n2.mul(0.5).add(0.5))
  bark.colorNode = mix(baseColor.mul(tint.mul(0.3).add(0.7)), moss, mossMask)
  bark.roughnessNode = mix(bark.roughnessNode as N, float(0.97), mossMask)

  // Silvered, sun- and rain-bleached splintered wood: the pole scan desaturated, pale, with its grain running radially.
  const end = solidMaterial(material("wood_pole")) as SurfaceMaterial
  retune(end, { size: 0.5, sat: 0.35, normalScale: 2.2, tint: [1.05, 0.95, 0.82], rough: [0.2, 0.75], contrast: 1.5 })
  return [bark, end]
}
