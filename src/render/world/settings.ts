import { Vector3 } from "three"
import type { Quality } from "../../sim/types"

export interface WorldQualitySettings {
  far: number
  fogNear: number
  fogFar: number
  /** Terrain tiles farther than this are hidden. */
  viewRadius: number
  /** LOD distance thresholds (m) for 64, 32 and 16 segment tiles; beyond uses 8. */
  lod: [number, number, number]
  treeRadius: number
  treesPerTile: number
  /** Distance where trees switch to their low-poly crowns. */
  treeDetailRadius: number
  clouds: number
  budgetMs: number
  inflight: number
}

export const WORLD_QUALITY: Record<Quality, WorldQualitySettings> = {
  low: { far: 12_000, fogNear: 3_500, fogFar: 11_500, viewRadius: 11_500, lod: [1_200, 3_000, 6_000], treeRadius: 1_700, treesPerTile: 320, treeDetailRadius: 700, clouds: 26, budgetMs: 1.5, inflight: 3 },
  balanced: { far: 18_000, fogNear: 5_000, fogFar: 17_000, viewRadius: 17_000, lod: [1_700, 4_000, 8_000], treeRadius: 2_500, treesPerTile: 560, treeDetailRadius: 1_100, clouds: 40, budgetMs: 2, inflight: 4 },
  high: { far: 24_000, fogNear: 6_500, fogFar: 23_000, viewRadius: 23_000, lod: [2_300, 5_200, 10_000], treeRadius: 3_400, treesPerTile: 800, treeDetailRadius: 1_600, clouds: 56, budgetMs: 2, inflight: 6 },
}

/** Direction toward the sun (unit). Late-morning tropical sun from the south-east. */
export const SUN_DIRECTION = new Vector3(0.45, 0.72, 0.53).normalize()

export const PALETTE = {
  horizon: "#cfe6f2",
  zenith: "#4d9be0",
  sunLight: "#fff3dc",
  hemiSky: "#cfe7ff",
  hemiGround: "#5f7a4c",
  sand: "#f0d9a0",
  lush: "#6fbf4a",
  meadow: "#98cc5a",
  forest: "#3f8f4a",
  darkForest: "#377d47",
  rock: "#a3958a",
  darkRock: "#8a807a",
  snow: "#f6f8fc",
  deepWater: "#1b5fa8",
  midWater: "#1f8fc4",
  shallowWater: "#3fd6cf",
  foam: "#f4fbff",
  abyss: "#173f78",
}

export const TEAM_COLORS = ["#2f6fd1", "#e0902a", "#2fae5a", "#d13f3f"]
