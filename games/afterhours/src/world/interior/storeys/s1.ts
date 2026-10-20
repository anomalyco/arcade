import * as THREE from "three/webgpu"
import { abs, float, floor, fract, hash, mix, positionWorld, vec2, vec3 } from "three/tsl"
import type { ModelName } from "../../../render/models"
import {
  type Builder,
  type POpening,
  type Prop,
  type RoomHandle,
  type StoreyContext,
  type StoreyHandle,
  FLOOR_Y,
  G,
  M,
  PLANT_BANDS,
  ROOM_BANDS,
  STYLES,
  SHELL,
  T,
  aaFade,
  ceiling,
  chalkboard,
  conferenceTable,
  cubiclePod,
  deskLamp,
  bankerLamp,
  kitchenette,
  partition,
  placeModels,
  rect,
  riserW1,
  room,
  serviceStack,
  spine,
  underBinTube,
  wastebasket,
  windowsOn,
  yawToward,
} from "../api"
import { Paper } from "./s1/docs"
import {
  P,
  ashtray,
  avCart,
  blotter,
  bookTruck,
  bookcase,
  briefcaseOpen,
  cardCatalogue,
  cardFile,
  coatOnChair,
  copier,
  crtTerminal,
  corkBoard,
  credenza,
  fillShelf,
  SHELF_DECKS,
  ficheReader,
  flipChart,
  inOutBoard,
  overheadProjector,
  periodicalsRack,
  phoneOffHook,
  planter,
  printerHood,
  projectionScreen,
  pt,
  rng,
  securityContainer,
  slideProjector,
  stepStool,
  table,
  typewriter,
  vaultHardware,
  verticalBlinds,
} from "./s1/furniture"

/*
 * Storey 1 — Program Administration (docs/building-program.md §2, storey 1). Carpet, beige vinyl, veneer doors,
 * louvred troffers. North of the spine: Records Center with its compact shelving and the two-person-rule vault, glass
 * Conference A, the Contracts suite (reception + four private offices joined by internal doors), coffee & copy, the
 * Personnel & Payroll bullpen behind a clerestory with the supervisor's fishbowl, the technical library. South: the
 * service stack, word processing, supply store, the open-plan Program Office (the south spine wall replaced by a
 * fabric panel run), glass Conference B and the AV store/kitchenette. At 3 a.m. only a few lights burn: one records
 * aisle, the contracts reception troffer, the Chief's desk lamp, the coffee-counter tube, the fishbowl lamp, a banker's
 * lamp and the fiche reader, one word-processing CRT, two cubicle task tubes and a desk lamp, Conference B.
 */

const S1 = STYLES[1]!
const OFFICE = S1
const W = 0.12
const DESK_TOP = FLOOR_Y + 0.787
const CUBE_TOP = FLOOR_Y + 0.735
/** Models face −Z; chairs face the way the sitter looks. */
const face = (dx: number, dz: number) => yawToward(dx, dz)

/** Broadloom for the open office and private offices: a cut-pile rust-brown carpet (the "carpet colour change" that
 *  marks the open office's edge against the corridor's carpet tiles); one shader. */
const broadloom = (() => {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.97, metalness: 0 })
  const p = positionWorld.xz
  const fibre = hash(floor(p.mul(260)).dot(vec2(1, 157)))
  const fine = mix(float(0.5), fibre, aaFade(positionWorld.x.mul(260)))
  const tuft = hash(floor(p.mul(37)).dot(vec2(13, 71)))
  const tufts = mix(float(0.5), tuft, aaFade(positionWorld.x.mul(37)))
  const patch = hash(floor(p.mul(0.7)).dot(vec2(3, 29))).mul(0.06)
  // Faint traffic wear along the cubicle aisles: a slow cosine field, kept subtle.
  const wear = abs(fract(p.x.mul(0.091)).sub(0.5)).mul(0.08)
  const base = vec3(0.118, 0.07, 0.048)
  m.colorNode = base.mul(float(0.86).add(fine.mul(0.14)).add(tufts.mul(0.1)).sub(patch).add(wear))
  m.name = "s1_broadloom"
  return m
})()

/** Glazed partition material for internal glass rooms is the kit's; vertical blinds are local. */

export async function build(b: Builder, { pause }: StoreyContext): Promise<StoreyHandle> {
  const paper = new Paper()
  const batch = new Map<ModelName, Prop[]>()
  const put = (name: ModelName, p: Prop) => {
    let l = batch.get(name)
    if (!l) batch.set(name, (l = []))
    l.push(p)
  }
  const handles: RoomHandle[] = []
  const rnd = rng(1984)

  // ---------------------------------------------------------------------------------------------- spine & services
  const svc = serviceStack(b)
  riserW1(b)
  const OPEN_X0 = G[5] + 0.06 // open office edge (east face of WC-W's wall)
  const OPEN_X1 = G[14] - 0.06
  const north: POpening[] = [
    { kind: "door", at: -46.0, side: "b", door: { id: "1-01", state: "closed", room: "1-01", leaf: "veneer", dutch: true, sign: { number: "1-01", label: "RECORDS" } } },
    { kind: "glazed", from: -36.85, to: -28.8, sill: 0.9, head: 2.3, mullion: 1.35 },
    { kind: "door", at: -28.2, side: "b", door: { id: "1-02", state: "open", room: "1-02", leaf: "glass", sign: { number: "1-02", label: "CONFERENCE" } } },
    { kind: "glazed", from: -27.6, to: -26.35, sill: 0.9, head: 2.3 },
    { kind: "door", at: -21.5, side: "b", door: { id: "1-03", state: "closed", room: "1-03", leaf: "veneer", sign: { number: "1-03", label: "CONTRACTS" } } },
    { kind: "cased", from: -14.6, to: -11.0 },
    { kind: "clerestory", from: -9.85, to: -1.1, sill: 1.0, head: 2.1 },
    { kind: "door", at: 0, side: "b", door: { id: "1-09", state: "open", room: "1-09", leaf: "veneer", double: true, sign: { number: "1-09", label: "PERSONNEL" } } },
    { kind: "clerestory", from: 1.1, to: 16.85, sill: 1.0, head: 2.1 },
    { kind: "door", at: 19.0, side: "b", door: { id: "1-10", state: "closed", room: "1-10", leaf: "glass", sign: { number: "1-10", label: "LIBRARY" } } },
    { kind: "glazed", from: 19.7, to: 22.6, sill: 0.9, head: 2.3 },
  ]
  const south: POpening[] = [
    ...svc.spineOpenings,
    { kind: "door", at: -51.0, side: "a", door: { id: "1-20", state: "closed", room: "1-20", leaf: "veneer", sign: { number: "1-20", label: "WORD PROCESSING" } } },
    { kind: "gap", from: OPEN_X0, to: OPEN_X1 },
    { kind: "door", at: 28.6, side: "a", door: { id: "1-26", state: "closed", room: "1-26", leaf: "veneer", sign: { number: "1-26", label: "AV" } } },
  ]
  const sp = spine(b, { north, south, nightCircuit: 3, northRoomFinish: ROOM_BANDS, southRoomFinish: ROOM_BANDS })
  // Ceiling over the missing south spine wall, between the corridor's ceiling and the open office's.
  ceiling(b, OPEN_X0, 1.6, OPEN_X1, 1.75)
  // Door plates (readable) beside the service doors on this storey and an evacuation map by the hall.
  paper.wall("plate_el1", -45.0 - 0.68, FLOOR_Y + 1.39, 1.6 - 0.019, 0, -1, { pin: "none", offset: 0.003 })
  paper.wall("plate_jc", -32.0 - 0.68, FLOOR_Y + 1.39, 1.6 - 0.019, 0, -1, { pin: "none", offset: 0.003 })
  paper.wall("map_evac_1", -43.4, FLOOR_Y + 1.5, -1.6, 0, 1, { pin: "tape" })
  paper.wall("notice_firedoors", -52.6, FLOOR_Y + 1.55, -1.6, 0, 1, { pin: "tape" })
  await pause()

  // ---------------------------------------------------------------------------------------------- 1-01 Records + vault
  const VX1 = -48.55 // vault east wall centre (0.3 m block); the vault takes the NW corner incl. one window each face
  const VZ1 = -14.25
  partition(b, { axis: "x", at: VZ1, from: SHELL.x0, to: VX1 + 0.15, thickness: 0.3, finish: [PLANT_BANDS, ROOM_BANDS] })
  const vaultIds = partition(b, {
    axis: "z",
    at: VX1,
    from: SHELL.z0,
    to: VZ1 - 0.15,
    thickness: 0.3,
    finish: [PLANT_BANDS, ROOM_BANDS],
    openings: [{ kind: "door", at: -17.4, side: "b", door: { id: "1-01v", state: "locked", room: "1-01v", leaf: P.vault, glass: "none", sign: { number: "1-01v", label: "VAULT" } } }],
  })
  partition(b, { axis: "z", at: G[3], from: SHELL.z0, to: -1.75, finish: [ROOM_BANDS, OFFICE] })
  const vault = room(b, { id: "1-01v", name: "Classified vault", rect: rect(SHELL.x0, VX1 - 0.15, SHELL.z0, VZ1 - 0.15), floor: "concrete_floor_dry", lit: "none", troffers: { dx: 2.4, dz: 3.6 }, windows: false, columns: false })
  // The vault's two facade windows were blocked with grouted block when it was built.
  for (const w of vault.windows) {
    if (w.face === "north") b.box("concrete_block", w.u0, FLOOR_Y + w.sill, SHELL.z0 + 0.004, w.u1, FLOOR_Y + w.head, -21.612, { skip: "z" })
    else b.box("concrete_block", SHELL.x0 + 0.004, FLOOR_Y + w.sill, w.u0, -54.612, FLOOR_Y + w.head, w.u1, { skip: "x" })
  }
  for (const [x, z, yaw] of [
    [-53.9, -21.2, face(0, 1)],
    [-53.2, -21.2, face(0, 1)],
    [-52.5, -21.2, face(0, 1)],
    [-54.25, -18.6, face(1, 0)],
    [-54.25, -17.9, face(1, 0)],
  ] as const)
    securityContainer(b, x, z, yaw)
  table(b, -51.0, -17.0, 0, 1.2, 0.7, { mat: M.steel, legs: M.darkSteel })
  paper.flat("memo_carbon_inventory", -51.1, FLOOR_Y + 0.742, -17.0, 0.2)
  const leaf = b.group.getObjectByName(vaultIds[0]!)
  if (leaf) vaultHardware(leaf, 0.92 - 0.006)
  paper.wall("plate_vault", VX1 + 0.15 + 0.003, FLOOR_Y + 1.62, -17.4 - 0.75, 1, 0, { pin: "none" })

  const recMain = rect(VX1 + 0.15, G[3], SHELL.z0, -1.75)
  const recWest = rect(SHELL.x0, VX1 + 0.15, VZ1 + 0.15, -1.75)
  const openAisle = -44.55
  handles.push(
    room(b, { id: "1-01", name: "Records Center", rect: recMain, floor: M.carpet, lit: [[openAisle, -19.2], [openAisle, -15.6], [openAisle, -12.0]], troffers: { louvre: true }, windows: { blinds: "closed", radiators: "none" } }),
    room(b, { id: "1-01w", name: "Records Center (filing)", rect: recWest, floor: M.carpet, lit: "none", troffers: { louvre: true }, windows: { blinds: "closed", radiators: "convector" } }),
  )
  // Compact (mobile) shelving: six carriages on floor rails, one aisle cranked open; two static rows beyond.
  const carriages = [-47.0, -46.24, -45.48, -43.62, -42.86, -42.1]
  const unitZ = [-20.2, -17.83, -15.46, -13.09, -10.72]
  for (const x of carriages) {
    for (const z of unitZ) {
      put("steel_shelves", { position: [x, FLOOR_Y + 0.03, z], yaw: Math.PI / 2, inset: 0.03 })
      fillShelf(b, x, z, rnd, { y0: FLOOR_Y + 0.03, decks: SHELF_DECKS, gap: 0.06 })
    }
    // Carriage base and the end panel with its three-spoke handwheel facing the cross aisle.
    b.box(M.darkSteel, x - 0.37, FLOOR_Y, -21.4, x + 0.37, FLOOR_Y + 0.03, -9.5)
    b.rbox(M.cabinet, T(x, FLOOR_Y, -9.47), 0.74, 2.3, 0.04, 0.008, 0, 1.15, 0)
    const hub: [number, number, number] = [x, FLOOR_Y + 1.1, -9.42]
    b.cyl(M.steel, T(hub[0], hub[1], hub[2], 0, Math.PI / 2), 0.035, 0.035, 0.06, 14)
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2 + (x * 3) % 1
      b.rod(M.steel, hub, [hub[0] + Math.cos(a) * 0.17, hub[1] + Math.sin(a) * 0.17, hub[2] - 0.03], 0.008, 6)
      b.cyl(M.rubber, T(hub[0] + Math.cos(a) * 0.17, hub[1] + Math.sin(a) * 0.17, hub[2] - 0.05, 0, Math.PI / 2), 0.014, 0.014, 0.05, 8)
    }
    b.box(M.paper, x - 0.12, FLOOR_Y + 1.55, -9.452, x + 0.12, FLOOR_Y + 1.7, -9.448, { cast: false })
  }
  for (const z of [-20.6, -15.0, -10.0]) b.box(M.steel, -47.5, FLOOR_Y, z - 0.03, -41.6, FLOOR_Y + 0.008, z + 0.03, { cast: false })
  for (const x of [-40.0, -38.2])
    for (const z of unitZ) {
      put("steel_shelves", { position: [x, FLOOR_Y, z], yaw: Math.PI / 2, inset: 0.03 })
      fillShelf(b, x, z, rnd, { decks: SHELF_DECKS.slice(0, 3), gap: 0.15 })
    }
  // Filing: twelve cabinets along the vault wall, eight along the corridor wall (one of each set pulled open).
  for (let k = 0; k < 12; k++) {
    const x = SHELL.x0 + 0.35 + k * 0.45
    if (x > VX1 + 0.1) break
    put(k === 7 ? "filing_cabinet_open" : "filing_cabinet", { position: [x, FLOOR_Y, VZ1 + 0.15 + (k === 7 ? 0.52 : 0.27)], yaw: face(0, 1), inset: 0.02 })
  }
  for (let k = 0; k < 8; k++) {
    const x = SHELL.x0 + 0.5 + k * 0.45
    put(k === 3 ? "filing_cabinet_open" : "filing_cabinet", { position: [x, FLOOR_Y, -1.75 - (k === 3 ? 0.52 : 0.27)], yaw: face(0, -1), inset: 0.02 })
  }
  // Counter area inside the Dutch door: sorting table with pigeonholes, card catalogue, book trucks.
  const sortTop = table(b, -51.6, -8.6, 0, 2.2, 0.9)
  for (let k = 0; k < 6; k++) b.box(M.veneer, -52.6 + k * 0.4, sortTop, -9.02, -52.58 + k * 0.4, sortTop + 0.42, -8.78)
  b.box(M.veneer, -52.62, sortTop + 0.42, -9.04, -50.58, sortTop + 0.44, -8.76)
  b.box(M.veneerDark, -52.62, sortTop, -9.06, -50.58, sortTop + 0.44, -9.04)
  for (let k = 0; k < 12; k++) b.box(k % 3 ? M.paper : P.oak, -52.55 + (k % 5) * 0.4, sortTop + 0.01, -9.0, -52.3 + (k % 5) * 0.4, sortTop + 0.03 + (k % 3) * 0.04, -8.8, { cast: false })
  paper.flat("envelope_interoffice", -51.2, sortTop, -8.4, 0.3)
  paper.flat("form_requisition", -50.8, sortTop + 0.0015, -8.5, -0.5)
  cardCatalogue(b, -37.06 - 0.25, -5.0, face(-1, 0), rnd)
  cardCatalogue(b, -37.06 - 0.25, -6.0, face(-1, 0), rnd)
  bookTruck(b, -40.6, -4.4, 0.4, rnd)
  bookTruck(b, -49.2, -5.0, -1.2, rnd)
  put("stack_chair", { position: [-51.2, FLOOR_Y, -7.7], yaw: face(0, -1) + 0.4 })
  // Vignette: the open aisle — step stool, a box pulled and spilt, the roster on the counter ledge.
  stepStool(b, openAisle, -16.2, 0)
  put("cardboard_box", { position: [openAisle + 0.05, FLOOR_Y, -14.4], yaw: 0.4, collide: false, blob: 0, tilt: new THREE.Euler(0.0, 0, 1.45) })
  put("cardboard_box", { position: [openAisle - 0.1, FLOOR_Y, -18.9], yaw: 1.2 })
  paper.flat("roster_field_team", -46.0 + 0.84, FLOOR_Y + 1.066, -1.675 + 0.075 + 0.14, 0.12)
  for (const [id, dx, dz, t] of [
    ["envelope_interoffice", 0.1, -13.6, 0.7],
    ["memo_carbon_inventory", -0.2, -13.1, -0.4],
    ["envelope_interoffice", 0.15, -12.7, 2.2],
    ["roster_operators", -0.1, -12.2, 1.1],
    ["memo_signin", 0.2, -13.9, 2.9],
  ] as const)
    paper.flat(id, openAisle + dx, FLOOR_Y + 0.002, dz, t)
  for (const [x, z] of [[-41.0, -5.4], [-39.9, -2.6]] as const) wastebasket(b, x, z)
  put("wall_clock", { position: [-46.0, FLOOR_Y + 2.25, -1.825 - 0.03], yaw: face(0, -1), collide: false, blob: 0 })
  await pause()

  // ---------------------------------------------------------------------------------------------- 1-02 Conference A
  const ZW = -11.925 // zone wall centre line
  partition(b, { axis: "z", at: G[5], from: SHELL.z0, to: -1.75, finish: [OFFICE, OFFICE], openings: [{ kind: "door", at: -13.6, side: "b", door: { id: "1-05b", state: "closed", room: "1-05", leaf: "veneer" } }] })
  partition(b, { axis: "x", at: ZW, from: G[3] + 0.06, to: G[7] - 0.06, finish: [OFFICE, OFFICE], openings: [
    { kind: "door", at: -22.0, side: "b", door: { id: "1-06", state: "closed", room: "1-06", leaf: "veneer", sign: { number: "1-06" } } },
    { kind: "door", at: -16.6, side: "b", door: { id: "1-07", state: "open", room: "1-07", leaf: "veneer", sign: { number: "1-07", label: "CHIEF" } } },
  ] })
  const confA = room(b, { id: "1-02", name: "Conference A", rect: rect(G[3], G[5], ZW, -1.75), floor: M.carpet, troffers: { louvre: true } })
  handles.push(confA)
  conferenceTable(b, -31.6, -7.4, 0, 14)
  overheadProjector(b, -34.0, FLOOR_Y + 0.765, -7.4, face(1, 0))
  for (let k = 0; k < 4; k++) ashtray(b, -33.6 + k * 1.3, FLOOR_Y + 0.765, -7.4 + (k % 2 ? 0.25 : -0.25), rnd, k + 1)
  paper.flat("memo_coffee", -30.2, FLOOR_Y + 0.7665, -7.0, 0.6)
  chalkboard(b, G[3] + 0.06 + 0.03, -7.2, face(1, 0), 3.0, "chalk", "chalkboard_agenda")
  projectionScreen(b, G[3] + 0.35, -7.2, face(1, 0), 2.2, 1.0)
  put("wall_clock", { position: [G[5] - 0.06 - 0.025, FLOOR_Y + 2.15, -7.4], yaw: face(-1, 0), collide: false, blob: 0 })
  verticalBlinds(b, "x", -1.84, -36.8, -28.85, rnd, { open: 1.1 })
  verticalBlinds(b, "x", -1.84, -27.55, -26.4, rnd, { open: 0.25 })
  credenza(b, -31.6, ZW + 0.06 + 0.25, face(0, 1), 2.4)
  paper.wall("calendar_oct84", G[5] - 0.063, FLOOR_Y + 1.6, -4.0, -1, 0, { pin: "tack" })
  await pause()

  // ---------------------------------------------------------------------------------------------- 1-03..07 Contracts
  partition(b, { axis: "z", at: G[4], from: SHELL.z0, to: ZW - 0.06, finish: [OFFICE, OFFICE], openings: [{ kind: "door", at: -13.6, side: "b", door: { id: "1-04", state: "closed", room: "1-04", leaf: "veneer", sign: { number: "1-04" } } }] })
  partition(b, { axis: "z", at: G[6], from: SHELL.z0, to: ZW - 0.06, finish: [OFFICE, OFFICE] })
  partition(b, { axis: "z", at: G[7], from: SHELL.z0, to: -1.75, finish: [OFFICE, ROOM_BANDS] })
  const reception = room(b, { id: "1-03", name: "Contracts reception", rect: rect(G[5], G[7], ZW, -1.75), floor: M.carpet, lit: [[-20.8, -6.6]], troffers: { louvre: true } })
  handles.push(reception)
  for (const [x, i] of [[-23.4, 0], [-18.2, 1]] as const) {
    const z = -7.6
    put("office_desk", { position: [x, FLOOR_Y, z], yaw: face(0, -1) })
    put("office_chair", { position: [x + 0.2, FLOOR_Y, z - 0.85], yaw: face(0, 1) + (i ? 0.5 : -0.3), inset: 0.15 })
    const tp = typewriter(b, x - 0.35, DESK_TOP, z - 0.12, face(0, -1), { tan: i === 1 })
    if (i === 0) paper.add({ id: "form_requisition", position: tp.position, normal: tp.normal, pin: "none", curl: 0.2 })
    put("telephone", { position: [x + 0.65, DESK_TOP, z - 0.05], yaw: face(0, -1) + 0.3, collide: false, blob: 0 })
    cardFile(b, x + 0.45, DESK_TOP, z + 0.25, face(0, -1))
    paper.flat(i ? "directory_extensions" : "memo_signin", x + 0.2, DESK_TOP, z + 0.15, 0.2 - i * 0.4)
    wastebasket(b, x + 0.75, z - 0.75)
  }
  for (let k = 0; k < 4; k++) put("filing_cabinet", { position: [G[5] + 0.06 + 0.26, FLOOR_Y, -9.6 + k * 0.46], yaw: face(1, 0), inset: 0.02 })
  put("coat_rack", { position: [-16.1, FLOOR_Y, -2.4], yaw: 0.4 })
  for (const x of [-25.4, -24.7]) put("stack_chair", { position: [x, FLOOR_Y, -2.35], yaw: face(0, -1) })
  planter(b, -15.95, -10.9, rnd, 1.0)
  paper.wall("card_extensions", G[7] - 0.062, FLOOR_Y + 1.45, -7.2, -1, 0, { pin: "tack" })
  paper.wall("calendar_oct84", G[7] - 0.062, FLOOR_Y + 1.6, -6.4, -1, 0, { pin: "pin" })

  // Private offices on the window bays: 1-04 (through 1-05), 1-05, 1-06, 1-07 (the Chief).
  const offices = [
    { id: "1-04", bay: 3, lamp: false },
    { id: "1-05", bay: 4, lamp: false },
    { id: "1-06", bay: 5, lamp: false },
    { id: "1-07", bay: 6, lamp: true },
  ]
  for (const o of offices) {
    const x0 = G[o.bay]
    const x1 = G[o.bay + 1]
    const cx = (x0 + x1) / 2
    handles.push(room(b, { id: o.id, name: o.id === "1-07" ? "Chief, Contracts" : "Contracts office", rect: rect(x0, x1, SHELL.z0, ZW), floor: broadloom, troffers: { louvre: true }, windows: { blinds: o.id === "1-07" ? "closed" : "random", radiators: "models" } }))
    const dz = -17.4
    const yaw = face(0, 1)
    put("office_desk", { position: [cx, FLOOR_Y, dz], yaw: face(0, -1) })
    const chief = o.id === "1-07"
    const chairP: [number, number] = [cx + 0.15, dz - 0.85]
    put("office_chair", { position: [chairP[0], FLOOR_Y, chairP[1]], yaw: yaw + (chief ? 0.35 : -0.2), inset: 0.15 })
    for (let k = 0; k < 2; k++) put("stack_chair", { position: [cx - 0.4 + k * 0.8, FLOOR_Y, dz + 1.05], yaw: face(0, -1) + (k - 0.5) * 0.4 })
    put("filing_cabinet", { position: [x0 + 0.06 + 0.26, FLOOR_Y, -20.2], yaw: face(1, 0), inset: 0.02 })
    put("coat_rack", { position: [x1 - 0.4, FLOOR_Y, -12.6], yaw: 0.3 })
    bookcase(b, x1 - 0.06 - 0.16, -15.4, face(-1, 0), rnd, { w: 0.9 })
    bookcase(b, x1 - 0.06 - 0.16, -16.32, face(-1, 0), rnd, { w: 0.9, fill: 0.7 })
    deskLamp(b, cx - 0.72, DESK_TOP, dz + 0.22, face(0, -1) - 0.35, chief, { intensity: 55 })
    blotter(b, cx, DESK_TOP, dz - 0.05, 0)
    wastebasket(b, cx + 0.95, dz - 0.6)
    if (chief) {
      // Vignette: coat still on his chair, briefcase open, phone off the hook on the blotter, the memo.
      coatOnChair(b, chairP[0], chairP[1], yaw + 0.35)
      briefcaseOpen(b, cx + 0.6, DESK_TOP, dz + 0.05, 0.25)
      phoneOffHook(b, cx + 0.35, DESK_TOP + 0.004, dz - 0.25, face(0, -1) - 0.2)
      paper.flat("memo_next_of_kin", cx - 0.1, DESK_TOP + 0.006, dz - 0.05, 0.12)
      paper.flat("sticky_dont", cx - 0.35, DESK_TOP + 0.006, dz + 0.14, -0.3)
      ashtray(b, cx - 0.5, DESK_TOP, dz + 0.28, rnd, 6)
      paper.flat("roster_field_team", cx + 0.62, DESK_TOP + 0.09, dz + 0.06, 0.3, { offset: 0.002 })
    } else {
      put("telephone", { position: [cx + 0.6, DESK_TOP, dz - 0.1], yaw: face(0, -1) - 0.3, collide: false, blob: 0 })
      paper.flat(rnd() < 0.5 ? "form_requisition" : "envelope_interoffice", cx + 0.1, DESK_TOP + 0.006, dz - 0.05, rnd() - 0.5)
    }
    paper.wall(o.bay % 2 ? "calendar_oct84" : "directory_extensions", x0 + 0.063, FLOOR_Y + 1.55, -14.4, 1, 0, { pin: "tack" })
  }
  await pause()

  // ---------------------------------------------------------------------------------------------- 1-08 Coffee & copy
  partition(b, { axis: "x", at: ZW, from: G[7] + 0.06, to: G[8] - 0.06, finish: [ROOM_BANDS, ROOM_BANDS] })
  partition(b, { axis: "z", at: G[8], from: ZW + 0.06, to: -1.75, finish: [ROOM_BANDS, ROOM_BANDS] })
  handles.push(room(b, { id: "1-08", name: "Coffee & copy", rect: rect(G[7], G[8], ZW, -1.75), floor: "linoleum", troffers: { louvre: true } }))
  kitchenette(b, -12.9, ZW + 0.06 + 0.31, face(0, 1), 2.4, { coffeeOn: true })
  underBinTube(b, -14.0, -11.8, ZW + 0.06 + 0.26, FLOOR_Y + 1.49)
  copier(b, G[8] - 0.06 - 0.36, -6.2, face(-1, 0))
  put("trash_can", { position: [-10.5, FLOOR_Y, -9.6], yaw: 0.6 })
  put("water_cooler", { position: [-15.1, FLOOR_Y, -4.4], yaw: face(1, 0) })
  const cb = corkBoard(b, G[7] + 0.06 + 0.01, FLOOR_Y + 1.5, -7.0, face(1, 0), 1.2, 0.9)
  for (const [id, dz, dy] of [
    ["menu_cafeteria", -0.38, 0.12],
    ["memo_coffee", 0.05, 0.28],
    ["flyer_bowling", 0.4, 0.05],
    ["poster_missing_cat", -0.05, -0.18],
    ["signup_bowling", 0.38, -0.2],
  ] as const)
    paper.wall(id, cb.face[0] + 0.002, cb.face[1] + dy, cb.face[2] + dz, 1, 0, { pin: "pin" })
  await pause()

  // ---------------------------------------------------------------------------------------------- 1-09 Bullpen + fishbowl
  partition(b, { axis: "z", at: G[13], from: SHELL.z0, to: -1.75, finish: [ROOM_BANDS, ROOM_BANDS] })
  const FZ = -14.0
  partition(b, { axis: "x", at: FZ, from: G[12] + 0.04, to: G[13] - 0.06, thickness: 0.08, finish: [ROOM_BANDS, ROOM_BANDS], openings: [
    { kind: "glazed", from: 11.7, to: 15.6, sill: 0.1, head: 2.3, mullion: 1.3 },
    { kind: "door", at: 16.25, side: "b", door: { id: "1-09f", state: "closed", room: "1-09f", leaf: "glass", sign: { number: "1-09f" } } },
  ] })
  partition(b, { axis: "z", at: G[12], from: SHELL.z0, to: FZ - 0.04, thickness: 0.08, finish: [ROOM_BANDS, ROOM_BANDS], openings: [{ kind: "glazed", from: -21.4, to: -14.15, sill: 0.1, head: 2.3, mullion: 1.45 }] })
  const bull = room(b, { id: "1-09", name: "Personnel & Payroll", rect: rect(G[8], G[12], SHELL.z0, -1.75), floor: M.carpet, troffers: { louvre: true }, windows: { blinds: "random", radiators: "convector" } })
  handles.push(
    bull,
    room(b, { id: "1-09w", name: "Personnel & Payroll (files)", rect: rect(G[7], G[8], SHELL.z0, ZW), floor: M.carpet, troffers: { louvre: true }, windows: { blinds: "random", radiators: "convector" } }),
    room(b, { id: "1-09e", name: "Personnel & Payroll (east)", rect: rect(G[12], G[13], FZ, -1.75), floor: M.carpet, troffers: { louvre: true }, windows: false }),
    room(b, { id: "1-09f", name: "Supervisor's office", rect: rect(G[12], G[13], SHELL.z0, FZ), floor: broadloom, troffers: { louvre: true }, windows: { blinds: "open", radiators: "convector" } }),
  )
  const deskXs = [-8.4, -5.1, -1.8, 1.5, 4.8, 8.1]
  const deskZs = [-19.6, -16.6, -8.8, -5.8]
  let n = 0
  for (const z of deskZs)
    for (const x of deskXs) {
      const i = n++
      // Clerks face east: the desk's drawer side (model front) towards the chair on its west.
      const yaw = face(-1, 0)
      put("office_desk", { position: [x, FLOOR_Y, z], yaw })
      const turned = i === 4 // the one chair turned to the windows
      put("stack_chair", { position: [x - 0.85 + (rnd() - 0.5) * 0.2, FLOOR_Y, z + (turned ? -0.3 : (rnd() - 0.5) * 0.4)], yaw: turned ? face(0, -1) : face(1, 0) + (rnd() - 0.5) * 0.5 })
      // Desk-top: typewriter on most, phone, card file, paperwork (worker side = local −z).
      const m = T(x, FLOOR_Y, z, yaw)
      if (i % 4 !== 3) {
        const tp = typewriter(b, ...xyz(pt(m, -0.3, 0, -0.1), DESK_TOP), yaw, { tan: i % 3 === 0 })
        if (i === 14) paper.add({ id: "letter_regret", position: tp.position, normal: tp.normal, pin: "none", curl: 0.25 })
        else if (i % 5 === 0) paper.add({ id: "form_requisition", position: tp.position, normal: tp.normal, pin: "none", curl: 0.2 })
      }
      const ph = pt(m, 0.6, 0, -0.05)
      put("telephone", { position: [ph[0], DESK_TOP, ph[2]], yaw: yaw + (rnd() - 0.5) * 0.6, collide: false, blob: 0 })
      if (i % 3 === 1) cardFile(b, ...xyz(pt(m, 0.25, 0, 0.25), DESK_TOP), yaw)
      const dp = pt(m, 0.2 + (rnd() - 0.5) * 0.3, 0, -0.12)
      if (i % 2 === 0) paper.flat(rnd() < 0.5 ? "envelope_interoffice" : "form_requisition", dp[0], DESK_TOP, dp[2], rnd() * 6)
      if (i % 4 === 1) wastebasket(b, ...xz(pt(m, 0.8, 0, -0.65)))
    }
  // In/out board on the east wall: every name OUT except six on the FIELD line.
  inOutBoard(b, G[13] - 0.06 - 0.025, FLOOR_Y + 1.5, -8.0, face(-1, 0), 22, [3, 7, 8, 12, 17, 20])
  paper.wall("roster_operators", G[13] - 0.062, FLOOR_Y + 1.55, -6.9, -1, 0, { pin: "pin", pinColor: "red" })
  // Files in the west wing: card-file cabinets and a typing table.
  for (let k = 0; k < 6; k++) put("filing_cabinet", { position: [G[7] + 0.06 + 0.26, FLOOR_Y, -20.6 + k * 0.46], yaw: face(1, 0), inset: 0.02 })
  for (let k = 0; k < 4; k++) put("filing_cabinet", { position: [-13.6 + k * 0.46, FLOOR_Y, ZW - 0.06 - 0.27], yaw: face(0, -1), inset: 0.02 })
  const tt = table(b, -12.6, -17.0, face(1, 0), 1.2, 0.6, { mat: M.laminateTop, legs: M.darkSteel, h: 0.68 })
  typewriter(b, -12.55, tt, -17.0, face(-1, 0) + 0.15)
  put("stack_chair", { position: [-13.3, FLOOR_Y, -17.1], yaw: face(1, 0) + 0.3 })
  // Supervisor's fishbowl.
  put("office_desk", { position: [14.3, FLOOR_Y, -18.6], yaw: face(0, -1) })
  put("office_chair", { position: [14.4, FLOOR_Y, -19.45], yaw: face(0, 1) - 0.2, inset: 0.15 })
  put("filing_cabinet", { position: [G[13] - 0.06 - 0.26, FLOOR_Y, -20.6], yaw: face(-1, 0), inset: 0.02 })
  put("filing_cabinet", { position: [G[13] - 0.06 - 0.26, FLOOR_Y, -20.14], yaw: face(-1, 0), inset: 0.02 })
  put("stack_chair", { position: [14.0, FLOOR_Y, -17.4], yaw: face(0, -1) + 0.2 })
  deskLamp(b, 13.6, DESK_TOP, -18.35, face(0, -1) - 0.4, true, { intensity: 45 })
  put("telephone", { position: [14.9, DESK_TOP, -18.7], yaw: face(0, -1) - 0.4, collide: false, blob: 0 })
  blotter(b, 14.3, DESK_TOP, -18.6, 0)
  paper.flat("roster_field_team", 14.3, DESK_TOP + 0.006, -18.55, -0.1)
  paper.flat("sticky_marge", 14.0, DESK_TOP + 0.007, -18.4, 0.4)
  verticalBlinds(b, "z", 11.68, -21.3, -17.0, rnd, { y0: 0.15, open: 0.3 })
  await pause()

  // ---------------------------------------------------------------------------------------------- 1-10 Technical library
  const lib = room(b, { id: "1-10", name: "Technical library", rect: rect(G[13], SHELL.x1, SHELL.z0, -1.75), floor: M.carpet, troffers: { louvre: true }, windows: { blinds: "random", radiators: "convector" } })
  handles.push(lib)
  const stackXs = [19.6, 21.6, 23.6, 25.6, 29.6, 31.6]
  const libProps: Prop[] = []
  for (const x of stackXs) for (const z of [-19.9, -17.53, -15.16]) libProps.push({ position: [x, FLOOR_Y, z], yaw: Math.PI / 2, inset: 0.03 })
  for (const p of libProps) {
    put("steel_shelves", p)
    fillShelf(b, p.position[0], p.position[2], rnd, { books: true, gap: 0.04 })
  }
  // Reading tables with banker's lamps (one lit), chairs.
  for (const [x, z, on] of [[21.4, -9.4, false], [25.6, -9.4, true], [21.4, -6.2, false], [25.6, -6.2, false]] as const) {
    const top = table(b, x, z, 0, 2.4, 1.0)
    bankerLamp(b, x, top, z, 0, on)
    for (let k = 0; k < 2; k++)
      for (const s of [-1, 1]) put("stack_chair", { position: [x - 0.6 + k * 1.2 + (rnd() - 0.5) * 0.1, FLOOR_Y, z + s * 0.78], yaw: face(0, -s) + (rnd() - 0.5) * 0.3 })
    if (on) {
      paper.flat("printout_greenbar", x + 0.5, top, z + 0.05, 0.1)
      paper.flat("note_repeated", x - 0.4, top + 0.001, z + 0.15, -0.25)
    }
  }
  // Librarian's desk by the door, card catalogue, fiche reader, periodicals.
  put("office_desk", { position: [20.2, FLOOR_Y, -3.6], yaw: face(-1, 0) })
  put("stack_chair", { position: [19.35, FLOOR_Y, -3.7], yaw: face(1, 0) + 0.3 })
  put("telephone", { position: [20.3, DESK_TOP, -4.3], yaw: face(-1, 0), collide: false, blob: 0 })
  cardFile(b, 20.25, DESK_TOP, -3.0, face(-1, 0))
  paper.flat("directory_extensions", 20.1, DESK_TOP, -3.6, 1.4)
  cardCatalogue(b, 28.4, -2.0 - 0.25, face(0, -1), rnd, { cols: 8 })
  const ft = table(b, SHELL.x1 - 0.5, -8.6, face(-1, 0), 1.4, 0.8)
  ficheReader(b, SHELL.x1 - 0.48, ft, -8.6, face(-1, 0), true)
  put("stack_chair", { position: [SHELL.x1 - 1.3, FLOOR_Y, -8.5], yaw: face(1, 0) - 0.2 })
  periodicalsRack(b, SHELL.x1 - 0.06 - 0.2, -5.2, face(-1, 0), rnd)
  periodicalsRack(b, SHELL.x1 - 0.06 - 0.2, -11.6, face(-1, 0), rnd)
  bookTruck(b, 27.6, -13.0, 1.4, rnd)
  put("wall_clock", { position: [G[13] + 0.06 + 0.025, FLOOR_Y + 2.2, -8.0], yaw: face(1, 0), collide: false, blob: 0 })
  await pause()

  // ---------------------------------------------------------------------------------------------- 1-20 Word processing
  partition(b, { axis: "z", at: G[1], from: 10.675 + 0.06, to: SHELL.z1, finish: [ROOM_BANDS, ROOM_BANDS], openings: [{ kind: "door", at: 13.4, side: "a", door: { id: "1-22", state: "janitor", room: "1-22", leaf: "veneer", sign: { number: "1-22", label: "SUPPLY" } } }] })
  handles.push(room(b, { id: "1-20", name: "Word processing", rect: rect(SHELL.x0, G[1], 1.75, SHELL.z1), floor: M.carpet, troffers: { louvre: true }, windows: { blinds: "random", radiators: "convector" } }))
  const wpWins = windowsOn(1, rect(SHELL.x0, G[1], 1.75, SHELL.z1)).filter((w) => w.face === "west")
  wpWins.forEach((w, i) => {
    const z = (w.u0 + w.u1) / 2
    const x = SHELL.x0 + 0.04 + 0.2 + 0.48
    // Operators face the window: desk front (drawers) towards the chair on the east.
    put("office_desk", { position: [x, FLOOR_Y, z], yaw: face(1, 0) })
    put("office_chair", { position: [x + 0.85, FLOOR_Y, z + (i - 1) * 0.2], yaw: face(-1, 0) + (i - 1) * 0.4, inset: 0.15 })
    if (i === 1) {
      // The one terminal left on: green phosphor, a small light on the operator's chair.
      crtTerminal(b, x - 0.1, DESK_TOP, z - 0.3, face(1, 0), true)
      paper.flat("note_repeated", x + 0.25, DESK_TOP, z + 0.35, 1.3)
    } else {
      put("crt_terminal", { position: [x - 0.05, DESK_TOP, z - 0.3], yaw: face(1, 0), collide: false, blob: 0 })
      paper.flat("form_requisition", x + 0.2, DESK_TOP, z + 0.3, 1.5 + i)
    }
  })
  put("office_desk", { position: [-50.4, FLOOR_Y, 19.9], yaw: face(0, -1) })
  put("crt_terminal", { position: [-50.7, DESK_TOP, 20.1], yaw: face(0, -1), collide: false, blob: 0 })
  put("office_chair", { position: [-50.5, FLOOR_Y, 19.0], yaw: face(0, 1) + 0.2, inset: 0.15 })
  printerHood(b, -48.5, 19.6, face(-1, 0))
  for (let k = 0; k < 3; k++) put("filing_cabinet", { position: [G[1] - 0.06 - 0.26, FLOOR_Y, 4.0 + k * 0.46], yaw: face(-1, 0), inset: 0.02 })
  wastebasket(b, -48.4, 6.2)
  paper.wall("calendar_oct84", G[1] - 0.063, FLOOR_Y + 1.6, 8.6, -1, 0, { pin: "tack" })

  // 1-22 Supply store (janitor key, through 1-20).
  partition(b, { axis: "z", at: -43.33, from: 10.675 + 0.06, to: SHELL.z1, finish: [ROOM_BANDS, ROOM_BANDS] })
  handles.push(room(b, { id: "1-22", name: "Supply store", rect: rect(G[1], -43.33, 10.675, SHELL.z1), floor: "linoleum", troffers: { dx: 2.4, dz: 3.6 }, windows: { blinds: "closed", radiators: "none" } }))
  put("steel_shelves", { position: [-43.39 - 0.37, FLOOR_Y, 13.0], yaw: face(-1, 0), inset: 0.03 })
  put("steel_shelves", { position: [-43.39 - 0.37, FLOOR_Y, 15.4], yaw: face(-1, 0), inset: 0.03 })
  put("metal_rack", { position: [-46.4, FLOOR_Y, 10.735 + 0.32], yaw: face(0, 1) })
  for (const [x, z, y, r] of [[-46.8, 18.4, 0, 0.2], [-46.4, 18.9, 0, 1.1], [-46.6, 18.6, 0.342, 0.5], [-45.2, 20.6, 0, 0.1]] as const)
    put("cardboard_box", { position: [x, FLOOR_Y + y, z], yaw: r, collide: y === 0, blob: y === 0 ? 1.2 : 0 })
  await pause()

  // ---------------------------------------------------------------------------------------------- 1-24 Program office
  // West wing filler wall against the lift lobby (the chase wall stops at z 16.05).
  partition(b, { axis: "z", at: -36.077, from: 16.05, to: SHELL.z1, thickness: 0.146, finish: [ROOM_BANDS, OFFICE] })
  handles.push(
    room(b, { id: "1-24", name: "Program Office", rect: rect(G[5], G[14], 1.75, SHELL.z1), floor: broadloom, lit: "none", troffers: { louvre: true }, windows: { blinds: "random", radiators: "convector" } }),
    room(b, { id: "1-24w", name: "Program Office (west)", rect: rect(-36.077, G[5], 9.675, SHELL.z1), floor: broadloom, lit: "none", troffers: { louvre: true }, windows: { blinds: "random", radiators: "convector" } }),
  )
  // The edge: a 1.2 m fabric panel run with planters where the corridor wall used to be.
  const gaps: [number, number][] = [[-16.3, -14.7], [-5.4, -3.8], [5.4, 7.0], [16.2, 17.8]]
  let cur = OPEN_X0 + 0.02
  for (const [g0, g1] of [...gaps, [OPEN_X1 - 0.02, OPEN_X1] as [number, number]]) {
    panelRun(b, cur, g0, 1.69)
    if (g0 - cur > 1) {
      planter(b, g0 - 0.35, 2.2, rnd, 0.9)
      if (cur > OPEN_X0 + 0.1) planter(b, cur + 0.35, 2.2, rnd, 0.7)
    }
    cur = g1
  }
  // Nine pods of four; two task tubes and one desk lamp burning.
  const pods: [number, number, number[]][] = [
    [-31.0, 16.6, []],
    [-21.1, 6.2, []],
    [-21.1, 16.6, []],
    [-10.0, 6.2, [2]],
    [-10.0, 16.6, []],
    [0.8, 6.2, []],
    [0.8, 16.6, [1]],
    [11.6, 6.2, []],
    [11.6, 16.6, []],
  ]
  pods.forEach(([x, z, tubes], i) => cubiclePod(b, x, z, 0, { tubes, seed: i + 3 }))
  deskLamp(b, 12.4 + 0.2, CUBE_TOP, 17.2, face(-1, -1), true, { intensity: 40 })
  paper.flat("note_repeated", 12.2, CUBE_TOP, 17.35, 0.4)
  paper.flat("polaroid_corridor", -9.3, CUBE_TOP, 5.75, 1.0)
  paper.flat("sticky_dish", -9.6, CUBE_TOP, 5.6, 0.2)
  for (const [x, z] of pods.map(([x, z]) => [x, z] as const)) {
    paper.wall(rnd() < 0.5 ? "memo_signin" : "calendar_oct84", x - 0.9, FLOOR_Y + 1.25, z - 0.031, 0, -1, { pin: "pin" })
    wastebasket(b, x + 1.55, z + 1.0)
  }
  for (const [x, z] of [[-26.0, 12.2], [-4.6, 12.6], [6.2, 11.2], [17.0, 12.6]] as const) wastebasket(b, x + 0.5, z)
  put("coat_rack", { position: [-26.6, FLOOR_Y, 10.3], yaw: 0.6 })
  // Notice board on the AV store's wall facing the open office.
  const ob = corkBoard(b, G[14] - 0.06 - 0.01, FLOOR_Y + 1.5, 5.6, face(-1, 0), 1.5, 0.9)
  for (const [id, dz, dy] of [
    ["notice_nightshift", -0.5, 0.25],
    ["flyer_bowling", -0.1, 0.1],
    ["memo_signin", 0.35, 0.15],
    ["polaroid_dish", -0.45, -0.2],
    ["card_extensions", 0.0, -0.25],
    ["sticky_marge", 0.3, -0.22],
    ["notice_north_lot", 0.58, -0.05],
  ] as const)
    paper.wall(id, ob.face[0] - 0.002, ob.face[1] + dy, ob.face[2] + dz, -1, 0, { pin: "pin" })
  put("coat_rack", { position: [21.8, FLOOR_Y, 8.6], yaw: 1.1 })
  put("water_cooler", { position: [21.95, FLOOR_Y, 3.2], yaw: face(-1, 0) })
  await pause()

  // ---------------------------------------------------------------------------------------------- 1-25 / 1-26
  const ZB = 9.45 // shifted 0.2 m north of the program line so the east facade window stays inside Conference B
  partition(b, { axis: "z", at: G[14], from: 1.75, to: SHELL.z1, finish: [OFFICE, OFFICE], openings: [
    { kind: "door", at: 11.0, side: "a", door: { id: "1-25", state: "open", room: "1-25", leaf: "glass", sign: { number: "1-25", label: "CONFERENCE" } } },
    { kind: "glazed", from: 11.6, to: 21.4, sill: 0.9, head: 2.3, mullion: 1.4 },
  ] })
  partition(b, { axis: "x", at: ZB, from: G[14] + 0.06, to: SHELL.x1, finish: [ROOM_BANDS, OFFICE], openings: [{ kind: "door", at: 33.4, side: "b", door: { id: "1-25b", state: "closed", room: "1-26", leaf: "veneer" } }] })
  handles.push(
    room(b, { id: "1-25", name: "Conference B", rect: rect(G[14], SHELL.x1, ZB, SHELL.z1), floor: broadloom, lit: [[25.2, 13.2], [25.2, 18.0], [31.2, 13.2], [31.2, 18.0]], troffers: { louvre: true, intensity: 22 }, windows: { blinds: "random", radiators: "convector" } }),
    room(b, { id: "1-26", name: "AV store & kitchenette", rect: rect(G[14], SHELL.x1, 1.75, ZB), floor: "linoleum", troffers: { louvre: true } }),
  )
  conferenceTable(b, 28.6, 15.6, 0, 12)
  for (let k = 0; k < 3; k++) ashtray(b, 26.6 + k * 2.0, FLOOR_Y + 0.765, 15.6, rnd, 2 + k)
  slideProjector(b, 31.2, FLOOR_Y + 0.765, 15.6, face(-1, 0))
  flipChart(b, 23.4, 19.6, face(1, -1))
  projectionScreen(b, G[14] + 0.25, 15.6, face(1, 0), 2.0, 1.4)
  paper.flat("printout_greenbar", 27.4, FLOOR_Y + 0.7665, 15.3, 0.4)
  paper.flat("map_evac_1", 29.6, FLOOR_Y + 0.7665, 15.9, -0.2)
  verticalBlinds(b, "z", G[14] + 0.1, 11.7, 15.0, rnd, { open: 0.15 })
  // AV store + kitchenette.
  kitchenette(b, SHELL.x1 - 0.04 - 0.31, 5.2, face(-1, 0), 2.4)
  for (const [x, z, r] of [[24.0, 4.0, 0.3], [24.0, 6.4, -0.2]] as const) {
    const top = avCart(b, x, z, r)
    put("television", { position: [x, top, z], yaw: r + Math.PI, collide: false, blob: 0 })
  }
  put("metal_rack", { position: [27.0, FLOOR_Y, ZB - 0.06 - 0.31], yaw: face(0, -1) })
  put("metal_rack", { position: [28.0, FLOOR_Y, ZB - 0.06 - 0.31], yaw: face(0, -1) })
  for (const [x, y] of [[26.8, 0.5], [27.2, 0.92], [28.1, 0.5]] as const) b.cyl(P.puttyDark, T(x, FLOOR_Y + y + 0.035, ZB - 0.4), 0.14, 0.14, 0.07, 24)
  put("trash_can", { position: [30.3, FLOOR_Y, 2.3], yaw: 0.3 })
  paper.wall("memo_coffee", SHELL.x1 - 0.042, FLOOR_Y + 1.5, 3.6, -1, 0, { pin: "tape" })
  await pause()

  // ---------------------------------------------------------------------------------------------- models, paper
  for (const [name, list] of batch) placeModels(b, name, list)
  paper.flush(b)

  return {
    update: (t) => {
      sp.update(t)
      for (const h of handles) h.update(t)
    },
    proxy: null,
  }
}


const xyz = (p: [number, number, number], y: number): [number, number, number] => [p[0], y, p[2]]
const xz = (p: [number, number, number]): [number, number] => [p[0], p[2]]

/** Fabric-covered systems panels (1.2 m) with posts and a trim cap, along x at z = zc from a0 to a1. */
function panelRun(b: Builder, a0: number, a1: number, zc: number) {
  if (a1 - a0 < 0.3) return
  const h = 1.2
  const t = 0.06
  const n = Math.max(1, Math.round((a1 - a0) / 1.5))
  const w = (a1 - a0) / n
  for (let k = 0; k < n; k++) {
    const x0 = a0 + k * w
    b.rbox(P.fabric, T(x0 + w / 2, FLOOR_Y, zc), w - 0.04, h - 0.03, t, 0.012, 0, (h - 0.03) / 2 + 0.01, 0)
    b.box(P.fabricTrim, x0 - 0.02, FLOOR_Y, zc - t / 2 - 0.006, x0 + 0.02, FLOOR_Y + h, zc + t / 2 + 0.006)
  }
  b.box(P.fabricTrim, a1 - 0.02, FLOOR_Y, zc - t / 2 - 0.006, a1 + 0.02, FLOOR_Y + h, zc + t / 2 + 0.006)
  b.box(P.fabricTrim, a0, FLOOR_Y + h, zc - t / 2 - 0.004, a1, FLOOR_Y + h + 0.025, zc + t / 2 + 0.004)
  b.collide(a0, FLOOR_Y, zc - t / 2, a1, FLOOR_Y + h, zc + t / 2)
}
