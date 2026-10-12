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
  | "cafe"
  | "lab"
  | "foyer"
  | "demo"

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
 * The floor's overall arrangement (see plans.ts):
 * - ring: a corridor loop round a central zone of core and rooms, offices or open plan outside it.
 * - spine: two corridors the length of the floor, ladder-linked by cross corridors, ending at fire exits.
 * - atrium: a ring round a glazed garden court.
 * - court: a ring round an open-air light well cut out of the plate.
 * - sidecore: the core on a facade, a spine corridor, a deep open plan with islands of rooms.
 * - cross: two corridors crossing, a quadrant of different workspace in each corner; L, T, U and H plates.
 * - open: no corridors at all, open plan wrapped round an island core, rooms along some facades.
 */
export type Archetype = "ring" | "spine" | "atrium" | "court" | "sidecore" | "cross" | "open"

export type Plan = {
  W: number
  H: number
  archetype: Archetype
  /** The plate's outline and the notable zone templates, e.g. "L", "suite", "cafe", "demo". */
  tags: string[]
  rooms: Room[]
  corridors: Rect[]
  openings: Opening[]
  ends: End[]
  /** Structural columns standing in open frontages. */
  pillars: Rect[]
  /** Outer walls that must be solid (fire exits and the core sit against them). */
  solid: Side[]
  /** Parts of the bounding rect outside the building: terraces and light wells, glazed round, not walkable. */
  voids: Rect[]
}

export const EPS = 1e-3
export const q = (v: number) => Math.round(v * 100) / 100
/** A value from lo to hi in steps (planning-grid dimensions). */
export const step = (r: Rng, lo: number, hi: number, by: number) => q(lo + by * r.int(Math.floor((hi - lo) / by + EPS) + 1))
/** Snaps to the 0.3 m planning grid. */
export const snap = (v: number) => q(Math.round(v / 0.3) * 0.3)

export function shuffle<T>(r: Rng, xs: T[]): T[] {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = r.int(i + 1)
    ;[xs[i], xs[j]] = [xs[j]!, xs[i]!]
  }
  return xs
}

export function weighted<T>(r: Rng, table: readonly (readonly [T, number])[]): T {
  const total = table.reduce((s, [, w]) => s + Math.max(0, w), 0)
  let x = r.next() * total
  for (const [v, w] of table) {
    x -= Math.max(0, w)
    if (x < 0) return v
  }
  return table[table.length - 1]![0]
}

export const OPP: Record<Side, Side> = { n: "s", s: "n", e: "w", w: "e" }
/** Side under a swap of x and y. */
export const SWAP: Record<Side, Side> = { n: "w", w: "n", s: "e", e: "s" }
export const horizontal = (s: Side) => s === "n" || s === "s"

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
export const lineOf = (rc: Rect, s: Side) => (s === "n" ? rc[1] : s === "s" ? rc[3] : s === "w" ? rc[0] : rc[2])

export const area = (rc: Rect) => (rc[2] - rc[0]) * (rc[3] - rc[1])
export const overlaps = (a: Rect, b: Rect) => a[0] < b[2] - EPS && a[2] > b[0] + EPS && a[1] < b[3] - EPS && a[3] > b[1] + EPS

/** Rect a minus rect b, as up to four rects: full-width strips above and below, then the sides. */
export function subtract(a: Rect, b: Rect): Rect[] {
  if (!overlaps(a, b)) return [a]
  const out: Rect[] = []
  if (b[1] > a[1] + EPS) out.push([a[0], a[1], a[2], b[1]])
  if (b[3] < a[3] - EPS) out.push([a[0], b[3], a[2], a[3]])
  const y0 = Math.max(a[1], b[1])
  const y1 = Math.min(a[3], b[3])
  if (b[0] > a[0] + EPS) out.push([a[0], y0, b[0], y1])
  if (b[2] < a[2] - EPS) out.push([b[2], y0, a[2], y1])
  return out
}

/** Rect a minus rect b, splitting the other way: full-height strips left and right, then above and below. */
export function subtractV(a: Rect, b: Rect): Rect[] {
  if (!overlaps(a, b)) return [a]
  const out: Rect[] = []
  if (b[0] > a[0] + EPS) out.push([a[0], a[1], b[0], a[3]])
  if (b[2] < a[2] - EPS) out.push([b[2], a[1], a[2], a[3]])
  const x0 = Math.max(a[0], b[0])
  const x1 = Math.min(a[2], b[2])
  if (b[1] > a[1] + EPS) out.push([x0, a[1], x1, b[1]])
  if (b[3] < a[3] - EPS) out.push([x0, b[3], x1, a[3]])
  return out
}
