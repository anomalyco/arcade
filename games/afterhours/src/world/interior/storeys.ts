import * as THREE from "three/webgpu"
import { atan, float, fract, mix, positionWorld, sin, smoothstep, step, uv, vec3 } from "three/tsl"
import type { Lamp } from "../context"
import { materialFor } from "../../render/materials"
import { FIRE_ESCAPE } from "../layout"
import {
  type Band,
  type Mat,
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
  louvre,
  wall,
} from "./kit"
import { HALL, SHELL } from "./core"
import { bulletin, extinguisher, fluoro, fountain, hazardLight, rigLevel } from "./corridor"
import { furnish, flushModels, furnishNook, loungeChairs } from "./furnish"
import { STYLES, type Style } from "./styles"
import { MODELS, yawToward } from "../../render/models"
import { placeModels } from "./props"

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
  /** Door not locked: open rooms, lit rooms and a scattering of others, all fully furnished. */
  unlocked: boolean
  /** Layout variety: an open break area, a cross corridor to the facade, a glazed machine room, a storage nook. */
  kind?: "lounge" | "cross" | "glass" | "nook"
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

const KINDS: Record<number, [number, number, NonNullable<Room["kind"]>][]> = {
  1: [[-1, 6, "lounge"]],
  2: [[-1, 7, "cross"], [1, 9, "lounge"]],
  3: [[1, 11, "glass"], [-1, 2, "nook"]],
  4: [[-1, 9, "nook"]],
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
      const enter = has(picks.enter, side, index) || (KINDS[storey]?.some(([sd, i]) => sd === side && i === index) ?? false)
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
        lit: enter || litHere || KINDS[storey]?.some(([sd, i, k]) => sd === side && i === index && k !== "nook") === true,
        index,
        unlocked: enter || litHere || index % (storey === 4 ? 2 : 4) === 1,
        kind: KINDS[storey]?.find(([sd, i]) => sd === side && i === index)?.[2],
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
/** Polythene sheeting: nearly clear, glossy (the tubes streak across its folds), never a dark veil. */
const plasticMat = materialFor("flat", { color: 0xe8ece6, roughness: 0.12, transparent: 0.12, side: THREE.DoubleSide, name: "interior_plastic" })
/** Machine-room glazing: clear, faintly green-edged plate glass. */
const glazing = materialFor("flat", { color: 0xd4e4dc, roughness: 0.03, transparent: 0.08, name: "interior_glazing" })

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
  const style = STYLES[storey]!
  const special = rooms.filter((r) => r.kind)
  // Floor: storey finish, with the raised-floor stretch outside the machine room on storey 3.
  b.floor(style.floor, x0, -ZC, x1, ZC)
  if (storey === 3) raisedCorridor(b, special.find((r) => r.kind === "glass")!)
  if (storey === 4) slabRemnants(b, rnd)
  const sy = FLOOR_Y + 0.0015
  // Edge stripes run in segments that stop at every wide opening (hall, lounge, cross corridor, nook).
  const gaps = (side: number) =>
    [
      ...(side > 0 ? [[HALL.x0 - 0.15, HALL.x1 + 0.15] as [number, number]] : []),
      ...special.filter((r) => r.side === side && r.kind !== "glass").map((r) => [r.x0, r.x1] as [number, number]),
    ].sort((p, q) => p[0] - q[0])
  if (style.stripe)
    for (const side of [-1, 1]) {
      let cur = x0 + 0.4
      for (const [g0, g1] of [...gaps(side), [x1 - 0.4, x1] as [number, number]]) {
        if (g0 - cur > 0.2) b.box(style.stripe, cur, sy - 0.01, side * 1.18 - 0.06, g0, sy, side * 1.18 + 0.06, { cast: false })
        cur = g1
      }
    }
  const north = rooms.filter((r) => r.side < 0)
  const south = rooms.filter((r) => r.side > 0)
  const openingFor = (r: Room) =>
    r.kind === "glass"
      ? [doorOpening(r.door), { a0: r.door + 0.75, a1: r.x1 - 0.3, bottom: 0.9, top: 2.3 }]
      : r.kind
        ? [{ a0: r.x0 + 0.06, a1: r.x1 - 0.06, top: CEIL_Y }]
        : [doorOpening(r.door)]
  wall(b, "x", x0, x1, -ZC, -1.6, style.bands, north.flatMap(openingFor))
  wall(b, "x", x0, x1, 1.6, ZC, style.bands, [...south.flatMap(openingFor), { a0: HALL.x0 - 0.15, a1: HALL.x1 + 0.15, top: CEIL_Y }])
  wall(b, "z", -1.6, 1.6, x0, x0 + 0.04, style.bands, [doorOpening(FIRE_ESCAPE.door.z, FIRE_ESCAPE.door.width)], { y0: FLOOR_Y - 0.01, y1: CEIL_Y + 0.02, collide: false })
  // East end: the facade has a window on the corridor axis from storey 2 up.
  wall(b, "z", -1.6, 1.6, x1 - 0.04, x1, style.bands, storey >= 2 ? [{ a0: -1.6, a1: 1.6, bottom: SILL, top: HEAD }] : [], { y0: FLOOR_Y - 0.01, y1: CEIL_Y + 0.02, collide: false })
  // The fire-exit leaf itself is the facility's (a door in the shell's opening); this storey only lines the reveal.
  b.box(M.frame, x0 + 0.04, FLOOR_Y + DOOR_H + 0.25, -0.3, x0 + 0.15, FLOOR_Y + DOOR_H + 0.52, 0.3)
  b.box(M.exitSign, x0 + 0.15, FLOOR_Y + DOOR_H + 0.28, -0.27, x0 + 0.155, FLOOR_Y + DOOR_H + 0.49, 0.27, { cast: false })
  b.lamp({ kind: "exit", position: [x0 + 0.3, FLOOR_Y + DOOR_H + 0.38, 0], color: [1, 0.08, 0.04], intensity: 1, range: 3, size: 0.35 })

  ceiling(b, x0, -1.6, x1, 1.6, style.missing, storey, abandoned ? (x, z) => rnd() < 0.18 && fallenTile(b, x, z, rnd) : undefined)
  const dead = new Set<number>()
  const flick = new Map<number, number>()
  for (let x = 33; x >= -51; x -= 3) {
    const r = rnd()
    if (abandoned ? r < 0.45 : r < 0.12) dead.add(x)
    else if (abandoned ? r < 0.62 : r < 0.18) flick.set(x, 0.6 + rnd() * 0.4)
  }
  let flickCount = 0
  for (let x = 33; x >= -51; x -= 3) {
    if (abandoned && rnd() < 0.35) {
      hangingTroffer(b, x, rnd)
      continue
    }
    if (style.louvre) louvre(b, x, 0)
    if (dead.has(x)) {
      troffer(b, x, 0, "off", PANEL_ON)
      continue
    }
    const f = flick.get(x)
    const real = (x - 33) % 6 === 0 || f !== undefined
    const lamp = real ? b.lamp(fluoro(x, 0, f, storey === 1 ? 9 : 6)) : null
    if (f !== undefined && flickCount < 3 && lamp) {
      flickCount++
      const p = fluorescentPanel(1)
      flickers.push({ level: p.level, amount: f, seed: x + storey * 100, lamp })
      troffer(b, x, 0, { flicker: f, ...p }, PANEL_ON)
    } else troffer(b, x, 0, "on", PANEL_ON)
  }
  corridorDressing(b, storey, theme, rnd, special)

  // ---------------------------------------------------------------- rooms
  for (const p of PART) {
    wall(b, "z", -ZW, -ZC, p - 0.06, p + 0.06, roomBands)
    if (!coreGap(p)) wall(b, "z", ZC, ZW, p - 0.06, p + 0.06, roomBands)
  }
  for (const [ri, r] of rooms.entries()) {
    if (ri % 3 === 0) await pause()
    const zc = r.side * ZC
    const zw = r.side * ZW
    const records = theme === "records" && (r.index % 2 === 1 || r.kind === "glass")
    const floorMat = r.kind === "cross" ? style.floor : theme === "offices" ? M.carpet : records ? RAISED : abandoned ? "concrete_floor_dry" : "linoleum"
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
    if (style.louvre) for (const tx of cols) for (const tz of rows) if (tx - 0.31 >= r.x0 && tx + 0.31 <= r.x1 && !(tz + 0.6 > CORE_Z && (tx - 0.31 < r.wx0 || tx + 0.31 > r.wx1))) louvre(b, tx, r.side * tz)
    if (r.lit) for (const v of r.enter || r.kind ? [7.2, 14.4] : [14.4]) b.lamp(fluoro(cols[v > 10 ? 1 : 0]!, rz(r, v), abandoned ? 0.8 : undefined, 30))
    if (r.kind !== "lounge" && r.kind !== "cross" && r.kind !== "nook") {
      const chem = theme === "labs" && r.side > 0 && !r.unlocked
      door(b, r.door, r.side * (1.6 + 0.075), {
        rot: r.side < 0 ? 0 : Math.PI,
        open: r.enter ? 0.5 + rnd() * 0.9 : 0,
        locked: !r.unlocked || chem,
        leaf: style.leaf,
        glass: theme === "offices" ? null : undefined,
      })
      if (chem) hazardPlacard(b, r.door + 0.75, r.side * 1.59, r.side)
    }
    if (r.kind === "glass") machineGlazing(b, r)
    if (r.kind === "lounge") lounge(b, r, rnd)
    else if (r.kind === "cross") crossCorridor(b, r, style)
    else if (r.kind === "nook") nook(b, r, rnd)
    else furnish(b, theme, r, rnd)
    if (abandoned) roomDecay(b, r, rnd)
  }
  flushModels(b)
  // Far-view silhouettes for lit rooms (desks against the light), drawn while the real furniture is hidden.
  const px = new Builder(b.ctx, `storey-${storey}-proxy`, storey)
  for (const r of rooms) {
    if (!r.lit || theme === "labs") continue
    const cx = (r.wx0 + r.wx1) / 2
    for (const dx of [-1.12, 1.12]) {
      const zc = rz(r, 16.4)
      px.box(M.darkSteel, cx + dx - 1.0, FLOOR_Y, zc - 0.45, cx + dx + 1.0, FLOOR_Y + 0.76, zc + 0.45, { cast: false })
      const zc2 = rz(r, 15.5)
      px.box(M.rubber, cx + dx - 0.25, FLOOR_Y, zc2 - 0.25, cx + dx + 0.25, FLOOR_Y + 0.95, zc2 + 0.25, { cast: false })
    }
  }
  px.flush(b.group)
  await pause()

  return {
    proxy: px.group as THREE.Object3D,
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
  if (r.unlocked) {
    // Cast-iron column radiators under the sill on their feet, a little off the wall, with the supply pipe.
    const [rw, , rd] = MODELS.radiator.size
    const zr = zf - s * (rd / 2 + 0.05)
    placeModels(b, "radiator", [-0.5, 0.5].map((k) => ({ position: [a + WIN_W / 2 + k * (rw + 0.06), FLOOR_Y + 0.02, zr] as const, yaw: s > 0 ? 0 : Math.PI, inset: 0 })))
    b.rod(M.darkSteel, [a + WIN_W / 2 - rw - 0.1, FLOOR_Y + 0.08, zr], [a + WIN_W / 2 + rw + 0.1, FLOOR_Y + 0.08, zr], 0.012, 8)
  } else {
    const rm = T(a + WIN_W / 2, FLOOR_Y + 0.38, zf - s * 0.1)
    b.rbox(M.beige, rm, 2.2, 0.5, 0.14, 0.03)
    for (let k = 0; k < 22; k++) b.box(M.darkSteel, a + WIN_W / 2 - 1.0 + k * 0.095, FLOOR_Y + 0.6, zf - s * 0.15, a + WIN_W / 2 - 0.97 + k * 0.095, FLOOR_Y + 0.635, zf - s * 0.05, { cast: false })
    b.collide(a + WIN_W / 2 - 1.1, FLOOR_Y, Math.min(zf, zf - s * 0.2), a + WIN_W / 2 + 1.1, FLOOR_Y + 0.65, Math.max(zf, zf - s * 0.2))
  }
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

function corridorDressing(b: Builder, storey: number, theme: Theme, rnd: () => number, special: Room[]) {
  // Same fittings as the ground floor, shuffled per storey, kept clear of doors and the wide openings.
  const doors = roomsFor(storey).map((r) => [r.side, r.door] as const)
  const clear = (x: number, side: number) => {
    for (let k = 0; k < 8; k++) {
      const bad =
        special.some((r) => r.side === side && x > r.x0 - 0.6 && x < r.x1 + 0.6) ||
        (side > 0 && x > HALL.x0 - 0.8 && x < HALL.x1 + 0.8) ||
        doors.some(([s, d]) => s === side && Math.abs(x - d) < 1.0)
      if (!bad) return x
      x += 2.7
    }
    return x
  }
  extinguisher(b, clear(-20 + storey * 3.1, -1), -1.6)
  extinguisher(b, clear(18 - storey * 2.3, -1), -1.6)
  if (theme !== "abandoned") fountain(b, clear(-24.6 + storey * 1.7, 1), 1.6)
  if (theme !== "abandoned" && theme !== "records") bulletin(b, clear(3.5 - storey * 2, 1), 1.6)
  hazardLight(b, clear(-30 + storey, -1), -1.6, false)
  const hx = clear(25 - storey, -1)
  hazardLight(b, hx, -1.6, theme === "abandoned")
  if (theme === "abandoned") b.lamp({ kind: "warning", position: [hx, FLOOR_Y + 2.55, -1.4], color: [1, 0.12, 0.05], intensity: 1.5, range: 3, size: 0.12 })
  if (theme === "labs") {
    safetyShower(b, clear(9.3, -1), -1.6)
    safetyShower(b, clear(-15.3, -1), -1.6)
  }
  if (theme === "offices") vinylSeams(b, special)
  if (theme === "records") cableTray(b)
  if (theme === "abandoned") decayCorridor(b, rnd)
}

/** Butt seams of the wallcovering every 0.9 m on both corridor walls (storey 1). */
function vinylSeams(b: Builder, special: Room[]) {
  for (const side of [-1, 1]) {
    const z = side * 1.6
    for (let x = SHELL.x0 + 0.9; x < SHELL.x1; x += 0.9) {
      if (special.some((r) => r.side === side && x > r.x0 && x < r.x1)) continue
      if (side > 0 && x > HALL.x0 - 0.2 && x < HALL.x1 + 0.2) continue
      b.box(M.vinylSeam, x - 0.002, FLOOR_Y + 0.93, z - side * 0.002, x + 0.002, CEIL_Y, z, { cast: false })
    }
  }
}

/** Ladder cable tray hung below the ceiling along the corridor (storey 3), cable bundles in it. */
function cableTray(b: Builder) {
  const y = CEIL_Y - 0.32
  const z0 = 0.55
  const z1 = 0.95
  b.box("metal_galvanized", SHELL.x0, y, z0, SHELL.x1, y + 0.08, z0 + 0.012)
  b.box("metal_galvanized", SHELL.x0, y, z1 - 0.012, SHELL.x1, y + 0.08, z1)
  for (let x = SHELL.x0 + 0.15; x < SHELL.x1; x += 0.3) b.box("metal_galvanized", x - 0.01, y, z0, x + 0.01, y + 0.012, z1, { cast: false })
  for (let x = SHELL.x0 + 0.75; x < SHELL.x1; x += 1.5) {
    b.rod(M.darkSteel, [x, y, z0 - 0.02], [x, CEIL_Y, z0 - 0.02], 0.005, 4)
    b.rod(M.darkSteel, [x, y, z1 + 0.02], [x, CEIL_Y, z1 + 0.02], 0.005, 4)
    b.box(M.darkSteel, x - 0.015, y - 0.02, z0 - 0.04, x + 0.015, y, z1 + 0.04)
  }
  for (const [dz, r, mat] of [
    [0.08, 0.035, M.rubber],
    [0.17, 0.03, paint(0x5a5f62, 0.6)],
    [0.26, 0.04, M.rubber],
    [0.33, 0.022, paint(0x7a6a3a, 0.6)],
  ] as const)
    b.rod(mat, [SHELL.x0, y + 0.012 + r, z0 + dz], [SHELL.x1, y + 0.012 + r, z0 + dz], r, 6)
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
  // Plastic sheeting: one torn sheet bunched against the north wall (no full-height planes across the corridor), and
  // blue tarps: one hung over a doorway, one on the floor catching a leak.
  plastic(b, -30, -1.6, -0.9, rnd, 0.35)
  tarpHung(b, 6.6, -1.6, rnd)
  tarpFloor(b, -12, 0.3, rnd)
  // Dead end: plywood hoarding across the corridor at x = 22, chairs stacked against it.
  hoarding(b, 22)
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

// ------------------------------------------------------------------------------------------------ storey identities

/** Raised access floor in the corridor outside the machine room: 60 cm grey tiles, a few perforated. */
function raisedCorridor(b: Builder, r: Room) {
  const y = FLOOR_Y + 0.0012
  const xa = Math.ceil((r.x0 - 3) / 0.6) * 0.6
  const xb = r.x1 + 3
  b.box(M.raised, xa, y - 0.01, -1.6, xb, y, 1.6, { cast: false })
  for (let x = xa; x <= xb + 1e-3; x += 0.6) b.box(M.darkSteel, x - 0.005, y, -1.6, x + 0.005, y + 0.0008, 1.6, { cast: false })
  for (let z = -1.5; z <= 1.6; z += 0.6) b.box(M.darkSteel, xa, y, z - 0.005, xb, y + 0.0008, z + 0.005, { cast: false })
  for (let x = xa + 1.2; x < xb - 0.6; x += 2.4) b.box(M.perf, x + 0.03, y, -0.27, x + 0.57, y + 0.0009, 0.27, { cast: false })
  // Ramp nosings at each end.
  for (const x of [xa, xb]) b.box(M.hazard, x - 0.04, y - 0.01, -1.6, x + 0.04, y + 0.002, 1.6, { cast: false })
}

/** Patches of old linoleum and adhesive left on the stripped slab. */
function slabRemnants(b: Builder, rnd: () => number) {
  for (let k = 0; k < 9; k++) {
    const x = SHELL.x0 + 4 + rnd() * 80
    const w = 0.6 + rnd() * 2.2
    const z0 = -1.6 + rnd() * 1.2
    b.box("linoleum", x, FLOOR_Y, z0, x + w, FLOOR_Y + 0.003, z0 + 0.5 + rnd() * 1.4, { cast: false })
  }
}

/** A fitting hanging out of the grid on two wires, a T-bar sagging beside it. */
function hangingTroffer(b: Builder, x: number, rnd: () => number) {
  const tilt = 0.5 + rnd() * 0.4
  const m = T(x, CEIL_Y - 0.5, 0.15, rnd() * 0.4, 0.1, tilt)
  b.boxM(M.housing, m, 0.6, 0.08, 1.2)
  b.quad(M.diffuserOff, m.clone().multiply(T(0, -0.041, 0, 0, Math.PI / 2)), 0.56, 1.16, { cast: false })
  b.rod(M.rubber, [x - 0.25, CEIL_Y, 0.2], [x - 0.25, CEIL_Y - 0.3, 0.25], 0.004, 4)
  b.rod(M.rubber, [x + 0.25, CEIL_Y, 0.2], [x + 0.2, CEIL_Y - 0.72, 0.0], 0.004, 4)
  b.rod(M.tbar, [x - 1.2, CEIL_Y - 0.01, 0.6], [x + 0.8, CEIL_Y - 0.45 - rnd() * 0.3, 0.55], 0.008, 4)
}

/** Chemical store placard beside a lab door: a hazard diamond (four coloured quarters) and a chevron floor strip. */
function hazardPlacard(b: Builder, x: number, z: number, side: number) {
  const y = FLOOR_Y + 1.55
  const yaw = side > 0 ? Math.PI : 0
  const cols = [paint(0x2a4a8a, 0.5), paint(0x8a1a12, 0.5), paint(0x9a8012, 0.5), paint(0xcfcbbb, 0.6)]
  const off = [
    [0, 0.07],
    [-0.07, 0],
    [0.07, 0],
    [0, -0.07],
  ]
  off.forEach(([dx, dy], i) => b.boxM(cols[(i + 1) % 4]!, T(x + dx! * (side > 0 ? -1 : 1), y + dy!, z, yaw, 0, Math.PI / 4), 0.095, 0.095, 0.006))
  b.box(M.hazard, x - 1.3, FLOOR_Y + 0.0015, Math.min(z, z - side * 0.25), x + 0.1, FLOOR_Y + 0.0025, Math.max(z, z - side * 0.25), { cast: false })
}

/** Glazed corridor wall into the machine room: plate glass in steel mullions, halon warning beacons over the door. */
function machineGlazing(b: Builder, r: Room) {
  const a0 = r.door + 0.75
  const a1 = r.x1 - 0.3
  const z = r.side * 1.675
  const y0 = FLOOR_Y + 0.9
  const y1 = FLOOR_Y + 2.3
  b.box(M.frame, a0, y0 - 0.04, z - 0.09, a1, y0, z + 0.09)
  b.box(M.frame, a0, y1, z - 0.09, a1, y1 + 0.05, z + 0.09)
  const n = Math.max(1, Math.round((a1 - a0) / 1.2))
  for (let k = 0; k <= n; k++) {
    const x = a0 + ((a1 - a0) * k) / n
    b.box(M.frame, x - 0.025, y0, z - 0.04, x + 0.025, y1, z + 0.04)
  }
  b.quad(glazing, T((a0 + a1) / 2, (y0 + y1) / 2, z, r.side > 0 ? Math.PI : 0), a1 - a0, y1 - y0, { cast: false })
  b.collide(a0, y0, z - 0.03, a1, y1, z + 0.03)
  // Halon discharge beacons (amber, red) and a blank instruction plate beside the door.
  const zf = r.side * 1.59
  for (const [dx, mat] of [
    [-0.2, M.amberGlow],
    [0.2, M.hazardRed],
  ] as const) {
    b.box(M.darkSteel, r.door + dx - 0.07, FLOOR_Y + 2.32, zf - r.side * 0.06, r.door + dx + 0.07, FLOOR_Y + 2.36, zf)
    b.cyl(mat, T(r.door + dx, FLOOR_Y + 2.42, zf - r.side * 0.04), 0.045, 0.05, 0.12, 12, { cast: false })
  }
  b.lamp({ kind: "warning", position: [r.door - 0.2, FLOOR_Y + 2.45, zf - r.side * 0.2], color: [1, 0.55, 0.1], intensity: 1.2, range: 3.5, size: 0.08 })
  b.box(M.safety, r.door + 0.6, FLOOR_Y + 1.35, zf - r.side * 0.006, r.door + 0.95, FLOOR_Y + 1.8, zf, { cast: false })
  b.box(M.felt, r.door + 0.63, FLOOR_Y + 1.38, zf - r.side * 0.008, r.door + 0.92, FLOOR_Y + 1.77, zf - r.side * 0.006, { cast: false })
}

/** Break area open to the corridor: vending machines, sofa, coffee table, a table with chairs, water cooler; a back
 *  partition with a closed door to a storeroom. */
function lounge(b: Builder, r: Room, rnd: () => number) {
  const s = r.side
  const back = 8.4
  wall(b, "x", r.x0, r.x1, Math.min(rz(r, back), rz(r, back + 0.12)), Math.max(rz(r, back), rz(r, back + 0.12)), roomBands, [doorOpening(r.x1 - 1.2)])
  door(b, r.x1 - 1.2, rz(r, back + 0.06), { rot: s < 0 ? 0 : Math.PI, locked: true })
  // Two vending machines against the left partition, fronts facing across the room.
  // Two coffee vending machines side by side against the left partition, fronts facing across the room.
  const vx = r.x0 + MODELS.vending_machine.size[2] / 2 + 0.03
  placeModels(b, "vending_machine", [0.75, 1.42].map((v) => ({ position: [vx, FLOOR_Y, rz(r, v)] as const, yaw: yawToward(1, 0), inset: 0.02 })))
  b.lamp({ kind: "fluorescent", position: [vx + 0.6, FLOOR_Y + 1.2, rz(r, 1.1)], color: [0.95, 0.9, 0.75], intensity: 2.5, range: 4, size: 0.5 })
  // Two lounge chairs angled round the coffee table.
  const sx = (r.x0 + r.x1) / 2 - 0.5
  const tv = back - 1.7
  placeModels(
    b,
    "lounge_chair",
    [-1, 1].map((k) => {
      const cx = sx + k * 1.25
      const cv = tv + 0.45
      return { position: [cx, FLOOR_Y, rz(r, cv)] as const, yaw: yawToward(sx - cx, rz(r, tv) - rz(r, cv)) + k * 0.15, inset: 0.18 }
    }),
  )
  const tm = T(sx, FLOOR_Y, rz(r, back - 1.7))
  b.rbox(M.wood, tm, 1.1, 0.04, 0.55, 0.01, 0, 0.42, 0)
  for (const [dx, dz] of [[-0.48, -0.22], [0.48, -0.22], [-0.48, 0.22], [0.48, 0.22]]) b.boxM(M.darkSteel, tm, 0.03, 0.4, 0.03, dx!, 0.2, dz!)
  b.collide(sx - 0.55, FLOOR_Y, rz(r, back - 1.7) - 0.28, sx + 0.55, FLOOR_Y + 0.44, rz(r, back - 1.7) + 0.28)
  paperStackLounge(b, sx - 0.2, FLOOR_Y + 0.44, rz(r, back - 1.7), rnd)
  // Round table with stacking chairs near the corridor.
  const rx = r.x1 - 1.3
  const rv = 3.2
  b.cyl(M.laminateTop, T(rx, FLOOR_Y + 0.72, rz(r, rv)), 0.45, 0.45, 0.03, 32)
  b.cyl(M.steel, T(rx, FLOOR_Y + 0.7, rz(r, rv)), 0.45, 0.45, 0.012, 32, { open: true })
  b.cyl(M.darkSteel, T(rx, FLOOR_Y + 0.36, rz(r, rv)), 0.03, 0.03, 0.7, 16)
  b.cyl(M.darkSteel, T(rx, FLOOR_Y + 0.015, rz(r, rv)), 0.25, 0.28, 0.03, 32)
  b.collide(rx - 0.45, FLOOR_Y, rz(r, rv) - 0.45, rx + 0.45, FLOOR_Y + 0.74, rz(r, rv) + 0.45)
  b.cyl(M.paper, T(rx + 0.1, FLOOR_Y + 0.78, rz(r, rv) + 0.1), 0.04, 0.035, 0.09, 12)
  loungeChairs(b, r, rx, rv, rnd)
  // Water cooler by the opening.
  const wx = r.x1 - 0.35
  const wv = 0.6
  placeModels(b, "water_cooler", [{ position: [wx, FLOOR_Y, rz(r, wv)], yaw: yawToward(-1, 0), inset: 0.02 }])
}

function paperStackLounge(b: Builder, x: number, y: number, z: number, rnd: () => number) {
  for (let k = 0; k < 4; k++) b.boxM(M.paper, T(x + (rnd() - 0.5) * 0.2, y + 0.003 + k * 0.004, z + (rnd() - 0.5) * 0.1, rnd() * 3), 0.21, 0.003, 0.28, 0, 0, 0, { cast: false })
}

/** Cross corridor through to a window on the facade, finished like the main corridor. */
function crossCorridor(b: Builder, r: Room, style: Style) {
  const za = Math.min(rz(r, 0), rz(r, DEPTH))
  const zb = Math.max(rz(r, 0), rz(r, DEPTH))
  wall(b, "z", za, zb, r.x0, r.x0 + 0.01, style.bands, [], { y0: FLOOR_Y - 0.01, y1: CEIL_Y + 0.02, collide: false })
  wall(b, "z", za, zb, r.x1 - 0.01, r.x1, style.bands, [], { y0: FLOOR_Y - 0.01, y1: CEIL_Y + 0.02, collide: false })
  if (style.stripe) {
    const cx = (r.x0 + r.x1) / 2
    b.box(style.stripe, cx - 0.06, FLOOR_Y + 0.0005, za + 0.1, cx + 0.06, FLOOR_Y + 0.0015, zb - 0.3, { cast: false })
  }
  extinguisher(b, r.x0 + 0.01, 0)
  safetyShower(b, r.x1 - 0.12 - 0.4, rz(r, 9) + 0.0)
}

/** Dead-end storage nook: a shallow bay off the corridor stacked with chairs and boxes, a partition behind. */
function nook(b: Builder, r: Room, rnd: () => number) {
  const back = 3.4
  wall(b, "x", r.x0, r.x1, Math.min(rz(r, back), rz(r, back + 0.12)), Math.max(rz(r, back), rz(r, back + 0.12)), roomBands)
  furnishNook(b, r, back, rnd)
}

/** Blue tarp hung from the grid over a doorway, sagging and creased. */
function tarpHung(b: Builder, x: number, zWall: number, rnd: () => number) {
  const w = 2.2
  const h = CEIL_Y - FLOOR_Y - 0.5
  const g = new THREE.PlaneGeometry(w, h, 10, 8)
  const pos = g.getAttribute("position")
  for (let i = 0; i < pos.count; i++) {
    const u = pos.getX(i)
    const v = pos.getY(i)
    pos.setZ(i, Math.sin(u * 4 + rnd() * 0.3) * 0.06 + (0.5 - v / h) * 0.12 + Math.sin(v * 7) * 0.02)
  }
  g.computeVertexNormals()
  g.applyMatrix4(T(x, CEIL_Y - h / 2, zWall + 0.2, 0))
  b.add(M.tarp, g, { worldUV: false, cast: false })
  b.box(M.wood, x - w / 2, CEIL_Y - 0.04, zWall + 0.15, x + w / 2, CEIL_Y - 0.01, zWall + 0.22)
}

/** Tarp spread on the floor under a leak, edges folded, a bucket of brown water on it. */
function tarpFloor(b: Builder, x: number, z: number, rnd: () => number) {
  const g = new THREE.PlaneGeometry(1.8, 1.4, 8, 6)
  const pos = g.getAttribute("position")
  for (let i = 0; i < pos.count; i++) {
    const e = Math.max(Math.abs(pos.getX(i)) / 0.9, Math.abs(pos.getY(i)) / 0.7)
    pos.setZ(i, e > 0.85 ? 0.03 + rnd() * 0.04 : rnd() * 0.01)
  }
  g.computeVertexNormals()
  g.applyMatrix4(T(x, FLOOR_Y + 0.004, z, 0.3, -Math.PI / 2))
  b.add(M.tarp, g, { worldUV: false, cast: false })
  b.quad(PUDDLE, T(x + 0.2, FLOOR_Y + 0.02, z - 0.1, 0, -Math.PI / 2), 0.9, 0.6, { cast: false })
  b.cyl(M.darkSteel, T(x - 0.4, FLOOR_Y + 0.16, z + 0.3), 0.15, 0.13, 0.3, 16, { open: true })
}

/** Plywood hoarding across the corridor on its studs, hazard tape on it: the east end is closed off. */
function hoarding(b: Builder, x: number) {
  b.box(M.plywood, x, FLOOR_Y, -1.6, x + 0.018, CEIL_Y, 1.6)
  for (let z = -1.5; z <= 1.6; z += 0.6) b.box(M.wood, x + 0.018, FLOOR_Y, z - 0.02, x + 0.1, CEIL_Y, z + 0.02)
  b.box(M.wood, x + 0.018, FLOOR_Y, -1.6, x + 0.1, FLOOR_Y + 0.05, 1.6)
  b.box(M.wood, x + 0.018, CEIL_Y - 0.05, -1.6, x + 0.1, CEIL_Y, 1.6)
  for (const y of [1.0, 1.25]) b.box(M.hazard, x - 0.004, FLOOR_Y + y, -1.6, x, FLOOR_Y + y + 0.08, 1.6, { cast: false })
  // Seams between sheets.
  b.box(M.darkSteel, x - 0.002, FLOOR_Y, -0.38, x, CEIL_Y, -0.36, { cast: false })
  b.box(M.darkSteel, x - 0.002, FLOOR_Y + 2.44, -1.6, x, FLOOR_Y + 2.45, 1.6, { cast: false })
  b.collide(x - 0.02, FLOOR_Y, -1.6, x + 0.1, CEIL_Y, 1.6)
}
