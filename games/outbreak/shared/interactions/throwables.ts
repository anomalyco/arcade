import type { AIAgent } from "@arcade/kit/sim/ai"
import { raycast, type Rect } from "@arcade/kit/sim/geom"
import type { StoreState } from "@arcade/kit/sim/ledger"
import type { WindowOpening } from "../map"

/**
 * Throwables (AR-96, Kit after the co-op playtest: "Also maybe like baseballs you can throw?"). Baseballs, bricks,
 * rocks, tin cans and bottles lie about in houses and yards. Hold the button to wind up (the arc and where it lands
 * are drawn), let go to throw: further the longer you hold. A throw flies over the heads of the dead in the middle
 * of a long lob and hits the first one near its ends, bounces off walls, rolls, and is heard where it lands, so a can
 * over a fence pulls the crowd away. A baseball to the head bonks one down, a brick hurts, a rock in between; a
 * bottle shatters into glass (and the crunch underfoot), and a brick, rock or baseball goes through a shut window.
 * What survives the throw lies where it stopped, to be picked up again.
 *
 * Every throw is one ledger store from a fixed ring, so co-op seats see it with the ledger deltas and nothing is added
 * to the wire. Times are deciseconds, offsets centimetres from `at` (where it comes to rest).
 *
 * | Store | Counts | Meaning |
 * | --- | --- | --- |
 * | `toss:<k>` | `t`, `fl`, `it`, `sx`, `sy`, `ix`, `iy`, `pk`, `out`, `done` | thrown at `t` from `at + s`, reaching `at + i` after `fl` (peak `pk` cm), then rolling to `at` |
 * | `drop:t:<k>:<t>` | the item | a thrown thing lying where it stopped (an ordinary ground drop) |
 * | `drop:v:yard:<building>` | the item | one found on a porch, in a yard or on a floor (seeded once per house) |
 */

export const THROWABLE_ITEMS = ["baseball", "brick", "rock", "tin-can", "bottle"] as const
export type ThrowableItem = (typeof THROWABLE_ITEMS)[number]

export const isThrowable = (item: string | undefined): item is ThrowableItem => item !== undefined && (THROWABLE_ITEMS as readonly string[]).includes(item)

export type ThrowableDef = {
  /** Metres at full wind-up. */
  range: number
  /** Damage to the one it hits. */
  damage: number
  /** Seconds the one it hits staggers (a bonk knocks it down for this long). */
  stagger: number
  /** Knocks down rather than staggers: a baseball to the head. */
  bonk: boolean
  /** How far its landing carries to the dead, in metres. */
  noise: number
  /** Breaks on landing (into glass) rather than lying there to be picked up. */
  shatters: boolean
  /** Goes through a shut window, breaking it. */
  breaksWindows: boolean
  /** Share of what is left of the throw it rolls or bounces on after landing (0 drops dead, 1 skips on). */
  bounce: number
}

export const THROWABLES: Readonly<Record<ThrowableItem, ThrowableDef>> = {
  baseball: { range: 20, damage: 12, stagger: 1.6, bonk: true, noise: 6, shatters: false, breaksWindows: true, bounce: 0.4 },
  brick: { range: 11, damage: 34, stagger: 0.9, bonk: false, noise: 8, shatters: false, breaksWindows: true, bounce: 0.06 },
  rock: { range: 15, damage: 20, stagger: 0.7, bonk: false, noise: 6, shatters: false, breaksWindows: true, bounce: 0.2 },
  "tin-can": { range: 14, damage: 3, stagger: 0.25, bonk: false, noise: 11, shatters: false, breaksWindows: false, bounce: 0.55 },
  bottle: { range: 13, damage: 8, stagger: 0.5, bonk: false, noise: 15, shatters: true, breaksWindows: false, bounce: 0 },
}

/** 0..1 power of a throw held for `held` seconds: a tap throws `throwTap` of full range. */
export function throwPower(held: number, t: { throwWindup: number; throwTap: number }): number {
  const u = Math.max(0, Math.min(1, held / Math.max(0.05, t.throwWindup)))
  return t.throwTap + (1 - t.throwTap) * u
}

/** Height a throw leaves the hand at, and the height of a head it can hit. */
export const HAND_HEIGHT = 1.4
const BODY_LOW = 0.3
const HEAD_LOW = 1.15
const HEAD_HIGH = 2.0
/** How near the line of a throw one of the dead has to be to be hit. */
const HIT_RADIUS = 0.42
/** How near where a throw comes down one of the dead has to be to take it. */
const LAND_RADIUS = 0.6

/** The arc's height above the ground at `u` (0 in the hand, 1 on landing) for a throw peaking `peak` metres up. */
export function arcHeight(u: number, peak: number): number {
  return HAND_HEIGHT * (1 - u) + 4 * peak * u * (1 - u)
}

/** How high a throw of `dist` metres arcs (above the straight line from hand to ground). */
export const arcPeak = (dist: number) => Math.min(3.2, 0.25 + dist * 0.15)

/** Seconds a throw of `dist` metres is in the air. */
export const flightTime = (dist: number) => Math.max(0.22, Math.min(0.95, 0.12 + dist / 18))

export type TossPlan = {
  /** Where it comes down (a head, a wall, a window or the ground). */
  ix: number
  iy: number
  /** Where it comes to rest. */
  rx: number
  ry: number
  /** Metres from the hand to `i`, and the arc's peak over them. */
  dist: number
  peak: number
  flight: number
  /** The one of the dead it hits, if any, and whether on the head (a baseball there bonks them down). */
  hit: AIAgent | null
  head: boolean
  /** The shut window it goes through (or breaks against), if any. */
  window: WindowOpening | null
  /** It struck a wall (or a shut door) and fell back. */
  wall: boolean
}

/** How far along a ray the first of `rects` is, or `maxT` if none is nearer. */
function cast(ox: number, oy: number, dx: number, dy: number, rects: readonly Rect[], maxT: number): number {
  return Math.min(maxT, raycast(ox, oy, dx, dy, rects, maxT))
}

/**
 * Where a throw from `(x, y)` along `aim` at `power` goes. Pure: the same world gives the same plan on every seat.
 * `walls` are what stop it (walls and shut doors, `sightRects`), `windows` the town's windows, `agents` the dead.
 */
export function planToss(
  x: number,
  y: number,
  aim: number,
  power: number,
  def: ThrowableDef,
  throwRange: number,
  walls: readonly Rect[],
  windows: readonly WindowOpening[],
  agents: readonly AIAgent[],
): TossPlan {
  const dx = Math.cos(aim)
  const dy = Math.sin(aim)
  const want = Math.max(1, def.range * throwRange * Math.max(0.05, Math.min(1, power)))
  const peak = arcPeak(want)
  const wallT = cast(x, y, dx, dy, walls, want)
  let stopT = wallT
  let window: WindowOpening | null = null
  for (const w of windows) {
    if (w.open) continue
    const t = cast(x, y, dx, dy, [w.rect], stopT)
    if (t < stopT - 1e-6) {
      stopT = t
      window = w
    }
  }
  let hit: AIAgent | null = null
  let hitT = Infinity
  let head = false
  for (const a of agents) {
    if (a.state === "dead") continue
    const ox = a.x - x
    const oy = a.y - y
    const along = ox * dx + oy * dy
    if (along < 0.5 || along > stopT + 0.3) continue
    const across = Math.abs(ox * dy - oy * dx)
    const landing = Math.hypot(a.x - (x + dx * stopT), a.y - (y + dy * stopT))
    const h = arcHeight(Math.min(1, along / want), peak)
    const inLine = across <= HIT_RADIUS && h >= BODY_LOW && h <= HEAD_HIGH
    if ((inLine || landing <= LAND_RADIUS) && along < hitT) {
      hit = a
      hitT = along
      head = inLine && h >= HEAD_LOW
    }
  }
  if (hit) {
    const ix = hit.x - dx * 0.2
    const iy = hit.y - dy * 0.2
    // It drops at their feet, glancing off a little to one side.
    const back = 0.35 + def.bounce * 0.6
    const rT = Math.max(0, cast(ix, iy, -dx, -dy, walls, back) - 0.2)
    return { ix, iy, rx: ix - dx * rT, ry: iy - dy * rT, dist: hitT, peak, flight: flightTime(hitT), hit, head, window: null, wall: false }
  }
  const ix = x + dx * Math.max(0.4, stopT - (stopT < want ? 0.12 : 0))
  const iy = y + dy * Math.max(0.4, stopT - (stopT < want ? 0.12 : 0))
  const left = Math.max(0, want - stopT)
  if (window && def.breaksWindows) {
    // Through the glass: it lands a stride beyond, inside.
    const on = Math.min(1.6, 0.6 + left * 0.3)
    const rT = Math.max(0, cast(ix, iy, dx, dy, walls, on + 0.3) - 0.3)
    return { ix, iy, rx: ix + dx * rT, ry: iy + dy * rT, dist: stopT, peak, flight: flightTime(stopT), hit: null, head: false, window, wall: false }
  }
  if (stopT < want - 1e-6) {
    // Off the wall (or off the glass for what cannot break it): it falls back the way it came.
    const back = Math.min(2.5, 0.25 + left * def.bounce * 0.5)
    const rT = Math.max(0, cast(ix, iy, -dx, -dy, walls, back + 0.3) - 0.3)
    return { ix, iy, rx: ix - dx * rT, ry: iy - dy * rT, dist: stopT, peak, flight: flightTime(stopT), hit: null, head: false, window, wall: true }
  }
  const roll = want * def.bounce * 0.18
  const rT = Math.max(0, cast(ix, iy, dx, dy, walls, roll + 0.3) - 0.3)
  return { ix, iy, rx: ix + dx * Math.min(roll, rT), ry: iy + dy * Math.min(roll, rT), dist: want, peak, flight: flightTime(want), hit: null, head: false, window: null, wall: false }
}

// ── The store ──────────────────────────────────────────────────────────────────────────────────────────────────

export const TOSS_RING = 16
export const tossId = (k: number) => `toss:${k}`
export const isTossStore = (id: string) => id.startsWith("toss:")

/** `out` bits. */
export const OUT_HIT = 1
export const OUT_BONK = 2
export const OUT_WINDOW = 4
export const OUT_SHATTER = 8
export const OUT_WALL = 16

/** Seconds the roll after landing takes. */
export const ROLL_SECONDS = 0.35

export const tossItem = (st: StoreState): ThrowableItem => THROWABLE_ITEMS[st.counts.it ?? 0] ?? "rock"

/**
 * A throw in flight at `time`: where it is, how high, whether it is still moving, and `phase` (0..1 flying, 1..2
 * rolling, 2 at rest). Null before it was thrown.
 */
export function tossAt(st: StoreState, time: number): { x: number; y: number; h: number; phase: number; spin: number } | null {
  if (!st.at || !st.counts.t) return null
  const t0 = st.counts.t / 10
  const fl = Math.max(0.1, (st.counts.fl ?? 5) / 10)
  const age = time - t0
  if (age < 0) return null
  const ax = st.at.x
  const ay = st.at.y
  const sx = ax + (st.counts.sx ?? 0) / 100
  const sy = ay + (st.counts.sy ?? 0) / 100
  const ix = ax + (st.counts.ix ?? 0) / 100
  const iy = ay + (st.counts.iy ?? 0) / 100
  const peak = (st.counts.pk ?? 0) / 100
  if (age < fl) {
    const u = age / fl
    // Where it comes down is not always the ground: a head or a window catches it at their height.
    const out = st.counts.out ?? 0
    const end = out & OUT_HIT ? 1.55 : out & (OUT_WINDOW | OUT_WALL) ? 1.1 : 0
    return { x: sx + (ix - sx) * u, y: sy + (iy - sy) * u, h: arcHeight(u, peak) + end * u, phase: u, spin: age * 14 }
  }
  const out = st.counts.out ?? 0
  const from = out & OUT_HIT ? 1.55 : out & (OUT_WINDOW | OUT_WALL) ? 1.1 : 0
  const r = Math.min(1, (age - fl) / ROLL_SECONDS)
  const k = 1 - (1 - r) * (1 - r)
  // Off a head or a wall it falls the rest of the way; on open ground it hops once and rolls.
  const h = from > 0 ? from * (1 - r) * (1 - r) : Math.sin(Math.PI * r) * 0.18 * (1 - r)
  return { x: ix + (ax - ix) * k, y: iy + (ay - iy) * k, h, phase: 1 + r, spin: (fl + (age - fl) * (1 - r)) * 14 }
}
