import type { Rect } from "../geom"
import type { Rng } from "../rng"
import { type End, type Opening, type OpeningKind, type Room, type RoomKind, type Side, EPS, OPP, SWAP, contact, horizontal, lineOf, q, shuffle, snap, step, weighted } from "./geo"

export type Slot = "perim" | "inner" | "support"
type Hand = "lo" | "hi" | "mid"
/** How a row's rooms connect to each other: every neighbour, in pairs, now and then, or not at all. */
export type Link = "chain" | "pairs" | "some" | "none"
/** A floor's character, which tilts the choice of zone templates. */
export type Mood = "mixed" | "warren" | "open" | "social" | "tech"
/**
 * What fills a block of floor:
 * - rows: a row of rooms on each corridor (back to back when there are two), sometimes a pass-through room between.
 * - hall: open plan, open to its corridors between columns, rooms at its ends.
 * - rowhall: rooms along the corridor, open plan behind them, a foyer straight through.
 * - cluster: meeting rooms round a shared foyer open to the corridor.
 * - cafe: a cafeteria open on every side it has a corridor, a kitchen at one end.
 * - server: a server hall with two doors, the rest a row.
 * - labs: a row of wide labs that run into each other.
 * - suite: reception, assistant, office and boardroom in a chain off the corridor.
 * - team: one big team room glazed to both corridors.
 */
export type Template = "rows" | "hall" | "rowhall" | "cluster" | "cafe" | "server" | "labs" | "suite" | "team"

/** Rooms that count as circulation: you can walk through them to reach the rooms off them. */
export const THROUGH = new Set<RoomKind>(["hall", "reception", "core", "cafe", "foyer", "demo"])
/** Rooms that may have just one way in. */
export const SINGLE = new Set<RoomKind>(["closet", "bathroom", "stair", "shaft", "core", "server"])
/** Rooms that may have a door straight into a neighbouring room. */
const LINKABLE = new Set<RoomKind>(["office", "manager", "meeting", "boardroom", "storage", "copy", "kitchen", "lounge", "lab", "reception", "empty", "cubicles", "foyer", "cafe", "demo", "hall", "atrium", "server"])
/** Rooms that open right up into each other rather than through a door. */
const OPENS = new Set<RoomKind>(["lounge", "kitchen", "foyer", "cafe", "hall", "demo", "reception", "cubicles"])

const swap = (a: Rect): Rect => [a[1], a[0], a[3], a[2]]

export class Gen {
  rooms: Room[] = []
  corridors: Rect[] = []
  openings: Opening[] = []
  ends: End[] = []
  pillars: Rect[] = []
  voids: Rect[] = []
  solid = new Set<Side>()
  /** Per room: where along its frontage the door goes, and whether the rest of the frontage is glazed. */
  hand = new Map<number, Hand>()
  glazed = new Set<number>()
  /** Rooms entered only through their neighbours (inner rooms of a suite, back rows). */
  inner = new Set<number>()
  /** Rooms that get two ways in although their kind needn't (big server halls). */
  twice = new Set<number>()
  rows: { ids: number[]; link: Link }[] = []
  tags = new Set<string>()
  need = new Map<RoomKind, number>([
    ["kitchen", 1],
    ["copy", 1],
    ["server", 1],
    ["storage", 1],
    ["meeting", 2],
  ])
  /** How many of each kind the floor has so far. */
  count = new Map<RoomKind, number>()

  constructor(
    readonly r: Rng,
    public W: number,
    public H: number,
    readonly mood: Mood,
  ) {}

  /** Swaps x and y for everything, so a template written for east-west blocks can fill a north-south one. */
  flip(): void {
    for (const x of this.rooms) {
      x.rect = swap(x.rect)
      x.front = SWAP[x.front]
    }
    this.corridors = this.corridors.map(swap)
    this.pillars = this.pillars.map(swap)
    this.voids = this.voids.map(swap)
    this.openings = this.openings.map((o) => ({ ...o, x0: o.y0, y0: o.x0, x1: o.y1, y1: o.x1 }))
    this.ends = this.ends.map((e) => ({ ...e, x: e.y, y: e.x, side: SWAP[e.side] }))
    this.solid = new Set([...this.solid].map((s) => SWAP[s]))
    ;[this.W, this.H] = [this.H, this.W]
  }

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

  /** A corridor that runs into the outer wall at end `side`. */
  end(z: number, side: Side, exit: boolean): void {
    const c = this.rect(z)
    const x = side === "w" ? 0 : side === "e" ? this.W : q((c[0] + c[2]) / 2)
    const y = side === "n" ? 0 : side === "s" ? this.H : q((c[1] + c[3]) / 2)
    this.ends.push({ x, y, side, exit, corridor: z })
    if (exit) this.solid.add(side)
  }

  void(rc: Rect): void {
    this.voids.push([q(rc[0]), q(rc[1]), q(rc[2]), q(rc[3])])
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

  /** Openings already on room a's side `side` between lo and hi. */
  busy(a: number, side: Side, lo: number, hi: number, pad = 0.3): Opening[] {
    const l = lineOf(this.rect(a), side)
    const hz = horizontal(side)
    return this.openings.filter((o) => (hz ? Math.abs(o.y0 - o.y1) < EPS && Math.abs(o.y0 - l) < EPS && o.x0 < hi + pad && o.x1 > lo - pad : Math.abs(o.x0 - o.x1) < EPS && Math.abs(o.x0 - l) < EPS && o.y0 < hi + pad && o.y1 > lo - pad))
  }

  /** A door (or open stretch) through room a's side, cutting back any glass in the way. False if a doorway is already there. */
  door(kind: OpeningKind, a: number, b: number, side: Side, lo: number, hi: number): boolean {
    const hits = this.busy(a, side, lo, hi)
    if (hits.some((o) => o.kind !== "glass")) return false
    const hz = horizontal(side)
    for (const g of hits) {
      this.openings.splice(this.openings.indexOf(g), 1)
      const g0 = hz ? g.x0 : g.y0
      const g1 = hz ? g.x1 : g.y1
      const piece = (u0: number, u1: number) => {
        if (u1 - u0 < 0.2) return
        this.openings.push(hz ? { ...g, x0: q(u0), x1: q(u1) } : { ...g, y0: q(u0), y1: q(u1) })
      }
      piece(g0, lo)
      piece(hi, g1)
    }
    this.open(kind, a, b, side, lo, hi)
    return true
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

  /** Total corridor (and, with `rooms`, walk-through room) frontage on side s. */
  reach(rc: Rect, s: Side, rooms = true): number {
    return this.frontage(rc, s)
      .filter((f) => rooms || f.z < 0)
      .reduce((a, f) => a + f.hi - f.lo, 0)
  }

  link(): Link {
    const m = this.mood
    return weighted<Link>(this.r, [
      ["chain", m === "warren" ? 6 : m === "tech" ? 3 : 2.5],
      ["pairs", m === "warren" ? 2 : 3],
      ["some", m === "open" ? 3 : 1.5],
      ["none", 0.4],
    ])
  }

  /** A room kind and how many bays it takes, for a row of bays of width `bay` and depth `depth`. */
  pick(slot: Slot, bay: number, depth: number, left: number, end: boolean): [RoomKind, number] {
    const span = (w: number) => Math.max(1, Math.ceil((w - 0.2) / bay))
    const needs = (k: RoomKind) => ((this.need.get(k) ?? 0) > 0 ? 1 : 0)
    const tech = this.mood === "tech" ? 1 : 0
    const opts: [RoomKind, number, number][] =
      slot === "perim"
        ? [
            ["manager", bay >= 4.2 ? 1 : 2, 3],
            ["office", 1, bay <= 4.8 ? (this.mood === "warren" ? 6 : 4) : 1],
            ["meeting", span(5), 0.8 + 3 * needs("meeting")],
            ["boardroom", span(8), depth >= 5 ? (end ? 1.6 : 0.5) : 0],
            ["empty", 1, 0.5],
            ["kitchen", span(6), 0.05 + needs("kitchen")],
            ["lounge", span(6), 0.3],
            ["lab", span(6), depth >= 5.4 ? 0.2 + tech * 3 : 0],
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
              ["lab", span(6), tech * 3],
              ["empty", 1, 0.5],
            ]
          : [
              ["kitchen", span(6), 0.15 + 6 * needs("kitchen")],
              ["copy", 1, 0.3 + 6 * needs("copy")],
              ["server", 1, 0.3 + 6 * needs("server")],
              ["storage", 1, 0.8 + 4 * needs("storage")],
              ["meeting", span(4.8), 2 + 4 * needs("meeting")],
              ["boardroom", span(7.5), 0.6],
              ["lounge", span(6), 0.6],
              ["lab", span(6), tech * 3],
              ["closet", 1, bay <= 3.6 ? 0.5 : 0],
              ["empty", 1, 0.8],
              ["office", 1, this.mood === "warren" ? 3 : 1],
              ["manager", bay >= 4.2 ? 1 : 2, 0.6],
            ]
    // Each repeat of a kind makes it less likely again; offices come in rows, so they're exempt.
    const big = (k: RoomKind) => k === "kitchen" || k === "lounge" || k === "boardroom" || k === "reception"
    const used = (k: RoomKind) => (k === "office" || k === "manager" || k === "lab" ? 0 : (this.count.get(k) ?? 0) * (big(k) ? 4 : 1.6))
    const fit = opts.filter(([, n, w]) => w > 0 && n <= left).map(([k, n, w]) => [[k, n] as [RoomKind, number], w / (1 + used(k))] as const)
    const out: [RoomKind, number] = fit.length ? weighted(this.r, fit) : [slot === "perim" ? "office" : "storage", left]
    this.tally(out[0])
    return out
  }

  /**
   * A row of rooms along a band, entered from side `front`: bays on the planning grid, grouped into rooms by kind. End
   * rooms without enough frontage widen into corner rooms. `reception` turns the room at that coordinate into the
   * reception facing the lifts; `kinds` lays out a fixed sequence of rooms of the given widths instead.
   */
  row(rc: Rect, front: Side, slot: Slot, opts: { bay?: number; reception?: number; link?: Link; kinds?: [RoomKind, number][]; inner?: boolean } = {}): Room[] {
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
    let bounds: { kind: RoomKind; a: number; b: number }[]
    if (opts.kinds) {
      bounds = []
      let u = u0
      opts.kinds.forEach(([kind, w], k) => {
        const b = k === opts.kinds!.length - 1 ? u1 : Math.min(u1, snap(u + w))
        if (b - u > 0.05) bounds.push({ kind, a: u, b })
        u = b
      })
      // Too narrow for a room: it joins its neighbour.
      for (let k = 0; k < bounds.length && bounds.length > 1; ) {
        if (bounds[k]!.b - bounds[k]!.a >= 3) {
          k++
          continue
        }
        if (k > 0) bounds[k - 1]!.b = bounds[k]!.b
        else bounds[1]!.a = bounds[0]!.a
        bounds.splice(k, 1)
      }
      for (const g of bounds) this.tally(g.kind)
    } else {
      const bay = opts.bay ?? (slot === "perim" ? r.pick([3.6, 3.6, 4.2, 4.5, 4.8]) : r.pick([3.3, 3.6, 4.2, 4.8]))
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
      if (!opts.inner) {
        while (groups.length > 1 && Math.min(at(groups[0]!.b), fb) - Math.max(at(groups[0]!.a), fa) < 2.2) merge(0)
        while (groups.length > 1 && Math.min(at(groups[groups.length - 1]!.b), fb) - Math.max(at(groups[groups.length - 1]!.a), fa) < 2.2) merge(groups.length - 2)
      }
      if (opts.reception !== undefined) {
        const k = groups.findIndex((g) => at(g.a) <= opts.reception! && at(g.b) >= opts.reception!)
        if (k >= 0) {
          if ((groups[k]!.b - groups[k]!.a) * bw < 4.5 && groups.length > 1) merge(k + 1 < groups.length ? k : k - 1)
          const j = groups.findIndex((g) => at(g.a) <= opts.reception! && at(g.b) >= opts.reception!)
          groups[j]!.kind = "reception"
          this.tally("reception")
        }
      }
      bounds = groups.map((g) => ({ kind: g.kind, a: q(at(g.a)), b: q(at(g.b)) }))
    }
    // Doors fall at the same end of every room in a row; glass fronts are a row-wide choice too.
    const hand: Hand = r.pick(["lo", "hi", "lo", "hi", "mid"])
    const glazed = r.next() < 0.45
    const rooms = bounds.map((g) => {
      const room = this.room(g.kind, along ? [g.a, rc[1], g.b, rc[3]] : [rc[0], g.a, rc[2], g.b], front, false)
      this.hand.set(room.id, hand)
      if (opts.inner) this.inner.add(room.id)
      if (glazed || g.kind === "meeting" || g.kind === "boardroom") this.glazed.add(room.id)
      return room
    })
    this.rows.push({ ids: rooms.map((x) => x.id), link: opts.link ?? this.link() })
    return rooms
  }

  /** Opens a walk-through room onto everything on side `side`: columns at a regular spacing, or a glass screen with doors. */
  frontOpen(room: Room, screen: boolean, side: Side = room.front, corridorsOnly = false): void {
    const r = this.r
    const along = horizontal(side)
    const l = lineOf(room.rect, side)
    for (const f of this.frontage(room.rect, side, room.id)) {
      if (corridorsOnly && f.z >= 0) continue
      const lo = f.lo + 0.15
      const hi = f.hi - 0.15
      if (hi - lo < 1.5) continue
      if (screen) {
        const doors = Math.max(1, Math.round((hi - lo) / 10))
        let u = lo
        for (let k = 0; k < doors; k++) {
          const c = lo + ((k + 0.5) * (hi - lo)) / doors
          this.open("glass", room.id, f.z, side, u, c - 0.9)
          this.open("open", room.id, f.z, side, c - 0.9, c + 0.9)
          u = c + 0.9
        }
        this.open("glass", room.id, f.z, side, u, hi)
        continue
      }
      const span = hi - lo
      const bays = Math.max(1, Math.round(span / step(r, 5.4, 7.2, 0.6)))
      let u = lo
      for (let k = 1; k <= bays; k++) {
        const c = k < bays ? lo + (k * span) / bays : hi
        const end = k < bays ? c - 0.25 : hi
        this.open("open", room.id, f.z, side, u, end)
        if (k < bays) this.pillars.push(along ? [q(c - 0.25), q(l - 0.25), q(c + 0.25), q(l + 0.25)] : [q(l - 0.25), q(c - 0.25), q(l + 0.25), q(c + 0.25)])
        u = c + 0.25
      }
    }
  }

  /** Opens a walk-through room onto every corridor round it. */
  openRound(room: Room, screen: number): void {
    for (const s of ["n", "s", "e", "w"] as Side[]) if (this.reach(room.rect, s, false) >= 2) this.frontOpen(room, this.r.next() < screen, s, true)
  }

  /**
   * The service core in a block between corridors north and south (or one of them): toilets, a lift bank with its
   * lobby, and a fire stair with a riser or server room. Returns the lobby's centre along the block. Blocks between
   * east and west corridors are laid out turned.
   */
  core(rc: Rect, fronts: Side[]): number {
    if (fronts.some((s) => !horizontal(s))) {
      this.flip()
      const v = this.core(swap(rc), fronts.map((s) => SWAP[s]))
      this.flip()
      return v
    }
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
          if (r.next() < 0.5) {
            this.room("stair", [a, y0, b, q(y0 + sd)], "n")
            this.room(kind2, [a, q(y0 + sd), b, y1], "s")
          } else {
            this.room(kind2, [a, y0, b, q(y1 - sd)], "n")
            this.room("stair", [a, q(y1 - sd), b, y1], "s")
          }
        } else this.room("stair", [a, y0, b, y1], top)
      }
    }
    this.tags.add("core")
    return lobby
  }

  /** A small core: a fire stair and toilets on one side, a lift with its lobby on the other. Blocks 6-10 m wide. */
  miniCore(rc: Rect, fronts: Side[]): void {
    if (fronts.some((s) => !horizontal(s))) {
      this.flip()
      this.miniCore(swap(rc), fronts.map((s) => SWAP[s]))
      this.flip()
      return
    }
    const r = this.r
    const [x0, y0, x1, y1] = rc
    const D = y1 - y0
    const w = x1 - x0
    const top: Side = fronts.length === 2 ? (r.next() < 0.5 ? "n" : "s") : fronts[0] ?? "n"
    const bot = OPP[top]
    const sw = q(Math.min(w - 2.4, Math.max(3, snap(w / 2))))
    const stairLeft = r.next() < 0.5
    if (fronts.length === 2 && D >= 9.6) {
      // Stair and toilets onto one corridor, lift lobby onto the other, the shaft between.
      const sd = Math.min(5.4, Math.max(3.6, snap(D * 0.42)))
      const ld = Math.max(2.4, snap((D - sd) * 0.45))
      const [ta, tb] = top === "n" ? [y0, q(y0 + sd)] : [q(y1 - sd), y1]
      const [la, lb] = top === "n" ? [q(y1 - ld), y1] : [y0, q(y0 + ld)]
      this.room("stair", stairLeft ? [x0, ta, q(x0 + sw), tb] : [q(x1 - sw), ta, x1, tb], top)
      this.room("bathroom", stairLeft ? [q(x0 + sw), ta, x1, tb] : [x0, ta, q(x1 - sw), tb], top)
      this.room("shaft", top === "n" ? [x0, tb, x1, la] : [x0, lb, x1, ta], top)
      this.room("core", [x0, la, x1, lb], bot)
    } else {
      // One way in: the lift and its lobby in the middle, the stair one side, toilets the other.
      const lw = w >= 8.4 ? 3 : 2.4
      const cw = q((w - lw) / 2)
      const sd = Math.min(3, Math.max(2.1, snap(D * 0.4)))
      const [sa, sb] = top === "n" ? [q(y1 - sd), y1] : [y0, q(y0 + sd)]
      this.room("stair", [x0, y0, q(x0 + cw), y1], top)
      {
        this.room("shaft", [q(x0 + cw), sa, q(x0 + cw + lw), sb], top)
        this.room("core", top === "n" ? [q(x0 + cw), y0, q(x0 + cw + lw), sa] : [q(x0 + cw), sb, q(x0 + cw + lw), y1], top)
      }
      this.room("bathroom", [q(x1 - cw), y0, x1, y1], top)
    }
    this.tags.add("minicore")
  }

  // Zone templates ----------------------------------------------------------------------------------------------------

  /** Fills a block of floor with a zone template suited to its size and the corridors round it (see Template). */
  block(rc: Rect, allow?: Template[], opts: { reception?: number } = {}): Template {
    const ns = this.reach(rc, "n") + this.reach(rc, "s")
    const ew = this.reach(rc, "e") + this.reach(rc, "w")
    const turn = ew > ns + 0.01 || (ew === ns && rc[3] - rc[1] > rc[2] - rc[0])
    if (!turn) return this.blockH(rc, allow, opts)
    this.flip()
    const t = this.blockH(swap(rc), allow, { reception: undefined })
    this.flip()
    return t
  }

  /** Picks a template for a block with its corridors north and/or south. */
  choose(rc: Rect, allow?: Template[]): Template {
    const L = rc[2] - rc[0]
    const D = rc[3] - rc[1]
    const fn = this.reach(rc, "n") >= 2
    const fs = this.reach(rc, "s") >= 2
    const one = fn !== fs
    const m = this.mood
    const has = (t: string) => this.tags.has(t)
    const table: [Template, number][] = [
      ["rows", (m === "warren" ? 7 : m === "open" ? 1.2 : 3) * (one && D > 7.8 ? 0.5 : 1)],
      ["hall", D >= 7.8 && L >= 12 ? (m === "open" ? 6 : 1.6) / (has("hall") ? 1.5 : 1) : 0],
      ["rowhall", D >= 11.4 && L >= 14 ? (m === "open" ? 3 : 2) : 0],
      ["cluster", D >= 8.4 && L >= 11 && L <= 24 ? (m === "social" ? 3 : 1.4) / (has("cluster") ? 3 : 1) : 0],
      ["cafe", D >= 7.2 && L >= 9 && L <= 24 && !has("cafe") ? (m === "social" ? 6 : 0.8) : 0],
      ["server", D >= 6 && L >= 10 && !has("server") ? (m === "tech" ? 4 : 0.5) : 0],
      ["labs", D >= 5.4 && D <= 9.6 && L >= 12 ? (m === "tech" ? 5 : 0.3) : 0],
      ["suite", one && D >= 4.8 && D <= 8.4 && L >= 17 && !has("suite") ? (m === "warren" ? 3 : 1.2) : 0],
      ["team", fn && fs && L >= 8 && L <= 16 && D <= 16 ? 0.6 : 0],
    ]
    const ok = table.filter(([t, w]) => w > 0 && (!allow || allow.includes(t)))
    return ok.length ? weighted(this.r, ok) : "rows"
  }

  blockH(rc: Rect, allow?: Template[], opts: { reception?: number } = {}): Template {
    const t = this.choose(rc, allow)
    const fn = this.reach(rc, "n") >= 2
    const fs = this.reach(rc, "s") >= 2
    const front: Side = fn && fs ? (this.reach(rc, "n") >= this.reach(rc, "s") ? "n" : "s") : fs ? "s" : "n"
    this.tags.add(t)
    switch (t) {
      case "rows":
        this.rowsT(rc, fn, fs, front, opts.reception)
        break
      case "hall":
        this.hallT(rc)
        break
      case "rowhall":
        this.rowHallT(rc, front)
        break
      case "cluster":
        this.clusterT(rc, front)
        break
      case "cafe":
        this.cafeT(rc)
        break
      case "server":
        this.serverT(rc, front)
        break
      case "labs":
        this.labsT(rc, front)
        break
      case "suite":
        this.suiteT(rc, front)
        break
      case "team": {
        const room = this.room("cubicles", rc, front)
        this.openRound(room, 0.6)
        break
      }
    }
    return t
  }

  rowsT(rc: Rect, fn: boolean, fs: boolean, front: Side, reception?: number): void {
    const r = this.r
    const [x0, y0, x1, y1] = rc
    const L = x1 - x0
    const D = y1 - y0
    const slot: Slot = rc[1] < 0.01 || rc[3] > this.H - 0.01 ? "perim" : "inner"
    if (fn && fs && D >= 9.6) {
      if (L >= 13 && r.next() < 0.6) {
        // A room right through the block from one corridor to the other.
        let tw = Math.min(step(r, 4.2, 7.2, 0.6), q(L - 6.6))
        let u = snap(x0 + (L - tw) * r.range(0.2, 0.8))
        if (u - x0 < 3) {
          tw = q(tw + u - x0)
          u = x0
        }
        if (x1 - u - tw < 3) tw = q(x1 - u)
        const kind = weighted<RoomKind>(r, [
          ["meeting", 2],
          ["lounge", 1.5],
          ["kitchen", (this.need.get("kitchen") ?? 0) > 0 ? 3 : 0.4],
          ["copy", 0.8],
          ["boardroom", tw >= 6 ? 1 : 0],
          ["cubicles", tw >= 6 && D >= 9.6 ? 1 : 0],
          ["foyer", 1],
        ])
        const room = this.room(kind, [u, y0, q(u + tw), y1], "n")
        if (kind === "meeting" || kind === "boardroom" || r.next() < 0.4) this.glazed.add(room.id)
        if (kind === "foyer" || kind === "cubicles") this.openRound(room, 0.5)
        this.tags.add("through")
        if (u - x0 > 0.05) this.backToBack([x0, y0, u, y1], slot)
        if (x1 - u - tw > 0.05) this.backToBack([q(u + tw), y0, x1, y1], slot)
        return
      }
      this.backToBack(rc, slot)
      return
    }
    if (D <= 7.8 || (fn && fs)) {
      this.row(rc, front, slot, { reception })
      return
    }
    // Deep with one corridor: a row on the corridor, a second row behind entered through the first.
    const fd = step(r, 4.8, Math.min(6, D - 3.6), 0.6)
    if (D - fd > 8.4 && L >= 12) {
      this.tags.add("rowhall")
      this.rowHallT(rc, front)
      return
    }
    const [a, b]: [Rect, Rect] = front === "n" ? [[x0, y0, x1, q(y0 + fd)], [x0, q(y0 + fd), x1, y1]] : [[x0, q(y1 - fd), x1, y1], [x0, y0, x1, q(y1 - fd)]]
    this.row(a, front, slot, { reception })
    this.row(b, front, "support", { inner: true, link: r.next() < 0.7 ? "chain" : "pairs" })
    this.tags.add("backrow")
  }

  backToBack(rc: Rect, slot: Slot): void {
    const [x0, y0, x1, y1] = rc
    const D = y1 - y0
    const m = snap(y0 + D / 2 + (this.r.int(3) - 1) * 0.6)
    this.row([x0, y0, x1, m], "n", slot)
    this.row([x0, m, x1, y1], "s", slot)
  }

  /** Open plan over the block with an enclosed room at either end, open to every corridor round it. */
  hallT(rc: Rect): void {
    const r = this.r
    let [x0, , x1] = rc
    const [, y0, , y1] = rc
    const D = y1 - y0
    const ends: Room[] = []
    for (const lo of [true, false]) {
      if (r.next() > 0.6 || x1 - x0 < 18) continue
      const w = step(r, 4.8, 7.2, 0.6)
      const kind = weighted<RoomKind>(r, [
        ["meeting", 2],
        ["manager", 1.5],
        ["boardroom", w >= 6 && D >= 6 ? 1.5 : 0],
        ["lounge", D >= 6 ? 1 : 0],
        ["kitchen", (this.need.get("kitchen") ?? 0) > 0 ? 1.5 : 0.3],
        ["copy", (this.need.get("copy") ?? 0) > 0 ? 1 : 0.2],
      ])
      const rc2: Rect = lo ? [x0, y0, q(x0 + w), y1] : [q(x1 - w), y0, x1, y1]
      const fn = this.reach(rc2, "n", false) >= 2
      const fs = this.reach(rc2, "s", false) >= 2
      if (D >= 9 && (fn || fs) && r.next() < 0.6) {
        // Two rooms one behind the other.
        const m = snap(y0 + D / 2)
        ends.push(this.room(kind, [rc2[0], y0, rc2[2], m], "n"), this.room(r.pick<RoomKind>(["meeting", "storage", "copy", "manager"]), [rc2[0], m, rc2[2], y1], "s"))
      } else ends.push(this.room(kind, rc2, fn || !fs ? "n" : "s"))
      if (lo) x0 = q(x0 + w)
      else x1 = q(x1 - w)
    }
    for (const e of ends) if (e.kind === "meeting" || e.kind === "boardroom" || r.next() < 0.5) this.glazed.add(e.id)
    const hall = this.room("hall", [x0, y0, x1, y1], this.reach([x0, y0, x1, y1], "n") >= this.reach([x0, y0, x1, y1], "s") ? "n" : "s")
    this.openRound(hall, 0.3)
  }

  /** Rooms along the corridor with open plan behind them, a foyer through the row. */
  rowHallT(rc: Rect, front: Side): void {
    const r = this.r
    const [x0, y0, x1, y1] = rc
    const L = x1 - x0
    const rd = step(r, 4.8, 6, 0.6)
    const rowRc: Rect = front === "n" ? [x0, y0, x1, q(y0 + rd)] : [x0, q(y1 - rd), x1, y1]
    const hallRc: Rect = front === "n" ? [x0, q(y0 + rd), x1, y1] : [x0, y0, x1, q(y1 - rd)]
    const hall = this.room("hall", hallRc, front)
    this.openRound(hall, 0.3)
    let fw = step(r, 3, 4.2, 0.6)
    let u = snap(x0 + (L - fw) * r.range(0.25, 0.75))
    // The foyer takes in any stretch too short for a room.
    if (u - x0 < 3) {
      fw = q(fw + u - x0)
      u = x0
    }
    if (x1 - u - fw < 3) fw = q(x1 - u)
    const foyer = this.room("foyer", [u, rowRc[1], q(u + fw), rowRc[3]], front)
    this.frontOpen(foyer, false, front)
    this.frontOpen(foyer, false, OPP[front])
    for (const part of [[x0, rowRc[1], u, rowRc[3]], [q(u + fw), rowRc[1], x1, rowRc[3]]] as Rect[]) if (part[2] - part[0] > 0.05) this.row(part, front, "perim")
  }

  /** Meeting rooms round a foyer that opens onto the corridor; every room has a door to the foyer and another. */
  clusterT(rc: Rect, front: Side): void {
    const r = this.r
    const [x0, y0, x1, y1] = rc
    const L = x1 - x0
    const D = y1 - y0
    const fw = step(r, 3.6, 4.8, 0.6)
    const u = snap(x0 + (L - fw) / 2 + (r.int(3) - 1) * 0.6)
    const foyer = this.room("foyer", [u, y0, q(u + fw), y1], front)
    for (const s of ["n", "s"] as Side[]) if (this.reach(foyer.rect, s, false) >= 2) this.frontOpen(foyer, r.next() < 0.3, s, true)
    for (const [a, b] of [
      [x0, u],
      [q(u + fw), x1],
    ] as const) {
      if (b - a < 0.05) continue
      const ids: number[] = []
      const cols = b - a >= 9 ? 2 : 1
      for (let k = 0; k < cols; k++) {
        const ca = k === 0 ? a : snap((a + b) / 2)
        const cb = k === cols - 1 ? b : snap((a + b) / 2)
        const stack = D >= 9.6 ? 2 : 1
        for (let j = 0; j < stack; j++) {
          const ya = j === 0 ? y0 : snap(y0 + D / 2)
          const yb = j === stack - 1 ? y1 : snap(y0 + D / 2)
          const big = (cb - ca) * (yb - ya)
          const kind = weighted<RoomKind>(r, [
            ["meeting", 5],
            ["boardroom", big >= 30 ? 1.5 : 0],
            ["copy", (this.need.get("copy") ?? 0) > 0 ? 2 : 0.3],
            ["lounge", big >= 22 ? 0.8 : 0],
            ["manager", 0.8],
          ])
          const s: Side = stack === 1 ? front : j === 0 ? "n" : "s"
          const room = this.room(kind, [ca, ya, cb, yb], s)
          if (kind === "meeting" || kind === "boardroom") this.glazed.add(room.id)
          ids.push(room.id)
        }
      }
      this.rows.push({ ids, link: "some" })
    }
  }

  /** A cafeteria open on every corridor side, with its kitchen at one end. */
  cafeT(rc: Rect): void {
    const r = this.r
    let [x0, , x1] = rc
    const [, y0, , y1] = rc
    if (x1 - x0 >= 15 && r.next() < 0.6) {
      const kw = step(r, 3.6, 4.8, 0.6)
      const lo = r.next() < 0.5
      const k = this.room("kitchen", lo ? [x0, y0, q(x0 + kw), y1] : [q(x1 - kw), y0, x1, y1], "n")
      this.hand.set(k.id, "mid")
      if (lo) x0 = q(x0 + kw)
      else x1 = q(x1 - kw)
    }
    const cafe = this.room("cafe", [x0, y0, x1, y1], this.reach([x0, y0, x1, y1], "n") >= this.reach([x0, y0, x1, y1], "s") ? "n" : "s")
    this.openRound(cafe, 0.35)
  }

  /** A server hall with two doors, a row of rooms beside it. */
  serverT(rc: Rect, front: Side): void {
    const r = this.r
    const [x0, y0, x1, y1] = rc
    const L = x1 - x0
    let sw = Math.min(L, step(r, 7.2, 12, 0.6))
    if (L - sw < 3) sw = L
    const lo = r.next() < 0.5
    const s = this.room("server", lo ? [x0, y0, q(x0 + sw), y1] : [q(x1 - sw), y0, x1, y1], front)
    this.twice.add(s.id)
    const rest: Rect = lo ? [q(x0 + sw), y0, x1, y1] : [x0, y0, q(x1 - sw), y1]
    if (rest[2] - rest[0] > 0.05) this.row(rest, front, "support")
  }

  /** Wide labs in a row, opening into each other. */
  labsT(rc: Rect, front: Side): void {
    const r = this.r
    const L = rc[2] - rc[0]
    const kinds: [RoomKind, number][] = []
    let left = L
    while (left > 0.5) {
      const kind: RoomKind = kinds.length && r.next() < 0.25 ? r.pick<RoomKind>(["storage", "copy", "office"]) : "lab"
      const w = kind === "lab" ? step(r, 6, 8.4, 0.6) : step(r, 3, 4.2, 0.6)
      kinds.push([kind, Math.min(w, left)])
      left = q(left - w)
    }
    this.row(rc, front, "inner", { kinds, link: "chain" })
  }

  /** An executive suite: reception off the corridor, then assistant, office and boardroom, one through the next. */
  suiteT(rc: Rect, front: Side): void {
    const r = this.r
    const [x0, y0, x1, y1] = rc
    const L = x1 - x0
    const seq: [RoomKind, number][] = [
      ["reception", step(r, 4.8, 6, 0.6)],
      ["office", step(r, 3.6, 4.2, 0.6)],
      ["manager", step(r, 4.8, 6, 0.6)],
      ["boardroom", step(r, 6, 7.8, 0.6)],
    ]
    const total = seq.reduce((s, [, w]) => s + w, 0)
    const lo = r.next() < 0.5
    const order = lo ? seq : [...seq].reverse()
    const sr: Rect = L - total < 3 ? rc : lo ? [x0, y0, q(x0 + total), y1] : [q(x1 - total), y0, x1, y1]
    const rooms = this.row(sr, front, "perim", { kinds: order, link: "chain" })
    for (const x of rooms) if (x.kind === "office" || x.kind === "manager") this.inner.add(x.id)
    const rest: Rect = lo ? [sr[2], y0, x1, y1] : [x0, y0, sr[0], y1]
    if (rest[2] - rest[0] > 0.05) this.row(rest, front, "perim")
  }
}

// Connections -------------------------------------------------------------------------------------------------------

const ways = (g: Gen, id: number) => g.openings.filter((o) => (o.a === id || o.b === id) && o.kind !== "glass").length

/** Doors, glass fronts and openings for every room; then a second way into nearly every room; then checks it all joins up. */
export function connect(g: Gen): void {
  const r = g.r
  /** A door of width w in [lo, hi] at the room's usual end. */
  const place = (id: number, lo: number, hi: number, w: number): [number, number] => {
    const hand = g.hand.get(id) ?? "mid"
    const inset = 0.45
    if (hi - lo < w + 2 * inset) return [q((lo + hi) / 2 - w / 2), q((lo + hi) / 2 + w / 2)]
    if (hand === "lo") return [q(lo + inset), q(lo + inset + w)]
    if (hand === "hi") return [q(hi - inset - w), q(hi - inset)]
    return [q((lo + hi) / 2 - w / 2), q((lo + hi) / 2 + w / 2)]
  }
  const doorW = (k: RoomKind) => (k === "closet" || k === "bathroom" ? 1.2 : k === "stair" ? 1.4 : 1.25)
  for (const room of g.rooms) {
    if (room.kind === "shaft" || room.kind === "hall" || room.kind === "cafe" || g.inner.has(room.id) || ways(g, room.id)) continue
    if (room.kind === "atrium") {
      // Glass all round, a door in the middle of each side onto a corridor.
      for (const s of ["n", "s", "e", "w"] as Side[])
        for (const f of g.frontage(room.rect, s)) {
          const lo = f.lo + 0.3
          const hi = f.hi - 0.3
          const mid = (lo + hi) / 2
          if (f.z < 0 && hi - lo > 4) {
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
    fr.sort((a, b) => b.hi - b.lo - (a.hi - a.lo) + (a.z < 0 ? -1 : 0) - (b.z < 0 ? -1 : 0))
    const f = fr[0]!
    const lo = f.lo + 0.3
    const hi = f.hi - 0.3
    const s = room.front
    if (room.kind === "core" || room.kind === "reception" || room.kind === "foyer" || room.kind === "demo" || (room.kind === "lounge" && r.next() < 0.5) || (room.kind === "kitchen" && r.next() < 0.4 && hi - lo >= 3.6)) {
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
    const w = doorW(room.kind)
    const [a, b] = place(room.id, lo, hi, w)
    g.open("door", room.id, f.z, s, a, b)
    let gaps: [number, number][] = [[a, b]]
    if (hi - lo >= 6.5 && !SINGLE.has(room.kind) && r.next() < 0.7) {
      // A second door at the other end.
      const c = a - lo > hi - b ? lo + 0.45 : hi - 0.45 - w
      g.open("door", room.id, f.z, s, c, c + w)
      gaps.push([c, c + w])
    }
    const glassy = g.glazed.has(room.id) && !["storage", "server", "closet", "copy", "bathroom", "stair", "empty", "lab"].includes(room.kind)
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
  // Walk-through areas that meet run into each other.
  for (const a of g.rooms)
    for (const b of g.rooms) {
      if (a.id >= b.id || !THROUGH.has(a.kind) || !THROUGH.has(b.kind) || a.kind === "core" || b.kind === "core") continue
      const t = contact(a.rect, b.rect)
      if (!t || t.hi - t.lo <= 2) continue
      if (g.busy(a.id, t.side, t.lo, t.hi, 0).length) continue
      if ((a.kind === "hall" || a.kind === "demo") && (b.kind === "hall" || b.kind === "demo")) g.open("open", a.id, b.id, t.side, t.lo + 0.4, t.hi - 0.4)
      else {
        const w = Math.min(t.hi - t.lo - 0.8, r.pick([1.8, 2.4, 3.6]))
        const mid = (t.lo + t.hi) / 2
        g.open("open", a.id, b.id, t.side, mid - w / 2, mid + w / 2)
      }
    }

  // Rows of rooms that run into one another.
  for (const row of g.rows) {
    for (let k = 0; k + 1 < row.ids.length; k++) {
      const link = row.link === "chain" || (row.link === "pairs" && k % 2 === 0) || (row.link === "some" && r.next() < 0.45)
      if (link) neighbourDoor(g, g.rooms[row.ids[k]!]!, g.rooms[row.ids[k + 1]!]!)
    }
  }
  reachAll(g)

  // A second way into nearly every room: another corridor, the open plan behind, or the room next door.
  for (const room of g.rooms) {
    if (room.kind === "shaft" || room.kind === "hall" || room.kind === "atrium") continue
    if (SINGLE.has(room.kind) && !g.twice.has(room.id) && (room.kind !== "server" || r.next() < 0.6)) continue
    for (let tries = 0; tries < 2 && ways(g, room.id) < 2; tries++) second(g, room)
  }
  // And the odd extra door between neighbours, for flanking routes.
  for (const a of g.rooms)
    for (const b of g.rooms) {
      if (a.id >= b.id || r.next() > 0.03) continue
      neighbourDoor(g, a, b)
    }
  reachAll(g)
}

/** A connecting door (or a wide opening between break areas) between two neighbouring rooms. */
function neighbourDoor(g: Gen, a: Room, b: Room): boolean {
  if (!LINKABLE.has(a.kind) || !LINKABLE.has(b.kind)) return false
  const t = contact(a.rect, b.rect)
  if (!t || t.hi - t.lo < 2.2) return false
  const r = g.r
  const wide = OPENS.has(a.kind) && OPENS.has(b.kind)
  const w = wide ? Math.min(t.hi - t.lo - 0.9, r.pick([1.8, 2.4, 3])) : 1.25
  // Toward the back of the room, away from its corridor door, so it makes a second route.
  const lo = t.lo + 0.45
  const hi = t.hi - 0.45
  if (hi - lo < w) return false
  const back = horizontal(t.side) === horizontal(a.front) ? 0.5 : a.front === "n" || a.front === "w" ? 0.6 : 0.4
  const c = Math.min(hi - w / 2, Math.max(lo + w / 2, lo + (hi - lo) * back + (r.next() - 0.5) * 0.6))
  return g.door(wide ? "open" : "door", a.id, b.id, t.side, q(c - w / 2), q(c + w / 2))
}

/** One more way into a room that has only one. */
function second(g: Gen, room: Room): void {
  const r = g.r
  const opts: { go: () => boolean; w: number }[] = []
  for (const s of ["n", "s", "e", "w"] as Side[]) {
    for (const f of g.frontage(room.rect, s, room.id)) {
      if (f.hi - f.lo < 2) continue
      const used = g.busy(room.id, s, f.lo, f.hi, 0).filter((o) => o.kind !== "glass").length
      if (used && f.hi - f.lo < 5) continue
      const other = f.z >= 0 ? g.rooms[f.z]! : null
      if (other && (other.kind === "core" || other.kind === "reception") && room.kind !== "foyer") continue
      opts.push({
        w: (s === room.front ? 2 : 6) * (f.z < 0 ? 1.2 : 1),
        go: () => {
          const lo = f.lo + 0.45
          const hi = f.hi - 0.45
          const w = 1.25
          // At the end of the stretch away from the doors already there.
          const ex = g.busy(room.id, s, f.lo, f.hi, 0)
          const mid = ex.length ? ex.reduce((a, o) => a + (horizontal(s) ? o.x0 + o.x1 : o.y0 + o.y1) / 2, 0) / ex.length : (lo + hi) / 2
          const c = ex.length ? (mid - lo > hi - mid ? lo + w / 2 : hi - w / 2) : r.range(lo + w / 2, hi - w / 2)
          return g.door("door", room.id, f.z, s, q(c - w / 2), q(c + w / 2))
        },
      })
    }
  }
  for (const o of g.rooms) {
    if (o.id === room.id || THROUGH.has(o.kind)) continue
    const t = contact(room.rect, o.rect)
    if (!t || t.hi - t.lo < 2.2 || !LINKABLE.has(room.kind) || !LINKABLE.has(o.kind)) continue
    opts.push({ w: ways(g, o.id) < 2 ? 4 : 2, go: () => neighbourDoor(g, room, o) })
  }
  while (opts.length) {
    const pick = weighted(
      r,
      opts.map((o) => [o, o.w] as const),
    )
    if (pick.go()) return
    opts.splice(opts.indexOf(pick), 1)
  }
}

/** Rooms with no way in get a door from a neighbour that has one, corridors and walk-through rooms first. */
function reachAll(g: Gen): void {
  const r = g.r
  const reach = () => {
    const seen = new Set<number>()
    const queue: number[] = g.corridors.map((_, k) => -1 - k)
    if (!queue.length) {
      const start = g.rooms.find((x) => x.kind === "hall") ?? g.rooms.find((x) => x.kind !== "shaft")
      if (start) queue.push(start.id)
    }
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
  for (let pass = 0; pass < 60; pass++) {
    const seen = reach()
    const stuck = g.rooms.filter((x) => x.kind !== "shaft" && !seen.has(x.id))
    if (!stuck.length) return
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
      const w = Math.min(1.25, best.t.hi - best.t.lo - 0.5)
      // Clear of doors already on that wall.
      let c = (best.t.lo + best.t.hi) / 2
      for (const cand of [0.5, 0.25, 0.75, 0.15, 0.85]) {
        c = best.t.lo + (best.t.hi - best.t.lo) * cand
        if (!g.busy(room.id, best.t.side, c - w / 2, c + w / 2, 0.2).some((o) => o.kind !== "glass")) break
      }
      if (g.door("door", room.id, best.z, best.t.side, q(c - w / 2), q(c + w / 2))) {
        fixed = true
        break
      }
    }
    if (!fixed) break
  }
  // Anything still sealed off becomes plant room: solid, like the lift shafts.
  const seen = reach()
  for (const x of g.rooms) if (!seen.has(x.id) && x.kind !== "shaft") {
    x.kind = "shaft"
    g.openings = g.openings.filter((o) => o.a !== x.id && o.b !== x.id)
  }
}

/** Any must-have room the rows didn't produce takes over an ordinary one. */
export function program(g: Gen): void {
  const must: [RoomKind, number][] = [
    ["kitchen", 1],
    ["copy", 1],
    ["server", 1],
    ["storage", 1],
    ["meeting", 1],
  ]
  for (const [kind, n] of must) {
    if (kind === "kitchen" && g.rooms.some((x) => x.kind === "cafe")) continue
    for (let have = g.rooms.filter((x) => x.kind === kind).length; have < n; have++) {
      const pool = g.rooms.filter((x) => (x.kind === "office" || x.kind === "empty" || x.kind === "manager" || x.kind === "lab") && (x.rect[2] - x.rect[0]) * (x.rect[3] - x.rect[1]) >= 12 && !g.inner.has(x.id))
      if (!pool.length) break
      g.r.pick(pool).kind = kind
    }
  }
}
