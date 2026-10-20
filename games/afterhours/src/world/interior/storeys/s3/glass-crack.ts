import * as THREE from "three/webgpu"
import { decalBias } from "../../../../render/materials"

// An impact crack in plate glass, drawn once into a canvas (alpha only) and laid on a glass face as a lit decal: a
// crushed, chipped centre, jagged radial cracks that fork and taper, and broken concentric segments between them
// (never full rings). The material is lit (bright only where a lamp or the torch catches the fracture faces, dark
// otherwise), transparent, and pulled towards the camera with decalBias.

const PX = 1024

function rng(seed: number) {
  let s = seed * 7919 + 1
  return () => ((s = (s * 16807) % 2147483647) / 2147483647)
}

function drawCrack(seed: number) {
  const c = document.createElement("canvas")
  c.width = c.height = PX
  const g = c.getContext("2d")!
  const rnd = rng(seed)
  const C = PX / 2
  g.lineCap = "round"
  g.lineJoin = "round"
  // Jagged polyline from (x, y) along angle `a` for `len` px, tapering from `w`; forks now and then.
  const ends: [number, number, number][] = []
  const crack = (x: number, y: number, a: number, len: number, w: number, depth: number) => {
    let px = x
    let py = y
    let travelled = 0
    while (travelled < len) {
      const step = 8 + rnd() * 18
      a += (rnd() - 0.5) * 0.35
      const nx = px + Math.cos(a) * step
      const ny = py + Math.sin(a) * step
      const k = 1 - travelled / len
      g.strokeStyle = `rgba(255,255,255,${0.55 + 0.45 * k})`
      g.lineWidth = Math.max(1.6, w * k)
      g.beginPath()
      g.moveTo(px, py)
      g.lineTo(nx, ny)
      g.stroke()
      px = nx
      py = ny
      travelled += step
      if (depth < 2 && rnd() < 0.04) crack(px, py, a + (rnd() < 0.5 ? -1 : 1) * (0.35 + rnd() * 0.5), (len - travelled) * (0.3 + rnd() * 0.4), w * k * 0.7, depth + 1)
    }
    ends.push([px, py, a])
  }
  // Radials (uneven spacing and length).
  const radials: number[] = []
  let a0 = rnd() * Math.PI * 2
  for (let i = 0; i < 9; i++) {
    a0 += (Math.PI * 2) / 9 + (rnd() - 0.5) * 0.5
    radials.push(a0)
    crack(C + Math.cos(a0) * 10, C + Math.sin(a0) * 10, a0, 140 + rnd() * 330, 5, 0)
  }
  // Concentric segments: short jagged bridges between neighbouring radials at 2–3 radii, some missing.
  for (const r of [55 + rnd() * 15, 110 + rnd() * 30, 190 + rnd() * 40]) {
    for (let i = 0; i < radials.length; i++) {
      if (rnd() < 0.35) continue
      const ra = radials[i]!
      const rb = radials[(i + 1) % radials.length]!
      const span = (rb - ra + Math.PI * 4) % (Math.PI * 2)
      const rr = r * (0.85 + rnd() * 0.3)
      g.strokeStyle = `rgba(255,255,255,${0.45 + rnd() * 0.35})`
      g.lineWidth = 1.8 + rnd() * 1.4
      g.beginPath()
      const n = 6
      for (let k = 0; k <= n; k++) {
        const a = ra + (span * k) / n
        const rk = rr * (1 + (rnd() - 0.5) * 0.12)
        const x = C + Math.cos(a) * rk
        const y = C + Math.sin(a) * rk
        if (k === 0) g.moveTo(x, y)
        else g.lineTo(x, y)
      }
      g.stroke()
    }
  }
  // Crushed centre: chips (small irregular flakes, brighter) and a frosted spot.
  const grd = g.createRadialGradient(C, C, 0, C, C, 34)
  grd.addColorStop(0, "rgba(255,255,255,0.55)")
  grd.addColorStop(1, "rgba(255,255,255,0)")
  g.fillStyle = grd
  g.fillRect(C - 40, C - 40, 80, 80)
  for (let i = 0; i < 40; i++) {
    const a = rnd() * Math.PI * 2
    const r = rnd() ** 2 * 40
    const x = C + Math.cos(a) * r
    const y = C + Math.sin(a) * r
    g.fillStyle = `rgba(255,255,255,${0.3 + rnd() * 0.5})`
    g.beginPath()
    const s = 1.5 + rnd() * 4
    g.moveTo(x, y - s)
    g.lineTo(x + s * rnd(), y + s * 0.6)
    g.lineTo(x - s * rnd(), y + s * 0.4)
    g.closePath()
    g.fill()
  }
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 8
  return t
}

let mat: THREE.Material | null = null

/** A crack `size` m across, facing +Z, centred on its origin. */
export function glassCrack(size: number, seed: number) {
  if (!mat) {
    const m = new THREE.MeshStandardNodeMaterial({ map: drawCrack(seed), color: 0xf2f6f6, roughness: 0.25, metalness: 0, transparent: true, depthWrite: false, opacity: 1, emissive: 0x2a2e2e })
    decalBias(m, 2)
    m.name = "interior_glass_crack"
    mat = m
  }
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat)
  mesh.name = "glass-crack"
  mesh.renderOrder = 3
  return mesh
}
