import { Rng } from "../sim/rng"

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

export type MaterialRecipeDef = {
  id: MaterialRecipeId
  index: number
  label: string
  category: string
  summary: string
  defaults: Readonly<MaterialRecipeParams>
}

export const MATERIAL_RECIPES: Readonly<Record<MaterialRecipeId, MaterialRecipeDef>> = {
  wood_planks: {
    id: "wood_planks",
    index: 0,
    label: "Wood planks",
    category: "Flooring & Timber",
    summary: "Matte heartwood grain, staggered board lengths, butt-joint AO, and warm/cool per-board variation.",
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
  },
  cobblestone: {
    id: "cobblestone",
    index: 1,
    label: "Cobblestone & pavers",
    category: "Paths & Masonry",
    summary: "Voronoi irregular stone distribution, worn rounded edges, recessed dirt joints, and mineral variation.",
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
  },
  plaster_wall: {
    id: "plaster_wall",
    index: 2,
    label: "Plaster & painted wall",
    category: "Architecture",
    summary: "Trowel stipple, side-by-side paint/plaster mixture patches, baseboard contact, and causal ledge runoff.",
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
  },
  asphalt_concrete: {
    id: "asphalt_concrete",
    index: 3,
    label: "Asphalt & concrete",
    category: "Roads & Sidewalks",
    summary: "Multi-scale crushed aggregate, tar repair seams, wheel-track wear, and worn concrete expansion joints.",
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
  },
  grass_soil: {
    id: "grass_soil",
    index: 4,
    label: "Grass & soil",
    category: "Terrain & Grounds",
    summary: "Voronoi clump-correlated turf, directional blade tufts, dry-to-lush hue shifts, and dark loam exposure.",
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
  },
  foliage_canopy: {
    id: "foliage_canopy",
    index: 5,
    label: "Foliage & ground cover",
    category: "Vegetation",
    summary: "Cluster-correlated leaf masses, crown gaps, top/bottom canopy shading, and low ground-cover rosettes.",
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
  },
}

export const MATERIAL_RECIPE_IDS = Object.keys(MATERIAL_RECIPES) as readonly MaterialRecipeId[]

export function isMaterialRecipeId(value: unknown): value is MaterialRecipeId {
  return typeof value === "string" && value in MATERIAL_RECIPES
}

export function cloneMaterialParams(recipeId: MaterialRecipeId): MaterialRecipeParams {
  return { ...MATERIAL_RECIPES[recipeId].defaults }
}

function snapToStep(value: number, spec: MaterialParamSpec): number {
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

export type MaterialSwatchMode = "room" | "ball" | "plane"
export type MaterialCompareMode = 0 | 1 | 2

export type MaterialPresetV1 = {
  version: 1
  recipe: MaterialRecipeId
  swatch: MaterialSwatchMode
  compare: MaterialCompareMode
  tuningSeed: number
  roomSeed: number
  params: MaterialRecipeParams
}

export function exportMaterialPreset(preset: Omit<MaterialPresetV1, "version">): MaterialPresetV1 {
  const checked = validateMaterialParams(preset.params)
  if (!checked.ok) throw new Error(checked.error)
  return {
    version: 1,
    recipe: preset.recipe,
    swatch: preset.swatch,
    compare: preset.compare,
    tuningSeed: Math.max(1, Math.min(9999, Math.trunc(preset.tuningSeed) || 1)),
    roomSeed: Math.max(1, Math.min(999, Math.trunc(preset.roomSeed) || 7)),
    params: checked.value,
  }
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
  if (obj.compare !== 0 && obj.compare !== 1 && obj.compare !== 2) {
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
 * Shared WGSL procedural material functions used by both the production scene shader (Outbreak)
 * and the interactive Lab Materials workbench.
 * Filter widths (`surfaceFootprint`) must be initialized in uniform control flow before calling these functions.
 */
export const surfaceMaterialCoreWgsl = /* wgsl */ `
var<private> surfaceFootprint: f32;

struct MaterialRecipe {
  u0: vec4f, // baseR, baseG, baseB, roughness
  u1: vec4f, // scale, elementRatio, irregularity, grainScale
  u2: vec4f, // colorVariation, jointWidth, wear, macroVariation
}

struct SurfaceSample {
  albedo: vec3f,
  gloss: vec2f,
  roughness: f32,
  cavity: f32,
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

/** Recipe 0: Matte wood planks with staggered lengths, butt-joint AO, cathedral heartwood figure, and warm/cool board tint. */
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
  col *= 1.0 + longStreak * 0.22 + cathedral * 0.10 * fadeMed + fiber * 0.18;

  // Anti-aliased long edge seams AND staggered butt-joint seams.
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

/** Recipe 1: Irregular Voronoi cobblestone / stone pavers (fast 2x2 quadrant Voronoi) with varied stone sizes, worn edges, and recessed dirt joints. */
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

  // Domain warp before cell partitioning so stone rows curve organically and vary in width.
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
  let mineralGrit = grain(p, 11.5 * gScale) * 0.24;
  stoneCol = stoneCol * slopeShade * (0.86 + 0.14 * bevel + mineralGrit) + vec3f(0.06, 0.055, 0.045) * rimWear;

  let macroNoise = surfaceNoise(p * 0.45 + vec2f(6.2, 1.9));
  let mossMask = smoothstep(0.55, 0.82, macroNoise) * macroVar;
  let dirtCol = mix(baseTint * vec3f(0.36, 0.32, 0.25), vec3f(0.18, 0.23, 0.13), mossMask * 0.65);
  var col = mix(dirtCol, stoneCol, stoneMask);
  col *= 1.0 - (macroNoise - 0.48) * macroVar * 0.22;

  let localRough = clamp(r.u0.w + (1.0 - stoneMask) * 0.12, 0.05, 1.0);
  return SurfaceSample(col, roughnessToGloss(localRough, 0.05), localRough, mix(0.45, 1.0, bevel * stoneMask));
}

/** Recipe 2: Plaster & painted wall with side-by-side paint/plaster mixture patches, trowel stipple, and causal runoff/base wear. */
fn evalPlasterWall(world: vec3f, normal: vec3f, baseTint: vec3f, r: MaterialRecipe) -> SurfaceSample {
  let scale = max(0.25, r.u1.x);
  let gScale = max(0.25, r.u1.w);
  let colVar = r.u2.x;
  let wear = r.u2.z;
  let macroVar = r.u2.w;

  let uv = vec2f(world.x + world.z, world.y);
  let patchNoise = surfaceNoise(uv * 0.65 * scale + vec2f(1.9, 3.4));
  let exposedPlaster = smoothstep(0.54 - wear * 0.20, 0.78 - wear * 0.10, patchNoise) * wear;
  let underTone = baseTint * vec3f(0.92, 0.87, 0.78);
  var col = mix(baseTint, underTone, exposedPlaster * (0.5 + 0.5 * colVar));

  let stipple = grain(uv, 9.0 * gScale) * 0.18;
  col *= 1.0 + stipple * (1.0 + 0.35 * exposedPlaster);

  let streak = surfaceNoise(vec2f(uv.x * 2.4 * scale, uv.y * 0.45)) * smoothstep(1.5, 2.75, world.y) * wear * 0.14;
  let baseWear = (1.0 - smoothstep(0.12, 0.48, world.y)) * wear * 0.20;
  let macroTone = (patchNoise - 0.5) * macroVar * 0.16;
  col *= 1.0 - streak - baseWear + macroTone;

  let localRough = clamp(r.u0.w + exposedPlaster * 0.08, 0.05, 1.0);
  return SurfaceSample(col, roughnessToGloss(localRough, 0.03), localRough, 1.0 - baseWear);
}

/** Recipe 3: Asphalt road & concrete sidewalk slabs with multi-scale crushed aggregate, tar seams, and worn joints. */
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
    // Grass verge strip between the concrete sidewalk (z=38..39.32) and street curb (z=39.78..40.0) on house frontages.
    let inNorthVerge = p.y > 39.32 && p.y < 39.78 && (p.x < 37.8 || p.x > 50.2);
    let inSouthVerge = p.y > 48.22 && p.y < 48.68 && (p.x < 37.8 || p.x > 50.2);
    let inDrivewayApron = (p.x > 18.8 && p.x < 21.8) || (p.x > 49.8 && p.x < 52.8);
    let inFrontWalk = (p.x > 26.8 && p.x < 28.6 && p.y < 40.0) || (p.x > 25.8 && p.x < 27.6 && p.y > 48.0);
    if ((inNorthVerge || inSouthVerge) && !inDrivewayApron && !inFrontWalk) {
      return evalGrassSoil(p, vec3f(0.24, 0.30, 0.17), false, defaultMaterialRecipe(4));
    }
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
    let grit = grain(p, 10.5 * gScale) * 0.22;
    let macroTone = (warp / max(0.001, 0.035 * irreg)) * 0.18 * macroVar;
    col *= 0.95 + grit + macroTone - edgeDirt;
    col = mix(col * vec3f(0.38, 0.37, 0.32), col, joint);
    cavity = joint;
  } else {
    let coarseAgg = grain(p, 7.2 * gScale) * 0.34;
    let patchField = surfaceNoise(p * 0.42 * scale + vec2f(3.1, 6.7));
    let tarPatch = smoothstep(0.58 - wear * 0.15, 0.68 - wear * 0.10, patchField) * wear;
    let crackField = abs(surfaceNoise(p * 0.78 * scale + vec2f(patchField * 0.45)) - 0.5);
    let crackAa = max(surfaceFootprint * 0.78 * scale, 0.006);
    let crack = (1.0 - smoothstep(0.006, 0.016 + crackAa, crackField)) * step(0.45, patchField) * wear;
    let macroTone = (surfaceNoise(p * 0.20 + vec2f(8.3, 1.4)) - 0.5) * 0.24 * macroVar;
    // Darkened wet gutter pan along the street curbs (z=40.0..40.35 and z=47.65..48.0).
    let gutterDist = min(abs(p.y - 40.0), abs(p.y - 48.0));
    let gutterShade = 1.0 - (1.0 - smoothstep(0.0, 0.38, gutterDist)) * 0.36;
    // Scattered fallen autumn leaves near the gutter and sidewalk edge.
    let leafCell = floor(p * 9.5);
    let leafHash = hash2(leafCell + vec2f(4.7, 9.1));
    let leafMask = step(0.955, leafHash) * (1.0 - smoothstep(0.0, 1.35, gutterDist)) * (1.0 - smoothstep(0.18, 0.55, surfaceFootprint * 9.5));

    col *= (0.96 + coarseAgg + macroTone + (patchField - 0.5) * 0.12 * colVar) * gutterShade;
    col = mix(col, col * vec3f(0.76, 0.78, 0.82), tarPatch * 0.55);
    col = mix(col, col * 0.50, crack * 0.68);
    col = mix(col, vec3f(0.42, 0.28, 0.14), leafMask * 0.75);
    localRough = clamp(r.u0.w - tarPatch * 0.08 + crack * 0.08, 0.05, 1.0);
    cavity = (1.0 - crack * 0.4) * gutterShade;
  }

  return SurfaceSample(col, roughnessToGloss(localRough, 0.045), localRough, cavity);
}

/** Recipe 4: Clump-correlated lawn turf & dark garden soil/mulch. */
fn evalGrassSoil(p: vec2f, baseTint: vec3f, isMulchBed: bool, r: MaterialRecipe) -> SurfaceSample {
  let scale = max(0.25, r.u1.x);
  let clumpSize = max(0.25, r.u1.y) / scale;
  let irreg = r.u1.z;
  let gScale = max(0.25, r.u1.w);
  let colVar = r.u2.x;
  let wear = r.u2.z;
  let macroVar = r.u2.w;

  if (isMulchBed) {
    let bark = grain(vec2f(p.x * 1.4, p.y * 2.2), 9.5 * gScale) * 0.36;
    let damp = smoothstep(0.35, 0.72, surfaceNoise(p * 0.85 * scale));
    var col = mix(baseTint * vec3f(1.05, 0.98, 0.88), baseTint * vec3f(0.68, 0.62, 0.54), damp * 0.55);
    col *= 0.94 + bark;
    return SurfaceSample(col, vec2f(0.0), 0.95, 1.0);
  }

  // Two-octave warped clump field gives organic turf patches without Voronoi cell outlines or 9-tap loop overhead.
  let c0 = surfaceNoise(p * (0.65 / clumpSize) + vec2f(1.3, 4.2));
  let c1 = surfaceNoise(p * (1.45 / clumpSize) + vec2f(c0 * 1.4 * irreg, 6.7));
  let clumpField = c0 * 0.58 + c1 * 0.42;

  let lushTint = baseTint * vec3f(0.84, 0.96, 0.66);
  let dryTint = baseTint * vec3f(1.08, 0.96, 0.64);
  let dryMix = smoothstep(0.32, 0.78, clumpField) * colVar * 0.72;
  var turfCol = mix(lushTint, dryTint, dryMix);
  turfCol *= 0.88 + (c1 - 0.45) * 0.32 * colVar;

  let tuftStreak = grain(vec2f(p.x * 1.6 + p.y * 0.4, p.y * 2.4 - p.x * 0.3), 8.5 * gScale) * 0.28;
  turfCol *= 1.0 + tuftStreak;

  let soilMask = smoothstep(0.54 - wear * 0.22, 0.76 - wear * 0.12, clumpField) * (0.45 + 0.55 * macroVar);
  let soilCol = vec3f(0.18, 0.145, 0.098) * (0.86 + 0.28 * c1);
  let col = mix(turfCol, soilCol, soilMask * 0.62);

  return SurfaceSample(col, roughnessToGloss(r.u0.w, 0.06), r.u0.w, 0.92 + 0.08 * c0);
}

/** Recipe 5: Clustered foliage canopy with 3D bough variation, top/bottom normal separation, and self-occlusion. */
fn evalFoliageCanopy(world: vec3f, normal: vec3f, baseTint: vec3f, r: MaterialRecipe) -> SurfaceSample {
  let scale = max(0.25, r.u1.x);
  let clusterSize = max(0.2, r.u1.y) / scale;
  let gScale = max(0.25, r.u1.w);
  let colVar = r.u2.x;
  let wear = r.u2.z;
  let macroVar = r.u2.w;

  let n0 = surfaceNoise(world.xz * 2.1 + 1.3) - 0.5;
  let warp = vec3f(n0, 0.0, -n0 * 0.8) * clusterSize * 0.9 * r.u1.z;
  let clusterCell = floor((world + warp) / clusterSize);
  let hCluster = hash2(clusterCell.xz + vec2f(clusterCell.y * 3.7, 11.3)) - 0.5;
  let hHue = fract((hCluster + 0.5) * 13.7) - 0.5;

  let leafClump = surfaceNoise(world.xz * 5.8 + vec2f(world.y * 2.1, -world.y * 1.7)) - 0.5;
  let fineLeaf = grain(world.xz + vec2f(world.y * 0.7), 11.5 * gScale);
  let topMask = clamp(normal.y * 0.5 + 0.5, 0.0, 1.0);
  let heightLift = smoothstep(0.05, 1.2, fract(world.y * 0.65));
  let canopyLift = mix(0.56 - wear * 0.12, 1.32, clamp(topMask * 0.72 + heightLift * 0.28 + leafClump * 0.22, 0.0, 1.0));
  let warmTip = clamp(leafClump + topMask * 0.35 - 0.1, -0.4, 0.6);
  let hueTint = vec3f(1.0 + (hHue * 0.18 + warmTip * 0.22) * colVar, 1.0 + (hHue * 0.08 + warmTip * 0.14) * colVar, 1.0 - (hHue * 0.16 + warmTip * 0.20) * colVar);
  var col = baseTint * hueTint * (0.94 + hCluster * 0.32 * colVar) * canopyLift;

  col *= 1.0 + leafClump * 0.34 + fineLeaf * 0.32 + n0 * 0.18 * macroVar;

  return SurfaceSample(col, roughnessToGloss(r.u0.w, 0.05), r.u0.w, mix(0.68, 1.0, topMask));
}
`

/** Opt-in matte outdoor & architectural finishes. Games assign materials/palettes; existing shaders stay identical. */
export const surfaceMaterialDeclarations = surfaceMaterialCoreWgsl

export const surfaceMaterial = /* wgsl */ `
    if (mat == 20) {
      let kind = i32(round(o.aux));
      let p = o.world.xz;
      if (kind == 0) {
        let s = evalGrassSoil(p, albedo, false, defaultMaterialRecipe(4));
        albedo = s.albedo;
        gloss = s.gloss;
      } else if (kind == 1) {
        let s = evalAsphaltConcrete(p, albedo, false, defaultMaterialRecipe(3));
        albedo = s.albedo;
        gloss = s.gloss;
      } else if (kind == 2) {
        let s = evalAsphaltConcrete(p, albedo, true, defaultMaterialRecipe(3));
        albedo = s.albedo;
        gloss = s.gloss;
      } else if (kind == 3) {
        // Gravel drive: crushed stone aggregate with wheel-track compaction and dark soil crevices.
        let ruts = exp(-pow((fract((p.x - 19.0) * 0.377) - 0.26) * 5.2, 2.0)) + exp(-pow((fract((p.x - 19.0) * 0.377) - 0.74) * 5.2, 2.0));
        let pebbles = grain(p, 18.0) * 0.78 + grain(p + vec2f(3.7, 1.9), 9.5) * 0.42;
        let edgeFade = smoothstep(0.0, 0.24, min(fract((p.x - 19.0) * 0.377), 1.0 - fract((p.x - 19.0) * 0.377)));
        albedo *= (0.78 + pebbles + (surfaceNoise(p * 2.6) - 0.5) * 0.32 - 0.14 * clamp(ruts, 0.0, 1.0)) * (0.76 + 0.24 * edgeFade);
        gloss = vec2f(0.0);
      } else if (kind == 4) {
        let s = evalWoodPlanks(p, albedo, defaultMaterialRecipe(0));
        albedo = s.albedo;
        gloss = s.gloss;
      } else if (kind == 6) {
        let s = evalCobblestone(p, albedo, defaultMaterialRecipe(1));
        albedo = s.albedo;
        gloss = s.gloss;
      } else {
        let s = evalGrassSoil(p, albedo, true, defaultMaterialRecipe(4));
        albedo = s.albedo;
        gloss = s.gloss;
      }
    }
    if (mat == 4 && o.aux > 19.5) {
      if (o.aux > 20.5) {
        let s = evalPlasterWall(o.world, n, albedo, defaultMaterialRecipe(2));
        albedo = s.albedo;
        gloss = s.gloss;
      } else {
        // Painted wood clapboard siding with crisp horizontal lap shadows, staggered plank seams, and subtle grain.
        let course = o.world.y / 0.165;
        let row = floor(course);
        let fy = fract(course);
        let plank = floor((o.world.x + o.world.z + row * 0.43) / 2.2);
        albedo *= 0.96 + (hash2(vec2f(row, plank)) - 0.5) * 0.09;
        let lapShadow = mix(0.56, 1.05, smoothstep(0.0, 0.22, fy)) * mix(1.04, 0.90, fy);
        albedo *= mix(1.0, lapShadow * mix(0.62, 1.0, seam(course, 0.032, 6.06)), 1.0 - smoothstep(0.18, 0.55, surfaceFootprint * 6.06));
        albedo *= 0.97 + grain(vec2f(o.world.x + o.world.z, o.world.y * 3.5), 11.0) * 0.14;
        albedo *= mix(0.84, 1.0, smoothstep(0.28, 0.65, o.world.y));
      }
    }
    if (mat == 21) {
      let row = floor(o.world.z / 0.23);
      let q = vec2f(o.world.x / 0.34 + fract(row * 0.5) + (hash2(vec2f(row, 3.1)) - 0.5) * 0.15, o.world.z / 0.23);
      let tabHash = hash2(floor(q)) - 0.5;
      let rowShade = mix(0.76, 1.08, fract(o.world.z / 0.23));
      albedo *= (0.98 + tabHash * 0.34 * (1.0 - smoothstep(0.12, 0.5, surfaceFootprint * 4.35))) * rowShade;
      albedo *= mix(0.48, 1.0, seam(q.x, 0.020, 2.94) * seam(q.y, 0.042, 4.35));
      albedo *= 1.0 + grain(o.world.xz, 18.0) * 0.16;
    }
    if (mat == 23) {
      let p = vec2f(o.world.x + o.world.z, o.world.y);
      let row = floor(p.y / 0.085);
      let q = vec2f(p.x / 0.25 + fract(row * 0.5), p.y / 0.085);
      albedo = mix(vec3f(0.32, 0.30, 0.26), albedo * (0.8 + 0.35 * hash2(floor(q))), seam(q.x, 0.025, 4.0) * seam(q.y, 0.06, 11.76));
    }
    if (mat == 22) {
      let s = evalFoliageCanopy(o.world, n, albedo, defaultMaterialRecipe(5));
      albedo = s.albedo;
      gloss = s.gloss;
    }
    if (mat == 24) {
      albedo *= 0.84 + surfaceNoise(vec2f(o.world.x + o.world.z, o.world.y * 0.18) * 28.0) * 0.24;
      gloss = vec2f(0.0);
    }
`

/**
 * Legacy pre-recipe material evaluation retained for honest A/B comparison in the Lab workbench
 * (shiny/gridded floorboards, Cartesian gridded pavers, flat plaster walls, uniform asphalt, blotchy grass).
 */
export const legacyMaterialComparisonWgsl = /* wgsl */ `
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
  switch recipeId {
    case 0: { return evalWoodPlanks(world.xz, baseTint, r); }
    case 1: { return evalCobblestone(world.xz, baseTint, r); }
    case 2: { return evalPlasterWall(world, normal, baseTint, r); }
    case 3: { return evalAsphaltConcrete(world.xz, baseTint, false, r); }
    case 4: { return evalGrassSoil(world.xz, baseTint, false, r); }
    default: { return evalFoliageCanopy(world, normal, baseTint, r); }
  }
}
`
