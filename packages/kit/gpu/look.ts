import type { LabControl } from "../lab-panel"
import { Rng } from "../sim/rng"
import { wgslStruct } from "./wgsl"

export type LookPresetId =
  | "current"
  | "noir"
  | "painterly"
  | "cinematic_dusk"
  | "sodium_70s"
  | "cozy_golden_hour"

export type LookTonemapMode = 0 | 1 | 2 | 3
export type LookCompareMode = 0 | 1 | 2

export type LookGroup =
  | "Tone & Curve"
  | "Split-Tone & Palette"
  | "Lighting & Silhouette"
  | "Atmosphere & Shafts"
  | "Lens & Film"
  | "Painterly & Ink"

export type LookPalette = {
  sky: readonly [number, number, number]
  practical: readonly [number, number, number]
  wall: readonly [number, number, number]
  wood: readonly [number, number, number]
  stone: readonly [number, number, number]
  asphalt: readonly [number, number, number]
  foliage: readonly [number, number, number]
  ink: readonly [number, number, number]
}

export type LookNumericKey =
  | "exposure"
  | "tonemap"
  | "contrast"
  | "toe"
  | "shoulder"
  | "blackCrush"
  | "saturation"
  | "temperature"
  | "splitTone"
  | "shadowTintR"
  | "shadowTintG"
  | "shadowTintB"
  | "highlightTintR"
  | "highlightTintG"
  | "highlightTintB"
  | "paletteMix"
  | "selectiveColor"
  | "foliageShift"
  | "ambientFill"
  | "shadowColorR"
  | "shadowColorG"
  | "shadowColorB"
  | "practicalWarmth"
  | "practicalIntensity"
  | "moonIntensity"
  | "rimStrength"
  | "contactShade"
  | "surfaceWetness"
  | "fogDensity"
  | "fogHeightFalloff"
  | "fogColorR"
  | "fogColorG"
  | "fogColorB"
  | "shaftStrength"
  | "shaftSlats"
  | "bloom"
  | "halation"
  | "vignette"
  | "grain"
  | "grainSeed"
  | "chromatic"
  | "diffuseWrap"
  | "diffuseBands"
  | "bandSoftness"
  | "painterlySmooth"
  | "outlineStrength"
  | "outlineWidth"

export type LookSettings = Record<LookNumericKey, number> & {
  preset: LookPresetId
  grainAnimated: boolean
}

export type LookParamSpec = {
  key: LookNumericKey | "grainAnimated"
  label: string
  group: LookGroup
  type: "range" | "select" | "toggle"
  min?: number
  max?: number
  step?: number
  unit?: "" | "×" | "m" | "px"
  options?: readonly { value: number; label: string }[]
  /** All Look parameters update live shader uniforms without rebuilding geometry or resetting transport. */
  boundary: "uniform"
}

export const LOOK_TONEMAP_OPTIONS: readonly { value: LookTonemapMode; label: string }[] = [
  { value: 0, label: "Current (ACES)" },
  { value: 1, label: "Filmic (Lamplight)" },
  { value: 2, label: "AgX (Sobotka)" },
  { value: 3, label: "ACES Hue-Preserving" },
] as const

export const LOOK_GROUPS: readonly LookGroup[] = [
  "Tone & Curve",
  "Split-Tone & Palette",
  "Lighting & Silhouette",
  "Atmosphere & Shafts",
  "Lens & Film",
  "Painterly & Ink",
] as const

export const LOOK_PARAM_SPECS: readonly LookParamSpec[] = [
  // Tone & Curve
  { key: "exposure", label: "Exposure", group: "Tone & Curve", type: "range", min: 0.2, max: 2.5, step: 0.02, unit: "×", boundary: "uniform" },
  { key: "tonemap", label: "Tonemap", group: "Tone & Curve", type: "select", options: LOOK_TONEMAP_OPTIONS, boundary: "uniform" },
  { key: "contrast", label: "Contrast", group: "Tone & Curve", type: "range", min: 0.6, max: 1.8, step: 0.02, unit: "×", boundary: "uniform" },
  { key: "toe", label: "Shadow toe", group: "Tone & Curve", type: "range", min: 0.0, max: 0.8, step: 0.02, unit: "", boundary: "uniform" },
  { key: "shoulder", label: "Highlight shoulder", group: "Tone & Curve", type: "range", min: 0.0, max: 1.0, step: 0.02, unit: "", boundary: "uniform" },
  { key: "blackCrush", label: "Black crush", group: "Tone & Curve", type: "range", min: 0.0, max: 0.2, step: 0.001, unit: "", boundary: "uniform" },
  { key: "saturation", label: "Saturation", group: "Tone & Curve", type: "range", min: 0.0, max: 1.6, step: 0.02, unit: "×", boundary: "uniform" },
  { key: "temperature", label: "Temperature", group: "Tone & Curve", type: "range", min: -1.0, max: 1.0, step: 0.02, unit: "", boundary: "uniform" },

  // Split-Tone & Palette
  { key: "splitTone", label: "Split-tone strength", group: "Split-Tone & Palette", type: "range", min: 0.0, max: 1.5, step: 0.02, unit: "", boundary: "uniform" },
  { key: "shadowTintR", label: "Shadow tint R", group: "Split-Tone & Palette", type: "range", min: 0.2, max: 1.5, step: 0.02, unit: "", boundary: "uniform" },
  { key: "shadowTintG", label: "Shadow tint G", group: "Split-Tone & Palette", type: "range", min: 0.2, max: 1.5, step: 0.02, unit: "", boundary: "uniform" },
  { key: "shadowTintB", label: "Shadow tint B", group: "Split-Tone & Palette", type: "range", min: 0.2, max: 1.5, step: 0.02, unit: "", boundary: "uniform" },
  { key: "highlightTintR", label: "Highlight tint R", group: "Split-Tone & Palette", type: "range", min: 0.2, max: 1.5, step: 0.02, unit: "", boundary: "uniform" },
  { key: "highlightTintG", label: "Highlight tint G", group: "Split-Tone & Palette", type: "range", min: 0.2, max: 1.5, step: 0.02, unit: "", boundary: "uniform" },
  { key: "highlightTintB", label: "Highlight tint B", group: "Split-Tone & Palette", type: "range", min: 0.2, max: 1.5, step: 0.02, unit: "", boundary: "uniform" },
  { key: "paletteMix", label: "Preset palette blend", group: "Split-Tone & Palette", type: "range", min: 0.0, max: 1.0, step: 0.01, unit: "", boundary: "uniform" },
  { key: "selectiveColor", label: "Selective beam colour", group: "Split-Tone & Palette", type: "range", min: 0.0, max: 1.5, step: 0.02, unit: "×", boundary: "uniform" },
  { key: "foliageShift", label: "Foliage warmth shift", group: "Split-Tone & Palette", type: "range", min: -0.6, max: 0.6, step: 0.01, unit: "", boundary: "uniform" },

  // Lighting & Silhouette
  { key: "ambientFill", label: "Ambient / sky fill", group: "Lighting & Silhouette", type: "range", min: 0.0, max: 2.2, step: 0.01, unit: "×", boundary: "uniform" },
  { key: "shadowColorR", label: "Shadow colour R", group: "Lighting & Silhouette", type: "range", min: 0.1, max: 1.5, step: 0.02, unit: "", boundary: "uniform" },
  { key: "shadowColorG", label: "Shadow colour G", group: "Lighting & Silhouette", type: "range", min: 0.1, max: 1.5, step: 0.02, unit: "", boundary: "uniform" },
  { key: "shadowColorB", label: "Shadow colour B", group: "Lighting & Silhouette", type: "range", min: 0.1, max: 1.5, step: 0.02, unit: "", boundary: "uniform" },
  { key: "practicalWarmth", label: "Practical warmth", group: "Lighting & Silhouette", type: "range", min: -0.8, max: 1.2, step: 0.01, unit: "", boundary: "uniform" },
  { key: "practicalIntensity", label: "Practical intensity", group: "Lighting & Silhouette", type: "range", min: 0.0, max: 2.5, step: 0.05, unit: "×", boundary: "uniform" },
  { key: "moonIntensity", label: "Moon / sun intensity", group: "Lighting & Silhouette", type: "range", min: 0.0, max: 2.5, step: 0.05, unit: "×", boundary: "uniform" },
  { key: "rimStrength", label: "Rim / silhouette light", group: "Lighting & Silhouette", type: "range", min: 0.0, max: 2.0, step: 0.05, unit: "×", boundary: "uniform" },
  { key: "contactShade", label: "Contact shading", group: "Lighting & Silhouette", type: "range", min: 0.0, max: 1.5, step: 0.05, unit: "", boundary: "uniform" },
  { key: "surfaceWetness", label: "Surface damp sheen", group: "Lighting & Silhouette", type: "range", min: 0.0, max: 1.0, step: 0.01, unit: "", boundary: "uniform" },

  // Atmosphere & Shafts
  { key: "fogDensity", label: "Fog density", group: "Atmosphere & Shafts", type: "range", min: 0.0, max: 1.2, step: 0.02, unit: "", boundary: "uniform" },
  { key: "fogHeightFalloff", label: "Fog height falloff", group: "Atmosphere & Shafts", type: "range", min: 0.3, max: 4.5, step: 0.1, unit: "m", boundary: "uniform" },
  { key: "fogColorR", label: "Fog colour R", group: "Atmosphere & Shafts", type: "range", min: 0.0, max: 1.0, step: 0.01, unit: "", boundary: "uniform" },
  { key: "fogColorG", label: "Fog colour G", group: "Atmosphere & Shafts", type: "range", min: 0.0, max: 1.0, step: 0.01, unit: "", boundary: "uniform" },
  { key: "fogColorB", label: "Fog colour B", group: "Atmosphere & Shafts", type: "range", min: 0.0, max: 1.0, step: 0.01, unit: "", boundary: "uniform" },
  { key: "shaftStrength", label: "Light shaft strength", group: "Atmosphere & Shafts", type: "range", min: 0.0, max: 2.5, step: 0.05, unit: "×", boundary: "uniform" },
  { key: "shaftSlats", label: "Venetian slats / cookie", group: "Atmosphere & Shafts", type: "range", min: 0.0, max: 1.0, step: 0.01, unit: "", boundary: "uniform" },

  // Lens & Film
  { key: "bloom", label: "Bloom strength", group: "Lens & Film", type: "range", min: 0.0, max: 2.5, step: 0.05, unit: "×", boundary: "uniform" },
  { key: "halation", label: "Film halation", group: "Lens & Film", type: "range", min: 0.0, max: 1.5, step: 0.01, unit: "", boundary: "uniform" },
  { key: "vignette", label: "Lens vignette", group: "Lens & Film", type: "range", min: 0.0, max: 1.5, step: 0.01, unit: "", boundary: "uniform" },
  { key: "grain", label: "Film grain", group: "Lens & Film", type: "range", min: 0.0, max: 1.2, step: 0.02, unit: "", boundary: "uniform" },
  { key: "grainSeed", label: "Grain seed", group: "Lens & Film", type: "range", min: 1, max: 9999, step: 1, unit: "", boundary: "uniform" },
  { key: "grainAnimated", label: "Temporal grain", group: "Lens & Film", type: "toggle", boundary: "uniform" },
  { key: "chromatic", label: "Chromatic softness", group: "Lens & Film", type: "range", min: 0.0, max: 1.5, step: 0.01, unit: "", boundary: "uniform" },

  // Painterly & Ink
  { key: "diffuseWrap", label: "Diffuse wrap", group: "Painterly & Ink", type: "range", min: 0.0, max: 1.0, step: 0.01, unit: "", boundary: "uniform" },
  { key: "diffuseBands", label: "Diffuse bands (0=off)", group: "Painterly & Ink", type: "range", min: 0, max: 6, step: 1, unit: "", boundary: "uniform" },
  { key: "bandSoftness", label: "Band softness", group: "Painterly & Ink", type: "range", min: 0.02, max: 0.46, step: 0.02, unit: "", boundary: "uniform" },
  { key: "painterlySmooth", label: "Kuwahara brush smooth", group: "Painterly & Ink", type: "range", min: 0.0, max: 1.0, step: 0.01, unit: "", boundary: "uniform" },
  { key: "outlineStrength", label: "Ink outline strength", group: "Painterly & Ink", type: "range", min: 0.0, max: 1.5, step: 0.01, unit: "", boundary: "uniform" },
  { key: "outlineWidth", label: "Ink outline width", group: "Painterly & Ink", type: "range", min: 0.5, max: 3.0, step: 0.25, unit: "px", boundary: "uniform" },
] as const

export type LookPresetDef = {
  id: LookPresetId
  index: number
  label: string
  directionRef: string
  summary: string
  palette: LookPalette
  defaults: Readonly<LookSettings>
}

export const LOOK_PRESETS: Readonly<Record<LookPresetId, LookPresetDef>> = {
  current: {
    id: "current",
    index: 0,
    label: "Current",
    directionRef: "Identity baseline",
    summary: "Exact identity pass — reproduces today's approved game and stage output without grading or surface overrides.",
    palette: {
      sky: [0.48, 0.61, 0.90],
      practical: [1.0, 0.68, 0.36],
      wall: [0.44, 0.40, 0.33],
      wood: [0.55, 0.43, 0.31],
      stone: [0.47, 0.45, 0.40],
      asphalt: [0.24, 0.26, 0.28],
      foliage: [0.31, 0.38, 0.22],
      ink: [0.08, 0.09, 0.12],
    },
    defaults: {
      preset: "current",
      exposure: 1.0,
      tonemap: 0,
      contrast: 1.0,
      toe: 0.0,
      shoulder: 0.0,
      blackCrush: 0.0,
      saturation: 1.0,
      temperature: 0.0,
      splitTone: 0.0,
      shadowTintR: 1.0,
      shadowTintG: 1.0,
      shadowTintB: 1.0,
      highlightTintR: 1.0,
      highlightTintG: 1.0,
      highlightTintB: 1.0,
      paletteMix: 0.0,
      selectiveColor: 0.0,
      foliageShift: 0.0,
      ambientFill: 1.0,
      shadowColorR: 1.0,
      shadowColorG: 1.0,
      shadowColorB: 1.0,
      practicalWarmth: 0.0,
      practicalIntensity: 1.0,
      moonIntensity: 1.0,
      rimStrength: 0.0,
      contactShade: 0.0,
      surfaceWetness: 0.0,
      fogDensity: 0.0,
      fogHeightFalloff: 2.2,
      fogColorR: 0.16,
      fogColorG: 0.2,
      fogColorB: 0.26,
      shaftStrength: 0.0,
      shaftSlats: 0.35,
      bloom: 1.0,
      halation: 0.0,
      vignette: 0.0,
      grain: 0.0,
      grainSeed: 73,
      grainAnimated: true,
      chromatic: 0.0,
      diffuseWrap: 0.0,
      diffuseBands: 0,
      bandSoftness: 0.18,
      painterlySmooth: 0.0,
      outlineStrength: 0.0,
      outlineWidth: 1.25,
    },
  },
  noir: {
    id: "noir",
    index: 1,
    label: "Noir / Limbo",
    directionRef: "Outbreak Dir 3 + Lamplight amber-limbo / hybrid-noir",
    summary: "Muted, warm-grey night with readable mid-tones and soft silhouette rims, where received light (the player's flashlight first, then practical lamps) restores natural colour through a soft knee.",
    palette: {
      sky: [0.42, 0.56, 0.72],
      practical: [1.0, 0.62, 0.24],
      wall: [0.28, 0.30, 0.33],
      wood: [0.34, 0.29, 0.24],
      stone: [0.31, 0.33, 0.36],
      asphalt: [0.13, 0.15, 0.18],
      foliage: [0.17, 0.22, 0.19],
      ink: [0.02, 0.03, 0.05],
    },
    defaults: {
      preset: "noir",
      exposure: 1.1,
      tonemap: 1,
      contrast: 1.1,
      toe: 0.12,
      shoulder: 0.28,
      blackCrush: 0.004,
      saturation: 0.42,
      temperature: 0.2,
      splitTone: 0.32,
      shadowTintR: 1.04,
      shadowTintG: 0.98,
      shadowTintB: 0.9,
      highlightTintR: 0.98,
      highlightTintG: 1.0,
      highlightTintB: 0.96,
      paletteMix: 0.24,
      selectiveColor: 0.92,
      foliageShift: -0.14,
      ambientFill: 0.38,
      shadowColorR: 0.84,
      shadowColorG: 0.92,
      shadowColorB: 1.04,
      practicalWarmth: 0.0,
      practicalIntensity: 1.15,
      moonIntensity: 1.15,
      rimStrength: 1.65,
      contactShade: 0.85,
      surfaceWetness: 0.82,
      fogDensity: 0.32,
      fogHeightFalloff: 1.6,
      fogColorR: 0.04,
      fogColorG: 0.05,
      fogColorB: 0.07,
      shaftStrength: 1.65,
      shaftSlats: 0.65,
      bloom: 1.1,
      halation: 0.14,
      vignette: 0.82,
      grain: 0.0,
      grainSeed: 73,
      grainAnimated: true,
      chromatic: 0.1,
      diffuseWrap: 0.1,
      diffuseBands: 0,
      bandSoftness: 0.16,
      painterlySmooth: 0.0,
      outlineStrength: 0.0,
      outlineWidth: 1.0,
    },
  },
  painterly: {
    id: "painterly",
    index: 2,
    label: "Painterly",
    directionRef: "Outbreak Dir 2 (Tiny Glade / Ghibli gouache)",
    summary: "Warm gouache twilight with periwinkle shadows, peach-gold practicals, 3-band soft wrap diffuse, multi-ring Kuwahara brush smoothing, and soft ink outlines.",
    palette: {
      sky: [0.52, 0.62, 0.90],
      practical: [1.0, 0.78, 0.48],
      wall: [0.74, 0.69, 0.63],
      wood: [0.72, 0.52, 0.33],
      stone: [0.64, 0.63, 0.68],
      asphalt: [0.44, 0.49, 0.66],
      foliage: [0.44, 0.58, 0.32],
      ink: [0.22, 0.20, 0.30],
    },
    defaults: {
      preset: "painterly",
      exposure: 1.24,
      tonemap: 2,
      contrast: 0.92,
      toe: 0.02,
      shoulder: 0.24,
      blackCrush: 0.0,
      saturation: 1.18,
      temperature: 0.08,
      splitTone: 0.58,
      shadowTintR: 0.82,
      shadowTintG: 0.88,
      shadowTintB: 1.14,
      highlightTintR: 1.12,
      highlightTintG: 1.0,
      highlightTintB: 0.82,
      paletteMix: 0.88,
      selectiveColor: 0.0,
      foliageShift: 0.28,
      ambientFill: 1.65,
      shadowColorR: 0.74,
      shadowColorG: 0.84,
      shadowColorB: 1.18,
      practicalWarmth: 0.32,
      practicalIntensity: 1.35,
      moonIntensity: 1.35,
      rimStrength: 0.65,
      contactShade: 0.25,
      surfaceWetness: 0.0,
      fogDensity: 0.14,
      fogHeightFalloff: 3.2,
      fogColorR: 0.34,
      fogColorG: 0.4,
      fogColorB: 0.58,
      shaftStrength: 0.85,
      shaftSlats: 0.08,
      bloom: 1.25,
      halation: 0.16,
      vignette: 0.12,
      grain: 0.0,
      grainSeed: 73,
      grainAnimated: false,
      chromatic: 0.0,
      diffuseWrap: 0.65,
      diffuseBands: 3,
      bandSoftness: 0.22,
      painterlySmooth: 0.9,
      outlineStrength: 0.52,
      outlineWidth: 1.5,
    },
  },
  cinematic_dusk: {
    id: "cinematic_dusk",
    index: 3,
    label: "Cinematic dusk",
    directionRef: "Outbreak Dir 1 + Lamplight dusk",
    summary: "Cool slate-indigo twilight sky fill against warm 2700K tungsten practical pools, AgX tonemapping, grounded contact occlusion, and crisp dusk shafts.",
    palette: {
      sky: [0.36, 0.50, 0.78],
      practical: [1.0, 0.67, 0.33],
      wall: [0.46, 0.43, 0.38],
      wood: [0.56, 0.42, 0.29],
      stone: [0.46, 0.45, 0.42],
      asphalt: [0.21, 0.24, 0.28],
      foliage: [0.29, 0.37, 0.21],
      ink: [0.07, 0.09, 0.13],
    },
    defaults: {
      preset: "cinematic_dusk",
      exposure: 1.04,
      tonemap: 2,
      contrast: 1.14,
      toe: 0.22,
      shoulder: 0.24,
      blackCrush: 0.01,
      saturation: 1.06,
      temperature: 0.06,
      splitTone: 0.48,
      shadowTintR: 0.82,
      shadowTintG: 0.9,
      shadowTintB: 1.08,
      highlightTintR: 1.08,
      highlightTintG: 0.98,
      highlightTintB: 0.86,
      paletteMix: 0.38,
      selectiveColor: 0.0,
      foliageShift: 0.04,
      ambientFill: 0.82,
      shadowColorR: 0.78,
      shadowColorG: 0.88,
      shadowColorB: 1.06,
      practicalWarmth: 0.32,
      practicalIntensity: 1.2,
      moonIntensity: 1.1,
      rimStrength: 0.45,
      contactShade: 0.55,
      surfaceWetness: 0.15,
      fogDensity: 0.18,
      fogHeightFalloff: 2.4,
      fogColorR: 0.14,
      fogColorG: 0.18,
      fogColorB: 0.26,
      shaftStrength: 0.95,
      shaftSlats: 0.3,
      bloom: 1.05,
      halation: 0.15,
      vignette: 0.48,
      grain: 0.18,
      grainSeed: 73,
      grainAnimated: true,
      chromatic: 0.1,
      diffuseWrap: 0.15,
      diffuseBands: 0,
      bandSoftness: 0.18,
      painterlySmooth: 0.0,
      outlineStrength: 0.0,
      outlineWidth: 1.0,
    },
  },
  sodium_70s: {
    id: "sodium_70s",
    index: 4,
    label: "70s sodium",
    directionRef: "Outbreak Dir 5 (1970s Kodak 5247 / Crewdson)",
    summary: "2100K high-pressure sodium orange street/porch glow against muted olive-slate shadows, faded suburban tones, red-orange film halation, and 35mm grain.",
    palette: {
      sky: [0.38, 0.44, 0.46],
      practical: [1.0, 0.51, 0.18],
      wall: [0.50, 0.48, 0.40],
      wood: [0.46, 0.35, 0.22],
      stone: [0.44, 0.43, 0.38],
      asphalt: [0.23, 0.24, 0.23],
      foliage: [0.28, 0.32, 0.20],
      ink: [0.09, 0.08, 0.06],
    },
    defaults: {
      preset: "sodium_70s",
      exposure: 0.98,
      tonemap: 1,
      contrast: 1.18,
      toe: 0.28,
      shoulder: 0.42,
      blackCrush: 0.015,
      saturation: 0.62,
      temperature: 0.28,
      splitTone: 0.92,
      shadowTintR: 0.78,
      shadowTintG: 0.86,
      shadowTintB: 0.8,
      highlightTintR: 1.22,
      highlightTintG: 0.88,
      highlightTintB: 0.58,
      paletteMix: 0.62,
      selectiveColor: 0.0,
      foliageShift: -0.22,
      ambientFill: 0.68,
      shadowColorR: 0.76,
      shadowColorG: 0.82,
      shadowColorB: 0.78,
      practicalWarmth: 0.95,
      practicalIntensity: 1.45,
      moonIntensity: 0.75,
      rimStrength: 0.35,
      contactShade: 0.5,
      surfaceWetness: 0.3,
      fogDensity: 0.3,
      fogHeightFalloff: 2.1,
      fogColorR: 0.22,
      fogColorG: 0.18,
      fogColorB: 0.14,
      shaftStrength: 1.15,
      shaftSlats: 0.45,
      bloom: 1.45,
      halation: 0.85,
      vignette: 0.72,
      grain: 0.68,
      grainSeed: 73,
      grainAnimated: true,
      chromatic: 0.45,
      diffuseWrap: 0.1,
      diffuseBands: 0,
      bandSoftness: 0.18,
      painterlySmooth: 0.0,
      outlineStrength: 0.0,
      outlineWidth: 1.0,
    },
  },
  cozy_golden_hour: {
    id: "cozy_golden_hour",
    index: 5,
    label: "Cozy golden hour",
    directionRef: "Outbreak Dir 4 (Overgrown autumn golden hour)",
    summary: "Low-angle amber golden-hour sunlight, warm terracotta bounce, lush olive/chartreuse foliage, dusty golden window shafts, and soft halation.",
    palette: {
      sky: [0.95, 0.62, 0.32],
      practical: [1.0, 0.72, 0.35],
      wall: [0.58, 0.50, 0.39],
      wood: [0.62, 0.44, 0.27],
      stone: [0.55, 0.48, 0.38],
      asphalt: [0.30, 0.26, 0.22],
      foliage: [0.42, 0.46, 0.18],
      ink: [0.14, 0.09, 0.05],
    },
    defaults: {
      preset: "cozy_golden_hour",
      exposure: 1.14,
      tonemap: 3,
      contrast: 1.12,
      toe: 0.18,
      shoulder: 0.32,
      blackCrush: 0.0,
      saturation: 1.18,
      temperature: 0.52,
      splitTone: 0.78,
      shadowTintR: 1.06,
      shadowTintG: 0.86,
      shadowTintB: 0.72,
      highlightTintR: 1.2,
      highlightTintG: 0.96,
      highlightTintB: 0.68,
      paletteMix: 0.74,
      selectiveColor: 0.0,
      foliageShift: 0.48,
      ambientFill: 1.05,
      shadowColorR: 1.12,
      shadowColorG: 0.88,
      shadowColorB: 0.68,
      practicalWarmth: 0.58,
      practicalIntensity: 1.25,
      moonIntensity: 1.4,
      rimStrength: 0.85,
      contactShade: 0.45,
      surfaceWetness: 0.1,
      fogDensity: 0.32,
      fogHeightFalloff: 2.0,
      fogColorR: 0.32,
      fogColorG: 0.21,
      fogColorB: 0.12,
      shaftStrength: 2.1,
      shaftSlats: 0.25,
      bloom: 1.35,
      halation: 0.42,
      vignette: 0.52,
      grain: 0.22,
      grainSeed: 73,
      grainAnimated: true,
      chromatic: 0.12,
      diffuseWrap: 0.22,
      diffuseBands: 0,
      bandSoftness: 0.18,
      painterlySmooth: 0.0,
      outlineStrength: 0.0,
      outlineWidth: 1.0,
    },
  },
}

export const LOOK_PRESET_IDS = Object.keys(LOOK_PRESETS) as readonly LookPresetId[]

export function isLookPresetId(value: unknown): value is LookPresetId {
  return typeof value === "string" && value in LOOK_PRESETS
}

export function resolveLookPresetId(raw: unknown): LookPresetId | null {
  if (typeof raw !== "string") return null
  const trimmed = raw.trim().toLowerCase()
  if (isLookPresetId(trimmed)) return trimmed
  const slug = trimmed.replace(/[^a-z0-9]+/g, "")
  const aliases: Record<string, LookPresetId> = {
    current: "current",
    identity: "current",
    default: "current",
    baseline: "current",
    noir: "noir",
    limbo: "noir",
    noirlimbo: "noir",
    amberlimbo: "noir",
    hybridnoir: "noir",
    horror: "noir",
    dir3: "noir",
    painterly: "painterly",
    ghibli: "painterly",
    tinyglade: "painterly",
    gouache: "painterly",
    dir2: "painterly",
    cinematicdusk: "cinematic_dusk",
    dusk: "cinematic_dusk",
    cinematic: "cinematic_dusk",
    dir1: "cinematic_dusk",
    sodium70s: "sodium_70s",
    "70ssodium": "sodium_70s",
    sodium: "sodium_70s",
    "70s": "sodium_70s",
    suburban: "sodium_70s",
    dir5: "sodium_70s",
    cozygoldenhour: "cozy_golden_hour",
    goldenhour: "cozy_golden_hour",
    cozy: "cozy_golden_hour",
    dir4: "cozy_golden_hour",
  }
  if (slug in aliases) return aliases[slug]!
  for (const id of LOOK_PRESET_IDS) {
    const def = LOOK_PRESETS[id]
    if (def.label.toLowerCase() === trimmed || def.label.toLowerCase().replace(/[^a-z0-9]+/g, "") === slug) {
      return id
    }
  }
  return null
}

export function createLookSettings(preset: LookPresetId = "current"): LookSettings {
  return { ...LOOK_PRESETS[preset].defaults }
}

const blendedPalettes = new WeakMap<LookSettings, LookPalette>()

export function getLookPalette(settings: LookSettings): LookPalette {
  return blendedPalettes.get(settings) ?? (LOOK_PRESETS[settings.preset] ?? LOOK_PRESETS.current).palette
}

export function applyLookPreset(target: LookSettings, preset: LookPresetId): LookSettings {
  const def = LOOK_PRESETS[preset] ?? LOOK_PRESETS.current
  blendedPalettes.delete(target)
  Object.assign(target, def.defaults)
  return target
}

const LOOK_BLEND_KEYS: readonly LookNumericKey[] = [
  "exposure",
  "contrast",
  "toe",
  "shoulder",
  "blackCrush",
  "saturation",
  "temperature",
  "splitTone",
  "shadowTintR",
  "shadowTintG",
  "shadowTintB",
  "highlightTintR",
  "highlightTintG",
  "highlightTintB",
  "paletteMix",
  "selectiveColor",
  "foliageShift",
  "ambientFill",
  "shadowColorR",
  "shadowColorG",
  "shadowColorB",
  "practicalWarmth",
  "practicalIntensity",
  "moonIntensity",
  "rimStrength",
  "contactShade",
  "surfaceWetness",
  "fogDensity",
  "fogHeightFalloff",
  "fogColorR",
  "fogColorG",
  "fogColorB",
  "shaftStrength",
  "shaftSlats",
  "bloom",
  "halation",
  "vignette",
  "grain",
  "chromatic",
  "diffuseWrap",
  "bandSoftness",
  "painterlySmooth",
  "outlineStrength",
  "outlineWidth",
]

function lerpRgb(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  t: number,
): [number, number, number] {
  const u = 1 - t
  return [a[0] * u + b[0] * t, a[1] * u + b[1] * t, a[2] * u + b[2] * t]
}

export function blendLookPalettes(a: LookPalette, b: LookPalette, t: number): LookPalette {
  const k = Math.max(0, Math.min(1, t))
  return {
    sky: lerpRgb(a.sky, b.sky, k),
    practical: lerpRgb(a.practical, b.practical, k),
    wall: lerpRgb(a.wall, b.wall, k),
    wood: lerpRgb(a.wood, b.wood, k),
    stone: lerpRgb(a.stone, b.stone, k),
    asphalt: lerpRgb(a.asphalt, b.asphalt, k),
    foliage: lerpRgb(a.foliage, b.foliage, k),
    ink: lerpRgb(a.ink, b.ink, k),
  }
}

/**
 * Smoothly blends all continuous LookSettings parameters and surface palettes between `a` and `b`
 * without discrete pops.
 */
export function blendLookSettings(
  a: LookSettings,
  b: LookSettings,
  t: number,
  out: LookSettings = { ...b },
): LookSettings {
  const k = Math.max(0, Math.min(1, t))
  const u = 1 - k
  for (let i = 0; i < LOOK_BLEND_KEYS.length; i++) {
    const key = LOOK_BLEND_KEYS[i]!
    out[key] = a[key] * u + b[key] * k
  }
  out.tonemap = k < 0.5 ? a.tonemap : b.tonemap
  out.diffuseBands = Math.round(a.diffuseBands * u + b.diffuseBands * k)
  out.grainSeed = b.grainSeed
  out.grainAnimated = k < 0.5 ? a.grainAnimated : b.grainAnimated
  out.preset = k < 0.5 ? a.preset : b.preset
  const palA = getLookPalette(a)
  const palB = getLookPalette(b)
  blendedPalettes.set(out, blendLookPalettes(palA, palB, k))
  return out
}

/**
 * C-infinity 3-anchor LookSettings blend across `darkness` in [0, 1]:
 * - darkness = 0.0 -> 100% `day`
 * - darkness = 0.5 -> 100% `dusk`
 * - darkness = 1.0 -> 100% `night`
 * Uses non-negative convex weights (wDay + wDusk + wNight === 1) so it never overshoots or pops.
 */
export function blendLookSettings3(
  day: LookSettings,
  dusk: LookSettings,
  night: LookSettings,
  darkness: number,
  out: LookSettings = { ...night },
): LookSettings {
  const d = Math.max(0, Math.min(1, darkness))
  const wDusk = 4 * d * (1 - d)
  const rem = 1 - wDusk
  const wDay = (1 - d) * rem
  const wNight = d * rem
  for (let i = 0; i < LOOK_BLEND_KEYS.length; i++) {
    const key = LOOK_BLEND_KEYS[i]!
    out[key] = day[key] * wDay + dusk[key] * wDusk + night[key] * wNight
  }
  out.tonemap = night.tonemap
  out.diffuseBands = 0
  out.grainSeed = night.grainSeed
  out.grainAnimated = true
  out.preset = night.preset
  const pDay = getLookPalette(day)
  const pDusk = getLookPalette(dusk)
  const pNight = getLookPalette(night)
  const blendRgb3 = (
    c0: readonly [number, number, number],
    c1: readonly [number, number, number],
    c2: readonly [number, number, number],
  ): [number, number, number] => [
    c0[0] * wDay + c1[0] * wDusk + c2[0] * wNight,
    c0[1] * wDay + c1[1] * wDusk + c2[1] * wNight,
    c0[2] * wDay + c1[2] * wDusk + c2[2] * wNight,
  ]
  blendedPalettes.set(out, {
    sky: blendRgb3(pDay.sky, pDusk.sky, pNight.sky),
    practical: blendRgb3(pDay.practical, pDusk.practical, pNight.practical),
    wall: blendRgb3(pDay.wall, pDusk.wall, pNight.wall),
    wood: blendRgb3(pDay.wood, pDusk.wood, pNight.wood),
    stone: blendRgb3(pDay.stone, pDusk.stone, pNight.stone),
    asphalt: blendRgb3(pDay.asphalt, pDusk.asphalt, pNight.asphalt),
    foliage: blendRgb3(pDay.foliage, pDusk.foliage, pNight.foliage),
    ink: blendRgb3(pDay.ink, pDusk.ink, pNight.ink),
  })
  return out
}

/**
 * Returns true if the given LookSettings match the "Current" identity look.
 * When true, shared game renderers run their untouched baseline pipelines for bit-exact parity.
 */
export function isIdentityLook(settings: LookSettings | null | undefined): boolean {
  if (!settings) return true
  const base = LOOK_PRESETS.current.defaults
  if (settings.preset !== "current") return false
  for (const spec of LOOK_PARAM_SPECS) {
    if (spec.key === "grainSeed" || spec.key === "grainAnimated" || spec.key === "bandSoftness" || spec.key === "outlineWidth" || spec.key === "fogHeightFalloff" || spec.key === "shaftSlats" || spec.key === "fogColorR" || spec.key === "fogColorG" || spec.key === "fogColorB") {
      continue
    }
    const a = settings[spec.key]
    const b = base[spec.key]
    if (typeof a === "number" && typeof b === "number") {
      if (Math.abs(a - b) > 1e-4) return false
    } else if (a !== b) {
      return false
    }
  }
  return true
}

function snapLookValue(val: number, spec: LookParamSpec): number {
  const min = spec.min ?? 0
  const max = spec.max ?? 1
  const step = spec.step ?? 0.01
  const clamped = Math.max(min, Math.min(max, val))
  const steps = Math.round((clamped - min) / step)
  return Number(Math.min(max, Math.max(min, min + steps * step)).toPrecision(12))
}

export function resolveLookGroup(raw?: string): LookGroup | "all" | null {
  if (!raw || raw.trim() === "" || raw.trim().toLowerCase() === "all") return "all"
  const q = raw.trim().toLowerCase()
  const slug = q.replace(/[^a-z0-9]+/g, "")
  const map: Record<string, LookGroup> = {
    tone: "Tone & Curve",
    curve: "Tone & Curve",
    tonecurve: "Tone & Curve",
    grade: "Tone & Curve",
    splittone: "Split-Tone & Palette",
    palette: "Split-Tone & Palette",
    splittonepalette: "Split-Tone & Palette",
    lighting: "Lighting & Silhouette",
    silhouette: "Lighting & Silhouette",
    lightingsilhouette: "Lighting & Silhouette",
    atmosphere: "Atmosphere & Shafts",
    shafts: "Atmosphere & Shafts",
    fog: "Atmosphere & Shafts",
    atmosphereshafts: "Atmosphere & Shafts",
    lens: "Lens & Film",
    film: "Lens & Film",
    lensfilm: "Lens & Film",
    painterly: "Painterly & Ink",
    ink: "Painterly & Ink",
    painterlyink: "Painterly & Ink",
  }
  if (slug in map) return map[slug]!
  for (const g of LOOK_GROUPS) {
    if (g.toLowerCase() === q || g.toLowerCase().replace(/[^a-z0-9]+/g, "") === slug) return g
  }
  return null
}

/**
 * Deterministic seeded randomization of a Look parameter group (or all groups),
 * using an isolated `tuningSeed` that never mutates structural room/world seeds.
 */
export function randomizeLookSettings(
  current: LookSettings,
  tuningSeed: number,
  group: LookGroup | "all" = "all",
): LookSettings {
  const groupIdx = group === "all" ? 0 : LOOK_GROUPS.indexOf(group) + 1
  const rng = new Rng(((Math.trunc(tuningSeed) || 1) ^ (groupIdx * 0x9e3779b9)) >>> 0)
  const anchorPreset = isLookPresetId(current.preset) && current.preset !== "current" ? current.preset : "cinematic_dusk"
  const base = LOOK_PRESETS[anchorPreset].defaults
  const next: LookSettings = { ...current }

  for (const spec of LOOK_PARAM_SPECS) {
    if (group !== "all" && spec.group !== group) continue
    if (spec.key === "grainSeed" || spec.type === "toggle") continue
    if (spec.type === "select" && spec.options) {
      const idx = Math.floor(rng.next() * spec.options.length)
      next.tonemap = (spec.options[idx]?.value ?? 0) as LookTonemapMode
      continue
    }
    if (spec.type === "range" && spec.min !== undefined && spec.max !== undefined) {
      const key = spec.key as LookNumericKey
      if (key === "diffuseBands") {
        // Keep diffuseBands at 0 (smooth) unless Painterly group is randomized or preset is painterly
        if (group === "Painterly & Ink" || current.preset === "painterly") {
          next.diffuseBands = rng.next() < 0.25 ? 0 : 2 + Math.floor(rng.next() * 4)
        }
        continue
      }
      const span = spec.max - spec.min
      const center = base[key]
      const spread = key === "blackCrush" ? 0.35 : 0.55
      const raw = center + (rng.next() - 0.5) * span * spread
      next[key] = snapLookValue(raw, spec)
    }
  }
  return next
}

export type LookPresetSchemaV1 = {
  version: 1
  preset: LookPresetId
  tuningSeed: number
  roomSeed: number
  settings: LookSettings
}

export function validateLookSettings(
  input: unknown,
): { ok: true; value: LookSettings } | { ok: false; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "Look settings must be a JSON object." }
  }
  const raw = input as Record<string, unknown>
  const presetId = resolveLookPresetId(raw.preset ?? "current")
  if (!presetId) {
    return { ok: false, error: `Unknown look preset "${String(raw.preset)}".` }
  }
  const out = createLookSettings(presetId)
  for (const spec of LOOK_PARAM_SPECS) {
    if (!(spec.key in raw)) continue
    const v = raw[spec.key]
    if (spec.type === "toggle") {
      if (typeof v !== "boolean") {
        return { ok: false, error: `Parameter "${spec.key}" must be a boolean.` }
      }
      out.grainAnimated = v
      continue
    }
    if (typeof v !== "number" || !Number.isFinite(v)) {
      return { ok: false, error: `Parameter "${spec.key}" must be a finite number.` }
    }
    if (spec.type === "select" && spec.options) {
      if (!spec.options.some(o => o.value === v)) {
        return { ok: false, error: `Invalid option ${v} for "${spec.key}".` }
      }
      out.tonemap = v as LookTonemapMode
      continue
    }
    const min = spec.min ?? 0
    const max = spec.max ?? 1
    if (v < min - 1e-6 || v > max + 1e-6) {
      return { ok: false, error: `Parameter "${spec.key}" (${v}) is outside bounds [${min}, ${max}].` }
    }
    out[spec.key as LookNumericKey] = snapLookValue(v, spec)
  }
  return { ok: true, value: out }
}

export function exportLookPreset(
  settings: LookSettings,
  meta?: { tuningSeed?: number; roomSeed?: number },
): LookPresetSchemaV1 {
  const checked = validateLookSettings(settings)
  if (!checked.ok) throw new Error(checked.error)
  return {
    version: 1,
    preset: checked.value.preset,
    tuningSeed: Math.max(1, Math.min(9999, Math.trunc(meta?.tuningSeed ?? 108))),
    roomSeed: Math.max(1, Math.min(999, Math.trunc(meta?.roomSeed ?? 7))),
    settings: checked.value,
  }
}

export function importLookPreset(
  rawJson: string | unknown,
): { ok: true; value: LookPresetSchemaV1 } | { ok: false; error: string } {
  let parsed: unknown = rawJson
  if (typeof rawJson === "string") {
    try {
      parsed = JSON.parse(rawJson)
    } catch {
      return { ok: false, error: "Invalid JSON syntax." }
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "Look preset must be a JSON object." }
  }
  const obj = parsed as Record<string, unknown>
  if (obj.version !== undefined && obj.version !== 1) {
    return { ok: false, error: `Unsupported look preset version: ${String(obj.version)} (expected 1).` }
  }
  const candidateSettings = (obj.settings && typeof obj.settings === "object" ? obj.settings : obj) as Record<string, unknown>
  const merged = {
    preset: obj.preset ?? candidateSettings.preset ?? "current",
    ...candidateSettings,
  }
  const validated = validateLookSettings(merged)
  if (!validated.ok) return validated
  const tuningSeed = typeof obj.tuningSeed === "number" && Number.isFinite(obj.tuningSeed) ? Math.max(1, Math.min(9999, Math.trunc(obj.tuningSeed))) : 108
  const roomSeed = typeof obj.roomSeed === "number" && Number.isFinite(obj.roomSeed) ? Math.max(1, Math.min(999, Math.trunc(obj.roomSeed))) : 7
  return {
    ok: true,
    value: {
      version: 1,
      preset: validated.value.preset,
      tuningSeed,
      roomSeed,
      settings: validated.value,
    },
  }
}

export function createLookControls(
  settings: Record<string, any>,
  options?: {
    onPresetChange?: (preset: LookPresetId) => void
    onChange?: (key: string, value: number | string | boolean) => void
    onRandomizeGroup?: (group: LookGroup) => void
    includePresetPicker?: boolean
  },
): LabControl[] {
  const controls: LabControl[] = []
  if (options?.includePresetPicker !== false) {
    controls.push({
      key: "preset",
      label: "Look preset",
      group: "Preset",
      type: "select",
      options: LOOK_PRESET_IDS.map(id => ({ value: id, label: LOOK_PRESETS[id].label })),
      change: val => {
        const pid = resolveLookPresetId(val) ?? "current"
        options?.onPresetChange?.(pid)
      },
    })
  }
  for (const group of LOOK_GROUPS) {
    for (const spec of LOOK_PARAM_SPECS) {
      if (spec.group !== group) continue
      if (spec.type === "select" && spec.options) {
        controls.push({
          key: spec.key,
          label: spec.label,
          group: spec.group,
          type: "select",
          options: spec.options,
          change: v => options?.onChange?.(spec.key, v),
        })
      } else if (spec.type === "toggle") {
        controls.push({
          key: spec.key,
          label: spec.label,
          group: spec.group,
          change: v => options?.onChange?.(spec.key, v),
        })
      } else if (spec.type === "range") {
        controls.push({
          key: spec.key,
          label: spec.label,
          group: spec.group,
          type: "range",
          min: spec.min!,
          max: spec.max!,
          step: spec.step,
          unit: spec.unit,
          change: v => options?.onChange?.(spec.key, v),
        })
      }
    }
    if (options?.onRandomizeGroup) {
      const grp = group
      controls.push({
        key: `randomize.${grp}`,
        label: `Randomize ${grp}`,
        group: grp,
        type: "action",
        run: () => options.onRandomizeGroup!(grp),
      })
    }
  }
  void settings
  return controls
}

/**
 * Typed WGSL layout for `LookUniforms` (64 floats / 256 bytes).
 * Replaces manual float offset tables and `LK.u0.x..LK.u15.w` swizzles with named fields.
 */
export const LookUniformsStruct = wgslStruct("LookUniforms", {
  // u0
  exposure: "f32",
  tonemap: "f32",
  contrast: "f32",
  toe: "f32",
  // u1
  shoulder: "f32",
  blackCrush: "f32",
  saturation: "f32",
  temperature: "f32",
  // u2
  splitTone: "f32",
  shadowTintR: "f32",
  shadowTintG: "f32",
  shadowTintB: "f32",
  // u3
  highlightTintR: "f32",
  highlightTintG: "f32",
  highlightTintB: "f32",
  paletteMix: "f32",
  // u4
  ambientFill: "f32",
  shadowColorR: "f32",
  shadowColorG: "f32",
  shadowColorB: "f32",
  // u5
  practicalWarmth: "f32",
  practicalIntensity: "f32",
  moonIntensity: "f32",
  rimStrength: "f32",
  // u6
  contactShade: "f32",
  surfaceWetness: "f32",
  fogDensity: "f32",
  fogHeightFalloff: "f32",
  // u7
  fogColorR: "f32",
  fogColorG: "f32",
  fogColorB: "f32",
  shaftStrength: "f32",
  // u8
  shaftSlats: "f32",
  bloom: "f32",
  halation: "f32",
  vignette: "f32",
  // u9
  grain: "f32",
  grainSeed: "f32",
  grainAnimated: "f32",
  chromatic: "f32",
  // u10
  diffuseWrap: "f32",
  diffuseBands: "f32",
  bandSoftness: "f32",
  painterlySmooth: "f32",
  // u11
  outlineStrength: "f32",
  outlineWidth: "f32",
  foliageShift: "f32",
  activeFlag: "f32",
  // u12 (vec3f at 16B boundary + f32 = 16B)
  paletteWall: "vec3f",
  compareMode: "f32",
  // u13
  paletteWood: "vec3f",
  wipeSplit: "f32",
  // u14
  paletteStone: "vec3f",
  presetIndex: "f32",
  // u15
  paletteFoliage: "vec3f",
  selectiveColor: "f32",
})

export const LOOK_UNIFORM_FLOATS = LookUniformsStruct.floatCount

export function packLookUniforms(
  settings: LookSettings,
  out: Float32Array = LookUniformsStruct.createBuffer(),
  offset = 0,
  extra?: { compareMode?: LookCompareMode; wipeSplit?: number; forceActive?: boolean },
): Float32Array {
  const presetDef = LOOK_PRESETS[settings.preset] ?? LOOK_PRESETS.current
  const pal = getLookPalette(settings)
  const active = extra?.forceActive ? 1 : isIdentityLook(settings) ? 0 : 1
  return LookUniformsStruct.pack(
    {
      exposure: settings.exposure,
      tonemap: settings.tonemap,
      contrast: settings.contrast,
      toe: settings.toe,
      shoulder: settings.shoulder,
      blackCrush: settings.blackCrush,
      saturation: settings.saturation,
      temperature: settings.temperature,
      splitTone: settings.splitTone,
      shadowTintR: settings.shadowTintR,
      shadowTintG: settings.shadowTintG,
      shadowTintB: settings.shadowTintB,
      highlightTintR: settings.highlightTintR,
      highlightTintG: settings.highlightTintG,
      highlightTintB: settings.highlightTintB,
      paletteMix: settings.paletteMix,
      ambientFill: settings.ambientFill,
      shadowColorR: settings.shadowColorR,
      shadowColorG: settings.shadowColorG,
      shadowColorB: settings.shadowColorB,
      practicalWarmth: settings.practicalWarmth,
      practicalIntensity: settings.practicalIntensity,
      moonIntensity: settings.moonIntensity,
      rimStrength: settings.rimStrength,
      contactShade: settings.contactShade,
      surfaceWetness: settings.surfaceWetness,
      fogDensity: settings.fogDensity,
      fogHeightFalloff: settings.fogHeightFalloff,
      fogColorR: settings.fogColorR,
      fogColorG: settings.fogColorG,
      fogColorB: settings.fogColorB,
      shaftStrength: settings.shaftStrength,
      shaftSlats: settings.shaftSlats,
      bloom: settings.bloom,
      halation: settings.halation,
      vignette: settings.vignette,
      grain: settings.grain,
      grainSeed: settings.grainSeed,
      grainAnimated: settings.grainAnimated ? 1 : 0,
      chromatic: settings.chromatic,
      diffuseWrap: settings.diffuseWrap,
      diffuseBands: settings.diffuseBands,
      bandSoftness: settings.bandSoftness,
      painterlySmooth: settings.painterlySmooth,
      outlineStrength: settings.outlineStrength,
      outlineWidth: settings.outlineWidth,
      foliageShift: settings.foliageShift,
      activeFlag: active,
      paletteWall: pal.wall,
      compareMode: extra?.compareMode ?? 1,
      paletteWood: pal.wood,
      wipeSplit: extra?.wipeSplit ?? 0.5,
      paletteStone: pal.stone,
      presetIndex: presetDef.index,
      paletteFoliage: pal.foliage,
      selectiveColor: settings.selectiveColor,
    },
    out as Float32Array<ArrayBuffer>,
    offset,
  )
}

/**
 * Shared WGSL struct and shading/post functions for `LookSettings`.
 * Used by both the Lab "Looks" debug room and Outbreak's opt-in look hook.
 */
export const lookStructWgsl = /* wgsl */ `
${LookUniformsStruct.wgsl}

fn lookQuantizeDiffuse(ndlRaw: f32, wrap: f32, bands: f32, softness: f32) -> f32 {
  let wrapped = clamp((ndlRaw + wrap) / (1.0 + max(wrap, 0.0)), 0.0, 1.0);
  if (bands < 1.5) {
    return wrapped;
  }
  let b = max(2.0, round(bands));
  let scaled = wrapped * b;
  let cell = floor(scaled);
  let f = scaled - cell;
  let s = clamp(softness, 0.02, 0.48);
  return clamp((cell + smoothstep(0.5 - s, 0.5 + s, f)) / b, 0.0, 1.0);
}

fn lookPracticalColor(baseCol: vec3f, warmth: f32) -> vec3f {
  let warmTarget = vec3f(1.05, 0.52, 0.16);
  let coolTarget = vec3f(0.72, 0.88, 1.08);
  if (warmth >= 0.0) {
    return mix(baseCol, warmTarget * length(baseCol) * 0.65, clamp(warmth, 0.0, 1.0));
  }
  return mix(baseCol, coolTarget * length(baseCol) * 0.65, clamp(-warmth, 0.0, 1.0));
}

fn lookTonemapACES(x: vec3f) -> vec3f {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
}

fn lookTonemapFilmic(x: vec3f) -> vec3f {
  let u = x * 1.35;
  let expCh = (u * (1.0 + u * 0.55)) / (vec3f(1.0) + u * (1.0 + u * 0.55));
  let lum = max(dot(x, vec3f(0.2126, 0.7152, 0.0722)), 1e-4);
  let uL = lum * 1.35;
  let expLum = (uL * (1.0 + uL * 0.55)) / (1.0 + uL * (1.0 + uL * 0.55));
  let huePres = clamp(x / lum * expLum, vec3f(0.0), vec3f(1.2));
  let c = mix(expCh, huePres, 0.42);
  let over = max(c - vec3f(0.62), vec3f(0.0));
  return clamp(min(c, vec3f(0.62)) + (vec3f(0.38) * over) / (over + vec3f(0.38)), vec3f(0.0), vec3f(1.0));
}

fn lookTonemapAgX(val: vec3f) -> vec3f {
  let agxMat = mat3x3f(
    0.842479062253094, 0.0423282422610123, 0.0423756549057051,
    0.0784335999999992, 0.878468636469772, 0.0784336,
    0.0792237451477643, 0.0791661274605434, 0.879142973793104
  );
  let agxMatInv = mat3x3f(
    1.19687900512017, -0.0528968517574562, -0.0529716355144438,
    -0.0980208811401368, 1.15190312990417, -0.0980434501171241,
    -0.0990297440797205, -0.0989611768448433, 1.15107367264116
  );
  var v = agxMat * max(val, vec3f(1e-6));
  v = clamp((log2(v) - (-12.47393)) / (4.026069 - (-12.47393)), vec3f(0.0), vec3f(1.0));
  let x2 = v * v;
  let x4 = x2 * x2;
  v = 15.5 * x4 * x2 - 40.14 * x4 * v + 31.96 * x4 - 6.868 * x2 * v + 0.4298 * x2 + 0.1191 * v - 0.00232;
  v = agxMatInv * v;
  return clamp(pow(max(v, vec3f(0.0)), vec3f(2.2)), vec3f(0.0), vec3f(1.0));
}

fn lookApplyTonemap(hdr: vec3f, mode: i32, huePreserve: f32) -> vec3f {
  let x = max(hdr, vec3f(0.0));
  if (mode == 1) {
    return lookTonemapFilmic(x);
  }
  if (mode == 2) {
    return lookTonemapAgX(x);
  }
  let baseAces = lookTonemapACES(x);
  let peak = max(x.r, max(x.g, x.b));
  let hp = select(huePreserve, 0.52, mode == 3);
  return mix(baseAces, x * (lookTonemapACES(vec3f(peak)).r / max(peak, 1e-4)), hp);
}

fn lookHash12(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

fn lookApplyTonemapFast(hdr: vec3f, mode: i32, huePreserve: f32) -> vec3f {
  let x = max(hdr, vec3f(0.0));
  if (mode == 1) {
    return lookTonemapFilmic(x);
  }
  let baseAces = lookTonemapACES(x);
  let peak = max(x.r, max(x.g, x.b));
  let hp = select(huePreserve, 0.52, mode == 3);
  return mix(baseAces, x * (lookTonemapACES(vec3f(peak)).r / max(peak, 1e-4)), hp);
}

fn lookGradeColor(
  L: LookUniforms,
  hdrIn: vec3f,
  bloomIn: vec3f,
  uv: vec2f,
  fragXY: vec2f,
  time: f32,
  shaftLift: f32,
  baseBloomScale: f32,
  baseVignetteFloor: f32,
  baseHuePreserve: f32,
  flashMask: f32,
) -> vec3f {
  let exposure = L.exposure;
  let tonemapMode = i32(round(L.tonemap));
  let contrast = L.contrast;
  let toe = L.toe;
  let shoulder = L.shoulder;
  let blackCrush = L.blackCrush;
  let saturation = L.saturation;
  let temperature = L.temperature;
  let splitTone = L.splitTone;
  let shadowTint = vec3f(L.shadowTintR, L.shadowTintG, L.shadowTintB);
  let highlightTint = vec3f(L.highlightTintR, L.highlightTintG, L.highlightTintB);
  let bloomMult = L.bloom;
  let halation = L.halation;
  let vigStrength = L.vignette;
  let grainStrength = L.grain;
  let grainSeed = L.grainSeed;
  let grainAnim = L.grainAnimated > 0.5;
  let selectiveColor = clamp(L.selectiveColor, 0.0, 1.5);
  let beamRetain = clamp(flashMask * selectiveColor, 0.0, 1.0);

  // 1. Add bloom & warm film halation before tone mapping
  let halationTint = vec3f(1.08, 0.34, 0.10) * halation * 0.28;
  var hdr = hdrIn + bloomIn * (baseBloomScale * bloomMult + halationTint);

  // 2. Exposure & colour temperature in linear HDR (relax cold monochrome shift inside the flashlight beam)
  let effTemp = mix(temperature, max(temperature, 0.06), beamRetain * 0.88);
  hdr *= exposure * vec3f(1.0 + effTemp * 0.24, 1.0 + effTemp * 0.03, 1.0 - effTemp * 0.24);
  hdr = max(hdr, vec3f(0.0));

  // 3. Mid-grey contrast curve around 0.18 (Lamplight post.wgsl)
  if (abs(contrast - 1.0) > 0.001) {
    let hLum = max(dot(hdr, vec3f(0.2126, 0.7152, 0.0722)), 1e-4);
    hdr *= pow(hLum / 0.18, contrast - 1.0);
  }

  // 4. Tonemap (Current ACES / Filmic / AgX / ACES Hue-Preserving)
  var c = lookApplyTonemap(hdr, tonemapMode, max(baseHuePreserve, beamRetain * 0.45));

  // 5. Highlight shoulder compression
  if (shoulder > 0.001) {
    let knee = 1.0 - shoulder * 0.45;
    let invSpan = 1.0 / max(1.0 - knee, 0.06);
    let over = max(c - vec3f(knee), vec3f(0.0)) * invSpan;
    let comp = min(c, vec3f(knee)) + (1.0 - knee) * (over / (vec3f(1.0) + over));
    c = mix(c, comp, clamp(shoulder, 0.0, 1.0));
  }

  // 6. Shadow toe curve (Lamplight paper.wgsl)
  let effToe = toe * (1.0 - 0.65 * beamRetain);
  if (effToe > 0.001) {
    let toeK = effToe * 0.055;
    let t = c * c / max(c + vec3f(toeK), vec3f(1e-5));
    c = mix(c, t * (1.0 + toeK * 0.5), clamp(effToe * 0.75, 0.0, 0.85));
  }

  // 7. Split-toning & light-driven selective colour restoration (per-pixel flashlight irradiance mask from scene pass)
  let luma = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  let splitCurve = mix(shadowTint, highlightTint, smoothstep(0.02, 0.55, luma));
  let activeSplit = mix(vec3f(1.0), splitCurve, clamp(splitTone, 0.0, 1.5));
  let mono = vec3f(luma) * activeSplit;
  let warmBias = clamp((hdrIn.r - hdrIn.b * 1.05) / max(hdrIn.r + 0.005, 1e-4) - 0.08, 0.0, 1.0) * clamp(L.practicalWarmth * 1.6, 0.0, 1.0);
  let warmTinted = c * mix(activeSplit, vec3f(1.18, 0.88, 0.52), warmBias * 0.65);
  let effSat = mix(saturation, max(saturation, 0.88), warmBias * 0.82);
  let outsideCol = mix(mono, warmTinted, effSat);
  if (beamRetain > 0.001) {
    let beamSplit = mix(activeSplit, vec3f(1.05, 1.00, 0.94), beamRetain * 0.92);
    let beamSat = clamp(max(saturation, 1.15 * min(selectiveColor, 1.35)), 0.0, 1.55);
    let beamCol = mix(vec3f(luma) * beamSplit, c * beamSplit, beamSat);
    c = mix(outsideCol, beamCol, beamRetain);
  } else {
    c = outsideCol;
  }

  // 8. Black crush (carves deep shadows to near-black while keeping dim moonlight & lit beams intact)
  let effCrush = blackCrush * (1.0 - 0.8 * beamRetain);
  if (effCrush > 0.0005) {
    let linearCrush = effCrush * 0.045;
    c = max(vec3f(0.0), (c - vec3f(linearCrush)) / max(1.0 - linearCrush, 0.1));
  }

  // 9. Optical lens vignette
  let fromC = (uv - 0.5) * vec2f(1.0, 0.82);
  let vDist = length(fromC);
  let baseVig = mix(1.0, baseVignetteFloor, smoothstep(0.32, 0.85, vDist));
  let extraVig = 1.0 - clamp(vigStrength * 0.65, 0.0, 0.92) * smoothstep(0.20, 0.84, vDist);
  c *= baseVig * extraVig;

  // 10. Seeded dual-scale triangular film grain in midtones & light shafts
  if (grainStrength > 0.001) {
    let timeSalt = select(0.0, floor(time * 24.0) * 19.37, grainAnim);
    let seedVec = vec2f(grainSeed * 1.13 + timeSalt, grainSeed * 2.71 - timeSalt * 0.63);
    let finePx = floor(fragXY * 0.9) + seedVec;
    let grainVal = lookHash12(finePx) + lookHash12(finePx * 0.5 + vec2f(53.0, 91.0)) - 1.0;
    let midMask = smoothstep(0.004, 0.12, luma) * (1.0 - smoothstep(0.75, 1.0, luma));
    let amp = (0.026 + 0.024 * shaftLift) * grainStrength * (0.25 + 0.75 * midMask);
    c = max(vec3f(0.0), c + vec3f(grainVal * amp * max(luma * 2.2, 0.18)));
  }

  return clamp(c, vec3f(0.0), vec3f(1.0));
}
`
