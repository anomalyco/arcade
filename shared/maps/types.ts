import type { Rect, Vec } from "../geom"
import type { LightDef } from "../sim/light"

/** How a blocking wall is drawn. All styles block light, sight, bullets and movement. */
export type WallStyle = "wall" | "partition" | "rack" | "shelf" | "pillar" | "stall" | "core"

export type Wall = { rect: Rect; h: number; style: WallStyle }

/** Door. Closed it blocks like a wall; open it blocks nothing. */
export type Door = { id: number; rect: Rect }

/** Breakable glass. Blocks movement and nothing else; a bullet shatters it. */
export type Glass = { id: number; rect: Rect }

export type PropKind =
  | "desk"
  | "chair"
  | "cabinet"
  | "plant"
  | "sofa"
  | "table"
  | "vending"
  | "copier"
  | "counter"
  | "fridge"
  | "cooler"
  | "bookshelf"
  | "crate"
  | "pallet"
  | "barrel"
  | "forklift"
  | "bench"
  | "exitdoor"
  | "lamp"
  | "pillar"
  | "printer"
  | "whiteboard"
  | "reception"
  | "liftdoor"

/** Furniture and clutter. Solid props block movement only. `rot` turns the model in quarter turns. */
export type Prop = { kind: PropKind; rect: Rect; rot: 0 | 1 | 2 | 3; solid: boolean; light?: number }

export type FloorKind = "carpet" | "tile" | "concrete" | "grate" | "wood"
export type Floor = { rect: Rect; kind: FloorKind }

export type Noisy = { rect: Rect; kind: "grate" | "puddle" }

export type Breaker = { x: number; y: number; group: string }

export type MapDef = {
  /** Unique per layout, e.g. "office-1234". */
  id: string
  seed: number
  name: string
  blurb: string
  size: readonly [number, number]
  floors: readonly Floor[]
  walls: readonly Wall[]
  /** Outer windows: block movement and bullets, let light and sight through. */
  windows: readonly Rect[]
  glass: readonly Glass[]
  doors: readonly Door[]
  /** Doors that start the round open. */
  openDoors: readonly number[]
  props: readonly Prop[]
  lights: readonly LightDef[]
  breakers: readonly Breaker[]
  noisy: readonly Noisy[]
  spawns: readonly Vec[]
  /** Mustard floor tape along aisles, drawn only. */
  tape: readonly Rect[]
  /** The lift and stair core: solid, drawn with lift doors. */
  cores: readonly Rect[]
  /** Base ambient light, linear RGB. Kept tiny: darkness should be dark. */
  ambient: readonly [number, number, number]
}
