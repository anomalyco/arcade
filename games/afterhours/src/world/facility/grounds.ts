import * as THREE from "three/webgpu"
import { BUILDING } from "../layout"
import type { WorldContext } from "../context"
import { Batch, SKIP_BOTTOM, rng, type Mat } from "./geo"
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js"
import { PLATFORM } from "./dock"
import { material, materialFor } from "../../render/materials"
import { ANNEX_TOP } from "./shell"

// The ground right around the building: concrete walks and the truck court, the entrance walk to the car park,
// planting beds with clipped shrubs, ground-mounted plant (condensers, a standby generator), utility meters, a
// fenced transformer pad, and puddles where the pavement dips.

const MAIN = BUILDING.main
const ANNEX = BUILDING.annex

export function buildGrounds(ctx: WorldContext, b: Batch, root: THREE.Object3D) {
  const rand = rng(4242)
  const walk = 2.2
  const y = 0.03
  // Perimeter walks (thin slabs just proud of the terrain).
  b.box("concrete_floor", MAIN.min[0] - walk, -0.1, MAIN.max[1], ANNEX.min[0] + 0.01, y, MAIN.max[1] + walk, SKIP_BOTTOM)
  b.box("concrete_floor", MAIN.min[0] - walk, -0.1, MAIN.min[1] - walk, MAIN.min[0], y, MAIN.max[1], SKIP_BOTTOM)
  b.box("concrete_floor", MAIN.min[0], -0.1, MAIN.min[1] - walk, PLATFORM.x0 - 5, y, MAIN.min[1], SKIP_BOTTOM)
  b.box("concrete_floor", PLATFORM.x1 + 6, -0.1, MAIN.min[1] - walk, ANNEX.min[0], y, MAIN.min[1], SKIP_BOTTOM)
  b.box("concrete_floor", ANNEX.min[0] - walk, -0.1, ANNEX.min[1] - walk, ANNEX.max[0] + walk, y, ANNEX.min[1], SKIP_BOTTOM)
  b.box("concrete_floor", ANNEX.min[0] - walk, -0.1, ANNEX.min[1], ANNEX.min[0], y, MAIN.min[1] - walk, SKIP_BOTTOM)
  b.box("concrete_floor", ANNEX.max[0], -0.1, ANNEX.min[1], ANNEX.max[0] + walk, y, ANNEX.max[1] + walk, SKIP_BOTTOM)
  b.box("concrete_floor", ANNEX.min[0], -0.1, ANNEX.max[1], ANNEX.max[0], y, ANNEX.max[1] + walk, SKIP_BOTTOM)
  b.box("concrete_floor", MAIN.max[0], -0.1, ANNEX.max[1] + walk, MAIN.max[0] + walk, y, MAIN.max[1] + walk, SKIP_BOTTOM)
  // Truck court behind the dock.
  b.box("concrete_floor", PLATFORM.x0 - 5, -0.1, MAIN.min[1] - BUILDING.dock.depth - 12, PLATFORM.x1 + 6, 0.02, MAIN.min[1], SKIP_BOTTOM)
  // Expansion joints scored across the court.
  for (let z = MAIN.min[1] - 4; z > MAIN.min[1] - BUILDING.dock.depth - 12; z -= 4.5) {
    b.box("concrete_dark", PLATFORM.x0 - 5, 0.02, z - 0.02, PLATFORM.x1 + 6, 0.024, z + 0.02)
  }
  // Entrance walk from the canopy to the car park.
  b.box("concrete_floor", -2.6, -0.1, MAIN.max[1] + walk, 2.6, y, BUILDING.entrance.z + 16, SKIP_BOTTOM)
  for (let z = MAIN.max[1] + 7; z < BUILDING.entrance.z + 16; z += 2.6) b.box("concrete_dark", -2.6, y, z - 0.015, 2.6, y + 0.003, z + 0.015)

  // Planting beds with clipped junipers either side of the entrance, curbed.
  const beds: [number, number][] = [[-30, -9.5], [9.5, 30]]
  const shrubGeo = shrubGeometry()
  for (const [x0, x1] of beds) {
    const z0 = MAIN.max[1] + walk
    const z1 = z0 + 1.8
    b.box("concrete_dark", x0, -0.1, z1, x1, 0.18, z1 + 0.15, SKIP_BOTTOM)
    b.box("concrete_dark", x0 - 0.15, -0.1, z0, x0, 0.18, z1 + 0.15, SKIP_BOTTOM)
    b.box("concrete_dark", x1, -0.1, z0, x1 + 0.15, 0.18, z1 + 0.15, SKIP_BOTTOM)
    b.box("dirt", x0, -0.1, z0, x1, 0.1, z1, SKIP_BOTTOM)
    for (let x = x0 + 0.9; x < x1 - 0.5; x += 1.5 + rand() * 0.8) {
      if (rand() < 0.12) continue
      const s = 0.7 + rand() * 0.45
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3(x, 0.1, z0 + 0.9 + (rand() - 0.5) * 0.3),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rand() * 6.28, 0)),
        new THREE.Vector3(s * (1 + rand() * 0.3), s * (0.75 + rand() * 0.3), s),
      )
      b.add("pine_needles", shrubGeo, m, 1, true)
    }
  }
  // A couple of overgrown shrubs at the west end and by the annex.
  for (const [x, z, s] of [[-57.5, 18, 1.4], [-57.8, 10, 1.1], [64.5, 2, 1.3], [-57.6, -14, 1.2]] as const) {
    const m = new THREE.Matrix4().compose(new THREE.Vector3(x, 0, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, x, 0)), new THREE.Vector3(s, s * 1.1, s))
    b.add("pine_needles", shrubGeo, m, 1, true)
  }

  // Condenser pad by the west wall (the units themselves are ac_unit models from props.ts).
  for (const z of [3.5, 6.5]) {
    const x = MAIN.min[0] - 2.6
    b.box("concrete_dark", x - 0.8, 0, z - 1.0, x + 0.8, 0.15, z + 1.0)
    b.box("metal_galvanized", MAIN.min[0] - 0.12, 0.4, z - 0.05, x - 0.45, 0.48, z + 0.05)
  }

  standbyGenerator(ctx, b, ANNEX.max[0] + 5.5, -16)

  // Conduit risers for the utility cabinets on the annex east wall (cabinets are utility_box models from props.ts):
  // round galvanised conduit with LB fittings where they turn into the wall.
  {
    const x = ANNEX.max[0] + 0.07
    for (const z of [-22.2, -21.4, -20.2]) {
      b.cylinder("metal_galvanized", x, 0, z, 0.027, 0.4, 12)
      b.cylinder("metal_galvanized", x, 0.36, z, 0.034, 0.04, 12)
    }
    b.cylinder("metal_galvanized", x, 1.55, -21.4, 0.032, ANNEX_TOP - 1.55 - 0.25, 12)
    lbFitting(b, x, ANNEX_TOP - 0.25, -21.4)
  }

  transformer(ctx, b, 41, 10, 49, 16.5)

  puddles(root, rand)
}

function chainlinkPen(b: Batch, x0: number, z0: number, x1: number, z1: number, h: number, gate: [number, number]) {
  const posts: [number, number][] = []
  for (let x = x0; x <= x1 + 1e-6; x += (x1 - x0) / 4) posts.push([x, z0], [x, z1])
  for (let z = z0 + (z1 - z0) / 3; z < z1 - 1e-6; z += (z1 - z0) / 3) posts.push([x0, z], [x1, z])
  for (const [x, z] of posts) b.cylinder("metal_galvanized", x, 0, z, 0.04, h + 0.1, 8)
  const rail = (ax: number, az: number, bx: number, bz: number, yy: number) =>
    b.strut("metal_galvanized", new THREE.Vector3(ax, yy, az), new THREE.Vector3(bx, yy, bz), 0.035, true)
  rail(x0, z0, x1, z0, h)
  rail(x0, z0, x0, z1, h)
  rail(x1, z0, x1, z1, h)
  rail(x0, z1, gate[0], z1, h)
  rail(gate[1], z1, x1, z1, h)
  const mesh = (ax: number, az: number, bx: number, bz: number) => {
    if (Math.abs(az - bz) < 1e-6) b.box("chainlink", ax, 0.04, az - 0.005, bx, h, az + 0.005)
    else b.box("chainlink", ax - 0.005, 0.04, az, ax + 0.005, h, bz)
  }
  mesh(x0, z0, x1, z0)
  mesh(x0, z0, x0, z1)
  mesh(x1, z0, x1, z1)
  mesh(x0, z1, gate[0], z1)
  mesh(gate[1], z1, x1, z1)
  // Gate leaf, shut, with its frame.
  b.box("chainlink", gate[0] + 0.05, 0.08, z1 + 0.04, gate[1] - 0.05, h - 0.1, z1 + 0.05)
  for (const x of gate) b.cylinder("metal_galvanized", x, 0, z1, 0.05, h + 0.1, 8)
  rail(gate[0] + 0.05, z1 + 0.045, gate[1] - 0.05, z1 + 0.045, h - 0.1)
  rail(gate[0] + 0.05, z1 + 0.045, gate[1] - 0.05, z1 + 0.045, 0.1)
}

function shrubGeometry() {
  const g = new THREE.IcosahedronGeometry(0.7, 2)
  const p = g.attributes.position!
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i)
    const y = p.getY(i)
    const z = p.getZ(i)
    const n = 1 + 0.18 * Math.sin(x * 7.1 + z * 3.3) * Math.cos(y * 5.7 - x * 2.1) + 0.08 * Math.sin(z * 13.0 + y * 11.0)
    // Squash the underside instead of clamping it flat (a clamp stacks coplanar faces on one plane).
    const yy = y * n
    p.setXYZ(i, x * n, (yy < 0 ? yy * 0.35 : yy) + 0.45, z * n)
  }
  g.deleteAttribute("normal")
  const merged = g.toNonIndexed()
  merged.computeVertexNormals()
  return merged
}

function puddles(root: THREE.Object3D, rand: () => number) {
  const water = material("glass_dark")
  const geos: THREE.BufferGeometry[] = []
  const spots: [number, number, number][] = [
    [-31, -28.5, 1.1], [-26.5, -31.5, 1.5], [-21.5, -27.2, 0.7], [-36.5, -34, 1.2], [-18, -24.5, 0.6], [-24.5, -38, 1.7],
    [1.4, 30.5, 0.5], [58, -40.5, 0.8],
  ]
  for (const [x, z, r] of spots) {
    const pts: THREE.Vector2[] = []
    const seg = 22
    const k1 = rand() * 6
    const k2 = rand() * 6
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2
      const rr = r * (1 + 0.25 * Math.sin(a * 2 + k1) + 0.12 * Math.sin(a * 5 + k2)) * (i % 2 ? 1 : 0.97)
      pts.push(new THREE.Vector2(Math.cos(a) * rr * 1.3, Math.sin(a) * rr))
    }
    const g = new THREE.ShapeGeometry(new THREE.Shape(pts))
    g.rotateX(-Math.PI / 2)
    g.translate(x, 0.034, z)
    geos.push(g)
  }
  const b = new Batch()
  for (const g of geos) b.add(water, g, undefined, 1, false)
  b.flush(root, { name: "puddles", castShadow: false })
}

const PAINT_GREEN = () => materialFor("flat", { color: 0x2f3d31, roughness: 0.55, metalness: 0.3, name: "facility_paint_green" })
const PAINT_GENSET = () => materialFor("flat", { color: 0x8a8670, roughness: 0.6, metalness: 0.25, name: "facility_paint_genset" })
const HAZARD_YELLOW = () => materialFor("flat", { color: 0xc89a16, roughness: 0.5, metalness: 0.05, name: "facility_hazard_yellow" })
const HAZARD_BLACK = () => materialFor("flat", { color: 0x0b0b0a, roughness: 0.6, metalness: 0.05, name: "facility_hazard_black" })
const PORCELAIN = () => materialFor("flat", { color: 0x5a3824, roughness: 0.25, metalness: 0, name: "facility_porcelain" })

/** Bevelled box (sheet-metal housing edges) with metre-scaled UVs. */
function rbox(b: Batch, mat: Mat, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, r = 0.03) {
  const w = x1 - x0
  const h = y1 - y0
  const d = z1 - z0
  const g = new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2 - 1e-3, h / 2 - 1e-3, d / 2 - 1e-3))
  b.add(mat, g, new THREE.Matrix4().makeTranslation((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), [Math.max(w, d), h])
}

/** Conduit LB fitting: a small cast box with a cover where the pipe turns into the wall (+x wall at x - 0.07). */
function lbFitting(b: Batch, x: number, y: number, z: number) {
  rbox(b, "metal_galvanized", x - 0.05, y - 0.06, z - 0.045, x + 0.05, y + 0.14, z + 0.045, 0.012)
  b.box("metal_galvanized", x + 0.05, y - 0.04, z - 0.035, x + 0.058, y + 0.12, z + 0.035)
  for (const dy of [-0.03, 0.11]) b.cylinder("metal_dark", x + 0.06, y + dy, z, 0.006, 0.004, 6)
}

/**
 * Hazard plate (no text): a yellow enamel plate with a black border, a black warning triangle and a lightning bolt,
 * built from geometry on the plane `x = px` (facing +x when `nx` = 1) or `z = pz` facing ±z.
 */
function hazardPlate(b: Batch, c: THREE.Vector3, facing: THREE.Vector3, w: number, h: number) {
  const right = new THREE.Vector3(facing.z, 0, -facing.x)
  const m = new THREE.Matrix4().makeBasis(right, new THREE.Vector3(0, 1, 0), facing).setPosition(c)
  const quad = (mat: Mat, x0: number, y0: number, x1: number, y1: number, z: number) => {
    const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, 0.004)
    g.translate((x0 + x1) / 2, (y0 + y1) / 2, z)
    b.add(mat, g, m, [x1 - x0, y1 - y0], false)
  }
  quad(HAZARD_YELLOW(), -w / 2, -h / 2, w / 2, h / 2, 0)
  const t = 0.018
  quad(HAZARD_BLACK(), -w / 2, h / 2 - t, w / 2, h / 2, 0.003)
  quad(HAZARD_BLACK(), -w / 2, -h / 2, w / 2, -h / 2 + t, 0.003)
  quad(HAZARD_BLACK(), -w / 2, -h / 2, -w / 2 + t, h / 2, 0.003)
  quad(HAZARD_BLACK(), w / 2 - t, -h / 2, w / 2, h / 2, 0.003)
  // Triangle outline and bolt as thin bars in the plate plane.
  const bar = (ax: number, ay: number, bx: number, by: number, th: number) => {
    const len = Math.hypot(bx - ax, by - ay)
    const g = new THREE.BoxGeometry(len, th, 0.004)
    g.rotateZ(Math.atan2(by - ay, bx - ax))
    g.translate((ax + bx) / 2, (ay + by) / 2, 0.004)
    b.add(HAZARD_BLACK(), g, m, [len, th], false)
  }
  const s = Math.min(w, h) * 0.36
  const cy = h * 0.06
  const A: [number, number] = [0, cy + s]
  const B: [number, number] = [-s * 1.1, cy - s * 0.85]
  const C: [number, number] = [s * 1.1, cy - s * 0.85]
  bar(...A, ...B, 0.03)
  bar(...B, ...C, 0.03)
  bar(...C, ...A, 0.03)
  bar(0.03, cy + s * 0.55, -0.05, cy - 0.02, 0.022)
  bar(-0.05, cy - 0.02, 0.05, cy + 0.02, 0.022)
  bar(0.05, cy + 0.02, -0.03, cy - s * 0.6, 0.022)
}

/** Standby diesel generator in a weatherproof enclosure: skid, belly tank, louvred doors, exhaust with rain cap. */
function standbyGenerator(ctx: WorldContext, b: Batch, x: number, z: number) {
  const paint = PAINT_GENSET()
  const L = 2.3
  const W = 1.05
  b.box("concrete_wall", x - 2.8, 0, z - 1.6, x + 2.8, 0.2, z + 1.6, SKIP_BOTTOM)
  // Belly fuel tank and skid channels.
  rbox(b, "metal_dark", x - 2.45, 0.2, z - 1.18, x + 2.45, 0.74, z + 1.18, 0.04)
  for (const s of [-1, 1]) b.box("metal_dark", x - 2.5, 0.2, z + s * 1.14 - 0.06, x + 2.5, 0.32, z + s * 1.14 + 0.06)
  b.cylinder("metal_galvanized", x + 1.9, 0.74, z + 0.85, 0.07, 0.12, 12)
  b.cylinder("metal_dark", x + 1.9, 0.86, z + 0.85, 0.085, 0.04, 12)
  b.cylinder("metal_galvanized", x + 2.15, 0.74, z + 0.95, 0.02, 0.5, 8)
  b.cylinder("metal_galvanized", x + 2.15, 1.22, z + 0.95, 0.035, 0.05, 8)
  rbox(b, "metal_galvanized", x - 2.2, 0.5, z + 1.17, x - 1.9, 0.68, z + 1.2, 0.01)
  // Housing and the overhanging roof.
  rbox(b, paint, x - L, 0.74, z - W, x + L, 2.6, z + W, 0.035)
  rbox(b, paint, x - L - 0.06, 2.6, z - W - 0.06, x + L + 0.06, 2.7, z + W + 0.06, 0.03)
  // Four doors (two per side): seams, louvre bank, hinges and latch handles.
  for (const side of [-1, 1]) {
    const zf = z + side * W
    for (const [d0, d1] of [[-1.95, -0.25], [0.05, 1.75]] as const) {
      const xa = x + d0
      const xb = x + d1
      b.box("metal_dark", xa - 0.012, 0.9, zf - 0.004, xa + 0.012, 2.45, zf + 0.004)
      b.box("metal_dark", xb - 0.012, 0.9, zf - 0.004, xb + 0.012, 2.45, zf + 0.004)
      b.box("metal_dark", xa, 2.44, zf - 0.004, xb, 2.46, zf + 0.004)
      for (let k = 0; k < 9; k++) {
        const y = 1.55 + k * 0.085
        const g = new THREE.BoxGeometry(xb - xa - 0.24, 0.07, 0.012)
        g.rotateX(side * 0.6)
        g.translate((xa + xb) / 2, y, zf + side * 0.012)
        b.add("metal_dark", g, undefined, [xb - xa, 0.07])
      }
      for (const y of [1.05, 2.25]) b.cylinder("metal_galvanized", xa + 0.03, y, zf + side * 0.015, 0.012, 0.12, 8)
      rbox(b, "metal_galvanized", xb - 0.1, 1.5, zf + (side > 0 ? 0 : -0.035), xb - 0.05, 1.68, zf + (side > 0 ? 0.035 : 0), 0.008)
    }
  }
  // Radiator end: a coarse grille.
  for (let k = 0; k < 12; k++) b.box("metal_dark", x - L - 0.025, 0.95 + k * 0.125, z - 0.85, x - L + 0.005, 1.0 + k * 0.125, z + 0.85)
  b.box("metal_dark", x - L - 0.03, 0.92, z - 0.9, x - L, 2.5, z - 0.86)
  b.box("metal_dark", x - L - 0.03, 0.92, z + 0.86, x - L, 2.5, z + 0.9)
  // Lifting eyes on the roof.
  for (const dx of [-1.9, 1.9]) for (const dz of [-0.75, 0.75]) {
    const g = new THREE.TorusGeometry(0.05, 0.012, 6, 12)
    g.translate(x + dx, 2.76, z + dz)
    b.add("metal_dark", g)
  }
  // Exhaust: flex section, stack, and the hinged rain cap tipped open.
  b.cylinder("metal_dark", x + 1.6, 2.7, z, 0.13, 0.12, 14)
  b.cylinder("metal_galvanized", x + 1.6, 2.82, z, 0.09, 1.2, 14)
  b.cylinder("metal_galvanized", x + 1.6, 3.95, z, 0.11, 0.08, 14)
  {
    const cap = new THREE.CylinderGeometry(0.105, 0.105, 0.01, 16)
    cap.translate(0, 0, 0.1)
    cap.rotateX(-0.5)
    cap.translate(x + 1.6, 4.04, z - 0.1)
    b.add("metal_dark", cap)
    b.box("metal_dark", x + 1.58, 3.98, z - 0.13, x + 1.62, 4.06, z - 0.09)
  }
  // Stencilled hazard plate on the access door, and conduit with elbows into the annex.
  hazardPlate(b, new THREE.Vector3(x + 0.9, 2.08, z + W + 0.004), new THREE.Vector3(0, 0, 1), 0.3, 0.22)
  const ax = BUILDING.annex.max[0]
  b.strut("metal_galvanized", new THREE.Vector3(x - L, 0.95, z + 0.6), new THREE.Vector3(x - L - 0.35, 0.95, z + 0.6), 0.06, true)
  b.strut("metal_galvanized", new THREE.Vector3(x - L - 0.35, 0.95, z + 0.6), new THREE.Vector3(x - L - 0.35, 0.35, z + 0.6), 0.06, true)
  b.strut("metal_galvanized", new THREE.Vector3(x - L - 0.35, 0.35, z + 0.6), new THREE.Vector3(ax + 0.12, 0.35, z + 0.6), 0.06, true)
  b.strut("metal_galvanized", new THREE.Vector3(ax + 0.12, 0.35, z + 0.6), new THREE.Vector3(ax + 0.12, 0.9, z + 0.6), 0.06, true)
  lbFitting(b, ax + 0.12, 0.9, z + 0.6)
  ctx.colliders.push({ min: [x - 2.8, -0.5, z - 1.6], max: [x + 2.8, 2.7, z + 1.6] })
}

/** Pad-mounted transformer behind chain link: rounded cabinet, door seams, padlock hasp, fin banks, bushings. */
function transformer(ctx: WorldContext, b: Batch, x0: number, z0: number, x1: number, z1: number) {
  const green = PAINT_GREEN()
  const cx0 = x0 + 2.2
  const cx1 = x1 - 2.2
  const cz0 = z0 + 1.8
  const cz1 = z1 - 2.2
  b.box("concrete_wall", x0 + 1, -0.1, z0 + 1, x1 - 1, 0.25, z1 - 1, SKIP_BOTTOM)
  rbox(b, green, cx0, 0.25, cz0, cx1, 1.9, cz1, 0.05)
  rbox(b, green, cx0 - 0.04, 1.9, cz0 - 0.04, cx1 + 0.04, 1.98, cz1 + 0.04, 0.03)
  // Front (+z) double door: seams, three hinges a side, and the padlock hasp at the meeting edge.
  const zf = cz1
  const mx = (cx0 + cx1) / 2
  for (const xs of [cx0 + 0.12, mx, cx1 - 0.12]) b.box("metal_dark", xs - 0.008, 0.35, zf - 0.002, xs + 0.008, 1.8, zf + 0.006)
  b.box("metal_dark", cx0 + 0.12, 1.79, zf - 0.002, cx1 - 0.12, 1.805, zf + 0.006)
  for (const xs of [cx0 + 0.14, cx1 - 0.14]) for (const y of [0.55, 1.1, 1.6]) b.cylinder("metal_dark", xs, y, zf + 0.012, 0.014, 0.12, 8)
  rbox(b, green, mx - 0.07, 1.05, zf, mx + 0.07, 1.3, zf + 0.04, 0.01)
  b.box("metal_galvanized", mx - 0.035, 1.12, zf + 0.04, mx + 0.035, 1.2, zf + 0.055)
  {
    const lock = new THREE.TorusGeometry(0.022, 0.006, 6, 12, Math.PI)
    lock.translate(mx, 1.075, zf + 0.06)
    b.add("metal_galvanized", lock)
    rbox(b, "metal_dark", mx - 0.025, 1.02, zf + 0.05, mx + 0.025, 1.075, zf + 0.07, 0.006)
  }
  hazardPlate(b, new THREE.Vector3(mx - 0.55, 1.45, zf + 0.004), new THREE.Vector3(0, 0, 1), 0.28, 0.2)
  // Cooling fin banks on both ends: real thin fins on a header.
  for (const s of [-1, 1]) {
    const xf = s < 0 ? cx0 : cx1
    b.box(green, xf + s * 0.0, 0.4, cz0 + 0.25, xf + s * 0.06, 1.75, cz1 - 0.25)
    for (let z = cz0 + 0.3; z < cz1 - 0.25; z += 0.07) b.box(green, Math.min(xf, xf + s * 0.26), 0.45, z - 0.008, Math.max(xf, xf + s * 0.26), 1.7, z + 0.008)
  }
  // Bushings on the lid: stacked porcelain discs on a short neck, with cable to a riser at the back.
  for (const dx of [-0.5, 0, 0.5]) {
    const bx = mx + dx
    const bz = cz0 + 0.35
    b.cylinder("metal_dark", bx, 1.98, bz, 0.07, 0.06, 12)
    for (let k = 0; k < 4; k++) b.cylinder(PORCELAIN(), bx, 2.04 + k * 0.07, bz, 0.075 - k * 0.006, 0.045, 14, 0.06 - k * 0.006)
    b.cylinder("metal_galvanized", bx, 2.32, bz, 0.018, 0.06, 8)
    b.strut("metal_dark", new THREE.Vector3(bx, 2.37, bz), new THREE.Vector3(bx, 2.2, cz0 - 0.15), 0.025, true)
  }
  b.cylinder("metal_galvanized", mx, 0.25, cz0 - 0.15, 0.06, 1.95, 12)
  b.box("gravel", x0, -0.1, z0, x1, 0.06, z1, SKIP_BOTTOM)
  chainlinkPen(b, x0, z0, x1, z1, 2.4, [44, 46])
  ctx.colliders.push({ min: [x0 - 0.05, -0.5, z0 - 0.05], max: [x1 + 0.05, 2.6, z1 + 0.05] })
  // High-voltage plate on the gate (geometry, no text).
  hazardPlate(b, new THREE.Vector3(45, 1.5, z1 + 0.06), new THREE.Vector3(0, 0, 1), 0.42, 0.3)
}
