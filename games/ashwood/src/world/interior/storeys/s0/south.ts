import * as THREE from "three/webgpu"
import { MODELS } from "../../../../render/models"
import {
  type Builder,
  type RoomHandle,
  CEIL_Y,
  FLOOR_Y,
  M,
  ROOM_BANDS,
  T,
  ceiling,
  officeSet,
  paint,
  placeModels,
  rect,
  room,
  trofferGrid,
  wall,
  wastebasket,
  yawToward,
} from "../../api"
import { type Docs, PANEL_BANDS, SLIDE, corkBoard, garment, hookRail, rng, table } from "./common"
import { P, door } from "./west"
import { keyCabinetOn } from "./key-cabinet"
import { keyCabinet } from "../../search-spots"

// South of the west spine: facilities office (0-30, the player's base) and workshop (0-31) with its store (0-33), the
// briefing auditorium and foyer (0-35, projector beam), personnel & badge office (0-36) and the badge room (0-36b).

const ptIn = (m: THREE.Matrix4, x: number, y: number, z: number): [number, number, number] => {
  const v = new THREE.Vector3(x, y, z).applyMatrix4(m)
  return [v.x, v.y, v.z]
}
const PEG = paint(0x8a7a5a, 0.85)
const TOOL = paint(0x2a2a28, 0.5, 0.6)
const SCREEN_WHITE = paint(0xd8d8cc, 0.9)

export async function buildSouth(b: Builder, docs: Docs, pause: () => Promise<void>) {
  const rooms: RoomHandle[] = []
  rooms.push(...facilities(b, docs))
  await pause()
  rooms.push(...auditorium(b, docs))
  await pause()
  rooms.push(...personnel(b, docs))
  return rooms
}

// ------------------------------------------------------------------------------------------------ 0-30 / 0-31 / 0-33

function facilities(b: Builder, docs: Docs): RoomHandle[] {
  const y = FLOOR_Y
  const r30 = room(b, { id: "0-30", name: "Facilities office", rect: rect(-54.65, -47.8, 1.75, 8.1), lit: "none", floor: "linoleum", windows: { blinds: "random", radiators: "models" } })
  const r31g = rect(-54.65, -47.8, 8.25, 21.65)
  const g31 = trofferGrid(r31g)
  const c31 = g31.reduce((best, c) => (Math.hypot(c.x + 51.2, c.z - 15) < Math.hypot(best.x + 51.2, best.z - 15) ? c : best), g31[0]!)
  const r31 = room(b, { id: "0-31", name: "Facilities workshop", rect: r31g, lit: [[c31.x, c31.z]], floor: "concrete_floor_dry", troffers: { intensity: 16 } })
  const r33 = room(b, { id: "0-33", name: "Facilities stores", rect: rect(-47.8, -43.25, 10.75, 21.65), lit: "none", floor: "concrete_floor_dry" })
  b.floor("concrete_floor_dry", -43.25, 10.75, -42.15, 16.05)
  ceiling(b, -43.25, 10.75, -42.15, 16.05)
  wall(b, "z", 16.05, 21.61, -43.262, -43.25, ROOM_BANDS, [], { y0: FLOOR_Y - 0.01, y1: CEIL_Y + 0.02, collide: false })
  P(b, "x", 8.175, -54.65, -47.86, [ROOM_BANDS, ROOM_BANDS], [door(-50.4, "b", { id: "0-31", state: "closed", room: "0-31", sign: { number: "0-31", label: "WORKSHOP" } })], 0.15)
  P(b, "z", -47.8, 10.75, 21.65, [ROOM_BANDS, ROOM_BANDS], [door(18.0, "b", { id: "0-33", state: "janitor", room: "0-33", sign: { number: "0-33", label: "STORES" } })])

  // 0-30: supervisor's desk with its lamp (the player's base), key cabinet, work orders, radio chargers, coat rack.
  officeSet(b, -51.4, 5.0, yawToward(0, 1), { lamp: true, visitors: 1 })
  const top = y + MODELS.office_desk.size[1]
  const clip = T(-51.0, top, 5.1, 0.2)
  b.boxM(M.clipboard, clip, 0.23, 0.006, 0.32, 0, 0.003, 0, { cast: false })
  b.boxM("metal_galvanized", clip, 0.08, 0.012, 0.025, 0, 0.012, -0.14)
  docs.flat("work_order_night", -51.0, top + 0.0065, 5.1, 0.2, { scale: 0.95 })
  docs.flat("work_order_halt", -51.9, top + 0.001, 5.3, -0.25)
  // Key cabinet (./key-cabinet.ts): shut and locked, its key in Hargrove's locker (3-20); TRUCK 2 on the top right hook.
  // (The east wall's finished room face is at x −47.86.)
  {
    const kc = keyCabinetOn(b, -47.862, y + 1.45, 3.3, { card: ["FACILITIES 0-30", "VEHICLES · PLANT"], tag: ["CABINET KEY HELD AT", "SECURITY, 0-38"] })
    keyCabinet.door = kc.door
    keyCabinet.keys = kc.keys
    keyCabinet.at = kc.at
    keyCabinet.open = kc.open
  }
  // Radio chargers on a shelf, coat rack with the night jacket, filing cabinets, notice board.
  b.rbox(M.wood, T(-54.4, y + 1.1, 2.6), 0.4, 0.03, 1.2, 0.006)
  for (let k = 0; k < 4; k++) {
    b.rbox(M.darkSteel, T(-54.42, y + 1.115, 2.15 + k * 0.3), 0.12, 0.05, 0.1, 0.01, 0, 0.025, 0)
    b.rbox(M.rubber, T(-54.42, y + 1.14, 2.15 + k * 0.3), 0.05, 0.2, 0.07, 0.01, 0, 0.1, 0)
    b.boxM(k === 1 ? M.hazardRed : M.amberGlow, T(-54.42, y + 1.115, 2.15 + k * 0.3), 0.01, 0.008, 0.004, 0.03, 0.04, 0.052, { cast: false })
  }
  b.collide(-54.61, y + 1.08, 1.95, -54.2, y + 1.4, 3.25)
  placeModels(b, "coat_rack", [{ position: [-48.4, y, 7.5], yaw: 0.6 }])
  placeModels(b, "filing_cabinet", [{ position: [-54.33, y, 7.6], yaw: yawToward(1, 0) }])
  placeModels(b, "telephone", [{ position: [-54.33, y + 1.32, 7.6], yaw: yawToward(1, 0), collide: false }])
  corkBoard(b, docs, -51.5, 8.1, 0, -1, 1.6, 0.85, ["work_order_night", "directory_extensions", "card_extensions", "notice_nightshift", "log_shower_test", "calendar_oct84"], 30, FLOOR_Y + 1.2)
  wastebasket(b, -48.3, 2.3)

  // 0-31 workshop: workbench with a vise under a pegboard, step ladders, spare tubes, fuse stock, a mop cart.
  const wb = T(-54.61 + 0.4, y, 14.0, yawToward(1, 0))
  b.rbox(M.wood, wb, 3.0, 0.06, 0.75, 0.01, 0, 0.88, 0)
  for (const u of [-1.4, 1.4]) for (const s of [-1, 1]) b.boxM(M.darkSteel, wb, 0.05, 0.85, 0.05, u, 0.425, s * 0.3)
  b.boxM(M.darkSteel, wb, 2.8, 0.03, 0.6, 0, 0.18, 0)
  b.collideLocal(wb, [-1.5, 0, -0.38], [1.5, 0.91, 0.38])
  const v = ptIn(wb, 1.0, 0.91, -0.3)
  b.rbox(M.cabinet, T(v[0], v[1], v[2]), 0.14, 0.12, 0.22, 0.01, 0, 0.06, 0)
  b.rod(M.steel, [v[0], v[1] + 0.08, v[2] - 0.12], [v[0], v[1] + 0.08, v[2] - 0.2], 0.01, 6)
  b.box(PEG, -54.61, y + 1.1, 12.6, -54.59, y + 2.1, 15.4)
  const rt = rng(31)
  for (let k = 0; k < 14; k++) {
    const pz = 12.8 + (k % 7) * 0.38
    const py = y + 1.35 + Math.floor(k / 7) * 0.45
    b.box(TOOL, -54.59, py - 0.12 * (0.6 + rt()), pz - 0.02, -54.57, py + 0.08, pz + 0.02 + rt() * 0.05, { cast: false })
  }
  for (let k = 0; k < 6; k++) b.cyl(M.jugWhite, T(-48.2, y + 0.06 + k * 0.025, 19.5, 0, Math.PI / 2, Math.PI / 2), 0.0125, 0.0125, 1.2, 8)
  b.rbox(M.cardboard, T(-48.2, y, 20.5), 0.3, 0.3, 1.25, 0.01, 0, 0.15, 0)
  for (const [lx, lz, yaw] of [[-48.3, 11.0, 0.2], [-48.35, 12.0, -0.1]] as const) ladder(b, lx, lz, yaw)
  placeModels(b, "metal_rack", [{ position: [-50.5, y, 21.61 - MODELS.metal_rack.size[2] / 2 - 0.15], yaw: Math.PI }])
  placeModels(b, "cardboard_box", [{ position: [-52.6, y, 20.9], yaw: 0.1 }, { position: [-52.5, y + MODELS.cardboard_box.size[1], 20.9], yaw: -0.2, collide: false, blob: 0 }])
  placeModels(b, "drum_steel", [{ position: [-53.9, y, 9.0], yaw: 0.4 }])
  docs.wall("work_order_halt", -54.59, FLOOR_Y + 1.55, 15.7, 1, 0, { pin: "pin" })

  // 0-33 stores: shelves, tube cartons, fuse boxes, spare ceiling tiles.
  placeModels(b, "steel_shelves", [
    { position: [-46.2, y, 21.61 - 0.4], yaw: Math.PI, inset: 0.03 },
    { position: [-47.4, y, 15.2], yaw: yawToward(1, 0), inset: 0.03 },
    { position: [-47.4, y, 12.7], yaw: yawToward(1, 0), inset: 0.03 },
  ])
  for (let k = 0; k < 5; k++) b.rbox(M.cardboard, T(-44.5, y + k * 0.11, 12.0), 1.25, 0.1, 0.32, 0.005, 0, 0.05, 0)
  for (let k = 0; k < 8; k++) b.box("ceiling_tile", -44.3, y + k * 0.018, 18.4, -43.7, y + 0.016 + k * 0.018, 19.6)
  b.collide(-45.15, y, 11.8, -43.85, y + 0.55, 12.2)
  b.collide(-44.3, y, 18.4, -43.7, y + 0.15, 19.6)
  return [r30, r31, r33]
}

const KEY = paint(0x8a6a2a, 0.3, 0.9)

/** Aluminium A-frame step ladder folded and leaning on a wall (lean along local −x). */
function ladder(b: Builder, x: number, z: number, yaw: number) {
  const m = T(x, FLOOR_Y, z, yaw)
  for (const s of [-1, 1]) b.rod("metal_galvanized", ptIn(m, -0.3, 0, s * 0.22), ptIn(m, 0, 1.8, s * 0.2), 0.016, 6)
  for (let k = 1; k < 6; k++) b.rod("metal_galvanized", ptIn(m, -0.3 + k * 0.05, k * 0.3, -0.21), ptIn(m, -0.3 + k * 0.05, k * 0.3, 0.21), 0.02, 4)
  b.collideLocal(m, [-0.32, 0, -0.25], [0.02, 1.8, 0.25])
}

// ------------------------------------------------------------------------------------------------ 0-35 auditorium

function auditorium(b: Builder, docs: Docs): RoomHandle[] {
  const y = FLOOR_Y
  const foyer = room(b, { id: "0-35f", name: "Auditorium foyer", rect: rect(-26.2, -20.8, 1.75, 9.6), lit: "none", floor: "terrazzo" })
  const aud = room(b, { id: "0-35", name: "Briefing auditorium", rect: rect(-36.0, -20.8, 9.75, 21.65), lit: "none", floor: "linoleum", windows: { blinds: "closed", radiators: "convector" } })
  P(b, "x", 9.675, -26.2, -20.8, [ROOM_BANDS, PANEL_BANDS], [door(-23.5, "a", { id: "0-35", state: "closed", room: "0-35", double: true, leaf: "veneer", sign: { number: "0-35", label: "BRIEFING" } })], 0.15)
  P(b, "z", -36.075, 16.05, 21.65, [ROOM_BANDS, PANEL_BANDS], [], 0.15)
  P(b, "z", -20.8, 1.75, 21.65, [PANEL_BANDS, ROOM_BANDS])
  // Foyer: coat hooks, a notice board, an ashtray stand.
  hookRail(b, -20.86, 5.0, -Math.PI / 2, 2.4, 8)
  corkBoard(b, docs, -26.14, 5.6, 1, 0, 1.2, 0.8, ["notice_north_lot", "notice_north_array", "calendar_oct84"], 35, FLOOR_Y + 1.2)
  b.cyl(M.steel, T(-21.5, y + 0.33, 2.6), 0.13, 0.15, 0.66, 18)
  b.cyl(M.darkSteel, T(-21.5, y + 0.665, 2.6), 0.12, 0.12, 0.01, 18, { cast: false })
  b.collide(-21.65, y, 2.45, -21.35, y + 0.67, 2.75)

  // Pull-down screen on the north wall with the projected slide; lectern; 40 stack chairs; projector on its cart.
  const sx = -28.4
  const sz = 9.75 + 0.1
  b.rbox(M.darkSteel, T(sx, CEIL_Y - 0.12, sz + 0.02), 3.3, 0.12, 0.14, 0.03)
  b.box(SCREEN_WHITE, sx - 1.5, y + 0.9, sz - 0.004, sx + 1.5, CEIL_Y - 0.18, sz + 0.004, { cast: false })
  b.box(M.darkSteel, sx - 1.52, y + 0.88, sz - 0.012, sx + 1.52, y + 0.92, sz + 0.012)
  b.quad(SLIDE, T(sx, y + 1.95, sz + 0.006), 2.2, 1.65, { cast: false })
  const lec = T(-32.4, y, 10.9, yawToward(0.6, 1))
  b.rbox(M.veneer, lec, 0.6, 1.05, 0.45, 0.02, 0, 0.525, 0)
  b.rbox(M.veneerDark, lec.clone().multiply(T(0, 1.12, 0.02, 0, 0.35)), 0.62, 0.04, 0.48, 0.008)
  b.collideLocal(lec, [-0.3, 0, -0.23], [0.3, 1.15, 0.25])
  docs.flat("notice_north_lot", ...ptIn(lec, 0, 1.15, 0.02), Math.PI)
  const rnd = rng(35)
  const chairs = []
  for (let row = 0; row < 5; row++)
    for (const side of [-1, 1])
      for (let k = 0; k < 4; k++) {
        const x = sx + side * (0.9 + k * 0.6) + (rnd() - 0.5) * 0.05
        chairs.push({ position: [x, y, 13.2 + row * 1.0 + (rnd() - 0.5) * 0.08] as const, yaw: (rnd() - 0.5) * 0.15, inset: 0.08 })
      }
  placeModels(b, "stack_chair", chairs)
  // Projector cart at the back, its fan still running: the beam (shadowed spot) up the aisle onto the screen.
  const px = sx
  const pz = 19.6
  b.box(M.darkSteel, px - 0.35, y + 0.75, pz - 0.28, px + 0.35, y + 0.78, pz + 0.28)
  b.box(M.darkSteel, px - 0.35, y + 0.2, pz - 0.28, px + 0.35, y + 0.22, pz + 0.28)
  for (const dx of [-0.32, 0.32]) for (const dz of [-0.25, 0.25]) b.box(M.steel, px + dx - 0.012, y, pz + dz - 0.012, px + dx + 0.012, y + 0.78, pz + dz + 0.012)
  b.collide(px - 0.36, y, pz - 0.29, px + 0.36, y + 0.78, pz + 0.29)
  const pm = T(px, y + 0.78, pz, 0, 0.06)
  b.rbox(M.beige, pm, 0.32, 0.16, 0.36, 0.02, 0, 0.08, 0)
  b.cyl(M.rubber, pm.clone().multiply(T(0, 0.17, 0.02)), 0.16, 0.16, 0.035, 28)
  b.cyl(M.darkSteel, pm.clone().multiply(T(0, 0.08, -0.2, 0, Math.PI / 2)), 0.035, 0.04, 0.08, 14)
  b.cyl(M.bulbWarm, pm.clone().multiply(T(0, 0.08, -0.241, 0, Math.PI / 2)), 0.028, 0.028, 0.004, 14, { cast: false })
  const from: [number, number, number] = [px, y + 0.88, pz - 0.3]
  const to: [number, number, number] = [sx, y + 1.95, sz]
  const d = [to[0] - from[0], to[1] - from[1], to[2] - from[2]]
  const l = Math.hypot(d[0]!, d[1]!, d[2]!)
  b.lamp({ kind: "incandescent", position: from, direction: [d[0]! / l, d[1]! / l, d[2]! / l], color: [1.0, 0.9, 0.75], intensity: 900, range: 14, angle: 0.13, penumbra: 0.25, shadow: true, size: 0.04 })
  b.rod(M.rubber, [px + 0.15, y + 0.78, pz + 0.2], [px + 0.3, y, pz + 0.9], 0.006, 4)
  wastebasket(b, -21.4, 20.9)
  return [foyer, aud]
}

// ------------------------------------------------------------------------------------------------ 0-36 personnel

function personnel(b: Builder, docs: Docs): RoomHandle[] {
  const y = FLOOR_Y
  const r = room(b, { id: "0-36", name: "Personnel & badge office", rect: rect(-20.8, -9.15, 1.75, 21.65), lit: "none", floor: "linoleum", windows: { blinds: "random", radiators: "models" } })
  const rb = room(b, { id: "0-36b", name: "Badge room", rect: rect(-9.15, -1.75, 1.75, 8.85), lit: "none", floor: "linoleum" })
  P(b, "z", -9.075, 1.75, 8.85, [ROOM_BANDS, ROOM_BANDS], [{ kind: "cased", from: 4.6, to: 5.8 }], 0.15)
  // Four desks in two facing pairs, ID files along the west wall, the counter behind the lobby window.
  // Back-to-back pairs: desk fronts (the occupant side, local −Z) face outward (kit chair convention).
  for (const [dx, dz, yaw] of [[-17.2, 6.0, 0], [-17.2, 7.0, Math.PI], [-13.2, 6.0, 0], [-13.2, 7.0, Math.PI]] as const) officeSet(b, dx, dz, yaw, { visitors: 0 })
  const fc = []
  for (let k = 0; k < 9; k++) fc.push({ position: [-20.74 + 0.26, y, 11.0 + k * 0.46] as const, yaw: yawToward(1, 0) })
  placeModels(b, "filing_cabinet", fc)
  placeModels(b, "filing_cabinet_open", [{ position: [-20.74 + 0.55, y, 15.6], yaw: yawToward(1, 0), inset: 0.05 }])
  b.rbox(M.laminate, T(-9.65, y, 17.3), 0.7, 0.95, 2.2, 0.01, 0, 0.475, 0)
  b.collide(-10.0, y, 16.2, -9.15, y + 0.97, 18.4)
  docs.flat("signin_sheet", -9.7, y + 0.951, 17.0, -Math.PI / 2 + 0.1)
  docs.flat("envelope_interoffice", -9.65, y + 0.951, 17.7, -Math.PI / 2 - 0.2, { offset: 0.003 })
  placeModels(b, "office_chair", [{ position: [-10.6, y, 17.4], yaw: yawToward(1, 0) + 0.4, inset: 0.12 }])
  docs.flat("roster_field_team", -17.0, y + MODELS.office_desk.size[1], 6.1, 0.3)
  wastebasket(b, -12.0, 9.0)
  corkBoard(b, docs, -15.0, 1.75, 0, 1, 1.4, 0.8, ["memo_signin", "notice_north_array", "roster_operators", "flyer_bowling"], 36, FLOOR_Y + 1.25)

  // Badge room: backdrop, camera on a tripod, a stool, laminator on a table, a photo lamp (off).
  b.box(paint(0x2a3a5a, 0.85), -2.0, y + 0.6, 4.2, -1.76, y + 2.3, 5.8, { cast: false })
  placeModels(b, "lab_stool", [{ position: [-2.6, y, 5.0], yaw: 0.3, inset: 0.06 }])
  const tp = [-5.4, y, 5.0] as const
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2
    b.rod(M.darkSteel, [tp[0] + Math.cos(a) * 0.35, y, tp[2] + Math.sin(a) * 0.35], [tp[0], y + 1.2, tp[2]], 0.01, 6)
  }
  b.rod(M.darkSteel, [tp[0], y + 1.2, tp[2]], [tp[0], y + 1.4, tp[2]], 0.014, 6)
  b.rbox(M.rubber, T(tp[0], y + 1.4, tp[2], -Math.PI / 2), 0.16, 0.14, 0.22, 0.02, 0, 0.07, 0)
  b.cyl(M.darkSteel, T(tp[0] + 0.14, y + 1.47, tp[2], 0, 0, Math.PI / 2), 0.04, 0.045, 0.08, 14)
  b.collide(tp[0] - 0.3, y, tp[2] - 0.3, tp[0] + 0.3, y + 1.5, tp[2] + 0.3)
  b.rod(M.darkSteel, [-3.2, y, 7.6], [-3.2, y + 1.9, 7.6], 0.012, 6)
  b.cyl(M.steel, T(-3.2, y + 1.95, 7.6, 0, 0, 1.0), 0.06, 0.2, 0.2, 16, { open: true })
  b.collide(-3.4, y, 7.4, -3.0, y + 2.0, 7.8)
  table(b, -7.5, 8.2, 0, 1.4, 0.7)
  b.rbox(M.beige, T(-7.8, y + 0.74, 8.2), 0.45, 0.12, 0.3, 0.02, 0, 0.06, 0)
  b.boxM(M.amberGlow, T(-7.8, y + 0.74, 8.2), 0.012, 0.008, 0.004, 0.18, 0.09, -0.152, { cast: false })
  docs.flat("polaroid_corridor", -7.2, y + 0.741, 8.1, 0.4)
  docs.flat("polaroid_dish", -7.05, y + 0.741, 8.25, -0.2, { offset: 0.0025 })
  return [r, rb]
}
