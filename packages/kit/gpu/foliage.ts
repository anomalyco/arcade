import { MAT, Mesh, type Rgb } from "./mesh"
import { Rng } from "../sim/rng"

export type FoliagePresetId = "oak" | "maple" | "birch" | "pine" | "hydrangea"
export type FoliageCrownShape = "dome" | "layered" | "columnar" | "conical" | "spreading"
export type FoliageCameraMode = "close" | "game"
export type FoliageCompareMode = 0 | 1 | 2

export type FoliageNumericKey =
  // Tree (18 numeric parameters)
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
  // Grass (14 numeric parameters)
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
  { key: "leafCardSize", label: "Leaf card size", group: "Tree Structure", min: 0.14, max: 0.80, step: 0.02, unit: "m", boundary: "structural" },
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
  { key: "bladeHeight", label: "Blade height", group: "Grass Blades", min: 0.06, max: 0.50, step: 0.01, unit: "m", boundary: "structural" },
  { key: "bladeWidth", label: "Blade width", group: "Grass Blades", min: 0.015, max: 0.11, step: 0.005, unit: "m", boundary: "structural" },
  { key: "bladeCurvature", label: "Blade curvature", group: "Grass Blades", min: 0.0, max: 1.0, step: 0.02, unit: "", boundary: "structural" },
  { key: "grassClumping", label: "Clumping", group: "Grass Blades", min: 0.0, max: 1.0, step: 0.02, unit: "", boundary: "structural" },
  // Grass Colour & Wind
  { key: "rootColorR", label: "Root red", group: "Grass Colour & Wind", min: 0.05, max: 0.65, step: 0.01, unit: "", boundary: "structural" },
  { key: "rootColorG", label: "Root green", group: "Grass Colour & Wind", min: 0.08, max: 0.70, step: 0.01, unit: "", boundary: "structural" },
  { key: "rootColorB", label: "Root blue", group: "Grass Colour & Wind", min: 0.04, max: 0.50, step: 0.01, unit: "", boundary: "structural" },
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
  bladeHeight: 0.22,
  bladeWidth: 0.045,
  bladeCurvature: 0.62,
  grassClumping: 0.78,
  rootColorR: 0.16,
  rootColorG: 0.23,
  rootColorB: 0.11,
  tipColorR: 0.43,
  tipColorG: 0.54,
  tipColorB: 0.27,
  grassVariation: 0.58,
  dryPatches: 0.28,
  grassWind: 0.42,
  distanceFade: 0.55,
} as const

export const FOLIAGE_PRESETS: Readonly<Record<FoliagePresetId, FoliagePresetDef>> = {
  oak: {
    id: "oak",
    label: "Street Oak (Broadleaf)",
    summary: "Spreading broadleaf dome with layered bough puffs, soft bent normals, deep interior AO, and clumped meadow grass.",
    defaults: {
      treePreset: "oak",
      crownShape: "dome",
      treeHeight: 5.2,
      crownRadius: 2.35,
      branchCount: 6,
      branchAngle: 44,
      clumpCount: 2,
      clumpSize: 0.95,
      leafCardSize: 0.38,
      porosity: 0.35,
      treeColorR: 0.34,
      treeColorG: 0.45,
      treeColorB: 0.22,
      treeColorVariation: 0.58,
      autumnMix: 0.24,
      translucency: 0.52,
      canopyAO: 0.64,
      normalSoftness: 0.82,
      treeWindStrength: 0.30,
      treeWindFreq: 0.85,
      treeWindGust: 0.45,
      ...COMMON_GRASS_DEFAULTS,
    },
  },
  maple: {
    id: "maple",
    label: "Autumn Maple (Layered)",
    summary: "Tiered horizontal bough shelves with warm amber-ochre peripheral foliage and golden-straw lawn patches.",
    defaults: {
      treePreset: "maple",
      crownShape: "layered",
      treeHeight: 4.9,
      crownRadius: 2.45,
      branchCount: 7,
      branchAngle: 52,
      clumpCount: 3,
      clumpSize: 0.85,
      leafCardSize: 0.36,
      porosity: 0.45,
      treeColorR: 0.46,
      treeColorG: 0.44,
      treeColorB: 0.21,
      treeColorVariation: 0.68,
      autumnMix: 0.64,
      translucency: 0.58,
      canopyAO: 0.60,
      normalSoftness: 0.80,
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
    summary: "Slender upright white-barked crown with high porosity, fine fluttering leaf cards, and tall feathery grass.",
    defaults: {
      treePreset: "birch",
      crownShape: "columnar",
      treeHeight: 5.8,
      crownRadius: 1.75,
      branchCount: 6,
      branchAngle: 32,
      clumpCount: 2,
      clumpSize: 0.72,
      leafCardSize: 0.28,
      porosity: 0.55,
      treeColorR: 0.38,
      treeColorG: 0.49,
      treeColorB: 0.24,
      treeColorVariation: 0.52,
      autumnMix: 0.36,
      translucency: 0.64,
      canopyAO: 0.52,
      normalSoftness: 0.76,
      treeWindStrength: 0.42,
      treeWindFreq: 1.15,
      treeWindGust: 0.55,
      ...COMMON_GRASS_DEFAULTS,
      bladeHeight: 0.27,
      bladeCurvature: 0.72,
    },
  },
  pine: {
    id: "pine",
    label: "Conifer Pine (Spire)",
    summary: "Conical evergreen tiers with downward-swept boughs, deep forest needles, and shaded understory turf.",
    defaults: {
      treePreset: "pine",
      crownShape: "conical",
      treeHeight: 6.2,
      crownRadius: 2.0,
      branchCount: 8,
      branchAngle: 62,
      clumpCount: 2,
      clumpSize: 0.80,
      leafCardSize: 0.32,
      porosity: 0.25,
      treeColorR: 0.22,
      treeColorG: 0.35,
      treeColorB: 0.18,
      treeColorVariation: 0.40,
      autumnMix: 0.08,
      translucency: 0.34,
      canopyAO: 0.74,
      normalSoftness: 0.72,
      treeWindStrength: 0.22,
      treeWindFreq: 0.75,
      treeWindGust: 0.40,
      ...COMMON_GRASS_DEFAULTS,
      rootColorR: 0.14,
      rootColorG: 0.20,
      rootColorB: 0.10,
    },
  },
  hydrangea: {
    id: "hydrangea",
    label: "Garden Hydrangea (Shrub)",
    summary: "Compact multi-stemmed foundation shrub with lush peripheral rosettes and creamy-white panicle blooms.",
    defaults: {
      treePreset: "hydrangea",
      crownShape: "spreading",
      treeHeight: 1.65,
      crownRadius: 1.25,
      branchCount: 5,
      branchAngle: 56,
      clumpCount: 2,
      clumpSize: 0.58,
      leafCardSize: 0.26,
      porosity: 0.20,
      treeColorR: 0.31,
      treeColorG: 0.43,
      treeColorB: 0.21,
      treeColorVariation: 0.48,
      autumnMix: 0.12,
      translucency: 0.50,
      canopyAO: 0.66,
      normalSoftness: 0.85,
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
    out.leafCardSize = snapKey("leafCardSize", out.clumpSize * (0.34 + rng.next() * 0.16))
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
    out.translucency = snapKey("translucency", 0.30 + rng.next() * 0.48)
    out.canopyAO = snapKey("canopyAO", 0.44 + rng.next() * 0.38)
    out.normalSoftness = snapKey("normalSoftness", 0.60 + rng.next() * 0.34)
    out.treeWindStrength = snapKey("treeWindStrength", 0.16 + rng.next() * 0.42)
    out.treeWindFreq = snapKey("treeWindFreq", 0.55 + rng.next() * 0.95)
    out.treeWindGust = snapKey("treeWindGust", 0.24 + rng.next() * 0.54)
  }

  if (scope === "all" || scope === "grass") {
    out.grassDensity = snapKey("grassDensity", 0.70 + rng.next() * 0.95)
    out.bladeHeight = snapKey("bladeHeight", 0.14 + rng.next() * 0.22)
    out.bladeWidth = snapKey("bladeWidth", 0.030 + rng.next() * 0.040)
    out.bladeCurvature = snapKey("bladeCurvature", 0.36 + rng.next() * 0.50)
    out.grassClumping = snapKey("grassClumping", 0.52 + rng.next() * 0.42)

    const rootG = 0.16 + rng.next() * 0.12
    const rootR = rootG * (0.64 + rng.next() * 0.20)
    const rootB = rootG * (0.42 + rng.next() * 0.16)
    out.rootColorR = snapKey("rootColorR", rootR)
    out.rootColorG = snapKey("rootColorG", rootG)
    out.rootColorB = snapKey("rootColorB", rootB)

    // Tips are always warmer and brighter than roots so blades read with ground-up AO.
    const tipG = Math.min(0.68, rootG * (1.85 + rng.next() * 0.55))
    const tipR = Math.min(0.64, tipG * (0.74 + rng.next() * 0.24))
    const tipB = Math.min(0.42, tipG * (0.44 + rng.next() * 0.16))
    out.tipColorR = snapKey("tipColorR", tipR)
    out.tipColorG = snapKey("tipColorG", tipG)
    out.tipColorB = snapKey("tipColorB", tipB)
    out.grassVariation = snapKey("grassVariation", 0.38 + rng.next() * 0.44)
    out.dryPatches = snapKey("dryPatches", 0.12 + rng.next() * 0.48)
    out.grassWind = snapKey("grassWind", 0.22 + rng.next() * 0.46)
    out.distanceFade = snapKey("distanceFade", 0.36 + rng.next() * 0.44)
  }

  return out
}

export type FoliagePresetV1 = {
  version: 1
  seed: number
  tuningSeed: number
  cameraMode: FoliageCameraMode
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

function noise2(x: number, y: number): number {
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

function branchSegment(m: Mesh, a: Point, b: Point, r0: number, r1: number, bark: Rgb, sides = 5): void {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const dz = b[2] - a[2]
  const len = Math.hypot(dx, dy, dz) || 1
  const axis: Point = [dx / len, dy / len, dz / len]
  const side = Math.hypot(dx, dz)
  const u: Point = side < 0.001 ? [1, 0, 0] : [-dz / side, 0, dx / side]
  const v = cross3(axis, u)
  const ringPoint = (end: number, i: number): Point => {
    const q = end ? b : a
    const s = end ? r1 : r0
    const ang = (i * Math.PI * 2) / sides
    const c = Math.cos(ang)
    const n = Math.sin(ang)
    return [
      q[0] + s * (u[0] * c + v[0] * n),
      q[1] + s * (u[1] * c + v[1] * n),
      q[2] + s * (u[2] * c + v[2] * n),
    ]
  }
  for (let i = 0; i < sides; i++) {
    m.quadAuto(ringPoint(0, i), ringPoint(1, i), ringPoint(1, i + 1), ringPoint(0, i + 1), bark, MAT.timber, 0)
  }
}

/**
 * Emits a cupped, multi-lobed botanical leaf fan pitched tangentially to its bough puff,
 * with vertex normals smoothly blended toward the ellipsoidal bough + crown normal (`normalSoftness`).
 * Avoids flat horizontal 4-corner square pyramids ("umbrella/ravioli" artifacts).
 */
function emitBentLeafRosette(
  m: Mesh,
  px: number,
  py: number,
  pz: number,
  size: number,
  dirX: number,
  dirY: number,
  dirZ: number,
  clusterCenter: Point,
  crownCenter: Point,
  normalSoftness: number,
  rng: Rng,
  baseTone: Rgb,
  innerDarken: number,
  flexWeight: number,
): void {
  const upBias = normalize3(dirX * 0.68, Math.max(0.28, dirY * 0.75 + 0.35), dirZ * 0.68)
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

  const dome = size * 0.28
  const center: Point = [
    px + upBias[0] * dome,
    py + upBias[1] * dome,
    pz + upBias[2] * dome,
  ]

  // 6-sided scalloped organic leaf fan with alternating major/minor lobe radii
  const lobes = 6
  const ring: Point[] = []
  for (let i = 0; i < lobes; i++) {
    const a = (i / lobes) * Math.PI * 2 + (rng.next() - 0.5) * 0.18
    const lobeScale = (i % 2 === 0 ? 1.06 : 0.78) * (0.88 + rng.next() * 0.24)
    const r = size * lobeScale
    const droop = size * (0.10 + (i % 2) * 0.08)
    const ca = Math.cos(a) * r
    const sa = Math.sin(a) * r
    ring.push([
      px + uAxis[0] * ca + vAxis[0] * sa - upBias[0] * droop,
      py + uAxis[1] * ca + vAxis[1] * sa - upBias[1] * droop - droop * 0.35,
      pz + uAxis[2] * ca + vAxis[2] * sa - upBias[2] * droop,
    ])
  }

  const shade = 0.92 + rng.next() * 0.20
  const tipCol = scaleRgb(baseTone, shade * 1.08)
  const midCol = scaleRgb(baseTone, shade * 0.96)
  const centerCol = scaleRgb(baseTone, shade * innerDarken)

  const sphericalNormalAt = (pt: Point): Point => {
    const nCluster = normalize3(
      pt[0] - clusterCenter[0],
      (pt[1] - clusterCenter[1]) * 1.15 + 0.16,
      pt[2] - clusterCenter[2],
    )
    const nCrown = normalize3(
      pt[0] - crownCenter[0],
      (pt[1] - crownCenter[1]) * 1.05 + 0.22,
      pt[2] - crownCenter[2],
    )
    return blendNormal(nCluster, nCrown, 0.36)
  }

  for (let i = 0; i < lobes; i++) {
    const p0 = ring[i]!
    const p1 = ring[(i + 1) % lobes]!
    const fn = faceNormal(center, p0, p1)
    const nCenter = blendNormal(fn, sphericalNormalAt(center), normalSoftness)
    const n0 = blendNormal(fn, sphericalNormalAt(p0), normalSoftness)
    const n1 = blendNormal(fn, sphericalNormalAt(p1), normalSoftness)
    m.vert(center, nCenter, centerCol, MAT.foliage, flexWeight * 0.85)
    m.vert(p0, n0, i % 2 === 0 ? tipCol : midCol, MAT.foliage, flexWeight)
    m.vert(p1, n1, (i + 1) % 2 === 0 ? tipCol : midCol, MAT.foliage, flexWeight)
  }
}

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
  rosettes: number,
  leafCardScale: number,
  canopyAO: number,
  normalSoftness: number,
  flexBase: number,
): void {
  const clusterCenter: Point = [cx, cy - ry * 0.18, cz]
  // Two-tier rounded 7-sided core volume (upper sunlit dome + recessed lower shadow skirt)
  const coreDark = Math.max(0.22, 0.64 - canopyAO * 0.40)
  const midShade = Math.max(0.45, 0.82 - canopyAO * 0.24)
  const darkCol = scaleRgb(base, coreDark)
  const midCol = scaleRgb(base, midShade)
  const topCol = scaleRgb(base, 1.04)

  const segs = 7
  const apex: Point = [cx, cy + ry * 0.62, cz]
  const upperRing: Point[] = []
  const lowerRing: Point[] = []
  for (let i = 0; i < segs; i++) {
    const a = (i / segs) * Math.PI * 2 + (rng.next() - 0.5) * 0.22
    const rUp = rx * (0.64 + (i % 2) * 0.12 + (rng.next() - 0.5) * 0.12)
    const rLo = rx * (0.48 + (rng.next() - 0.5) * 0.12)
    upperRing.push([cx + Math.cos(a) * rUp, cy + ry * (0.08 + (rng.next() - 0.5) * 0.10), cz + Math.sin(a) * rUp])
    lowerRing.push([cx + Math.cos(a + 0.22) * rLo, cy - ry * 0.34, cz + Math.sin(a + 0.22) * rLo])
  }

  const smoothN = (pt: Point): Point => {
    const nc = normalize3(pt[0] - clusterCenter[0], (pt[1] - clusterCenter[1]) * 1.15 + 0.15, pt[2] - clusterCenter[2])
    const nw = normalize3(pt[0] - crownCenter[0], (pt[1] - crownCenter[1]) * 1.05 + 0.20, pt[2] - crownCenter[2])
    return blendNormal(nc, nw, 0.35)
  }

  for (let i = 0; i < segs; i++) {
    const u0 = upperRing[i]!
    const u1 = upperRing[(i + 1) % segs]!
    const l0 = lowerRing[i]!

    const fnUp = faceNormal(apex, u0, u1)
    m.vert(apex, blendNormal(fnUp, smoothN(apex), normalSoftness), topCol, MAT.foliage, flexBase * 0.72)
    m.vert(u0, blendNormal(fnUp, smoothN(u0), normalSoftness), midCol, MAT.foliage, flexBase * 0.80)
    m.vert(u1, blendNormal(fnUp, smoothN(u1), normalSoftness), midCol, MAT.foliage, flexBase * 0.80)

    const fnLo = faceNormal(u0, l0, u1)
    m.vert(u0, blendNormal(fnLo, smoothN(u0), normalSoftness), midCol, MAT.foliage, flexBase * 0.75)
    m.vert(l0, blendNormal(fnLo, smoothN(l0), normalSoftness), darkCol, MAT.foliage, flexBase * 0.60)
    m.vert(u1, blendNormal(fnLo, smoothN(u1), normalSoftness), midCol, MAT.foliage, flexBase * 0.75)
  }

  // Fibonacci golden-angle peripheral leaf fans pitched tangentially across the cluster surface
  const innerDarken = Math.max(0.56, 0.92 - canopyAO * 0.30)
  const totalRosettes = Math.max(4, rosettes + 1)
  for (let s = 0; s < totalRosettes; s++) {
    const a = s * 2.39996 + (rng.next() - 0.5) * 0.32
    const tFrac = s / Math.max(1, totalRosettes - 1)
    const radial = rx * (s === 0 ? 0.14 : 0.48 + Math.sqrt(tFrac) * (0.44 + rng.next() * 0.18))
    const ox = Math.cos(a) * radial
    const oz = Math.sin(a) * radial
    const oy = s === 0 ? ry * 0.58 : ry * (0.42 - tFrac * 0.62 + (rng.next() - 0.5) * 0.16)
    const dir = normalize3(ox, oy + ry * 0.35, oz)
    const sz = Math.max(0.14, leafCardScale * (s === 0 ? 1.05 : 0.78 + rng.next() * 0.36))
    const lift = s === 0 ? 1.16 : 0.84 + (1 - tFrac * 0.55) * 0.32
    const tone = scaleRgb(base, lift)
    const flex = Math.min(1.4, flexBase * (0.85 + 0.35 * (radial / Math.max(0.1, rx))))
    emitBentLeafRosette(
      m,
      cx + ox,
      cy + oy,
      cz + oz,
      sz,
      dir[0],
      dir[1],
      dir[2],
      clusterCenter,
      crownCenter,
      normalSoftness,
      rng,
      tone,
      innerDarken,
      flex,
    )
  }
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
  const shape: FoliageCrownShape = shapeOverride ?? (isTree ? params.crownShape : "spreading")

  // Scale defaults proportionally when called from Outbreak's per-prop height/radius arguments.
  const heightRatio = h / Math.max(1.2, params.treeHeight)
  const radiusRatio = radius / Math.max(0.7, params.crownRadius)
  const boughs = isTree ? Math.max(3, Math.round(params.branchCount)) : Math.max(3, Math.min(5, Math.round(params.branchCount * 0.75)))
  const gapAngle = rng.next() * Math.PI * 2
  const gapHalfWidth = 0.15 + params.porosity * 0.72
  const leanX = (rng.next() - 0.5) * (isTree ? 0.22 : 0.04)
  const leanZ = (rng.next() - 0.5) * (isTree ? 0.22 : 0.04)

  const barkColor: Rgb =
    params.treePreset === "birch" || shape === "columnar"
      ? [0.58, 0.56, 0.51]
      : params.treePreset === "pine" || shape === "conical"
        ? [0.27, 0.21, 0.16]
        : [0.28, 0.26, 0.20]

  if (isTree) {
    const trunkTopFrac = shape === "conical" ? 0.88 : shape === "columnar" ? 0.80 : 0.72
    const trunkR0 = (shape === "columnar" ? 0.12 : 0.165) * Math.max(0.7, Math.min(1.3, heightRatio))
    // Root flare collar + main trunk
    branchSegment(m, [x, ground, z], [x + leanX * 0.25, ground + h * 0.16, z + leanZ * 0.25], trunkR0 * 1.28, trunkR0, barkColor, 5)
    branchSegment(
      m,
      [x + leanX * 0.25, ground + h * 0.15, z + leanZ * 0.25],
      [x + leanX, ground + h * trunkTopFrac, z + leanZ],
      trunkR0,
      trunkR0 * 0.38,
      barkColor,
      5,
    )
  }

  // Construct chlorophyll + autumn palette from base RGB, variation, and autumnMix.
  const baseRgb: Rgb = [params.treeColorR, params.treeColorG, params.treeColorB]
  const varAmt = params.treeColorVariation
  const autumn = params.autumnMix
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
      clamp01(baseRgb[2] * (1 - 0.10 * varAmt)),
    ],
    [
      clamp01(baseRgb[0] * (1 + 0.28 * varAmt)),
      clamp01(baseRgb[1] * (1 + 0.14 * varAmt)),
      clamp01(baseRgb[2] * (1 - 0.16 * varAmt)),
    ],
    [
      clamp01(baseRgb[0] * (1 - 0.08 * varAmt)),
      clamp01(baseRgb[1] * (1 - 0.05 * varAmt)),
      clamp01(baseRgb[2] * (1 + 0.06 * varAmt)),
    ],
  ]
  const autumnPalette: Rgb[] = [
    [0.62, 0.44, 0.18], // warm ochre gold
    [0.68, 0.34, 0.16], // burnt rust amber
    [0.54, 0.47, 0.20], // olive-gold
    [0.72, 0.49, 0.19], // sunlit amber
    [0.44, 0.38, 0.19], // russet bronze
  ]
  const palette: Rgb[] = greenPalette.map((gCol, idx) => {
    const aWeight = clamp01(autumn * (idx % 2 === 0 ? 1.15 : 0.72))
    return mixRgb(gCol, autumnPalette[idx % autumnPalette.length]!, aWeight)
  })

  const crownCenter: Point = [x + leanX * 0.5, ground + h * 0.58, z + leanZ * 0.5]
  const angleRad = (params.branchAngle * Math.PI) / 180
  const cosPitch = Math.cos(angleRad)
  const sinPitch = Math.sin(angleRad)
  const clumpsPerBough = isTree ? Math.max(1, Math.round(params.clumpCount)) : 1
  const clumpScale = params.clumpSize * Math.max(0.45, Math.min(1.45, radiusRatio))
  const cardScale = params.leafCardSize * Math.max(0.50, Math.min(1.40, radiusRatio))
  const rosettesPerClump = isTree ? 5 : 4

  for (let b = 0; b < boughs; b++) {
    const baseAngle = (b * Math.PI * 2) / boughs + (rng.next() - 0.5) * 0.42
    const gapDelta = Math.abs(Math.atan2(Math.sin(baseAngle - gapAngle), Math.cos(baseAngle - gapAngle)))
    const inGap = gapDelta < gapHalfWidth
    const tierFrac = boughs > 1 ? b / (boughs - 1) : 0.5

    let shapeProfile = 1 - tierFrac * 0.25
    if (shape === "conical") {
      shapeProfile = 1.12 - tierFrac * 0.68
    } else if (shape === "columnar") {
      shapeProfile = 0.68 * (1 - Math.abs(tierFrac - 0.45) * 0.55)
    } else if (shape === "layered") {
      shapeProfile = 1.08 - tierFrac * 0.32
    } else if (shape === "spreading") {
      shapeProfile = 1.15 - tierFrac * 0.18
    }

    const reach =
      radius *
      shapeProfile *
      (inGap ? Math.max(0.28, 0.52 - params.porosity * 0.28) : 0.62 + rng.next() * 0.34) *
      (0.72 + 0.28 * sinPitch)

    const startH =
      ground +
      h *
        (isTree
          ? (shape === "conical" ? 0.20 + tierFrac * 0.52 : 0.26 + tierFrac * 0.32)
          : 0.10 + tierFrac * 0.14)
    const rise = reach * Math.max(-0.18, cosPitch * (shape === "conical" ? 0.22 : 0.52))
    const tipH = Math.min(
      ground + h * 0.94,
      startH + rise + h * (isTree ? 0.14 + (rng.next() - 0.4) * 0.07 : 0.30 + tierFrac * 0.28),
    )

    const start: Point = [x + leanX * (0.25 + tierFrac * 0.45), startH, z + leanZ * (0.25 + tierFrac * 0.45)]
    const tip: Point = [x + Math.cos(baseAngle) * reach, tipH, z + Math.sin(baseAngle) * reach]

    if (isTree) {
      branchSegment(m, start, tip, 0.068 * (1 - tierFrac * 0.32), 0.026 * (1 - tierFrac * 0.32), barkColor, 5)
    }

    const boughClumps = inGap ? 1 : clumpsPerBough
    for (let cIdx = 0; cIdx < boughClumps; cIdx++) {
      const tAlong = boughClumps === 1 ? 0.96 : 0.58 + (cIdx / (boughClumps - 1)) * 0.44
      const jitterA = cIdx === 0 ? 0 : (rng.next() - 0.5) * 0.52
      const cAngle = baseAngle + jitterA
      const cDist = reach * tAlong
      const cx = x + Math.cos(cAngle) * cDist
      const cz = z + Math.sin(cAngle) * cDist
      const cy =
        start[1] +
        (tip[1] - start[1]) * tAlong +
        (shape === "layered" ? 0 : (cIdx % 2 === 0 ? 0.06 : -0.05) * h)

      const clusterTone = palette[(b + cIdx + Math.floor(rng.next() * 2)) % palette.length]!
      const subScale = cIdx === 0 ? 1.0 : 0.78 + rng.next() * 0.18
      const rx = clumpScale * subScale * (inGap ? 0.74 : 0.92 + rng.next() * 0.22)
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
        rosettesPerClump,
        cardScale * subScale,
        params.canopyAO,
        params.normalSoftness,
        flexBase,
      )
    }
  }

  // Crown apex cluster
  const crownTone = palette[seed % palette.length]!
  const apexRx = clumpScale * (shape === "conical" ? 0.62 : 0.92)
  const apexRy = apexRx * (shape === "layered" ? 0.52 : 0.72)
  emitBoughCluster(
    m,
    x + leanX * 0.55,
    ground + h * (isTree ? 0.86 : 0.70),
    z + leanZ * 0.55,
    apexRx,
    apexRy,
    crownCenter,
    rng,
    crownTone,
    rosettesPerClump,
    cardScale * 0.95,
    params.canopyAO,
    params.normalSoftness,
    0.95,
  )

  // Hydrangea creamy panicle blooms when shrub/hydrangea preset is active
  if (params.treePreset === "hydrangea") {
    for (let i = 0; i < 12; i++) {
      const a = i * 2.39996 + (seed % 7) * 0.2
      const dist = radius * (0.24 + (i % 4) * 0.18)
      const bx = x + Math.cos(a) * dist
      const bz = z + Math.sin(a) * dist
      const by = ground + h * (0.44 + (1 - (i % 4) * 0.18) * 0.34)
      const bloomCol: Rgb = i % 3 === 0 ? [0.87, 0.90, 0.84] : [0.77, 0.82, 0.74]
      m.prism(bx, bz, 0.075, 0.055, by, by + 0.09, 6, bloomCol, MAT.foliage, 0.45)
    }
  }

  // Root-flare curved grass blades around the trunk base, leaving an open side gap
  const coverCount = isTree ? 4 : 2
  for (let c = 0; c < coverCount; c++) {
    const a = gapAngle + 1.2 + c * 1.45 + (rng.next() - 0.5) * 0.35
    const d = radius * (isTree ? 0.24 : 0.38) * (0.65 + rng.next() * 0.45)
    const gx = x + Math.cos(a) * d
    const gz = z + Math.sin(a) * d
    emitGrassTuft(m, gx, ground, gz, {
      bladeCount: 3,
      radius: 0.14 + rng.next() * 0.08,
      height: (isTree ? 0.18 : 0.13) + rng.next() * 0.07,
      width: params.bladeWidth,
      curvature: params.bladeCurvature,
      leanAngle: a + (rng.next() - 0.5) * 0.4,
      rootColor: [params.rootColorR, params.rootColorG, params.rootColorB],
      tipColor: [params.tipColorR, params.tipColorG, params.tipColorB],
      rng,
    })
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
  if (tree) branchSegment(m, [x, ground, z], [x + leanX, ground + h * 0.78, z + leanZ], 0.17, 0.17 * 0.4, [0.28, 0.26, 0.20], 5)
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
    branchSegment(m, start, tip, br, br * 0.4, [0.28, 0.26, 0.20], 5)
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
 * Emits a single curved, tapered 2-segment 3D grass blade with rounded cross-section normals,
 * root-to-tip colour/AO gradient, and normalized arc coordinate encoded in `aux < 0`.
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
  // Perpendicular horizontal axis across blade width
  const sideX = -dirZ
  const sideZ = dirX

  const bend1 = height * curvature * 0.28
  const bend2 = height * curvature * 0.72
  const y1 = by + height * (0.52 - curvature * 0.05)
  const y2 = by + height * Math.max(0.58, 1.0 - curvature * 0.18)

  const c0: Point = [bx, by, bz]
  const c1: Point = [bx + dirX * bend1, y1, bz + dirZ * bend1]
  const c2: Point = [bx + dirX * bend2, y2, bz + dirZ * bend2]

  const w0 = width * 0.5
  const w1 = width * 0.28

  const p0L: Point = [c0[0] - sideX * w0, c0[1], c0[2] - sideZ * w0]
  const p0R: Point = [c0[0] + sideX * w0, c0[1], c0[2] + sideZ * w0]
  const p1L: Point = [c1[0] - sideX * w1, c1[1], c1[2] - sideZ * w1]
  const p1R: Point = [c1[0] + sideX * w1, c1[1], c1[2] + sideZ * w1]
  const p2Tip: Point = c2

  // Compute smooth spine normal + Ghost of Tsushima lateral normal rounding (`±0.36`)
  const spineN0 = normalize3(-dirX * 0.35, 0.92, -dirZ * 0.35)
  const spineN1 = normalize3(-dirX * (0.42 + curvature * 0.25), 0.86, -dirZ * (0.42 + curvature * 0.25))
  const spineN2 = normalize3(-dirX * (0.28 + curvature * 0.30), 0.92, -dirZ * (0.28 + curvature * 0.30))

  const round = 0.36
  const n0L = normalize3(spineN0[0] - sideX * round, spineN0[1], spineN0[2] - sideZ * round)
  const n0R = normalize3(spineN0[0] + sideX * round, spineN0[1], spineN0[2] + sideZ * round)
  const n1L = normalize3(spineN1[0] - sideX * round, spineN1[1], spineN1[2] - sideZ * round)
  const n1R = normalize3(spineN1[0] + sideX * round, spineN1[1], spineN1[2] + sideZ * round)

  const midCol = mixRgb(rootCol, tipCol, 0.58)
  const aux0 = -0.05
  const aux1 = -0.52
  const aux2 = -1.0

  // Segment 0 quad (2 triangles)
  m.vert(p0L, n0L, rootCol, MAT.foliage, aux0)
  m.vert(p0R, n0R, rootCol, MAT.foliage, aux0)
  m.vert(p1R, n1R, midCol, MAT.foliage, aux1)

  m.vert(p0L, n0L, rootCol, MAT.foliage, aux0)
  m.vert(p1R, n1R, midCol, MAT.foliage, aux1)
  m.vert(p1L, n1L, midCol, MAT.foliage, aux1)

  // Segment 1 tapered tip triangle
  m.vert(p1L, n1L, midCol, MAT.foliage, aux1)
  m.vert(p1R, n1R, midCol, MAT.foliage, aux1)
  m.vert(p2Tip, spineN2, tipCol, MAT.foliage, aux2)
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
    // Blend clump-correlated wind lean with slight outward radial splay
    const splay = Math.atan2(Math.sin(radialA - leanAngle), Math.cos(radialA - leanAngle)) * 0.32
    const bladeYaw = leanAngle + splay + (rng.next() - 0.5) * 0.45
    const bh = height * (0.78 + rng.next() * 0.42) * (1.08 - (radialD / Math.max(0.05, radius)) * 0.24)
    const bw = width * (0.85 + rng.next() * 0.30)
    const bCurve = clamp01(curvature * (0.82 + rng.next() * 0.36))
    const shade = 0.88 + rng.next() * 0.24
    emitCurvedGrassBlade(
      m,
      bx,
      y,
      bz,
      bh,
      bw,
      bCurve,
      bladeYaw,
      scaleRgb(rootColor, shade * 0.82),
      scaleRgb(tipColor, shade * 1.05),
    )
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
 * Generates clump-correlated grass tufts with shared wind-lean direction, height mounds,
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
  const dryRoot: Rgb = [0.28, 0.24, 0.13]
  const dryTip: Rgb = [0.62, 0.54, 0.28]

  const out: GrassClumpSample[] = []
  const effClusters = Math.max(1, Math.round(clusterCount * params.grassDensity))

  for (let c = 0; c < effClusters; c++) {
    const cx = x0 + rng.next() * (x1 - x0)
    const cz = z0 + rng.next() * (z1 - z0)
    if (avoid?.(cx, cz)) continue

    // Correlated clump noise field (shared lean angle, dry-patch weight, and mound height)
    const nLean = noise2(cx * 0.22 + 3.1, cz * 0.22 + 7.4)
    const nDry = noise2(cx * 0.18 + 11.3, cz * 0.18 + 2.9)
    const clumpLean = nLean * Math.PI * 2
    const spread = (0.48 + rng.next() * 0.95) * (1.25 - params.grassClumping * 0.45)
    const dryWeight = clamp01((nDry - (0.62 - params.dryPatches * 0.45)) * 2.4) * params.dryPatches
    const hueShift = (rng.next() - 0.5) * 0.28 * params.grassVariation

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

      // Taller in the heart of the clump, tapering toward the fringe (like Botanics & Ghost of Tsushima)
      const moundScale = 1.18 - radialFrac * 0.34 * params.grassClumping
      const shade = 0.86 + rng.next() * 0.28
      const randomLean = (rng.next() - 0.5) * Math.PI * 2
      const leanAngle = clumpLean * params.grassClumping + randomLean * (1 - params.grassClumping)

      out.push({
        x: tx,
        z: tz,
        radius: 0.10 + rng.next() * 0.12,
        height: params.bladeHeight * moundScale * (0.82 + rng.next() * 0.36),
        width: params.bladeWidth * (0.88 + rng.next() * 0.24),
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
    vec4f(0.30, 0.85, 0.45, 0.52),
    vec4f(0.42, 0.55, 0.64, 0.82)
  );
}

/**
 * Hierarchical vertex displacement for MAT.foliage (mat == 22):
 * - aux > 0.02: Tree/shrub canopy vertex with flexibility weight aux. Combines global bough sway
 *   with 3D spatial leaf-card flutter (inspired by Sujen Phea's Botanics applyTreeWind).
 * - aux < -0.02: Curved grass blade vertex with normalized root-to-tip coordinate bladeT = -aux.
 *   Applies travelling wind waves with arc-length-preserving vertical dip.
 */
fn applyFoliageVertexWind(pos: vec3f, normal: vec3f, aux: f32, time: f32, eye: vec3f, cfg: FoliageWindConfig) -> array<vec3f, 2> {
  var p = pos;
  var n = normal;
  if (aux > 0.02) {
    let flex = clamp(aux, 0.0, 1.5);
    let freq = max(0.1, cfg.u0.y);
    let strength = cfg.u0.x * 0.14 * flex;
    let gustEnv = 1.0 + cfg.u0.z * (0.45 * sin(time * 0.75 + pos.x * 0.18 + pos.z * 0.14) + 0.25 * cos(time * 1.3 - pos.z * 0.22));
    let phase = pos.x * 0.52 + pos.z * 0.39 + pos.y * 0.31;
    let swayX = (sin(time * freq * 3.1 + phase) + 0.55 * sin(time * freq * 1.35 + phase * 1.7 + 1.2)) * strength * gustEnv;
    let swayZ = (cos(time * freq * 2.6 + phase * 0.9) + 0.45 * sin(time * freq * 1.15 - phase * 1.3)) * strength * 0.78 * gustEnv;
    let flutter = sin(time * freq * 6.8 + dot(pos, vec3f(4.3, 6.1, 4.9))) * strength * 0.26;
    let dx = swayX + flutter;
    let dz = swayZ - flutter * 0.7;
    p.x += dx;
    p.z += dz;
    p.y -= (abs(dx) + abs(dz)) * 0.14;
    n = normalize(n + vec3f(dx * 1.4, 0.0, dz * 1.4));
  } else if (aux < -0.02) {
    let bladeT = clamp(-aux, 0.0, 1.0);
    let bendWeight = bladeT * bladeT;
    let dist = length(eye.xz - pos.xz);
    let fade = 1.0 - smoothstep(26.0, 62.0, dist) * cfg.u1.y * 0.65;
    let wavePhase = pos.x * 0.85 + pos.z * 0.62;
    let ripple = sin(time * 3.2 + wavePhase) + 0.6 * sin(time * 1.45 + pos.x * 0.35 - pos.z * 0.48 + 2.1);
    let gust = 0.75 + 0.45 * sin(time * 0.85 + pos.x * 0.22 + pos.z * 0.19);
    let windAmt = cfg.u1.x * 0.085 * bendWeight * gust * fade;
    let wx = ripple * windAmt;
    let wz = cos(time * 2.5 + wavePhase * 0.8) * windAmt * 0.65;
    p.x += wx;
    p.z += wz;
    // Arc-length preservation: horizontal deflection slightly lowers blade tip height.
    p.y = (p.y * mix(1.0, fade, 0.35)) - (abs(wx) + abs(wz)) * 0.28 * bladeT;
    n = normalize(n + vec3f(wx * 3.2, 0.0, wz * 3.2));
  }
  return array<vec3f, 2>(p, n);
}
`
