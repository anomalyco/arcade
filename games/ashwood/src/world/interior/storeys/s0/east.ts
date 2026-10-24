import { keyCabinetOn } from "./key-cabinet"
import { securityKeyBox } from "../../search-spots"
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
  cot,
  deskLamp,
  glow,
  kitchenette,
  lockers,
  paint,
  placeModels,
  rect,
  riserW1,
  room,
  sinkCounter,
  wastebasket,
  yawToward,
} from "../../api"
import { CCTV, type Docs, PANEL_BANDS, TV_STATIC, bulkhead, corkBoard, lining, rng, roomOpen, table } from "./common"
import { P, door } from "./west"

// East of the junction. North: mail & messenger (0-19, riser W-1), PBX (0-20), building control (0-21), dry stores and
// walk-in freezer with the annex door (0-22). South: guard ready room + armory (0-37), security office (0-38, concept
// r4-08), cafeteria servery / kitchen / dining (0-39, concept r4-03).

const ptIn = (m: THREE.Matrix4, x: number, y: number, z: number): [number, number, number] => {
  const v = new THREE.Vector3(x, y, z).applyMatrix4(m)
  return [v.x, v.y, v.z]
}
const CANVAS = paint(0x6a6450, 0.95)
const STAINLESS = paint(0xa8aaa6, 0.25, 0.9)
const INSUL = paint(0xc8c8c0, 0.45, 0.2)
const LED_GREEN = glow(0x041004, 0x30ff40, 1.6, "led_green")
const LED_AMBER = M.amberGlow

export async function buildEast(b: Builder, docs: Docs, pause: () => Promise<void>) {
  const rooms: RoomHandle[] = []
  rooms.push(mail(b, docs))
  rooms.push(pbx(b, docs))
  await pause()
  rooms.push(control(b, docs))
  rooms.push(...dryStores(b, docs))
  await pause()
  rooms.push(readyRoom(b, docs))
  rooms.push(security(b, docs))
  await pause()
  rooms.push(...cafeteria(b, docs))
  return rooms
}

// ------------------------------------------------------------------------------------------------ 0-19 mail

function mail(b: Builder, docs: Docs): RoomHandle {
  const y = FLOOR_Y
  const r = room(b, { id: "0-19", name: "Mail & messenger", rect: rect(-4.6, 6.2, -21.65, -1.75), lit: "none", floor: "linoleum" })
  // The PBX wall stops at riser W-1 (its cupboard sits in the corner, door into the mail room).
  P(b, "z", 6.2, -21.65, -4.7, [ROOM_BANDS, ROOM_BANDS])
  P(b, "z", 6.2, -3.3, -1.75, [ROOM_BANDS, ROOM_BANDS])
  riserW1(b, { face: "west" })
  docs.wall("stencil_w1", 5.19, FLOOR_Y + 2.3, -4.0, -1, 0, { pin: "none", curl: 0 })
  // Pigeonholes along the west wall: a wooden grid with envelopes in some of the slots.
  const px = -4.54
  const pm = T(px + 0.2, y, -9.0, yawToward(1, 0))
  b.rbox(M.wood, pm, 3.0, 0.9, 0.4, 0.01, 0, 0.45, 0)
  for (let c = 0; c <= 12; c++) b.boxM(M.wood, pm, 0.015, 1.0, 0.36, -1.5 + c * 0.25, 1.4, 0.02)
  for (let rr = 0; rr <= 6; rr++) b.boxM(M.wood, pm, 3.0, 0.015, 0.36, 0, 0.9 + rr * 0.167, 0.02)
  b.boxM(M.wood, pm, 3.0, 1.0, 0.012, 0, 1.4, 0.194)
  const rnd = rng(19)
  for (let c = 0; c < 12; c++)
    for (let rr = 0; rr < 6; rr++) if (rnd() < 0.35) b.boxM(rnd() < 0.5 ? M.paper : M.cardboard, pm, 0.2, 0.004 + rnd() * 0.05, 0.3, -1.375 + c * 0.25, 0.915 + rr * 0.167 + 0.02, 0.03, { cast: false })
  b.collideLocal(pm, [-1.5, 0, -0.2], [1.5, 1.9, 0.2])
  // Sorting table, two canvas mail hampers, parcel cage at the window end.
  table(b, 0.5, -9.0, 0, 2.4, 1.0, 0.86, M.wood)
  docs.flat("envelope_interoffice", 0.1, y + 0.86, -9.1, 0.3)
  docs.flat("envelope_interoffice", 0.9, y + 0.86, -8.9, -0.5, { offset: 0.004 })
  docs.flat("memo_signin", 1.4, y + 0.86, -9.2, 0.1)
  for (const [hx, hz, yaw] of [[3.0, -6.0, 0.3], [-1.8, -5.2, -0.4]] as const) hamper(b, hx, hz, yaw)
  const cz0 = -21.55
  const cz1 = -18.4
  for (let x = -3.5; x <= 4.5; x += 1.0) b.box(M.darkSteel, x - 0.02, y, cz1 - 0.02, x + 0.02, y + 2.2, cz1 + 0.02)
  b.box("chainlink", -3.5, y + 0.05, cz1 - 0.005, 4.5, y + 2.2, cz1 + 0.005)
  b.box(M.darkSteel, -3.5, y + 2.18, cz1 - 0.02, 4.5, y + 2.22, cz1 + 0.02)
  b.collide(-3.5, y, cz1 - 0.03, 4.5, y + 2.2, cz1 + 0.03)
  placeModels(b, "cardboard_box", [
    { position: [-2.5, y, cz0 + 0.5], yaw: 0.2 },
    { position: [-2.0, y, cz0 + 0.6], yaw: -0.3 },
    { position: [1.2, y, cz0 + 0.45], yaw: 0.1 },
  ])
  placeModels(b, "hand_truck", [{ position: [3.8, y, -19.6], yaw: -0.4 }])
  corkBoard(b, docs, 2.8, -1.75, 0, -1, 1.1, 0.7, ["directory_extensions", "card_extensions", "memo_coffee"], 7, FLOOR_Y + 1.3)
  wastebasket(b, -3.9, -2.4)
  return r
}

/** Canvas mail hamper on a steel frame with castors. */
function hamper(b: Builder, x: number, z: number, yaw: number) {
  const m = T(x, FLOOR_Y, z, yaw)
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    b.rod("metal_galvanized", ptIn(m, sx * 0.4, 0.1, sz * 0.28), ptIn(m, sx * 0.4, 0.9, sz * 0.28), 0.012, 6)
    b.cyl(M.rubber, m.clone().multiply(T(sx * 0.38, 0.04, sz * 0.26, 0, 0, Math.PI / 2)), 0.04, 0.04, 0.03, 10)
  }
  b.rbox(CANVAS, m, 0.8, 0.62, 0.56, 0.08, 0, 0.52, 0)
  b.boxM(M.paper, m, 0.6, 0.05, 0.4, 0, 0.83, 0, { cast: false })
  b.collideLocal(m, [-0.42, 0, -0.3], [0.42, 0.9, 0.3])
}

// ------------------------------------------------------------------------------------------------ 0-20 PBX

function pbx(b: Builder, docs: Docs): RoomHandle {
  const y = FLOOR_Y
  const r = room(b, { id: "0-20", name: "PBX switchboard", rect: rect(6.2, 11.6, -21.65, -1.75), lit: "none", floor: "linoleum" })
  P(b, "z", 11.6, -21.65, -1.75, [ROOM_BANDS, ROOM_BANDS])
  // Cord board: three positions against the east wall, keyshelf, jack field, line lamps, cords.
  const xw = 11.54
  const bm = T(xw - 0.4, y, -12.0, yawToward(-1, 0))
  b.rbox(M.veneerDark, bm, 2.6, 0.75, 0.8, 0.015, 0, 0.375, 0)
  b.rbox(M.laminateTop, bm.clone().multiply(T(0, 0.78, -0.12, 0, 0.12)), 2.6, 0.035, 0.55, 0.008)
  b.rbox(M.veneerDark, bm, 2.6, 1.15, 0.22, 0.015, 0, 1.38, 0.29)
  const jp = bm.clone().multiply(T(0, 1.4, 0.175))
  b.boxM(M.felt, jp, 2.4, 0.95, 0.01, 0, 0, 0)
  const rnd = rng(20)
  for (let rr = 0; rr < 10; rr++)
    for (let c = 0; c < 30; c++) {
      const u = -1.16 + c * 0.08
      const v = -0.4 + rr * 0.09
      b.boxM(STAINLESS, jp, 0.018, 0.018, 0.006, u, v, -0.008, { cast: false })
      if (rr % 2 === 0) b.boxM(rnd() < 0.04 ? LED_AMBER : M.hazardOff, jp, 0.012, 0.008, 0.004, u, v + 0.03, -0.007, { cast: false })
    }
  for (let k = 0; k < 14; k++) {
    const u = -1.1 + k * 0.17
    const p0 = ptIn(bm, u, 0.84, -0.3)
    b.cyl(M.rubber, T(p0[0], p0[1] + 0.03, p0[2]), 0.008, 0.008, 0.06, 6)
    if (k % 3 === 0) {
      const p1 = ptIn(jp, -1.16 + Math.floor(rnd() * 30) * 0.08, -0.4 + Math.floor(rnd() * 10) * 0.09, -0.02)
      b.rod(M.rubber, [p0[0], p0[1] + 0.06, p0[2]], [(p0[0] + p1[0]) / 2, p0[1] - 0.05, (p0[2] + p1[2]) / 2], 0.004, 4)
      b.rod(M.rubber, [(p0[0] + p1[0]) / 2, p0[1] - 0.05, (p0[2] + p1[2]) / 2], p1, 0.004, 4)
    }
  }
  b.collideLocal(bm, [-1.3, 0, -0.42], [1.3, 1.96, 0.4])
  // The one line lamp still calling (amber, blinking), operator's chair turned away, headset on the shelf.
  const call = ptIn(jp, 0.36, 0.2, -0.05)
  b.lamp({ kind: "warning", position: call, color: [1, 0.55, 0.12], intensity: 0.5, range: 1.6, size: 0.02, flicker: 0.6 })
  placeModels(b, "office_chair", [{ position: [10.1, y, -11.4], yaw: yawToward(-1, 0.6) + Math.PI, inset: 0.12 }])
  const hs = ptIn(bm, -0.4, 0.83, -0.25)
  const band = new THREE.TorusGeometry(0.08, 0.006, 6, 18, Math.PI)
  band.applyMatrix4(T(hs[0], hs[1] + 0.02, hs[2], 0.3, Math.PI / 2))
  b.add(M.rubber, band)
  b.cyl(M.rubber, T(hs[0], hs[1] + 0.02, hs[2] + 0.08), 0.03, 0.03, 0.02, 12)
  deskLamp(b, ...ptIn(bm, 0.95, 0.8, -0.18), yawToward(-1, 0.3), true, { intensity: 45 })
  docs.flat("card_extensions", ...ptIn(bm, 0.3, 0.825, -0.2), Math.PI / 2 + 0.2)
  docs.flat("sticky_dont", ...ptIn(bm, 0.55, 0.826, -0.22), Math.PI / 2 - 0.4)
  docs.wall("directory_extensions", 6.26, FLOOR_Y + 1.5, -10.5, 1, 0, { pin: "pin" })
  placeModels(b, "wall_clock", [{ position: [6.26 + 0.03, FLOOR_Y + 2.3, -12.0], yaw: yawToward(1, 0), collide: false, blob: 0 }])
  wastebasket(b, 10.8, -14.0)
  return r
}

// ------------------------------------------------------------------------------------------------ 0-21 control

function control(b: Builder, docs: Docs): RoomHandle {
  const y = FLOOR_Y
  const r = room(b, { id: "0-21", name: "Building control", rect: rect(11.6, 22.4, -21.65, -1.75), lit: "none", floor: "linoleum" })
  P(b, "z", 22.4, -21.65, -1.75, [ROOM_BANDS, ROOM_BANDS])
  // Fire-alarm annunciator on the west wall: zone windows, most dark, two green (normal), one amber (trouble).
  const an = T(11.66 + 0.05, y + 1.6, -9.0, yawToward(1, 0))
  b.rbox(M.cabinet, an, 2.0, 1.1, 0.1, 0.01)
  const rnd = rng(21)
  for (let rr = 0; rr < 6; rr++)
    for (let c = 0; c < 12; c++) {
      const k = rnd()
      b.boxM(k < 0.06 ? LED_GREEN : M.hazardOff, an, 0.11, 0.06, 0.006, -0.88 + c * 0.16, 0.38 - rr * 0.13, -0.052, { cast: false })
      if (rr === 2 && c === 7) b.boxM(LED_AMBER, an, 0.11, 0.06, 0.008, -0.88 + c * 0.16, 0.38 - rr * 0.13, -0.054, { cast: false })
    }
  b.collideLocal(an, [-1, -0.55, -0.1], [1, 0.55, 0.1])
  const glowAt = ptIn(an, 0.3, 0.0, -0.4)
  b.lamp({ kind: "window", position: glowAt, color: [0.5, 1, 0.45], intensity: 0.6, range: 2.2, size: 0.2 })
  // HVAC panel with three circular chart recorders and gauges along the north wall.
  const hv = T(16.5, y, -21.61 + 0.3, 0)
  b.rbox(M.cabinet, hv, 3.0, 2.0, 0.5, 0.015, 0, 1.0, 0)
  for (let k = 0; k < 3; k++) {
    const u = -1.0 + k * 1.0
    b.cyl(M.darkSteel, hv.clone().multiply(T(u, 1.35, -0.26, 0, Math.PI / 2)), 0.2, 0.2, 0.03, 28)
    b.cyl(M.paper, hv.clone().multiply(T(u, 1.35, -0.277, 0, Math.PI / 2)), 0.18, 0.18, 0.004, 28)
    b.rod(M.red, ptIn(hv, u, 1.35, -0.282), ptIn(hv, u + 0.12, 1.42, -0.282), 0.003, 4)
    b.cyl(M.jugWhite, hv.clone().multiply(T(u, 0.75, -0.258, 0, Math.PI / 2)), 0.07, 0.07, 0.02, 20)
  }
  b.collideLocal(hv, [-1.5, 0, -0.25], [1.5, 2.0, 0.25])
  // Master clock (tall case + dial), exterior-lighting contactor cabinets on the east wall.
  const mc = T(13.2, y, -21.61 + 0.2, 0)
  b.rbox(M.wood, mc, 0.5, 1.8, 0.3, 0.01, 0, 0.9, 0)
  b.cyl(M.jugWhite, mc.clone().multiply(T(0, 1.5, -0.152, 0, Math.PI / 2)), 0.17, 0.17, 0.005, 28)
  b.quad(M.glass, mc.clone().multiply(T(0, 0.8, -0.152, Math.PI)), 0.3, 0.6, { cast: false })
  b.collideLocal(mc, [-0.25, 0, -0.15], [0.25, 1.8, 0.15])
  const [, , ud] = MODELS.utility_box_b.size
  placeModels(b, "utility_box_b", [-14.0, -11.8].map((z) => ({ position: [22.34 - ud / 2 - 0.02, y + 0.6, z] as const, yaw: yawToward(-1, 0), inset: 0, blob: 0 })))
  for (const z of [-14.0, -11.8]) b.rod("metal_galvanized", [22.3, y + 1.72, z], [22.3, CEIL_Y, z], 0.016, 6)
  table(b, 16.0, -6.5, 0, 1.6, 0.8)
  placeModels(b, "office_chair", [{ position: [16.3, y, -5.7], yaw: Math.PI + 0.5, inset: 0.12 }])
  docs.flat("log_shower_test", 15.8, y + 0.741, -6.5, 0.15)
  docs.wall("plate_el0", 12.6, FLOOR_Y + 1.5, -1.81, 0, -1, { pin: "none" })
  return r
}

// ------------------------------------------------------------------------------------------------ 0-22 dry stores

function dryStores(b: Builder, docs: Docs): RoomHandle[] {
  const y = FLOOR_Y
  const r = roomOpen(b, { id: "0-22", name: "Dry stores", rect: rect(22.4, 34.65, -21.65, -1.75), lit: "none", floor: "concrete_floor_dry" }, ["east"])
  // Annex door (facility leaf; keycard "plant"): opening in the lining, reader and plate beside it.
  lining(b, "east", -21.65, -1.75, [{ a0: -8.66, a1: -7.34, top: 2.14 }])
  const rd = T(34.6, y + 1.2, -6.95, -Math.PI / 2)
  b.rbox(M.darkSteel, rd, 0.08, 0.13, 0.025, 0.006)
  b.boxM(glow(0x200404, 0xff2010, 2, "card_reader_led"), rd, 0.012, 0.012, 0.004, 0, -0.04, 0.014, { cast: false })
  docs.wall("notice_north_lot", 34.6, FLOOR_Y + 1.55, -9.3, -1, 0, { pin: "tape" })
  // Shelving rows of tins and sacks on pallets.
  placeModels(b, "steel_shelves", [
    { position: [26.0, y, -14.0], yaw: 0, inset: 0.03 },
    { position: [28.4, y, -14.0], yaw: 0, inset: 0.03 },
    { position: [26.0, y, -12.4], yaw: Math.PI, inset: 0.03 },
    { position: [28.4, y, -12.4], yaw: Math.PI, inset: 0.03 },
    { position: [22.9, y, -18.0], yaw: yawToward(1, 0), inset: 0.03 },
  ])
  placeModels(b, "pallet", [{ position: [32.4, y, -19.8], yaw: 0 }, { position: [32.4, y, -16.4], yaw: 0.05 }])
  const ph = MODELS.pallet.size[1]
  const rnd = rng(22)
  for (const pz of [-19.8, -16.4])
    for (let k = 0; k < 7; k++) {
      const m = T(32.4 - 0.3 + (k % 2) * 0.6, y + ph + Math.floor(k / 4) * 0.16, pz - 0.35 + (Math.floor(k / 2) % 2) * 0.7, (rnd() - 0.5) * 0.3)
      b.rbox(CANVAS, m, 0.5, 0.17, 0.7, 0.07, 0, 0.085, 0)
    }
  placeModels(b, "cardboard_box", [{ position: [30.6, y, -20.9], yaw: 0.2 }, { position: [30.2, y, -21.0], yaw: -0.1 }])
  // Walk-in freezer box near the spine, insulated door on its east face; lamp inside (seen when opened).
  const f = { x0: 23.0, x1: 27.4, z0: -9.4, z1: -3.6 }
  const IB = [[0, 0.1, M.rubber] as const, [0.1, 99, INSUL] as const]
  P(b, "x", f.z0, f.x0, f.x1, [IB, IB], [], 0.1)
  P(b, "x", f.z1, f.x0, f.x1, [IB, IB], [], 0.1)
  P(b, "z", f.x0, f.z0 + 0.05, f.z1 - 0.05, [IB, IB], [], 0.1)
  P(b, "z", f.x1, f.z0 + 0.05, f.z1 - 0.05, [IB, IB], [door(-6.5, "b", { id: "0-22F", state: "closed", room: "0-22f", insulated: true, sign: { number: "0-22F", label: "FREEZER" } })], 0.1)
  b.box(INSUL, f.x0 - 0.05, 2.5, f.z0 - 0.05, f.x1 + 0.05, 2.6, f.z1 + 0.05)
  b.box(paint(0x2a2c2a, 0.6), f.x0 + 0.05, 2.49, f.z0 + 0.05, f.x1 - 0.05, 2.5, f.z1 - 0.05, { cast: false, skip: "Y" })
  const fz = room(b, { id: "0-22f", name: "Walk-in freezer", rect: rect(f.x0 + 0.05, f.x1 - 0.05, f.z0 + 0.05, f.z1 - 0.05), floor: "concrete_floor_dry", ceiling: { none: true }, troffers: false, lit: "none", columns: false })
  bulkhead(b, 25.2, 2.49, -6.5, 0, 0, true, 4, { range: 3 })
  for (const z of [-9.0, -4.0]) {
    for (const h of [0.4, 1.0, 1.6]) {
      b.box(STAINLESS, f.x0 + 0.1, y + h, z - 0.25, f.x1 - 1.1, y + h + 0.02, z + 0.25)
      for (let k = 0; k < 4; k++) b.rbox(k % 2 ? M.cardboard : M.jugWhite, T(f.x0 + 0.5 + k * 0.7, y + h + 0.02, z), 0.4, 0.22, 0.38, 0.01, 0, 0.11, 0)
    }
    b.collide(f.x0 + 0.05, y, z - 0.27, f.x1 - 1.1, y + 1.9, z + 0.27)
  }
  b.box(STAINLESS, 27.47, y + 1.8, -5.6, 27.5, y + 2.0, -5.3)
  return [r, fz]
}

// ------------------------------------------------------------------------------------------------ 0-37 ready room

function readyRoom(b: Builder, docs: Docs): RoomHandle {
  const y = FLOOR_Y
  const r = room(b, { id: "0-37", name: "Guard ready room", rect: rect(1.75, 17.0, 1.75, 8.85), lit: "none", floor: "linoleum" })
  P(b, "x", 8.925, 9.15, 17.0, [ROOM_BANDS, ROOM_BANDS], [], 0.15)
  // Armory cage at the east end (locked, signposted).
  const ax = 14.4
  P(b, "z", ax, 1.75, 8.85, [[[0, 99, "chainlink"]], [[0, 99, "chainlink"]]], [door(3.2, "a", { id: "0-37A", state: "locked", room: "0-37a", leaf: M.darkSteel, glass: "none", sign: { number: "0-37A", label: "ARMORY · AUTHORIZED ONLY" } })], 0.03)
  for (let z = 1.9; z < 8.85; z += 1.2) if (Math.abs(z - 3.2) > 0.7) b.box(M.darkSteel, ax - 0.03, y, z - 0.02, ax + 0.03, CEIL_Y, z + 0.02)
  b.box(M.red, ax - 0.025, y + 1.75, 4.0, ax - 0.016, y + 1.95, 4.6, { cast: false })
  for (let k = 0; k < 6; k++) {
    const z = 5.2 + k * 0.28
    b.box(M.wood, 16.9, y + 0.1, z - 0.02, 16.94, y + 1.6, z + 0.02)
    b.rod(M.darkSteel, [16.86, y + 0.15, z], [16.86, y + 1.2, z + 0.02], 0.014, 6)
    b.box(M.wood, 16.82, y + 0.2, z - 0.02, 16.9, y + 0.55, z + 0.02)
  }
  b.rbox(paint(0x3a4a32, 0.7, 0.3), T(16.6, y, 2.6), 0.6, 1.0, 1.2, 0.01, 0, 0.5, 0)
  b.collide(16.3, y, 2.0, 16.94, y + 1.0, 3.2)
  // TV left on, on a cart facing the door: its static throws a flickering spot through the door's wire glass.
  const tv = T(5.0, y, 5.2, 0)
  b.box(M.darkSteel, 4.7, y + 0.6, 4.95, 5.3, y + 0.63, 5.45)
  for (const dx of [-0.28, 0.28]) for (const dz of [-0.22, 0.22]) b.box(M.darkSteel, 5.0 + dx - 0.012, y, 5.2 + dz - 0.012, 5.0 + dx + 0.012, y + 0.6, 5.2 + dz + 0.012)
  b.collide(4.7, y, 4.95, 5.3, y + 1.08, 5.45)
  b.rbox(M.veneerDark, tv, 0.56, 0.44, 0.42, 0.03, 0, 0.85, 0)
  b.rbox(M.darkSteel, tv, 0.42, 0.33, 0.02, 0.02, -0.05, 0.86, -0.21)
  b.quad(TV_STATIC, tv.clone().multiply(T(-0.05, 0.86, -0.222, Math.PI)), 0.36, 0.27, { cast: false })
  for (const k of [0, 1]) b.cyl(M.steel, tv.clone().multiply(T(0.21, 0.95 - k * 0.1, -0.215, 0, Math.PI / 2)), 0.018, 0.018, 0.02, 10)
  b.lamp({ kind: "fluorescent", position: [4.95, y + 0.86, 4.85], direction: [0, 0.16, -1].map((v, i, a) => v / Math.hypot(...a)) as [number, number, number], color: [0.78, 0.86, 1.0], intensity: 26, range: 6, angle: 0.5, penumbra: 0.6, shadow: true, size: 0.25, flicker: 1 })
  // Lockers, cot, coffee counter, table with chairs and a full ashtray.
  lockers(b, 2.05 + 0.0, 7.0, yawToward(1, 0), 6)
  cot(b, 10.5, 8.3, 0)
  kitchenette(b, 12.0, 1.75 + 0.31 + 0.005, Math.PI, 1.8, { coffeeOn: true, fridge: false })
  table(b, 8.0, 5.0, 0, 1.4, 0.8)
  placeModels(b, "stack_chair", [
    { position: [7.6, y, 5.75], yaw: Math.PI + 0.3 },
    { position: [8.6, y, 4.2], yaw: 0.2 },
  ])
  b.cyl(M.glass, T(8.2, y + 0.74, 5.1), 0.06, 0.07, 0.025, 14)
  docs.flat("roster_operators", 7.6, y + 0.741, 4.95, 0.4)
  corkBoard(b, docs, 9.0, 8.85, 0, -1, 1.4, 0.8, ["roster_operators", "notice_nightshift", "flyer_bowling", "calendar_oct84"], 37, FLOOR_Y + 1.2)
  wastebasket(b, 3.0, 2.2)
  return r
}

// ------------------------------------------------------------------------------------------------ 0-38 security

function security(b: Builder, docs: Docs): RoomHandle {
  const y = FLOOR_Y
  const r = room(b, { id: "0-38", name: "Security office", rect: rect(9.15, 17.0, 9.0, 21.65), lit: "none", floor: "linoleum", windows: { blinds: "random", radiators: "convector" } })
  // Staff door through to the cafeteria: the guards' way to the coffee, and a second way out of the office.
  P(b, "z", 17.0, 1.75, 21.65, [ROOM_BANDS, PANEL_BANDS], [door(17.4, "a", { id: "0-38C", state: "closed", room: "0-39" })])
  // CCTV console against the north wall: steel rack with two rows of three monitors, sloped control shelf.
  const cx = 13.2
  const cz = 9.0 + 0.33
  const con = T(cx, y, cz, 0)
  b.rbox(M.cabinet, con, 2.3, 0.85, 0.64, 0.015, 0, 0.425, 0)
  b.rbox(M.laminateTop, con.clone().multiply(T(0, 0.86, 0.12, 0, -0.18)), 2.3, 0.03, 0.42, 0.006)
  b.rbox(M.darkSteel, con, 2.3, 1.05, 0.5, 0.015, 0, 1.4, -0.07)
  b.collideLocal(con, [-1.15, 0, -0.32], [1.15, 1.95, 0.32])
  const variants: [number, number, number, number][] = [
    [0, 0, 1, 1], [0.1, 0, 1.0, 0.95], [0, 0.05, 0.9, 1], [0.05, 0, 0.95, 1], [0, 0, 0.9, 0.9], [0.1, 0.05, 1, 1],
  ]
  for (let k = 0; k < 6; k++) {
    const u = -0.75 + (k % 3) * 0.75
    const v = 1.62 - Math.floor(k / 3) * 0.44
    const mon = con.clone().multiply(T(u, v, 0.08))
    b.rbox(paint(0x1e201e, 0.5, 0.3), mon, 0.62, 0.4, 0.38, 0.03, 0, 0, -0.05)
    b.boxM(M.darkSteel, mon, 0.5, 0.3, 0.01, 0, 0, 0.145)
    const [u0, v0, u1, v1] = variants[k]!
    const g = new THREE.PlaneGeometry(0.44, 0.32)
    const uvA = g.getAttribute("uv") as THREE.BufferAttribute
    for (let i = 0; i < uvA.count; i++) uvA.setXY(i, u0 + uvA.getX(i) * (u1 - u0), v0 + uvA.getY(i) * (v1 - v0))
    g.applyMatrix4(mon.clone().multiply(T(0, 0, 0.152)))
    b.add(CCTV, g, { worldUV: false, cast: false })
    b.boxM(LED_GREEN, mon, 0.012, 0.012, 0.004, 0.27, -0.17, 0.152, { cast: false })
    // Monitor 6: the dock camera, looking through the FL-1 gate (lattice bars in the picture).
    if (k === 5) for (let j = 0; j < 7; j++) b.boxM(paint(0x0a0c0a, 0.9), mon, 0.008, 0.2, 0.002, -0.12 + j * 0.04, -0.02, 0.154, { cast: false })
  }
  const glowAt = ptIn(con, 0, 1.4, 0.8)
  b.lamp({ kind: "window", position: glowAt, color: [0.62, 0.8, 0.68], intensity: 2.0, range: 4.5, size: 0.6 })
  // Desk facing the monitors, chair pushed back; logbook, ashtray with a cigarette burnt to the filter, mug, radio.
  placeModels(b, "office_desk", [{ position: [cx, y, 10.9], yaw: Math.PI }])
  const top = y + MODELS.office_desk.size[1]
  placeModels(b, "office_chair", [{ position: [cx + 0.35, y, 12.45], yaw: 0.8, inset: 0.12 }])
  docs.flat("security_log", cx - 0.15, top, 11.05, Math.PI + 0.12)
  docs.flat("checklist_rounds", cx - 0.62, top, 10.85, Math.PI - 0.3, { offset: 0.003 })
  docs.flat("sticky_dish", cx + 0.2, top, 10.75, Math.PI + 0.4)
  b.cyl(M.glass, T(cx + 0.45, top + 0.012, 11.0), 0.065, 0.075, 0.024, 16)
  b.rod(M.paper, [cx + 0.42, top + 0.03, 11.0], [cx + 0.47, top + 0.028, 10.98], 0.004, 6)
  b.rod(paint(0x8a6a3a, 0.8), [cx + 0.47, top + 0.028, 10.98], [cx + 0.5, top + 0.027, 10.97], 0.0042, 6)
  b.cyl(M.jugBrown, T(cx + 0.72, top + 0.05, 11.15), 0.04, 0.04, 0.1, 12)
  b.rbox(M.darkSteel, T(cx - 0.75, top, 10.6), 0.34, 0.12, 0.24, 0.01, 0, 0.06, 0)
  b.rod(M.steel, [cx - 0.85, top + 0.12, 10.55], [cx - 0.85, top + 0.55, 10.55], 0.004, 4)
  b.boxM(LED_AMBER, T(cx - 0.75, top, 10.6), 0.02, 0.01, 0.004, 0.08, 0.08, 0.122, { cast: false })
  placeModels(b, "telephone", [{ position: [cx + 0.75, top, 10.7], yaw: Math.PI - 0.3, collide: false }])
  deskLamp(b, cx - 0.55, top, 11.2, Math.PI - 0.5, true, { intensity: 55 })
  // Key box on the east wall (door open): the Facilities cabinet's key on its own hook, "FAC. CAB." (src/game/search).
  {
    const kb = keyCabinetOn(b, 16.94, y + 1.45, 14.5, { open: true, seed: 38, footer: "PROTECTIVE SERVICES 0-38 · SIGN OUT EVERY KEY", special: { col: 2, row: 1, label: "FAC. CAB.", fob: 0xd8c25a, keys: 1 } })
    securityKeyBox.keys = kb.keys
    securityKeyBox.at = kb.keys.userData.at as [number, number, number]
  }
  const ap = T(9.21 + 0.04, y + 1.5, 13.4, Math.PI / 2)
  b.rbox(M.beige, ap, 0.35, 0.28, 0.06, 0.01)
  for (let k = 0; k < 6; k++) b.boxM(k === 2 ? M.hazardRed : k === 0 ? LED_GREEN : M.hazardOff, ap, 0.02, 0.012, 0.004, -0.12 + k * 0.045, 0.08, 0.032, { cast: false })
  placeModels(b, "filing_cabinet", [{ position: [16.68, y, 19.5], yaw: yawToward(-1, 0) }, { position: [16.68, y, 19.0], yaw: yawToward(-1, 0) }])
  placeModels(b, "coat_rack", [{ position: [9.6, y, 20.9], yaw: 0.3 }])
  docs.wall("map_evac_0", 9.21, FLOOR_Y + 1.5, 16.0, 1, 0, { pin: "tack" })
  docs.wall("polaroid_corridor", 16.94, FLOOR_Y + 1.55, 13.7, -1, 0, { pin: "pin" })
  wastebasket(b, 12.0, 11.3)
  return r
}
const KEY_BRASS = paint(0x8a6a2a, 0.3, 0.9)

// ------------------------------------------------------------------------------------------------ 0-39 cafeteria

function cafeteria(b: Builder, docs: Docs): RoomHandle[] {
  const y = FLOOR_Y
  // Dining: two adjacent night-circuit troffers on (one lamp), wood-panelled walls.
  const dining = room(b, { id: "0-39", name: "Cafeteria", rect: rect(17.0, 34.65, 9.75, 21.65), lit: [[24.0, 15.6], [26.4, 15.6]], floor: "linoleum", troffers: { intensity: 22 }, windows: { blinds: "random", radiators: "models" } })
  const servery = room(b, { id: "0-39s", name: "Servery", rect: rect(17.0, 27.8, 1.75, 9.6), lit: "none", floor: "linoleum" })
  const kitchen = room(b, { id: "0-39k", name: "Kitchen", rect: rect(27.8, 34.65, 1.75, 9.6), lit: "none", floor: "terrazzo" })
  P(b, "x", 9.675, 17.06, 27.8, [ROOM_BANDS, PANEL_BANDS], [{ kind: "cased", from: 18.2, to: 26.8, head: 2.4 }], 0.15)
  P(b, "x", 9.675, 27.8, 34.65, [ROOM_BANDS, PANEL_BANDS], [], 0.15)
  P(b, "z", 27.8, 1.75, 9.6, [ROOM_BANDS, ROOM_BANDS], [door(6.8, "a", { id: "0-39K2", state: "closed", room: "0-39k" })])
  // Servery: steam table with wells and sneeze guard, tray rail, back counter with the menu board.
  const st = T(22.0, y, 5.6, Math.PI)
  b.rbox(STAINLESS, st, 5.0, 0.86, 0.75, 0.01, 0, 0.43, 0)
  b.boxM(M.rubber, st, 4.9, 0.1, 0.65, 0, 0.05, 0.04)
  for (let k = 0; k < 6; k++) b.boxM(M.darkSteel, st, 0.55, 0.004, 0.45, -2.0 + k * 0.8, 0.862, 0, { cast: false })
  for (const u of [-2.4, 0, 2.4]) b.rod(M.steel, ptIn(st, u, 0.86, -0.2), ptIn(st, u, 1.4, -0.3), 0.01, 6)
  b.quad(M.glass, st.clone().multiply(T(0, 1.42, -0.15, 0, -1.2)), 5.0, 0.45, { cast: false })
  for (const dz of [0.45, 0.55, 0.65]) b.rod(STAINLESS, ptIn(st, -2.5, 0.84, -dz), ptIn(st, 2.5, 0.84, -dz), 0.014, 8)
  for (const u of [-2.3, 0, 2.3]) b.box(STAINLESS, 22.0 + u - 0.015, y + 0.8, 5.95, 22.0 + u + 0.015, y + 0.83, 6.3)
  b.collide(19.5, y, 5.2, 24.5, y + 0.9, 6.3)
  sinkCounter(b, 21.0, 1.75 + 0.31 + 0.005, Math.PI, 3.0, 1)
  b.rbox(STAINLESS, T(24.4, y, 2.2), 1.6, 1.5, 0.6, 0.01, 0, 0.75, 0)
  b.collide(23.6, y, 1.9, 25.2, y + 1.5, 2.5)
  b.box(M.chalkboard, 19.0, y + 1.7, 1.81, 23.0, y + 2.5, 1.84)
  docs.wall("menu_cafeteria", 21.0, FLOOR_Y + 2.1, 1.845, 0, 1, { pin: "tape" })
  // Stack of trays at the rail's start.
  for (let k = 0; k < 12; k++) b.box(paint(0x5a3a22, 0.4), 24.55, y + 0.86 + k * 0.012, 5.35, 24.95, y + 0.87 + k * 0.012, 5.85, { cast: false })
  // Kitchen: range with canopy hood on the east wall, dish pit along the south wall, prep table.
  const rx = 34.61 - 0.45
  b.rbox(STAINLESS, T(rx, y, 4.5), 0.9, 0.9, 2.2, 0.01, 0, 0.45, 0)
  for (let k = 0; k < 6; k++) b.cyl(M.darkSteel, T(rx - 0.15 + (k % 2) * 0.3, y + 0.905, 3.8 + Math.floor(k / 2) * 0.7), 0.12, 0.12, 0.012, 16)
  b.collide(rx - 0.45, y, 3.4, 34.61, y + 0.9, 5.6)
  const hood = new THREE.CylinderGeometry(0.4, 0.75, 0.5, 4, 1, true)
  hood.rotateY(Math.PI / 4)
  hood.scale(0.95, 1, 2.0)
  hood.translate(rx - 0.05, y + 2.25, 4.5)
  b.add(STAINLESS, hood)
  b.box(STAINLESS, rx - 0.35, y + 2.5, 3.9, 34.61, CEIL_Y, 5.1)
  sinkCounter(b, 31.0, 9.6 - 0.31 - 0.005, 0, 3.2, 2)
  b.rbox(STAINLESS, T(31.0, y + 1.6, 9.42), 3.2, 0.03, 0.3, 0.005)
  table(b, 30.5, 5.6, 0, 1.8, 0.8, 0.9, STAINLESS, STAINLESS)
  placeModels(b, "trash_can", [{ position: [28.4, y, 8.8], yaw: 0.4 }])
  // Dining: tables in rows, stack chairs, three vending machines with their glow, cooler, bins, notice board.
  const rnd = rng(39)
  const chairs = []
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 2; j++) {
      const tx = 21.5 + i * 4.2
      const tz = 13.6 + j * 4.6
      table(b, tx, tz, 0, 2.2, 0.9, 0.74, M.wood, M.steel)
      for (let s = 0; s < 4; s++) {
        const side = s < 2 ? -1 : 1
        const u = (s % 2 ? 0.5 : -0.5) + (rnd() - 0.5) * 0.15
        chairs.push({ position: [tx + u, y, tz + side * (0.62 + rnd() * 0.15)] as const, yaw: (side > 0 ? 0 : Math.PI) + (rnd() - 0.5) * 0.5, inset: 0.08 })
      }
    }
  placeModels(b, "stack_chair", chairs)
  const [vw, , vd] = MODELS.vending_machine.size
  for (let k = 0; k < 3; k++) {
    const vz = 17.6 + k * (vw + 0.06)
    const vx = 34.61 - vd / 2 - 0.04
    placeModels(b, "vending_machine", [{ position: [vx, y, vz], yaw: yawToward(-1, 0) }])
    b.lamp({ kind: "window", position: [vx - vd / 2 - 0.35, y + 1.25, vz], color: [1.0, 0.92, 0.75], intensity: 2.2, range: 3.2, size: 0.5 })
  }
  placeModels(b, "water_cooler", [{ position: [34.61 - 0.2, y, 13.6], yaw: yawToward(-1, 0) }])
  placeModels(b, "trash_can", [{ position: [33.9, y, 15.0], yaw: 1.2 }, { position: [17.5, y, 20.9], yaw: 0.2 }])
  corkBoard(b, docs, 20.5, 9.75, 0, 1, 1.6, 1.0, ["menu_cafeteria", "flyer_bowling", "signup_bowling", "poster_missing_cat", "memo_coffee", "notice_firedoors", "calendar_oct84"], 39, FLOOR_Y + 1.05)
  placeModels(b, "wall_clock", [{ position: [17.06 + 0.03, FLOOR_Y + 2.45, 15.0], yaw: yawToward(1, 0), collide: false, blob: 0 }])
  return [dining, servery, kitchen]
}
