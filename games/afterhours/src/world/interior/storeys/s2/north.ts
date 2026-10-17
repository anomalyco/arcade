import {
  type RoomHandle,
  FLOOR_Y,
  CEIL_Y,
  G,
  LAYER,
  M,
  ROOM_BANDS,
  STYLES,
  T,
  benchRun,
  ceiling,
  column,
  drenchShower,
  eyewashStation,
  fumeHood,
  officeSet,
  partition,
  peninsula,
  placeModels,
  rect,
  riserW1,
  room,
  sinkCounter,
  troffers,
  yawToward,
} from "../../api"
import {
  BENCH,
  DESK,
  HOOD_DECK,
  SPINE_TOP,
  F,
  GL,
  type K,
  P,
  balanceTable,
  beaker,
  bioPlacard,
  bottle,
  bottleRow,
  bulkhead,
  chestFreezer,
  coatRail,
  coreBox,
  deskClipboard,
  flask,
  flatDoc,
  gasCylinder,
  cylinderStrap,
  hazardDiamond,
  intercom,
  jar,
  labCart,
  plate,
  pt,
  shelfUnit,
  table,
  tallCabinet,
  wallCabinet,
  wallClipboard,
  wallDoc,
} from "./props"
import {
  atomicAbsorption,
  benchAutoclave,
  biosafetyCabinet,
  centrifuge,
  chartRecorder,
  darkroomSink,
  electronMicroscope,
  enlarger,
  gasChromatograph,
  incubatorStack,
  isolator,
} from "./equipment"

// North side of storey 2 (z < 0): chemical store, geochemistry labs and their instrument room, microbiology, the cold
// room, the specimen archive, the lab manager's offices, darkroom + EM, and the containment suite. Spine doors are
// built by the spine (s2.ts); everything here is behind them.

const LAB = STYLES[2]!.bands
const DARK = [
  [0, 0.1, M.rubber],
  [0.1, 99, P.dark],
] as typeof ROOM_BANDS
const COLD = [[0, 99, P.coldPanel]] as typeof ROOM_BANDS
/** Zone wall (interior/perimeter) centre and thickness on the north side. */
const ZW = -11.925
const ZT = 0.15
/** Room faces of the zone wall. */
const ZN = ZW - ZT / 2
const ZS = ZW + ZT / 2

const stool = (k: K, x: number, z: number) => placeModels(k.b, "lab_stool", [{ position: [x, FLOOR_Y, z], yaw: k.rnd() * 6.28, inset: 0.06 }])
const glassware = (k: K, x: number, y: number, z: number, yaw: number) => placeModels(k.b, "glassware", [{ position: [x, y, z], yaw, collide: false, blob: 0 }])

export async function buildNorth(k: K, pause: () => Promise<void>): Promise<RoomHandle[]> {
  const b = k.b
  const rooms: RoomHandle[] = []

  // ---------------------------------------------------------------- 2-01 chemical store / 2-02 Geochem 1 / 2-03 GC-AA
  // The program's 2-01/2-02 line (z −11.9) would cut through a west-facade window; it moves 1.6 m north to the pier
  // between windows (z −13.5), and 2-02 keeps its internal door from 2-03 through the zone wall.
  rooms.push(room(b, { id: "2-01", name: "Chemical store", rect: rect(G[0], G[1], -13.44, -1.75), windows: { blinds: "closed" } }))
  rooms.push(room(b, { id: "2-02", name: "Geochemistry Lab 1", rect: rect(G[0], G[2], -21.65, -13.56), windows: { blinds: "random" } }))
  rooms.push(room(b, { id: "2-02b", name: "Geochemistry Lab 1 (door bay)", rect: rect(G[1], G[2], -13.56, -12.0), troffers: false }))
  rooms.push(room(b, { id: "2-03", name: "Instrument room (GC / AA)", rect: rect(G[1], G[2], -11.85, -1.75), lit: [[-45.1, -7.2]] }))
  partition(b, { axis: "x", at: -13.5, from: G[0], to: G[1], finish: [LAB, LAB] })
  partition(b, { axis: "z", at: G[1], from: -13.5, to: -1.75, finish: [LAB, LAB] })
  partition(b, {
    axis: "x",
    at: ZW,
    from: G[1],
    to: G[2],
    thickness: ZT,
    finish: [LAB, LAB],
    openings: [{ kind: "door", at: -45.1, side: "b", door: { id: "2-02", state: "closed", room: "2-02", sign: { number: "2-02", label: "GEOCHEM 1" } } }],
  })
  partition(b, { axis: "z", at: G[2], from: -21.65, to: -1.75, finish: [LAB, LAB] })
  column(b, G[1], -11.9)

  // 2-01: flammables cabinets (yellow), acid cabinet (blue-grey), ventilated shelving, spill kit, eyewash inside door.
  for (const [z, mat] of [[-8.62, P.hazYellow], [-7.58, P.hazYellow], [-2.85, P.blueGrey]] as const) {
    const m = tallCabinet(b, -54.61 + 0.3, z, yawToward(1, 0), 1.0, 1.65, 0.58, mat)
    b.boxM(M.red, m, 0.6, 0.08, 0.004, 0, 1.4, -0.292, { cast: false })
  }
  for (const z of [-8.4, -7.1, -5.8]) {
    const lv = shelfUnit(b, -48.15, z, yawToward(-1, 0), 1.2, 0.5, [0.12, 0.55, 0.98, 1.41, 1.84], P.blueGrey, 2.1)
    for (const y of lv.slice(1)) bottleRow(k, -48.3, z - 0.5, -48.3, z + 0.5, y, 7)
    for (const y of lv.slice(1, 3)) bottleRow(k, -48.0, z - 0.5, -48.0, z + 0.5, y, 5)
  }
  b.cyl(P.hazYellow, T(-48.5, FLOOR_Y + 0.38, -3.3), 0.28, 0.25, 0.76, 18)
  b.cyl(P.hazYellow, T(-48.5, FLOOR_Y + 0.79, -3.3), 0.29, 0.29, 0.06, 18)
  b.collide(-48.8, FLOOR_Y, -3.6, -48.2, FLOOR_Y + 0.82, -3.0)
  eyewashStation(b, -51.05, -1.75 - 0.145, 0)
  sinkCounter(b, -52.35, -1.75 - 0.31, 0, 1.2, 1, "epoxy")
  wallDoc(k, "poster_chemical", -53.0, FLOOR_Y + 1.55, -13.44 + 0.0, 0, 1)
  await pause()

  // 2-02: two fume hoods on its south walls, two peninsulas, a wall bench and the sink, eyewash and drench at the door.
  fumeHood(b, -52.6, -13.56 - 0.43, 0, false)
  fumeHood(b, -50.4, -13.56 - 0.43, 0, false)
  peninsula(b, -50.3, -18.2, Math.PI / 2, 3.6, { sink: true })
  peninsula(b, -46.1, -18.2, Math.PI / 2, 3.6)
  benchRun(b, "z", -21.5, -14.5, G[2] - 0.06, G[2] - 0.71)
  sinkCounter(b, G[2] - 0.06 - 0.31, -13.5, Math.PI / 2, 1.8, 2, "epoxy")
  eyewashStation(b, -44.0, ZN - 0.145, 0)
  drenchShower(b, -46.6, ZN - 0.26, 0)
  for (const [x, z] of [[-49.4, -19.1], [-51.2, -17.2], [-45.2, -18.9], [-47.0, -17.6]] as const) stool(k, x, z)
  for (const x of [-50.3, -46.1]) bottleRow(k, x, -19.6, x, -16.9, SPINE_TOP, 14)
  glassware(k, -46.55, BENCH, -17.3, yawToward(-1, 0))
  for (const z of [-20.8, -19.4, -16.0]) bottle(k.s, G[2] - 0.4, BENCH, z, 0, 0.24, 0.05)
  beaker(k.s, G[2] - 0.45, BENCH, -18.2)
  flask(k.s, G[2] - 0.5, BENCH, -18.6)
  for (const x of [-52.6, -50.4]) {
    bottle(k.s, x - 0.3, HOOD_DECK, -14.0, 0)
    beaker(k.s, x + 0.2, HOOD_DECK, -13.9, 0.05, 0.13)
  }
  deskClipboard(k, "form_requisition", -49.85, BENCH, -18.8, 0.3)
  wallDoc(k, "poster_chemical", -54.61 + 0.002, FLOOR_Y + 1.6, -20.4, 1, 0)
  await pause()

  // 2-03: instrument benches (GC, AA under its canopy, chart recorder spooling onto the floor, a terminal), chained gas.
  benchRun(b, "z", -11.6, -5.0, G[1] + 0.06, G[1] + 0.71)
  benchRun(b, "z", -10.9, -3.2, G[2] - 0.06, G[2] - 0.71)
  gasChromatograph(b, G[1] + 0.4, BENCH, -9.6, yawToward(1, 0))
  gasChromatograph(b, G[1] + 0.4, BENCH, -8.6, yawToward(1, 0))
  atomicAbsorption(b, G[2] - 0.38, BENCH, -9.6, yawToward(-1, 0))
  chartRecorder(k, G[1] + 0.33, BENCH, -6.4, yawToward(1, 0), 0.38)
  placeModels(b, "crt_terminal", [{ position: [G[2] - 0.35, BENCH, -6.2], yaw: yawToward(-1, 0), collide: false, blob: 0 }])
  placeModels(b, "office_chair", [{ position: [-43.9, FLOOR_Y, -6.0], yaw: yawToward(-1, 0) + 0.5, inset: 0.15 }])
  for (const [x, c] of [[-46.7, P.cylGrey], [-46.4, P.cylBlack], [-46.1, P.cylGreen]] as const) gasCylinder(b, x, -11.62, c, 1.42, 0.115, x !== -46.4)
  cylinderStrap(b, -46.9, -45.9, ZS, 1)
  stool(k, -46.4, -7.2)
  deskClipboard(k, "memo_carbon_inventory", G[2] - 0.45, BENCH, -4.4, -1.4)
  wallDoc(k, "calendar_oct84", -42.46, FLOOR_Y + 1.7, -4.0, -1, 0, { pin: "tack" })
  await pause()

  // ---------------------------------------------------------------- 2-04 Geochem Lab 2
  rooms.push(room(b, { id: "2-04", name: "Geochemistry Lab 2", rect: rect(G[2], G[4], -21.65, -1.75), windows: { blinds: "random" } }))
  partition(b, {
    axis: "x",
    at: ZW,
    from: G[2],
    to: G[4],
    thickness: 0.12,
    finish: [LAB, LAB],
    openings: [
      { kind: "glazed", from: -42.3, to: -40.6, sill: 0.9, head: 2.3 },
      { kind: "door", at: -40.0, side: "b", door: { id: "2-04L", state: "closed", room: "2-04", glass: "wire" } },
      { kind: "glazed", from: -39.4, to: -37.3, sill: 0.9, head: 2.3 },
      { kind: "glazed", from: -36.7, to: -31.7, sill: 0.9, head: 2.3, mullion: 1.25 },
    ],
  })
  partition(b, { axis: "z", at: G[4], from: -21.65, to: -1.75, finish: [LAB, LAB] })
  // Lab: west wall sink + eyewash within 3 m of the lab door, drench beside the door, the lit hood (facade glow).
  sinkCounter(b, G[2] + 0.06 + 0.31, -14.2, -Math.PI / 2, 1.2, 1, "epoxy")
  eyewashStation(b, G[2] + 0.06 + 0.145, -13.0, -Math.PI / 2)
  drenchShower(b, -38.6, -12.55 - 0.2, 0)
  fumeHood(b, G[2] + 0.06 + 0.43, -19.4, -Math.PI / 2, true)
  fumeHood(b, -37.0, -21.61 + 0.43, Math.PI, false)
  fumeHood(b, G[4] - 0.06 - 0.43, -19.5, Math.PI / 2, false)
  benchRun(b, "z", -17.6, -12.3, G[4] - 0.06, G[4] - 0.71)
  for (const x of [-39.6, -36.9, -34.2]) {
    peninsula(b, x, -16.5, Math.PI / 2, 3.0, { sink: x === -34.2 })
    bottleRow(k, x, -17.7, x, -15.4, SPINE_TOP, 12)
  }
  placeModels(b, "chemistry_set", [{ position: [-36.9 + 0.42, BENCH, -16.6], yaw: yawToward(1, 0), collide: false, blob: 0 }])
  glassware(k, -39.6 - 0.42, BENCH, -16.0, yawToward(-1, 0))
  for (const [x, z] of [[-35.7, -16.9], [-40.6, -15.8], [-38.4, -17.3]] as const) stool(k, x, z)
  // The lit hood: work in progress left inside.
  const hx = G[2] + 0.5
  bottle(k.s, hx, HOOD_DECK, -19.9, 2, 0.26, 0.06, 1)
  beaker(k.s, hx + 0.05, HOOD_DECK, -19.3, 0.055, 0.14)
  flask(k.s, hx, HOOD_DECK, -18.9, 0.06)
  wallDoc(k, "poster_chemical", G[4] - 0.06, FLOOR_Y + 1.6, -12.9, -1, 0)
  await pause()
  // Write-up area (south of the glass): three desks facing the lab, chalkboard, coat rack, files.
  for (const [i, x] of [-37.4, -35.2, -33.0].entries()) {
    placeModels(b, "office_desk", [{ position: [x, FLOOR_Y, -10.85], yaw: 0 }])
    placeModels(b, "office_chair", [{ position: [x + (k.rnd() - 0.5) * 0.4, FLOOR_Y, -9.95 + k.rnd() * 0.3], yaw: Math.PI + (k.rnd() - 0.5) * 0.9, inset: 0.15 }])
    flatDoc(k, (["form_requisition", "memo_carbon_inventory", "envelope_interoffice"] as const)[i]!, x + 0.4, DESK, -10.8, (k.rnd() - 0.5) * 0.6)
  }
  placeModels(b, "telephone", [{ position: [-32.6, DESK, -11.0], yaw: 0.3, collide: false, blob: 0 }])
  placeModels(b, "coat_rack", [{ position: [-41.6, FLOOR_Y, -2.6], yaw: 0.4 }])
  placeModels(b, "filing_cabinet", [-3.0, -3.5].map((z) => ({ position: [G[4] - 0.06 - 0.26, FLOOR_Y, z] as const, yaw: yawToward(-1, 0) })))
  wallDoc(k, "map_evac_2", G[4] - 0.06, FLOOR_Y + 1.5, -6.0, -1, 0, { pin: "tape" })
  wallDoc(k, "notice_firedoors", G[2] + 0.06, FLOOR_Y + 1.5, -5.0, 1, 0, { pin: "tape" })
  await pause()

  // ---------------------------------------------------------------- 2-05 Microbiology suite
  rooms.push(room(b, { id: "2-05", name: "Microbiology: gowning and media prep", rect: rect(G[4], G[6], -11.85, -1.75) }))
  rooms.push(room(b, { id: "2-05L", name: "Microbiology lab", rect: rect(G[4], G[6], -21.65, -12.0), windows: { blinds: "closed" } }))
  partition(b, {
    axis: "x",
    at: ZW,
    from: G[4],
    to: G[6],
    thickness: ZT,
    finish: [LAB, LAB],
    openings: [
      { kind: "glazed", from: -25.7, to: -23.9, sill: 1.0, head: 2.0 },
      { kind: "door", at: -22.5, side: "b", door: { id: "2-05L", state: "closed", room: "2-05L", sign: { number: "2-05", label: "MICROBIOLOGY" } } },
    ],
  })
  partition(b, { axis: "z", at: G[6], from: -21.65, to: -1.75, finish: [LAB, LAB] })
  column(b, G[5], -11.9)
  // Gowning: coat rail, bench, sticky mat at the lab door, media prep counter with a bench-top autoclave.
  coatRail(b, -11.6, -7.0, G[4] + 0.06, "z", 1, 6, P.coat, k.rnd)
  table(b, -28.5, -6.5, 0, 1.8, 0.4, 0.45, P.wood, M.darkSteel)
  b.box(M.paper, -23.1, FLOOR_Y, -11.7, -21.9, FLOOR_Y + LAYER, -10.9, { cast: false })
  sinkCounter(b, G[6] - 0.06 - 0.31, -5.0, Math.PI / 2, 2.4, 1, "epoxy")
  benchAutoclave(b, G[6] - 0.4, BENCH, -5.8, yawToward(-1, 0))
  bottleRow(k, G[6] - 0.25, -4.6, G[6] - 0.25, -3.9, BENCH, 4)
  wallClipboard(k, "form_requisition", G[6] - 0.06, FLOOR_Y + 1.5, -3.2, -1, 0)
  biohazardDoor(k, -21.2, ZS, 1)
  // Lab: BSC on the pier (UV on: the violet landmark), incubators, centrifuge, microscopes, sink + eyewash at the door.
  biosafetyCabinet(b, -26.2, -21.61 + 0.42, Math.PI, true)
  incubatorStack(b, G[4] + 0.06 + 0.38, -12.95, yawToward(1, 0))
  incubatorStack(b, G[4] + 0.06 + 0.38, -13.75, yawToward(1, 0))
  benchRun(b, "z", -20.8, -15.0, G[4] + 0.06, G[4] + 0.71)
  centrifuge(b, G[6] - 0.06 - 0.4, -17.0, yawToward(-1, 0))
  sinkCounter(b, G[6] - 0.06 - 0.31, -13.6, Math.PI / 2, 1.2, 1, "epoxy")
  eyewashStation(b, -21.38, ZN - 0.145, 0)
  placeModels(b, "microscope", [
    { position: [G[4] + 0.38, BENCH, -16.0], yaw: yawToward(1, 0), collide: false, blob: 0 },
    { position: [G[4] + 0.38, BENCH, -18.4], yaw: yawToward(1, 0) + 0.2, collide: false, blob: 0 },
  ])
  stool(k, -30.2, -16.2)
  stool(k, -29.9, -18.9)
  for (let i = 0; i < 6; i++) k.s.cyl(P.enamel, T(G[4] + 0.35, BENCH + 0.006 + i * 0.012, -19.9), 0.045, 0.045, 0.01, 14)
  bottleRow(k, G[4] + 0.3, -20.6, G[4] + 0.3, -20.2, BENCH, 3)
  table(b, -26.0, -17.4, 0, 1.6, 0.75, 0.9, P.stainless, P.stainless)
  for (let i = 0; i < 5; i++) k.s.cyl(P.enamel, T(-26.5 + i * 0.12, FLOOR_Y + 0.9 + 0.006, -17.3), 0.045, 0.045, 0.012, 14)
  deskClipboard(k, "form_requisition", -25.5, FLOOR_Y + 0.9, -17.5, 0.2)
  await pause()

  // ---------------------------------------------------------------- 2-06 Cold room + −80 °C freezers
  rooms.push(room(b, { id: "2-06", name: "Cold room anteroom", rect: rect(G[6], G[7], -6.1, -1.75), ceiling: { none: true }, troffers: false }))
  ceiling(b, G[6], -6.1, G[7], -1.75)
  troffers(b, [{ x: -18.0, z: -3.6, on: false }])
  b.floor("linoleum", G[6], -11.85, G[7], -6.1)
  partition(b, { axis: "z", at: G[7], from: ZW + ZT / 2, to: -1.75, finish: [LAB, LAB] })
  partition(b, { axis: "x", at: ZW, from: G[6], to: G[7], thickness: ZT, finish: [LAB, COLD] })
  coldRoom(k)
  chestFreezer(b, G[7] - 0.06 - 0.4, -5.1, yawToward(-1, 0))
  chestFreezer(b, G[7] - 0.06 - 0.4, -3.3, yawToward(-1, 0))
  wallClipboard(k, "memo_carbon_inventory", G[6] + 0.06, FLOOR_Y + 1.45, -4.6, 1, 0)
  column(b, G[7], -11.9)
  await pause()

  // ---------------------------------------------------------------- 2-07 Specimen archive
  rooms.push(room(b, { id: "2-07", name: "Specimen archive", rect: rect(G[7], G[9], -21.65, -1.75), troffers: false, windows: { blinds: "closed" } }))
  rooms.push(room(b, { id: "2-07b", name: "Specimen archive (west aisles)", rect: rect(G[6], G[7], -21.65, -12.0), troffers: false, windows: { blinds: "closed" } }))
  partition(b, { axis: "z", at: G[9], from: -21.65, to: -1.75, finish: [LAB, ROOM_BANDS] })
  const cells = [-3.6, -7.2, -10.8, -14.4, -18.0].flatMap((z) => [
    { x: -10.2, z, on: z === -10.8, flicker: z === -10.8 ? 0.85 : undefined },
    { x: -12.6, z, on: false },
    { x: -7.2, z, on: false },
  ])
  cells.push({ x: -16.8, z: -14.4, on: false }, { x: -16.8, z: -18.0, on: false }, { x: -19.2, z: -16.8, on: false })
  const tr = troffers(b, cells, { intensity: 14 })
  k.updates.push(tr.update)
  archive(k)
  await pause()

  // ---------------------------------------------------------------- 2-08 Lab manager, safety office, write-up
  rooms.push(room(b, { id: "2-08", name: "Write-up bullpen", rect: rect(G[9], G[11], -11.85, -1.75) }))
  rooms.push(room(b, { id: "2-08a", name: "Lab manager", rect: rect(G[9], G[10], -21.65, -12.0), windows: { blinds: "random" } }))
  rooms.push(room(b, { id: "2-08b", name: "Safety officer", rect: rect(G[10], G[11], -21.65, -12.0), windows: { blinds: "random" } }))
  partition(b, {
    axis: "x",
    at: ZW,
    from: G[9],
    to: G[11],
    thickness: ZT,
    finish: [ROOM_BANDS, ROOM_BANDS],
    openings: [
      { kind: "door", at: -3.6, side: "b", door: { id: "2-08a", state: "closed", room: "2-08a", leaf: "veneer", sign: { number: "2-08A", label: "LAB MANAGER" } } },
      { kind: "door", at: 5.3, side: "b", door: { id: "2-08b", state: "closed", room: "2-08b", leaf: "veneer", sign: { number: "2-08B", label: "SAFETY" } } },
    ],
  })
  partition(b, { axis: "z", at: G[10], from: -21.65, to: ZN, finish: [ROOM_BANDS, ROOM_BANDS] })
  partition(b, { axis: "z", at: G[11], from: -21.65, to: -12.0, finish: [ROOM_BANDS, LAB] })
  partition(b, { axis: "z", at: G[11], from: -12.0, to: -4.7, finish: [ROOM_BANDS, DARK] })
  partition(b, { axis: "z", at: G[11], from: -3.3, to: -1.75, finish: [ROOM_BANDS, DARK] })
  riserW1(b, { face: "west" })
  wallDoc(k, "stencil_w1", 5.3 - 0.002, FLOOR_Y + 2.45, -4.0, -1, 0, { pin: "none", curl: 0 })
  column(b, G[9], -11.9)
  column(b, G[11], -11.9)
  bullpen(k)
  await pause()

  // ---------------------------------------------------------------- 2-09 Darkroom + EM
  rooms.push(room(b, { id: "2-09", name: "Darkroom", rect: rect(G[11], 13.4, -11.85, -1.75) }))
  rooms.push(room(b, { id: "2-09a", name: "Darkroom anteroom", rect: rect(13.4, G[13], -11.85, -1.75) }))
  rooms.push(room(b, { id: "2-09e", name: "Electron microscope room", rect: rect(G[11], G[13], -21.65, -12.0), windows: { blinds: "closed" } }))
  partition(b, {
    axis: "x",
    at: ZW,
    from: G[11],
    to: G[13],
    thickness: ZT,
    finish: [LAB, LAB],
    openings: [{ kind: "door", at: 15.2, side: "b", door: { id: "2-09e", state: "closed", room: "2-09e", sign: { number: "2-09E", label: "ELECTRON MICROSCOPE" } } }],
  })
  partition(b, { axis: "z", at: 13.4, from: ZS, to: -1.75, finish: [DARK, LAB], openings: [{ kind: "cased", from: -3.1, to: -2.0, head: 2.1 }] })
  partition(b, { axis: "z", at: 12.14, from: -4.4, to: -1.75, finish: [DARK, DARK] })
  partition(b, { axis: "z", at: G[13], from: -21.65, to: -1.75, finish: [LAB, LAB] })
  column(b, G[13], -11.9)
  darkroom(k)
  await pause()

  // ---------------------------------------------------------------- 2-10 Containment lab + airlock
  rooms.push(room(b, { id: "2-10a", name: "Containment airlock", rect: rect(G[13], G[14], -11.85, -1.75) }))
  rooms.push(room(b, { id: "2-10", name: "Containment lab", rect: rect(G[14], G[16], -21.65, -1.75), windows: { blinds: "closed" } }))
  rooms.push(room(b, { id: "2-10b", name: "Containment lab (support bay)", rect: rect(G[13], G[14], -21.65, -12.0), windows: { blinds: "closed" } }))
  partition(b, { axis: "x", at: ZW, from: G[13], to: G[14], thickness: ZT, finish: [LAB, WET()] })
  partition(b, {
    axis: "z",
    at: G[14],
    from: -12.0,
    to: -1.75,
    finish: [WET(), LAB],
    openings: [
      { kind: "glazed", from: -4.3, to: -3.7, sill: 0.95, head: 1.45 },
      { kind: "door", at: -9.0, side: "a", door: { id: "2-10L", state: "closed", room: "2-10", sign: { number: "2-10", label: "CONTAINMENT" } } },
    ],
  })
  containment(k)
  return rooms
}

const WET = () => [
  [0, 0.12, "tile_green_dark"],
  [0.12, 1.5, "tile_green"],
  [1.5, 99, M.block],
] as typeof ROOM_BANDS

/** Biohazard placard and intercom beside a door (on the wall face at z = wz, normal nz). */
function biohazardDoor(k: K, x: number, wz: number, nz: number) {
  bioPlacard(k.b, x, FLOOR_Y + 1.55, wz + nz * 0.002, 0, nz)
}

/** 2-06 walk-in cold room (4 °C): insulated panel box, latch door, its own panel ceiling, racks, bulkhead lamp. */
function coldRoom(k: K) {
  const b = k.b
  const x0 = G[6] + 0.06
  const x1 = G[7] - 0.06
  const z0 = ZS
  const zDoor = -6.15
  const top = FLOOR_Y + 2.6
  partition(b, {
    axis: "x",
    at: zDoor,
    from: x0,
    to: x1,
    thickness: 0.1,
    finish: [COLD, COLD],
    openings: [{ kind: "door", at: -18.9, side: "b", door: { id: "2-06w", state: "closed", room: "2-06", insulated: true, sign: { number: "2-06", label: "COLD ROOM 4°C" } } }],
  })
  // Inner liner on the room's own walls, panel ceiling, aluminium floor.
  b.box(P.coldPanel, x0 + 0.005, FLOOR_Y, z0 + 0.005, x0 + 0.05, top, zDoor - 0.05, { skip: "x" })
  b.box(P.coldPanel, x1 - 0.05, FLOOR_Y, z0 + 0.005, x1 - 0.005, top, zDoor - 0.05, { skip: "X" })
  b.box(P.coldPanel, x0 + 0.05, FLOOR_Y, z0 + 0.005, x1 - 0.05, top, z0 + 0.05, { skip: "z" })
  b.box(P.coldPanel, x0, top, z0, x1, top + 0.08, zDoor - 0.05, { cast: false })
  b.box(P.stainless, x0 + 0.05, FLOOR_Y, z0 + 0.05, x1 - 0.05, FLOOR_Y + LAYER, zDoor - 0.05, { cast: false })
  for (let x = x0 + 1.0; x < x1 - 0.5; x += 1.0) b.box(P.stainless, x - 0.01, FLOOR_Y + 0.4, z0 + 0.05, x + 0.01, top, z0 + 0.06, { cast: false })
  bulkhead(b, (x0 + x1) / 2, top, -9.0, true, 5)
  // Racks: tube racks, sample boxes, a few jars, a crate of cores on the floor.
  for (const z of [-11.0, -9.6, -8.2]) {
    const lv = shelfUnit(b, x0 + 0.05 + 0.25, z, yawToward(1, 0), 1.2, 0.5, [0.12, 0.6, 1.08, 1.56, 2.0], P.stainless, 2.3)
    lv.slice(1).forEach((y) => {
      for (let i = 0; i < 4; i++) if (k.rnd() < 0.7) k.s.rbox(i % 2 ? P.poly : M.cardboard, T(x0 + 0.33, y, z - 0.45 + i * 0.3), 0.36, 0.1, 0.25, 0.01, 0, 0.05, 0)
    })
  }
  for (const z of [-11.0, -9.6]) {
    const lv = shelfUnit(b, x1 - 0.05 - 0.25, z, yawToward(-1, 0), 1.2, 0.5, [0.12, 0.6, 1.08, 1.56, 2.0], P.stainless, 2.3)
    lv.slice(1, 4).forEach((y) => {
      for (let i = 0; i < 6; i++) if (k.rnd() < 0.6) jar(k, x1 - 0.32, y, z - 0.45 + i * 0.18, 0.05, 0.14, k.rnd())
    })
  }
  coreBox(k.s, -18.0, FLOOR_Y, -7.4, 0.4)
  coreBox(k.s, -18.05, FLOOR_Y + 0.1, -7.38, 0.35)
  b.collide(-18.45, FLOOR_Y, -7.7, -17.55, FLOOR_Y + 0.2, -7.1)
  // Outside: dial thermometer beside the door, a placard.
  const m = T(-18.0, FLOOR_Y + 1.6, zDoor + 0.05)
  b.cyl(M.steel, m.clone().multiply(T(0, 0, 0.02, 0, Math.PI / 2)), 0.08, 0.08, 0.04, 20)
  b.cyl(P.enamel, m.clone().multiply(T(0, 0, 0.041, 0, Math.PI / 2)), 0.07, 0.07, 0.002, 20, { cast: false })
  b.boxM(M.red, m, 0.004, 0.06, 0.002, 0.015, 0.0, 0.044, { cast: false })
  plate(b, -19.9, FLOOR_Y + 1.7, zDoor + 0.05, 0, 1, 0.4, 0.14, P.green)
}

/** 2-07: long aisles of steel shelving — jars in fluid and waxed core boxes, labelled by SL depth. */
function archive(k: K) {
  const b = k.b
  const W = 1.2
  const D = 0.5
  const fill = (x: number, z: number, face: number, levels: number[], jars: number) => {
    levels.forEach((y, li) => {
      const r = k.rnd()
      if (r < jars && li > 0 && li < 4) {
        let u = -W / 2 + 0.08
        while (u < W / 2 - 0.08) {
          const rr = 0.04 + k.rnd() * 0.05
          const h = rr * (2.2 + k.rnd() * 1.6)
          if (k.rnd() < 0.85) jar(k, x + face * (D / 2 - 0.12 - k.rnd() * 0.08), y, z + u, rr, Math.min(h, 0.36), k.rnd())
          u += rr * 2 + 0.03
        }
      } else if (r < jars + 0.4) {
        const n = 1 + Math.floor(k.rnd() * 3)
        for (let i = 0; i < n; i++) coreBox(k.s, x + face * 0.02, y + i * 0.102, z + (k.rnd() - 0.5) * 0.1, Math.PI / 2 + (k.rnd() - 0.5) * 0.05, i === n - 1 && k.rnd() < 0.1)
      }
      // Depth label on the shelf lip.
      k.s.box(M.paper, x + face * (D / 2 + 0.001), y - 0.03, z - 0.06, x + face * (D / 2 + 0.003), y - 0.005, z + 0.06, { cast: false })
    })
  }
  const run = (x: number, z0: number, z1: number, faces: number[], jars: number) => {
    for (let z = z0 + W / 2; z <= z1 - W / 2 + 1e-3; z += W + 0.02)
      for (const f of faces) {
        const cx = x + (faces.length === 2 ? f * D / 2 : 0)
        const lv = shelfUnit(b, cx, z, f > 0 ? yawToward(1, 0) : yawToward(-1, 0))
        fill(cx, z, f, lv, jars)
      }
  }
  for (const x of [-13.6, -11.6, -8.4, -6.4]) {
    const jars = Math.abs(x + 10) < 2 ? 0.55 : 0.35
    run(x, -21.0, -12.6, [-1, 1], jars)
    run(x, -11.4, -3.0, [-1, 1], jars)
  }
  run(G[6] + 0.06 + 0.25, -21.0, -13.8, [1], 0.2)
  run(-18.3, -21.0, -13.8, [-1, 1], 0.2)
  // A step stool and a box pulled out onto the floor.
  coreBox(k.s, -10.1, FLOOR_Y, -14.0, 0.3, true)
  b.collide(-10.5, FLOOR_Y, -14.3, -9.7, FLOOR_Y + 0.12, -13.7)
  k.b.rbox(P.blueGrey, T(-9.6, FLOOR_Y, -15.2, 0.2), 0.4, 0.3, 0.3, 0.02, 0, 0.15, 0)
  wallClipboard(k, "form_requisition", -15.34, FLOOR_Y + 1.5, -3.0, 1, 0)
  wallDoc(k, "notice_sublevel", -4.66, FLOOR_Y + 1.55, -2.6, -1, 0, { pin: "tack" })
}

/** 2-08 write-up desks, MSDS shelves, the riser door; offices: lab manager (key cabinet) and safety officer. */
function bullpen(k: K) {
  const b = k.b
  for (const [x, i] of [[-2.0, 0], [0.3, 1], [2.6, 2]] as const) {
    placeModels(b, "office_desk", [{ position: [x, FLOOR_Y, -9.4], yaw: Math.PI }, { position: [x, FLOOR_Y, -8.45], yaw: 0 }])
    placeModels(b, i === 1 ? "stack_chair" : "office_chair", [{ position: [x + (k.rnd() - 0.5) * 0.4, FLOOR_Y, -10.3], yaw: (k.rnd() - 0.5) * 0.8, inset: 0.12 }])
    placeModels(b, i === 2 ? "office_chair" : "stack_chair", [{ position: [x + (k.rnd() - 0.5) * 0.4, FLOOR_Y, -7.55], yaw: Math.PI + (k.rnd() - 0.5) * 0.8, inset: 0.12 }])
  }
  flatDoc(k, "form_requisition", -1.8, DESK, -8.5, 0.2)
  flatDoc(k, "memo_carbon_inventory", 2.8, DESK, -9.3, Math.PI - 0.3)
  flatDoc(k, "directory_extensions", 0.6, DESK, -9.5, Math.PI + 0.1)
  placeModels(b, "telephone", [{ position: [0.8, DESK, -8.3], yaw: Math.PI + 0.3, collide: false, blob: 0 }])
  // MSDS binders: two bookcases on the west wall.
  for (const z of [-6.3, -5.3]) binderCase(k, G[9] + 0.06 + 0.16, z, yawToward(1, 0))
  placeModels(b, "filing_cabinet", [0.4, 1.0, 1.6].map((x) => ({ position: [x, FLOOR_Y, -1.75 - 0.075 - 0.27] as const, yaw: Math.PI })))
  wallDoc(k, "directory_extensions", -1.6, FLOOR_Y + 1.5, ZS + 0.001, 0, 1, { pin: "tack" })
  wallDoc(k, "calendar_oct84", 3.9, FLOOR_Y + 1.6, ZS + 0.001, 0, 1, { pin: "tack" })
  // Lab manager (2-08a): desk facing the door, key cabinet (chem store key), MSDS binders, calendar.
  officeSet(b, -1.9, -17.2, Math.PI, { lamp: false, visitors: 1 })
  const kc = wallCabinet(b, G[10] - 0.06, FLOOR_Y + 1.5, -14.2, -1, 0, 0.38, 0.5, 0.09, false, P.blueGrey)
  b.boxM(M.paper, kc, 0.12, 0.05, 0.002, 0, 0.18, 0.122, { cast: false })
  binderCase(k, G[9] + 0.06 + 0.16, -14.6, yawToward(1, 0))
  placeModels(b, "filing_cabinet", [{ position: [G[9] + 0.06 + 0.27, FLOOR_Y, -19.5], yaw: yawToward(1, 0) }])
  wallDoc(k, "calendar_oct84", G[10] - 0.06, FLOOR_Y + 1.6, -16.3, -1, 0, { pin: "tack" })
  flatDoc(k, "memo_carbon_inventory", -1.6, DESK, -17.2, 0.4)
  // Safety officer (2-08b): desk, files, the containment keycard on the blotter.
  officeSet(b, 3.5, -17.2, Math.PI, { lamp: false, visitors: 1 })
  b.box(P.enamel, 3.05, DESK, -17.25, 3.135, DESK + 0.002, -17.196, { cast: false })
  b.box(M.red, 3.05, DESK + 0.002, -17.25, 3.135, DESK + 0.0025, -17.236, { cast: false })
  placeModels(b, "filing_cabinet", [-19.2, -19.7].map((z) => ({ position: [G[11] - 0.06 - 0.27, FLOOR_Y, z] as const, yaw: yawToward(-1, 0) })))
  wallClipboard(k, "form_requisition", G[11] - 0.06, FLOOR_Y + 1.5, -14.0, -1, 0)
  wallDoc(k, "poster_chemical", G[10] + 0.06, FLOOR_Y + 1.6, -15.0, 1, 0)
  flatDoc(k, "form_requisition", 3.2, DESK, -17.0, -0.3)
}

/** Bookcase of MSDS binders (coloured spines), back at +Z. */
function binderCase(k: K, x: number, z: number, yaw: number) {
  const m = F(x, z, yaw)
  const b = k.b
  b.rbox(M.cabinet, m, 0.9, 1.8, 0.32, 0.01, 0, 0.9, 0)
  const cols = [P.hazRed, P.capBlue, P.hazYellow, P.green, P.dark, P.hazWhite]
  for (let s = 0; s < 4; s++) {
    const y = 0.12 + s * 0.42
    b.boxM(M.darkSteel, m, 0.86, 0.018, 0.3, 0, y, -0.006)
    let u = -0.41
    while (u < 0.4) {
      const w = 0.05 + k.rnd() * 0.03
      if (k.rnd() < 0.9) k.s.boxM(cols[Math.floor(k.rnd() * cols.length)]!, m, w - 0.004, 0.3, 0.25, u + w / 2, y + 0.16, -0.02)
      u += w
    }
  }
  b.boxM(M.darkSteel, m, 0.86, 0.003, 0.002, 0, 1.79, -0.161, { cast: false })
}

/** 2-09 darkroom (light trap, wet sink with trays, enlargers, prints drying, red safelight) and EM room. */
function darkroom(k: K) {
  const b = k.b
  darkroomSink(k, 9.2, ZS + 0.375, Math.PI, 4.2)
  benchRun(b, "z", -10.8, -5.0, G[11] + 0.06, G[11] + 0.71)
  enlarger(b, G[11] + 0.4, BENCH, -9.6, yawToward(1, 0))
  enlarger(b, G[11] + 0.4, BENCH, -6.6, yawToward(1, 0))
  // Safelight over the sink: housing with a red filter; real lamp (incandescent behind red glass).
  const sm = T(9.2, FLOOR_Y + 2.35, ZS + 0.05)
  b.rbox(P.dark, sm, 0.26, 0.2, 0.1, 0.01, 0, 0, 0.05)
  b.boxM(GL.safelight, sm, 0.22, 0.16, 0.002, 0, 0, 0.101, { cast: false })
  b.lamp({ kind: "incandescent", position: [9.2, FLOOR_Y + 2.2, ZS + 0.3], direction: [0, -0.7, 0.7], color: [1, 0.06, 0.02], intensity: 6, range: 6, angle: 1.3, penumbra: 0.8, size: 0.12 })
  // Prints drying on a line, timer on the wall.
  b.rod(M.steel, [7.0, FLOOR_Y + 2.05, -7.4], [12.0, FLOOR_Y + 2.05, -7.4], 0.002, 4)
  for (let i = 0; i < 9; i++) {
    const x = 7.4 + i * 0.5 + (k.rnd() - 0.5) * 0.1
    const m = T(x, FLOOR_Y + 1.88, -7.4, (k.rnd() - 0.5) * 0.3, 0, (k.rnd() - 0.5) * 0.08)
    k.s.boxM(k.rnd() < 0.5 ? P.chart : M.paper, m, 0.2, 0.25, 0.002, 0, 0, 0, { cast: false })
    k.s.boxM(P.dark, m, 0.16, 0.19, 0.0025, 0, 0.01, 0, { cast: false })
    k.s.boxM(P.wood, m, 0.03, 0.04, 0.012, 0, 0.14, 0)
  }
  const tm = T(11.3, FLOOR_Y + 1.6, ZS + 0.02)
  b.rbox(P.dark, tm, 0.2, 0.2, 0.05, 0.02, 0, 0, 0.025)
  b.cyl(GL.ledGreen, tm.clone().multiply(T(0, 0, 0.052, 0, Math.PI / 2)), 0.07, 0.07, 0.002, 16, { cast: false })
  // Anteroom: film drying cabinet, chemical shelf, "in use" lamp (off) over the light trap.
  const dc = tallCabinet(b, 16.5, ZS + 0.31, Math.PI, 0.7, 1.9, 0.6, P.enamel)
  b.quad(P.dark, dc.clone().multiply(T(0, 1.2, -0.302, Math.PI)), 0.5, 0.8, { cast: false })
  for (const z of [-9.4]) {
    const lv = shelfUnit(b, G[13] - 0.06 - 0.25, z, yawToward(-1, 0), 1.2, 0.5)
    for (const y of lv.slice(1, 4)) for (let i = 0; i < 4; i++) bottle(k.s, G[13] - 0.3, y, z - 0.4 + i * 0.26, i % 2 ? 3 : 0, 0.28, 0.07)
  }
  b.box(M.hazardOff, 13.46, FLOOR_Y + 2.2, -2.75, 13.5, FLOOR_Y + 2.3, -2.35)
  wallDoc(k, "notice_firedoors", G[13] - 0.06, FLOOR_Y + 1.55, -6.0, -1, 0, { pin: "tape" })
  // EM room: microscope console, chilled-water lines on the north wall, water chiller, electronics rack.
  electronMicroscope(b, 10.8, -17.0, Math.PI)
  for (const x of [8.0, 8.25]) b.rod(P.capBlue, [x, FLOOR_Y, -21.45], [x, CEIL_Y, -21.45], 0.025, 8)
  for (const x of [8.0, 8.25]) b.rod(P.capBlue, [x, FLOOR_Y + 0.4, -21.45], [x, FLOOR_Y + 0.4, -19.5], 0.025, 8)
  b.cyl(M.red, T(8.0, FLOOR_Y + 1.2, -21.35, 0, Math.PI / 2), 0.05, 0.05, 0.02, 12)
  const ch = tallCabinet(b, G[11] + 0.06 + 0.36, -19.6, yawToward(1, 0), 0.8, 1.2, 0.7, P.beige)
  b.boxM(GL.ledGreen, ch, 0.02, 0.02, 0.002, 0.2, 1.0, -0.352, { cast: false })
  const rk = tallCabinet(b, 15.8, -21.61 + 0.4, Math.PI, 0.65, 1.9, 0.8, P.blueGrey)
  for (let i = 0; i < 5; i++) b.boxM(i % 2 ? GL.amber : GL.ledGreen, rk, 0.012, 0.012, 0.002, -0.2 + i * 0.1, 1.5, -0.402, { cast: false })
  placeModels(b, "office_chair", [{ position: [11.2, FLOOR_Y, -15.9], yaw: Math.PI + 0.4, inset: 0.15 }])
  flatDoc(k, "printout_greenbar", 11.6, FLOOR_Y + 0.775, -17.1, 0.2)
}

/** 2-10 containment airlock (decon shower, eyewash, PPE, pass box) and lab (isolator facing the spine window). */
function containment(k: K) {
  const b = k.b
  // Airlock: decon shower stall in the NE corner beside the lab door, eyewash, bench, suits, boot rack.
  const sx0 = 21.0
  const sx1 = G[14] - 0.06
  const sz0 = ZS
  const sz1 = -10.4
  b.box("tile_green", sx0, FLOOR_Y, sz1 - 0.1, sx1, FLOOR_Y + 0.12, sz1)
  b.collide(sx0, FLOOR_Y, sz1 - 0.1, sx1, FLOOR_Y + 0.12, sz1)
  b.box(M.steel, (sx0 + sx1) / 2 - 0.08, FLOOR_Y + LAYER * 0.5, (sz0 + sz1) / 2 - 0.08, (sx0 + sx1) / 2 + 0.08, FLOOR_Y + LAYER * 1.5, (sz0 + sz1) / 2 + 0.08, { cast: false })
  b.box("tile_green", sx0 - 0.04, FLOOR_Y, sz0, sx0, FLOOR_Y + 2.1, sz1 - 0.1)
  b.collide(sx0 - 0.04, FLOOR_Y, sz0, sx0, FLOOR_Y + 2.1, sz1 - 0.1)
  b.rod(M.steel, [sx0, FLOOR_Y + 2.05, sz1 - 0.05], [sx1, FLOOR_Y + 2.05, sz1 - 0.05], 0.012, 6)
  for (let i = 0; i < 3; i++) b.quad(P.coat, T(sx0 + 0.15 + i * 0.14, FLOOR_Y + 1.25, sz1 - 0.05, 0.3 * (i - 1)), 0.18, 1.6, { cast: false })
  drenchShower(b, (sx0 + sx1) / 2 + 0.1, sz0 + 0.27, Math.PI)
  eyewashStation(b, sx1 - 0.145, -10.0, Math.PI / 2)
  table(b, 19.4, -6.0, 0, 1.8, 0.4, 0.45, P.wood, M.darkSteel)
  coatRail(b, -8.6, -4.6, G[13] + 0.06, "z", 1, 5, P.suit, k.rnd)
  for (let i = 0; i < 4; i++) k.s.rbox(P.suit, T(17.4 + i * 0.3, FLOOR_Y, -2.4), 0.12, 0.3, 0.28, 0.04, 0, 0.15, 0)
  intercom(b, G[13] + 0.06 + 0.002, FLOOR_Y + 1.45, -2.6, 1, 0)
  // Pass box through the airlock/lab wall.
  const pb = T(G[14], FLOOR_Y + 0.95, -4.0, Math.PI / 2)
  b.rbox(P.stainless, pb, 0.6, 0.5, 0.42, 0.01, 0, 0.25, 0)
  for (const s of [-1, 1]) {
    b.boxM(GLASS(), pb, 0.4, 0.3, 0.004, 0, 0.27, s * 0.212, { cast: false })
    b.boxM(M.steel, pb, 0.04, 0.12, 0.03, 0.22, 0.25, s * 0.225)
  }
  wallDoc(k, "notice_sublevel", G[13] + 0.062, FLOOR_Y + 1.55, -7.8, 1, 0, { pin: "tape" })
  // Lab: the isolator facing the observation window, its torn glove; tray SL-14 empty, lid on the floor.
  isolator(k, 28.0, -4.6, Math.PI)
  const tm = table(b, 31.6, -6.0, Math.PI, 1.4, 0.7, 0.9, P.stainless, P.stainless)
  const tp = pt(tm, 0.2, 0.9, 0)
  k.s.boxM(P.stainless, T(tp[0], tp[1], tp[2], 0.15), 0.42, 0.012, 0.3, 0, 0.006, 0)
  for (const [w, dz] of [[0.42, 0.15], [0.42, -0.15]] as const) k.s.boxM(P.stainless, T(tp[0], tp[1], tp[2], 0.15), w, 0.05, 0.008, 0, 0.03, dz)
  for (const [dx] of [[0.21], [-0.21]] as const) k.s.boxM(P.stainless, T(tp[0], tp[1], tp[2], 0.15), 0.008, 0.05, 0.3, dx, 0.03, 0)
  k.s.boxM(M.paper, T(tp[0], tp[1], tp[2], 0.15), 0.08, 0.03, 0.002, 0, 0.03, 0.155, { cast: false })
  k.s.boxM(P.stainless, T(30.9, FLOOR_Y + 0.008, -4.9, 0.9, 0.05, 0.03), 0.44, 0.016, 0.32, 0, 0, 0)
  b.collide(30.65, FLOOR_Y, -5.15, 31.15, FLOOR_Y + 0.03, -4.65)
  // Benches along the north wall, waste bins, a −80 freezer and fridge in the support bay.
  benchRun(b, "z", -21.4, -13.6, 34.61, 33.96)
  for (const z of [-20.0, -17.4]) placeModels(b, "microscope", [{ position: [34.27, BENCH, z], yaw: yawToward(-1, 0) + 0.1, collide: false, blob: 0 }])
  bottleRow(k, 34.4, -19.2, 34.4, -18.2, BENCH, 6)
  deskClipboard(k, "form_requisition", 34.2, BENCH, -15.0, 1.4)
  for (const [x, z] of [[33.6, -3.0], [34.0, -3.0]] as const) {
    k.b.rbox(P.bio, T(x, FLOOR_Y, z), 0.36, 0.6, 0.36, 0.03, 0, 0.3, 0)
    b.collide(x - 0.18, FLOOR_Y, z - 0.18, x + 0.18, FLOOR_Y + 0.6, z + 0.18)
  }
  chestFreezer(b, G[13] + 0.06 + 0.4, -15.0, yawToward(1, 0))
  const fr = tallCabinet(b, G[13] + 0.06 + 0.36, -17.4, yawToward(1, 0), 0.7, 1.9, 0.7, P.enamel)
  b.boxM(GL.ledGreen, fr, 0.02, 0.02, 0.002, 0.2, 1.75, -0.352, { cast: false })
  labCart(b, 20.0, -14.0, 0.3)
  bioPlacard(b, G[13] + 0.062, FLOOR_Y + 1.6, -13.0, 1, 0)
  bioPlacard(b, 23.3, FLOOR_Y + 1.6, -1.752, 0, -1)
  bioPlacard(b, 20.95, FLOOR_Y + 1.55, -1.598, 0, 1)
  intercom(b, 21.4, FLOOR_Y + 1.4, -1.598, 0, 1)
  hazardDiamond(b, 34.61 - 0.002, FLOOR_Y + 1.6, -2.6, -1, 0)
  wallClipboard(k, "checklist_rounds", G[14] + 0.06, FLOOR_Y + 1.5, -6.6, 1, 0)
}

const GLASS = () => M.glass
// Re-exported helpers the south side shares.
export { stool, glassware, LAB, WET, DARK }
export { balanceTable, gasCylinder, bioPlacard, hazardDiamond }
