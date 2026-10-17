import * as THREE from "three/webgpu"
import type { WorldContext } from "../context"
import { heightAt } from "../height"
import { BOOTH } from "../layout"
import { material } from "../../render/materials"
import { Batch, box, cyl, matrix, plane, rod, sphere } from "./geo"
import { boothGlass, flat, glow, wood } from "./mats"
import { sodiumPole } from "./lamps"

// The guard booth by the gate: a 1980s precast concrete hut with glass on all four sides, a flat overhanging roof and
// a single warm bulb inside, so it reads as a glowing orange box in the fog (concept r5-03 / r3-01). The door on the
// south face stands open and the floor is walkable.

export const FY = 0.2
const SILL = 1.05
const HEAD = 2.15
const TOP = 2.55
export const WALL = 0.14

export function buildBooth(ctx: WorldContext, root: THREE.Object3D) {
  const { x, z, w, d } = BOOTH
  const y0 = heightAt(x, z)
  const hw = w / 2
  const hd = d / 2
  const batch = new Batch()
  const b = batch.child(matrix(x, y0, z))
  const concrete = material("concrete_wall")
  const dark = material("concrete_dark")
  const frame = material("metal_dark")
  const inner = flat(0xa39d84, 0.85)
  const glass = boothGlass()

  // Raised concrete island the booth, boom and lamp stand on, with a curb nose facing the road.
  const island = { x0: 4.9 - x, x1: 11.8 - x, z0: 124.3 - z, z1: 131.4 - z }
  const ISLAND = 0.12
  const iw = island.x1 - island.x0
  const id = island.z1 - island.z0
  b.at(material("concrete_floor"), box(iw, ISLAND, id), (island.x0 + island.x1) / 2, ISLAND / 2, (island.z0 + island.z1) / 2)
  b.at(flat(0x8a7a3a, 0.7), box(0.2, 0.005, id + 0.02), island.x0 + 0.1, ISLAND + 0.001, (island.z0 + island.z1) / 2)
  ctx.floors.push({ min: [x + island.x0, z + island.z0], max: [x + island.x1, z + island.z1], y: y0 + ISLAND })

  // Plinth, step and interior floor.
  b.at(dark, box(w + 0.3, FY, d + 0.3), 0, FY / 2, 0)
  b.at(dark, box(1.3, 0.1, 0.4), 1.0, 0.05, hd + 0.35)
  b.at(material("linoleum"), plane(w - 2 * WALL, d - 2 * WALL), 0, FY + 0.004, 0)

  // Corner columns.
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.at(concrete, box(0.2, TOP - FY, 0.2), sx * (hw - 0.1), (FY + TOP) / 2, sz * (hd - 0.1))

  // Knee walls, header band and inner skin. `span` is along the wall from a to b; the door gap is on the south side.
  const DOOR = { a: 0.45, b: 1.45 }
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
  wallZ(1, -hw + 0.2, DOOR.a, FY, SILL)
  wallZ(1, DOOR.b, hw - 0.2, FY, SILL)
  wallX(-1, -hd + 0.2, hd - 0.2, HEAD, TOP)
  wallX(1, -hd + 0.2, hd - 0.2, HEAD, TOP)
  wallZ(-1, -hw + 0.2, hw - 0.2, HEAD, TOP)
  wallZ(1, -hw + 0.2, hw - 0.2, HEAD, TOP)
  // Door jamb between the south window and the door.
  b.at(concrete, box(0.1, HEAD - SILL, WALL), DOOR.a + 0.05, (SILL + HEAD) / 2, hd - WALL / 2)
  b.at(concrete, box(hw - 0.2 - DOOR.b, HEAD - SILL, WALL), (DOOR.b + hw - 0.2) / 2, (SILL + HEAD) / 2, hd - WALL / 2)

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
  winZ(1, -hw + 0.2, DOOR.a, false)

  // Flat roof with a deep overhang, metal fascia and a ceiling inside.
  b.at(dark, box(w + 0.75, 0.26, d + 0.75), 0, TOP + 0.13, 0)
  b.at(frame, box(w + 0.79, 0.07, d + 0.79), 0, TOP + 0.29, 0)
  b.at(material("ceiling_tile"), box(w - 2 * WALL, 0.02, d - 2 * WALL), 0, TOP - 0.01, 0)
  // Roof vent and conduit down the east column to a junction box.
  b.at(frame, cyl(0.09, 0.09, 0.3, 8), -0.7, TOP + 0.45, -0.6)
  b.at(frame, cyl(0.13, 0.13, 0.04, 8), -0.7, TOP + 0.62, -0.6)
  b.add(material("metal_galvanized"), rod({ x: hw + 0.03, y: 0.5, z: -hd + 0.25 }, { x: hw + 0.03, y: TOP, z: -hd + 0.25 }, 0.018, 6))
  b.at(flat(0x55574c, 0.6, 0.3), box(0.08, 0.36, 0.28), hw + 0.06, 0.55, -hd + 0.4)

  // Door: open outwards, hinged on the east jamb, with a wired-glass vision panel.
  const door = b.child(matrix(DOOR.b - 0.02, FY, hd - 0.02, (68 * Math.PI) / 180))
  const steel = material("door_steel")
  const dw = DOOR.b - DOOR.a - 0.05
  door.at(steel, box(dw, 1.0, 0.045), -dw / 2, 0.5, 0)
  door.at(steel, box(dw, 0.35, 0.045), -dw / 2, 1.78, 0)
  door.at(steel, box(0.16, 0.6, 0.045), -0.08, 1.3, 0)
  door.at(steel, box(0.16, 0.6, 0.045), -dw + 0.08, 1.3, 0)
  door.add(glass, planeZ(dw - 0.32, 0.6), matrix(-dw / 2, 1.3, 0))
  door.at(material("chrome"), sphere(0.03, 8, 6), -dw + 0.08, 1.0, 0.05)
  door.at(material("chrome"), sphere(0.03, 8, 6), -dw + 0.08, 1.0, -0.05)
  b.at(frame, box(0.05, HEAD - FY, 0.08), DOOR.a, (FY + HEAD) / 2, hd - 0.04)
  b.at(frame, box(0.05, HEAD - FY, 0.08), DOOR.b, (FY + HEAD) / 2, hd - 0.04)

  furnish(b)

  batch.build(root, { castShadow: (m) => m !== glass, name: "booth" })

  // A warm bulb under the ceiling plus the space heater's glow.
  ctx.lamps.push({ kind: "incandescent", position: [x, y0 + TOP - 0.2, z], color: [1, 0.62, 0.3], intensity: 140, range: 16, size: 0.12 })

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
  ctx.colliders.push({ min: [x - hw, y0, z + hd - t], max: [x + DOOR.a, top, z + hd] })
  ctx.colliders.push({ min: [x + DOOR.b, y0, z + hd - t], max: [x + hw, top, z + hd] })
  ctx.colliders.push({ min: [x + DOOR.b - 0.45, y0, z + hd], max: [x + DOOR.b, y0 + 2.2, z + hd + 0.9] })
  ctx.colliders.push({ min: [x - hw, y0, z - hd], max: [x - hw + 0.8, y0 + FY + 0.95, z + hd] })
  ctx.floors.push({ min: [x - hw - 0.15, z - hd - 0.15], max: [x + hw + 0.15, z + hd + 0.15], y: y0 + FY })
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

  // Clipboard with a sheet, a thermos and a mug.
  const clip = b.child(matrix(deskX + 0.08, surface, 0.72, 0.2))
  clip.at(wood(0x5a4026, 0x6e5030), box(0.23, 0.008, 0.32), 0, 0.004, 0)
  clip.at(flat(0xd2ccb8, 0.9), box(0.21, 0.004, 0.27), 0, 0.01, 0.015)
  clip.at(material("chrome"), box(0.08, 0.012, 0.03), 0, 0.014, -0.14)
  b.at(flat(0x2c4a3a, 0.4, 0.2), cyl(0.045, 0.045, 0.3, 12), deskX - 0.17, surface + 0.15, 1.0)
  b.at(flat(0x8a1e14, 0.4), cyl(0.048, 0.048, 0.07, 12), deskX - 0.17, surface + 0.335, 1.0)
  b.at(flat(0xcfc8b4, 0.3), cyl(0.04, 0.036, 0.095, 12), deskX + 0.14, surface + 0.048, 0.48)
  // Pencil cup and a logbook.
  b.at(flat(0x2b2b28, 0.5), cyl(0.035, 0.035, 0.1, 10), deskX - 0.18, surface + 0.05, 0.42)
  b.at(flat(0x1f2e45, 0.7), box(0.22, 0.03, 0.3), deskX - 0.02, surface + 0.015, -0.1)

  // Space heater in the north-east corner with glowing coils.
  const heater = b.child(matrix(hw - WALL - 0.25, FY, -hd + WALL + 0.18, -0.6))
  heater.at(flat(0x6a6250, 0.5, 0.3), box(0.36, 0.42, 0.16), 0, 0.21, 0)
  heater.at(glow(1, 0.32, 0.08, 2.2), box(0.28, 0.2, 0.01), 0, 0.24, 0.08)

  // Wall clock over the north window.
  b.at(flat(0xd8d2c0, 0.6), cyl(0.13, 0.13, 0.03, 16), 0.6, HEAD + 0.2, -hd + WALL + 0.02, 0, Math.PI / 2)

  // Ceiling fixture: a shallow shade and a bare bulb.
  b.at(material("metal_painted"), cyl(0.09, 0.2, 0.09, 14, true), 0, TOP - 0.1, 0)
  b.at(glow(1, 0.62, 0.3, 30), sphere(0.045, 10, 8), 0, TOP - 0.17, 0)
}
