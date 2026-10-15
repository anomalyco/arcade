import {
  LOOK_PRESETS,
  blendLookSettings3,
  type LookSettings,
} from "@arcade/kit/look"
import { dayCycle, type DayCyclePhase } from "../shared/day-cycle"
import type { FogOfWarSettings } from "./fog-of-war"
import { OUTBREAK_LOOK_LIGHTING_PRESETS, type OutbreakLightingSettings } from "./lighting"

/**
 * Calm, readable afternoon look (anchored on `cozy_golden_hour` with Filmic Lamplight tonemapping
 * so Day -> Dusk -> Noir Night never switches tonemapper shaders).
 */
export const OUTBREAK_DAY_LOOK: Readonly<LookSettings> = {
  ...LOOK_PRESETS.cozy_golden_hour.defaults,
  preset: "cozy_golden_hour",
  tonemap: 1,
  exposure: 1.08,
  contrast: 1.06,
  toe: 0.10,
  shoulder: 0.24,
  blackCrush: 0.001,
  saturation: 0.96,
  temperature: 0.14,
  splitTone: 0.22,
  paletteMix: 0.18,
  selectiveColor: 0.0,
  foliageShift: 0.08,
  ambientFill: 1.32,
  practicalWarmth: 0.35,
  practicalIntensity: 0.85,
  moonIntensity: 1.18,
  rimStrength: 0.28,
  contactShade: 0.35,
  surfaceWetness: 0.08,
  fogDensity: 0.04,
  fogHeightFalloff: 2.6,
  shaftStrength: 0.20,
  bloom: 0.32,
  halation: 0.14,
  vignette: 0.18,
  grain: 0,
  chromatic: 0.06,
}

/**
 * Dusk / dawn transition look (anchored on `cinematic_dusk`): colour drains from the world,
 * practicals switch on with warm amber pools, directional shadows lengthen, and flashlight
 * selective colour begins taking over.
 */
export const OUTBREAK_DUSK_LOOK: Readonly<LookSettings> = {
  ...LOOK_PRESETS.cinematic_dusk.defaults,
  preset: "cinematic_dusk",
  tonemap: 1,
  exposure: 1.04,
  contrast: 1.22,
  toe: 0.24,
  shoulder: 0.30,
  blackCrush: 0.005,
  saturation: 0.56,
  temperature: 0.04,
  splitTone: 0.58,
  paletteMix: 0.32,
  selectiveColor: 0.68,
  foliageShift: -0.04,
  ambientFill: 0.90,
  practicalWarmth: 0.62,
  practicalIntensity: 1.38,
  moonIntensity: 1.08,
  rimStrength: 0.78,
  contactShade: 0.58,
  surfaceWetness: 0.28,
  fogDensity: 0.20,
  fogHeightFalloff: 1.75,
  shaftStrength: 0.78,
  bloom: 0.52,
  halation: 0.28,
  vignette: 0.44,
  grain: 0,
  chromatic: 0.14,
}

/** Full Noir night look: a muted, warm-grey world where received light restores colour. */
export const OUTBREAK_NIGHT_LOOK: Readonly<LookSettings> = {
  ...LOOK_PRESETS.noir.defaults,
}

export type DayNightLightingCurve = Omit<OutbreakLightingSettings, "lighting" | "actorLampShadow">

export const OUTBREAK_DAY_LIGHTING: Readonly<DayNightLightingCurve> = {
  exposure: 1.08,
  skyFill: 1.12,
  moonFill: 1.22,
  practicalWarmth: 0.86,
  porchPower: 0.68,
  windowPower: 0.78,
  roomPower: 0.82,
  streetPower: 0.55,
  lightFalloff: 0.96,
  flashlightHaze: 0.22,
  wetSpecular: 0.30,
  rimStrength: 0.45,
  vignetteDarkness: 0.14,
  streetAirHaze: 0.25,
}

export const OUTBREAK_DUSK_LIGHTING: Readonly<DayNightLightingCurve> = {
  exposure: 1.04,
  skyFill: 0.68,
  moonFill: 1.02,
  practicalWarmth: 0.88,
  porchPower: 0.92,
  windowPower: 0.98,
  roomPower: 0.85,
  streetPower: 0.96,
  lightFalloff: 1.08,
  flashlightHaze: 0.78,
  wetSpecular: 0.68,
  rimStrength: 0.92,
  vignetteDarkness: 0.36,
  streetAirHaze: 1.35,
}

export const OUTBREAK_NIGHT_LIGHTING: Readonly<DayNightLightingCurve> = {
  exposure: OUTBREAK_LOOK_LIGHTING_PRESETS.noir.exposure ?? 1.03,
  skyFill: OUTBREAK_LOOK_LIGHTING_PRESETS.noir.skyFill ?? 0.40,
  moonFill: OUTBREAK_LOOK_LIGHTING_PRESETS.noir.moonFill ?? 0.90,
  practicalWarmth: OUTBREAK_LOOK_LIGHTING_PRESETS.noir.practicalWarmth ?? 0.0,
  porchPower: OUTBREAK_LOOK_LIGHTING_PRESETS.noir.porchPower ?? 0.36,
  windowPower: OUTBREAK_LOOK_LIGHTING_PRESETS.noir.windowPower ?? 0.38,
  roomPower: OUTBREAK_LOOK_LIGHTING_PRESETS.noir.roomPower ?? 0.56,
  streetPower: OUTBREAK_LOOK_LIGHTING_PRESETS.noir.streetPower ?? 0.12,
  lightFalloff: OUTBREAK_LOOK_LIGHTING_PRESETS.noir.lightFalloff ?? 1.38,
  flashlightHaze: OUTBREAK_LOOK_LIGHTING_PRESETS.noir.flashlightHaze ?? 1.38,
  wetSpecular: OUTBREAK_LOOK_LIGHTING_PRESETS.noir.wetSpecular ?? 0.85,
  rimStrength: OUTBREAK_LOOK_LIGHTING_PRESETS.noir.rimStrength ?? 1.45,
  vignetteDarkness: OUTBREAK_LOOK_LIGHTING_PRESETS.noir.vignetteDarkness ?? 0.58,
  streetAirHaze: 1.0,
}

/** Unknown-area grain and sound ripples are off-by-default Lab options, so the cycle leaves them alone. */
export type DayNightFogCurve = Pick<FogOfWarSettings, "fogEdgeSoftness" | "fogMemoryDim" | "fogGhostDuration"> & { shroud: number }

export const OUTBREAK_DAY_FOG: Readonly<DayNightFogCurve> = {
  fogEdgeSoftness: 1.08,
  fogMemoryDim: 0.72,
  fogGhostDuration: 2.0,
  shroud: 0.40,
}

export const OUTBREAK_DUSK_FOG: Readonly<DayNightFogCurve> = {
  fogEdgeSoftness: 0.92,
  fogMemoryDim: 0.56,
  fogGhostDuration: 2.6,
  shroud: 0.35,
}

export const OUTBREAK_NIGHT_FOG: Readonly<DayNightFogCurve> = {
  fogEdgeSoftness: 0.78,
  fogMemoryDim: 0.5,
  fogGhostDuration: 3.2,
  shroud: 0.32,
}

const LIGHTING_KEYS: readonly (keyof DayNightLightingCurve)[] = [
  "exposure",
  "skyFill",
  "moonFill",
  "practicalWarmth",
  "porchPower",
  "windowPower",
  "roomPower",
  "streetPower",
  "lightFalloff",
  "flashlightHaze",
  "wetSpecular",
  "rimStrength",
  "vignetteDarkness",
  "streetAirHaze",
]

const FOG_KEYS: readonly (keyof DayNightFogCurve)[] = [
  "fogEdgeSoftness",
  "fogMemoryDim",
  "fogGhostDuration",
  "shroud",
]

export type OutbreakDayNightEvaluation = {
  hour: number
  phase: DayCyclePhase
  darkness: number
  threat: number
  sun: number
  twilight: number
  lamps: number
  look: LookSettings
  lighting: DayNightLightingCurve
  fog: DayNightFogCurve
}

/**
 * Evaluates Outbreak's continuous Day -> Dusk -> Noir Night look, lighting, fog-of-war, and threat
 * curve at any `hour` in [0, 24).
 */
export function evaluateOutbreakDayNight(
  hour: number,
  outLook: LookSettings = { ...OUTBREAK_NIGHT_LOOK },
): OutbreakDayNightEvaluation {
  const day = dayCycle(hour)
  const d = Math.max(0, Math.min(1, day.darkness))
  const wDusk = 4 * d * (1 - d)
  const rem = 1 - wDusk
  const wDay = (1 - d) * rem
  const wNight = d * rem

  blendLookSettings3(OUTBREAK_DAY_LOOK, OUTBREAK_DUSK_LOOK, OUTBREAK_NIGHT_LOOK, d, outLook)

  const lighting = {} as DayNightLightingCurve
  for (let i = 0; i < LIGHTING_KEYS.length; i++) {
    const k = LIGHTING_KEYS[i]!
    lighting[k] = OUTBREAK_DAY_LIGHTING[k] * wDay + OUTBREAK_DUSK_LIGHTING[k] * wDusk + OUTBREAK_NIGHT_LIGHTING[k] * wNight
  }

  const fog = {} as DayNightFogCurve
  for (let i = 0; i < FOG_KEYS.length; i++) {
    const k = FOG_KEYS[i]!
    fog[k] = OUTBREAK_DAY_FOG[k] * wDay + OUTBREAK_DUSK_FOG[k] * wDusk + OUTBREAK_NIGHT_FOG[k] * wNight
  }

  return {
    hour,
    phase: day.phase,
    darkness: day.darkness,
    threat: day.threat,
    sun: day.sun,
    twilight: day.twilight,
    lamps: day.lamps,
    look: outLook,
    lighting,
    fog,
  }
}

/**
 * Applies the continuous Day -> Dusk -> Noir Night look, lighting, and fog-of-war parameters in-place
 * while preserving user-selected `fogStyle`.
 */
export function applyOutbreakDayNight(
  hour: number,
  lookSettings: LookSettings,
  settings: {
    lighting?: Partial<OutbreakLightingSettings>
    fog?: Partial<FogOfWarSettings>
    vision?: { shroud?: number }
  } & Record<string, any>,
): OutbreakDayNightEvaluation {
  const evalOut = evaluateOutbreakDayNight(hour, lookSettings)
  const lightingTarget =
    settings.lighting && typeof settings.lighting === "object" ? (settings.lighting as Record<string, any>) : settings
  const fogTarget =
    settings.fog && typeof settings.fog === "object" ? (settings.fog as Record<string, any>) : settings
  const visionTarget =
    settings.vision && typeof settings.vision === "object" ? (settings.vision as Record<string, any>) : settings
  for (let i = 0; i < LIGHTING_KEYS.length; i++) {
    const k = LIGHTING_KEYS[i]!
    lightingTarget[k] = evalOut.lighting[k]
  }
  fogTarget.fogEdgeSoftness = evalOut.fog.fogEdgeSoftness
  fogTarget.fogMemoryDim = evalOut.fog.fogMemoryDim
  fogTarget.fogGhostDuration = evalOut.fog.fogGhostDuration
  visionTarget.shroud = evalOut.fog.shroud
  return evalOut
}
