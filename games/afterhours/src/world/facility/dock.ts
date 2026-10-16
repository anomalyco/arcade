import * as THREE from "three/webgpu"
import { BUILDING } from "../layout"
import type { Lamp, WorldContext } from "../context"
import { Batch, SKIP_BOTTOM } from "./geo"
import { DOCK_DOORS, facades, fbox, normal, point, type Facade } from "./shell"

// The back of the building (concept r5-06): raised loading dock with bumpers and steps, one roll-up door shut and
// one half open with warm light spilling from a shallow receiving bay, a dock lamp, the dumpster, an unmarked box
// truck backed up to the dock, pallets and puddles, plus steel personnel doors with caged lights round the building.

const T = BUILDING.wallThickness
const DK = BUILDING.dock
const WALL_Z = BUILDING.main.min[1]
export const PLATFORM = { x0: DK.x - DK.width / 2, x1: DK.x + DK.width / 2, z0: WALL_Z - 4.5, z1: WALL_Z, y: DK.height }

function localMat(color: number, roughness: number, metalness = 0, name = "facility_paint") {
  const m = new THREE.MeshStandardNodeMaterial({ color, roughness, metalness })
  m.name = name
  return m
}

export function buildDock(ctx: WorldContext, b: Batch) {
  const P = PLATFORM
  const north = facades().find((f) => f.name === "main-north")!

  // Platform, steel nosing, steps at the east end.
  b.box("concrete_wall", P.x0, -0.05, P.z0, P.x1, P.y, P.z1, SKIP_BOTTOM)
  b.box("metal_dark", P.x0, P.y - 0.12, P.z0 - 0.012, P.x1, P.y + 0.002, P.z0 + 0.1)
  ctx.floors.push({ min: [P.x0, P.z0], max: [P.x1, P.z1], y: P.y })
  ctx.colliders.push({ min: [P.x0, -0.5, P.z0], max: [P.x1, P.y, P.z1] })
  const steps = [0.42, 0.84]
  for (let i = 0; i < steps.length; i++) {
    const x1 = P.x1 + (steps.length - i) * 0.42
    b.box("concrete_wall", P.x1, -0.05, P.z1 - 2.6, x1, steps[i]!, P.z1 - 0.4, SKIP_BOTTOM)
    ctx.floors.push({ min: [P.x1, P.z1 - 2.6], max: [x1, P.z1 - 0.4], y: steps[i]! })
  }
  // Pipe handrail beside the steps.
  for (const x of [P.x1 + 0.05, P.x1 + 0.8]) b.cylinder("metal_galvanized", x, x > P.x1 + 0.5 ? 0.42 : P.y, P.z1 - 2.55, 0.025, x > P.x1 + 0.5 ? 1.35 : 0.95, 6)
  b.strut("metal_galvanized", new THREE.Vector3(P.x1 + 0.05, P.y + 0.95, P.z1 - 2.55), new THREE.Vector3(P.x1 + 0.8, 1.77, P.z1 - 2.55), 0.05, true)
  b.strut("metal_galvanized", new THREE.Vector3(P.x1 + 0.8, 1.77, P.z1 - 2.55), new THREE.Vector3(P.x1 + 0.8, 1.77, P.z1 - 0.5), 0.05, true)

  // Dock bumpers either side of each roll-up door.
  for (const d of [DOCK_DOORS.open, DOCK_DOORS.closed]) {
    for (const x of [d.u0 - 0.35, d.u1 + 0.35]) {
      b.box("rubber", x - 0.14, 0.55, P.z0 - 0.14, x + 0.14, 1.15, P.z0)
      b.box("metal_dark", x - 0.17, 0.5, P.z0 - 0.02, x + 0.17, 1.2, P.z0)
    }
  }

  rollup(b, north, DOCK_DOORS.closed.u0, DOCK_DOORS.closed.u1, DOCK_DOORS.y0, DOCK_DOORS.head, DOCK_DOORS.head)
  rollup(b, north, DOCK_DOORS.open.u0, DOCK_DOORS.open.u1, DOCK_DOORS.y0, DOCK_DOORS.head, DOCK_DOORS.y0 + DOCK_DOORS.openHeight)
  for (const d of [DOCK_DOORS.open, DOCK_DOORS.closed]) ctx.colliders.push({ min: [d.u0, P.y, WALL_Z - 0.05], max: [d.u1, DOCK_DOORS.head, WALL_Z + T] })

  // Receiving bay behind the open door: block walls, a few crates, lit by a bare fixture.
  const bx0 = DOCK_DOORS.open.u0 - 1.6
  const bx1 = DOCK_DOORS.open.u1 + 1.6
  const bz0 = WALL_Z + T
  const bz1 = WALL_Z + 6.5
  const by = P.y
  const block = localMat(0x9a8f78, 0.85, 0, "facility_block_wall")
  b.box("concrete_floor", bx0, BUILDING.floorY, bz0, bx1, by, bz1, SKIP_BOTTOM)
  b.box(block, bx0 - 0.2, by, bz1, bx1 + 0.2, 4.2, bz1 + 0.2)
  b.box(block, bx0 - 0.2, by, bz0, bx0, 4.2, bz1)
  b.box(block, bx1, by, bz0, bx1 + 0.2, 4.2, bz1)
  b.box("concrete_dark", bx0 - 0.2, 4.2, bz0, bx1 + 0.2, 4.4, bz1 + 0.2)
  const crate = localMat(0x5a4a34, 0.9, 0, "facility_crate")
  b.box(crate, bx0 + 0.3, by, bz1 - 1.4, bx0 + 1.5, by + 1.1, bz1 - 0.2)
  b.box(crate, bx0 + 0.4, by + 1.1, bz1 - 1.3, bx0 + 1.3, by + 1.8, bz1 - 0.4)
  b.box(crate, bx1 - 1.9, by, bz1 - 1.1, bx1 - 0.3, by + 0.8, bz1 - 0.2)
  b.box("metal_painted", bx0 + 2.4, by, bz1 - 0.6, bx0 + 4.4, by + 2.0, bz1 - 0.15)
  b.box("metal_dark", (bx0 + bx1) / 2 - 0.15, 4.0, bz0 + 2.8, (bx0 + bx1) / 2 + 0.15, 4.2, bz0 + 3.2)
  b.box("emissive_sodium", (bx0 + bx1) / 2 - 0.08, 3.92, bz0 + 2.92, (bx0 + bx1) / 2 + 0.08, 4.0, bz0 + 3.08)
  const bayCx = (DOCK_DOORS.open.u0 + DOCK_DOORS.open.u1) / 2
  ctx.lamps.push({
    kind: "incandescent",
    position: [bayCx, 3.85, bz0 + 3.0],
    direction: [0, -0.62, -0.78],
    color: [1, 0.62, 0.3],
    intensity: 420,
    range: 22,
    angle: 0.85,
    penumbra: 0.5,
    shadow: true,
    size: 0.2,
  })

  // Swing-arm dock lamp beside the open door.
  const ax = DOCK_DOORS.open.u1 + 0.55
  b.box("metal_dark", ax - 0.08, 3.1, WALL_Z - 0.06, ax + 0.08, 3.4, WALL_Z)
  b.strut("metal_dark", new THREE.Vector3(ax, 3.25, WALL_Z - 0.05), new THREE.Vector3(ax - 0.4, 3.35, WALL_Z - 1.0), 0.05, true)
  const head = new THREE.CylinderGeometry(0.12, 0.2, 0.3, 12, 1, true)
  head.rotateX(-Math.PI / 2 - 0.5)
  head.translate(ax - 0.45, 3.32, WALL_Z - 1.1)
  b.add("metal_dark", head)

  // Personnel doors (dock man-door, west and annex back doors) with caged wall lights.
  for (const f of facades()) {
    for (const h of f.holes) if (h.kind === "door") personnelDoor(ctx, b, f, h.u0, h.u1, h.y0, h.y1)
  }

  // Dumpster against the wall east of the steps.
  dumpster(ctx, b, P.x1 + 2.2, WALL_Z - 0.1)
  // Unmarked box truck backed up in front of the shut door.
  boxTruck(ctx, b, (DOCK_DOORS.closed.u0 + DOCK_DOORS.closed.u1) / 2, P.z0 - 0.2)
  // Pallets.
  const wood = "wood_pole" as const
  pallet(b, wood, P.x0 + 0.3, P.y, P.z1 - 1.5, 0)
  pallet(b, wood, P.x0 + 0.3, P.y + 0.15, P.z1 - 1.5, 0.05)
  pallet(b, wood, P.x0 + 0.3, P.y + 0.3, P.z1 - 1.5, -0.04)
  pallet(b, wood, P.x1 + 4.6, 0.02, WALL_Z - 1.4, 0.3)
  pallet(b, wood, P.x1 + 4.6, 0.17, WALL_Z - 1.4, 0.36)
  ctx.colliders.push({ min: [P.x1 + 3.9, -0.5, WALL_Z - 2.3], max: [P.x1 + 5.4, 0.4, WALL_Z - 0.5] })
}

function rollup(b: Batch, f: Facade, u0: number, u1: number, y0: number, head: number, bottom: number) {
  const d = 0.17
  for (const u of [u0, u1 - 0.1]) fbox(b, "metal_dark", f, u, u + 0.1, y0, head, d - 0.06, d + 0.06)
  for (let y = head; y > bottom + 0.01; y -= 0.16) {
    const yb = Math.max(bottom, y - 0.16)
    fbox(b, "metal_painted", f, u0 + 0.05, u1 - 0.05, yb, y - 0.01, d - 0.02, d + 0.02)
    fbox(b, "metal_painted", f, u0 + 0.05, u1 - 0.05, yb + 0.03, y - 0.04, d - 0.04, d - 0.02)
  }
  fbox(b, "rubber", f, u0 + 0.05, u1 - 0.05, bottom - 0.05, bottom + 0.04, d - 0.04, d + 0.04)
  fbox(b, "metal_dark", f, u0 + 0.6, u0 + 0.75, bottom + 0.06, bottom + 0.16, d - 0.1, d - 0.03)
}

function personnelDoor(ctx: WorldContext, b: Batch, f: Facade, u0: number, u1: number, y0: number, y1: number) {
  const fr = 0.05
  fbox(b, "metal_dark", f, u0, u1, y1 - fr, y1, 0.08, 0.2)
  fbox(b, "metal_dark", f, u0, u0 + fr, y0, y1, 0.08, 0.2)
  fbox(b, "metal_dark", f, u1 - fr, u1, y0, y1, 0.08, 0.2)
  fbox(b, "door_steel", f, u0 + fr, u1 - fr, y0, y1 - fr, 0.12, 0.16)
  const flip = f.out > 0 === (f.axis === "x")
  const hu = flip ? u1 - 0.18 : u0 + 0.18
  fbox(b, "metal_galvanized", f, hu - 0.03, hu + 0.03, y0 + 0.95, y0 + 1.1, 0.06, 0.12)
  // Kick plate and a small wired-glass vision panel.
  fbox(b, "metal_galvanized", f, u0 + fr, u1 - fr, y0, y0 + 0.25, 0.115, 0.12)
  fbox(b, "glass_dark", f, (u0 + u1) / 2 - 0.1, (u0 + u1) / 2 + 0.1, y0 + 1.35, y0 + 1.75, 0.11, 0.115)
  // Step / stoop outside.
  const s0 = point(f, u0 - 0.5, 0, 0)
  const s1 = point(f, u1 + 0.5, y0 > 1 ? 0 : y0, -1.1)
  if (y0 < 1) b.box("concrete_wall", s0.x, -0.05, s0.z, s1.x, y0, s1.z, SKIP_BOTTOM)
  // Caged bulkhead light above the door.
  const lu = (u0 + u1) / 2
  const ly = y1 + 0.35
  fbox(b, "metal_dark", f, lu - 0.14, lu + 0.14, ly - 0.12, ly + 0.12, -0.06, 0)
  const lens = point(f, lu, ly, -0.12)
  const g = new THREE.SphereGeometry(0.075, 10, 6)
  g.translate(lens.x, lens.y, lens.z)
  b.add("glass_lit", g, undefined, 1, false)
  for (const k of [-0.09, 0, 0.09]) fbox(b, "metal_dark", f, lu + k - 0.008, lu + k + 0.008, ly - 0.1, ly + 0.1, -0.2, -0.06)
  fbox(b, "metal_dark", f, lu - 0.1, lu + 0.1, ly - 0.01, ly + 0.01, -0.2, -0.06)
  const n = normal(f)
  const lp = point(f, lu, ly - 0.05, -0.3)
  const lamp: Lamp = {
    kind: "incandescent",
    position: [lp.x, lp.y, lp.z],
    direction: [n.x * 0.45, -0.89, n.z * 0.45],
    color: [1, 0.7, 0.4],
    intensity: 70,
    range: 10,
    angle: 1.15,
    penumbra: 0.8,
    size: 0.15,
  }
  ctx.lamps.push(lamp)
}

function dumpster(ctx: WorldContext, b: Batch, x: number, zWall: number) {
  const green = localMat(0x1e2e26, 0.7, 0.3, "facility_dumpster")
  const lidMat = localMat(0x161a17, 0.6, 0, "facility_lid")
  const w = 2.0
  const d = 1.5
  const z0 = zWall - d
  b.box(green, x - w / 2, 0.15, z0, x + w / 2, 1.25, zWall)
  b.box("metal_dark", x - w / 2 - 0.05, 1.05, z0 - 0.05, x + w / 2 + 0.05, 1.15, zWall)
  // Sloped split lids, one propped slightly.
  const lid = (cx: number, open: number) => {
    const g = new THREE.BoxGeometry(w / 2 - 0.04, 0.04, d + 0.08)
    g.translate(0, 0, -(d + 0.08) / 2)
    const m = new THREE.Matrix4().makeTranslation(cx, 1.32, zWall).multiply(new THREE.Matrix4().makeRotationX(-0.1 - open))
    b.add(lidMat, g, m)
  }
  lid(x - w / 4, 0)
  lid(x + w / 4, 0.18)
  for (const dx of [-w / 2 + 0.2, w / 2 - 0.2]) for (const z of [z0 + 0.2, zWall - 0.2]) b.cylinder("rubber", dx + x, 0, z, 0.08, 0.15, 8)
  for (const s of [-1, 1]) b.box("metal_dark", x + s * (w / 2 + 0.02) - 0.04, 0.55, z0 + 0.2, x + s * (w / 2 + 0.02) + 0.04, 0.75, zWall - 0.2)
  ctx.colliders.push({ min: [x - w / 2, -0.5, z0], max: [x + w / 2, 1.4, zWall] })
}

/** Cab-over box truck facing north, rear doors at `zRear`. */
function boxTruck(ctx: WorldContext, b: Batch, x: number, zRear: number) {
  const paint = localMat(0x4a4c46, 0.55, 0.2, "facility_truck_paint")
  const boxPaint = localMat(0x5d5b54, 0.75, 0.05, "facility_truck_box")
  const W = 2.4
  const bodyLen = 5.6
  const zb1 = zRear
  const zb0 = zRear - bodyLen
  // Box body with corner posts and side rub rails.
  b.box(boxPaint, x - W / 2, 1.15, zb0, x + W / 2, 3.65, zb1)
  for (const sx of [-1, 1]) for (const z of [zb0, zb1 - 0.08]) b.box("metal_galvanized", x + sx * W / 2 - (sx > 0 ? 0.06 : -0.06) - 0.03, 1.1, z, x + sx * W / 2 + (sx > 0 ? 0.02 : -0.02), 3.7, z + 0.08)
  for (const sx of [-1, 1]) b.box("metal_galvanized", x + sx * (W / 2 + 0.015) - 0.02, 1.6, zb0, x + sx * (W / 2 + 0.015) + 0.02, 1.68, zb1)
  b.box("metal_galvanized", x - W / 2, 3.65, zb0, x + W / 2, 3.72, zb1)
  // Rear roll-up and underride bar.
  b.box("metal_galvanized", x - W / 2 + 0.1, 1.2, zb1, x + W / 2 - 0.1, 3.55, zb1 + 0.02)
  b.box("metal_dark", x - W / 2 + 0.1, 0.45, zb1 - 0.1, x + W / 2 - 0.1, 0.58, zb1)
  // Chassis rails.
  b.box("metal_dark", x - 0.55, 0.55, zb0 - 2.4, x - 0.4, 0.85, zb1 - 0.1)
  b.box("metal_dark", x + 0.4, 0.55, zb0 - 2.4, x + 0.55, 0.85, zb1 - 0.1)
  b.box("metal_dark", x - 1.05, 0.65, zb0 + 1.2, x - 0.55, 1.15, zb0 + 2.6)
  // Cab-over cab.
  const zc1 = zb0 - 0.12
  const zc0 = zc1 - 1.75
  b.box(paint, x - 1.15, 0.85, zc0 + 0.1, x + 1.15, 1.7, zc1)
  b.box(paint, x - 1.12, 1.7, zc0 + 0.25, x + 1.12, 2.75, zc1)
  b.box("glass_dark", x - 1.0, 1.82, zc0 + 0.22, x + 1.0, 2.6, zc0 + 0.27)
  for (const sx of [-1, 1]) b.box("glass_dark", x + sx * 1.125 - 0.01, 1.85, zc0 + 0.45, x + sx * 1.125 + 0.01, 2.55, zc0 + 1.3)
  b.box(paint, x - 1.1, 2.75, zc0 + 0.35, x + 1.1, 2.82, zc1 - 0.05)
  // Grille, bumper, lamps.
  b.box("metal_dark", x - 0.8, 1.0, zc0 + 0.07, x + 0.8, 1.45, zc0 + 0.1)
  b.box("metal_dark", x - 1.2, 0.6, zc0 - 0.05, x + 1.2, 0.85, zc0 + 0.15)
  for (const sx of [-1, 1]) {
    b.box("chrome", x + sx * 0.95 - 0.13, 1.05, zc0 + 0.06, x + sx * 0.95 + 0.13, 1.25, zc0 + 0.1)
    // Mirrors.
    b.box("metal_dark", x + sx * 1.3 - 0.06, 1.95, zc0 + 0.35, x + sx * 1.3 + 0.06, 2.35, zc0 + 0.42)
    b.strut("metal_dark", new THREE.Vector3(x + sx * 1.13, 2.3, zc0 + 0.4), new THREE.Vector3(x + sx * 1.3, 2.3, zc0 + 0.4), 0.025, true)
  }
  // Wheels.
  const wheel = (wx: number, wz: number, dual: boolean) => {
    const g = new THREE.CylinderGeometry(0.47, 0.47, dual ? 0.5 : 0.28, 18)
    g.rotateZ(Math.PI / 2)
    g.translate(wx, 0.47, wz)
    b.add("rubber", g)
    const hub = new THREE.CylinderGeometry(0.22, 0.22, (dual ? 0.5 : 0.28) + 0.02, 10)
    hub.rotateZ(Math.PI / 2)
    hub.translate(wx, 0.47, wz)
    b.add("metal_galvanized", hub)
  }
  for (const sx of [-1, 1]) {
    wheel(x + sx * 0.98, zc0 + 0.9, false)
    wheel(x + sx * 0.9, zb1 - 1.5, true)
    b.box("metal_dark", x + sx * 1.05 - 0.35, 1.0, zb1 - 2.15, x + sx * 1.05 + 0.35, 1.06, zb1 - 0.85)
  }
  ctx.colliders.push({ min: [x - W / 2 - 0.1, -0.5, zc0 - 0.1], max: [x + W / 2 + 0.1, 3.7, zb1 + 0.05] })
}

function pallet(b: Batch, mat: "wood_pole", x: number, y: number, z: number, rot: number) {
  const m = new THREE.Matrix4().makeTranslation(x + 0.6, y, z + 0.5).multiply(new THREE.Matrix4().makeRotationY(rot))
  const add = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => {
    const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0)
    g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2)
    b.add(mat, g, m)
  }
  for (const zz of [-0.45, -0.05, 0.37]) add(-0.6, 0, zz, 0.6, 0.1, zz + 0.08)
  for (let k = 0; k < 7; k++) {
    const xx = -0.6 + k * 0.19
    add(xx, 0.1, -0.5, xx + 0.1, 0.13, 0.5)
  }
}
