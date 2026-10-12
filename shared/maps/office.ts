import type { Rect, Vec } from "../geom"
import { Rng } from "../rng"
import { Nav } from "../sim/nav"
import { Builder, type Gap, T, WALL_H } from "./builder"
import { type CellRect, EDGE, type Plan, type Room, type Side, layout, shuffle } from "./layout"
import type { FloorKind, MapDef, Prop, PropKind } from "./types"

const COLD = [0.8, 0.88, 1] as const
const WARM = [1, 0.72, 0.42] as const
const SPAWNS = 32
/** How far a door's clear zone reaches into the rooms either side. */
const DOOR_CLEAR = 1.3

type Rot = Prop["rot"]
/** Rotation for something standing against wall `side`, facing into the room. */
const FACE_IN: Record<Side, Rot> = { n: 0, s: 2, w: 3, e: 1 }
const OPP: Record<Side, Side> = { n: "s", s: "n", e: "w", w: "e" }
/** The walls either side of `side`. */
const FLANKS: Record<Side, [Side, Side]> = { n: ["w", "e"], s: ["w", "e"], w: ["n", "s"], e: ["n", "s"] }
/** Unit vector pointing into the room from wall `side`. */
const INTO: Record<Side, [number, number]> = { n: [0, 1], s: [0, -1], w: [1, 0], e: [-1, 0] }

const FLOOR_OF: Partial<Record<Room["kind"], FloorKind>> = {
  kitchen: "tile",
  bathroom: "tile",
  copy: "tile",
  manager: "wood",
  boardroom: "wood",
  lounge: "wood",
  core: "tile",
  storage: "concrete",
  closet: "concrete",
  empty: "concrete",
  server: "grate",
}

const overlap = (a: Rect, b: Rect) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]

/**
 * Procedural office floor from a seed: a labyrinth of narrow corridors with rooms hanging off them (see layout.ts),
 * walls and door gaps on the cell edges, furniture per room kind, sparse lights and spawns spread across the floor.
 * The server and every client build the identical floor from one number.
 */
export function generateOffice(seed: number): MapDef {
  const r = new Rng(seed)
  const plan = layout(r)
  const W = plan.xs[plan.gw]!
  const H = plan.ys[plan.gh]!
  const b = new Builder()
  b.floor("carpet", 0, 0, W, H)
  const clear: Rect[] = []
  outerWalls(b, r, W, H)
  walls(b, r, plan, clear, W, H)
  for (const room of plan.rooms) {
    if (!room.rects.length || room.id === 0) continue
    const kind = FLOOR_OF[room.kind]
    if (kind) for (const c of room.rects) b.floor(kind, ...cellRect(plan, c))
  }
  for (const room of plan.rooms) if (room.id > 0 && room.rects.length) furnish(b, r, plan, room, clear, W, H)
  corridors(b, r, plan, clear)
  const nav = repair(b, plan, W, H, seed)
  const map = b.build({ id: `office-${seed}`, seed, name: `Office Tower · FL ${floorOf(seed)}`, size: [W, H] })
  b.spawns.push(...spawns(nav, r, plan))
  return map
}

export const floorOf = (seed: number) => 3 + (seed % 57)

const cellRect = (p: Plan, c: CellRect): Rect => [p.xs[c[0]]!, p.ys[c[1]]!, p.xs[c[2] + 1]!, p.ys[c[3] + 1]!]
const cellCenter = (p: Plan, i: number): Vec => {
  const x = i % p.gw
  const y = Math.floor(i / p.gw)
  return { x: (p.xs[x]! + p.xs[x + 1]!) / 2, y: (p.ys[y]! + p.ys[y + 1]!) / 2 }
}

// Walls ---------------------------------------------------------------------------------------------------------------

/** Two or three sides of the tower are glass; the rest is the building's shell. */
function outerWalls(b: Builder, r: Rng, W: number, H: number): void {
  const sides = shuffle(r, ["n", "s", "e", "w"] as Side[])
  const glass = new Set(sides.slice(0, 2 + r.int(2)))
  const rect: Record<Side, Rect> = { n: [0, 0, W, T], s: [0, H - T, W, H], w: [0, T, T, H - T], e: [W - T, T, W, H - T] }
  for (const s of ["n", "s", "w", "e"] as const) {
    if (glass.has(s)) b.windows.push(rect[s])
    else b.wall(...rect[s], WALL_H, "wall")
  }
}

function doorGap(r: Rng, a: number, z: number): Gap {
  const room = z - a - T - 0.2
  const w = Math.min(1.2 + r.next() * 0.3, room)
  const s = a + T / 2 + 0.1 + r.next() * (room - w)
  return [s, s + w]
}

/** Walls along every edge between zones, merged into runs, with door gaps, glass and open stretches. */
function walls(b: Builder, r: Rng, p: Plan, clear: Rect[], W: number, H: number): void {
  const { gw, gh, xs, ys } = p
  for (let y = 1; y < gh; y++) {
    const ly = ys[y]!
    let x0 = -1
    let gaps: Gap[] = []
    const flush = (end: number) => {
      if (x0 >= 0) b.hwall(ly, Math.max(0, xs[x0]! - T / 2), Math.min(W, xs[end]! + T / 2), gaps)
      x0 = -1
      gaps = []
    }
    for (let x = 0; x < gw; x++) {
      const k = p.h[y * gw + x]
      if (k === EDGE.wall || k === EDGE.door) {
        if (x0 < 0) x0 = x
        if (k === EDGE.door) {
          const g = doorGap(r, xs[x]!, xs[x + 1]!)
          gaps.push(g)
          clear.push([g[0] - 0.15, ly - DOOR_CLEAR, g[1] + 0.15, ly + DOOR_CLEAR])
        }
        continue
      }
      flush(x)
      if (k === EDGE.glass) b.pane(xs[x]!, ly - 0.06, xs[x + 1]!, ly + 0.06)
      if (k === EDGE.open) clear.push([xs[x]!, ly - DOOR_CLEAR, xs[x + 1]!, ly + DOOR_CLEAR])
    }
    flush(gw)
  }
  for (let x = 1; x < gw; x++) {
    const lx = xs[x]!
    let y0 = -1
    let gaps: Gap[] = []
    const flush = (end: number) => {
      if (y0 >= 0) b.vwall(lx, Math.max(0, ys[y0]! - T / 2), Math.min(H, ys[end]! + T / 2), gaps)
      y0 = -1
      gaps = []
    }
    for (let y = 0; y < gh; y++) {
      const k = p.v[y * (gw + 1) + x]
      if (k === EDGE.wall || k === EDGE.door) {
        if (y0 < 0) y0 = y
        if (k === EDGE.door) {
          const g = doorGap(r, ys[y]!, ys[y + 1]!)
          gaps.push(g)
          clear.push([lx - DOOR_CLEAR, g[0] - 0.15, lx + DOOR_CLEAR, g[1] + 0.15])
        }
        continue
      }
      flush(y)
      if (k === EDGE.glass) b.pane(lx - 0.06, ys[y]!, lx + 0.06, ys[y + 1]!)
      if (k === EDGE.open) clear.push([lx - DOOR_CLEAR, ys[y]!, lx + DOOR_CLEAR, ys[y + 1]!])
    }
    flush(gh)
  }
}

// Furniture -----------------------------------------------------------------------------------------------------------

/** Furnishing context for one room: its usable floor, which wall has the door, and what to keep clear. */
class Fit {
  placed: Rect[] = []
  readonly iw: number
  readonly ih: number

  constructor(
    readonly b: Builder,
    readonly r: Rng,
    readonly inner: Rect,
    readonly door: Side,
    readonly avoid: Rect[],
  ) {
    this.iw = inner[2] - inner[0]
    this.ih = inner[3] - inner[1]
  }

  get back(): Side {
    return OPP[this.door]
  }

  /** Length of wall `s` and the room's depth away from it. */
  len(s: Side): number {
    return s === "n" || s === "s" ? this.iw : this.ih
  }

  depth(s: Side): number {
    return s === "n" || s === "s" ? this.ih : this.iw
  }

  /** A rect in wall-local coordinates: u along wall `s` from its west or north end, v out from the wall. */
  at(s: Side, u0: number, v0: number, u1: number, v1: number): Rect {
    const [x0, y0, x1, y1] = this.inner
    if (s === "n") return [x0 + u0, y0 + v0, x0 + u1, y0 + v1]
    if (s === "s") return [x0 + u0, y1 - v1, x0 + u1, y1 - v0]
    if (s === "w") return [x0 + v0, y0 + u0, x0 + v1, y0 + u1]
    return [x1 - v1, y0 + u0, x1 - v0, y0 + u1]
  }

  point(s: Side, u: number, v: number): Vec {
    const rc = this.at(s, u, v, u, v)
    return { x: rc[0], y: rc[1] }
  }

  fits(rc: Rect, gap = 0.08): boolean {
    const [x0, y0, x1, y1] = this.inner
    if (rc[0] < x0 - 0.01 || rc[1] < y0 - 0.01 || rc[2] > x1 + 0.01 || rc[3] > y1 + 0.01) return false
    if (this.avoid.some((a) => overlap(a, rc))) return false
    const g: Rect = [rc[0] - gap, rc[1] - gap, rc[2] + gap, rc[3] + gap]
    return !this.placed.some((q) => overlap(q, g))
  }

  put(kind: PropKind, rc: Rect, rot: Rot, solid = true, light?: number): boolean {
    if (!this.fits(rc)) return false
    this.b.prop(kind, rc[0], rc[1], rc[2], rc[3], rot, solid, light)
    this.placed.push(rc)
    return true
  }

  /** Free-standing shelving, racks or stalls: walls inside the room. */
  solid(rc: Rect, h: number, style: "shelf" | "rack" | "stall" | "pillar" | "core"): boolean {
    if (!this.fits(rc, 0.02)) return false
    this.b.wall(rc[0], rc[1], rc[2], rc[3], h, style)
    this.placed.push(rc)
    return true
  }

  /** u of a span `w` long on wall `s`, at the end nearest the back wall. */
  nearBack(s: Side, w: number, pad = 0.1): number {
    const back = this.back
    return back === "n" || back === "w" ? pad : this.len(s) - w - pad
  }

  nearFront(s: Side, w: number, pad = 0.1): number {
    const back = this.back
    return back === "n" || back === "w" ? this.len(s) - w - pad : pad
  }

  /** A plant in whichever corner is free. */
  plant(): void {
    for (const s of shuffle(this.r, ["n", "s", "e", "w"] as Side[])) {
      const u = this.r.next() < 0.5 ? 0.05 : this.len(s) - 0.7
      if (this.put("plant", this.at(s, u, 0.05, u + 0.65, 0.7), 0)) return
    }
  }

  light(kind: "panel" | "bulb" | "pendant" | "server", x: number, y: number, flicker = 0): number {
    const spec = {
      panel: { h: 2.6, r: 6, power: 0.85, color: COLD },
      bulb: { h: 2.3, r: 4.5, power: 0.8, color: WARM },
      pendant: { h: 2.2, r: 5.5, power: 0.95, color: WARM },
      server: { h: 2.4, r: 5.5, power: 0.8, color: [0.3, 0.5, 1] as const },
    }[kind]
    return this.b.light({ kind, x, y, ...spec, flicker: flicker || undefined })
  }

  get cx(): number {
    return (this.inner[0] + this.inner[2]) / 2
  }

  get cy(): number {
    return (this.inner[1] + this.inner[3]) / 2
  }
}

/** Which wall of the room's main rect has a door (or an open stretch); null when it's only reached via a merged sliver. */
function doorSide(p: Plan, c: CellRect): Side | null {
  const { gw } = p
  const isDoor = (k: number | undefined) => k === EDGE.door || k === EDGE.open
  const found: Side[] = []
  for (let x = c[0]; x <= c[2]; x++) {
    if (isDoor(p.h[c[1] * gw + x])) found.push("n")
    if (isDoor(p.h[(c[3] + 1) * gw + x])) found.push("s")
  }
  for (let y = c[1]; y <= c[3]; y++) {
    if (isDoor(p.v[y * (gw + 1) + c[0]])) found.push("w")
    if (isDoor(p.v[y * (gw + 1) + c[2] + 1])) found.push("e")
  }
  return found[0] ?? null
}

function furnish(b: Builder, r: Rng, p: Plan, room: Room, clear: Rect[], W: number, H: number): void {
  const c = room.rects[0]!
  const [x0, y0, x1, y1] = cellRect(p, c)
  const inner: Rect = [x0 === 0 ? T + 0.02 : x0 + T / 2 + 0.02, y0 === 0 ? T + 0.02 : y0 + T / 2 + 0.02, x1 >= W ? W - T - 0.02 : x1 - T / 2 - 0.02, y1 >= H ? H - T - 0.02 : y1 - T / 2 - 0.02]
  const door = doorSide(p, c) ?? (r.next() < 0.5 ? "s" : "e")
  const f = new Fit(b, r, inner, door, clear.filter((a) => overlap(a, inner)))
  switch (room.kind) {
    case "office":
      return office(f, false)
    case "manager":
      return office(f, true)
    case "storage":
      return storage(f)
    case "closet":
      return closet(f)
    case "server":
      return server(f)
    case "bathroom":
      return bathroom(f)
    case "kitchen":
      return kitchen(f)
    case "copy":
      return copy(f)
    case "meeting":
      return meeting(f)
    case "boardroom":
      return boardroom(f)
    case "lounge":
      return lounge(f)
    case "cubicles":
      return void (cubicles(f, false) || office(f, false))
    case "hall":
      return void (cubicles(f, true) || lounge(f))
    case "core":
      return core(f)
    case "empty":
      return empty(f)
  }
}

/** A desk facing the door with the chair behind it, a cabinet, maybe a lone lamp left on. */
function office(f: Fit, manager: boolean): void {
  const back = f.back
  const L = f.len(back)
  const u = L / 2
  const desk = f.at(back, u - 0.75, 0.85, u + 0.75, 1.6)
  const front = FACE_IN[OPP[back]]
  if (f.put("desk", desk, front)) {
    f.put("chair", f.at(back, u - 0.25, 0.3, u + 0.25, 0.8), FACE_IN[back], false)
    if (f.r.next() < (manager ? 0.5 : 0.2)) {
      const lp = f.point(back, u + 0.45, 1.2)
      f.b.deskLamp(lp.x, lp.y, front)
    }
  }
  const [s1, s2] = f.r.next() < 0.5 ? FLANKS[back] : [...FLANKS[back]].reverse()
  const cu = f.nearBack(s1!, 1.0)
  f.put("cabinet", f.at(s1!, cu, 0, cu + 1.0, 0.55), FACE_IN[s1!])
  if (manager) {
    const bu = f.nearBack(s2!, 1.6)
    f.put("bookshelf", f.at(s2!, bu, 0, bu + 1.6, 0.45), FACE_IN[s2!])
    const su = f.nearFront(s2!, 2.0, 0.3)
    f.put("sofa", f.at(s2!, su, 0.05, su + 2.0, 0.85), FACE_IN[s2!])
    f.plant()
  }
  if (f.r.next() < 0.5) f.plant()
}

/** Rows of shelving out from the back wall with aisles between them; one bare bulb, if it works. */
function storage(f: Fit): void {
  const back = f.back
  const L = f.len(back)
  const D = f.depth(back)
  const reach = D - 1.5
  if (reach >= 1.2)
    for (let u = 0.1; u + 0.55 <= L - 0.1; u += 1.75) f.solid(f.at(back, u, 0.05, u + 0.55, reach - f.r.next() * Math.min(1, reach - 1.2)), 2.0, "shelf")
  for (let k = 0; k < 3; k++) {
    const s = f.r.pick(FLANKS[back])
    const u = f.nearFront(s, 0.7, 0.1 + k * 0.8)
    if (f.r.next() < 0.6) f.put("crate", f.at(s, u, 0.05, u + 0.7, 0.75), 0)
  }
  if (f.r.next() < 0.2) f.light("bulb", f.cx, f.cy, 0.5)
}

function closet(f: Fit): void {
  const back = f.back
  const L = f.len(back)
  if (f.r.next() < 0.6) f.solid(f.at(back, 0.05, 0.05, L - 0.05, 0.5), 2.0, "shelf")
  else f.put("crate", f.at(back, 0.1, 0.05, 0.8, 0.75), 0)
  const s = f.r.pick(FLANKS[back])
  if (f.r.next() < 0.3) f.put(f.r.next() < 0.5 ? "cabinet" : "crate", f.at(s, f.nearBack(s, 0.7, 0.8), 0.05, f.nearBack(s, 0.7, 0.8) + 0.7, 0.6), FACE_IN[s])
  if (f.r.next() < 0.08) f.light("bulb", f.cx, f.cy, 0.7)
}

/** Racks out from the back wall, glowing; the room's blue light is usually on. */
function server(f: Fit): void {
  const back = f.back
  const L = f.len(back)
  const D = f.depth(back)
  const reach = D - 1.4
  if (reach >= 1)
    for (let u = 0.2; u + 0.7 <= L - 0.2; u += 1.95) f.solid(f.at(back, u, 0.3, u + 0.7, reach), 2.1, "rack")
  else f.solid(f.at(back, 0.2, 0.05, L - 0.2, 0.75), 2.1, "rack")
  if (f.r.next() < 0.75) f.light("server", f.cx, f.cy, 0.1)
}

function bathroom(f: Fit): void {
  const back = f.back
  const L = f.len(back)
  const D = f.depth(back)
  const n = Math.min(5, Math.floor((L - 0.6) / 1.2))
  if (n >= 1 && D >= 3) {
    const u0 = (L - n * 1.2) / 2
    for (let i = 0; i <= n; i++) f.solid(f.at(back, u0 + i * 1.2 - 0.04, 0, u0 + i * 1.2 + 0.04, 1.5), 2.0, "stall")
  }
  for (const s of shuffle(f.r, [...FLANKS[back]])) {
    const w = Math.min(1.8, f.len(s) - (n >= 1 ? 2.0 : 0.6))
    if (w < 0.8) continue
    const u = f.nearFront(s, w, 0.3)
    if (f.put("counter", f.at(s, u, 0, u + w, 0.55), FACE_IN[s])) break
  }
  if (f.r.next() < 0.35) f.light("panel", f.cx, f.cy, 0.6)
}

/** Counter and fridge on the back wall, a glowing vending machine, a table if there's room. */
function kitchen(f: Fit): void {
  const back = f.back
  const L = f.len(back)
  const D = f.depth(back)
  const cl = Math.max(1, Math.min(L * 0.6, L - 1.2))
  f.put("counter", f.at(back, 0.05, 0, cl, 0.65), FACE_IN[back])
  f.put("fridge", f.at(back, cl + 0.1, 0, cl + 0.95, 0.8), FACE_IN[back])
  for (const s of shuffle(f.r, [...FLANKS[back]])) {
    const u = f.nearFront(s, 1.4, 0.4)
    const rc = f.at(s, u, 0, u + 1.4, 0.85)
    if (!f.fits(rc)) continue
    const [dx, dy] = INTO[s]
    const mid = f.point(s, u + 0.7, 1.1)
    const id = f.b.light({ kind: "vending", x: mid.x, y: mid.y, h: 1.2, r: 4.8, power: 1, color: [0.25, 0.85, 1], cone: [dx, dy, -0.25] })
    f.put("vending", rc, FACE_IN[s], true, id)
    break
  }
  if (D >= 4.6 && L >= 3.6) table(f, f.cx, f.cy + (back === "n" ? 0.4 : back === "s" ? -0.4 : 0), 1.3, 0.9)
  if (f.r.next() < 0.5) {
    const s = f.r.pick(FLANKS[back])
    const u = f.nearBack(s, 0.55, 0.9)
    f.put("cooler", f.at(s, u, 0.05, u + 0.55, 0.6), FACE_IN[s])
  }
  if (f.r.next() < 0.25) f.light("panel", f.cx, f.cy, 0.4)
}

function copy(f: Fit): void {
  const back = f.back
  const L = f.len(back)
  const k = Math.max(1, Math.min(3, Math.floor(L / 1.8)))
  for (let i = 0; i < k; i++) {
    const u = ((i + 0.5) * L) / k
    f.put("copier", f.at(back, u - 0.6, 0.05, u + 0.6, 0.95), FACE_IN[back])
  }
  const s = f.r.pick(FLANKS[back])
  const u = f.nearFront(s, 1.2, 0.3)
  f.put("cabinet", f.at(s, u, 0, u + 1.2, 0.6), FACE_IN[s])
  if (f.r.next() < 0.3) f.light("panel", f.cx, f.cy, 0.8)
}

/** A table with a chair on each side. */
function table(f: Fit, x: number, y: number, w: number, h: number): void {
  if (!f.put("table", [x - w / 2, y - h / 2, x + w / 2, y + h / 2], 0)) return
  f.put("chair", [x - 0.25, y - h / 2 - 0.6, x + 0.25, y - h / 2 - 0.1], 0, false)
  f.put("chair", [x - 0.25, y + h / 2 + 0.1, x + 0.25, y + h / 2 + 0.6], 2, false)
  f.put("chair", [x - w / 2 - 0.6, y - 0.25, x - w / 2 - 0.1, y + 0.25], 3, false)
  f.put("chair", [x + w / 2 + 0.1, y - 0.25, x + w / 2 + 0.6, y + 0.25], 1, false)
}

function meeting(f: Fit): void {
  const w = Math.min(2.2, f.iw - 2.6)
  const h = Math.min(1.3, f.ih - 2.6)
  if (w >= 0.9 && h >= 0.9) table(f, f.cx, f.cy, w, h)
  f.plant()
  if (f.r.next() < 0.45) f.light("pendant", f.cx, f.cy)
}

/** A long table down the room's long axis, chairs along it, a whiteboard on the back wall. */
function boardroom(f: Fit): void {
  const wide = f.iw >= f.ih
  const len = (wide ? f.iw : f.ih) * 0.6
  const tw = Math.min(1.3, (wide ? f.ih : f.iw) - 2.6)
  if (tw >= 0.9) {
    const t: Rect = wide ? [f.cx - len / 2, f.cy - tw / 2, f.cx + len / 2, f.cy + tw / 2] : [f.cx - tw / 2, f.cy - len / 2, f.cx + tw / 2, f.cy + len / 2]
    if (f.put("table", t, wide ? 1 : 0)) {
      for (let a = 0.45; a < len - 0.3; a += 0.9) {
        if (wide) {
          f.put("chair", [t[0] + a - 0.25, t[1] - 0.65, t[0] + a + 0.25, t[1] - 0.15], 0, false)
          f.put("chair", [t[0] + a - 0.25, t[3] + 0.15, t[0] + a + 0.25, t[3] + 0.65], 2, false)
        } else {
          f.put("chair", [t[0] - 0.65, t[1] + a - 0.25, t[0] - 0.15, t[1] + a + 0.25], 3, false)
          f.put("chair", [t[2] + 0.15, t[1] + a - 0.25, t[2] + 0.65, t[1] + a + 0.25], 1, false)
        }
      }
    }
  }
  const back = f.back
  const L = f.len(back)
  f.put("whiteboard", f.at(back, L * 0.25, 0, L * 0.75, 0.12), FACE_IN[back], false)
  f.plant()
  f.plant()
  if (f.r.next() < 0.6) f.light("pendant", f.cx, f.cy)
}

function lounge(f: Fit): void {
  const { cx, cy } = f
  f.put("sofa", [cx - 1.2, cy - 1.6, cx + 1.2, cy - 0.8], 0)
  f.put("table", [cx - 0.6, cy - 0.4, cx + 0.6, cy + 0.4], 0)
  f.put("sofa", [cx - 1.2, cy + 0.8, cx + 1.2, cy + 1.6], 2)
  f.plant()
  if (f.r.next() < 0.5) f.light("bulb", cx + 1.7, cy - 1.2, 0.2)
}

/** Open plan: desk clusters in a grid with aisles, a desk lamp or two left burning, pillars in the big halls. */
function cubicles(f: Fit, hall: boolean): boolean {
  const ax = 1.7
  const ay = 1.8
  const px = 3.48 + ax
  const py = 2.4 + ay
  const m = 1.25
  const nx = Math.floor((f.iw - 2 * m + ax) / px)
  const ny = Math.floor((f.ih - 2 * m + ay) / py)
  if (nx < 1 || ny < 1) return false
  const x0 = f.cx - (nx * px - ax) / 2 + 1.74
  const y0 = f.cy - (ny * py - ay) / 2 + 1.2
  let placed = 0
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const x = x0 + i * px
      const y = y0 + j * py
      const foot: Rect = [x - 1.78, y - 1.24, x + 1.78, y + 1.24]
      if (!f.fits(foot, 0.1)) continue
      if (f.r.next() < 0.1) {
        // A gap in the rows: a printer or an abandoned sofa.
        if (f.r.next() < 0.5) f.put("printer", [x - 0.6, y - 0.45, x + 0.6, y + 0.45], f.r.next() < 0.5 ? 0 : 2)
        else f.put("sofa", [x - 1.2, y - 0.4, x + 1.2, y + 0.4], 0)
        continue
      }
      const lamp = f.r.next() < (hall ? 0.09 : 0.14) ? [f.r.pick(["ne", "nw", "se", "sw"] as const)] : []
      f.b.cluster(x, y, lamp)
      f.placed.push(foot)
      placed++
      if (hall && i < nx - 1 && j < ny - 1 && f.r.next() < 0.35) f.solid([x + px / 2 - 0.25, y + py / 2 - 0.25, x + px / 2 + 0.25, y + py / 2 + 0.25], WALL_H, "pillar")
    }
  if (!placed) return false
  if (hall) {
    for (let k = 0; k < 2; k++) if (f.r.next() < 0.45) f.light("panel", f.r.range(f.inner[0] + 2, f.inner[2] - 2), f.r.range(f.inner[1] + 2, f.inner[3] - 2), f.r.next())
    for (let k = 0; k < 4; k++) f.plant()
    const s = f.r.pick(FLANKS[f.back])
    const u = f.nearBack(s, 1.2, 0.4)
    f.put("printer", f.at(s, u, 0.05, u + 1.2, 0.95), FACE_IN[s])
  }
  return true
}

/** Lift core: a dark shaft block in the middle with a stair door and its EXIT sign, a lobby ring around it. */
function core(f: Fit): void {
  const ring = 2.1
  const shaft: Rect = [f.inner[0] + ring, f.inner[1] + ring, f.inner[2] - ring, f.inner[3] - ring]
  if (shaft[2] - shaft[0] < 1.2 || shaft[3] - shaft[1] < 1.2 || !f.solid(shaft, WALL_H, "core")) return void lounge(f)
  const s = f.door
  // The stair door on the shaft face toward the main entrance.
  const [dx, dy] = INTO[s]
  const fx = s === "w" ? shaft[0] : s === "e" ? shaft[2] : (shaft[0] + shaft[2]) / 2
  const fy = s === "n" ? shaft[1] : s === "s" ? shaft[3] : (shaft[1] + shaft[3]) / 2
  const horiz = s === "n" || s === "s"
  f.b.prop("exitdoor", horiz ? fx - 0.7 : fx - 0.2, horiz ? fy - 0.2 : fy - 0.7, horiz ? fx + 0.7 : fx + 0.2, horiz ? fy + 0.2 : fy + 0.7, FACE_IN[s], false)
  f.b.light({ kind: "exit", x: fx - dx * 0.35, y: fy - dy * 0.35, h: 2.4, r: 4.5, power: 0.7, color: [1, 0.16, 0.45], cone: [-dx, -dy, 0.1] })
  if (f.r.next() < 0.4) f.light("bulb", f.inner[0] + 1, f.inner[1] + 1, 0.3)
}

/** Abandoned: a few crates and a stray chair in the dark. */
function empty(f: Fit): void {
  const n = f.r.int(4)
  for (let k = 0; k < n; k++) {
    const s = f.r.pick(["n", "s", "e", "w"] as Side[])
    const u = f.r.range(0.1, Math.max(0.1, f.len(s) - 0.8))
    f.put("crate", f.at(s, u, 0.05, u + 0.7, 0.75), 0)
  }
  if (f.r.next() < 0.4) f.put("chair", [f.cx - 0.25, f.cy - 0.25, f.cx + 0.25, f.cy + 0.25], f.r.int(4) as Rot, false)
}

// Corridors -----------------------------------------------------------------------------------------------------------

/**
 * Sparse panels over a few junctions and stretches, far apart so most corridors are dark, and the dead ends dressed:
 * a vending machine glowing at the end, an EXIT sign over a locked fire door, a water cooler.
 */
function corridors(b: Builder, r: Rng, p: Plan, clear: Rect[]): void {
  const { gw, gh } = p
  const isC = (x: number, y: number) => x >= 0 && y >= 0 && x < gw && y < gh && p.zone[y * gw + x] === 0
  const lit: Vec[] = []
  const cells: number[] = []
  for (let i = 0; i < gw * gh; i++) if (p.zone[i] === 0) cells.push(i)
  const dirs: [Side, number, number][] = [
    ["e", 1, 0],
    ["w", -1, 0],
    ["s", 0, 1],
    ["n", 0, -1],
  ]
  for (const i of shuffle(r, [...cells])) {
    const x = i % gw
    const y = Math.floor(i / gw)
    const open = dirs.filter(([, dx, dy]) => isC(x + dx, y + dy))
    const c = cellCenter(p, i)
    if (open.length === 1) {
      // Dead end: dress the wall opposite the way in.
      const end = OPP[open[0]![0]]
      const edge = end === "n" ? p.h[y * gw + x] : end === "s" ? p.h[(y + 1) * gw + x] : end === "w" ? p.v[y * (gw + 1) + x] : p.v[y * (gw + 1) + x + 1]
      const outer = (end === "n" && y === 0) || (end === "s" && y === gh - 1) || (end === "w" && x === 0) || (end === "e" && x === gw - 1)
      if (edge !== EDGE.wall && !outer) continue
      const [x0, y0, x1, y1] = cellRect(p, [x, y, x, y])
      const inner: Rect = [x === 0 ? T : x0 + T / 2, y === 0 ? T : y0 + T / 2, x === gw - 1 ? x1 - T : x1 - T / 2, y === gh - 1 ? y1 - T : y1 - T / 2]
      const f = new Fit(b, r, inner, OPP[end], clear.filter((a) => overlap(a, inner)))
      const L = f.len(end)
      const [dx, dy] = INTO[end]
      const roll = r.next()
      if (roll < 0.22) {
        const rc = f.at(end, L / 2 - 0.65, 0, L / 2 + 0.65, 0.8)
        if (f.fits(rc)) {
          const m = f.point(end, L / 2, 1.0)
          const id = b.light({ kind: "vending", x: m.x, y: m.y, h: 1.2, r: 4.8, power: 1, color: [0.25, 0.85, 1], cone: [dx, dy, -0.25], flicker: r.next() < 0.3 ? 0.3 : undefined })
          f.put("vending", rc, FACE_IN[end], true, id)
          lit.push(m)
        }
      } else if (roll < 0.45 && !outer) {
        const rc = f.at(end, L / 2 - 0.7, -0.2, L / 2 + 0.7, 0.2)
        b.prop("exitdoor", rc[0], rc[1], rc[2], rc[3], FACE_IN[end], false)
        const m = f.point(end, L / 2, 0.35)
        b.light({ kind: "exit", x: m.x, y: m.y, h: 2.4, r: 4.5, power: 0.7, color: [1, 0.16, 0.45], cone: [dx, dy, 0.1] })
      } else if (roll < 0.58) f.put("cooler", f.at(end, L / 2 - 0.3, 0.05, L / 2 + 0.3, 0.6), FACE_IN[end])
      else if (roll < 0.66) f.put("plant", f.at(end, L / 2 - 0.35, 0.05, L / 2 + 0.35, 0.75), 0)
      continue
    }
    const chance = open.length >= 3 ? 0.3 : 0.035
    if (r.next() > chance || lit.some((q) => Math.hypot(q.x - c.x, q.y - c.y) < 12)) continue
    b.light({ kind: "panel", x: c.x, y: c.y, h: 2.6, r: 6.5, power: 0.85, color: COLD, flicker: r.next() < 0.3 ? r.range(0.3, 0.9) : undefined })
    lit.push(c)
  }
}

// Checks and spawns ---------------------------------------------------------------------------------------------------

/** A corridor cell whose centre is walkable, to flood the floor from. */
function hub(nav: Nav, p: Plan): Vec {
  for (let i = 0; i < p.gw * p.gh; i++) if (p.zone[i] === 0 && nav.walkable(cellCenter(p, i))) return cellCenter(p, i)
  return { x: p.xs[1]!, y: p.ys[1]! }
}

/** Removes solid furniture that seals off a pocket of floor, until everything walkable is reachable. Returns the nav grid. */
function repair(b: Builder, p: Plan, W: number, H: number, seed: number): Nav {
  for (let pass = 0; ; pass++) {
    const nav = new Nav(b.build({ id: `office-${seed}`, seed, name: "", size: [W, H] }))
    if (pass >= 4) return nav
    const reach = nav.reachable(hub(nav, p))
    const stuck: Vec[] = []
    for (let cy = 0; cy < nav.h; cy++)
      for (let cx = 0; cx < nav.w; cx++) {
        const i = cy * nav.w + cx
        if (nav.grid[i] === 0 && !reach[i]) stuck.push({ x: (cx + 0.5) * 0.5, y: (cy + 0.5) * 0.5 })
      }
    if (!stuck.length) return nav
    const before = b.props.length
    b.props = b.props.filter((q) => !q.solid || !stuck.some((s) => s.x > q.rect[0] - 0.9 && s.x < q.rect[2] + 0.9 && s.y > q.rect[1] - 0.9 && s.y < q.rect[3] + 0.9))
    if (b.props.length === before) return nav
  }
}

/** Reachable spots spread evenly across the floor by farthest-point sampling, away from walls. */
function spawns(nav: Nav, r: Rng, p: Plan): Vec[] {
  const reach = nav.reachable(hub(nav, p))
  const pool: Vec[] = []
  for (let cy = 1; cy < nav.h - 1; cy += 2)
    for (let cx = 1; cx < nav.w - 1; cx += 2) {
      const i = cy * nav.w + cx
      if (!reach[i] || nav.grid[i - 1] || nav.grid[i + 1] || nav.grid[i - nav.w] || nav.grid[i + nav.w]) continue
      pool.push({ x: (cx + 0.5) * 0.5, y: (cy + 0.5) * 0.5 })
    }
  const out: Vec[] = [pool[r.int(pool.length)]!]
  const dist = pool.map((q) => Math.hypot(q.x - out[0]!.x, q.y - out[0]!.y))
  while (out.length < SPAWNS && out.length < pool.length) {
    let best = 0
    for (let k = 1; k < pool.length; k++) if (dist[k]! > dist[best]!) best = k
    const s = pool[best]!
    out.push(s)
    for (let k = 0; k < pool.length; k++) dist[k] = Math.min(dist[k]!, Math.hypot(pool[k]!.x - s.x, pool[k]!.y - s.y))
  }
  return out
}
