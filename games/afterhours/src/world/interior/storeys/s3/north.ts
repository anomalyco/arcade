import * as THREE from "three/webgpu"
import { MODELS } from "../../../../render/models"
import {
  CEIL_Y,
  FLOOR_Y,
  G,
  LAYER,
  M,
  RISER_W1_OUTER,
  ROOM_BANDS,
  T,
  beacon,
  chalkboard,
  deskLamp,
  linePrinter,
  paint,
  partition,
  pendant,
  placeModels,
  rect,
  riserW1,
  room,
  trofferGrid,
  troffers,
  wallPapers,
  wastebasket,
  yawToward,
} from "../../api"
import { DESK_TOP, type S3 } from "./common"
import {
  BRUSHED,
  analyserRack,
  cardSorter,
  cpuFrame,
  crac,
  decollator,
  diskUnit,
  drumPlotter,
  flatFile,
  halonBank,
  headphones,
  keypunch,
  lightTable,
  pigeonholes,
  recorderConsole,
  reelRack,
  scope,
  stripChart,
  tapeCleaner,
  tapeUnit,
  teleprinter,
  teletype,
  terminal,
  upsCabinet,
  batteryRack,
} from "./equipment"
import { ashtray, cardDeck, consoleDesk, lateralFile, mug, printoutStack, workTable, acousticPanel } from "./furniture"
import { PLOT } from "./mats"
import { radioUnit } from "./radio-gear"
import { OPERATOR_CHAIR, OPERATOR_DESK_H, stageListeningRoom } from "./listening"

// North side of storey 3 (z < −1.75): data control, keypunch, UPS, the glazed machine room with its secure zone (tape
// library, operations console), plotter room, the listening room under the dish, and the open analysis bullpen.

const N = yawToward(0, -1)
const S = yawToward(0, 1)
const E = yawToward(1, 0)
const W = yawToward(-1, 0)
const GREEN: [number, number, number] = [0.35, 1, 0.5]
const PERF = paint(0x777a74, 0.55, 0.2)

/** Screen glow lamp for a hero terminal / scope (tiny, green). */
const screenLamp = (s: S3, p: readonly [number, number, number], intensity = 0.7) =>
  s.b.lamp({ kind: "window", position: p, color: GREEN, intensity, range: 2.4, size: 0.12 })

export async function buildNorth(s: S3, pause: () => Promise<void>) {
  const b = s.b
  const rnd = s.rnd
  let listening: (t: number) => void = () => {}

  // ------------------------------------------------------------------ partitions between the north rooms
  for (const x of [G[1], G[3], G[4], G[9], G[10], G[12]]) partition(b, { axis: "z", at: x, from: -21.65, to: -1.75, finish: [ROOM_BANDS, ROOM_BANDS] })

  // ------------------------------------------------------------------ 3-01 data control / I/O counter
  s.rooms.push(room(b, { id: "3-01", name: "Data control", rect: rect(G[0], G[1], -21.65, -1.75), floor: "linoleum", lit: "none", anchors: [{ kind: "bin", x: -48.6, y: FLOOR_Y, z: -2.4 }] }))
  const label = pigeonholes(b, -48.04, -7.4, W, 16, 6, rnd, 61)
  // Label for the stuffed cubby: a time card taped across its lip, "DELACROIX, J. — FIELD".
  s.doc("timecard_delacroix", [label[0] - 0.002, label[1] + 0.035, label[2]], [-1, 0, 0], { rotation: Math.PI / 2, scale: 0.8, pin: "tape" })
  const t1 = workTable(b, -52.2, -2.55, 0, 2.2, 0.76)
  for (let k = 0; k < 5; k++) cardDeck(b, -53.0 + k * 0.32, t1, -2.6 + (rnd() - 0.5) * 0.2, (rnd() - 0.5) * 0.4, 0.03 + rnd() * 0.05)
  printoutStack(b, -51.5, t1, -2.5, 0.1, 0.09)
  decollator(b, -52.6, -10.5, E)
  const t2 = workTable(b, -51.2, -15.6, Math.PI / 2, 2.4, 0.9)
  for (let k = 0; k < 4; k++) printoutStack(b, -51.2 + (rnd() - 0.5) * 0.3, t2, -16.5 + k * 0.55, (rnd() - 0.5) * 0.3, 0.03 + rnd() * 0.08)
  cardDeck(b, -50.9, t2, -14.6, 0.2, 0.06)
  placeModels(b, "office_chair", [{ position: [-50.3, FLOOR_Y, -15.2], yaw: W + 0.5, inset: 0.15 }])
  placeModels(b, "filing_cabinet", [-53.2, -52.7].map((x) => ({ position: [x, FLOOR_Y, -21.61 + 0.27] as const, yaw: S })))
  placeModels(b, "telephone", [{ position: [-52.9, t1, -2.4], yaw: S + 0.3, collide: false, blob: 0 }])
  wastebasket(b, -48.6, -2.4)
  s.doc("signin_sheet", [-52.4, t1, -2.75], [0, 1, 0], { rotation: 0.2 })
  await pause()

  // ------------------------------------------------------------------ 3-02 keypunch room
  s.rooms.push(room(b, { id: "3-02", name: "Keypunch room", rect: rect(G[1], G[3], -21.65, -1.75), floor: "linoleum", lit: "none" }))
  const chairs: { position: readonly [number, number, number]; yaw: number; inset: number }[] = []
  for (const z of [-7.6, -12.2, -16.8])
    for (const x of [-46.2, -43.6, -41.0, -38.4]) {
      keypunch(b, x, z, N, rnd)
      if (rnd() < 0.8) chairs.push({ position: [x + (rnd() - 0.5) * 0.3, FLOOR_Y, z - 0.95 - rnd() * 0.25], yaw: S + (rnd() - 0.5) * 0.7, inset: 0.1 })
      cardDeck(b, x - 0.35, FLOOR_Y + 0.757, z + 0.1, rnd(), 0.02 + rnd() * 0.04)
    }
  placeModels(b, "stack_chair", chairs)
  cardSorter(b, -39.4, -2.2, N)
  placeModels(b, "cardboard_box", [
    { position: [-47.3, FLOOR_Y, -20.9], yaw: 0.1 },
    { position: [-47.3, FLOOR_Y, -20.3], yaw: -0.05 },
    { position: [-47.3, FLOOR_Y + MODELS.cardboard_box.size[1], -20.6], yaw: 0.2, collide: false, blob: 0 },
    { position: [-46.8, FLOOR_Y, -20.95], yaw: 1.6 },
  ])
  wastebasket(b, -47.4, -2.5)
  await pause()

  // ------------------------------------------------------------------ 3-03 UPS & power distribution (keycard server)
  s.rooms.push(
    room(b, { id: "3-03", name: "UPS & power distribution", rect: rect(G[3], G[4], -21.65, -1.75), floor: "concrete_floor_dry", lit: "none", anchors: [{ kind: "breakers:machine-room", x: -31.9, y: FLOOR_Y + 1.2, z: -4.9 }] }),
  )
  for (const z of [-15.2, -13.9, -12.6]) upsCabinet(b, -36.52, z, E)
  upsCabinet(b, -36.52, -8.0, E, false)
  batteryRack(b, -34.2, -18.2, Math.PI / 2, 4.6)
  batteryRack(b, -32.6, -18.2, Math.PI / 2, 4.6)
  const [bw, , bd] = MODELS.utility_box_b.size
  placeModels(b, "utility_box_b", [-6.1, -4.9].map((z) => ({ position: [-31.66 - bd / 2 - 0.01, FLOOR_Y + 0.55, z] as const, yaw: W, collide: true, inset: 0, blob: 0 })))
  placeModels(b, "utility_box", [{ position: [-31.66 - MODELS.utility_box.size[2] / 2 - 0.01, FLOOR_Y + 0.6, -8.4], yaw: W, blob: 0 }])
  void bw
  for (const z of [-6.4, -5.6, -4.6, -8.4]) b.rod("metal_galvanized", [-31.7, FLOOR_Y + 1.7, z], [-31.7, CEIL_Y, z], 0.02, 6)
  b.box(M.hazard, -32.9, FLOOR_Y, -9.0, -32.75, FLOOR_Y + LAYER, -3.8, { cast: false })
  // Panel lamps: the machine-room boards' pilot lights.
  b.box(paint(0x2a0c04, 0.4), -31.71, FLOOR_Y + 1.98, -5.7, -31.69, FLOOR_Y + 2.02, -5.3)
  b.lamp({ kind: "warning", position: [-32.0, FLOOR_Y + 2.0, -5.5], color: [1, 0.45, 0.12], intensity: 0.5, range: 2.5, size: 0.03 })
  await pause()

  // ------------------------------------------------------------------ 3-04 machine room (raised floor, fully lit)
  partition(b, {
    axis: "x",
    at: -11.925,
    from: G[4],
    to: G[9],
    thickness: 0.15,
    finish: [ROOM_BANDS, ROOM_BANDS],
    openings: [
      { kind: "door", at: -28.0, side: "b", door: { id: "3-05", state: "closed", room: "3-05", sign: { number: "3-05", label: "TAPE LIBRARY" } } },
      { kind: "door", at: -13.0, side: "b", door: { id: "3-06", state: "closed", room: "3-06", sign: { number: "3-06", label: "OPERATIONS" } } },
      { kind: "glazed", from: -11.8, to: -5.4, sill: 0.9, head: 2.1, mullion: 1.6 },
    ],
  })
  partition(b, { axis: "z", at: G[7], from: -21.65, to: -11.85, finish: [ROOM_BANDS, ROOM_BANDS] })
  const mr = rect(G[4], G[9], -11.925, -1.75)
  const mrh = room(b, { id: "3-04", name: "Machine room", rect: mr, floor: M.raised, lit: "none", troffers: false, anchors: [{ kind: "halon", x: -30.0, y: FLOOR_Y, z: -11.4 }] })
  const cells = trofferGrid(mr).map((c) => ({ ...c, on: true }))
  s.rooms.push({ ...mrh, update: troffers(b, cells, { perLamp: 9, intensity: 90 }).update })
  // Raised access floor: 600 mm tiles, perforated ones in the cold aisle, a hazard edge at the door.
  for (let x = Math.ceil((mr.x0 + 0.1) / 0.6) * 0.6; x < mr.x1 - 0.05; x += 0.6) b.box(M.darkSteel, x - 0.004, FLOOR_Y, mr.z0 + 0.06, x + 0.004, FLOOR_Y + LAYER, mr.z1, { cast: false })
  for (let z = Math.ceil((mr.z0 + 0.1) / 0.6) * 0.6; z < mr.z1 - 0.05; z += 0.6) b.box(M.darkSteel, mr.x0 + 0.06, FLOOR_Y + 0.0005, z - 0.004, mr.x1 - 0.06, FLOOR_Y + LAYER + 0.0005, z + 0.004, { cast: false })
  for (let x = -28.8; x < -14; x += 1.2)
    for (const z of [-4.2, -5.4]) b.box(PERF, x + 0.01, FLOOR_Y, z + 0.01, x + 0.59, FLOOR_Y + LAYER, z + 0.59, { cast: false })
  // Row A along the glass: six tape drives, four disk units, the processor, the system console.
  for (let k = 0; k < 6; k++) tapeUnit(b, -29.2 + k * 0.8, -2.55, S)
  for (let k = 0; k < 4; k++) diskUnit(b, -23.7 + k * 0.84, -2.6, S)
  cpuFrame(b, -15.2, -2.6, S, true)
  for (let k = 0; k < 3; k++) cpuFrame(b, -14.18 + k * 0.82, -2.6, S)
  const [cTop, cShelf] = consoleDesk(b, -8.8, -3.4, 0, 2.6)
  const ct = terminal(b, -9.5, cShelf, -3.15, 0, true, 0.185)
  terminal(b, -8.3, cShelf, -3.15, 0.1, true, 0.185)
  screenLamp(s, ct, 0.5)
  printoutStack(b, -7.7, cTop, -3.75, 0.2, 0.05)
  placeModels(b, "office_chair", [{ position: [-9.0, FLOOR_Y, -4.4], yaw: S + 0.25, inset: 0.15 }])
  teleprinter(b, -6.6, -3.3, 0)
  // Row B (processor frames) and row C (disk strings), back to back, a cross aisle at x ≈ −21.
  for (let k = 0; k < 7; k++) cpuFrame(b, -27.6 + k * 0.82, -6.45, S)
  for (let k = 0; k < 6; k++) cpuFrame(b, -19.6 + k * 0.82, -6.45, S)
  for (let k = 0; k < 7; k++) diskUnit(b, -26.3 + k * 0.84, -9.4, N)
  for (let k = 0; k < 6; k++) diskUnit(b, -19.0 + k * 0.84, -9.4, N)
  crac(b, -31.1, -6.6, E)
  crac(b, -5.1, -7.2, W)
  halonBank(b, -30.2, -11.62, S, 3)
  linePrinter(b, -9.6, -7.9, W, rnd)
  // A tape cart by the drives with a few reels.
  {
    const m = T(-24.6, FLOOR_Y, -4.6, 0.3)
    for (const y of [0.25, 0.75]) b.rbox(M.steel, m, 0.7, 0.03, 0.45, 0.01, 0, y, 0)
    for (const dx of [-0.33, 0.33]) for (const dz of [-0.2, 0.2]) b.boxM(M.darkSteel, m, 0.025, 0.85, 0.025, dx, 0.45, dz)
    for (let k = 0; k < 5; k++) b.cyl(paint(0x5a5e60, 0.45, 0.3), m.clone().multiply(T(-0.24 + k * 0.1, 0.9, 0, 0, 0, Math.PI / 2)), 0.135, 0.135, 0.028, 16)
    b.collideLocal(m, [-0.37, 0, -0.24], [0.37, 1.05, 0.24])
  }
  // Ceiling: halon nozzles and smoke heads; wall beacons at each end of the glass; the emergency power-off button.
  for (const [x, z] of [[-27, -5], [-20, -8], [-13, -5], [-7, -9]] as const) {
    b.cyl(BRUSHED, T(x, CEIL_Y - 0.06, z), 0.02, 0.02, 0.12, 8)
    b.cyl(BRUSHED, T(x, CEIL_Y - 0.13, z), 0.035, 0.025, 0.03, 10)
    b.cyl(M.jugWhite, T(x + 1.2, CEIL_Y - 0.02, z), 0.07, 0.07, 0.04, 16)
  }
  for (const x of [-31.3, -4.9]) {
    b.box(M.darkSteel, x - 0.24, FLOOR_Y + 2.55, -2.45, x + 0.24, FLOOR_Y + 2.59, -2.25)
    beacon(b, x + (x < -20 ? 0.1 : -0.1), FLOOR_Y + 2.59, -2.35, "amber")
  }
  b.rbox(M.yellow, T(-4.7, FLOOR_Y + 1.4, -2.2, -Math.PI / 2), 0.16, 0.2, 0.06, 0.01)
  b.cyl(M.red, T(-4.77, FLOOR_Y + 1.4, -2.2, 0, 0, Math.PI / 2), 0.035, 0.035, 0.04, 14)
  await pause()

  // ------------------------------------------------------------------ 3-05 tape library
  s.rooms.push(room(b, { id: "3-05", name: "Tape library", rect: rect(G[4], G[7], -21.65, -11.925), floor: "linoleum", lit: [[-22.8, -16.8]] }))
  for (const x of [-30.3, -28.6, -26.9, -25.2, -23.5]) reelRack(b, x, -17.5, Math.PI / 2, 4.6, rnd)
  tapeCleaner(b, -15.82, -14.6, W)
  const lt = workTable(b, -19.0, -13.0, 0, 1.6, 0.76)
  cardDeck(b, -19.4, lt, -13.1, 0.3, 0.12)
  mug(b, -18.5, lt, -12.85)
  s.doc("memo_carbon_inventory", [-19.0, lt, -13.05], [0, 1, 0], { rotation: -0.2 })
  placeModels(b, "office_chair", [{ position: [-19.1, FLOOR_Y, -13.8], yaw: S - 0.4, inset: 0.15 }])
  for (const [x, z, r] of [[-21.3, -17.8, 0.4], [-19.6, -19.6, -0.2]] as const) {
    const m = T(x, FLOOR_Y, z, r)
    for (const y of [0.25, 0.75]) b.rbox(M.steel, m, 0.7, 0.03, 0.45, 0.01, 0, y, 0)
    for (const dx of [-0.33, 0.33]) for (const dz of [-0.2, 0.2]) b.boxM(M.darkSteel, m, 0.025, 0.85, 0.025, dx, 0.45, dz)
    for (let k = 0; k < 4; k++) b.cyl(paint(0x5a5e60, 0.45, 0.3), m.clone().multiply(T(-0.2 + k * 0.12, 0.9, 0, 0, 0, Math.PI / 2)), 0.135, 0.135, 0.028, 16)
    b.collideLocal(m, [-0.37, 0, -0.24], [0.37, 1.05, 0.24])
  }
  await pause()

  // ------------------------------------------------------------------ 3-06 operations console (03:04 — ???)
  s.rooms.push(room(b, { id: "3-06", name: "Operations console", rect: rect(G[7], G[9], -21.65, -11.925), floor: "linoleum", lit: "none", anchors: [{ kind: "log", x: -8.6, y: DESK_TOP, z: -12.75 }] }))
  const [oTop, oShelf] = consoleDesk(b, -8.6, -12.55, 0, 3.6)
  const ot = terminal(b, -9.6, oShelf, -12.3, 0, true, 0.185)
  terminal(b, -7.6, oShelf, -12.3, -0.05, true, 0.185)
  screenLamp(s, ot, 0.8)
  deskLamp(b, -6.95, oTop, -12.45, N + 0.4, true, { intensity: 50 })
  s.doc("ops_log", [-8.55, oTop, -12.85], [0, 1, 0], { rotation: 0.12 })
  s.doc("printout_greenbar", [-10.1, oTop, -12.8], [0, 1, 0], { rotation: -0.3 })
  s.doc("sticky_dont", [-7.25, oTop, -12.95], [0, 1, 0], { rotation: 0.5 })
  mug(b, -9.0, oTop, -12.7)
  ashtray(b, -7.9, oTop, -12.75, rnd)
  placeModels(b, "telephone", [{ position: [-10.2, oTop, -12.5], yaw: N - 0.2, collide: false, blob: 0 }])
  headphones(b, -8.15, oTop, -12.99, 0.2, 0.38)
  // The operator's chair pushed back, half turned.
  placeModels(b, "office_chair", [{ position: [-8.35, FLOOR_Y, -14.05], yaw: S + 1.1, inset: 0.15 }])
  chalkboard(b, -15.31, -16.6, -Math.PI / 2, 2.6, "white", "whiteboard_ops")
  s.doc("calendar_oct84", [-4.66, FLOOR_Y + 1.55, -14.8], [-1, 0, 0], { pin: "tack" })
  s.doc("roster_operators", [-4.66, FLOOR_Y + 1.5, -15.5], [-1, 0, 0], { pin: "pin" })
  placeModels(b, "filing_cabinet", [-5.3, -5.8].map((x) => ({ position: [x, FLOOR_Y, -21.61 + 0.27] as const, yaw: S })))
  placeModels(b, "wall_clock", [{ position: [-10.0, FLOOR_Y + 2.45, -21.6 + 0.03], yaw: S, collide: false, blob: 0 }])
  // North-array link status panel on the wall by the window: lamps blinking, one red lamp steady.
  b.rbox(paint(0x3a3e3c, 0.5, 0.4), T(-4.72, FLOOR_Y + 1.6, -13.4, -Math.PI / 2), 0.5, 0.36, 0.08, 0.01)
  s.doc("plate_array_link", [-4.76, FLOOR_Y + 1.61, -13.4], [-1, 0, 0], { pin: "none", curl: 0, size: [0.4, 0.22] })
  wastebasket(b, -11.0, -13.3)
  await pause()

  // ------------------------------------------------------------------ 3-07 plotter & map room
  s.rooms.push(room(b, { id: "3-07", name: "Plotter & map room", rect: rect(G[9], G[10], -21.65, -1.75), floor: "linoleum", lit: "none" }))
  drumPlotter(b, -1.9, -8.6, S)
  for (const z of [-12.8, -14.2, -15.6]) flatFile(b, -4.06, z, E, rnd)
  lightTable(b, -1.9, -19.9, S)
  placeModels(b, "lab_stool", [{ position: [-1.6, FLOOR_Y, -18.9], yaw: 0.4 }])
  for (const [z, w] of [[-5.0, 1.0], [-6.4, 0.8]] as const) b.quad(PLOT, T(0.74, FLOOR_Y + 1.6, z, -Math.PI / 2), w, w * 0.72, { cast: false })
  wallPapers(b, 0.735, FLOOR_Y + 1.5, -11.5, -Math.PI / 2, 1.6, 0.8, rnd, 5)
  printoutStack(b, -1.2, FLOOR_Y + 0.8, -8.75, 0, 0.12)
  await pause()

  // ------------------------------------------------------------------ 3-08 listening room (under the dish)
  partition(b, { axis: "z", at: 6.2, from: -21.65, to: -14.925, finish: [ROOM_BANDS, ROOM_BANDS], openings: [{ kind: "door", at: -17.2, side: "a", door: { id: "3-08b", state: "open", open: 1.45, room: "3-08b", sign: { number: "3-08B", label: "BOOTH" } } }] })
  partition(b, { axis: "x", at: -14.925, from: 6.2, to: G[12], finish: [ROOM_BANDS, ROOM_BANDS], openings: [{ kind: "glazed", from: 6.8, to: 10.5, sill: 0.95, head: 2.05, mullion: 1.85 }] })
  s.rooms.push(room(b, { id: "3-08", name: "Listening room", rect: rect(G[10], G[12], -14.925, -1.75), exclude: [RISER_W1_OUTER], floor: "linoleum", lit: "none", anchors: [{ kind: "tape", x: 8.0, y: FLOOR_Y + 0.8, z: -14.0 }] }))
  s.rooms.push(room(b, { id: "3-08w", name: "Listening room (recorders)", rect: rect(G[10], 6.2, -21.65, -14.925), floor: "linoleum", lit: "none" }))
  s.rooms.push(room(b, { id: "3-08b", name: "Listening booth", rect: rect(6.2, G[12], -21.65, -14.925), floor: M.carpet, lit: "none", windows: { blinds: "random", radiators: "convector" } }))
  riserW1(b, { face: "west" })
  s.doc("stencil_w1", [5.3 - 0.002, FLOOR_Y + 2.35, -4.0], [-1, 0, 0], { pin: "none", curl: 0 })
  // Coax bundle out of the riser (the north-array trunk), along the ceiling on hangers to the recorder racks.
  const cy = CEIL_Y - 0.14
  const run: [number, number][] = [[6.0, -4.75], [6.0, -11.6], [10.9, -11.6]]
  for (let k = 0; k < 4; k++) {
    const o = (k - 1.5) * 0.028
    b.rod(M.rubber, [6.0 + o, CEIL_Y, -4.72], [6.0 + o, cy, -4.9], 0.012, 6)
    b.rod(M.rubber, [6.0 + o, cy, -4.9], [6.0 + o, cy, -11.6 + o], 0.012, 6)
    b.rod(M.rubber, [6.0 + o, cy, -11.6 + o], [10.9, cy, -11.6 + o], 0.012, 6)
    b.rod(M.rubber, [10.9, cy, -11.6 + o], [10.95, FLOOR_Y + 1.92, -11.6 + o], 0.012, 6)
  }
  for (const [x, z] of [[6.0, -6.5], [6.0, -9.0], [8.4, -11.6]]) {
    b.rod(M.darkSteel, [x, cy + 0.03, z], [x, CEIL_Y, z], 0.004, 4)
    b.box(M.darkSteel, x - 0.07, cy - 0.025, z - 0.07, x + 0.07, cy - 0.018, z + 0.07)
  }
  b.box(M.yellow, 5.94, cy - 0.03, -8.0, 6.06, cy + 0.03, -7.9, { cast: false })
  void run
  // Recorder wall (east): four reel-to-reel consoles, two analyser racks.
  for (const z of [-14.3, -13.6, -12.9, -12.2]) recorderConsole(b, 11.18, z, W)
  for (const z of [-11.3, -10.68]) analyserRack(b, 11.22, z, W)
  for (const z of [-10.0, -9.3]) recorderConsole(b, 11.18, z, W)
  // Operator desk facing the booth window under the single pendant.
  const od = workTable(b, 8.3, -13.95, 0, 3.0, 0.86, undefined, OPERATOR_DESK_H)
  // Two rack receivers stacked on the desk's left end (a monitor receiver on a spectrum display unit).
  radioUnit(b, T(7.35, od, -14.12, S + 0.06), { maker: "WATKINS-JOHNSON", model: "WJ-8718 HF RECEIVER", w: 0.48, h: 0.13, d: 0.36, meters: ["SIGNAL", "LINE"], knobs: ["BFO", "BANDWIDTH", "RF GAIN", "AF GAIN"] })
  radioUnit(b, T(7.35, od + 0.13, -14.14, S + 0.06), { maker: "IOPS / PHS", model: "SPECTRUM DISPLAY SD-2", w: 0.48, h: 0.15, d: 0.34, meters: ["LEVEL dB"], knobs: ["SPAN", "CENTER", "SWEEP", "INTENSITY"], panel: "#a9aaa2" })
  screenLamp(s, [7.4, od + 0.15, -13.85], 0.6)
  placeModels(b, "telephone", [{ position: [9.9, od, -13.8], yaw: S - 0.4, collide: false, blob: 0 }])
  s.doc("sticky_dish", [7.32, od, -13.64], [0, 1, 0], { rotation: 0.3 })
  s.doc("printout_greenbar", [9.0, od, -13.9], [0, 1, 0], { rotation: 0.15 })
  placeModels(b, "office_chair", [{ position: [OPERATOR_CHAIR.x, FLOOR_Y + OPERATOR_CHAIR.dy, OPERATOR_CHAIR.z], yaw: OPERATOR_CHAIR.yaw, inset: 0.15 }])
  // The one working light: a wide open shade, its spill reaching across the floor to where Hargrove fell.
  pendant(b, 8.3, -13.45, { drop: 1.05, shadow: true, intensity: 95, angle: 1.4, range: 11 })
  // West bench: strip-chart recorders, the paper heaped on the floor; the teletype under the window.
  const wb = workTable(b, 1.25, -18.0, Math.PI / 2, 3.0, 0.76)
  stripChart(b, 1.25, wb, -17.2, E, 1.1, rnd)
  stripChart(b, 1.25, wb, -18.6, E, 0.25, rnd)
  s.doc("printout_greenbar", [3.0, FLOOR_Y, -17.0], [0, 1, 0], { rotation: 1.1, curl: 0.5 })
  s.doc("polaroid_dish", [0.865, FLOOR_Y + 1.45, -19.0], [1, 0, 0], { pin: "pin" })
  teletype(b, 3.5, -20.9, S)
  placeModels(b, "stack_chair", [{ position: [2.0, FLOOR_Y, -15.9], yaw: W + 0.6 }])
  // The spine door is propped open with a chair against the leaf.
  placeModels(b, "stack_chair", [{ position: [1.95, FLOOR_Y, -2.75], yaw: E + 0.3, inset: 0.12 }])
  // STATIC: the night it happened (receiver, aftermath, body anchors): ./listening.ts.
  listening = stageListeningRoom(s)
  // Booth: acoustic panels, a small desk at the window, headphones on it, a lamp left on.
  for (const z of [-20.4, -18.8, -16.0]) acousticPanel(b, 6.3, z, Math.PI / 2, 1.2, 1.8, 0.4)
  for (const z of [-20.2, -18.4, -16.6]) acousticPanel(b, 11.5, z, -Math.PI / 2, 1.4, 1.8, 0.4)
  const bd2 = workTable(b, 8.9, -19.9, 0, 1.6, 0.76)
  deskLamp(b, 9.5, bd2, -20.05, S - 0.5, true, { intensity: 45 })
  headphones(b, 8.6, bd2, -19.8, -0.3)
  s.doc("note_repeated", [8.95, bd2, -19.75], [0, 1, 0], { rotation: -0.25 })
  placeModels(b, "stack_chair", [{ position: [8.7, FLOOR_Y, -19.0], yaw: N + 0.9 }])
  await pause()

  // ------------------------------------------------------------------ 3-09 data analysis bullpen (open to the spine)
  s.rooms.push(room(b, { id: "3-09", name: "Data analysis", rect: rect(G[12], G[16], -21.65, -1.75), floor: "linoleum", lit: "none" }))
  for (let x = 13.46; x < 33.0; x += 0.94) {
    if ((x > 17.4 && x < 19.4) || (x > 26.9 && x < 28.9)) continue
    const top = lateralFile(b, x, -2.0, N)
    if (rnd() < 0.3) printoutStack(b, x + (rnd() - 0.5) * 0.3, top, -2.0, rnd(), 0.03 + rnd() * 0.06)
  }
  const desks: { position: readonly [number, number, number]; yaw: number }[] = []
  const deskChairs: { position: readonly [number, number, number]; yaw: number; inset: number }[] = []
  const terms: { position: readonly [number, number, number]; yaw: number; collide: boolean; blob: number }[] = []
  const litTerms: [number, number, number][] = []
  const cluster = (cx: number, cz: number, lit: number[]) => {
    let i = 0
    for (const sz of [-1, 1])
      for (const sx of [-1, 1]) {
        const x = cx + sx * 1.02
        const z = cz + sz * 0.48
        const yaw = sz < 0 ? N : S
        desks.push({ position: [x, FLOOR_Y, z], yaw })
        if (rnd() < 0.85) deskChairs.push({ position: [x + (rnd() - 0.5) * 0.5, FLOOR_Y, z + sz * (0.95 + rnd() * 0.3)], yaw: yaw + Math.PI + (rnd() - 0.5) * 1.2, inset: 0.15 })
        if (lit.includes(i)) litTerms.push([x - sx * 0.3, z, yaw])
        else if (rnd() < 0.7) terms.push({ position: [x - sx * 0.3, DESK_TOP, z - sz * 0.1], yaw, collide: false, blob: 0 })
        if (rnd() < 0.6) printoutStack(b, x + sx * 0.45, DESK_TOP, z, rnd() * 0.5, 0.02 + rnd() * 0.08)
        i++
      }
  }
  cluster(15.5, -7.2, [1])
  cluster(24.0, -7.2, [2])
  cluster(21.5, -16.2, [0])
  placeModels(b, "office_desk", desks)
  placeModels(b, "office_chair", deskChairs)
  placeModels(b, "crt_terminal", terms)
  for (const [x, z, yaw] of litTerms) {
    const p = terminal(b, x, DESK_TOP, z, yaw, true)
    screenLamp(s, p, 0.6)
  }
  deskLamp(b, 14.0, DESK_TOP, -6.75, N + 2.6, true)
  deskLamp(b, 23.0, DESK_TOP, -16.65, S - 0.6, true)
  s.doc("printout_greenbar", [16.2, DESK_TOP, -7.65], [0, 1, 0], { rotation: 0.4 })
  mug(b, 15.0, DESK_TOP, -6.9)
  ashtray(b, 24.6, DESK_TOP, -7.6, rnd)
  // Map table and plots.
  const mt = workTable(b, 30.6, -16.0, 0, 2.8, 1.3)
  b.quad(PLOT, T(30.4, mt + 0.002, -16.0, 0.05, -Math.PI / 2), 1.2, 0.86, { cast: false })
  b.quad(PLOT, T(31.5, mt + 0.004, -15.8, -0.2, -Math.PI / 2), 0.8, 0.58, { cast: false })
  placeModels(b, "stack_chair", [{ position: [30.0, FLOOR_Y, -14.9], yaw: N + 0.3 }, { position: [31.6, FLOOR_Y, -17.1], yaw: S - 0.2 }])
  chalkboard(b, 11.69, -11.0, -Math.PI / 2, 4.2, "chalk", "chalkboard_equations")
  // Keep the storey's random sequence as it was (the strokes drew 2–3 numbers per cell).
  for (let r = 0; r < 7; r++)
    for (let k = 0; k < 6; k++) {
      if (rnd() < 0.25) continue
      void rnd()
      void rnd()
    }
  for (const x of [17.0, 22.4, 27.8]) b.quad(PLOT, T(x, FLOOR_Y + 1.55, -21.6 + 0.004, 0), 1.1, 0.8, { cast: false })
  wallPapers(b, 34.6, FLOOR_Y + 1.5, -15.0, -Math.PI / 2, 2.0, 0.8, rnd, 7)
  placeModels(b, "filing_cabinet", [33.9, 33.4].map((x) => ({ position: [x, FLOOR_Y, -21.61 + 0.27] as const, yaw: S })))
  placeModels(b, "wall_clock", [{ position: [11.67, FLOOR_Y + 2.6, -16.0], yaw: E, collide: false, blob: 0 }])
  wastebasket(b, 18.0, -9.0)
  wastebasket(b, 26.0, -14.5)
  void THREE
  return listening
}
