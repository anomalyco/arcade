import { BUILDING, CORE } from "../layout"
import { STYLES } from "./styles"
import { TUBE, type Band, type Builder, CEIL_Y, DOOR_W, FLOOR_Y, M, PANEL_ON, STOREY_H, T, ceiling, corridorBands, door, doorOpening, troffer, wall, LAYER } from "./kit"

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

export const HALL = { x0: CORE.hall.min[0], x1: CORE.hall.max[0], z0: CORE.hall.min[1] + 0.15, z1: ST.wallZ0 }
export const LOBBY = { x0: CORE.liftLobby.min[0], x1: CORE.liftLobby.max[0] - 0.02, z0: CORE.liftLobby.min[1], z1: 19.45 }

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
    [LOBBY.x0, ST.wallZ0, -36.15, LOBBY.z1],
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
  b.box("concrete_floor", ST.x0, y - 0.25, ST.z0, ST.wellX0, y, ST.zFlight)
  b.box("concrete_floor", ST.wellX0, y - 0.25, ST.z0, xEast, y, zEast)
  b.walk(ST.x0, ST.z0, ST.wellX0, ST.zFlight, y)
  b.walk(ST.wellX0, ST.z0, xEast, zEast, y)
  // Edge nosings along the drop into the flights below.
  b.box(M.darkSteel, ST.x0, y - 0.03, ST.zFlight - 0.04, ST.wellX0, y + 0.003, ST.zFlight + 0.003)
  // Storey number: i + 1 painted bars on the west wall, abstract (no readable figures).
  const zc = 17.4
  for (let k = 0; k <= i; k++) {
    const z = zc - (i * 0.13) / 2 + k * 0.13
    b.box(M.stencil, ST.x0, y + 1.45, z - 0.04, ST.x0 + 0.004, y + 2.05, z + 0.04, { cast: false })
  }
  b.box(M.stencil, ST.x0, y + 1.32, zc - 0.5, ST.x0 + 0.004, y + 1.37, zc + 0.5, { cast: false })
  if (roof) {
    lightBulkhead(b, -42.3, y + 2.4, ST.z0 + 0.07, 0, true)
    return
  }
  // Bulkhead light over the door, emergency twin-head on the west wall.
  lightBulkhead(b, -42.4, y + 2.45, ST.z0 + 0.07, 0, true)
  emergency(b, ST.x0, y + 2.3, 18.2, i === 4)
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
  b.box("concrete_floor", ST.x0, yMid - 0.22, ST.zMid, ST.x1, yMid, ST.z1)
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

function step(b: Builder, x0: number, x1: number, z0: number, z1: number, top: number, dir: 1 | -1) {
  b.box("concrete_floor", x0, top - RISE - 0.02, z0, x1, top, z1, { skip: "y" })
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

function stairWalls(b: Builder, i: number) {
  const ext = { y0: FLOOR_Y - 0.26, y1: FLOOR_Y + STOREY_H - 0.26 }
  wall(b, "z", ST.wallZ0, ST.z1 + 0.14, -43.25, ST.x0, stairBands, [], ext)
  // South wall, open where the tower's glazed slot looks in on the mid landing.
  wall(b, "x", -43.25, -39.5, ST.z1, ST.z1 + 0.14, stairBands, [{ a0: -40.27, a1: -39.5, bottom: 0.84, top: 2.66 }], ext)
  b.collide(-40.27, ext.y0, ST.z1, -39.5, ext.y1, ST.z1 + 0.14)
  wall(b, "z", ST.wallZ0, ST.z1 + 0.14, ST.x1, -39.5, stairBands, [], ext)
  // North wall: corridor tile on the hall side is the hall's; this is the stair side, with the door.
  wall(b, "x", -43.25, ST.x1, ST.wallZ0, ST.z0, stairBands, [doorOpening(ST.door)], ext)
  // Threshold through the wall thickness (the slab is cut for the stairwell here).
  b.box(M.darkSteel, ST.door - 0.55, FLOOR_Y - 0.02, ST.wallZ0 - 0.01, ST.door + 0.55, FLOOR_Y + 0.002, ST.z0 + 0.01, { cast: false })
  b.walk(ST.door - 0.55, ST.wallZ0 - 0.02, ST.door + 0.55, ST.z0 + 0.02)
  door(b, ST.door, ST.wallZ0 + 0.075, { rot: Math.PI, open: i === 3 ? 0 : 0.7 })
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
    b.quad(M.paper, T(px, yMid + 0.003 + k * 0.0004, pz, rnd() * 6, -Math.PI / 2), 0.21 * (0.6 + rnd() * 0.4), 0.28 * (0.5 + rnd() * 0.5), { cast: false })
  }
  b.cyl(M.diffuserOff, T(x + 0.5, yMid + 0.02, z - 0.7, 0.4, 0, Math.PI / 2 - 0.2), 0.085, 0.09, 0.06, 16)
  b.cyl(M.steel, T(-40.4, yMid + 0.035, 23.2, 1.1, 0, Math.PI / 2), 0.032, 0.032, 0.11, 12)
}

/** Hall from the corridor to the stair door and lift lobby. */
function hall(b: Builder, i: number) {
  const { x0, x1, z0, z1 } = HALL
  const style = STYLES[i]!
  b.floor(style.floor, x0, z0, x1, z1)
  b.walk(x0, z0 - 0.15, x1, z0)
  const sy = FLOOR_Y + LAYER
  // Hall stripes start where the corridor's edge stripe stops (ground floor) and run to the stair wall.
  if (i === 0) for (const x of [x0 + 0.42, x1 - 0.42]) b.box(M.stripe, x - 0.05, sy - 0.01, z0 - 0.62, x + 0.05, sy, z1 - 0.1, { cast: false })
  wall(b, "z", z0, z1, x0 - 0.15, x0, style.bands)
  wall(b, "z", z0, z1, x1, x1 + 0.15, style.bands)
  // Hall face of the stair wall, either side of the door.
  wall(b, "x", x0, LOBBY.x0, z1 - 0.012, z1, style.bands, [doorOpening(ST.door, DOOR_W)], { y0: FLOOR_Y - 0.01, y1: CEIL_Y + 0.02, collide: false })
  ceiling(b, x0, z0 - 0.15, x1, z1, style.missing * 0.5, 90 + i)
  const dead = i === 4
  for (const z of [3.6, 7.2, 10.8, 14.4]) troffer(b, -40.2, z, z === 7.2 && !dead ? "on" : "off", PANEL_ON)
  if (!dead) b.lamp({ kind: "fluorescent", position: [-40.2, CEIL_Y + 0.1, 7.2], direction: [0, -1, 0], color: TUBE, intensity: 4, range: 7, angle: 1.3, penumbra: 0.7, size: 1.2 })
  // Floor plan holder and a fire extinguisher by the stair door.
  b.rbox(M.frame, T(x0 + 0.02, FLOOR_Y + 1.5, 13.4, Math.PI / 2), 0.5, 0.36, 0.02, 0.006)
  b.quad(M.paper, T(x0 + 0.032, FLOOR_Y + 1.5, 13.4, Math.PI / 2), 0.44, 0.3, { cast: false })
  b.cyl(M.red, T(x0 + 0.1, FLOOR_Y + 0.55, 15.3), 0.075, 0.075, 0.5, 14)
  b.cyl(M.darkSteel, T(x0 + 0.1, FLOOR_Y + 0.85, 15.3), 0.03, 0.05, 0.1, 10)
}

function lobby(b: Builder, i: number) {
  const { x0, x1, z0, z1 } = LOBBY
  b.floor("terrazzo", x0, z0, x1, z1)
  b.floor("terrazzo", x0, ST.wallZ0, HALL.x1 + 0.15, z0)
  // North wall (lobby/room), east wall, and the lobby face of the shaft wall (the lift module cuts the doors).
  wall(b, "x", HALL.x1 + 0.15, -36.15, ST.wallZ0, z0, STYLES[i]!.bands)
  wall(b, "z", ST.wallZ0, z1, x1, -36.15, STYLES[i]!.bands)
  ceiling(b, x0, ST.wallZ0, x1, z1)
  troffer(b, -37.8, 18, i === 4 ? "off" : "on", PANEL_ON)
}
