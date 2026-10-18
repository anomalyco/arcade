import * as THREE from "three/webgpu"
import { MODELS, yawToward } from "../../render/models"
import { type Builder, CEIL_Y, FLOOR_Y, M, T, paint } from "./kit"
import { CORE_PLAN, type DoorState, RISER_W1, SERVICE, type Rect } from "./plan"
import { type PDoor, type POpening, partition } from "./partition"
import { placeModels } from "./props"
import { room } from "./room"
import { washroom } from "./washroom"
import { bucket } from "./fixtures"
import { fountain } from "./fittings"
import { PLANT_BANDS, ROOM_BANDS, WET_BANDS } from "./styles"

// The fixed parts every storey shares (building program §1): the service stack south of the spine (EL electrical,
// TC telecom, WC-M, janitor closet, store, WC-W, the fountain between the WC doors, the mechanical chase beside the
// core hall) and riser W-1. Storeys call these; the kit owns what they contain.

export type ServiceRoom = "EL" | "TC" | "WCM" | "JC" | "STORE" | "WCW"
export type ServiceOpts = {
  /** Rooms a storey builds itself (storey 0 keeps its existing janitor closet: skip "JC"). */
  skip?: ServiceRoom[]
  /** Door state overrides (defaults: EL/JC/store janitor, WCs open; TC's door is the core's, keycard "comms"). */
  states?: Partial<Record<ServiceRoom, DoorState>>
  /** Storey 4: WCs taped "out of order", a temporary distribution board in EL. */
  refurb?: boolean
}

export type ServiceHandle = {
  /** Openings to pass into `spine({ south: [...] })`: the spine doors of EL, WC-M, JC and WC-W. */
  spineOpenings: POpening[]
  rooms: Record<ServiceRoom, Rect>
}


export function serviceStack(b: Builder, o: ServiceOpts = {}): ServiceHandle {
  const skip = new Set(o.skip ?? [])
  const st = (r: ServiceRoom, d: DoorState) => o.states?.[r] ?? d
  const S = SERVICE
  const n = b.storey
  // Walls (centred on the program lines; the hall's west wall and the spine wall are the core's / spine's).
  const z1 = 10.735 // the 10.675 cross wall's far face: no stub past it
  partition(b, { axis: "z", at: -47.8, from: 1.75, to: z1, finish: [ROOM_BANDS, PLANT_BANDS] })
  partition(b, { axis: "x", at: 10.675, from: -47.8, to: -42.15, finish: [PLANT_BANDS, ROOM_BANDS] })
  partition(b, { axis: "x", at: 6.475, from: -47.8, to: -42.15, finish: [PLANT_BANDS, PLANT_BANDS] })
  // Chase wall: toilet tile on the WC-M side, room finish north of the toilets.
  partition(b, { axis: "z", at: -36.075, from: 1.75, to: 9.6, thickness: 0.15, finish: [PLANT_BANDS, WET_BANDS] })
  partition(b, { axis: "z", at: -36.075, from: 9.6, to: CORE_PLAN.chase.z1, thickness: 0.15, finish: [PLANT_BANDS, ROOM_BANDS] })
  partition(b, { axis: "x", at: 9.675, from: -36.0, to: -26.2, finish: [WET_BANDS, ROOM_BANDS] })
  partition(b, { axis: "z", at: -26.2, from: 1.75, to: 9.75, finish: [WET_BANDS, ROOM_BANDS] })
  partition(b, { axis: "z", at: -32.675, from: 1.75, to: 9.6, finish: [WET_BANDS, WET_BANDS] })
  partition(b, { axis: "z", at: -29.325, from: 1.75, to: 9.6, finish: [WET_BANDS, WET_BANDS] })
  const storeDoor: PDoor = { kind: "door", at: -31.0, side: "a", door: { id: "STORE", state: st("STORE", "janitor"), room: "STORE", sign: { number: `${n}-S`, label: "STORE" } } }
  partition(b, { axis: "x", at: 5.075, from: -32.6, to: -29.4, finish: [WET_BANDS, ROOM_BANDS], openings: skip.has("STORE") ? [] : [storeDoor] })
  // Rooms.
  if (!skip.has("EL")) electrical(b, o.refurb)
  if (!skip.has("TC")) telecom(b)
  if (!skip.has("WCM")) toilets(b, S.WCM, "M", o.refurb, -34.4)
  if (!skip.has("WCW")) toilets(b, S.WCW, "W", o.refurb, -27.7)
  if (!skip.has("JC")) janitor(b)
  if (!skip.has("STORE")) store(b)
  fountain(b, S.fountain.x, S.fountain.z)
  const d = (r: ServiceRoom, at: number, state: DoorState, label: string): POpening => ({ kind: "door", at, side: "a", door: { id: r, state, room: r, sign: { number: `${r}-${n}`, label } } })
  const spineOpenings: POpening[] = []
  if (!skip.has("EL")) spineOpenings.push(d("EL", -45.0, st("EL", "janitor"), "ELECTRICAL"))
  if (!skip.has("WCM")) spineOpenings.push(d("WCM", -34.4, st("WCM", "open"), "MEN"))
  if (!skip.has("JC")) spineOpenings.push(d("JC", -32.0, st("JC", "janitor"), "JANITOR"))
  if (!skip.has("WCW")) spineOpenings.push(d("WCW", -27.7, st("WCW", "open"), "WOMEN"))
  return { spineOpenings, rooms: { EL: S.EL, TC: S.TC, WCM: S.WCM, JC: S.JC, STORE: S.STORE, WCW: S.WCW } }
}

function electrical(b: Builder, refurb?: boolean) {
  const r = SERVICE.EL
  room(b, { id: "EL", name: "Electrical", rect: r, floor: "concrete_floor_dry", lit: "none", troffers: { dx: 2.4, dz: 3.6 }, windows: false, columns: false })
  const wx = r.x0 + 0.06
  const [, , bd] = MODELS.utility_box_b.size
  placeModels(b, "utility_box_b", [3.0, 4.4].map((z) => ({ position: [wx + bd / 2, FLOOR_Y + 0.5, z] as const, yaw: yawToward(1, 0), collide: true, inset: 0, blob: 0 })))
  placeModels(b, "utility_box", [{ position: [wx + MODELS.utility_box.size[2] / 2, FLOOR_Y + 0.4, 5.6], yaw: yawToward(1, 0), blob: 0 }])
  // Conduit up from every panel into the ceiling, a horizontal run along the wall.
  for (const z of [2.7, 3.3, 4.1, 4.7, 5.6]) b.rod("metal_galvanized", [wx + 0.04, FLOOR_Y + 1.6, z], [wx + 0.04, CEIL_Y, z], 0.014, 6)
  b.rod("metal_galvanized", [wx + 0.04, CEIL_Y - 0.2, 2.2], [wx + 0.04, CEIL_Y - 0.2, 6.2], 0.016, 6)
  // Breaker schedule cards (blank), a shelf of fuse spares.
  for (const z of [3.0, 4.4]) b.box(M.paper, wx + 0.002, FLOOR_Y + 1.62, z - 0.12, wx + 0.006, FLOOR_Y + 1.82, z + 0.12, { cast: false })
  b.box(M.wood, r.x1 - 0.35, FLOOR_Y + 1.4, 2.2, r.x1 - 0.06, FLOOR_Y + 1.43, 3.6)
  for (let k = 0; k < 6; k++) b.box(M.cardboard, r.x1 - 0.3, FLOOR_Y + 1.43, 2.3 + k * 0.2, r.x1 - 0.12, FLOOR_Y + 1.53, 2.42 + k * 0.2)
  if (refurb) {
    // Temporary distribution board feeding the work lights: plywood backboard, yellow cables out under the door.
    b.box(M.plywood, r.x1 - 0.03, FLOOR_Y + 0.6, 4.6, r.x1 - 0.012, FLOOR_Y + 1.6, 5.8)
    b.rbox(M.safety, T(r.x1 - 0.1, FLOOR_Y + 1.1, 5.2, -Math.PI / 2), 0.5, 0.6, 0.15, 0.02)
    b.rod(M.safety, [r.x1 - 0.1, FLOOR_Y + 0.8, 5.2], [-45.0, FLOOR_Y + 0.01, 1.8], 0.012, 6)
  }
  b.lamp({ kind: "warning", position: [wx + 0.3, FLOOR_Y + 1.9, 3.7], color: [1, 0.5, 0.1], intensity: 0.15, range: 1.5, size: 0.02 })
}

function telecom(b: Builder) {
  const r = SERVICE.TC
  room(b, { id: "TC", name: "Telecom", rect: r, floor: "concrete_floor_dry", lit: "none", windows: false, columns: false })
  // 66-block punch-down board: plywood backboard on the west wall with rows of white blocks.
  const wx = r.x0 + 0.06
  b.box(M.plywood, wx, FLOOR_Y + 0.6, 7.0, wx + 0.019, FLOOR_Y + 2.4, 9.8)
  for (let row = 0; row < 3; row++)
    for (let k = 0; k < 9; k++) b.box(M.jugWhite, wx + 0.019, FLOOR_Y + 1.0 + row * 0.42, 7.2 + k * 0.28, wx + 0.04, FLOOR_Y + 1.32 + row * 0.42, 7.38 + k * 0.28)
  // Relay rack: two-post frame with equipment shelves.
  const rx = -44.6
  for (const dz of [-0.24, 0.24]) b.box(M.darkSteel, rx - 0.04, FLOOR_Y, 8.6 + dz - 0.04, rx + 0.04, FLOOR_Y + 2.1, 8.6 + dz + 0.04)
  for (let k = 0; k < 5; k++) b.rbox(k % 2 ? M.beige : M.darkSteel, T(rx, FLOOR_Y + 0.4 + k * 0.33, 8.6), 0.4, 0.22, 0.44, 0.01)
  b.collide(rx - 0.25, FLOOR_Y, 8.3, rx + 0.25, FLOOR_Y + 2.1, 8.9)
  // Cable ladder overhead from the rack to the backboard.
  for (const dz of [-0.15, 0.15]) b.box("metal_galvanized", wx, CEIL_Y - 0.4, 8.6 + dz - 0.01, rx, CEIL_Y - 0.36, 8.6 + dz + 0.01)
  for (let x = wx + 0.2; x < rx; x += 0.3) b.box("metal_galvanized", x - 0.01, CEIL_Y - 0.4, 8.45, x + 0.01, CEIL_Y - 0.385, 8.75, { cast: false })
}

/** Washrooms: see washroom.ts (library fixtures, steel stalls, mirror, drain). */
function toilets(b: Builder, r: Rect, kind: "M" | "W", refurb: boolean | undefined, doorX: number) {
  const id = kind === "M" ? "WCM" : "WCW"
  washroom(b, { id, name: kind === "M" ? "Men's room" : "Women's room", rect: r, kind, refurb, door: { x: doorX, id } })
}

function janitor(b: Builder) {
  const r = SERVICE.JC
  room(b, { id: "JC", name: "Janitor's closet", rect: r, floor: "concrete_floor_dry", lit: "none", troffers: false, windows: false, columns: false })
  const y = FLOOR_Y
  // Slop sink in the back corner, bucket and wringer, mops, shelves of chemicals, wet-floor signs, a radio.
  const mx0 = r.x1 - 0.75
  const mz0 = r.z1 - 0.75
  const h = 0.28
  // Curbs butt (front/back run full width, sides fit between them), 2 mm off the walls; base inside the curbs.
  const wx1 = r.x1 - 0.002
  const wz1 = r.z1 - 0.002
  for (const [a, c, d, e] of [
    [mx0, wx1, mz0, mz0 + 0.07],
    [mx0, wx1, wz1 - 0.05, wz1],
    [mx0, mx0 + 0.06, mz0 + 0.07, wz1 - 0.05],
    [wx1 - 0.05, wx1, mz0 + 0.07, wz1 - 0.05],
  ] as const)
    b.box(M.concreteSink, a, y, d, c, y + h, e, { skip: "y" })
  b.box(M.concreteSink, mx0 + 0.06, y, mz0 + 0.07, wx1 - 0.05, y + 0.04, wz1 - 0.05, { skip: "y" })
  b.rod(M.steel, [mx0 + 0.25, y + 0.95, r.z1], [mx0 + 0.55, y + 0.95, r.z1], 0.015)
  b.rod(M.steel, [mx0 + 0.4, y + 0.95, r.z1], [mx0 + 0.4, y + 0.88, r.z1 - 0.2], 0.012)
  b.collide(mx0, y, mz0, r.x1, y + h, r.z1)
  bucket(b, r.x0 + 0.4, 3.9)
  placeModels(b, "metal_rack", [{ position: [r.x1 - MODELS.metal_rack.size[2] / 2 - 0.02, y, 2.75], yaw: yawToward(-1, 0) }])
  placeModels(b, "wet_floor_sign", [
    { position: [r.x0 + 0.25, y, 2.2], yaw: 0.3, collide: false },
    { position: [r.x0 + 0.5, y, 2.25], yaw: -0.2, collide: false },
  ])
  b.rbox(M.darkSteel, T(r.x1 - 0.3, y + 1.48, 2.9, -Math.PI / 2), 0.24, 0.14, 0.08, 0.02)
  b.rod(M.steel, [r.x1 - 0.3, y + 1.55, 2.95], [r.x1 - 0.3, y + 1.8, 2.95], 0.003, 4)
  // Bare bulb on a pull chain.
  const bx = (r.x0 + r.x1) / 2
  b.cyl(M.paper, T(bx, CEIL_Y - 0.04, 3.3), 0.05, 0.06, 0.08, 12)
  const bulb = new THREE.SphereGeometry(0.04, 12, 8)
  bulb.translate(bx, CEIL_Y - 0.13, 3.3)
  b.add(M.bulbWarm, bulb, { cast: false })
  b.lamp({ kind: "incandescent", position: [bx, CEIL_Y - 0.2, 3.3], color: [1.0, 0.68, 0.38], intensity: 3, range: 4.5, size: 0.06 })
}

function store(b: Builder) {
  const r = SERVICE.STORE
  room(b, { id: "STORE", name: "Store", rect: r, floor: "concrete_floor_dry", lit: "none", windows: false, columns: false })
  const [, , sd] = MODELS.steel_shelves.size
  placeModels(b, "steel_shelves", [{ position: [(r.x0 + r.x1) / 2, FLOOR_Y, r.z1 - sd / 2 - 0.04], yaw: 0, inset: 0.03 }])
  placeModels(b, "cardboard_box", [
    { position: [r.x0 + 0.35, FLOOR_Y, 6.0], yaw: 0.3 },
    { position: [r.x0 + 0.35, FLOOR_Y + MODELS.cardboard_box.size[1], 6.0], yaw: -0.2, collide: false, blob: 0 },
  ])
  // A step ladder against the east wall.
  const lx = r.x1 - 0.08
  for (const dz of [-0.22, 0.22]) b.rod("metal_galvanized", [lx - 0.25, FLOOR_Y, 6.4 + dz], [lx, FLOOR_Y + 1.6, 6.4 + dz], 0.015, 6)
  for (let k = 1; k < 5; k++) b.box("metal_galvanized", lx - 0.25 + k * 0.05 - 0.04, FLOOR_Y + k * 0.32 - 0.01, 6.18, lx - 0.25 + k * 0.05 + 0.04, FLOOR_Y + k * 0.32 + 0.01, 6.62)
}

/** The footprint riserW1 occupies including its walls: pass it to `room({ exclude: [RISER_W1_OUTER] })` for the room
 *  that contains it. */
export const RISER_W1_OUTER: Rect = { x0: RISER_W1.x0 - 0.1, x1: RISER_W1.x1 + 0.1, z0: RISER_W1.z0 - 0.1, z1: RISER_W1.z1 + 0.1 }

/** Riser W-1: a locked cupboard (stencilled trunk marks, no readable text) on every storey; door on `face`. */
export function riserW1(b: Builder, o: { face?: "north" | "south" | "east" | "west"; state?: DoorState; hidden?: boolean } = {}) {
  const r = RISER_W1
  const t = 0.1
  const face = o.face ?? "south"
  const door = (axisFace: string, at: number): POpening[] =>
    face === axisFace ? [{ kind: "door", at, side: face === "south" || face === "east" ? "b" : "a", door: { id: "W-1", state: o.state ?? "locked", width: 0.8, sign: { number: "W-1", label: "SL TRUNK" } } }] : []
  const cx = (r.x0 + r.x1) / 2
  const cz = (r.z0 + r.z1) / 2
  partition(b, { axis: "x", at: r.z0 - t / 2, from: r.x0 - t, to: r.x1 + t, thickness: t, finish: [ROOM_BANDS, PLANT_BANDS], openings: door("north", cx) })
  partition(b, { axis: "x", at: r.z1 + t / 2, from: r.x0 - t, to: r.x1 + t, thickness: t, finish: [PLANT_BANDS, ROOM_BANDS], openings: door("south", cx) })
  partition(b, { axis: "z", at: r.x0 - t / 2, from: r.z0, to: r.z1, thickness: t, finish: [ROOM_BANDS, PLANT_BANDS], openings: door("west", cz) })
  partition(b, { axis: "z", at: r.x1 + t / 2, from: r.z0, to: r.z1, thickness: t, finish: [PLANT_BANDS, ROOM_BANDS], openings: door("east", cz) })
  b.floor("concrete_floor_dry", r.x0, r.z0, r.x1, r.z1)
  b.box(M.concrete, r.x0, CEIL_Y, r.z0, r.x1, CEIL_Y + 0.03, r.z1, { cast: false, skip: "XxYZz" })
  // Coax bundle down the middle of the trunk.
  for (const [dx, dz] of [[-0.12, 0], [0.1, 0.06], [0, -0.12], [0.06, 0.14]]) b.rod(M.rubber, [cx + dx!, FLOOR_Y, cz + dz!], [cx + dx!, CEIL_Y, cz + dz!], 0.025, 8)
  // Stencil marks beside the door (abstract bars).
  if (!o.hidden) {
    const n = face === "south" ? [0, 1] : face === "north" ? [0, -1] : face === "east" ? [1, 0] : [-1, 0]
    const fx = face === "east" ? r.x1 + t + 0.002 : face === "west" ? r.x0 - t - 0.002 : cx + 0.55
    const fz = face === "south" ? r.z1 + t + 0.002 : face === "north" ? r.z0 - t - 0.002 : cz + 0.55
    for (let k = 0; k < 3; k++) {
      const off = -0.08 + k * 0.08
      const [x, z] = n[0] === 0 ? [fx + off, fz] : [fx, fz + off]
      b.box(M.stencil, x - 0.025, FLOOR_Y + 1.5, z - 0.002, x + 0.025, FLOOR_Y + 1.85, z + 0.002, { cast: false })
    }
  }
}
