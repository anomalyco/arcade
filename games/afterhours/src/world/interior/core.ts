import { NIGHT_EXTRA } from "./lighting-state"
import { BUILDING, CORE, ROOF_Y } from "../layout"
import { STYLES } from "./styles"
import { doorway } from "./doorway"
import { TUBE, type Band, type Builder, CEIL_Y, FLOOR_Y, M, PANEL_ON, STOREY_H, T, addDocuments, ceiling, doorOpening, troffer, wall, LAYER } from "./kit"
import type { DocumentId } from "../../render/documents"

// Structure shared by every storey: the floor slabs of storeys 1–4 (and the one under the roof deck), the switchback
// stair from the ground floor to the roof, and on every storey the hall from the corridor to the stair door and the
// lift lobby. Built in one always-visible group (the stairwell sees every storey); lamps carry their storey's zone.

export const STOREYS = BUILDING.main.storeys
/** Inner faces of the main block's shell. */
export const SHELL = { x0: -54.65, x1: 34.65, z0: -21.65, z1: 21.65 }

const RISERS = 21
const RISE = STOREY_H / RISERS
const GOING = 0.28

/** Stairwell plan (x across, z along the flights), inner faces 2 cm proud of the facility's tower walls. */
export const ST = {
  x0: -43.08,
  x1: CORE.stair.max[0],
  /** West flight runs south (up), east flight north (up); the well is between them. */
  wellX0: -41.48,
  wellX1: -41.3,
  z0: CORE.stair.min[1],
  /** Storey landing ends / flights start. */
  zFlight: 18.66,
  /** Flights end / mid landing starts. */
  zMid: 18.66 + 10 * GOING,
  z1: 24.81,
  door: -40.9,
  wallZ0: CORE.stair.min[1] - 0.15,
}

/** Telecom room door in the hall's west wall (z centre of SERVICE.TC). */
export const TC_DOOR_Z = 8.6

export const HALL = { x0: CORE.hall.min[0], x1: CORE.hall.max[0], z0: CORE.hall.min[1] + 0.15, z1: ST.wallZ0 }
export const LOBBY = { x0: CORE.liftLobby.min[0], x1: CORE.liftLobby.max[0] - 0.02, z0: CORE.liftLobby.min[1], z1: 19.45 }

const PLANT: Band[] = [[0, 99, "concrete_wall"]]

const stairBands: Band[] = [
  [0, 1.05, M.enamel],
  [1.05, 1.13, "tile_green_dark"],
  [1.13, 99, "painted_wall"],
]

export function buildSlabs(b: Builder) {
  const { x0, x1, z0, z1 } = SHELL
  // Holes: the stairwell (with its walls) and the lift shaft. The lift lobby keeps its slab.
  const rects: [number, number, number, number][] = [
    [x0, z0, x1, ST.wallZ0],
    [x0, ST.wallZ0, -43.25, z1],
    [LOBBY.x0, ST.z0, VEST.x1, LOBBY.z1],
    [-36.15, ST.wallZ0, x1, z1],
  ]
  for (let i = 1; i <= STOREYS; i++) {
    b.storey = i
    const top = i === STOREYS ? FLOOR_Y - 0.11 : FLOOR_Y - 0.01
    for (const [a, c, d, e] of rects) {
      b.box("concrete_dark", a, top - 0.3, c, d, top, e, { cast: false, skip: "Y" })
      if (i < STOREYS) b.walk(a, c, d, e, top)
    }
  }
  b.storey = 0
}

export async function buildCore(b: Builder, pause: () => Promise<void>) {
  for (let i = 0; i <= STOREYS; i++) {
    await pause()
    b.storey = i
    landing(b, i)
    if (i === STOREYS) continue
    flights(b, i)
    stairWalls(b, i)
    hall(b, i)
    lobby(b, i)
  }
  b.storey = 0
}

/** Storey landing (and on the roof, the top landing in the core tower). */
function landing(b: Builder, i: number) {
  const y = FLOOR_Y
  const roof = i === STOREYS
  const xEast = roof ? -38.9 : ST.x1
  const zEast = ST.zFlight + GOING
  b.box("concrete_floor", ST.x0 + IN, y - 0.25, ST.z0 + IN, ST.wellX0, y, ST.zFlight)
  b.box("concrete_floor", ST.wellX0, y - 0.25, ST.z0 + IN, roof ? xEast : xEast - IN, y, zEast)
  b.walk(ST.x0, ST.z0, ST.wellX0, ST.zFlight, y)
  b.walk(ST.wellX0, ST.z0, xEast, zEast, y)
  // Edge nosings along the drop into the flights below.
  b.box(M.darkSteel, ST.x0, y - 0.03, ST.zFlight - 0.04, ST.wellX0, y + 0.003, ST.zFlight + 0.003)
  // Storey number stencilled on the west wall (G, 1..4, ROOF).
  addDocuments(b, [{ id: `stencil_storey_${i}` as DocumentId, position: [ST.x0, y + 1.75, 17.4], normal: [1, 0, 0], pin: "none", curl: 0 }])
  if (roof) {
    lightBulkhead(b, -42.3, y + 2.4, ST.z0 + 0.07, 0, true)
    // No flight continues up from the roof landing: guard its open edge over the storey-4 west flight (pipe rail,
    // mid rail and balusters, meeting the well return), with a collider to rail height.
    const z = ST.zFlight + 0.03
    const xa = ST.x0 + 0.06
    const xb = ST.wellX0 - 0.03
    b.rod(M.darkSteel, [xa, y + 1.0, z], [xb, y + 1.0, z], 0.021)
    b.rod(M.darkSteel, [xa, y + 0.5, z], [xb, y + 0.5, z], 0.012)
    for (let x = xa; x <= xb + 1e-3; x += (xb - xa) / Math.max(1, Math.round((xb - xa) / 0.55))) b.rod(M.darkSteel, [x, y, z], [x, y + 1.0, z], 0.014, 8)
    b.collide(ST.x0, y, ST.zFlight, ST.wellX0, y + 1.1, ST.zFlight + 0.06)
    return
  }
  // Bulkhead light over the door, emergency twin-head on the west wall.
  lightBulkhead(b, -42.4, y + 2.45, ST.z0 + 0.07, 0, true)
  emergency(b, ST.x0, y + 2.3, 18.2, i === 4 || NIGHT_EXTRA.emergency)
}

/** Two flights and the mid landing from storey i up to storey i + 1. */
function flights(b: Builder, i: number) {
  const y0 = FLOOR_Y
  const W = [ST.x0, ST.wellX0] as const
  const E = [ST.wellX1, ST.x1] as const
  // West flight: 10 treads south, then the mid landing (11th riser).
  for (let k = 1; k <= 10; k++) {
    const za = ST.zFlight + (k - 1) * GOING
    step(b, W[0], W[1], za, za + GOING, y0 + k * RISE, 1)
  }
  const yMid = y0 + 11 * RISE
  b.box("concrete_floor", ST.x0 + IN, yMid - 0.22, ST.zMid, ST.x1 - IN, yMid, ST.z1 - IN)
  b.walk(ST.x0, ST.zMid, ST.x1, ST.z1, yMid)
  b.box(M.darkSteel, ST.wellX1, yMid - 0.03, ST.zMid - 0.003, ST.x1, yMid + 0.003, ST.zMid + 0.04)
  // East flight: 9 treads north, arriving at the next storey's landing.
  for (let j = 1; j <= 9; j++) {
    const zb = ST.zMid - (j - 1) * GOING
    step(b, E[0], E[1], zb - GOING, zb, yMid + j * RISE, -1)
  }
  // Sloped soffits and the open-side stringers.
  soffit(b, W[0], W[1], ST.zFlight, ST.zMid, y0 - 0.2, y0 + 10 * RISE - 0.2)
  soffit(b, E[0], E[1], ST.zMid, ST.zFlight + GOING, yMid - 0.2, yMid + 9 * RISE - 0.2)
  // Well guard: no stepping across from one flight to the other.
  b.collide(ST.wellX0 - 0.02, y0, ST.zFlight, ST.wellX1 + 0.02, y0 + STOREY_H, ST.zMid)
  railings(b, yMid)
  midLight(b, i, yMid)
}

/** Treads and landings stop 5 mm short of the wall faces (flush, their ends fought the linings). */
const IN = 0.005
const inX0 = (x: number) => (x <= ST.x0 + 1e-3 ? x + IN : x)
const inX1 = (x: number) => (x >= ST.x1 - 1e-3 ? x - IN : x)

function step(b: Builder, x0: number, x1: number, z0: number, z1: number, top: number, dir: 1 | -1) {
  b.box("concrete_floor", inX0(x0), top - RISE - 0.02, z0, inX1(x1), top, z1, { skip: "y" })
  const front = dir > 0 ? z0 : z1
  // Nosing 3 mm proud of the riser face (flush, it fought the riser).
  const nz0 = dir > 0 ? front - 0.003 : front - 0.045
  const nz1 = dir > 0 ? front + 0.045 : front + 0.003
  b.box(M.darkSteel, x0 + 0.03, top - 0.025, nz0, x1 - 0.03, top + 0.003, nz1, { cast: false })
  b.walk(x0, z0, x1, z1, top)
}

function soffit(b: Builder, x0: number, x1: number, za: number, zb: number, ya: number, yb: number) {
  const len = Math.hypot(zb - za, yb - ya)
  const pitch = Math.atan2(yb - ya, zb - za)
  const m = T((x0 + x1) / 2, (ya + yb) / 2, (za + zb) / 2, 0, -pitch)
  // 3 mm narrower than the flight each side: flush, its sides fought the treads' side faces.
  b.boxM("concrete_wall", m, x1 - x0 - 0.006, 0.16, len, 0, 0, 0)
}

/** Steel pipe handrails: wall rails on brackets and the guard round the well with balusters. */
function railings(b: Builder, yMid: number) {
  const y0 = FLOOR_Y
  const H = 0.9
  const r = 0.021
  const pipe = M.darkSteel
  // Rail height follows the nosing line.
  const westY = (z: number) => y0 + H + RISE * ((z - ST.zFlight) / GOING + 1)
  const eastY = (z: number) => yMid + H + RISE * ((ST.zMid - z) / GOING + 1)
  const wall = (x: number, za: number, zb: number, f: (z: number) => number) => {
    b.rod(pipe, [x, f(za), za], [x, f(zb), zb], r)
    for (let z = za + 0.3; z < zb; z += 1.2) b.rod(pipe, [x, f(z), z], [x + (x < -42 ? -0.07 : 0.07), f(z) - 0.06, z], 0.008, 6)
  }
  wall(ST.x0 + 0.08, ST.zFlight, ST.zMid, westY)
  wall(ST.x1 - 0.08, ST.zFlight + GOING, ST.zMid, eastY)
  for (const [x, f, za, zb] of [
    [ST.wellX0 - 0.03, westY, ST.zFlight, ST.zMid],
    [ST.wellX1 + 0.03, eastY, ST.zFlight + GOING, ST.zMid],
  ] as const) {
    b.rod(pipe, [x, f(za), za], [x, f(zb), zb], r)
    b.rod(pipe, [x, f(za) - 0.45, za], [x, f(zb) - 0.45, zb], 0.012)
    for (let z = za; z <= zb + 1e-3; z += GOING * 2) b.rod(pipe, [x, f(z) - H + 0.02, z], [x, f(z), z], 0.011, 6)
  }
  // Return round the end of the well at the mid landing and the storey landing above.
  b.rod(pipe, [ST.wellX0 - 0.03, westY(ST.zMid), ST.zMid], [ST.wellX1 + 0.03, eastY(ST.zMid), ST.zMid], r)
  b.rod(pipe, [ST.wellX0 - 0.03, y0 + STOREY_H + H, ST.zFlight], [ST.wellX1 + 0.03, y0 + STOREY_H + H, ST.zFlight], r)
  b.rod(pipe, [ST.wellX1 + 0.03, y0 + STOREY_H + H, ST.zFlight], [ST.wellX1 + 0.03, eastY(ST.zFlight + GOING), ST.zFlight + GOING], r)
}

/** Top of the walls that continue into the roof-level stair house and lift headhouse (embedded 2 cm into the
 *  facility tower's roof slab, whose underside is at 23.1). */
export const HEAD_TOP = ROOF_Y + 3.97
/** World height where the facility's stair-house walls start: storey-4 core walls stop just under it. */
const HOUSE_Y = ROOF_Y - 0.31
/** Lift lobby / vestibule plan (cased opening from the vestibule into the lobby). */
export const VEST = { x0: -42.0, x1: -36.32, z0: 13.6, z1: ST.wallZ0, chaseCap: 13.45 }
export const LOBBY_OPENING = { x0: -39.45, x1: -36.37, head: 2.5 }

/** Local wall extents for storey i: from under the slab to under the next one (storey 4: under the stair house). */
const ext = (b: Builder, i: number, toRoof = false) => ({
  y0: FLOOR_Y - 0.26,
  y1: i < STOREYS - 1 ? FLOOR_Y + STOREY_H - 0.26 : (toRoof ? HEAD_TOP : HOUSE_Y) - b.oy,
})

/**
 * Stairwell walls. One wall per line, two layers where the faces differ, every joint butted (no doubled linings):
 * west wall (inside the main block; a 2 cm lining over the facility tower's wall beyond z 21.65), back lining with the
 * tower slot, the stair/lift wall (stair face | lobby face to z 19.45, shaft face beyond; on storey 4 it continues to
 * the headhouse top south of the roof landing), and the north line (stair door, then the cased lobby opening).
 */
function stairWalls(b: Builder, i: number) {
  const e = ext(b, i)
  const er = ext(b, i, true)
  const st = STYLES[i]!
  const top = i === STOREYS - 1
  // Walls meet on centre lines (the joint resolver closes the corners).
  wall(b, "z", (ST.wallZ0 + ST.z0) / 2, 21.65, -43.25, ST.x0, stairBands, [], e)
  wall(b, "z", 21.65, ST.z1, -43.1, ST.x0, stairBands, [], e)
  // Back lining over the tower's south wall (inner face z 24.85), cut for the glazed slot.
  wall(b, "x", -43.09, -39.6, ST.z1, 24.85, stairBands, [{ a0: -40.27, a1: -39.6, bottom: 0.84, top: 2.66 }], top ? er : e)
  b.collide(-40.27, e.y0, ST.z1, -39.6, (top ? er : e).y1, 24.85)
  // Stair / lift wall x −39.7..−39.5.
  if (top) {
    wall(b, "z", ST.z0, ST.zFlight + GOING, -39.7, -39.6, stairBands, [], e)
    wall(b, "z", ST.zFlight + GOING, 24.85, -39.7, -39.6, stairBands, [], er)
    wall(b, "z", ST.z0, ST.zFlight + GOING, -39.6, -39.5, st.bands, [], { ...e, collide: false })
    wall(b, "z", ST.zFlight + GOING, LOBBY.z1, -39.6, -39.5, st.bands, [], { ...er, collide: false })
    wall(b, "z", LOBBY.z1, 24.85, -39.6, -39.5, PLANT, [], { ...er, collide: false })
  } else {
    wall(b, "z", ST.z0, 24.85, -39.7, -39.6, stairBands, [], e)
    wall(b, "z", ST.z0, LOBBY.z1, -39.6, -39.5, st.bands, [], { ...e, collide: false })
    wall(b, "z", LOBBY.z1, 24.85, -39.6, -39.5, PLANT, [], { ...e, collide: false })
  }
  // North line z 16.05..16.2: hall/vestibule face in the storey finish, stair face enamel; the stair door; the cased
  // lift-lobby opening (lobby face in the storey finish too, so the finish turns the corner).
  const mid = (ST.wallZ0 + ST.z0) / 2
  const door = doorOpening(ST.door)
  wall(b, "x", (-43.25 + ST.x0) / 2, -39.6, ST.wallZ0, mid, st.bands, [door], e)
  wall(b, "x", (-43.25 + ST.x0) / 2, -39.6, mid, ST.z0, stairBands, [door], { ...e, collide: false })
  const op = { a0: LOBBY_OPENING.x0, a1: LOBBY_OPENING.x1, top: LOBBY_OPENING.head }
  wall(b, "x", -39.6, VEST.x1, ST.wallZ0, ST.z0, st.bands, [op], e)
  // Steel casing round the lobby opening (jambs, head, both faces), threshold strip.
  const ca = 0.05
  const cz0 = ST.wallZ0 - 0.012
  const cz1 = ST.z0 + 0.012
  for (const x of [LOBBY_OPENING.x0, LOBBY_OPENING.x1 - ca]) b.box(M.frame, x, FLOOR_Y, cz0, x + ca, FLOOR_Y + LOBBY_OPENING.head, cz1)
  b.box(M.frame, LOBBY_OPENING.x0, FLOOR_Y + LOBBY_OPENING.head - ca, cz0, LOBBY_OPENING.x1, FLOOR_Y + LOBBY_OPENING.head, cz1)
  b.box(M.darkSteel, LOBBY_OPENING.x0 + ca, FLOOR_Y - 0.02, ST.wallZ0, LOBBY_OPENING.x1 - ca, FLOOR_Y + LAYER, ST.z0, { cast: false })
  b.walk(LOBBY_OPENING.x0, ST.wallZ0 - 0.02, LOBBY_OPENING.x1, ST.z0 + 0.02)
  // Threshold through the stair door (the slab is cut for the stairwell here).
  b.box(M.darkSteel, ST.door - 0.55, FLOOR_Y - 0.02, ST.wallZ0 - 0.01, ST.door + 0.55, FLOOR_Y + 0.002, ST.z0 + 0.01, { cast: false })
  b.walk(ST.door - 0.55, ST.wallZ0 - 0.02, ST.door + 0.55, ST.z0 + 0.02)
  doorway(b, { x: ST.door, z: mid, rot: Math.PI, id: "STAIR", state: i === 3 ? "closed" : "open", open: i === 3 ? 0 : 0.7, wallT: ST.z0 - ST.wallZ0, sign: { number: `S-${i}`, label: "STAIR" } })
}

/** Caged bulkhead light (wall-mounted, lens facing out along `yaw`). */
function lightBulkhead(b: Builder, x: number, y: number, z: number, yaw: number, lit: boolean) {
  const m = T(x, y, z, yaw)
  b.rbox(M.darkSteel, m, 0.3, 0.2, 0.06, 0.02, 0, 0, 0.0)
  b.cyl(lit ? M.bulbCool : M.hazardOff, m.clone().multiply(T(0, 0, 0.05, 0, Math.PI / 2)), 0.085, 0.09, 0.06, 16, { cast: false })
  for (let k = -1; k <= 1; k++) b.boxM(M.darkSteel, m, 0.012, 0.2, 0.012, k * 0.06, 0, 0.09)
  b.boxM(M.darkSteel, m, 0.2, 0.012, 0.012, 0, 0, 0.09)
  if (lit) b.lamp({ kind: "fluorescent", position: [x, y - 0.05, z + 0.25], color: TUBE, intensity: 6, range: 7, size: 0.18 })
}

function emergency(b: Builder, xWall: number, y: number, z: number, on: boolean) {
  const m = T(xWall + 0.06, y, z, Math.PI / 2)
  b.rbox(M.beige, m, 0.34, 0.16, 0.12, 0.015)
  for (const s of [-1, 1]) {
    const h = m.clone().multiply(T(s * 0.12, 0.12, 0.03, 0, -0.5))
    b.cyl(M.beige, h, 0.035, 0.045, 0.07, 12)
    b.cyl(on ? M.bulbWarm : M.diffuserOff, h.clone().multiply(T(0, 0.036, 0)), 0.03, 0.03, 0.005, 12, { cast: false })
  }
  if (on) b.lamp({ kind: "incandescent", position: [xWall + 0.25, y + 0.1, z], direction: [0.6, -0.8, 0], color: [1, 0.8, 0.55], intensity: 2.5, range: 6, angle: 0.8, penumbra: 0.6, size: 0.06 })
}

/** Light on the mid-landing wall; one is dead, its lens smashed on the landing with the rubbish nobody swept up. */
function midLight(b: Builder, i: number, yMid: number) {
  const x = -40.75
  const z = ST.z1 - 0.07
  const dead = i === 2
  lightBulkhead(b, x, yMid + 2.15, z, Math.PI, !dead)
  if (!dead) return
  let s = 41
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647)
  for (let k = 0; k < 14; k++) {
    const px = x + (rnd() - 0.5) * 1.6
    const pz = z - 0.2 - rnd() * 1.5
    b.boxM(M.glass, T(px, yMid + 0.004, pz, rnd() * 6), 0.03 + rnd() * 0.05, 0.004, 0.02 + rnd() * 0.04)
  }
  for (let k = 0; k < 7; k++) {
    const px = ST.x0 + 0.3 + rnd() * 2.8
    const pz = ST.zMid + 0.4 + rnd() * 2.8
    const rot = rnd() * 6
    void rnd()
    void rnd()
    addDocuments(b, [{ id: (["envelope_interoffice", "memo_coffee", "note_repeated"] as const)[k % 3], position: [px, yMid, pz], normal: [0, 1, 0], rotation: rot }])
  }
  b.cyl(M.diffuserOff, T(x + 0.5, yMid + 0.02, z - 0.7, 0.4, 0, Math.PI / 2 - 0.2), 0.085, 0.09, 0.06, 16)
  b.cyl(M.steel, T(-40.4, yMid + 0.035, 23.2, 1.1, 0, Math.PI / 2), 0.032, 0.032, 0.11, 12)
}

/** Hall from the corridor to the stair door and lift lobby. */
function hall(b: Builder, i: number) {
  const { x0, x1, z0, z1 } = HALL
  const style = STYLES[i]!
  b.floor(style.floor, x0, z0, x1, VEST.z0)
  b.walk(x0, z0 - 0.15, x1, z0)
  // Vestibule at the hall's north end, widened east to the lift lobby (the north end of the old chase).
  b.floor(style.floor, VEST.x0, VEST.z0, VEST.x1, VEST.z1)
  const sy = FLOOR_Y + LAYER
  // Hall stripes start where the corridor's edge stripe stops (ground floor) and run to the stair wall.
  if (i === 0) for (const x of [x0 + 0.42, x1 - 0.42]) b.box(M.stripe, x - 0.05, sy - 0.01, z0 - 0.62, x + 0.05, sy, z1 - 0.1, { cast: false })
  // West wall: the telecom room TC-n's door (service stack, keycard "comms").
  wall(b, "z", z0, z1, x0 - 0.15, x0, style.bands, [doorOpening(TC_DOOR_Z)])
  doorway(b, { x: x0 - 0.075, z: TC_DOOR_Z, rot: Math.PI / 2, id: "TC", state: "keycard:comms", sign: { number: `TC-${i}`, label: "TELECOM" } })
  wall(b, "z", z0, VEST.z0, x1, x1 + 0.15, style.bands)
  // Chase cap (vestibule face finished) and the vestibule / lobby east wall, one line to the shaft.
  wall(b, "x", x1 + 0.15, VEST.x1, VEST.chaseCap, VEST.chaseCap + 0.075, PLANT)
  wall(b, "x", x1 + 0.15, VEST.x1, VEST.chaseCap + 0.075, VEST.z0, style.bands, [], { y0: FLOOR_Y - 0.01, y1: CEIL_Y + 0.02, collide: false })
  wall(b, "z", VEST.chaseCap + 0.075, LOBBY.z1, VEST.x1, -36.15, style.bands, [], ext(b, i))
  ceiling(b, x0, z0 - 0.15, x1, VEST.z0, style.missing * 0.5, 90 + i)
  ceiling(b, VEST.x0, VEST.z0, VEST.x1, VEST.z1, style.missing * 0.5, 95 + i)
  const dead = i === 4
  for (const z of [3.6, 7.2, 10.8]) troffer(b, -40.2, z, z === 7.2 && !dead ? "on" : "off", PANEL_ON)
  troffer(b, -39.0, 14.4, dead ? "off" : "on", PANEL_ON)
  if (!dead) b.lamp({ kind: "fluorescent", position: [-39.0, CEIL_Y + 0.1, 14.4], direction: [0, -1, 0], color: TUBE, intensity: 4, range: 7, angle: 1.3, penumbra: 0.7, size: 1.2 })
  if (!dead) b.lamp({ kind: "fluorescent", position: [-40.2, CEIL_Y + 0.1, 7.2], direction: [0, -1, 0], color: TUBE, intensity: 4, range: 7, angle: 1.3, penumbra: 0.7, size: 1.2 })
  // Floor plan holder and a fire extinguisher by the stair door.
  b.rbox(M.frame, T(x0 + 0.02, FLOOR_Y + 1.5, 13.4, Math.PI / 2), 0.5, 0.36, 0.02, 0.006)
  addDocuments(b, [{ id: `map_evac_${i}` as DocumentId, position: [x0 + 0.029, FLOOR_Y + 1.5, 13.4], normal: [1, 0, 0], pin: "none", curl: 0, size: [0.44, 0.3] }])
  b.cyl(M.red, T(x0 + 0.1, FLOOR_Y + 0.55, 15.3), 0.075, 0.075, 0.5, 14)
  b.cyl(M.darkSteel, T(x0 + 0.1, FLOOR_Y + 0.85, 15.3), 0.03, 0.05, 0.1, 10)
}

function lobby(b: Builder, i: number) {
  const { x0, x1, z0, z1 } = LOBBY
  const style = STYLES[i]!
  // Same floor finish as the hall and vestibule; the shaft's front wall (with the landing doors and call button) is
  // the lift module's, the side walls are the stair/lift wall and the vestibule/lobby east wall.
  b.floor(style.floor, x0, z0, x1, z1)
  ceiling(b, x0, ST.wallZ0, x1, z1, style.missing * 0.5, 97 + i)
  const on = i !== 4
  troffer(b, -37.8, 18, on ? "on" : "off", PANEL_ON)
  if (on) b.lamp({ kind: "fluorescent", position: [-37.8, CEIL_Y + 0.1, 18], direction: [0, -1, 0], color: TUBE, intensity: 4, range: 7, angle: 1.3, penumbra: 0.7, size: 1.2 })
}
