import * as THREE from "three/webgpu"
import { BUILDING } from "../layout"
import type { Lamp, WorldContext } from "../context"
import { Batch, SKIP_BOTTOM } from "./geo"
import { DOCK_DOORS, band, facades, fbox, normal, openingFrame, point, type Facade } from "./shell"
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
  dockSteps(ctx, b)

  // Dock bumpers either side of each roll-up door.
  for (const d of [DOCK_DOORS.open, DOCK_DOORS.closed]) {
    for (const x of [d.u0 - 0.35, d.u1 + 0.35]) {
      b.box("rubber", x - 0.14, 0.55, P.z0 - 0.14, x + 0.14, 1.15, P.z0)
      b.box("metal_dark", x - 0.17, 0.5, P.z0 - 0.02, x + 0.17, 1.2, P.z0)
    }
  }

  // Working roll-up doors (E: fully open / shut); the west one is shut, the east one stands about half open on load.

  // Fully open = curtain coiled into the head box (bottom edge 0.1 m under the head).
  const lift = DOCK_DOORS.head - DOCK_DOORS.y0 - 0.1
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

  // Everything inside the shell (behind the roll-ups and the man door) is the interior's receiving room 0-16; only a
  // dock-height threshold through the wall thickness under each roll-up is ours.
  for (const d of [DOCK_DOORS.closed, DOCK_DOORS.open]) {
    b.box("concrete_floor_dry", d.u0 - 0.1, BUILDING.floorY, WALL_Z - 0.01, d.u1 + 0.1, P.y, WALL_Z + T - 0.006, SKIP_BOTTOM)
    ctx.floors.push({ min: [d.u0 - 0.1, WALL_Z - 0.05], max: [d.u1 + 0.1, WALL_Z + T], y: P.y })
  }
  // Block skin on the dock wall around the roll-up doors and the man door, from grade up to the first floor band.
  blockSkin(b)

  // Swing-arm dock lamp beside the open door.
  const ax = DOCK_DOORS.open.u1 + 0.55
  b.box("metal_dark", ax - 0.08, 3.1, WALL_Z - 0.06, ax + 0.08, 3.4, WALL_Z)
  b.strut("metal_dark", new THREE.Vector3(ax, 3.25, WALL_Z - 0.05), new THREE.Vector3(ax - 0.4, 3.35, WALL_Z - 1.0), 0.05, true)
  const head = new THREE.CylinderGeometry(0.12, 0.2, 0.3, 12, 1, true)
  head.rotateX(-Math.PI / 2 - 0.5)
  head.translate(ax - 0.45, 3.32, WALL_Z - 1.1)
  b.add("metal_dark", head)
  // The dock's key light now the bay's fake glow is gone: the swing-arm sodium aimed down over the dock edge and court.
  b.cylinder("emissive_sodium", ax - 0.47, 3.2, WALL_Z - 1.15, 0.1, 0.02, 12)
  ctx.lamps.push({
    kind: "sodium",
    position: [ax - 0.47, 3.18, WALL_Z - 1.15],
    direction: [-0.25, -0.85, -0.46],
    color: [1, 0.5, 0.16],
    intensity: 260,
    range: 14,
    angle: 0.75,
    penumbra: 0.6,
    shadow: true,
    size: 0.2,
  })

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
  openingFrame(b, f, u0, u1, y0, y1, fr)
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
    // Exit doors: panic bar inside, closer.
    panic: true,
    closer: true,
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

/**
 * Solid cast-in-place concrete steps from the court up to the dock (1.25 m): 7 equal risers (~179 mm) and 280 mm
 * goings descending east from the platform, each step a solid block down to the ground, and a continuous 42 mm pipe
 * handrail on the open side with posts landing on treads, a level extension at each end and returns down to the posts.
 */
function dockSteps(ctx: WorldContext, b: Batch) {
  const P = PLATFORM
  const N = 7
  const rise = P.y / N
  const go = 0.28
  const z0 = P.z1 - 2.4
  const z1 = P.z1 - 0.4
  for (let i = 1; i < N; i++) {
    const h = P.y - i * rise
    const xa = P.x1 + (i - 1) * go
    const xb = P.x1 + i * go
    b.box("concrete_wall", xa, -0.05, z0, xb, h, z1, SKIP_BOTTOM)
    ctx.floors.push({ min: [xa, z0], max: [xb, z1], y: h })
  }
  // Handrail on the open (south) edge: 900 mm above the nosing line.
  const zr = z0 + 0.06
  const R = 0.042
  const top = P.y + 0.9
  const nosing = (x: number) => P.y - ((x - P.x1) / go) * rise
  const xEnd = P.x1 + (N - 1) * go
  const pts = [
    new THREE.Vector3(P.x1 - 0.3, top, zr),
    new THREE.Vector3(P.x1, top, zr),
    new THREE.Vector3(xEnd, nosing(xEnd) + 0.9, zr),
    new THREE.Vector3(xEnd + go, nosing(xEnd) + 0.9, zr),
  ]
  for (let k = 0; k < pts.length - 1; k++) b.strut("metal_galvanized", pts[k]!, pts[k + 1]!, R, true)
  // Posts: on the platform at the top, on tread 3, and on the ground past the bottom step; the rail ends turn down.
  const posts: [number, number][] = [
    [P.x1 - 0.3, P.y],
    [P.x1 + 2.5 * go, P.y - 3 * rise],
    [xEnd + go, 0],
  ]
  for (const [x, base] of posts) {
    const railY = x <= P.x1 ? top : x >= xEnd ? nosing(xEnd) + 0.9 : nosing(x) + 0.9
    b.cylinder("metal_galvanized", x, base, zr, R / 2, railY - base, 10)
    b.cylinder("metal_galvanized", x, base, zr, 0.045, 0.012, 12)
  }
  // Collider along the rail so the open side can't be walked off.
  ctx.colliders.push({ min: [P.x1 - 0.3, 0, zr - 0.03], max: [xEnd + go, top, zr + 0.03] })
}
