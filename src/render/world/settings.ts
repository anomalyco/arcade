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
  low: { far: 12_000, fogNear: 1_200, fogFar: 11_500, viewRadius: 11_000, lod: [1_500, 4_500, 9_000], treeRadius: 1_500, treesPerCluster: 900, clouds: 24, budgetMs: 1.5, inflight: 2 },
  balanced: { far: 18_000, fogNear: 1_600, fogFar: 17_000, viewRadius: 16_500, lod: [2_200, 6_000, 13_000], treeRadius: 2_200, treesPerCluster: 1_600, clouds: 36, budgetMs: 2, inflight: 3 },
  high: { far: 24_000, fogNear: 2_000, fogFar: 23_000, viewRadius: 22_500, lod: [2_800, 8_000, 17_000], treeRadius: 3_000, treesPerCluster: 2_400, clouds: 48, budgetMs: 2, inflight: 4 },
}

/** Direction toward the sun (unit). Warm late-morning sun from the south-east. */
export const SUN_DIRECTION = new Vector3(0.5, 0.62, 0.6).normalize()
