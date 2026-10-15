import { distToRect, type Rect } from "@arcade/kit/sim/geom"
import { EXTERIOR_VEHICLE_COLLIDERS, propShape, type Door, type Prop, type Town, type WindowOpening } from "../map"

/**
 * Verbs (D-19 slice 4): crouching, hiding in closets, peepholes, thrown bottles, can tripwires, car alarms and
 * crowbar repairs. Pure geometry and store naming; the state is ledger stores (so it snapshots, saves and reaches
 * co-op clients like everything else) and the survivor's own fields.
 *
 * | Store | Counts | Meaning |
 * | --- | --- | --- |
 * | `hide:<closet>` | `in: 1`, owner = who | someone is inside that closet |
 * | `trip:<portal>` | `armed: 1` or `0` | cans strung across a door or window; 0 once sprung |
 * | `car:<key>` | `smashed`, `alarm`, `start`, `until` (deciseconds) | a car's window broken; an alarm that wailed |
 * | `glass:<n>` | `t` (deciseconds), `steps`, `keep` | broken glass where a bottle landed (swept after a while), or a vignette's (`keep`, never swept); `steps` counts feet that crunched it |
 */

export const hideStoreId = (closet: string) => `hide:${closet}`
export const tripStoreId = (portal: string) => `trip:${portal}`
export const carStoreId = (key: string) => `car:${key}`

/** Deciseconds: store counts are integers, so times are kept to a tenth of a second. */
export const ds = (seconds: number) => Math.round(seconds * 10)

// ── Closets ───────────────────────────────────────────────────────────────────────────────────────────────────

export type ClosetSite = { id: string; x: number; y: number; rect: Rect; out: { x: number; y: number } }

/** Closets in the world: tall cupboards a survivor can squeeze into. Their doors face south (+y). */
export function closetSites(town: Town): ClosetSite[] {
  const out: ClosetSite[] = []
  for (const p of town.props) {
    if (p.kind !== "closet") continue
    const shape = propShape(p)!
    out.push({ id: closetId(p), x: p.x, y: p.y, rect: shape.rect, out: { x: p.x, y: shape.rect[3] + 0.45 } })
  }
  return out
}

export { closetSpot } from "./closet-spot"

export const closetId = (p: Pick<Prop, "x" | "y">) => `closet:${p.x.toFixed(2)},${p.y.toFixed(2)}`

// ── Cars ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type CarSite = { key: string; rect: Rect; x: number; y: number; alarm: boolean }

const hash01 = (s: string) => {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return (h >>> 0) / 4294967296
}

/** The abandoned cars along the streets. About half still have a working alarm, fixed per car. */
export function carSites(town: Town): CarSite[] {
  return (town.vehicles ?? EXTERIOR_VEHICLE_COLLIDERS).map((rect) => {
    const x = (rect[0] + rect[2]) / 2
    const y = (rect[1] + rect[3]) / 2
    const key = `${x.toFixed(1)},${y.toFixed(1)}`
    return { key, rect, x, y, alarm: hash01(key) < 0.5 }
  })
}

// ── Tripwires ─────────────────────────────────────────────────────────────────────────────────────────────────

export type Portal = Pick<Door, "id" | "rect"> | Pick<WindowOpening, "id" | "rect">

/** The doorways and windows a tripwire can be strung across. */
export function portals(town: Town): Portal[] {
  return [...town.doors, ...town.windows]
}

export const portalCentre = (p: Portal) => ({ x: (p.rect[0] + p.rect[2]) / 2, y: (p.rect[1] + p.rect[3]) / 2 })

/** Whether a point is passing through a portal: inside its opening, give or take a stride either side. */
export function crossing(p: Portal, x: number, y: number, stride = 0.38): boolean {
  const [x0, y0, x1, y1] = p.rect
  const horizontal = x1 - x0 > y1 - y0
  return horizontal ? x > x0 && x < x1 && y > y0 - stride && y < y1 + stride : y > y0 && y < y1 && x > x0 - stride && x < x1 + stride
}

/**
 * Doorways someone strung cans across before the game began: the front door of each pharmacy, police station and
 * clinic. Walking through rattles them (crouch to step over); taking one down teaches how.
 */
export const TRAPPED_ARCHETYPES: readonly string[] = ["pharmacy", "police", "clinic"]

export function trappedDoors(town: Town): string[] {
  const out: string[] = []
  for (const b of town.buildings) {
    if (!TRAPPED_ARCHETYPES.includes(b.archetype ?? b.kind)) continue
    const front = town.doors.find((d) => d.id === `${b.id}-front`)
    if (front) out.push(front.id)
  }
  return out
}

/** How far from the opening the cans hang: about a stride, where someone stepping through puts a foot down. */
const TRIP_INSET = 0.55

export type TripLine = { id: string; x: number; y: number; rect: Rect }

/**
 * Where a portal's tripwire hangs, as a thin rect across the opening: a stride inside its building, except in a south
 * wall, whose height hides a couple of metres of floor from the camera looking north over it; there the cans go
 * across the step outside, where whoever approaches can see them. A portal that belongs to no building keeps it in
 * the opening.
 */
export function tripLine(town: Town, p: Portal): TripLine {
  const [x0, y0, x1, y1] = p.rect
  const c = portalCentre(p)
  const horizontal = x1 - x0 > y1 - y0
  let owner: Town["buildings"][number] | undefined
  let best = 0.5
  for (const b of town.buildings) {
    const d = distToRect(c.x, c.y, b.rect)
    if (d <= best) {
      best = d
      owner = b
    }
  }
  let ox = 0
  let oy = 0
  if (owner) {
    // A north or south wall's line is always on its south side, the side the camera sees.
    if (horizontal) oy = TRIP_INSET
    else ox = Math.sign((owner.rect[0] + owner.rect[2]) / 2 - c.x) * TRIP_INSET
  }
  const rect: Rect = horizontal
    ? [x0, c.y + oy - 0.04, x1, c.y + oy + 0.04]
    : [c.x + ox - 0.04, y0, c.x + ox + 0.04, y1]
  return { id: p.id, x: c.x + ox, y: c.y + oy, rect }
}

/** The portal nearest a point within `range`, if any. */
export function nearestPortal(town: Town, x: number, y: number, range: number): Portal | null {
  let best: Portal | null = null
  let bestD = range
  for (const p of portals(town)) {
    const d = distToRect(x, y, p.rect)
    if (d <= bestD) {
      bestD = d
      best = p
    }
  }
  return best
}
