import * as THREE from "three/webgpu"
import type { WorldContext } from "../context"
import { heightAt } from "../height"
import { BOOTH } from "../layout"
import { material } from "../../render/materials"
import { Batch, box, cyl, lathe, matrix, plane, rod, sphere } from "./geo"
import { boothGlass, flat, glow, wood } from "./mats"
import { sodiumPole } from "./lamps"

// The guard booth by the gate: a 1980s precast concrete hut with glass on all four sides, a flat overhanging roof and
// a single warm bulb inside, so it reads as a glowing orange box in the fog (concept r5-03 / r3-01). The door on the
// south face stands open and the floor is walkable.

export const FY = 0.2
const SILL = 1.05
export const HEAD = 2.15
const TOP = 2.55
export const WALL = 0.14

/** Paved apron west of the gate, outside the fence, where the hero wagon is parked (clear of the access road's
 *  west shoulder at x ≈ -4.4 and of the gate leaves, which swing inward). */
const APRON = { x0: -12.6, x1: -4.8, z0: 133.4, z1: 142.2 }
export const WAGON_APRON = { x: -8.2, y: 0.03, z: 137.8 }

export function buildBooth(ctx: WorldContext, root: THREE.Object3D) {
  buildApron(ctx, root)
  const { x, z, w, d } = BOOTH
  const y0 = heightAt(x, z)
  const hw = w / 2
  const hd = d / 2
  const batch = new Batch()
  const b = batch.child(matrix(x, y0, z))
  const concrete = material("concrete_wall")
  const dark = material("concrete_dark")
  const frame = material("metal_dark")
  const inner = flat(0x553416, 0.9)
  const glass = boothGlass()

  // Raised concrete island the booth, boom and lamp stand on, with a curb nose facing the road.
  const island = { x0: 4.9 - x, x1: 11.8 - x, z0: 124.3 - z, z1: 131.4 - z }
  const ISLAND = 0.12
  const iw = island.x1 - island.x0
  const id = island.z1 - island.z0
  b.at(material("concrete_floor"), box(iw, ISLAND, id), (island.x0 + island.x1) / 2, ISLAND / 2, (island.z0 + island.z1) / 2)
  b.at(flat(0x8a7a3a, 0.7), box(0.2, 0.006, id + 0.02), island.x0 + 0.1, ISLAND + 0.002, (island.z0 + island.z1) / 2)
  ctx.floors.push({ min: [x + island.x0, z + island.z0], max: [x + island.x1, z + island.z1], y: y0 + ISLAND })

  // Plinth, step and interior floor.
  b.at(dark, box(w + 0.3, FY, d + 0.3), 0, FY / 2, 0)
  b.at(material("linoleum"), plane(w - 2 * WALL, d - 2 * WALL), 0, FY + 0.004, 0)

  // Corner columns.
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.at(concrete, box(0.2, TOP - FY, 0.2), sx * (hw - 0.1), (FY + TOP) / 2, sz * (hd - 0.1))

  // Knee walls, header band and inner skin. `span` is along the wall from a to b; the door gap is on the south side.
  // Clear opening between the frame's jamb faces; the frame (JAMB wide) sits outside it, the east jamb against the
  // corner column, the west one against a short concrete pier that ends the south window.
  const DOOR = { a: 0.5, b: 1.45 }
  const JAMB = 0.05
  const wallX = (sx: number, a: number, c: number, y1: number, y2: number) => {
    b.at(concrete, box(WALL, y2 - y1, c - a), sx * (hw - WALL / 2), (y1 + y2) / 2, (a + c) / 2)
    b.at(inner, box(0.01, y2 - y1, c - a), sx * (hw - WALL - 0.005), (y1 + y2) / 2, (a + c) / 2)
  }
  const wallZ = (sz: number, a: number, c: number, y1: number, y2: number) => {
    b.at(concrete, box(c - a, y2 - y1, WALL), (a + c) / 2, (y1 + y2) / 2, sz * (hd - WALL / 2))
    b.at(inner, box(c - a, y2 - y1, 0.01), (a + c) / 2, (y1 + y2) / 2, sz * (hd - WALL - 0.005))
  }
  wallX(-1, -hd + 0.2, hd - 0.2, FY, SILL)
  wallX(1, -hd + 0.2, hd - 0.2, FY, SILL)
  wallZ(-1, -hw + 0.2, hw - 0.2, FY, SILL)
  wallZ(1, -hw + 0.2, DOOR.a - JAMB, FY, SILL)
  wallX(-1, -hd + 0.2, hd - 0.2, HEAD, TOP)
  wallX(1, -hd + 0.2, hd - 0.2, HEAD, TOP)
  wallZ(-1, -hw + 0.2, hw - 0.2, HEAD, TOP)
  wallZ(1, -hw + 0.2, hw - 0.2, HEAD, TOP)
  // Concrete pier between the south window and the door frame.
  const PIER = 0.1
  b.at(concrete, box(PIER, HEAD - SILL, WALL), DOOR.a - JAMB - PIER / 2, (SILL + HEAD) / 2, hd - WALL / 2)

  // Window sills, frames, mullions and glass.
  const winX = (sx: number) => {
    const len = d - 0.4
    const px = sx * (hw - WALL / 2)
    b.at(dark, box(0.26, 0.05, len), px + sx * 0.04, SILL + 0.025, 0)
    b.add(glass, planeX(len, HEAD - SILL - 0.05), matrix(px, (SILL + HEAD) / 2 + 0.025, 0))
    for (const zz of [-len / 2, 0, len / 2]) b.at(frame, box(0.06, HEAD - SILL, 0.05), px, (SILL + HEAD) / 2, zz)
    b.at(frame, box(0.06, 0.04, len), px, HEAD - 0.02, 0)
    b.at(frame, box(0.07, 0.035, len), px, SILL + 0.06, 0)
  }
  const winZ = (sz: number, a: number, c: number, mid: boolean) => {
    const len = c - a
    const pz = sz * (hd - WALL / 2)
    const cx = (a + c) / 2
    b.at(dark, box(len, 0.05, 0.26), cx, SILL + 0.025, pz + sz * 0.04)
    b.add(glass, planeZ(len, HEAD - SILL - 0.05), matrix(cx, (SILL + HEAD) / 2 + 0.025, pz))
    for (const xx of mid ? [a, cx, c] : [a, c]) b.at(frame, box(0.05, HEAD - SILL, 0.06), xx, (SILL + HEAD) / 2, pz)
    b.at(frame, box(len, 0.04, 0.06), cx, HEAD - 0.02, pz)
    b.at(frame, box(len, 0.035, 0.07), cx, SILL + 0.06, pz)
  }
  winX(-1)
  winX(1)
  winZ(-1, -hw + 0.2, hw - 0.2, true)
  winZ(1, -hw + 0.2, DOOR.a - JAMB - PIER, false)

  // Flat roof with a deep overhang, metal fascia and a ceiling inside.
  b.at(dark, box(w + 0.75, 0.26, d + 0.75), 0, TOP + 0.13, 0)
  b.at(frame, box(w + 0.79, 0.07, d + 0.79), 0, TOP + 0.29, 0)
  b.at(flat(0x4a3018, 0.9), box(w - 2 * WALL, 0.02, d - 2 * WALL), 0, TOP - 0.01, 0)
  // Roof vent and conduit down the east column to a junction box.
  b.at(frame, cyl(0.09, 0.09, 0.3, 8), -0.7, TOP + 0.45, -0.6)
  b.at(frame, cyl(0.13, 0.13, 0.04, 8), -0.7, TOP + 0.62, -0.6)
  b.add(material("metal_galvanized"), rod({ x: hw + 0.03, y: 0.5, z: -hd + 0.25 }, { x: hw + 0.03, y: TOP, z: -hd + 0.25 }, 0.018, 6))
  b.at(flat(0x55574c, 0.6, 0.3), box(0.08, 0.36, 0.28), hw + 0.04, 0.55, -hd + 0.4)

  doorFrame(b, DOOR.a, DOOR.b, JAMB, hd)

  furnish(b)

  batch.build(root, { castShadow: (m) => m !== glass, name: "booth" })

  // A warm bulb under the ceiling plus the space heater's glow.
  ctx.lamps.push({ kind: "incandescent", position: [x, y0 + TOP - 0.2, z], color: [1, 0.48, 0.16], intensity: 150, range: 14, size: 0.25 })

  // Sodium davit lamp at the booth's south-west corner, reaching over the lane (concept r3-01 / r5-03).
  const poles = new Batch()
  sodiumPole(ctx, poles, { x: x - hw - 0.55, z: z + hd + 0.7, height: 6.4, heading: Math.PI, arm: 2.1, style: "cobra", state: "on", shadow: true, intensity: 3000, range: 30 })
  poles.build(root, { castShadow: true, name: "booth-pole" })

  // Colliders: four walls (door gap south), the open door leaf and the counter.
  const t = 0.16
  const top = y0 + TOP + 0.3
  ctx.colliders.push({ min: [x - hw, y0, z - hd], max: [x - hw + t, top, z + hd] })
  ctx.colliders.push({ min: [x + hw - t, y0, z - hd], max: [x + hw, top, z + hd] })
  ctx.colliders.push({ min: [x - hw, y0, z - hd], max: [x + hw, top, z - hd + t] })
  ctx.colliders.push({ min: [x - hw, y0, z + hd - t], max: [x + DOOR.a - 0.005, top, z + hd] })
  ctx.colliders.push({ min: [x + DOOR.b + 0.005, y0, z + hd - t], max: [x + hw, top, z + hd] })
  ctx.colliders.push({ min: [x - hw, y0, z - hd], max: [x - hw + 0.8, y0 + FY + 0.95, z + hd] })
  ctx.floors.push({ min: [x - hw - 0.15, z - hd - 0.15], max: [x + hw + 0.15, z + hd + 0.15], y: y0 + FY })

  // The door: its own hinged leaf on the east jamb, driven by the shared door system. It swings either way (away from
  // the player); 85° (plus the system's ~4 % overshoot) stops short of the floor stop outside and the wall bumper
  // inside, and the rounded hinge edge keeps the leaf clear of the jamb at every angle.
  const gap = 0.003
  const axisX = DOOR.b - gap - LEAF_T / 2
  const leafW = DOOR.b - DOOR.a - 2 * gap
  // Leaf bottom clears the 8 mm threshold plate by the same 3 mm gap as the jambs and head.
  const lift = THRESHOLD + gap
  const leafH = HEAD - JAMB - FY - lift - gap
  const leaf = new THREE.Group()
  leaf.name = "booth-door"
  doorLeaf(leaf, leafW, leafH, lift, glass)
  root.add(leaf)
  const leafZ = hd - WALL / 2
  ctx.doors.add({
    id: "booth",
    leaf,
    hinge: [x + axisX, y0 + FY, z + leafZ],
    width: -(leafW - LEAF_T / 2),
    height: leafH,
    thickness: LEAF_T,
    openAngle: (85 * Math.PI) / 180,
    swing: "auto",
    startOpen: 0,
    sound: "steel",
  })
  // Stops: a floor stop on the island outside and a rubber-tipped bumper on the east wall inside, both where the
  // leaf face would sit at 90°.
  const stop = batch.child(matrix(x, y0, z))
  const reach = leafW * 0.88
  const sx = axisX + LEAF_T / 2 + 0.03
  stop.at(material("metal_dark"), cyl(0.028, 0.034, 0.012, 14), sx, 0.126, leafZ + reach)
  stop.at(material("chrome"), cyl(0.014, 0.016, 0.16, 12), sx, 0.2, leafZ + reach)
  stop.at(material("rubber"), lathe([[0, 0], [0.024, 0], [0.026, 0.02], [0.02, 0.045], [0, 0.05]], 14), sx, 0.27, leafZ + reach)
  const wallIn = hw - WALL - 0.01
  stop.at(material("metal_dark"), cyl(0.03, 0.03, 0.01, 14), wallIn - 0.005, FY + 0.95, leafZ - reach, 0, 0, Math.PI / 2)
  stop.at(material("chrome"), cyl(0.012, 0.012, wallIn - sx - 0.03, 10), (wallIn + sx + 0.03) / 2, FY + 0.95, leafZ - reach, 0, 0, Math.PI / 2)
  stop.at(material("rubber"), cyl(0.022, 0.022, 0.03, 14), sx + 0.015, FY + 0.95, leafZ - reach, 0, 0, Math.PI / 2)
  stop.build(root, { castShadow: false, name: "booth-stops" })
  ctx.colliders.push({ min: [x + sx - 0.04, y0, z + leafZ + reach - 0.04], max: [x + sx + 0.04, y0 + 0.32, z + leafZ + reach + 0.04] })
}

const LEAF_T = 0.045
/** Threshold plate height (its top sits 4 mm above the linoleum). */
const THRESHOLD = 0.008

/**
 * Continuous hollow-metal frame around the opening: two jambs and a head of the same rolled profile (a face, two
 * returns wrapping the wall, a soffit), meeting in mitred corners, plus a flush steel threshold plate.
 */
function doorFrame(b: Batch, xa: number, xb: number, J: number, hd: number) {
  const steel = material("door_steel")
  const seam = flat(0x0a0a0a, 0.9)
  const depth = WALL + 0.02
  const zc = hd - WALL / 2
  const top = HEAD
  const yOpen = HEAD - J
  // Profile as a closed outline in (across, along-depth): face strips proud of each wall face, a soffit across the
  // depth, and a raised stop bead in the middle.
  const member = (len: number) => {
    const s = new THREE.Shape()
    const d2 = depth / 2
    s.moveTo(0, -d2)
    s.lineTo(J, -d2)
    s.lineTo(J, -d2 + 0.012)
    s.lineTo(0.012, -d2 + 0.012)
    s.lineTo(0.012, -0.006)
    s.lineTo(0, -0.006)
    s.lineTo(0, 0.006)
    s.lineTo(0.012, 0.006)
    s.lineTo(0.012, d2 - 0.012)
    s.lineTo(J, d2 - 0.012)
    s.lineTo(J, d2)
    s.lineTo(0, d2)
    s.closePath()
    return new THREE.ExtrudeGeometry(s, { depth: len, bevelEnabled: false })
  }
  // Jambs: profile in XZ (x = across from the opening face outward), extruded up Y from the floor to the head top.
  const jamb = (x: number, dir: 1 | -1) => {
    const g = member(top - FY)
    g.rotateX(-Math.PI / 2) // extrude axis +Z → +Y; profile y → -z
    if (dir < 0) g.rotateY(Math.PI) // profile is symmetric in depth, so a half turn mirrors it without flipping winding
    g.translate(x, FY, zc)
    return g
  }
  b.add(steel, jamb(xb, 1))
  b.add(steel, jamb(xa, -1))
  // Head: same profile, across from the opening face upward, extruded along X between the jambs' outer faces.
  const hg = member(xb - xa + 2 * J)
  // Map (u = profile x, v = profile y, w = extrude) → (X = w, Y = u, Z = v): a proper rotation, winding kept.
  hg.applyMatrix4(new THREE.Matrix4().set(0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1))
  hg.translate(xa - J, yOpen, zc)
  b.add(steel, hg)
  // Mitre lines at the two head corners on both faces.
  const m = Math.SQRT2 * J
  for (const [cx, rz] of [
    [xb + J / 2, -Math.PI / 4],
    [xa - J / 2, Math.PI / 4],
  ] as const)
    for (const sz of [-1, 1]) b.at(seam, box(0.003, m, 0.002), cx, yOpen + J / 2, zc + sz * (depth / 2 + 0.001), 0, 0, rz)
  // Flush threshold plate across the full frame depth, with a ribbed tread.
  b.at(material("metal_dark"), box(xb - xa + 2 * J, THRESHOLD, depth), (xa + xb) / 2, FY + THRESHOLD / 2, zc)
  for (let k = -3; k <= 3; k++) b.at(seam, box(xb - xa, 0.006, 0.004), (xa + xb) / 2, FY + THRESHOLD + 0.001, zc + k * 0.018)
}

/**
 * A 1980s hollow-metal door. The hinge axis is the local origin; the hinge edge is rounded about it (radius T/2) so it
 * never sweeps into the jamb, and the leaf extends to -x, `w` long, `h` tall, raised `lift` off the floor. Stiles and
 * rails frame a glazed upper panel and a pressed lower panel; kick plates, three butt hinges and lever sets.
 */
function doorLeaf(parent: THREE.Object3D, w: number, h: number, lift: number, glass: THREE.Material) {
  const b = new Batch()
  const steel = material("door_steel")
  const dark = material("metal_dark")
  const chrome = material("chrome")
  const T = LEAF_T
  const r = T / 2
  const L = w - r // flat part of the leaf, from x = 0 to -L
  const stile = 0.12
  const y = (v: number) => lift + v
  const gy0 = 1.05
  const gy1 = h - 0.16
  // Rounded hinge edge.
  b.at(steel, cyl(r, r, h, 14), 0, y(h / 2), 0)
  // Stiles full height, bottom rail, lock rail, top rail.
  b.at(steel, box(stile, h, T), -stile / 2, y(h / 2), 0)
  b.at(steel, box(stile, h, T), -L + stile / 2, y(h / 2), 0)
  b.at(steel, box(L - 2 * stile, 0.22, T), -L / 2, y(0.11), 0)
  b.at(steel, box(L - 2 * stile, 0.16, T), -L / 2, y(gy0 - 0.08), 0)
  b.at(steel, box(L - 2 * stile, h - gy1, T), -L / 2, y((gy1 + h) / 2), 0)
  // Pressed lower panel (slightly recessed) with its edge lines.
  b.at(steel, box(L - 2 * stile, gy0 - 0.38, T * 0.6), -L / 2, y((0.22 + gy0 - 0.16) / 2), 0)
  for (const sz of [-1, 1]) {
    b.at(dark, box(L - 2 * stile, 0.01, 0.004), -L / 2, y(gy0 - 0.165), sz * (T * 0.3 + 0.002))
    b.at(dark, box(L - 2 * stile, 0.01, 0.004), -L / 2, y(0.225), sz * (T * 0.3 + 0.002))
    b.at(chrome, box(L - 0.04, 0.2, 0.004), -L / 2, y(0.12), sz * (T / 2 + 0.002))
  }
  // Glazed vision panel with glazing stops.
  b.add(glass, planeZ(L - 2 * stile, gy1 - gy0), matrix(-L / 2, y((gy0 + gy1) / 2), 0))
  for (const sz of [-1, 1]) {
    b.at(dark, box(L - 2 * stile, 0.02, 0.012), -L / 2, y(gy0 + 0.01), sz * 0.012)
    b.at(dark, box(L - 2 * stile, 0.02, 0.012), -L / 2, y(gy1 - 0.01), sz * 0.012)
    b.at(dark, box(0.02, gy1 - gy0, 0.012), -stile - 0.01, y((gy0 + gy1) / 2), sz * 0.012)
    b.at(dark, box(0.02, gy1 - gy0, 0.012), -L + stile + 0.01, y((gy0 + gy1) / 2), sz * 0.012)
  }
  // Butt hinge knuckles on the axis (inside the rounded edge's radius, so they turn in place).
  for (const v of [0.25, h / 2 + 0.1, h - 0.25]) {
    b.at(dark, cyl(r + 0.004, r + 0.004, 0.1, 14), 0, y(v), 0)
    b.at(dark, cyl(r + 0.0055, r + 0.0055, 0.004, 14), 0, y(v + 0.052), 0)
  }
  // Lever sets near the latch edge on both faces: round rose, lever, key escutcheon below.
  for (const sz of [-1, 1]) {
    const z = sz * (T / 2)
    const hx = -L + 0.075
    b.at(chrome, cyl(0.03, 0.032, 0.008, 18), hx, y(1.03), z + sz * 0.004, 0, Math.PI / 2)
    b.at(chrome, cyl(0.009, 0.009, 0.05, 10), hx, y(1.03), z + sz * 0.03, 0, Math.PI / 2)
    b.at(chrome, cyl(0.009, 0.009, 0.12, 10), hx + 0.06, y(1.03), z + sz * 0.055, 0, 0, Math.PI / 2)
    b.at(chrome, sphere(0.011, 10, 6), hx + 0.12, y(1.03), z + sz * 0.055)
    b.at(chrome, cyl(0.016, 0.016, 0.006, 14), hx, y(0.93), z + sz * 0.003, 0, Math.PI / 2)
    b.at(dark, box(0.004, 0.014, 0.002), hx, y(0.93), z + sz * 0.0065)
  }
  b.build(parent, { castShadow: (m) => m !== glass, name: "booth-door" })
}

/** A thin flat slab with rounded corners (clipboards, book covers), lying on y = 0. */
function roundedSlab(w: number, d: number, t: number, r: number) {
  const s = new THREE.Shape()
  s.moveTo(-w / 2 + r, -d / 2)
  s.lineTo(w / 2 - r, -d / 2)
  s.quadraticCurveTo(w / 2, -d / 2, w / 2, -d / 2 + r)
  s.lineTo(w / 2, d / 2 - r)
  s.quadraticCurveTo(w / 2, d / 2, w / 2 - r, d / 2)
  s.lineTo(-w / 2 + r, d / 2)
  s.quadraticCurveTo(-w / 2, d / 2, -w / 2, d / 2 - r)
  s.lineTo(-w / 2, -d / 2 + r)
  s.quadraticCurveTo(-w / 2, -d / 2, -w / 2 + r, -d / 2)
  const g = new THREE.ExtrudeGeometry(s, { depth: t, bevelEnabled: false, curveSegments: 4 })
  g.rotateX(-Math.PI / 2)
  return g
}

/** Glass pane in the YZ plane. */
function planeX(len: number, h: number) {
  const g = new THREE.PlaneGeometry(len, h)
  g.rotateY(Math.PI / 2)
  return g
}

/** Glass pane in the XY plane. */
function planeZ(len: number, h: number) {
  return new THREE.PlaneGeometry(len, h)
}

/** Counter along the road-side window with the guard's smaller things, a heater and a clock (the terminal, phone and
 * chair are models, see compound/models.ts). */
function furnish(b: Batch) {
  const hw = BOOTH.w / 2
  const hd = BOOTH.d / 2
  const top = FY + 0.74
  const deskX = -hw + WALL + 0.31
  const deskW = 0.62
  const len = BOOTH.d - 2 * WALL - 0.04
  const counter = wood(0x3a2416, 0x5a3a22, 0.45)
  const beige = flat(0x8d8672, 0.55)
  b.at(counter, box(deskW, 0.04, len), deskX, top + 0.02, 0)
  b.at(material("metal_painted"), box(0.03, 0.7, len), deskX + deskW / 2 - 0.02, FY + 0.37, 0)
  b.at(material("metal_painted"), box(deskW - 0.06, 0.02, len), deskX, FY + 0.18, 0)
  const surface = top + 0.04

  // Clipboard with a sheet and its spring clip.
  const clip = b.child(matrix(deskX + 0.08, surface, 0.72, 0.2))
  clip.at(wood(0x5a4026, 0x6e5030), roundedSlab(0.23, 0.32, 0.006, 0.012), 0, 0, 0)
  clip.at(flat(0xd2ccb8, 0.9), box(0.21, 0.002, 0.27), 0, 0.007, 0.018)
  clip.at(flat(0xc8c2ae, 0.9), box(0.205, 0.004, 0.265), 0.004, 0.010, 0.022, 0.03)
  clip.at(material("chrome"), roundedSlab(0.1, 0.035, 0.008, 0.008), 0, 0.007, -0.135)
  clip.at(material("chrome"), cyl(0.005, 0.005, 0.1, 8), 0, 0.016, -0.15, 0, 0, Math.PI / 2)
  // Steel vacuum flask with its cup-lid, a stoneware mug and a pencil tin.
  const flask = b.child(matrix(deskX - 0.17, surface, 1.0))
  flask.add(flat(0x2c4a3a, 0.35, 0.3), lathe([[0, 0], [0.042, 0], [0.046, 0.01], [0.046, 0.24], [0.04, 0.27], [0.03, 0.28], [0, 0.28]], 24))
  flask.add(material("chrome"), lathe([[0.0465, 0.02], [0.0475, 0.02], [0.0475, 0.03], [0.0465, 0.03]], 24))
  flask.add(flat(0x8a1e14, 0.4), lathe([[0, 0.278], [0.042, 0.278], [0.047, 0.29], [0.049, 0.35], [0.047, 0.355], [0, 0.355]], 24))
  const mug = b.child(matrix(deskX + 0.14, surface, 0.48, 0.8))
  const cream = flat(0xcfc8b4, 0.25)
  mug.add(cream, lathe([[0, 0], [0.036, 0], [0.04, 0.008], [0.04, 0.095], [0.036, 0.095], [0.034, 0.012], [0, 0.012]], 24))
  mug.add(flat(0x1c120a, 0.15), lathe([[0, 0.07], [0.0345, 0.07]], 20))
  mug.add(cream, new THREE.TorusGeometry(0.026, 0.006, 8, 16, Math.PI), matrix(0.04, 0.048, 0, 0, 0, -Math.PI / 2))
  const tin = b.child(matrix(deskX - 0.18, surface, 0.42))
  tin.add(flat(0x2b2b28, 0.4, 0.5), lathe([[0, 0], [0.033, 0], [0.035, 0.004], [0.035, 0.1], [0.032, 0.1], [0.032, 0.006], [0, 0.006]], 20))
  for (const [px, pz, rx, rz, c] of [
    [0.01, 0.0, 0.12, 0.05, 0xb8901c],
    [-0.012, 0.008, -0.1, 0.12, 0xb8901c],
    [0.004, -0.014, 0.06, -0.14, 0x1a3a6a],
  ] as const) {
    tin.at(flat(c, 0.5), cyl(0.0035, 0.0035, 0.17, 6), px, 0.09, pz, 0, rx, rz)
  }
  // Logbook: hard covers overhanging a page block, a ribbon marker.
  const book = b.child(matrix(deskX - 0.02, surface, -0.1, 0.05))
  const cover = flat(0x1f2e45, 0.7)
  book.at(cover, roundedSlab(0.22, 0.3, 0.004, 0.004), 0, 0, 0)
  book.at(flat(0xd8d0b8, 0.95), box(0.21, 0.022, 0.29), 0.004, 0.015, 0)
  book.at(cover, roundedSlab(0.22, 0.3, 0.004, 0.004), 0, 0.026, 0)
  book.at(cover, cyl(0.016, 0.016, 0.3, 10, true), -0.108, 0.015, 0, 0, Math.PI / 2)
  book.at(flat(0x7a1610, 0.6), box(0.008, 0.002, 0.06), 0.03, 0.031, 0.17)

  // Period radiant heater in the north-east corner: a rounded steel housing on a foot, a polished reflector behind a
  // chrome guard grille, two glowing quartz elements.
  const heater = b.child(matrix(hw - WALL - 0.24, FY, -hd + WALL + 0.2, -0.6))
  const shell = flat(0x5e5446, 0.45, 0.4)
  const HW = 0.34
  const HH = 0.3
  const housing = new THREE.Shape()
  const rr = 0.05
  housing.moveTo(-HW / 2 + rr, 0)
  housing.lineTo(HW / 2 - rr, 0)
  housing.quadraticCurveTo(HW / 2, 0, HW / 2, rr)
  housing.lineTo(HW / 2, HH - rr)
  housing.quadraticCurveTo(HW / 2, HH, HW / 2 - rr, HH)
  housing.lineTo(-HW / 2 + rr, HH)
  housing.quadraticCurveTo(-HW / 2, HH, -HW / 2, HH - rr)
  housing.lineTo(-HW / 2, rr)
  housing.quadraticCurveTo(-HW / 2, 0, -HW / 2 + rr, 0)
  const opening = new THREE.Path()
  opening.moveTo(-HW / 2 + 0.03, 0.04)
  opening.lineTo(HW / 2 - 0.03, 0.04)
  opening.lineTo(HW / 2 - 0.03, HH - 0.04)
  opening.lineTo(-HW / 2 + 0.03, HH - 0.04)
  opening.closePath()
  housing.holes.push(opening)
  const shellGeo = new THREE.ExtrudeGeometry(housing, { depth: 0.13, bevelEnabled: true, bevelThickness: 0.008, bevelSize: 0.008, bevelSegments: 3, curveSegments: 6 })
  shellGeo.translate(0, 0.08, -0.065)
  heater.add(shell, shellGeo)
  // Reflector: a curved polished trough behind the elements.
  const trough = new THREE.CylinderGeometry(0.11, 0.11, HW - 0.07, 18, 1, true, Math.PI * 0.5, Math.PI)
  trough.rotateZ(Math.PI / 2)
  heater.add(material("chrome"), trough, matrix(0, 0.08 + HH / 2, -0.01))
  // Elements: quartz tubes glowing deep orange with brighter cores, on ceramic end caps.
  for (const ey of [0.08 + HH / 2 - 0.05, 0.08 + HH / 2 + 0.05]) {
    heater.at(glow(1, 0.3, 0.06, 2.6), cyl(0.009, 0.009, HW - 0.09, 10), 0, ey, 0.01, 0, 0, Math.PI / 2)
    heater.at(glow(1, 0.5, 0.15, 5), cyl(0.004, 0.004, HW - 0.1, 8), 0, ey, 0.01, 0, 0, Math.PI / 2)
    for (const ex of [-1, 1]) heater.at(flat(0xd8d0c0, 0.6), cyl(0.014, 0.014, 0.02, 10), ex * (HW / 2 - 0.045), ey, 0.01, 0, 0, Math.PI / 2)
  }
  // Guard grille: horizontal chrome wires across the opening and a centre badge.
  for (let gy = 0.08 + 0.05; gy < 0.08 + HH - 0.04; gy += 0.022) heater.at(material("chrome"), cyl(0.0022, 0.0022, HW - 0.06, 5), 0, gy, 0.075, 0, 0, Math.PI / 2)
  for (const gx of [-0.08, 0, 0.08]) heater.at(material("chrome"), cyl(0.0025, 0.0025, HH - 0.08, 5), gx, 0.08 + HH / 2, 0.077)
  // Foot and stem, control knob on the side.
  heater.add(shell, lathe([[0, 0], [0.1, 0], [0.11, 0.008], [0.09, 0.022], [0.02, 0.03], [0, 0.03]], 24), matrix(0, 0, 0))
  heater.at(material("chrome"), cyl(0.014, 0.014, 0.06, 10), 0, 0.055, 0)
  heater.at(flat(0x1a1a18, 0.5), cyl(0.018, 0.018, 0.02, 14), HW / 2 + 0.012, 0.08 + HH - 0.06, 0, 0, 0, Math.PI / 2)
  heater.add(flat(0x1a1a18, 0.5), rod({ x: HW / 2 - 0.05, y: 0.09, z: -0.07 }, { x: HW / 2 + 0.05, y: 0.004, z: -0.4 }, 0.0035, 5))

  // Ceiling fixture: a frosted drum diffuser glowing warm, the way the concept's booth reads from the road.
  b.at(material("metal_painted"), cyl(0.24, 0.24, 0.03, 20), 0, TOP - 0.035, 0)
  b.at(glow(1, 0.4, 0.1, 3), cyl(0.21, 0.19, 0.1, 20), 0, TOP - 0.1, 0)
}

/** Wet asphalt apron with a broken concrete curb on its west and north edges and a faded stop bar. */
function buildApron(ctx: WorldContext, root: THREE.Object3D) {
  const b = new Batch()
  const { x0, x1, z0, z1 } = APRON
  const y = WAGON_APRON.y
  b.at(material("asphalt_lot"), plane(x1 - x0, z1 - z0), (x0 + x1) / 2, y, (z0 + z1) / 2)
  const curb = material("concrete_wall")
  b.at(curb, box(0.18, 0.14, z1 - z0), x0 - 0.09, 0.07, (z0 + z1) / 2)
  b.at(curb, box(x1 - x0 + 0.18, 0.14, 0.18), (x0 + x1) / 2 - 0.09, 0.07, z0 - 0.09)
  b.at(material("road_line_white"), plane(0.1, 5.2), x0 + 1.0, y + 0.006, (z0 + z1) / 2)
  b.build(root, { castShadow: false, name: "apron" })
  ctx.floors.push({ min: [x0, z0], max: [x1, z1], y })
}
