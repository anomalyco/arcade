import * as THREE from "three/webgpu"
import { MODELS } from "../../../../render/models"
import {
  type Band,
  type Builder,
  type DoorState,
  type Finish,
  type Mat,
  type POpening,
  type RoomHandle,
  CEIL_Y,
  FL1,
  FLOOR_Y,
  LAYER,
  M,
  PANEL_ON,
  ROOM_BANDS,
  T,
  ceiling,
  corridorBands,
  cot,
  drenchShower,
  emergencyPack,
  exitSign,
  eyewashStation,
  fluoroLamp,
  lockers,
  paint,
  partition,
  placeModels,
  rect,
  liftGate,
  room,
  sinkCounter,
  troffer,
  trofferGrid,
  troffers,
  wastebasket,
  yawToward,
} from "../../api"
import {
  BLOCK_BANDS,
  CLOTH_DARK,
  type Docs,
  SHOWER_BANDS,
  WHITE_COAT,
  YELLOW_SUIT,
  bench,
  bulkhead,
  corkBoard,
  garment,
  hookRail,
  lining,
  rng,
  roomOpen,
  table,
} from "./common"

// West wing north of the spine: staff entrance + time clock (0-10), health unit (0-11), change rooms (0-12/13), decon
// showers (0-14), clean side / FL-1 lobby (0-15), the freight lift FL-1, receiving (0-16), the sample-intake lab (0-17,
// concept r5-05, kept) with its core store, reprographics (0-18).

type Spec = { id: string; state: DoorState; room?: string; sign?: { number: string; label?: string }; double?: boolean; open?: number; width?: number; dutch?: boolean; insulated?: boolean; leaf?: "steel" | "veneer" | "glass" | Mat; glass?: "wire" | "none" }
export const door = (at: number, side: "a" | "b", d: Spec): POpening => ({ kind: "door", at, side, door: d })
export const P = (b: Builder, axis: "x" | "z", at: number, from: number, to: number, finish: [Finish, Finish], openings: POpening[] = [], thickness = 0.12) =>
  partition(b, { axis, at, from, to, finish, openings, thickness })

const ptIn = (m: THREE.Matrix4, x: number, y: number, z: number): [number, number, number] => {
  const v = new THREE.Vector3(x, y, z).applyMatrix4(m)
  return [v.x, v.y, v.z]
}

const CHECKER = paint(0x6c6e6a, 0.35, 0.85)
const RUBBER_MAT = paint(0x101110, 0.95)
const PORCELAIN = paint(0xd8d6cc, 0.18)
const VINYL = paint(0x2c3a36, 0.6)
const CORE_ROCK = paint(0x55524a, 0.85)

export async function buildWest(b: Builder, docs: Docs, pause: () => Promise<void>) {
  const rooms: RoomHandle[] = []
  rooms.push(...staffEntrance(b, docs))
  await pause()
  rooms.push(...changeAndDecon(b, docs))
  await pause()
  freightLift(b, docs)
  rooms.push(...receiving(b, docs))
  await pause()
  rooms.push(...lab(b, docs))
  await pause()
  rooms.push(reprographics(b, docs))
  return rooms
}

// ------------------------------------------------------------------------------------------------ 0-10 / 0-11

function staffEntrance(b: Builder, docs: Docs): RoomHandle[] {
  const y = FLOOR_Y
  // 0-10: the west door (facility leaf at z -10) needs a hole in the lining.
  const r10 = roomOpen(b, { id: "0-10", name: "Staff entrance", rect: rect(-54.65, -47.8, -13.0, -1.75), lit: "none", floor: "linoleum" }, ["west"])
  lining(b, "west", -13.0, -1.75, [{ a0: -10.56, a1: -9.44, top: 2.12 }])
  b.box("metal_galvanized", -54.65, FLOOR_Y, -10.55, -54.3, FLOOR_Y + 0.006, -9.45, { cast: false })
  const r11 = room(b, { id: "0-11", name: "Health unit", rect: rect(-54.65, -47.8, -21.65, -13.15), lit: "none", floor: "linoleum", windows: { blinds: "closed", radiators: "convector" } })
  P(b, "z", -47.8, -21.65, -1.75, [ROOM_BANDS, ROOM_BANDS])
  P(b, "x", -13.075, -54.65, -47.86, [ROOM_BANDS, ROOM_BANDS], [door(-49.4, "b", { id: "0-11", state: "closed", room: "0-11", sign: { number: "0-11", label: "HEALTH UNIT" } })], 0.15)

  // Exit sign, emergency pack (on: the room's only light), fire-alarm pull and extinguisher by the exit.
  exitSign(b, -54.61, -10.0, 1, 0)
  emergencyPack(b, -47.86, FLOOR_Y + 2.45, -10.0, -1, 0, true)
  b.rbox(M.red, T(-54.6, y + 1.25, -11.15, Math.PI / 2), 0.12, 0.16, 0.06, 0.01)
  b.boxM(M.jugWhite, T(-54.6, y + 1.23, -11.15, Math.PI / 2), 0.06, 0.03, 0.02, 0, 0, 0.035)
  b.box(M.darkSteel, -54.61, y + 0.95, -8.85, -54.55, y + 1.0, -8.55)
  placeModels(b, "fire_extinguisher", [{ position: [-54.61 + MODELS.fire_extinguisher.size[2] / 2 + 0.02, y + 0.42, -8.7], yaw: yawToward(1, 0), collide: false, blob: 0 }])

  // Time clock between the two card racks on the east wall: OUT rack (south) full, IN rack (north) with six SL cards.
  const xw = -47.86
  const clock = T(xw - 0.11, y + 1.42, -7.2, -Math.PI / 2)
  b.rbox(M.beige, clock, 0.34, 0.44, 0.2, 0.03)
  b.cyl(M.jugWhite, clock.clone().multiply(T(0, 0.06, -0.101, 0, Math.PI / 2)), 0.11, 0.11, 0.006, 24)
  b.cyl(M.darkSteel, clock.clone().multiply(T(0, 0.06, -0.106, 0, Math.PI / 2)), 0.116, 0.116, 0.004, 24, { open: true })
  b.boxM(M.felt, clock, 0.006, 0.075, 0.004, 0, 0.09, -0.108)
  b.boxM(M.felt, clock.clone().multiply(T(0, 0.06, 0, 0, 0, 1.9)), 0.005, 0.09, 0.004, 0, 0.045, -0.108)
  b.boxM(M.darkSteel, clock, 0.12, 0.012, 0.02, 0, -0.14, -0.1)
  b.boxM(M.felt, clock, 0.1, 0.006, 0.01, 0, -0.14, -0.111)
  b.collide(xw - 0.21, y + 1.2, -7.37, xw, y + 1.64, -7.03)
  // Night light over the time clock so the card racks read (coordinator: vignette too dark).
  bulkhead(b, xw, y + 2.6, -7.2, -1, 0, true, 7, { range: 4.5 })
  rack(b, docs, xw, -8.25, true)
  rack(b, docs, xw, -6.15, false)
  // Bench, coat hooks with two coats, a notice board on the north wall.
  bench(b, -52.6, -12.75, Math.PI, 2.0)
  hookRail(b, -52.6, -13.015, Math.PI, 2.2, 7)
  garment(b, -53.3, FLOOR_Y + 1.65, -13.02, Math.PI, CLOTH_DARK, 1.0)
  garment(b, -51.9, FLOOR_Y + 1.65, -13.02, Math.PI, paint(0x3a3226, 0.9), 0.9)
  corkBoard(b, docs, -52.6, -13.015, 0, 1, 1.1, 0.8, ["notice_sublevel", "notice_nightshift", "flyer_bowling", "memo_coffee"], 11, FLOOR_Y + 1.85)
  docs.wall("map_evac_0", -54.61, FLOOR_Y + 1.5, -12.0, 1, 0, { pin: "tack" })
  wastebasket(b, -48.25, -2.3)
  placeModels(b, "wet_floor_sign", [{ position: [-53.5, y, -9.9], yaw: 0.6, inset: 0.05 }])
  // Rubber entrance mat inside the door.
  b.box(RUBBER_MAT, -54.3, FLOOR_Y, -11.0, -52.8, FLOOR_Y + LAYER * 2, -9.0, { cast: false })

  // 0-11 health unit: exam couch, cot, sink + eyewash, scale, glass cabinet.
  const exam = T(-51.0, y, -18.6, 0)
  b.rbox(M.cabinet, exam, 0.62, 0.55, 1.8, 0.02, 0, 0.3, 0)
  b.rbox(VINYL, exam, 0.66, 0.12, 1.86, 0.05, 0, 0.64, 0)
  b.rbox(VINYL, exam.clone().multiply(T(0, 0.7, -0.62, 0, -0.45)), 0.66, 0.1, 0.6, 0.05, 0, 0, -0.25)
  b.boxM(M.paper, exam, 0.5, 0.004, 1.2, 0, 0.702, 0.2, { cast: false })
  b.collideLocal(exam, [-0.33, 0, -0.95], [0.33, 0.9, 0.95])
  cot(b, -53.5, -15.0, Math.PI / 2)
  sinkCounter(b, -48.2, -18.6, yawToward(-1, 0), 1.4, 1)
  eyewashStation(b, -47.95, -16.7, yawToward(-1, 0))
  b.rbox(M.steel, T(-53.8, y, -14.0), 0.36, 0.06, 0.42, 0.02, 0, 0.03, 0)
  b.rod(M.steel, [-53.8, y + 0.06, -13.84], [-53.8, y + 1.45, -13.84], 0.018, 8)
  b.rbox(M.steel, T(-53.8, y + 1.3, -13.84), 0.3, 0.05, 0.05, 0.01)
  b.collide(-54.0, y, -14.21, -53.6, y + 1.5, -13.79)
  const cab = T(-53.0, y, -21.61 + 0.2)
  b.rbox(M.jugWhite, cab, 0.9, 1.8, 0.38, 0.01, 0, 0.9, 0)
  b.quad(M.glass, cab.clone().multiply(T(0, 1.3, -0.192, Math.PI)), 0.8, 0.9, { cast: false })
  for (let k = 0; k < 8; k++) b.cyl(k % 3 ? M.jugBrown : M.jugWhite, cab.clone().multiply(T(-0.3 + k * 0.085, 1.0 + (k % 2) * 0.4, 0)), 0.03, 0.03, 0.12, 8)
  b.collideLocal(cab, [-0.45, 0, -0.19], [0.45, 1.8, 0.19])
  return [r10, r11]
}

/** Time-card rack: two columns of eight pockets on the wall at xw (facing −x); cards stand in them. */
function rack(b: Builder, docs: Docs, xw: number, zc: number, isIn: boolean) {
  const y0 = FLOOR_Y + 0.95
  b.box(M.darkSteel, xw - 0.012, y0, zc - 0.33, xw, y0 + 1.0, zc + 0.33)
  const rnd = rng(isIn ? 5 : 9)
  for (let col = 0; col < 2; col++)
    for (let row = 0; row < 8; row++) {
      const z = zc - 0.16 + col * 0.32
      const py = y0 + 0.08 + row * 0.115
      b.box(M.steel, xw - 0.03, py, z - 0.11, xw - 0.012, py + 0.035, z + 0.11, { cast: false })
      // IN rack: the top three pockets of each column hold the SL cards, tabbed red; the rest are empty.
      // OUT rack: most pockets hold the day staff's cards.
      const sl = isIn && row >= 5
      const has = sl || (!isIn && rnd() < 0.8)
      if (sl) b.box(M.red, xw - 0.031, py + 0.036, z - 0.1, xw - 0.029, py + 0.046, z - 0.06, { cast: false })
      if (!has) continue
      if (sl) docs.add(row % 2 ? "timecard_halverson" : "timecard_lindqvist", [xw - 0.019, py + 0.07, z], [-1, 0, 0], { pin: "none", curl: 0.05, rotation: (rnd() - 0.5) * 0.06, scale: 0.9 })
      else b.box(M.paper, xw - 0.022, py + 0.01, z - 0.04, xw - 0.019, py + 0.11, z + 0.04, { cast: false })
    }
  // Rack labels (blank strips; IN rack has a red "SL" strip across its top row).
  b.box(M.paper, xw - 0.014, y0 + 1.01, zc - 0.2, xw - 0.012, y0 + 1.06, zc + 0.2, { cast: false })
  if (isIn) b.box(M.red, xw - 0.016, y0 + 0.66, zc - 0.31, xw - 0.014, y0 + 0.68, zc + 0.31, { cast: false })
}

// ------------------------------------------------------------------------------------------------ 0-12 .. 0-15

function changeAndDecon(b: Builder, docs: Docs): RoomHandle[] {
  const y = FLOOR_Y
  const rM = rect(-47.8, -43.6, -14.0, -1.75)
  const rW = rect(-43.6, -37.0, -14.0, -1.75)
  const r12 = room(b, { id: "0-12", name: "Change room (men)", rect: rM, lit: "none", floor: "terrazzo" })
  const gW = trofferGrid(rW)
  const mid = gW.reduce((best, c) => (Math.hypot(c.x + 40.3, c.z + 7.9) < Math.hypot(best.x + 40.3, best.z + 7.9) ? c : best), gW[0]!)
  const r13 = room(b, { id: "0-13", name: "Change room (women)", rect: rW, lit: [[mid.x, mid.z]], floor: "terrazzo", troffers: { flicker: [[mid.x, mid.z]], intensity: 18 } })
  P(b, "z", -43.6, -14.0, -1.75, [ROOM_BANDS, ROOM_BANDS])
  P(b, "x", -14.075, -47.8, -41.5, [SHOWER_BANDS, ROOM_BANDS], [
    door(-45.5, "b", { id: "0-12N", state: "closed", room: "0-14" }),
    door(-42.55, "b", { id: "0-13N", state: "closed", room: "0-14" }),
  ], 0.15)
  P(b, "x", -14.075, -41.5, -37.0, [ROOM_BANDS, ROOM_BANDS], [], 0.15)
  for (const [x0, x1, seed] of [[-47.8, -43.6, 2], [-43.6, -37.0, 3]] as const) {
    const cx = (x0 + x1) / 2
    lockers(b, x0 + 0.06 + 0.235, -8.0, yawToward(1, 0), 10)
    bench(b, cx + 0.3, -8.0, Math.PI / 2, 2.6)
    sinkCounter(b, x1 - 0.06 - 0.31, -4.0, yawToward(-1, 0), 1.8, 2)
    b.box(M.steel, x1 - 0.07, y + 1.15, -4.85, x1 - 0.06, y + 1.95, -3.15, { cast: false })
    hookRail(b, cx, -13.94, 0, 2.6, 7, FLOOR_Y + 1.7)
    const rnd = rng(seed)
    for (let k = 0; k < 3; k++) garment(b, cx - 1.0 + k * 0.85 + rnd() * 0.1, FLOOR_Y + 1.7, -13.92, 0, YELLOW_SUIT, 1.35)
    wastebasket(b, x1 - 0.3, -2.3)
  }
  docs.wall("poster_radiation", -37.06 - 0.0, FLOOR_Y + 1.6, -11.0, -1, 0, { pin: "tape" })

  // 0-14 decon showers (concept r4-04): tiled, four stalls on the west wall, drench head, drains, curb, boot rack.
  const rD = rect(-47.8, -41.5, -21.65, -14.15)
  const gD = trofferGrid(rD)
  const cD = gD[Math.floor(gD.length / 2)]!
  const r14 = room(b, { id: "0-14", name: "Decontamination showers", rect: rD, lit: [[cD.x, cD.z]], floor: "tile_green_dark", windows: { blinds: "closed", radiators: "none" }, troffers: { intensity: 16 } })
  P(b, "x", -21.615, -47.8, -41.5, [ROOM_BANDS, SHOWER_BANDS], [], 0.0)
  const wx = -47.74
  for (let k = 0; k < 4; k++) {
    const z0 = -20.9 + k * 1.6
    const zc = z0 + 0.8
    if (k > 0) {
      b.box("tile_green", wx, y, z0 - 0.05, wx + 1.0, y + 1.85, z0 + 0.05)
      b.box(M.steel, wx + 1.0, y, z0 - 0.06, wx + 1.03, y + 1.85, z0 + 0.06)
      b.collide(wx, y, z0 - 0.06, wx + 1.03, y + 1.85, z0 + 0.06)
    }
    // Head on an arm, mixing valve, drain.
    b.rod(M.steel, [wx, y + 2.05, zc], [wx + 0.28, y + 2.0, zc], 0.012, 8)
    b.cyl(M.steel, T(wx + 0.32, y + 1.97, zc, 0, 0, -0.5), 0.05, 0.025, 0.06, 14)
    b.cyl(M.steel, T(wx + 0.005, y + 1.15, zc, 0, 0, Math.PI / 2), 0.06, 0.06, 0.012, 16)
    b.rbox(M.steel, T(wx + 0.04, y + 1.15, zc), 0.04, 0.025, 0.12, 0.008)
    b.cyl(M.darkSteel, T(wx + 0.55, y + 0.003, zc), 0.08, 0.08, 0.002, 16, { cast: false })
  }
  b.box("tile_green_dark", wx + 1.0, y, -20.9, wx + 1.06, y + 0.06, -14.5, { cast: false })
  // Drench head in the middle of the room with its pull chain, central drain.
  const dz = -17.9
  b.rod(M.safety, [-44.0, CEIL_Y, dz], [-44.0, CEIL_Y - 0.3, dz], 0.02, 8)
  b.cyl(M.steel, T(-44.0, CEIL_Y - 0.36, dz), 0.06, 0.16, 0.1, 18, { open: true })
  b.rod(M.steel, [-43.9, CEIL_Y - 0.32, dz], [-43.9, FLOOR_Y + 1.6, dz], 0.003, 4)
  b.cyl(M.darkSteel, T(-44.0, y + 0.003, dz), 0.12, 0.12, 0.002, 18, { cast: false })
  // Boot rack and hose reel on the east wall, a coverall on a hook (concept), emergency stop button.
  const ex = -41.56
  for (let k = 0; k < 2; k++) b.box(M.darkSteel, ex - 0.32, y + 0.2 + k * 0.35, -20.6, ex, y + 0.23 + k * 0.35, -18.8)
  for (let k = 0; k < 4; k++) {
    b.rbox(M.rubber, T(ex - 0.16, y + 0.23, -20.4 + k * 0.42), 0.12, 0.3, 0.26, 0.04, 0, 0.15, 0)
  }
  b.collide(ex - 0.34, y, -20.65, ex, y + 0.6, -18.75)
  const hose = T(ex - 0.12, y + 1.3, -15.6, Math.PI / 2)
  b.cyl(M.red, hose.clone().multiply(T(0, 0, 0, 0, Math.PI / 2)), 0.25, 0.25, 0.12, 20)
  b.cyl(M.rubber, hose.clone().multiply(T(0, 0, 0.0, 0, Math.PI / 2)), 0.2, 0.2, 0.13, 20)
  hookRail(b, -42.5, -14.21, Math.PI, 1.6, 4, FLOOR_Y + 1.75)
  garment(b, -42.9, FLOOR_Y + 1.75, -14.24, Math.PI, YELLOW_SUIT, 1.45)
  b.rbox(M.darkSteel, T(-46.6, y + 1.35, -14.21, Math.PI), 0.16, 0.16, 0.06, 0.01)
  b.cyl(M.red, T(-46.6, y + 1.35, -14.28, 0, Math.PI / 2), 0.045, 0.05, 0.04, 16)

  // 0-15 clean side / FL-1 lobby: bench, rubber matting, dosimeter board and rack (two badges gone), caged bulkhead.
  const r15 = room(b, { id: "0-15", name: "Clean side / FL-1 lobby", rect: rect(-41.5, -37.0, -21.65, -14.15), lit: "none", troffers: false, floor: "linoleum", windows: { blinds: "closed", radiators: "convector" } })
  P(b, "z", -41.5, -21.65, -14.15, [SHOWER_BANDS, ROOM_BANDS], [door(-16.6, "b", { id: "0-14E", state: "closed", room: "0-15" })])
  b.box(RUBBER_MAT, -41.44, FLOOR_Y, -21.0, -37.6, FLOOR_Y + LAYER * 2, -14.6, { cast: false })
  bulkhead(b, -39.2, CEIL_Y, -17.8, 0, 0, true, 12)
  // Gate light on the FL-1 enclosure wall, so the locked gate and its signs read from the lobby.
  bulkhead(b, -37.075, y + 2.55, -20.4, -1, 0, true, 8, { range: 5 })
  bench(b, -40.9, -18.2, -Math.PI / 2, 2.4)
  const bx = -38.0
  b.box(M.wood, bx - 0.5, y + 1.15, -14.25, bx + 0.5, y + 1.75, -14.21)
  for (let k = 0; k < 10; k++) {
    const u = bx - 0.42 + (k % 5) * 0.21
    const v = y + 1.62 - Math.floor(k / 5) * 0.28
    b.rod(M.steel, [u, v, -14.25], [u, v - 0.01, -14.3], 0.004, 4)
    if (k === 3 || k === 7) continue
    b.rbox(k % 2 ? M.jugWhite : M.beige, T(u, v - 0.07, -14.265), 0.05, 0.08, 0.012, 0.004)
  }
  docs.wall("board_dosimeter", bx, FLOOR_Y + 2.0, -14.152, 0, -1, { pin: "none", curl: 0 })
  docs.wall("notice_sublevel", -37.06, FLOOR_Y + 1.55, -15.3, -1, 0, { pin: "tape" })
  return [r12, r13, r14, r15]
}

// ------------------------------------------------------------------------------------------------ FL-1

/** Freight lift FL-1: block shaft enclosure, the car standing at the ground stop, two locked collapsible gates. */
function freightLift(b: Builder, docs: Docs) {
  const y = FLOOR_Y
  const c = FL1.car
  const xs = -33.0
  const zs = c.z1 + 0.2
  // Shaft north line: on the facade while the car runs up to it, else its own wall behind the dock platform.
  const zN = Math.max(-21.65, c.z0 - 0.1)
  const gz0 = c.z0 + 0.9
  const gz1 = c.z1 - 0.9
  // West wall (clean side | shaft, gate) — the same line continues south between 0-13 and receiving.
  P(b, "z", -37.0, -21.65, zs + 1.15, [ROOM_BANDS, PLANT_BANDS_], [{ kind: "cased", from: gz0, to: gz1, head: 2.4 }], 0.15)
  P(b, "z", -37.0, zs + 1.3, -1.75, [ROOM_BANDS, BLOCK_BANDS], [], 0.15)
  P(b, "x", zs, -36.925, xs + 0.075, [PLANT_BANDS_, BLOCK_BANDS], [{ kind: "cased", from: -36.4, to: -33.6, head: 2.4 }], 0.15)
  if (zN > -21.5) P(b, "x", zN - 0.075, -36.925, xs + 0.075, [BLOCK_BANDS, PLANT_BANDS_], [], 0.15)
  // East wall from the shaft's north line (the dock platform runs along its north side).
  P(b, "z", xs, zN > -21.5 ? zN - 0.15 : -20.5, zs - 0.075, [PLANT_BANDS_, BLOCK_BANDS], [], 0.15)
  dockPlatform(b, zN > -21.5 ? zN - 0.15 : c.z0)
  // Pit floor under the car (dark), car platform flush with the landings, sill plates.
  b.box(M.concrete, -36.925, y - 0.4, zN > -21.5 ? zN : -21.61, xs - 0.075, y - 0.3, zs - 0.075, { cast: false, skip: "y" })
  b.box(CHECKER, c.x0, y - 0.12, c.z0, c.x1, y + 0.004, c.z1)
  b.walk(c.x0, c.z0, c.x1, c.z1, y + 0.004)
  b.box(CHECKER, -36.925, y - 0.05, gz0, c.x0, y + 0.004, gz1)
  b.walk(-36.925, gz0, c.x0, gz1, y + 0.004)
  b.box(CHECKER, -36.4, y - 0.05, c.z1, -33.6, y + 0.004, zs - 0.075)
  b.walk(-36.4, c.z1, -33.6, zs - 0.075, y + 0.004)
  // Car: corner posts, crosshead, plywood-lined north and east sides with bumper rails, steel canopy.
  const top = y + 2.6
  for (const [px, pz] of [[c.x0, c.z0], [c.x1, c.z0], [c.x0, c.z1], [c.x1, c.z1]] as const) b.box(M.darkSteel, px - 0.04, y, pz - 0.04, px + 0.04, top, pz + 0.04)
  b.box(M.plywood, c.x0 + 0.04, y + 0.004, c.z0, c.x1 - 0.04, top - 0.1, c.z0 + 0.02)
  b.box(M.plywood, c.x1 - 0.02, y + 0.004, c.z0 + 0.04, c.x1, top - 0.1, c.z1 - 0.04)
  for (const h of [0.35, 1.0]) {
    b.box(M.darkSteel, c.x0 + 0.04, y + h, c.z0 + 0.02, c.x1 - 0.04, y + h + 0.12, c.z0 + 0.06)
    b.box(M.darkSteel, c.x1 - 0.06, y + h, c.z0 + 0.04, c.x1 - 0.02, y + h + 0.12, c.z1 - 0.04)
  }
  b.box(M.darkSteel, c.x0 - 0.04, top, c.z0 - 0.04, c.x1 + 0.04, top + 0.04, c.z1 + 0.04)
  b.box(M.darkSteel, (c.x0 + c.x1) / 2 - 0.1, top + 0.04, c.z0 - 0.04, (c.x0 + c.x1) / 2 + 0.1, top + 0.3, c.z1 + 0.04)
  for (const [x0, x1, z0, z1] of [[c.x0, c.x1, c.z0, c.z0 + 0.02], [c.x1 - 0.02, c.x1, c.z0, c.z1]] as const) b.collide(x0, y, z0, x1, top, z1)
  bulkhead(b, (c.x0 + c.x1) / 2, top, (c.z0 + c.z1) / 2 + 1.0, 0, 0, false)
  // Car operating panel on the east lining: SL / 0 buttons, key switch, emergency stop.
  const op = T(c.x1 - 0.025, y + 1.3, c.z1 - 0.45, -Math.PI / 2)
  b.rbox(M.steel, op, 0.2, 0.4, 0.02, 0.005)
  for (const k of [0, 1]) b.cyl(k ? M.amberGlow : M.darkSteel, op.clone().multiply(T(0, 0.08 - k * 0.09, -0.014, 0, Math.PI / 2)), 0.022, 0.022, 0.01, 12)
  b.cyl(KEY, op.clone().multiply(T(0, -0.1, -0.014, 0, Math.PI / 2)), 0.016, 0.016, 0.012, 12)
  b.cyl(M.red, op.clone().multiply(T(0, -0.16, -0.016, 0, Math.PI / 2)), 0.02, 0.025, 0.02, 12)
  // Landing gates (static, shut and locked: keycard sublevel) with indicators and call stations.
  // Light over the receiving-side gate.
  bulkhead(b, -35.0, y + 2.75, zs + 0.075, 0, 1, true, 8, { range: 5 })
  // Real gates in the door system (kit liftGate): locked with the sublevel keycard, they fold when unlocked.
  liftGate(b, { axis: "z", at: -37.0, from: gz0, to: gz1, id: "FL-1W", state: "keycard:sublevel", room: "FL-1", sign: { number: "FL-1", label: "FREIGHT — SUBLEVEL" } })
  liftGate(b, { axis: "x", at: zs, from: -36.4, to: -33.6, id: "FL-1S", state: "keycard:sublevel", room: "FL-1", sign: { number: "FL-1", label: "FREIGHT — SUBLEVEL" } })
  // Position indicator over each gate (0 lit), key-switch call station, hazard floor stripes, signs.
  for (const [ix, iz, yaw] of [[-37.09, (gz0 + gz1) / 2, -Math.PI / 2], [-35.0, zs + 0.09, 0]] as const) {
    const m = T(ix, y + 2.62, iz, yaw)
    b.rbox(M.darkSteel, m, 0.42, 0.14, 0.05, 0.01)
    b.boxM(M.hazardOff, m, 0.1, 0.07, 0.004, -0.09, 0, 0.026, { cast: false })
    b.boxM(M.amberGlow, m, 0.1, 0.07, 0.004, 0.09, 0, 0.026, { cast: false })
  }
  const cs = T(-33.25, y + 1.25, zs + 0.09)
  b.rbox(M.steel, cs, 0.14, 0.26, 0.03, 0.005)
  b.cyl(KEY, cs.clone().multiply(T(0, 0.05, 0.016, 0, Math.PI / 2)), 0.016, 0.016, 0.012, 12)
  b.cyl(M.darkSteel, cs.clone().multiply(T(0, -0.05, 0.016, 0, Math.PI / 2)), 0.022, 0.022, 0.01, 12)
  b.box(M.hazard, -36.4, FLOOR_Y, zs + 0.09, -33.6, FLOOR_Y + LAYER, zs + 0.6, { cast: false })
  docs.wall("notice_sublevel", -32.3, FLOOR_Y + 1.6, zs + 0.078, 0, 1, { pin: "tape" })
  docs.wall("board_dosimeter", -35.0, FLOOR_Y + 2.92, zs + 0.078, 0, 1, { pin: "none", curl: 0, scale: 0.8 })
}

const KEY = paint(0x8a6a2a, 0.3, 0.9)
const PLANT_BANDS_: Band[] = [[0, 99, "concrete_wall"]]

/** Collapsible scissor gate filling an opening (axis: the wall's axis, at its line, from..to), locked shut. */

/**
 * Dock platform inside the north wall at dock height (1.25 m), behind all three dock doors (shut roll-up, open
 * roll-up, man door): x −36.94..−23.2, 1.5 m deep (only to the FL-1 shaft's north wall where the shaft reaches
 * further north: `zShaft`). Checker-plate levellers in front of the roll-ups, a 7-riser stair down to receiving
 * between the open roll-up and the man door, pipe guard rail along the drop with a collider.
 */
function dockPlatform(b: Builder, zShaft: number) {
  const y = FLOOR_Y
  const top = 1.25
  const z0 = -21.61
  const zF = -20.11
  const xs = -33.0 + 0.075
  // West part (behind the shut roll-up, over the shaft) and east part.
  const parts = [
    { x0: -36.925, x1: xs, z1: Math.min(zF, zShaft) },
    { x0: xs, x1: -23.2, z1: zF },
  ]
  for (const p of parts) {
    if (p.z1 - z0 < 0.3) continue
    b.box(M.concrete, p.x0, y, z0, p.x1, top - 0.006, p.z1, { skip: "y" })
    b.box("concrete_floor_dry", p.x0, top - 0.006, z0, p.x1, top, p.z1, { skip: "y" })
    b.walk(p.x0, z0 - 0.06, p.x1, p.z1, top)
    b.collide(p.x0, y, z0, p.x1, top - 0.05, p.z1)
    b.box(M.safety, p.x0, top - 0.03, p.z1 - 0.06, p.x1, top + 0.004, p.z1 + 0.003, { cast: false })
  }
  // Checker-plate levellers flush in the platform in front of each roll-up (lip on the door sill).
  for (const [u0, u1] of [[-35.5, -32.3], [-29.7, -26.5]] as const) {
    const zl = u0 < -33 ? Math.min(zF, zShaft) : zF
    b.box(CHECKER, u0 + 0.1, top - 0.004, z0, u1 - 0.1, top + 0.004, Math.min(z0 + 1.8, zl - 0.1), { cast: false })
  }
  // Stair down to receiving: 7 risers of 0.156 m, 0.28 m goings, between the open roll-up and the man door.
  const sx0 = -26.25
  const sx1 = -25.05
  const n = 7
  const rise = (top - y) / n
  for (let k = 1; k < n; k++) {
    const t = top - k * rise
    const za = zF + (k - 1) * 0.28
    b.box("concrete_floor_dry", sx0, y, za, sx1, t, za + 0.28, { skip: "y" })
    b.box(M.safety, sx0 + 0.02, t - 0.025, za + 0.25, sx1 - 0.02, t + 0.003, za + 0.283, { cast: false })
    b.walk(sx0, za, sx1, za + 0.28, t)
  }
  const zEnd = zF + (n - 1) * 0.28
  // Stair handrails both sides (posts on treads, continuous rail, returns down at the ends).
  for (const x of [sx0 - 0.03, sx1 + 0.03]) {
    b.rod("metal_galvanized", [x, top + 0.9, zF - 0.3], [x, top + 0.9, zF], 0.021, 8)
    b.rod("metal_galvanized", [x, top + 0.9, zF], [x, y + 0.9 + rise, zEnd], 0.021, 8)
    b.rod("metal_galvanized", [x, y + 0.9 + rise, zEnd], [x, y + 0.9, zEnd + 0.3], 0.021, 8)
    for (const z of [zF - 0.25, zF + 0.7, zF + 1.4]) {
      const ty = z < zF ? top : top - Math.ceil((z - zF) / 0.28) * rise
      b.rod("metal_galvanized", [x, ty, z], [x, ty + 0.9 + (z < zF ? 0 : 0.05), z], 0.02, 8)
    }
    b.collide(x - 0.03, y, zF, x + 0.03, top + 0.9, zEnd)
  }
  // Guard rail along the platform's drop (gap at the stair), posts every ~1.5 m, mid rail; collider to 1.1 m.
  const runs: [number, number, number][] = [
    [-36.9, xs, Math.min(zF, zShaft)],
    [xs, sx0 - 0.03, zF],
    [sx1 + 0.03, -23.2, zF],
  ]
  for (const [a, c2, zr] of runs) {
    if (c2 - a < 0.3) continue
    const z = zr - 0.04
    b.rod("metal_galvanized", [a, top + 1.0, z], [c2, top + 1.0, z], 0.021, 8)
    b.rod("metal_galvanized", [a, top + 0.5, z], [c2, top + 0.5, z], 0.014, 8)
    const nPost = Math.max(1, Math.round((c2 - a) / 1.5))
    for (let k = 0; k <= nPost; k++) {
      const x = a + 0.03 + ((c2 - a - 0.06) * k) / nPost
      b.rod("metal_galvanized", [x, top, z], [x, top + 1.0, z], 0.02, 8)
    }
    b.collide(a, top, z - 0.04, c2, top + 1.1, z + 0.04)
  }
}

// ------------------------------------------------------------------------------------------------ 0-16 receiving

function receiving(b: Builder, docs: Docs): RoomHandle[] {
  const y = FLOOR_Y
  // A: the dock half (no ceiling over the facility's dock bay), B: the south part beside the lab.
  const rA = roomOpen(b, { id: "0-16", name: "Receiving & stores", rect: rect(-37.0, -20.8, -21.65, -9.75), lit: "none", floor: "concrete_floor_dry", ceiling: { none: true }, troffers: false }, ["north"])
  const rB = room(b, { id: "0-16b", name: "Receiving (south)", rect: rect(-37.0, -25.65, -9.75, -1.75), lit: "none", floor: "concrete_floor_dry" })
  lining(b, "north", -37.0, -20.8, [
    { a0: -29.7, a1: -26.5, bottom: 1.09, top: 99 },
    { a0: -24.8, a1: -23.7, bottom: 1.09, top: 3.2 },
  ])
  // No suspended ceiling over the dock platform (1.25 m up: it would leave 1.85 m headroom); open to the slab.
  ceiling(b, -37.0, -20.0, -20.8, -9.75)
  troffers(b, [
    { x: -30.0, z: -12.0, on: true },
    { x: -34.2, z: -12.0, on: false },
    { x: -24.6, z: -13.2, on: false },
    { x: -22.2, z: -18.0, on: false },
  ], { perLamp: 1, intensity: 11 })
  P(b, "z", -20.8, -21.65, -9.75, [BLOCK_BANDS, ROOM_BANDS])
  // Pallets with freight, hand truck, shelves, drums, a platform scale, the foreman's desk with the clipboard.
  placeModels(b, "pallet", [
    { position: [-30.0, y, -12.6], yaw: 0.1 },
    { position: [-27.6, y, -13.2], yaw: -0.05 },
    { position: [-35.2, y, -8.0], yaw: 1.57 },
    { position: [-35.2, y, -5.6], yaw: 1.6 },
  ])
  const bh = MODELS.cardboard_box.size[1]
  const ph = MODELS.pallet.size[1]
  const boxes = []
  const rnd = rng(16)
  for (const [px, pz] of [[-30.0, -12.6], [-35.2, -8.0]] as const)
    for (let k = 0; k < 6; k++) boxes.push({ position: [px - 0.3 + (k % 2) * 0.55, y + ph + Math.floor(k / 4) * bh, pz - 0.35 + (Math.floor(k / 2) % 2) * 0.62] as const, yaw: (rnd() - 0.5) * 0.2, collide: k === 0, blob: 0 })
  placeModels(b, "cardboard_box", boxes)
  placeModels(b, "drum_steel", [
    { position: [-27.4, y + ph, -13.4], yaw: 0.3, collide: false, blob: 0 },
    { position: [-27.9, y + ph, -12.85], yaw: 1.2, collide: false, blob: 0 },
    { position: [-21.5, y, -14.0], yaw: 2.1 },
  ])
  placeModels(b, "hand_truck", [{ position: [-32.0, y, -14.6], yaw: 0.7 }])
  placeModels(b, "steel_shelves", [
    { position: [-21.25, y, -19.5], yaw: yawToward(-1, 0), inset: 0.03 },
    { position: [-21.25, y, -17.1], yaw: yawToward(-1, 0), inset: 0.03 },
    { position: [-36.5, y, -11.4], yaw: yawToward(1, 0), inset: 0.03 },
  ])
  // Platform scale: steel deck on the floor and a dial on a column.
  b.box(CHECKER, -33.4, y, -12.2, -32.2, y + 0.06, -11.0)
  b.rod(M.darkSteel, [-32.1, y, -11.05], [-32.1, y + 1.2, -11.05], 0.03, 10)
  b.cyl(M.jugWhite, T(-32.1, y + 1.35, -11.05, 0, Math.PI / 2, 0), 0.16, 0.16, 0.06, 24)
  b.cyl(M.darkSteel, T(-32.1, y + 1.35, -11.02, 0, Math.PI / 2, 0), 0.165, 0.165, 0.04, 24, { open: true })
  b.collide(-33.4, y, -12.2, -32.0, y + 0.06, -11.0)
  b.collide(-32.16, y, -11.12, -32.04, y + 1.5, -10.98)
  placeModels(b, "office_desk", [{ position: [-33.8, y, -3.0], yaw: Math.PI }])
  placeModels(b, "office_chair", [{ position: [-33.6, y, -3.95], yaw: 0.4, inset: 0.12 }])
  const dtop = y + MODELS.office_desk.size[1]
  const clip = T(-33.4, dtop, -3.0, 2.9)
  b.boxM(M.clipboard, clip, 0.23, 0.006, 0.32, 0, 0.003, 0, { cast: false })
  docs.flat("memo_carbon_inventory", -33.4, dtop + 0.0065, -3.0, 2.9 - Math.PI, { scale: 0.95 })
  placeModels(b, "telephone", [{ position: [-34.4, dtop, -2.85], yaw: 3.4, collide: false }])
  corkBoard(b, docs, -33.8, -1.75, 0, -1, 1.2, 0.8, ["checklist_rounds", "notice_north_lot", "form_requisition", "calendar_oct84"], 19, FLOOR_Y + 1.25)
  docs.wall("poster_chemical", -25.71, FLOOR_Y + 1.55, -6.0, -1, 0, { pin: "tape" })
  wastebasket(b, -32.3, -2.3)
  return [rA, rB]
}

// ------------------------------------------------------------------------------------------------ 0-17 lab + core store

const LAB = { x0: -25.5, x1: -17, z0: -9.6, z1: -1.75 }
const WARM: [number, number, number] = [1.0, 0.68, 0.38]

/** The sample-intake lab as built (concept r5-05), now with its door to the core store, and the store itself. */
function lab(b: Builder, docs: Docs): RoomHandle[] {
  const { x0, x1, z0 } = LAB
  const y = FLOOR_Y
  P(b, "z", -25.575, -9.75, -1.75, [BLOCK_BANDS, corridorBands], [], 0.15)
  P(b, "z", -16.925, -9.75, -1.75, [corridorBands, ROOM_BANDS], [door(-6.0, "a", { id: "0-17E", state: "closed", room: "0-17s", sign: { number: "0-17A", label: "CORE STORE" } })], 0.15)
  P(b, "x", -9.675, -25.65, -20.8, [BLOCK_BANDS, corridorBands], [], 0.15)
  P(b, "x", -9.675, -20.8, -16.85, [ROOM_BANDS, corridorBands], [], 0.15)
  ceiling(b, x0, z0, x1, LAB.z1)
  for (const tx of [-23.4, -19.2])
    for (const tz of [-3.6, -7.2]) {
      const lit = tx === -23.4 && tz === -7.2
      troffer(b, tx, tz, lit ? "on" : "off", PANEL_ON)
      if (lit) b.lamp({ ...fluoroLamp(tx, tz, 60), color: [0.86, 0.95, 0.62], flicker: 0.15 })
    }
  benchRunX(b, x0, -19.8, z0, z0 + 0.68)
  benchRunZ(b, z0 + 0.68, -4.1, x0, x0 + 0.68)
  const sx = -20.6
  b.box(M.steel, sx - 0.3, y + 0.935, z0 + 0.12, sx + 0.3, y + 0.94, z0 + 0.56, { cast: false })
  b.rod(M.steel, [sx, y + 0.93, z0 + 0.08], [sx, y + 1.25, z0 + 0.08], 0.012)
  b.rod(M.steel, [sx, y + 1.25, z0 + 0.08], [sx, y + 1.22, z0 + 0.3], 0.012)
  eyewashStation(b, -18.0, z0 + 0.15, 0)
  // Canopy hood over the west bench, duct into the ceiling.
  const hz = -8.35
  const hxc = x0 + 0.43
  const hood = new THREE.CylinderGeometry(0.33, Math.SQRT1_2, 1, 4, 1)
  hood.rotateY(Math.PI / 4)
  hood.scale(0.85, 0.42, 1.9)
  hood.translate(hxc, y + 2.08, hz)
  b.add("metal_galvanized", hood)
  b.cyl("metal_galvanized", T(x0 + 0.4, (y + 2.25 + CEIL_Y) / 2, hz), 0.15, 0.15, CEIL_Y - y - 2.25, 14)
  const top = y + 0.935
  b.box(M.paper, -23.55, top, z0 + 0.33, -23.32, top + 0.04, z0 + 0.63)
  docs.flat("form_requisition", -22.7, top, z0 + 0.4, 0.2)
  // Desk lamp on the north bench, arm reaching towards the door: the room's warm light (shadowed).
  const lx = -24.35
  const lz = z0 + 0.14
  placeModels(b, "desk_lamp", [{ position: [lx, top, lz + MODELS.desk_lamp.size[2] / 2 - 0.05], yaw: Math.PI, collide: false, blob: 0 }])
  b.lamp({ kind: "incandescent", position: [lx, top + 0.4, lz + 0.5], direction: [0, -0.85, 0.53], color: WARM, intensity: 260, range: 5, angle: 1.0, penumbra: 0.8, shadow: true, size: 0.08 })
  // Island table, stools, chalkboard, supply cabinet, models.
  const tx0 = -23.7
  const tx1 = -21.5
  b.box(M.epoxy, tx0, y + 0.88, -6.2, tx1, y + 0.92, -5.2)
  b.box(M.cabinet, tx0 + 0.05, y + 0.8, -6.15, tx1 - 0.05, y + 0.88, -5.25)
  for (const a of [tx0 + 0.08, tx1 - 0.08]) for (const c of [-6.12, -5.28]) b.box(M.cabinet, a - 0.025, y, c - 0.025, a + 0.025, y + 0.8, c + 0.025)
  b.collide(tx0, y, -6.2, tx1, y + 0.92, -5.2)
  docs.flat("note_repeated", -22.2, y + 0.921, -5.7, 0.35)
  placeModels(b, "lab_stool", [[-22.05, -4.55], [-23.05, -4.7], [-21.0, -5.9], [-22.7, -6.85]].map(([sx2, sz]) => ({ position: [sx2!, y, sz!] as const, yaw: Math.sin(sx2! * 12.9 + sz! * 7.1) * 3, inset: 0.06 })))
  const wz = z0
  b.box(M.wood, -24.8, y + 1.07, wz, -22.4, y + 2.25, wz + 0.04)
  b.box(M.chalkboard, -24.75, y + 1.12, wz + 0.04, -22.45, y + 2.2, wz + 0.045, { cast: false })
  docs.wall("chalkboard_wiped", -23.6, y + 1.66, wz + 0.045, 0, 1, { pin: "none", curl: 0, size: [2.3, 1.08] })
  b.box(M.cabinet, x0, y, -3.7, x0 + 0.5, y + 2.0, -2.0)
  b.quad(M.wireGlass, T(x0 + 0.503, y + 1.45, -2.85, Math.PI / 2), 1.5, 1.0, { cast: false })
  for (const sy of [1.05, 1.45, 1.85]) for (let k = 0; k < 6; k++) b.cyl(k % 2 ? M.jugBrown : M.jugWhite, T(x0 + 0.35, y + sy + 0.07, -3.5 + k * 0.25), 0.04, 0.04, 0.14, 10)
  b.collide(x0, y, -3.7, x0 + 0.5, y + 2.0, -2.0)
  placeModels(b, "chemistry_set", [{ position: [-21.95, top, z0 + 0.34], yaw: Math.PI, collide: false }])
  placeModels(b, "glassware", [{ position: [x0 + 0.36, top, -7.3], yaw: yawToward(1, 0) + 0.2, collide: false, blob: 0 }])
  placeModels(b, "microscope", [{ position: [-23.1, y + 0.92, -5.75], yaw: 0.6, collide: false, blob: 0 }])
  placeModels(b, "filing_cabinet_open", [{ position: [x1 - 0.55, y, z0 + 0.6], yaw: yawToward(-1, 0), inset: 0.05 }])
  const labRoom = room(b, { id: "0-17", name: "Sample intake lab", rect: rect(x0, x1, z0, LAB.z1), troffers: false, ceiling: { none: true }, lit: "none", columns: false })

  // Core store: core trays on slotted-angle racks, sample fridge, intake ledger on a shelf desk in the passage.
  const rS = room(b, { id: "0-17s", name: "Core store", rect: rect(-20.8, -15.4, -21.65, -9.75), lit: "none", floor: "concrete_floor_dry", windows: { blinds: "closed", radiators: "convector" } })
  const rP = room(b, { id: "0-17p", name: "Core store passage", rect: rect(-16.85, -15.46, -9.75, -1.75), lit: "none", floor: "concrete_floor_dry", troffers: false, columns: false })
  for (const zc of [-17.0, -13.4]) coreRack(b, -18.1, zc, 3.6)
  const fr = T(-15.82, y, -11.0, -Math.PI / 2)
  b.rbox(M.jugWhite, fr, 0.7, 1.85, 0.62, 0.03, 0, 0.925, 0)
  b.boxM(M.steel, fr, 0.03, 0.4, 0.03, 0.28, 1.1, -0.32)
  b.quad(M.glass, fr.clone().multiply(T(0, 1.15, -0.315, Math.PI)), 0.56, 1.2, { cast: false })
  b.collideLocal(fr, [-0.35, 0, -0.31], [0.35, 1.85, 0.31])
  b.rbox(M.laminateTop, T(-15.73, y + 0.95, -2.75), 0.42, 0.035, 1.6, 0.008)
  for (const zb of [-3.45, -2.05]) b.box(M.darkSteel, -15.5, y + 0.6, zb - 0.02, -15.48, y + 0.94, zb + 0.02)
  b.collide(-15.95, y, -3.55, -15.46, y + 0.97, -1.95)
  docs.flat("memo_carbon_inventory", -15.75, y + 0.968, -2.95, Math.PI / 2 + 0.1)
  docs.flat("envelope_interoffice", -15.72, y + 0.968, -2.3, Math.PI / 2 - 0.15, { offset: 0.003 })
  return [labRoom, rS, rP]
}

/** Slotted-angle rack along x with core trays (wooden boxes of grey core sticks) on three shelves. */
function coreRack(b: Builder, x: number, z: number, len: number) {
  const y = FLOOR_Y
  const d = 0.6
  for (const u of [-len / 2, 0, len / 2]) for (const s of [-1, 1]) b.box(M.darkSteel, x + u - 0.02, y, z + s * d / 2 - 0.02, x + u + 0.02, y + 1.9, z + s * d / 2 + 0.02)
  const rnd = rng(Math.round(z * 10))
  for (const h of [0.15, 0.75, 1.35]) {
    b.box(M.cabinet, x - len / 2, y + h, z - d / 2, x + len / 2, y + h + 0.025, z + d / 2)
    for (let k = 0; k < 3; k++) {
      if (rnd() < 0.15) continue
      const tx = x - len / 2 + 0.6 + k * 1.2
      const tm = T(tx, y + h + 0.025, z + (rnd() - 0.5) * 0.05, (rnd() - 0.5) * 0.04)
      b.boxM(M.wood, tm, 1.05, 0.08, 0.02, 0, 0.04, -0.24)
      b.boxM(M.wood, tm, 1.05, 0.08, 0.02, 0, 0.04, 0.24)
      b.boxM(M.wood, tm, 1.05, 0.015, 0.5, 0, 0.0075, 0)
      for (let r = 0; r < 4; r++) b.cyl(CORE_ROCK, tm.clone().multiply(T(0, 0.045, -0.18 + r * 0.12, 0, 0, Math.PI / 2)), 0.04, 0.04, 0.98 - rnd() * 0.2, 10)
    }
  }
  b.collide(x - len / 2 - 0.02, y, z - d / 2 - 0.02, x + len / 2 + 0.02, y + 1.9, z + d / 2 + 0.02)
}

/** Steel base cabinets with an epoxy top along a wall (x run at z c0 wall → c1 front, or z run). */
function benchRunX(b: Builder, a0: number, a1: number, c0: number, c1: number) {
  const y = FLOOR_Y
  b.box(M.cabinet, a0, y + 0.1, c0, a1, y + 0.9, c1 - 0.02)
  b.box(M.rubber, a0, y, c0, a1, y + 0.1, c1 - 0.08, { cast: false })
  b.box(M.epoxy, a0, y + 0.9, c0, a1, y + 0.935, c1 + 0.02)
  for (let i = 0; i < Math.floor((a1 - a0) / 0.6); i++) {
    const p = a0 + i * 0.6 + 0.3
    b.box(M.darkSteel, p + 0.298, y + 0.12, c1 - 0.02, p + 0.302, y + 0.88, c1 - 0.016, { cast: false })
    b.box(M.steel, p - 0.07, y + 0.77, c1 - 0.016, p + 0.07, y + 0.786, c1 + 0.004)
  }
  b.collide(a0, y, c0, a1, y + 0.935, c1 + 0.02)
}
function benchRunZ(b: Builder, a0: number, a1: number, c0: number, c1: number) {
  const y = FLOOR_Y
  b.box(M.cabinet, c0, y + 0.1, a0, c1 - 0.02, y + 0.9, a1)
  b.box(M.rubber, c0, y, a0, c1 - 0.08, y + 0.1, a1, { cast: false })
  b.box(M.epoxy, c0, y + 0.9, a0, c1 + 0.02, y + 0.935, a1)
  for (let i = 0; i < Math.floor((a1 - a0) / 0.6); i++) {
    const p = a0 + i * 0.6 + 0.3
    b.box(M.darkSteel, c1 - 0.02, y + 0.12, p + 0.298, c1 - 0.016, y + 0.88, p + 0.302, { cast: false })
    b.box(M.steel, c1 - 0.016, y + 0.77, p - 0.07, c1 + 0.004, y + 0.786, p + 0.07)
  }
  b.collide(c0, y, a0, c1 + 0.02, y + 0.935, a1)
}

// ------------------------------------------------------------------------------------------------ 0-18 reprographics

function reprographics(b: Builder, docs: Docs): RoomHandle {
  const y = FLOOR_Y
  const r = room(b, { id: "0-18", name: "Reprographics & supply", rect: rect(-15.4, -4.6, -21.65, -1.75), lit: "none", floor: "linoleum", windows: { blinds: "random", radiators: "convector" } })
  P(b, "z", -15.4, -21.65, -1.75, [ROOM_BANDS, ROOM_BANDS])
  P(b, "z", -4.6, -21.65, -1.75, [ROOM_BANDS, ROOM_BANDS])
  copier(b, -13.6, -6.0, yawToward(1, 0))
  copier(b, -13.6, -9.4, yawToward(1, 0))
  // Offset duplicator: low cabinet, inked drum, feed and delivery trays.
  const od = T(-7.2, y, -8.0, yawToward(-1, 0))
  b.rbox(M.beige, od, 1.1, 0.75, 0.62, 0.02, 0, 0.375, 0)
  b.rbox(M.darkSteel, od, 0.7, 0.32, 0.5, 0.03, 0.05, 0.92, 0)
  b.cyl(M.rubber, od.clone().multiply(T(0.05, 0.98, 0, 0, Math.PI / 2, Math.PI / 2)), 0.12, 0.12, 0.46, 18)
  b.boxM(M.steel, od, 0.32, 0.01, 0.34, -0.48, 0.88, 0)
  b.boxM(M.paper, od, 0.22, 0.04, 0.28, -0.48, 0.905, 0, { cast: false })
  b.boxM(M.steel, od, 0.3, 0.01, 0.32, 0.55, 0.8, 0)
  b.collideLocal(od, [-0.65, 0, -0.31], [0.7, 1.1, 0.31])
  // Paper reams on a pallet, supply shelving, guillotine on a stand, waste bin.
  placeModels(b, "pallet", [{ position: [-9.0, y, -19.6], yaw: 0 }])
  const ph = MODELS.pallet.size[1]
  for (let k = 0; k < 12; k++) {
    const px = -9.45 + (k % 3) * 0.44
    const pz = -20.0 + (Math.floor(k / 3) % 2) * 0.32
    const py = y + ph + Math.floor(k / 6) * 0.24
    b.rbox(M.cardboard, T(px, py, pz, (k % 4) * 0.02), 0.42, 0.24, 0.3, 0.01, 0, 0.12, 0)
  }
  placeModels(b, "steel_shelves", [
    { position: [-14.9, y, -18.5], yaw: yawToward(1, 0), inset: 0.03 },
    { position: [-14.9, y, -16.1], yaw: yawToward(1, 0), inset: 0.03 },
  ])
  placeModels(b, "cardboard_box", [{ position: [-12.0, y, -20.9], yaw: 0.2 }, { position: [-11.6, y, -20.95], yaw: -0.1 }])
  table(b, -6.2, -14.0, Math.PI / 2, 1.4, 0.7, 0.86, M.wood)
  const gm = T(-6.2, y + 0.86, -14.0, Math.PI / 2)
  b.rbox(M.darkSteel, gm, 0.62, 0.03, 0.48, 0.01, 0, 0.015, 0)
  b.boxM(M.steel, gm.clone().multiply(T(-0.3, 0.05, 0.22, 0, 0, 0.5)), 0.65, 0.012, 0.04, 0.3, 0, 0)
  b.cyl(M.rubber, gm.clone().multiply(T(0.24, 0.38, 0.22, 0, Math.PI / 2)), 0.03, 0.03, 0.12, 10)
  docs.flat("directory_extensions", -6.3, y + 0.89, -14.2, Math.PI / 2, { offset: 0.003 })
  wastebasket(b, -12.4, -2.3)
  corkBoard(b, docs, -10.0, -1.75, 0, -1, 1.4, 0.7, ["memo_coffee", "notice_firedoors", "signup_bowling", "poster_missing_cat"], 18, FLOOR_Y + 1.2)
  return r
}

const COPIER_LED = paint(0x103a10, 0.4)

/** Floor-standing office copier (late-70s console type): body, platen lid, sorter bins, control panel with LEDs. */
function copier(b: Builder, x: number, z: number, yaw: number) {
  const m = T(x, FLOOR_Y, z, yaw)
  b.rbox(M.beige, m, 1.5, 0.9, 0.7, 0.03, 0, 0.45, 0)
  b.boxM(M.rubber, m, 1.44, 0.08, 0.64, 0, 0.04, 0)
  b.rbox(paint(0x6a6660, 0.5), m, 0.95, 0.06, 0.58, 0.015, -0.18, 0.93, 0.02)
  b.rbox(M.darkSteel, m, 0.42, 0.06, 0.22, 0.01, 0.5, 0.93, -0.18)
  b.boxM(COPIER_LED, m, 0.03, 0.01, 0.02, 0.38, 0.965, -0.24, { cast: false })
  b.boxM(M.amberGlow, m, 0.012, 0.006, 0.012, 0.6, 0.962, -0.25, { cast: false })
  for (let k = 0; k < 5; k++) b.boxM(M.jugWhite, m, 0.04, 0.012, 0.4, 0.82, 0.55 + k * 0.07, 0, { cast: true })
  b.boxM(M.beige, m, 0.06, 0.5, 0.46, 0.79, 0.65, 0)
  b.collideLocal(m, [-0.75, 0, -0.35], [0.88, 0.96, 0.35])
}
