import type { Rect, Vec } from "../geom"
import { Rng } from "../rng"
import { Nav } from "../sim/nav"
import { Builder, T, WALL_H } from "./builder"
import { type Plan, type Room, type Side, contact, layout, shuffle } from "./layout"
import type { FloorKind, MapDef, Prop, PropKind } from "./types"

const COLD = [0.8, 0.88, 1] as const
const WARM = [1, 0.72, 0.42] as const
const SPAWNS = 16
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
  reception: "wood",
  atrium: "tile",
  stair: "concrete",
  storage: "concrete",
  closet: "concrete",
  empty: "concrete",
  server: "grate",
}

const overlap = (a: Rect, b: Rect) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]

/**
 * Procedural office floor from a seed: a believable tower floor plan (see layout.ts), walls with door openings and
 * glass fronts, furniture per room kind, sparse lights and spawns spread across the floor. The server and every client
 * build the identical floor from one number.
 */
export function generateOffice(seed: number): MapDef {
  const r = new Rng(seed)
  const plan = layout(r)
  const { W, H } = plan
  const b = new Builder()
  b.floor("carpet", 0, 0, W, H)
  const clear: Rect[] = []
  outerWalls(b, r, W, H, plan.solid)
  walls(b, plan, clear, W, H)
  for (const room of plan.rooms) {
    const kind = FLOOR_OF[room.kind]
    if (kind) b.floor(kind, ...room.rect)
  }
  for (const room of plan.rooms) furnish(b, r, plan, room, clear, W, H)
  corridors(b, r, plan, clear, W, H)
  const nav = repair(b, plan, W, H, seed)
  const map = b.build({ id: `office-${seed}`, seed, name: `Office Tower · FL ${floorOf(seed)}`, size: [W, H] })
  b.spawns.push(...spawns(nav, r, plan))
  return map
}

export const floorOf = (seed: number) => 3 + (seed % 57)

// Walls ---------------------------------------------------------------------------------------------------------------

/** Two or three sides of the tower are glass; the rest is the building's shell, including any side an exit is on. */
function outerWalls(b: Builder, r: Rng, W: number, H: number, solid: Side[]): void {
  const sides = shuffle(
    r,
    (["n", "s", "e", "w"] as Side[]).filter((s) => !solid.includes(s)),
  )
  const glass = new Set(sides.slice(0, Math.max(1, Math.min(sides.length, 2 + r.int(2)))))
  const rect: Record<Side, Rect> = { n: [0, 0, W, T], s: [0, H - T, W, H], w: [0, T, T, H - T], e: [W - T, T, W, H - T] }
  for (const s of ["n", "s", "w", "e"] as const) {
    if (glass.has(s)) b.windows.push(rect[s])
    else b.wall(...rect[s], WALL_H, "wall")
  }
}

type Span = [number, number]

/** Merges overlapping spans. */
function union(spans: Span[]): Span[] {
  const out: Span[] = []
  for (const s of [...spans].sort((a, b) => a[0] - b[0])) {
    const last = out[out.length - 1]
    if (last && s[0] <= last[1] + 1e-3) last[1] = Math.max(last[1], s[1])
    else out.push([s[0], s[1]])
  }
  return out
}

/** Spans minus the cut spans. */
function subtract(spans: Span[], cuts: Span[]): Span[] {
  let out = spans
  for (const c of cuts) {
    const next: Span[] = []
    for (const s of out) {
      if (c[1] <= s[0] + 1e-3 || c[0] >= s[1] - 1e-3) {
        next.push(s)
        continue
      }
      if (c[0] > s[0] + 1e-3) next.push([s[0], c[0]])
      if (c[1] < s[1] - 1e-3) next.push([c[1], s[1]])
    }
    out = next
  }
  return out
}

/**
 * Walls along every room edge, merged per wall line, with doors and open stretches as gaps and glass fronts as panes.
 * Lift shafts are solid blocks; columns stand in open frontages.
 */
function walls(b: Builder, p: Plan, clear: Rect[], W: number, H: number): void {
  const lines = { h: new Map<number, Span[]>(), v: new Map<number, Span[]>() }
  const cuts = { h: new Map<number, Span[]>(), v: new Map<number, Span[]>() }
  const gaps = { h: new Map<number, Span[]>(), v: new Map<number, Span[]>() }
  const add = (m: Map<number, Span[]>, k: number, a: number, z: number) => {
    const key = Math.round(k * 100)
    const list = m.get(key) ?? []
    list.push([a, z])
    m.set(key, list)
  }
  const E = 1e-3
  const shafts: Rect[] = []
  for (const room of p.rooms) {
    const [x0, y0, x1, y1] = room.rect
    if (room.kind === "shaft") {
      shafts.push(room.rect)
      b.wall(Math.max(T, x0 - T / 2), Math.max(T, y0 - T / 2), Math.min(W - T, x1 + T / 2), Math.min(H - T, y1 + T / 2), WALL_H, "core")
      add(cuts.h, y0, x0 - T / 2, x1 + T / 2)
      add(cuts.h, y1, x0 - T / 2, x1 + T / 2)
      add(cuts.v, x0, y0 - T / 2, y1 + T / 2)
      add(cuts.v, x1, y0 - T / 2, y1 + T / 2)
      continue
    }
    if (y0 > E) add(lines.h, y0, x0, x1)
    if (y1 < H - E) add(lines.h, y1, x0, x1)
    if (x0 > E) add(lines.v, x0, y0, y1)
    if (x1 < W - E) add(lines.v, x1, y0, y1)
  }
  for (const o of p.openings) {
    const hz = Math.abs(o.y0 - o.y1) < E
    if (o.kind === "glass") b.pane(hz ? o.x0 : o.x0 - 0.06, hz ? o.y0 - 0.06 : o.y0, hz ? o.x1 : o.x0 + 0.06, hz ? o.y0 + 0.06 : o.y1)
    else if (hz) clear.push([o.x0 - 0.15, o.y0 - DOOR_CLEAR, o.x1 + 0.15, o.y0 + DOOR_CLEAR])
    else clear.push([o.x0 - DOOR_CLEAR, o.y0 - 0.15, o.x0 + DOOR_CLEAR, o.y1 + 0.15])
    if (hz) add(gaps.h, o.y0, o.x0, o.x1)
    else add(gaps.v, o.x0, o.y0, o.y1)
  }
  for (const dir of ["h", "v"] as const) {
    for (const [key, spans] of lines[dir]) {
      const l = key / 100
      const max = dir === "h" ? W : H
      const runs = subtract(union(spans), cuts[dir].get(key) ?? [])
      const holes = union(gaps[dir].get(key) ?? [])
      const touches = (u: number) => {
        const x = dir === "h" ? u : l
        const y = dir === "h" ? l : u
        return shafts.some((c) => x >= c[0] - E && x <= c[2] + E && y >= c[1] - E && y <= c[3] + E)
      }
      for (const [a, z] of runs) {
        // Runs reach half a wall past their ends to close the corners, except into a shaft.
        const a2 = touches(a) ? a : Math.max(0, a - T / 2)
        const z2 = touches(z) ? z : Math.min(max, z + T / 2)
        const inside = holes.filter((g) => g[0] < z - E && g[1] > a + E).map((g): Span => [Math.max(a2, g[0]), Math.min(z2, g[1])])
        if (dir === "h") b.hwall(l, a2, z2, inside)
        else b.vwall(l, a2, z2, inside)
      }
    }
  }
  for (const c of p.pillars) b.wall(...c, WALL_H, "pillar")
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

/** Which wall the room's main way in is on: a door or open stretch, else its front. */
function doorSide(p: Plan, room: Room): Side {
  const [x0, y0, x1, y1] = room.rect
  const E = 1e-3
  for (const o of p.openings) {
    if (o.kind === "glass" || (o.a !== room.id && o.b !== room.id)) continue
    if (Math.abs(o.y0 - o.y1) < E) {
      if (Math.abs(o.y0 - y0) < E) return "n"
      if (Math.abs(o.y0 - y1) < E) return "s"
    } else {
      if (Math.abs(o.x0 - x0) < E) return "w"
      if (Math.abs(o.x0 - x1) < E) return "e"
    }
  }
  return room.front
}

function furnish(b: Builder, r: Rng, p: Plan, room: Room, clear: Rect[], W: number, H: number): void {
  if (room.kind === "shaft") return
  const [x0, y0, x1, y1] = room.rect
  const inner: Rect = [x0 < 0.01 ? T + 0.02 : x0 + T / 2 + 0.02, y0 < 0.01 ? T + 0.02 : y0 + T / 2 + 0.02, x1 > W - 0.01 ? W - T - 0.02 : x1 - T / 2 - 0.02, y1 > H - 0.01 ? H - T - 0.02 : y1 - T / 2 - 0.02]
  const door = doorSide(p, room)
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
      return lobby(f, !p.rooms.some((x) => x.kind === "reception"))
    case "reception":
      return reception(f)
    case "stair":
      return stair(f)
    case "atrium":
      return atrium(f)
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
  // Sofas leave a clear walk round each end.
  const w = Math.min(1.2, (f.iw - 2.6) / 2)
  if (w >= 0.6 && f.ih >= 4.4) {
    f.put("sofa", [cx - w, cy - 1.6, cx + w, cy - 0.8], 0)
    f.put("table", [cx - 0.6, cy - 0.4, cx + 0.6, cy + 0.4], 0)
    f.put("sofa", [cx - w, cy + 0.8, cx + w, cy + 1.6], 2)
  }
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
      if (hall && i < nx - 1 && j < ny - 1 && (i % 2 === 1 || nx <= 3)) f.solid([x + px / 2 - 0.25, y + py / 2 - 0.25, x + px / 2 + 0.25, y + py / 2 + 0.25], WALL_H, "pillar")
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

/** Lift lobby: kept clear in front of the lift doors, a bench and a plant by the corridor, a reception desk when roomy. */
function lobby(f: Fit, desk: boolean): void {
  const front = f.door
  const L = f.len(front)
  const D = f.depth(front)
  if (desk && L >= 5.4 && D >= 4.2) {
    const rc = f.at(front, L / 2 - 1.2, 1.4, L / 2 + 1.2, 2.2)
    if (f.put("reception", rc, FACE_IN[front])) f.put("chair", f.at(front, L / 2 - 0.25, 2.3, L / 2 + 0.25, 2.8), FACE_IN[front], false)
  }
  for (const s of shuffle(f.r, [...FLANKS[front]])) {
    if (D < 3.4) break
    const u = f.nearFront(s, 1.8, 0.6)
    if (f.put("sofa", f.at(s, u, 0.05, u + 1.8, 0.8), FACE_IN[s])) break
  }
  f.plant()
  if (f.r.next() < 0.5) f.light("bulb", f.cx, f.cy, 0.3)
}

/** Reception facing the lifts: a long desk, a waiting sofa, plants, usually a warm light left on. */
function reception(f: Fit): void {
  const back = f.back
  const L = f.len(back)
  const D = f.depth(back)
  const w = Math.min(3, L - 2)
  const u = f.r.next() < 0.5 ? L / 2 - w / 2 : f.nearBack(back, w, 0.9)
  if (D >= 3.5 && f.put("reception", f.at(back, u, 1.2, u + w, 2.05), FACE_IN[OPP[back]])) f.put("chair", f.at(back, u + w / 2 - 0.25, 0.45, u + w / 2 + 0.25, 0.95), FACE_IN[back], false)
  const s = f.r.pick(FLANKS[back])
  const su = f.nearFront(s, 2.0, 0.5)
  f.put("sofa", f.at(s, su, 0.05, su + 2.0, 0.85), FACE_IN[s])
  f.plant()
  f.plant()
  if (f.r.next() < 0.7) f.light("pendant", f.cx, f.cy)
}

/** Fire stair: a bare vestibule with the stair door and its EXIT sign on the far wall. */
function stair(f: Fit): void {
  const back = f.back
  const L = f.len(back)
  const [bx, by] = INTO[back]
  const rc = f.at(back, L / 2 - 0.7, -0.2, L / 2 + 0.7, 0.2)
  f.b.prop("exitdoor", rc[0], rc[1], rc[2], rc[3], FACE_IN[back], false)
  f.placed.push(f.at(back, L / 2 - 0.8, 0, L / 2 + 0.8, 1.2))
  const m = f.point(back, L / 2, 0.35)
  f.b.light({ kind: "exit", x: m.x, y: m.y, h: 2.4, r: 4.5, power: 0.7, color: [1, 0.16, 0.45], cone: [bx, by, 0.1] })
  const s = f.r.pick(FLANKS[back])
  if (f.r.next() < 0.5) f.put("crate", f.at(s, f.nearFront(s, 0.7, 0.3), 0.05, f.nearFront(s, 0.7, 0.3) + 0.7, 0.75), 0)
}

/** Glazed garden court: planters in a grid, benches, a pool of cold light from above. */
function atrium(f: Fit): void {
  const nx = Math.max(1, Math.floor((f.iw - 2) / 3))
  const ny = Math.max(1, Math.floor((f.ih - 2) / 3))
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const x = f.inner[0] + ((i + 0.5) * f.iw) / nx
      const y = f.inner[1] + ((j + 0.5) * f.ih) / ny
      if ((i + j) % 2 === 0) f.put("plant", [x - 0.4, y - 0.4, x + 0.4, y + 0.4], 0)
      else if (f.r.next() < 0.6) f.put("sofa", [x - 0.9, y - 0.4, x + 0.9, y + 0.4], f.r.next() < 0.5 ? 0 : 2)
    }
  f.plant()
  f.plant()
  if (f.r.next() < 0.6) f.light("panel", f.cx, f.cy, 0.2)
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
 * Sparse panels over a few corridor junctions and long runs, far apart so most of the floor is dark. Corridors that run
 * into the outer wall end at a fire exit, or a vending machine glowing at the end, a water cooler or a plant.
 */
function corridors(b: Builder, r: Rng, p: Plan, clear: Rect[], W: number, H: number): void {
  const lit: Vec[] = []
  for (const e of p.ends) {
    const c = p.corridors[-1 - e.corridor]!
    const y0 = c[1] + T / 2 + 0.02
    const y1 = c[3] - T / 2 - 0.02
    const x0 = c[0] + T / 2 + 0.02
    const x1 = c[2] - T / 2 - 0.02
    const inner: Rect = e.side === "w" ? [T + 0.02, y0, T + 2.2, y1] : e.side === "e" ? [W - T - 2.2, y0, W - T - 0.02, y1] : e.side === "n" ? [x0, T + 0.02, x1, T + 2.2] : [x0, H - T - 2.2, x1, H - T - 0.02]
    const end = e.side
    const f = new Fit(b, r, inner, OPP[end], clear.filter((a) => overlap(a, inner)))
    const L = f.len(end)
    const [dx, dy] = INTO[end]
    if (e.exit) {
      const rc = f.at(end, L / 2 - 0.7, -0.2, L / 2 + 0.7, 0.2)
      b.prop("exitdoor", rc[0], rc[1], rc[2], rc[3], FACE_IN[end], false)
      const m = f.point(end, L / 2, 0.35)
      b.light({ kind: "exit", x: m.x, y: m.y, h: 2.4, r: 4.5, power: 0.7, color: [1, 0.16, 0.45], cone: [dx, dy, 0.1] })
      continue
    }
    const roll = r.next()
    if (roll < 0.5) {
      const rc = f.at(end, L / 2 - 0.65, 0, L / 2 + 0.65, 0.8)
      if (f.fits(rc)) {
        const m = f.point(end, L / 2, 1.0)
        const id = b.light({ kind: "vending", x: m.x, y: m.y, h: 1.2, r: 4.8, power: 1, color: [0.25, 0.85, 1], cone: [dx, dy, -0.25], flicker: r.next() < 0.3 ? 0.3 : undefined })
        f.put("vending", rc, FACE_IN[end], true, id)
        lit.push(m)
      }
    } else if (roll < 0.75) f.put("cooler", f.at(end, L / 2 - 0.3, 0.05, L / 2 + 0.3, 0.6), FACE_IN[end])
    else f.put("plant", f.at(end, L / 2 - 0.35, 0.05, L / 2 + 0.35, 0.75), 0)
  }
  // Junctions first, then points along the runs.
  const spots: { v: Vec; chance: number }[] = []
  p.corridors.forEach((a, i) =>
    p.corridors.forEach((c, j) => {
      if (j <= i) return
      const t = contact(a, c)
      if (!t) return
      const hz = t.side === "n" || t.side === "s"
      const l = t.side === "n" ? a[1] : t.side === "s" ? a[3] : t.side === "w" ? a[0] : a[2]
      spots.push({ v: hz ? { x: (t.lo + t.hi) / 2, y: l } : { x: l, y: (t.lo + t.hi) / 2 }, chance: 0.4 })
    }),
  )
  for (const c of p.corridors) {
    const hz = c[2] - c[0] >= c[3] - c[1]
    const len = hz ? c[2] - c[0] : c[3] - c[1]
    for (let u = 3; u < len - 3; u += 6) spots.push({ v: hz ? { x: c[0] + u, y: (c[1] + c[3]) / 2 } : { x: (c[0] + c[2]) / 2, y: c[1] + u }, chance: 0.1 })
  }
  // Then, on a floor that came out too dark to play, a few more.
  for (const pass of [0, 1]) {
    for (const { v, chance } of shuffle(r, spots)) {
      if (pass && b.lights.length >= 12) break
      if ((!pass && r.next() > chance) || lit.some((q) => Math.hypot(q.x - v.x, q.y - v.y) < (pass ? 9 : 12))) continue
      b.light({ kind: "panel", x: v.x, y: v.y, h: 2.6, r: 6.5, power: 0.85, color: COLD, flicker: r.next() < 0.3 ? r.range(0.3, 0.9) : undefined })
      lit.push(v)
    }
  }
}

// Checks and spawns ---------------------------------------------------------------------------------------------------

/** A corridor spot that is walkable, to flood the floor from. */
function hub(nav: Nav, p: Plan): Vec {
  for (const c of p.corridors) {
    const v = { x: (c[0] + c[2]) / 2, y: (c[1] + c[3]) / 2 }
    if (nav.walkable(v)) return v
  }
  return nav.nearest({ x: p.W / 2, y: p.H / 2 })
}

/** Removes solid furniture that seals off a pocket of floor, until everything walkable is reachable. Returns the nav grid. */
function repair(b: Builder, p: Plan, W: number, H: number, seed: number): Nav {
  for (let pass = 0; ; pass++) {
    const nav = new Nav(b.build({ id: `office-${seed}`, seed, name: "", size: [W, H] }))
    if (pass >= 5) return nav
    const reach = nav.reachable(hub(nav, p))
    // Unreachable pockets big enough to matter; slivers behind a desk aren't worth losing the desk over.
    const stuck: Vec[] = []
    const seen = new Uint8Array(nav.grid.length)
    for (let i = 0; i < nav.grid.length; i++) {
      if (nav.grid[i] || reach[i] || seen[i]) continue
      const comp = [i]
      seen[i] = 1
      for (let k = 0; k < comp.length; k++) {
        const c = comp[k]!
        for (const n of [c + 1, c - 1, c + nav.w, c - nav.w]) {
          if (n < 0 || n >= nav.grid.length || seen[n] || nav.grid[n] || reach[n]) continue
          if (Math.abs((n % nav.w) - (c % nav.w)) > 1) continue
          seen[n] = 1
          comp.push(n)
        }
      }
      if (comp.length >= 12) for (const c of comp) stuck.push({ x: ((c % nav.w) + 0.5) * 0.5, y: (Math.floor(c / nav.w) + 0.5) * 0.5 })
    }
    if (!stuck.length) return nav
    const near = (rc: Rect, d: number) => stuck.some((s) => s.x > rc[0] - d && s.x < rc[2] + d && s.y > rc[1] - d && s.y < rc[3] + d)
    const before = b.props.length + b.walls.length
    b.props = b.props.filter((q) => !q.solid || !near(q.rect, 1))
    // Then free-standing shelving, racks and stalls; structural walls and cubicle partitions stay.
    if (b.props.length + b.walls.length === before) b.walls = b.walls.filter((w) => !(w.style === "shelf" || w.style === "rack" || w.style === "stall" || w.style === "pillar") || !near(w.rect, 1))
    if (b.props.length + b.walls.length === before) return nav
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
