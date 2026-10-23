/**
 * Plain-data description of a forest level: what the gameplay toy owns and the forest renderer
 * (`@arcade/kit/forest`) draws. Pure (no GPU, no DOM), so a game's `shared/` sim can import it for walking
 * heights and colliders. Units are metres, +y up, yaw in radians about +y (0 faces +z).
 */
export type Vec2 = readonly [number, number]
export type Vec3 = readonly [number, number, number]

export type TreeSpecies = "pine" | "spruce" | "birch" | "snag"

export interface ForestTree {
  x: number
  z: number
  species: TreeSpecies
  /** Trunk radius at breast height. Old-growth pine 0.3–0.6, birch 0.1–0.2. */
  r: number
  /** Total height. */
  h: number
  /** Lean from vertical (radians) and its direction. */
  lean?: number
  leanYaw?: number
  /** Stable per-tree seed: bark offset, branch layout, tint. */
  seed: number
}

export interface ForestRock {
  x: number
  z: number
  /** Footprint radius and height above the ground. */
  r: number
  h: number
  yaw: number
  seed: number
  /** 0–1 moss cover on top faces (default 0.7). */
  moss?: number
}

/** A fallen trunk lying on the terrain, centred at (x, z). */
export interface ForestLog {
  x: number
  z: number
  yaw: number
  length: number
  r: number
  seed: number
}

/** A worn trail: no ferns on it, packed dirt and needles. */
export interface ForestPath {
  points: readonly Vec2[]
  width: number
}

export interface ForestClearing {
  x: number
  z: number
  r: number
}

/** Still water. The surface is flat at `level`; the shoreline is where terrain crosses it. */
export interface ForestLake {
  x: number
  z: number
  rx: number
  rz: number
  level: number
}

export type CampBuildingKind = "mess-hall" | "cabin" | "shed"

export interface CampBuilding {
  kind: CampBuildingKind
  x: number
  z: number
  yaw: number
  /** Footprint width (local x), depth (local z) and eave height. */
  w: number
  d: number
  h: number
  /** Fraction of windows lit from inside, 0–1. */
  lit: number
  porch?: boolean
}

export interface CampDock {
  x: number
  z: number
  yaw: number
  length: number
  width: number
}

/** A sagging string of bulbs between posts or eaves. */
export interface CampStringLight {
  points: readonly Vec3[]
  bulbs: number
}

export interface CampProp {
  kind: "canoe" | "bench" | "picnic-table" | "fire-pit" | "flagpole" | "stump"
  x: number
  z: number
  yaw: number
}

export interface ForestCamp {
  buildings: readonly CampBuilding[]
  dock?: CampDock
  stringLights?: readonly CampStringLight[]
  props?: readonly CampProp[]
}

/** Orange flagging tape tied round a trunk at height y (relative to the ground), or hung from a branch. */
export interface ForestFlag {
  x: number
  z: number
  y: number
  yaw: number
  /** Trunk radius it wraps; 0 hangs a loose streamer. */
  r: number
}

export interface ForestWorld {
  seed: number
  /** Half-size of the square that holds the level; the renderer fills to it and fades past it. */
  half: number
  /** Ground height at (x, z). Pure and deterministic: the sim walks on it, the renderer meshes it. */
  height(x: number, z: number): number
  trees: readonly ForestTree[]
  rocks: readonly ForestRock[]
  logs: readonly ForestLog[]
  paths?: readonly ForestPath[]
  clearings?: readonly ForestClearing[]
  lake?: ForestLake
  camp?: ForestCamp
  flags?: readonly ForestFlag[]
}
