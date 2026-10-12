import { Vector3 } from "three"
import type { Quality } from "../../sim/types"
import { SUN_DIRECTION as SUN_DIR } from "./palette"

export interface WorldQualitySettings {
  far: number
  /** Legacy linear-fog range (the storm uses height fog; see palette FOG_DENSITY_*). */
  fogNear: number
  fogFar: number
  /** Clusters farther than this (rect distance) are hidden. */
  viewRadius: number
  /** Cluster rect-distance thresholds for LOD 0, 1, 2; beyond uses LOD 3. */
  lod: [number, number, number]
  treeRadius: number
  treesPerCluster: number
  /** Kept for compatibility (old cumulus count). */
  clouds: number
  budgetMs: number
  inflight: number
  /** Ocean grid: radial segments × rings, and Gerstner waves displaced in the vertex stage. */
  oceanSegments: number
  oceanRings: number
  oceanWaves: number
  /** Extra per-pixel chop waves (normals only). */
  oceanChop: number
  /** Rain streaks / sea-spray particles around the camera. */
  rain: number
  spray: number
  /** Number of moving cloud-deck layers (0 = sky dome only). */
  cloudLayers: number
}

export const WORLD_QUALITY: Record<Quality, WorldQualitySettings> = {
  low: {
    far: 9_000, fogNear: 150, fogFar: 5_000, viewRadius: 9_000, lod: [800, 2_600, 5_500], treeRadius: 1_200, treesPerCluster: 2_500,
    clouds: 0, budgetMs: 1.5, inflight: 2, oceanSegments: 96, oceanRings: 64, oceanWaves: 4, oceanChop: 2, rain: 2_500, spray: 0, cloudLayers: 0,
  },
  balanced: {
    far: 12_000, fogNear: 150, fogFar: 5_500, viewRadius: 12_000, lod: [1_300, 3_500, 7_000], treeRadius: 1_700, treesPerCluster: 5_000,
    clouds: 0, budgetMs: 2, inflight: 3, oceanSegments: 192, oceanRings: 120, oceanWaves: 7, oceanChop: 4, rain: 7_000, spray: 1_200, cloudLayers: 1,
  },
  high: {
    far: 15_000, fogNear: 150, fogFar: 6_000, viewRadius: 15_000, lod: [2_000, 4_500, 9_000], treeRadius: 2_400, treesPerCluster: 8_000,
    clouds: 0, budgetMs: 2, inflight: 4, oceanSegments: 288, oceanRings: 180, oceanWaves: 9, oceanChop: 6, rain: 14_000, spray: 2_500, cloudLayers: 2,
  },
}

/** Direction toward the key light (unit) as a Vector3. */
export const SUN_DIRECTION = new Vector3(...SUN_DIR).normalize()
