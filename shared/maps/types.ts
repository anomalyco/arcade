import type { Rect, Vec } from "../geom"

export type WallStyle = "wall" | "partition" | "rack" | "shelf" | "pillar" | "stall" | "core"

/** Walls block movement and bullets, and cast light shadows. */
export type Wall = { rect: Rect; h: number; style: WallStyle }

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
  | "whiteboard"
  | "reception"
  | "printer"
  | "exitdoor"
  | "lamp"

/** Furniture. Solid props block movement only. `rot` turns the model in quarter turns. */
export type Prop = { kind: PropKind; rect: Rect; rot: 0 | 1 | 2 | 3; solid: boolean; light?: number }

export type FloorKind = "carpet" | "tile" | "wood" | "concrete" | "grate"
export type Floor = { rect: Rect; kind: FloorKind }

export type LightKind = "desk" | "panel" | "pendant" | "exit" | "vending" | "server" | "bulb"

/** A light, for looks only. `h` is its height; `cone` is a floor-plan direction and the cosine of the half-angle. */
export type LightDef = {
  id: number
  kind: LightKind
  x: number
  y: number
  h: number
  r: number
  power: number
  color: readonly [number, number, number]
  cone?: readonly [number, number, number]
}

export type MapDef = {
  id: string
  seed: number
  name: string
  size: readonly [number, number]
  floors: readonly Floor[]
  walls: readonly Wall[]
  /** Outer windows and interior glass: block movement and bullets, not light. */
  windows: readonly Rect[]
  glass: readonly Rect[]
  props: readonly Prop[]
  lights: readonly LightDef[]
  spawns: readonly Vec[]
  /** Floor tape along aisles, drawn only. */
  tape: readonly Rect[]
}
