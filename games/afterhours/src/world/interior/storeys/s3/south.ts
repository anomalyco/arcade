import { MODELS } from "../../../../render/models"
import {
  CEIL_Y,
  FLOOR_Y,
  G,
  M,
  PANEL_ON,
  ROOM_BANDS,
  T,
  TUBE,
  ceiling,
  column,
  conferenceTable,
  cot,
  deskLamp,
  kitchenette,
  linePrinter,
  lockers,
  partition,
  placeModels,
  rect,
  room,
  wall,
  wallPapers,
  wastebasket,
  yawToward,
  type DoorState,
  type Prop,
} from "../../api"
import { DESK_TOP, type S3 } from "./common"
import { decollator, pigeonholes, staticTV, teleprinter, terminal } from "./equipment"
import { ashtray, cardCatalogue, carrel, counter, mug, printoutStack, workTable } from "./furniture"
import { PLOT } from "./mats"

// South side of storey 3 (z > 1.75): operators' rest room, the computing manager, the terminal pool, and the
// programmers' wing with its racetrack (cross corridor → inner corridor) round the print room and documentation library.

const N = yawToward(0, -1)
const S = yawToward(0, 1)
const E = yawToward(1, 0)
const W = yawToward(-1, 0)
const GREEN: [number, number, number] = [0.35, 1, 0.5]

export async function buildSouth(s: S3, pause: () => Promise<void>) {
  const b = s.b
  const rnd = s.rnd
  const chairs: Prop[] = []
  const stacks: Prop[] = []
  const crts: Prop[] = []

  // ------------------------------------------------------------------ 3-20 operators' rest room
  partition(b, { axis: "z", at: G[1], from: 10.75, to: 21.65, finish: [ROOM_BANDS, ROOM_BANDS], openings: [{ kind: "door", at: 13.0, side: "a", door: { id: "3-22", state: "closed", room: "3-22", sign: { number: "3-22", label: "MANAGER" } } }] })
  s.rooms.push(
    room(b, {
      id: "3-20",
      name: "Operators' rest room",
      rect: rect(G[0], G[1], 1.75, 21.65),
      floor: "linoleum",
      lit: "none",
      anchors: [{ kind: "keycard:server", x: -48.3, y: FLOOR_Y + 1.4, z: 7.6 }],
    }),
  )
  lockers(b, -48.095, 5.0, Math.PI / 2, 6)
  lockers(b, -48.095, 7.8, Math.PI / 2, 4)
  cot(b, -53.9, 10.6, Math.PI / 2)
  kitchenette(b, -52.3, 2.06, Math.PI, 1.8, { coffeeOn: true })
  const tvp = staticTV(b, -51.1, 18.3, N)
  b.lamp({ kind: "window", position: tvp, color: [0.72, 0.8, 1.0], intensity: 1.4, range: 4.5, size: 0.25, flicker: 0.6 })
  placeModels(b, "lounge_chair", [
    { position: [-52.2, FLOOR_Y, 15.4], yaw: S + 0.35 },
    { position: [-50.1, FLOOR_Y, 15.6], yaw: S - 0.3 },
  ])
  const lt = workTable(b, -51.1, 16.7, 0, 0.9, 0.55)
  mug(b, -51.3, lt, 16.65)
  ashtray(b, -50.85, lt, 16.8, rnd)
  // Cork board by the lockers: the watch roster, a polaroid, the night-shift notice.
  b.box(M.cork, -47.885, FLOOR_Y + 1.15, 9.05, -47.86, FLOOR_Y + 1.95, 10.25)
  s.doc("roster_operators", [-47.887, FLOOR_Y + 1.55, 9.4], [-1, 0, 0], { pin: "pin" })
  s.doc("polaroid_corridor", [-47.887, FLOOR_Y + 1.7, 9.85], [-1, 0, 0], { pin: "pin", rotation: 0.1 })
  s.doc("notice_nightshift", [-47.887, FLOOR_Y + 1.32, 9.95], [-1, 0, 0], { pin: "tack" })
  wastebasket(b, -53.9, 3.0)
  await pause()

  // ------------------------------------------------------------------ 3-22 manager, computing
  s.rooms.push(room(b, { id: "3-22", name: "Manager, Computing", rect: rect(G[1], -43.25, 10.675, 21.65), floor: M.carpet, lit: "none" }))
  // The strip beside the hall wall (the stair core takes the rest of the bay).
  b.floor(M.carpet, -43.25, 10.675, -42.15, 16.05)
  ceiling(b, -43.25, 10.675, -42.15, 16.05)
  placeModels(b, "office_desk", [{ position: [-45.6, FLOOR_Y, 17.4], yaw: S }])
  chairs.push({ position: [-45.5, FLOOR_Y, 18.3], yaw: N + 0.3, inset: 0.15 })
  stacks.push({ position: [-46.1, FLOOR_Y, 16.2], yaw: S + 0.2 }, { position: [-45.0, FLOOR_Y, 16.15], yaw: S - 0.3 })
  deskLamp(b, -46.3, DESK_TOP, 17.25, S + 0.4, false)
  placeModels(b, "telephone", [{ position: [-44.9, DESK_TOP, 17.3], yaw: S - 0.3, collide: false, blob: 0 }])
  placeModels(b, "filing_cabinet", [-47.2, -46.72].map((x) => ({ position: [x, FLOOR_Y, 10.735 + 0.27] as const, yaw: S })))
  placeModels(b, "coat_rack", [{ position: [-43.7, FLOOR_Y, 11.3], yaw: 0 }])
  b.quad(PLOT, T(-47.735, FLOOR_Y + 1.6, 15.0, Math.PI / 2), 1.4, 1.0, { cast: false })
  s.doc("directory_extensions", [-47.737, FLOOR_Y + 1.5, 17.6], [1, 0, 0], { pin: "tack" })
  s.doc("memo_coffee", [-45.4, DESK_TOP, 17.15], [0, 1, 0], { rotation: 0.3 })
  wastebasket(b, -44.4, 17.9)
  await pause()

  // ------------------------------------------------------------------ 3-24 terminal pool
  s.rooms.push(room(b, { id: "3-24", name: "Terminal pool", rect: rect(G[5], G[9], 1.75, 21.65), floor: "linoleum", lit: "none" }))
  s.rooms.push(room(b, { id: "3-24w", name: "Terminal pool (printing terminals)", rect: rect(-36.15, G[5], 9.675, 21.65), floor: "linoleum", lit: "none" }))
  column(b, G[5], 11.9)
  // The chase wall's pool face gets this room's finish (the service stack tiles it for the WC side).
  wall(b, "z", 9.735, 16.05, -36.0, -35.99, ROOM_BANDS, [], { y0: FLOOR_Y - 0.01, y1: CEIL_Y + 0.02, collide: false })
  const litPool = new Set(["P1N-22", "P1N-21", "P2S-13.5", "P2S-12.5", "P2S-11.5", "P2N-12.5"])
  const block = (tag: string, xs: number[], zc: number) => {
    for (const [row, z, yaw] of [["N", zc - 0.375, 0], ["S", zc + 0.375, Math.PI]] as const)
      for (const x of xs) {
        const top = carrel(b, x, z, yaw)
        const away = row === "N" ? -1 : 1
        const key = `${tag}${row}${x}`
        if (litPool.has(key)) {
          const p = terminal(b, x, top, z + away * -0.02, yaw, true)
          // The CRTs left on throw a green glow the window shows from outside (lighting-state.ts 3-24).
          if (key === "P1N-21" || key === "P2S-12.5" || key === "P2S-13.5") b.lamp({ kind: "window", position: p, color: GREEN, intensity: 3, range: 4, size: 0.12 })
        } else crts.push({ position: [x, top, z + away * 0.05], yaw, collide: false, blob: 0 })
        const r = rnd()
        const cp = [x + (rnd() - 0.5) * 0.3, FLOOR_Y, z + away * (0.85 + rnd() * 0.3)] as const
        if (r < 0.45) chairs.push({ position: cp, yaw: yaw + Math.PI + (rnd() - 0.5) * 0.9, inset: 0.15 })
        else if (r < 0.8) stacks.push({ position: cp, yaw: yaw + Math.PI + (rnd() - 0.5) * 0.6 })
      }
  }
  block("P1", [-25, -24, -23, -22, -21, -20], 5.6)
  block("P2", [-16.5, -15.5, -14.5, -13.5, -12.5, -11.5], 17.5)
  // Printing terminals along the west room's north wall, an acoustic-coupler table, the output pigeonholes, help desk.
  for (const x of [-34.6, -33.2, -31.8]) teleprinter(b, x, 10.12, S)
  stacks.push({ position: [-33.3, FLOOR_Y, 11.1], yaw: N + 0.3 })
  const ct = workTable(b, -31.0, 15.6, 0, 1.6, 0.76)
  placeModels(b, "telephone", [{ position: [-31.4, ct + 0.05, 15.6], yaw: N, collide: false, blob: 0 }])
  b.rbox(M.beige, T(-31.4, ct, 15.6), 0.3, 0.06, 0.16, 0.01, 0, 0.03, 0)
  for (const dx of [-0.08, 0.08]) b.cyl(M.rubber, T(-31.4 + dx, ct + 0.06, 15.6), 0.045, 0.04, 0.04, 12, { open: true })
  crts.push({ position: [-30.55, ct, 15.65], yaw: N, collide: false, blob: 0 })
  stacks.push({ position: [-30.7, FLOOR_Y, 14.7], yaw: S + 0.1 })
  pigeonholes(b, -4.85, 4.4, W, 8, 4, rnd)
  const hc = counter(b, -7.6, 14.2, W, 2.2)
  s.doc("card_extensions", [-7.7, hc, 14.4], [0, 1, 0], { rotation: 0.4 })
  placeModels(b, "telephone", [{ position: [-7.5, hc, 13.6], yaw: W + 0.3, collide: false, blob: 0 }])
  chairs.push({ position: [-6.9, FLOOR_Y, 14.0], yaw: W + 0.4, inset: 0.15 })
  printoutStack(b, -23.0, FLOOR_Y + 0.73, 5.3, 0.2, 0.04)
  // Output distribution: the pool's own band printer and the sorting tables where jobs wait to be collected.
  linePrinter(b, -22.5, 14.0, N, rnd)
  const ot = workTable(b, -22.6, 18.6, 0, 2.4, 0.76)
  for (let k = 0; k < 6; k++) printoutStack(b, -23.5 + k * 0.36, ot, 18.6 + (rnd() - 0.5) * 0.15, (rnd() - 0.5) * 0.3, 0.02 + rnd() * 0.1)
  stacks.push({ position: [-21.4, FLOOR_Y, 17.7], yaw: S + 0.5 })
  s.doc("printout_greenbar", [-12.0, FLOOR_Y + 0.73, 17.85], [0, 1, 0], { rotation: Math.PI + 0.2 })
  for (const [x, z] of [[-26.8, 3.2], [-9.6, 9.5], [-17.6, 19.8]]) wastebasket(b, x, z)
  await pause()

  // ------------------------------------------------------------------ 3-25 programmers' wing: walls of the racetrack
  partition(b, {
    axis: "z",
    at: G[9],
    from: 1.75,
    to: 21.65,
    finish: [ROOM_BANDS, ROOM_BANDS],
    openings: [{ kind: "door", at: 11.15, side: "b", door: { id: "3-24e", state: "closed", room: "3-24", sign: { number: "3-24", label: "TERMINALS" } } }],
  })
  partition(b, {
    axis: "x",
    at: 10.375,
    from: G[9],
    to: G[15],
    thickness: 0.15,
    finish: [ROOM_BANDS, ROOM_BANDS],
    openings: [
      { kind: "gap", from: 0.86, to: 2.64 },
      { kind: "door", at: 9.5, side: "b", door: { id: "3-25p2", state: "open", room: "3-25p", sign: { number: "3-25P", label: "PRINT ROOM" } } },
      { kind: "door", at: 20.0, side: "b", door: { id: "3-25l2", state: "closed", room: "3-25l", sign: { number: "3-25L", label: "LIBRARY" } } },
      { kind: "cased", from: 22.75, to: 27.45 },
    ],
  })
  const offices: [number, number, number, DoorState][] = [
    [G[9], G[10], -1.9, "closed"],
    [G[10], G[11], 3.5, "open"],
    [G[11], G[12], 8.9, "closed"],
    [G[12], G[13], 14.3, "closed"],
    [G[13], G[14], 19.7, "open"],
    [G[14], G[15], 25.1, "closed"],
  ]
  partition(b, {
    axis: "x",
    at: 11.925,
    from: G[9],
    to: G[15],
    thickness: 0.15,
    finish: [ROOM_BANDS, ROOM_BANDS],
    openings: offices.map(([, , at, state], i) => ({ kind: "door" as const, at, side: "a" as const, door: { id: `3-25-${i + 1}`, state, room: `3-25-${i + 1}`, leaf: "veneer" as const, sign: { number: `3-${31 + i}`, label: "OFFICE" } } })),
  })
  for (const x of [G[10], G[11], G[12], G[13], G[14]]) partition(b, { axis: "z", at: x, from: 11.925, to: 21.65, finish: [ROOM_BANDS, ROOM_BANDS] })
  partition(b, {
    axis: "z",
    at: G[15],
    from: 7.875,
    to: 21.65,
    finish: [ROOM_BANDS, ROOM_BANDS],
    openings: [{ kind: "door", at: 11.15, side: "a", door: { id: "3-25c", state: "closed", room: "3-25c", leaf: "veneer", sign: { number: "3-37", label: "CHIEF PROGRAMMER" } } }],
  })
  partition(b, { axis: "z", at: 0.8, from: 1.75, to: 10.3, finish: [ROOM_BANDS, ROOM_BANDS], openings: [{ kind: "door", at: 5.5, side: "b", door: { id: "3-25f", state: "janitor", room: "3-25f", sign: { number: "3-25F", label: "FORMS" } } }] })
  partition(b, { axis: "z", at: 2.7, from: 1.75, to: 10.3, finish: [ROOM_BANDS, ROOM_BANDS] })
  partition(b, { axis: "z", at: G[12], from: 1.75, to: 10.3, finish: [ROOM_BANDS, ROOM_BANDS] })
  partition(b, { axis: "z", at: G[14], from: 1.75, to: 10.3, finish: [ROOM_BANDS, ROOM_BANDS] })
  partition(b, { axis: "x", at: 7.875, from: G[14], to: G[16], thickness: 0.15, finish: [ROOM_BANDS, ROOM_BANDS] })
  await pause()

  // Corridors of the racetrack: the cross corridor from the spine and the inner corridor behind the offices.
  s.rooms.push(room(b, { id: "3-25x", name: "Cross corridor", rect: rect(0.8, 2.7, 1.75, 10.375), floor: "linoleum", lit: [[1.8, 4.8]], windows: false, columns: false }))
  s.rooms.push(room(b, { id: "3-25i", name: "Inner corridor", rect: rect(G[9], G[15], 10.375, 11.925), floor: "linoleum", troffers: false, windows: false, columns: false }))
  for (const x of [-2.7, 1.7, 5.9, 10.1, 14.3, 18.5, 22.7, 26.4]) {
    const on = x === 1.7
    const z = 11.15
    b.box(M.housing, x - 0.62, CEIL_Y - 0.085, z - 0.13, x + 0.62, CEIL_Y - 0.004, z + 0.13, { cast: false })
    b.quad(on ? PANEL_ON : M.diffuserOff, T(x, CEIL_Y - 0.09, z, Math.PI / 2, Math.PI / 2), 0.22, 1.2, { cast: false })
    if (on) b.lamp({ kind: "fluorescent", position: [x, CEIL_Y - 0.2, z], direction: [0, -1, 0], color: TUBE, intensity: 4, range: 6, angle: 1.3, penumbra: 0.7, size: 1.0 })
  }
  s.doc("map_evac_3", [-4.535, FLOOR_Y + 1.55, 11.15 + 0.85], [1, 0, 0], { pin: "tape" })

  // Forms & tape store (janitor key).
  s.rooms.push(room(b, { id: "3-25f", name: "Forms & tape store", rect: rect(G[9], 0.8, 1.75, 10.375), floor: "linoleum", lit: "none" }))
  const [sw, , sd] = MODELS.steel_shelves.size
  placeModels(b, "steel_shelves", [
    { position: [-4.54 + sd / 2, FLOOR_Y, 3.6], yaw: E, inset: 0.03 },
    { position: [-4.54 + sd / 2, FLOOR_Y, 3.6 + sw + 0.05], yaw: E, inset: 0.03 },
    { position: [-1.8, FLOOR_Y, 10.3 - sd / 2 - 0.04], yaw: N, inset: 0.03 },
  ])
  placeModels(b, "cardboard_box", [
    { position: [-0.2, FLOOR_Y, 2.4], yaw: 0.2 },
    { position: [-0.25, FLOOR_Y + MODELS.cardboard_box.size[1], 2.45], yaw: -0.1, collide: false, blob: 0 },
    { position: [-0.9, FLOOR_Y, 2.4], yaw: 1.5 },
  ])
  await pause()

  // Print room (two band printers, a burster, paper stock).
  s.rooms.push(room(b, { id: "3-25p", name: "Print room", rect: rect(2.7, G[12], 1.75, 10.375), floor: "linoleum", lit: "none" }))
  linePrinter(b, 5.4, 6.4, N, rnd)
  linePrinter(b, 8.6, 6.4, N, rnd)
  decollator(b, 3.6, 9.4, S)
  placeModels(b, "pallet", [{ position: [10.7, FLOOR_Y, 3.0], yaw: 0, collide: true }])
  placeModels(b, "cardboard_box", [0, 1, 2, 3].map((k) => ({ position: [10.45 + (k % 2) * 0.45, FLOOR_Y + 0.216 + Math.floor(k / 2) * MODELS.cardboard_box.size[1], 2.85], yaw: (rnd() - 0.5) * 0.2, collide: k < 2, blob: 0 })))
  for (let k = 0; k < 3; k++) printoutStack(b, 10.3 + k * 0.12, FLOOR_Y + 0.216 + 0.684, 3.25, rnd(), 0.05)
  wastebasket(b, 3.2, 2.3)
  await pause()

  // Documentation library + help desk (open to the spine).
  s.rooms.push(room(b, { id: "3-25l", name: "Documentation library", rect: rect(G[12], G[14], 1.75, 10.375), floor: "linoleum", lit: "none" }))
  const hd = counter(b, 13.9, 3.2, 0, 2.2)
  placeModels(b, "telephone", [{ position: [13.3, hd, 3.25], yaw: N + 0.2, collide: false, blob: 0 }])
  s.doc("directory_extensions", [14.3, hd, 3.15], [0, 1, 0], { rotation: -0.15 })
  chairs.push({ position: [13.8, FLOOR_Y, 4.1], yaw: N + 0.1, inset: 0.15 })
  cardCatalogue(b, 17.2, 2.12, Math.PI)
  placeModels(b, "steel_shelves", [
    { position: [17.0, FLOOR_Y, 6.3], yaw: S, inset: 0.03 },
    { position: [19.4, FLOOR_Y, 6.3], yaw: S, inset: 0.03 },
    { position: [17.0, FLOOR_Y, 8.4], yaw: N, inset: 0.03 },
    { position: [19.4, FLOOR_Y, 8.4], yaw: N, inset: 0.03 },
  ])
  const rt = workTable(b, 13.3, 7.4, Math.PI / 2, 1.8, 0.9)
  stacks.push({ position: [12.6, FLOOR_Y, 7.0], yaw: E + 0.2 }, { position: [14.0, FLOOR_Y, 7.9], yaw: W - 0.3 })
  printoutStack(b, 13.3, rt, 7.0, 0.3, 0.07)
  await pause()

  // Supplies (janitor key) and the coffee nook off the inner corridor.
  s.rooms.push(room(b, { id: "3-25s", name: "Supplies", rect: rect(G[14], G[16], 1.75, 7.875), floor: "linoleum", lit: "none" }))
  const [rw, , rd] = MODELS.metal_rack.size
  placeModels(b, "metal_rack", [23.1, 24.05, 25.0, 33.2].map((x) => ({ position: [x, FLOOR_Y, 7.8 - rd / 2 - 0.03] as const, yaw: N })))
  void rw
  placeModels(b, "pallet", [{ position: [27.6, FLOOR_Y, 4.2], yaw: 0.1 }])
  placeModels(b, "cardboard_box", [0, 1, 2, 3, 4].map((k) => ({ position: [27.35 + (k % 2) * 0.45, FLOOR_Y + 0.216 + Math.floor(k / 2) * MODELS.cardboard_box.size[1], 4.2], yaw: (rnd() - 0.5) * 0.3, collide: k < 2, blob: 0 })))
  s.rooms.push(room(b, { id: "3-25n", name: "Coffee nook", rect: rect(G[14], G[15], 7.875, 10.375), floor: "linoleum", lit: "none", columns: false }))
  kitchenette(b, 25.1, 8.26, Math.PI, 2.4, { coffeeOn: true })
  s.doc("memo_coffee", [26.7, FLOOR_Y + 1.5, 7.953], [0, 0, 1], { pin: "pin" })
  await pause()

  // Perimeter offices on the bays, two desks each.
  offices.forEach(([x0, x1], i) => {
    const id = `3-25-${i + 1}`
    s.rooms.push(room(b, { id, name: "Programmer's office", rect: rect(x0, x1, 11.925, 21.65), floor: M.carpet, lit: "none" }))
    const cx = (x0 + x1) / 2 + 0.5
    placeModels(b, "office_desk", [{ position: [cx, FLOOR_Y, 17.6], yaw: S }])
    chairs.push({ position: [cx + (rnd() - 0.5) * 0.4, FLOOR_Y, 18.45 + rnd() * 0.3], yaw: N + (rnd() - 0.5) * 1.0, inset: 0.15 })
    crts.push({ position: [cx - 0.45, DESK_TOP, 17.45], yaw: S + 0.15, collide: false, blob: 0 })
    if (rnd() < 0.7) printoutStack(b, cx + 0.5, DESK_TOP, 17.5, rnd(), 0.03 + rnd() * 0.08)
    const st = workTable(b, x0 + 0.5, 14.2, Math.PI / 2, 1.6, 0.76)
    crts.push({ position: [x0 + 0.45, st, 14.0], yaw: E, collide: false, blob: 0 })
    stacks.push({ position: [x0 + 1.3, FLOOR_Y, 14.3], yaw: W + (rnd() - 0.5) * 0.8 })
    placeModels(b, "filing_cabinet", [{ position: [x1 - 0.4, FLOOR_Y, 12.0 + 0.27], yaw: S }])
    wastebasket(b, cx + 1.2, 18.4)
    wallPapers(b, x1 - 0.065, FLOOR_Y + 1.5, 16.5, -Math.PI / 2, 1.4, 0.7, rnd, 3 + Math.floor(rnd() * 4))
  })
  await pause()

  // Chief programmer's corner office: the lit SE corner (desk lamp + one troffer), a small meeting table.
  s.rooms.push(room(b, { id: "3-25c", name: "Chief programmer", rect: rect(G[15], G[16], 7.875, 21.65), floor: M.carpet, lit: [[31.2, 18.6]] }))
  placeModels(b, "office_desk", [{ position: [31.2, FLOOR_Y, 18.9], yaw: S }])
  chairs.push({ position: [31.3, FLOOR_Y, 19.75], yaw: N + 0.4, inset: 0.15 })
  deskLamp(b, 30.5, DESK_TOP, 18.75, S + 0.5, true)
  const ft = terminal(b, 31.9, DESK_TOP, 18.7, S + 0.2, true)
  void ft
  s.doc("sticky_marge", [31.4, DESK_TOP, 19.0], [0, 1, 0], { rotation: 0.6 })
  s.doc("printout_greenbar", [31.0, DESK_TOP, 19.05], [0, 1, 0], { rotation: 0.1 })
  mug(b, 32.4, DESK_TOP, 19.1)
  conferenceTable(b, 31.4, 10.6, 0, 4, { length: 2.0 })
  placeModels(b, "steel_shelves", [{ position: [27.86 + MODELS.steel_shelves.size[2] / 2 + 0.02, FLOOR_Y, 15.4], yaw: E, inset: 0.03 }])
  placeModels(b, "filing_cabinet", [33.2, 33.7].map((x) => ({ position: [x, FLOOR_Y, 7.95 + 0.27] as const, yaw: S })))
  placeModels(b, "coat_rack", [{ position: [28.4, FLOOR_Y, 13.2], yaw: 0.4 }])
  wallPapers(b, 34.6, FLOOR_Y + 1.6, 20.4, -Math.PI / 2, 0.8, 0.5, rnd, 2)
  wastebasket(b, 32.6, 19.6)

  placeModels(b, "office_chair", chairs)
  placeModels(b, "stack_chair", stacks)
  placeModels(b, "crt_terminal", crts)
}
