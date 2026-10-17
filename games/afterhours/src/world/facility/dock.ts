import * as THREE from "three/webgpu"
import { BUILDING } from "../layout"
import type { Lamp, WorldContext } from "../context"
import { Batch, SKIP_BOTTOM } from "./geo"
import { materialFor } from "../../render/materials"
import { DOCK_DOORS, band, facades, fbox, normal, point, type Facade } from "./shell"
import { addFacadeDoor, rollupLeaf, steelLeaf } from "./doors"

// The back of the building (concept r5-06): raised loading dock with bumpers and steps, one roll-up door shut and
// one half open with warm light spilling from a shallow receiving bay, a dock lamp, the dumpster, an unmarked box
// truck backed up to the dock, pallets and puddles, plus steel personnel doors with flood lights round the building.
// The truck, dumpster, pallets, boxes and light heads are real models placed by props.ts.

const T = BUILDING.wallThickness
const DK = BUILDING.dock
const WALL_Z = BUILDING.main.min[1]
export const PLATFORM = { x0: DK.x - DK.width / 2, x1: DK.x + DK.width / 2, z0: WALL_Z - 4.5, z1: WALL_Z, y: DK.height }

export function buildDock(ctx: WorldContext, b: Batch, root: THREE.Object3D) {
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

  // Working roll-up doors (E: fully open / shut); the west one is shut, the east one stands about half open on load.
  // The curtain lifts 1.8 m (bottom edge clears a head) and visually coils into the head box as it goes.
  const lift = 1.8
  for (const [key, d, start] of [["closed", DOCK_DOORS.closed, 0], ["open", DOCK_DOORS.open, 0.49]] as const) {
    rollupFrame(b, north, d.u0, d.u1, DOCK_DOORS.y0, DOCK_DOORS.head)
    const curtain = rollupLeaf(`dock-rollup-${key}`, d.u1 - d.u0, DOCK_DOORS.head - DOCK_DOORS.y0)
    addFacadeDoor(ctx, root, {
      id: `dock-rollup-${key}`,
      f: north,
      u0: d.u0,
      u1: d.u1,
      y0: DOCK_DOORS.y0,
      depth: 0.17,
      height: DOCK_DOORS.head - DOCK_DOORS.y0,
      leaf: curtain.leaf,
      onMove: (t) => curtain.coil(Math.max(0, Math.min(1, t)) * lift),
      openAngle: 0,
      startOpen: start,
      sound: "gate",
      slide: { axis: [0, 1, 0], distance: lift },
      thickness: 0.08,
    })
  }

  // Receiving bay behind the open door: block walls, a few crates, lit by a bare fixture.
  const bx0 = DOCK_DOORS.open.u0 - 1.6
  // East end takes in the dock man door too, so it opens into the bay.
  const bx1 = DOCK_DOORS.man.u1 + 0.55
  const bz0 = WALL_Z + T
  const bz1 = WALL_Z + 6.5
  const by = P.y
  // The bay is the dock's key light (concept r5-06): concrete block walls lit deep sodium-orange by a hot fixture,
  // and a floor that carries a little warm glow of its own so the slot still reads if the light budget trims a lamp.
  const bayFloor = materialFor("emissive", { color: 0x4a3420, roughness: 0.5, emissive: new THREE.Color(1, 0.3, 0.04), intensity: 0.5, name: "facility_bay_floor" })
  b.box(bayFloor, bx0, BUILDING.floorY, bz0, bx1, by, bz1, SKIP_BOTTOM)
  ctx.floors.push({ min: [bx0, WALL_Z - 0.05], max: [bx1, bz1], y: by })
  ctx.colliders.push(
    { min: [bx0 - 0.2, -0.5, bz1], max: [bx1 + 0.2, 4.4, bz1 + 0.2] },
    { min: [bx0 - 0.2, -0.5, bz0], max: [bx0, 4.4, bz1] },
    { min: [bx1, -0.5, bz0], max: [bx1 + 0.2, 4.4, bz1] },
  )
  // Second, unlit bay behind the shut roll-up door.
  {
    const cx0 = DOCK_DOORS.closed.u0 - 1.8
    const cx1 = bx0 - 0.2
    b.box("concrete_floor_dry", cx0, BUILDING.floorY, bz0, cx1, by, bz1, SKIP_BOTTOM)
    b.box("concrete_block", cx0 - 0.2, by, bz1, cx1, 4.2, bz1 + 0.2)
    b.box("concrete_block", cx0 - 0.2, by, bz0, cx0, 4.2, bz1)
    b.box("concrete_dark", cx0 - 0.2, 4.2, bz0, cx1, 4.4, bz1 + 0.2)
    ctx.floors.push({ min: [cx0, WALL_Z - 0.05], max: [cx1, bz1], y: by })
    ctx.colliders.push({ min: [cx0 - 0.2, -0.5, bz1], max: [cx1, 4.4, bz1 + 0.2] }, { min: [cx0 - 0.2, -0.5, bz0], max: [cx0, 4.4, bz1] })
  }
  // Bay walls: painted block glowing sodium-orange (self-lit so the slot reads like the concept whatever reaches it),
  // with darker recessed mortar joints in 400×200 running bond.
  const glowBlock = materialFor("emissive", { color: 0x5a4632, roughness: 0.85, emissive: new THREE.Color(1, 0.36, 0.07), intensity: 0.4, name: "facility_bay_block" })
  const glowMortar = materialFor("emissive", { color: 0x2a2018, roughness: 0.95, emissive: new THREE.Color(1, 0.36, 0.07), intensity: 0.08, name: "facility_bay_mortar" })
  b.box(glowBlock, bx0 - 0.2, by, bz1, bx1 + 0.2, 4.2, bz1 + 0.2)
  b.box(glowBlock, bx0 - 0.2, by, bz0, bx0, 4.2, bz1)
  b.box(glowBlock, bx1, by, bz0, bx1 + 0.2, 4.2, bz1)
  for (let k = 1; by + k * 0.2 < 4.2; k++) {
    const y = by + k * 0.2
    b.box(glowMortar, bx0, y - 0.006, bz1 - 0.004, bx1, y + 0.006, bz1)
    b.box(glowMortar, bx0, y - 0.006, bz0, bx0 + 0.004, y + 0.006, bz1)
    b.box(glowMortar, bx1 - 0.004, y - 0.006, bz0, bx1, y + 0.006, bz1)
    const off = k % 2 ? 0 : 0.2
    for (let x = bx0 + off; x < bx1; x += 0.4) b.box(glowMortar, x - 0.005, y - 0.2, bz1 - 0.004, x + 0.005, y, bz1)
    for (let z = bz0 + off; z < bz1; z += 0.4) {
      b.box(glowMortar, bx0, y - 0.2, z - 0.005, bx0 + 0.004, y, z + 0.005)
      b.box(glowMortar, bx1 - 0.004, y - 0.2, z - 0.005, bx1, y, z + 0.005)
    }
  }
  // Block skin on the dock wall around the roll-up doors and the man door, from grade up to the first floor band.
  blockSkin(b)
  b.box("concrete_dark", bx0 - 0.2, 4.2, bz0, bx1 + 0.2, 4.4, bz1 + 0.2)
  b.box("metal_painted", bx0 + 2.4, by, bz1 - 0.6, bx0 + 4.4, by + 2.0, bz1 - 0.15)
  b.box("metal_dark", (bx0 + bx1) / 2 - 0.15, 4.0, bz0 + 2.8, (bx0 + bx1) / 2 + 0.15, 4.2, bz0 + 3.2)
  b.box("emissive_sodium", (bx0 + bx1) / 2 - 0.5, 3.92, bz0 + 2.92, (bx0 + bx1) / 2 + 0.5, 4.0, bz0 + 3.08)
  const bayCx = (DOCK_DOORS.open.u0 + DOCK_DOORS.open.u1) / 2
  const SODIUM: [number, number, number] = [1, 0.36, 0.07]
  // Fill inside the bay: paints the block walls and floor deep orange.
  ctx.lamps.push({ kind: "sodium", position: [bayCx, 3.9, bz0 + 4.2], direction: [0, -0.94, 0.34], color: SODIUM, intensity: 600, range: 9, angle: 1.2, penumbra: 0.6, size: 0.3 })
  // Small omni deep in the bay: washes the back and side block walls, too short-ranged to reach the truck.
  ctx.lamps.push({ kind: "sodium", position: [bayCx, 2.4, bz1 - 1.3], color: SODIUM, intensity: 300, range: 4, size: 0.2 })
  // Throw out through the half-open door, slightly down onto the dock edge and court; the truck casts its shadow.
  ctx.lamps.push({
    kind: "sodium",
    position: [bayCx, 2.2, bz0 + 1.2],
    direction: [0, -0.32, -0.95],
    color: SODIUM,
    intensity: 800,
    range: 16,
    angle: 0.5,
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
    for (const h of f.holes) if (h.kind === "door") personnelDoor(ctx, root, b, f, h.u0, h.u1, h.y0, h.y1)
  }

}

/** Static guide channels and head box of a roll-up door (the curtain itself is a door leaf). */
function rollupFrame(b: Batch, f: Facade, u0: number, u1: number, y0: number, head: number) {
  const d = 0.17
  for (const u of [u0 - 0.06, u1 - 0.04]) fbox(b, "metal_dark", f, u, u + 0.1, y0, head, d - 0.07, d + 0.07)
  fbox(b, "metal_dark", f, u0 - 0.06, u1 + 0.06, head - 0.04, head + 0.12, d - 0.07, T)
}

function personnelDoor(ctx: WorldContext, root: THREE.Object3D, b: Batch, f: Facade, u0: number, u1: number, y0: number, y1: number) {
  const fr = 0.05
  // Frame round the opening (head and jambs sit outside the clear width), a flush threshold through the wall.
  fbox(b, "metal_dark", f, u0 - fr, u1 + fr, y1, y1 + fr, 0.06, 0.22)
  fbox(b, "metal_dark", f, u0 - fr, u0, y0, y1, 0.06, 0.22)
  fbox(b, "metal_dark", f, u1, u1 + fr, y0, y1, 0.06, 0.22)
  const ta = point(f, u0, 0, -0.05)
  const tb = point(f, u1, 0, T + 0.05)
  ctx.floors.push({ min: [Math.min(ta.x, tb.x), Math.min(ta.z, tb.z)], max: [Math.max(ta.x, tb.x), Math.max(ta.z, tb.z)], y: y0 })
  addFacadeDoor(ctx, root, {
    id: `door-${f.name}-${Math.round(u0)}`,
    f,
    u0: u0 + 0.005,
    u1: u1 - 0.005,
    y0,
    depth: 0.14,
    height: y1 - y0 - 0.01,
    leaf: steelLeaf(`door-${f.name}-${Math.round(u0)}`, u1 - u0 - 0.01, y1 - y0 - 0.01),
    openAngle: 1.75,
    swing: "auto",
    sound: "steel",
  })
  // Step / stoop outside.
  const s0 = point(f, u0 - 0.5, 0, 0)
  const s1 = point(f, u1 + 0.5, y0 > 1 ? 0 : y0, -1.1)
  if (y0 < 1) {
    b.box("concrete_wall", s0.x, -0.05, s0.z, s1.x, y0, s1.z, SKIP_BOTTOM)
    ctx.floors.push({ min: [Math.min(s0.x, s1.x), Math.min(s0.z, s1.z)], max: [Math.max(s0.x, s1.x), Math.max(s0.z, s1.z)], y: y0 })
  }
  // Light head (the security_light model) is placed in props.ts; here its lamp and a glowing lens under the cage.
  const { u: lu, y: lyTop } = lightAbove(f, u0, u1, y1)
  const ly = lyTop + 0.17
  fbox(b, "emissive_sodium", f, lu - 0.09, lu + 0.09, lyTop - 0.05, lyTop + 0.02, -0.32, -0.14)
  const n = normal(f)
  const lp = point(f, lu, ly - 0.05, -0.3)
  const lamp: Lamp = {
    kind: "incandescent",
    position: [lp.x, lp.y, lp.z],
    direction: [n.x * 0.45, -0.89, n.z * 0.45],
    color: [1, 0.7, 0.4],
    intensity: f.name === "main-north" ? 160 : 70,
    range: f.name === "main-north" ? 14 : 10,
    angle: 1.15,
    penumbra: 0.8,
    size: 0.15,
  }
  ctx.lamps.push(lamp)
}


/** Where the wall light over a personnel door sits: the dock man door's wall-pack is set up and off to the side. */
export function lightAbove(f: Facade, u0: number, u1: number, y1: number) {
  if (f.name === "main-north" && u0 === DOCK_DOORS.man.u0) return { u: u1 + 0.75, y: y1 + 0.75 }
  return { u: (u0 + u1) / 2, y: y1 + 0.18 }
}

/** Concrete block skin (proud of the board-formed wall by 5 mm) round the dock openings, up to the first floor band. */
function blockSkin(b: Batch) {
  const f = facades().find((x) => x.name === "main-north")!
  const x0 = -38
  const x1 = -21.5
  const top = band(1).y0
  const D = DOCK_DOORS
  const holes = [D.open, D.closed].map((d) => ({ u0: d.u0, u1: d.u1, y0: D.y0, y1: top })).concat([{ u0: D.man.u0, u1: D.man.u1, y0: D.y0, y1: D.y0 + 2.1 }])
  const ys = [0, D.y0, D.y0 + 2.1, top]
  for (let i = 0; i < ys.length - 1; i++) {
    const ya = ys[i]!
    const yb = ys[i + 1]!
    let u = x0
    for (const h of holes.filter((h) => h.y0 <= ya + 1e-6 && h.y1 >= yb - 1e-6).sort((a, c) => a.u0 - c.u0)) {
      if (h.u0 > u) fbox(b, "concrete_block", f, u, h.u0, ya, yb, -0.005, 0)
      u = h.u1
    }
    if (u < x1) fbox(b, "concrete_block", f, u, x1, ya, yb, -0.005, 0)
  }
}
