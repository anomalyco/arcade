import * as THREE from "three/webgpu"
import { MODELS } from "../../../../render/models"
import { openable } from "../../plan"
import {
  type Builder,
  type Window,
  CEIL_Y,
  DOOR_H,
  FLOOR_Y,
  M,
  ROOM_BANDS,
  T,
  WARM,
  beacon,
  conferenceTable,
  cot,
  deskLamp,
  door,
  kitchenette,
  partition,
  placeModels,
  rackRow,
  rect,
  registerDoor,
  riserW1,
  room,
  screen,
  wall,
  paint,
  wastebasket,
  yawToward,
  framedMirror,
} from "../../api"
import { type S4, paper } from "./common"
import { BROADLOOM, CERAMIC, CHART, EXEC_BANDS, FROST, LED_AMBER, LED_GREEN, SURVEY_MAP, TRANSOM, WALNUT } from "./mats"
import { bookcase, cans, credenza, decanter, floorLamp, frame, hotPlate, intercom, nameCard, projectorCart, safe, selectric, shredder, tableLamp } from "./props"

// East half of storey 4: the Directorate (4-10 … 4-17). Carpeted, walnut-panelled, lit only by the corridor sconces,
// the reception table lamp, the receiver room's red beacon and rack lamps, and — at the end of the corridor — the
// Director's barricaded office with its lights on behind a locked pair of doors.

const SEPIA = [0x6a5a44, 0x5a4c3a, 0x76664c] as const

const top = (name: "office_desk") => FLOOR_Y + MODELS[name].size[1]

/** Walnut cladding over a room's exterior lining on one face, around its windows (sill and head panels included). */
function cladLining(b: Builder, wins: Window[], face: "north" | "east", a0: number, a1: number) {
  const d0 = face === "north" ? -21.61 : 34.61
  const d1 = face === "north" ? -21.592 : 34.592
  const bx = (u0: number, u1: number, y0: number, y1: number) => {
    if (u1 - u0 < 0.01) return
    if (face === "north") b.box(WALNUT, u0, FLOOR_Y + y0, d0, u1, FLOOR_Y + y1, d1, { skip: "z" })
    else b.box(WALNUT, d1, FLOOR_Y + y0, u0, d0, FLOOR_Y + y1, u1, { skip: "X" })
  }
  const ws = wins.filter((w) => w.face === face).sort((p, q) => p.u0 - q.u0)
  let cur = a0
  for (const w of ws) {
    bx(cur, w.u0, 0.1, CEIL_Y - FLOOR_Y)
    bx(w.u0, w.u1, 0.1, w.sill - 0.03)
    bx(w.u0, w.u1, w.head, CEIL_Y - FLOOR_Y)
    cur = w.u1
  }
  bx(cur, a1, 0.1, CEIL_Y - FLOOR_Y)
}

/** Chart paper taped over a window from the inside, sheet by sheet. */
function paperOver(s: S4, w: Window) {
  const { sb, rnd } = s
  const len = w.u1 - w.u0
  const cols = Math.ceil(len / 0.58)
  const rows = Math.ceil((w.head - w.sill) / 0.85)
  for (let i = 0; i < cols; i++)
    for (let j = 0; j < rows; j++) {
      const u = w.u0 + (len * (i + 0.5)) / cols + (rnd() - 0.5) * 0.04
      const y = FLOOR_Y + w.sill + ((w.head - w.sill) * (j + 0.5)) / rows + (rnd() - 0.5) * 0.04
      const d = 0.006 + ((i + j) % 2) * 0.0015
      const m = w.face === "south" ? T(u, y, 21.61 - d, Math.PI, 0, (rnd() - 0.5) * 0.05) : T(34.61 - d, y, u, -Math.PI / 2, 0, (rnd() - 0.5) * 0.05)
      sb.quad(CHART, m, len / cols + 0.06, (w.head - w.sill) / rows + 0.06, { cast: false })
    }
  // Masking tape along the edges.
  for (const y of [w.sill + 0.01, w.head - 0.01]) {
    if (w.face === "south") sb.box(M.vinylBeige, w.u0, FLOOR_Y + y - 0.012, 21.6, w.u1, FLOOR_Y + y + 0.012, 21.601, { cast: false })
    else sb.box(M.vinylBeige, 34.6, FLOOR_Y + y - 0.012, w.u0, 34.601, FLOOR_Y + y + 0.012, w.u1, { cast: false })
  }
}

export async function buildEast(s: S4, pause: () => Promise<void>) {
  const { b, sb, rnd } = s
  const deskTop = top("office_desk")

  // ---------------------------------------------------------------- partitions
  partition(b, { axis: "z", at: 0.8, from: -21.65, to: -1.75, finish: [ROOM_BANDS, ROOM_BANDS] })
  partition(b, { axis: "z", at: 0.8, from: 1.75, to: 21.65, finish: [EXEC_BANDS, EXEC_BANDS] })
  partition(b, { axis: "z", at: 11.6, from: -21.65, to: -1.75, finish: [ROOM_BANDS, EXEC_BANDS] })
  partition(b, {
    axis: "z",
    at: 11.6,
    from: 1.75,
    to: 21.65,
    finish: [EXEC_BANDS, EXEC_BANDS],
    openings: [
      { kind: "door", at: 6.6, side: "a", door: { id: "4-17", state: "closed", room: "4-17", leaf: "veneer", sign: { number: "4-17", label: "PANTRY" } } },
      { kind: "door", at: 14.2, side: "a", door: { id: "4-13", state: "closed", room: "4-13", leaf: "veneer", sign: { number: "4-13", label: "DEPUTY DIRECTOR" } } },
    ],
  })
  partition(b, { axis: "x", at: 12.075, from: 11.66, to: 22.4, thickness: 0.15, finish: [EXEC_BANDS, EXEC_BANDS] })
  partition(b, { axis: "z", at: 22.475, from: 1.6, to: 21.65, thickness: 0.15, finish: [EXEC_BANDS, EXEC_BANDS] })
  partition(b, { axis: "x", at: -1.675, from: 22.55, to: 34.65, thickness: 0.15, finish: [EXEC_BANDS, EXEC_BANDS] })

  // ---------------------------------------------------------------- 4-15 executive secretary
  room(b, { id: "4-15", name: "Executive secretary", rect: rect(-4.6, 0.8, 1.75, 21.65), floor: BROADLOOM, lit: "none", windows: { blinds: "closed", radiators: "convector" } })
  placeModels(b, "office_desk", [{ position: [-1.7, FLOOR_Y, 5.4], yaw: 0 }])
  placeModels(b, "office_chair", [{ position: [-1.75, FLOOR_Y, 6.35], yaw: 0.25 }])
  placeModels(b, "stack_chair", [
    { position: [-3.4, FLOOR_Y, 3.4], yaw: yawToward(0.4, 1) },
    { position: [-2.7, FLOOR_Y, 3.3], yaw: yawToward(-0.2, 1) },
  ])
  selectric(sb, -1.95, deskTop, 5.6, Math.PI)
  paper(s, "letter_regret", [-1.95, deskTop + 0.29, 5.62], [0, 0.25, 1], { pin: "none", curl: 0.05 })
  for (let k = 0; k < 4; k++) paper(s, "letter_regret", [-2.55 + k * 0.004, deskTop + 0.001 + k * 0.0012, 5.35 - k * 0.003], [0, 1, 0], { rotation: 0.08 - k * 0.03, offset: 0.005 + k * 0.0036, curl: 0, seed: 40 + k })
  paper(s, "memo_next_of_kin", [-1.15, deskTop, 5.45], [0, 1, 0], { rotation: -0.2 })
  paper(s, "card_extensions", [-0.95, deskTop, 5.8], [0, 1, 0], { rotation: 0.3 })
  paper(s, "sticky_marge", [-0.88, deskTop, 5.15], [0, 1, 0], { rotation: -0.4 })
  intercom(sb, -1.05, deskTop, 5.85, Math.PI - 0.3)
  placeModels(b, "telephone", [{ position: [-0.85, deskTop, 5.35], yaw: Math.PI - 0.5, collide: false, blob: 0 }])
  const fcD = MODELS.filing_cabinet.size[2]
  placeModels(b, "filing_cabinet", [9.0, 9.48, 9.96].map((z) => ({ position: [0.74 - fcD / 2, FLOOR_Y, z] as const, yaw: yawToward(-1, 0) })))
  placeModels(b, "coat_rack", [{ position: [-4.1, FLOOR_Y, 2.35], yaw: 0.4 }])
  placeModels(b, "water_cooler", [{ position: [0.42, FLOOR_Y, 2.2], yaw: yawToward(-1, 0) }])
  wastebasket(b, -0.6, 6.1)
  await pause()

  // ---------------------------------------------------------------- 4-16 Director's files
  room(b, { id: "4-16", name: "Director's files", rect: rect(-4.6, 0.8, -21.65, -1.75), floor: "linoleum", lit: "none", windows: { blinds: "closed", radiators: "convector" } })
  placeModels(b, "filing_cabinet", [0, 1, 2, 3, 4, 5].map((k) => ({ position: [-4.575 + fcD / 2 + 0.02, FLOOR_Y, -3.1 - k * 0.47] as const, yaw: yawToward(1, 0) })))
  safe(b, 0.32, -2.55, yawToward(-1, 0))
  shredder(b, -0.2, -7.2, yawToward(-1, 0.3), rnd)
  b.rbox(M.laminateTop, T(-1.9, FLOOR_Y + 0.73, -10.0), 1.5, 0.03, 0.75, 0.006)
  for (const [dx, dz] of [[-0.68, -0.32], [0.68, -0.32], [-0.68, 0.32], [0.68, 0.32]]) b.rod(M.steel, [-1.9 + dx!, FLOOR_Y, -10.0 + dz!], [-1.9 + dx!, FLOOR_Y + 0.72, -10.0 + dz!], 0.015, 6)
  b.collide(-2.65, FLOOR_Y, -10.38, -1.15, FLOOR_Y + 0.75, -9.62)
  paper(s, "roster_sl_rotation", [-2.1, FLOOR_Y + 0.746, -10.0], [0, 1, 0], { rotation: 0.1 })
  paper(s, "memo_carbon_inventory", [-1.6, FLOOR_Y + 0.746, -9.9], [0, 1, 0], { rotation: -0.25 })
  sb.box(M.cardboard, -1.55, FLOOR_Y + 0.745, -10.3, -1.2, FLOOR_Y + 0.99, -10.05)
  await pause()

  // ---------------------------------------------------------------- 4-11 receiver & feed room (keycard)
  room(b, { id: "4-11", name: "Receiver & feed room", rect: rect(0.8, 11.6, -21.65, -1.75), floor: M.antistatic, lit: "none", windows: { blinds: "open", radiators: "convector" } })
  riserW1(b, { face: "west" })
  // Feed waveguide tapped off the trunk: rectangular copper guide with flanges, down into the cryogenic LNA.
  const CU = M.jugBrown
  const wy = FLOOR_Y + 2.55
  b.box(CU, 6.7, wy - 0.03, -4.06, 8.6, wy + 0.03, -3.94)
  b.box(CU, 8.54, FLOOR_Y + 1.62, -4.06, 8.66, wy + 0.03, -3.94)
  for (const x of [7.3, 8.0]) b.box(M.steel, x - 0.01, wy - 0.05, -4.09, x + 0.01, wy + 0.05, -3.91)
  for (const y of [1.95, 2.3]) b.box(M.steel, 8.51, FLOOR_Y + y - 0.01, -4.09, 8.69, FLOOR_Y + y + 0.01, -3.91)
  for (let k = 0; k < 2; k++) b.rod(M.darkSteel, [7.0 + k * 1.2, wy + 0.03, -4.0], [7.0 + k * 1.2, CEIL_Y, -4.0], 0.006, 4)
  // LNA dewar on its stand, frost on the cold head, helium lines to the compressor.
  const dx = 8.6
  const dz = -4.0
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2
    b.rod(M.darkSteel, [dx + Math.cos(a) * 0.3, FLOOR_Y, dz + Math.sin(a) * 0.3], [dx + Math.cos(a) * 0.16, FLOOR_Y + 0.4, dz + Math.sin(a) * 0.16], 0.015, 6)
  }
  b.cyl(M.darkSteel, T(dx, FLOOR_Y + 0.41, dz), 0.2, 0.2, 0.02, 20)
  b.cyl(M.steel, T(dx, FLOOR_Y + 0.92, dz), 0.2, 0.2, 1.0, 24)
  b.cyl(FROST, T(dx, FLOOR_Y + 1.36, dz), 0.205, 0.205, 0.16, 24, { open: true })
  b.cyl(M.steel, T(dx, FLOOR_Y + 1.44, dz), 0.23, 0.23, 0.03, 24)
  b.cyl(FROST, T(dx, FLOOR_Y + 1.53, dz), 0.09, 0.11, 0.15, 16)
  for (let k = 0; k < 7; k++) {
    const a = rnd() * Math.PI * 2
    b.boxM(FROST, T(dx + Math.cos(a) * 0.2, FLOOR_Y + 1.26 + rnd() * 0.08, dz + Math.sin(a) * 0.2, a), 0.02, 0.04 + rnd() * 0.06, 0.03, 0, 0, 0, { cast: false })
  }
  b.collide(dx - 0.32, FLOOR_Y, dz - 0.32, dx + 0.32, FLOOR_Y + 1.62, dz + 0.32)
  b.rbox(M.beige, T(10.6, FLOOR_Y, -3.0), 0.55, 0.62, 0.48, 0.02, 0, 0.31, 0)
  b.collide(10.32, FLOOR_Y, -3.25, 10.88, FLOOR_Y + 0.62, -2.75)
  sb.box(LED_GREEN, 10.45, FLOOR_Y + 0.5, -3.245, 10.47, FLOOR_Y + 0.52, -3.241, { cast: false })
  for (const [a, c] of [[0.0, 0.25], [0.08, 0.3]] as const) {
    const pts: [number, number, number][] = [[dx + 0.1, FLOOR_Y + 1.5 - a, dz + 0.1], [dx + 0.6, FLOOR_Y + 1.1 - a, dz + 0.5], [10.0, FLOOR_Y + 0.25, -3.3 + c], [10.32, FLOOR_Y + 0.35, -3.1 + c]]
    for (let i = 1; i < pts.length; i++) b.rod(M.rubber, pts[i - 1]!, pts[i]!, 0.012, 6)
  }
  // Receiver racks in two rows facing each other, panel lamps lit; the RF beacon on top of the window row.
  rackRow(b, 6.2, -19.6, Math.PI, 5, 99)
  rackRow(b, 6.6, -16.4, 0, 4, 99)
  // The rotating receiver beacon fills the room (lighting-state.ts 4-11: the red window seen from the lot).
  beacon(b, 3.0, FLOOR_Y + 1.6, -19.6, "red", true, { intensity: 7, range: 7 })
  b.lamp({ kind: "window", position: [6.4, FLOOR_Y + 1.3, -18.0], color: [0.4, 1, 0.5], intensity: 0.7, range: 3, size: 0.3 })
  // Bench: spectrum display, rubidium standard, log printout.
  const benchY = FLOOR_Y + 0.76
  b.rbox(M.epoxy, T(2.9, benchY - 0.02, -8.2), 2.0, 0.035, 0.75, 0.006)
  for (const [ox, oz] of [[-0.95, -0.33], [0.95, -0.33], [-0.95, 0.33], [0.95, 0.33]]) b.box(M.darkSteel, 2.9 + ox! - 0.02, FLOOR_Y, -8.2 + oz! - 0.02, 2.9 + ox! + 0.02, benchY - 0.04, -8.2 + oz! + 0.02)
  b.collide(1.9, FLOOR_Y, -8.58, 3.9, benchY, -7.82)
  const sa = T(2.4, benchY, -8.35, Math.PI)
  b.rbox(M.beige, sa, 0.46, 0.26, 0.5, 0.015, 0, 0.13, 0)
  screen(b, sa.clone().multiply(T(-0.07, 0.15, -0.252)), 0.2, 0.14, 0x50ff70, { intensity: 0.8, lamp: true })
  for (let k = 0; k < 6; k++) b.boxM(M.felt, sa, 0.02, 0.02, 0.01, 0.12 + (k % 2) * 0.05, 0.2 - Math.floor(k / 2) * 0.05, -0.252, { cast: false })
  const rb = T(3.3, benchY, -8.45, Math.PI)
  b.rbox(M.darkSteel, rb, 0.44, 0.13, 0.36, 0.01, 0, 0.065, 0)
  sb.boxM(LED_AMBER, rb, 0.015, 0.015, 0.004, -0.15, 0.08, -0.182, { cast: false })
  sb.boxM(LED_GREEN, rb, 0.015, 0.015, 0.004, -0.11, 0.08, -0.182, { cast: false })
  paper(s, "printout_greenbar", [3.2, benchY + 0.001, -7.95], [0, 1, 0], { rotation: 0.2 })
  placeModels(b, "lab_stool", [{ position: [2.7, FLOOR_Y, -7.4], yaw: 0.6 }])
  // Corridor side: RF hazard plaque and a beacon over the keycard door.
  b.box(M.hazard, 2.18, FLOOR_Y + 1.35, -1.6, 2.5, FLOOR_Y + 1.67, -1.594, { cast: false })
  b.box(M.yellow, 2.21, FLOOR_Y + 1.38, -1.594, 2.47, FLOOR_Y + 1.64, -1.590, { cast: false })
  b.box(M.darkSteel, 3.95, FLOOR_Y + 2.31, -1.6, 4.15, FLOOR_Y + 2.33, -1.42)
  beacon(b, 4.05, FLOOR_Y + 2.35, -1.5, "red")
  await pause()

  // ---------------------------------------------------------------- 4-12 executive conference
  const conf = rect(11.6, 34.65, -21.65, -1.75)
  const confRoom = room(b, { id: "4-12", name: "Executive conference", rect: conf, floor: BROADLOOM, lit: "none", windows: { blinds: "closed", radiators: "convector" } })
  cladLining(b, confRoom.windows, "north", 11.66, 34.61)
  cladLining(b, confRoom.windows, "east", -21.61, -1.75)
  const tx = 25.5
  const tz = -7.0
  conferenceTable(b, tx, tz, 0, 0, { length: 7.6 })
  const tableTop = FLOOR_Y + 0.7625
  // Twenty chairs shoved back from the table, as if everyone stood at once; one on its back.
  const chairs: { position: readonly [number, number, number]; yaw: number; tilt?: THREE.Euler; inset?: number }[] = []
  const seats: [number, number][] = []
  for (let k = 0; k < 10; k++)
    for (const side of [-1, 1]) {
      const x = tx - 3.8 + 0.76 * (k + 0.5)
      seats.push([x, side])
      const push = 0.45 + rnd() * 0.6
      const jx = (rnd() - 0.5) * 0.5
      const yaw = (side < 0 ? Math.PI : 0) + (rnd() - 0.5) * 1.3
      if (k === 6 && side > 0) chairs.push({ position: [x + jx, FLOOR_Y + 0.36, tz + side * (0.98 + push + 0.35)], yaw, tilt: new THREE.Euler(-1.45, 0, 0.1) })
      else chairs.push({ position: [x + jx, FLOOR_Y, tz + side * (0.98 + push)], yaw, inset: 0.12 })
    }
  placeModels(b, "office_chair", chairs)
  b.collide(tx - 3.8 + 0.76 * 6.5 - 0.45, FLOOR_Y, tz + 1.4, tx - 3.8 + 0.76 * 6.5 + 0.55, FLOOR_Y + 0.6, tz + 2.6)
  // Twelve name cards, one turned face down; pads and glasses at those places.
  const carded = [0, 2, 3, 5, 6, 8, 11, 12, 14, 15, 17, 19]
  carded.forEach((i, n) => {
    const [x, side] = seats[i]!
    const z = tz + side * 0.42
    nameCard(sb, x, tableTop, z, 0, n === 7)
    sb.box(M.paper, x - 0.11, tableTop, z + side * 0.06, x + 0.11, tableTop + 0.008, z + side * 0.34, { cast: false })
    sb.cyl(M.glass, T(x + 0.22, tableTop + 0.055, z + side * 0.1), 0.035, 0.03, 0.11, 12, { open: true, cast: false })
  })
  for (const x of [tx - 2.2, tx + 1.6]) sb.cyl(M.steel, T(x, tableTop + 0.12, tz), 0.06, 0.07, 0.24, 16)
  projectorCart(b, tx - 4.8, tz, yawToward(1, 0))
  // Roll-down screen hung from the ceiling in front of the east windows.
  b.box(M.beige, 33.95, CEIL_Y - 0.12, tz - 1.4, 34.1, CEIL_Y - 0.01, tz + 1.4)
  b.box(paint1(), 34.0, CEIL_Y - 2.0, tz - 1.3, 34.006, CEIL_Y - 0.12, tz + 1.3, { cast: false })
  b.box(M.darkSteel, 33.98, CEIL_Y - 2.03, tz - 1.32, 34.03, CEIL_Y - 2.0, tz + 1.32)
  // Map wall: survey sheet of the county in a walnut frame, pins at the station and the SL sites.
  const mw = 4.2
  const mh = 1.7
  b.quad(SURVEY_MAP, T(11.665, FLOOR_Y + 1.55, -10.0, Math.PI / 2), mw, mh, { cast: false })
  for (const [z0, z1, y0, y1] of [[-10 - mw / 2 - 0.05, -10 + mw / 2 + 0.05, 1.55 + mh / 2, 1.55 + mh / 2 + 0.05], [-10 - mw / 2 - 0.05, -10 + mw / 2 + 0.05, 1.55 - mh / 2 - 0.05, 1.55 - mh / 2], [-10 - mw / 2 - 0.05, -10 - mw / 2, 1.55 - mh / 2, 1.55 + mh / 2], [-10 + mw / 2, -10 + mw / 2 + 0.05, 1.55 - mh / 2, 1.55 + mh / 2]] as const)
    b.box(M.veneerDark, 11.66, FLOOR_Y + y0, z0, 11.69, FLOOR_Y + y1, z1)
  for (let k = 0; k < 9; k++) sb.cyl(k < 6 ? M.red : M.blue, T(11.672, FLOOR_Y + 1.3 + rnd() * 0.6, -11.2 + rnd() * 2.4, 0, 0, Math.PI / 2), 0.008, 0.008, 0.012, 8)
  const cTop = credenza(b, 26.0, -2.0, 0, 2.2)
  decanter(sb, 25.4, cTop, -2.05)
  placeModels(b, "telephone", [{ position: [26.7, cTop, -2.0], yaw: 0.2, collide: false, blob: 0 }])
  placeModels(b, "lounge_chair", [
    { position: [14.0, FLOOR_Y, -19.4], yaw: yawToward(0.6, 0.8) },
    { position: [16.2, FLOOR_Y, -19.6], yaw: yawToward(-0.6, 0.8) },
  ])
  await pause()

  // ---------------------------------------------------------------- 4-10 Directorate reception
  room(b, { id: "4-10", name: "Directorate reception", rect: rect(0.8, 11.6, 1.75, 21.65), floor: BROADLOOM, lit: "none", windows: { blinds: "closed", radiators: "convector" } })
  // Reception desk facing the glass doors: veneer front with a transaction ledge, returns, work surface behind.
  const rx = 6.2
  const rz = 5.4
  b.rbox(M.veneer, T(rx, FLOOR_Y + 0.54, rz), 2.6, 1.08, 0.05, 0.01)
  b.rbox(M.veneerDark, T(rx, FLOOR_Y + 1.1, rz + 0.06), 2.7, 0.04, 0.34, 0.01)
  for (const sx of [-1, 1]) b.rbox(M.veneer, T(rx + sx * 1.28, FLOOR_Y + 0.54, rz + 0.4), 0.05, 1.08, 0.8, 0.01)
  b.rbox(M.laminateTop, T(rx, FLOOR_Y + 0.74, rz + 0.42), 2.5, 0.03, 0.7, 0.006)
  b.box(M.veneerDark, rx - 1.3, FLOOR_Y, rz - 0.03, rx + 1.3, FLOOR_Y + 0.1, rz - 0.02)
  b.collide(rx - 1.32, FLOOR_Y, rz - 0.03, rx + 1.32, FLOOR_Y + 1.12, rz + 0.82)
  placeModels(b, "office_chair", [{ position: [rx + 0.3, FLOOR_Y, rz + 1.2], yaw: 0.4 }])
  placeModels(b, "telephone", [{ position: [rx - 0.7, FLOOR_Y + 0.755, rz + 0.45], yaw: Math.PI + 0.3, collide: false, blob: 0 }])
  paper(s, "directory_extensions", [rx + 0.4, FLOOR_Y + 0.756, rz + 0.5], [0, 1, 0], { rotation: Math.PI - 0.1, up: [0, 0, -1] })
  paper(s, "polaroid_dish", [rx - 0.3, FLOOR_Y + 1.121, rz + 0.08], [0, 1, 0], { rotation: Math.PI + 0.25 })
  paper(s, "calendar_oct84", [0.865, FLOOR_Y + 1.6, 4.4], [1, 0, 0], { pin: "tack" })
  // Waiting area at the windows: two leather lounge chairs, a side table with the lit lamp, construction photos.
  placeModels(b, "lounge_chair", [
    { position: [3.2, FLOOR_Y, 19.4], yaw: yawToward(0.5, -1) },
    { position: [6.0, FLOOR_Y, 19.4], yaw: yawToward(-0.5, -1) },
  ])
  b.rbox(M.veneer, T(4.6, FLOOR_Y + 0.27, 19.9), 0.55, 0.54, 0.55, 0.02)
  b.collide(4.32, FLOOR_Y, 19.62, 4.88, FLOOR_Y + 0.55, 20.18)
  tableLamp(b, 4.6, FLOOR_Y + 0.54, 19.95, true, 12)
  b.rbox(M.veneerDark, T(4.6, FLOOR_Y + 0.2, 18.4), 1.1, 0.04, 0.6, 0.01)
  for (const [ox, oz] of [[-0.5, -0.25], [0.5, -0.25], [-0.5, 0.25], [0.5, 0.25]]) b.box(M.veneerDark, 4.6 + ox! - 0.02, FLOOR_Y, 18.4 + oz! - 0.02, 4.6 + ox! + 0.02, FLOOR_Y + 0.18, 18.4 + oz! + 0.02)
  b.collide(4.05, FLOOR_Y, 18.1, 5.15, FLOOR_Y + 0.22, 18.7)
  for (let k = 0; k < 3; k++) sb.boxM(k === 1 ? M.red : M.paper, T(4.4 + k * 0.18, FLOOR_Y + 0.225 + k * 0.004, 18.35, 0.3 * k - 0.2), 0.21, 0.004, 0.28, 0, 0, 0, { cast: false })
  placeModels(b, "coat_rack", [{ position: [1.35, FLOOR_Y, 2.4], yaw: 0.1 }])
  placeModels(b, "wall_clock", [{ position: [6.2, FLOOR_Y + 2.3, 1.75 + MODELS.wall_clock.size[2] / 2], yaw: Math.PI, collide: false, blob: 0 }])
  SEPIA.forEach((c, k) => frame(b, 0.875, FLOOR_Y + 1.6, 9.0 + k * 1.4, yawToward(1, 0), 0.7, 0.55, paint2(c)))
  b.cyl(M.potClay, T(10.9, FLOOR_Y + 0.22, 20.9), 0.2, 0.16, 0.44, 16)
  for (let k = 0; k < 9; k++) {
    const a = (k / 9) * Math.PI * 2
    b.boxM(M.leaf, T(10.9 + Math.cos(a) * 0.12, FLOOR_Y + 0.75, 20.9 + Math.sin(a) * 0.12, a, 0.5, 0), 0.08, 0.7, 0.01)
  }
  b.collide(10.7, FLOOR_Y, 20.7, 11.1, FLOOR_Y + 1.1, 21.1)
  await pause()

  // ---------------------------------------------------------------- 4-17 executive pantry + private WC
  room(b, { id: "4-17", name: "Executive pantry", rect: rect(11.6, 22.4, 1.75, 12.0), floor: "linoleum", lit: "none", windows: false })
  kitchenette(b, 15.2, 1.75 + 0.31, Math.PI, 3.0, { coffeeOn: true })
  for (let k = 0; k < 4; k++) sb.cyl(CERAMIC, T(16.0 + k * 0.12, FLOOR_Y + 0.98, 2.15), 0.04, 0.035, 0.08, 12)
  b.cyl(M.veneer, T(16.4, FLOOR_Y + 0.73, 7.6), 0.5, 0.5, 0.03, 24)
  b.rod(M.darkSteel, [16.4, FLOOR_Y, 7.6], [16.4, FLOOR_Y + 0.72, 7.6], 0.04, 8)
  b.cyl(M.darkSteel, T(16.4, FLOOR_Y + 0.01, 7.6), 0.3, 0.3, 0.02, 16)
  b.collide(15.9, FLOOR_Y, 7.1, 16.9, FLOOR_Y + 0.75, 8.1)
  placeModels(b, "stack_chair", [
    { position: [16.4, FLOOR_Y, 6.85], yaw: yawToward(0, 1) + 0.3 },
    { position: [16.4, FLOOR_Y, 8.4], yaw: yawToward(0.2, -1) },
  ])
  partition(b, { axis: "z", at: 19.6, from: 1.75, to: 5.2, openings: [{ kind: "door", at: 3.7, side: "a", door: { id: "4-17W", state: "closed", room: "4-17", leaf: "veneer" } }], finish: [EXEC_BANDS, ROOM_BANDS] })
  partition(b, { axis: "x", at: 5.26, from: 19.54, to: 22.4, finish: [ROOM_BANDS, EXEC_BANDS] })
  toilet(b, 21.4, 1.75, 0)
  // Library lavatory (wall-hung, rim at 0.86 m) on the east wall, mirror over it.
  placeModels(b, "lavatory", [{ position: [22.4 - MODELS.lavatory.size[2] / 2, FLOOR_Y + 0.49, 4.4], yaw: yawToward(-1, 0), collide: false, blob: 0 }])
  b.collide(22.4 - MODELS.lavatory.size[2], FLOOR_Y + 0.49, 4.12, 22.4, FLOOR_Y + 1.05, 4.68)
  framedMirror(b, { at: 22.4, u: 4.4, face: "x-", width: 0.46 })
  await pause()

  // ---------------------------------------------------------------- 4-13 Deputy Director
  room(b, { id: "4-13", name: "Deputy Director", rect: rect(11.6, 22.4, 12.15, 21.65), floor: BROADLOOM, lit: "none", windows: { blinds: "closed", radiators: "convector" } })
  placeModels(b, "office_desk", [{ position: [17.6, FLOOR_Y, 16.6], yaw: yawToward(-1, 0) }])
  placeModels(b, "office_chair", [{ position: [18.5, FLOOR_Y, 16.7], yaw: yawToward(-1, 0) + 0.3 }])
  placeModels(b, "stack_chair", [
    { position: [16.5, FLOOR_Y, 16.1], yaw: yawToward(1, 0) },
    { position: [16.5, FLOOR_Y, 17.1], yaw: yawToward(1, 0.1) },
  ])
  placeModels(b, "desk_lamp", [{ position: [17.4, deskTop, 16.0], yaw: yawToward(-0.6, 0.6), collide: false, blob: 0 }])
  bookcase(b, 22.24, 13.8, yawToward(-1, 0), rnd)
  bookcase(b, 22.24, 14.75, yawToward(-1, 0), rnd)
  placeModels(b, "coat_rack", [{ position: [12.2, FLOOR_Y, 20.9], yaw: 0.6 }])
  frame(b, 17.0, FLOOR_Y + 1.6, 12.16, Math.PI, 0.6, 0.45, paint2(0xcfc6a8))
  await pause()

  // ---------------------------------------------------------------- 4-14 Director's office (locked, lit)
  const dRect = rect(22.55, 34.65, -1.6, 21.65)
  const dRoom = room(b, { id: "4-14", name: "Director's office", rect: dRect, floor: BROADLOOM, lit: "none", windows: { blinds: "up", radiators: "convector" } })
  for (const w of dRoom.windows) paperOver(s, w)
  // The door at the end of the corridor: walnut pair under a reeded transom (lock state kept for gameplay; locks are
  // off by default, so it opens), with furniture shoved behind it.
  wall(b, "z", -1.6, 1.6, 22.4, 22.55, EXEC_BANDS, [{ a0: -0.9, a1: 0.9, top: 2.72 }])
  const ids = door(b, 22.475, 0, { rot: -Math.PI / 2, wallT: 0.15, width: 1.7, leaves: 2, locked: !openable("locked"), glass: null, leaf: M.veneer, sound: "wood", id: "s4:4-14" })
  registerDoor({ id: ids[0]!, storey: b.storey, state: "locked", room: "4-14", x: 22.475, z: 0, sign: { number: "4-14", label: "DIRECTOR" } })
  b.box(M.veneerDark, 22.4, FLOOR_Y + DOOR_H + 0.05, -0.9, 22.55, FLOOR_Y + 2.3, 0.9)
  for (const z of [-0.9, 0.9]) b.box(M.veneerDark, 22.4, FLOOR_Y + 2.3, z - (z > 0 ? 0.04 : 0), 22.55, FLOOR_Y + 2.72, z + (z < 0 ? 0.04 : 0))
  b.box(M.veneerDark, 22.4, FLOOR_Y + 2.68, -0.86, 22.55, FLOOR_Y + 2.72, 0.86)
  b.box(M.veneerDark, 22.46, FLOOR_Y + 2.3, -0.015, 22.49, FLOOR_Y + 2.68, 0.015)
  b.quad(TRANSOM, T(22.475, FLOOR_Y + 2.49, 0, -Math.PI / 2), 1.72, 0.38, { cast: false })
  b.box(M.steel, 22.38, FLOOR_Y, -0.85, 22.57, FLOOR_Y + 0.006, 0.85, { cast: false })
  b.walk(22.38, -0.85, 22.57, 0.85)
  // Light spilling under the doors onto the corridor carpet.
  b.lamp({ kind: "incandescent", position: [22.3, FLOOR_Y + 0.05, 0], direction: [-0.97, -0.25, 0], color: WARM, intensity: 6, range: 3.5, angle: 1.3, penumbra: 1, size: 0.02 })
  // "DO NOT DISTURB — R.H." taped on the left leaf: a torn sheet with a scrawl.
  for (let k = 0; k < 7; k++) void rnd()
  paper(s, "note_do_not_disturb", [22.449, FLOOR_Y + 1.52, -0.42], [-1, 0, 0], { pin: "tape", rotation: 0.06 })
  // A barricade that was pushed aside: the credenza dragged back along the north side of the doors at an angle, the
  // filing cabinet shoved off to the south, a gap of about a metre to squeeze through between them.
  credenza(b, 23.35, 1.85, yawToward(1, 0.45), 1.5)
  placeModels(b, "filing_cabinet", [{ position: [25.1, FLOOR_Y, -1.25], yaw: yawToward(1, -0.5) }])
  floorLamp(b, 23.7, -1.05, true, 26)
  // Desk turned to the wall, the chair facing north; lamp on, papers everywhere.
  placeModels(b, "office_desk", [{ position: [28.6, FLOOR_Y, 14.0], yaw: yawToward(-1, 0) }])
  placeModels(b, "office_chair", [{ position: [29.6, FLOOR_Y, 14.6], yaw: 0 }])
  deskLamp(b, 28.35, deskTop, 13.35, yawToward(0.3, 0.6), true, { shadow: true, intensity: 70 })
  paper(s, "printout_greenbar", [28.5, deskTop, 14.2], [0, 1, 0], { rotation: Math.PI / 2 + 0.1 })
  paper(s, "polaroid_corridor", [28.3, deskTop, 14.6], [0, 1, 0], { rotation: 0.5 })
  paper(s, "roster_sl_rotation", [28.75, deskTop, 13.7], [0, 1, 0], { rotation: 1.3 })
  for (let k = 0; k < 10; k++) {
    const a = rnd() * Math.PI * 2
    const d = 0.8 + rnd() * 2.4
    paper(s, "note_repeated", [29.4 + Math.cos(a) * d, FLOOR_Y, 13.4 + Math.sin(a) * d], [0, 1, 0], { rotation: rnd() * 6, seed: 90 + k, offset: 0.0015 + k * 0.0004 })
  }
  sb.box(M.paper, 28.9, deskTop, 13.3, 29.15, deskTop + 0.06, 13.6)
  wastebasket(b, 27.6, 13.0)
  // Cot by the east windows, hot plate and tins: he has been living here.
  cot(b, 33.6, 15.2, Math.PI / 2)
  b.rbox(M.veneer, T(33.4, FLOOR_Y + 0.36, 20.4), 0.9, 0.72, 0.5, 0.01)
  b.collide(32.95, FLOOR_Y, 20.15, 33.85, FLOOR_Y + 0.72, 20.65)
  hotPlate(sb, 33.25, FLOOR_Y + 0.72, 20.4, 0)
  cans(sb, 31.9, FLOOR_Y, 20.5, rnd, 4)
  for (let k = 0; k < 5; k++) sb.cyl(M.steel, T(30.6 + rnd() * 1.6, FLOOR_Y + 0.04, 18.6 + rnd() * 1.6, rnd() * 3, 0, Math.PI / 2), 0.04, 0.04, 0.115, 10, { open: true })
  // Survey map on the west wall with the station ringed in pins.
  b.quad(SURVEY_MAP, T(22.556, FLOOR_Y + 1.6, 8.0, Math.PI / 2), 1.9, 1.3, { cast: false })
  for (let k = 0; k < 18; k++) {
    const a = (k / 18) * Math.PI * 2
    sb.cyl(M.red, T(22.565, FLOOR_Y + 1.52 + Math.sin(a) * 0.17, 8.25 + Math.cos(a) * 0.17, 0, 0, Math.PI / 2), 0.009, 0.009, 0.014, 8)
  }
  paper(s, "sticky_dish", [22.558, FLOOR_Y + 2.1, 8.9], [1, 0, 0], { pin: "none", rotation: 0.1 })
  // Private washroom.
  partition(b, { axis: "z", at: 31.0, from: 3.94, to: 9.66, finish: [EXEC_BANDS, ROOM_BANDS], openings: [{ kind: "door", at: 6.6, side: "a", door: { id: "4-14W", state: "closed", room: "4-14", leaf: "veneer" } }] })
  partition(b, { axis: "x", at: 3.94, from: 31.06, to: 34.61, finish: [EXEC_BANDS, ROOM_BANDS] })
  partition(b, { axis: "x", at: 9.66, from: 31.06, to: 34.61, finish: [ROOM_BANDS, EXEC_BANDS] })
  toilet(b, 33.4, 4.0, 0)
  placeModels(b, "lavatory", [{ position: [34.61 - MODELS.lavatory.size[2] / 2, FLOOR_Y + 0.49, 7.6], yaw: yawToward(-1, 0), collide: false, blob: 0 }])
  b.collide(34.61 - MODELS.lavatory.size[2], FLOOR_Y + 0.49, 7.32, 34.61, FLOOR_Y + 1.05, 7.88)
  framedMirror(b, { at: 34.61, u: 7.6, face: "x-", width: 0.46 })
}

/** Library toilet with its back to the wall at z0, facing +z (`yaw` adds a turn). */
function toilet(b: Builder, x: number, z0: number, yaw: number) {
  placeModels(b, "toilet", [{ position: [x, FLOOR_Y, z0 + 0.02 + MODELS.toilet.size[2] / 2], yaw: Math.PI + yaw, inset: 0.03, blob: 0 }])
}

const SCREEN = paint(0xe2e2da, 0.8)
const paint1 = () => SCREEN
const paint2 = (hex: number) => paint(hex, 0.6)
