import { MAT, Mesh, type Rgb } from "./mesh"
import { wgslStruct } from "./wgsl"
import { Rng } from "../sim/rng"

/** The three vegetation looks the Lab tunes separately; each has its own presets, parameters and Randomize. */
export type FoliageKind = "tree" | "bush" | "grass"
export type TreePresetId = "oak" | "maple" | "pine" | "birch"
export type BushPresetId = "hedge" | "overgrown" | "hydrangea"
export type GrassPresetId = "lawn" | "overgrown" | "weeds"
/** @deprecated Tree presets only; use `TreePresetId`. */
export type FoliagePresetId = TreePresetId
export type FoliageCrownShape = "dome" | "layered" | "columnar" | "conical" | "spreading"
export type FoliageCameraMode = "close" | "game"
export type FoliageStageMode = "lot" | "swatch"
export type FoliageCompareMode = 0 | 1 | 2

export type FoliageNumericKey =
  // Tree
  | "treeHeight"
  | "crownRadius"
  | "branchCount"
  | "branchAngle"
  | "clumpCount"
  | "clumpSize"
  | "leafCardSize"
  | "porosity"
  | "treeColorR"
  | "treeColorG"
  | "treeColorB"
  | "treeColorVariation"
  | "autumnMix"
  | "translucency"
  | "canopyAO"
  | "normalSoftness"
  | "treeWindStrength"
  | "treeWindFreq"
  | "treeWindGust"
  // Bush
  | "bushHeight"
  | "bushSpread"
  | "bushLobes"
  | "bushTrim"
  | "bushLeafSize"
  | "bushDensity"
  | "bushColorR"
  | "bushColorG"
  | "bushColorB"
  | "bushColorVariation"
  | "bushFlowers"
  | "bushAO"
  | "bushTranslucency"
  | "bushWind"
  // Grass
  | "grassDensity"
  | "bladeHeight"
  | "bladeWidth"
  | "bladeCurvature"
  | "grassClumping"
  | "rootColorR"
  | "rootColorG"
  | "rootColorB"
  | "tipColorR"
  | "tipColorG"
  | "tipColorB"
  | "grassVariation"
  | "dryPatches"
  | "weedRosettes"
  | "grassWind"
  | "distanceFade"
  | "trampleRadius"
  | "trampleStrength"

export type FoliageParams = Record<FoliageNumericKey, number> & {
  treePreset: TreePresetId
  bushPreset: BushPresetId
  grassPreset: GrassPresetId
  crownShape: FoliageCrownShape
}

export type FoliageParamGroup =
  | "Tree Structure"
  | "Tree Canopy & Shading"
  | "Tree Wind"
  | "Bush Shape"
  | "Bush Leaves & Colour"
  | "Bush Light & Wind"
  | "Grass Blades"
  | "Grass Colour"
  | "Grass Wind & Interaction"

export type FoliageParamSpec = {
  key: FoliageNumericKey
  kind: FoliageKind
  label: string
  group: FoliageParamGroup
  min: number
  max: number
  step: number
  unit: "" | "m" | "°" | "×" | "Hz"
  /**
   * Update boundary per docs/lab.md:
   * - "structural": rebuilds tree/bush/grass meshes deterministically from the structure seed.
   * - "uniform": updates shader uniforms live without rebuilding meshes.
   */
  boundary: "structural" | "uniform"
}

const spec = (
  kind: FoliageKind,
  group: FoliageParamGroup,
  key: FoliageNumericKey,
  label: string,
  min: number,
  max: number,
  step: number,
  unit: FoliageParamSpec["unit"],
  boundary: FoliageParamSpec["boundary"] = "structural",
): FoliageParamSpec => ({ key, kind, label, group, min, max, step, unit, boundary })

export const FOLIAGE_PARAM_SPECS: readonly FoliageParamSpec[] = [
  spec("tree", "Tree Structure", "treeHeight", "Height", 1.2, 7.5, 0.1, "m"),
  spec("tree", "Tree Structure", "crownRadius", "Crown radius", 0.7, 3.8, 0.05, "m"),
  spec("tree", "Tree Structure", "branchCount", "Branch count", 3, 10, 1, ""),
  spec("tree", "Tree Structure", "branchAngle", "Branch angle", 18, 78, 1, "°"),
  spec("tree", "Tree Structure", "clumpCount", "Clumps per branch", 1, 5, 1, ""),
  spec("tree", "Tree Structure", "clumpSize", "Clump size", 0.35, 1.65, 0.05, "m"),
  spec("tree", "Tree Structure", "leafCardSize", "Leaf cluster size", 0.12, 0.75, 0.02, "m"),
  spec("tree", "Tree Structure", "porosity", "Crown porosity", 0.0, 0.85, 0.05, ""),
  spec("tree", "Tree Canopy & Shading", "treeColorR", "Leaf red", 0.08, 0.85, 0.01, ""),
  spec("tree", "Tree Canopy & Shading", "treeColorG", "Leaf green", 0.12, 0.85, 0.01, ""),
  spec("tree", "Tree Canopy & Shading", "treeColorB", "Leaf blue", 0.05, 0.65, 0.01, ""),
  spec("tree", "Tree Canopy & Shading", "treeColorVariation", "Colour variation", 0.0, 1.0, 0.02, ""),
  spec("tree", "Tree Canopy & Shading", "autumnMix", "Autumn mix", 0.0, 1.0, 0.02, ""),
  spec("tree", "Tree Canopy & Shading", "translucency", "Translucency", 0.0, 1.0, 0.02, "", "uniform"),
  spec("tree", "Tree Canopy & Shading", "canopyAO", "Interior AO", 0.0, 1.0, 0.02, ""),
  spec("tree", "Tree Canopy & Shading", "normalSoftness", "Soft dome normals", 0.0, 1.0, 0.02, ""),
  spec("tree", "Tree Wind", "treeWindStrength", "Sway strength", 0.0, 1.0, 0.02, "", "uniform"),
  spec("tree", "Tree Wind", "treeWindFreq", "Sway frequency", 0.2, 3.0, 0.05, "Hz", "uniform"),
  spec("tree", "Tree Wind", "treeWindGust", "Gustiness", 0.0, 1.0, 0.02, "", "uniform"),

  spec("bush", "Bush Shape", "bushHeight", "Height scale", 0.6, 1.6, 0.05, "×"),
  spec("bush", "Bush Shape", "bushSpread", "Spread scale", 0.6, 1.6, 0.05, "×"),
  spec("bush", "Bush Shape", "bushLobes", "Mound lobes", 3, 9, 1, ""),
  spec("bush", "Bush Shape", "bushTrim", "Clipped (0 wild, 1 hedge)", 0.0, 1.0, 0.02, ""),
  spec("bush", "Bush Leaves & Colour", "bushLeafSize", "Leaf cluster size", 0.06, 0.36, 0.01, "m"),
  spec("bush", "Bush Leaves & Colour", "bushDensity", "Leaf density", 0.5, 1.8, 0.05, "×"),
  spec("bush", "Bush Leaves & Colour", "bushColorR", "Leaf red", 0.08, 0.85, 0.01, ""),
  spec("bush", "Bush Leaves & Colour", "bushColorG", "Leaf green", 0.12, 0.85, 0.01, ""),
  spec("bush", "Bush Leaves & Colour", "bushColorB", "Leaf blue", 0.05, 0.65, 0.01, ""),
  spec("bush", "Bush Leaves & Colour", "bushColorVariation", "Colour variation", 0.0, 1.0, 0.02, ""),
  spec("bush", "Bush Leaves & Colour", "bushFlowers", "Blossoms", 0.0, 1.0, 0.02, ""),
  spec("bush", "Bush Light & Wind", "bushAO", "Interior AO", 0.0, 1.0, 0.02, ""),
  spec("bush", "Bush Light & Wind", "bushTranslucency", "Translucency", 0.0, 1.0, 0.02, "", "uniform"),
  spec("bush", "Bush Light & Wind", "bushWind", "Wind rustle", 0.0, 1.0, 0.02, "", "uniform"),

  spec("grass", "Grass Blades", "grassDensity", "Density", 0.25, 2.5, 0.05, "×"),
  spec("grass", "Grass Blades", "bladeHeight", "Blade height", 0.06, 0.55, 0.01, "m"),
  spec("grass", "Grass Blades", "bladeWidth", "Blade width", 0.015, 0.12, 0.005, "m"),
  spec("grass", "Grass Blades", "bladeCurvature", "Blade curvature", 0.0, 1.0, 0.02, ""),
  spec("grass", "Grass Blades", "grassClumping", "Clumping", 0.0, 1.0, 0.02, ""),
  spec("grass", "Grass Colour", "rootColorR", "Root red", 0.04, 0.65, 0.01, ""),
  spec("grass", "Grass Colour", "rootColorG", "Root green", 0.06, 0.70, 0.01, ""),
  spec("grass", "Grass Colour", "rootColorB", "Root blue", 0.03, 0.50, 0.01, ""),
  spec("grass", "Grass Colour", "tipColorR", "Tip red", 0.12, 0.90, 0.01, ""),
  spec("grass", "Grass Colour", "tipColorG", "Tip green", 0.18, 0.92, 0.01, ""),
  spec("grass", "Grass Colour", "tipColorB", "Tip blue", 0.06, 0.65, 0.01, ""),
  spec("grass", "Grass Colour", "grassVariation", "Colour variation", 0.0, 1.0, 0.02, ""),
  spec("grass", "Grass Colour", "dryPatches", "Dry patches", 0.0, 1.0, 0.02, ""),
  spec("grass", "Grass Colour", "weedRosettes", "Weed rosettes", 0.0, 1.0, 0.02, ""),
  spec("grass", "Grass Wind & Interaction", "grassWind", "Wind", 0.0, 1.0, 0.02, "", "uniform"),
  spec("grass", "Grass Wind & Interaction", "distanceFade", "Distance wind fade", 0.0, 1.0, 0.02, "", "uniform"),
  spec("grass", "Grass Wind & Interaction", "trampleRadius", "Actor bend radius", 0.3, 2.0, 0.05, "m", "uniform"),
  spec("grass", "Grass Wind & Interaction", "trampleStrength", "Actor bend strength", 0.0, 1.0, 0.02, "", "uniform"),
] as const

export const FOLIAGE_KINDS: readonly FoliageKind[] = ["tree", "bush", "grass"]
export const FOLIAGE_KIND_LABELS: Readonly<Record<FoliageKind, string>> = { tree: "Tree", bush: "Bush", grass: "Grass" }

export function foliageSpecsFor(kind: FoliageKind): readonly FoliageParamSpec[] {
  return FOLIAGE_PARAM_SPECS.filter(s => s.kind === kind)
}

type KindKeys<K extends FoliageKind> = K extends "tree"
  ? "treeHeight" | "crownRadius" | "branchCount" | "branchAngle" | "clumpCount" | "clumpSize" | "leafCardSize" | "porosity"
    | "treeColorR" | "treeColorG" | "treeColorB" | "treeColorVariation" | "autumnMix" | "translucency" | "canopyAO"
    | "normalSoftness" | "treeWindStrength" | "treeWindFreq" | "treeWindGust"
  : K extends "bush"
    ? "bushHeight" | "bushSpread" | "bushLobes" | "bushTrim" | "bushLeafSize" | "bushDensity" | "bushColorR" | "bushColorG"
      | "bushColorB" | "bushColorVariation" | "bushFlowers" | "bushAO" | "bushTranslucency" | "bushWind"
    : "grassDensity" | "bladeHeight" | "bladeWidth" | "bladeCurvature" | "grassClumping" | "rootColorR" | "rootColorG"
      | "rootColorB" | "tipColorR" | "tipColorG" | "tipColorB" | "grassVariation" | "dryPatches" | "weedRosettes"
      | "grassWind" | "distanceFade" | "trampleRadius" | "trampleStrength"

export type FoliagePresetDef<K extends FoliageKind, Id extends string> = {
  id: Id
  kind: K
  label: string
  summary: string
  values: Readonly<Record<KindKeys<K>, number>> & (K extends "tree" ? { crownShape: FoliageCrownShape } : unknown)
}

export const TREE_PRESETS: Readonly<Record<TreePresetId, FoliagePresetDef<"tree", TreePresetId>>> = {
  oak: {
    id: "oak",
    kind: "tree",
    label: "Oak",
    summary: "Broad street oak: wide dome of overlapping bough mounds, dark interior and lit outer lobes.",
    values: {
      crownShape: "dome", treeHeight: 5.2, crownRadius: 2.35, branchCount: 6, branchAngle: 44, clumpCount: 2, clumpSize: 0.95,
      leafCardSize: 0.28, porosity: 0.35, treeColorR: 0.27, treeColorG: 0.31, treeColorB: 0.19, treeColorVariation: 0.66,
      autumnMix: 0.42, translucency: 0.28, canopyAO: 0.64, normalSoftness: 0.9, treeWindStrength: 0.24, treeWindFreq: 0.8,
      treeWindGust: 0.4,
    },
  },
  maple: {
    id: "maple",
    kind: "tree",
    label: "Maple",
    summary: "Layered bough shelves with a warm amber-ochre autumn mix and strong leaf translucency.",
    values: {
      crownShape: "layered", treeHeight: 4.9, crownRadius: 2.45, branchCount: 7, branchAngle: 52, clumpCount: 3, clumpSize: 0.86,
      leafCardSize: 0.26, porosity: 0.45, treeColorR: 0.46, treeColorG: 0.43, treeColorB: 0.19, treeColorVariation: 0.68,
      autumnMix: 0.66, translucency: 0.58, canopyAO: 0.64, normalSoftness: 0.86, treeWindStrength: 0.34, treeWindFreq: 0.9,
      treeWindGust: 0.5,
    },
  },
  pine: {
    id: "pine",
    kind: "tree",
    label: "Pine",
    summary: "Conical evergreen tiers with downswept boughs, dense dark needles and little translucency.",
    values: {
      crownShape: "conical", treeHeight: 6.2, crownRadius: 2.0, branchCount: 8, branchAngle: 62, clumpCount: 2, clumpSize: 0.82,
      leafCardSize: 0.24, porosity: 0.25, treeColorR: 0.2, treeColorG: 0.34, treeColorB: 0.16, treeColorVariation: 0.4,
      autumnMix: 0.08, translucency: 0.36, canopyAO: 0.76, normalSoftness: 0.82, treeWindStrength: 0.22, treeWindFreq: 0.75,
      treeWindGust: 0.4,
    },
  },
  birch: {
    id: "birch",
    kind: "tree",
    label: "Birch",
    summary: "Slender white-barked columnar crown with high porosity and fluttering small leaf clusters.",
    values: {
      crownShape: "columnar", treeHeight: 5.8, crownRadius: 1.75, branchCount: 6, branchAngle: 32, clumpCount: 2, clumpSize: 0.74,
      leafCardSize: 0.22, porosity: 0.55, treeColorR: 0.36, treeColorG: 0.48, treeColorB: 0.21, treeColorVariation: 0.52,
      autumnMix: 0.36, translucency: 0.64, canopyAO: 0.58, normalSoftness: 0.84, treeWindStrength: 0.42, treeWindFreq: 1.15,
      treeWindGust: 0.55,
    },
  },
}

export const BUSH_PRESETS: Readonly<Record<BushPresetId, FoliagePresetDef<"bush", BushPresetId>>> = {
  hedge: {
    id: "hedge",
    kind: "bush",
    label: "Clipped hedge",
    summary: "Tight boxwood/privet: flat clipped top, straight sides, small dense leaves, no blossoms.",
    values: {
      bushHeight: 1.0, bushSpread: 1.0, bushLobes: 6, bushTrim: 0.86, bushLeafSize: 0.1, bushDensity: 1.5, bushColorR: 0.22,
      bushColorG: 0.32, bushColorB: 0.14, bushColorVariation: 0.24, bushFlowers: 0, bushAO: 0.72, bushTranslucency: 0.3,
      bushWind: 0.12,
    },
  },
  overgrown: {
    id: "overgrown",
    kind: "bush",
    label: "Overgrown shrub",
    summary: "Unpruned foundation shrub: ragged multi-lobe mound, mixed olive tones, loose leaves spilling out.",
    values: {
      bushHeight: 1.0, bushSpread: 1.0, bushLobes: 6, bushTrim: 0.12, bushLeafSize: 0.18, bushDensity: 1.1, bushColorR: 0.27,
      bushColorG: 0.32, bushColorB: 0.18, bushColorVariation: 0.62, bushFlowers: 0.06, bushAO: 0.66, bushTranslucency: 0.5,
      bushWind: 0.3,
    },
  },
  hydrangea: {
    id: "hydrangea",
    kind: "bush",
    label: "Hydrangea",
    summary: "Rounded flowering shrub: broad leaves and creamy blossom heads across the crown.",
    values: {
      bushHeight: 1.0, bushSpread: 1.05, bushLobes: 5, bushTrim: 0.32, bushLeafSize: 0.2, bushDensity: 1.0, bushColorR: 0.29,
      bushColorG: 0.42, bushColorB: 0.18, bushColorVariation: 0.46, bushFlowers: 0.8, bushAO: 0.68, bushTranslucency: 0.5,
      bushWind: 0.24,
    },
  },
}

export const GRASS_PRESETS: Readonly<Record<GrassPresetId, FoliagePresetDef<"grass", GrassPresetId>>> = {
  lawn: {
    id: "lawn",
    kind: "grass",
    label: "Lawn",
    summary: "Kept lawn: short even blades, low clumping, uniform green and few weeds.",
    values: {
      grassDensity: 1.0, bladeHeight: 0.12, bladeWidth: 0.035, bladeCurvature: 0.55, grassClumping: 0.45, rootColorR: 0.15,
      rootColorG: 0.21, rootColorB: 0.1, tipColorR: 0.3, tipColorG: 0.4, tipColorB: 0.18, grassVariation: 0.34,
      dryPatches: 0.12, weedRosettes: 0.04, grassWind: 0.32, distanceFade: 0.55, trampleRadius: 0.9, trampleStrength: 0.7,
    },
  },
  overgrown: {
    id: "overgrown",
    kind: "grass",
    label: "Overgrown lawn",
    summary: "Unmown suburban lawn: taller clumped tufts, mixed olive-ochre tones and dry patches.",
    values: {
      grassDensity: 1.0, bladeHeight: 0.2, bladeWidth: 0.042, bladeCurvature: 0.72, grassClumping: 0.82, rootColorR: 0.16,
      rootColorG: 0.19, rootColorB: 0.12, tipColorR: 0.29, tipColorG: 0.33, tipColorB: 0.2, grassVariation: 0.68,
      dryPatches: 0.36, weedRosettes: 0.22, grassWind: 0.44, distanceFade: 0.55, trampleRadius: 1.1, trampleStrength: 0.85,
    },
  },
  weeds: {
    id: "weeds",
    kind: "grass",
    label: "Weeds / dead grass",
    summary: "Neglected verge: sparse straw-coloured tussocks, broadleaf weed rosettes and bare soil.",
    values: {
      grassDensity: 0.8, bladeHeight: 0.26, bladeWidth: 0.05, bladeCurvature: 0.86, grassClumping: 0.9, rootColorR: 0.2,
      rootColorG: 0.18, rootColorB: 0.1, tipColorR: 0.5, tipColorG: 0.44, tipColorB: 0.23, grassVariation: 0.8,
      dryPatches: 0.86, weedRosettes: 0.72, grassWind: 0.5, distanceFade: 0.5, trampleRadius: 1.0, trampleStrength: 0.8,
    },
  },
}

/** Tree presets, kept under the historical name used by recipes and variation grids. */
export const FOLIAGE_PRESETS = TREE_PRESETS
export const TREE_PRESET_IDS = Object.keys(TREE_PRESETS) as readonly TreePresetId[]
export const BUSH_PRESET_IDS = Object.keys(BUSH_PRESETS) as readonly BushPresetId[]
export const GRASS_PRESET_IDS = Object.keys(GRASS_PRESETS) as readonly GrassPresetId[]
export const FOLIAGE_PRESET_IDS = TREE_PRESET_IDS

export const FOLIAGE_CROWN_SHAPES: readonly { value: FoliageCrownShape; label: string }[] = [
  { value: "dome", label: "Broadleaf dome" },
  { value: "layered", label: "Layered bough tiers" },
  { value: "columnar", label: "Airy columnar" },
  { value: "conical", label: "Conical spire" },
  { value: "spreading", label: "Spreading" },
]

export function isTreePresetId(value: unknown): value is TreePresetId {
  return typeof value === "string" && value in TREE_PRESETS
}
export const isFoliagePresetId = isTreePresetId
export function isBushPresetId(value: unknown): value is BushPresetId {
  return typeof value === "string" && value in BUSH_PRESETS
}
export function isGrassPresetId(value: unknown): value is GrassPresetId {
  return typeof value === "string" && value in GRASS_PRESETS
}
export function isFoliageCrownShape(value: unknown): value is FoliageCrownShape {
  return typeof value === "string" && FOLIAGE_CROWN_SHAPES.some(s => s.value === value)
}

export function foliagePresetIdsFor(kind: FoliageKind): readonly string[] {
  return kind === "tree" ? TREE_PRESET_IDS : kind === "bush" ? BUSH_PRESET_IDS : GRASS_PRESET_IDS
}

export function foliagePresetFor(kind: FoliageKind, id: string): { id: string; label: string; summary: string; values: Readonly<Record<string, number | string>> } | null {
  const table: Readonly<Record<string, { id: string; label: string; summary: string; values: object }>> =
    kind === "tree" ? TREE_PRESETS : kind === "bush" ? BUSH_PRESETS : GRASS_PRESETS
  const def = table[id]
  return def ? (def as { id: string; label: string; summary: string; values: Readonly<Record<string, number | string>> }) : null
}

/** Applies one look's preset (only that kind's parameters change). */
export function applyFoliagePreset(kind: FoliageKind, id: string, target: FoliageParams = foliageSettings): FoliageParams {
  const def = foliagePresetFor(kind, id)
  if (!def) throw new Error(`Unknown ${kind} preset "${id}". Valid: ${foliagePresetIdsFor(kind).join(", ")}.`)
  Object.assign(target, def.values)
  if (kind === "tree") target.treePreset = id as TreePresetId
  else if (kind === "bush") target.bushPreset = id as BushPresetId
  else target.grassPreset = id as GrassPresetId
  return target
}

export function cloneFoliageParams(
  tree: TreePresetId = "oak",
  bush: BushPresetId = "overgrown",
  grass: GrassPresetId = "overgrown",
): FoliageParams {
  return {
    treePreset: tree,
    bushPreset: bush,
    grassPreset: grass,
    ...TREE_PRESETS[tree].values,
    ...BUSH_PRESETS[bush].values,
    ...GRASS_PRESETS[grass].values,
  } as FoliageParams
}

/** Shared production vegetation settings consumed by Outbreak's level build and the Lab Vegetation section. */
export const foliageSettings: FoliageParams = cloneFoliageParams()

/** Resets the tree look to a tree preset (bushes and grass are untouched). */
export function resetFoliageParams(presetId: TreePresetId = "oak", target: FoliageParams = foliageSettings): FoliageParams {
  return applyFoliagePreset("tree", presetId, target)
}

function snapToStep(value: number, s: FoliageParamSpec): number {
  const clamped = Math.max(s.min, Math.min(s.max, value))
  const steps = Math.round((clamped - s.min) / s.step)
  return Number(Math.min(s.max, Math.max(s.min, s.min + steps * s.step)).toPrecision(12))
}

/**
 * Validates a complete parameter set. Version-1 payloads predate bushes, grass presets and actor bending;
 * pass `fillMissing` to take those keys from the production defaults instead of rejecting them.
 */
export function validateFoliageParams(
  input: unknown,
  options: { fillMissing?: boolean } = {},
): { ok: true; value: FoliageParams } | { ok: false; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "Foliage parameters must be an object." }
  }
  const raw = input as Record<string, unknown>
  const defaults = cloneFoliageParams()
  const legacyHydrangea = raw.treePreset === "hydrangea"
  const tree: TreePresetId = isTreePresetId(raw.treePreset) ? raw.treePreset : "oak"
  const bush: BushPresetId = isBushPresetId(raw.bushPreset) ? raw.bushPreset : legacyHydrangea ? "hydrangea" : defaults.bushPreset
  const grass: GrassPresetId = isGrassPresetId(raw.grassPreset) ? raw.grassPreset : defaults.grassPreset
  const shape: FoliageCrownShape = isFoliageCrownShape(raw.crownShape) ? raw.crownShape : TREE_PRESETS[tree].values.crownShape
  const out = { treePreset: tree, bushPreset: bush, grassPreset: grass, crownShape: shape } as FoliageParams
  const fill = cloneFoliageParams(tree, bush, grass)
  for (const s of FOLIAGE_PARAM_SPECS) {
    const v = raw[s.key]
    if (v === undefined && options.fillMissing) {
      out[s.key] = fill[s.key]
      continue
    }
    if (typeof v !== "number" || !Number.isFinite(v)) {
      return { ok: false, error: `Invalid or non-finite foliage parameter "${s.key}".` }
    }
    if (v < s.min - 1e-6 || v > s.max + 1e-6) {
      return { ok: false, error: `Parameter "${s.key}" (${v}) is outside [${s.min}, ${s.max}].` }
    }
    out[s.key] = snapToStep(v, s)
  }
  return { ok: true, value: out }
}

const specMap = new Map<FoliageNumericKey, FoliageParamSpec>(FOLIAGE_PARAM_SPECS.map(s => [s.key, s]))
function snapKey(key: FoliageNumericKey, value: number): number {
  return snapToStep(value, specMap.get(key)!)
}

export type FoliageRandomizeScope = "all" | FoliageKind

/**
 * Deterministic, botanically constrained parameter randomization from an isolated tuning seed.
 * Leaves the structure seed and the other looks unchanged; colours stay chlorophyll- or straw-dominant.
 */
export function randomizeFoliageParams(
  base: Readonly<FoliageParams>,
  tuningSeed: number,
  scope: FoliageRandomizeScope = "all",
): FoliageParams {
  const rng = new Rng((Math.trunc(tuningSeed) || 1) ^ 0x85ebca6b)
  const out: FoliageParams = { ...base }

  if (scope === "all" || scope === "tree") {
    const presetValues = TREE_PRESETS[base.treePreset]?.values ?? TREE_PRESETS.oak.values
    const isSlender = base.crownShape === "columnar" || base.crownShape === "conical"
    out.treeHeight = snapKey("treeHeight", 3.8 + rng.next() * 3.0)
    const aspect = isSlender ? 0.28 + rng.next() * 0.14 : 0.38 + rng.next() * 0.18
    out.crownRadius = snapKey("crownRadius", out.treeHeight * aspect)
    out.branchCount = snapKey("branchCount", 5 + Math.floor(rng.next() * 4))
    out.branchAngle = snapKey("branchAngle", isSlender ? 26 + rng.next() * 28 : 34 + rng.next() * 28)
    out.clumpCount = snapKey("clumpCount", 1 + Math.floor(rng.next() * 3))
    out.clumpSize = snapKey("clumpSize", out.crownRadius * (0.34 + rng.next() * 0.16))
    out.leafCardSize = snapKey("leafCardSize", out.clumpSize * (0.24 + rng.next() * 0.12))
    out.porosity = snapKey("porosity", 0.15 + rng.next() * 0.45)
    const g = Math.max(0.28, Math.min(0.56, presetValues.treeColorG + (rng.next() - 0.5) * 0.16))
    const r = Math.max(0.18, Math.min(g * 1.06, presetValues.treeColorR + (rng.next() - 0.5) * 0.16))
    const b = Math.max(0.12, Math.min(g * 0.62, presetValues.treeColorB + (rng.next() - 0.5) * 0.1))
    out.treeColorR = snapKey("treeColorR", r)
    out.treeColorG = snapKey("treeColorG", g)
    out.treeColorB = snapKey("treeColorB", b)
    out.treeColorVariation = snapKey("treeColorVariation", 0.36 + rng.next() * 0.46)
    out.autumnMix = snapKey("autumnMix", base.treePreset === "pine" ? rng.next() * 0.18 : rng.next() * 0.72)
    out.translucency = snapKey("translucency", 0.32 + rng.next() * 0.46)
    out.canopyAO = snapKey("canopyAO", 0.48 + rng.next() * 0.38)
    out.normalSoftness = snapKey("normalSoftness", 0.68 + rng.next() * 0.28)
    out.treeWindStrength = snapKey("treeWindStrength", 0.16 + rng.next() * 0.42)
    out.treeWindFreq = snapKey("treeWindFreq", 0.55 + rng.next() * 0.95)
    out.treeWindGust = snapKey("treeWindGust", 0.24 + rng.next() * 0.54)
  }

  if (scope === "all" || scope === "bush") {
    out.bushHeight = snapKey("bushHeight", 0.8 + rng.next() * 0.5)
    out.bushSpread = snapKey("bushSpread", 0.8 + rng.next() * 0.5)
    out.bushLobes = snapKey("bushLobes", 4 + Math.floor(rng.next() * 5))
    out.bushTrim = snapKey("bushTrim", rng.next() < 0.3 ? 0.65 + rng.next() * 0.3 : rng.next() * 0.45)
    out.bushLeafSize = snapKey("bushLeafSize", 0.09 + rng.next() * 0.16)
    out.bushDensity = snapKey("bushDensity", 0.8 + rng.next() * 0.8)
    const g = 0.26 + rng.next() * 0.2
    out.bushColorG = snapKey("bushColorG", g)
    out.bushColorR = snapKey("bushColorR", g * (0.66 + rng.next() * 0.3))
    out.bushColorB = snapKey("bushColorB", g * (0.4 + rng.next() * 0.18))
    out.bushColorVariation = snapKey("bushColorVariation", 0.2 + rng.next() * 0.55)
    out.bushFlowers = snapKey("bushFlowers", rng.next() < 0.35 ? 0.3 + rng.next() * 0.6 : rng.next() * 0.12)
    out.bushAO = snapKey("bushAO", 0.5 + rng.next() * 0.35)
    out.bushTranslucency = snapKey("bushTranslucency", 0.25 + rng.next() * 0.5)
    out.bushWind = snapKey("bushWind", 0.08 + rng.next() * 0.4)
  }

  if (scope === "all" || scope === "grass") {
    out.grassDensity = snapKey("grassDensity", 0.75 + rng.next() * 0.95)
    out.bladeHeight = snapKey("bladeHeight", 0.1 + rng.next() * 0.26)
    out.bladeWidth = snapKey("bladeWidth", 0.03 + rng.next() * 0.03)
    out.bladeCurvature = snapKey("bladeCurvature", 0.4 + rng.next() * 0.5)
    out.grassClumping = snapKey("grassClumping", 0.4 + rng.next() * 0.55)
    const dry = rng.next()
    const rootG = 0.14 + rng.next() * 0.09
    out.rootColorG = snapKey("rootColorG", rootG)
    out.rootColorR = snapKey("rootColorR", rootG * (0.62 + dry * 0.5))
    out.rootColorB = snapKey("rootColorB", rootG * (0.4 + rng.next() * 0.14))
    const tipG = Math.min(0.6, rootG * (1.8 + rng.next() * 0.6))
    out.tipColorG = snapKey("tipColorG", tipG)
    out.tipColorR = snapKey("tipColorR", Math.min(0.66, tipG * (0.72 + dry * 0.42)))
    out.tipColorB = snapKey("tipColorB", Math.min(0.4, tipG * (0.4 + rng.next() * 0.14)))
    out.grassVariation = snapKey("grassVariation", 0.3 + rng.next() * 0.5)
    out.dryPatches = snapKey("dryPatches", dry * 0.85)
    out.weedRosettes = snapKey("weedRosettes", rng.next() * 0.6)
    out.grassWind = snapKey("grassWind", 0.24 + rng.next() * 0.48)
    out.distanceFade = snapKey("distanceFade", 0.36 + rng.next() * 0.44)
    out.trampleRadius = snapKey("trampleRadius", 0.7 + rng.next() * 0.6)
    out.trampleStrength = snapKey("trampleStrength", 0.55 + rng.next() * 0.4)
  }

  return out
}

export type FoliageLabTool = FoliageKind | "lot"
export type FoliageLighting = "night" | "dusk" | "day"

/** Version 2: separate tree, bush and grass presets plus Lab view state. Version 1 imports are migrated. */
export type FoliagePresetV2 = {
  version: 2
  seed: number
  tuningSeed: number
  tool: FoliageLabTool
  lighting: FoliageLighting
  look: string
  cameraMode: FoliageCameraMode
  params: FoliageParams
}

const LAB_TOOLS: readonly FoliageLabTool[] = ["tree", "bush", "grass", "lot"]
const LIGHTINGS: readonly FoliageLighting[] = ["night", "dusk", "day"]

export function exportFoliagePreset(input: Omit<FoliagePresetV2, "version">): FoliagePresetV2 {
  const checked = validateFoliageParams(input.params)
  if (!checked.ok) throw new Error(checked.error)
  return {
    version: 2,
    seed: Math.max(1, Math.min(999, Math.trunc(input.seed) || 7)),
    tuningSeed: Math.max(1, Math.min(9999, Math.trunc(input.tuningSeed) || 41)),
    tool: LAB_TOOLS.includes(input.tool) ? input.tool : "tree",
    lighting: LIGHTINGS.includes(input.lighting) ? input.lighting : "night",
    look: typeof input.look === "string" && input.look ? input.look : "current",
    cameraMode: input.cameraMode === "close" ? "close" : "game",
    params: checked.value,
  }
}

export function importFoliagePreset(
  rawJson: string,
): { ok: true; value: FoliagePresetV2 } | { ok: false; error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawJson)
  } catch {
    return { ok: false, error: "Invalid JSON syntax." }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "Foliage preset must be a JSON object." }
  }
  const obj = parsed as Record<string, unknown>
  if (obj.version !== 1 && obj.version !== 2) {
    return { ok: false, error: `Unsupported foliage preset version: ${String(obj.version)} (expected 1 or 2).` }
  }
  if (typeof obj.seed !== "number" || !Number.isFinite(obj.seed) || obj.seed < 1 || obj.seed > 999) {
    return { ok: false, error: "Invalid seed (expected 1..999)." }
  }
  if (typeof obj.tuningSeed !== "number" || !Number.isFinite(obj.tuningSeed) || obj.tuningSeed < 1 || obj.tuningSeed > 9999) {
    return { ok: false, error: "Invalid tuningSeed (expected 1..9999)." }
  }
  if (obj.cameraMode !== "close" && obj.cameraMode !== "game") {
    return { ok: false, error: `Invalid cameraMode: "${String(obj.cameraMode)}".` }
  }
  const v1 = obj.version === 1
  if (!v1 && !LAB_TOOLS.includes(obj.tool as FoliageLabTool)) return { ok: false, error: `Invalid tool: "${String(obj.tool)}".` }
  if (!v1 && !LIGHTINGS.includes(obj.lighting as FoliageLighting)) return { ok: false, error: `Invalid lighting: "${String(obj.lighting)}".` }
  if (!v1 && typeof obj.look !== "string") return { ok: false, error: "Invalid look (expected a look preset id)." }
  const paramsRes = validateFoliageParams(obj.params, { fillMissing: v1 })
  if (!paramsRes.ok) return paramsRes
  return {
    ok: true,
    value: {
      version: 2,
      seed: Math.trunc(obj.seed),
      tuningSeed: Math.trunc(obj.tuningSeed),
      tool: v1 ? (obj.stageMode === "lot" ? "lot" : "tree") : (obj.tool as FoliageLabTool),
      lighting: v1 ? (obj.lightingPreset === "outbreak_day" ? "day" : obj.lightingPreset === "outbreak_dusk" ? "dusk" : "night") : (obj.lighting as FoliageLighting),
      look: v1 ? "current" : (obj.look as string),
      cameraMode: obj.cameraMode,
      params: paramsRes.value,
    },
  }
}

// --- Deterministic CPU helpers & Production Geometry Builders ---

type Point = [number, number, number]

function fract(x: number): number {
  return x - Math.floor(x)
}

function hash2(x: number, y: number): number {
  let qx = fract(x * 0.1031)
  let qy = fract(y * 0.1030)
  const d = qx * (qy + 33.33) + qy * (qx + 33.33)
  qx += d
  qy += d
  return fract((qx + qy) * qx)
}

export function noise2(x: number, y: number): number {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const fx = x - ix
  const fy = y - iy
  const ux = fx * fx * (3 - 2 * fx)
  const uy = fy * fy * (3 - 2 * fy)
  const a = hash2(ix, iy)
  const b = hash2(ix + 1, iy)
  const c = hash2(ix, iy + 1)
  const d = hash2(ix + 1, iy + 1)
  return a + (b - a) * ux + (c - a + (a - b - c + d) * ux) * uy
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x))
}

function normalize3(x: number, y: number, z: number): Point {
  const len = Math.hypot(x, y, z) || 1
  return [x / len, y / len, z / len]
}

function cross3(a: Point, b: Point): Point {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ]
}

function faceNormal(a: Point, b: Point, c: Point): Point {
  const u: Point = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
  const w: Point = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
  const n = cross3(u, w)
  return normalize3(n[0], n[1], n[2])
}

function blendNormal(a: Point, b: Point, t: number): Point {
  return normalize3(
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  )
}

function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [
    clamp01(a[0] + (b[0] - a[0]) * t),
    clamp01(a[1] + (b[1] - a[1]) * t),
    clamp01(a[2] + (b[2] - a[2]) * t),
  ]
}

function scaleRgb(c: Rgb, k: number): Rgb {
  return [clamp01(c[0] * k), clamp01(c[1] * k), clamp01(c[2] * k)]
}

/**
 * Multi-step curved & tapered timber branch/trunk with smooth radial vertex normals
 * and optional root-collar buttress flare (`collarFlare > 0`).
 */
function emitTaperedLimb(
  m: Mesh,
  p0: Point,
  p1: Point,
  p2: Point,
  r0: number,
  r1: number,
  bark: Rgb,
  steps = 3,
  sides = 6,
  collarFlare = 0,
  flex0 = -1,
  flex1 = -1,
): void {
  const rings: { pt: Point; n: Point }[][] = []
  // Swaying limbs carry aux = FOLIAGE_LIMB_AUX + flex (0 at the root, 1 where a leaf clump hangs); -1 keeps aux 0 (static).
  const limbAux = (t: number) => (flex0 < 0 ? 0 : FOLIAGE_LIMB_AUX + flex0 + (flex1 - flex0) * t)
  const baseCol = scaleRgb(bark, 0.78)
  const upperCol = scaleRgb(bark, 1.04)

  for (let s = 0; s <= steps; s++) {
    const t = s / steps
    const u = 1 - t
    const cx = u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0]
    const cy = u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]
    const cz = u * u * p0[2] + 2 * u * t * p1[2] + t * t * p2[2]

    const tx = 2 * u * (p1[0] - p0[0]) + 2 * t * (p2[0] - p1[0])
    const ty = 2 * u * (p1[1] - p0[1]) + 2 * t * (p2[1] - p1[1])
    const tz = 2 * u * (p1[2] - p0[2]) + 2 * t * (p2[2] - p1[2])
    const axis = normalize3(tx, ty, tz)
    const horiz = Math.hypot(axis[0], axis[2])
    const uVec: Point = horiz < 0.001 ? [1, 0, 0] : [-axis[2] / horiz, 0, axis[0] / horiz]
    const vVec = cross3(axis, uVec)

    const rBase = r0 + (r1 - r0) * Math.pow(t, 0.82)
    const flare = 1 + collarFlare * Math.exp(-t * 6.0)
    const ring: { pt: Point; n: Point }[] = []

    for (let i = 0; i < sides; i++) {
      const ang = (i / sides) * Math.PI * 2
      const ca = Math.cos(ang)
      const sa = Math.sin(ang)
      // Fluted root buttresses at the base of the trunk
      const buttress = collarFlare > 0 ? 1 + collarFlare * 0.42 * Math.exp(-t * 7.5) * Math.cos(ang * 5) : 1
      const r = rBase * flare * buttress
      const nx = uVec[0] * ca + vVec[0] * sa
      const ny = uVec[1] * ca + vVec[1] * sa + 0.12
      const nz = uVec[2] * ca + vVec[2] * sa
      ring.push({
        pt: [cx + nx * r, cy + (uVec[1] * ca + vVec[1] * sa) * r, cz + nz * r],
        n: normalize3(nx, ny, nz),
      })
    }
    rings.push(ring)
  }

  for (let s = 0; s < steps; s++) {
    const rA = rings[s]!
    const rB = rings[s + 1]!
    const colA = mixRgb(baseCol, upperCol, s / steps)
    const colB = mixRgb(baseCol, upperCol, (s + 1) / steps)
    for (let i = 0; i < sides; i++) {
      const next = (i + 1) % sides
      const a0 = rA[i]!
      const a1 = rA[next]!
      const b1 = rB[next]!
      const b0 = rB[i]!
      const auxA = limbAux(s / steps)
      const auxB = limbAux((s + 1) / steps)
      m.vert(a0.pt, a0.n, colA, MAT.timber, auxA)
      m.vert(b0.pt, b0.n, colB, MAT.timber, auxB)
      m.vert(b1.pt, b1.n, colB, MAT.timber, auxB)

      m.vert(a0.pt, a0.n, colA, MAT.timber, auxA)
      m.vert(b1.pt, b1.n, colB, MAT.timber, auxB)
      m.vert(a1.pt, a1.n, colA, MAT.timber, auxA)
    }
  }
}

/**
 * Emits a small, curved 3-leaf botanical trefoil sprig (3 individual pointed ovate/lanceolate leaves
 * radiating from a stem node, each folded along its midrib) with normals blended `normalSoftness`
 * toward the ellipsoidal sub-cloud + crown dome normal (`Lamplight §3.3`).
 * Replaces large flat polygonal cards so canopies read as hundreds of small individual leaves.
 */
function emitLeafSprig(
  m: Mesh,
  root: Point,
  outDir: Point,
  sprigSize: number,
  domePivot: Point,
  crownCenter: Point,
  normalSoftness: number,
  rng: Rng,
  baseCol: Rgb,
  tipCol: Rgb,
  flexWeight: number,
  leafletCount = 3,
  auxOffset = 0,
): void {
  const yawBase = Math.atan2(outDir[2], outDir[0])
  const domeNormalAt = (pt: Point): Point => {
    const nCloud = normalize3(
      pt[0] - domePivot[0],
      (pt[1] - domePivot[1]) * 1.35 + 0.14,
      pt[2] - domePivot[2],
    )
    const nCrown = normalize3(
      pt[0] - crownCenter[0],
      (pt[1] - crownCenter[1]) * 1.15 + 0.22,
      pt[2] - crownCenter[2],
    )
    return blendNormal(nCloud, nCrown, 0.35)
  }

  for (let l = 0; l < leafletCount; l++) {
    // Splay 3 leaflets in a natural botanical trefoil fan (-0.68, 0, +0.68 rad)
    const fanOffset = leafletCount === 1 ? 0 : (l - (leafletCount - 1) * 0.5) * 0.68
    const yaw = yawBase + fanOffset + (rng.next() - 0.5) * 0.28
    const pitch = outDir[1] * 0.55 + (l === 1 ? 0.18 : -0.12) + (rng.next() - 0.5) * 0.22
    const len = sprigSize * (l === 1 ? 1.15 : 0.92 + rng.next() * 0.20)
    const wid = len * (0.52 + rng.next() * 0.12)

    const dir = normalize3(Math.cos(yaw), pitch, Math.sin(yaw))
    const side = normalize3(-Math.sin(yaw), (rng.next() - 0.5) * 0.28, Math.cos(yaw))
    const geomUp = cross3(side, dir)

    // Cupped V-folded diamond leaflet: petiole base -> wide left/right flanks -> pointed curved apex
    const droop = len * 0.18
    const fold = wid * 0.22
    const pBase: Point = root
    const pMidL: Point = [
      root[0] + dir[0] * len * 0.48 - side[0] * wid + geomUp[0] * fold,
      root[1] + dir[1] * len * 0.48 - side[1] * wid + geomUp[1] * fold,
      root[2] + dir[2] * len * 0.48 - side[2] * wid + geomUp[2] * fold,
    ]
    const pMidR: Point = [
      root[0] + dir[0] * len * 0.48 + side[0] * wid + geomUp[0] * fold,
      root[1] + dir[1] * len * 0.48 + side[1] * wid + geomUp[1] * fold,
      root[2] + dir[2] * len * 0.48 + side[2] * wid + geomUp[2] * fold,
    ]
    const pTip: Point = [
      root[0] + dir[0] * len,
      root[1] + dir[1] * len - droop,
      root[2] + dir[2] * len,
    ]

    const fnLRaw = faceNormal(pBase, pMidL, pTip)
    const fnRRaw = faceNormal(pBase, pTip, pMidR)
    const fnL: Point = fnLRaw[1] < 0 ? [-fnLRaw[0], -fnLRaw[1], -fnLRaw[2]] : fnLRaw
    const fnR: Point = fnRRaw[1] < 0 ? [-fnRRaw[0], -fnRRaw[1], -fnRRaw[2]] : fnRRaw
    const nBase = blendNormal(fnL, domeNormalAt(pBase), normalSoftness)
    const nMidL = blendNormal(fnL, domeNormalAt(pMidL), normalSoftness)
    const nMidR = blendNormal(fnR, domeNormalAt(pMidR), normalSoftness)
    const nTip = blendNormal(fnR, domeNormalAt(pTip), normalSoftness)

    const midCol = mixRgb(baseCol, tipCol, 0.58)
    const tipFlex = Math.min(1.45, flexWeight * 1.12)

    const tipAux = auxOffset + Math.min(1, tipFlex)
    m.vert(pBase, nBase, baseCol, MAT.foliage, auxOffset + flexWeight * 0.78)
    m.vert(pMidL, nMidL, midCol, MAT.foliage, auxOffset + flexWeight * 0.95)
    m.vert(pTip, nTip, tipCol, MAT.foliage, tipAux)

    m.vert(pBase, nBase, baseCol, MAT.foliage, auxOffset + flexWeight * 0.78)
    m.vert(pTip, nTip, tipCol, MAT.foliage, tipAux)
    m.vert(pMidR, nMidR, midCol, MAT.foliage, auxOffset + flexWeight * 0.95)
  }
}

/**
 * Emits a cupped 6-triangle brushy leaf-cluster card whose center vertex has `aux = 1.0`
 * and perimeter vertices have `aux = 0.01`. Under 4x MSAA alpha-to-coverage, the straight
 * outer polygon edges are 100% transparent (`alpha = 0`) while the interior is carved by the
 * procedural/texture leaf-cluster atlas into soft, clumpy, brushy leaf masses.
 */
/**
 * Emits a 3D ruffled, scalloped 5-triangle botanical leaf-cluster bouquet whose central apex has
 * `aux = 0.96` and whose outer perimeter vertices all have `aux = 0.02`.
 * Because every outer boundary edge connects two `aux = 0.02` vertices, the fragment shader's
 * high-frequency `leaf_atlas` + multi-octave micro-leaf noise carves away all straight polygon
 * edges into soft, ragged 4-7cm micro-leaf silhouettes over deep interior shadow.
 */
function emitBrushyLeafCard(
  m: Mesh,
  px: number,
  py: number,
  pz: number,
  outDir: Point,
  cardRadius: number,
  domePivot: Point,
  crownCenter: Point,
  normalSoftness: number,
  rng: Rng,
  deepCol: Rgb,
  midCol: Rgb,
  sunlitCol: Rgb,
  boughRadius: number,
  tips = 5,
  auxOffset = 0,
): void {
  const upBias = normalize3(outDir[0] * 0.78, Math.max(0.22, outDir[1] * 0.76 + 0.28), outDir[2] * 0.78)
  const yaw = rng.next() * Math.PI * 2
  const ref: Point = Math.abs(upBias[1]) > 0.92 ? [Math.cos(yaw), 0, Math.sin(yaw)] : [0, 1, 0]
  const t1Raw = cross3(ref, upBias)
  const t1 = normalize3(t1Raw[0], t1Raw[1], t1Raw[2])
  const t2 = cross3(upBias, t1)

  const rot = rng.next() * Math.PI * 2
  const cr = Math.cos(rot)
  const sr = Math.sin(rot)
  const uAxis: Point = [t1[0] * cr + t2[0] * sr, t1[1] * cr + t2[1] * sr, t1[2] * cr + t2[2] * sr]
  const vAxis: Point = [-t1[0] * sr + t2[0] * cr, -t1[1] * sr + t2[1] * cr, -t1[2] * sr + t2[2] * cr]

  const cup = cardRadius * 0.34
  const center: Point = [px + upBias[0] * cup, py + upBias[1] * cup, pz + upBias[2] * cup]

  // Scalloped rosette: alternating leaf tips (flared out, lifted) and clefts (tucked in, dropped) around a raised
  // centre, so even the opaque no-discard pipeline shows a serrated multi-leaf outline instead of a flat polygon plate.
  const ringCount = tips * 2
  const ring: Point[] = []
  const isTip: boolean[] = []
  const phase = rng.next() * Math.PI * 2
  for (let i = 0; i < ringCount; i++) {
    const tip = i % 2 === 0
    const a = phase + (i / ringCount) * Math.PI * 2 + (rng.next() - 0.5) * (tip ? 0.3 : 0.16)
    const reach = tip ? 1.0 + (rng.next() - 0.3) * 0.26 : 0.5 + rng.next() * 0.12
    const r = cardRadius * reach
    const droop = cardRadius * (tip ? 0.12 : 0.26)
    const ca = Math.cos(a) * r
    const sa = Math.sin(a) * r
    ring.push([
      px + uAxis[0] * ca + vAxis[0] * sa - upBias[0] * droop,
      py + uAxis[1] * ca + vAxis[1] * sa - upBias[1] * droop - droop * 0.25,
      pz + uAxis[2] * ca + vAxis[2] * sa - upBias[2] * droop,
    ])
    isTip.push(tip)
  }

  const soft = Math.min(0.98, Math.max(0.92, normalSoftness * 0.95 + 0.04))
  const domeNormalAt = (pt: Point): Point => {
    const nCloud = normalize3(
      pt[0] - domePivot[0],
      (pt[1] - domePivot[1]) * 1.25 + 0.22,
      pt[2] - domePivot[2],
    )
    const nCrown = normalize3(
      pt[0] - crownCenter[0],
      (pt[1] - crownCenter[1]) * 1.10 + 0.28,
      pt[2] - crownCenter[2],
    )
    return blendNormal(nCloud, nCrown, 0.45)
  }

  // Smooth 3D position-based color field so overlapping/adjacent triangles share continuous colors with zero polygon seams
  const colorAt = (pt: Point): Rgb => {
    const dx = pt[0] - domePivot[0]
    const dy = pt[1] - domePivot[1]
    const dz = pt[2] - domePivot[2]
    const dist = Math.hypot(dx, dy, dz) / Math.max(0.25, boughRadius * 1.25)
    const shell = clamp01(dist * 0.62 + clamp01((dy + boughRadius * 0.35) / Math.max(0.25, boughRadius * 1.35)) * 0.38)
    const nWave = noise2(pt[0] * 1.8 + pt[1] * 0.7, pt[2] * 1.8 - pt[1] * 0.5)
    const t = clamp01(shell * 0.82 + (nWave - 0.5) * 0.28)
    return t < 0.52 ? mixRgb(deepCol, midCol, t / 0.52) : mixRgb(midCol, sunlitCol, (t - 0.52) / 0.48)
  }

  const cCol = colorAt(center)
  const ringCols = ring.map((pt, i) => scaleRgb(colorAt(pt), isTip[i] ? 1.1 : 0.8))
  const auxCenter = auxOffset + 0.55
  const auxTip = auxOffset + 1.0
  const auxCleft = auxOffset + 0.4

  for (let i = 0; i < ringCount; i++) {
    const j = (i + 1) % ringCount
    const p0 = ring[i]!
    const p1 = ring[j]!
    const fnRaw = faceNormal(center, p0, p1)
    const fn: Point = fnRaw[1] < 0 ? [-fnRaw[0], -fnRaw[1], -fnRaw[2]] : fnRaw
    const nC = blendNormal(fn, domeNormalAt(center), soft)
    const n0 = blendNormal(fn, domeNormalAt(p0), soft)
    const n1 = blendNormal(fn, domeNormalAt(p1), soft)
    m.vert(center, nC, cCol, MAT.foliage, auxCenter)
    m.vert(p0, n0, ringCols[i]!, MAT.foliage, isTip[i] ? auxTip : auxCleft)
    m.vert(p1, n1, ringCols[j]!, MAT.foliage, isTip[j] ? auxTip : auxCleft)
  }
}

/** Lively mound shading: the crown centre the clump is lit away from, and the sunlit leaf colour. */
type MoundStyle = { crown: Point; lit: Rgb }

/**
 * Closed lumpy leaf mound: an apex fan plus rings of jittered ellipsoid points with soft ellipsoid normals.
 * It gives each bough or bush lobe an opaque mass (no see-through gaps from above) for ~72 vertices; the
 * scalloped rosettes placed on its surface provide the leafy silhouette and lit tips.
 */
function emitLeafMound(
  m: Mesh,
  cx: number,
  cy: number,
  cz: number,
  rx: number,
  ry: number,
  deepCol: Rgb,
  midCol: Rgb,
  rng: Rng,
  auxOffset: number,
  flex: number,
  segs = 6,
  style?: MoundStyle,
): void {
  // Lively crowns: a fourth ring below the equator rounds the silhouette (no hexagon outline from above).
  const polar = style ? [0.0, 0.62, 1.25, 1.95] : [0.0, 0.78, 1.72]
  const rings: { p: Point; n: Point; t: number }[][] = []
  const phase = rng.next() * Math.PI * 2
  for (let k = 0; k < polar.length; k++) {
    const th = polar[k]!
    const ring: { p: Point; n: Point; t: number }[] = []
    const count = k === 0 ? 1 : segs
    for (let i = 0; i < count; i++) {
      const a = phase + ((i + (k % 2) * 0.5) / segs) * Math.PI * 2
      const lump = k === 0 ? 1 : 0.86 + rng.next() * 0.26
      const sx = Math.sin(th) * Math.cos(a), sz = Math.sin(th) * Math.sin(a), sy = Math.cos(th)
      const p: Point = [cx + sx * rx * lump, cy + sy * ry * (k === 0 ? 0.94 + rng.next() * 0.1 : lump), cz + sz * rx * lump]
      const n = normalize3(sx / rx, sy / ry + 0.35 / ry, sz / rx)
      ring.push({ p, n, t: clamp01((p[1] - (cy - ry)) / (2 * ry)) })
    }
    rings.push(ring)
  }
  const col = (t: number, p: Point, n: Point): Rgb => {
    const w = noise2(p[0] * 2.1 + p[1], p[2] * 2.1 - p[1])
    const base = mixRgb(deepCol, midCol, clamp01(t * 1.25 + (w - 0.5) * 0.3))
    if (!style) return base
    // Clump depth from above: faces turned out of the crown and up catch the light, faces turned in toward the trunk
    // (the crevices between clumps) fall into the crown's shade.
    const o = normalize3(p[0] - style.crown[0], (p[1] - style.crown[1]) * 0.8 + 0.25, p[2] - style.crown[2])
    const e = n[0] * o[0] + n[1] * o[1] + n[2] * o[2]
    const lit = clamp01((e - 0.15) / 0.75) * (0.35 + 0.65 * t)
    const inward = clamp01(-e * 1.4)
    return scaleRgb(mixRgb(base, style.lit, lit * 0.7), 1 - 0.4 * inward)
  }
  const vert = (v: { p: Point; n: Point; t: number }) =>
    m.vert(v.p, v.n, col(v.t, v.p, v.n), MAT.foliage, auxOffset + clamp01(flex * (0.35 + 0.65 * v.t)))
  const apex = rings[0]![0]!
  for (let i = 0; i < segs; i++) {
    const a = rings[1]![i]!, b = rings[1]![(i + 1) % segs]!
    vert(apex), vert(a), vert(b)
  }
  for (let k = 1; k < rings.length - 1; k++) {
    for (let i = 0; i < segs; i++) {
      const a0 = rings[k]![i]!, a1 = rings[k]![(i + 1) % segs]!
      const b0 = rings[k + 1]![i]!, b1 = rings[k + 1]![(i + 1) % segs]!
      vert(a0), vert(b0), vert(b1)
      vert(a0), vert(b1), vert(a1)
    }
  }
}

/**
 * 3-Shell Brushy Volumetric Bough Bouquet:
 * Combines overlapping cupped brushy leaf-cluster cards (`emitBrushyLeafCard`, whose polygon edges
 * are dissolved by 4x MSAA alpha-to-coverage into clumpy multi-leaf lobes) with fine peripheral
 * 3-leaf sprigs (`emitLeafSprig`) and 90% spherized dome normals.
 */
function emitBoughCluster(
  m: Mesh,
  cx: number,
  cy: number,
  cz: number,
  rx: number,
  ry: number,
  crownCenter: Point,
  rng: Rng,
  base: Rgb,
  sprigDensity: number,
  leafCardScale: number,
  canopyAO: number,
  normalSoftness: number,
  flexBase: number,
  tips = 5,
  auxOffset = 0,
  sprigs = 0,
  mound = false,
  moundSegs = 6,
  lively = false,
): void {
  const domePivot: Point = [cx, cy - ry * 0.28, cz]
  // Note: vertex colors are sRGB (raised to ^2.2 in vs), so 0.58 sRGB = 0.30 linear (deep uncrushed 70s olive-walnut shadow)
  const coreDark = Math.max(0.56, 0.80 - canopyAO * 0.28)
  const midShade = Math.max(0.76, 0.94 - canopyAO * 0.20)
  const deepCol = scaleRgb(base, coreDark)
  const midCol = scaleRgb(base, midShade)
  const sunlitCol = scaleRgb(base, 1.24)

  if (mound) emitLeafMound(m, cx, cy, cz, rx * 0.9, ry * 0.92, deepCol, midCol, rng, auxOffset, flexBase, moundSegs, lively ? { crown: crownCenter, lit: sunlitCol } : undefined)
  const totalCards = Math.max(mound ? 2 : 3, Math.round(sprigDensity))
  for (let s = 0; s < totalCards; s++) {
    // With a mound for mass, rosettes go only on the mid/outer shells where they break the silhouette.
    const tierFrac = mound ? 0.34 + (s / totalCards) * 0.66 : s / totalCards
    const isCore = tierFrac < 0.34
    const isMid = tierFrac >= 0.34 && tierFrac < 0.74

    const a = s * 2.39996 + (rng.next() - 0.5) * 0.28
    const rNorm = mound ? 0.35 + 0.65 * Math.sqrt((s + 0.5) / totalCards) : Math.sqrt((s + 0.25) / totalCards)
    const rShell = isCore
      ? 0.06 + 0.36 * rNorm
      : isMid
        ? 0.34 + 0.38 * rNorm
        : 0.60 + 0.38 * rNorm

    // Clumpy 3-to-4-lobe sub-puff grouping within each bough
    const subLobe = 0.84 + 0.26 * Math.sin(a * 3 + cx * 1.9 + cy * 1.3)
    const radX = rx * rShell * subLobe
    const domeArch = Math.sqrt(Math.max(0.05, 1 - Math.min(1, rShell * 0.84) ** 2))
    const oy = isCore
      ? (rng.next() - 0.42) * ry * 0.45
      : (domeArch * 0.70 - (1 - domeArch) * 0.28 + (rng.next() - 0.5) * 0.20) * ry

    const px = cx + Math.cos(a) * radX
    const py = cy + oy
    const pz = cz + Math.sin(a) * radX
    const outDir = normalize3(px - cx, (py - domePivot[1]) * 1.18 + (isCore ? 0.28 : 0.08), pz - cz)

    const cardRadius = Math.max(
      0.11,
      leafCardScale * (isCore ? 1.54 : isMid ? 1.32 : 1.12) * (0.88 + rng.next() * 0.24),
    )

    emitBrushyLeafCard(
      m,
      px,
      py,
      pz,
      outDir,
      cardRadius,
      domePivot,
      crownCenter,
      normalSoftness,
      rng,
      deepCol,
      midCol,
      sunlitCol,
      rx,
      tips,
      auxOffset,
    )
  }
  // Pointed leaf sprigs splaying past the outer shell break the cluster silhouette and catch grazing rim light.
  for (let s = 0; s < sprigs; s++) {
    const a = rng.next() * Math.PI * 2
    const up = 0.15 + rng.next() * 0.55
    const dir = normalize3(Math.cos(a), up, Math.sin(a))
    const root: Point = [cx + dir[0] * rx * 0.86, cy + dir[1] * ry * 0.7, cz + dir[2] * rx * 0.86]
    emitLeafSprig(
      m,
      root,
      dir,
      leafCardScale * (0.62 + rng.next() * 0.22),
      domePivot,
      crownCenter,
      normalSoftness,
      rng,
      midCol,
      scaleRgb(sunlitCol, 1.06),
      Math.min(1, flexBase + 0.2),
      3,
      auxOffset,
    )
  }
}

/** Timber limb vertices with aux at or above this sway with their canopy (aux − `FOLIAGE_LIMB_AUX` = flex, 0..1). */
export const FOLIAGE_LIMB_AUX = 8

/**
 * Build-time vegetation options beside the look parameters. `lively` gives each tree a species by seed, leaves some
 * bare, encodes limb flex so branches sway with their clumps and adds stray shoots to shrubs; off reproduces today's
 * meshes vertex for vertex. `quality` (0 low, 1 medium, 2 high) scales clump and sprig counts on lively trees.
 */
export type FoliageBuildOptions = {
  lively: boolean
  quality: number
  /** Fraction of trees left bare (dead or leafless), 0..0.5. */
  deadTrees: number
  /** 0: every tree follows the tree look; 1: trees pick oak, maple, birch or pine by seed. */
  variety: number
}
export const FOLIAGE_BUILD_TODAY: Readonly<FoliageBuildOptions> = { lively: false, quality: 1, deadTrees: 0, variety: 0 }
export const FOLIAGE_BUILD_LIVELY: Readonly<FoliageBuildOptions> = { lively: true, quality: 1, deadTrees: 0.14, variety: 0.7 }

/** The species a lively tree takes from its seed (null keeps the tree look), and whether it stands bare. */
export function foliageTreeSpecies(seed: number, opts: Readonly<FoliageBuildOptions>): { species: TreePresetId | null; dead: boolean } {
  if (!opts.lively) return { species: null, dead: false }
  const pick = new Rng((seed ^ 0x5eed7) >>> 0)
  const roll = pick.next()
  const dead = pick.next() < opts.deadTrees
  if (roll >= opts.variety) return { species: null, dead }
  const r = roll / Math.max(1e-6, opts.variety)
  return { species: r < 0.4 ? "oak" : r < 0.64 ? "maple" : r < 0.8 ? "birch" : "pine", dead }
}

/**
 * Production tree & shrub generator used by both Outbreak (`architecture.ts`) and the Lab Foliage workbench.
 */
export function buildFoliageTree(
  m: Mesh,
  x: number,
  z: number,
  h: number,
  radius: number,
  seed: number,
  ground: number,
  lookParams: Readonly<FoliageParams> = foliageSettings,
  shapeOverride?: FoliageCrownShape,
  opts: Readonly<FoliageBuildOptions> = FOLIAGE_BUILD_TODAY,
): void {
  const isTree = h > 2.1
  if (!isTree && shapeOverride === undefined) {
    buildFoliageBush(m, x, z, h, radius, seed, ground, lookParams, opts)
    return
  }
  const lively = opts.lively && isTree
  const { species, dead } = shapeOverride === undefined && isTree ? foliageTreeSpecies(seed, opts) : { species: null, dead: false }
  let params: Readonly<FoliageParams> = lookParams
  if (species && species !== lookParams.treePreset) params = { ...lookParams, ...TREE_PRESETS[species].values, treePreset: species }
  if (lively) params = { ...params, porosity: Math.min(0.85, params.porosity + 0.12) }
  const quality = Math.round(Math.min(2, Math.max(0, opts.quality)))
  const rng = new Rng(seed)
  const naturalHabit: FoliageCrownShape = (["dome", "layered", "spreading", "dome"] as const)[Math.abs(seed) & 3]!
  const shape: FoliageCrownShape =
    shapeOverride ?? (isTree ? (params.crownShape === "dome" ? naturalHabit : params.crownShape) : "spreading")

  const heightRatio = h / Math.max(1.2, params.treeHeight)
  const radiusRatio = radius / Math.max(0.7, params.crownRadius)
  const boughs = isTree ? Math.max(3, Math.round(params.branchCount)) : 5
  const gapAngle = rng.next() * Math.PI * 2
  const gapHalfWidth = 0.16 + params.porosity * (isTree ? 0.72 : 0.32)
  const leanX = (rng.next() - 0.5) * (isTree ? 0.26 : 0.14)
  const leanZ = (rng.next() - 0.5) * (isTree ? 0.26 : 0.14)

  const barkColor: Rgb = dead
    ? [0.37, 0.34, 0.30]
    : params.treePreset === "birch" || shape === "columnar"
      ? [0.64, 0.61, 0.56]
      : params.treePreset === "pine" || shape === "conical"
        ? [0.28, 0.21, 0.16]
        : [0.30, 0.26, 0.20]

  if (isTree) {
    const trunkTopFrac = shape === "conical" ? 0.88 : shape === "columnar" ? 0.80 : 0.68
    const trunkR0 = (shape === "columnar" ? 0.13 : 0.175) * Math.max(0.7, Math.min(1.3, heightRatio))
    const midBowX = leanX * 0.45 + (rng.next() - 0.5) * 0.14
    const midBowZ = leanZ * 0.45 + (rng.next() - 0.5) * 0.14
    emitTaperedLimb(
      m,
      [x, ground - 0.02, z],
      [x + midBowX, ground + h * (trunkTopFrac * 0.48), z + midBowZ],
      [x + leanX, ground + h * trunkTopFrac, z + leanZ],
      trunkR0,
      trunkR0 * 0.34,
      barkColor,
      4,
      7,
      0.48,
      lively ? 0 : -1,
      lively ? 0.12 : -1,
    )
  }

  // Construct chlorophyll + autumn palette from base RGB, variation, and per-tree species shift.
  const treeToneShift = (((Math.abs(seed) * 2654435761) >>> 0) % 100) / 100 - 0.5
  const baseRgb: Rgb = [
    clamp01(params.treeColorR * (1 + treeToneShift * 0.18)),
    clamp01(params.treeColorG * (1 + treeToneShift * 0.10)),
    clamp01(params.treeColorB * (1 - treeToneShift * 0.12)),
  ]
  const varAmt = params.treeColorVariation
  const autumn = clamp01(params.autumnMix * (isTree ? 0.85 + (Math.abs(seed * 7) % 5) * 0.12 : 0.72))
  const greenPalette: Rgb[] = [
    baseRgb,
    [
      clamp01(baseRgb[0] * (1 + 0.18 * varAmt)),
      clamp01(baseRgb[1] * (1 + 0.09 * varAmt)),
      clamp01(baseRgb[2] * (1 - 0.12 * varAmt)),
    ],
    [
      clamp01(baseRgb[0] * (1 - 0.14 * varAmt)),
      clamp01(baseRgb[1] * (1 - 0.12 * varAmt)),
      clamp01(baseRgb[2] * (1 - 0.06 * varAmt)),
    ],
    [
      clamp01(baseRgb[0] * (1 + 0.26 * varAmt)),
      clamp01(baseRgb[1] * (1 + 0.12 * varAmt)),
      clamp01(baseRgb[2] * (1 - 0.14 * varAmt)),
    ],
    [
      clamp01(baseRgb[0] * (1 - 0.08 * varAmt)),
      clamp01(baseRgb[1] * (1 - 0.05 * varAmt)),
      clamp01(baseRgb[2] * (1 + 0.06 * varAmt)),
    ],
  ]
  const autumnPalette: Rgb[] = [
    [0.44, 0.36, 0.20],
    [0.48, 0.32, 0.18],
    [0.38, 0.35, 0.20],
    [0.50, 0.40, 0.21],
    [0.34, 0.30, 0.18],
  ]
  const palette: Rgb[] = greenPalette.map((gCol, idx) => {
    const aWeight = clamp01(autumn * (idx % 2 === 0 ? 1.15 : 0.72))
    return mixRgb(gCol, autumnPalette[idx % autumnPalette.length]!, aWeight)
  })

  const crownCenter: Point = [x + leanX * 0.5, ground + h * 0.54, z + leanZ * 0.5]
  const angleRad = (params.branchAngle * Math.PI) / 180
  const cosPitch = Math.cos(angleRad)
  const sinPitch = Math.sin(angleRad)
  const isHeroTree = !isTree || Math.abs(x) < 12 || (x > 11 && x < 46 && z > 18 && z < 56)
  const baseClumps = isTree ? (isHeroTree ? Math.max(1, Math.round(params.clumpCount)) : 1) : 1
  const clumpsPerBough = lively ? Math.max(1, baseClumps + (quality === 2 ? 1 : quality === 0 ? -1 : 0)) : baseClumps
  const clumpScale = isTree
    ? params.clumpSize * Math.max(0.45, Math.min(1.65, radiusRatio))
    : radius * (0.50 + rng.next() * 0.14)
  const cardScale = isTree
    ? params.leafCardSize * Math.max(0.55, Math.min(1.55, radiusRatio))
    : Math.max(0.11, radius * 0.24)
  // Distance/perimeter LOD: full card density on hero street/house trees, lighter on outer town trees
  // Lively mounds are rounder (more segments, a fourth ring) on medium and high detail.
  const moundSegs = lively ? [isHeroTree ? 6 : 5, isHeroTree ? 8 : 7, isHeroTree ? 10 : 8][quality]! : isHeroTree ? 6 : 5
  const sprigsPerClump = (isHeroTree ? 3 : 2) + (lively ? quality - 1 : 0)
  const edgeSprigs = lively ? (quality === 0 ? 0 : quality === 2 ? (isHeroTree ? 2 : 1) : isHeroTree ? 1 : 0) : isHeroTree ? 1 : 0
  // Bare trees: a few dry clumps cling to some boughs; the rest of the crown is limbs and twigs.
  const deadPalette: Rgb[] = [[0.40, 0.33, 0.21], [0.35, 0.30, 0.20], [0.44, 0.36, 0.22]]

  for (let b = 0; b < boughs; b++) {
    const baseAngle = (b * Math.PI * 2) / boughs + (rng.next() - 0.5) * (isTree ? 0.42 : 0.58)
    const gapDelta = Math.abs(Math.atan2(Math.sin(baseAngle - gapAngle), Math.cos(baseAngle - gapAngle)))
    const inGap = gapDelta < gapHalfWidth
    const tierFrac = boughs > 1 ? b / (boughs - 1) : 0.5

    let shapeProfile = 1 - tierFrac * 0.24
    if (shape === "conical") {
      shapeProfile = 1.14 - tierFrac * 0.68
    } else if (shape === "columnar") {
      shapeProfile = 0.68 * (1 - Math.abs(tierFrac - 0.45) * 0.55)
    } else if (shape === "layered") {
      shapeProfile = 1.08 - tierFrac * 0.30
    } else if (shape === "spreading") {
      shapeProfile = 1.16 - tierFrac * 0.16
    }

    const reach = !isTree
      ? radius * (inGap ? 0.34 : 0.46 + rng.next() * 0.32) * (1.02 - tierFrac * 0.16)
      : radius *
        shapeProfile *
        (inGap ? Math.max(0.26, 0.48 - params.porosity * 0.28) : 0.62 + rng.next() * 0.34) *
        (0.72 + 0.28 * sinPitch)

    const startH =
      ground +
      h *
        (isTree
          ? shape === "conical"
            ? 0.22 + tierFrac * 0.50
            : 0.28 + tierFrac * 0.30
          : 0.10 + tierFrac * 0.14)
    const rise = reach * Math.max(-0.18, cosPitch * (shape === "conical" ? 0.20 : 0.50))
    const tipH = Math.min(
      ground + h * 0.94,
      startH + rise + h * (isTree ? 0.14 + (rng.next() - 0.4) * 0.08 : 0.28 + tierFrac * 0.28),
    )

    const start: Point = [x + leanX * (0.28 + tierFrac * 0.45), startH, z + leanZ * (0.28 + tierFrac * 0.45)]
    const tip: Point = [x + Math.cos(baseAngle) * reach, tipH, z + Math.sin(baseAngle) * reach]
    const midCtrl: Point = [
      (start[0] + tip[0]) * 0.5 + (rng.next() - 0.5) * 0.18,
      (start[1] + tip[1]) * 0.5 + h * 0.05,
      (start[2] + tip[2]) * 0.5 + (rng.next() - 0.5) * 0.18,
    ]

    if (isTree) {
      const rBough0 = 0.078 * (1 - tierFrac * 0.32) * Math.max(0.75, Math.min(1.25, heightRatio))
      emitTaperedLimb(m, start, midCtrl, tip, rBough0, rBough0 * 0.28, barkColor, 3, 5, 0.22, lively ? 0.08 : -1, lively ? 1 : -1)
      if (dead) {
        // Twigs splaying from the bough's outer half: a bare crown reads as a fan of fine limbs against the ground.
        const twigs = 2 + Math.floor(rng.next() * 2)
        for (let t = 0; t < twigs; t++) {
          const along = 0.5 + rng.next() * 0.45
          const tw0: Point = [start[0] + (tip[0] - start[0]) * along, start[1] + (tip[1] - start[1]) * along, start[2] + (tip[2] - start[2]) * along]
          const ta = baseAngle + (rng.next() - 0.5) * 1.5
          const tl = reach * (0.32 + rng.next() * 0.3)
          const tw2: Point = [tw0[0] + Math.cos(ta) * tl, tw0[1] + tl * (0.25 + rng.next() * 0.45), tw0[2] + Math.sin(ta) * tl]
          const tw1: Point = [(tw0[0] + tw2[0]) * 0.5, (tw0[1] + tw2[1]) * 0.5 + 0.06, (tw0[2] + tw2[2]) * 0.5]
          emitTaperedLimb(m, tw0, tw1, tw2, rBough0 * 0.42, 0.006, barkColor, 2, 3, 0, 0.5, 1)
        }
      }
    }

    const boughClumps = inGap ? 1 : clumpsPerBough
    for (let cIdx = 0; cIdx < boughClumps; cIdx++) {
      const tAlong = boughClumps === 1 ? 0.94 : 0.56 + (cIdx / (boughClumps - 1)) * 0.44
      const jitterA = cIdx === 0 ? 0 : (rng.next() - 0.5) * 0.54
      const cAngle = baseAngle + jitterA
      const cDist = reach * tAlong
      const cx = x + Math.cos(cAngle) * cDist
      const cz = z + Math.sin(cAngle) * cDist
      const cy =
        start[1] +
        (tip[1] - start[1]) * tAlong +
        (shape === "layered" ? 0 : (cIdx % 2 === 0 ? 0.06 : -0.05) * h)

      // Emit a secondary forked twig to sub-clusters so every leaf bouquet is visibly supported
      if (isTree && cIdx > 0) {
        const forkStart: Point = [
          start[0] + (tip[0] - start[0]) * 0.48,
          start[1] + (tip[1] - start[1]) * 0.48,
          start[2] + (tip[2] - start[2]) * 0.48,
        ]
        const forkMid: Point = [(forkStart[0] + cx) * 0.5, (forkStart[1] + cy) * 0.5 + 0.08, (forkStart[2] + cz) * 0.5]
        emitTaperedLimb(m, forkStart, forkMid, [cx, cy, cz], 0.036, 0.014, barkColor, 2, 4, 0, lively ? 0.5 : -1, lively ? 1 : -1)
      }
      if (dead && rng.next() > 0.22) continue

      const clusterTone = dead ? deadPalette[(b + cIdx) % deadPalette.length]! : palette[(b + cIdx + Math.floor(rng.next() * 2)) % palette.length]!
      const subScale = cIdx === 0 ? 1.0 : 0.78 + rng.next() * 0.18
      const rx = clumpScale * subScale * (inGap ? 0.72 : 0.92 + rng.next() * 0.22) * (dead ? 0.55 : 1)
      const ry = rx * (shape === "layered" ? 0.48 : isTree ? 0.68 : 0.78)
      const flexBase = 0.22 + 0.78 * clamp01((cy - ground) / Math.max(1.0, h))

      emitBoughCluster(
        m,
        cx,
        cy,
        cz,
        rx,
        ry,
        crownCenter,
        rng,
        clusterTone,
        sprigsPerClump,
        cardScale * subScale,
        params.canopyAO,
        params.normalSoftness,
        flexBase,
        5,
        0,
        inGap ? 0 : edgeSprigs,
        true,
        moundSegs,
        lively,
      )
    }
  }

  // Crown apex bouquet
  if (!dead) {
    const crownTone = palette[Math.abs(seed) % palette.length]!
    const apexRx = clumpScale * (shape === "conical" ? 0.64 : 0.94)
    const apexRy = apexRx * (shape === "layered" ? 0.52 : 0.72)
    emitBoughCluster(
      m,
      x + leanX * 0.55,
      ground + h * (isTree ? 0.85 : 0.70),
      z + leanZ * 0.55,
      apexRx,
      apexRy,
      crownCenter,
      rng,
      crownTone,
      sprigsPerClump + 2,
      cardScale * 0.95,
      params.canopyAO,
      params.normalSoftness,
      0.95,
      5,
      0,
      edgeSprigs,
      true,
      lively ? moundSegs + 1 : 6,
      lively,
    )
  }

  // Root-flare curved grass & sprawling bramble/weed shoots around the base
  const coverCount = isTree ? 4 : 3
  for (let c = 0; c < coverCount; c++) {
    const a = gapAngle + 0.8 + c * (Math.PI * 2 / coverCount) + (rng.next() - 0.5) * 0.55
    const d = radius * (isTree ? 0.24 : 0.62) * (0.65 + rng.next() * 0.55)
    const gx = x + Math.cos(a) * d
    const gz = z + Math.sin(a) * d
    emitGrassTuft(m, gx, ground, gz, {
      bladeCount: 3,
      radius: (isTree ? 0.16 : 0.24) + rng.next() * 0.14,
      height: (isTree ? 0.24 : 0.28) + rng.next() * 0.20,
      width: params.bladeWidth * 1.18,
      curvature: Math.min(1.0, params.bladeCurvature * 1.15),
      leanAngle: a + (rng.next() - 0.5) * 0.45,
      rootColor: [params.rootColorR * 0.85, params.rootColorG * 0.85, params.rootColorB * 0.85],
      tipColor: [params.tipColorR * 0.96, params.tipColorG * 0.98, params.tipColorB * 0.88],
      rng,
    })
  }
}

/** Bush vertices carry `aux = 3 + flex` so shaders can give bushes their own wind, translucency and actor bending. */
export const FOLIAGE_BUSH_AUX = 3

/**
 * Production shrub/hedge generator. `bushTrim` morphs a ragged multi-lobe mound (0) into a clipped hedge (1) by
 * flattening the top and straightening the sides of the emitted leaf clusters; the lowest 30 cm get contact AO.
 */
export function buildFoliageBush(
  m: Mesh,
  x: number,
  z: number,
  h: number,
  radius: number,
  seed: number,
  ground: number,
  params: Readonly<FoliageParams> = foliageSettings,
  opts: Readonly<FoliageBuildOptions> = FOLIAGE_BUILD_TODAY,
): void {
  const rng = new Rng(seed ^ 0x2b5e)
  const from = m.v.length
  const trim = clamp01(params.bushTrim)
  const wild = 1 - trim
  const H = Math.max(0.2, h * params.bushHeight)
  const R = Math.max(0.15, radius * params.bushSpread)
  // Small shrubs get fewer lobes so a yard of foundation planting stays near the old vertex budget.
  const lobes = Math.max(3, Math.round(params.bushLobes * Math.min(1, Math.max(0.6, R / 0.75))))
  const varAmt = params.bushColorVariation
  const tone = ((((Math.abs(seed) * 2654435761) >>> 0) % 100) / 100 - 0.5) * varAmt
  const base: Rgb = [
    clamp01(params.bushColorR * (1 + tone * 0.28)),
    clamp01(params.bushColorG * (1 + tone * 0.12)),
    clamp01(params.bushColorB * (1 - tone * 0.2)),
  ]
  const tones: Rgb[] = [
    base,
    [clamp01(base[0] * (1 + 0.2 * varAmt)), clamp01(base[1] * (1 + 0.08 * varAmt)), clamp01(base[2] * (1 - 0.14 * varAmt))],
    [clamp01(base[0] * (1 - 0.12 * varAmt)), clamp01(base[1] * (1 - 0.1 * varAmt)), clamp01(base[2] * (1 + 0.04 * varAmt))],
  ]
  const centre: Point = [x, ground + H * 0.5, z]
  const tips = trim > 0.6 ? 4 : 5
  const cards = Math.max(2, Math.round(2.0 * params.bushDensity))
  const sprigs = Math.round(wild * 1.6)
  const leaf = params.bushLeafSize

  for (let i = 0; i < lobes; i++) {
    const a = (i / lobes) * Math.PI * 2 + (rng.next() - 0.5) * 0.9 * wild
    const ring = R * (0.46 + rng.next() * 0.16 * wild)
    const lobeH = H * (0.62 + (rng.next() - 0.45) * 0.42 * wild)
    const rx = R * (0.46 + rng.next() * 0.16 * wild)
    const ry = Math.min(rx * 0.9, lobeH * 0.55)
    const cy = ground + Math.max(ry * 0.8, lobeH - ry * 0.7)
    const flex = 0.3 + 0.6 * clamp01((cy - ground) / Math.max(0.5, H))
    emitBoughCluster(
      m,
      x + Math.cos(a) * ring,
      cy,
      z + Math.sin(a) * ring,
      rx,
      ry,
      centre,
      rng,
      tones[i % tones.length]!,
      cards,
      leaf,
      params.bushAO,
      0.9,
      flex,
      tips,
      FOLIAGE_BUSH_AUX,
      sprigs,
      true,
      opts.lively ? 7 : 5,
      opts.lively,
    )
  }
  const topR = R * (0.56 + 0.1 * wild)
  emitBoughCluster(
    m,
    x,
    ground + H - topR * 0.42,
    z,
    topR,
    Math.min(topR * 0.72, H * 0.42),
    centre,
    rng,
    tones[Math.abs(seed) % tones.length]!,
    cards + 1,
    leaf,
    params.bushAO,
    0.9,
    0.95,
    tips,
    FOLIAGE_BUSH_AUX,
    sprigs,
    true,
    opts.lively ? 8 : 6,
    opts.lively,
  )

  // Clip toward a rounded box (flat top, straight sides) by `trim`, bend normals to match, and darken the skirt.
  const top = ground + H
  for (let i = from; i < m.v.length; i += 11) {
    const px = m.v[i]!, py = m.v[i + 1]!, pz = m.v[i + 2]!
    const dx = px - x, dz = pz - z
    const d = Math.hypot(dx, dz)
    if (trim > 0.01) {
      const capY = Math.min(py, top - 0.02 * rng.next())
      m.v[i + 1] = py + (capY - py) * trim
      const maxR = R * 1.02
      if (d > maxR) {
        const k = 1 + (maxR / d - 1) * trim
        m.v[i] = x + dx * k
        m.v[i + 2] = z + dz * k
      }
      const nearTop = clamp01((m.v[i + 1]! - (top - 0.18)) / 0.18)
      const side = clamp01((d - R * 0.7) / (R * 0.3))
      const bx = (dx / Math.max(d, 1e-4)) * side * (1 - nearTop)
      const bz = (dz / Math.max(d, 1e-4)) * side * (1 - nearTop)
      const n = normalize3(
        m.v[i + 3]! + (bx - m.v[i + 3]!) * trim * 0.7,
        m.v[i + 4]! + (nearTop - m.v[i + 4]!) * trim * 0.7,
        m.v[i + 5]! + (bz - m.v[i + 5]!) * trim * 0.7,
      )
      m.v[i + 3] = n[0]
      m.v[i + 4] = n[1]
      m.v[i + 5] = n[2]
    }
    const skirt = 0.5 + 0.5 * clamp01((m.v[i + 1]! - ground) / 0.3)
    m.v[i + 6] = m.v[i + 6]! * skirt
    m.v[i + 7] = m.v[i + 7]! * skirt
    m.v[i + 8] = m.v[i + 8]! * skirt
  }

  const blossoms = Math.round(18 * params.bushFlowers)
  if (blossoms >= 2) {
    emitHydrangeaPanicles(m, x, ground, z, H, R, seed, blossoms, FOLIAGE_BUSH_AUX)
  }

  if (opts.lively) {
    // Stray shoots past the clipped or rounded crown (nobody has trimmed since the outbreak): they break the hedge's
    // silhouette and, at full flex, wave in the wind ahead of the mass. Their own Rng keeps the rest of the bush intact.
    const shootRng = new Rng((seed ^ 0x51007) >>> 0)
    const shoots = 2 + Math.floor(shootRng.next() * (2 + opts.quality))
    const shootCol = scaleRgb(tones[1]!, 1.12)
    for (let k = 0; k < shoots; k++) {
      const a = shootRng.next() * Math.PI * 2
      const up = 0.35 + shootRng.next() * 0.5
      const root: Point = [x + Math.cos(a) * R * 0.62, ground + H * (0.72 + shootRng.next() * 0.2), z + Math.sin(a) * R * 0.62]
      emitLeafSprig(m, root, normalize3(Math.cos(a), up, Math.sin(a)), leaf * (2.0 + shootRng.next() * 0.9), [x, ground + H * 0.4, z], centre, 0.7, shootRng, scaleRgb(tones[0]!, 0.9), shootCol, 1, 3, FOLIAGE_BUSH_AUX)
    }
  }

  if (wild > 0.4) {
    for (let c = 0; c < 3; c++) {
      const a = c * 2.1 + rng.next() * 0.8
      const dd = R * (0.8 + rng.next() * 0.3)
      emitGrassTuft(m, x + Math.cos(a) * dd, ground, z + Math.sin(a) * dd, {
        bladeCount: 3,
        radius: 0.16 + rng.next() * 0.1,
        height: 0.22 + rng.next() * 0.16,
        width: params.bladeWidth * 1.1,
        curvature: Math.min(1, params.bladeCurvature * 1.15),
        leanAngle: a,
        rootColor: [params.rootColorR * 0.85, params.rootColorG * 0.85, params.rootColorB * 0.85],
        tipColor: [params.tipColorR, params.tipColorG, params.tipColorB * 0.9],
        rng,
      })
    }
  }
}

/**
 * Emits delicate creamy-white / pale-celadon / warm-ivory hydrangea blossom flecks
 * nestled organically across the outer foliage of a corner bush.
 */
/** Creamy-white fresh hydrangea heads (the default). */
export const HYDRANGEA_FRESH: readonly Rgb[] = [
  [0.82, 0.86, 0.78],
  [0.74, 0.80, 0.70],
  [0.88, 0.87, 0.78],
  [0.68, 0.75, 0.64],
]
/** Heads left to dry on the bush through autumn: papery tan and rust, darker than fresh, so they don't sparkle under a lamp. */
export const HYDRANGEA_DRIED: readonly Rgb[] = [
  [0.36, 0.29, 0.20],
  [0.30, 0.24, 0.17],
  [0.40, 0.31, 0.21],
  [0.27, 0.22, 0.16],
]

export function emitHydrangeaPanicles(
  m: Mesh,
  x: number,
  ground: number,
  z: number,
  h: number,
  radius: number,
  seed: number,
  count = 16,
  auxOffset = 0,
  palette: readonly Rgb[] = HYDRANGEA_FRESH,
): void {
  const rng = new Rng(seed ^ 0x6f1a)
  for (let i = 0; i < count; i++) {
    const a = i * 2.39996 + (rng.next() - 0.5) * 0.36
    const rFrac = 0.22 + Math.sqrt((i + 0.4) / count) * 0.74
    const dist = radius * rFrac
    const bx = x + Math.cos(a) * dist
    const bz = z + Math.sin(a) * dist * 0.92
    const domeY = Math.sqrt(Math.max(0.12, 1 - rFrac * rFrac * 0.72))
    const by = ground + h * (0.28 + domeY * 0.52) + (rng.next() - 0.5) * 0.08
    const mainR = 0.045 + rng.next() * 0.025
    const col = palette[i % palette.length]!
    const rimCol = scaleRgb(col, 0.78)
    m.prism(bx, bz, mainR, mainR * 0.68, by, by + mainR * 0.95, 5, col, MAT.foliage, auxOffset + 0.45)
    const sa = a + 1.2 + rng.next() * 0.9
    const sx = bx + Math.cos(sa) * mainR * 0.75
    const sz = bz + Math.sin(sa) * mainR * 0.75
    m.prism(sx, sz, mainR * 0.64, mainR * 0.46, by - 0.01, by + mainR * 0.76, 5, rimCol, MAT.foliage, auxOffset + 0.42)
  }
}

/**
 * Shipped baseline faceted pyramid tree (`m.facet` origami cones, `aux = 0` static)
 * retained for honest Before/After/Split comparison in the Lab workbench.
 */
export function buildLegacyFoliageTree(
  m: Mesh,
  x: number,
  z: number,
  h: number,
  radius: number,
  seed: number,
  ground: number,
): void {
  const rng = new Rng(seed)
  const tree = h > 2
  const boughs = tree ? 5 : 4
  const gapAngle = rng.next() * 6.283
  const leanX = (rng.next() - 0.5) * (tree ? 0.22 : 0.06)
  const leanZ = (rng.next() - 0.5) * (tree ? 0.22 : 0.06)
  if (tree) {
    emitTaperedLimb(
      m,
      [x, ground, z],
      [x + leanX * 0.5, ground + h * 0.39, z + leanZ * 0.5],
      [x + leanX, ground + h * 0.78, z + leanZ],
      0.17,
      0.17 * 0.4,
      [0.28, 0.26, 0.20],
      1,
      5,
      0,
    )
  }
  const palette: Rgb[] = [
    [0.26, 0.34, 0.17],
    [0.31, 0.38, 0.20],
    [0.23, 0.30, 0.15],
    [0.35, 0.39, 0.21],
  ]
  for (let b = 0; b < boughs; b++) {
    const baseAngle = (b * 6.283) / boughs + (rng.next() - 0.5) * 0.55
    const gapDelta = Math.abs(Math.atan2(Math.sin(baseAngle - gapAngle), Math.cos(baseAngle - gapAngle)))
    const inGap = gapDelta < 0.62
    const reach = radius * (inGap ? 0.42 : 0.68 + rng.next() * 0.38)
    const tierFrac = b / (boughs - 1)
    const startH = ground + h * (tree ? 0.28 + tierFrac * 0.24 : 0.10 + tierFrac * 0.12)
    const tipH = ground + h * (tree ? 0.54 + tierFrac * 0.36 + (rng.next() - 0.4) * 0.10 : 0.48 + tierFrac * 0.38)
    const start: Point = [x + leanX * 0.35, startH, z + leanZ * 0.35]
    const tip: Point = [x + Math.cos(baseAngle) * reach, tipH, z + Math.sin(baseAngle) * reach]
    const br = tree ? 0.075 * (1 - tierFrac * 0.28) : 0.022
    emitTaperedLimb(
      m,
      start,
      [(start[0] + tip[0]) * 0.5, (start[1] + tip[1]) * 0.5, (start[2] + tip[2]) * 0.5],
      tip,
      br,
      br * 0.4,
      [0.28, 0.26, 0.20],
      1,
      5,
      0,
    )
    const lobes = tree ? (inGap ? 1 : 2) : 1
    for (let lobe = 0; lobe < lobes; lobe++) {
      const t = lobes === 1 ? 0.82 : 0.58 + lobe * 0.38
      const cx = start[0] + (tip[0] - start[0]) * t
      const cy = start[1] + (tip[1] - start[1]) * t
      const cz = start[2] + (tip[2] - start[2]) * t
      const clusterTone = palette[(b + lobe) % palette.length]!
      const sprays = 3
      for (let s = 0; s < sprays; s++) {
        const a = baseAngle + s * 2.15 + lobe * 1.1 + (rng.next() - 0.5) * 0.45
        const spread = radius * (tree ? 0.24 : 0.26) * Math.sqrt((s + 0.4) / sprays)
        const px = cx + Math.cos(a) * spread
        const pz = cz + Math.sin(a) * spread
        const py = cy + (s === 0 ? 0.06 : -0.02) + (rng.next() - 0.45) * h * 0.09
        const size = (tree ? 0.42 : 0.17) + rng.next() * (tree ? 0.28 : 0.11)
        const width = size * (0.72 + rng.next() * 0.20)
        const fx = Math.cos(a) * size
        const fz = Math.sin(a) * size
        const sx = -Math.sin(a) * width
        const sz = Math.cos(a) * width
        const dome = tree ? 0.11 : 0.05
        const droop = tree ? 0.06 : 0.03
        const center: Point = [px, py + dome, pz]
        const a0: Point = [px - fx, py - droop * 0.5, pz - fz]
        const a1: Point = [px + sx, py - droop, pz + sz]
        const a2: Point = [px + fx, py - droop * 0.8, pz + fz]
        const a3: Point = [px - sx, py - droop, pz - sz]
        const k = 0.78 + rng.next() * 0.34
        const col: Rgb = [clusterTone[0] * k, clusterTone[1] * k, clusterTone[2] * k]
        for (const [p0, p1] of [
          [a0, a1],
          [a1, a2],
          [a2, a3],
          [a3, a0],
        ] as const) {
          m.facet(center, p0, p1, col, MAT.foliage, 0)
        }
      }
    }
  }
}

/**
 * Emits a single curved, parabolically tapered (1 - y^2) 2-segment 3D grass blade
 * combining Above the Grassland's quadratic tilt + cubic curvature (y^3), arc-length height drop,
 * cylindrical cross-section normal rotation (±55°), power-curve root-to-tip colour (y^0.65),
 * and strong root contact AO that survives at Outbreak's 34-46m game camera.
 */
export function emitCurvedGrassBlade(
  m: Mesh,
  bx: number,
  by: number,
  bz: number,
  height: number,
  width: number,
  curvature: number,
  leanAngle: number,
  rootCol: Rgb,
  tipCol: Rgb,
): void {
  const dirX = Math.cos(leanAngle)
  const dirZ = Math.sin(leanAngle)
  const sideX = -dirZ
  const sideZ = dirX

  // Arch profile with generous horizontal reach so top-down cameras (34-46m) see the curved blade ribbon
  const yFrac1 = 0.52
  const bend1 = height * (0.24 * yFrac1 * yFrac1 + curvature * 0.68 * yFrac1 * yFrac1 * yFrac1)
  const bend2 = height * (0.28 + curvature * 0.82)
  const y1 = by + height * yFrac1 - bend1 * bend1 * 0.16
  const y2 = by + Math.max(height * 0.54, height - bend2 * bend2 * 0.18)

  const c0: Point = [bx, by, bz]
  const c1: Point = [bx + dirX * bend1, y1, bz + dirZ * bend1]
  const c2: Point = [bx + dirX * bend2, y2, bz + dirZ * bend2]

  // Parabolic width taper w(y) = w0 * (1 - 0.72 * y^2) keeps upper-mid blade broad enough to read at 42m
  const w0 = width * 0.5
  const w1 = width * 0.5 * (1 - 0.72 * yFrac1 * yFrac1)

  const p0L: Point = [c0[0] - sideX * w0, c0[1], c0[2] - sideZ * w0]
  const p0R: Point = [c0[0] + sideX * w0, c0[1], c0[2] + sideZ * w0]
  const p1L: Point = [c1[0] - sideX * w1, c1[1], c1[2] - sideZ * w1]
  const p1R: Point = [c1[0] + sideX * w1, c1[1], c1[2] + sideZ * w1]
  const p2Tip: Point = c2

  // Cylindrical cross-section normal rotation + terrain-normal upward bias (`Lamplight §3.1`)
  const spineN0 = normalize3(-dirX * 0.25, 0.96, -dirZ * 0.25)
  const spineN1 = normalize3(-dirX * (0.34 + curvature * 0.24), 0.90, -dirZ * (0.34 + curvature * 0.24))
  const spineN2 = normalize3(-dirX * (0.20 + curvature * 0.28), 0.94, -dirZ * (0.20 + curvature * 0.28))

  const cosR = 0.58
  const sinR = 0.81
  const n0L = normalize3(spineN0[0] * cosR - sideX * sinR, spineN0[1] * cosR, spineN0[2] * cosR - sideZ * sinR)
  const n0R = normalize3(spineN0[0] * cosR + sideX * sinR, spineN0[1] * cosR, spineN0[2] * cosR + sideZ * sinR)
  const n1L = normalize3(spineN1[0] * cosR - sideX * sinR, spineN1[1] * cosR, spineN1[2] * cosR - sideZ * sinR)
  const n1R = normalize3(spineN1[0] * cosR + sideX * sinR, spineN1[1] * cosR, spineN1[2] * cosR + sideZ * sinR)

  // High-contrast root-to-tip gradient so tufts pop from 38-46m overhead without neon oversaturation
  const rootGrounded = scaleRgb(rootCol, 0.58)
  const midCol = mixRgb(rootCol, tipCol, Math.pow(yFrac1, 0.62))
  const brightTip = scaleRgb(tipCol, 1.06)
  const aux0 = -0.05
  const aux1 = -0.52
  const aux2 = -1.0

  // Segment 0 quad (2 triangles)
  m.vert(p0L, n0L, rootGrounded, MAT.foliage, aux0)
  m.vert(p0R, n0R, rootGrounded, MAT.foliage, aux0)
  m.vert(p1R, n1R, midCol, MAT.foliage, aux1)

  m.vert(p0L, n0L, rootGrounded, MAT.foliage, aux0)
  m.vert(p1R, n1R, midCol, MAT.foliage, aux1)
  m.vert(p1L, n1L, midCol, MAT.foliage, aux1)

  // Segment 1 tapered tip triangle
  m.vert(p1L, n1L, midCol, MAT.foliage, aux1)
  m.vert(p1R, n1R, midCol, MAT.foliage, aux1)
  m.vert(p2Tip, spineN2, brightTip, MAT.foliage, aux2)
}

export function emitGrassTuft(
  m: Mesh,
  x: number,
  y: number,
  z: number,
  opts: {
    bladeCount: number
    radius: number
    height: number
    width: number
    curvature: number
    leanAngle: number
    rootColor: Rgb
    tipColor: Rgb
    rng: Rng
  },
): void {
  const { bladeCount, radius, height, width, curvature, leanAngle, rootColor, tipColor, rng } = opts
  for (let i = 0; i < bladeCount; i++) {
    const radialA = i * 2.39996 + rng.next() * 0.55
    const radialD = radius * Math.sqrt((i + 0.2) / bladeCount) * (0.45 + rng.next() * 0.55)
    const bx = x + Math.cos(radialA) * radialD
    const bz = z + Math.sin(radialA) * radialD
    // Splay blades outward from the tuft heart while biasing toward the clump wind-lean direction
    const splay = Math.atan2(Math.sin(radialA - leanAngle), Math.cos(radialA - leanAngle)) * 0.42
    const bladeYaw = leanAngle + splay + (rng.next() - 0.5) * 0.45
    const bh = height * (0.82 + rng.next() * 0.42) * (1.12 - (radialD / Math.max(0.05, radius)) * 0.26)
    const bw = width * (0.88 + rng.next() * 0.30)
    const bCurve = clamp01(curvature * (0.85 + rng.next() * 0.32))
    const shade = 0.95 + rng.next() * 0.1
    emitCurvedGrassBlade(
      m,
      bx,
      y,
      bz,
      bh,
      bw,
      bCurve,
      bladeYaw,
      scaleRgb(rootColor, shade * 0.80),
      scaleRgb(tipColor, shade * 1.08),
    )
  }
}

/** Broadleaf weed rosette (dandelion/plantain): six lanceolate leaves radiating from a low crown, tips lifted. */
export function emitWeedMat(
  m: Mesh,
  x: number,
  y: number,
  z: number,
  radius: number,
  height: number,
  rng: Rng,
  baseCol: Rgb = [0.16, 0.25, 0.11],
): void {
  const leaves = 6
  const rot = rng.next() * Math.PI * 2
  const heart: Point = [x, y + height * 0.35, z]
  const heartCol = scaleRgb(baseCol, 0.6)
  for (let i = 0; i < leaves; i++) {
    const a = rot + (i / leaves) * Math.PI * 2 + (rng.next() - 0.5) * 0.4
    const len = radius * (0.8 + rng.next() * 0.45)
    const wid = len * 0.24
    const dx = Math.cos(a), dz = Math.sin(a)
    const mid: Point = [x + dx * len * 0.5, y + height * 0.55, z + dz * len * 0.5]
    const tip: Point = [x + dx * len, y + height * (0.4 + rng.next() * 0.5), z + dz * len]
    const l: Point = [mid[0] - dz * wid, mid[1] - height * 0.15, mid[2] + dx * wid]
    const r: Point = [mid[0] + dz * wid, mid[1] - height * 0.15, mid[2] - dx * wid]
    const n = normalize3(dx * 0.25, 1, dz * 0.25)
    const leafCol = scaleRgb(baseCol, 0.9 + rng.next() * 0.2)
    m.vert(heart, n, heartCol, MAT.foliage, -0.08)
    m.vert(l, n, leafCol, MAT.foliage, -0.3)
    m.vert(tip, n, scaleRgb(leafCol, 1.1), MAT.foliage, -0.55)
    m.vert(heart, n, heartCol, MAT.foliage, -0.08)
    m.vert(tip, n, scaleRgb(leafCol, 1.1), MAT.foliage, -0.55)
    m.vert(r, n, leafCol, MAT.foliage, -0.3)
  }
}

export type GrassClumpSample = {
  x: number
  z: number
  radius: number
  height: number
  width: number
  curvature: number
  leanAngle: number
  blades: number
  rootColor: Rgb
  tipColor: Rgb
  /** Broadleaf weed rosette instead of a blade tuft (`weedRosettes`). */
  weed?: boolean
}

/** Emits one scattered clump: a curved-blade tuft, or a flat broadleaf weed rosette when `c.weed` is set. */
export function emitGrassClump(m: Mesh, c: GrassClumpSample, y: number, rng: Rng, scale = 1): void {
  if (c.weed) {
    const leaf = mixRgb(c.rootColor, c.tipColor, 0.4)
    emitWeedMat(m, c.x, y, c.z, c.radius * 1.15 * scale, 0.035 + c.height * 0.12, rng, [leaf[0] * 0.85, leaf[1] * 1.1, leaf[2] * 0.75])
    return
  }
  emitGrassTuft(m, c.x, y, c.z, {
    bladeCount: c.blades,
    radius: c.radius * scale,
    height: c.height * scale,
    width: c.width * scale,
    curvature: c.curvature,
    leanAngle: c.leanAngle,
    rootColor: c.rootColor,
    tipColor: c.tipColor,
    rng,
  })
}

/**
 * Generates clump-correlated grass tufts with mowed vs. overgrown zones, shared wind-lean direction,
 * root-to-tip colour gradients, and dry straw patches.
 */
export function scatterGrassClumps(options: {
  seed: number
  bounds: readonly [number, number, number, number]
  clusterCount: number
  tuftsPerCluster?: number
  params?: Readonly<FoliageParams>
  avoid?: (x: number, z: number) => boolean
}): GrassClumpSample[] {
  const {
    seed,
    bounds: [x0, z0, x1, z1],
    clusterCount,
    tuftsPerCluster = 4,
    params = foliageSettings,
    avoid,
  } = options
  const rng = new Rng(seed ^ 0x6a09e667)
  const baseRoot: Rgb = [params.rootColorR, params.rootColorG, params.rootColorB]
  const baseTip: Rgb = [params.tipColorR, params.tipColorG, params.tipColorB]
  const dryRoot: Rgb = [0.24, 0.20, 0.10]
  const dryTip: Rgb = [0.64, 0.54, 0.24]

  const out: GrassClumpSample[] = []
  const effClusters = Math.max(1, Math.round(clusterCount * params.grassDensity))

  for (let c = 0; c < effClusters; c++) {
    const cx = x0 + rng.next() * (x1 - x0)
    const cz = z0 + rng.next() * (z1 - z0)
    if (avoid?.(cx, cz)) continue

    // Correlated clump noise field: shared lean angle, mowed vs. overgrown height envelope, and dry-patch weight
    const nLean = noise2(cx * 0.22 + 3.1, cz * 0.22 + 7.4)
    const nDry = noise2(cx * 0.18 + 11.3, cz * 0.18 + 2.9)
    const nOvergrown = noise2(cx * 0.32 + 5.7, cz * 0.32 + 1.9)
    const clumpLean = nLean * Math.PI * 2
    const overgrownScale = 0.72 + Math.pow(nOvergrown, 1.3) * 0.78
    const spread = (0.45 + rng.next() * 0.90) * (1.25 - params.grassClumping * 0.45)
    const dryWeight = clamp01((nDry - (0.62 - params.dryPatches * 0.45)) * 2.4) * params.dryPatches
    const hueShift = (rng.next() - 0.5) * 0.32 * params.grassVariation

    const clusterRoot = mixRgb(
      [
        clamp01(baseRoot[0] * (1 + hueShift * 0.8)),
        clamp01(baseRoot[1] * (1 + hueShift * 0.5)),
        clamp01(baseRoot[2] * (1 - hueShift * 0.6)),
      ],
      dryRoot,
      dryWeight * 0.75,
    )
    const clusterTip = mixRgb(
      [
        clamp01(baseTip[0] * (1 + hueShift)),
        clamp01(baseTip[1] * (1 + hueShift * 0.6)),
        clamp01(baseTip[2] * (1 - hueShift * 0.8)),
      ],
      dryTip,
      dryWeight,
    )

    const count = Math.max(2, Math.round(tuftsPerCluster * (0.65 + rng.next() * 0.7)))
    const weedSlot = rng.next() < params.weedRosettes * 0.6 ? Math.floor(rng.next() * count) : -1
    for (let i = 0; i < count; i++) {
      const angle = i * 2.39996 + rng.next() * 0.55
      const radialFrac = Math.sqrt((i + 0.2) / count)
      const dist = spread * radialFrac * (0.52 + rng.next() * 0.58)
      const tx = cx + Math.cos(angle) * dist
      const tz = cz + Math.sin(angle) * dist
      if (tx < x0 || tx > x1 || tz < z0 || tz > z1 || avoid?.(tx, tz)) continue

      const moundScale = (1.22 - radialFrac * 0.36 * params.grassClumping) * overgrownScale
      const shade = 0.93 + rng.next() * 0.14
      const randomLean = (rng.next() - 0.5) * Math.PI * 2
      const leanAngle = clumpLean * params.grassClumping + randomLean * (1 - params.grassClumping)

      out.push({
        x: tx,
        z: tz,
        radius: 0.11 + rng.next() * 0.12,
        height: params.bladeHeight * moundScale * (0.82 + rng.next() * 0.36),
        width: params.bladeWidth * (0.90 + rng.next() * 0.24),
        curvature: params.bladeCurvature,
        leanAngle,
        blades: 3 + (i % 2),
        rootColor: scaleRgb(clusterRoot, shade),
        tipColor: scaleRgb(clusterTip, shade),
        weed: i === weedSlot,
      })
    }
  }
  return out
}

export type FoliageTextureSlot = "grassAlbedo" | "grassNormal" | "barkAlbedo" | "leafAtlas"

/**
 * Configurable texture URLs for external/generated textures (`grass/soil albedo`, `grass/soil detail normal`,
 * `bark albedo`, and `leaf-cluster RGBA atlas`). Defaults to the prepared WebP maps from `generated-textures`.
 */
export const foliageTextureUrls: Record<FoliageTextureSlot, string> = {
  grassAlbedo: "texture-assets/lawn_grass.webp",
  grassNormal: "texture-assets/lawn_grass_normal.webp",
  barkAlbedo: "texture-assets/tree_bark.webp",
  leafAtlas: "texture-assets/leaf_atlas.webp",
}

let textureRev = 1
export function getFoliageTexturesRevision(): number {
  return textureRev
}

export function setFoliageTextureUrls(urls: Partial<Record<FoliageTextureSlot, string>>): void {
  let changed = false
  for (const [k, v] of Object.entries(urls) as [FoliageTextureSlot, string | undefined][]) {
    if (typeof v === "string" && v.trim() && foliageTextureUrls[k] !== v.trim()) {
      foliageTextureUrls[k] = v.trim()
      changed = true
    }
  }
  if (changed) textureRev++
}

/**
 * Emits 4 stacked horizontal volumetric grass fur shell slices (`aux = -(2.0 + shellFrac)`)
 * over `[x0, z0, x1, z1]`. Combined with 4x MSAA `alphaToCoverageEnabled: true`, these shells
 * render hundreds of thousands of fuzzy sub-pixel grass strands with wind shear and parallax
 * for only 8 triangles per grid cell.
 */
export function emitGrassFurShells(
  m: Mesh,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  heightAt: (x: number, z: number) => number,
  params: Readonly<FoliageParams> = foliageSettings,
  shellCount = 4,
  cellSize = 2.4,
): void {
  const nx = Math.max(1, Math.ceil((x1 - x0) / cellSize))
  const nz = Math.max(1, Math.ceil((z1 - z0) / cellSize))
  const dx = (x1 - x0) / nx
  const dz = (z1 - z0) / nz
  const rootCol: Rgb = [params.rootColorR, params.rootColorG, params.rootColorB]
  const tipCol: Rgb = [params.tipColorR, params.tipColorG, params.tipColorB]
  const maxFurH = Math.max(0.08, Math.min(0.26, params.bladeHeight * 0.68))

  for (let s = 0; s < shellCount; s++) {
    const shellT = (s + 1) / (shellCount + 0.25)
    const yOff = maxFurH * shellT
    const col = mixRgb(scaleRgb(rootCol, 0.72), scaleRgb(tipCol, 1.12), Math.pow(shellT, 0.65))
    const aux = -(2.0 + shellT)
    for (let iz = 0; iz < nz; iz++) {
      const cz0 = z0 + iz * dz
      const cz1 = cz0 + dz
      for (let ix = 0; ix < nx; ix++) {
        const cx0 = x0 + ix * dx
        const cx1 = cx0 + dx
        const a: Point = [cx0, heightAt(cx0, cz0) + yOff, cz0]
        const b: Point = [cx1, heightAt(cx1, cz0) + yOff, cz0]
        const c: Point = [cx1, heightAt(cx1, cz1) + yOff, cz1]
        const d: Point = [cx0, heightAt(cx0, cz1) + yOff, cz1]
        m.quad(a, d, c, b, [0, 1, 0], col, MAT.foliage, aux)
      }
    }
  }
}

/**
 * Typed WGSL layout for `FoliageWindConfig` (12 floats / 48 bytes) and `FoliageActors` (20 floats / 80 bytes).
 */
export const FoliageWindConfigStruct = wgslStruct("FoliageWindConfig", {
  treeWindStrength: "f32",
  treeWindFreq: "f32",
  treeWindGust: "f32",
  translucency: "f32",
  grassWind: "f32",
  distanceFade: "f32",
  canopyAO: "f32",
  normalSoftness: "f32",
  bushWind: "f32",
  bushTranslucency: "f32",
  trampleRadius: "f32",
  trampleStrength: "f32",
})

export const FoliageActorsStruct = wgslStruct("FoliageActors", {
  count: "f32",
  pad0: "f32",
  pad1: "f32",
  pad2: "f32",
  p: "array<vec4f, 4>",
})

/** Floats in `FoliageWindConfig` (3 vec4f = 12 floats). */
export const FOLIAGE_WIND_FLOATS = FoliageWindConfigStruct.floatCount
/** Floats in `FoliageActors` (count header + 8 packed xz positions = 20 floats). */
export const FOLIAGE_ACTOR_FLOATS = FoliageActorsStruct.floatCount
export const FOLIAGE_MAX_ACTORS = 8

/**
 * The town-wide wind field (`applyFoliageWindField`): `on` 0 keeps today's per-plant wobble, 1 drives every canopy,
 * limb, shrub and blade from one travelling gust field. Distances in metres, speed in m/s, direction as a unit xz vector.
 */
export const FoliageGustStruct = wgslStruct("FoliageGust", {
  on: "f32",
  strength: "f32",
  gustScale: "f32",
  gustSpeed: "f32",
  dirX: "f32",
  dirZ: "f32",
  branchSway: "f32",
  leafFlutter: "f32",
  bushSway: "f32",
  grassSway: "f32",
  trunkBend: "f32",
  canopyOpen: "f32",
})
export const FOLIAGE_GUST_FLOATS = FoliageGustStruct.floatCount

export type FoliageGust = { readonly [K in keyof typeof FoliageGustStruct.schema]: number }

/** Today's wind: the field is off and every plant keeps the per-vertex wobble driven by `FoliageWindConfig`. */
export const FOLIAGE_GUST_OFF: FoliageGust = {
  on: 0, strength: 0, gustScale: 24, gustSpeed: 5, dirX: 0.88, dirZ: 0.47,
  branchSway: 0, leafFlutter: 0, bushSway: 0, grassSway: 0, trunkBend: 0, canopyOpen: 0,
}

/** Pack the wind field (12 floats); `dirX`/`dirZ` are normalised here. */
export function packFoliageGust(g: FoliageGust, out: Float32Array = FoliageGustStruct.createBuffer(), offset = 0): Float32Array {
  const len = Math.hypot(g.dirX, g.dirZ) || 1
  return FoliageGustStruct.pack({ ...g, dirX: g.dirX / len, dirZ: g.dirZ / len }, out as Float32Array<ArrayBuffer>, offset)
}

/** Pack live uniform-boundary foliage parameters into `FoliageWindConfig` (12 floats). */
export function packFoliageUniforms(
  params: Readonly<FoliageParams>,
  out: Float32Array = FoliageWindConfigStruct.createBuffer(),
  offset = 0,
): Float32Array {
  return FoliageWindConfigStruct.pack(params, out as Float32Array<ArrayBuffer>, offset)
}

/**
 * Pack up to eight actor ground positions (player, nearest zombies, Lab walkers) into `FoliageActors`.
 * Grass blades and bush leaves within `trampleRadius` bend away from them in the vertex shader. Presentation only.
 */
export function packFoliageActors(
  actors: readonly { x: number; z: number }[],
  out: Float32Array = FoliageActorsStruct.createBuffer(),
  offset = 0,
): Float32Array {
  const n = Math.min(FOLIAGE_MAX_ACTORS, actors.length)
  out[offset] = n
  out[offset + 1] = 0
  out[offset + 2] = 0
  out[offset + 3] = 0
  for (let i = 0; i < FOLIAGE_MAX_ACTORS; i++) {
    const a = i < n ? actors[i] : undefined
    out[offset + 4 + i * 2] = a ? a.x : 0
    out[offset + 5 + i * 2] = a ? a.z : 0
  }
  return out
}

/** The focus actor plus the nearest others within `radius` metres, capped at `FOLIAGE_MAX_ACTORS`. */
export function nearestFoliageActors(
  x: number,
  z: number,
  others: readonly { x: number; z: number }[],
  radius = 24,
): { x: number; z: number }[] {
  const near = others
    .map(o => ({ o, d: (o.x - x) ** 2 + (o.z - z) ** 2 }))
    .filter(e => e.d < radius * radius)
    .sort((a, b) => a.d - b.d)
    .slice(0, FOLIAGE_MAX_ACTORS - 1)
    .map(e => e.o)
  return [{ x, z }, ...near]
}

/**
 * Shared WGSL vertex displacement for `MAT.foliage` (22), used by Outbreak's scene shader and the Lab.
 * Declare these structs before any uniform struct that embeds them.
 */
export const foliageWindDeclarationsWgsl = /* wgsl */ `
${FoliageWindConfigStruct.wgsl}

${FoliageActorsStruct.wgsl}

fn defaultFoliageWindConfig() -> FoliageWindConfig {
  return FoliageWindConfig(
    0.24, 0.80, 0.42, 0.30,
    0.45, 0.55, 0.72, 0.88,
    0.30, 0.50, 1.10, 0.85
  );
}

${FoliageGustStruct.wgsl}

fn noFoliageActors() -> FoliageActors {
  return FoliageActors(0.0, 0.0, 0.0, 0.0, array<vec4f, 4>(vec4f(0.0), vec4f(0.0), vec4f(0.0), vec4f(0.0)));
}

/** Bush vertices carry aux = 3 + flex; tree canopies 0 < aux <= 1.45; grass blades aux < 0. */
fn foliageIsBush(aux: f32) -> bool { return aux > 2.5; }

/** Leaf-tip / blade-tip weight in 0..1 for translucency, rim and bending. */
fn foliageTipWeight(aux: f32) -> f32 {
  return select(clamp(abs(aux), 0.0, 1.0), clamp(aux - 3.0, 0.0, 1.0), aux > 2.5);
}

fn foliageTranslucency(aux: f32, cfg: FoliageWindConfig) -> f32 {
  return select(cfg.translucency, cfg.bushTranslucency, aux > 2.5);
}

/** Horizontal push away from nearby actors: (1 - d/R)^2 falloff, scaled by weight. */
fn foliageTrample(pos: vec3f, weight: f32, cfg: FoliageWindConfig, actors: FoliageActors) -> vec2f {
  let count = i32(actors.count);
  if (count <= 0 || weight <= 0.0 || cfg.trampleStrength <= 0.0) { return vec2f(0.0); }
  let R = max(0.05, cfg.trampleRadius);
  var ap = actors.p;
  var push = vec2f(0.0);
  for (var i = 0; i < 8; i++) {
    if (i >= count) { break; }
    let v = ap[i / 2];
    let a = select(v.xy, v.zw, (i & 1) == 1);
    let d = pos.xz - a;
    let dist = length(d);
    if (dist < R) {
      let f = 1.0 - dist / R;
      push += d / max(dist, 0.001) * f * f;
    }
  }
  return push * R * 0.5 * cfg.trampleStrength * weight;
}

/**
 * Hierarchical vertex displacement for MAT.foliage (mat == 22):
 * - 0 < aux <= 1.45: tree canopy; global bough sway plus leaf flutter weighted by height and aux.
 * - aux > 2.5: bush; lighter rustle and parting around actors, weight aux - 3.
 * - aux < -0.02: grass blade (bladeT = -aux) or fur shell (aux < -1.5); travelling 3-wave wind, actor trampling.
 */
fn applyFoliageVertexWind(pos: vec3f, normal: vec3f, aux: f32, time: f32, eye: vec3f, cfg: FoliageWindConfig, actors: FoliageActors) -> array<vec3f, 2> {
  var p = pos;
  var n = normal;
  if (aux > 2.5) {
    let flex = clamp(aux - 3.0, 0.0, 1.0);
    let phase = pos.x * 0.9 + pos.z * 0.7 + pos.y * 1.3;
    let s = cfg.bushWind * 0.05 * flex;
    let gust = 1.0 + 0.5 * sin(time * 0.7 + pos.x * 0.2 + pos.z * 0.15);
    let dx = (sin(time * 2.6 + phase) + 0.4 * sin(time * 5.3 + phase * 1.7)) * s * gust;
    let dz = (cos(time * 2.2 + phase * 0.8) + 0.4 * sin(time * 4.7 - phase * 1.3)) * s * 0.8 * gust;
    let push = foliageTrample(pos, flex * 0.75, cfg, actors);
    p.x += dx + push.x;
    p.z += dz + push.y;
    p.y -= length(push) * 0.35;
    n = normalize(n + vec3f(dx + push.x, 0.0, dz + push.y) * 2.0);
  } else if (aux > 0.0) {
    let flex = clamp((pos.y - 0.35) * 0.26, 0.06, 1.25) * (0.65 + 0.35 * clamp(aux, 0.0, 1.2));
    let freq = max(0.1, cfg.treeWindFreq);
    let strength = cfg.treeWindStrength * 0.12 * flex;
    let gustEnv = 1.0 + cfg.treeWindGust * (0.42 * sin(time * 0.65 + pos.x * 0.16 + pos.z * 0.12) + 0.24 * cos(time * 1.15 - pos.z * 0.18));
    let phase = pos.x * 0.48 + pos.z * 0.36 + pos.y * 0.28;
    let swayX = (sin(time * freq * 2.3 + phase) + 0.52 * sin(time * freq * 1.15 + phase * 1.6 + 1.2)) * strength * gustEnv;
    let swayZ = (cos(time * freq * 1.9 + phase * 0.9) + 0.44 * sin(time * freq * 0.95 - phase * 1.3)) * strength * 0.78 * gustEnv;
    let flutter = sin(time * freq * 4.2 + dot(pos, vec3f(3.7, 5.1, 4.1))) * strength * 0.18;
    let dx = swayX + flutter;
    let dz = swayZ - flutter * 0.7;
    p.x += dx;
    p.z += dz;
    p.y -= (abs(dx) + abs(dz)) * 0.14;
    n = normalize(n + vec3f(dx * 1.2, 0.0, dz * 1.2));
  } else if (aux < -0.02) {
    let isShell = aux < -1.5;
    let bladeT = select(clamp(-aux, 0.0, 1.0), clamp(-aux - 2.0, 0.0, 1.0), isShell);
    let bendWeight = bladeT * bladeT;
    let dist = length(eye - pos);
    let fade = 1.0 - smoothstep(34.0, 72.0, dist) * cfg.distanceFade * 0.55;
    let windDir = vec2f(0.88, 0.47);
    let crossDir = vec2f(-0.47, 0.88);
    let freq = 0.42;
    let speed = 1.45;
    let l = dot(pos.xz, windDir) * freq + time * speed;
    let u = dot(pos.xz, crossDir) * freq;
    let phi = fract(sin(dot(floor(pos.xz * 4.0), vec2f(12.9898, 78.233))) * 43758.5453) * 6.28318;
    let swell = sin(l + phi);
    let gust = sin(l * 0.37 + u * 0.90 + time * speed * 0.31 + phi * 0.73);
    let turb = sin(l * 2.30 - u * 1.70 + time * speed * 1.90 + phi * 1.37);
    let flutter = sin(time * 5.0 + pos.x * 0.35 + pos.z * 0.22 + bladeT * 2.5 + phi) * 0.16;
    let scaleAmt = select(0.13, 0.085, isShell);
    let along = (swell * 0.62 + gust * 0.42 + turb * 0.16 + flutter) * cfg.grassWind * scaleAmt * bendWeight * fade;
    let across = (gust * 0.22 + turb * 0.12 + flutter * 0.6) * cfg.grassWind * (scaleAmt * 0.7) * bendWeight * fade;
    let push = foliageTrample(pos, bladeT, cfg, actors);
    let wx = windDir.x * along + crossDir.x * across + push.x;
    let wz = windDir.y * along + crossDir.y * across + push.y;
    p.x += wx;
    p.z += wz;
    if (!isShell) {
      p.y -= (wx * wx + wz * wz) * 1.45 + (abs(wx) + abs(wz)) * 0.14 * bladeT + length(push) * 0.45 * bladeT;
    }
    n = normalize(n + vec3f(wx * 3.6, 0.0, wz * 3.6));
  }
  return array<vec3f, 2>(p, n);
}

fn foliageGustHash(p: vec2f) -> f32 {
  let q = fract(p * vec2f(0.1031, 0.1030));
  let r = q + dot(q, q.yx + 33.33);
  return fract((r.x + r.y) * r.x);
}

/** Smooth value noise (quintic fade): band-limited, so the field never adds detail finer than its cell. */
fn foliageGustNoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = p - i;
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  let a = foliageGustHash(i);
  let b = foliageGustHash(i + vec2f(1.0, 0.0));
  let c = foliageGustHash(i + vec2f(0.0, 1.0));
  let d = foliageGustHash(i + vec2f(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

/**
 * Gust strength 0..~1.2 at a ground point: elongated gust fronts (cells \`gustScale\` long downwind, 1.6x wider across)
 * travel downwind at \`gustSpeed\`, over a slow town-wide swell. A pure function of position and sim time, so co-op
 * clients see the same gusts.
 */
fn foliageGustAt(xz: vec2f, time: f32, g: FoliageGust) -> f32 {
  let dir = vec2f(g.dirX, g.dirZ);
  let across = vec2f(-dir.y, dir.x);
  let s = max(4.0, g.gustScale);
  let u = (dot(xz, dir) - time * g.gustSpeed) / s;
  let v = dot(xz, across) / (s * 1.6);
  let n = foliageGustNoise(vec2f(u, v)) * 0.65 + foliageGustNoise(vec2f(u * 2.1 + 3.7, v * 2.1 - 1.3)) * 0.35;
  let front = smoothstep(0.32, 0.82, n);
  let swell = 0.5 + 0.5 * sin(time * 0.21 + 1.3);
  return front * (0.6 + 0.6 * swell);
}

/** Bough-level displacement shared by canopies and their limbs: a downwind lean in gusts plus a slow branch sway. */
fn foliageBoughSway(pos: vec3f, time: f32, wind: f32, g: FoliageGust, cfg: FoliageWindConfig) -> vec2f {
  let dir = vec2f(g.dirX, g.dirZ);
  let across = vec2f(-dir.y, dir.x);
  let hw = clamp((pos.y - 0.35) * 0.26, 0.0, 1.25);
  let bend = hw * sqrt(hw);
  let fq = max(0.1, cfg.treeWindFreq);
  let ph = dot(pos, vec3f(0.55, 0.31, 0.47));
  let oscA = sin(time * fq * 1.9 + ph) * 0.62 + sin(time * fq * 3.1 + ph * 1.7 + 1.1) * 0.38;
  let oscB = sin(time * fq * 1.6 - ph * 1.3 + 2.3);
  let lean = wind * 0.30;
  let osc = 0.10 * (0.35 + wind);
  return (dir * (lean + oscA * osc) + across * (oscB * osc * 0.6)) * g.branchSway * bend;
}

/**
 * Wind for foliage (\`mat\` 22) and swaying tree limbs (\`mat\` 24 with aux >= ${FOLIAGE_LIMB_AUX}): with \`g.on\` 0 it is exactly
 * \`applyFoliageVertexWind\` (limbs stay still). With the field on, one travelling gust field drives three layers:
 * bough sway (canopies and their limbs together; trunks barely move), leaf flutter (small, fading with distance from the
 * camera so it never glitters) and shrub and blade bend; the canopy parts around the first actor within \`canopyOpen\` m.
 */
fn applyFoliageWindField(pos: vec3f, normal: vec3f, aux: f32, mat: f32, time: f32, eye: vec3f, cfg: FoliageWindConfig, g: FoliageGust, actors: FoliageActors) -> array<vec3f, 2> {
  let isLimb = mat > 23.5;
  if (g.on < 0.5) {
    if (isLimb) { return array<vec3f, 2>(pos, normal); }
    return applyFoliageVertexWind(pos, normal, aux, time, eye, cfg, actors);
  }
  var p = pos;
  var n = normal;
  let dir = vec2f(g.dirX, g.dirZ);
  let across = vec2f(-dir.y, dir.x);
  let gust = foliageGustAt(pos.xz, time, g);
  let wind = g.strength * (0.3 + 0.9 * gust);
  // Leaf flutter fades out away from the camera's ground point, before it can turn into per-pixel shimmer.
  let near = 1.0 - smoothstep(26.0, 52.0, length(pos.xz - eye.xz));
  if (isLimb) {
    let flex = clamp(aux - ${FOLIAGE_LIMB_AUX}.0, 0.0, 1.0);
    // Boughs follow their clumps (flex 1 at the clump); the trunk (flex <= 0.12) only leans by \`trunkBend\`.
    let sway = foliageBoughSway(pos, time, wind, g, cfg) * flex * mix(g.trunkBend, 1.0, smoothstep(0.1, 0.3, flex));
    p.x += sway.x;
    p.z += sway.y;
    return array<vec3f, 2>(p, n);
  }
  if (aux > 2.5) {
    let flex = clamp(aux - 3.0, 0.0, 1.0);
    let ph = pos.x * 0.9 + pos.z * 0.7 + pos.y * 1.3;
    let rustle = (sin(time * 2.6 + ph) + 0.4 * sin(time * 5.3 + ph * 1.7)) * (0.3 + wind) * 0.05;
    let lean = wind * 0.09;
    let sway = (dir * (lean + rustle) + across * rustle * 0.6) * g.bushSway * flex;
    let flutter = sin(time * 11.0 + dot(pos, vec3f(4.3, 6.1, 5.2))) * g.leafFlutter * 0.018 * (0.3 + wind) * flex * near;
    let push = foliageTrample(pos, flex * 0.75, cfg, actors);
    p.x += sway.x + push.x + flutter * across.x;
    p.z += sway.y + push.y + flutter * across.y;
    p.y -= length(push) * 0.35 + length(sway) * 0.2;
    n = normalize(n + vec3f(sway.x + push.x, 0.0, sway.y + push.y) * 2.0 + vec3f(across.x, 0.0, across.y) * flutter * 9.0);
  } else if (aux > 0.0) {
    let tip = clamp(aux, 0.0, 1.0);
    let sway = foliageBoughSway(pos, time, wind, g, cfg);
    let fl = sin(time * 11.0 + dot(pos, vec3f(4.3, 6.1, 5.2))) * 0.65 + sin(time * 17.0 + dot(pos, vec3f(-3.1, 5.3, 2.7))) * 0.35;
    let flutter = fl * g.leafFlutter * 0.03 * (0.3 + wind) * tip * near;
    p.x += sway.x + flutter * across.x;
    p.z += sway.y + flutter * across.y;
    p.y -= length(sway) * 0.18 - flutter * 0.4;
    // Leaves turning in the wind: the normal rocks with the flutter, so lit leaves catch and lose the light.
    n = normalize(n + vec3f(sway.x, 0.0, sway.y) * 1.2 + vec3f(across.x, 0.6, across.y) * flutter * 10.0);
    if (g.canopyOpen > 0.05 && actors.count > 0.5 && pos.y > 1.7) {
      let d = pos.xz - actors.p[0].xy;
      let dist = length(d);
      let R = g.canopyOpen;
      if (dist < R) {
        let f = 1.0 - dist / R;
        let k = f * f * R * 0.8 * smoothstep(1.7, 2.5, pos.y);
        p.x += d.x / max(dist, 0.05) * k;
        p.z += d.y / max(dist, 0.05) * k;
        p.y -= k * 0.25;
      }
    }
  } else if (aux < -0.02) {
    let isShell = aux < -1.5;
    let bladeT = select(clamp(-aux, 0.0, 1.0), clamp(-aux - 2.0, 0.0, 1.0), isShell);
    let bendWeight = bladeT * bladeT;
    let fade = 1.0 - smoothstep(34.0, 72.0, length(eye - pos)) * cfg.distanceFade * 0.55;
    let l = dot(pos.xz, dir) * 0.42 + time * 1.45;
    let u = dot(pos.xz, across) * 0.42;
    let phi = fract(sin(dot(floor(pos.xz * 4.0), vec2f(12.9898, 78.233))) * 43758.5453) * 6.28318;
    let swell = sin(l + phi);
    let turb = sin(l * 2.30 - u * 1.70 + time * 2.75 + phi * 1.37);
    let flutter = sin(time * 5.0 + pos.x * 0.35 + pos.z * 0.22 + bladeT * 2.5 + phi) * 0.16;
    let scaleAmt = select(0.13, 0.085, isShell);
    let amt = cfg.grassWind * g.grassSway * scaleAmt * bendWeight * fade;
    // Gust fronts lay the blades over downwind as they pass: visible bands rolling across a lawn.
    let along = (gust * 1.1 * g.strength + (swell * 0.45 + turb * 0.16 + flutter) * (0.4 + wind)) * amt;
    let acrossAmt = (turb * 0.14 + flutter * 0.6) * (0.4 + wind) * amt * 0.7;
    let push = foliageTrample(pos, bladeT, cfg, actors);
    let wx = dir.x * along + across.x * acrossAmt + push.x;
    let wz = dir.y * along + across.y * acrossAmt + push.y;
    p.x += wx;
    p.z += wz;
    if (!isShell) {
      p.y -= (wx * wx + wz * wz) * 1.45 + (abs(wx) + abs(wz)) * 0.14 * bladeT + length(push) * 0.45 * bladeT;
    }
    n = normalize(n + vec3f(wx * 3.6, 0.0, wz * 3.6));
  }
  return array<vec3f, 2>(p, n);
}
`
