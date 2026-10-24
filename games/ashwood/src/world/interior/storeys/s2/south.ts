import {
  type RoomHandle,
  FLOOR_Y,
  G,
  LAYER,
  M,
  PLANT_BANDS,
  PUDDLE,
  ROOM_BANDS,
  T,
  WET_BANDS,
  benchRun,
  chalkboard,
  deskLamp,
  drenchShower,
  eyewashStation,
  fumeHood,
  kitchenette,
  lockers,
  partition,
  peninsula,
  placeModels,
  rect,
  room,
  sinkCounter,
  wastebasket,
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
  ashtray,
  balance,
  balanceTable,
  beaker,
  bottle,
  bottleRow,
  coatRail,
  corkBoard,
  deskClipboard,
  flask,
  flatDoc,
  gasCylinder,
  cylinderStrap,
  hotPlate,
  instrument,
  kitchenTimer,
  labCart,
  plate,
  pt,
  scope,
  shelfUnit,
  table,
  tallCabinet,
  wallCabinet,
  wallClipboard,
  wallDoc,
} from "./props"
import { autoclave, diWater, dryingRack, glasswasher } from "./equipment"
import { LAB, glassware, stool } from "./north"

// South side of storey 2 (z > 0): lab safety office and gas store, the biochem teaching lab with its PPE foyer,
// electronics & sensor lab, break room, Analytical Lab 4 (lit, the hot-plate vignette), glasswash and media prep.

/** Yaw for a chair whose sitter faces (dx, dz) (the seat models face local +Z, as `officeSet` places them). */
const chairYaw = (dx: number, dz: number) => yawToward(dx, dz) + Math.PI

export async function buildSouth(k: K, pause: () => Promise<void>): Promise<RoomHandle[]> {
  const b = k.b
  const rooms: RoomHandle[] = []

  // ---------------------------------------------------------------- 2-20 Lab safety office / 2-22 gas cylinder store
  rooms.push(room(b, { id: "2-20", name: "Lab safety office", rect: rect(G[0], G[1], 1.75, 21.65), windows: { blinds: "random" } }))
  rooms.push(room(b, { id: "2-22", name: "Gas cylinder store", rect: rect(G[1], -43.25, 10.75, 21.65), floor: "concrete_floor_dry", windows: { blinds: "up" } }))
  partition(b, {
    axis: "z",
    at: G[1],
    from: 10.75,
    to: 21.65,
    finish: [ROOM_BANDS, PLANT_BANDS],
    openings: [{ kind: "door", at: 13.2, side: "a", door: { id: "2-22", state: "janitor", room: "2-22", sign: { number: "2-22", label: "GAS CYLINDERS" } } }],
  })
  partition(b, { axis: "z", at: -43.31, from: 10.75, to: 16.05, finish: [PLANT_BANDS, PLANT_BANDS] })
  const ex = G[1] - 0.06
  // First aid, respirators, spill kits by the door; the weekly shower test log (blank after Oct 3).
  const fa = wallCabinet(b, ex, FLOOR_Y + 1.45, 3.1, -1, 0, 0.5, 0.6, 0.16, false, P.enamel)
  b.boxM(M.red, fa, 0.04, 0.16, 0.004, -0.12, 0.05, 0.19, { cast: false })
  b.boxM(M.red, fa, 0.16, 0.04, 0.004, -0.12, 0.05, 0.19, { cast: false })
  const rc = wallCabinet(b, ex, FLOOR_Y + 1.5, 4.6, -1, 0, 0.9, 0.7, 0.3, true, M.cabinet)
  for (let i = 0; i < 4; i++) k.s.rbox(P.dark, rc.clone().multiply(T(-0.3 + i * 0.2, -0.05, 0.15)), 0.12, 0.12, 0.1, 0.05, 0, 0, 0)
  for (const z of [6.0, 6.7]) {
    k.b.rbox(P.hazYellow, F(ex - 0.28, z), 0.5, 0.7, 0.5, 0.04, 0, 0.35, 0)
    k.b.rbox(P.hazYellow, F(ex - 0.28, z), 0.52, 0.04, 0.52, 0.02, 0, 0.72, 0)
    b.collide(ex - 0.53, FLOOR_Y, z - 0.25, ex - 0.03, FLOOR_Y + 0.74, z + 0.25)
  }
  wallClipboard(k, "log_shower_test", ex, FLOOR_Y + 1.5, 2.3, -1, 0)
  // Desk and files at the back; PPE lockers; posters.
  placeModels(b, "office_desk", [{ position: [-51.0, FLOOR_Y, 13.4], yaw: yawToward(1, 0) }])
  placeModels(b, "office_chair", [{ position: [-51.85, FLOOR_Y, 13.3], yaw: chairYaw(1, 0) + 0.3, inset: 0.15 }])
  placeModels(b, "telephone", [{ position: [-50.85, DESK, 14.0], yaw: yawToward(-1, 0) + 0.3, collide: false, blob: 0 }])
  flatDoc(k, "log_shower_test", -50.9, DESK, 13.2, Math.PI / 2 + 0.2)
  flatDoc(k, "memo_carbon_inventory", -51.1, DESK, 12.8, Math.PI / 2 - 0.3)
  placeModels(b, "filing_cabinet", [15.0, 15.5, 16.0].map((z) => ({ position: [ex - 0.27, FLOOR_Y, z] as const, yaw: yawToward(-1, 0) })))
  lockers(b, ex - 0.23, 19.6, Math.PI / 2, 6)
  for (const z of [17.2]) {
    const lv = shelfUnit(b, ex - 0.25, z, yawToward(-1, 0), 1.2, 0.5)
    for (const y of lv.slice(1, 4)) for (let i = 0; i < 3; i++) k.s.rbox(M.cardboard, T(ex - 0.28, y, z - 0.38 + i * 0.38), 0.4, 0.22, 0.32, 0.01, 0, 0.11, 0)
  }
  corkBoard(k, ex, FLOOR_Y + 1.5, 9.4, -1, 0, 1.2, 0.8, ["poster_chemical", "notice_north_array", "poster_radiation", "map_evac_2"])
  wallDoc(k, "calendar_oct84", ex, FLOOR_Y + 1.6, 12.0, -1, 0, { pin: "tack" })
  wastebasket(b, -50.4, 12.6)
  // Gas store: cylinders chained to the west wall, a regulator bench, a cylinder hand truck.
  const gx = G[1] + 0.06
  const cyl = [P.cylGreen, P.cylGrey, P.cylGrey, P.cylBlack, P.cylBrown, P.cylGrey, P.cylGreen, P.cylBlack]
  cyl.forEach((c, i) => gasCylinder(b, gx + 0.15, 16.5 + i * 0.27, c, 1.42, 0.115, i % 3 !== 1))
  cylinderStrap(b, 16.3, 18.6, gx, 1, "z")
  for (const [i, c] of [P.cylGrey, P.cylGreen, P.cylGrey].entries()) gasCylinder(b, -46.0 + i * 0.28, 10.735 + 0.15, c, 1.42)
  cylinderStrap(b, -46.2, -45.2, 10.735, 1)
  benchRun(b, "z", 16.6, 20.6, -43.25, -43.9)
  for (let i = 0; i < 3; i++) {
    const m = T(-43.6, BENCH, 17.2 + i * 0.6)
    k.s.cyl(M.steel, m.clone().multiply(T(0, 0.04, 0, 0, 0, Math.PI / 2)), 0.035, 0.035, 0.1, 12)
    k.s.cyl(M.steel, m.clone().multiply(T(0, 0.06, 0)), 0.03, 0.03, 0.06, 12)
  }
  placeModels(b, "hand_truck", [{ position: [-45.4, FLOOR_Y, 18.6], yaw: 0.6 }])
  wallDoc(k, "notice_firedoors", -43.37, FLOOR_Y + 1.55, 12.5, -1, 0, { pin: "tape" })
  await pause()

  // ---------------------------------------------------------------- 2-24 Biochem teaching lab + PPE foyer
  rooms.push(room(b, { id: "2-24f", name: "Teaching lab PPE foyer", rect: rect(G[5], G[6], 1.75, 9.6) }))
  rooms.push(room(b, { id: "2-24", name: "Biochemistry teaching lab", rect: rect(-36.0, G[6], 9.75, 21.65), windows: { blinds: "random" } }))
  partition(b, {
    axis: "x",
    at: 9.675,
    from: G[5],
    to: G[6],
    finish: [ROOM_BANDS, LAB],
    openings: [{ kind: "door", at: -23.5, side: "a", door: { id: "2-24L", state: "open", room: "2-24" } }],
  })
  partition(b, { axis: "z", at: G[6], from: 1.75, to: 9.75, finish: [ROOM_BANDS, LAB] })
  partition(b, { axis: "z", at: G[6], from: 9.75, to: 21.65, finish: [LAB, LAB] })
  partition(b, { axis: "z", at: -36.075, from: 16.05, to: 21.65, thickness: 0.15, finish: [PLANT_BANDS, WET_BANDS] })
  // Foyer: coats, goggles cabinet, a bench.
  coatRail(b, 2.8, 7.4, G[5] + 0.06, "z", 1, 7, P.coat, k.rnd)
  const gc = wallCabinet(b, G[6] - 0.06, FLOOR_Y + 1.5, 5.2, -1, 0, 0.8, 0.6, 0.25, true)
  for (let i = 0; i < 6; i++) k.s.rbox(P.clear, gc.clone().multiply(T(-0.28 + i * 0.11, -0.05, 0.13)), 0.09, 0.05, 0.08, 0.02, 0, 0, 0)
  table(b, -25.2, 6.6, Math.PI / 2, 1.6, 0.38, 0.45, P.wood, M.darkSteel)
  wallDoc(k, "poster_chemical", G[6] - 0.06, FLOOR_Y + 1.55, 3.0, -1, 0)
  // Lab: drench by the exit, eyewash at the sink nearest the foyer, demonstration bench, four islands.
  sinkCounter(b, -28.4, 9.735 + 0.31, Math.PI, 1.8, 2, "epoxy")
  eyewashStation(b, -26.8, 9.735 + 0.145, Math.PI)
  drenchShower(b, -25.3, 9.735 + 0.26, Math.PI)
  chalkboard(b, -36.0 + 0.03, 15.7, yawToward(1, 0), 3.6, "chalk", "chalkboard_titration")
  peninsula(b, -34.4, 15.7, Math.PI / 2, 2.4, { sink: true })
  for (const z of [14.0, 18.0])
    for (const x of [-30.6, -24.9]) {
      peninsula(b, x, z, 0, 3.6, { sink: z > 15 })
      bottleRow(k, x - 1.5, z, x + 0.9, z, SPINE_TOP, 10)
      for (const dx of [-1.1, 0.0, 1.1]) stool(k, x + dx + (k.rnd() - 0.5) * 0.3, z + (dx === 0 ? -1.05 : 1.05))
    }
  benchRun(b, "z", 10.2, 20.6, G[6] - 0.06, G[6] - 0.71)
  glassware(k, -30.3, BENCH, 13.55, Math.PI)
  glassware(k, -25.4, BENCH, 18.45, 0)
  for (let i = 0; i < 4; i++) beaker(k.s, -34.4 - 0.4, BENCH, 15.0 + i * 0.25, 0.04, 0.1)
  deskClipboard(k, "form_requisition", -21.2, BENCH, 14.0, -Math.PI / 2)
  wallDoc(k, "map_evac_2", -21.0 + 0.0, FLOOR_Y + 1.5, 9.735 + 0.002, 0, 1, { pin: "tape" })
  await pause()

  // ---------------------------------------------------------------- 2-25 Electronics & sensor lab
  rooms.push(room(b, { id: "2-25", name: "Electronics & sensor lab", rect: rect(G[6], G[9], 1.75, 21.65), windows: { blinds: "random" } }))
  // Electronics → break room → Analytical 4: inner doors by the windows, a way along the south side off the spine.
  partition(b, { axis: "z", at: G[9], from: 1.75, to: 21.65, finish: [LAB, ROOM_BANDS], openings: [{ kind: "door", at: 15.0, side: "a", door: { id: "2-26w", state: "closed", room: "2-26" } }] })
  const wx = G[6] + 0.06
  benchRun(b, "z", 2.4, 20.8, wx, wx + 0.65)
  for (const z of [5.0, 8.5, 12.5, 16.5]) scope(b, wx + 0.3, BENCH, z, yawToward(1, 0))
  for (const z of [6.4, 10.2, 14.2, 18.4]) partsCabinet(k, wx + 0.18, BENCH, z, yawToward(1, 0))
  for (const z of [7.2, 11.4, 15.4]) solderStation(k, wx + 0.42, BENCH, z)
  for (const z of [6.0, 11.0, 15.8]) stool(k, wx + 1.15, z)
  // Centre workbenches: one with its lamp still on over a sensor head on the bench.
  const wb = table(b, -13.0, 8.0, 0, 2.4, 0.9, 0.9, M.laminateTop, M.darkSteel)
  table(b, -13.0, 13.5, 0, 2.4, 0.9, 0.9, M.laminateTop, M.darkSteel)
  deskLamp(b, -12.1, FLOOR_Y + 0.9, 7.7, yawToward(0, 1), true, { intensity: 55 })
  scope(b, -13.7, FLOOR_Y + 0.9, 7.8, yawToward(0, 1))
  instrument(b, T(-12.8, FLOOR_Y + 0.9, 13.4, Math.PI), 0.44, 0.16, 0.36, GL.amber)
  sensorHead(k, ...pt(wb, 0.7, 0.9, 0.15), true)
  placeModels(b, "office_chair", [{ position: [-12.5, FLOOR_Y, 8.9], yaw: chairYaw(0, -1) + 0.4, inset: 0.15 }])
  flatDoc(k, "work_order_night", -13.2, FLOOR_Y + 0.9, 8.2, 0.3)
  // Sensor-head rack "N. ARRAY 2", cable reels, parts shelving.
  const rx = G[9] - 0.06 - 0.25
  for (const z of [6.5, 7.72]) {
    const lv = shelfUnit(b, rx, z, yawToward(-1, 0), 1.2, 0.5)
    for (const y of lv.slice(1, 4)) for (let i = 0; i < 4; i++) sensorHead(k, rx - 0.02, y, z - 0.42 + i * 0.28, false)
  }
  plate(b, G[9] - 0.06 - 0.002, FLOOR_Y + 2.35, 7.1, -1, 0, 0.6, 0.14, P.hazYellow, "sign_sensor_store")
  for (const [x, z, r] of [[-6.2, 18.5, 0.42], [-6.4, 17.3, 0.32], [-7.4, 18.6, 0.35]] as const) cableReel(k, x, z, r)
  corkBoard(k, G[9] - 0.06, FLOOR_Y + 1.5, 12.0, -1, 0, 1.5, 0.9, ["work_order_night", "directory_extensions", "printout_greenbar", "polaroid_dish", "card_extensions"])
  wallDoc(k, "calendar_oct84", G[9] - 0.06, FLOOR_Y + 1.6, 3.5, -1, 0, { pin: "tack" })
  await pause()

  // ---------------------------------------------------------------- 2-26 Lab break room
  rooms.push(room(b, { id: "2-26", name: "Lab break room", rect: rect(G[9], G[11], 1.75, 21.65), lit: [[0.6, 6.0]], windows: { blinds: "random" } }))
  partition(b, { axis: "z", at: G[11], from: 1.75, to: 21.65, finish: [ROOM_BANDS, LAB], openings: [{ kind: "door", at: 16.8, side: "a", door: { id: "2-27x", state: "closed", room: "2-27" } }] })
  kitchenette(b, G[9] + 0.06 + 0.31, 4.5, -Math.PI / 2, 2.4, { coffeeOn: true })
  placeModels(b, "vending_machine", [3.2, 3.9].map((z) => ({ position: [G[11] - 0.06 - 0.32, FLOOR_Y, z] as const, yaw: yawToward(-1, 0) })))
  b.lamp({ kind: "window", position: [5.0, FLOOR_Y + 1.3, 3.55], color: [0.92, 0.92, 0.84], intensity: 2.2, range: 3.8, size: 0.4 })
  placeModels(b, "water_cooler", [{ position: [G[11] - 0.06 - 0.18, FLOOR_Y, 4.75], yaw: yawToward(-1, 0) }])
  for (const tz of [9.2, 13.0]) {
    table(b, 0.6, tz, 0, 1.2, 0.8)
    placeModels(b, "stack_chair", [
      { position: [0.3, FLOOR_Y, tz + 0.65], yaw: chairYaw(0, -1) + (k.rnd() - 0.5) * 0.4, inset: 0.1 },
      { position: [0.9, FLOOR_Y, tz - 0.65], yaw: chairYaw(0, 1) + (k.rnd() - 0.5) * 0.4, inset: 0.1 },
      { position: [-0.3, FLOOR_Y, tz - 0.6], yaw: chairYaw(0, 1) + (k.rnd() - 0.5) * 0.6, inset: 0.1 },
    ])
    ashtray(k, 0.8, FLOOR_Y + 0.74, tz + 0.1)
  }
  placeModels(b, "lounge_chair", [
    { position: [-1.8, FLOOR_Y, 18.8], yaw: chairYaw(1, 0.3) },
    { position: [1.6, FLOOR_Y, 19.0], yaw: chairYaw(-1, 0.2) },
  ])
  table(b, -0.1, 19.0, 0, 0.9, 0.5, 0.42, P.wood, P.wood)
  ashtray(k, -0.2, FLOOR_Y + 0.42, 19.0)
  flatDoc(k, "memo_coffee", 0.1, FLOOR_Y + 0.42, 18.9, 0.5)
  wastebasket(b, -3.6, 7.2)
  corkBoard(k, G[9] + 0.06, FLOOR_Y + 1.5, 10.5, 1, 0, 1.5, 0.9, ["flyer_bowling", "signup_bowling", "memo_coffee", "poster_missing_cat", "menu_cafeteria", "notice_nightshift", "sticky_marge"])
  placeModels(b, "wall_clock", [{ position: [G[11] - 0.06 - 0.03, FLOOR_Y + 2.3, 9.0], yaw: yawToward(-1, 0), collide: false, blob: 0 }])
  await pause()

  // ---------------------------------------------------------------- 2-27 Analytical Lab 4 (lit; the hot plate)
  rooms.push(
    room(b, {
      id: "2-27",
      name: "Analytical Lab 4",
      rect: rect(G[11], G[14], 1.75, 21.65),
      lit: [[9.0, 18.0], [13.8, 18.0], [8.4, 12.0], [10.8, 12.0], [13.2, 12.0], [15.6, 12.0]],
      troffers: { intensity: 24 },
      windows: { blinds: "random" },
    }),
  )
  partition(b, {
    axis: "x",
    at: 15.6,
    from: G[11],
    to: G[14],
    finish: [LAB, LAB],
    openings: [
      { kind: "glazed", from: 6.35, to: 13.6, sill: 0.9, head: 2.3 },
      { kind: "door", at: 14.3, side: "a", door: { id: "2-27w", state: "closed", room: "2-27" } },
      { kind: "glazed", from: 15.0, to: 22.25, sill: 0.9, head: 2.3 },
    ],
  })
  partition(b, { axis: "z", at: G[14], from: 1.75, to: 8.1, finish: [LAB, WET_BANDS] })
  partition(b, { axis: "z", at: G[14], from: 8.1, to: 21.65, finish: [LAB, LAB] })
  const w = G[11] + 0.06
  const e = G[14] - 0.06
  // Both doors: drench beside the door, eyewash next to a sink on the side wall.
  drenchShower(b, 6.95, 1.75 + 0.26, Math.PI)
  eyewashStation(b, w + 0.145, 3.2, -Math.PI / 2)
  sinkCounter(b, w + 0.31, 4.7, -Math.PI / 2, 1.8, 2, "epoxy")
  drenchShower(b, 21.35, 1.75 + 0.26, Math.PI)
  eyewashStation(b, e - 0.145, 3.2, Math.PI / 2)
  sinkCounter(b, e - 0.31, 4.7, Math.PI / 2, 1.8, 2, "epoxy")
  fumeHood(b, e - 0.43, 7.0, Math.PI / 2, false)
  fumeHood(b, e - 0.43, 8.8, Math.PI / 2, false)
  benchRun(b, "z", 9.9, 15.4, e, e - 0.65)
  benchRun(b, "z", 6.0, 15.4, w, w + 0.65)
  for (const x of [9.3, 12.1, 14.9, 19.0]) {
    peninsula(b, x, 8.4, Math.PI / 2, 4.2, { sink: x === 14.9 })
    bottleRow(k, x, 6.6, x, 10.2, SPINE_TOP, 14)
  }
  for (const [x, z] of [[8.4, 7.4], [10.2, 9.6], [11.2, 7.0], [15.8, 9.0], [18.1, 7.6], [19.9, 9.8]] as const) stool(k, x, z)
  placeModels(b, "chemistry_set", [{ position: [14.9 - 0.42, BENCH, 8.0], yaw: yawToward(-1, 0), collide: false, blob: 0 }])
  placeModels(b, "microscope", [{ position: [w + 0.36, BENCH, 12.4], yaw: yawToward(1, 0) - 0.2, collide: false, blob: 0 }])
  glassware(k, 9.3 + 0.42, BENCH, 7.6, yawToward(1, 0))
  glassware(k, 19.0 - 0.42, BENCH, 9.2, yawToward(-1, 0))
  for (const x of [e - 0.5]) {
    beaker(k.s, x, HOOD_DECK, 7.2, 0.05, 0.13)
    bottle(k.s, x, HOOD_DECK, 6.6, 0)
    flask(k.s, x - 0.05, HOOD_DECK, 9.0)
  }
  // Vignette: hot plate still on under a beaker boiled dry, timer stopped at 01:12, "back in 5 — R.".
  const hp: [number, number, number] = [12.1 + 0.45, BENCH, 10.0]
  hotPlate(k, hp[0], hp[1], hp[2], yawToward(1, 0), true)
  beaker(k.s, hp[0] - 0.02, hp[1] + 0.095, hp[2] - 0.0, 0.05, 0.13, true)
  kitchenTimer(k.s, hp[0] + 0.05, hp[1], hp[2] + 0.28, 1.2)
  flatDoc(k, "sticky_back5", hp[0] + 0.12, hp[1], hp[2] - 0.25, 0.25)
  deskClipboard(k, "form_requisition", hp[0] + 0.05, hp[1], hp[2] - 0.6, -1.3)
  b.lamp({ kind: "incandescent", position: [hp[0], hp[1] + 0.2, hp[2]], color: [1, 0.32, 0.08], intensity: 1.4, range: 1.6, size: 0.08 })
  placeModels(b, "lab_stool", [{ position: [hp[0] + 0.75, FLOOR_Y, hp[2] + 0.3], yaw: 0.8, inset: 0.06 }])
  // Balance tables against the glass, write-up desks at the windows.
  balanceTable(k, 9.9, 15.54 - 0.32, Math.PI, 1)
  balanceTable(k, 11.3, 15.54 - 0.32, Math.PI, 1)
  for (const [i, x] of [8.9, 14.3, 19.7].entries()) {
    placeModels(b, "office_desk", [{ position: [x, FLOOR_Y, 20.55], yaw: Math.PI }])
    placeModels(b, "office_chair", [{ position: [x + (k.rnd() - 0.5) * 0.5, FLOOR_Y, 19.6], yaw: chairYaw(0, 1) + (k.rnd() - 0.5) * 0.8, inset: 0.15 }])
    flatDoc(k, (["form_requisition", "memo_carbon_inventory", "printout_greenbar"] as const)[i]!, x - 0.3, DESK, 20.5, Math.PI + (k.rnd() - 0.5) * 0.5)
  }
  placeModels(b, "telephone", [{ position: [14.9, DESK, 20.4], yaw: Math.PI - 0.3, collide: false, blob: 0 }])
  wallClipboard(k, "log_shower_test", w, FLOOR_Y + 1.5, 2.4, 1, 0)
  wallDoc(k, "poster_chemical", e, FLOOR_Y + 1.6, 12.5, -1, 0)
  wallDoc(k, "calendar_oct84", w, FLOOR_Y + 1.6, 18.0, 1, 0, { pin: "tack" })
  await pause()

  // ---------------------------------------------------------------- 2-28 Glasswash & autoclave / 2-29 balance & media
  rooms.push(room(b, { id: "2-28", name: "Glasswash & autoclave", rect: rect(G[14], G[16], 1.75, 8.04), lit: [[28.2, 4.8]], windows: { blinds: "up" } }))
  rooms.push(room(b, { id: "2-29", name: "Balance & media prep", rect: rect(G[14], G[16], 8.16, 21.65), windows: { blinds: "random" } }))
  partition(b, {
    axis: "x",
    at: 8.1,
    from: G[14],
    to: G[16],
    finish: [WET_BANDS, LAB],
    openings: [{ kind: "door", at: 30.0, side: "a", door: { id: "2-29", state: "closed", room: "2-29" } }],
  })
  sinkCounter(b, 24.6, 8.04 - 0.31, 0, 2.4, 2, "epoxy")
  glasswasher(b, 26.5, 8.04 - 0.31, 0)
  dryingRack(k, 24.6, FLOOR_Y + 1.75, 8.04, 0, -1, 2.0)
  autoclave(b, 33.0, 1.75 + 0.66, Math.PI)
  diWater(b, 32.0, FLOOR_Y + 1.55, 8.04, 0, -1)
  b.box(M.steel, 28.35, FLOOR_Y + LAYER * 0.5, 4.65, 28.65, FLOOR_Y + LAYER * 1.5, 4.95, { cast: false })
  for (const [x, z, sx, sz, r] of [[28.4, 4.9, 2.2, 1.4, 0.3], [25.6, 6.3, 1.6, 0.9, 1.1], [30.8, 3.4, 1.2, 0.8, 2.0]] as const)
    b.quad(PUDDLE, T(x, FLOOR_Y + LAYER * 2, z, r, -Math.PI / 2), sx, sz, { cast: false })
  placeModels(b, "wet_floor_sign", [{ position: [27.6, FLOOR_Y, 3.0], yaw: 0.6, inset: 0.05 }])
  const cart = labCart(b, 27.25, 2.35, 0)
  for (let i = 0; i < 5; i++) flask(k.s, ...pt(cart, -0.3 + i * 0.15, 0.88, 0.05), 0.05)
  for (let i = 0; i < 4; i++) beaker(k.s, ...pt(cart, -0.25 + i * 0.17, 0.28, -0.05), 0.05, 0.12)
  labCart(b, 23.4, 5.0, Math.PI / 2 + 0.1)
  wallDoc(k, "notice_firedoors", G[14] + 0.06, FLOOR_Y + 1.6, 3.4, 1, 0, { pin: "tape" })
  // 2-29: balance tables, media fridge, pH meters on the peninsula, a bench on the west wall.
  for (const x of [23.4, 24.8, 26.2]) balanceTable(k, x, 8.16 + 0.32, Math.PI, 1)
  const fr = tallCabinet(b, 33.6, 8.16 + 0.37, Math.PI, 0.7, 1.9, 0.7, P.enamel)
  b.quad(M.glass, fr.clone().multiply(T(0, 1.15, -0.352, Math.PI)), 0.56, 1.2, { cast: false })
  for (let s = 0; s < 4; s++) for (let i = 0; i < 4; i++) bottle(k.s, ...pt(fr, -0.22 + i * 0.15, 0.6 + s * 0.32, -0.15), 2, 0.16, 0.04, 1)
  benchRun(b, "z", 12.0, 20.8, G[14] + 0.06, G[14] + 0.71)
  peninsula(b, 28.5, 15.0, 0, 3.6)
  for (const dx of [-1.0, 0.2]) instrument(b, T(28.5 + dx, BENCH, 14.6, 0), 0.26, 0.12, 0.22, GL.ledGreen)
  for (const dx of [-1.0, 0.2]) beaker(k.s, 28.5 + dx + 0.25, BENCH, 14.5, 0.035, 0.08)
  bottleRow(k, 27.0, 15.4, 30.0, 15.4, BENCH, 12)
  bottleRow(k, 27.0, 15.0, 30.0, 15.0, SPINE_TOP, 12)
  stool(k, 27.6, 13.8)
  stool(k, 29.6, 16.3)
  balance(k.s, T(G[14] + 0.4, BENCH, 15.0, yawToward(1, 0)))
  deskClipboard(k, "form_requisition", G[14] + 0.4, BENCH, 17.5, Math.PI / 2)
  return rooms
}

/** Small multi-drawer parts cabinet on a bench (front −Z). */
function partsCabinet(k: K, x: number, y: number, z: number, yaw: number) {
  const m = T(x, y, z, yaw)
  k.b.rbox(P.blueGrey, m, 0.45, 0.4, 0.3, 0.006, 0, 0.2, 0)
  for (let r = 0; r < 6; r++) for (let c = 0; c < 4; c++) k.s.boxM(r % 2 ? P.clear : P.poly, m, 0.1, 0.055, 0.006, -0.165 + c * 0.11, 0.04 + r * 0.063, -0.152, { cast: false })
}

/** Soldering station: base unit, iron in its coil stand, a sponge tray, solder reel. */
function solderStation(k: K, x: number, y: number, z: number) {
  const m = T(x, y, z, yawToward(1, 0))
  k.s.rbox(P.blueGrey, m, 0.14, 0.09, 0.18, 0.01, -0.12, 0.045, 0)
  k.s.boxM(GL.red, m, 0.02, 0.01, 0.002, -0.12, 0.06, -0.091, { cast: false })
  k.s.cyl(M.steel, m.clone().multiply(T(0.08, 0.06, 0, 0, 0.6)), 0.02, 0.03, 0.12, 10, { open: true })
  k.s.rod(P.dark, pt(m, 0.08, 0.1, 0.03), pt(m, 0.08, 0.02, -0.12), 0.008, 6)
  k.s.cyl(M.steel, m.clone().multiply(T(0.0, 0.025, -0.12, 0, Math.PI / 2)), 0.03, 0.03, 0.02, 12)
}

/** Sensor head: steel can with a domed window and a cable tail, tag on a string. */
function sensorHead(k: K, x: number, y: number, z: number, open: boolean) {
  k.s.cyl(P.stainless, T(x, y + 0.11, z), 0.06, 0.06, 0.22, 12)
  k.s.cyl(M.darkSteel, T(x, y + 0.225, z), 0.065, 0.065, 0.01, 12)
  k.s.cyl(open ? P.dark : M.glass, T(x, y + 0.235, z), 0.04, 0.05, 0.02, 12)
  k.s.boxM(M.paper, T(x + 0.065, y + 0.12, z, 0.3), 0.004, 0.06, 0.04, 0, 0, 0, { cast: false })
  k.s.rod(M.rubber, [x - 0.06, y + 0.04, z], [x - 0.14, y + 0.01, z + 0.05], 0.008, 5)
}

/** Wooden cable reel standing on its flange edge? No — lying flat: two flanges and a drum of cable. */
function cableReel(k: K, x: number, z: number, r: number) {
  k.b.cyl(P.wood, T(x, FLOOR_Y + 0.02, z), r, r, 0.04, 20)
  k.b.cyl(M.rubber, T(x, FLOOR_Y + 0.17, z), r * 0.8, r * 0.8, 0.26, 20)
  k.b.cyl(P.wood, T(x, FLOOR_Y + 0.32, z), r, r, 0.04, 20)
  k.b.collide(x - r, FLOOR_Y, z - r, x + r, FLOOR_Y + 0.34, z + r)
}
