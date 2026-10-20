import {
  LOOK_PRESETS,
  blendLookSettings3,
  type LookSettings,
} from "@arcade/kit/look"
import { curveText, parseCurve, sameCurve, sampleCurve, type CurvePoint } from "@arcade/kit/ramps"
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

export type DayNightLightingCurve = Omit<OutbreakLightingSettings, "lighting" | "actorLampShadow" | "lampFalloffCurve">

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
  // Street lamps hold dusk's power through the night. Noir's 0.12 dimmed them 8× as night fell (power 0.03, a tenth
  // of a porch light) and dropped below the sodium ground pool's 0.2 gate, so lit lamps left the ground dark.
  streetPower: 0.96,
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

/** The cycle's convex Day/Dusk/Night weights at clamped darkness `d` (the same blend `blendLookSettings3` uses). */
function weights(d: number) {
  const wDusk = 4 * d * (1 - d)
  const rem = 1 - wDusk
  return { wDay: (1 - d) * rem, wDusk, wNight: d * rem }
}

/**
 * Values the Lab can reshape as curves over darkness (x: 0 day, 0.5 dusk, 1 night). Each default is the Day/Dusk/Night
 * blend sampled at nine points, and while a curve still reads as its default the cycle uses the exact blend, so an
 * untouched curve changes nothing.
 */
export const DAY_NIGHT_CURVES = {
  skyFillCurve: { label: "Sky fill by darkness", unit: "×", range: [0, 1.5] as const, field: "skyFill" },
  moonFillCurve: { label: "Moon fill by darkness", unit: "×", range: [0, 2] as const, field: "moonFill" },
  streetAirHazeCurve: { label: "Street air haze by darkness", unit: "×", range: [0, 2] as const, field: "streetAirHaze" },
} satisfies Record<string, { label: string; unit: string; range: readonly [number, number]; field: keyof DayNightLightingCurve }>
export type DayNightCurveKey = keyof typeof DAY_NIGHT_CURVES
export type DayNightCurveSettings = Record<DayNightCurveKey, string>
export const DAY_NIGHT_CURVE_KEYS = Object.keys(DAY_NIGHT_CURVES) as DayNightCurveKey[]

const defaultPoints = (key: DayNightCurveKey): CurvePoint[] => {
  const { field } = DAY_NIGHT_CURVES[key]
  const [day, dusk, night] = [OUTBREAK_DAY_LIGHTING[field], OUTBREAK_DUSK_LIGHTING[field], OUTBREAK_NIGHT_LIGHTING[field]]
  return Array.from({ length: 9 }, (_, i) => {
    const { wDay, wDusk, wNight } = weights(i / 8)
    return { x: i / 8, y: day * wDay + dusk * wDusk + night * wNight }
  })
}

export const DEFAULT_DAY_NIGHT_CURVES: Readonly<DayNightCurveSettings> = Object.fromEntries(
  DAY_NIGHT_CURVE_KEYS.map(key => [key, curveText(defaultPoints(key), { range: DAY_NIGHT_CURVES[key].range })]),
) as DayNightCurveSettings

const DEFAULT_POINTS = Object.fromEntries(
  DAY_NIGHT_CURVE_KEYS.map(key => [key, parseCurve(DEFAULT_DAY_NIGHT_CURVES[key], [], { range: DAY_NIGHT_CURVES[key].range })]),
) as Record<DayNightCurveKey, readonly CurvePoint[]>

/** Reshaped curves by key, only those that differ from their default. */
export type DayNightCurveOverrides = Partial<Record<DayNightCurveKey, readonly CurvePoint[]>>
const overrideCache = new Map<DayNightCurveKey, { text: unknown; points: readonly CurvePoint[] | null }>()

/** The curves in `settings` (JSON text) that differ from their default, parsed once per change. */
export function dayNightCurveOverrides(settings: Partial<Record<DayNightCurveKey, unknown>> | undefined): DayNightCurveOverrides {
  const out: DayNightCurveOverrides = {}
  if (!settings) return out
  for (const key of DAY_NIGHT_CURVE_KEYS) {
    const text = settings[key]
    if (text === undefined || text === DEFAULT_DAY_NIGHT_CURVES[key]) continue
    let cached = overrideCache.get(key)
    if (!cached || cached.text !== text) {
      const points = parseCurve(text, DEFAULT_POINTS[key], { range: DAY_NIGHT_CURVES[key].range })
      cached = { text, points: sameCurve(points, DEFAULT_POINTS[key]) ? null : points }
      overrideCache.set(key, cached)
    }
    if (cached.points) out[key] = cached.points
  }
  return out
}

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
  curves: DayNightCurveOverrides = {},
): OutbreakDayNightEvaluation {
  const day = dayCycle(hour)
  const d = Math.max(0, Math.min(1, day.darkness))
  const { wDay, wDusk, wNight } = weights(d)

  blendLookSettings3(OUTBREAK_DAY_LOOK, OUTBREAK_DUSK_LOOK, OUTBREAK_NIGHT_LOOK, d, outLook)

  const lighting = {} as DayNightLightingCurve
  for (let i = 0; i < LIGHTING_KEYS.length; i++) {
    const k = LIGHTING_KEYS[i]!
    lighting[k] = OUTBREAK_DAY_LIGHTING[k] * wDay + OUTBREAK_DUSK_LIGHTING[k] * wDusk + OUTBREAK_NIGHT_LIGHTING[k] * wNight
  }
  for (const key of DAY_NIGHT_CURVE_KEYS) {
    const points = curves[key]
    if (points) lighting[DAY_NIGHT_CURVES[key].field] = sampleCurve(points, d)
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
 * while preserving user-selected `fogStyle`. Curves reshaped in `settings.dayCycle` replace their blend.
 */
export function applyOutbreakDayNight(
  hour: number,
  lookSettings: LookSettings,
  settings: {
    lighting?: Partial<OutbreakLightingSettings>
    fog?: Partial<FogOfWarSettings>
    vision?: { shroud?: number }
    dayCycle?: Partial<Record<DayNightCurveKey, unknown>>
  } & Record<string, any>,
): OutbreakDayNightEvaluation {
  const evalOut = evaluateOutbreakDayNight(hour, lookSettings, dayNightCurveOverrides(settings.dayCycle))
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
