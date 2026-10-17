import type { LevelChunk, LevelData } from "@arcade/kit/gpu/level"
import { VERT_BYTES } from "@arcade/kit/gpu/mesh"
import {
  MATERIAL_RECIPES,
  type MaterialParamKey,
  type MaterialRecipeId,
  type MaterialRecipeParams,
} from "@arcade/kit/gpu/surface-materials"
import type { LookPresetId, LookSettings } from "@arcade/kit/look"
import { Rng } from "@arcade/kit/sim/rng"
import { BUILDING_RECTS, CHUNK, type Prop, type Town } from "../../shared/map"
import { buildLevel } from "../level"
import { propDressingState } from "../props/state"

export type VignetteSurfaceId =
  | "wood_floor"
  | "plaster"
  | "siding"
  | "shingles"
  | "asphalt"
  | "concrete"
  | "grass"

export type VignetteCameraPreset = "game" | "interior" | "street" | "target_street" | "target_interior"
export type VignetteDirectionId = 0 | 1 | 2 | 3 | 4 | 5

export type VignetteSurfaceMeta = {
  id: VignetteSurfaceId
  label: string
  slot: number
  baseRecipe: MaterialRecipeId
  defaults: Readonly<MaterialRecipeParams>
}

export const VIGNETTE_SURFACES: Readonly<Record<VignetteSurfaceId, VignetteSurfaceMeta>> = {
  wood_floor: {
    id: "wood_floor",
    label: "Wood floor (interior)",
    slot: 0,
    baseRecipe: "wood_planks",
    defaults: { ...MATERIAL_RECIPES.wood_planks.defaults },
  },
  plaster: {
    id: "plaster",
    label: "Plaster wall (interior)",
    slot: 2,
    baseRecipe: "plaster_wall",
    defaults: { ...MATERIAL_RECIPES.plaster_wall.defaults },
  },
  siding: {
    id: "siding",
    label: "Clapboard siding (exterior)",
    slot: 6,
    baseRecipe: "plaster_wall",
    defaults: {
      baseR: 0.70,
      baseG: 0.68,
      baseB: 0.62,
      roughness: 0.86,
      scale: 1.0,
      elementRatio: 1.56,
      irregularity: 0.38,
      grainScale: 1.0,
      colorVariation: 0.36,
      jointWidth: 0.045,
      wear: 0.42,
      macroVariation: 0.44,
    },
  },
  shingles: {
    id: "shingles",
    label: "Roof shingles",
    slot: 7,
    baseRecipe: "cobblestone",
    defaults: {
      baseR: 0.24,
      baseG: 0.28,
      baseB: 0.35,
      roughness: 0.88,
      scale: 1.0,
      elementRatio: 1.56,
      irregularity: 0.42,
      grainScale: 1.0,
      colorVariation: 0.48,
      jointWidth: 0.035,
      wear: 0.44,
      macroVariation: 0.46,
    },
  },
  asphalt: {
    id: "asphalt",
    label: "Street asphalt",
    slot: 3,
    baseRecipe: "asphalt_concrete",
    defaults: { ...MATERIAL_RECIPES.asphalt_concrete.defaults },
  },
  concrete: {
    id: "concrete",
    label: "Sidewalk & curb concrete",
    slot: 4,
    baseRecipe: "asphalt_concrete",
    defaults: {
      ...MATERIAL_RECIPES.asphalt_concrete.defaults,
      baseR: 0.60,
      baseG: 0.61,
      baseB: 0.64,
      roughness: 0.86,
      elementRatio: 1.6,
      jointWidth: 0.04,
      wear: 0.48,
    },
  },
  grass: {
    id: "grass",
    label: "Lawn grass & soil",
    slot: 5,
    baseRecipe: "grass_soil",
    defaults: { ...MATERIAL_RECIPES.grass_soil.defaults },
  },
}

export const VIGNETTE_SURFACE_IDS = Object.keys(VIGNETTE_SURFACES) as readonly VignetteSurfaceId[]

export function isVignetteSurfaceId(v: unknown): v is VignetteSurfaceId {
  return typeof v === "string" && v in VIGNETTE_SURFACES
}

export type VignetteDirectionSpec = {
  id: VignetteDirectionId
  slug: string
  lookPreset: LookPresetId
  lookOverrides?: Partial<LookSettings>
  label: string
  summary: string
  rendererGaps: string
  values: {
    hour: number
    exposure: number
    ambientFill: number
    skyFill: number
    skyTemp: number
    moonStrength: number
    moonTemp: number
    shadowSoftness: number
    diffuseWrap: number
    streetLampPower: number
    streetLampTemp: number
    streetLampFalloff: number
    porchLightPower: number
    porchLightTemp: number
    porchLightFalloff: number
    windowLightPower: number
    windowLightTemp: number
    windowLightFalloff: number
    flashlightOn: boolean
    flashlightIntensity: number
    flashlightCone: number
    flashlightRange: number
    flashlightWarmth: number
    flashlightAim: number
    flashlightHaze: number
    clutterDensity: number
    foliageDensity: number
    overgrowth: number
  }
  surfaces: Partial<Record<VignetteSurfaceId, Partial<MaterialRecipeParams>>>
}

/**
 * Art direction presets ordered by Kit's priority:
 * 3 (Noir / survival horror) primary, 2 (Painterly) second, then 1 (Cinematic dusk), 5 (70s sodium), 4 (Cozy golden hour), 0 (Shipped).
 */
export const VIGNETTE_DIRECTIONS: Readonly<Record<VignetteDirectionId, VignetteDirectionSpec>> = {
  3: {
    id: 3,
    slug: "noir",
    lookPreset: "noir",
    lookOverrides: {
      tonemap: 0,
      exposure: 1.06,
      contrast: 1.02,
      toe: 0.0,
      shoulder: 0.12,
      blackCrush: 0.0,
      saturation: 0.78,
      temperature: -0.14,
      splitTone: 0.24,
      paletteMix: 0.0,
      foliageShift: 0.0,
      ambientFill: 1.0,
      shadowColorR: 0.92,
      shadowColorG: 0.98,
      shadowColorB: 1.08,
      practicalWarmth: 0.0,
      practicalIntensity: 1.0,
      moonIntensity: 1.0,
      rimStrength: 0.12,
      contactShade: 0.12,
      surfaceWetness: 0.22,
      fogDensity: 0.0,
      shaftStrength: 0.0,
      bloom: 1.0,
      halation: 0.06,
      vignette: 0.16,
      grain: 0.10,
      chromatic: 0.04,
      diffuseWrap: 0.0,
    },
    label: "3 · High-contrast noir / survival horror",
    summary: "Crushed shadows, cold steel-cyan moonlight, polar-shadowed player flashlight cone, damp specular road/porch sheen, and stark shadow edges.",
    rendererGaps: "Implemented in renderer: shared LookSettings ('noir') + gameplay flashlight (shared/flashlight.ts) with volumetric cone mist, wet low-roughness specular sheen, cold moonlight, and tight shadow softness. Remaining gaps: animated rain-ripple normals.",
    values: {
      hour: 22.4,
      exposure: 0.94,
      ambientFill: 0.18,
      skyFill: 0.24,
      skyTemp: -0.78,
      moonStrength: 1.15,
      moonTemp: -0.85,
      shadowSoftness: 0.07,
      diffuseWrap: 0.0,
      streetLampPower: 0.0,
      streetLampTemp: 3400,
      streetLampFalloff: 0.85,
      porchLightPower: 0.29,
      porchLightTemp: 3600,
      porchLightFalloff: 0.64,
      windowLightPower: 0.40,
      windowLightTemp: 2450,
      windowLightFalloff: 0.72,
      flashlightOn: true,
      flashlightIntensity: 1.68,
      flashlightCone: 35,
      flashlightRange: 10.6,
      flashlightWarmth: 0.22,
      flashlightAim: 45.5,
      flashlightHaze: 1.15,
      clutterDensity: 1.0,
      foliageDensity: 1.0,
      overgrowth: 0.15,
    },
    surfaces: {
      asphalt: { baseR: 0.16, baseG: 0.18, baseB: 0.21, roughness: 0.30, wear: 0.68, macroVariation: 0.72 },
      concrete: { baseR: 0.46, baseG: 0.49, baseB: 0.54, roughness: 0.40, wear: 0.64 },
      wood_floor: { baseR: 0.42, baseG: 0.32, baseB: 0.23, roughness: 0.56, wear: 0.62 },
      plaster: { baseR: 0.34, baseG: 0.32, baseB: 0.28, roughness: 0.86, wear: 0.68 },
      siding: { baseR: 0.54, baseG: 0.56, baseB: 0.58, roughness: 0.78, wear: 0.66 },
      shingles: { baseR: 0.18, baseG: 0.21, baseB: 0.27, roughness: 0.72, wear: 0.62 },
      grass: { baseR: 0.22, baseG: 0.28, baseB: 0.20, roughness: 0.88, wear: 0.58 },
    },
  },
  2: {
    id: 2,
    slug: "painterly",
    lookPreset: "painterly",
    lookOverrides: {
      tonemap: 0,
      exposure: 1.0,
      contrast: 1.04,
      toe: 0.04,
      shoulder: 0.22,
      blackCrush: 0.0,
      saturation: 1.16,
      temperature: 0.06,
      splitTone: 0.28,
      shadowTintR: 0.88,
      shadowTintG: 0.92,
      shadowTintB: 1.10,
      highlightTintR: 1.14,
      highlightTintG: 1.00,
      highlightTintB: 0.82,
      paletteMix: 0.0,
      foliageShift: 0.0,
      ambientFill: 1.0,
      shadowColorR: 0.90,
      shadowColorG: 0.94,
      shadowColorB: 1.06,
      practicalWarmth: 0.28,
      practicalIntensity: 1.10,
      moonIntensity: 1.0,
      rimStrength: 0.20,
      contactShade: 0.35,
      surfaceWetness: 0.0,
      fogDensity: 0.0,
      shaftStrength: 0.0,
      bloom: 1.15,
      halation: 0.16,
      painterlySmooth: 0.65,
      outlineStrength: 0.24,
      outlineWidth: 1.25,
      vignette: 0.18,
      grain: 0.0,
    },
    label: "2 · Painterly stylised (Tiny Glade / Ghibli)",
    summary: "Warm gouache twilight, periwinkle shadows + peach-gold practicals, 3-band soft diffuse wrap, and broad hand-painted Voronoi/plank shapes with suppressed micro-grit.",
    rendererGaps: "Implemented in renderer: shared LookSettings ('painterly') Kuwahara brush smoothing & ink outlines + gouache twilight surface washes and sage wainscot. Remaining gaps: curved silhouette mesh wobble.",
    values: {
      hour: 18.0,
      exposure: 1.12,
      ambientFill: 1.45,
      skyFill: 1.45,
      skyTemp: 0.16,
      moonStrength: 1.35,
      moonTemp: 0.18,
      shadowSoftness: 0.46,
      diffuseWrap: 0.90,
      streetLampPower: 0.0,
      streetLampTemp: 2900,
      streetLampFalloff: 1.15,
      porchLightPower: 1.05,
      porchLightTemp: 2750,
      porchLightFalloff: 1.15,
      windowLightPower: 1.05,
      windowLightTemp: 2700,
      windowLightFalloff: 1.15,
      flashlightOn: false,
      flashlightIntensity: 0.0,
      flashlightCone: 48,
      flashlightRange: 15,
      flashlightWarmth: 0.45,
      flashlightAim: 43,
      flashlightHaze: 0.0,
      clutterDensity: 1.15,
      foliageDensity: 1.25,
      overgrowth: 0.32,
    },
    surfaces: {
      wood_floor: { baseR: 0.72, baseG: 0.50, baseB: 0.28, roughness: 0.90, grainScale: 0.35, irregularity: 0.86, colorVariation: 0.58, wear: 0.24 },
      plaster: { baseR: 0.68, baseG: 0.58, baseB: 0.46, roughness: 0.92, grainScale: 0.35, colorVariation: 0.48, wear: 0.26 },
      siding: { baseR: 0.82, baseG: 0.78, baseB: 0.72, roughness: 0.90, grainScale: 0.35, irregularity: 0.68, wear: 0.22 },
      shingles: { baseR: 0.36, baseG: 0.40, baseB: 0.56, roughness: 0.90, scale: 0.85, irregularity: 0.82, grainScale: 0.35, colorVariation: 0.62 },
      asphalt: { baseR: 0.38, baseG: 0.42, baseB: 0.56, roughness: 0.92, grainScale: 0.35, wear: 0.24, macroVariation: 0.52 },
      concrete: { baseR: 0.72, baseG: 0.72, baseB: 0.78, roughness: 0.90, grainScale: 0.35, irregularity: 0.76, wear: 0.28 },
      grass: { baseR: 0.44, baseG: 0.56, baseB: 0.34, roughness: 0.95, scale: 0.80, grainScale: 0.35, colorVariation: 0.68, wear: 0.20 },
    },
  },
  1: {
    id: 1,
    slug: "dusk",
    lookPreset: "cinematic_dusk",
    label: "1 · Grounded cinematic dusk (current target)",
    summary: "Cool slate-indigo twilight sky fill against warm 2700K tungsten porch/window pools, matte weathered clapboard, variegated shingles, and clumped fescue lawn.",
    rendererGaps: "Implemented in renderer: shared LookSettings ('cinematic_dusk') + surface-materials WGSL + 5-tap polar shadows. Remaining gaps: directional moon shadow maps.",
    values: {
      hour: 18.2,
      exposure: 1.05,
      ambientFill: 1.0,
      skyFill: 1.05,
      skyTemp: -0.15,
      moonStrength: 1.10,
      moonTemp: -0.22,
      shadowSoftness: 0.20,
      diffuseWrap: 0.0,
      streetLampPower: 1.15,
      streetLampTemp: 3100,
      streetLampFalloff: 1.05,
      porchLightPower: 1.15,
      porchLightTemp: 2700,
      porchLightFalloff: 1.05,
      windowLightPower: 1.10,
      windowLightTemp: 2650,
      windowLightFalloff: 1.05,
      flashlightOn: false,
      flashlightIntensity: 0.0,
      flashlightCone: 48,
      flashlightRange: 15,
      flashlightWarmth: 0.45,
      flashlightAim: 43,
      flashlightHaze: 0.0,
      clutterDensity: 1.0,
      foliageDensity: 1.05,
      overgrowth: 0.12,
    },
    surfaces: {},
  },
  5: {
    id: 5,
    slug: "suburban-70s",
    lookPreset: "sodium_70s",
    label: "5 · Desaturated 70s/80s suburban (sodium)",
    summary: "2050K high-pressure sodium orange streetlamp vs 2850K warm tungsten interiors, muted 1970s walnut/ochre/avocado surfaces, halation, and 35mm film grain.",
    rendererGaps: "Implemented in renderer: shared LookSettings ('sodium_70s' halation + 35mm grain + split-tone grade) + 2050K sodium streetlamp vs 2850K tungsten interior colour split.",
    values: {
      hour: 19.3,
      exposure: 0.98,
      ambientFill: 0.76,
      skyFill: 0.80,
      skyTemp: -0.08,
      moonStrength: 0.72,
      moonTemp: -0.18,
      shadowSoftness: 0.22,
      diffuseWrap: 0.0,
      streetLampPower: 1.60,
      streetLampTemp: 2050,
      streetLampFalloff: 1.25,
      porchLightPower: 1.15,
      porchLightTemp: 2600,
      porchLightFalloff: 1.05,
      windowLightPower: 1.20,
      windowLightTemp: 2850,
      windowLightFalloff: 1.10,
      flashlightOn: false,
      flashlightIntensity: 0.0,
      flashlightCone: 48,
      flashlightRange: 15,
      flashlightWarmth: 0.45,
      flashlightAim: 43,
      flashlightHaze: 0.0,
      clutterDensity: 1.10,
      foliageDensity: 0.95,
      overgrowth: 0.08,
    },
    surfaces: {
      wood_floor: { baseR: 0.44, baseG: 0.33, baseB: 0.22, roughness: 0.82, colorVariation: 0.44, wear: 0.54 },
      plaster: { baseR: 0.45, baseG: 0.41, baseB: 0.31, roughness: 0.88, wear: 0.56 },
      siding: { baseR: 0.68, baseG: 0.64, baseB: 0.54, roughness: 0.86, wear: 0.58 },
      shingles: { baseR: 0.25, baseG: 0.24, baseB: 0.23, roughness: 0.88, wear: 0.56 },
      asphalt: { baseR: 0.22, baseG: 0.22, baseB: 0.21, roughness: 0.82, wear: 0.62 },
      concrete: { baseR: 0.56, baseG: 0.55, baseB: 0.50, roughness: 0.86, wear: 0.58 },
      grass: { baseR: 0.31, baseG: 0.34, baseB: 0.22, roughness: 0.94, wear: 0.52 },
    },
  },
  4: {
    id: 4,
    slug: "cozy-apocalypse",
    lookPreset: "cozy_golden_hour",
    label: "4 · Warm cozy-apocalypse (golden hour)",
    summary: "Low amber golden-hour sun, warm window sun-shaft floor pools, and overgrown moss/turf creeping through cracked concrete and asphalt.",
    rendererGaps: "Implemented in renderer: shared LookSettings ('cozy_golden_hour') + low-elevation golden-hour sun, window sun-shaft floor pools, and mossy crack overgrowth. Remaining gaps: 3D climbing ivy vines (owned by foliage agent).",
    values: {
      hour: 17.2,
      exposure: 1.14,
      ambientFill: 1.18,
      skyFill: 1.22,
      skyTemp: 0.76,
      moonStrength: 1.75,
      moonTemp: 0.88,
      shadowSoftness: 0.26,
      diffuseWrap: 0.18,
      streetLampPower: 0.35,
      streetLampTemp: 2700,
      streetLampFalloff: 0.90,
      porchLightPower: 0.95,
      porchLightTemp: 2550,
      porchLightFalloff: 1.0,
      windowLightPower: 1.05,
      windowLightTemp: 2500,
      windowLightFalloff: 1.05,
      flashlightOn: false,
      flashlightIntensity: 0.0,
      flashlightCone: 48,
      flashlightRange: 15,
      flashlightWarmth: 0.45,
      flashlightAim: 43,
      flashlightHaze: 0.0,
      clutterDensity: 1.25,
      foliageDensity: 1.45,
      overgrowth: 0.88,
    },
    surfaces: {
      wood_floor: { baseR: 0.58, baseG: 0.43, baseB: 0.28, roughness: 0.85, wear: 0.64, macroVariation: 0.66 },
      plaster: { baseR: 0.48, baseG: 0.42, baseB: 0.33, roughness: 0.88, wear: 0.66 },
      siding: { baseR: 0.72, baseG: 0.67, baseB: 0.56, roughness: 0.88, wear: 0.70, macroVariation: 0.68 },
      shingles: { baseR: 0.26, baseG: 0.29, baseB: 0.24, roughness: 0.90, wear: 0.68, macroVariation: 0.76 },
      asphalt: { baseR: 0.23, baseG: 0.24, baseB: 0.22, roughness: 0.86, wear: 0.78, macroVariation: 0.76 },
      concrete: { baseR: 0.58, baseG: 0.56, baseB: 0.49, roughness: 0.88, wear: 0.76, jointWidth: 0.065 },
      grass: { baseR: 0.39, baseG: 0.44, baseB: 0.22, roughness: 0.94, colorVariation: 0.76, wear: 0.36 },
    },
  },
  0: {
    id: 0,
    slug: "shipped",
    lookPreset: "current",
    label: "0 · Current shipped (baseline)",
    summary: "Exact shipped Outbreak lighting, practical lamps, and default surface-materials recipes.",
    rendererGaps: "Baseline production Outbreak configuration.",
    values: {
      hour: 18.0,
      exposure: 1.0,
      ambientFill: 1.0,
      skyFill: 1.0,
      skyTemp: 0.0,
      moonStrength: 1.0,
      moonTemp: 0.0,
      shadowSoftness: 0.20,
      diffuseWrap: 0.0,
      streetLampPower: 1.0,
      streetLampTemp: 3200,
      streetLampFalloff: 1.0,
      porchLightPower: 1.0,
      porchLightTemp: 2700,
      porchLightFalloff: 1.0,
      windowLightPower: 1.0,
      windowLightTemp: 2650,
      windowLightFalloff: 1.0,
      flashlightOn: false,
      flashlightIntensity: 0.0,
      flashlightCone: 52,
      flashlightRange: 19,
      flashlightWarmth: 0.45,
      flashlightAim: 43,
      flashlightHaze: 0.0,
      clutterDensity: 1.0,
      foliageDensity: 1.0,
      overgrowth: 0.0,
    },
    surfaces: {},
  },
}

export const VIGNETTE_DIRECTION_ORDER: readonly VignetteDirectionId[] = [3, 2, 1, 5, 4, 0]

export const VIGNETTE_CAMERA_PRESETS: Readonly<
  Record<
    VignetteCameraPreset,
    {
      label: string
      focus: [number, number, number]
      pitch: number
      yaw: number
      dist: number
      cutawayMode: 0 | 1 | 2
      playerPos: [number, number, number]
    }
  >
> = {
  game: {
    label: "Game camera (lot + street + cutaway)",
    focus: [28.6, 0.3, 35.4],
    pitch: 1.1,
    yaw: 0,
    dist: 36,
    cutawayMode: 1,
    playerPos: [27.7, 38.6, -Math.PI / 2],
  },
  interior: {
    label: "Interior close (living room + kitchen)",
    focus: [29.5, 0.4, 31.4],
    pitch: 1.12,
    yaw: 0,
    dist: 22,
    cutawayMode: 1,
    playerPos: [28.0, 31.2, -Math.PI / 2],
  },
  street: {
    label: "Street close (lamp + curb + porch)",
    focus: [29.2, 0.2, 38.8],
    pitch: 1.04,
    yaw: 0,
    dist: 24,
    cutawayMode: 0,
    playerPos: [28.2, 41.2, -Math.PI / 2],
  },
  target_street: {
    label: "Target street (aligned 1000×680)",
    focus: [30.0, 0.0, 41.0],
    pitch: 1.1,
    yaw: 0,
    dist: 42.0,
    cutawayMode: 2,
    playerPos: [30.0, 41.35, -Math.PI / 2],
  },
  target_interior: {
    label: "Target interior (aligned 1000×680)",
    focus: [27.7, 0.0, 31.0],
    pitch: 1.1,
    yaw: 0,
    dist: 34.0,
    cutawayMode: 1,
    playerPos: [28.15, 31.35, -Math.PI / 2],
  },
}

/** Optional bridge hook for the shared @arcade/kit LookSettings system (branch `looks`). */
export type VignetteLookHook = (state: {
  directionPreset: VignetteDirectionId
  directionSlug: string
  settings: Readonly<Record<string, number | string | boolean>>
}) => void

let externalLookHook: VignetteLookHook | undefined
export function setVignetteLookHook(hook: VignetteLookHook | undefined): void {
  externalLookHook = hook
}
export function getVignetteLookHook(): VignetteLookHook | undefined {
  return externalLookHook
}

/** Convert Kelvin colour temperature (1800..6500K) into linear-ish lamp RGB multiplier. */
export function kelvinToRgb(kelvin: number): [number, number, number] {
  const k = Math.max(1800, Math.min(6500, kelvin))
  if (k <= 2200) {
    // High-pressure sodium amber-orange (2000-2200K)
    const t = (k - 1800) / 400
    return [1.0, 0.42 + t * 0.12, 0.08 + t * 0.08]
  }
  if (k <= 3200) {
    // Warm tungsten incandescent (2200-3200K)
    const t = (k - 2200) / 1000
    return [1.0, 0.54 + t * 0.24, 0.16 + t * 0.36]
  }
  // Neutral to cool halogen / LED flashlight (3200-6500K)
  const t = (k - 3200) / 3300
  return [1.0 - t * 0.14, 0.78 + t * 0.16, 0.52 + t * 0.48]
}

export function surfaceParamKey(surface: VignetteSurfaceId, param: MaterialParamKey): string {
  return `mat_${surface}_${param}`
}

/**
 * Build a single-house-lot Town (`ash`, BUILDING_RECTS[0] = [22, 24, 37, 35.5])
 * with lawn, front path, porch, cutaway interior (living room + kitchen + bedroom),
 * sidewalk/curb/street strip, one streetlamp, and one tree slot.
 */
export function makeVignetteTown(options: {
  seed?: number
  houseSeed?: number
  terrain?: number
  foliageDensity?: number
  clutterDensity?: number
  treeSlot?: number
}): Town {
  const seed = options.seed ?? 7
  const houseSeed = options.houseSeed ?? 7
  const terrain = options.terrain ?? 0.22
  const foliageDensity = options.foliageDensity ?? 1
  const clutterDensity = options.clutterDensity ?? 1
  const treeSlot = options.treeSlot ?? 1

  const rng = new Rng(seed)
  const houses = new Rng(houseSeed)
  const town: Town = {
    seed,
    houseSeed,
    terrain,
    foliageDensity,
    chunks: [],
    buildings: [],
    barriers: [],
    doors: [],
    windows: [],
    props: [],
    lamps: [],
  }
  for (let y = 0; y < 3; y++) {
    for (let x = 0; x < 3; x++) {
      town.chunks.push([x * CHUNK, y * CHUNK, (x + 1) * CHUNK, (y + 1) * CHUNK])
    }
  }

  const rect = BUILDING_RECTS[0]
  const [x, y, r, b] = rect
  const color = houses.pick([0xb3afa0, 0x899d95, 0xb4a181, 0x9caaa9])
  town.buildings.push({ id: "ash", kind: "house", rect, color })

  const wall = (wRect: readonly [number, number, number, number], wColor: number, kind: "wall" | "window" | "fence" = "wall") =>
    town.barriers.push({ rect: wRect, color: wColor, kind })

  const doorX = x + 5
  wall([x, y, r, y + 0.22], color)
  wall([x, y, x + 0.22, b], color)
  wall([r - 0.22, y, r, y + 4], color)
  wall([r - 0.22, y + 4, r, y + 6.5], color, "window")
  wall([r - 0.22, y + 6.5, r, b], color)
  wall([x, b - 0.22, x + 1.5, b], color)
  wall([x + 1.5, b - 0.22, x + 3.5, b], color, "window")
  wall([x + 3.5, b - 0.22, doorX, b], color)
  town.doors.push({ id: "ash-front", rect: [doorX, b - 0.22, doorX + 1.4, b], open: true })
  wall([doorX + 1.4, b - 0.22, r - 4, b], color)
  wall([r - 4, b - 0.22, r - 1.5, b], color, "window")
  wall([r - 1.5, b - 0.22, r, b], color)

  const split = y + 5.5
  wall([x, split, doorX, split + 0.2], color)
  town.doors.push({ id: "ash-room", rect: [doorX, split, doorX + 1.4, split + 0.2], open: true })
  wall([doorX + 1.4, split, r, split + 0.2], color)

  // Lot perimeter fence (north + west)
  wall([18, 20, 39, 20.12], 0x756b51, "fence")
  wall([18, 20, 18.12, 39], 0x756b51, "fence")

  // Interior furniture & clutter scaled by clutterDensity (0..1.5)
  const allInteriorProps: { x: number; y: number; kind: Prop["kind"]; minDensity: number }[] = [
    // Core living room + kitchen + bedroom fixtures
    { x: x + 1.1, y: b - 2.2, kind: "sofa", minDensity: 0.1 },
    { x: r - 0.8, y: b - 2.0, kind: "counter", minDensity: 0.1 },
    { x: r - 0.8, y: b - 4.0, kind: "fridge", minDensity: 0.1 },
    { x: r - 0.8, y: b - 0.65, kind: "stove", minDensity: 0.1 },
    { x: x + 4.0, y: y + 2.0, kind: "bed", minDensity: 0.15 },
    { x: r - 3.2, y: b - 2.8, kind: "table", minDensity: 0.25 },
    // Standard lived-in furniture
    { x: x + 2.7, y: b - 2.2, kind: "coffee", minDensity: 0.45 },
    { x: r - 3.2, y: b - 1.8, kind: "chair", minDensity: 0.5 },
    { x: r - 3.2, y: b - 3.7, kind: "chair", minDensity: 0.65 },
    { x: x + 2.7, y: y + 2.0, kind: "nightstand", minDensity: 0.55 },
    { x: r - 2.3, y: y + 1.1, kind: "dresser", minDensity: 0.6 },
    { x: x + 4.2, y: b - 1.1, kind: "chair", minDensity: 0.75 },
    { x: x + 7.7, y: y + 0.7, kind: "shelf", minDensity: 0.85 },
    { x: r - 4.0, y: y + 3.0, kind: "table", minDensity: 0.9 },
    { x: r - 4.0, y: y + 3.9, kind: "chair", minDensity: 0.95 },
    // Extra high-density clutter (clutterDensity > 1.0)
    { x: x + 1.2, y: y + 4.4, kind: "shelf", minDensity: 1.15 },
    { x: r - 1.2, y: y + 3.4, kind: "nightstand", minDensity: 1.25 },
    { x: x + 8.6, y: b - 1.2, kind: "nightstand", minDensity: 1.35 },
  ]

  for (const item of allInteriorProps) {
    const v = rng.next()
    if (clutterDensity >= item.minDensity) {
      town.props.push({ x: item.x, y: item.y, kind: item.kind, variant: v })
    }
  }

  // Framing trees around the house lot and south street (matching makeTown seed 7 framing)
  if (treeSlot > 0) {
    const variant = treeSlot === 1 ? 0.46 : treeSlot === 2 ? 0.82 : 0.18
    town.props.push({ x: 16.4, y: 32.6, kind: "tree", variant })
    for (const [tx, ty] of [
      [12.8, 24.5],
      [15.6, 29.4],
      [11.5, 33.2],
      [15.4, 35.8],
      [13.8, 49.2],
      [44.5, 52.8],
      [48.2, 51.4],
    ] as const) {
      town.props.push({ x: tx, y: ty, kind: "tree", variant: rng.next() })
    }
  }

  // One streetlamp right beside the house lot frontage + the house's porch, window, and room practicals
  town.lamps.push({ x: 34.4, y: 39.12, h: 3.55, radius: 7.4, power: 0.52, kind: "street" })
  town.lamps.push({ x: x + 5.7, y: b + 1.15, h: 2.42, radius: 6.8, power: 1.05, kind: "porch" })
  town.lamps.push({ x: x + 2.6, y: y + 1.85, h: 1.24, radius: 4.6, power: 0.38, kind: "room" })
  town.lamps.push({ x: x + 1.25, y: b - 1.25, h: 1.48, radius: 5.4, power: 0.45, kind: "room" })
  town.lamps.push({ x: r - 3.2, y: b - 3.6, h: 2.15, radius: 5.4, power: 0.38, kind: "room" })
  town.lamps.push({ x: x + 6.1, y: y + 4.2, h: 2.40, radius: 5.2, power: 0.34, kind: "room" })
  for (const wx of [x + 2.5, r - 2.75]) {
    town.lamps.push({ x: wx, y: b + 0.12, h: 1.42, radius: 2.4, power: 0.26, kind: "window" })
  }

  return town
}

/**
 * Filter compiled LevelData triangles to the focused single-lot + street strip bounds
 * (`x ∈ [13.5, 41.5], z ∈ [19.5, 48.2]`) so distant town terrain/road triangles are excluded.
 */
function cropChunkToVignette(chunk: LevelChunk): LevelChunk | null {
  const minXBound = 6.0
  const maxXBound = 55.0
  const minZBound = 18.0
  const maxZBound = 57.0
  if (chunk.box[2] < minXBound || chunk.box[0] > maxXBound || chunk.box[3] < minZBound || chunk.box[1] > maxZBound) {
    return null
  }
  const f32 = new Float32Array(chunk.data)
  const u8 = new Uint8Array(chunk.data)
  const strideFloats = VERT_BYTES / 4 // 6 floats (24 bytes) per vertex
  const triBytes = VERT_BYTES * 3 // 72 bytes per triangle
  const totalTris = chunk.data.byteLength / triBytes
  const keptTris: number[] = []
  let x0 = Infinity
  let z0 = Infinity
  let x1 = -Infinity
  let z1 = -Infinity
  let top = 0

  for (let t = 0; t < totalTris; t++) {
    const baseF = t * strideFloats * 3
    const ax = f32[baseF]!
    const ay = f32[baseF + 1]!
    const az = f32[baseF + 2]!
    const bx = f32[baseF + 6]!
    const by = f32[baseF + 7]!
    const bz = f32[baseF + 8]!
    const cx = f32[baseF + 12]!
    const cy = f32[baseF + 13]!
    const cz = f32[baseF + 14]!
    const triMinX = Math.min(ax, bx, cx)
    const triMaxX = Math.max(ax, bx, cx)
    const triMinZ = Math.min(az, bz, cz)
    const triMaxZ = Math.max(az, bz, cz)
    if (triMaxX < minXBound || triMinX > maxXBound || triMaxZ < minZBound || triMinZ > maxZBound) continue
    keptTris.push(t)
    x0 = Math.min(x0, triMinX)
    x1 = Math.max(x1, triMaxX)
    z0 = Math.min(z0, triMinZ)
    z1 = Math.max(z1, triMaxZ)
    top = Math.max(top, ay, by, cy)
  }

  if (!keptTris.length) return null
  if (keptTris.length === totalTris) return chunk

  const out = new Uint8Array(keptTris.length * triBytes)
  for (let i = 0; i < keptTris.length; i++) {
    const srcOff = keptTris[i]! * triBytes
    out.set(u8.subarray(srcOff, srcOff + triBytes), i * triBytes)
  }
  return {
    data: out.buffer,
    box: [x0, z0, x1, z1] as const,
    cutBox: chunk.cutBox ? [x0, 0, z0, x1, Math.max(top, chunk.cutBox[4] ?? top), z1] : undefined,
    customCutaway: chunk.customCutaway,
  }
}

export function buildVignetteLevel(town: Town): LevelData {
  // Vignette scenes do not run PropDressing, so keep the level's box furniture intact.
  const wasOn = propDressingState.on
  propDressingState.on = false
  try {
    const raw = buildLevel(town)
    return {
      chunks: raw.chunks.map(cropChunkToVignette).filter((c): c is LevelChunk => c !== null),
      glass: raw.glass.map(cropChunkToVignette).filter((c): c is LevelChunk => c !== null),
      floor: raw.floor,
      bounce: raw.bounce,
    }
  } finally {
    propDressingState.on = wasOn
  }
}
