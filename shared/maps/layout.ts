import type { Rect } from "../geom"
import type { Rng } from "../rng"

export type Side = "n" | "s" | "e" | "w"

export type RoomKind =
  | "office"
  | "manager"
  | "storage"
  | "closet"
  | "server"
  | "bathroom"
  | "kitchen"
  | "copy"
  | "meeting"
  | "boardroom"
  | "lounge"
  | "cubicles"
  | "empty"
  | "hall"
  | "core"
  | "reception"
  | "stair"
  | "shaft"
  | "atrium"

/** A room: `front` is the wall facing the corridor (or open plan) it is entered from. Shafts are solid. */
export type Room = { id: number; kind: RoomKind; rect: Rect; front: Side }

export type OpeningKind = "door" | "open" | "glass"
/**
 * A stretch of wall line that isn't plain wall, between zones a and b. Zones are room ids (>= 0) or -1 - k for
 * corridor k. Horizontal when y0 === y1.
 */
export type Opening = { kind: OpeningKind; x0: number; y0: number; x1: number; y1: number; a: number; b: number }

/** Where a corridor runs into the outer wall: the middle of its end on the wall line, which wall, and whether it's a fire exit. */
export type End = { x: number; y: number; side: Side; exit: boolean; corridor: number }

/**
 * The floor's arrangement:
 * - ring: a corridor loop round a central zone holding the lift core and support rooms, offices or open plan outside it.
 * - spine: two straight corridors the length of the floor, linked by cross corridors, ending at fire exits.
 * - atrium: a ring round a glazed garden court, the core to one side of it.
 * - sidecore: the core against one facade, one spine corridor, a deep open-plan floor beyond.
 */
export type Archetype = "ring" | "spine" | "atrium" | "sidecore"

export type Plan = {
  W: number
  H: number
  archetype: Archetype
  rooms: Room[]
  corridors: Rect[]
  openings: Opening[]
  ends: End[]
  /** Structural columns standing in open frontages. */
  pillars: Rect[]
  /** Outer walls that must be solid (fire exits and the core sit against them). */
  solid: Side[]
}

const EPS = 1e-3
const q = (v: number) => Math.round(v * 100) / 100
/** A value from lo to hi in steps (planning-grid dimensions). */
const step = (r: Rng, lo: number, hi: number, by: number) => q(lo + by * r.int(Math.floor((hi - lo) / by + EPS) + 1))

export function shuffle<T>(r: Rng, xs: T[]): T[] {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = r.int(i + 1)
    ;[xs[i], xs[j]] = [xs[j]!, xs[i]!]
  }
  return xs
}

function weighted<T>(r: Rng, table: readonly (readonly [T, number])[]): T {
  const total = table.reduce((s, [, w]) => s + Math.max(0, w), 0)
  let x = r.next() * total
  for (const [v, w] of table) {
    x -= Math.max(0, w)
    if (x < 0) return v
  }
  return table[table.length - 1]![0]
}

const OPP: Record<Side, Side> = { n: "s", s: "n", e: "w", w: "e" }
const horizontal = (s: Side) => s === "n" || s === "s"

/** The edge rect a shares with rect b: which side of a, and the overlap along it. */
export function contact(a: Rect, b: Rect): { side: Side; lo: number; hi: number } | null {
  const ox0 = Math.max(a[0], b[0])
  const ox1 = Math.min(a[2], b[2])
  const oy0 = Math.max(a[1], b[1])
  const oy1 = Math.min(a[3], b[3])
  if (ox1 - ox0 > EPS) {
    if (Math.abs(a[3] - b[1]) < EPS) return { side: "s", lo: ox0, hi: ox1 }
    if (Math.abs(a[1] - b[3]) < EPS) return { side: "n", lo: ox0, hi: ox1 }
  }
  if (oy1 - oy0 > EPS) {
    if (Math.abs(a[2] - b[0]) < EPS) return { side: "e", lo: oy0, hi: oy1 }
    if (Math.abs(a[0] - b[2]) < EPS) return { side: "w", lo: oy0, hi: oy1 }
  }
  return null
}

/** Coordinate of side s's wall line. */
const lineOf = (rc: Rect, s: Side) => (s === "n" ? rc[1] : s === "s" ? rc[3] : s === "w" ? rc[0] : rc[2])

/** Rooms that count as circulation: you can walk through them to reach the rooms off them. */
const THROUGH = new Set<RoomKind>(["hall", "reception", "core"])

type Slot = "perim" | "inner" | "support"
type Hand = "lo" | "hi" | "mid"

class Gen {
  rooms: Room[] = []
  corridors: Rect[] = []
  openings: Opening[] = []
  ends: End[] = []
  pillars: Rect[] = []
  solid = new Set<Side>()
  /** Per room: where along its frontage the door goes, and whether the rest of the frontage is glazed. */
  hand = new Map<number, Hand>()
  glazed = new Set<number>()
  need = new Map<RoomKind, number>([
    ["kitchen", 1],
    ["copy", 1],
    ["server", 1],
    ["storage", 1],
    ["meeting", 2],
  ])

  constructor(
    readonly r: Rng,
    readonly W: number,
    readonly H: number,
  ) {}

  /** How many of each kind the floor has so far. */
  count = new Map<RoomKind, number>()

  /** Books a room kind against the floor's program. */
  tally(kind: RoomKind): void {
    this.count.set(kind, (this.count.get(kind) ?? 0) + 1)
    const n = this.need.get(kind)
    if (n) this.need.set(kind, n - 1)
  }

  room(kind: RoomKind, rc: Rect, front: Side, tally = true): Room {
    const room: Room = { id: this.rooms.length, kind, rect: [q(rc[0]), q(rc[1]), q(rc[2]), q(rc[3])], front }
    this.rooms.push(room)
    if (tally) this.tally(kind)
    return room
  }

  corridor(rc: Rect): number {
    this.corridors.push([q(rc[0]), q(rc[1]), q(rc[2]), q(rc[3])])
    return -this.corridors.length
  }

  rect(z: number): Rect {
    return z >= 0 ? this.rooms[z]!.rect : this.corridors[-z - 1]!
  }

  open(kind: OpeningKind, a: number, b: number, side: Side, lo: number, hi: number): void {
    const rc = this.rect(a)
    const l = lineOf(rc, side)
    if (hi - lo < 0.2) return
    if (horizontal(side)) this.openings.push({ kind, x0: q(lo), y0: l, x1: q(hi), y1: l, a, b })
    else this.openings.push({ kind, x0: l, y0: q(lo), x1: l, y1: q(hi), a, b })
  }

  /** Corridors and walk-through rooms touching rect rc on side s, with the overlap. */
  frontage(rc: Rect, s: Side, self = -999): { z: number; lo: number; hi: number }[] {
    const out: { z: number; lo: number; hi: number }[] = []
    this.corridors.forEach((c, k) => {
      const t = contact(rc, c)
      if (t && t.side === s) out.push({ z: -1 - k, lo: t.lo, hi: t.hi })
    })
    for (const o of this.rooms) {
      if (o.id === self || !THROUGH.has(o.kind)) continue
      const t = contact(rc, o.rect)
      if (t && t.side === s) out.push({ z: o.id, lo: t.lo, hi: t.hi })
    }
    return out
  }

  /** A room kind and how many bays it takes, for a row of bays of width `bay` and depth `depth`. */
  pick(slot: Slot, bay: number, depth: number, left: number, end: boolean): [RoomKind, number] {
    const span = (w: number) => Math.max(1, Math.ceil((w - 0.2) / bay))
    const needs = (k: RoomKind) => ((this.need.get(k) ?? 0) > 0 ? 1 : 0)
    const opts: [RoomKind, number, number][] =
      slot === "perim"
        ? [
            ["manager", bay >= 4.2 ? 1 : 2, 3],
            ["office", 1, bay <= 4.8 ? 4 : 1],
            ["meeting", span(5), 0.8 + 3 * needs("meeting")],
            ["boardroom", span(8), depth >= 5 ? (end ? 1.6 : 0.5) : 0],
            ["empty", 1, 0.8],
            ["kitchen", span(6), 0.05 + needs("kitchen")],
            ["copy", 1, 0.1],
            ["storage", 1, 0.2],
          ]
        : slot === "support"
          ? [
              ["meeting", span(5), 2 + 4 * needs("meeting")],
              ["boardroom", span(8), 1.2],
              ["kitchen", span(6), 0.1 + 6 * needs("kitchen")],
              ["copy", 1, 0.15 + 5 * needs("copy")],
              ["storage", 1, 0.8 + 4 * needs("storage")],
              ["server", 1, 0.15 + 4 * needs("server")],
              ["manager", bay >= 4.2 ? 1 : 2, 2],
              ["lounge", span(6), 0.6],
              ["empty", 1, 0.6],
            ]
          : [
              ["kitchen", span(6), 0.15 + 6 * needs("kitchen")],
              ["copy", 1, 0.3 + 6 * needs("copy")],
              ["server", 1, 0.3 + 6 * needs("server")],
              ["storage", 1, 0.8 + 4 * needs("storage")],
              ["meeting", span(4.8), 2 + 4 * needs("meeting")],
              ["boardroom", span(7.5), 0.6],
              ["lounge", span(6), 0.5],
              ["closet", 1, bay <= 3.6 ? 0.6 : 0],
              ["empty", 1, 1.2],
              ["office", 1, 1],
              ["manager", bay >= 4.2 ? 1 : 2, 0.6],
            ]
    // Each repeat of a kind makes it less likely again; offices come in rows, so they're exempt.
    const big = (k: RoomKind) => k === "kitchen" || k === "lounge" || k === "boardroom" || k === "reception"
    const used = (k: RoomKind) => (k === "office" || k === "manager" ? 0 : (this.count.get(k) ?? 0) * (big(k) ? 4 : 1.6))
    const fit = opts.filter(([, n, w]) => w > 0 && n <= left).map(([k, n, w]) => [[k, n] as [RoomKind, number], w / (1 + used(k))] as const)
    const out: [RoomKind, number] = fit.length ? weighted(this.r, fit) : [slot === "perim" ? "office" : "storage", left]
    this.tally(out[0])
    return out
  }

  /**
   * A row of rooms along a band, entered from side `front`: equal bays on the planning grid, grouped into rooms by
   * kind. End rooms without enough frontage widen into corner rooms. `reception` turns the room at that coordinate
   * into the reception facing the lifts.
   */
  row(rc: Rect, front: Side, slot: Slot, opts: { bay?: number; reception?: number } = {}): Room[] {
    const r = this.r
    const along = horizontal(front)
    const u0 = along ? rc[0] : rc[1]
    const u1 = along ? rc[2] : rc[3]
    const depth = along ? rc[3] - rc[1] : rc[2] - rc[0]
    const L = u1 - u0
    if (L < 1.5 || depth < 1.5) return []
    const fr = this.frontage(rc, front)
    const fa = fr.length ? Math.min(...fr.map((f) => f.lo)) : u0
    const fb = fr.length ? Math.max(...fr.map((f) => f.hi)) : u1
    const bay = opts.bay ?? (slot === "perim" ? r.pick([3.6, 3.6, 4.2, 4.5]) : r.pick([3.3, 3.6, 4.2]))
    const n = Math.max(1, Math.round(L / bay))
    const bw = L / n
    const groups: { kind: RoomKind; a: number; b: number }[] = []
    for (let i = 0; i < n; ) {
      const [kind, span] = this.pick(slot, bw, depth, n - i, i === 0 || i + 1 >= n)
      groups.push({ kind, a: i, b: i + span })
      i += span
    }
    const at = (i: number) => u0 + i * bw
    const merge = (k: number) => {
      const g = groups[k]!
      const h = groups[k + 1]!
      const big = g.b - g.a >= h.b - h.a ? g : h
      groups.splice(k, 2, { kind: big.kind === "office" || big.kind === "empty" ? (r.next() < 0.5 ? "meeting" : "manager") : big.kind, a: g.a, b: h.b })
    }
    // Every room needs a door's worth of frontage, so corner rooms take in their neighbours.
    while (groups.length > 1 && Math.min(at(groups[0]!.b), fb) - Math.max(at(groups[0]!.a), fa) < 2.2) merge(0)
    while (groups.length > 1 && Math.min(at(groups[groups.length - 1]!.b), fb) - Math.max(at(groups[groups.length - 1]!.a), fa) < 2.2) merge(groups.length - 2)
    if (opts.reception !== undefined) {
      const k = groups.findIndex((g) => at(g.a) <= opts.reception! && at(g.b) >= opts.reception!)
      if (k >= 0) {
        if ((groups[k]!.b - groups[k]!.a) * bw < 4.5 && groups.length > 1) merge(k + 1 < groups.length ? k : k - 1)
        const j = groups.findIndex((g) => at(g.a) <= opts.reception! && at(g.b) >= opts.reception!)
        groups[j]!.kind = "reception"
        this.tally("reception")
      }
    }
    // Doors fall at the same end of every room in a row; glass fronts are a row-wide choice too.
    const hand: Hand = r.pick(["lo", "hi", "lo", "hi", "mid"])
    const glazed = r.next() < 0.45
    return groups.map((g) => {
      const a = q(at(g.a))
      const b = q(at(g.b))
      const room = this.room(g.kind, along ? [a, rc[1], b, rc[3]] : [rc[0], a, rc[2], b], front, false)
      this.hand.set(room.id, hand)
      if (glazed || g.kind === "meeting" || g.kind === "boardroom") this.glazed.add(room.id)
      return room
    })
  }

  /**
   * Open-plan workspace along a facade, open to its corridor between structural columns (or behind a glass screen),
   * sometimes with an enclosed room at either end.
   */
  openBand(rc: Rect, front: Side): void {
    const r = this.r
    const along = horizontal(front)
    let u0 = along ? rc[0] : rc[1]
    let u1 = along ? rc[2] : rc[3]
    const depth = along ? rc[3] - rc[1] : rc[2] - rc[0]
    const sub = (a: number, b: number): Rect => (along ? [a, rc[1], b, rc[3]] : [rc[0], a, rc[2], b])
    for (const lo of [true, false]) {
      if (r.next() > 0.55 || u1 - u0 < 20) continue
      const w = step(r, 4.8, 7.2, 0.6)
      const kind = weighted<RoomKind>(r, [
        ["meeting", 2],
        ["manager", 2],
        ["boardroom", w >= 6 && depth >= 6 ? 1.5 : 0],
        ["lounge", depth >= 6 ? 1 : 0],
        ["kitchen", (this.need.get("kitchen") ?? 0) > 0 ? 1.5 : 0.3],
      ])
      const room = this.room(kind, sub(lo ? u0 : u1 - w, lo ? u0 + w : u1), front)
      if (kind === "meeting" || kind === "boardroom" || r.next() < 0.5) this.glazed.add(room.id)
      this.hand.set(room.id, lo ? "hi" : "lo")
      if (lo) u0 += w
      else u1 -= w
    }
    const hall = this.room("hall", sub(u0, u1), front)
    this.frontOpen(hall, r.next() < 0.3)
  }

  /** Opens a walk-through room onto everything along its front: columns at a regular spacing, or a glass screen with doors. */
  frontOpen(room: Room, screen: boolean): void {
    const r = this.r
    const along = horizontal(room.front)
    const l = lineOf(room.rect, room.front)
    for (const f of this.frontage(room.rect, room.front, room.id)) {
      const lo = f.lo + 0.15
      const hi = f.hi - 0.15
      if (hi - lo < 1.5) continue
      if (screen) {
        const doors = Math.max(1, Math.round((hi - lo) / 12))
        let u = lo
        for (let k = 0; k < doors; k++) {
          const c = lo + ((k + 0.5) * (hi - lo)) / doors
          this.open("glass", room.id, f.z, room.front, u, c - 0.9)
          this.open("open", room.id, f.z, room.front, c - 0.9, c + 0.9)
          u = c + 0.9
        }
        this.open("glass", room.id, f.z, room.front, u, hi)
        continue
      }
      const span = hi - lo
      const bays = Math.max(1, Math.round(span / step(r, 5.4, 7.2, 0.6)))
      let u = lo
      for (let k = 1; k <= bays; k++) {
        const c = k < bays ? lo + (k * span) / bays : hi
        const end = k < bays ? c - 0.25 : hi
        this.open("open", room.id, f.z, room.front, u, end)
        if (k < bays) this.pillars.push(along ? [q(c - 0.25), q(l - 0.25), q(c + 0.25), q(l + 0.25)] : [q(l - 0.25), q(c - 0.25), q(l + 0.25), q(c + 0.25)])
        u = c + 0.25
      }
    }
  }

  /**
   * The service core in a block between two corridors (or against a facade when `back` is set): toilets, a lift bank
   * with its lobby, and a fire stair with a riser or server room. Returns the lobby's centre along the block.
   */
  core(rc: Rect, fronts: Side[]): number {
    const r = this.r
    const [x0, y0, x1, y1] = rc
    const D = y1 - y0
    const Cw = x1 - x0
    let wc = step(r, 4.2, 5.4, 0.6)
    let aux = step(r, 3.6, 4.8, 0.6)
    let lift = Cw - wc - aux
    while (lift > 9 && wc < 7.2) {
      wc = q(wc + 0.6)
      lift = q(lift - 0.6)
      if (lift > 9 && aux < 6) {
        aux = q(aux + 0.6)
        lift = q(lift - 0.6)
      }
    }
    while (lift < 5.4 && wc > 3.6) {
      wc = q(wc - 0.6)
      lift = q(lift + 0.6)
    }
    const cols: ["wc" | "lift" | "aux", number][] = r.next() < 0.5 ? [["wc", wc], ["lift", lift], ["aux", aux]] : [["aux", aux], ["lift", lift], ["wc", wc]]
    const both = fronts.length === 2
    const top: Side = fronts.includes("n") ? "n" : "s"
    let x = x0
    let lobby = (x0 + x1) / 2
    for (const [kind, w] of cols) {
      const a = x
      const b = kind === cols[2]![0] ? x1 : q(x + w)
      x = b
      if (kind === "lift") {
        lobby = (a + b) / 2
        if (both && D >= 12) {
          // Lifts back to back, a lobby onto each corridor.
          const sd = Math.min(6, Math.max(4.2, q(D - 8.4)))
          const m = q(y0 + (D - sd) / 2)
          this.room("core", [a, y0, b, m], "n")
          this.room("shaft", [a, m, b, q(m + sd)], "n")
          this.room("core", [a, q(m + sd), b, y1], "s")
        } else {
          const sd = Math.min(5.4, Math.max(3.6, q(D - 4.2)))
          if (top === "s") {
            this.room("shaft", [a, y0, b, q(y0 + sd)], "s")
            this.room("core", [a, q(y0 + sd), b, y1], "s")
          } else {
            this.room("core", [a, y0, b, q(y1 - sd)], "n")
            this.room("shaft", [a, q(y1 - sd), b, y1], "n")
          }
        }
      } else if (kind === "wc") {
        if (both && D >= 8) {
          const m = q(y0 + D / 2)
          this.room("bathroom", [a, y0, b, m], "n")
          this.room("bathroom", [a, m, b, y1], "s")
        } else if (b - a >= 7) {
          const m = q((a + b) / 2)
          this.room("bathroom", [a, y0, m, y1], top)
          this.room("bathroom", [m, y0, b, y1], top)
        } else this.room("bathroom", [a, y0, b, y1], top)
      } else {
        const sd = Math.min(6, Math.max(4.2, q(D / 2)))
        const kind2 = weighted<RoomKind>(r, [
          ["closet", 2],
          ["server", (this.need.get("server") ?? 0) > 0 ? 3 : 0.5],
          ["storage", 1],
        ])
        if (both && D - sd >= 3.6) {
          const up = r.next() < 0.5
          if (up) {
            this.room("stair", [a, y0, b, q(y0 + sd)], "n")
            this.room(kind2, [a, q(y0 + sd), b, y1], "s")
          } else {
            this.room(kind2, [a, y0, b, q(y1 - sd)], "n")
            this.room("stair", [a, q(y1 - sd), b, y1], "s")
          }
        } else this.room("stair", [a, y0, b, y1], top)
      }
    }
    return lobby
  }

  /** A block between corridors: a double-loaded pair of rows, a single row, or one big room. */
  inner(rc: Rect, slot: Slot = "inner"): void {
    const r = this.r
    const [x0, y0, x1, y1] = rc
    const D = y1 - y0
    const w = x1 - x0
    const fn = this.frontage(rc, "n").length > 0
    const fs = this.frontage(rc, "s").length > 0
    if (w >= 8 && w <= 16 && D <= 16 && r.next() < 0.22) {
      const kind = weighted<RoomKind>(r, [
        ["cubicles", w >= 10 ? 2 : 0],
        ["lounge", 1],
        ["boardroom", w <= 12 ? 1 : 0],
        ["storage", 0.6],
      ])
      const room = this.room(kind, rc, fn ? "n" : "s")
      if (kind === "cubicles" && fn && fs) {
        // A team room open to both corridors: another way through.
        this.frontOpen(room, r.next() < 0.5)
        room.front = OPP[room.front]
        this.frontOpen(room, true)
        room.front = OPP[room.front]
      }
      return
    }
    if (D >= 9.6 && fn && fs) {
      const m = q(y0 + Math.round((D / 2 + (r.int(3) - 1) * 0.6) / 0.3) * 0.3)
      this.row([x0, y0, x1, m], "n", slot)
      this.row([x0, m, x1, y1], "s", slot)
    } else this.row(rc, fn ? "n" : "s", slot)
  }
}

/** Picks a long band's kind and depth: a row of offices (cell) or open plan. */
const bandDepth = (r: Rng, t: "cell" | "open") => (t === "cell" ? step(r, 4.8, 6.6, 0.6) : step(r, 9.6, 12, 0.6))

/** Ring, spine and atrium floors: bands along the long facades, two long corridors, a central zone split into blocks. */
function banded(r: Rng, arch: "ring" | "spine" | "atrium"): Gen {
  const c = r.pick([2.1, 2.4, 2.4, 2.7])
  let tN: "cell" | "open" = "cell"
  let tS: "cell" | "open" = "open"
  let dN = 5.4
  let dS = 10.2
  let H = 36
  for (let tries = 0; tries < 60; tries++) {
    ;[tN, tS] = weighted<["cell" | "open", "cell" | "open"]>(r, [
      [["cell", "open"], 3],
      [["open", "cell"], 3],
      [["cell", "cell"], 2],
      [["open", "open"], arch === "spine" ? 1 : 0.6],
    ])
    dN = bandDepth(r, tN)
    dS = bandDepth(r, tS)
    H = step(r, 33, 40, 0.3)
    const mid = H - dN - dS - 2 * c
    if (mid >= (arch === "atrium" ? 12 : 10.8) && mid <= 18) break
    tN = "cell"
    tS = "open"
    dN = 5.4
    dS = 10.2
    H = q(dN + dS + 2 * c + 14.4)
  }
  const W = step(r, 48, 58, 0.3)
  const g = new Gen(r, W, H)
  const yN = dN
  const yS = q(H - dS)
  let cx0 = 0
  let cx1 = W
  let tW: "cell" | "open" | "none" = "none"
  let tE: "cell" | "open" | "none" = "none"
  let stub: { side: "w" | "e"; y: number } | null = null
  if (arch === "spine") {
    const n = g.corridor([0, yN, W, yN + c])
    const s = g.corridor([0, yS - c, W, yS])
    const diag = r.next() < 0.5
    g.ends.push({ x: 0, y: yN + c / 2, side: "w", exit: diag, corridor: n })
    g.ends.push({ x: W, y: yN + c / 2, side: "e", exit: !diag, corridor: n })
    g.ends.push({ x: 0, y: yS - c / 2, side: "w", exit: !diag, corridor: s })
    g.ends.push({ x: W, y: yS - c / 2, side: "e", exit: diag, corridor: s })
    g.solid.add("w")
    g.solid.add("e")
  } else {
    const side = () => weighted<"cell" | "open" | "none">(r, [
      ["cell", 6],
      ["open", 2.5],
      ["none", 1.2],
    ])
    tW = side()
    tE = side()
    if (tW === "none" && tE === "none") tE = "cell"
    const dW = tW === "none" ? 0 : tW === "cell" ? step(r, 4.8, 6.6, 0.6) : step(r, 9, 10.8, 0.6)
    const dE = tE === "none" ? 0 : tE === "cell" ? step(r, 4.8, 6.6, 0.6) : step(r, 9, 10.8, 0.6)
    cx0 = dW
    cx1 = q(W - dE)
    g.corridor([cx0, yN, cx1, yN + c])
    g.corridor([cx0, yS - c, cx1, yS])
    g.corridor([cx0, yN + c, cx0 + c, yS - c])
    g.corridor([cx1 - c, yN + c, cx1, yS - c])
    // An escape corridor out through an office row to a fire stair on the facade.
    const cand = (["w", "e"] as const).filter((s) => (s === "w" ? tW : tE) === "cell")
    if (cand.length && yS - yN >= 15 && r.next() < 0.55) {
      const s = r.pick(cand)
      const y = q(Math.round(((yN + yS) / 2 - c / 2 + (r.int(3) - 1) * 1.2) / 0.3) * 0.3)
      const k = s === "w" ? g.corridor([0, y, cx0, y + c]) : g.corridor([cx1, y, W, y + c])
      g.ends.push({ x: s === "w" ? 0 : W, y: q(y + c / 2), side: s, exit: true, corridor: k })
      g.solid.add(s)
      stub = { side: s, y }
    }
  }

  // The central zone: blocks across it, a cross corridor between some of them.
  const mx0 = arch === "spine" ? 0 : q(cx0 + c)
  const mx1 = arch === "spine" ? W : q(cx1 - c)
  const my0 = q(yN + c)
  const my1 = q(yS - c)
  const IW = mx1 - mx0
  type Block = { kind: "core" | "atrium" | "inner"; w: number }
  const blocks: Block[] = []
  const coreW = step(r, 13.2, 17.4, 0.6)
  const atrium = arch === "atrium" && IW - coreW - 2 * c >= 9
  if (atrium) {
    const aw = Math.min(step(r, 9, 13.2, 0.6), q(IW - coreW - 2 * c))
    const coreFirst = r.next() < 0.5
    const rest = IW - aw - coreW - 2 * c
    blocks.push({ kind: "core", w: coreW }, { kind: "atrium", w: aw })
    if (rest >= 6.6) blocks.push({ kind: "inner", w: rest })
    else blocks[0]!.w += rest + c
    if (!coreFirst) blocks.reverse()
    if (blocks.length === 3 && blocks[1]!.kind !== "atrium") [blocks[1], blocks[2]] = [blocks[2]!, blocks[1]!]
  } else {
    const three = IW - coreW >= 2 * 6.6 + 2 * c
    if (three) {
      const at = arch === "spine" ? 1 : weighted(r, [[1, 3], [0, 1], [2, 1]] as const)
      for (let k = 0; k < 3; k++) blocks.push({ kind: k === at ? "core" : "inner", w: 0 })
    } else blocks.push(...(r.next() < 0.5 ? [{ kind: "core" as const, w: 0 }, { kind: "inner" as const, w: 0 }] : [{ kind: "inner" as const, w: 0 }, { kind: "core" as const, w: 0 }]))
  }
  // Cross corridors: always in spines and round the atrium, otherwise sometimes.
  const gaps = blocks.slice(1).map((b, k) => arch === "spine" || b.kind === "atrium" || blocks[k]!.kind === "atrium" || r.next() < 0.5)
  if (arch !== "spine" && gaps.length && !gaps.some(Boolean) && r.next() < 0.5) gaps[r.int(gaps.length)] = true
  if (!atrium) {
    let free = IW - coreW - gaps.filter(Boolean).length * c
    let others = blocks.filter((b) => b.kind !== "core")
    if (arch !== "spine" && free / others.length < 6.6) {
      gaps.fill(false)
      free = IW - coreW
    }
    if (free / others.length < 6.6) {
      // Too narrow to share: the core takes the whole zone.
      blocks.splice(0, blocks.length, { kind: "core", w: IW })
      gaps.length = 0
      others = []
    }
    const share = free / others.length
    let left = free
    others.forEach((b, k) => {
      b.w = k === others.length - 1 ? left : q(Math.round((share * (0.85 + r.next() * 0.3)) / 0.3) * 0.3)
      left = q(left - b.w)
    })
    if (others.length) blocks.find((b) => b.kind === "core")!.w = coreW
  }
  let x = mx0
  let lobby = W / 2
  const pending: { kind: Block["kind"]; rc: Rect }[] = []
  blocks.forEach((b, k) => {
    const x1 = k === blocks.length - 1 ? mx1 : q(x + b.w)
    pending.push({ kind: b.kind, rc: [x, my0, x1, my1] })
    x = x1
    if (k < gaps.length && gaps[k]) {
      g.corridor([x, my0, q(x + c), my1])
      x = q(x + c)
    }
  })
  // The core first: the reception faces its lift lobby.
  for (const p of pending) if (p.kind === "core") lobby = g.core(p.rc, ["n", "s"])
  const rec = tN === "cell" && (tS !== "cell" || r.next() < 0.5) ? "n" : tS === "cell" ? "s" : null

  // Bands along the facades. Open plan first so the rooms beside it can open into it.
  const bands: { t: "cell" | "open"; rc: Rect; front: Side; recept: boolean }[] = []
  bands.push({ t: tN, rc: [0, 0, W, yN], front: "s", recept: rec === "n" })
  bands.push({ t: tS, rc: [0, yS, W, H], front: "n", recept: rec === "s" })
  for (const [t, s, rc] of [
    [tW, "w", [0, yN, cx0, yS]],
    [tE, "e", [cx1, yN, W, yS]],
  ] as const) {
    if (t === "none") continue
    const front = OPP[s]
    if (stub?.side === s && t === "cell") {
      bands.push({ t, rc: [rc[0], rc[1], rc[2], stub.y], front, recept: false })
      bands.push({ t, rc: [rc[0], q(stub.y + c), rc[2], rc[3]], front, recept: false })
    } else bands.push({ t, rc: [...rc], front, recept: false })
  }
  for (const b of [...bands.filter((x) => x.t === "open"), ...bands.filter((x) => x.t === "cell")]) {
    if (b.t === "cell") g.row(b.rc, b.front, "perim", b.recept ? { reception: lobby } : {})
    else g.openBand(b.rc, b.front)
  }
  for (const p of pending) {
    if (p.kind === "atrium") g.room("atrium", p.rc, "n")
    else if (p.kind === "inner") g.inner(p.rc)
  }
  return g
}

/** Side core: the core and support rooms along the north facade, a spine corridor, a deep open-plan floor to the south. */
function sidecore(r: Rng): Gen {
  const c = r.pick([2.1, 2.4, 2.4, 2.7])
  const W = step(r, 48, 58, 0.3)
  const H = step(r, 33, 40, 0.3)
  const g = new Gen(r, W, H)
  const dN = step(r, 7.2, 9.6, 0.6)
  const spine = g.corridor([0, dN, W, dN + c])
  const exitW = r.next() < 0.75
  g.ends.push({ x: 0, y: q(dN + c / 2), side: "w", exit: exitW, corridor: spine })
  g.ends.push({ x: W, y: q(dN + c / 2), side: "e", exit: !exitW || r.next() < 0.6, corridor: spine })
  g.solid.add("w")
  g.solid.add("e")
  g.solid.add("n")
  // The core, roughly central.
  const cw = step(r, 13.2, 16.8, 0.6)
  const cx = q(Math.round((W / 2 - cw / 2 + (r.next() - 0.5) * W * 0.25) / 0.3) * 0.3)
  g.core([cx, 0, q(cx + cw), dN], ["s"])
  const top = q(dN + c)
  const dS = r.next() < 0.65 ? step(r, 4.8, 6, 0.6) : 0
  const bottom = q(H - dS)
  // Open plan, maybe with a column of rooms at either end.
  let h0 = 0
  let h1 = W
  const ends: Rect[] = []
  for (const lo of [true, false]) {
    if (r.next() > 0.45) continue
    const w = step(r, 6, 8.4, 0.6)
    ends.push(lo ? [0, top, w, bottom] : [q(W - w), top, W, bottom])
    if (lo) h0 = w
    else h1 = q(W - w)
  }
  const hall = g.room("hall", [h0, top, h1, bottom], "n")
  g.frontOpen(hall, r.next() < 0.25)
  for (const rc of ends) g.row(rc, rc[0] === 0 ? "e" : "w", "support", { bay: r.pick([4.2, 4.8, 5.4]) })
  if (dS) g.row([0, bottom, W, H], "n", "perim")
  g.row([0, 0, cx, dN], "s", "support")
  g.row([q(cx + cw), 0, W, dN], "s", "support")
  return g
}

/** Doors, glass fronts and openings for every room, then makes sure everything can be walked to. */
function doors(g: Gen): void {
  const r = g.r
  const linked = (id: number) => g.openings.some((o) => (o.a === id || o.b === id) && o.kind !== "glass")
  /** A door of width w in [lo, hi] at the room's usual end. */
  const place = (id: number, lo: number, hi: number, w: number): [number, number] => {
    const hand = g.hand.get(id) ?? "mid"
    const inset = 0.45
    if (hi - lo < w + 2 * inset) return [q((lo + hi) / 2 - w / 2), q((lo + hi) / 2 + w / 2)]
    if (hand === "lo") return [q(lo + inset), q(lo + inset + w)]
    if (hand === "hi") return [q(hi - inset - w), q(hi - inset)]
    return [q((lo + hi) / 2 - w / 2), q((lo + hi) / 2 + w / 2)]
  }
  for (const room of g.rooms) {
    if (room.kind === "shaft" || room.kind === "hall" || linked(room.id)) continue
    if (room.kind === "atrium") {
      // Glass all round, a door in the middle of each long side.
      for (const s of ["n", "s", "e", "w"] as Side[])
        for (const f of g.frontage(room.rect, s)) {
          const lo = f.lo + 0.3
          const hi = f.hi - 0.3
          const mid = (lo + hi) / 2
          if (horizontal(s) && f.z < 0 && hi - lo > 4) {
            g.open("glass", room.id, f.z, s, lo, mid - 0.8)
            g.open("door", room.id, f.z, s, mid - 0.8, mid + 0.8)
            g.open("glass", room.id, f.z, s, mid + 0.8, hi)
          } else g.open("glass", room.id, f.z, s, lo, hi)
        }
      continue
    }
    let fr = g.frontage(room.rect, room.front, room.id).filter((f) => f.hi - f.lo >= 2)
    if (!fr.length)
      for (const s of shuffle(r, ["n", "s", "e", "w"] as Side[])) {
        fr = g.frontage(room.rect, s, room.id).filter((f) => f.hi - f.lo >= 2 && (f.z < 0 || room.kind !== "bathroom"))
        if (fr.length) {
          room.front = s
          break
        }
      }
    if (!fr.length) continue
    fr.sort((a, b) => b.hi - b.lo - (a.hi - a.lo))
    const f = fr[0]!
    const lo = f.lo + 0.3
    const hi = f.hi - 0.3
    const s = room.front
    if (room.kind === "core" || room.kind === "reception" || (room.kind === "lounge" && r.next() < 0.5) || (room.kind === "kitchen" && r.next() < 0.4 && hi - lo >= 3.6)) {
      // Lobbies, reception and some break areas open right up.
      if (room.kind === "reception" || room.kind === "kitchen") {
        const w = Math.min(hi - lo, Math.max(2.4, (hi - lo) * 0.5))
        const [a, b] = place(room.id, lo, hi, w)
        g.open("glass", room.id, f.z, s, lo, a)
        g.open("open", room.id, f.z, s, a, b)
        g.open("glass", room.id, f.z, s, b, hi)
      } else g.open("open", room.id, f.z, s, lo, hi)
      continue
    }
    const w = room.kind === "closet" || room.kind === "bathroom" ? 1.2 : room.kind === "stair" ? 1.4 : 1.25
    const [a, b] = place(room.id, lo, hi, w)
    g.open("door", room.id, f.z, s, a, b)
    let gaps: [number, number][] = [[a, b]]
    if (hi - lo >= 7 && (room.kind === "meeting" || room.kind === "boardroom" || room.kind === "lounge" || room.kind === "kitchen" || room.kind === "storage") && r.next() < 0.6) {
      // A second door at the other end.
      const c = a - lo > hi - b ? lo + 0.45 : hi - 0.45 - w
      g.open("door", room.id, f.z, s, c, c + w)
      gaps.push([c, c + w])
    }
    const glassy = g.glazed.has(room.id) && room.kind !== "storage" && room.kind !== "server" && room.kind !== "closet" && room.kind !== "copy" && room.kind !== "bathroom" && room.kind !== "stair" && room.kind !== "empty"
    if (glassy) {
      gaps = gaps.sort((p, q2) => p[0] - q2[0])
      let u = lo
      for (const [ga, gb] of gaps) {
        g.open("glass", room.id, f.z, s, u, ga)
        u = gb
      }
      g.open("glass", room.id, f.z, s, u, hi)
    }
  }
  // Open-plan areas that meet run into each other.
  for (const a of g.rooms)
    for (const b of g.rooms) {
      if (a.id >= b.id || a.kind !== "hall" || b.kind !== "hall") continue
      const t = contact(a.rect, b.rect)
      if (t && t.hi - t.lo > 2) g.open("open", a.id, b.id, t.side, t.lo + 0.4, t.hi - 0.4)
    }

  // Rooms with no way in get a door from a neighbour that has one, walk-through rooms first.
  const reach = () => {
    const seen = new Set<number>()
    const queue: number[] = g.corridors.map((_, k) => -1 - k)
    for (const z of queue) seen.add(z)
    while (queue.length) {
      const z = queue.pop()!
      for (const o of g.openings) {
        if (o.kind === "glass") continue
        const n = o.a === z ? o.b : o.b === z ? o.a : null
        if (n === null || seen.has(n)) continue
        seen.add(n)
        queue.push(n)
      }
    }
    return seen
  }
  for (let pass = 0; pass < 40; pass++) {
    const seen = reach()
    const stuck = g.rooms.filter((x) => x.kind !== "shaft" && !seen.has(x.id))
    if (!stuck.length) break
    let fixed = false
    for (const room of shuffle(r, stuck)) {
      const opts: { z: number; t: { side: Side; lo: number; hi: number }; w: number }[] = []
      for (const o of g.rooms) {
        if (!seen.has(o.id) || o.kind === "shaft" || o.kind === "stair" || o.kind === "bathroom") continue
        const t = contact(room.rect, o.rect)
        if (!t || t.hi - t.lo < 1.9) continue
        opts.push({ z: o.id, t, w: (THROUGH.has(o.kind) ? 4 : 1) + (o.kind === "atrium" ? -0.9 : 0) })
      }
      for (const [k, c] of g.corridors.entries()) {
        const t = contact(room.rect, c)
        if (t && t.hi - t.lo >= 1.6) opts.push({ z: -1 - k, t, w: 8 })
      }
      if (!opts.length) continue
      const best = weighted(
        r,
        opts.map((x) => [x, x.w] as const),
      )
      const mid = (best.t.lo + best.t.hi) / 2
      const w = Math.min(1.25, best.t.hi - best.t.lo - 0.5)
      // Glass on that stretch gives way to the door.
      const l = lineOf(room.rect, best.t.side)
      g.openings = g.openings.filter((o) => !(o.kind === "glass" && (horizontal(best.t.side) ? o.y0 === l && o.x0 < mid + w / 2 && o.x1 > mid - w / 2 : o.x0 === l && o.y0 < mid + w / 2 && o.y1 > mid - w / 2)))
      g.open("door", room.id, best.z, best.t.side, mid - w / 2, mid + w / 2)
      fixed = true
      break
    }
    if (!fixed) break
  }
  // The odd connecting door between neighbouring offices, for flanking routes.
  for (const a of g.rooms)
    for (const b of g.rooms) {
      if (a.id >= b.id || r.next() > 0.035) continue
      const ok = (k: RoomKind) => k === "office" || k === "manager" || k === "meeting" || k === "boardroom" || k === "storage" || k === "copy" || k === "kitchen"
      if (!ok(a.kind) || !ok(b.kind)) continue
      const t = contact(a.rect, b.rect)
      if (!t || t.hi - t.lo < 3.2) continue
      const mid = (t.lo + t.hi) / 2
      g.open("door", a.id, b.id, t.side, mid - 0.6, mid + 0.6)
    }
}

/** Any must-have room the rows didn't produce takes over an ordinary one. */
function program(g: Gen): void {
  for (const [kind, n] of g.need) {
    for (let k = 0; k < n; k++) {
      const pool = g.rooms.filter((x) => (x.kind === "office" || x.kind === "empty" || x.kind === "manager") && (x.rect[2] - x.rect[0]) * (x.rect[3] - x.rect[1]) >= 12)
      if (!pool.length) break
      g.r.pick(pool).kind = kind
    }
  }
}

function mirror(p: Plan, mx: boolean, my: boolean): Plan {
  const { W, H } = p
  const rc = (a: Rect): Rect => [mx ? q(W - a[2]) : a[0], my ? q(H - a[3]) : a[1], mx ? q(W - a[0]) : a[2], my ? q(H - a[1]) : a[3]]
  const sd = (s: Side): Side => (mx && !horizontal(s) ? OPP[s] : my && horizontal(s) ? OPP[s] : s)
  return {
    ...p,
    rooms: p.rooms.map((x) => ({ ...x, rect: rc(x.rect), front: sd(x.front) })),
    corridors: p.corridors.map(rc),
    pillars: p.pillars.map(rc),
    openings: p.openings.map((o) => {
      const [x0, y0, x1, y1] = rc([o.x0, o.y0, o.x1, o.y1])
      return { ...o, x0, y0, x1, y1 }
    }),
    ends: p.ends.map((e) => ({ ...e, x: mx ? q(W - e.x) : e.x, y: my ? q(H - e.y) : e.y, side: sd(e.side) })),
    solid: p.solid.map(sd),
  }
}

/** Lays out an office floor the way an architect would: see Archetype. */
export function layout(r: Rng): Plan {
  const archetype = weighted<Archetype>(r, [
    ["ring", 3],
    ["spine", 2.5],
    ["atrium", 1.6],
    ["sidecore", 2.2],
  ])
  const g = archetype === "sidecore" ? sidecore(r) : banded(r, archetype)
  program(g)
  doors(g)
  const plan: Plan = { W: g.W, H: g.H, archetype, rooms: g.rooms, corridors: g.corridors, openings: g.openings, ends: g.ends, pillars: g.pillars, solid: [...g.solid] }
  return mirror(plan, r.next() < 0.5, r.next() < 0.5)
}
