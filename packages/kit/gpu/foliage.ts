import { MAT, Mesh, type Rgb } from "./mesh"
import { Rng } from "../sim/rng"

export type FoliagePresetId = "oak" | "maple" | "birch" | "pine" | "hydrangea"
export type FoliageCrownShape = "dome" | "layered" | "columnar" | "conical" | "spreading"
export type FoliageCameraMode = "close" | "game"
export type FoliageStageMode = "lot" | "swatch"
export type FoliageCompareMode = 0 | 1 | 2

export type FoliageNumericKey =
  // Tree (19 numeric parameters)
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
  // Grass (15 numeric parameters)
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
  | "grassWind"
  | "distanceFade"

export type FoliageParams = Record<FoliageNumericKey, number> & {
  treePreset: FoliagePresetId
  crownShape: FoliageCrownShape
}

export type FoliageParamSpec = {
  key: FoliageNumericKey
  label: string
  group: "Tree Structure" | "Tree Canopy & Shading" | "Tree Wind" | "Grass Blades" | "Grass Colour & Wind"
  min: number
  max: number
  step: number
  unit: "" | "m" | "°" | "×" | "Hz"
  /**
   * Update boundary per docs/lab.md:
   * - "structural": rebuilds tree/grass meshes deterministically from `seed`.
   * - "uniform": updates shader uniform live without rebuilding meshes.
   */
  boundary: "structural" | "uniform"
}

export const FOLIAGE_PARAM_SPECS: readonly FoliageParamSpec[] = [
  // Tree Structure
  { key: "treeHeight", label: "Height", group: "Tree Structure", min: 1.2, max: 7.5, step: 0.1, unit: "m", boundary: "structural" },
  { key: "crownRadius", label: "Crown radius", group: "Tree Structure", min: 0.7, max: 3.8, step: 0.05, unit: "m", boundary: "structural" },
  { key: "branchCount", label: "Branch count", group: "Tree Structure", min: 3, max: 10, step: 1, unit: "", boundary: "structural" },
  { key: "branchAngle", label: "Branch angle", group: "Tree Structure", min: 18, max: 78, step: 1, unit: "°", boundary: "structural" },
  { key: "clumpCount", label: "Clump count", group: "Tree Structure", min: 1, max: 5, step: 1, unit: "", boundary: "structural" },
  { key: "clumpSize", label: "Clump size", group: "Tree Structure", min: 0.35, max: 1.65, step: 0.05, unit: "m", boundary: "structural" },
  { key: "leafCardSize", label: "Leaf card size", group: "Tree Structure", min: 0.12, max: 0.75, step: 0.02, unit: "m", boundary: "structural" },
  { key: "porosity", label: "Crown porosity", group: "Tree Structure", min: 0.0, max: 0.85, step: 0.05, unit: "", boundary: "structural" },
  // Tree Canopy & Shading
  { key: "treeColorR", label: "Base red", group: "Tree Canopy & Shading", min: 0.08, max: 0.85, step: 0.01, unit: "", boundary: "structural" },
  { key: "treeColorG", label: "Base green", group: "Tree Canopy & Shading", min: 0.12, max: 0.85, step: 0.01, unit: "", boundary: "structural" },
  { key: "treeColorB", label: "Base blue", group: "Tree Canopy & Shading", min: 0.05, max: 0.65, step: 0.01, unit: "", boundary: "structural" },
  { key: "treeColorVariation", label: "Colour variation", group: "Tree Canopy & Shading", min: 0.0, max: 1.0, step: 0.02, unit: "", boundary: "structural" },
  { key: "autumnMix", label: "Autumn mix", group: "Tree Canopy & Shading", min: 0.0, max: 1.0, step: 0.02, unit: "", boundary: "structural" },
  { key: "translucency", label: "Translucency", group: "Tree Canopy & Shading", min: 0.0, max: 1.0, step: 0.02, unit: "", boundary: "uniform" },
  { key: "canopyAO", label: "Canopy AO", group: "Tree Canopy & Shading", min: 0.0, max: 1.0, step: 0.02, unit: "", boundary: "structural" },
  { key: "normalSoftness", label: "Normal softness", group: "Tree Canopy & Shading", min: 0.0, max: 1.0, step: 0.02, unit: "", boundary: "structural" },
  // Tree Wind
  { key: "treeWindStrength", label: "Wind strength", group: "Tree Wind", min: 0.0, max: 1.0, step: 0.02, unit: "", boundary: "uniform" },
  { key: "treeWindFreq", label: "Wind frequency", group: "Tree Wind", min: 0.2, max: 3.0, step: 0.05, unit: "Hz", boundary: "uniform" },
  { key: "treeWindGust", label: "Wind gust", group: "Tree Wind", min: 0.0, max: 1.0, step: 0.02, unit: "", boundary: "uniform" },
  // Grass Blades
  { key: "grassDensity", label: "Grass density", group: "Grass Blades", min: 0.25, max: 2.5, step: 0.05, unit: "×", boundary: "structural" },
  { key: "bladeHeight", label: "Blade height", group: "Grass Blades", min: 0.06, max: 0.55, step: 0.01, unit: "m", boundary: "structural" },
  { key: "bladeWidth", label: "Blade width", group: "Grass Blades", min: 0.015, max: 0.12, step: 0.005, unit: "m", boundary: "structural" },
  { key: "bladeCurvature", label: "Blade curvature", group: "Grass Blades", min: 0.0, max: 1.0, step: 0.02, unit: "", boundary: "structural" },
  { key: "grassClumping", label: "Clumping", group: "Grass Blades", min: 0.0, max: 1.0, step: 0.02, unit: "", boundary: "structural" },
  // Grass Colour & Wind
  { key: "rootColorR", label: "Root red", group: "Grass Colour & Wind", min: 0.04, max: 0.65, step: 0.01, unit: "", boundary: "structural" },
  { key: "rootColorG", label: "Root green", group: "Grass Colour & Wind", min: 0.06, max: 0.70, step: 0.01, unit: "", boundary: "structural" },
  { key: "rootColorB", label: "Root blue", group: "Grass Colour & Wind", min: 0.03, max: 0.50, step: 0.01, unit: "", boundary: "structural" },
  { key: "tipColorR", label: "Tip red", group: "Grass Colour & Wind", min: 0.12, max: 0.90, step: 0.01, unit: "", boundary: "structural" },
  { key: "tipColorG", label: "Tip green", group: "Grass Colour & Wind", min: 0.18, max: 0.92, step: 0.01, unit: "", boundary: "structural" },
  { key: "tipColorB", label: "Tip blue", group: "Grass Colour & Wind", min: 0.06, max: 0.65, step: 0.01, unit: "", boundary: "structural" },
  { key: "grassVariation", label: "Colour variation", group: "Grass Colour & Wind", min: 0.0, max: 1.0, step: 0.02, unit: "", boundary: "structural" },
  { key: "dryPatches", label: "Dry patches", group: "Grass Colour & Wind", min: 0.0, max: 1.0, step: 0.02, unit: "", boundary: "structural" },
  { key: "grassWind", label: "Grass wind", group: "Grass Colour & Wind", min: 0.0, max: 1.0, step: 0.02, unit: "", boundary: "uniform" },
  { key: "distanceFade", label: "Distance fade", group: "Grass Colour & Wind", min: 0.0, max: 1.0, step: 0.02, unit: "", boundary: "uniform" },
] as const

export type FoliagePresetDef = {
  id: FoliagePresetId
  label: string
  summary: string
  defaults: Readonly<FoliageParams>
}

const COMMON_GRASS_DEFAULTS = {
  grassDensity: 1.0,
  bladeHeight: 0.30,
  bladeWidth: 0.058,
  bladeCurvature: 0.62,
  grassClumping: 0.82,
  rootColorR: 0.12,
  rootColorG: 0.20,
  rootColorB: 0.08,
  tipColorR: 0.30,
  tipColorG: 0.43,
  tipColorB: 0.19,
  grassVariation: 0.62,
  dryPatches: 0.28,
  grassWind: 0.48,
  distanceFade: 0.55,
} as const

export const FOLIAGE_PRESETS: Readonly<Record<FoliagePresetId, FoliagePresetDef>> = {
  oak: {
    id: "oak",
    label: "Street Oak (Broadleaf)",
    summary: "Spreading broadleaf dome with 3-shell sub-crown leaf bouquets, spherized normals, deep interior AO, and clumped meadow grass.",
    defaults: {
      treePreset: "oak",
      crownShape: "dome",
      treeHeight: 5.2,
      crownRadius: 2.35,
      branchCount: 6,
      branchAngle: 44,
      clumpCount: 2,
      clumpSize: 0.95,
      leafCardSize: 0.28,
      porosity: 0.35,
      treeColorR: 0.19,
      treeColorG: 0.30,
      treeColorB: 0.14,
      treeColorVariation: 0.62,
      autumnMix: 0.18,
      translucency: 0.26,
      canopyAO: 0.78,
      normalSoftness: 0.90,
      treeWindStrength: 0.26,
      treeWindFreq: 0.80,
      treeWindGust: 0.42,
      ...COMMON_GRASS_DEFAULTS,
    },
  },
  maple: {
    id: "maple",
    label: "Autumn Maple (Layered)",
    summary: "Tiered horizontal bough shelves with warm amber-ochre peripheral leaf bouquets and golden-straw lawn patches.",
    defaults: {
      treePreset: "maple",
      crownShape: "layered",
      treeHeight: 4.9,
      crownRadius: 2.45,
      branchCount: 7,
      branchAngle: 52,
      clumpCount: 3,
      clumpSize: 0.86,
      leafCardSize: 0.26,
      porosity: 0.45,
      treeColorR: 0.46,
      treeColorG: 0.43,
      treeColorB: 0.19,
      treeColorVariation: 0.68,
      autumnMix: 0.66,
      translucency: 0.58,
      canopyAO: 0.64,
      normalSoftness: 0.86,
      treeWindStrength: 0.34,
      treeWindFreq: 0.90,
      treeWindGust: 0.50,
      ...COMMON_GRASS_DEFAULTS,
      dryPatches: 0.44,
    },
  },
  birch: {
    id: "birch",
    label: "Silver Birch (Airy)",
    summary: "Slender upright white-barked crown with high porosity, fine fluttering leaf sprigs, and tall feathery grass.",
    defaults: {
      treePreset: "birch",
      crownShape: "columnar",
      treeHeight: 5.8,
      crownRadius: 1.75,
      branchCount: 6,
      branchAngle: 32,
      clumpCount: 2,
      clumpSize: 0.74,
      leafCardSize: 0.22,
      porosity: 0.55,
      treeColorR: 0.36,
      treeColorG: 0.48,
      treeColorB: 0.21,
      treeColorVariation: 0.52,
      autumnMix: 0.36,
      translucency: 0.64,
      canopyAO: 0.58,
      normalSoftness: 0.84,
      treeWindStrength: 0.42,
      treeWindFreq: 1.15,
      treeWindGust: 0.55,
      ...COMMON_GRASS_DEFAULTS,
      bladeHeight: 0.34,
      bladeCurvature: 0.72,
    },
  },
  pine: {
    id: "pine",
    label: "Conifer Pine (Spire)",
    summary: "Conical evergreen tiers with downward-swept boughs, dense needle sprays, and shaded understory turf.",
    defaults: {
      treePreset: "pine",
      crownShape: "conical",
      treeHeight: 6.2,
      crownRadius: 2.0,
      branchCount: 8,
      branchAngle: 62,
      clumpCount: 2,
      clumpSize: 0.82,
      leafCardSize: 0.24,
      porosity: 0.25,
      treeColorR: 0.20,
      treeColorG: 0.34,
      treeColorB: 0.16,
      treeColorVariation: 0.40,
      autumnMix: 0.08,
      translucency: 0.36,
      canopyAO: 0.76,
      normalSoftness: 0.82,
      treeWindStrength: 0.22,
      treeWindFreq: 0.75,
      treeWindGust: 0.40,
      ...COMMON_GRASS_DEFAULTS,
      rootColorR: 0.10,
      rootColorG: 0.17,
      rootColorB: 0.07,
    },
  },
  hydrangea: {
    id: "hydrangea",
    label: "Garden Hydrangea (Shrub)",
    summary: "Compact multi-stemmed foundation shrub with lush peripheral leaf sprigs and creamy-white panicle blooms.",
    defaults: {
      treePreset: "hydrangea",
      crownShape: "spreading",
      treeHeight: 1.65,
      crownRadius: 1.25,
      branchCount: 5,
      branchAngle: 56,
      clumpCount: 2,
      clumpSize: 0.58,
      leafCardSize: 0.20,
      porosity: 0.20,
      treeColorR: 0.29,
      treeColorG: 0.42,
      treeColorB: 0.18,
      treeColorVariation: 0.48,
      autumnMix: 0.12,
      translucency: 0.50,
      canopyAO: 0.68,
      normalSoftness: 0.88,
      treeWindStrength: 0.24,
      treeWindFreq: 0.95,
      treeWindGust: 0.38,
      ...COMMON_GRASS_DEFAULTS,
    },
  },
}

export const FOLIAGE_PRESET_IDS = Object.keys(FOLIAGE_PRESETS) as readonly FoliagePresetId[]
export const FOLIAGE_CROWN_SHAPES: readonly { value: FoliageCrownShape; label: string }[] = [
  { value: "dome", label: "Broadleaf dome" },
  { value: "layered", label: "Layered bough tiers" },
  { value: "columnar", label: "Airy columnar" },
  { value: "conical", label: "Conical spire" },
  { value: "spreading", label: "Spreading shrub" },
]

export function isFoliagePresetId(value: unknown): value is FoliagePresetId {
  return typeof value === "string" && value in FOLIAGE_PRESETS
}

export function isFoliageCrownShape(value: unknown): value is FoliageCrownShape {
  return typeof value === "string" && FOLIAGE_CROWN_SHAPES.some(s => s.value === value)
}

export function cloneFoliageParams(presetId: FoliagePresetId = "oak"): FoliageParams {
  return { ...FOLIAGE_PRESETS[presetId].defaults }
}

/** Shared production foliage settings consumed by Outbreak level build and Lab Foliage workbench. */
export const foliageSettings: FoliageParams = cloneFoliageParams("oak")

export function resetFoliageParams(presetId: FoliagePresetId = "oak", target: FoliageParams = foliageSettings): FoliageParams {
  Object.assign(target, FOLIAGE_PRESETS[presetId].defaults)
  return target
}

function snapToStep(value: number, spec: FoliageParamSpec): number {
  const clamped = Math.max(spec.min, Math.min(spec.max, value))
  const steps = Math.round((clamped - spec.min) / spec.step)
  return Number(Math.min(spec.max, Math.max(spec.min, spec.min + steps * spec.step)).toPrecision(12))
}

export function validateFoliageParams(
  input: unknown,
): { ok: true; value: FoliageParams } | { ok: false; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "Foliage parameters must be an object." }
  }
  const raw = input as Record<string, unknown>
  const preset: FoliagePresetId = isFoliagePresetId(raw.treePreset) ? raw.treePreset : "oak"
  const shape: FoliageCrownShape = isFoliageCrownShape(raw.crownShape) ? raw.crownShape : FOLIAGE_PRESETS[preset].defaults.crownShape
  const out = { treePreset: preset, crownShape: shape } as FoliageParams
  for (const spec of FOLIAGE_PARAM_SPECS) {
    const v = raw[spec.key]
    if (typeof v !== "number" || !Number.isFinite(v)) {
      return { ok: false, error: `Invalid or non-finite foliage parameter "${spec.key}".` }
    }
    if (v < spec.min - 1e-6 || v > spec.max + 1e-6) {
      return { ok: false, error: `Parameter "${spec.key}" (${v}) is outside [${spec.min}, ${spec.max}].` }
    }
    out[spec.key] = snapToStep(v, spec)
  }
  return { ok: true, value: out }
}

const specMap = new Map<FoliageNumericKey, FoliageParamSpec>(FOLIAGE_PARAM_SPECS.map(s => [s.key, s]))
function snapKey(key: FoliageNumericKey, value: number): number {
  return snapToStep(value, specMap.get(key)!)
}

/**
 * Deterministic, botanically constrained parameter randomization using an isolated `tuningSeed`.
 * Leaves structural `seed` unchanged and constrains height/crown/leaf ratios and chlorophyll palettes
 * to plausible combinations.
 */
export function randomizeFoliageParams(
  base: Readonly<FoliageParams>,
  tuningSeed: number,
  scope: "all" | "tree" | "grass" = "all",
): FoliageParams {
  const rng = new Rng((Math.trunc(tuningSeed) || 1) ^ 0x85ebca6b)
  const out: FoliageParams = { ...base }

  if (scope === "all" || scope === "tree") {
    const presetDefaults = FOLIAGE_PRESETS[base.treePreset]?.defaults ?? FOLIAGE_PRESETS.oak.defaults
    const isShrub = base.treePreset === "hydrangea" || base.crownShape === "spreading"
    const isSlender = base.crownShape === "columnar" || base.crownShape === "conical"

    const hLo = isShrub ? 1.3 : 3.8
    const hHi = isShrub ? 2.4 : 6.8
    out.treeHeight = snapKey("treeHeight", hLo + rng.next() * (hHi - hLo))

    const aspect = isShrub ? 0.62 + rng.next() * 0.26 : isSlender ? 0.28 + rng.next() * 0.14 : 0.38 + rng.next() * 0.18
    out.crownRadius = snapKey("crownRadius", out.treeHeight * aspect)
    out.branchCount = snapKey("branchCount", isShrub ? 4 + Math.floor(rng.next() * 3) : 5 + Math.floor(rng.next() * 4))
    out.branchAngle = snapKey("branchAngle", isSlender ? 26 + rng.next() * 28 : 34 + rng.next() * 28)
    out.clumpCount = snapKey("clumpCount", 1 + Math.floor(rng.next() * 3))
    out.clumpSize = snapKey("clumpSize", out.crownRadius * (0.34 + rng.next() * 0.16))
    out.leafCardSize = snapKey("leafCardSize", out.clumpSize * (0.24 + rng.next() * 0.12))
    out.porosity = snapKey("porosity", 0.15 + rng.next() * 0.45)

    // Keep chlorophyll green dominant (G >= R*0.85, B <= G*0.65) so trees never turn neon magenta/cyan.
    const g = Math.max(0.28, Math.min(0.56, presetDefaults.treeColorG + (rng.next() - 0.5) * 0.16))
    const r = Math.max(0.18, Math.min(g * 1.06, presetDefaults.treeColorR + (rng.next() - 0.5) * 0.16))
    const b = Math.max(0.12, Math.min(g * 0.62, presetDefaults.treeColorB + (rng.next() - 0.5) * 0.10))
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

  if (scope === "all" || scope === "grass") {
    out.grassDensity = snapKey("grassDensity", 0.75 + rng.next() * 0.95)
    out.bladeHeight = snapKey("bladeHeight", 0.18 + rng.next() * 0.22)
    out.bladeWidth = snapKey("bladeWidth", 0.035 + rng.next() * 0.045)
    out.bladeCurvature = snapKey("bladeCurvature", 0.40 + rng.next() * 0.48)
    out.grassClumping = snapKey("grassClumping", 0.55 + rng.next() * 0.40)

    const rootG = 0.14 + rng.next() * 0.11
    const rootR = rootG * (0.58 + rng.next() * 0.20)
    const rootB = rootG * (0.36 + rng.next() * 0.14)
    out.rootColorR = snapKey("rootColorR", rootR)
    out.rootColorG = snapKey("rootColorG", rootG)
    out.rootColorB = snapKey("rootColorB", rootB)

    const tipG = Math.min(0.72, rootG * (2.15 + rng.next() * 0.65))
    const tipR = Math.min(0.66, tipG * (0.72 + rng.next() * 0.24))
    const tipB = Math.min(0.40, tipG * (0.36 + rng.next() * 0.16))
    out.tipColorR = snapKey("tipColorR", tipR)
    out.tipColorG = snapKey("tipColorG", tipG)
    out.tipColorB = snapKey("tipColorB", tipB)
    out.grassVariation = snapKey("grassVariation", 0.40 + rng.next() * 0.44)
    out.dryPatches = snapKey("dryPatches", 0.12 + rng.next() * 0.48)
    out.grassWind = snapKey("grassWind", 0.24 + rng.next() * 0.48)
    out.distanceFade = snapKey("distanceFade", 0.36 + rng.next() * 0.44)
  }

  return out
}

export type FoliagePresetV1 = {
  version: 1
  seed: number
  tuningSeed: number
  cameraMode: FoliageCameraMode
  stageMode?: FoliageStageMode
  compare: FoliageCompareMode
  lightingPreset: string
  params: FoliageParams
}

export function exportFoliagePreset(input: Omit<FoliagePresetV1, "version">): FoliagePresetV1 {
  const checked = validateFoliageParams(input.params)
  if (!checked.ok) throw new Error(checked.error)
  return {
    version: 1,
    seed: Math.max(1, Math.min(999, Math.trunc(input.seed) || 7)),
    tuningSeed: Math.max(1, Math.min(9999, Math.trunc(input.tuningSeed) || 41)),
    cameraMode: input.cameraMode === "game" ? "game" : "close",
    stageMode: input.stageMode === "swatch" ? "swatch" : "lot",
    compare: input.compare === 0 ? 0 : input.compare === 2 ? 2 : 1,
    lightingPreset: input.lightingPreset || "outbreak_dusk",
    params: checked.value,
  }
}

export function importFoliagePreset(
  rawJson: string,
): { ok: true; value: FoliagePresetV1 } | { ok: false; error: string } {
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
  if (obj.version !== 1) {
    return { ok: false, error: `Unsupported foliage preset version: ${String(obj.version)} (expected 1).` }
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
  if (obj.compare !== 0 && obj.compare !== 1 && obj.compare !== 2) {
    return { ok: false, error: `Invalid compare mode: "${String(obj.compare)}".` }
  }
  const paramsRes = validateFoliageParams(obj.params)
  if (!paramsRes.ok) return paramsRes
  return {
    ok: true,
    value: {
      version: 1,
      seed: Math.trunc(obj.seed),
      tuningSeed: Math.trunc(obj.tuningSeed),
      cameraMode: obj.cameraMode,
      stageMode: obj.stageMode === "swatch" ? "swatch" : "lot",
      compare: obj.compare,
      lightingPreset: typeof obj.lightingPreset === "string" ? obj.lightingPreset : "outbreak_dusk",
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
): void {
  const rings: { pt: Point; n: Point }[][] = []
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
      m.vert(a0.pt, a0.n, colA, MAT.timber, 0)
      m.vert(b0.pt, b0.n, colB, MAT.timber, 0)
      m.vert(b1.pt, b1.n, colB, MAT.timber, 0)

      m.vert(a0.pt, a0.n, colA, MAT.timber, 0)
      m.vert(b1.pt, b1.n, colB, MAT.timber, 0)
      m.vert(a1.pt, a1.n, colA, MAT.timber, 0)
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

    m.vert(pBase, nBase, baseCol, MAT.foliage, flexWeight * 0.78)
    m.vert(pMidL, nMidL, midCol, MAT.foliage, flexWeight * 0.95)
    m.vert(pTip, nTip, tipCol, MAT.foliage, tipFlex)

    m.vert(pBase, nBase, baseCol, MAT.foliage, flexWeight * 0.78)
    m.vert(pTip, nTip, tipCol, MAT.foliage, tipFlex)
    m.vert(pMidR, nMidR, midCol, MAT.foliage, flexWeight * 0.95)
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

  // 5-sided cupped spherical cap (5 tris = 15 verts) forming a smooth overlapping 3D lobe puff
  const sides = 5
  const ring: Point[] = []
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2 + (rng.next() - 0.5) * 0.22
    const lobeReach = 0.94 + 0.22 * Math.sin(a * 2 + px * 1.7) + (rng.next() - 0.5) * 0.14
    const r = cardRadius * lobeReach
    const droop = cardRadius * 0.18
    const ca = Math.cos(a) * r
    const sa = Math.sin(a) * r
    ring.push([
      px + uAxis[0] * ca + vAxis[0] * sa - upBias[0] * droop,
      py + uAxis[1] * ca + vAxis[1] * sa - upBias[1] * droop - droop * 0.25,
      pz + uAxis[2] * ca + vAxis[2] * sa - upBias[2] * droop,
    ])
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
  const ringCols = ring.map(colorAt)
  const auxCenter = 0.85
  const auxRim = 0.35

  for (let i = 0; i < sides; i++) {
    const p0 = ring[i]!
    const p1 = ring[(i + 1) % sides]!
    const fnRaw = faceNormal(center, p0, p1)
    const fn: Point = fnRaw[1] < 0 ? [-fnRaw[0], -fnRaw[1], -fnRaw[2]] : fnRaw
    const nC = blendNormal(fn, domeNormalAt(center), soft)
    const n0 = blendNormal(fn, domeNormalAt(p0), soft)
    const n1 = blendNormal(fn, domeNormalAt(p1), soft)
    m.vert(center, nC, cCol, MAT.foliage, auxCenter)
    m.vert(p0, n0, ringCols[i]!, MAT.foliage, auxRim)
    m.vert(p1, n1, ringCols[(i + 1) % sides]!, MAT.foliage, auxRim)
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
): void {
  const domePivot: Point = [cx, cy - ry * 0.28, cz]
  // Note: vertex colors are sRGB (raised to ^2.2 in vs), so 0.48 sRGB = 0.20 linear (deep green interior shadow, never pitch black)
  const coreDark = Math.max(0.46, 0.72 - canopyAO * 0.32)
  const midShade = Math.max(0.66, 0.88 - canopyAO * 0.24)
  const deepCol = scaleRgb(base, coreDark)
  const midCol = scaleRgb(base, midShade)
  const sunlitCol = scaleRgb(base, 1.18)

  const totalCards = Math.max(8, Math.round(sprigDensity * 1.15))
  for (let s = 0; s < totalCards; s++) {
    const tierFrac = s / totalCards
    const isCore = tierFrac < 0.34
    const isMid = tierFrac >= 0.34 && tierFrac < 0.74

    const a = s * 2.39996 + (rng.next() - 0.5) * 0.28
    const rNorm = Math.sqrt((s + 0.25) / totalCards)
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
      0.10,
      leafCardScale * (isCore ? 1.45 : isMid ? 1.25 : 1.05) * (0.88 + rng.next() * 0.24),
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
    )
  }
  void flexBase
  void emitLeafSprig
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
  params: Readonly<FoliageParams> = foliageSettings,
  shapeOverride?: FoliageCrownShape,
): void {
  const rng = new Rng(seed)
  const isTree = h > 2.1
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

  const barkColor: Rgb =
    params.treePreset === "birch" || shape === "columnar"
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
  const autumn = clamp01(params.autumnMix * (isTree ? 0.85 + (Math.abs(seed * 7) % 5) * 0.12 : 0.45))
  const greenPalette: Rgb[] = [
    baseRgb,
    [
      clamp01(baseRgb[0] * (1 + 0.18 * varAmt)),
      clamp01(baseRgb[1] * (1 + 0.09 * varAmt)),
      clamp01(baseRgb[2] * (1 - 0.12 * varAmt)),
    ],
    [
      clamp01(baseRgb[0] * (1 - 0.18 * varAmt)),
      clamp01(baseRgb[1] * (1 - 0.14 * varAmt)),
      clamp01(baseRgb[2] * (1 - 0.08 * varAmt)),
    ],
    [
      clamp01(baseRgb[0] * (1 + 0.28 * varAmt)),
      clamp01(baseRgb[1] * (1 + 0.14 * varAmt)),
      clamp01(baseRgb[2] * (1 - 0.16 * varAmt)),
    ],
    [
      clamp01(baseRgb[0] * (1 - 0.10 * varAmt)),
      clamp01(baseRgb[1] * (1 - 0.06 * varAmt)),
      clamp01(baseRgb[2] * (1 + 0.06 * varAmt)),
    ],
  ]
  const autumnPalette: Rgb[] = [
    [0.52, 0.36, 0.14],
    [0.58, 0.28, 0.13],
    [0.44, 0.40, 0.15],
    [0.62, 0.42, 0.15],
    [0.36, 0.32, 0.14],
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
  const clumpsPerBough = isTree ? (isHeroTree ? Math.max(1, Math.round(params.clumpCount)) : 1) : 1
  const clumpScale = isTree
    ? params.clumpSize * Math.max(0.45, Math.min(1.65, radiusRatio))
    : radius * (0.50 + rng.next() * 0.14)
  const cardScale = isTree
    ? params.leafCardSize * Math.max(0.55, Math.min(1.55, radiusRatio))
    : Math.max(0.11, radius * 0.24)
  // Distance/perimeter LOD: full card density on hero street/house trees, lighter on outer town trees
  const sprigsPerClump = isTree ? (isHeroTree ? 8 : 5) : 5

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
      emitTaperedLimb(m, start, midCtrl, tip, rBough0, rBough0 * 0.28, barkColor, 3, 5, 0.22)
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
        emitTaperedLimb(m, forkStart, forkMid, [cx, cy, cz], 0.036, 0.014, barkColor, 2, 4, 0)
      }

      const clusterTone = palette[(b + cIdx + Math.floor(rng.next() * 2)) % palette.length]!
      const subScale = cIdx === 0 ? 1.0 : 0.78 + rng.next() * 0.18
      const rx = clumpScale * subScale * (inGap ? 0.72 : 0.92 + rng.next() * 0.22)
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
      )
    }
  }

  // Crown apex bouquet
  const crownTone = palette[seed % palette.length]!
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
  )

  if (params.treePreset === "hydrangea") {
    emitHydrangeaPanicles(m, x, ground, z, h, radius, seed)
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

/**
 * Emits delicate creamy-white / pale-celadon / warm-ivory hydrangea blossom flecks
 * nestled organically across the outer foliage of a corner bush.
 */
export function emitHydrangeaPanicles(
  m: Mesh,
  x: number,
  ground: number,
  z: number,
  h: number,
  radius: number,
  seed: number,
): void {
  const rng = new Rng(seed ^ 0x6f1a)
  const palette: readonly Rgb[] = [
    [0.82, 0.86, 0.78],
    [0.74, 0.80, 0.70],
    [0.88, 0.87, 0.78],
    [0.68, 0.75, 0.64],
  ]
  for (let i = 0; i < 16; i++) {
    const a = i * 2.39996 + (rng.next() - 0.5) * 0.36
    const rFrac = 0.22 + Math.sqrt((i + 0.4) / 16) * 0.74
    const dist = radius * rFrac
    const bx = x + Math.cos(a) * dist
    const bz = z + Math.sin(a) * dist * 0.92
    const domeY = Math.sqrt(Math.max(0.12, 1 - rFrac * rFrac * 0.72))
    const by = ground + h * (0.28 + domeY * 0.52) + (rng.next() - 0.5) * 0.08
    const mainR = 0.038 + rng.next() * 0.020
    const col = palette[i % palette.length]!
    const rimCol = scaleRgb(col, 0.78)
    m.prism(bx, bz, mainR, mainR * 0.68, by, by + mainR * 0.95, 5, col, MAT.foliage, 0.45)
    const sa = a + 1.2 + rng.next() * 0.9
    const sx = bx + Math.cos(sa) * mainR * 0.75
    const sz = bz + Math.sin(sa) * mainR * 0.75
    m.prism(sx, sz, mainR * 0.64, mainR * 0.46, by - 0.01, by + mainR * 0.76, 5, rimCol, MAT.foliage, 0.42)
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
    const shade = 0.88 + rng.next() * 0.26
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
  const center: Point = [x, y + height, z]
  const sides = 5
  const ring: Point[] = []
  const rot = rng.next() * Math.PI * 2
  for (let i = 0; i < sides; i++) {
    const a = rot + (i / sides) * Math.PI * 2 + (rng.next() - 0.5) * 0.36
    const r = radius * (i % 2 === 0 ? 1.15 + rng.next() * 0.25 : 0.72 + rng.next() * 0.22)
    ring.push([x + Math.cos(a) * r, y + 0.008, z + Math.sin(a) * r])
  }
  const cCol = scaleRgb(baseCol, 0.92 + rng.next() * 0.16)
  const rCol = scaleRgb(baseCol, 0.54 + rng.next() * 0.12)
  for (let i = 0; i < sides; i++) {
    const p0 = ring[i]!
    const p1 = ring[(i + 1) % sides]!
    const n0 = normalize3(p0[0] - x, radius * 1.45, p0[2] - z)
    const n1 = normalize3(p1[0] - x, radius * 1.45, p1[2] - z)
    m.vert(center, [0, 1, 0], cCol, MAT.foliage, 0.55)
    m.vert(p0, n0, rCol, MAT.foliage, 0.15)
    m.vert(p1, n1, rCol, MAT.foliage, 0.15)
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
    for (let i = 0; i < count; i++) {
      const angle = i * 2.39996 + rng.next() * 0.55
      const radialFrac = Math.sqrt((i + 0.2) / count)
      const dist = spread * radialFrac * (0.52 + rng.next() * 0.58)
      const tx = cx + Math.cos(angle) * dist
      const tz = cz + Math.sin(angle) * dist
      if (tx < x0 || tx > x1 || tz < z0 || tz > z1 || avoid?.(tx, tz)) continue

      const moundScale = (1.22 - radialFrac * 0.36 * params.grassClumping) * overgrownScale
      const shade = 0.86 + rng.next() * 0.28
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

/** Pack live uniform-boundary foliage parameters into 2 vec4f (8 floats). */
export function packFoliageUniforms(
  params: Readonly<FoliageParams>,
  out: Float32Array = new Float32Array(8),
  offset = 0,
): Float32Array {
  out[offset + 0] = params.treeWindStrength
  out[offset + 1] = params.treeWindFreq
  out[offset + 2] = params.treeWindGust
  out[offset + 3] = params.translucency
  out[offset + 4] = params.grassWind
  out[offset + 5] = params.distanceFade
  out[offset + 6] = params.canopyAO
  out[offset + 7] = params.normalSoftness
  return out
}

/**
 * Shared WGSL vertex displacement and fragment shading functions for `MAT.foliage` (22).
 * Used by both Outbreak's production scene shader and the Lab Foliage workbench.
 */
export const foliageWindDeclarationsWgsl = /* wgsl */ `
struct FoliageWindConfig {
  // x: treeWindStrength, y: treeWindFreq, z: treeWindGust, w: translucency
  u0: vec4f,
  // x: grassWind, y: distanceFade, z: canopyAO, w: normalSoftness
  u1: vec4f,
}

fn defaultFoliageWindConfig() -> FoliageWindConfig {
  return FoliageWindConfig(
    vec4f(0.24, 0.80, 0.42, 0.30),
    vec4f(0.45, 0.55, 0.72, 0.88)
  );
}

/**
 * Hierarchical vertex displacement for MAT.foliage (mat == 22):
 * - aux > 0.02: Tree/shrub canopy vertex with flexibility weight aux. Combines global bough sway
 *   with 3D spatial leaf-card flutter (Botanics applyTreeWind + Lamplight §3.2).
 * - aux < -0.02: Curved grass blade vertex with normalized root-to-tip coordinate bladeT = -aux.
 *   Applies Above the Grassland's 3-wave directional wind field with arc-length height preservation
 *   and top-down distance visibility compensation.
 */
fn applyFoliageVertexWind(pos: vec3f, normal: vec3f, aux: f32, time: f32, eye: vec3f, cfg: FoliageWindConfig) -> array<vec3f, 2> {
  var p = pos;
  var n = normal;
  if (aux > 0.0) {
    // Height-based bough flexibility + peripheral leaflet tip weight (aux) for organic two-stage sway
    let flex = clamp((pos.y - 0.35) * 0.26, 0.06, 1.25) * (0.65 + 0.35 * clamp(aux, 0.0, 1.2));
    let freq = max(0.1, cfg.u0.y);
    let strength = cfg.u0.x * 0.12 * flex;
    let gustEnv = 1.0 + cfg.u0.z * (0.42 * sin(time * 0.65 + pos.x * 0.16 + pos.z * 0.12) + 0.24 * cos(time * 1.15 - pos.z * 0.18));
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
    let fade = 1.0 - smoothstep(34.0, 72.0, dist) * cfg.u1.y * 0.55;
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
    let along = (swell * 0.62 + gust * 0.42 + turb * 0.16 + flutter) * cfg.u1.x * scaleAmt * bendWeight * fade;
    let across = (gust * 0.22 + turb * 0.12 + flutter * 0.6) * cfg.u1.x * (scaleAmt * 0.7) * bendWeight * fade;
    let wx = windDir.x * along + crossDir.x * across;
    let wz = windDir.y * along + crossDir.y * across;
    p.x += wx;
    p.z += wz;
    if (!isShell) {
      p.y -= (wx * wx + wz * wz) * 1.45 + (abs(wx) + abs(wz)) * 0.14 * bladeT;
    }
    n = normalize(n + vec3f(wx * 3.6, 0.0, wz * 3.6));
  }
  return array<vec3f, 2>(p, n);
}
`
