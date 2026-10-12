import type { Rect, Vec } from "../geom"
import type { Rng } from "../rng"
import type { Builder } from "./builder"
import type { Side } from "./geo"
import type { VehicleSpawn } from "./types"

/** Height of a one-storey shop's walls (open to the sky like the office, so you can see in). */
export const SHOP_H = 3.4
export const rd = (v: number) => Math.round(v * 100) / 100

/** A road: its asphalt, which way it runs, travel lanes, parking lane widths on its low and high side. Stubs dead-end at the map edge `end`. */
export type Street = { rect: Rect; axis: "x" | "y"; lanes: number; park: [number, number]; stub: boolean; end?: Side }
/** A road crossing: its box and which arms leave it. */
export type Junction = { rect: Rect; n: boolean; s: boolean; w: boolean; e: boolean }
export type BlockKind = "buildings" | "plaza" | "parking" | "park" | "edge"
/** A city block: its rect including the sidewalk, the lot inside it, and what's built there. Edge strips front one way. */
export type Block = { rect: Rect; lot: Rect; kind: BlockKind; front?: Side; big: boolean }
/** A strip of sidewalk and the side of it that is the curb. */
export type Walk = { rect: Rect; curb: Side }

/** Everything the downtown generator passes between its stages. */
export type Town = {
  b: Builder
  r: Rng
  W: number
  H: number
  /** Sidewalk width. */
  sw: number
  streets: Street[]
  blocks: Block[]
  junctions: Junction[]
  walks: Walk[]
  /** Footprints street furniture must keep out of. */
  taken: Rect[]
  /** Where lights already are, to keep them spread. */
  lit: Vec[]
  shops: number
  /** Raised kerbed areas (sidewalks), for the renderer's curbs. */
  curbs: Rect[]
  /** Drivable vehicles parked at the start of every match. */
  vehicles: VehicleSpawn[]
}

export const overlap = (a: Rect, b: Rect, pad = 0) => a[0] < b[2] + pad && a[2] > b[0] - pad && a[1] < b[3] + pad && a[3] > b[1] - pad

/** True when rc is clear of everything taken (and of every street's drivable part when `road` is false). */
export function free(t: Town, rc: Rect, pad = 0.1): boolean {
  return !t.taken.some((q) => overlap(q, rc, pad))
}

export function take(t: Town, rc: Rect): void {
  t.taken.push(rc)
}

/** Unit vector out of a rect through side s. */
export const OUT: Record<Side, [number, number]> = { n: [0, -1], s: [0, 1], w: [-1, 0], e: [1, 0] }
/** Prop rotation that faces out through side s (models face +y at rot 0). */
export const FACE: Record<Side, 0 | 1 | 2 | 3> = { s: 0, w: 1, n: 2, e: 3 }

/** The part of a street cars drive on: the asphalt less its parking lanes. */
export function drive(s: Street): Rect {
  const [x0, y0, x1, y1] = s.rect
  return s.axis === "x" ? [x0, y0 + s.park[0], x1, y1 - s.park[1]] : [x0 + s.park[0], y0, x1 - s.park[1], y1]
}

