import { Rng } from "../sim/rng"
import { DEFAULT_TEXTURE_MANIFEST, TEXTURE_LAYER, type TextureAssetId } from "../textures/manifest"

export type MaterialRecipeId =
  | "wood_planks"
  | "cobblestone"
  | "plaster_wall"
  | "asphalt_concrete"
  | "grass_soil"
  | "foliage_canopy"

export type MaterialParamKey =
  | "baseR"
  | "baseG"
  | "baseB"
  | "roughness"
  | "scale"
  | "elementRatio"
  | "irregularity"
  | "grainScale"
  | "colorVariation"
  | "jointWidth"
  | "wear"
  | "macroVariation"

export type MaterialRecipeParams = Record<MaterialParamKey, number>

export type MaterialTextureParamKey =
  | "textureLayer"
  | "texScale"
  | "texRotation"
  | "texContrast"
  | "texRoughness"
  | "texBlend"

export type MaterialTextureParams = Record<MaterialTextureParamKey, number>

export type MaterialParamSpec = {
  key: MaterialParamKey
  label: string
  group: "Surface" | "Pattern" | "Weathering"
  min: number
  max: number
  step: number
  unit: "" | "m" | "×"
  /** Live shader uniform update; does not rebuild scene meshes or reset transport. */
  boundary: "uniform"
}

export type MaterialTextureParamSpec = {
  key: Exclude<MaterialTextureParamKey, "textureLayer">
  label: string
  min: number
  max: number
  step: number
  unit: "" | "°" | "×"
  boundary: "uniform"
}

export const MATERIAL_PARAM_SPECS: readonly MaterialParamSpec[] = [
  { key: "baseR", label: "Base red", group: "Surface", min: 0.05, max: 1.0, step: 0.01, unit: "", boundary: "uniform" },
  { key: "baseG", label: "Base green", group: "Surface", min: 0.05, max: 1.0, step: 0.01, unit: "", boundary: "uniform" },
  { key: "baseB", label: "Base blue", group: "Surface", min: 0.05, max: 1.0, step: 0.01, unit: "", boundary: "uniform" },
  { key: "roughness", label: "Roughness", group: "Surface", min: 0.05, max: 1.0, step: 0.01, unit: "", boundary: "uniform" },
  { key: "scale", label: "Pattern scale", group: "Pattern", min: 0.25, max: 3.0, step: 0.05, unit: "×", boundary: "uniform" },
  { key: "elementRatio", label: "Element size", group: "Pattern", min: 0.16, max: 3.5, step: 0.02, unit: "m", boundary: "uniform" },
  { key: "irregularity", label: "Irregularity", group: "Pattern", min: 0.0, max: 1.0, step: 0.02, unit: "", boundary: "uniform" },
  { key: "grainScale", label: "Grain frequency", group: "Pattern", min: 0.25, max: 3.0, step: 0.05, unit: "×", boundary: "uniform" },
  { key: "colorVariation", label: "Colour variation", group: "Weathering", min: 0.0, max: 1.0, step: 0.02, unit: "", boundary: "uniform" },
  { key: "jointWidth", label: "Joint & dirt AO", group: "Weathering", min: 0.0, max: 0.16, step: 0.005, unit: "", boundary: "uniform" },
  { key: "wear", label: "Edge & surface wear", group: "Weathering", min: 0.0, max: 1.0, step: 0.02, unit: "", boundary: "uniform" },
  { key: "macroVariation", label: "Macro breakup", group: "Weathering", min: 0.0, max: 1.0, step: 0.02, unit: "", boundary: "uniform" },
] as const

export const MATERIAL_TEXTURE_PARAM_SPECS: readonly MaterialTextureParamSpec[] = [
  { key: "texScale", label: "Texture scale", min: 0.25, max: 3.0, step: 0.05, unit: "×", boundary: "uniform" },
  { key: "texRotation", label: "Texture rotation", min: -180, max: 180, step: 5, unit: "°", boundary: "uniform" },
  { key: "texContrast", label: "Texture contrast", min: 0.0, max: 2.0, step: 0.05, unit: "×", boundary: "uniform" },
  { key: "texRoughness", label: "Roughness trim", min: -0.35, max: 0.35, step: 0.01, unit: "", boundary: "uniform" },
  { key: "texBlend", label: "Texture blend", min: 0.0, max: 1.0, step: 0.05, unit: "", boundary: "uniform" },
] as const

export const TEXTURE_SELECT_OPTIONS: readonly { value: number; label: string }[] = [
  { value: -1, label: "Procedural only (None)" },
  ...DEFAULT_TEXTURE_MANIFEST.filter(m => m.wrapMode !== "derived_normal").map(m => ({
    value: m.layer,
    label: `${m.layer}: ${m.label}`,
  })),
]

export type MaterialRecipeDef = {
  id: MaterialRecipeId
  index: number
  label: string
  category: string
  summary: string
  defaultTextureId: TextureAssetId
  defaults: Readonly<MaterialRecipeParams>
  textureDefaults: Readonly<MaterialTextureParams>
}

export const MATERIAL_RECIPES: Readonly<Record<MaterialRecipeId, MaterialRecipeDef>> = {
  wood_planks: {
    id: "wood_planks",
    index: 0,
    label: "Wood planks",
    category: "Flooring & Timber",
    summary: "Matte heartwood grain, staggered board lengths, butt-joint AO, and warm/cool per-board variation.",
    defaultTextureId: "wood_floorboards",
    defaults: {
      baseR: 0.55,
      baseG: 0.43,
      baseB: 0.31,
      roughness: 0.84,
      scale: 1.0,
      elementRatio: 1.56,
      irregularity: 0.72,
      grainScale: 1.0,
      colorVariation: 0.58,
      jointWidth: 0.045,
      wear: 0.42,
      macroVariation: 0.48,
    },
    textureDefaults: {
      textureLayer: TEXTURE_LAYER.wood_floorboards,
      texScale: 1.0,
      texRotation: 0,
      texContrast: 1.0,
      texRoughness: 0.0,
      texBlend: 0.82,
    },
  },
  cobblestone: {
    id: "cobblestone",
    index: 1,
    label: "Cobblestone & pavers",
    category: "Paths & Masonry",
    summary: "Voronoi irregular stone distribution, worn rounded edges, recessed dirt joints, and mineral variation.",
    defaultTextureId: "cobblestone_pavers",
    defaults: {
      baseR: 0.47,
      baseG: 0.45,
      baseB: 0.40,
      roughness: 0.86,
      scale: 1.0,
      elementRatio: 0.32,
      irregularity: 0.84,
      grainScale: 1.0,
      colorVariation: 0.62,
      jointWidth: 0.06,
      wear: 0.58,
      macroVariation: 0.52,
    },
    textureDefaults: {
      textureLayer: TEXTURE_LAYER.cobblestone_pavers,
      texScale: 1.0,
      texRotation: 0,
      texContrast: 1.0,
      texRoughness: 0.0,
      texBlend: 0.78,
    },
  },
  plaster_wall: {
    id: "plaster_wall",
    index: 2,
    label: "Plaster & painted wall",
    category: "Architecture",
    summary: "Trowel stipple, wallpaper/plaster mixture patches, baseboard contact, and causal ledge runoff.",
    defaultTextureId: "wallpaper_plaster",
    defaults: {
      baseR: 0.44,
      baseG: 0.40,
      baseB: 0.33,
      roughness: 0.88,
      scale: 1.0,
      elementRatio: 1.8,
      irregularity: 0.46,
      grainScale: 1.0,
      colorVariation: 0.42,
      jointWidth: 0.03,
      wear: 0.48,
      macroVariation: 0.5,
    },
    textureDefaults: {
      textureLayer: TEXTURE_LAYER.wallpaper_plaster,
      texScale: 1.0,
      texRotation: 0,
      texContrast: 1.0,
      texRoughness: 0.0,
      texBlend: 0.80,
    },
  },
  asphalt_concrete: {
    id: "asphalt_concrete",
    index: 3,
    label: "Asphalt & concrete",
    category: "Roads & Sidewalks",
    summary: "Multi-scale crushed aggregate, tar repair seams, wheel-track wear, and worn concrete expansion joints.",
    defaultTextureId: "street_asphalt",
    defaults: {
      baseR: 0.24,
      baseG: 0.26,
      baseB: 0.28,
      roughness: 0.85,
      scale: 1.0,
      elementRatio: 1.6,
      irregularity: 0.54,
      grainScale: 1.0,
      colorVariation: 0.46,
      jointWidth: 0.04,
      wear: 0.52,
      macroVariation: 0.58,
    },
    textureDefaults: {
      textureLayer: TEXTURE_LAYER.street_asphalt,
      texScale: 1.0,
      texRotation: 0,
      texContrast: 1.0,
      texRoughness: 0.0,
      texBlend: 0.80,
    },
  },
  grass_soil: {
    id: "grass_soil",
    index: 4,
    label: "Grass & soil",
    category: "Terrain & Grounds",
    summary: "Voronoi clump-correlated turf, directional blade tufts, dry-to-lush hue shifts, and dark loam exposure.",
    defaultTextureId: "lawn_grass",
    defaults: {
      baseR: 0.34,
      baseG: 0.39,
      baseB: 0.26,
      roughness: 0.94,
      scale: 1.0,
      elementRatio: 0.96,
      irregularity: 0.76,
      grainScale: 1.0,
      colorVariation: 0.62,
      jointWidth: 0.06,
      wear: 0.46,
      macroVariation: 0.64,
    },
    textureDefaults: {
      textureLayer: TEXTURE_LAYER.lawn_grass,
      texScale: 1.0,
      texRotation: 0,
      texContrast: 1.0,
      texRoughness: 0.0,
      texBlend: 0.82,
    },
  },
  foliage_canopy: {
    id: "foliage_canopy",
    index: 5,
    label: "Foliage & ground cover",
    category: "Vegetation",
    summary: "Cluster-correlated leaf masses, crown gaps, top/bottom canopy shading, and low ground-cover rosettes.",
    defaultTextureId: "leaf_atlas",
    defaults: {
      baseR: 0.29,
      baseG: 0.36,
      baseB: 0.19,
      roughness: 0.82,
      scale: 1.0,
      elementRatio: 0.46,
      irregularity: 0.74,
      grainScale: 1.0,
      colorVariation: 0.66,
      jointWidth: 0.05,
      wear: 0.44,
      macroVariation: 0.56,
    },
    textureDefaults: {
      textureLayer: TEXTURE_LAYER.leaf_atlas,
      texScale: 1.0,
      texRotation: 0,
      texContrast: 1.0,
      texRoughness: 0.0,
      texBlend: 0.80,
    },
  },
}

export const MATERIAL_RECIPE_IDS = Object.keys(MATERIAL_RECIPES) as readonly MaterialRecipeId[]

export function isMaterialRecipeId(value: unknown): value is MaterialRecipeId {
  return typeof value === "string" && value in MATERIAL_RECIPES
}

export function cloneMaterialParams(recipeId: MaterialRecipeId): MaterialRecipeParams {
  return { ...MATERIAL_RECIPES[recipeId].defaults }
}

export function cloneMaterialTextureParams(recipeId: MaterialRecipeId): MaterialTextureParams {
  return { ...MATERIAL_RECIPES[recipeId].textureDefaults }
}

function snapToStep(value: number, spec: { min: number; max: number; step: number }): number {
  const clamped = Math.max(spec.min, Math.min(spec.max, value))
  const steps = Math.round((clamped - spec.min) / spec.step)
  return Number(Math.min(spec.max, Math.max(spec.min, spec.min + steps * spec.step)).toPrecision(12))
}

export function validateMaterialParams(
  input: unknown,
): { ok: true; value: MaterialRecipeParams } | { ok: false; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "Material parameters must be an object." }
  }
  const raw = input as Record<string, unknown>
  const out = {} as MaterialRecipeParams
  for (const spec of MATERIAL_PARAM_SPECS) {
    const v = raw[spec.key]
    if (typeof v !== "number" || !Number.isFinite(v)) {
      return { ok: false, error: `Invalid or non-finite material parameter "${spec.key}".` }
    }
    if (v < spec.min - 1e-6 || v > spec.max + 1e-6) {
      return { ok: false, error: `Parameter "${spec.key}" (${v}) is outside [${spec.min}, ${spec.max}].` }
    }
    out[spec.key] = snapToStep(v, spec)
  }
  return { ok: true, value: out }
}

export function validateMaterialTextureParams(
  recipeId: MaterialRecipeId,
  input: unknown,
): { ok: true; value: MaterialTextureParams } | { ok: false; error: string } {
  const defaults = MATERIAL_RECIPES[recipeId].textureDefaults
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "Material texture parameters must be an object." }
  }
  const raw = input as Record<string, unknown>
  const layer = raw.textureLayer ?? defaults.textureLayer
  if (typeof layer !== "number" || !Number.isInteger(layer) || layer < -1 || layer > 15) {
    return { ok: false, error: `Invalid textureLayer: ${String(layer)} (expected integer -1..15).` }
  }
  const out: MaterialTextureParams = {
    textureLayer: layer,
    texScale: defaults.texScale,
    texRotation: defaults.texRotation,
    texContrast: defaults.texContrast,
    texRoughness: defaults.texRoughness,
    texBlend: defaults.texBlend,
  }
  for (const spec of MATERIAL_TEXTURE_PARAM_SPECS) {
    const v = raw[spec.key] ?? defaults[spec.key]
    if (typeof v !== "number" || !Number.isFinite(v)) {
      return { ok: false, error: `Invalid or non-finite texture parameter "${spec.key}".` }
    }
    if (v < spec.min - 1e-6 || v > spec.max + 1e-6) {
      return { ok: false, error: `Texture parameter "${spec.key}" (${v}) is outside [${spec.min}, ${spec.max}].` }
    }
    out[spec.key] = snapToStep(v, spec)
  }
  return { ok: true, value: out }
}

/**
 * Deterministic recipe randomization using an isolated tuning seed.
 * Respects parameter bounds and step increments while keeping base palette recognizable
 * and wood/masonry roughness within physically sensible non-mirror ranges.
 */
export function randomizeMaterialParams(recipeId: MaterialRecipeId, tuningSeed: number): MaterialRecipeParams {
  const rng = new Rng((Math.trunc(tuningSeed) || 1) ^ (MATERIAL_RECIPES[recipeId].index * 0x9e3779b9))
  const base = MATERIAL_RECIPES[recipeId].defaults
  const out = { ...base }
  for (const spec of MATERIAL_PARAM_SPECS) {
    if (spec.key === "baseR" || spec.key === "baseG" || spec.key === "baseB") {
      // Keep randomized base colors anchored near the material's natural pigment family.
      const delta = (rng.next() - 0.5) * 0.24
      out[spec.key] = snapToStep(base[spec.key] + delta, spec)
    } else if (spec.key === "roughness") {
      const lo = recipeId === "wood_planks" ? 0.65 : 0.55
      const hi = 0.98
      out.roughness = snapToStep(lo + rng.next() * (hi - lo), spec)
    } else {
      const span = spec.max - spec.min
      const center = base[spec.key]
      const candidate = center + (rng.next() - 0.5) * span * 0.65
      out[spec.key] = snapToStep(candidate, spec)
    }
  }
  return out
}

export function randomizeMaterialTextureParams(recipeId: MaterialRecipeId, tuningSeed: number): MaterialTextureParams {
  const rng = new Rng((Math.trunc(tuningSeed) || 1) ^ (MATERIAL_RECIPES[recipeId].index * 0x85ebca6b))
  const base = MATERIAL_RECIPES[recipeId].textureDefaults
  return {
    textureLayer: base.textureLayer,
    texScale: snapToStep(0.65 + rng.next() * 0.9, MATERIAL_TEXTURE_PARAM_SPECS[0]!),
    texRotation: snapToStep((rng.next() - 0.5) * 40, MATERIAL_TEXTURE_PARAM_SPECS[1]!),
    texContrast: snapToStep(0.65 + rng.next() * 0.75, MATERIAL_TEXTURE_PARAM_SPECS[2]!),
    texRoughness: snapToStep((rng.next() - 0.5) * 0.22, MATERIAL_TEXTURE_PARAM_SPECS[3]!),
    texBlend: snapToStep(0.55 + rng.next() * 0.45, MATERIAL_TEXTURE_PARAM_SPECS[4]!),
  }
}

export type MaterialSwatchMode = "room" | "ball" | "plane"
export type MaterialCompareMode = 0 | 1 | 2 | 3 | 4

export type MaterialPresetV1 = {
  version: 1
  recipe: MaterialRecipeId
  swatch: MaterialSwatchMode
  compare: MaterialCompareMode
  tuningSeed: number
  roomSeed: number
  params: MaterialRecipeParams
  textureParams?: MaterialTextureParams
}

export function exportMaterialPreset(preset: Omit<MaterialPresetV1, "version">): MaterialPresetV1 {
  const checked = validateMaterialParams(preset.params)
  if (!checked.ok) throw new Error(checked.error)
  const out: MaterialPresetV1 = {
    version: 1,
    recipe: preset.recipe,
    swatch: preset.swatch,
    compare: preset.compare,
    tuningSeed: Math.max(1, Math.min(9999, Math.trunc(preset.tuningSeed) || 1)),
    roomSeed: Math.max(1, Math.min(999, Math.trunc(preset.roomSeed) || 7)),
    params: checked.value,
  }
  if (preset.textureParams) {
    const texChecked = validateMaterialTextureParams(preset.recipe, preset.textureParams)
    if (!texChecked.ok) throw new Error(texChecked.error)
    out.textureParams = texChecked.value
  }
  return out
}

export function importMaterialPreset(
  rawJson: string,
): { ok: true; value: MaterialPresetV1 } | { ok: false; error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawJson)
  } catch {
    return { ok: false, error: "Invalid JSON syntax." }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "Material preset must be a JSON object." }
  }
  const obj = parsed as Record<string, unknown>
  if (obj.version !== 1) {
    return { ok: false, error: `Unsupported material preset version: ${String(obj.version)} (expected 1).` }
  }
  if (!isMaterialRecipeId(obj.recipe)) {
    return { ok: false, error: `Unknown material recipe ID: "${String(obj.recipe)}".` }
  }
  if (obj.swatch !== "room" && obj.swatch !== "ball" && obj.swatch !== "plane") {
    return { ok: false, error: `Invalid swatch mode: "${String(obj.swatch)}".` }
  }
  if (obj.compare !== 0 && obj.compare !== 1 && obj.compare !== 2 && obj.compare !== 3 && obj.compare !== 4) {
    return { ok: false, error: `Invalid compare mode: "${String(obj.compare)}".` }
  }
  if (typeof obj.tuningSeed !== "number" || !Number.isFinite(obj.tuningSeed) || obj.tuningSeed < 1 || obj.tuningSeed > 9999) {
    return { ok: false, error: "Invalid tuningSeed (expected 1..9999)." }
  }
  if (typeof obj.roomSeed !== "number" || !Number.isFinite(obj.roomSeed) || obj.roomSeed < 1 || obj.roomSeed > 999) {
    return { ok: false, error: "Invalid roomSeed (expected 1..999)." }
  }
  const paramsRes = validateMaterialParams(obj.params)
  if (!paramsRes.ok) return paramsRes
  let textureParams: MaterialTextureParams | undefined
  if (obj.textureParams !== undefined) {
    const texRes = validateMaterialTextureParams(obj.recipe, obj.textureParams)
    if (!texRes.ok) return texRes
    textureParams = texRes.value
  }
  return {
    ok: true,
    value: {
      version: 1,
      recipe: obj.recipe,
      swatch: obj.swatch,
      compare: obj.compare,
      tuningSeed: Math.trunc(obj.tuningSeed),
      roomSeed: Math.trunc(obj.roomSeed),
      params: paramsRes.value,
      ...(textureParams ? { textureParams } : {}),
    },
  }
}

/** Pack a recipe's 12 parameters into a Float32Array (3 vec4f). */
export function packMaterialParams(params: MaterialRecipeParams, out = new Float32Array(12), offset = 0): Float32Array {
  out[offset + 0] = params.baseR
  out[offset + 1] = params.baseG
  out[offset + 2] = params.baseB
  out[offset + 3] = params.roughness
  out[offset + 4] = params.scale
  out[offset + 5] = params.elementRatio
  out[offset + 6] = params.irregularity
  out[offset + 7] = params.grainScale
  out[offset + 8] = params.colorVariation
  out[offset + 9] = params.jointWidth
  out[offset + 10] = params.wear
  out[offset + 11] = params.macroVariation
  return out
}

export const SURFACE_TEX_UNIFORM_FLOATS = 44

export type SurfaceTexUniformInput = {
  /** 1 = textured + procedural, 0 = procedural fallback, 2 = A/B split (procedural < splitX, textured >= splitX) */
  enabled?: number
  globalScale?: number
  globalContrast?: number
  globalRoughness?: number
  rugStyle?: number
  wallStyle?: number
  floorStyle?: number
  splitX?: number
  recipes?: Partial<Record<MaterialRecipeId, Partial<MaterialTextureParams>>>
}

/**
 * Packs the 44-float `SurfaceTexUniforms` buffer consumed by `@group(0) @binding(12)` in `surfaceMaterialCoreWgsl`.
 */
export function packSurfaceTexUniforms(
  input: SurfaceTexUniformInput = {},
  out = new Float32Array(SURFACE_TEX_UNIFORM_FLOATS),
): Float32Array {
  out[0] = input.enabled ?? 1
  out[1] = input.globalScale ?? 1
  out[2] = input.globalContrast ?? 1
  out[3] = input.globalRoughness ?? 0
  out[4] = input.rugStyle ?? 0
  out[5] = input.wallStyle ?? 0
  out[6] = input.floorStyle ?? 0
  out[7] = input.splitX ?? 27.7

  for (const id of MATERIAL_RECIPE_IDS) {
    const def = MATERIAL_RECIPES[id]
    const idx = def.index
    const t = { ...def.textureDefaults, ...input.recipes?.[id] }
    const baseOff = 8 + idx * 4
    out[baseOff + 0] = t.textureLayer
    out[baseOff + 1] = t.texScale
    out[baseOff + 2] = (t.texRotation * Math.PI) / 180
    out[baseOff + 3] = t.texContrast
    const extraOff = 32 + idx * 2
    out[extraOff + 0] = t.texRoughness
    out[extraOff + 1] = t.texBlend
  }
  return out
}

// --- Deterministic CPU mirrors for testing & scatter generation ---

function fract(x: number): number {
  return x - Math.floor(x)
}

function hash2Cpu(x: number, y: number): number {
  let qx = fract(x * 0.1031)
  let qy = fract(y * 0.1030)
  const d = qx * (qy + 33.33) + qy * (qx + 33.33)
  qx += d
  qy += d
  return fract((qx + qy) * qx)
}

function noise2Cpu(x: number, y: number): number {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const fx = x - ix
  const fy = y - iy
  const ux = fx * fx * (3 - 2 * fx)
  const uy = fy * fy * (3 - 2 * fy)
  const a = hash2Cpu(ix, iy)
  const b = hash2Cpu(ix + 1, iy)
  const c = hash2Cpu(ix, iy + 1)
  const d = hash2Cpu(ix + 1, iy + 1)
  return a + (b - a) * ux + (c - a + (a - b - c + d) * ux) * uy
}

/** CPU mirror of staggered wood plank coordinates and specular response for unit verification. */
export function evaluateWoodPlankSample(
  x: number,
  z: number,
  params: MaterialRecipeParams = MATERIAL_RECIPES.wood_planks.defaults,
): { row: number; plank: number; buttDist: number; edgeDist: number; tint: [number, number, number]; specularStrength: number } {
  const width = 0.17 / Math.max(0.25, params.scale)
  const length = Math.max(0.35, params.elementRatio) / Math.max(0.25, params.scale)
  const row = Math.floor(z / width)
  const v = fract(z / width)
  const rowOffset = hash2Cpu(row, 17.3) + (row % 2) * 0.37
  const lengthWarp = (noise2Cpu((x / length) * 0.55, row * 3.17) - 0.5) * 0.42 * params.irregularity
  const uWarped = x / length + rowOffset + lengthWarp
  const plank = Math.floor(uWarped)
  const u = fract(uWarped)
  const h1 = hash2Cpu(row * 1.17 + 0.3, plank * 2.31 + 0.7) - 0.5
  const h2 = hash2Cpu(plank * 1.73 + 5.1, row * 3.11 + 2.9) - 0.5
  const vMult = 1 + h1 * 0.38 * params.colorVariation
  const warmR = 1 + h2 * 0.14 * params.colorVariation
  const warmG = 1 + h2 * 0.02 * params.colorVariation
  const warmB = 1 - h2 * 0.16 * params.colorVariation
  // Wood is matte by default (~0.75-0.9) with zero broad specular sheen.
  const specularStrength = params.roughness >= 0.72 ? 0 : Math.pow((0.72 - params.roughness) / 0.67, 1.6) * 0.35
  return {
    row,
    plank,
    buttDist: Math.min(u, 1 - u) * length,
    edgeDist: Math.min(v, 1 - v) * width,
    tint: [params.baseR * vMult * warmR, params.baseG * vMult * warmG, params.baseB * vMult * warmB],
    specularStrength,
  }
}

/** CPU mirror of the irregular Voronoi cobblestone cell & edge solver for unit verification. */
export function evaluateCobblestoneSample(
  x: number,
  z: number,
  params: MaterialRecipeParams = MATERIAL_RECIPES.cobblestone.defaults,
): { cellX: number; cellY: number; edgeDist: number; wornEdge: number; stoneScale: number; inJoint: boolean } {
  const cellScale = (1 / Math.max(0.15, params.elementRatio)) * params.scale
  const wx = (noise2Cpu(x * 0.85 + 1.7, z * 0.85 + 4.1) - 0.5) * 0.38 * params.irregularity
  const wz = (noise2Cpu(x * 0.85 + 9.3, z * 0.85 + 2.7) - 0.5) * 0.38 * params.irregularity
  const qx = x * cellScale + wx
  const qz = z * cellScale + wz
  const iqx = Math.floor(qx)
  const iqz = Math.floor(qz)
  const fqx = qx - iqx
  const fqz = qz - iqz
  let d1 = 1e9
  let d2 = 1e9
  let bestX = iqx
  let bestY = iqz
  let bestScale = 1
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const cx = iqx + ox
      const cy = iqz + oy
      const stagger = (cy & 1) * 0.5 * (1 - params.irregularity * 0.6)
      const jx = fract(hash2Cpu(cx, cy) + stagger) - 0.5
      const jy = hash2Cpu(cx + 13.7, cy + 29.3) - 0.5
      const px = ox + 0.5 + jx * 0.78 * params.irregularity - fqx
      const py = oy + 0.5 + jy * 0.78 * params.irregularity - fqz
      const stoneWeight = 1 + (hash2Cpu(cx + 7.1, cy + 3.9) - 0.5) * 0.34 * params.irregularity
      const dist = Math.hypot(px, py) * stoneWeight
      if (dist < d1) {
        d2 = d1
        d1 = dist
        bestX = cx
        bestY = cy
        bestScale = 1 / stoneWeight
      } else if (dist < d2) {
        d2 = dist
      }
    }
  }
  const edgeDist = Math.max(0, d2 - d1)
  const cornerRound = Math.max(0, Math.min(1, (d1 - 0.22) / 0.45))
  const wornEdge = Math.max(0, edgeDist - params.wear * 0.085 * cornerRound)
  return {
    cellX: bestX,
    cellY: bestY,
    edgeDist,
    wornEdge,
    stoneScale: bestScale,
    inJoint: wornEdge < params.jointWidth,
  }
}

export type FoliageClusterTuft = {
  x: number
  z: number
  radius: number
  height: number
  blades: number
  tint: [number, number, number]
}

/**
 * Deterministic clustered ground-cover & shrub-understory scatter recipe.
 * Produces clump-correlated patches with intentional bare gaps rather than uniform confetti.
 */
export function scatterClusteredGroundCover(options: {
  seed: number
  bounds: readonly [number, number, number, number]
  clusterCount: number
  tuftsPerCluster?: number
  avoid?: (x: number, z: number) => boolean
}): FoliageClusterTuft[] {
  const { seed, bounds: [x0, z0, x1, z1], clusterCount, tuftsPerCluster = 5, avoid } = options
  const rng = new Rng(seed ^ 0x6a09e667)
  const palette: readonly [number, number, number][] = [
    [0.31, 0.38, 0.21],
    [0.26, 0.34, 0.18],
    [0.37, 0.40, 0.23],
    [0.24, 0.31, 0.16],
  ]
  const out: FoliageClusterTuft[] = []
  for (let c = 0; c < clusterCount; c++) {
    const cx = x0 + rng.next() * (x1 - x0)
    const cz = z0 + rng.next() * (z1 - z0)
    if (avoid?.(cx, cz)) continue
    const spread = 0.55 + rng.next() * 1.15
    const baseColor = palette[Math.floor(rng.next() * palette.length)]!
    const count = Math.max(2, Math.round(tuftsPerCluster * (0.65 + rng.next() * 0.7)))
    for (let i = 0; i < count; i++) {
      // Golden-angle spiral with radial jitter leaves natural gaps between clumps.
      const angle = i * 2.39996 + rng.next() * 0.65
      const dist = spread * Math.sqrt((i + 0.25) / count) * (0.55 + rng.next() * 0.6)
      const tx = cx + Math.cos(angle) * dist
      const tz = cz + Math.sin(angle) * dist
      if (tx < x0 || tx > x1 || tz < z0 || tz > z1 || avoid?.(tx, tz)) continue
      const shade = 0.84 + rng.next() * 0.32
      out.push({
        x: tx,
        z: tz,
        radius: 0.14 + rng.next() * 0.16,
        height: 0.11 + rng.next() * 0.18,
        blades: 3 + (i % 2),
        tint: [baseColor[0] * shade, baseColor[1] * shade, baseColor[2] * shade],
      })
    }
  }
  return out
}

function wgslVec4(a: number, b: number, c: number, d: number): string {
  return `vec4f(${a.toFixed(4)}, ${b.toFixed(4)}, ${c.toFixed(4)}, ${d.toFixed(4)})`
}

function defaultRecipeStructWgsl(id: MaterialRecipeId): string {
  const d = MATERIAL_RECIPES[id].defaults
  return `MaterialRecipe(${wgslVec4(d.baseR, d.baseG, d.baseB, d.roughness)}, ${wgslVec4(d.scale, d.elementRatio, d.irregularity, d.grainScale)}, ${wgslVec4(d.colorVariation, d.jointWidth, d.wear, d.macroVariation)})`
}

/**
 * Shared WGSL procedural + projected-texture material functions used by both the production scene shader (Outbreak)
 * and the interactive Lab Materials workbench.
 * Filter widths (`surfaceFootprint`, `surfaceGradX`, `surfaceGradY`) must be initialized in uniform control flow
 * before calling these functions.
 */
export const surfaceMaterialCoreWgsl = /* wgsl */ `
var<private> surfaceFootprint: f32;
var<private> surfaceTime: f32;
var<private> surfaceNormalShift: vec3f;
var<private> surfaceAlpha: f32;

struct MaterialRecipe {
  u0: vec4f, // baseR, baseG, baseB, roughness
  u1: vec4f, // scale, elementRatio, irregularity, grainScale
  u2: vec4f, // colorVariation, jointWidth, wear, macroVariation
}

@group(0) @binding(10) var materialTexArray: texture_2d_array<f32>;
@group(0) @binding(11) var materialSampler: sampler;

struct SurfaceSample {
  albedo: vec3f,
  gloss: vec2f,
  roughness: f32,
  cavity: f32,
}

fn textureLayerRefLinear(layer: i32) -> vec3f {
  switch layer {
    case 0: { return vec3f(0.4035, 0.1731, 0.0646); }
    case 1: { return vec3f(0.6427, 0.5308, 0.3801); }
    case 2: { return vec3f(0.7567, 0.6302, 0.4162); }
    case 3: { return vec3f(0.6159, 0.5723, 0.5086); }
    case 4: { return vec3f(0.1056, 0.1172, 0.1297); }
    case 5: { return vec3f(0.3143, 0.1732, 0.1377); }
    case 6: { return vec3f(0.4007, 0.3581, 0.3189); }
    case 7: { return vec3f(0.0931, 0.0927, 0.0950); }
    case 8: { return vec3f(0.1918, 0.1757, 0.0541); }
    case 9: { return vec3f(0.5001, 0.5000, 0.9996); }
    case 10: { return vec3f(0.2501, 0.2102, 0.1684); }
    case 11: { return vec3f(0.2654, 0.1868, 0.0342); }
    case 12: { return vec3f(0.3882, 0.2897, 0.1774); }
    case 13: { return vec3f(0.3522, 0.1986, 0.1107); }
    case 14: { return vec3f(0.2887, 0.2220, 0.1674); }
    default: { return vec3f(0.2950, 0.2326, 0.1649); }
  }
}

fn materialMipLod(effScale: f32) -> f32 {
  return clamp(log2(max(surfaceFootprint * effScale * 256.0, 1.0)) - 0.35, 0.0, 8.0);
}

fn sampleMaterialFast(layer: i32, uv0: vec2f, scale: f32) -> vec4f {
  return textureSampleLevel(materialTexArray, materialSampler, uv0 * scale, layer, materialMipLod(scale));
}

fn modulateFast(procCol: vec3f, tex: vec4f, refLin: vec3f, blend: f32) -> vec3f {
  let ratio = clamp(tex.rgb / refLin, vec3f(0.35), vec3f(2.15));
  let lumRatio = dot(ratio, vec3f(0.299, 0.587, 0.114));
  let balanced = mix(vec3f(lumRatio), ratio, 0.58);
  return procCol * clamp(vec3f(1.0) + (balanced - vec3f(1.0)) * blend, vec3f(0.38), vec3f(1.85));
}

// Four distinct lattice corners. Kept separate from the legacy material noise to preserve its look.
fn surfaceNoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash2(i), hash2(i + vec2f(1.0, 0.0)), u.x),
    mix(hash2(i + vec2f(0.0, 1.0)), hash2(i + vec2f(1.0, 1.0)), u.x),
    u.y
  );
}

// Analytical value-noise height (x) and gradient (yz) with C1 smoothstep derivatives (zero dpdx quad blockiness).
fn surfaceNoiseGrad(p: vec2f) -> vec3f {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let du = 6.0 * f * (1.0 - f);
  let a = hash2(i);
  let b = hash2(i + vec2f(1.0, 0.0));
  let c = hash2(i + vec2f(0.0, 1.0));
  let d = hash2(i + vec2f(1.0, 1.0));
  let k0 = b - a;
  let k1 = c - a;
  let k2 = a - b - c + d;
  let val = a + k0 * u.x + k1 * u.y + k2 * u.x * u.y;
  let grad = du * vec2f(k0 + k2 * u.y, k1 + k2 * u.x);
  return vec3f(val, grad.x, grad.y);
}

fn surfaceFbm(p: vec2f) -> f32 {
  return surfaceNoise(p) * 0.5 + surfaceNoise(p * 2.03 + 7.1) * 0.3 + surfaceNoise(p * 4.1 + 3.7) * 0.2;
}

fn seam(q: f32, width: f32, frequency: f32) -> f32 {
  let d = abs(fract(q + 0.5) - 0.5);
  let aa = max(surfaceFootprint * frequency, 0.002);
  return mix(smoothstep(width - aa, width + aa, d), 1.0 - 2.0 * width, smoothstep(0.22, 0.75, aa));
}

fn grain(p: vec2f, frequency: f32) -> f32 {
  let fade = 1.0 - smoothstep(0.32, 0.98, surfaceFootprint * frequency);
  return (surfaceNoise(p * frequency) - 0.5) * fade;
}

/**
 * Convert perceptual roughness + unresolved normal variance into the renderer's (shininess, strength) pair.
 * Matte surfaces (roughness >= 0.72, including default wood planks at 0.84) produce zero broad specular sheen.
 */
fn roughnessToGloss(roughness: f32, normalVariance: f32) -> vec2f {
  let effRough = sqrt(clamp(roughness * roughness + normalVariance * clamp(surfaceFootprint * 12.0, 0.0, 1.0), 0.0025, 1.0));
  if (effRough >= 0.72) {
    return vec2f(0.0, 0.0);
  }
  let smoothness = clamp((0.72 - effRough) / 0.67, 0.0, 1.0);
  let shininess = mix(10.0, 110.0, smoothness * smoothness);
  let strength = smoothness * smoothness * 0.45;
  return vec2f(shininess, strength);
}

fn defaultMaterialRecipe(id: i32) -> MaterialRecipe {
  switch id {
    case 0: { return ${defaultRecipeStructWgsl("wood_planks")}; }
    case 1: { return ${defaultRecipeStructWgsl("cobblestone")}; }
    case 2: { return ${defaultRecipeStructWgsl("plaster_wall")}; }
    case 3: { return ${defaultRecipeStructWgsl("asphalt_concrete")}; }
    case 4: { return ${defaultRecipeStructWgsl("grass_soil")}; }
    default: { return ${defaultRecipeStructWgsl("foliage_canopy")}; }
  }
}

/** Recipe 0: Matte wood planks with staggered lengths, butt-joint AO, cathedral heartwood figure, and projected oak floorboards texture. */
fn evalWoodPlanks(p: vec2f, baseTint: vec3f, r: MaterialRecipe) -> SurfaceSample {
  let scale = max(0.25, r.u1.x);
  let boardWidth = 0.165 / scale;
  let boardLen = max(0.35, r.u1.y) / scale;
  let irreg = r.u1.z;
  let gScale = max(0.25, r.u1.w);
  let colVar = r.u2.x;
  let jWidth = r.u2.y;
  let wear = r.u2.z;
  let macroVar = r.u2.w;

  let row = floor(p.y / boardWidth);
  let v = fract(p.y / boardWidth);
  // Staggered row phase + per-row length modulation so butt joints never align in a grid.
  let rowPhase = hash2(vec2f(row, 17.3)) + fract(row * 0.37);
  let rowScale = 1.0 + (hash2(vec2f(row, 5.9)) - 0.5) * 0.28 * irreg;
  let effLen = boardLen * rowScale;
  let uCoord = p.x / effLen + rowPhase;
  let plank = floor(uCoord);
  let u = fract(uCoord);

  let hVal = hash2(vec2f(row * 1.17 + 0.3, plank * 2.31 + 0.7)) - 0.5;
  let hHue = hash2(vec2f(plank * 1.73 + 5.1, row * 3.11 + 2.9)) - 0.5;

  // Warm amber vs aged chestnut board-to-board variation.
  let boardTint = vec3f(1.0 + hHue * 0.14 * colVar, 1.0 + hHue * 0.02 * colVar, 1.0 - hHue * 0.16 * colVar);
  let boardValue = 0.94 + hVal * 0.34 * colVar;
  var col = baseTint * boardTint * boardValue;

  // Longitudinal heartwood grain + subtle parabolic cathedral figure (readable at gameplay zoom ~34-42m).
  let ringFreq = 9.0 * gScale * scale;
  let fadeMed = 1.0 - smoothstep(0.35, 0.98, surfaceFootprint * ringFreq);
  let longStreak = (surfaceNoise(vec2f(p.x * 0.85 + hVal * 7.0, p.y * 13.5) * gScale + vec2f(row, plank) * 3.1) - 0.5) * fadeMed;
  let curve = abs(v - 0.5 + 0.18 * hHue) * 2.2 + 0.12 * (u - 0.5) * (u - 0.5) + 0.14 * longStreak;
  let cathedral = (0.5 + 0.5 * sin(curve * 11.0 * gScale)) - 0.5;
  let fiber = grain(vec2f(p.x * 1.3 + hVal * 9.0, p.y * 25.0) * gScale, 1.0);
  col *= 1.0 + longStreak * 0.16 + cathedral * 0.08 * fadeMed + fiber * 0.14;

  // Anti-aliased long edge seams AND staggered butt-joint seams stay crisp over the texture.
  let seamLong = seam(p.y / boardWidth, max(0.004, jWidth * 0.42), 1.0 / boardWidth);
  let seamButt = seam(uCoord, max(0.003, jWidth * 0.18), 1.0 / effLen);
  let joints = seamLong * seamButt;
  let endWear = (1.0 - smoothstep(0.0, 0.08, min(u, 1.0 - u))) * wear * 0.13;
  let edgeBevel = (1.0 - smoothstep(0.0, 0.11, min(v, 1.0 - v))) * wear * 0.09;
  col *= (1.0 - endWear - edgeBevel);
  col = mix(col * vec3f(0.38, 0.31, 0.24), col, mix(0.32, 1.0, joints));

  // Macro traffic/weathering breakup across the room.
  let macroTone = surfaceNoise(p * 0.35 + vec2f(2.1, 5.7)) - 0.5;
  col *= 1.0 + macroTone * 0.18 * macroVar;

  let localRough = clamp(r.u0.w + (1.0 - joints) * 0.12, 0.05, 1.0);
  return SurfaceSample(col, roughnessToGloss(localRough, 0.035), localRough, joints);
}

/** Recipe 1: Irregular Voronoi cobblestone / stone pavers with projected stone texture, worn edges, and recessed dirt joints. */
fn evalCobblestone(p: vec2f, baseTint: vec3f, r: MaterialRecipe) -> SurfaceSample {
  let scale = max(0.25, r.u1.x);
  let stoneSize = max(0.15, r.u1.y);
  let cellScale = (1.0 / stoneSize) * scale;
  let irreg = r.u1.z;
  let gScale = max(0.25, r.u1.w);
  let colVar = r.u2.x;
  let jWidth = r.u2.y;
  let wear = r.u2.z;
  let macroVar = r.u2.w;

  let nWarp = surfaceNoise(p * 0.85 + vec2f(1.7, 4.1)) - 0.5;
  let q = p * cellScale + vec2f(nWarp, -nWarp * 0.8) * 0.38 * irreg;
  let baseCell = floor(q - 0.5);

  var d1 = 1e9;
  var d2 = 1e9;
  var id1 = vec2f(0.0);
  var delta1 = vec2f(0.0);

  for (var oy = 0; oy <= 1; oy++) {
    for (var ox = 0; ox <= 1; ox++) {
      let cell = baseCell + vec2f(f32(ox), f32(oy));
      let h0 = hash2(cell);
      let h1 = fract(h0 * 17.37 + 0.31);
      let stagger = f32(i32(cell.y) & 1) * 0.42 * (1.0 - irreg * 0.6);
      let jx = fract(h0 + stagger) - 0.5;
      let jy = h1 - 0.5;
      let feat = cell + 0.5 + vec2f(jx, jy) * 0.68 * irreg - q;
      let weight = 1.0 + (fract(h0 * 7.13) - 0.5) * 0.30 * irreg;
      let d = length(feat) * weight;
      if (d < d1) {
        d2 = d1;
        d1 = d;
        id1 = cell;
        delta1 = feat;
      } else if (d < d2) {
        d2 = d;
      }
    }
  }

  let edgeDist = max(0.0, d2 - d1);
  let cornerRound = smoothstep(0.20, 0.62, d1);
  let wornEdge = max(0.0, edgeDist - wear * 0.08 * cornerRound);
  let aa = max(surfaceFootprint * cellScale, 0.008);
  let rawStoneMask = smoothstep(jWidth - aa, jWidth + aa, wornEdge);
  let avgStone = clamp(1.0 - jWidth * 1.65, 0.55, 0.95);
  let stoneMask = mix(rawStoneMask, avgStone, smoothstep(0.28, 0.85, aa));

  let hVal = hash2(id1 * 1.37 + 0.5) - 0.5;
  let hWarm = fract((hVal + 0.5) * 13.7) - 0.5;
  var stoneCol = baseTint * (0.92 + hVal * 0.36 * colVar) * vec3f(1.0 + hWarm * 0.12 * colVar, 1.0 + hWarm * 0.03 * colVar, 1.0 - hWarm * 0.13 * colVar);

  let bevel = smoothstep(jWidth, jWidth + 0.16 + wear * 0.14, wornEdge);
  let rimWear = (1.0 - bevel) * stoneMask * wear * 0.18;
  let slopeShade = 1.0 + dot(delta1, vec2f(-0.32, -0.32)) * 0.14;
  let mineralGrit = grain(p, 11.5 * gScale) * 0.20;
  stoneCol = stoneCol * slopeShade * (0.86 + 0.14 * bevel + mineralGrit) + vec3f(0.06, 0.055, 0.045) * rimWear;

  let macroNoise = surfaceNoise(p * 0.45 + vec2f(6.2, 1.9));
  let mossMask = smoothstep(0.55, 0.82, macroNoise) * macroVar;
  let dirtCol = mix(baseTint * vec3f(0.36, 0.32, 0.25), vec3f(0.18, 0.23, 0.13), mossMask * 0.65);
  var col = mix(dirtCol, stoneCol, stoneMask);
  col *= 1.0 - (macroNoise - 0.48) * macroVar * 0.22;

  let localRough = clamp(r.u0.w + (1.0 - stoneMask) * 0.12, 0.05, 1.0);
  return SurfaceSample(col, roughnessToGloss(localRough, 0.05), localRough, mix(0.45, 1.0, bevel * stoneMask));
}

/** Recipe 2: Plaster & wallpapered wall with 1970s lower walnut wainscot paneling, chair-rail molding, and upper trowel-stippled plaster/wallpaper. */
fn evalPlasterWall(world: vec3f, normal: vec3f, baseTint: vec3f, r: MaterialRecipe) -> SurfaceSample {
  let scale = max(0.25, r.u1.x);
  let gScale = max(0.25, r.u1.w);
  let colVar = r.u2.x;
  let wear = r.u2.z;
  let macroVar = r.u2.w;
  surfaceNormalShift = vec3f(0.0);

  let uv = vec2f(world.x + world.z, world.y);
  let patchNoise = surfaceNoise(uv * 0.65 * scale + vec2f(1.9, 3.4));
  let stipple = grain(uv, 9.0 * gScale) * 0.16;

  // Lower 0.13..0.94m timber wainscot paneling with vertical V-grooves + 0.94..0.99m chair-rail molding
  let inWainscot = world.y > 0.13 && world.y < 0.96 && abs(normal.y) < 0.35;
  let chairRailBand = smoothstep(0.91, 0.95, world.y) * (1.0 - smoothstep(0.96, 1.01, world.y)) * step(abs(normal.y), 0.35);
  var col = baseTint;
  var localRough = r.u0.w;

  if (inWainscot) {
    let boardPitch = 0.14 / scale;
    let bIdx = floor(uv.x / boardPitch);
    let bHash = hash2(vec2f(bIdx, 7.1)) - 0.5;
    let vGroove = seam(uv.x / boardPitch, 0.032, 1.0 / boardPitch);
    let woodGrain = grain(vec2f(uv.x * 3.5, uv.y * 18.0) * gScale, 1.0) * 0.18;
    let panelTint = vec3f(0.22, 0.15, 0.095) * (0.94 + bHash * 0.22 * colVar) * (1.0 + woodGrain);
    col = panelTint * mix(0.42, 1.0, vGroove);
    localRough = 0.76;
  } else {
    let exposedPlaster = smoothstep(0.50 - wear * 0.20, 0.76 - wear * 0.10, patchNoise) * wear;
    let underTone = baseTint * vec3f(0.84, 0.78, 0.68);
    col = mix(baseTint, underTone, exposedPlaster * (0.55 + 0.45 * colVar));
    col *= 1.0 + stipple * (1.0 + 0.35 * exposedPlaster);
    localRough = clamp(r.u0.w + exposedPlaster * 0.08, 0.05, 1.0);
  }

  // Moulded wooden chair rail at y ~ 0.95m
  col = mix(col, vec3f(0.28, 0.19, 0.12), chairRailBand * 0.85);
  let streak = surfaceNoise(vec2f(uv.x * 2.4 * scale, uv.y * 0.45)) * smoothstep(1.55, 2.74, world.y) * wear * 0.26;
  let baseWear = (1.0 - smoothstep(0.12, 0.42, world.y)) * (0.20 + 0.14 * patchNoise) * wear;
  let macroTone = (patchNoise - 0.5) * macroVar * 0.20;
  col *= clamp(1.0 - streak - baseWear + macroTone, 0.36, 1.25);

  return SurfaceSample(col, roughnessToGloss(localRough, 0.03), localRough, 1.0 - baseWear);
}

/** Recipe 3: Asphalt road & concrete sidewalk slabs with projected aggregate/concrete textures, tar seams, and worn joints. */
fn evalAsphaltConcrete(p: vec2f, baseTint: vec3f, isConcrete: bool, r: MaterialRecipe) -> SurfaceSample {
  let scale = max(0.25, r.u1.x);
  let slabSize = max(0.4, r.u1.y) / scale;
  let irreg = r.u1.z;
  let gScale = max(0.25, r.u1.w);
  let colVar = r.u2.x;
  let jWidth = r.u2.y;
  let wear = r.u2.z;
  let macroVar = r.u2.w;

  var col = baseTint;
  var localRough = r.u0.w;
  var cavity = 1.0;

  if (isConcrete) {
    let isCurb = (p.y >= 39.78 && p.y <= 40.02) || (p.y >= 47.98 && p.y <= 48.22) || (p.x >= 39.78 && p.x <= 40.02) || (p.x >= 47.98 && p.x <= 48.22);
    let warp = (surfaceNoise(p * 1.4 + 2.3) - 0.5) * 0.035 * irreg;
    let q = p / slabSize + warp;
    let cell = floor(q);
    let fq = fract(q);
    let hSlab = hash2(cell * 1.73 + 0.9) - 0.5;
    let hWarm = fract((hSlab + 0.5) * 11.3) - 0.5;
    col *= (0.94 + hSlab * 0.18 * colVar) * vec3f(1.0 + hWarm * 0.06 * colVar, 1.0 + hWarm * 0.02 * colVar, 1.0 - hWarm * 0.07 * colVar);

    let sx = seam(q.x, max(0.003, jWidth * 0.16), 1.0 / slabSize);
    let sy = seam(q.y, max(0.003, jWidth * 0.16), 1.0 / slabSize);
    var joint = sx * sy;
    if (isCurb) {
      joint = seam(q.x * 0.75, 0.006, 0.75 / slabSize);
      col *= vec3f(0.84, 0.86, 0.90);
    }
    let edgeDist = min(min(fq.x, 1.0 - fq.x), min(fq.y, 1.0 - fq.y));
    let edgeDirt = (1.0 - smoothstep(0.0, 0.09 + wear * 0.08, edgeDist)) * wear * 0.18;
    let grit = grain(p, 10.5 * gScale) * 0.16;
    let macroTone = (warp / max(0.001, 0.035 * irreg)) * 0.18 * macroVar;
    col *= 0.95 + grit + macroTone - edgeDirt;
    col = mix(col * vec3f(0.38, 0.37, 0.32), col, joint);
    cavity = joint;
  } else {
    let coarseAgg = grain(p, 7.2 * gScale) * 0.24;
    let patchField = surfaceNoise(p * 0.42 * scale + vec2f(3.1, 6.7));
    let tarPatch = smoothstep(0.58 - wear * 0.15, 0.68 - wear * 0.10, patchField) * wear;
    let crackField = abs(surfaceNoise(p * 0.78 * scale + vec2f(patchField * 0.45)) - 0.5);
    let crackAa = max(surfaceFootprint * 0.78 * scale, 0.006);
    let crack = (1.0 - smoothstep(0.006, 0.016 + crackAa, crackField)) * step(0.45, patchField) * wear;
    let macroTone = (surfaceNoise(p * 0.20 + vec2f(8.3, 1.4)) - 0.5) * 0.24 * macroVar;
    let gutterDist = min(abs(p.y - 40.0), abs(p.y - 48.0));
    let gutterShade = 1.0 - (1.0 - smoothstep(0.0, 0.38, gutterDist)) * 0.36;
    let leafCell = floor(p * 9.5);
    let leafHash = hash2(leafCell + vec2f(4.7, 9.1));
    let leafMask = step(0.955, leafHash) * (1.0 - smoothstep(0.0, 1.35, gutterDist)) * (1.0 - smoothstep(0.18, 0.55, surfaceFootprint * 9.5));

    col *= (0.96 + coarseAgg + macroTone + (patchField - 0.5) * 0.12 * colVar) * gutterShade;
    col = mix(col, col * vec3f(0.76, 0.78, 0.82), tarPatch * 0.55);
    col = mix(col, col * 0.50, crack * 0.68);
    col = mix(col, vec3f(0.42, 0.28, 0.14), leafMask * 0.75);
    localRough = clamp(localRough - tarPatch * 0.08 + crack * 0.08, 0.05, 1.0);
    cavity = (1.0 - crack * 0.4) * gutterShade;
  }

  return SurfaceSample(col, roughnessToGloss(localRough, 0.045), localRough, cavity);
}

fn evalMulchBed(p: vec2f, baseTint: vec3f, scale: f32, gScale: f32) -> SurfaceSample {
  let barkG = surfaceNoiseGrad(vec2f(p.x * 4.2, p.y * 6.5) * gScale);
  let damp = smoothstep(0.32, 0.72, surfaceNoise(p * 0.85 * scale));
  var col = mix(baseTint * vec3f(0.92, 0.84, 0.72), baseTint * vec3f(0.48, 0.42, 0.34), damp * 0.65);
  col *= 0.82 + (barkG.x - 0.5) * 0.38;
  let atten = 1.0 - smoothstep(0.08, 0.45, surfaceFootprint);
  surfaceNormalShift = vec3f(barkG.y * 0.16, 0.0, barkG.z * 0.16) * atten;
  return SurfaceSample(col, vec2f(0.0), 0.95, 0.88);
}

/** Recipe 4: Clump-correlated lawn turf with impostor blade-tuft relief, mowed/overgrown zones & wind waves. */
fn evalGrassSoil(p: vec2f, baseTint: vec3f, isMulchBed: bool, r: MaterialRecipe) -> SurfaceSample {
  let scale = max(0.25, r.u1.x);
  let clumpSize = max(0.25, r.u1.y) / scale;
  let irreg = r.u1.z;
  let gScale = max(0.25, r.u1.w);
  let colVar = r.u2.x;
  let wear = r.u2.z;
  let macroVar = r.u2.w;
  surfaceNormalShift = vec3f(0.0);

  if (isMulchBed) {
    return evalMulchBed(p, baseTint, scale, gScale);
  }

  // Wind-aligned coordinate frame (matching applyFoliageVertexWind's windDir = (0.88, 0.47))
  let windUv = vec2f(p.x * 0.88 + p.y * 0.47, p.y * 0.88 - p.x * 0.47);
  let windPhase = (p.x * 0.88 + p.y * 0.47) * 0.42 + surfaceTime * 1.45;
  let windCross = (-p.x * 0.47 + p.y * 0.88) * 0.42;
  let windWave = sin(windPhase) * 0.55 + sin(windPhase * 0.37 + windCross * 0.90 + surfaceTime * 0.45) * 0.45;
  let windCrest = smoothstep(-0.25, 0.68, windWave);

  // 1. Mowed vs. Overgrown clump architecture (readable at 34-46m game camera)
  let c0 = surfaceNoise(p * (0.62 / clumpSize) + vec2f(1.3, 4.2));
  let c1 = surfaceNoise(p * (1.45 / clumpSize) + vec2f(c0 * 1.3 * irreg, 6.7));
  let clumpField = c0 * 0.56 + c1 * 0.44;
  let overgrownMask = smoothstep(0.34, 0.72, clumpField);

  // 2. Multi-scale impostor blade-tuft micro-relief + high-frequency detail normal (visible at 34-46m AND close-up)
  let tuftMed = surfaceNoiseGrad(windUv * vec2f(3.2, 2.2) * gScale + vec2f(4.2, 7.1));
  let detailG = surfaceNoiseGrad(windUv * vec2f(14.5, 11.0) * gScale + vec2f(1.7, 8.3));
  let bladeFreq = 26.0 * gScale;
  let bladeAtten = 1.0 - smoothstep(0.04, 0.32, surfaceFootprint * bladeFreq * 0.08);
  let bladeFine = (surfaceNoise(windUv * vec2f(bladeFreq, bladeFreq * 0.65) + vec2f(windWave * 0.35, 2.9)) - 0.5) * bladeAtten;

  let tuftHeight = c1 * 0.32 + tuftMed.x * 0.36 + (detailG.x - 0.5) * 0.28 + bladeFine * 0.32;
  let bladeCrest = smoothstep(0.24, 0.72, tuftHeight + overgrownMask * 0.14);
  let rootThatch = 1.0 - smoothstep(0.18, 0.52, tuftHeight);

  // Deep forest-moss root thatch in crevices -> rich olive-emerald mid-turf -> muted sage-olive tips on crests
  let deepRootTint = baseTint * vec3f(0.32, 0.44, 0.26);
  let lushMidTint = baseTint * vec3f(0.68, 0.84, 0.54);
  let sunlitTipTint = baseTint * vec3f(0.96, 1.10, 0.66);
  let dryStrawTint = baseTint * vec3f(0.92, 0.80, 0.48);

  let dryMix = smoothstep(0.42 - wear * 0.18, 0.78 - wear * 0.10, c0 * 0.65 + (1.0 - c1) * 0.35) * colVar * 0.72;
  var turfCol = mix(deepRootTint, lushMidTint, smoothstep(0.14, 0.56, tuftHeight));
  turfCol = mix(turfCol, sunlitTipTint, bladeCrest * (0.44 + 0.32 * overgrownMask));
  turfCol = mix(turfCol, dryStrawTint, dryMix * (0.42 + 0.48 * bladeCrest));

  // Subtle wind-driven value waves across the lawn
  let gustWave = smoothstep(0.34, 0.74, windCrest * 0.65 + c0 * 0.35) * (0.30 + 0.55 * overgrownMask);
  turfCol = mix(turfCol, turfCol * vec3f(1.10, 1.14, 0.90), gustWave * 0.26);

  // Broad painterly lawn value waves & damp mossy troughs
  let macroPatch = surfaceNoise(p * 0.22 + vec2f(5.1, 2.7));
  let macroShade = mix(0.74, 1.12, smoothstep(0.24, 0.76, macroPatch));
  let soilMask = smoothstep(0.50 - wear * 0.20, 0.80 - wear * 0.10, 1.0 - clumpField) * rootThatch * macroVar;
  let soilCol = vec3f(0.015, 0.018, 0.010) * (0.82 + 0.25 * c1);
  var col = mix(turfCol * macroShade, soilCol, soilMask * 0.52);

  // Scattered warm autumn fallen leaf flecks on the lawn and verge
  let leafCell = floor(p * 8.2);
  let leafHash = hash2(leafCell + vec2f(3.7, 7.9));
  let leafPatch = smoothstep(0.42, 0.72, c0 * 0.6 + macroPatch * 0.4);
  let leafMask = step(0.958, leafHash) * leafPatch * (1.0 - smoothstep(0.18, 0.55, surfaceFootprint * 8.2));
  let leafCol = select(vec3f(0.14, 0.07, 0.02), vec3f(0.18, 0.11, 0.03), fract(leafHash * 19.3) > 0.5);
  col = mix(col, leafCol, leafMask * 0.72);

  // High-frequency ground detail normal + tuft mound normal so the lawn never reads as a flat plane
  let normAtten = 1.0 - smoothstep(0.14, 0.85, surfaceFootprint);
  let detailAtten = 1.0 - smoothstep(0.05, 0.36, surfaceFootprint);
  let nx = (tuftMed.y * 0.38 + detailG.y * 0.46 * detailAtten + bladeFine * 0.28 + windWave * 0.10) * normAtten;
  let nz = (tuftMed.z * 0.38 + detailG.z * 0.46 * detailAtten + bladeFine * 0.22 + windWave * 0.06) * normAtten;
  surfaceNormalShift = vec3f(nx, 0.0, nz);

  let cavity = clamp(mix(0.46, 0.98, bladeCrest) * (0.80 + 0.20 * overgrownMask), 0.38, 1.0);
  let localRough = clamp(r.u0.w - gustWave * 0.10 - bladeCrest * 0.06, 0.48, 0.96);
  return SurfaceSample(col, roughnessToGloss(localRough, 0.04), localRough, cavity);
}

/** Recipe 5: Clustered foliage canopy with procedural leaf-cluster platelets, inter-leaf gaps, and spherized dome shading. */
fn evalFoliageCanopy(world: vec3f, normal: vec3f, baseTint: vec3f, r: MaterialRecipe) -> SurfaceSample {
  let scale = max(0.25, r.u1.x);
  let clusterSize = max(0.2, r.u1.y) / scale;
  let gScale = max(0.25, r.u1.w);
  let colVar = r.u2.x;
  let wear = r.u2.z;
  let macroVar = r.u2.w;
  surfaceNormalShift = vec3f(0.0);

  let n0 = surfaceNoise(world.xz * 2.1 + 1.3) - 0.5;
  let warp = vec3f(n0, 0.0, -n0 * 0.8) * clusterSize * 0.9 * r.u1.z;
  let clusterCell = floor((world + warp) / clusterSize);
  let hCluster = hash2(clusterCell.xz + vec2f(clusterCell.y * 3.7, 11.3)) - 0.5;
  let hHue = fract((hCluster + 0.5) * 13.7) - 0.5;

  // Non-degenerate 3D tangent projection for individual 6-10cm overlapping leaf platelets & midribs
  let uv3 = vec2f(world.x + world.z * 0.73 + world.y * 0.41, world.y * 1.17 - world.x * 0.43 + world.z * 0.81);
  let clusterG = surfaceNoiseGrad(uv3 * (7.2 * gScale) + vec2f(1.7, 6.3));
  let bladeG = surfaceNoiseGrad(uv3 * (16.5 * gScale) + vec2f(clusterG.x * 0.6 + 5.4, 2.9));
  let microLeaf = clusterG.x * 0.56 + bladeG.x * 0.44;
  // Dark inter-leaf crevices separate each card into a cluster of small individual leaves
  let leafGap = 1.0 - smoothstep(0.24, 0.50, microLeaf);
  let leafPlate = smoothstep(0.40, 0.80, microLeaf);

  let topMask = clamp(normal.y * 0.5 + 0.5, 0.0, 1.0);
  let heightLift = smoothstep(0.05, 1.2, fract(world.y * 0.55));
  let canopyLift = mix(0.64 - wear * 0.08, 1.24, clamp(topMask * 0.68 + heightLift * 0.22 + (microLeaf - 0.5) * 0.28, 0.0, 1.0));
  let warmTip = clamp((microLeaf - 0.45) + topMask * 0.35 - 0.10, -0.4, 0.55);
  let hueTint = vec3f(
    1.0 + (hHue * 0.16 + warmTip * 0.18) * colVar,
    1.0 + (hHue * 0.08 + warmTip * 0.10) * colVar,
    1.0 - (hHue * 0.14 + warmTip * 0.16) * colVar
  );
  var col = baseTint * hueTint * (0.94 + hCluster * 0.26 * colVar) * canopyLift;
  col *= (1.0 - 0.26 * leafGap + 0.14 * leafPlate) * (1.0 + n0 * 0.14 * macroVar);

  let leafBumpAtten = (1.0 - smoothstep(0.08, 0.55, surfaceFootprint)) * 0.32;
  surfaceNormalShift = vec3f(
    clusterG.y * 0.55 + bladeG.y * 0.45,
    (clusterG.z - bladeG.y) * 0.25,
    clusterG.z * 0.55 + bladeG.z * 0.45
  ) * leafBumpAtten;

  let cavity = clamp(mix(0.56, 1.0, topMask) * (1.0 - 0.22 * leafGap), 0.42, 1.0);
  return SurfaceSample(col, roughnessToGloss(r.u0.w, 0.05), r.u0.w, cavity);
}

/**
 * Evaluates weathered 1970s/80s kitchen ceramic & travertine vinyl floor tiles with recessed grout normals & warm patina.
 */
fn evalKitchenTile(p: vec2f, baseTint: vec3f) -> SurfaceSample {
  let tileSize = 0.38;
  let q = p / tileSize;
  let cell = floor(q);
  let fq = fract(q);
  let hTile = hash2(cell * 1.91 + 0.7) - 0.5;
  let hHue = fract((hTile + 0.5) * 13.7) - 0.5;
  let chipped = step(0.90, fract((hTile + 0.5) * 29.3)) * 0.22;
  var col = baseTint * (0.94 + hTile * 0.28) * (1.0 - chipped) * vec3f(1.0 + hHue * 0.10, 1.0 + hHue * 0.03, 1.0 - hHue * 0.10);
  let edgeDist = min(min(fq.x, 1.0 - fq.x), min(fq.y, 1.0 - fq.y));
  let edgeWear = (1.0 - smoothstep(0.0, 0.14, edgeDist)) * 0.16;
  let joint = seam(q.x, 0.028, 1.0 / tileSize) * seam(q.y, 0.028, 1.0 / tileSize);
  let grime = (surfaceNoise(p * 0.85 + vec2f(3.1, 5.7)) - 0.42) * 0.28;
  col = mix(col * vec3f(0.24, 0.20, 0.16), col * (1.0 - edgeWear - max(0.0, grime)), joint);
  return SurfaceSample(col, vec2f(26.0, 0.07 * joint), 0.76, joint);
}
`

/** Opt-in matte outdoor & architectural finishes. Games assign materials/palettes; existing shaders stay identical. */
export const surfaceMaterialDeclarations = surfaceMaterialCoreWgsl

export const surfaceMaterial = /* wgsl */ `
    let texCfg = u32(max(0.0, F.screen.w));
    let texModeBits = texCfg & 3u;
    let texOn = select(texModeBits == 1u, o.world.x >= F.eye.x, texModeBits == 2u);
    let rugStyleBits = (texCfg >> 2u) & 3u;
    let wallStyleBits = (texCfg >> 4u) & 3u;
    let floorStyleBits = (texCfg >> 6u) & 3u;
    let texScaleMult = select(1.0, 0.5 + f32((texCfg >> 8u) & 63u) * 0.05, ((texCfg >> 8u) & 63u) > 0u);
    let texContrastMult = select(1.0, f32((texCfg >> 14u) & 63u) * 0.05, ((texCfg >> 14u) & 63u) > 0u);
    let weatherMult = select(1.0, f32((texCfg >> 20u) & 15u) * 0.2, ((texCfg >> 20u) & 15u) > 0u);
    if (mat == 20) {
      let kind = i32(round(o.aux));
      let p = o.world.xz;
      let inNorthVerge = kind == 2 && p.y > 39.32 && p.y < 39.78 && (p.x < 37.8 || p.x > 50.2);
      let inSouthVerge = kind == 2 && p.y > 48.22 && p.y < 48.68 && (p.x < 37.8 || p.x > 50.2);
      let inVergeGrass = (inNorthVerge || inSouthVerge) && !((p.x > 18.8 && p.x < 21.8) || (p.x > 49.8 && p.x < 52.8)) && !((p.x > 26.8 && p.x < 28.6 && p.y < 40.0) || (p.x > 25.8 && p.x < 27.6 && p.y > 48.0));
      if (kind == 0 || inVergeGrass) {
        var vEdge = 1.0;
        var grassTint = albedo;
        if (inVergeGrass) {
          let vDist = select(min(p.y - 48.22, 48.68 - p.y), min(p.y - 39.32, 39.78 - p.y), inNorthVerge);
          vEdge = smoothstep(0.0, 0.08, vDist);
          grassTint = vec3f(0.022, 0.038, 0.012) * (0.42 + 0.58 * vEdge);
        }
        let s = evalGrassSoil(p, grassTint, false, defaultMaterialRecipe(4));
        albedo = s.albedo * s.cavity * select(1.0, 0.55 + 0.45 * vEdge, inVergeGrass);
        n = normalize(n + surfaceNormalShift);
        if (texOn && !inVergeGrass) {
          let tex = sampleMaterialFast(8, p, 0.58 * texScaleMult);
          albedo = modulateFast(albedo, tex, vec3f(0.1918, 0.1757, 0.0541), 0.82 * texContrastMult);
        }
      } else if (kind == 1) {
        let s = evalAsphaltConcrete(p, albedo, false, defaultMaterialRecipe(3));
        albedo = s.albedo;
        if (texOn) {
          let tex = sampleMaterialFast(7, p, 0.55 * texScaleMult);
          albedo = modulateFast(albedo, tex, vec3f(0.0931, 0.0927, 0.0950), 0.85 * texContrastMult);
        }
      } else if (kind == 2) {
        let isShopFloor = p.x > 52.9 && (p.y < 38.1 || p.y > 53.9);
        if (isShopFloor) {
          let s = evalKitchenTile(p, albedo);
          albedo = s.albedo;
          if (texOn) {
            let tex = sampleMaterialFast(1, p, 0.88 * texScaleMult);
            albedo = modulateFast(albedo, tex, vec3f(0.6427, 0.5308, 0.3801), 0.85 * texContrastMult);
          }
        } else {
          let s = evalAsphaltConcrete(p, albedo, true, defaultMaterialRecipe(3));
          albedo = s.albedo * s.cavity;
          if (texOn) {
            let tex = sampleMaterialFast(6, p, 0.58 * texScaleMult);
            albedo = modulateFast(albedo, tex, vec3f(0.4007, 0.3581, 0.3189), 0.82 * texContrastMult);
          }
          // Weathered porch deck & front walkway: step tread seams, edge moss/grime, and threshold stain.
          let bPorch = select(vec4f(21.0, 54.0, 36.0, 65.5), vec4f(22.0, 24.0, 37.0, 35.5), p.y < 44.0);
          let onPorch = p.x >= bPorch.x + 4.45 && p.x <= bPorch.x + 7.05 && p.y >= bPorch.w - 0.05 && p.y <= bPorch.w + 1.32;
          let onWalk = p.x >= bPorch.x + 4.95 && p.x <= bPorch.x + 6.45 && p.y > bPorch.w + 1.32 && p.y <= bPorch.w + 4.55;
          if (onPorch) {
            let edgeX = min(p.x - (bPorch.x + 4.5), (bPorch.x + 7.0) - p.x);
            let edgeZ = min(p.y - bPorch.w, (bPorch.w + 1.3) - p.y);
            let borderGrime = smoothstep(0.0, 0.32, min(edgeX, edgeZ));
            let stainNoise = surfaceNoise(p * 3.4 + vec2f(1.7, 5.2));
            let rustStain = smoothstep(0.42, 0.76, stainNoise) * exp(-length(p - vec2f(bPorch.x + 5.35, bPorch.w + 0.92)) * 2.1) * weatherMult;
            let stepSeam = seam((p.y - bPorch.w) / 0.42, 0.024, 2.38);
            albedo *= (0.44 + 0.32 * borderGrime) * mix(0.52, 1.0, stepSeam);
            albedo = mix(albedo, vec3f(0.11, 0.04, 0.02), clamp(rustStain * 0.65, 0.0, 0.72));
          } else if (onWalk) {
            let walkEdge = min(p.x - (bPorch.x + 5.0), (bPorch.x + 6.4) - p.x);
            let walkGrime = smoothstep(0.0, 0.26, walkEdge);
            let wNoise = surfaceNoise(p * 5.2 + vec2f(2.1, 6.7));
            let walkCrack = abs(surfaceNoise(p * 1.85 + vec2f(wNoise * 0.45, 1.9)) - 0.5);
            let crackLine = (1.0 - smoothstep(0.005, 0.018, walkCrack)) * step(0.54, wNoise) * 0.40 * weatherMult;
            albedo *= (0.58 + 0.28 * walkGrime) * (1.0 - crackLine);
          }
        }
      } else if (kind == 3) {
        let uDrive = fract((p.x - 19.0) * 0.377);
        let ruts = exp(-pow((uDrive - 0.26) * 5.2, 2.0)) + exp(-pow((uDrive - 0.74) * 5.2, 2.0));
        let pebbles = grain(p, 18.0) * 0.78 + grain(p + vec2f(3.7, 1.9), 9.5) * 0.42;
        let edgeFade = smoothstep(0.0, 0.24, min(uDrive, 1.0 - uDrive));
        let mossNoise = surfaceNoise(p * 1.8 + vec2f(2.4, 5.1));
        let centerMoss = exp(-pow((uDrive - 0.50) * 7.5, 2.0)) * smoothstep(0.38, 0.72, mossNoise);
        albedo *= (0.74 + pebbles + (surfaceNoise(p * 2.6) - 0.5) * 0.32 - 0.14 * clamp(ruts, 0.0, 1.0)) * (0.76 + 0.24 * edgeFade);
        albedo = mix(albedo, vec3f(0.022, 0.036, 0.014), centerMoss * 0.58);
      } else if (kind == 4) {
        let b = select(vec4f(21.0, 54.0, 36.0, 65.5), vec4f(22.0, 24.0, 37.0, 35.5), p.y < 44.0);
        let inKitchen = p.x > b.z - 6.08 && p.x < b.z - 0.05 && p.y > b.y + 5.68 && p.y < b.w - 0.05;
        if (inKitchen) {
          // 1970s warm ochre-travertine kitchen tile floor with recessed dark grout & perimeter shading
          let perimDist = min(min(p.x - (b.z - 6.08), (b.z - 0.05) - p.x), min(p.y - (b.y + 5.68), (b.w - 0.05) - p.y));
          let perimShade = 0.68 + 0.32 * smoothstep(0.0, 0.80, perimDist);
          let s = evalKitchenTile(p, vec3f(0.215, 0.176, 0.132) * perimShade);
          albedo = s.albedo;
          gloss = s.gloss;
          if (texOn) {
            let tex = sampleMaterialFast(1, p, 0.88 * texScaleMult);
            albedo = modulateFast(albedo, tex, vec3f(0.6427, 0.5308, 0.3801), 0.82 * texContrastMult);
          }
        } else {
          let s = evalWoodPlanks(p, albedo * 1.04, defaultMaterialRecipe(0));
          albedo = s.albedo;
          if (texOn && floorStyleBits < 2u) {
            let styleScale = select(0.65, 0.95, floorStyleBits == 1u) * texScaleMult;
            let tex = sampleMaterialFast(0, p, styleScale);
            albedo = modulateFast(albedo, tex, vec3f(0.4035, 0.1731, 0.0646), 0.84 * texContrastMult);
          }
        }
      } else {
        let s = evalMulchBed(p, albedo, 1.0, 1.0);
        albedo = s.albedo * s.cavity;
        n = normalize(n + surfaceNormalShift);
      }
    } else if (mat == 0 && o.world.y > 0.131 && o.world.y < 0.156 && o.world.x < 37.5 && texOn && rugStyleBits < 2u) {
      let p = o.world.xz;
      let b = select(vec4f(21.0, 54.0, 36.0, 65.5), vec4f(22.0, 24.0, 37.0, 35.5), p.y < 44.0);
      let rugWear = 1.0 - (surfaceNoise(p * 1.65 + vec2f(4.2, 1.8)) - 0.35) * 0.28 * weatherMult;
      if (p.x >= b.x + 1.53 && p.x <= b.x + 4.44 && p.y >= b.w - 4.37 && p.y <= b.w - 0.83) {
        let span = vec2f(2.87, 3.50);
        let uv = clamp((p - vec2f(b.x + 1.55, b.w - 4.35)) / span, vec2f(0.015), vec2f(0.985));
        let edgeBevel = smoothstep(0.0, 0.045, min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)));
        let layer = select(12, 13, rugStyleBits == 1u);
        let tex = textureSampleLevel(materialTexArray, materialSampler, uv, layer, materialMipLod(0.32));
        let refLin = select(vec3f(0.3882, 0.2897, 0.1774), vec3f(0.3522, 0.1986, 0.1107), layer == 13);
        let centered = refLin + (tex.rgb - refLin) * texContrastMult;
        albedo = clamp(centered * vec3f(0.64, 0.56, 0.44) * rugWear * mix(0.58, 1.0, edgeBevel), vec3f(0.015), vec3f(0.75));
      } else if (p.x >= b.x + 4.90 && p.x <= b.x + 6.84 && p.y >= b.y + 1.33 && p.y <= b.y + 4.27) {
        let span = vec2f(1.90, 2.90);
        let uv = clamp((p - vec2f(b.x + 4.92, b.y + 1.35)) / span, vec2f(0.015), vec2f(0.985));
        let edgeBevel = smoothstep(0.0, 0.045, min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)));
        let layer = select(13, 12, rugStyleBits == 1u);
        let tex = textureSampleLevel(materialTexArray, materialSampler, uv, layer, materialMipLod(0.45));
        let refLin = select(vec3f(0.3882, 0.2897, 0.1774), vec3f(0.3522, 0.1986, 0.1107), layer == 13);
        let centered = refLin + (tex.rgb - refLin) * texContrastMult;
        let bedStain = exp(-length(p - vec2f(b.x + 5.18, b.y + 2.85)) * 2.8) * 0.35 * weatherMult;
        albedo = clamp(centered * vec3f(0.68, 0.58, 0.46) * rugWear * (1.0 - bedStain) * mix(0.58, 1.0, edgeBevel), vec3f(0.015), vec3f(0.75));
      } else if (p.x >= b.z - 4.97 && p.x <= b.z - 2.23 && p.y >= b.y + 6.43 && p.y <= b.y + 7.24) {
        let span = vec2f(2.70, 0.77);
        let uv = clamp((p - vec2f(b.z - 4.95, b.y + 6.45)) / span, vec2f(0.015), vec2f(0.985));
        let edgeBevel = smoothstep(0.0, 0.045, min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)));
        let tex = textureSampleLevel(materialTexArray, materialSampler, uv, 14, materialMipLod(0.65));
        let refLin = vec3f(0.2887, 0.2220, 0.1674);
        let centered = refLin + (tex.rgb - refLin) * texContrastMult;
        albedo = clamp(centered * 0.52 * rugWear * mix(0.58, 1.0, edgeBevel), vec3f(0.015), vec3f(0.65));
      }
    } else if (mat == 4) {
      let wallUv = vec2f(o.world.x + o.world.z, o.world.y);
      let inWallRoom = interior(o.world.xz + n.xz * 0.3);
      if (inWallRoom || o.aux > 20.5) {
        let s = evalPlasterWall(o.world, n, select(albedo, vec3f(0.34, 0.29, 0.22), inWallRoom), defaultMaterialRecipe(2));
        albedo = s.albedo;
        if (texOn && (!inWallRoom || wallStyleBits < 2u) && o.world.y >= 0.96) {
          let wallScale = select(0.78, select(0.78, 1.15, wallStyleBits == 1u), inWallRoom) * texScaleMult;
          let tex = sampleMaterialFast(2, wallUv, wallScale);
          albedo = modulateFast(albedo, tex, vec3f(0.7567, 0.6302, 0.4162), select(0.70, 0.78, inWallRoom) * texContrastMult);
        }
      } else if (o.aux > 19.5) {
        let course = o.world.y / 0.165;
        let row = floor(course);
        let fy = fract(course);
        let plank = floor((o.world.x + o.world.z + row * 0.43) / 2.2);
        let boardVar = hash2(vec2f(row, plank)) - 0.5;
        // Warm 1970s weathered putty-cream clapboard tint with lap-board normal tilt
        albedo *= vec3f(0.88, 0.82, 0.70) * (0.96 + boardVar * 0.16);
        if (texOn) {
          let tex = sampleMaterialFast(3, wallUv, 0.72 * texScaleMult);
          albedo = modulateFast(albedo, tex, vec3f(0.6159, 0.5723, 0.5086), 0.84 * texContrastMult);
        }
        let lapShadow = mix(0.44, 1.06, smoothstep(0.0, 0.26, fy)) * mix(1.05, 0.85, fy);
        albedo *= mix(1.0, lapShadow * mix(0.50, 1.0, seam(course, 0.038, 6.06)), 1.0 - smoothstep(0.28, 0.72, surfaceFootprint * 6.06));
        let grimeField = surfaceNoise(vec2f(wallUv.x * 2.1, o.world.y * 0.48) + vec2f(5.3, 1.7));
        let peelField = fract(grimeField * 3.17 + boardVar * 1.9);
        let grimeStreak = smoothstep(0.44, 0.78, grimeField) * (0.22 * weatherMult);
        let peelMask = smoothstep(0.68 - 0.10 * weatherMult, 0.80 - 0.06 * weatherMult, peelField) * clamp(weatherMult, 0.0, 1.5);
        albedo = mix(albedo, vec3f(0.18, 0.14, 0.10), peelMask * 0.52);
        albedo *= (0.96 + grain(vec2f(o.world.x + o.world.z, o.world.y * 3.5), 11.0) * 0.14) * (1.0 - grimeStreak);
        albedo *= mix(0.64, 1.0, smoothstep(0.28, 0.82, o.world.y));
        n = normalize(n + vec3f(0.0, (fy - 0.38) * 0.24, 0.0));
      }
    } else if (mat == 21) {
      // Slope-aware 3-tab architectural asphalt shingles with crisp course overlap shadows, moonlit tab lips, and weathered streaks.
      let ewWing = abs(n.x) > abs(n.z) && abs(n.y) < 0.96;
      let slopeCoord = select(o.world.z, o.world.x, ewWing);
      let spanCoord = select(o.world.x, o.world.z, ewWing);
      let coursePitch = 0.25;
      let tabSpan = 0.38;
      let row = floor(slopeCoord / coursePitch);
      let fy = fract(slopeCoord / coursePitch);
      let rowJitter = (hash2(vec2f(row, 3.1)) - 0.5) * 0.18;
      let q = vec2f(spanCoord / tabSpan + fract(row * 0.5) + rowJitter, slopeCoord / coursePitch);
      let tabId = floor(q);
      let fx = fract(q.x);
      let tabHash = hash2(tabId) - 0.5;
      let tabTilt = hash2(tabId * 1.73 + vec2f(5.1, 2.9)) - 0.5;
      let detailFade = 1.0 - smoothstep(0.40, 0.92, surfaceFootprint * 4.0);

      // Deep overlap drop-shadow at top of each course + bright granule catch along the stepped bottom lip.
      let overlapShadow = mix(0.20, 1.0, smoothstep(0.05, 0.28, fy));
      let stepCut = smoothstep(1.0, 0.88, fy);
      let bottomBevel = exp(-pow((fy - 0.78) * 9.5, 2.0)) * (0.56 + 0.32 * tabHash) * detailFade;
      let rowShade = mix(1.0, (0.74 + 0.42 * fy) * overlapShadow * mix(0.26, 1.0, stepCut), detailFade) + bottomBevel;

      // Per-tab warm-charcoal/slate/taupe granule variation + occasional missing/damaged dark tab.
      let missingTab = step(0.935, fract((tabHash + 0.5) * 19.7)) * 0.46 * clamp(weatherMult, 0.0, 1.5);
      let tabTint = vec3f(1.02 + tabTilt * 0.08, 1.0 + tabTilt * 0.03, 0.96 - tabTilt * 0.08);
      albedo *= tabTint * (1.04 + tabHash * 0.48 * detailFade) * (1.0 - missingTab) * rowShade;
      if (texOn) {
        let tex = sampleMaterialFast(4, o.world.xz, 0.72 * texScaleMult);
        albedo = modulateFast(albedo, tex, vec3f(0.1056, 0.1172, 0.1297), 0.92 * texContrastMult);
      }

      // Crisp dark keyways (vertical tab slots) with one-sided moonlit edge catch.
      let slotDist = min(fx, 1.0 - fx);
      let tabSlot = mix(1.0, mix(0.22, 1.0, smoothstep(0.018, 0.085, slotDist)), detailFade);
      let sideBevel = exp(-pow((fx - 0.12) * 14.0, 2.0)) * 0.22 * detailFade;
      albedo *= tabSlot * (1.0 + sideBevel);

      // Single-noise roof weathering: vertical rain/soot runoff streaks + damp moss near lower eaves.
      let streakNoise = surfaceNoise(vec2f(spanCoord * 1.65, slopeCoord * 0.42) + vec2f(2.7, 6.1));
      let eaveDamp = (1.0 - smoothstep(2.82, 3.28, o.world.y)) * 0.22 * weatherMult;
      let sootStreak = smoothstep(0.44, 0.78, streakNoise) * 0.18 * weatherMult;
      let mossPatch = smoothstep(0.62, 0.86, fract(streakNoise * 2.7 + tabHash)) * (1.0 - smoothstep(2.85, 3.65, o.world.y)) * 0.28 * weatherMult;
      albedo *= (1.0 - sootStreak - eaveDamp);
      albedo = mix(albedo, albedo * vec3f(0.68, 0.88, 0.62), mossPatch);
      surfaceAlpha = bottomBevel * tabSlot;

      // Perturb shingle normal so each course lip & individual tab catches directional moonlight and porch bounce.
      let lipNorm = (smoothstep(0.68, 0.88, fy) - smoothstep(0.0, 0.22, fy) * 0.75) * 0.42 * detailFade;
      let slotNorm = (smoothstep(0.0, 0.10, fx) - smoothstep(0.90, 1.0, fx)) * 0.22 * detailFade;
      let dirZ = select(-1.0, 1.0, n.z >= 0.0);
      let shShift = select(
        vec3f(slotNorm + tabTilt * 0.15 * detailFade, 0.0, lipNorm * dirZ + tabHash * 0.12 * detailFade),
        vec3f(lipNorm * select(-1.0, 1.0, n.x >= 0.0), 0.0, slotNorm + tabTilt * 0.15 * detailFade),
        ewWing
      );
      n = normalize(n + shShift);
      gloss = vec2f(26.0, (0.08 + 0.16 * bottomBevel) * tabSlot);
    } else if (mat == 23) {
      let p = vec2f(o.world.x + o.world.z, o.world.y);
      let row = floor(p.y / 0.085);
      let q = vec2f(p.x / 0.25 + fract(row * 0.5), p.y / 0.085);
      albedo = mix(vec3f(0.32, 0.30, 0.26), albedo * (0.8 + 0.35 * hash2(floor(q))), seam(q.x, 0.025, 4.0) * seam(q.y, 0.06, 11.76));
      if (texOn) {
        let tex = sampleMaterialFast(5, p, 0.85 * texScaleMult);
        albedo = modulateFast(albedo, tex, vec3f(0.3143, 0.1732, 0.1377), 0.78 * texContrastMult);
      }
    } else if (mat == 22) {
      if (o.aux < -0.02) {
        // Curved 3D grass blade: root contact AO, vascular vein striation, wind-crest highlight & feathered tip.
        let bladeT = clamp(-o.aux, 0.0, 1.0);
        let rootAO = mix(0.24, 1.0, smoothstep(0.0, 0.32, bladeT));
        let vein = grain(o.world.xz * 2.4 + vec2f(o.world.y * 1.6), 16.0) * 0.16;
        let crestNoise = surfaceNoise(o.world.xz * 0.32 + vec2f(surfaceTime * 0.28, surfaceTime * 0.16));
        let crestHighlight = smoothstep(0.42, 0.72, crestNoise) * 0.22 * bladeT;
        albedo = mix(albedo * (0.92 + vein), vec3f(0.28, 0.42, 0.18), crestHighlight) * rootAO * mix(0.80, 1.06, pow(bladeT, 0.62));
      } else {
        let s = evalFoliageCanopy(o.world, n, albedo, defaultMaterialRecipe(5));
        albedo = s.albedo * mix(0.58, 1.0, s.cavity);
        n = normalize(n + surfaceNormalShift);
        if (o.aux > 0.0) {
          let uv3 = vec2f(o.world.x + o.world.z * 0.73 + o.world.y * 0.41, o.world.y * 1.17 - o.world.x * 0.43 + o.world.z * 0.81);
          let brush1 = surfaceNoise(uv3 * 5.8 + vec2f(2.1, 4.7));
          let brush2 = surfaceNoise(uv3 * 13.5 + vec2f(brush1 * 0.7 + 6.3, 1.9));
          let brushField = brush1 * 0.58 + brush2 * 0.42;
          albedo *= mix(0.84, 1.06, brushField);
        }
      }
    } else if (mat == 24) {
      albedo *= 0.84 + surfaceNoise(vec2f(o.world.x + o.world.z, o.world.y * 0.18) * 28.0) * 0.24;
    }
`

export const resolveSurfaceMaterialWgsl = ""

/**
 * Legacy pre-recipe material evaluation retained for honest A/B comparison in the Lab workbench
 * (shiny/gridded floorboards, Cartesian gridded pavers, flat plaster walls, uniform asphalt, blotchy grass).
 */
export const legacyMaterialComparisonWgsl = /* wgsl */ `
struct SurfaceTexUniforms {
  global: vec4f,
  styles: vec4f,
  recipeTex: array<vec4f, 6>,
  recipeExtra: array<vec4f, 3>,
}

@group(0) @binding(12) var<uniform> surfaceTexUniforms: SurfaceTexUniforms;

fn surfaceTexEnabledAt(worldX: f32) -> bool {
  let mode = surfaceTexUniforms.global.x;
  if (mode > 1.5) {
    return worldX >= surfaceTexUniforms.styles.w;
  }
  return mode > 0.5;
}

fn recipeTexExtra(recipeIdx: i32) -> vec2f {
  let v = surfaceTexUniforms.recipeExtra[recipeIdx / 2];
  return select(v.xy, v.zw, (recipeIdx & 1) == 1);
}
fn evalLegacyMaterial(recipeId: i32, world: vec3f, normal: vec3f, baseTint: vec3f) -> SurfaceSample {
  let p = world.xz;
  var albedo = baseTint;
  var gloss = vec2f(0.0);
  var rough = 0.85;
  if (recipeId == 0) {
    // Legacy shiny floorboards: uniform row stripes with broad glossy highlight (shininess 30, strength 0.30).
    let row = floor(p.y / 0.18);
    albedo *= 0.93 + 0.12 * hash2(vec2f(row, floor((p.x + row * 0.37) / 1.8)));
    albedo *= mix(0.86, 1.0, seam(p.y / 0.18, 0.018, 5.55));
    albedo *= 1.0 + grain(vec2f(p.x * 0.15, p.y), 65.0) * 0.18;
    gloss = vec2f(30.0, 0.32);
    rough = 0.35;
  } else if (recipeId == 1) {
    // Legacy gridded pavers: regular 1.6m Cartesian grid without Voronoi irregularity or worn edges.
    albedo *= 0.92 + grain(p, 28.0) * 0.15;
    albedo *= mix(0.67, 1.0, seam(p.x / 1.6, 0.004, 0.625) * seam(p.y / 1.6, 0.004, 0.625));
  } else if (recipeId == 2) {
    // Legacy flat interior wall: constant uniform tint without plaster stipple or wear.
    albedo = baseTint;
  } else if (recipeId == 3) {
    // Legacy street asphalt: high-frequency grain that fades out at street camera distance.
    albedo *= 0.90 + grain(p, 14.0) * 0.28 + surfaceNoise(p * 2.0) * 0.10;
  } else if (recipeId == 4) {
    // Legacy Perlin blotch grass.
    let patches = smoothstep(0.35, 0.7, surfaceFbm(p * 0.7));
    albedo = mix(albedo * vec3f(0.83, 0.91, 0.65), vec3f(0.19, 0.155, 0.10), patches * 0.6);
    albedo *= 0.84 + 0.28 * surfaceNoise(p * 0.7) + grain(p, 12.0) * 0.16;
  } else {
    albedo *= 0.72 + surfaceNoise(world.xz * 4.0 + world.y) * 0.38;
  }
  return SurfaceSample(albedo, gloss, rough, 1.0);
}

fn evalRecipeById(recipeId: i32, world: vec3f, normal: vec3f, baseTint: vec3f, r: MaterialRecipe) -> SurfaceSample {
  var s: SurfaceSample;
  switch recipeId {
    case 0: { s = evalWoodPlanks(world.xz, baseTint, r); }
    case 1: { s = evalCobblestone(world.xz, baseTint, r); }
    case 2: { s = evalPlasterWall(world, normal, baseTint, r); }
    case 3: { s = evalAsphaltConcrete(world.xz, baseTint, false, r); }
    case 4: { s = evalGrassSoil(world.xz, baseTint, false, r); }
    default: { s = evalFoliageCanopy(world, normal, baseTint, r); }
  }
  if (surfaceTexEnabledAt(world.x)) {
    let tc = surfaceTexUniforms.recipeTex[recipeId];
    let te = recipeTexExtra(recipeId);
    let layer = i32(round(tc.x));
    if (layer >= 0 && te.y > 0.001) {
      let c = cos(tc.z);
      let sn = sin(tc.z);
      let an = abs(normal);
      var uv0 = world.xz;
      if (an.x > an.y && an.x >= an.z) { uv0 = vec2f(world.z, world.y); }
      else if (an.z > an.y && an.z > an.x) { uv0 = world.xy; }
      let effScale = tc.y * max(0.25, r.u1.x) * surfaceTexUniforms.global.y;
      let uv = vec2f(uv0.x * c - uv0.y * sn, uv0.x * sn + uv0.y * c) * effScale;
      let lod = clamp(log2(max(surfaceFootprint * effScale * 256.0, 1.0)) - 0.35, 0.0, 8.0);
      let tex = textureSampleLevel(materialTexArray, materialSampler, uv, layer, lod);
      let refLin = textureLayerRefLinear(layer);
      s.albedo = modulateFast(s.albedo, tex, refLin, te.y * tc.w);
      s.roughness = clamp(mix(s.roughness, tex.a, 0.55 * te.y) + te.x + surfaceTexUniforms.global.w, 0.05, 0.99);
      s.gloss = roughnessToGloss(s.roughness, 0.04);
    }
  }
  return s;
}
`
