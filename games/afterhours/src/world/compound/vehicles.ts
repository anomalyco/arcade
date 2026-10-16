import * as THREE from "three/webgpu"
import type { WorldContext } from "../context"
import { material } from "../../render/materials"
import { Batch, box, cyl, extrudeSide, matrix, rod, sideShape } from "./geo"
import { carGlass, flat, paint, wood } from "./mats"

// Period cars built from side-profile extrusions: a wood-panelled early-80s full-size station wagon (the hero from
// the concept), a two-door coupe with a vinyl roof and a square-body pickup. Local frame: +X forward, Y up, Z across.

type Arch = { x: number; y: number; r: number }

const glassMat = () => carGlass()
const chrome = () => material("chrome")
const rubber = () => material("rubber")
const headlight = () => flat(0x9ca29c, 0.12, 0.6)
const taillight = () => flat(0x4a0806, 0.28, 0)
const amber = () => flat(0x5a3008, 0.3, 0)

function wheels(b: Batch, axles: number[], r: number, track: number) {
  for (const ax of axles) {
    for (const s of [-1, 1]) {
      b.at(rubber(), cyl(r, r, 0.21, 18), ax, r, s * track, 0, Math.PI / 2)
      b.at(chrome(), cyl(r * 0.58, r * 0.6, 0.03, 14), ax, r, s * (track + 0.1), 0, Math.PI / 2)
      b.at(material("metal_dark"), cyl(r * 0.12, r * 0.12, 0.04, 8), ax, r, s * (track + 0.115), 0, Math.PI / 2)
    }
  }
}

function wheelWells(b: Batch, arches: Arch[], width: number) {
  for (const a of arches) b.at(rubber(), box(a.r * 2 - 0.02, a.r - 0.05, width - 0.32), a.x, a.y + (a.r - 0.05) / 2 + 0.02, 0)
}

/** Pillar strip on both sides of the greenhouse from (xa, ya) to (xb, yb). */
function pillar(b: Batch, mat: THREE.Material, xa: number, ya: number, xb: number, yb: number, halfW: number, thick = 0.07) {
  for (const s of [-1, 1]) b.add(mat, rod({ x: xa, y: ya, z: s * halfW }, { x: xb, y: yb, z: s * halfW }, thick / 2, 4))
}

function frontEnd(b: Batch, x: number, W: number, y: number, quad: boolean) {
  b.at(material("metal_dark"), box(0.03, 0.26, W * 0.62), x, y, 0)
  for (let k = -3; k <= 3; k++) b.at(chrome(), box(0.035, 0.24, 0.012), x + 0.005, y, k * W * 0.085)
  b.at(chrome(), box(0.04, 0.03, W * 0.64), x + 0.005, y + 0.14, 0)
  b.at(chrome(), box(0.04, 0.03, W * 0.64), x + 0.005, y - 0.14, 0)
  for (const s of [-1, 1]) {
    if (quad) {
      b.at(headlight(), box(0.03, 0.1, 0.2), x, y + 0.065, s * W * 0.39)
      b.at(headlight(), box(0.03, 0.1, 0.2), x, y - 0.065, s * W * 0.39)
    } else b.at(headlight(), box(0.03, 0.17, 0.24), x, y, s * W * 0.39)
    b.at(chrome(), box(0.035, 0.27, 0.27), x - 0.006, y, s * W * 0.39)
    b.at(amber(), box(0.04, 0.06, 0.2), x - 0.02, y - 0.22, s * W * 0.36)
  }
}

function bumpers(b: Batch, front: number, rear: number, W: number, y: number) {
  for (const x of [front, rear]) {
    b.at(chrome(), box(0.16, 0.17, W + 0.04), x, y, 0)
    b.at(rubber(), box(0.17, 0.035, W + 0.05), x, y + 0.02, 0)
  }
}

function mirrors(b: Batch, x: number, y: number, halfW: number, mat: THREE.Material) {
  for (const s of [-1, 1]) {
    b.at(mat, box(0.05, 0.05, 0.1), x, y, s * (halfW + 0.05))
    b.at(chrome(), box(0.06, 0.1, 0.13), x - 0.02, y + 0.06, s * (halfW + 0.12))
  }
}

/** Early-80s full-size wagon with simulated wood-grain sides, chrome trim and a roof rack. */
export function wagon(b: Batch, bodyMat: THREE.Material) {
  const L = 5.45
  const W = 1.96
  const r = 0.34
  const fa = 1.675
  const ra = -1.275
  const arches: Arch[] = [
    { x: fa, y: r, r: 0.44 },
    { x: ra, y: r, r: 0.44 },
  ]
  const x1 = L / 2
  const x0 = -L / 2
  const body = sideShape(x0, x1, 0.27, [
    [x1, 0.44],
    [x1 + 0.02, 0.84],
    [x1 - 0.07, 0.93],
    [0.95, 0.985],
    [x0 + 0.05, 1.0],
    [x0, 0.93],
    [x0, 0.42],
  ], arches)
  b.add(bodyMat, extrudeSide(body, W, 0.05))
  wheelWells(b, arches, W)
  b.at(material("metal_dark"), box(L - 0.6, 0.12, W - 0.35), 0, 0.3, 0)

  // Greenhouse: one glass volume with painted pillars, roof skin and chrome drip rails over it.
  const gx0 = x0 + 0.07
  const gW = W - 0.17
  const green = sideShape(gx0, 0.95, 0.97, [
    [0.22, 1.44],
    [x0 + 0.17, 1.46],
    [gx0, 1.4],
  ])
  b.add(glassMat(), extrudeSide(green, gW, 0.03, 4))
  b.at(bodyMat, box(0.22 - gx0 - 0.12, 0.05, gW + 0.02), (0.22 + gx0 + 0.12) / 2 - 0.02, 1.465, 0)
  const hw = gW / 2 + 0.006
  pillar(b, bodyMat, 0.94, 0.99, 0.21, 1.445, hw)
  pillar(b, bodyMat, -0.42, 0.99, -0.4, 1.455, hw, 0.09)
  pillar(b, bodyMat, -1.55, 0.99, -1.55, 1.46, hw, 0.08)
  pillar(b, bodyMat, gx0 + 0.07, 0.99, gx0 + 0.1, 1.43, hw, 0.13)
  for (const s of [-1, 1]) {
    b.at(chrome(), box(0.22 - gx0, 0.02, 0.02), (0.22 + gx0) / 2, 1.445, s * (hw + 0.004))
    b.at(chrome(), box(0.95 - gx0, 0.02, 0.015), (0.95 + gx0) / 2, 0.99, s * (hw + 0.004))
  }
  // Windshield and tailgate frames.
  b.add(chrome(), rod({ x: 0.95, y: 0.98, z: -hw }, { x: 0.95, y: 0.98, z: hw }, 0.012, 4))
  b.add(bodyMat, rod({ x: 0.22, y: 1.445, z: -hw }, { x: 0.22, y: 1.445, z: hw }, 0.03, 4))
  // Roof rack rails on stanchions.
  for (const s of [-1, 1]) {
    b.add(chrome(), rod({ x: -2.35, y: 1.55, z: s * 0.66 }, { x: -0.1, y: 1.55, z: s * 0.66 }, 0.014, 5))
    for (const x of [-2.3, -1.2, -0.15]) b.at(chrome(), box(0.06, 0.08, 0.04), x, 1.51, s * 0.66)
  }
  b.add(chrome(), rod({ x: -1.6, y: 1.55, z: -0.66 }, { x: -1.6, y: 1.55, z: 0.66 }, 0.012, 4))

  // Wood-grain side panels framed with chrome, and the tailgate panel.
  const grain = wood(0x4a2c16, 0x8a5a30, 0.42)
  const panel = sideShape(x0 + 0.1, x1 - 0.18, 0.5, [
    [x1 - 0.18, 0.86],
    [x0 + 0.1, 0.86],
  ], arches.map((a) => ({ ...a, r: 0.48 })))
  for (const s of [-1, 1]) {
    const g = extrudeSide(panel, 0.01, 0, 10)
    b.add(grain, g, matrix(0, 0, s * (W / 2 + 0.006)))
    b.at(chrome(), box(L - 0.28, 0.025, 0.014), -0.04, 0.875, s * (W / 2 + 0.01))
    b.at(chrome(), box(0.6, 0.02, 0.012), 0.2, 0.49, s * (W / 2 + 0.01))
  }
  b.at(grain, box(0.012, 0.32, 1.5), x0 - 0.008, 0.68, 0)
  b.at(chrome(), box(0.016, 0.02, 1.54), x0 - 0.01, 0.85, 0)
  b.at(flat(0xa8a088, 0.7), box(0.012, 0.15, 0.3), x0 - 0.012, 0.6, 0)
  for (const s of [-1, 1]) b.at(taillight(), box(0.03, 0.34, 0.2), x0 - 0.005, 0.7, s * 0.85)

  frontEnd(b, x1 + 0.075, W, 0.68, true)
  bumpers(b, x1 + 0.13, x0 - 0.1, W, 0.43)
  mirrors(b, 0.85, 1.02, W / 2, bodyMat)
  wheels(b, [fa, ra], r, W / 2 - 0.17)
  return { L, W }
}

/** Two-door coupe with a padded vinyl landau roof. */
export function coupe(b: Batch, bodyMat: THREE.Material) {
  const L = 5.0
  const W = 1.86
  const r = 0.33
  const fa = 1.5
  const ra = -1.3
  const arches: Arch[] = [
    { x: fa, y: r, r: 0.43 },
    { x: ra, y: r, r: 0.43 },
  ]
  const x1 = L / 2
  const x0 = -L / 2
  const body = sideShape(x0, x1, 0.27, [
    [x1, 0.45],
    [x1 + 0.02, 0.82],
    [x1 - 0.08, 0.9],
    [0.8, 0.96],
    [-1.75, 0.99],
    [x0 + 0.04, 0.97],
    [x0, 0.9],
    [x0, 0.42],
  ], arches)
  b.add(bodyMat, extrudeSide(body, W, 0.05))
  wheelWells(b, arches, W)
  b.at(material("metal_dark"), box(L - 0.6, 0.12, W - 0.35), 0, 0.3, 0)
  const gW = W - 0.2
  const green = sideShape(-1.78, 0.82, 0.95, [
    [0.1, 1.37],
    [-1.05, 1.39],
  ])
  b.add(glassMat(), extrudeSide(green, gW, 0.03, 4))
  // Vinyl landau roof over the rear half with an opera window cut by the wide C pillar.
  const vinyl = flat(0x2a2620, 0.8)
  b.at(vinyl, box(1.2, 0.04, gW + 0.03), -0.45, 1.395, 0)
  const hw = gW / 2 + 0.006
  pillar(b, bodyMat, 0.8, 0.97, 0.1, 1.37, hw)
  pillar(b, vinyl, -1.05, 1.385, -1.72, 0.98, hw, 0.12)
  for (const s of [-1, 1]) {
    b.add(vinyl, new THREE.PlaneGeometry(0.42, 0.34), matrix(-1.15, 1.15, s * (hw + 0.01), s > 0 ? 0 : Math.PI))
    b.at(chrome(), box(2.55, 0.02, 0.015), -0.48, 0.97, s * (hw + 0.004))
    b.at(chrome(), box(L - 0.3, 0.03, 0.012), 0, 0.62, s * (W / 2 + 0.006))
  }
  for (const s of [-1, 1]) b.at(taillight(), box(0.03, 0.16, 0.6), x0 - 0.005, 0.72, s * 0.55)
  b.at(flat(0xa8a088, 0.7), box(0.012, 0.15, 0.3), x0 - 0.012, 0.58, 0)
  frontEnd(b, x1 + 0.075, W, 0.66, true)
  bumpers(b, x1 + 0.13, x0 - 0.1, W, 0.42)
  mirrors(b, 0.7, 1.0, W / 2, bodyMat)
  wheels(b, [fa, ra], r, W / 2 - 0.16)
  return { L, W }
}

/** Square-body full-size pickup. */
export function pickup(b: Batch, bodyMat: THREE.Material) {
  const L = 5.15
  const W = 2.0
  const r = 0.37
  const fa = 1.6
  const ra = -1.6
  const x1 = L / 2
  const x0 = -L / 2
  const front: Arch = { x: fa, y: r, r: 0.47 }
  const rear: Arch = { x: ra, y: r, r: 0.47 }
  const cab = sideShape(0.02, x1, 0.36, [
    [x1, 0.55],
    [x1 + 0.02, 0.98],
    [x1 - 0.06, 1.06],
    [1.15, 1.1],
    [0.02, 1.1],
  ], [front])
  b.add(bodyMat, extrudeSide(cab, W, 0.04))
  wheelWells(b, [front, rear], W)
  b.at(material("metal_dark"), box(L - 0.6, 0.16, W - 0.5), 0, 0.42, 0)
  const gW = W - 0.18
  const green = sideShape(0.06, 1.15, 1.08, [
    [0.7, 1.78],
    [0.1, 1.79],
  ])
  b.add(glassMat(), extrudeSide(green, gW, 0.03, 4))
  b.at(bodyMat, box(0.66, 0.05, gW + 0.03), 0.4, 1.79, 0)
  const hw = gW / 2 + 0.006
  pillar(b, bodyMat, 1.14, 1.1, 0.68, 1.77, hw)
  pillar(b, bodyMat, 0.12, 1.1, 0.12, 1.78, hw, 0.14)
  // Bed: two side walls with the rear arch, floor, front wall, tailgate and rail caps.
  const bedSide = sideShape(x0, -0.02, 0.4, [
    [-0.02, 1.08],
    [x0, 1.08],
  ], [rear])
  for (const s of [-1, 1]) {
    b.add(bodyMat, extrudeSide(bedSide, 0.07, 0.015, 8), matrix(0, 0, s * (W / 2 - 0.035)))
    b.at(bodyMat, box(-x0 - 0.04, 0.03, 0.14), x0 / 2, 1.09, s * (W / 2 - 0.05))
    b.at(chrome(), box(-x0 - 0.1, 0.02, 0.012), x0 / 2, 0.82, s * (W / 2 + 0.003))
    b.at(taillight(), box(0.03, 0.3, 0.14), x0 - 0.005, 0.86, s * (W / 2 - 0.1))
  }
  b.at(material("metal_dark"), box(-x0 - 0.1, 0.04, W - 0.14), x0 / 2, 0.66, 0)
  b.at(bodyMat, box(0.06, 0.45, W - 0.1), -0.04, 0.87, 0)
  b.at(bodyMat, box(0.06, 0.62, W - 0.1), x0 + 0.03, 0.79, 0)
  b.at(flat(0xa8a088, 0.7), box(0.012, 0.15, 0.3), x0 - 0.012, 0.52, 0)
  frontEnd(b, x1 + 0.075, W, 0.78, false)
  bumpers(b, x1 + 0.13, x0 - 0.1, W, 0.5)
  mirrors(b, 1.05, 1.15, W / 2, chrome())
  wheels(b, [fa, ra], r, W / 2 - 0.17)
  return { L, W }
}

export type Parked = { kind: "wagon" | "coupe" | "pickup"; x: number; z: number; heading: number; paint: number | "library" }

export function buildVehicles(ctx: WorldContext, root: THREE.Object3D, cars: Parked[]) {
  const batch = new Batch()
  for (const car of cars) {
    const mat = car.paint === "library" ? material("car_paint") : paint(car.paint)
    const b = batch.child(matrix(car.x, 0.04, car.z, -car.heading))
    const { L, W } = car.kind === "wagon" ? wagon(b, mat) : car.kind === "coupe" ? coupe(b, mat) : pickup(b, mat)
    // Axis-aligned collider around the rotated footprint.
    const c = Math.abs(Math.cos(car.heading))
    const s = Math.abs(Math.sin(car.heading))
    const hx = (L / 2 + 0.1) * c + (W / 2) * s
    const hz = (L / 2 + 0.1) * s + (W / 2) * c
    ctx.colliders.push({ min: [car.x - hx, 0, car.z - hz], max: [car.x + hx, 1.5, car.z + hz] })
  }
  batch.build(root, { castShadow: true, name: "cars" })
}
