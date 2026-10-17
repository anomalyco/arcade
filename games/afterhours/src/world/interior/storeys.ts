import * as THREE from "three/webgpu"
import { atan, float, fract, mix, positionWorld, sin, smoothstep, step, uv, vec3 } from "three/tsl"
import type { Lamp } from "../context"
import { materialFor } from "../../render/materials"
import { FIRE_ESCAPE } from "../layout"
import {
  type Band,
  Builder,
  CEIL_Y,
  DOOR_H,
  FLOOR_Y,
  M,
  PANEL_ON,
  T,
  ceiling,
  corridorBands,
  door,
  doorOpening,
  flicker,
  fluorescentPanel,
  paint,
  troffer,
  wall,
} from "./kit"
import { HALL, SHELL } from "./core"
import { bulletin, extinguisher, fluoro, fountain, hazardLight, rigLevel } from "./corridor"
import { furnish, flushModels } from "./furnish"

// Storeys 1–4: the same double-loaded corridor the full length of the block, rooms between the facade's window piers
// running back to the exterior wall, each storey with its own trade: 1 offices, 2 labs, 3 records and the computer
// room, 4 half-abandoned. Every room has real contents (the facade glass shows them); a few are open, the rest shut.

export type Theme = "offices" | "labs" | "records" | "abandoned"
export const THEMES: Record<number, Theme> = { 1: "offices", 2: "labs", 3: "records", 4: "abandoned" }

export type Room = {
  side: 1 | -1
  /** Interior extents along x. */
  x0: number
  x1: number
  /** Usable x range at the window end (south rooms beside the core are notched). */
  wx0: number
  wx1: number
  door: number
  win: number | null
  enter: boolean
  lit: boolean
  index: number
}

/** Corridor wall room-side face and exterior lining face (|z|). */
export const ZC = 1.75
export const ZW = 21.61
const PART = Array.from({ length: 15 }, (_, i) => Math.round((-53.2 + 5.4 * (i + 1)) * 100) / 100)
/** Partitions on the south side stop at the core hall (the hall walls take their place). */
const coreGap = (p: number) => p > HALL.x0 - 1 && p < HALL.x1 + 2
const WIN = Array.from({ length: 16 }, (_, i) => Math.round((-52.15 + 5.4 * i) * 100) / 100)
const WIN_W = 3.3
/** Window sill and head above the finished floor. */
export const SILL = 0.95 - FLOOR_Y
export const HEAD = 2.75 - FLOOR_Y
const CORE_X0 = -43.25
const CORE_X1 = -36.15
const CORE_Z = 16.05

const roomBands: Band[] = [
  [0, 0.1, M.rubber],
  [0.1, 99, "painted_wall"],
]

/** Open rooms (side, index) and lit rooms (side, any x inside the room): a scattering of late workers at 3 a.m.,
 *  including the south-east corner rooms of storeys 1–3 that face the lot and the access road. */
const PICKS: Record<number, { enter: [number, number][]; lit: [number, number][] }> = {
  1: { enter: [[-1, 2], [-1, 8], [1, 4], [1, 10]], lit: [[1, 31], [1, 4.5], [-1, 15], [1, -18]] },
  2: { enter: [[-1, 4], [-1, 10], [1, 3], [1, 12]], lit: [[1, 26], [-1, -50], [1, 10]] },
  3: { enter: [[-1, 5], [-1, 11], [1, 2], [1, 8]], lit: [[1, 31], [1, 20.5], [-1, 26], [1, -2]] },
  4: { enter: [[-1, 3], [-1, 7], [1, 5], [1, 9], [-1, 13]], lit: [] },
}

export function roomsFor(storey: number): Room[] {
  const picks = PICKS[storey]!
  const has = (list: [number, number][], side: number, i: number) => list.some(([s, k]) => s === side && k === i)
  const out: Room[] = []
  for (const side of [-1, 1] as const) {
    const bounds: [number, number][] = []
    const parts = side < 0 ? PART : PART.filter((p) => !coreGap(p))
    let x = SHELL.x0
    for (const p of parts) {
      bounds.push([x, p - 0.06])
      x = p + 0.06
    }
    bounds.push([x, SHELL.x1])
    if (side > 0) {
      // Rooms either side of the core hall end at the hall walls.
      const k = bounds.findIndex(([a]) => a > -48 && a < -47)
      bounds[k] = [bounds[k]![0], HALL.x0 - 0.15]
      bounds[k + 1] = [HALL.x1 + 0.15, bounds[k + 1]![1]]
    }
    bounds.forEach(([x0, x1], index) => {
      const win = WIN.find((a) => a >= x0 - 0.01 && a + WIN_W <= x1 + 0.01 && !(side > 0 && a + WIN_W > CORE_X0 - 0.1 && a < CORE_X1 + 0.1)) ?? null
      const enter = has(picks.enter, side, index)
      const litHere = picks.lit.some(([s, px]) => s === side && px >= x0 && px <= x1)
      out.push({
        side,
        x0,
        x1,
        wx0: side > 0 && x0 < CORE_X1 && x1 > CORE_X1 ? CORE_X1 : x0,
        wx1: side > 0 && x1 > CORE_X0 && x0 < CORE_X0 ? CORE_X0 : x1,
        door: x0 + 0.8,
        win,
        enter,
        lit: enter || litHere,
        index,
      })
    })
  }
  return out
}

/** Room-local to world: u along x, v depth from the corridor wall (0) towards the windows. */
export const rz = (r: Room, v: number) => r.side * (ZC + v)
export const DEPTH = ZW - ZC

/** Venetian blinds: horizontal slats from the world height, closed (opaque) or tilted open (light between slats). */
const blindMats = (() => {
  const make = (open: boolean) => {
    const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.6, side: THREE.DoubleSide })
    const f = fract(positionWorld.y.mul(40))
    const shade = mix(float(0.55), float(1), step(0.12, f))
    m.colorNode = vec3(0.62, 0.6, 0.53).mul(shade)
    if (open) {
      m.opacityNode = step(f, 0.62)
      m.alphaTest = 0.5
    }
    m.name = open ? "interior_blind_open" : "interior_blind"
    return m
  }
  return { closed: make(false), open: make(true) }
})()

/** Clear plastic sheeting, hung from the ceiling on storey 4. */
const plasticMat = materialFor("flat", { color: 0xd8dcd6, roughness: 0.25, transparent: 0.32, side: THREE.DoubleSide, name: "interior_plastic" })

/** Soft-edged floor and ceiling decals (water stains, puddles) with an irregular outline, in the quad's 0..1 UVs. */
const decal = (color: number, roughness: number, alpha: number, name: string) => {
  const m = new THREE.MeshStandardNodeMaterial({ color, roughness, transparent: true, depthWrite: false })
  const p = uv().sub(0.5).mul(2)
  const a = atan(p.y, p.x)
  const edge = sin(a.mul(3).add(1.3)).mul(0.12).add(sin(a.mul(7).add(0.4)).mul(0.06)).add(0.82)
  const d = p.length().div(edge)
  m.opacityNode = float(1).sub(smoothstep(0.55, 1, d)).mul(alpha)
  m.polygonOffset = true
  m.polygonOffsetFactor = -3
  m.polygonOffsetUnits = -3
  m.name = `interior_${name}`
  return m
}
const STAIN = decal(0x2e2518, 0.95, 0.7, "stain_decal")
const PUDDLE = decal(0x080908, 0.03, 0.85, "puddle_decal")

const CARPET = paint(0x3a3630, 0.97)
const RAISED = paint(0x8f918a, 0.55)

export async function buildStorey(b: Builder, storey: number, pause: () => Promise<void>) {
  const theme = THEMES[storey]!
  const rooms = roomsFor(storey)
  let seed = storey * 7919 + 13
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  const abandoned = theme === "abandoned"
  const flickers: { level: THREE.UniformNode<"float", number>; amount: number; seed: number; lamp: Lamp }[] = []

  // ---------------------------------------------------------------- corridor
  const x0 = SHELL.x0
  const x1 = SHELL.x1
  b.floor("linoleum", x0, -ZC, x1, ZC)
  const sy = FLOOR_Y + 0.0015
  const stripe = theme === "labs" ? paint(0x6a5a1c, 0.25) : theme === "records" ? paint(0x23324a, 0.22) : M.stripe
  for (const z of [-1.18, 1.18]) b.box(stripe, x0 + 0.4, sy - 0.01, z - 0.05, x1 - 0.4, sy, z + 0.05, { cast: false })
  const north = rooms.filter((r) => r.side < 0)
  const south = rooms.filter((r) => r.side > 0)
  wall(b, "x", x0, x1, -ZC, -1.6, corridorBands, north.map((r) => doorOpening(r.door)))
  wall(b, "x", x0, x1, 1.6, ZC, corridorBands, [...south.map((r) => doorOpening(r.door)), { a0: HALL.x0 - 0.15, a1: HALL.x1 + 0.15, top: DOOR_H + 0.35 }])
  wall(b, "z", -1.6, 1.6, x0, x0 + 0.04, corridorBands, [doorOpening(FIRE_ESCAPE.door.z, FIRE_ESCAPE.door.width)], { y0: FLOOR_Y - 0.01, y1: CEIL_Y + 0.02, collide: false })
  // East end: the facade has a window on the corridor axis from storey 2 up.
  wall(b, "z", -1.6, 1.6, x1 - 0.04, x1, corridorBands, storey >= 2 ? [{ a0: -1.6, a1: 1.6, bottom: SILL, top: HEAD }] : [], { y0: FLOOR_Y - 0.01, y1: CEIL_Y + 0.02, collide: false })
  // Fire exit onto the escape landing: push-bar door, opens inward, held open on the top storey.
  door(b, x0 - 0.175, FIRE_ESCAPE.door.z, { rot: Math.PI / 2, wallT: 0.35, width: FIRE_ESCAPE.door.width, open: storey === 4 ? -1.45 : -1.2, panic: true, glass: null, plate: false, wedge: storey === 4 })
  b.box(M.frame, x0 + 0.04, FLOOR_Y + DOOR_H + 0.25, -0.3, x0 + 0.15, FLOOR_Y + DOOR_H + 0.52, 0.3)
  b.box(M.exitSign, x0 + 0.15, FLOOR_Y + DOOR_H + 0.28, -0.27, x0 + 0.155, FLOOR_Y + DOOR_H + 0.49, 0.27, { cast: false })
  b.lamp({ kind: "exit", position: [x0 + 0.3, FLOOR_Y + DOOR_H + 0.38, 0], color: [1, 0.08, 0.04], intensity: 1, range: 3, size: 0.35 })

  ceiling(b, x0, -1.6, x1, 1.6, abandoned ? 0.22 : 0, storey, abandoned ? (x, z) => fallenTile(b, x, z, rnd) : undefined)
  const dead = new Set<number>()
  const flick = new Map<number, number>()
  for (let x = 33; x >= -51; x -= 3) {
    const r = rnd()
    if (abandoned ? r < 0.45 : r < 0.12) dead.add(x)
    else if (abandoned ? r < 0.62 : r < 0.18) flick.set(x, 0.6 + rnd() * 0.4)
  }
  let flickCount = 0
  for (let x = 33; x >= -51; x -= 3) {
    if (dead.has(x)) {
      troffer(b, x, 0, "off", PANEL_ON)
      continue
    }
    const f = flick.get(x)
    const real = (x - 33) % 6 === 0 || f !== undefined
    const lamp = real ? b.lamp(fluoro(x, 0, f)) : null
    if (f !== undefined && flickCount < 3 && lamp) {
      flickCount++
      const p = fluorescentPanel(1)
      flickers.push({ level: p.level, amount: f, seed: x + storey * 100, lamp })
      troffer(b, x, 0, { flicker: f, ...p }, PANEL_ON)
    } else troffer(b, x, 0, "on", PANEL_ON)
  }
  corridorDressing(b, storey, theme, rnd)

  // ---------------------------------------------------------------- rooms
  for (const p of PART) {
    wall(b, "z", -ZW, -ZC, p - 0.06, p + 0.06, roomBands)
    if (!coreGap(p)) wall(b, "z", ZC, ZW, p - 0.06, p + 0.06, roomBands)
  }
  for (const [ri, r] of rooms.entries()) {
    if (ri % 3 === 0) await pause()
    const zc = r.side * ZC
    const zw = r.side * ZW
    const records = theme === "records" && r.index % 2 === 1
    const floorMat = theme === "offices" ? CARPET : records ? RAISED : "linoleum"
    // Floor (notched rooms: full depth at the window end only where there is no core).
    if (r.wx0 === r.x0 && r.wx1 === r.x1) b.floor(floorMat, r.x0, Math.min(zc, zw), r.x1, Math.max(zc, zw))
    else {
      b.floor(floorMat, r.x0, Math.min(zc, r.side * CORE_Z), r.x1, Math.max(zc, r.side * CORE_Z))
      b.floor(floorMat, r.wx0, Math.min(r.side * CORE_Z, zw), r.wx1, Math.max(r.side * CORE_Z, zw))
    }
    if (records) raisedFloorGrid(b, r)
    // Exterior lining with the window, sill, radiator and blinds.
    const lz0 = r.side > 0 ? ZW : -SHELL.z1 * 1
    const lz1 = r.side > 0 ? SHELL.z1 : -ZW
    wall(b, "x", r.wx0, r.wx1, lz0, lz1, roomBands, r.win !== null ? [{ a0: r.win, a1: r.win + WIN_W, bottom: SILL, top: HEAD }] : [], { y0: FLOOR_Y - 0.01, y1: CEIL_Y + 0.02, collide: false })
    if (r.win !== null) windowDressing(b, r, rnd)
    // Ceiling and troffers.
    const missing = abandoned ? (r.enter ? 0.16 : 0.06) : 0
    const fall = abandoned ? (x: number, z: number) => fallenTile(b, x, z, rnd) : undefined
    if (r.wx0 === r.x0 && r.wx1 === r.x1) ceiling(b, r.x0, Math.min(zc, zw), r.x1, Math.max(zc, zw), missing, storey * 50 + r.index, fall)
    else {
      ceiling(b, r.x0, Math.min(zc, r.side * CORE_Z), r.x1, Math.max(zc, r.side * CORE_Z), missing, storey * 50 + r.index, fall)
      ceiling(b, r.wx0, Math.min(r.side * CORE_Z, zw), r.wx1, Math.max(r.side * CORE_Z, zw), missing, storey * 51 + r.index, fall)
    }
    const cx = (r.x0 + r.x1) / 2
    const cols = [Math.round((cx - 1.2) / 0.6) * 0.6, Math.round((cx + 1.2) / 0.6) * 0.6]
    const rows = [4.8, 8.4, 12, 15.6, 19.2]
    for (const tx of cols)
      for (const tz of rows) {
        if (tx - 0.31 < r.x0 || tx + 0.31 > r.x1) continue
        if (tz + 0.6 > CORE_Z && (tx - 0.31 < r.wx0 || tx + 0.31 > r.wx1)) continue
        const on = r.lit && (tz >= 12 || r.enter) && !(abandoned && rnd() < 0.5)
        troffer(b, tx, r.side * tz, on ? "on" : "off", PANEL_ON)
      }
    if (r.lit) for (const v of r.enter ? [7.2, 14.4] : [14.4]) b.lamp(fluoro(cols[v > 10 ? 1 : 0]!, rz(r, v), abandoned ? 0.8 : undefined, 30))
    door(b, r.door, r.side * (1.6 + 0.075), { rot: r.side < 0 ? 0 : Math.PI, open: r.enter ? 1.35 + rnd() * 0.25 : 0 })
    furnish(b, theme, r, rnd)
    if (abandoned) roomDecay(b, r, rnd)
  }
  flushModels(b)
  await pause()

  return {
    update(time: number) {
      for (const f of flickers) f.level.value = rigLevel(f.lamp) ?? flicker(time, f.seed, f.amount)
    },
  }
}

function windowDressing(b: Builder, r: Room, rnd: () => number) {
  const a = r.win!
  const s = r.side
  const zf = s * ZW
  // Sill board and a fin-tube radiator cover beneath.
  b.box(paint(0x8b8878, 0.6), a - 0.05, FLOOR_Y + SILL - 0.025, zf - s * 0.16, a + WIN_W + 0.05, FLOOR_Y + SILL + 0.005, zf + s * 0.02)
  const rm = T(a + WIN_W / 2, FLOOR_Y + 0.38, zf - s * 0.1)
  b.rbox(M.beige, rm, 2.2, 0.5, 0.14, 0.03)
  for (let k = 0; k < 22; k++) b.box(M.darkSteel, a + WIN_W / 2 - 1.0 + k * 0.095, FLOOR_Y + 0.6, zf - s * 0.15, a + WIN_W / 2 - 0.97 + k * 0.095, FLOOR_Y + 0.635, zf - s * 0.05, { cast: false })
  b.collide(a + WIN_W / 2 - 1.1, FLOOR_Y, Math.min(zf, zf - s * 0.2), a + WIN_W / 2 + 1.1, FLOOR_Y + 0.65, Math.max(zf, zf - s * 0.2))
  // Venetian blinds: lowered anywhere from a third to all the way, a few raised, some with the slats open.
  const r0 = rnd()
  const drop = r0 < 0.15 ? 0.06 : 0.35 + rnd() * 0.65
  const h = (HEAD - SILL) * drop
  const mat = rnd() < 0.4 ? blindMats.open : blindMats.closed
  const yTop = FLOOR_Y + HEAD - 0.02
  b.box(M.beige, a + 0.02, yTop - 0.04, zf - s * 0.07, a + WIN_W - 0.02, yTop, zf - s * 0.02, { cast: false })
  // One blind in five hangs crooked, a cord broken.
  const crooked = rnd() < 0.2 ? (rnd() - 0.5) * 0.12 : 0
  b.quad(mat, T(a + WIN_W / 2, yTop - 0.04 - h / 2, zf - s * 0.045, s > 0 ? Math.PI : 0, 0, crooked), WIN_W - 0.06, h, { cast: false })
  b.box(M.beige, a + 0.03, yTop - 0.06 - h, zf - s * 0.06, a + WIN_W - 0.03, yTop - 0.04 - h, zf - s * 0.03, { cast: false })
}

function raisedFloorGrid(b: Builder, r: Room) {
  const y = FLOOR_Y + 0.001
  const za = Math.min(r.side * ZC, r.side * CORE_Z)
  const zb = Math.max(r.side * ZC, r.side * CORE_Z)
  for (let x = Math.ceil(r.x0 / 0.6) * 0.6; x < r.x1; x += 0.6) b.box(M.darkSteel, x - 0.006, y - 0.01, za, x + 0.006, y, zb, { cast: false })
  for (let z = Math.ceil(za / 0.6) * 0.6; z < zb; z += 0.6) b.box(M.darkSteel, r.x0, y - 0.01, z - 0.006, r.x1, y, z + 0.006, { cast: false })
}

/** A ceiling tile on the floor: whole and skewed, or snapped in two. */
function fallenTile(b: Builder, x: number, z: number, rnd: () => number) {
  const y = FLOOR_Y
  const yaw = rnd() * Math.PI
  if (rnd() < 0.5) b.boxM("ceiling_tile", T(x + (rnd() - 0.5) * 0.6, y + 0.03, z + (rnd() - 0.5) * 0.6, yaw, (rnd() - 0.5) * 0.08, (rnd() - 0.5) * 0.25), 0.6, 0.02, 1.2)
  else
    for (const s of [-1, 1]) b.boxM("ceiling_tile", T(x + s * 0.35 * Math.cos(yaw), y + 0.015, z + s * 0.35 * Math.sin(yaw), yaw + (rnd() - 0.5) * 0.6, 0, (rnd() - 0.5) * 0.1), 0.55, 0.02, 0.6)
  for (let k = 0; k < 5; k++) b.box(M.debris, x + (rnd() - 0.5) * 1.2, y, z + (rnd() - 0.5) * 1.2, x + (rnd() - 0.5) * 1.2 + 0.04, y + 0.012, z + (rnd() - 0.5) * 1.2 + 0.03, { cast: false })
}

function corridorDressing(b: Builder, storey: number, theme: Theme, rnd: () => number) {
  // Same fittings as the ground floor, shuffled per storey.
  extinguisher(b, -20 + storey * 3.1, -1.6)
  extinguisher(b, 18 - storey * 2.3, -1.6)
  fountain(b, -24.6 + storey * 1.7, 1.6)
  if (theme !== "abandoned") bulletin(b, 3.5 - storey * 2, 1.6)
  hazardLight(b, -30 + storey, -1.6, false)
  hazardLight(b, 25 - storey, -1.6, theme === "abandoned")
  if (theme === "abandoned") b.lamp({ kind: "warning", position: [25 - storey, FLOOR_Y + 2.55, -1.4], color: [1, 0.12, 0.05], intensity: 1.5, range: 3, size: 0.12 })
  if (theme === "labs") safetyShower(b, 9.3, -1.6)
  if (theme === "abandoned") decayCorridor(b, rnd)
}

/** Emergency drench shower and eyewash on the corridor wall (labs storey). */
function safetyShower(b: Builder, x: number, zWall: number) {
  const z = zWall + 0.12
  b.rod(M.safety, [x, FLOOR_Y, z], [x, CEIL_Y - 0.2, z], 0.02, 10)
  b.rod(M.safety, [x, CEIL_Y - 0.2, z], [x, CEIL_Y - 0.2, z + 0.45], 0.02, 10)
  b.cyl(M.steel, T(x, CEIL_Y - 0.32, z + 0.48), 0.04, 0.13, 0.14, 18, { open: true })
  b.rod(M.steel, [x, CEIL_Y - 0.25, z + 0.3], [x, 1.7, z + 0.3], 0.003, 4)
  const ring = new THREE.TorusGeometry(0.05, 0.007, 6, 16)
  ring.translate(x, 1.65, z + 0.3)
  b.add(M.safety, ring)
  b.cyl(M.steel, T(x + 0.18, FLOOR_Y + 1.0, z + 0.05, 0, 0, 0), 0.1, 0.06, 0.08, 16, { open: true })
  b.box(paint(0x2a6a38, 0.5), x - 0.2, FLOOR_Y + 2.25, zWall, x + 0.2, FLOOR_Y + 2.55, zWall + 0.006, { cast: false })
  b.box(M.stencil, x - 0.08, FLOOR_Y + 2.33, zWall + 0.006, x + 0.08, FLOOR_Y + 2.47, zWall + 0.008, { cast: false })
  b.collide(x - 0.05, FLOOR_Y, z - 0.05, x + 0.05, CEIL_Y, z + 0.05)
}

/** Storey 4 corridor: ducts and dangling cable through the holes, a fixture hanging on its wires, plastic sheeting,
 *  puddles under the leaks. */
function decayCorridor(b: Builder, rnd: () => number) {
  const yd = CEIL_Y + 0.12
  b.box("metal_galvanized", SHELL.x0, yd, -0.9, SHELL.x1, yd + 0.32, -0.25)
  for (let x = SHELL.x0 + 1; x < SHELL.x1; x += 1.2) b.box(M.darkSteel, x, yd - 0.01, -0.95, x + 0.04, yd + 0.33, -0.2)
  b.rod(M.darkSteel, [SHELL.x0, yd + 0.4, 0.6], [SHELL.x1, yd + 0.4, 0.6], 0.04, 8)
  b.rod("metal_galvanized", [SHELL.x0, yd + 0.25, 0.95], [SHELL.x1, yd + 0.25, 0.95], 0.025, 8)
  for (let k = 0; k < 14; k++) {
    const x = SHELL.x0 + 3 + rnd() * 84
    const z = (rnd() - 0.5) * 2.4
    const len = 0.3 + rnd() * 1.1
    b.rod(M.rubber, [x, CEIL_Y + 0.05, z], [x + (rnd() - 0.5) * 0.2, CEIL_Y - len, z + (rnd() - 0.5) * 0.2], 0.006, 4)
  }
  // A troffer hanging on two wires at a steep angle.
  for (const x of [-9, 21.6]) {
    const m = T(x, CEIL_Y - 0.55, 0.2, 0.2, 0.15, 0.75)
    b.boxM(M.housing, m, 0.6, 0.08, 1.2)
    b.quad(M.diffuserOff, m.clone().multiply(T(0, -0.041, 0, 0, Math.PI / 2)), 0.56, 1.16, { cast: false })
    b.rod(M.rubber, [x - 0.25, CEIL_Y, 0.2], [x - 0.25, CEIL_Y - 0.33, 0.25], 0.004, 4)
    b.rod(M.rubber, [x + 0.25, CEIL_Y, 0.2], [x + 0.2, CEIL_Y - 0.75, 0.0], 0.004, 4)
  }
  // Plastic sheeting across half the corridor, gaffer-taped to the grid, the other half torn and pulled aside.
  for (const x of [-30, -3, 15]) {
    plastic(b, x, -1.6, 0.25, rnd)
    plastic(b, x + 0.05, 0.9, 1.6, rnd, 0.6)
  }
  for (let k = 0; k < 6; k++) {
    const x = SHELL.x0 + 6 + rnd() * 80
    b.quad(PUDDLE, T(x, FLOOR_Y + 0.002, (rnd() - 0.5) * 1.6, rnd() * 3, -Math.PI / 2), 0.6 + rnd() * 1.4, 0.4 + rnd() * 0.9, { cast: false })
    b.quad(STAIN, T(x, CEIL_Y - 0.007, 0, rnd() * 3, Math.PI / 2), 1.2, 1.0, { cast: false })
  }
}

/** Hanging plastic sheet across z0..z1 at x, wrinkled, stopping `gap` short of the floor. */
function plastic(b: Builder, x: number, z0: number, z1: number, rnd: () => number, gap = 0.04) {
  const w = z1 - z0
  const h = CEIL_Y - FLOOR_Y - gap
  const g = new THREE.PlaneGeometry(w, h, 12, 10)
  const pos = g.getAttribute("position")
  const ph = rnd() * 6
  for (let i = 0; i < pos.count; i++) {
    const u = pos.getX(i)
    const v = pos.getY(i)
    const sag = (v / h + 0.5) * 0
    pos.setZ(i, Math.sin(u * 5.3 + ph) * 0.05 + Math.sin(u * 13 + v * 3 + ph) * 0.015 + sag + (0.5 - v / h) * 0.06)
  }
  g.computeVertexNormals()
  g.applyMatrix4(T(x, CEIL_Y - h / 2, (z0 + z1) / 2, Math.PI / 2))
  b.add(plasticMat, g, { worldUV: false, cast: false })
}

function roomDecay(b: Builder, r: Room, rnd: () => number) {
  const n = r.enter ? 5 : 2
  for (let k = 0; k < n; k++) {
    const x = r.x0 + 0.5 + rnd() * (r.x1 - r.x0 - 1)
    const v = 1 + rnd() * 13
    b.quad(rnd() < 0.5 ? PUDDLE : STAIN, T(x, FLOOR_Y + 0.002 + k * 0.0003, rz(r, v), rnd() * 3, -Math.PI / 2), 0.5 + rnd() * 1.5, 0.4 + rnd(), { cast: false })
  }
  // Streaks down the corridor wall from a leak above.
  if (rnd() < 0.5) {
    const x = r.x0 + 0.6 + rnd() * (r.x1 - r.x0 - 1.2)
    b.quad(STAIN, T(x, CEIL_Y - 0.5, r.side * (ZC + 0.003), r.side > 0 ? 0 : Math.PI), 0.5 + rnd() * 0.6, 1.4, { cast: false })
  }
  if (r.enter && rnd() < 0.7) plastic(b, r.x0 + (r.x1 - r.x0) * 0.6, rz(r, 6), rz(r, 9), rnd, 0.3)
}

/** Same bay rule as the facility's facades (5.4 m module, 3.3 m openings, centred, `edge` clear at each end). */
function bays(u0: number, u1: number, skip: [number, number][], edge = 2.2) {
  const pier = 5.4 - WIN_W
  const n = Math.max(0, Math.floor((u1 - u0 - edge * 2 + pier) / 5.4))
  const start = (u0 + u1) / 2 - (n * 5.4 - pier) / 2
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    const a = start + i * 5.4
    if (!skip.some(([s0, s1]) => a + WIN_W > s0 && a < s1)) out.push(a)
  }
  return out
}

/**
 * Ground-floor windows outside the lobby, lab and closet: offices that are shut for the night, so each window shows
 * fully lowered, closed venetian blinds just inside the glass (the facility's glass would otherwise show the void).
 */
export function groundWindows(b: Builder) {
  const sill = 1.0 - FLOOR_Y
  const head = 2.35 - FLOOR_Y
  const h = head - sill - 0.04
  const y = FLOOR_Y + sill + 0.02 + h / 2
  const zi = ZW + 0.06
  for (const a of bays(SHELL.x0 - 0.35, SHELL.x1 + 0.35, [[-38, -21.5]])) b.quad(blindMats.closed, T(a + WIN_W / 2, y, -zi, 0), WIN_W - 0.04, h, { cast: false })
  for (const a of bays(SHELL.x0 - 0.35, SHELL.x1 + 0.35, [[-10.5, 10.5], [-43.35, -36.05]])) b.quad(blindMats.closed, T(a + WIN_W / 2, y, zi, Math.PI), WIN_W - 0.04, h, { cast: false })
  const xi = SHELL.x1 + 0.06 - 0.12
  for (const a of bays(6, 22, [], 2.6)) b.quad(blindMats.closed, T(xi, y, a + WIN_W / 2, -Math.PI / 2), WIN_W - 0.04, h, { cast: false })
  for (const a of bays(-22, 22, [[-12.5, -7]])) b.quad(blindMats.closed, T(SHELL.x0 + 0.06, y, a + WIN_W / 2, Math.PI / 2), WIN_W - 0.04, h, { cast: false })
}
