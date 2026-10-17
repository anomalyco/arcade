import * as THREE from "three/webgpu"
import { BUILDING } from "../layout"
import type { WorldContext } from "../context"
import { Batch, SKIP_BOTTOM, rng } from "./geo"
import { PLATFORM } from "./dock"
import { material } from "../../render/materials"
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

  // Standby generator enclosure east of the annex, with its belly tank and exhaust.
  {
    const x = ANNEX.max[0] + 5.5
    const z = -16
    b.box("concrete_wall", x - 2.8, 0, z - 1.6, x + 2.8, 0.2, z + 1.6, SKIP_BOTTOM)
    b.box("metal_dark", x - 2.4, 0.2, z - 1.15, x + 2.4, 0.75, z + 1.15)
    b.box("metal_painted", x - 2.3, 0.75, z - 1.05, x + 2.3, 2.6, z + 1.05)
    b.box("metal_painted", x - 2.36, 2.6, z - 1.1, x + 2.36, 2.68, z + 1.1)
    for (let k = 0; k < 8; k++) b.box("metal_dark", x - 2.32, 1.1 + k * 0.16, z - 0.8, x - 2.3, 1.16 + k * 0.16, z + 0.8)
    for (const dx of [-1.2, 0.2]) b.box("metal_dark", x + dx, 0.95, z + 1.05, x + dx + 0.9, 2.3, z + 1.07)
    b.cylinder("metal_dark", x + 1.6, 2.68, z, 0.1, 1.3, 8)
    b.cylinder("metal_dark", x + 1.6, 3.98, z, 0.14, 0.1, 8)
    // Conduit to the annex wall.
    b.box("metal_galvanized", ANNEX.max[0], 0.25, z - 0.06, x - 2.3, 0.37, z + 0.06)
    ctx.colliders.push({ min: [x - 2.8, -0.5, z - 1.6], max: [x + 2.8, 2.7, z + 1.6] })
  }

  // Conduit risers for the utility cabinets on the annex east wall (cabinets are utility_box models from props.ts).
  {
    const x = ANNEX.max[0]
    for (const z of [-22.2, -21.4, -20.2]) b.box("metal_galvanized", x + 0.04, 0, z - 0.03, x + 0.1, 0.4, z + 0.03)
    b.box("metal_galvanized", x + 0.04, 1.55, -21.43, x + 0.1, ANNEX_TOP, -21.37)
  }

  // Transformer pad in a chain-link enclosure, south of the annex.
  {
    const x0 = 41
    const x1 = 49
    const z0 = 10
    const z1 = 16.5
    const green = "metal_painted" as const
    b.box("concrete_wall", x0 + 1, -0.1, z0 + 1, x1 - 1, 0.25, z1 - 1, SKIP_BOTTOM)
    b.box(green, x0 + 2.2, 0.25, z0 + 1.8, x1 - 2.2, 1.9, z1 - 2.2)
    for (let k = 0; k < 7; k++) b.box(green, x0 + 2.4 + k * 0.48, 0.45, z1 - 2.2, x0 + 2.52 + k * 0.48, 1.7, z1 - 1.85)
    b.box("metal_dark", x0 + 2.9, 1.9, z0 + 2.4, x0 + 3.5, 2.5, z0 + 3.0)
    for (const dx of [0.6, 1.6, 2.6]) b.cylinder("plastic_orange", x0 + 2.2 + dx, 1.9, z0 + 2.2, 0.08, 0.45, 8)
    b.box("gravel", x0, -0.1, z0, x1, 0.06, z1, SKIP_BOTTOM)
    chainlinkPen(b, x0, z0, x1, z1, 2.4, [44, 46])
    ctx.colliders.push({ min: [x0 - 0.05, -0.5, z0 - 0.05], max: [x1 + 0.05, 2.6, z1 + 0.05] })
    // Warning sign on the gate.
    b.box("plastic_orange", 44.3, 1.3, z1 + 0.03, 45.1, 1.75, z1 + 0.05)
  }

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
    p.setXYZ(i, x * n, Math.max(y * n, -0.25) + 0.45, z * n)
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
