import {
  FOLIAGE_BUILD_LIVELY,
  FOLIAGE_BUILD_TODAY,
  FOLIAGE_GUST_OFF,
  type FoliageBuildOptions,
  type FoliageGust,
} from "@arcade/kit/gpu/foliage"
import { TREE_LOOK_OPTIONS } from "@arcade/kit/gpu/foliage-looks"
import type { LabControl } from "@arcade/kit/lab-panel"

/**
 * Lab settings for Outbreak's trees, hedges, shrubs and grass (Backquote › Vegetation). "Today" keeps the shipped
 * meshes and per-plant wobble; "Lively" gives trees species, bare trees and swaying limbs, adds stray shoots to shrubs,
 * and drives everything from one town-wide gust field (`applyFoliageWindField` in `@arcade/kit/gpu/foliage`). The wind
 * reads only sim time and world position, so co-op clients see the same gusts.
 */
export type OutbreakVegetationSettings = {
  /** 0 Today (shipped meshes and wobble), 1 Lively (species, bare trees, gust field). */
  vegLook: number
  /** Lively tree detail: 0 low, 1 medium (today's clump counts), 2 high. Rebuilds the level. */
  vegQuality: number
  /** Overall wind: scales every layer's lean and sway. */
  vegWind: number
  /** Length of a gust front downwind, metres. */
  vegGustScale: number
  /** How fast gust fronts travel across the town, m/s. */
  vegGustSpeed: number
  /** Direction the wind blows toward, degrees from +x toward +z. */
  vegWindDir: number
  /** Bough layer: crowns and their limbs lean and sway. */
  vegBranchSway: number
  /** Leaf layer: small fast flutter near the camera, leaves catching and losing the light. */
  vegLeafFlutter: number
  /** Hedges and shrubs. */
  vegBushSway: number
  /** Grass blades laid over by passing gusts. */
  vegGrassSway: number
  /** How far trunks lean with their crowns (0 rigid). */
  vegTrunkBend: number
  /** Radius around the survivor inside which overhead canopies part so you can see underneath, metres (0 off). */
  vegCanopyOpen: number
  /** Share of trees left bare (dead or leafless). Rebuilds the level. */
  vegDeadTrees: number
  /** 0 every tree follows the tree look; 1 trees pick oak, maple, birch or pine by seed (autumn share in A–C). Rebuilds the level. */
  vegVariety: number
  /**
   * Tree look (D-41, Lively only; `@arcade/kit/gpu/foliage-looks`): 0 Today (Lively, #273), 1 A Diablo Deadwood,
   * 2 B Tiny Glade Fluffy, 3 C Darkwood × Diablo. Rebuilds the level.
   */
  vegTreeLook: number
  /** How far A and C trees sink to near-black, grey outside light (× the look's own amount). */
  vegTreeShade: number
  /** Extra saturation A and C trees keep where light lands. */
  vegTreeRichness: number
  /** Test the burn hook: the tree nearest the survivor burns at this state (0 off, 0.3 burning, 1 burnt). */
  vegBurnTest: number
}

export const DEFAULT_VEGETATION_SETTINGS: OutbreakVegetationSettings = {
  vegLook: 1,
  vegQuality: 1,
  vegWind: 1,
  vegGustScale: 22,
  vegGustSpeed: 5.5,
  vegWindDir: 28,
  vegBranchSway: 1,
  vegLeafFlutter: 1,
  vegBushSway: 1,
  vegGrassSway: 1,
  vegTrunkBend: 0.25,
  vegCanopyOpen: 2.4,
  vegDeadTrees: FOLIAGE_BUILD_LIVELY.deadTrees,
  vegVariety: FOLIAGE_BUILD_LIVELY.variety,
  vegTreeLook: 0,
  vegTreeShade: 1,
  vegTreeRichness: 1,
  vegBurnTest: 0,
}

const GROUP = "Vegetation"

export const vegetationControls: readonly LabControl[] = [
  { key: "vegLook", label: "Vegetation", group: GROUP, type: "select", options: [{ value: 0, label: "Today" }, { value: 1, label: "Lively (species, gusts)" }] },
  { key: "vegTreeLook", label: "Tree look", group: GROUP, type: "select", options: TREE_LOOK_OPTIONS },
  { key: "vegTreeShade", label: "Tree shade outside light (A, C)", group: GROUP, min: 0, max: 1.5, step: 0.05, unit: "×" },
  { key: "vegTreeRichness", label: "Tree colour in light (A, C)", group: GROUP, min: 0, max: 1.5, step: 0.05, unit: "" },
  { key: "vegQuality", label: "Tree detail", group: GROUP, type: "select", options: [{ value: 0, label: "Low" }, { value: 1, label: "Medium" }, { value: 2, label: "High" }] },
  { key: "vegWind", label: "Wind strength", group: GROUP, min: 0, max: 2.5, step: 0.05, unit: "×" },
  { key: "vegGustScale", label: "Gust size", group: GROUP, min: 6, max: 60, step: 1, unit: "m" },
  { key: "vegGustSpeed", label: "Gust speed", group: GROUP, min: 0.5, max: 14, step: 0.5, unit: "m/s" },
  { key: "vegWindDir", label: "Wind direction", group: GROUP, min: 0, max: 359, step: 1, unit: "°" },
  { key: "vegBranchSway", label: "Bough sway", group: GROUP, min: 0, max: 2.5, step: 0.05, unit: "×" },
  { key: "vegLeafFlutter", label: "Leaf flutter", group: GROUP, min: 0, max: 2.5, step: 0.05, unit: "×" },
  { key: "vegBushSway", label: "Shrub & hedge sway", group: GROUP, min: 0, max: 2.5, step: 0.05, unit: "×" },
  { key: "vegGrassSway", label: "Grass sway", group: GROUP, min: 0, max: 2.5, step: 0.05, unit: "×" },
  { key: "vegTrunkBend", label: "Trunk lean", group: GROUP, min: 0, max: 1, step: 0.05, unit: "" },
  { key: "vegCanopyOpen", label: "Canopy parts over survivor", group: GROUP, min: 0, max: 4, step: 0.1, unit: "m" },
  { key: "vegDeadTrees", label: "Bare trees", group: GROUP, min: 0, max: 0.5, step: 0.02, unit: "" },
  { key: "vegVariety", label: "Species mix", group: GROUP, min: 0, max: 1, step: 0.05, unit: "" },
  { key: "vegBurnTest", label: "Test: burn nearest tree", group: GROUP, min: 0, max: 1, step: 0.05, unit: "" },
]

/** Build options the level and streamed chunks read through `plant()`; synced from settings before every rebuild. */
export const vegetationBuild: FoliageBuildOptions = { ...FOLIAGE_BUILD_LIVELY }

/**
 * Copies the settings' build options into `vegetationBuild`; true when the meshes need rebuilding. Allocation-free
 * when nothing changed, so `world/scene-level.ts` can call it every frame.
 */
export function syncVegetationBuild(s: Readonly<OutbreakVegetationSettings>): boolean {
  const b = vegetationBuild
  const lively = s.vegLook >= 0.5
  const quality = lively ? Math.round(s.vegQuality) : FOLIAGE_BUILD_TODAY.quality
  const deadTrees = lively ? s.vegDeadTrees : FOLIAGE_BUILD_TODAY.deadTrees
  const variety = lively ? s.vegVariety : FOLIAGE_BUILD_TODAY.variety
  const treeLook = lively ? Math.round(s.vegTreeLook) : 0
  if (b.lively === lively && b.quality === quality && b.deadTrees === deadTrees && b.variety === variety && b.treeLook === treeLook) return false
  b.lively = lively
  b.quality = quality
  b.deadTrees = deadTrees
  b.variety = variety
  b.treeLook = treeLook
  return true
}

function signatureOf(o: Readonly<FoliageBuildOptions>): string {
  return o.lively ? `L${o.quality}/${o.deadTrees}/${o.variety}${o.treeLook ? `/t${o.treeLook}` : ""}` : "T"
}

/** Part of every level and chunk cache key, so a change of look rebuilds rather than reusing old meshes. */
export const vegetationSignature = (): string => signatureOf(vegetationBuild)

const gustScratch: { -readonly [K in keyof FoliageGust]: number } = { ...FOLIAGE_GUST_OFF }

/** The wind field uniforms for this frame's settings (`FOLIAGE_GUST_OFF` on Today); reuses one object per call. */
export function vegetationGust(s: Readonly<OutbreakVegetationSettings>): FoliageGust {
  if (s.vegLook < 0.5) return FOLIAGE_GUST_OFF
  const a = (s.vegWindDir * Math.PI) / 180
  const g = gustScratch
  g.on = 1
  g.strength = s.vegWind
  g.gustScale = s.vegGustScale
  g.gustSpeed = s.vegGustSpeed
  g.dirX = Math.cos(a)
  g.dirZ = Math.sin(a)
  g.branchSway = s.vegBranchSway
  g.leafFlutter = s.vegLeafFlutter
  g.bushSway = s.vegBushSway
  g.grassSway = s.vegGrassSway
  g.trunkBend = s.vegTrunkBend
  g.canopyOpen = s.vegCanopyOpen
  return g
}
