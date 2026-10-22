import type { LabControl } from "../lab-navigation"
import type { BeamProfile } from "../gpu/lights/beam"
import type { QualityScaling, QualityTier, QualityTiers } from "../quality"

/**
 * Every look choice of the night forest, typed, with units and approved defaults (RESEARCH.md's starting values). The
 * Lab binds these to its panel (`forestLookControls`); a game keeps the defaults and only scales them by tier.
 */
export type ForestLookSettings = {
  // Night sky
  /** Faint moonlight through the canopy (0 = moonless). */
  moon: number
  moonHeading: number
  moonElevation: number
  /** Airglow and horizon light pollution: what keeps a moonless sky readable above the crowns. */
  sky: number
  stars: number
  /** Skylight that reaches the forest floor through the canopy. */
  skylight: number
  // Fog and mist
  fogDensity: number
  fogFalloff: number
  /** Linear luminance of fully fogged distance (the sky glow the mist carries). */
  fogBrightness: number
  fogHue: number
  mist: "off" | "drift"
  mistDensity: number
  /** Mist top above the hollows' floor (m). */
  mistHeight: number
  mistScale: number
  mistDrift: number
  mistGaps: number
  /** Your own beam's near field in the air (m): within it the scattered light levels off instead of climbing to the lens. */
  beamNear: number
  /** How much the canopy dims the mist's own glow (the sky it scatters is blocked as for surfaces): 0 off, 1 physical. */
  canopyMist: number
  /** Isotropic share of the beams' phase: how much your own beam (seen from behind, as backscatter) glows. */
  phaseFloor: number
  /** Henyey–Greenstein g of the mist: how much brighter a beam reads looking along it (fog droplets ≈ 0.75–0.85). */
  phaseG: number
  /** Lamp light scattered in the air (share of the physical ratio; 1 is physical). */
  beamAir: number
  /** Share of the mist bank's own scattering the beams get (1 is physical). */
  beamMist: number
  /** Thin torch in-scatter within 8 m of the eye; compensate by −0.25 stop only while your torch is on. */
  clearAir: boolean
  /** Extra distance extinction beyond the clear near field, forest volume only. */
  depthMist: boolean
  depthDensity: number
  depthStart: number
  // Flashlight
  torchPower: number
  /** Outer half-angle of the main beam (deg). */
  torchAngle: number
  torchKelvin: number
  torchReach: number
  torchCore: number
  torchCoreWidth: number
  torchRings: number
  torchSpill: number
  torchSpillWidth: number
  /** Where the lens sits relative to the eye (m): right, down. */
  torchSide: number
  torchDrop: number
  /** How far the beam trails the view (s): the hand lags the head. */
  torchLag: number
  /** Near-field bounce of the beam's hit point onto its surroundings. */
  bounce: number
  torchShadows: "off" | "map"
  /** Ferns and needle sprays cast cut-out shadows from the torch. */
  foliageShadows: boolean
  shadowSize: 512 | 1024 | 2048
  /** Shadowed shafts in the air (the torch's light stops behind trunks in the mist). */
  shafts: boolean
  motes: number
  // Wind
  wind: number
  gust: number
  trunkSway: number
  branchSway: number
  flutter: number
  // Floor
  fernDensity: number
  litter: number
  moss: number
  // Camp and water
  windows: number
  stringLights: number
  water: number
  // Camera
  exposure: number
  autoExposure: boolean
  exposureModel: "metered" | "robust"
  /** Scene-referred luminance at the fixed night exposure; the adaptive term is relative to this. */
  nightKey: number
  nightStops: number
  nightStrength: number
  /** Maximum lift above the fixed exposure, independent of the stop-down limit. */
  adaptLift: number
  /** Calibration gain on the scene-referred meter; higher stops down more. */
  meterGain: number
  /** Night-model time constants (63% response), in seconds. Centre meter always uses 0.35/1.8 s. */
  adaptDarken: number
  adaptBrighten: number
  /** Maximum stop-down below the base, in stops; adaptLift independently bounds opening. */
  adaptRange: number
  /** Sensor noise in the dark, as 1/255 at midtones; it grows with the exposure gain. */
  noise: number
  chromaNoise: number
  vignette: number
  /** Lateral chromatic aberration at the corners (px). */
  aberration: number
  bloom: number
  /** Red halo round hot sources (film/sensor halation). */
  halation: number
  /** Veiling glare: a little of every hot source's light lifts the whole frame. */
  glare: number
}

export const FOREST_LOOK_DEFAULTS: Readonly<ForestLookSettings> = {
  moon: 0.06, moonHeading: 220, moonElevation: 34, sky: 1, stars: 1, skylight: 1,
  fogDensity: 0.008, fogFalloff: 0.02, fogBrightness: 0.0035, fogHue: 215,
  mist: "drift", mistDensity: 0.08, mistHeight: 2.4, canopyMist: 1, beamNear: 0.6, mistScale: 9, mistDrift: 0.15, mistGaps: 0.32, phaseG: 0.75, phaseFloor: 0.03, beamAir: 1, beamMist: 1,
  clearAir: true,
  depthMist: true, depthDensity: 0.05, depthStart: 12,
  torchPower: 70, torchAngle: 17, torchKelvin: 6000, torchReach: 40, torchCore: 0.9, torchCoreWidth: 0.42, torchRings: 0.35, torchSpill: 0.03, torchSpillWidth: 2.4,
  torchSide: 0.3, torchDrop: 0.28, torchLag: 0.07, bounce: 1, torchShadows: "map", foliageShadows: true, shadowSize: 1024, shafts: true, motes: 1,
  wind: 1, gust: 0.6, trunkSway: 1, branchSway: 1, flutter: 1,
  fernDensity: 1, litter: 1, moss: 1,
  windows: 1, stringLights: 1, water: 1,
  exposure: 1.6, autoExposure: true, meterGain: 3, adaptDarken: 0.8, adaptBrighten: 6, adaptRange: 1.5,
  exposureModel: "robust", nightKey: 0.003, nightStops: 0.8, nightStrength: 0.85, adaptLift: 0.8,
  noise: 1, chromaNoise: 0.35, vignette: 0.35, aberration: 0.6, bloom: 0.22, halation: 0.12, glare: 0.5,
}

export const createForestLookSettings = (o: Partial<ForestLookSettings> = {}): ForestLookSettings => ({ ...FOREST_LOOK_DEFAULTS, ...o })

/** Beam profile of the torch from the look settings (`lights/beam.ts`), shared by surfaces and the air. */
export const torchProfile = (s: ForestLookSettings): BeamProfile => ({ inner: 0.55, core: s.torchCore, coreWidth: s.torchCoreWidth, spill: s.torchSpill, spillWidth: s.torchSpillWidth, rings: s.torchRings })

/** Linear sRGB of a blackbody at `k` kelvin (Tanner Helland's fit), normalised to luminance 1. */
export function kelvinColor(k: number): [number, number, number] {
  const t = k / 100
  const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592)
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492)
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307
  const lin = [r, g, b].map(v => Math.pow(Math.max(0, Math.min(255, v)) / 255, 2.2)) as [number, number, number]
  const l = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
  return [lin[0] / l, lin[1] / l, lin[2] / l]
}

export function forestLookControls(settings: ForestLookSettings, prefix = "woods."): LabControl[] {
  const range = (k: keyof ForestLookSettings, label: string, group: string, min: number, max: number, step: number, unit?: string, subsection?: string): LabControl =>
    ({ key: prefix + k, field: k, label, group, min, max, step, ...(unit ? { unit } : {}), ...(subsection ? { subsection } : {}) })
  const toggle = (k: keyof ForestLookSettings, label: string, group: string, subsection?: string): LabControl => ({ key: prefix + k, field: k, label, group, type: "toggle", ...(subsection ? { subsection } : {}) })
  const select = (k: keyof ForestLookSettings, label: string, group: string, options: readonly { value: string | number; label: string }[], subsection?: string): LabControl =>
    ({ key: prefix + k, field: k, label, group, type: "select", options, ...(subsection ? { subsection } : {}) })
  const T = "Flashlight", N = "Night", F = "Mist", W = "Wind", C = "Camera", G = "Forest floor", K = "Camp"
  return [
    range("torchPower", "Beam intensity", T, 0, 200, 1, "cd×"),
    range("torchAngle", "Beam half-angle", T, 6, 35, 0.5, "°"),
    range("torchKelvin", "Colour temperature", T, 3000, 6500, 50, "K"),
    range("torchReach", "Reach", T, 10, 70, 1, "m"),
    range("bounce", "Near-field bounce", T, 0, 3, 0.05, "×"),
    select("torchShadows", "Torch shadows", T, [{ value: "map", label: "Shadow map" }, { value: "off", label: "Off" }]),
    toggle("shafts", "Shafts in the mist", T),
    toggle("foliageShadows", "Fern and needle shadows", T),
    select("shadowSize", "Shadow map size", T, [512, 1024, 2048].map(v => ({ value: v, label: String(v) }))),
    range("motes", "Motes and insects", T, 0, 3, 0.05, "×"),
    range("torchCore", "Hot spot", T, 0, 3, 0.05, "×", "Beam profile"),
    range("torchCoreWidth", "Hot spot width", T, 0.1, 1, 0.01, "×", "Beam profile"),
    range("torchRings", "Reflector rings", T, 0, 1.5, 0.05, "", "Beam profile"),
    range("torchSpill", "Spill level", T, 0, 0.2, 0.005, "", "Beam profile"),
    range("torchSpillWidth", "Spill width", T, 1, 4, 0.05, "×", "Beam profile"),
    range("torchSide", "Lens offset right", T, 0, 0.6, 0.01, "m", "Hand"),
    range("torchDrop", "Lens offset down", T, 0, 0.6, 0.01, "m", "Hand"),
    range("torchLag", "Beam lag", T, 0, 0.3, 0.005, "s", "Hand"),
    range("moon", "Moonlight", N, 0, 1, 0.01, "×"),
    range("sky", "Sky glow", N, 0, 3, 0.05, "×"),
    range("stars", "Stars", N, 0, 3, 0.05, "×"),
    range("skylight", "Skylight on the floor", N, 0, 3, 0.05, "×"),
    range("moonHeading", "Moon heading", N, 0, 360, 1, "°", "Moon"),
    range("moonElevation", "Moon elevation", N, 5, 85, 1, "°", "Moon"),
    select("mist", "Mist pockets", F, [{ value: "drift", label: "Drifting in hollows" }, { value: "off", label: "Off" }]),
    toggle("clearAir", "Clear air near you", F),
    toggle("depthMist", "Dark distance mist", F),
    range("depthDensity", "Distance extinction", F, 0, 0.15, 0.005, "/m"),
    range("depthStart", "Clear distance", F, 4, 25, 1, "m"),
    range("fogDensity", "Air density", F, 0, 0.03, 0.0005, "/m"),
    range("mistDensity", "Mist density", F, 0, 0.15, 0.002, "/m"),
    range("mistHeight", "Mist height", F, 0.3, 6, 0.1, "m"),
    range("beamAir", "Beam in the air", F, 0, 1.5, 0.01, "×"),
    range("beamMist", "Beam in the mist", F, 0, 3, 0.05, "×"),
    range("phaseG", "Forward scattering", F, 0, 0.9, 0.01, "g"),
    range("phaseFloor", "Backscatter floor", F, 0, 0.5, 0.01, "share"),
    range("canopyMist", "Canopy dims the mist", F, 0, 1, 0.05),
    range("beamNear", "Beam near field", F, 0.1, 4, 0.1, "m"),
    range("fogBrightness", "Mist glow", F, 0, 0.03, 0.0005, "", "Advanced"),
    range("fogHue", "Mist hue", F, 0, 360, 1, "°", "Advanced"),
    range("fogFalloff", "Height falloff", F, 0, 0.2, 0.005, "/m", "Advanced"),
    range("mistScale", "Billow size", F, 2, 30, 0.5, "m", "Advanced"),
    range("mistDrift", "Drift speed", F, 0, 1, 0.01, "m/s", "Advanced"),
    range("mistGaps", "Gaps between billows", F, 0, 0.9, 0.01, "", "Advanced"),
    range("wind", "Wind", W, 0, 3, 0.05, "×"),
    range("gust", "Gusts", W, 0, 2, 0.05, "×"),
    range("trunkSway", "Trunk sway", W, 0, 3, 0.05, "×"),
    range("branchSway", "Branch sway", W, 0, 3, 0.05, "×"),
    range("flutter", "Needle flutter", W, 0, 3, 0.05, "×"),
    range("fernDensity", "Ferns", G, 0, 2, 0.05, "×"),
    range("litter", "Twigs and litter", G, 0, 2, 0.05, "×"),
    range("moss", "Moss", G, 0, 2, 0.05, "×"),
    range("windows", "Lit windows", K, 0, 3, 0.05, "×"),
    range("stringLights", "String lights", K, 0, 3, 0.05, "×"),
    range("water", "Lake reflections", K, 0, 2, 0.05, "×"),
    range("exposure", "Exposure", C, 0.2, 6, 0.05, "×"),
    toggle("autoExposure", "Auto exposure", C),
    select("exposureModel", "Exposure model", C, [{ value: "metered", label: "Centre meter" }, { value: "robust", label: "Night log mean" }], "Auto exposure"),
    range("nightKey", "Night key", C, 0.001, 0.05, 0.001, "linear", "Auto exposure"),
    range("nightStops", "Night offset", C, -2, 2, 0.05, "stops", "Auto exposure"),
    range("nightStrength", "Adaptation strength", C, 0, 1, 0.05, "×", "Auto exposure"),
    range("adaptLift", "Maximum lift", C, 0, 3, 0.05, "stops", "Auto exposure"),
    range("meterGain", "Meter gain", C, 0.1, 10, 0.05, "×", "Auto exposure"),
    { ...range("adaptDarken", "Night stop-down response", C, 0.05, 5, 0.05, "s", "Auto exposure"), enabled: () => settings.exposureModel === "robust" },
    { ...range("adaptBrighten", "Night opening response", C, 0.2, 20, 0.1, "s", "Auto exposure"), enabled: () => settings.exposureModel === "robust" },
    range("adaptRange", "Maximum stop-down", C, 0, 3, 0.1, "stops", "Auto exposure"),
    range("noise", "Sensor noise", C, 0, 3, 0.05, "/255", "Sensor"),
    range("chromaNoise", "Colour noise", C, 0, 1, 0.05, "", "Sensor"),
    range("vignette", "Vignette", C, 0, 1, 0.01, "", "Lens"),
    range("aberration", "Chromatic aberration", C, 0, 3, 0.05, "px", "Lens"),
    range("bloom", "Bloom", C, 0, 1, 0.01, "", "Lens"),
    range("halation", "Halation", C, 0, 1, 0.01, "", "Lens"),
    range("glare", "Veiling glare", C, 0, 2, 0.05, "×", "Lens"),
  ]
}

/** What each quality tier draws (`packages/kit/quality.ts`): resolution, then the forest's own expensive parts. */
export interface ForestQuality extends QualityScaling {
  /** Texture-array layer size (base and normal; ORM is half). */
  readonly textureSize: 512 | 1024
  readonly shadowSize: 512 | 1024 | 2048
  readonly foliageShadows: boolean
  /** Fog march samples per lamp and mist steps. */
  readonly fogSamples: number
  readonly mistSteps: number
  /** Full-detail tree distance (m); simplified models beyond, fog silhouettes past `far`. */
  readonly near: number
  readonly far: number
  /** Full-detail fern distance (m); a lighter clump beyond. */
  readonly fernNear: number
  /** Share of the fern and litter scatter that is drawn. */
  readonly scatter: number
  readonly bloomLevels: number
}

export const FOREST_QUALITY: QualityTiers<ForestQuality> = {
  high: { tier: "high", label: "High", dprCap: 1.5, minScale: 0.7, textureSize: 1024, shadowSize: 2048, foliageShadows: true, fogSamples: 8, mistSteps: 8, near: 35, far: 140, fernNear: 14, scatter: 1, bloomLevels: 5 },
  balanced: { tier: "balanced", label: "Balanced", dprCap: 1.25, minScale: 0.65, textureSize: 1024, shadowSize: 1024, foliageShadows: true, fogSamples: 6, mistSteps: 6, near: 28, far: 120, fernNear: 10, scatter: 0.8, bloomLevels: 5 },
  low: { tier: "low", label: "Low", dprCap: 1, minScale: 0.6, textureSize: 512, shadowSize: 512, foliageShadows: false, fogSamples: 4, mistSteps: 4, near: 20, far: 90, fernNear: 7, scatter: 0.5, bloomLevels: 4 },
}
export const forestQuality = (tier: QualityTier): ForestQuality => FOREST_QUALITY[tier]
