import type { Rect, Vec } from "../geom"

export type WallStyle =
  | "wall"
  | "partition"
  | "rack"
  | "shelf"
  | "pillar"
  | "stall"
  | "core"
  // Downtown: solid blocks and street cover.
  | "building"
  | "shop"
  | "car"
  | "dumpster"
  | "barrier"
  | "planter"
  | "hedge"
  | "fence"
  | "fountain"
  | "wreck"
  | "hoarding"
  | "subway"

/**
 * Walls block movement and bullets, and cast light shadows. `v` picks a variant for the renderer (a car's model,
 * colour and which way it faces; a building's facade).
 */
export type Wall = { rect: Rect; h: number; style: WallStyle; v?: number }

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
  | "boards"
  | "ladder"
  // Downtown street furniture.
  | "lamppost"
  | "parklamp"
  | "signal"
  | "hydrant"
  | "bench"
  | "bin"
  | "newsbox"
  | "bollard"
  | "tree"
  | "shelter"
  | "neon"
  | "stool"
  | "floodpole"
  | "bags"

/** Furniture. Solid props block movement only. `rot` turns the model in quarter turns. `text` is a sign's lettering. */
export type Prop = { kind: PropKind; rect: Rect; rot: 0 | 1 | 2 | 3; solid: boolean; light?: number; text?: string }

export type FloorKind = "carpet" | "tile" | "wood" | "concrete" | "grate" | "asphalt" | "sidewalk" | "plaza" | "grass" | "parking"
export type Floor = { rect: Rect; kind: FloorKind }

export type LightKind = "desk" | "panel" | "pendant" | "exit" | "vending" | "server" | "bulb" | "street" | "signal" | "neon" | "fire" | "flood" | "glow"

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
  /** How unreliable the fitting is, 0 (steady) to 1 (barely working). A hint for the renderer; optional. */
  flicker?: number
}

/** Road paint, drawn only: lane lines, crosswalk stripes, stop lines, parking bays. */
export type Paint = { rect: Rect; color: "white" | "yellow" }

/**
 * A stretch of road for vehicles: its asphalt kerb to kerb, which way it runs, its travel lanes, and the width of the
 * parking lane on its low and high side (cars are parked there). Roads meet at junctions edge to edge.
 */
export type Road = { rect: Rect; axis: "x" | "y"; lanes: number; park: readonly [number, number] }

/** Which generator made the map: the office tower floor, or the streets downtown. */
export type MapKind = "office" | "downtown"
export const MAP_KINDS: readonly MapKind[] = ["office", "downtown"]

export type MapDef = {
  kind: MapKind
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
  /** Parts of the bounding rect outside the building (terraces, light wells): glazed round and never walkable. */
  voids?: readonly Rect[]
  /** Drivable vehicles parked here at the start of every match (shared/sim/vehicle.ts); none indoors. */
  vehicles?: readonly VehicleSpawn[]
  /** Downtown: road markings, and the roads themselves (vehicles drive on them). */
  paint?: readonly Paint[]
  roads?: readonly Road[]
}

export type VehicleKind = "jeep" | "van" | "scooter"

/** A vehicle's parking spot: its centre, and its heading in radians on the plan (0 faces +x, π/2 faces +y). */
export type VehicleSpawn = { kind: VehicleKind; x: number; y: number; heading: number }
