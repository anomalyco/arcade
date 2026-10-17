import * as THREE from "three/webgpu"
import type { WorldContext } from "../context"
import { heightAt } from "../height"
import { FENCE } from "../layout"
import { material, materialFor } from "../../render/materials"
import { Batch, box, cyl, matrix, rod } from "./geo"
import { fenceVeil, flat, signBlank, signInk, signPlate as signPlateMat, signRed, signYellow } from "./mats"

// Perimeter fence: galvanised line posts every FENCE.postSpacing m, top rail, chain-link mesh, 45° outriggers with
// three barbed strands and a concertina razor coil. The gates and the boom barrier are in compound/gate.ts.
// Each straight run is merged into one mesh per material so the ~870 m of fence costs a few draw calls and still culls.

type Run = { a: THREE.Vector2; b: THREE.Vector2; out: THREE.Vector3; endPosts: [boolean, boolean] }

/** Opening for the pedestrian gate in the south fence, east of the vehicle gate (between the two end posts). */
export const PED_GATE = { x0: 6.6, x1: 7.6 }

const H = FENCE.height
const ARM = FENCE.barbHeight
const POST_R = 0.044
const END_R = 0.06
const MESH_BOTTOM = 0.04
const MESH_TOP = H - 0.05

function runs(): Run[] {
  const [x0, z0] = FENCE.min
  const [x1, z1] = FENCE.max
  const { x0: g0, x1: g1 } = FENCE.gate
  const v = (x: number, z: number) => new THREE.Vector2(x, z)
  return [
    { a: v(x0, z1), b: v(g0, z1), out: new THREE.Vector3(0, 0, 1), endPosts: [true, true] },
    // East of the vehicle opening: a short run, the pedestrian gate opening (PED_GATE), then the long run.
    { a: v(g1, z1), b: v(PED_GATE.x0, z1), out: new THREE.Vector3(0, 0, 1), endPosts: [true, true] },
    { a: v(PED_GATE.x1, z1), b: v(x1, z1), out: new THREE.Vector3(0, 0, 1), endPosts: [true, true] },
    { a: v(x1, z1), b: v(x1, z0), out: new THREE.Vector3(1, 0, 0), endPosts: [true, true] },
    { a: v(x1, z0), b: v(x0, z0), out: new THREE.Vector3(0, 0, -1), endPosts: [true, true] },
    { a: v(x0, z0), b: v(x0, z1), out: new THREE.Vector3(-1, 0, 0), endPosts: [true, true] },
    // Inner security fence: the service yard west of the loading dock (seen behind the dock, concept r5-06).
    { a: v(-54, -24), b: v(-54, -95), out: new THREE.Vector3(-1, 0, 0), endPosts: [true, true] },
  ]
}

/** Chain-link strip through a list of points (one quad per span), UVs in metres, normal facing `out`. */
function meshStrip(pts: THREE.Vector3[], out: THREE.Vector3, bottom: number, top: number) {
  const pos: number[] = []
  const nor: number[] = []
  const uvs: number[] = []
  const idx: number[] = []
  let u = 0
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!
    if (i > 0) u += p.distanceTo(pts[i - 1]!)
    pos.push(p.x, p.y + bottom, p.z, p.x, p.y + top, p.z)
    nor.push(out.x, out.y, out.z, out.x, out.y, out.z)
    uvs.push(u, bottom, u, top)
    if (i > 0) {
      const k = i * 2
      idx.push(k - 2, k, k - 1, k - 1, k, k + 1)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3))
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2))
  g.setIndex(idx)
  return g
}

/** Concertina razor coil: a thin triangular tube wound along `dir` from `start` for `len` metres. */
function coil(start: THREE.Vector3, dir: THREE.Vector3, out: THREE.Vector3, len: number, radius: number, pitch: number, seed: number) {
  const segPerLoop = 11
  const loops = Math.floor(len / pitch)
  const n = loops * segPerLoop + 1
  const wire = 0.016
  const pos = new Float32Array(n * 3 * 3)
  const nor = new Float32Array(n * 3 * 3)
  const uvs = new Float32Array(n * 3 * 2)
  const idx: number[] = []
  const up = new THREE.Vector3(0, 1, 0)
  const c = new THREE.Vector3()
  const radial = new THREE.Vector3()
  const t2 = new THREE.Vector3()
  const p = new THREE.Vector3()
  const at = (th: number, target: THREE.Vector3) => {
    const r = radius * (1 + 0.08 * Math.sin(th * 0.37 + seed) + 0.05 * Math.sin(th * 1.13 + seed * 2))
    const s = (th / (Math.PI * 2)) * pitch
    return target
      .copy(start)
      .addScaledVector(dir, s + Math.sin(th) * pitch * 0.35)
      .addScaledVector(out, Math.cos(th) * r)
      .addScaledVector(up, Math.sin(th) * r * 0.92)
  }
  const q = new THREE.Vector3()
  for (let i = 0; i < n; i++) {
    const th = (i / segPerLoop) * Math.PI * 2
    at(th, c)
    radial.copy(out).multiplyScalar(Math.cos(th)).addScaledVector(up, Math.sin(th)).normalize()
    at(th + 0.01, q)
    q.sub(c).normalize()
    t2.crossVectors(q, radial).normalize()
    for (let k = 0; k < 3; k++) {
      const phi = (k / 3) * Math.PI * 2
      p.copy(radial).multiplyScalar(Math.cos(phi)).addScaledVector(t2, Math.sin(phi))
      const o = (i * 3 + k) * 3
      pos[o] = c.x + p.x * wire
      pos[o + 1] = c.y + p.y * wire
      pos[o + 2] = c.z + p.z * wire
      nor[o] = p.x
      nor[o + 1] = p.y
      nor[o + 2] = p.z
      const ou = (i * 3 + k) * 2
      uvs[ou] = (i / segPerLoop) * Math.PI * 2 * radius
      uvs[ou + 1] = k * 0.01
    }
    if (i > 0) {
      for (let k = 0; k < 3; k++) {
        const a = (i - 1) * 3 + k
        const b = (i - 1) * 3 + ((k + 1) % 3)
        const c2 = i * 3 + k
        const d = i * 3 + ((k + 1) % 3)
        idx.push(a, c2, b, b, c2, d)
      }
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3))
  g.setAttribute("normal", new THREE.BufferAttribute(nor, 3))
  g.setAttribute("uv", new THREE.BufferAttribute(uvs, 2))
  g.setIndex(idx)
  return g
}

/** Signs on the outward face: [run index, distance along run, variant]. */
const SIGNS: [number, number, number][] = [
  [0, 78, 0],
  [0, 52, 2],
  [0, 21, 3],
  [1, 11, 0],
  [1, 38, 1],
  [1, 70, 3],
  [2, 40, 2],
  [2, 140, 0],
  [3, 60, 1],
  [3, 130, 3],
  [4, 90, 0],
  [4, 200, 2],
]

export function buildFence(ctx: WorldContext, root: THREE.Object3D) {
  const galv = fenceSteel()
  const wireMat = darkWire()
  const meshMat = fenceMesh()
  const all = runs()

  all.forEach((run, ri) => {
    const batch = new Batch()
    const len = run.a.distanceTo(run.b)
    const dir2 = run.b.clone().sub(run.a).normalize()
    const dir = new THREE.Vector3(dir2.x, 0, dir2.y)
    const out = run.out
    const n = Math.max(1, Math.round(len / FENCE.postSpacing))
    const pts: THREE.Vector3[] = []
    for (let i = 0; i <= n; i++) {
      const s = (i / n) * len
      const x = run.a.x + dir.x * s
      const z = run.a.y + dir.z * s
      pts.push(new THREE.Vector3(x, heightAt(x, z), z))
    }
    pts.forEach((p, i) => {
      const end = (i === 0 && run.endPosts[0]) || (i === n && run.endPosts[1])
      const r = end ? END_R : POST_R
      batch.at(galv, cyl(r, r, H + 0.05 + 0.4, 8, true), p.x, p.y + (H + 0.05) / 2 - 0.2, p.z)
      batch.at(galv, cyl(r * 1.25, r * 1.25, 0.05, 6), p.x, p.y + H + 0.03, p.z)
      // 45° outrigger arm leaning out of the compound.
      const top = new THREE.Vector3(p.x, p.y + H + 0.03, p.z)
      const tip = top.clone().addScaledVector(out, ARM).add(new THREE.Vector3(0, ARM, 0))
      batch.add(galv, rod(top, tip, 0.016, 4))
      if (end) {
        // Diagonal brace from the end post to the next line post.
        const nb = pts[i === 0 ? 1 : n - 1]!
        batch.add(galv, rod(new THREE.Vector3(p.x, p.y + H * 0.5, p.z), new THREE.Vector3(nb.x, nb.y + 0.15, nb.z), 0.02, 4))
      }
    })
    const first = pts[0]!
    const last = pts[n]!
    // Top rail and bottom tension wire.
    batch.add(galv, rod(first.clone().setY(first.y + MESH_TOP), last.clone().setY(last.y + MESH_TOP), 0.021, 6))
    batch.add(wireMat, rod(first.clone().setY(first.y + MESH_BOTTOM + 0.02), last.clone().setY(last.y + MESH_BOTTOM + 0.02), 0.004, 3))
    // Three barbed strands up the outriggers.
    for (const f of [0.34, 0.67, 1]) {
      const off = new THREE.Vector3().addScaledVector(out, ARM * f).setY(H + 0.05 + ARM * f)
      batch.add(wireMat, rod(first.clone().add(off), last.clone().add(off), 0.006, 3))
    }
    const coilStart = first.clone().addScaledVector(out, 0.2).setY(first.y + H + 0.36)
    batch.add(wireMat, coil(coilStart, dir, out, len, 0.36, 0.22, ri * 3.1))
    const meshBatch = new Batch()
    meshBatch.add(meshMat, meshStrip(pts, out, MESH_BOTTOM, MESH_TOP))
    // Faint dark veil on the same strip: the mesh's average coverage, so the fence still reads as a darker band
    // against the fog at 25–40 m where the wires fall below a pixel.
    meshBatch.add(fenceVeil(), meshStrip(pts, out, MESH_BOTTOM, MESH_TOP))

    // Warning plates.
    for (const [sr, sd, variant] of SIGNS) {
      if (sr !== ri || sd > len - 1) continue
      const x = run.a.x + dir.x * sd
      const z = run.a.y + dir.z * sd
      const yaw = Math.atan2(out.x, out.z)
      const tilt = ((sd * 7.3) % 1) * 0.08 - 0.04
      const px = x + out.x * 0.035
      const pz = z + out.z * 0.035
      signPlate(batch.child(matrix(px, 1.55, pz, yaw, 0, tilt)), variant)
    }

    batch.build(root, { castShadow: (m) => m === galv, name: `fence${ri}` })
    for (const mesh of meshBatch.build(root, { name: `fence-mesh${ri}`, receiveShadow: false })) mesh.renderOrder = 1

    const minX = Math.min(run.a.x, run.b.x) - (out.x !== 0 ? 0.08 : 0)
    const maxX = Math.max(run.a.x, run.b.x) + (out.x !== 0 ? 0.08 : 0)
    const minZ = Math.min(run.a.y, run.b.y) - (out.z !== 0 ? 0.08 : 0)
    const maxZ = Math.max(run.a.y, run.b.y) + (out.z !== 0 ? 0.08 : 0)
    ctx.colliders.push({ min: [minX, -1, minZ], max: [maxX, H + ARM + 0.3, maxZ] })
  })

  // Heavier posts either side of the vehicle opening (the sliding gate and its hardware are in compound/gate.ts).
  const posts = new Batch()
  for (const hx of [FENCE.gate.x0, FENCE.gate.x1]) {
    const y = heightAt(hx, FENCE.max[1])
    posts.at(galv, cyl(0.07, 0.07, H + 0.6, 12), hx, y + (H + 0.6) / 2 - 0.3, FENCE.max[1])
    posts.at(galv, new THREE.SphereGeometry(0.08, 12, 6), hx, y + H + 0.32, FENCE.max[1])
    posts.at(material("concrete_dark"), cyl(0.22, 0.24, 0.12, 12), hx, y + 0.04, FENCE.max[1])
  }
  posts.build(root, { castShadow: true, name: "gate-posts" })
}

/**
 * A weathered warning plate on the fence (local frame: +Z faces out of the compound), with an abstract pictogram and
 * no text: 0 danger band + triangle, 1 yellow diamond + bolt, 2 prohibition ring, 3 blank.
 */
function signPlate(b: Batch, variant: number) {
  const W = 0.6
  const H = 0.45
  const f = 0.006
  b.at(variant === 3 ? signBlank() : signPlateMat(), box(W, H, 0.008), 0, 0, 0)
  const flatShape = (shape: THREE.Shape, z = f) => {
    const g = new THREE.ShapeGeometry(shape)
    g.translate(0, 0, z)
    return g
  }
  const tri = (cx: number, cy: number, r: number) => {
    const s = new THREE.Shape()
    s.moveTo(cx, cy + r)
    s.lineTo(cx + r * 0.95, cy - r * 0.6)
    s.lineTo(cx - r * 0.95, cy - r * 0.6)
    s.closePath()
    return s
  }
  if (variant === 0) {
    b.at(signRed(), box(W - 0.02, 0.11, 0.004), 0, H / 2 - 0.065, f)
    b.add(signInk(), flatShape(tri(0, -0.04, 0.13)))
    b.at(signPlateMat(), box(0.02, 0.07, 0.004), 0, -0.035, f + 0.002)
    b.at(signPlateMat(), box(0.02, 0.02, 0.004), 0, -0.095, f + 0.002)
  } else if (variant === 1) {
    const d = new THREE.Shape()
    d.moveTo(0, 0.17)
    d.lineTo(0.17, 0)
    d.lineTo(0, -0.17)
    d.lineTo(-0.17, 0)
    d.closePath()
    b.add(signYellow(), flatShape(d))
    const bolt = new THREE.Shape()
    bolt.moveTo(0.02, 0.12)
    bolt.lineTo(-0.04, 0.0)
    bolt.lineTo(0.0, 0.0)
    bolt.lineTo(-0.025, -0.11)
    bolt.lineTo(0.05, 0.02)
    bolt.lineTo(0.005, 0.02)
    bolt.closePath()
    b.add(signInk(), flatShape(bolt, f + 0.002))
  } else if (variant === 2) {
    const ring = new THREE.RingGeometry(0.12, 0.15, 28)
    ring.translate(0, 0, f)
    b.add(signRed(), ring)
    b.at(signInk(), new THREE.CircleGeometry(0.025, 14), 0, 0.065, f + 0.001)
    b.at(signInk(), box(0.04, 0.1, 0.004), 0, -0.01, f + 0.001)
    b.at(signRed(), box(0.28, 0.026, 0.004), 0, 0, f + 0.003, 0, 0, -Math.PI / 4)
  }
  // Bolts and rust streaks running down from them.
  for (const x of [-W / 2 + 0.04, W / 2 - 0.04]) {
    b.at(signInk(), new THREE.CircleGeometry(0.009, 8), x, H / 2 - 0.04, f + 0.001)
    b.at(signRust(), box(0.012, 0.12 + Math.abs(x) * 0.3, 0.004), x, H / 2 - 0.1 - Math.abs(x) * 0.15, f)
  }
}

const signRust = () => flat(0x4a2414, 0.9)

/** The library's alpha-tested chain-link, double-sided. */
export function fenceMesh() {
  const m = material("chainlink")
  m.side = THREE.DoubleSide
  return m
}

/** Weathered, dark galvanised steel: posts and rails read as dark silhouettes against the lit fog (r3-01, r5-01). */
export const fenceSteel = () => materialFor("flat", { color: 0x23262a, color2: 0x3a342c, roughness: 0.6, roughness2: 0.85, metalness: 0.5, noise: { scale: 2, channel: 1, smooth: true } })

/** Oxidised barbed and razor wire: dark so the coil reads as a silhouette against the fog at 25–40 m. */
export const darkWire = () => materialFor("flat", { color: 0x1c1e1f, roughness: 0.5, metalness: 0.6 })
