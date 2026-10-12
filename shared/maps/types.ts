import type { MapId } from "../config"
import type { Rect, Vec } from "../geom"

export type Door = { id: number; rect: Rect }
export type LampDef = { id: number; x: number; y: number; radius: number; power: number; color: readonly [number, number, number] }
export type NoisySurface = { rect: Rect; kind: "grate" | "puddle" }

export type MapDef = {
  id: MapId
  name: string
  blurb: string
  size: readonly [number, number]
  /** Static walls. Block light, bullets and movement. */
  walls: readonly Rect[]
  /** Closed doors block like walls. Open doors do not. */
  doors: readonly Door[]
  lamps: readonly LampDef[]
  spawns: readonly Vec[]
  /** Open floor points bots patrol between. */
  nav: readonly Vec[]
  noisy: readonly NoisySurface[]
}
