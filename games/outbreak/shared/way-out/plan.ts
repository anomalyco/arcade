import { Rng } from "@arcade/kit/sim/rng"
import { MACRO_SIZE } from "../world"
import type { WayOutTuning } from "./tuning"

/**
 * The Way Out (AR-64): where this town's way out is. A pure function of the town's seeds and the tuning, so the room,
 * every client and the Lab agree without sending it. Roads run on a grid, through the middle of every 96 m block
 * (`shared/world.ts`), so the destination sits on a crossroads 1.5–3 km out by road and the route there is an L along
 * two of those roads: out along one, then along the other to the destination.
 */

export type DestinationKind = "ferry" | "checkpoint" | "airfield" | "dam"
export const DESTINATION_KINDS: readonly DestinationKind[] = ["ferry", "checkpoint", "airfield", "dam"]

export type Compass = "north" | "south" | "east" | "west"

/** How each destination reads in words: the clue fragments, toasts and the escape card. */
export const DESTINATION_WORDS: Readonly<Record<DestinationKind, { name: string; short: string; by: string; craft: string; place: string }>> = {
  ferry: { name: "The harbour ferry", short: "The ferry", by: "by ferry", craft: "boat", place: "harbour" },
  checkpoint: { name: "The army checkpoint", short: "The checkpoint", by: "by army convoy", craft: "convoy", place: "checkpoint" },
  airfield: { name: "The airfield", short: "The airfield", by: "by plane", craft: "plane", place: "airfield" },
  dam: { name: "The dam", short: "The dam", by: "by helicopter", craft: "helicopter", place: "dam" },
}

export type RoadPoint = { x: number; y: number }

/** Something placed beside the route: where it stands and which way it faces (radians, toward the road). */
export type RoadsideSpot = { x: number; y: number; yaw: number; along: number }

export type WayOutPlan = {
  key: string
  kind: DestinationKind
  /** The destination's crossroads (its macro-block `bx, by`). */
  x: number
  y: number
  bx: number
  by: number
  /** Road distance from the town's crossroads (m). */
  distance: number
  /** Town crossroads, the corner (when the route turns), the destination. */
  route: RoadPoint[]
  /** The road the route comes in on, named for where it comes from ("the road in from the north"). */
  arrival: Compass
  /** Compass word for the destination from town ("east", "north-east"). */
  bearing: string
  /** Where you signal from: a post just off the crossroads on the arrival side. */
  signal: RoadPoint
  sign: RoadsideSpot
  soldier: RoadsideSpot
  /** The direction clues' rough area: a circle around a point near the destination, never centred on it. */
  rough: { x: number; y: number; r: number }
}

/** The town's crossroads, where every route starts. */
export const TOWN_CROSSROADS: RoadPoint = { x: 44, y: 44 }
const ROAD = 44
/** Roadside things stand on the pavement, this far from the road's middle (m). */
const KERB = 5

const roadAt = (b: number) => b * MACRO_SIZE + ROAD
const mod = (v: number, m: number) => ((v % m) + m) % m

export function planSeed(seed: number, houseSeed: number): number {
  let h = 2166136261 ^ 0x57a9
  for (const v of [seed >>> 0, houseSeed >>> 0]) {
    h = Math.imul(h ^ (v & 0xffff), 16777619)
    h = Math.imul(h ^ (v >>> 16), 16777619)
  }
  h ^= h >>> 15
  h = Math.imul(h, 0x2c1b3c6d)
  h ^= h >>> 12
  return h >>> 0 || 1
}

const BEARINGS = ["east", "south-east", "south", "south-west", "west", "north-west", "north", "north-east"]

/** Compass word for a direction in plan space (x east, y south). */
export function bearingOf(dx: number, dy: number): string {
  const a = Math.atan2(dy, dx)
  return BEARINGS[mod(Math.round(a / (Math.PI / 4)), 8)]!
}

function legDir(a: RoadPoint, b: RoadPoint): { dx: number; dy: number; len: number } {
  const len = Math.abs(b.x - a.x) + Math.abs(b.y - a.y)
  return { dx: Math.sign(b.x - a.x), dy: Math.sign(b.y - a.y), len }
}

/** The point `s` metres along a polyline of axis-aligned legs, and that leg's direction. */
export function alongRoute(route: readonly RoadPoint[], s: number): { x: number; y: number; dx: number; dy: number; leg: number } {
  let left = Math.max(0, s)
  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i]!
    const b = route[i + 1]!
    const { dx, dy, len } = legDir(a, b)
    if (left <= len || i === route.length - 2) {
      const k = Math.min(left, len)
      return { x: a.x + dx * k, y: a.y + dy * k, dx, dy, leg: i }
    }
    left -= len
  }
  const p = route[route.length - 1]!
  return { x: p.x, y: p.y, dx: 1, dy: 0, leg: 0 }
}

export function routeLength(route: readonly RoadPoint[]): number {
  let n = 0
  for (let i = 0; i < route.length - 1; i++) n += legDir(route[i]!, route[i + 1]!).len
  return n
}

/**
 * The middle of the straight stretch of road nearest `s` along the route (between two crossroads, where nothing is
 * parked in the junction), kept on the same leg.
 */
export function straightAt(route: readonly RoadPoint[], s: number): number {
  const p = alongRoute(route, s)
  const a = route[p.leg]!
  const b = route[p.leg + 1] ?? a
  const { len } = legDir(a, b)
  if (len < MACRO_SIZE) return s
  // Distance along this leg from its start, and of the leg's start along the whole route.
  let legStart = 0
  for (let i = 0; i < p.leg; i++) legStart += legDir(route[i]!, route[i + 1]!).len
  const k = s - legStart
  // Crossroads fall every 96 m from the leg's start (it starts on one); stretch middles at 48 + 96n.
  const n = Math.max(0, Math.min(Math.floor((len - 48) / MACRO_SIZE), Math.round((k - 48) / MACRO_SIZE)))
  return legStart + 48 + n * MACRO_SIZE
}

function roadside(route: readonly RoadPoint[], s: number, side: number): RoadsideSpot {
  const along = straightAt(route, s)
  const p = alongRoute(route, along)
  // Left of travel is (dy, -dx) in plan space (y south).
  const px = p.dy * side
  const py = -p.dx * side
  return {
    x: Number((p.x + px * KERB).toFixed(2)),
    y: Number((p.y + py * KERB).toFixed(2)),
    yaw: Number(Math.atan2(-py, -px).toFixed(3)),
    along,
  }
}

const cache = new Map<string, WayOutPlan>()

/** The town's way out. Deterministic in `(seed, houseSeed)` and the plan's tunables. */
export function wayOutPlan(
  seed: number,
  houseSeed: number,
  t: Pick<WayOutTuning, "destination" | "minDistance" | "maxDistance" | "signAt" | "soldierAt">,
): WayOutPlan {
  const key = `${seed >>> 0}:${houseSeed >>> 0}:${t.destination}:${t.minDistance}:${t.maxDistance}:${t.signAt}:${t.soldierAt}`
  const hit = cache.get(key)
  if (hit) return hit
  const rng = new Rng(planSeed(seed, houseSeed))
  const picked = rng.pick(DESTINATION_KINDS)
  const kind = t.destination >= 0 ? DESTINATION_KINDS[Math.floor(t.destination) % DESTINATION_KINDS.length]! : picked
  const lo = Math.max(2 * MACRO_SIZE, Math.min(t.minDistance, t.maxDistance))
  const hi = Math.max(lo, t.maxDistance)
  const blocksLo = Math.ceil(lo / MACRO_SIZE)
  const blocksHi = Math.max(blocksLo, Math.floor(hi / MACRO_SIZE))
  const total = blocksLo + rng.int(blocksHi - blocksLo + 1)
  const primaryX = rng.next() < 0.5
  const main = Math.round(total * (0.6 + rng.next() * 0.4))
  const side = total - main
  const sx = rng.next() < 0.5 ? -1 : 1
  const sy = rng.next() < 0.5 ? -1 : 1
  const bx = sx * (primaryX ? main : side)
  const by = sy * (primaryX ? side : main)
  const dest = { x: roadAt(bx), y: roadAt(by) }
  const o = TOWN_CROSSROADS
  const xFirst = rng.next() < 0.5
  const corner = xFirst ? { x: dest.x, y: o.y } : { x: o.x, y: dest.y }
  const route: RoadPoint[] = [{ ...o }]
  if ((corner.x !== o.x || corner.y !== o.y) && (corner.x !== dest.x || corner.y !== dest.y)) route.push(corner)
  route.push({ ...dest })
  const last = legDir(route[route.length - 2]!, dest)
  const arrival: Compass = last.dx > 0 ? "west" : last.dx < 0 ? "east" : last.dy > 0 ? "north" : "south"
  const len = routeLength(route)
  // The post stands on the arrival side, at the near-left corner of the crossroads.
  const signal = { x: dest.x - last.dx * 9 + last.dy * 8, y: dest.y - last.dy * 9 - last.dx * 8 }
  const fuzz = rng.next() * Math.PI * 2
  const roughR = Math.max(220, Math.min(520, len * 0.2))
  const plan: WayOutPlan = {
    key,
    kind,
    x: dest.x,
    y: dest.y,
    bx,
    by,
    distance: len,
    route,
    arrival,
    bearing: bearingOf(dest.x - o.x, dest.y - o.y),
    signal,
    sign: roadside(route, Math.min(t.signAt, len - MACRO_SIZE), 1),
    soldier: roadside(route, Math.min(t.soldierAt, len - MACRO_SIZE), -1),
    rough: {
      x: Number((dest.x + Math.cos(fuzz) * roughR * 0.55).toFixed(1)),
      y: Number((dest.y + Math.sin(fuzz) * roughR * 0.55).toFixed(1)),
      r: Number(roughR.toFixed(1)),
    },
  }
  if (cache.size > 32) cache.delete(cache.keys().next().value!)
  cache.set(key, plan)
  return plan
}

/** "about 2 km" / "about 800 m" for clue fragments. */
export function roughDistance(m: number): string {
  if (m >= 950) return `about ${Math.round(m / 500) / 2} km`
  return `about ${Math.round(m / 100) * 100} m`
}
