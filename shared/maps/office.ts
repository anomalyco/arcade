import type { Rect, Vec } from "../geom"
import { Rng } from "../rng"
import { Nav } from "../sim/nav"
import { Builder, type Gap, T, WALL_H } from "./builder"
import type { MapDef, Prop } from "./types"

/** Corridor width around the core. */
const C = 2.4
const COLD = [0.8, 0.88, 1] as const
const WARM = [1, 0.72, 0.42] as const
const SPAWNS = 12

type Side = "n" | "s" | "e" | "w"
type Rot = Prop["rot"]
/** Rotation for something standing against wall `side`, facing into the room. */
const FACE_IN: Record<Side, Rot> = { n: 0, s: 2, w: 3, e: 1 }
const OPP: Record<Side, Side> = { n: "s", s: "n", e: "w", w: "e" }

/** The strip of `depth` along edge `side` of r, covering the fraction [from, to] of that edge. */
function strip(r: Rect, side: Side, depth: number, from = 0, to = 1): Rect {
  const [x0, y0, x1, y1] = r
  const ax = x0 + (x1 - x0) * from
  const bx = x0 + (x1 - x0) * to
  const ay = y0 + (y1 - y0) * from
  const by = y0 + (y1 - y0) * to
  if (side === "n") return [ax, y0, bx, y0 + depth]
  if (side === "s") return [ax, y1 - depth, bx, y1]
  if (side === "w") return [x0, ay, x0 + depth, by]
  return [x1 - depth, ay, x1, by]
}

/** Usable floor of a room whose walls run along `room`'s edges: clear of walls and of the strip inside the door. */
function inner(room: Rect, door: Side): Rect {
  const m = T / 2 + 0.25
  const d = 1.8
  return [room[0] + (door === "w" ? d : m), room[1] + (door === "n" ? d : m), room[2] - (door === "e" ? d : m), room[3] - (door === "s" ? d : m)]
}

const cx = (r: Rect) => (r[0] + r[2]) / 2
const cy = (r: Rect) => (r[1] + r[3]) / 2

/**
 * Procedural office floor. Every floor shares the structure of concept/map-office-plan.png: a lift and service core in
 * the middle, a corridor ring around it, open-plan cubicles north and south, a strip of rooms along the west and east
 * windows. Sizes, room kinds and order, door placement, furniture, lights and spawns all come from the seed, so the
 * server and every client build the identical floor from one number.
 */
export function generateOffice(seed: number): MapDef {
  const r = new Rng(seed)
  const b = new Builder()
  const W = 46 + 2 * r.int(5)
  const H = 30 + 2 * r.int(4)
  const ws = 9 + r.int(3)
  const xe = W - 8 - r.int(2)
  const ch = 8 + r.int(3)
  const cy0 = Math.round(H / 2 - ch / 2)
  const cy1 = cy0 + ch

  b.floor("carpet", 0, 0, W, H)
  b.windows.push([0, 0, W, T], [0, H - T, W, H], [0, T, T, H - T], [W - T, T, W, H - T])

  core(b, r, ws + C, cy0, xe - C, cy1)
  westRooms(b, r, ws, H)
  eastRooms(b, r, xe, W, H)
  corridorLights(b, r, ws, xe, cy0, cy1)
  openPlan(b, r, ws, xe, T, cy0 - C, "n")
  openPlan(b, r, ws, xe, cy1 + C, H - T, "s")
  for (const y of [cy0 - C, cy1 + C]) for (let x = ws + 0.6; x + 1.2 < xe - 0.4; x += 2.4) b.tape.push([x, y - 0.035, x + 1.2, y + 0.035])
  for (const x of [ws + C, xe - C]) for (let y = cy0 - C + 0.6; y + 1.2 < cy1 + C - 0.4; y += 2.4) b.tape.push([x - 0.035, y, x + 0.035, y + 1.2])

  const map = b.build({ id: `office-${seed}`, seed, name: `Office Tower · FL ${floorOf(seed)}`, size: [W, H] })
  b.spawns.push(...spawns(map, r, { x: (ws + xe) / 2, y: cy1 + C / 2 }))
  return map
}

export const floorOf = (seed: number) => 3 + (seed % 57)

// Core --------------------------------------------------------------------------------------------------------------

type CoreCell = "lobby" | "stair" | "toilets" | "server" | "storage"

function core(b: Builder, r: Rng, x0: number, y0: number, x1: number, y1: number): void {
  const width = x1 - x0
  const side1: CoreCell[] = r.next() < 0.5 ? ["stair", "toilets"] : ["toilets", "stair"]
  const side2: CoreCell[] = r.next() < 0.5 ? ["server", "storage"] : ["storage", "server"]
  const left = r.next() < 0.5
  let cells: CoreCell[] = left ? [...side1, "lobby", ...side2] : [...side2, "lobby", ...side1]
  const base: Record<CoreCell, number> = { stair: 3.6, toilets: 4.4, server: 5.2, storage: 4.6, lobby: 6.5 }
  if (cells.reduce((s, c) => s + base[c], 0) > width) cells = cells.filter((c) => c !== "storage")
  const extra = width - cells.reduce((s, c) => s + base[c], 0)
  const share: Record<CoreCell, number> = { lobby: 0.45, storage: 0.25, server: 0.2, toilets: 0.1, stair: 0 }
  const totalShare = cells.reduce((s, c) => s + share[c], 0)
  const widths = cells.map((c) => base[c] + (extra * share[c]) / totalShare)

  const north: Gap[] = []
  const south: Gap[] = []
  let x = x0
  cells.forEach((kind, i) => {
    const a = x
    const z = x + widths[i]!
    x = z
    if (i > 0) b.vwall(a, y0 + T / 2, y1 - T / 2)
    const room: Rect = [a, y0, z, y1]
    const face: Side = r.next() < 0.5 ? "n" : "s"
    if (kind === "lobby") {
      ;(face === "n" ? north : south).push([a + 0.5, z - 0.5])
      lobby(b, r, room, face)
      return
    }
    const dc = a + (z - a) / 2 + r.range(-0.25, 0.25) * Math.max(0, z - a - 2.8)
    ;(face === "n" ? north : south).push([dc - 0.7, dc + 0.7])
    const door = { x: dc, y: face === "n" ? y0 : y1 }
    if (kind === "stair") stair(b, room, face, door)
    else if (kind === "toilets") toilets(b, r, room, face)
    else if (kind === "server") server(b, r, room, face, door)
    else storage(b, r, room, face)
  })
  b.hwall(y0, x0 - T / 2, x1 + T / 2, north)
  b.hwall(y1, x0 - T / 2, x1 + T / 2, south)
  b.vwall(x0, y0 + T / 2, y1 - T / 2)
  b.vwall(x1, y0 + T / 2, y1 - T / 2)
}

function lobby(b: Builder, r: Rng, room: Rect, face: Side): void {
  const back = OPP[face]
  const lifts = strip([room[0] + T / 2, room[1] + T / 2, room[2] - T / 2, room[3] - T / 2], back, 2.4, 0.08, 0.92)
  b.wall(lifts[0], lifts[1], lifts[2], lifts[3], WALL_H, "core")
  b.floor("wood", room[0] + T / 2, room[1] + T / 2, room[2] - T / 2, room[3] - T / 2)
  const desk = strip(inner(room, face), back, 0.8, 0.3, 0.7)
  const d: Rect = face === "s" ? [desk[0], desk[1] + 2.6, desk[2], desk[3] + 2.6] : [desk[0], desk[1] - 2.6, desk[2], desk[3] - 2.6]
  b.prop("reception", d[0], d[1], d[2], d[3], FACE_IN[back])
  b.prop("plant", room[0] + 0.45, cy(d) - 0.35, room[0] + 1.15, cy(d) + 0.35)
  b.prop("plant", room[2] - 1.15, cy(d) - 0.35, room[2] - 0.45, cy(d) + 0.35)
  b.light({ kind: "bulb", x: cx(room), y: cy(d), h: 2.5, r: 5, power: 0.75, color: WARM })
}

function stair(b: Builder, room: Rect, face: Side, door: Vec): void {
  const shaft = strip([room[0] + T / 2, room[1] + T / 2, room[2] - T / 2, room[3] - T / 2], OPP[face], (room[3] - room[1]) * 0.55)
  b.wall(shaft[0], shaft[1], shaft[2], shaft[3], WALL_H, "core")
  b.floor("concrete", room[0] + T / 2, room[1] + T / 2, room[2] - T / 2, room[3] - T / 2)
  const out = face === "n" ? -1 : 1
  b.prop("exitdoor", door.x - 0.7, door.y - 0.2, door.x + 0.7, door.y + 0.2, face === "n" ? 2 : 0, false)
  b.light({ kind: "exit", x: door.x, y: door.y + out * 0.35, h: 2.4, r: 4.5, power: 0.7, color: [1, 0.16, 0.45], cone: [0, out, 0.1] })
}

function toilets(b: Builder, r: Rng, room: Rect, face: Side): void {
  b.floor("tile", room[0] + T / 2, room[1] + T / 2, room[2] - T / 2, room[3] - T / 2)
  const back = OPP[face]
  const by = back === "n" ? room[1] + T / 2 : room[3] - T / 2
  const dir = back === "n" ? 1 : -1
  const n = Math.max(2, Math.floor((room[2] - room[0] - 0.6) / 1.2))
  const x0 = cx(room) - (n * 1.2) / 2
  for (let i = 0; i <= n; i++) {
    const x = x0 + i * 1.2
    b.wall(x - 0.04, Math.min(by, by + dir * 1.5), x + 0.04, Math.max(by, by + dir * 1.5), 2.0, "stall")
  }
  const sinks = strip(inner(room, face), "w", 0.55, 0.05, 0.6)
  b.prop("counter", sinks[0], sinks[1], sinks[2], sinks[3], FACE_IN.w)
  const p = inner(room, face)
  b.light({ kind: "panel", x: cx(room), y: cy(room), h: 2.6, r: 5.5, power: 0.85, color: COLD })
}

function server(b: Builder, r: Rng, room: Rect, face: Side, door: Vec): void {
  const floor: Rect = [room[0] + T / 2, room[1] + T / 2, room[2] - T / 2, room[3] - T / 2]
  b.floor("grate", ...floor)
  const p = inner(room, face)
  for (let x = p[0] + 0.1; x + 0.7 <= p[2]; x += 2.2) b.wall(x, p[1] + 0.2, x + 0.7, p[3] - 0.2, 2.1, "rack")
  b.light({ kind: "server", x: cx(p), y: cy(p), h: 2.4, r: 5.5, power: 0.8, color: [0.3, 0.5, 1] })
}

function storage(b: Builder, r: Rng, room: Rect, face: Side): void {
  b.floor("concrete", room[0] + T / 2, room[1] + T / 2, room[2] - T / 2, room[3] - T / 2)
  const p = inner(room, face)
  for (let x = p[0] + 0.05; x + 0.6 <= p[2]; x += 2.0) b.wall(x, p[1] + 0.2, x + 0.6, p[3] - 0.4 - r.next() * 1.2, 2.0, "shelf")
}

// Window rooms ------------------------------------------------------------------------------------------------------

type RoomKind = "kitchen" | "manager" | "lounge" | "copy" | "boardroom" | "meeting"

/** Splits [a, b] into n parts with random weights, each at least `min`. */
function split(r: Rng, a: number, b: number, n: number, min: number): number[] {
  const w = Array.from({ length: n }, () => 0.8 + r.next() * 0.6)
  const total = w.reduce((s, x) => s + x, 0)
  const free = b - a - n * min
  const cuts = [a]
  let acc = a
  for (const x of w) {
    acc += min + (free * x) / total
    cuts.push(acc)
  }
  cuts[cuts.length - 1] = b
  return cuts
}

function shuffle<T>(r: Rng, xs: T[]): T[] {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = r.int(i + 1)
    ;[xs[i], xs[j]] = [xs[j]!, xs[i]!]
  }
  return xs
}

function westRooms(b: Builder, r: Rng, ws: number, H: number): void {
  const n = H >= 34 ? 4 : 3 + r.int(2)
  const kinds: RoomKind[] = shuffle(r, ["kitchen", ...shuffle(r, ["manager", "lounge", "copy", "manager"] as RoomKind[]).slice(0, n - 1)])
  const cuts = split(r, T, H - T, n, 6)
  const gaps: Gap[] = []
  kinds.forEach((kind, i) => {
    const y0 = cuts[i]!
    const y1 = cuts[i + 1]!
    if (i > 0) b.hwall(y0, T, ws - T / 2)
    const room: Rect = [T / 2, y0, ws, y1]
    const dy = r.range(y0 + 1.4, y1 - 1.4)
    gaps.push(kind === "kitchen" && r.next() < 0.5 ? [dy - 1.1, dy + 1.1] : [dy - 0.7, dy + 0.7])
    furnish(b, r, kind, room, "e")
  })
  b.vwall(ws, T, H - T, gaps)
}

function eastRooms(b: Builder, r: Rng, xe: number, W: number, H: number): void {
  const n = 3 + r.int(2)
  const kinds: RoomKind[] = shuffle(r, ["boardroom", ...shuffle(r, ["meeting", "meeting", "manager", "lounge"] as RoomKind[]).slice(0, n - 1)])
  const cuts = split(r, T, H - T, n, 5.5)
  kinds.forEach((kind, i) => {
    const y0 = cuts[i]!
    const y1 = cuts[i + 1]!
    if (i > 0) b.hwall(y0, xe + T / 2, W - T)
    const room: Rect = [xe, y0, W - T / 2, y1]
    const dy = r.range(y0 + 1.4, y1 - 1.4)
    const glassy = kind === "boardroom" || kind === "meeting"
    if (glassy) {
      // Glass front: breakable panes either side of the door, posts between them.
      const a0 = i === 0 ? y0 : y0 + T / 2
      const a1 = i === n - 1 ? y1 : y1 - T / 2
      for (const [s, e] of [
        [a0, dy - 0.7],
        [dy + 0.7, a1],
      ] as const) {
        const parts = Math.max(1, Math.round((e - s) / 2.4))
        for (let k = 0; k < parts; k++) b.pane(xe - 0.06, s + ((e - s) * k) / parts, xe + 0.06, s + ((e - s) * (k + 1)) / parts)
      }
    } else b.vwall(xe, i === 0 ? y0 : y0 + T / 2, i === n - 1 ? y1 : y1 - T / 2, [[dy - 0.7, dy + 0.7]])
    furnish(b, r, kind, room, "w")
  })
}

function furnish(b: Builder, r: Rng, kind: RoomKind, room: Rect, door: Side): void {
  const p = inner(room, door)
  const back = OPP[door]
  const floorRect: Rect = [room[0] + T / 2, room[1] + T / 2, room[2] - T / 2, room[3] - T / 2]
  const corners = () => {
    b.prop("plant", p[0], p[1], p[0] + 0.7, p[1] + 0.7)
    if (r.next() < 0.6) b.prop("plant", p[0], p[3] - 0.7, p[0] + 0.7, p[3])
  }
  switch (kind) {
    case "kitchen": {
      b.floor("tile", ...floorRect)
      const counter = strip(p, "n", 0.65, 0, 0.62)
      b.prop("counter", counter[0], counter[1], counter[2], counter[3], FACE_IN.n)
      b.prop("fridge", counter[2] + 0.1, p[1], counter[2] + 0.95, p[1] + 0.8, FACE_IN.n)
      const vx = back === "w" ? p[0] : p[2] - 1.5
      const lid = b.light({ kind: "vending", x: vx + 0.75, y: p[3] - 1.1, h: 1.2, r: 4.8, power: 1, color: [0.25, 0.85, 1], cone: [0, -1, -0.25] })
      b.prop("vending", vx, p[3] - 0.85, vx + 1.5, p[3], FACE_IN.s, true, lid)
      table(b, cx(p), cy(p) + 0.3, 1.6, 1.0)
      b.prop("cooler", back === "w" ? p[2] - 0.6 : p[0], p[3] - 0.6, back === "w" ? p[2] : p[0] + 0.6, p[3])
      b.light({ kind: "panel", x: cx(p), y: cy(p) - 0.8, h: 2.6, r: 6, power: 0.9, color: COLD })
      return
    }
    case "manager": {
      b.floor("wood", ...floorRect)
      // The desk faces the door; the chair sits between it and the back wall.
      const d = strip(p, back, 0.8, 0.3, 0.7)
      const off = { w: [0.9, 0], e: [-0.9, 0], n: [0, 0.9], s: [0, -0.9] }[back]
      const desk: Rect = [d[0] + off[0]!, d[1] + off[1]!, d[2] + off[0]!, d[3] + off[1]!]
      b.prop("desk", desk[0], desk[1], desk[2], desk[3], FACE_IN[door])
      const chair = { x: cx(desk) - off[0]! / 1.8, y: cy(desk) - off[1]! / 1.8 }
      b.prop("chair", chair.x - 0.25, chair.y - 0.25, chair.x + 0.25, chair.y + 0.25, FACE_IN[back], false)
      if (r.next() < 0.85) b.deskLamp(cx(desk) + (off[1] ? 0.5 : 0), cy(desk) + (off[0] ? 0.25 : 0), FACE_IN[door])
      const shelf = strip(p, "n", 0.45, 0.3, 0.9)
      b.prop("bookshelf", shelf[0], shelf[1], shelf[2], shelf[3], FACE_IN.n)
      corners()
      return
    }
    case "lounge": {
      b.floor("wood", ...floorRect)
      const c = { x: cx(p), y: cy(p) }
      b.prop("sofa", c.x - 1.2, c.y - 1.6, c.x + 1.2, c.y - 0.8, 0)
      b.prop("table", c.x - 0.6, c.y - 0.4, c.x + 0.6, c.y + 0.4)
      b.prop("sofa", c.x - 1.2, c.y + 0.8, c.x + 1.2, c.y + 1.6, 2)
      corners()
      b.light({ kind: "bulb", x: c.x + 1.8, y: c.y - 1.4, h: 1.6, r: 5, power: 0.9, color: WARM })
      return
    }
    case "copy": {
      b.floor("tile", ...floorRect)
      const s = strip(p, back, 0.9)
      const along = back === "w" || back === "e"
      const len = along ? s[3] - s[1] : s[2] - s[0]
      const k = Math.max(1, Math.min(3, Math.floor(len / 1.8)))
      for (let i = 0; i < k; i++) {
        const a = (along ? s[1] : s[0]) + ((i + 0.5) * len) / k
        if (along) b.prop("copier", s[0], a - 0.6, s[2], a + 0.6, FACE_IN[back])
        else b.prop("copier", a - 0.6, s[1], a + 0.6, s[3], FACE_IN[back])
      }
      const cab = strip(p, "n", 0.6, 0.1, 0.5)
      b.prop("cabinet", cab[0], cab[1], cab[2], cab[3], FACE_IN.n)
      b.light({ kind: "panel", x: cx(p), y: cy(p), h: 2.6, r: 5.5, power: 0.85, color: COLD })
      return
    }
    case "boardroom": {
      b.floor("wood", ...floorRect)
      const tw = Math.min(1.3, (p[2] - p[0]) * 0.4)
      const th = (p[3] - p[1]) * 0.62
      const t: Rect = [cx(p) - tw / 2, cy(p) - th / 2, cx(p) + tw / 2, cy(p) + th / 2]
      b.prop("table", ...t)
      for (let y = t[1] + 0.45; y < t[3] - 0.3; y += 0.9) {
        b.prop("chair", t[0] - 0.65, y - 0.25, t[0] - 0.15, y + 0.25, 3, false)
        b.prop("chair", t[2] + 0.15, y - 0.25, t[2] + 0.65, y + 0.25, 1, false)
      }
      const wb = strip(p, back, 0.12, 0.25, 0.75)
      b.prop("whiteboard", wb[0], wb[1], wb[2], wb[3], FACE_IN[back], false)
      corners()
      b.light({ kind: "pendant", x: cx(t), y: cy(t), h: 2.2, r: 6.5, power: 1, color: WARM })
      return
    }
    case "meeting": {
      b.floor("carpet", ...floorRect)
      const c = { x: cx(p), y: cy(p) }
      table(b, c.x, c.y, 1.3, 1.3)
      b.prop("plant", p[2] - 0.7, p[1], p[2], p[1] + 0.7)
      if (r.next() < 0.6) b.light({ kind: "pendant", x: c.x, y: c.y, h: 2.2, r: 5.5, power: 0.9, color: WARM })
      return
    }
  }
}

/** A table with a chair on each side. */
function table(b: Builder, x: number, y: number, w: number, h: number): void {
  b.prop("table", x - w / 2, y - h / 2, x + w / 2, y + h / 2)
  b.prop("chair", x - 0.25, y - h / 2 - 0.6, x + 0.25, y - h / 2 - 0.1, 0, false)
  b.prop("chair", x - 0.25, y + h / 2 + 0.1, x + 0.25, y + h / 2 + 0.6, 2, false)
  b.prop("chair", x - w / 2 - 0.6, y - 0.25, x - w / 2 - 0.1, y + 0.25, 3, false)
  b.prop("chair", x + w / 2 + 0.1, y - 0.25, x + w / 2 + 0.6, y + 0.25, 1, false)
}

// Open plan ---------------------------------------------------------------------------------------------------------

function corridorLights(b: Builder, r: Rng, ws: number, xe: number, cy0: number, cy1: number): void {
  const x0 = ws + C / 2
  const x1 = xe - C / 2
  const n = Math.max(2, Math.round((x1 - x0) / 10))
  const spots: Vec[] = []
  for (const y of [cy0 - C / 2, cy1 + C / 2]) for (let i = 0; i < n; i++) spots.push({ x: x0 + ((i + 0.5) * (x1 - x0)) / n, y })
  spots.push({ x: x0, y: (cy0 + cy1) / 2 }, { x: x1, y: (cy0 + cy1) / 2 })
  for (const s of spots) {
    // Not every panel works on this floor.
    if (r.next() < 0.18) continue
    b.light({ kind: "panel", x: s.x, y: s.y, h: 2.6, r: 7, power: 0.95, color: COLD })
  }
}

function openPlan(b: Builder, r: Rng, ws: number, xe: number, zy0: number, zy1: number, side: "n" | "s"): void {
  const x0 = ws + C + 0.6
  const x1 = xe - C - 0.6
  const h = zy1 - zy0
  const rows = h >= 10.5 ? [zy0 + h * 0.28, zy0 + h * 0.72] : [zy0 + h / 2]
  for (const y of rows) {
    const gap = 2.4 + r.next() * 1.2
    const pitch = 3.48 + gap
    const n = Math.floor((x1 - x0 + gap) / pitch)
    const start = x0 + (x1 - x0 - (n * pitch - gap)) / 2 + 1.74
    for (let i = 0; i < n; i++) {
      const x = start + i * pitch
      const roll = r.next()
      if (roll < 0.8) {
        const lamps = (["ne", "nw", "se", "sw"] as const).filter(() => r.next() < 0.22)
        b.cluster(x, y, b.lightsLeft > 2 ? lamps.slice(0, 1) : [])
      } else if (roll < 0.9) {
        b.prop("printer", x - 0.6, y - 0.45, x + 0.6, y + 0.45, side === "n" ? 0 : 2)
        b.prop("plant", x + 1.0, y - 0.35, x + 1.7, y + 0.35)
      } else {
        b.prop("sofa", x - 1.2, y - 0.9, x + 1.2, y - 0.1, 0)
        b.prop("table", x - 0.5, y + 0.2, x + 0.5, y + 0.8)
      }
      if (i < n - 1 && r.next() < 0.35) {
        const px = x + 1.74 + gap / 2
        b.wall(px - 0.25, y - 0.25, px + 0.25, y + 0.25, WALL_H, "pillar")
      }
    }
  }
  // Clutter along the windows, clear of the walkway.
  const wy = side === "n" ? zy0 + 0.1 : zy1 - 0.8
  for (let x = ws + 1; x < xe - 1.5; x += 3 + r.next() * 4) {
    if (r.next() < 0.5) b.prop("plant", x, wy, x + 0.7, wy + 0.7)
    else if (r.next() < 0.5) b.prop("cabinet", x, wy, x + 1.2, wy + 0.6, side === "n" ? 0 : 2)
  }
}

// Spawns ------------------------------------------------------------------------------------------------------------

/** Reachable spots spread evenly across the floor. */
function spawns(map: MapDef, r: Rng, hub: Vec): Vec[] {
  const nav = new Nav(map)
  const reach = nav.reachable(hub)
  const pool: Vec[] = []
  for (let y = 1.2; y < map.size[1] - 1; y += 1.25)
    for (let x = 1.2; x < map.size[0] - 1; x += 1.25) {
      const p = { x: x + r.range(-0.2, 0.2), y: y + r.range(-0.2, 0.2) }
      if (nav.walkable(p) && nav.inMask(reach, p)) pool.push(p)
    }
  const out: Vec[] = [pool[r.int(pool.length)]!]
  while (out.length < SPAWNS && out.length < pool.length) {
    let best = pool[0]!
    let bd = -1
    for (const c of pool) {
      const d = Math.min(...out.map((o) => Math.hypot(o.x - c.x, o.y - c.y)))
      if (d > bd) {
        bd = d
        best = c
      }
    }
    out.push(best)
  }
  return out
}
