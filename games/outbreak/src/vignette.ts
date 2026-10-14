import { mat4, vec4 } from "wgpu-matrix"
import { Camera } from "@arcade/kit/client/camera"
import type { LabCommandRegistry } from "@arcade/kit/lab-commands"
import type { LabControl, LabSettings } from "@arcade/kit/lab-panel"
import type { LevelChunk, LevelData } from "@arcade/kit/gpu/level"
import { LIGHT_FLOATS, MAX_LIGHTS, MAX_OCCLUDERS, OCC_FLOATS } from "@arcade/kit/gpu/limits"
import { MAT, Mesh, VERT_BYTES } from "@arcade/kit/gpu/mesh"
import { Renderer, type Batch, type FrameInput } from "@arcade/kit/gpu/renderer"
import {
  FRAME_FLOATS,
  makeLookPostShader,
  makeLookSceneShader,
  makeSceneShader,
  postShader,
  spriteShader,
  type SceneHooks,
} from "@arcade/kit/gpu/shaders"
import {
  LOOK_PARAM_SPECS,
  applyLookPreset,
  createLookControls,
  createLookSettings,
  type LookCompareMode,
  type LookPresetId,
  type LookSettings,
} from "@arcade/kit/look"
import {
  MATERIAL_PARAM_SPECS,
  MATERIAL_RECIPES,
  packMaterialParams,
  randomizeMaterialParams,
  surfaceMaterialCoreWgsl,
  validateMaterialParams,
  type MaterialParamKey,
  type MaterialRecipeId,
  type MaterialRecipeParams,
} from "@arcade/kit/gpu/surface-materials"
import type { LabWorldObject, SectionFactory } from "@arcade/kit/lab/types"
import { Rng } from "@arcade/kit/sim/rng"
import { clockText, dayCycle, wrapHour } from "../shared/day-cycle"
import {
  DEFAULT_FLASHLIGHT_TUNING,
  createFlashlightState,
  flashlightColor,
  flashlightControls,
  stepFlashlight,
  type FlashlightState,
  type FlashlightTuning,
} from "../shared/flashlight"
import { BUILDING_RECTS, CHUNK, propShape, sightRects, SIZE, type Prop, type Town } from "../shared/map"
import { SceneryMemory } from "../shared/scenery-memory"
import { supportHeight } from "../shared/terrain"
import { FOG_SIZE, Vision } from "../shared/vision"
import { buildLevel, hex } from "./level"
import { outbreakPostFinish } from "./shaders"
import { Survivor } from "./survivor"

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
      porchLightPower: 0.40,
      porchLightTemp: 3600,
      porchLightFalloff: 0.78,
      windowLightPower: 0.42,
      windowLightTemp: 2450,
      windowLightFalloff: 0.74,
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
  // Temporarily tag seed so buildLevel's 3-entry cache doesn't collide with full-town builds
  const raw = buildLevel(town)
  return {
    chunks: raw.chunks.map(cropChunkToVignette).filter((c): c is LevelChunk => c !== null),
    glass: raw.glass.map(cropChunkToVignette).filter((c): c is LevelChunk => c !== null),
    floor: raw.floor,
    bounce: raw.bounce,
  }
}

export const vignetteSceneHooks: SceneHooks = {
  ao: "0.42",
  lightLeak: "0.006 * vis",
  lightAttenuation: `let dn = max(d3, 0.55);
    var att = power * win * (0.08 + 3.4 / (1.0 + dn * dn * 0.45));
    if (att <= 0.004) { continue; }`,
  wallDirectScale: "mix(0.28, 0.46, smoothstep(0.0, 1.5, o.world.y))",
  ambient:
    "ambientAt(n) * select(1.0, Vig.params2.z, useVignetteActive(o.pos)) * mix(0.13 * select(1.0, Vig.params1.x, useVignetteActive(o.pos)), 1.0, select(floorData(o.world.xz).g, 1.0, o.world.y > 2.8)) + select(vec3f(0.0), mix(vec3f(0.022, 0.015, 0.008), vec3f(0.032, 0.020, 0.009), clamp(select(0.0, Vig.params1.y, useVignetteActive(o.pos)), -1.0, 1.0) * 0.5 + 0.5) * select(1.0, Vig.params1.x, useVignetteActive(o.pos)), interior(o.world.xz) && o.world.y < 2.8)",
  diagnostics: "F.map.z",
  smoothShadows: true,
  shadowTaps: 5,
  lightMask: "if (L.cone.w < -0.5 && world.y > 2.75) { continue; } if (L.extra.w < -0.5 && !useVignetteWorld(world)) { continue; }",
  fragmentStart: "surfaceFootprint = max(length(dpdx(o.world)), length(dpdy(o.world)));",
  declarations: /* wgsl */ `
@group(0) @binding(9) var exploredTex: texture_2d<f32>;
${surfaceMaterialCoreWgsl}

struct VignetteUniforms {
  // 0: wood_floor, 1: cobblestone, 2: plaster, 3: asphalt, 4: concrete, 5: grass, 6: siding, 7: shingles
  recipes: array<MaterialRecipe, 8>,
  // x: compareMode (0=active, 1=shipped, 2=split), y: compareSplit (0..1), z: cutawayMode, w: diffuseWrap (0..1)
  params0: vec4f,
  // x: ambientFill, y: skyTemp, z: moonTemp, w: overgrowth (0..1)
  params1: vec4f,
  // x: playerX, y: playerZ, z: skyScaleRatio, w: moonScaleRatio
  params2: vec4f,
  // x: flashOriginX, y: flashOriginZ, z: flashDirX, w: flashDirZ
  params3: vec4f,
  // x: tanHalfAngle, y: flashRange, z: flashHaze, w: flashSlot (<0 if off)
  params4: vec4f,
}
@group(0) @binding(13) var<uniform> Vig: VignetteUniforms;
var<private> surfaceTexRatio: vec3f;

fn useVignetteActive(fragPos: vec4f) -> bool {
  let mode = i32(round(Vig.params0.x));
  if (mode == 1) { return false; }
  if (mode == 2) { return (fragPos.x / max(1.0, F.screen.x)) >= Vig.params0.y; }
  return true;
}

fn useVignetteWorld(world: vec3f) -> bool {
  let mode = i32(round(Vig.params0.x));
  if (mode == 1) { return false; }
  if (mode == 2) {
    let clip = F.viewProj * vec4f(world, 1.0);
    let u = (clip.x / max(clip.w, 1e-4)) * 0.5 + 0.5;
    return u >= Vig.params0.y;
  }
  return true;
}

fn pickRecipe(defId: i32, vigSlot: i32, useVig: bool) -> MaterialRecipe {
  if (useVig) { return Vig.recipes[vigSlot]; }
  return defaultMaterialRecipe(defId);
}

fn scaleBaseTint(vertexLinear: vec3f, recipeRgb: vec3f, defaultRgb: vec3f) -> vec3f {
  let rLin = pow(max(recipeRgb, vec3f(0.02)), vec3f(2.2));
  let dLin = pow(max(defaultRgb, vec3f(0.02)), vec3f(2.2));
  return clamp(vertexLinear * (rLin / max(dLin, vec3f(0.001))), vec3f(0.002), vec3f(1.8));
}

fn evalClapboardSiding(world: vec3f, baseTint: vec3f, r: MaterialRecipe) -> SurfaceSample {
  let scale = max(0.25, r.u1.x);
  let lapH = (0.18 * (r.u1.y / 1.56)) / scale;
  let boardLen = (2.2 / scale) * (1.0 + (r.u1.z - 0.38) * 0.3);
  let row = floor(world.y / lapH);
  let plank = floor((world.x + world.z + row * 0.43) / max(0.4, boardLen));
  var col = baseTint;
  col *= 0.95 + (hash2(vec2f(row, plank)) - 0.5) * 0.18 * r.u2.x;
  col *= mix(1.0 - clamp(r.u2.y * 6.5, 0.08, 0.55), 1.0, seam(world.y / lapH, max(0.008, r.u2.y * 0.55), 1.0 / lapH));
  col *= 0.97 + grain(vec2f(world.x + world.z, world.y * 3.5), 11.0 * max(0.25, r.u1.w)) * 0.16;
  let splash = (1.0 - smoothstep(0.13, 0.58, world.y)) * r.u2.z * 0.28;
  let macroPatch = (surfaceNoise(vec2f(world.x + world.z, world.y) * 0.55) - 0.5) * r.u2.w * 0.16;
  col *= clamp(1.0 - splash + macroPatch, 0.45, 1.25);
  return SurfaceSample(col, roughnessToGloss(r.u0.w, 0.03), r.u0.w, 1.0 - splash);
}

fn evalRoofShingles(world: vec3f, baseTint: vec3f, r: MaterialRecipe) -> SurfaceSample {
  let scale = max(0.25, r.u1.x);
  let courseZ = 0.24 / scale;
  let tabX = (0.36 * (r.u1.y / 1.56)) / scale;
  let warp = (surfaceNoise(world.xz * 1.6) - 0.5) * 0.18 * max(0.0, r.u1.z - 0.42);
  let row = floor((world.z + warp) / courseZ);
  let q = vec2f((world.x + warp * 0.5) / tabX + fract(row * 0.5), (world.z + warp) / courseZ);
  let tabHash = hash2(floor(q)) - 0.5;
  var col = baseTint * (0.97 + tabHash * 0.55 * r.u2.x * (1.0 - smoothstep(0.12, 0.5, surfaceFootprint * (1.0 / courseZ))));
  let jw = max(0.006, r.u2.y * 0.52);
  col *= mix(0.52, 1.0, seam(q.x, jw, 1.0 / tabX) * seam(q.y, jw * 1.8, 1.0 / courseZ));
  col *= 1.0 + grain(world.xz, 18.0 * max(0.25, r.u1.w)) * 0.15;
  let moss = smoothstep(0.58 - r.u2.z * 0.15, 0.80, surfaceNoise(world.xz * 0.65 + vec2f(3.1, 1.7))) * r.u2.w;
  col = mix(col, vec3f(0.18, 0.25, 0.14), moss * 0.38);
  return SurfaceSample(col, roughnessToGloss(r.u0.w, 0.04), r.u0.w, 1.0);
}

fn houseRect(id: i32) -> vec4f {
  switch id {
    ${BUILDING_RECTS.map((b, i) => `${i === 3 ? "default" : `case ${i}`}: {return vec4f(${b.map(v => v.toFixed(2)).join(",")});}`).join("\n")}
  }
}
fn interior(p: vec2f) -> bool {
  if (p.x < 21.25 || p.x > 72.75 || p.y < 23.25 || p.y > 67.75 || (p.x > 36.75 && p.x < 53.25) || (p.y > 37.75 && p.y < 54.25)) { return false; }
  for (var i = 0; i < 4; i++) { let b = houseRect(i); if (all(p > b.xy + 0.25) && all(p < b.zw - 0.25)) { return true; } }
  return false;
}
fn roofCut(p: vec3f, id: i32) -> bool {
  let b = houseRect(id);
  return all(F.eye.xy > b.xy - 0.1) && all(F.eye.xy < b.zw + 0.1) && p.x > b.x + 0.35 && p.x < b.z - 0.35 && p.z > b.y + 0.35 && p.z < b.w + 1.65;
}
fn eyeVisible(p: vec2f) -> f32 {
  let eyeOrigin = select(F.eye.xy, Vig.params2.xy, length(Vig.params2.xy) > 0.1);
  let delta = p - eyeOrigin;
  let distance = length(delta);
  let a = (atan2(delta.y, delta.x) + TAU) % TAU;
  let f = a / TAU * f32(RAYS) - 0.5;
  let ray0 = u32(i32(floor(f)) + i32(RAYS)) % RAYS;
  let ray1 = (ray0 + 1u) % RAYS;
  let los0 = 1.0 - smoothstep(polar[ray0 * 2u].x + 0.025, polar[ray0 * 2u].x + 0.10, distance);
  let los1 = 1.0 - smoothstep(polar[ray1 * 2u].x + 0.025, polar[ray1 * 2u].x + 0.10, distance);
  let los = mix(los0, los1, fract(f));
  let facing = dot(delta / max(distance, 0.001), vec2f(cos(F.effects.x), sin(F.effects.x)));
  let cone = smoothstep(F.effects.y, F.effects.y + 0.035, facing);
  let near = 1.0 - smoothstep(F.effects.z - 0.2, F.effects.z, distance);
  let range = 1.0 - smoothstep(lights[0].pos.w - 1.0, lights[0].pos.w, distance);
  return los * max(cone, near) * range;
}
`,
    material: /* wgsl */ `
    let activeVignette = useVignetteActive(o.pos);
    let texOn = surfaceTexEnabledAt(o.world.x);
    let wallUv = select(vec2f(o.world.x, o.world.y), vec2f(o.world.z, o.world.y), abs(n.x) > abs(n.z));
    if (mat == 20) {
      let kind = i32(round(o.aux));
      let p = o.world.xz;
      if (kind == 0) {
        let r = pickRecipe(4, 5, activeVignette);
        let tinted = select(albedo, scaleBaseTint(albedo, r.u0.xyz, vec3f(0.34, 0.39, 0.26)), activeVignette);
        let s = evalGrassSoil(p, tinted, false, r);
        albedo = s.albedo;
        gloss = s.gloss;
        if (texOn) {
          let tex = sampleMaterialFast(8, p, 0.58 * max(0.25, r.u1.x));
          albedo = modulateFast(albedo, tex, vec3f(0.1918, 0.1757, 0.0541), 0.88);
          let normAtten = (1.0 - smoothstep(0.08, 0.48, surfaceFootprint)) * 0.28;
          let tilt = (tex.a - 0.91) * 3.2;
          n = normalize(n + vec3f(tilt, 0.0, -tilt * 0.85) * normAtten);
        }
      } else if (kind == 1) {
        let r = pickRecipe(3, 3, activeVignette);
        let tinted = select(albedo, scaleBaseTint(albedo, r.u0.xyz, vec3f(0.24, 0.26, 0.28)), activeVignette);
        let s = evalAsphaltConcrete(p, tinted, false, r);
        albedo = s.albedo;
        gloss = s.gloss;
        if (texOn) {
          let tex = sampleMaterialFast(7, p, 0.55 * max(0.25, r.u1.x));
          albedo = modulateFast(albedo, tex, vec3f(0.0931, 0.0927, 0.0950), 0.92);
        }
        if (activeVignette && Vig.params1.w > 0.02) {
          let edgeCreep = (1.0 - smoothstep(0.0, 1.25, min(abs(p.y - 40.0), abs(p.y - 48.0)))) * surfaceNoise(p * 1.8 + vec2f(4.2, 1.9));
          let moss = smoothstep(0.42, 0.72, edgeCreep) * Vig.params1.w;
          albedo = mix(albedo, vec3f(0.14, 0.21, 0.09), moss * 0.65);
        }
      } else if (kind == 2) {
        let r = pickRecipe(3, 4, activeVignette);
        let tinted = select(albedo, scaleBaseTint(albedo, r.u0.xyz, vec3f(0.60, 0.61, 0.64)), activeVignette);
        let s = evalAsphaltConcrete(p, tinted, true, r);
        albedo = s.albedo;
        gloss = s.gloss;
        if (texOn) {
          let tex = sampleMaterialFast(6, p, 0.58 * max(0.25, r.u1.x));
          albedo = modulateFast(albedo, tex, vec3f(0.4007, 0.3581, 0.3189), 0.85);
        }
        if (activeVignette && Vig.params1.w > 0.02) {
          let jointMoss = (1.0 - s.cavity) * smoothstep(0.30, 0.68, surfaceNoise(p * 1.5 + vec2f(7.1, 2.3))) * Vig.params1.w;
          albedo = mix(albedo, vec3f(0.16, 0.24, 0.10), clamp(jointMoss * 1.35, 0.0, 0.78));
        }
      } else if (kind == 3) {
        let ruts = exp(-pow((fract((p.x - 19.0) * 0.377) - 0.26) * 5.2, 2.0)) + exp(-pow((fract((p.x - 19.0) * 0.377) - 0.74) * 5.2, 2.0));
        let pebbles = grain(p, 18.0) * 0.85 + grain(p + vec2f(3.7, 1.9), 9.5) * 0.48;
        let edgeFade = smoothstep(0.0, 0.24, min(fract((p.x - 19.0) * 0.377), 1.0 - fract((p.x - 19.0) * 0.377)));
        albedo *= (0.78 + pebbles + (surfaceNoise(p * 2.6) - 0.5) * 0.36 - 0.16 * clamp(ruts, 0.0, 1.0)) * (0.76 + 0.24 * edgeFade);
        if (texOn) {
          let tex = sampleMaterialFast(15, p, 0.85);
          albedo = modulateFast(albedo, tex, vec3f(0.2950, 0.2326, 0.1649), 0.65);
        }
        gloss = vec2f(0.0);
      } else if (kind == 4) {
        let r = pickRecipe(0, 0, activeVignette);
        let tinted = select(albedo, scaleBaseTint(albedo, r.u0.xyz, vec3f(0.55, 0.43, 0.31)), activeVignette);
        let s = evalWoodPlanks(p, tinted, r);
        albedo = s.albedo;
        gloss = s.gloss;
        if (texOn) {
          let tex = sampleMaterialFast(0, p, 0.65 * max(0.25, r.u1.x));
          albedo = modulateFast(albedo, tex, vec3f(0.4035, 0.1731, 0.0646), 0.82);
        }
      } else if (kind == 6) {
        let r = pickRecipe(1, 1, activeVignette);
        let s = evalCobblestone(p, albedo, r);
        albedo = s.albedo;
        gloss = s.gloss;
        if (texOn) {
          let tex = sampleMaterialFast(15, p, 0.68);
          albedo = modulateFast(albedo, tex, vec3f(0.2950, 0.2326, 0.1649), 0.78);
        }
      } else {
        let r = pickRecipe(4, 5, activeVignette);
        let s = evalGrassSoil(p, albedo, true, r);
        albedo = s.albedo;
        gloss = s.gloss;
      }
    }
    // Textured area rugs in living room, bedroom, and kitchen runner
    if (mat == 0 && o.world.y > 0.131 && o.world.y < 0.156 && o.world.x < 37.5 && texOn) {
      let p = o.world.xz;
      let b = vec4f(22.0, 24.0, 37.0, 35.5);
      if (p.x >= b.x + 1.53 && p.x <= b.x + 4.67 && p.y >= b.w - 4.37 && p.y <= b.w - 0.83) {
        let uv = clamp((p - vec2f(b.x + 1.55, b.w - 4.35)) / vec2f(3.10, 3.50), vec2f(0.015), vec2f(0.985));
        let edgeBevel = smoothstep(0.0, 0.035, min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)));
        let tex = textureSampleLevel(materialTexArray, materialSampler, uv, 12, materialMipLod(0.32));
        albedo = clamp(tex.rgb * 0.90 * mix(0.72, 1.0, edgeBevel), vec3f(0.02), vec3f(0.95));
        gloss = vec2f(0.0);
      } else if (p.x >= b.x + 5.00 && p.x <= b.x + 6.90 && p.y >= b.y + 1.33 && p.y <= b.y + 4.27) {
        let uv = clamp((p - vec2f(b.x + 5.02, b.y + 1.35)) / vec2f(1.86, 2.90), vec2f(0.015), vec2f(0.985));
        let edgeBevel = smoothstep(0.0, 0.035, min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)));
        let tex = textureSampleLevel(materialTexArray, materialSampler, uv, 13, materialMipLod(0.45));
        albedo = clamp(tex.rgb * 0.90 * mix(0.72, 1.0, edgeBevel), vec3f(0.02), vec3f(0.95));
        gloss = vec2f(0.0);
      }
    }
    if (mat == 4 && o.aux > 19.5) {
      if (o.aux > 20.5) {
        let r = pickRecipe(2, 2, activeVignette);
        let s = evalPlasterWall(o.world, n, albedo, r);
        albedo = s.albedo;
        gloss = s.gloss;
        if (texOn) {
          let tex = sampleMaterialFast(2, wallUv, 0.78);
          albedo = modulateFast(albedo, tex, vec3f(0.7567, 0.6302, 0.4162), 0.72);
        }
      } else if (activeVignette) {
        let r = Vig.recipes[6];
        let tinted = scaleBaseTint(albedo, r.u0.xyz, vec3f(0.70, 0.68, 0.62));
        let s = evalClapboardSiding(o.world, tinted, r);
        albedo = s.albedo;
        gloss = s.gloss;
        if (texOn) {
          let tex = sampleMaterialFast(3, wallUv, 0.72 * max(0.25, r.u1.x));
          albedo = modulateFast(albedo, tex, vec3f(0.6159, 0.5723, 0.5086), 0.80);
        }
      } else {
        let row = floor(o.world.y / 0.18);
        let plank = floor((o.world.x + o.world.z + row * 0.43) / 2.2);
        albedo *= 0.95 + (hash2(vec2f(row, plank)) - 0.5) * 0.08;
        albedo *= mix(0.70, 1.0, seam(o.world.y / 0.18, 0.025, 5.55));
        albedo *= 0.97 + grain(vec2f(o.world.x + o.world.z, o.world.y * 3.5), 11.0) * 0.14;
        albedo *= mix(0.84, 1.0, smoothstep(0.13, 0.55, o.world.y));
      }
    }
    if (mat == 4 && interior(o.world.xz + n.xz * 0.3)) {
      let r = pickRecipe(2, 2, activeVignette);
      let baseWall = select(vec3f(0.44, 0.38, 0.31), scaleBaseTint(vec3f(0.44, 0.38, 0.31), r.u0.xyz, vec3f(0.44, 0.40, 0.33)), activeVignette);
      let s = evalPlasterWall(o.world, n, baseWall, r);
      albedo = s.albedo;
      gloss = s.gloss;
      if (texOn) {
        let tex = sampleMaterialFast(2, wallUv, 0.78 * max(0.25, r.u1.x));
        albedo = modulateFast(albedo, tex, vec3f(0.7567, 0.6302, 0.4162), 0.72);
      }
    }
    if (mat == 21) {
      if (activeVignette) {
        let r = Vig.recipes[7];
        let tinted = scaleBaseTint(albedo, r.u0.xyz, vec3f(0.24, 0.28, 0.35));
        let s = evalRoofShingles(o.world, tinted, r);
        albedo = s.albedo;
        gloss = s.gloss;
        if (texOn) {
          let tex = sampleMaterialFast(4, o.world.xz, 0.68 * max(0.25, r.u1.x));
          albedo = modulateFast(albedo, tex, vec3f(0.1056, 0.1172, 0.1297), 0.88);
        }
      } else {
        let row = floor(o.world.z / 0.24);
        let q = vec2f(o.world.x / 0.36 + fract(row * 0.5), o.world.z / 0.24);
        let tabHash = hash2(floor(q)) - 0.5;
        albedo *= 0.97 + tabHash * 0.30 * (1.0 - smoothstep(0.12, 0.5, surfaceFootprint * 4.16));
        albedo *= mix(0.55, 1.0, seam(q.x, 0.018, 2.77) * seam(q.y, 0.035, 4.16));
        albedo *= 1.0 + grain(o.world.xz, 18.0) * 0.14;
      }
    }
    if (mat == 23) {
      let p = vec2f(o.world.x + o.world.z, o.world.y);
      let row = floor(p.y / 0.085);
      let q = vec2f(p.x / 0.25 + fract(row * 0.5), p.y / 0.085);
      albedo = mix(vec3f(0.32, 0.30, 0.26), albedo * (0.8 + 0.35 * hash2(floor(q))), seam(q.x, 0.025, 4.0) * seam(q.y, 0.06, 11.76));
      if (texOn) {
        let tex = sampleMaterialFast(5, p, 0.85);
        albedo = modulateFast(albedo, tex, vec3f(0.3143, 0.1732, 0.1377), 0.80);
      }
    }
    if (mat == 22) {
      let s = evalFoliageCanopy(o.world, n, albedo, defaultMaterialRecipe(5));
      albedo = s.albedo;
      gloss = s.gloss;
      if (texOn) {
        let tex = sampleMaterialFast(9, o.world.xz + vec2f(o.world.y * 0.35), 0.95);
        albedo = modulateFast(albedo, tex, vec3f(0.145, 0.195, 0.082), 0.72);
      }
      if (activeVignette && Vig.params1.y < -0.35 && Vig.params0.w < 0.05) {
        // Noir foliage: deep ink-black silhouette core with crisp moonlit upper-leaf rim
        let fLum = dot(albedo, vec3f(0.2126, 0.7152, 0.0722));
        let leafMicro = surfaceNoise(o.world.xz * 7.8 + vec2f(o.world.y * 3.1, -o.world.y * 2.4));
        let tipRim = smoothstep(0.54, 0.88, leafMicro) * max(0.0, n.y) * smoothstep(0.6, 3.2, o.world.y);
        let coreShadow = smoothstep(0.18, 0.72, leafMicro);
        albedo = mix(vec3f(fLum) * vec3f(0.18, 0.23, 0.30), albedo * 0.22, 0.18) * mix(0.28, 0.95, coreShadow) + vec3f(0.048, 0.062, 0.085) * tipRim;
      }
    }
    if (mat == 24) {
      albedo *= 0.84 + surfaceNoise(vec2f(o.world.x + o.world.z, o.world.y * 0.18) * 28.0) * 0.24;
      if (texOn) {
        let tex = sampleMaterialFast(10, vec2f(o.world.x + o.world.z, o.world.y), 0.9);
        albedo = modulateFast(albedo, tex, vec3f(0.18, 0.13, 0.09), 0.70);
      }
      gloss = vec2f(0.0);
    }
    surfaceTexRatio = clamp(albedo / max(o.color, vec3f(0.02)), vec3f(0.55), vec3f(1.55));
`,
    directional:
      "mix(vec3f(0.46, 0.68, 1.08), vec3f(1.05, 0.76, 0.44), clamp(F.monitorBounds.w + select(0.0, Vig.params1.z * 0.65, useVignetteActive(o.pos)), 0.0, 1.0)) * select(fd.g * 0.35, 1.0, !interior(o.world.xz) || o.world.y > 2.8) * F.ambient.w * select(1.0, Vig.params2.w, useVignetteActive(o.pos)) * max(0.0, dot(n, F.monitorBounds.xyz))",
    cutaway: `
      if (i32(round(o.mat)) == 21 && roofCut(o.world, i32(round(o.aux)))) { discard; }
      if (o.world.y > 2.8 && interior(o.world.xz)) {
        for (var i = 0; i < 4; i++) { if (roofCut(o.world, i)) { discard; } }
      }
    `,
    solidCutaway: "",
    surface: /* wgsl */ `
  let visible = eyeVisible(o.world.xz + n.xz * 0.06);
  let explored = textureSampleLevel(exploredTex, floorSamp, o.world.xz * F.map.xy, 0.0).r;
  let activeVig = useVignetteActive(o.pos);
  let isNoir = activeVig && Vig.params1.y < -0.35 && Vig.params0.w < 0.05;
  if (mat == 2) {
    col *= 0.88;
    if (isNoir) {
      // South facade windows: left window is unlit cold glass; right window has a soft centered amber glow.
      if (o.world.z > 35.1 && o.world.y < 2.2) {
        if (o.world.x < 26.5) {
          col = vec3f(0.012, 0.018, 0.026);
        } else if (o.world.x > 31.5) {
          let wDist = length(vec2f((o.world.x - 34.25) * 0.9, (o.world.y - 1.50) * 1.3));
          let wFall = exp(-wDist * wDist * 2.4);
          col = select(vec3f(0.32, 0.25, 0.16) * wFall + vec3f(0.015, 0.02, 0.028), col * 0.04, Vig.params2.y < 35.0);
        }
      } else if (o.world.z < 35.0) {
        // Bedroom nightstand shade is cool silvery-blue; unlit SW sofa shade is dark.
        if (o.world.x < 27.0 && o.world.z < 28.0) {
          col = vec3f(0.55, 0.72, 0.95) * 0.85;
        } else if (o.world.x < 26.0 && o.world.z > 30.0) {
          col = vec3f(0.015, 0.016, 0.02);
        } else {
          col *= 0.55;
        }
      } else {
        // Porch sconce diffuser
        col *= 0.45;
      }
    }
  }
  if (mat == 4 && !interior(o.world.xz + n.xz * 0.3)) { col *= mix(1.0, 0.52, smoothstep(2.15, 2.78, o.world.y)); }
  if (mat == 20 && i32(round(o.aux)) == 1) {
    let crown = 1.0 - abs(clamp((o.world.z - 40.0) / 8.0, 0.0, 1.0) * 2.0 - 1.0) * 0.35;
    col += vec3f(0.018, 0.026, 0.052) * F.ambient.w * crown * (0.88 + 0.24 * surfaceNoise(o.world.xz * 0.35));
  }
  if (mat == 20 && i32(round(o.aux)) == 2) {
    col += vec3f(0.012, 0.018, 0.036) * F.ambient.w;
  }
  if (mat == 21) {
    let eave = smoothstep(2.88, 3.55, o.world.y);
    col = col * mix(0.62, 1.08, eave) + vec3f(0.005, 0.010, 0.022) * F.ambient.w * eave * max(0.0, n.y);
  }
  // Direction 2 (Painterly): rich gouache twilight, saturated lush greens, warm honey interiors, peach highlights vs periwinkle shadows
  if (activeVig && Vig.params0.w > 0.05) {
    let wAmt = Vig.params0.w;
    let fbm1 = surfaceFbm(o.world.xz * 1.35 + vec2f(o.world.y * 0.8, 2.3));
    let fbm2 = surfaceNoise(o.world.xz * 4.2 + vec2f(5.1, 1.7));
    let brush = 0.74 + 0.52 * (fbm1 * 0.65 + fbm2 * 0.35);
    let isInteriorView = Vig.params2.y < 35.0;
    let extScale = select(1.0, 0.36, isInteriorView);
    let texMod = mix(vec3f(1.0), surfaceTexRatio, 0.55);
    if (mat == 2) {
      // Rich warm golden-amber window panes & glowing lamp shades
      col = vec3f(1.25, 0.72, 0.20) * (0.88 + 0.28 * fbm1);
    } else if (interior(o.world.xz) && o.world.y < 2.76) {
      let dBed = exp(-(pow((o.world.x - 24.6) * 0.42, 2.0) + pow((o.world.z - 25.8) * 0.42, 2.0)));
      let dSofa = exp(-(pow((o.world.x - 23.8) * 0.38, 2.0) + pow((o.world.z - 33.6) * 0.38, 2.0)));
      let dHall = exp(-(pow((o.world.x - 28.0) * 0.34, 2.0) + pow((o.world.z - 32.2) * 0.34, 2.0)));
      let dDin = exp(-(pow((o.world.x - 33.6) * 0.38, 2.0) + pow((o.world.z - 32.4) * 0.38, 2.0)));
      let dNorthTab = exp(-(pow((o.world.x - 32.5) * 0.48, 2.0) + pow((o.world.z - 27.4) * 0.48, 2.0)));
      let dEastWin = exp(-pow((o.world.x - 36.6) * 0.60, 2.0)) * (exp(-pow((o.world.z - 28.8) * 0.48, 2.0)) + exp(-pow((o.world.z - 32.8) * 0.48, 2.0)));
      let lampPools = clamp(dBed * 1.15 + dSofa * 1.05 + dHall * 0.85 + dDin * 1.15 + dNorthTab * 0.90 + dEastWin * 0.55, 0.0, 1.45);
      // Sage-green lower wainscot band on interior walls (y < 0.92), warm parchment-periwinkle upper plaster
      if (mat == 4 && abs(n.y) < 0.4) {
        let wainscot = 1.0 - smoothstep(0.82, 0.98, o.world.y);
        let wallShadow = mix(vec3f(0.18, 0.155, 0.145), vec3f(0.082, 0.105, 0.078), wainscot);
        let lampWall = vec3f(0.24, 0.135, 0.035) * lampPools;
        col = col * 0.20 + (wallShadow + lampWall) * texMod * brush * (0.75 + 0.25 * smoothstep(0.2, 2.4, o.world.y));
      } else if (mat == 20 || (o.world.y > 0.13 && o.world.y < 0.16)) {
        // Rich reddish-chestnut gouache floorboards with dark plank joints & shadowed corners, lifting in lamp pools
        let row = floor(o.world.z / 0.22);
        let plank = floor((o.world.x + fract(row * 0.41) * 1.8) / 1.6);
        let boardVar = 0.68 + 0.60 * hash2(vec2f(row, plank));
        let seamLong = smoothstep(0.0, 0.09, abs(fract(o.world.z / 0.22) - 0.5));
        let seamButt = smoothstep(0.0, 0.05, abs(fract((o.world.x + fract(row * 0.41) * 1.8) / 1.6) - 0.5));
        let inKitchen = smoothstep(29.8, 26.2, o.world.z) * smoothstep(27.5, 31.8, o.world.x);
        let floorBase = mix(vec3f(0.082, 0.044, 0.026), vec3f(0.042, 0.030, 0.024), inKitchen * 0.85);
        let warmLift = vec3f(0.145, 0.072, 0.022) * lampPools;
        col = (floorBase * boardVar + warmLift) * texMod * brush * (0.52 + 0.48 * seamLong * seamButt);
      } else {
        // Furniture: muted sage-teal bed blankets & kitchen cabinets, warm walnut tables/chairs
        let isBedOrCounter = (o.world.x < 25.4 && o.world.y > 0.40 && o.world.y < 0.72) || (o.world.x > 31.0 && o.world.z < 29.8 && o.world.y < 0.92);
        let furnBase = select(o.color * vec3f(0.20, 0.12, 0.068), vec3f(0.055, 0.088, 0.078), isBedOrCounter);
        col = col * 0.16 + (furnBase + vec3f(0.105, 0.058, 0.018) * lampPools) * brush;
      }
      // Darken cutaway wall-top border to slate-periwinkle
      if (o.world.y > 2.73 && n.y > 0.75) {
        col = vec3f(0.042, 0.052, 0.092);
      }
    } else {
      // Exterior gouache twilight: periwinkle-lavender road & roof, muted sage-olive turf/trees, golden-peach porch/window pools
      let edgeVignette = clamp(1.0 - pow(abs(o.world.x - 29.5) / 22.0, 1.8) * 0.34, 0.58, 1.06);
      let winGlowL = exp(-pow((o.world.x - 24.5) * 0.34, 2.0)) * exp(-pow((o.world.z - 36.4) * 0.36, 2.0));
      let winGlowR = exp(-pow((o.world.x - 34.2) * 0.34, 2.0)) * exp(-pow((o.world.z - 36.4) * 0.36, 2.0));
      let porchGlow = exp(-pow((o.world.x - 27.7) * 0.25, 2.0)) * exp(-pow((o.world.z - 37.8) * 0.26, 2.0));
      let warmLawn = clamp(winGlowL + winGlowR + porchGlow * 1.35, 0.0, 1.35);
      if (mat == 20) {
        let kind = i32(round(o.aux));
        if (kind == 1) {
          // Street asphalt: dappled periwinkle-lavender gouache wash with warm peach-gold porch spill
          let warmPool = exp(-pow((o.world.x - 28.0) * 0.15, 2.0)) * exp(-pow((o.world.z - 41.0) * 0.22, 2.0));
          let roadBase = mix(vec3f(0.098, 0.112, 0.195), vec3f(0.26, 0.185, 0.125), warmPool * 0.90);
          col = col * 0.12 + roadBase * texMod * brush * edgeVignette * extScale;
        } else if (kind == 2 || kind == 6) {
          // Sidewalk & front stone path: warm cream-lavender with rich golden-peach porch spill
          let walkGlow = exp(-pow((o.world.x - 27.7) * 0.26, 2.0)) * smoothstep(43.2, 35.5, o.world.z);
          let slabJoint = smoothstep(0.0, 0.06, min(abs(fract(o.world.x / 1.4) - 0.5), abs(fract(o.world.z / 1.2) - 0.5)));
          let walkBase = mix(vec3f(0.138, 0.148, 0.198), vec3f(0.46, 0.29, 0.11), walkGlow * 0.95);
          col = col * 0.14 + walkBase * texMod * brush * (0.82 + 0.18 * slabJoint) * edgeVignette * extScale;
        } else {
          // Lawn & verge: cool twilight olive-slate in side yards & south verge, lifting to warm golden-chartreuse in window/porch pools
          let yardCenter = exp(-pow((o.world.x - 29.5) * 0.11, 2.0)) * smoothstep(46.0, 36.0, o.world.z);
          let shadowGrass = mix(vec3f(0.045, 0.064, 0.068), vec3f(0.082, 0.122, 0.076), yardCenter);
          let grassBase = mix(shadowGrass, vec3f(0.35, 0.26, 0.075), warmLawn * 0.90);
          col = col * 0.08 + grassBase * texMod * brush * edgeVignette * extScale;
        }
      } else if (mat == 21) {
        // Roof shingles: hand-painted slate-periwinkle tiles with course & tab seams
        let row = floor(o.world.z / 0.28);
        let q = vec2f(o.world.x / 0.44 + fract(row * 0.5), o.world.z / 0.28);
        let tileVar = 0.78 + 0.44 * hash2(floor(q));
        let tileSeam = smoothstep(0.0, 0.08, abs(fract(q.x) - 0.5)) * smoothstep(0.0, 0.11, abs(fract(q.y) - 0.5));
        col = col * 0.10 + vec3f(0.056, 0.068, 0.125) * tileVar * (0.72 + 0.28 * tileSeam) * texMod * brush * edgeVignette * extScale;
      } else if (mat == 22) {
        // Tree & shrub foliage: deep twilight olive-sage in inner boughs, soft sage lobes on top, golden shrubs by windows
        let crownLift = clamp(smoothstep(0.2, 3.8, o.world.y) * 0.36 + max(0.0, n.y) * 0.40, 0.0, 1.0);
        let leafTone = mix(vec3f(0.020, 0.036, 0.034), vec3f(0.062, 0.095, 0.062), crownLift);
        let warmShrub = vec3f(0.24, 0.18, 0.048) * warmLawn * smoothstep(2.2, 0.2, o.world.y);
        col = col * 0.06 + (leafTone + warmShrub) * texMod * brush * edgeVignette * extScale;
      } else if (mat == 4) {
        // Exterior clapboard walls & porch columns: warm cream-peach near windows/porch, soft lavender at corners
        let wallWarm = mix(vec3f(0.14, 0.145, 0.19), vec3f(0.36, 0.24, 0.105), warmLawn * 0.85);
        col = col * 0.18 + o.color * wallWarm * texMod * brush * extScale;
      } else {
        col = col * 0.20 + o.color * vec3f(0.13, 0.14, 0.19) * brush * extScale;
      }
    }
    col = mix(o.color, col, wAmt);
  }
  // Direction 4 (Cozy golden-hour): warm slanting window sun-shaft pools on living room & kitchen floor
  if (activeVig && Vig.params1.w > 0.25 && interior(o.world.xz) && o.world.y < 0.22) {
    let p = o.world.xz;
    let southWin1 = smoothstep(1.2, 0.1, abs(p.x - 24.6)) * smoothstep(35.3, 33.6, p.y) * smoothstep(31.2, 33.2, p.y);
    let southWin2 = smoothstep(1.3, 0.1, abs(p.x - 34.2)) * smoothstep(35.3, 33.6, p.y) * smoothstep(31.2, 33.2, p.y);
    let eastWin = smoothstep(1.4, 0.1, abs(p.y - 29.4)) * smoothstep(36.8, 34.8, p.x) * smoothstep(32.5, 34.6, p.x);
    let shaft = max(max(southWin1, southWin2), eastWin) * Vig.params1.w;
    col += o.color * vec3f(0.55, 0.34, 0.12) * shaft;
  }
  if (isNoir) {
    // Darken cutaway wall-top molding (y = 2.76..2.81) so interior walls don't have a bright white outline
    if (o.world.y > 2.74 && o.world.y < 2.83 && n.y > 0.75 && o.world.x > 21.8 && o.world.x < 37.2 && o.world.z > 23.8 && o.world.z < 35.8) {
      col *= 0.08;
    }
    // Roof shingles catching cold directional moonlight along course steps & gable chevron (street view)
    if (mat == 21 && Vig.params2.y > 35.0) {
      let courseStep = smoothstep(0.68, 0.96, fract(o.world.z / 0.23));
      let tabGrain = 0.65 + 0.70 * surfaceNoise(o.world.xz * 6.5);
      let eaveGlow = smoothstep(35.45, 35.88, o.world.z) * smoothstep(36.05, 35.85, o.world.z) * 0.28;
      let gableMask = smoothstep(25.8, 26.5, o.world.x) * smoothstep(29.6, 28.9, o.world.x);
      let gableChevron = smoothstep(36.6, 37.08, o.world.z) * step(2.38, o.world.y) * gableMask;
      col = col * (0.76 + 0.32 * tabGrain) + vec3f(0.009, 0.014, 0.021) * courseStep * tabGrain + vec3f(0.030, 0.040, 0.054) * max(eaveGlow, gableChevron * 0.95);
    }
    // Fine textured detail in darks: gravel ruts, asphalt aggregate, and grass/verge blade micro-contrast + front lawn window spill
    if (mat == 20 && !interior(o.world.xz)) {
      let p = o.world.xz;
      let kind = i32(round(o.aux));
      let fineGrit = surfaceNoise(p * 6.8) * 0.6 + surfaceNoise(p * 15.0) * 0.4;
      if (kind == 1) {
        let crackLine = 1.0 - smoothstep(0.0, 0.022, abs(surfaceNoise(p * 0.95 + vec2f(2.4, 5.1)) - 0.5));
        col = col * (0.62 + 0.76 * fineGrit) * (1.0 - crackLine * 0.48);
      } else if (kind == 0) {
        let tuft = smoothstep(0.28, 0.78, fineGrit);
        let sideTreeShadow = smoothstep(17.5, 22.5, p.x) * smoothstep(40.5, 36.5, p.x);
        let frontLawnSpill = (exp(-pow((p.x - 24.5) * 0.38, 2.0)) + exp(-pow((p.x - 34.2) * 0.38, 2.0))) * exp(-pow((p.y - 37.2) * 0.45, 2.0));
        col = col * mix(0.48, 1.38, tuft) * mix(0.52, 1.0, sideTreeShadow) + vec3f(0.018, 0.022, 0.026) * frontLawnSpill * tuft * select(1.0, 0.35, Vig.params2.y < 35.0);
      }
    }
    // Weathered dark slate-grey porch trim, columns, and clapboard courses on south facade
    if ((mat == 4 || mat == 21) && o.world.z > 35.15 && !interior(o.world.xz)) {
      let trimLum = dot(col, vec3f(0.2126, 0.7152, 0.0722));
      let courseLap = mix(0.62, 1.12, smoothstep(0.0, 0.25, fract(o.world.y / 0.165)));
      if (trimLum > 0.028) {
        col = mix(vec3f(trimLum) * vec3f(0.22, 0.26, 0.32), col * 0.26, 0.20) * courseLap;
      }
    }
    // Desaturate bright rugs & bedding in Noir and balance interior rooms
    if (interior(o.world.xz) && o.world.y < 2.65) {
      let inLum = dot(col, vec3f(0.2126, 0.7152, 0.0722));
      col = mix(vec3f(inLum) * vec3f(0.92, 0.95, 1.02), col, 0.35);
      // Subdue white fridge/counter/stove tops & runner mat border along the partition
      if (o.world.x > 30.8 && o.world.x < 35.8 && o.world.z > 29.55 && o.world.z < 31.30) {
        if (o.world.y > 0.85 || (o.world.y > 0.131 && o.world.y < 0.148)) {
          col *= 0.24;
        }
      }
      let plasterTex = 0.72 + 0.56 * surfaceFbm(vec2f(o.world.x + o.world.z, o.world.y) * 2.8);
      // Cool silvery-blue wall-wash on the north bedroom wall behind the nightstand lamp
      if (abs(n.y) < 0.35 && o.world.x > 22.2 && o.world.x < 27.6 && o.world.z < 26.2 && o.world.y > 0.45 && o.world.y < 2.65) {
        let bx = exp(-pow((o.world.x - 24.65) * 0.62, 2.0));
        let by = exp(-pow((o.world.y - 1.55) * 1.15, 2.0));
        col += vec3f(0.095, 0.135, 0.185) * bx * by * plasterTex;
      }
      // Warm amber wall-wash on the vertical south-east dining partition wall above the console table
      if (abs(n.y) < 0.35 && o.world.x > 29.2 && o.world.x < 36.2 && o.world.z > 29.40 && o.world.z < 30.25 && o.world.y > 0.55 && o.world.y < 2.55) {
        let wx = exp(-pow((o.world.x - 33.45) * 0.58, 2.0));
        let wy = exp(-pow((o.world.y - 1.48) * 1.15, 2.0));
        col += vec3f(0.24, 0.135, 0.052) * wx * wy * plasterTex;
      }
      // Textured dark wood-plank & plaster fill in the north-east room & central hallway threshold
      if (o.world.z < 29.6 && o.world.x > 28.5) {
        let neTex = 0.55 + 0.90 * surfaceFbm(o.world.xz * 2.4);
        col = col * 0.85 + vec3f(0.007, 0.009, 0.012) * neTex * (0.6 + 0.4 * max(0.0, n.y));
      }
      // Hallway & living-room floorboard bounce around the survivor
      if (o.world.y < 0.22 && o.world.x > 25.8 && o.world.x < 32.2 && o.world.z > 28.8 && o.world.z < 35.3) {
        let hallCarry = exp(-pow((o.world.x - 28.1) * 0.58, 2.0)) * exp(-pow((o.world.z - 31.6) * 0.42, 2.0));
        let plankVar = 0.65 + 0.70 * surfaceNoise(vec2f(o.world.x * 1.4, o.world.z * 9.5));
        let seamDark = smoothstep(0.0, 0.08, abs(fract(o.world.z / 0.18) - 0.5));
        col += vec3f(0.046, 0.050, 0.056) * hallCarry * plankVar * seamDark;
      }
    }
    // East window icy moonlight spill on window reveals & kitchen counter/floor
    if (o.world.x > 33.8 && o.world.x < 37.2 && o.world.z > 26.8 && o.world.z < 35.0) {
      let winX = smoothstep(33.8, 36.85, o.world.x);
      let winZ1 = exp(-pow((o.world.z - 28.8) * 0.78, 2.0));
      let winZ2 = exp(-pow((o.world.z - 32.8) * 0.78, 2.0));
      let moonShaft = winX * max(winZ1, winZ2) * smoothstep(2.45, 0.05, o.world.y);
      col += vec3f(0.075, 0.105, 0.155) * moonShaft;
    }
    // Wider wet porch & walkway reflection pool under the porch light
    if (mat == 20 && o.world.x > 25.0 && o.world.x < 30.4 && o.world.z > 35.4 && o.world.z < 40.2) {
      let cx = exp(-pow((o.world.x - 27.7) * 1.45, 2.0));
      let cz = smoothstep(40.2, 35.5, o.world.z);
      let pWet = 0.55 + 0.90 * surfaceFbm(o.world.xz * 4.5);
      col = col * mix(0.55, 0.95, cx) + vec3f(0.20, 0.19, 0.17) * cx * cz * pWet * select(1.0, 0.28, Vig.params2.y < 35.0);
    }
  }
  // Direction 3 (Noir): volumetric flashlight cone haze + soft outer aura + hot hand core & textured ground beam
  if (activeVig && Vig.params4.w > 0.5) {
    let fSlot = u32(round(Vig.params4.w));
    let fOrig = Vig.params3.xy;
    let fDir = Vig.params3.zw;
    let fSide = vec2f(-fDir.y, fDir.x);
    let rel = o.world.xz - fOrig;
    let along = dot(rel, fDir);
    let across = abs(dot(rel, fSide));
    let tanHalf = max(0.10, Vig.params4.x);
    let fRange = max(3.5, Vig.params4.y);
    let hazeAmt = Vig.params4.z;
    let fLightCol = lights[fSlot].color.rgb;
    let fPower = lights[fSlot].color.w;
    let inHouse = interior(o.world.xz);
    if (along > -0.15 && along < fRange) {
      let coneR = 0.09 + max(0.0, along) * tanHalf * select(1.0, 1.04, inHouse);
      let radialCore = exp(-pow(across / (coneR * select(0.52, 0.50, inHouse)), 2.0));
      let radialAura = exp(-pow(across / (coneR * 0.92), 1.5)) * (1.0 - smoothstep(coneR * 0.75, coneR * 1.38, across));
      let radialEdge = 1.0 - smoothstep(coneR * 0.58, coneR * 1.12, across);
      let axialIn = smoothstep(-0.06, 0.14, along);
      let axialOut = pow(clamp(1.0 - along / fRange, 0.0, 1.0), select(1.55, 1.42, inHouse));
      let vis = shadowAt(fSlot, fOrig, lights[fSlot].pos.y, 0.045, o.world.xz, min(o.world.y, 0.95));
      let grit = 0.55 + 0.90 * (surfaceNoise(o.world.xz * 4.5 + vec2f(1.7, 3.9)) * 0.6 + surfaceNoise(o.world.xz * 11.2) * 0.4);
      let mist = (radialCore * radialEdge * 0.72 + radialAura * 0.36) * axialIn * axialOut / (0.45 + max(0.0, along) * 0.24) * vis * (0.82 + 0.36 * surfaceNoise(o.world.xz * 2.1));
      col += fLightCol * fPower * mist * hazeAmt * select(0.22, 0.24, inHouse);
      if (o.world.y < 0.38) {
        let groundSpot = radialCore * radialEdge * axialIn * axialOut / (0.28 + max(0.0, along) * 0.16 + along * along * 0.022) * vis * grit;
        col += (o.color * select(1.55, 2.05, inHouse) + vec3f(0.062, 0.070, 0.078)) * fLightCol * fPower * groundSpot * select(1.22, 1.65, inHouse);
      }
    }
    // Small close hand/lantern ground spill right at the survivor's feet
    let pRel = o.world.xz - (Vig.params2.xy + vec2f(-0.22, -0.35));
    let pDist = length(pRel);
    if (pDist < 1.55 && o.world.y < 0.35) {
      let nearGlow = exp(-pDist * pDist * 2.2) * (1.0 - smoothstep(0.5, 1.55, pDist));
      col += (o.color * 1.35 + vec3f(0.055, 0.06, 0.065)) * fLightCol * fPower * nearGlow * select(0.36, 0.48, inHouse);
    }
  }
  if (mat != 12 && mat != 21 && mat != 2 && !(activeVig && Vig.params0.w > 0.05)) {
    let luminance = dot(col, vec3f(0.2126, 0.7152, 0.0722));
    let peripheral = mix(vec3f(luminance) * vec3f(0.83, 0.94, 1.05), col, 0.72);
    if (interior(o.world.xz) && o.world.y < 2.8) {
      let room = mix(vec3f(luminance) * vec3f(0.90, 0.96, 1.0), col, 0.88 + 0.12 * visible);
      col = mix(o.color * 0.008, room * mix(F.effects.w, 1.0, 0.82), explored);
    } else {
      col = mix(peripheral * (0.86 + 0.14 * explored), col, 0.86 + 0.14 * visible);
    }
  }
  // Crisp split-screen divider when compareMode == 2 (Split A/B vs Shipped)
  if (i32(round(Vig.params0.x)) == 2) {
    let splitPx = Vig.params0.y * F.screen.x;
    if (abs(o.pos.x - splitPx) < 1.25) {
      col = mix(col, vec3f(0.95, 0.78, 0.42), 0.85);
    }
  }
`,
}

/** Vignette WGSL shaders: uses the production Outbreak scene, lookScene, post, and lookPost pipelines. */
export const vignetteShaders = {
  sprite: spriteShader(),
  post: postShader(false, false, outbreakPostFinish),
  scene: makeSceneShader(vignetteSceneHooks),
  lookScene: makeLookSceneShader(vignetteSceneHooks),
  lookPost: makeLookPostShader(outbreakPostFinish),
}

function computeGroundRectFromVP(viewProj: Float32Array, top = 5.5): [number, number, number, number] {
  const inv = mat4.inverse(viewProj)
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const nx of [-1, 1]) {
    for (const ny of [-1, 1]) {
      const a = vec4.transformMat4([nx, ny, 0, 1], inv)
      const b = vec4.transformMat4([nx, ny, 1, 1], inv)
      for (const h of [0, top]) {
        const ay = a[1]! / (a[3]! || 1e-6)
        const by = b[1]! / (b[3]! || 1e-6)
        const t = (h - ay) / (by - ay || 1e-6)
        const x = a[0]! / (a[3]! || 1e-6) + (b[0]! / (b[3]! || 1e-6) - a[0]! / (a[3]! || 1e-6)) * t
        const z = a[2]! / (a[3]! || 1e-6) + (b[2]! / (b[3]! || 1e-6) - a[2]! / (a[3]! || 1e-6)) * t
        x0 = Math.min(x0, x)
        x1 = Math.max(x1, x)
        y0 = Math.min(y0, z)
        y1 = Math.max(y1, z)
      }
    }
  }
  if (!Number.isFinite(x0) || !Number.isFinite(y0)) return [0, 0, SIZE, SIZE]
  return [Math.max(0, x0 - 4), Math.max(0, y0 - 4), Math.min(SIZE, x1 + 4), Math.min(SIZE, y1 + 4)]
}

export const outbreakVignetteSection: SectionFactory = context => {
  const { stage, device } = context

  // Initialize surface recipes from Direction 3 (Noir, primary preset) over surface defaults
  const surfaceState: Record<VignetteSurfaceId, MaterialRecipeParams> = {
    wood_floor: { ...VIGNETTE_SURFACES.wood_floor.defaults },
    plaster: { ...VIGNETTE_SURFACES.plaster.defaults },
    siding: { ...VIGNETTE_SURFACES.siding.defaults },
    shingles: { ...VIGNETTE_SURFACES.shingles.defaults },
    asphalt: { ...VIGNETTE_SURFACES.asphalt.defaults },
    concrete: { ...VIGNETTE_SURFACES.concrete.defaults },
    grass: { ...VIGNETTE_SURFACES.grass.defaults },
  }

  const primaryDir = VIGNETTE_DIRECTIONS[3]
  for (const id of VIGNETTE_SURFACE_IDS) {
    const patch = primaryDir.surfaces[id]
    if (patch) Object.assign(surfaceState[id], patch)
  }

  const lookSettings: LookSettings = createLookSettings(primaryDir.lookPreset)
  if (primaryDir.lookOverrides) Object.assign(lookSettings, primaryDir.lookOverrides)
  const flashlightState: FlashlightState = createFlashlightState(primaryDir.values.flashlightOn)

  const flatSurfaceSettings: Record<string, number> = {}
  for (const id of VIGNETTE_SURFACE_IDS) {
    for (const spec of MATERIAL_PARAM_SPECS) {
      flatSurfaceSettings[surfaceParamKey(id, spec.key)] = surfaceState[id][spec.key]
    }
  }

  /**
   * Typed Lab settings for the Outbreak vignette.
   * Update boundaries (per docs/lab.md):
   * - `uniform`: live uniform/light buffer update; does not rebuild static level geometry.
   * - `structural`: rebuilds single-lot static mesh (`houseSeed`, `clutterDensity`, `foliageDensity`, `treeSlot`) while preserving camera/lights/recipes.
   */
  const s: LabSettings &
    FlashlightTuning & {
      directionPreset: VignetteDirectionId
      cameraPreset: VignetteCameraPreset
      cutawayMode: 0 | 1 | 2
      compareMode: 0 | 1 | 2
      compareSplit: number
      diagnostic: number
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
      flashlightAim: number
      flashlightHaze: number
      activeSurface: VignetteSurfaceId
      tuningSeed: number
      baseR: number
      baseG: number
      baseB: number
      roughness: number
      scale: number
      elementRatio: number
      irregularity: number
      grainScale: number
      colorVariation: number
      jointWidth: number
      wear: number
      macroVariation: number
      clutterDensity: number
      foliageDensity: number
      overgrowth: number
      treeSlot: number
      houseSeed: number
      playing: boolean
    } = {
    directionPreset: 3,
    cameraPreset: "game",
    cutawayMode: 1,
    compareMode: 0,
    compareSplit: 0.5,
    diagnostic: 0,
    ...DEFAULT_FLASHLIGHT_TUNING,
    ...lookSettings,
    ...primaryDir.values,
    activeSurface: "asphalt",
    tuningSeed: 101,
    ...surfaceState.asphalt,
    ...flatSurfaceSettings,
    treeSlot: 1,
    houseSeed: 7,
    playing: true,
  }

  let renderer: Renderer | null = null
  let avatar: Survivor | null = null
  let doorModel = -1
  const doorData = new Float32Array(4 * 12)
  const doorBatch: Batch = { model: 0, data: doorData, count: 0 }
  const frame = new Float32Array(FRAME_FLOATS)
  const lights = new Float32Array(MAX_LIGHTS * LIGHT_FLOATS)
  const occluders = new Float32Array(MAX_OCCLUDERS * OCC_FLOATS)
  const lampPower = new Float32Array(MAX_LIGHTS)
  const empty = new Float32Array(0)
  const vignetteUniforms = new Float32Array(128)
  const cam = new Camera()
  const vision = new Vision()
  const scenery = new SceneryMemory()

  let town = makeVignetteTown({
    seed: 7,
    houseSeed: s.houseSeed,
    foliageDensity: s.foliageDensity,
    clutterDensity: s.clutterDensity,
    treeSlot: s.treeSlot,
  })
  let blockers = sightRects(town)
  let lightOccluders = 0
  let staticVertices = 0
  let simTime = 0
  const player = { x: 27.7, y: 38.6, vx: 0, vy: 0, aim: -Math.PI / 2 }

  function ensureRenderer() {
    if (renderer) return renderer
    const format = navigator.gpu.getPreferredCanvasFormat()
    const dummyCanvas = document.createElement("canvas")
    dummyCanvas.width = 16
    dummyCanvas.height = 16
    const dummyCtx = dummyCanvas.getContext("webgpu")!
    dummyCtx.configure({ device, format, alphaMode: "opaque" })
    renderer = new Renderer(device, dummyCtx, format, vignetteShaders)
    avatar = new Survivor(renderer)
    const doorMesh = new Mesh()
    doorMesh.box(0, 0.13, -0.1, 1.4, 2.3, 0.1, hex(0x463322), MAT.timber)
    doorMesh.box(0.08, 0.35, -0.11, 1.32, 2.1, -0.105, hex(0x57402b), MAT.timber)
    doorMesh.box(1.14, 1.08, 0.1, 1.25, 1.19, 0.18, hex(0xc9a96a), MAT.shiny)
    for (const dx of [0.15, 0.75]) {
      for (const dy of [0.42, 1.36]) {
        doorMesh.box(dx, dy, 0.101, dx + 0.48, dy + 0.70, 0.125, hex(0x5b432d), MAT.timber)
        doorMesh.box(dx + 0.035, dy + 0.04, 0.126, dx + 0.445, dy + 0.66, 0.132, hex(0x3a2a1c), MAT.timber)
      }
    }
    doorModel = renderer.addModel(doorMesh)
    doorBatch.model = doorModel
    rebuildVignetteLevel()
    return renderer
  }

  function rebuildOccluders() {
    blockers = sightRects(town)
    occluders.fill(0)
    blockers.forEach((r, i) => occluders.set([...r, 2.8, 0, 0, 0], i * OCC_FLOATS))
    lightOccluders = blockers.length
    for (const b of town.barriers) {
      if (b.kind === "window") occluders.set([...b.rect, 0.85, 0, 0, 0], lightOccluders++ * OCC_FLOATS)
    }
    for (const p of town.props) {
      const sh = propShape(p)
      if (sh) occluders.set([...sh.rect, sh.height, 0, 0, 0], lightOccluders++ * OCC_FLOATS)
    }
  }

  function rebuildVignetteLevel() {
    town = makeVignetteTown({
      seed: 7,
      houseSeed: s.houseSeed,
      foliageDensity: s.foliageDensity,
      clutterDensity: s.clutterDensity,
      treeSlot: s.treeSlot,
    })
    rebuildOccluders()
    if (!renderer) return
    const data = buildVignetteLevel(town)
    staticVertices = [...data.chunks, ...data.glass].reduce((n, c) => n + c.data.byteLength / VERT_BYTES, 0)
    renderer.setLevel(data)
    // Mark the vignette house interior explored so cutaway living room + kitchen is always readable
    scenery.mask.fill(255)
    renderer.setVisibility(scenery.mask, FOG_SIZE, FOG_SIZE)
  }

  function syncActiveSurfaceToFlat(id: VignetteSurfaceId) {
    const rec = surfaceState[id]
    for (const spec of MATERIAL_PARAM_SPECS) {
      s[surfaceParamKey(id, spec.key)] = rec[spec.key]
      if (s.activeSurface === id) {
        s[spec.key] = rec[spec.key]
      }
    }
  }

  function loadActiveSurfaceSliders(id: VignetteSurfaceId) {
    s.activeSurface = id
    const rec = surfaceState[id]
    for (const spec of MATERIAL_PARAM_SPECS) {
      s[spec.key] = rec[spec.key]
    }
  }

  function pullFlatIntoSurfaceState() {
    for (const id of VIGNETTE_SURFACE_IDS) {
      for (const spec of MATERIAL_PARAM_SPECS) {
        const k = surfaceParamKey(id, spec.key)
        const v = Number(s[k])
        if (Number.isFinite(v)) surfaceState[id][spec.key] = v
      }
    }
    if (isVignetteSurfaceId(s.activeSurface)) {
      const activeRec = surfaceState[s.activeSurface]
      for (const spec of MATERIAL_PARAM_SPECS) {
        const v = Number(s[spec.key])
        if (Number.isFinite(v)) {
          activeRec[spec.key] = v
          s[surfaceParamKey(s.activeSurface, spec.key)] = v
        }
      }
    }
  }

  function syncLookSettingsFromState() {
    for (const spec of LOOK_PARAM_SPECS) {
      const val = s[spec.key]
      if (spec.key === "grainAnimated" && typeof val === "boolean") {
        lookSettings.grainAnimated = val
      } else if (spec.key !== "grainAnimated" && typeof val === "number" && Number.isFinite(val)) {
        lookSettings[spec.key] = val
      }
    }
  }

  function applyDirectionPreset(dirId: VignetteDirectionId) {
    const spec = VIGNETTE_DIRECTIONS[dirId] ?? VIGNETTE_DIRECTIONS[3]
    const prevClutter = s.clutterDensity
    const prevFoliage = s.foliageDensity
    s.directionPreset = spec.id
    applyLookPreset(lookSettings, spec.lookPreset)
    if (spec.lookOverrides) Object.assign(lookSettings, spec.lookOverrides)
    for (const lSpec of LOOK_PARAM_SPECS) {
      ;(s as LabSettings)[lSpec.key] = lookSettings[lSpec.key]
    }
    Object.assign(s, spec.values)
    flashlightState.flashlightOn = s.flashlightOn
    flashlightState.battery = 1
    flashlightState.batteryDepleted = false
    flashlightState.flashlightOutput = s.flashlightOn ? 1 : 0

    for (const id of VIGNETTE_SURFACE_IDS) {
      surfaceState[id] = { ...VIGNETTE_SURFACES[id].defaults, ...(spec.surfaces[id] ?? {}) }
      syncActiveSurfaceToFlat(id)
    }
    loadActiveSurfaceSliders(s.activeSurface)

    if (prevClutter !== s.clutterDensity || prevFoliage !== s.foliageDensity) {
      rebuildVignetteLevel()
    }
    externalLookHook?.({
      directionPreset: spec.id,
      directionSlug: spec.slug,
      settings: s,
    })
  }

  function applyCameraPreset(preset: VignetteCameraPreset, overrideCutaway?: 0 | 1 | 2) {
    const cfg = VIGNETTE_CAMERA_PRESETS[preset] ?? VIGNETTE_CAMERA_PRESETS.game
    s.cameraPreset = preset
    s.cutawayMode = overrideCutaway ?? cfg.cutawayMode
    player.x = cfg.playerPos[0]
    player.y = cfg.playerPos[1]
    player.aim = cfg.playerPos[2]
    stage.focus[0] = cfg.focus[0]
    stage.focus[1] = cfg.focus[1]
    stage.focus[2] = cfg.focus[2]
    stage.targetFocus[0] = cfg.focus[0]
    stage.targetFocus[1] = cfg.focus[1]
    stage.targetFocus[2] = cfg.focus[2]
    stage.camYaw = cfg.yaw
    stage.targetYaw = cfg.yaw
    stage.camPitch = cfg.pitch
    stage.targetPitch = cfg.pitch
    stage.camDist = cfg.dist
    stage.targetDist = cfg.dist
    stage.camCustom = false
  }

  function packVignetteUniformBuffer() {
    pullFlatIntoSurfaceState()
    vignetteUniforms.fill(0)
    // Slot 0: wood_floor
    packMaterialParams(surfaceState.wood_floor, vignetteUniforms, 0 * 12)
    // Slot 1: cobblestone (derived from concrete/pavers)
    packMaterialParams(MATERIAL_RECIPES.cobblestone.defaults, vignetteUniforms, 1 * 12)
    // Slot 2: plaster
    packMaterialParams(surfaceState.plaster, vignetteUniforms, 2 * 12)
    // Slot 3: asphalt
    packMaterialParams(surfaceState.asphalt, vignetteUniforms, 3 * 12)
    // Slot 4: concrete
    packMaterialParams(surfaceState.concrete, vignetteUniforms, 4 * 12)
    // Slot 5: grass
    packMaterialParams(surfaceState.grass, vignetteUniforms, 5 * 12)
    // Slot 6: siding
    packMaterialParams(surfaceState.siding, vignetteUniforms, 6 * 12)
    // Slot 7: shingles
    packMaterialParams(surfaceState.shingles, vignetteUniforms, 7 * 12)

    // params0 (offset 96): compareMode, compareSplit, cutawayMode, diffuseWrap
    vignetteUniforms[96] = s.compareMode
    vignetteUniforms[97] = s.compareSplit
    vignetteUniforms[98] = s.cutawayMode
    vignetteUniforms[99] = s.diffuseWrap

    // params1 (offset 100): ambientFill, skyTemp, moonTemp, overgrowth
    vignetteUniforms[100] = s.ambientFill
    vignetteUniforms[101] = s.skyTemp
    vignetteUniforms[102] = s.moonTemp
    vignetteUniforms[103] = s.overgrowth

    // params2 (offset 104): true player x, z, skyScaleRatio, moonScaleRatio
    vignetteUniforms[104] = player.x
    vignetteUniforms[105] = player.y
    vignetteUniforms[106] = s.compareMode === 2 ? Math.max(0.05, s.skyFill) : 1.0
    vignetteUniforms[107] = s.compareMode === 2 ? Math.max(0.05, s.moonStrength) : 1.0
  }

  const controls: LabControl[] = [
    // --- Presets & Comparison ---
    {
      key: "directionPreset",
      label: "Art direction",
      group: "Direction & View",
      type: "select",
      options: VIGNETTE_DIRECTION_ORDER.map(id => ({
        value: id,
        label: VIGNETTE_DIRECTIONS[id].label,
      })),
      change: val => {
        applyDirectionPreset(Number(val) as VignetteDirectionId)
        context.sync()
      },
    },
    {
      key: "cameraPreset",
      label: "Camera preset",
      group: "Direction & View",
      type: "select",
      options: [
        { value: "game", label: "Game camera (lot + street)" },
        { value: "interior", label: "Interior close (living + kitchen)" },
        { value: "street", label: "Street close (lamp + porch)" },
        { value: "target_street", label: "Target street (1000×680 aligned)" },
        { value: "target_interior", label: "Target interior (1000×680 aligned)" },
      ],
      change: val => {
        applyCameraPreset(String(val) as VignetteCameraPreset)
        context.sync()
      },
    },
    {
      key: "cutawayMode",
      label: "Interior cutaway",
      group: "Direction & View",
      type: "select",
      options: [
        { value: 1, label: "Cutaway interior (living + kitchen)" },
        { value: 0, label: "Auto (by player position)" },
        { value: 2, label: "Closed roof" },
      ],
    },
    {
      key: "compareMode",
      label: "A/B vs Shipped",
      group: "Direction & View",
      type: "select",
      options: [
        { value: 0, label: "Vignette (Active)" },
        { value: 1, label: "Current shipped (Before)" },
        { value: 2, label: "Split A/B vs Shipped" },
      ],
      change: () => context.sync(),
    },
    {
      key: "compareSplit",
      label: "A/B split line",
      group: "Direction & View",
      type: "range",
      min: 0.1,
      max: 0.9,
      step: 0.05,
      unit: "",
      visible: () => s.compareMode === 2,
    },
    {
      key: "diagnostic",
      label: "Contribution",
      group: "Direction & View",
      type: "select",
      options: ["Beauty", "Albedo", "Direct", "Ambient + sky", "Specular", "Bloom", "Before memory"].map((label, value) => ({
        label,
        value,
      })),
    },

    // --- Time, Sky & Shadows ---
    { key: "hour", label: "Time of day", group: "Sky & Shadows", type: "range", min: 0, max: 24, step: 0.1, unit: "h" },
    { key: "exposure", label: "Exposure", group: "Sky & Shadows", type: "range", min: 0.4, max: 2.2, step: 0.05, unit: "×" },
    { key: "ambientFill", label: "Sheltered ambient", group: "Sky & Shadows", type: "range", min: 0, max: 2.0, step: 0.05, unit: "×" },
    { key: "skyFill", label: "Sky fill", group: "Sky & Shadows", type: "range", min: 0, max: 2.0, step: 0.05, unit: "×" },
    { key: "skyTemp", label: "Sky warmth", group: "Sky & Shadows", type: "range", min: -1, max: 1, step: 0.05, unit: "" },
    { key: "moonStrength", label: "Moon / sun fill", group: "Sky & Shadows", type: "range", min: 0, max: 2.5, step: 0.05, unit: "×" },
    { key: "moonTemp", label: "Moon / sun warmth", group: "Sky & Shadows", type: "range", min: -1, max: 1, step: 0.05, unit: "" },
    { key: "shadowSoftness", label: "Shadow softness", group: "Sky & Shadows", type: "range", min: 0.04, max: 0.6, step: 0.02, unit: "m" },
    { key: "diffuseWrap", label: "Painterly wrap", group: "Sky & Shadows", type: "range", min: 0, max: 1, step: 0.05, unit: "" },

    // --- Practical Lights & Flashlight (shared games/outbreak/shared/flashlight.ts) ---
    {
      key: "flashlightOn",
      label: "Flashlight switch",
      group: "Flashlight",
      change: val => {
        flashlightState.flashlightOn = Boolean(val)
        flashlightState.flashlightOutput = flashlightState.flashlightOn ? 1 : 0
      },
    },
    ...flashlightControls.map(
      (fc): LabControl => ({
        key: fc.key,
        label: fc.label,
        group: fc.group,
        type: "range",
        min: fc.min,
        max: fc.max,
        step: fc.step,
        unit: fc.unit,
        folded: fc.key.startsWith("flashlightD") || fc.key.startsWith("flashlightR") || fc.key === "flashlightFlicker",
      }),
    ),
    { key: "flashlightHaze", label: "Volumetric cone haze", group: "Flashlight", type: "range", min: 0, max: 2.0, step: 0.05, unit: "×" },
    { key: "flashlightAim", label: "Beam yaw", group: "Flashlight", type: "range", min: -180, max: 180, step: 1, unit: "deg" },
    { key: "streetLampPower", label: "Streetlamp power", group: "Practical Lights", type: "range", min: 0, max: 2.5, step: 0.05, unit: "×" },
    { key: "streetLampTemp", label: "Streetlamp colour", group: "Practical Lights", type: "range", min: 1800, max: 5500, step: 50, unit: "K" },
    { key: "streetLampFalloff", label: "Streetlamp radius", group: "Practical Lights", type: "range", min: 0.5, max: 1.8, step: 0.05, unit: "×" },
    { key: "porchLightPower", label: "Porch light power", group: "Practical Lights", type: "range", min: 0, max: 2.5, step: 0.05, unit: "×" },
    { key: "porchLightTemp", label: "Porch light colour", group: "Practical Lights", type: "range", min: 1800, max: 5500, step: 50, unit: "K" },
    { key: "porchLightFalloff", label: "Porch light radius", group: "Practical Lights", type: "range", min: 0.5, max: 1.8, step: 0.05, unit: "×" },
    { key: "windowLightPower", label: "Window & room power", group: "Practical Lights", type: "range", min: 0, max: 2.5, step: 0.05, unit: "×" },
    { key: "windowLightTemp", label: "Window & room colour", group: "Practical Lights", type: "range", min: 1800, max: 5500, step: 50, unit: "K" },
    { key: "windowLightFalloff", label: "Window & room radius", group: "Practical Lights", type: "range", min: 0.5, max: 1.8, step: 0.05, unit: "×" },

    // --- Surface Materials (shared surface-materials system) ---
    {
      key: "activeSurface",
      label: "Surface",
      group: "Surface Materials",
      type: "select",
      options: VIGNETTE_SURFACE_IDS.map(id => ({
        value: id,
        label: VIGNETTE_SURFACES[id].label,
      })),
      change: val => {
        if (isVignetteSurfaceId(val)) {
          loadActiveSurfaceSliders(val)
          context.sync()
        }
      },
    },
    {
      key: "tuningSeed",
      label: "Recipe tuning seed",
      group: "Surface Materials",
      type: "range",
      min: 1,
      max: 9999,
      step: 1,
      unit: "",
    },
    {
      key: "randomizeSurface",
      label: "Randomize surface",
      group: "Surface Materials",
      type: "action",
      run: () => {
        context.transact?.(`Randomize ${s.activeSurface} recipe`, () => {
          const meta = VIGNETTE_SURFACES[s.activeSurface]
          const next = randomizeMaterialParams(meta.baseRecipe, s.tuningSeed + meta.slot * 31)
          surfaceState[s.activeSurface] = next
          syncActiveSurfaceToFlat(s.activeSurface)
          s.tuningSeed = (s.tuningSeed % 9999) + 1
        })
        context.sync()
      },
    },
    {
      key: "resetSurface",
      label: "Reset surface",
      group: "Surface Materials",
      type: "action",
      run: () => {
        context.transact?.(`Reset ${s.activeSurface} recipe`, () => {
          surfaceState[s.activeSurface] = { ...VIGNETTE_SURFACES[s.activeSurface].defaults }
          syncActiveSurfaceToFlat(s.activeSurface)
        })
        context.sync()
      },
    },
    ...MATERIAL_PARAM_SPECS.map(
      (spec): LabControl => ({
        key: spec.key,
        label: spec.label,
        group: spec.group === "Surface" ? "Surface Materials" : `Material ${spec.group}`,
        folded: spec.group !== "Surface",
        type: "range",
        min: spec.min,
        max: spec.max,
        step: spec.step,
        unit: spec.unit,
        change: val => {
          if (typeof val === "number" && Number.isFinite(val)) {
            surfaceState[s.activeSurface][spec.key] = val
            s[surfaceParamKey(s.activeSurface, spec.key)] = val
          }
        },
      }),
    ),

    // --- Lot & Interior Clutter ---
    {
      key: "clutterDensity",
      label: "Interior clutter",
      group: "Lot & Clutter",
      type: "range",
      min: 0,
      max: 1.5,
      step: 0.05,
      unit: "×",
      change: () => rebuildVignetteLevel(),
    },
    {
      key: "foliageDensity",
      label: "Ground-cover density",
      group: "Lot & Clutter",
      type: "range",
      min: 0.25,
      max: 1.75,
      step: 0.05,
      unit: "×",
      change: () => rebuildVignetteLevel(),
    },
    {
      key: "overgrowth",
      label: "Crack moss & sun-shafts",
      group: "Lot & Clutter",
      type: "range",
      min: 0,
      max: 1,
      step: 0.05,
      unit: "",
    },
    {
      key: "treeSlot",
      label: "Tree slot",
      group: "Lot & Clutter",
      type: "select",
      options: [
        { value: 1, label: "Broadleaf oak" },
        { value: 2, label: "Autumn maple" },
        { value: 3, label: "Compact birch" },
        { value: 0, label: "Empty slot" },
      ],
      change: () => rebuildVignetteLevel(),
    },
    {
      key: "houseSeed",
      label: "House palette seed",
      group: "Lot & Clutter",
      type: "range",
      min: 1,
      max: 32,
      step: 1,
      unit: "",
      change: () => rebuildVignetteLevel(),
    },

    // --- Shared @arcade/kit LookSettings Controls ---
    ...createLookControls(lookSettings, { includePresetPicker: false }).map(
      (c): LabControl => ({
        ...c,
        folded: true,
        change: val => {
          ;(c as { change?: (v: any) => void }).change?.(val)
          syncLookSettingsFromState()
        },
      }),
    ),
  ]

  function renderVignetteToStage(width: number, height: number, outputView: GPUTextureView): number | null {
    const r = ensureRenderer()
    r.resize(width, height)
    r.setSurfaceTexUniforms({ enabled: s.compareMode === 1 ? 0 : 1, globalScale: 1.0, globalContrast: 1.15, globalRoughness: 0.0 })
    packVignetteUniformBuffer()
    r.setCustomUniforms(vignetteUniforms)

    const useShippedGlobal = s.compareMode === 1
    const effHour = wrapHour(useShippedGlobal ? 18.0 : s.hour)
    const day = dayCycle(effHour)

    // Camera matrix: use Outbreak's 0.52 FOV camera when on preset, or Stage's orbit camera when user orbits
    if (!stage.camCustom) {
      cam.x = stage.focus[0]!
      cam.z = stage.focus[2]!
      cam.pitch = stage.camPitch
      cam.dist = stage.camDist
      cam.zoomOffset = 0
      cam.update(width / Math.max(1, height))
      stage.viewProj.set(cam.viewProj)
      mat4.inverse(cam.viewProj, stage.inverse)
      stage.eye.set(cam.eye)
    }

    const view = computeGroundRectFromVP(stage.viewProj, 5.5)
    const groundY = supportHeight(town, player.x, player.y)

    // Populate lights: slot 0 is eye visibility
    lights.fill(0)
    lights.set([player.x, 1.65 + groundY, player.y, 27, 0, 0, 0, 0, 0, 0, 0, 0, 0, blockers.length, 0.01, -1], 0)
    let count = 1

    const isInteriorCam = s.cameraPreset === "interior" || s.cameraPreset === "target_interior"
    const isNoirPreset = !useShippedGlobal && s.directionPreset === 3
    const soft = useShippedGlobal ? 0.20 : s.shadowSoftness
    for (const [i, lamp] of town.lamps.entries()) {
      const kindMult = useShippedGlobal
        ? 1.0
        : lamp.kind === "street"
          ? s.streetLampPower
          : lamp.kind === "porch"
            ? s.porchLightPower * (isInteriorCam && isNoirPreset ? 0.36 : 1.0)
            : s.windowLightPower
      const radiusMult = useShippedGlobal
        ? 1.0
        : lamp.kind === "street"
          ? s.streetLampFalloff
          : lamp.kind === "porch"
            ? s.porchLightFalloff
            : s.windowLightFalloff
      let noirRoomMult = 1.0
      let noirColorOverride: [number, number, number] | null = null
      if (isNoirPreset) {
        if (lamp.kind === "window") {
          // Left window off; right window subtle
          noirRoomMult = lamp.x < 26 ? 0.0 : isInteriorCam ? 0.0 : 0.45
          noirColorOverride = [0.95, 0.76, 0.48]
        } else if (lamp.kind === "room") {
          if (lamp.x < 26 && lamp.y < 28) {
            // Bedroom nightstand lamp: cool pale ice-blue pool
            noirRoomMult = 1.55
            noirColorOverride = [0.64, 0.82, 1.0]
          } else if (lamp.x > 30 && lamp.y > 29) {
            // Dining/kitchen lamp: warm amber pool
            noirRoomMult = 1.22
            noirColorOverride = [1.0, 0.58, 0.22]
          } else {
            // SW living room & central hallway lamps off in Noir
            noirRoomMult = 0.0
          }
        }
      }
      const lampScale = Math.max(0.18, day.lamps) * kindMult * noirRoomMult
      lampPower[i] = lampScale
      const power = lampScale * lamp.power
      if (power <= 0.001) continue
      const lx = lamp.x + (lamp.kind === "street" ? 0.55 : 0)
      const ly = lamp.y
      const rad = lamp.radius * radiusMult
      const color: [number, number, number] = useShippedGlobal
        ? lamp.kind === "street"
          ? [1, 0.78, 0.54]
          : lamp.kind === "porch"
            ? [1, 0.66, 0.28]
            : lamp.kind === "window"
              ? [1, 0.60, 0.24]
              : [1, 0.52, 0.19]
        : noirColorOverride ??
          (lamp.kind === "street"
            ? kelvinToRgb(s.streetLampTemp)
            : lamp.kind === "porch"
              ? kelvinToRgb(s.porchLightTemp)
              : kelvinToRgb(s.windowLightTemp))
      const cone =
        lamp.kind === "window"
          ? [0, 1, -0.15, 1]
          : lamp.kind === "porch"
            ? [0, 1, -0.35, 1]
            : [0, 0, 0, lamp.kind === "room" ? -1 : 0]
      const fixtureSoft = lamp.kind === "room" ? soft * 0.8 : soft * 1.1
      lights.set(
        [lx, lamp.h, ly, rad, ...color, power, ...cone, 0, lightOccluders, fixtureSoft, i],
        count++ * LIGHT_FLOATS,
      )
    }

    // Player flashlight cone via shared games/outbreak/shared/flashlight.ts
    const flashActive = !useShippedGlobal && s.flashlightOn && s.flashlightIntensity > 0.001
    const flashPower = flashActive ? s.flashlightIntensity * Math.max(0.2, flashlightState.flashlightOutput) : 0
    let flashSlot = -1
    const beamDeg = isInteriorCam && Math.abs(s.flashlightAim - 45.5) < 3 ? 54.5 : s.flashlightAim
    const effRange = isInteriorCam && Math.abs(s.flashlightRange - 10.5) < 1 ? 6.2 : s.flashlightRange
    const halfConeDeg = s.flashlightCone * 0.5
    const beamRad = (beamDeg * Math.PI) / 180
    const dirX = Math.cos(beamRad)
    const dirZ = Math.sin(beamRad)
    const fx = player.x + 0.24
    const fz = player.y + 0.08
    const fy = groundY + 1.08
    if (flashPower > 0.001 && count < MAX_LIGHTS) {
      flashSlot = count
      const fCol = flashlightColor(isInteriorCam ? Math.max(s.flashlightWarmth, 0.72) : s.flashlightWarmth)
      const cosHalf = Math.cos((halfConeDeg * Math.PI) / 180)
      lights.set(
        [
          fx,
          fy,
          fz,
          effRange,
          fCol[0],
          fCol[1],
          fCol[2],
          flashPower * 0.85,
          dirX,
          dirZ,
          cosHalf,
          1,
          0,
          lightOccluders,
          Math.max(0.03, soft * 0.45),
          -1,
        ],
        count++ * LIGHT_FLOATS,
      )
    }
    vignetteUniforms[108] = fx
    vignetteUniforms[109] = fz
    vignetteUniforms[110] = dirX
    vignetteUniforms[111] = dirZ
    vignetteUniforms[112] = Math.tan((halfConeDeg * Math.PI) / 180)
    vignetteUniforms[113] = effRange
    vignetteUniforms[114] = useShippedGlobal ? 0 : s.flashlightHaze
    vignetteUniforms[115] = flashSlot
    r.setCustomUniforms(vignetteUniforms)

    // Cutaway coordinate in F.eye.xy:
    // - cutawayMode 1: place cutaway probe inside `ash` (29.5, 30.0) so living room + kitchen roof is cut away,
    //   and set cutOn = 0 so the screen-space Bayer wall circle does not dither the front wall.
    // - cutawayMode 2: place probe at (0, 0) with cutOn = 0 so roof stays closed.
    // - cutawayMode 0: use player's plan coordinates with cutOn = 1.
    const cutX = s.cutawayMode === 1 ? 29.5 : s.cutawayMode === 2 ? 0 : player.x
    const cutZ = s.cutawayMode === 1 ? 30.0 : s.cutawayMode === 2 ? 0 : player.y
    const cutOn = s.cutawayMode === 0 ? 1 : 0

    const skyFill = useShippedGlobal || s.compareMode === 2 ? 1.0 : s.skyFill
    const skyTemp = useShippedGlobal ? 0.0 : s.skyTemp
    const skyTint: [number, number, number] = [
      1 + Math.max(0, skyTemp) * 0.45 - Math.max(0, -skyTemp) * 0.15,
      1 + Math.max(0, skyTemp) * 0.12 - Math.max(0, -skyTemp) * 0.05,
      1 - Math.max(0, skyTemp) * 0.28 + Math.max(0, -skyTemp) * 0.28,
    ]
    const moonMult = useShippedGlobal || s.compareMode === 2 ? 1.0 : s.moonStrength

    frame.set(stage.viewProj, 0)
    frame.set([stage.eye[0]!, stage.eye[1]!, stage.eye[2]!, simTime], 16)
    frame.set([width, height, count, town.lamps.length], 20)
    frame.set([cutX, cutZ, cutOn, 0.48], 24)
    frame.set(
      [
        day.ambient[0] * skyFill * skyTint[0],
        day.ambient[1] * skyFill * skyTint[1],
        day.ambient[2] * skyFill * skyTint[2],
        day.strength * moonMult,
      ],
      28,
    )
    const focusProj = stage.projectWorld(cutX, 1, cutZ)
    frame.set([focusProj.u * 2 - 1, 1 - focusProj.v * 2, 1.0, count], 32)
    frame.set([...day.direction, day.sun], 36)
    frame.set([1 / SIZE, 1 / SIZE, s.diagnostic, SIZE], 40)
    frame.set([player.aim, Math.cos((110 * Math.PI) / 360), 2.5, 0.32], 44)

    town.doors.forEach((door, i) =>
      doorData.set(
        [door.rect[0], 0, (door.rect[1] + door.rect[3]) / 2, door.open ? -Math.PI / 2 : 0, 1, 1, 1, 1, 0, 0, 1, 0],
        i * 12,
      ),
    )
    doorBatch.count = town.doors.length
    const batches = [...(avatar ? avatar.draw(player, 1 / 60, simTime, (x, z) => supportHeight(town, x, z)) : []), doorBatch]

    syncLookSettingsFromState()
    const lookCompareMode: LookCompareMode = s.compareMode === 1 ? 0 : s.compareMode === 2 ? 2 : 1
    r.setLook(lookSettings, { mode: lookCompareMode, wipeSplit: s.compareSplit })

    const renderInput: FrameInput = {
      frame,
      lights,
      lightCount: count,
      shadowLightCount: count,
      occluders,
      occluderCount: lightOccluders,
      lampPower,
      lampCount: town.lamps.length,
      view,
      batches,
      alphaSprites: empty,
      alphaCount: 0,
      addSprites: empty,
      addCount: 0,
      grade: [simTime, s.diagnostic, 0, useShippedGlobal ? 1.0 : s.exposure],
      look: lookSettings,
      lookCompare: { mode: lookCompareMode, wipeSplit: s.compareSplit },
    }

    r.drawTo(renderInput, outputView)
    return null
  }

  const sceneObjects = (): LabWorldObject[] => [
    {
      id: "player",
      label: "Survivor (Player)",
      category: "character",
      x: player.x,
      y: supportHeight(town, player.x, player.y),
      z: player.y,
      yaw: player.aim,
      radius: 0.7,
      movable: true,
    },
    {
      id: "lamp:street",
      label: "Streetlamp",
      category: "light",
      x: 34.4,
      y: 0.1,
      z: 39.12,
      radius: 0.85,
      movable: false,
    },
    {
      id: "lamp:porch",
      label: "Porch Sconce",
      category: "light",
      x: 27.7,
      y: 0.13,
      z: 36.65,
      radius: 0.8,
      movable: false,
    },
    {
      id: "house:interior",
      label: "House Cutaway (Living + Kitchen)",
      category: "specimen",
      x: 29.5,
      y: 0.13,
      z: 31.2,
      radius: 1.5,
      movable: false,
    },
  ]

  let selectedObjectId = "player"

  return {
    id: "outbreak-vignette",
    label: "Outbreak vignette",
    settings: s,
    controls,
    get selectedObjectId() {
      return selectedObjectId
    },
    set selectedObjectId(v: string) {
      selectedObjectId = v
    },
    objects: sceneObjects,
    selectObject(id) {
      if (id) selectedObjectId = id
    },
    moveObject(id, x, z, yaw) {
      if (id === "player") {
        player.x = Math.max(15, Math.min(40, x))
        player.y = Math.max(21, Math.min(47, z))
        if (typeof yaw === "number" && Number.isFinite(yaw)) player.aim = yaw
        return true
      }
      return false
    },
    groundHeight: (x, z) => supportHeight(town, x, z),
    frameTarget: () => {
      const cfg = VIGNETTE_CAMERA_PRESETS[s.cameraPreset] ?? VIGNETTE_CAMERA_PRESETS.game
      return { x: cfg.focus[0], y: cfg.focus[1], z: cfg.focus[2], dist: cfg.dist }
    },
    retrigger: () => {
      rebuildVignetteLevel()
    },
    reroll: () => {
      s.houseSeed = (s.houseSeed % 32) + 1
      rebuildVignetteLevel()
      context.sync()
    },
    enter() {
      ensureRenderer()
      applyCameraPreset(s.cameraPreset, s.cutawayMode)
      stage.cameraOverride = (w, h, vp, inverse, eye, focus) => {
        cam.x = focus[0]!
        cam.z = focus[2]!
        cam.pitch = stage.camPitch
        cam.dist = stage.camDist
        cam.zoomOffset = 0
        cam.update(w / Math.max(1, h))
        vp.set(cam.viewProj)
        mat4.inverse(cam.viewProj, inverse)
        eye.set(cam.eye)
      }
      stage.customRender = (w, h, outputView) => renderVignetteToStage(w, h, outputView)
    },
    leave() {
      stage.customRender = undefined
      stage.cameraOverride = undefined
    },
    update(dt) {
      if (s.playing) {
        simTime += dt
        flashlightState.flashlightOn = s.flashlightOn
        // Keep battery topped up in static vignette inspection while exercising stepFlashlight
        if (flashlightState.battery < 0.65) flashlightState.battery = 1
        stepFlashlight(flashlightState, dt, simTime, s)
      }
    },
    prepare() {
      vision.update(player.x, player.y, player.aim, blockers, {
        cone: 110,
        awareness: 2.5,
        range: 27,
      })
    },
    telemetry: () => {
      const dir = VIGNETTE_DIRECTIONS[s.directionPreset] ?? VIGNETTE_DIRECTIONS[3]
      return `Outbreak vignette · ${dir.slug} (${dir.lookPreset}) · ${clockText(s.hour)} {"vertices":${staticVertices},"chunks":${renderer?.drawnChunks ?? 0},"lights":${town.lamps.length + (s.flashlightOn && s.flashlightIntensity > 0 ? 1 : 0)}}`
    },
    registerCommands(commands: LabCommandRegistry) {
      commands.registerAll([
        {
          id: "vignette.preset",
          label: "Set Outbreak Vignette Art Direction Preset",
          shortLabel: "Vignette Preset",
          category: "Preset",
          undoable: true,
          args: {
            direction: {
              type: "value",
              required: true,
              description: "Direction ID (0..5) or slug ('noir', 'painterly', 'dusk', 'cozy', '70s', 'shipped')",
            },
          },
          enabled: () => true,
          run: (_ctx, args) => {
            const raw = args?.direction
            let targetId: VignetteDirectionId | undefined
            if (typeof raw === "number" && raw in VIGNETTE_DIRECTIONS) {
              targetId = raw as VignetteDirectionId
            } else if (typeof raw === "string") {
              const q = raw.trim().toLowerCase()
              if (/^[0-5]$/.test(q)) {
                targetId = Number(q) as VignetteDirectionId
              } else {
                const match = Object.values(VIGNETTE_DIRECTIONS).find(
                  d => d.slug === q || d.label.toLowerCase().includes(q) || (q === "70s" && d.id === 5) || (q === "cozy" && d.id === 4),
                )
                if (match) targetId = match.id
              }
            }
            if (targetId === undefined) {
              throw new Error("Unknown vignette direction. Expected 0..5 or 'noir', 'painterly', 'dusk', 'cozy', '70s', 'shipped'.")
            }
            applyDirectionPreset(targetId)
            context.sync()
            const spec = VIGNETTE_DIRECTIONS[targetId]
            return {
              directionPreset: spec.id,
              slug: spec.slug,
              label: spec.label,
              rendererGaps: spec.rendererGaps,
            }
          },
        },
        {
          id: "vignette.camera",
          label: "Set Outbreak Vignette Camera & Cutaway Preset",
          shortLabel: "Vignette Camera",
          category: "Scene",
          undoable: true,
          args: {
            preset: {
              type: "string",
              required: true,
              enum: ["game", "interior", "street", "target_street", "target_interior"],
              description: "Camera preset ('game', 'interior', 'street', 'target_street', 'target_interior')",
            },
            cutaway: {
              type: "string",
              required: false,
              enum: ["auto", "cutaway", "closed"],
              description: "Optional roof cutaway mode",
            },
          },
          enabled: () => true,
          run: (_ctx, args) => {
            const rawPreset = String(args?.preset ?? "game").trim().toLowerCase() as VignetteCameraPreset
            if (!(rawPreset in VIGNETTE_CAMERA_PRESETS)) {
              throw new Error(`Unknown vignette camera preset "${rawPreset}". Expected 'game', 'interior', or 'street'.`)
            }
            const rawCut = typeof args?.cutaway === "string" ? args.cutaway.trim().toLowerCase() : undefined
            const cutOverride: 0 | 1 | 2 | undefined =
              rawCut === "auto" ? 0 : rawCut === "cutaway" ? 1 : rawCut === "closed" ? 2 : undefined
            applyCameraPreset(rawPreset, cutOverride)
            context.sync()
            return {
              cameraPreset: s.cameraPreset,
              cutawayMode: s.cutawayMode,
              focus: [...stage.focus],
              distance: stage.camDist,
            }
          },
        },
        {
          id: "vignette.compare",
          label: "Set Outbreak Vignette A/B Comparison vs Shipped",
          shortLabel: "Vignette A/B",
          category: "Compare",
          undoable: true,
          args: {
            mode: {
              type: "string",
              required: true,
              enum: ["active", "shipped", "split"],
              description: "'active' (vignette), 'shipped' (baseline), or 'split' (side-by-side wipe)",
            },
            split: {
              type: "number",
              required: false,
              min: 0.1,
              max: 0.9,
              description: "Split position (0.1..0.9) when mode is 'split'",
            },
          },
          enabled: () => true,
          run: (_ctx, args) => {
            const m = String(args?.mode ?? "active").trim().toLowerCase()
            s.compareMode = m === "shipped" || m === "before" ? 1 : m === "split" ? 2 : 0
            if (typeof args?.split === "number" && Number.isFinite(args.split)) {
              s.compareSplit = Math.max(0.1, Math.min(0.9, args.split))
            }
            context.sync()
            return { compareMode: s.compareMode, compareSplit: s.compareSplit }
          },
        },
        {
          id: "vignette.surface",
          label: "Inspect or Update Vignette Surface Material Recipe",
          shortLabel: "Vignette Surface",
          category: "Inspector",
          undoable: true,
          args: {
            surface: {
              type: "string",
              required: true,
              enum: [...VIGNETTE_SURFACE_IDS],
              description: "Surface ID (wood_floor, plaster, siding, shingles, asphalt, concrete, grass)",
            },
            randomize: {
              type: "boolean",
              required: false,
              description: "Deterministically randomize this surface using tuningSeed",
            },
            tuningSeed: {
              type: "number",
              required: false,
              min: 1,
              max: 9999,
              description: "Optional tuning seed for deterministic randomization",
            },
            params: {
              type: "value",
              required: false,
              description: "Optional partial MaterialRecipeParams object to apply",
            },
          },
          enabled: () => true,
          run: (_ctx, args) => {
            const surf = String(args?.surface ?? "").trim()
            if (!isVignetteSurfaceId(surf)) {
              throw new Error(`Unknown surface "${surf}". Expected one of: ${VIGNETTE_SURFACE_IDS.join(", ")}.`)
            }
            if (typeof args?.tuningSeed === "number" && Number.isFinite(args.tuningSeed)) {
              s.tuningSeed = Math.max(1, Math.min(9999, Math.trunc(args.tuningSeed)))
            }
            if (args?.randomize === true) {
              const meta = VIGNETTE_SURFACES[surf]
              surfaceState[surf] = randomizeMaterialParams(meta.baseRecipe, s.tuningSeed + meta.slot * 31)
            }
            if (args?.params && typeof args.params === "object" && !Array.isArray(args.params)) {
              const candidate = { ...surfaceState[surf], ...(args.params as Record<string, unknown>) }
              const checked = validateMaterialParams(candidate)
              if (!checked.ok) throw new Error(checked.error)
              surfaceState[surf] = checked.value
            }
            syncActiveSurfaceToFlat(surf)
            loadActiveSurfaceSliders(surf)
            context.sync()
            return {
              surface: surf,
              tuningSeed: s.tuningSeed,
              recipe: { ...surfaceState[surf] },
            }
          },
        },
      ])
    },
  }
}
