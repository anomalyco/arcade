import { Vector3 } from "three"
import type { Quality } from "../../sim/types"

export interface WorldQualitySettings {
  far: number
  fogNear: number
  fogFar: number
  /** Clusters farther than this (rect distance) are hidden. */
  viewRadius: number
  /** Cluster rect-distance thresholds for LOD 0, 1, 2; beyond uses LOD 3. */
  lod: [number, number, number]
  treeRadius: number
  treesPerCluster: number
  clouds: number
  budgetMs: number
  inflight: number
}

export const WORLD_QUALITY: Record<Quality, WorldQualitySettings> = {
  low: { far: 10_000, fogNear: 500, fogFar: 9_800, viewRadius: 10_000, lod: [800, 3_000, 6_500], treeRadius: 1_300, treesPerCluster: 1_800, clouds: 16, budgetMs: 1.5, inflight: 2 },
  balanced: { far: 14_000, fogNear: 700, fogFar: 13_600, viewRadius: 14_000, lod: [1_400, 4_000, 8_000], treeRadius: 1_900, treesPerCluster: 3_200, clouds: 24, budgetMs: 2, inflight: 3 },
  high: { far: 18_000, fogNear: 900, fogFar: 17_500, viewRadius: 18_000, lod: [2_200, 5_500, 10_000], treeRadius: 2_600, treesPerCluster: 4_800, clouds: 32, budgetMs: 2, inflight: 4 },
}

/** Direction toward the sun (unit). Warm late-morning sun from the south-east. */
export const SUN_DIRECTION = new Vector3(0.55, 0.55, 0.62).normalize()
