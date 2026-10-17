import * as THREE from "three/webgpu"
import { BUILDING } from "../layout"
import type { WorldContext } from "../context"
import { Batch, rng } from "./geo"
import { cagedLadder, crossover } from "./access"
import { ANNEX_ROOF_Y, ANNEX_TOP, MAIN_ROOF_Y, MAIN_TOP, facades, finPositions, CROWN, normal, point, tangent, type Facade } from "./shell"

// Rooftop plant and the things hung on the walls: HVAC units, mushroom vents, exhaust stacks, conduit runs, antenna
// masts, a roof hatch, caged ladders (ground to annex roof, annex roof to main roof) with steps over the parapets,
// and downpipes with their scuppers. Everything bulky on the roofs is a collider so the decks can be walked.

const MAIN = BUILDING.main
const ANNEX = BUILDING.annex

const COPE = 0.14
let colliders: WorldContext["colliders"] = []
const solid = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => colliders.push({ min: [x0, y0, z0], max: [x1, y1, z1] })

function hvac(b: Batch, x: number, y: number, z: number, w: number, d: number, rotated = false) {
  const [sx, sz] = rotated ? [d, w] : [w, d]
  const h = 1.45
  solid(x - sx / 2 - 0.15, y, z - sz / 2 - 0.15, x + sx / 2 + 0.15, y + 0.2 + h + 0.2, z + sz / 2 + 0.15)
  b.box("concrete_dark", x - sx / 2 - 0.15, y, z - sz / 2 - 0.15, x + sx / 2 + 0.15, y + 0.2, z + sz / 2 + 0.15)
  b.box("metal_painted", x - sx / 2, y + 0.2, z - sz / 2, x + sx / 2, y + 0.2 + h, z + sz / 2)
  // Louvre lines along the long sides.
  for (let k = 0; k < 6; k++) {
    const yy = y + 0.45 + k * 0.17
    if (rotated) {
      b.box("metal_dark", x - sx / 2 - 0.03, yy, z - sz / 2 + 0.2, x - sx / 2, yy + 0.05, z + sz / 2 - 0.2)
      b.box("metal_dark", x + sx / 2, yy, z - sz / 2 + 0.2, x + sx / 2 + 0.03, yy + 0.05, z + sz / 2 - 0.2)
    } else {
      b.box("metal_dark", x - sx / 2 + 0.2, yy, z - sz / 2 - 0.03, x + sx / 2 - 0.2, yy + 0.05, z - sz / 2)
      b.box("metal_dark", x - sx / 2 + 0.2, yy, z + sz / 2, x + sx / 2 - 0.2, yy + 0.05, z + sz / 2 + 0.03)
    }
  }
  // Two condenser fans on top.
  const top = y + 0.2 + h
  for (const s of [-1, 1]) {
    const fx = rotated ? x : x + (s * sx) / 4
    const fz = rotated ? z + (s * sz) / 4 : z
    const r = Math.min(sx, sz) * 0.36
    b.cylinder("metal_dark", fx, top, fz, r, 0.18, 16)
    b.cylinder("metal_galvanized", fx, top + 0.18, fz, r * 0.25, 0.06, 8)
  }
}

export function buildRoof(ctx: WorldContext, b: Batch) {
  colliders = ctx.colliders
  const rand = rng(77)
  const mr = MAIN_ROOF_Y
  hvac(b, -40, mr, -10, 3.4, 1.8)
  hvac(b, -31, mr, 10, 3.4, 1.8, true)
  hvac(b, -46, mr, 14, 2.6, 1.6)
  hvac(b, 26, mr, -15, 3.4, 1.8)
  hvac(b, 27, mr, 13, 3.0, 1.7, true)
  hvac(b, 48, ANNEX_ROOF_Y, -22, 3.4, 1.8)
  hvac(b, 55, ANNEX_ROOF_Y, -4, 2.6, 1.6, true)

  // Mechanical penthouse: louvred plant room for the air handlers serving the five floors.
  {
    const [x0, x1, z0, z1, h] = [-50, -37, -5, 8, 3.6]
    b.box("concrete_wall", x0, mr - 0.1, z0, x1, mr + h, z1)
    b.box("concrete_dark", x0 - 0.08, mr + h, z0 - 0.08, x1 + 0.08, mr + h + 0.14, z1 + 0.08)
    for (let k = 0; k < 9; k++) {
      const y = mr + 0.8 + k * 0.26
      b.box("metal_dark", x0 + 1.5, y, z1, x1 - 1.5, y + 0.12, z1 + 0.05)
      b.box("metal_dark", x1, y, z0 + 1.5, x1 + 0.05, y + 0.12, z1 - 1.5)
    }
    b.box("door_steel", x1 + 0.001, mr, z0 + 0.4, x1 + 0.05, mr + 2.1, z0 + 1.4)
    for (const [x, z] of [[-46, 2], [-41, 2]] as const) {
      b.cylinder("metal_galvanized", x, mr + h + 0.14, z, 0.9, 0.7, 16)
      b.cylinder("metal_dark", x, mr + h + 0.84, z, 0.95, 0.08, 16)
    }
    solid(x0, mr - 0.1, z0, x1 + 0.05, mr + h + 0.14, z1 + 0.05)
  }

  // Large supply duct from the west unit to the plant room.
  b.box("metal_galvanized", -38.2, mr + 0.5, -10.5, -12, mr + 1.3, -9.5)
  solid(-38.2, mr, -10.6, -12, mr + 1.3, -9.4)
  for (let x = -36; x < -12; x += 3) b.box("concrete_dark", x - 0.15, mr, -10.6, x + 0.15, mr + 0.5, -9.4)

  // Mushroom vents and plumbing stacks.
  const vents: [number, number, number][] = [
    [-50, -16, mr], [-22, -17, mr], [-18, 15, mr], [-8, 15, mr], [-34, -2, mr], [20, 10, mr], [30, -5, mr], [-2, 17, mr],
    [40, -30, ANNEX_ROOF_Y], [58, -30, ANNEX_ROOF_Y], [42, 0, ANNEX_ROOF_Y],
  ]
  for (const [x, z, y] of vents) {
    solid(x - 0.3, y, z - 0.3, x + 0.3, y + 0.73, z + 0.3)
    b.cylinder("metal_galvanized", x, y, z, 0.18, 0.55, 10)
    b.cylinder("metal_galvanized", x, y + 0.55, z, 0.38, 0.18, 12, 0.12)
  }
  for (const [x, z, h] of [[-12, -18, 2.6], [-12.6, -18, 2.1], [31, 18, 3.2]] as const) {
    b.cylinder("metal_dark", x, mr, z, 0.11, h, 8)
    solid(x - 0.15, mr, z - 0.15, x + 0.15, mr + h, z + 0.15)
    b.cylinder("metal_dark", x, mr + h, z, 0.16, 0.12, 8)
  }

  // Conduit runs on sleepers.
  const conduit = (x0: number, z0: number, x1: number, z1: number, y: number) => {
    b.box("metal_galvanized", Math.min(x0, x1) - 0.04, y + 0.16, Math.min(z0, z1) - 0.04, Math.max(x0, x1) + 0.04, y + 0.24, Math.max(z0, z1) + 0.04)
    const len = Math.hypot(x1 - x0, z1 - z0)
    for (let s = 0; s <= len; s += 2.5) {
      const t = s / len
      const x = x0 + (x1 - x0) * t
      const z = z0 + (z1 - z0) * t
      b.box("concrete_dark", x - 0.2, y, z - 0.2, x + 0.2, y + 0.16, z + 0.2)
    }
  }
  conduit(26, -14, 26, -3, mr)
  conduit(26, -3, 22, -3, mr)
  conduit(-31, 10, -31, 1, mr)
  conduit(-31, 1, -12, 1, mr)
  conduit(27, 13, 27, 3, mr)
  conduit(-20, -15.5, -6, -15.5, mr)

  // Antenna masts (thin silhouettes against the fog in the concept).
  const mast = (x: number, z: number, h: number, arms: number) => {
    b.box("concrete_dark", x - 0.3, mr, z - 0.3, x + 0.3, mr + 0.25, z + 0.3)
    solid(x - 0.3, mr, z - 0.3, x + 0.3, mr + h, z + 0.3)
    b.cylinder("metal_galvanized", x, mr + 0.25, z, 0.05, h, 6, 0.03)
    for (let k = 0; k < arms; k++) {
      const y = mr + h - 0.4 - k * 0.9
      b.box("metal_galvanized", x - 0.7, y, z - 0.02, x + 0.7, y + 0.04, z + 0.02)
    }
    // Guy wires.
    for (const [dx, dz] of [[2.4, 0], [-1.2, 2], [-1.2, -2]] as const) {
      b.strut("metal_galvanized", new THREE.Vector3(x, mr + h * 0.75, z), new THREE.Vector3(x + dx, mr + 0.02, z + dz), 0.012)
    }
  }
  mast(-20, -16, 7.5, 2)
  mast(-49, -17, 5.5, 1)
  mast(31, -1, 6.2, 0)

  // Roof hatch.
  b.box("concrete_dark", -15.6, mr, 4.4, -14.4, mr + 0.5, 5.6)
  b.box("metal_painted", -15.65, mr + 0.5, 4.35, -14.35, mr + 0.58, 5.65)
  solid(-15.65, mr, 4.35, -14.35, mr + 0.58, 5.65)

  // Caged ladder on the main block's east wall, from the annex roof over the parapet onto the main roof.
  const mainCoping = MAIN_TOP + COPE
  cagedLadder(ctx, b, { x: MAIN.max[0], z: -15, nx: 1, nz: 0, y0: ANNEX_ROOF_Y, y1: mainCoping + 1.0, arrive: mainCoping, cageFrom: ANNEX_ROOF_Y + 2.3 })
  crossover(ctx, b, MAIN.max[0], -15, 1, 0, mr, mainCoping, BUILDING.wallThickness + 0.1)
  // Access ladder up the annex's east wall from the ground to the annex roof.
  const annexCoping = ANNEX_TOP + COPE
  cagedLadder(ctx, b, { x: ANNEX.max[0], z: -30, nx: 1, nz: 0, y0: 0, y1: annexCoping + 1.0, arrive: annexCoping, cageFrom: 2.4 })
  crossover(ctx, b, ANNEX.max[0], -30, 1, 0, ANNEX_ROOF_Y, annexCoping, BUILDING.wallThickness + 0.1)

  // Downpipes with scupper heads, wall brackets and shoes.
  const fs = facades()
  const byName = new Map(fs.map((f) => [f.name, f]))
  const pipes: [string, number][] = [
    ["main-south", -53.2], ["main-south", -26.2], ["main-south", -10.0], ["main-south", 17.0], ["main-south", 33.2],
    ["main-north", -53.2], ["main-north", -42.4], ["main-north", -4.6], ["main-north", 22.4], ["main-north", 33.2],
    ["main-west", -8.1], ["main-west", 13.5], ["main-east", 8.4], ["main-east", 20.4],
    ["annex-south", 61], ["annex-north", 36.6], ["annex-north", 60.4], ["annex-east", -36.4], ["annex-east", -7.9],
  ]
  for (const [name, u] of pipes) {
    const f = byName.get(name)
    if (!f) continue
    const fins = name.startsWith("main") ? finPositions(f) : []
    const near = fins.reduce((best, x) => (Math.abs(x - u) < Math.abs(best - u) ? x : best), Infinity)
    downpipe(b, f, Number.isFinite(near) && Math.abs(near - u) < 2.6 ? near + (u > near ? 0.5 : -0.5) : u, rand)
  }
}

function downpipe(b: Batch, f: Facade, u: number, rand: () => number) {
  const top = f.name.startsWith("main") ? CROWN.y0 - 0.05 : f.y1 - 0.55
  const off = 0.24
  const n = normal(f)
  const t = tangent(f)
  // Scupper box through the parapet and the conductor head.
  const head = point(f, u, top, -off)
  const hw = 0.22
  const lo = head.clone().addScaledVector(t, -hw).addScaledVector(n, -0.14)
  const hi = head.clone().addScaledVector(t, hw).addScaledVector(n, 0.14)
  b.box("metal_galvanized", lo.x, top - 0.35, lo.z, hi.x, top, hi.z)
  const sc0 = point(f, u - 0.12, top + 0.15, -0.05)
  const sc1 = point(f, u + 0.12, top + 0.3, -off + 0.1)
  b.box("metal_galvanized", sc0.x, sc0.y, sc0.z, sc1.x, sc1.y, sc1.z)
  const base = point(f, u, 0.3, -off)
  b.cylinder("metal_galvanized", base.x, 0.3, base.z, 0.055, top - 0.35 - 0.3, 8)
  for (let y = 1.2; y < top - 0.5; y += 1.8 + rand() * 0.2) {
    const a = point(f, u - 0.05, y, 0)
    const c = point(f, u + 0.05, y + 0.05, -off)
    b.box("metal_dark", a.x, a.y, a.z, c.x, c.y, c.z)
  }
  // Shoe kicking out at the bottom, and a splash block.
  const shoe = point(f, u, 0.12, -off - 0.12)
  b.box("metal_galvanized", shoe.x - 0.07, 0.08, shoe.z - 0.07, shoe.x + 0.07, 0.34, shoe.z + 0.07)
  const s0 = point(f, u - 0.2, 0, -off + 0.02)
  const s1 = point(f, u + 0.2, 0.06, -off - 0.75)
  b.box("concrete_dark", s0.x, 0.0, s0.z, s1.x, 0.06, s1.z)
}
