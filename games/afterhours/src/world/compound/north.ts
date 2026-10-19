import * as THREE from "three/webgpu"
import type { WorldContext } from "../context"
import { heightAt } from "../height"
import { FENCE, NORTH_GATE, NORTH_TRACK, northTrackSamples } from "../layout"
import { material } from "../../render/materials"
import { Batch, box, cyl, matrix, rod } from "./geo"
import { flat, glow } from "./mats"
import { darkWire, fenceMesh, fenceSteel } from "./fence"

// The north gate and the track out to the north array site. A 3.6 m double swing gate in the north fence (both leaves
// on the shared door system, swinging out into the woods), found standing open with its chain hanging loose and the
// padlock open on the hasp; a magstripe keycard reader on the east post; a restricted-area sign; and a gravel track
// from the dock court through the gate to a turnaround in the trees where the array will go.

const H = 2.05
const BARB = 0.4

export function buildNorth(ctx: WorldContext, root: THREE.Object3D) {
  track(root)
  gate(ctx, root)
}

/** Gravel track: a dirt verge ribbon under a narrower gravel ribbon, both draped on the terrain with ragged edges. */
function track(root: THREE.Object3D) {
  const pts = northTrackSamples(0.5)
  const ribbon = (half: number, lift: number, seed: number, endFlare: number) => {
    const pos: number[] = []
    const uv: number[] = []
    const idx: number[] = []
    const across = 6
    let s = 0
    for (let i = 0; i < pts.length; i++) {
      const [x, z] = pts[i]!
      const [nx, nz] = pts[Math.min(i + 1, pts.length - 1)]!
      const [px, pz] = pts[Math.max(i - 1, 0)]!
      const tx = nx - px
      const tz = nz - pz
      const tl = Math.hypot(tx, tz) || 1
      const ox = -tz / tl
      const oz = tx / tl
      if (i > 0) s += Math.hypot(x - px, z - pz) / 2
      // Turnaround at the end: the last 8 m widen into a rough pad.
      const fromEnd = (pts.length - 1 - i) * 0.5
      const flare = endFlare * Math.max(0, 1 - fromEnd / 8)
      const jl = 0.18 * Math.sin(s * 0.9 + seed) + 0.12 * Math.sin(s * 2.3 + seed * 2)
      const jr = 0.18 * Math.sin(s * 0.7 + seed * 3) + 0.12 * Math.sin(s * 2.9 + seed)
      for (let k = 0; k <= across; k++) {
        const u = -1 + (2 * k) / across
        const w = u < 0 ? (half + flare + jl) * u : (half + flare + jr) * u
        const vx = x + ox * w
        const vz = z + oz * w
        // Slight crown; the edges sit lower, tucked into the ground.
        const crown = (1 - u * u) * 0.03
        pos.push(vx, heightAt(vx, vz) + lift + crown, vz)
        uv.push(w, s)
      }
      if (i > 0) {
        const a = (i - 1) * (across + 1)
        const b = i * (across + 1)
        for (let k = 0; k < across; k++) idx.push(a + k, b + k, a + k + 1, a + k + 1, b + k, b + k + 1)
      }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3))
    g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2))
    g.setIndex(idx)
    g.computeVertexNormals()
    // Winding depends on the track's direction; make sure the ribbon faces up.
    if (g.attributes.normal!.getY(Math.floor(g.attributes.normal!.count / 2)) < 0) {
      for (let i = 0; i < idx.length; i += 3) [idx[i + 1], idx[i + 2]] = [idx[i + 2]!, idx[i + 1]!]
      g.setIndex(idx)
      g.computeVertexNormals()
    }
    return g
  }
  const b = new Batch()
  b.add(material("dirt"), ribbon(NORTH_TRACK.width / 2 + 0.8, 0.03, 1, 3))
  b.add(material("gravel"), ribbon(NORTH_TRACK.width / 2, 0.055, 4, 2.5))
  b.build(root, { castShadow: false, receiveShadow: true, name: "north-track" })
}

function gate(ctx: WorldContext, root: THREE.Object3D) {
  const steel = fenceSteel()
  const wire = darkWire()
  const dark = material("metal_dark")
  const z = FENCE.min[1]
  const { x0, x1 } = NORTH_GATE
  const L = (x1 - x0) / 2 - 0.1

  // Heavier gate posts with caps and footings.
  const s = new Batch()
  for (const hx of [x0, x1]) {
    const y = heightAt(hx, z)
    s.at(steel, cyl(0.07, 0.07, FENCE.height + 0.6, 12), hx, y + (FENCE.height + 0.6) / 2 - 0.3, z)
    s.at(steel, new THREE.SphereGeometry(0.08, 12, 6), hx, y + FENCE.height + 0.32, z)
    s.at(material("concrete_dark"), cyl(0.22, 0.24, 0.12, 12), hx, y + 0.04, z)
  }

  // Keycard reader on the east post's inside face: weatherproof housing, swipe slot, a red LED still lit.
  const ry = heightAt(x1, z) + 1.15
  const rz = z + 0.09
  s.at(flat(0x3a3c36, 0.5, 0.3), box(0.11, 0.17, 0.05), x1 + 0.0, ry, rz)
  s.at(flat(0x3a3c36, 0.5, 0.3), box(0.13, 0.025, 0.07), x1 + 0.0, ry + 0.095, rz + 0.01)
  s.at(flat(0x0c0c0c, 0.6), box(0.012, 0.11, 0.004), x1 + 0.03, ry - 0.01, rz + 0.026)
  s.at(glow(1, 0.05, 0.02, 6), new THREE.SphereGeometry(0.005, 8, 6), x1 - 0.03, ry + 0.06, rz + 0.026)
  s.add(material("metal_galvanized"), rod({ x: x1, y: ry - 0.085, z: rz - 0.01 }, { x: x1, y: heightAt(x1, z) + 0.02, z: rz - 0.01 }, 0.009, 6))

  // Restricted-area sign on the fence just east of the gate, facing the compound (and a back plate).
  const sx = x1 + 1.6
  const sy = heightAt(sx, z) + 1.55
  const sign = new THREE.PlaneGeometry(0.9, 0.6)
  s.add(signMaterial(), sign, matrix(sx, sy, z + 0.03))
  s.at(material("metal_painted"), box(0.92, 0.62, 0.006), sx, sy, z + 0.024)
  for (const dx of [-0.42, 0.42]) for (const dy of [-0.27, 0.27]) s.at(dark, cyl(0.008, 0.008, 0.02, 8), sx + dx, sy + dy, z + 0.025, 0, Math.PI / 2)
  s.build(root, { castShadow: true, name: "north-gate-static" })

  // Two leaves swinging north (out into the woods); both found standing open, the east one not quite all the way.
  const leaves = [
    { id: "north-gate-w", partner: "north-gate-e", hx: x0, width: L + 0.1, angle: (95 * Math.PI) / 180, open: 1 },
    { id: "north-gate-e", partner: "north-gate-w", hx: x1, width: -(L + 0.1), angle: (-95 * Math.PI) / 180, open: 0.82 },
  ]
  for (const spec of leaves) {
    const leaf = new THREE.Group()
    leaf.name = spec.id
    const lb = new Batch()
    const lm = new Batch()
    const sg = Math.sign(spec.width)
    const m = matrix(0, 0, 0, sg > 0 ? 0 : Math.PI)
    const b = lb.child(m)
    const mb = lm.child(m)
    const a0 = 0.1
    const a1 = a0 + L
    const y0 = 0.12
    const v = (x: number, y: number) => new THREE.Vector3(x, y, 0)
    for (const [p, q] of [
      [v(a0, y0), v(a1, y0)],
      [v(a0, H), v(a1, H)],
      [v(a0, y0), v(a0, H)],
      [v(a1, y0), v(a1, H)],
      [v(a0, (y0 + H) / 2), v(a1, (y0 + H) / 2)],
      [v(a0, y0), v(a1, (y0 + H) / 2)],
    ] as const)
      b.add(steel, rod(p, q, 0.022, 8))
    for (const x of [a0, a1]) b.add(steel, rod(v(x, H), v(x, H + BARB), 0.012, 6))
    for (const y of [0.13, 0.26, 0.4]) b.add(wire, rod(v(a0, H + y), v(a1, H + y), 0.005, 4))
    for (const y of [0.35, H - 0.3]) b.at(dark, cyl(0.05, 0.05, 0.1, 12), 0, y, 0)
    const panel = new THREE.PlaneGeometry(L, H - y0)
    const uv = panel.attributes.uv!
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * L, uv.getY(i) * (H - y0))
    mb.at(fenceMesh(), panel, (a0 + a1) / 2, (y0 + H) / 2, 0)
    if (sg > 0) {
      // Drop rod lifted out of its ground socket and pinned up.
      b.add(steel, rod(v(a1 - 0.12, 0.35), v(a1 - 0.12, 1.25), 0.01, 6))
    } else {
      // Chain hanging loose from the latch stile, the open padlock still hooked through the last link.
      chain(b, a1 + 0.01, 1.05)
    }
    lb.build(leaf, { castShadow: (mat) => mat === steel, name: spec.id })
    for (const mesh of lm.build(leaf, { name: `${spec.id}-mesh`, receiveShadow: false })) mesh.renderOrder = 1
    root.add(leaf)
    ctx.doors.add({
      id: spec.id,
      leaf,
      hinge: [spec.hx, heightAt(spec.hx, z), z],
      width: spec.width,
      height: H + BARB,
      thickness: 0.05,
      openAngle: spec.angle,
      // Found standing open to the north; once closed, they open away from whoever pushes (both sides are clear).
      swing: "auto",
      startOpen: spec.open,
      double: spec.partner,
      sound: "gate",
    })
  }
}

/** A loose chain draped from (x, y) on a leaf's latch stile, links alternating 90°, ending in an open padlock. */
function chain(b: Batch, x: number, y: number) {
  const steel = material("metal_galvanized")
  const link = () => new THREE.TorusGeometry(0.016, 0.0045, 6, 12)
  // Wrapped twice round the stile...
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * Math.PI * 4
    b.add(steel, link(), matrix(x + Math.cos(a) * 0.035, y + k * 0.008, Math.sin(a) * 0.035, a + Math.PI / 2, k % 2 ? Math.PI / 2 : 0))
  }
  // ...then hanging straight down with a slight kick away from the leaf.
  let py = y - 0.02
  for (let k = 0; k < 16; k++) {
    b.add(steel, link(), matrix(x + 0.04 + k * 0.0015, py, 0.03, 0, Math.PI / 2, k % 2 ? Math.PI / 2 : 0))
    py -= 0.027
  }
  // Open padlock: brass body, shackle swung out.
  const brass = flat(0x7a5a24, 0.35, 0.8)
  b.at(brass, box(0.04, 0.05, 0.018), x + 0.065, py - 0.03, 0.03)
  const shackle = new THREE.TorusGeometry(0.014, 0.004, 6, 14, Math.PI)
  b.add(material("chrome"), shackle, matrix(x + 0.072, py + 0.004, 0.03, 0.9))
}

let signMat: THREE.MeshStandardNodeMaterial | null = null
/** Enamel sign with stencilled text (the one canvas texture in the compound; one extra shader). */
function signMaterial() {
  if (signMat) return signMat
  const W = 768
  const Hh = 512
  const c = document.createElement("canvas")
  c.width = W
  c.height = Hh
  const g = c.getContext("2d")!
  g.fillStyle = "#d8d2bf"
  g.fillRect(0, 0, W, Hh)
  g.fillStyle = "#8c1d14"
  g.fillRect(0, 0, W, 150)
  g.fillStyle = "#efe8d6"
  g.font = "bold 108px Helvetica, Arial, sans-serif"
  g.textAlign = "center"
  g.textBaseline = "middle"
  g.fillText("RESTRICTED", W / 2, 80)
  g.fillStyle = "#1b1b18"
  g.font = "bold 76px Helvetica, Arial, sans-serif"
  g.fillText("NORTH ARRAY", W / 2, 228)
  g.font = "bold 46px Helvetica, Arial, sans-serif"
  g.fillText("FIELD KEYCARD REQUIRED", W / 2, 330)
  g.font = "28px Helvetica, Arial, sans-serif"
  g.fillText("AUTHORIZED PERSONNEL ONLY · IOPS", W / 2, 420)
  g.strokeStyle = "#1b1b18"
  g.lineWidth = 8
  g.strokeRect(14, 14, W - 28, Hh - 28)
  // Weathering: rust bloom at the bolt holes and edges, streaks, a dulling film.
  let seed = 19
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  for (let i = 0; i < 420; i++) {
    const edge = rnd() < 0.6
    const x = edge ? (rnd() < 0.5 ? rnd() * 60 : W - rnd() * 60) : rnd() * W
    const y = edge ? rnd() * Hh : rnd() < 0.5 ? rnd() * 40 : Hh - rnd() * 40
    g.fillStyle = `rgba(${100 + rnd() * 40},${48 + rnd() * 20},20,${0.05 + rnd() * 0.25})`
    g.beginPath()
    g.arc(x, y, 1 + rnd() * 7, 0, Math.PI * 2)
    g.fill()
  }
  for (const [bx, by] of [
    [38, 38],
    [W - 38, 38],
    [38, Hh - 38],
    [W - 38, Hh - 38],
  ]) {
    const grad = g.createLinearGradient(0, by, 0, by + 160)
    grad.addColorStop(0, "rgba(110,52,20,0.7)")
    grad.addColorStop(1, "rgba(110,52,20,0)")
    g.fillStyle = grad
    g.fillRect(bx! - 5, by!, 10 + rnd() * 6, 160)
  }
  g.fillStyle = "rgba(40,44,36,0.18)"
  g.fillRect(0, 0, W, Hh)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  signMat = new THREE.MeshStandardNodeMaterial({ map: tex, roughness: 0.7, metalness: 0.1 })
  signMat.name = "compound_north_sign"
  return signMat
}
