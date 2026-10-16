import type { LabControl } from "@arcade/kit/lab-panel"
import type { LookSettings } from "@arcade/kit/look"

/**
 * Trims on top of the day cycle: the Day → Dusk → Noir blend still sets the look and the lights for the hour, and
 * these scale or offset what it produces, so a tuned look survives the clock moving. Every default is the identity,
 * which is today's look.
 */
export type OutbreakLookTrims = {
  /** Curated preset last applied (`look/presets.ts`); editing a knob afterwards keeps the name as a starting point. */
  lookIdea: string
  /** World colour after the grade (× the hour's saturation). */
  lookSaturation: number
  lookExposure: number
  lookContrast: number
  lookVignette: number
  /** Added to the grade's temperature: negative is colder. */
  lookTemperature: number
  /** How much warm lamplight brings back colour through the Noir grade (added to the grade's practical warmth). */
  lampColour: number
  /** How much the flashlight and headlights bring back colour (× selective colour). */
  beamColour: number
  /** Porch, window, streetlamp and interior lamp power. */
  lampPower: number
  /** Interior lamp pools on top of `lampPower`. */
  roomPools: number
  /** × light pool tightness: below 1 widens the pools. */
  poolTightness: number
  /** Added to the lamps' warmth (0 white, 1 amber). */
  lampWarmth: number
  /** × the cool sky ambient that fills shadows. */
  skyAmbient: number
  /** × moonlight. */
  moonlight: number
}

export const DEFAULT_LOOK_TRIMS: OutbreakLookTrims = {
  lookIdea: "today",
  lookSaturation: 1,
  lookExposure: 1,
  lookContrast: 1,
  lookVignette: 1,
  lookTemperature: 0,
  lampColour: 0,
  beamColour: 1,
  lampPower: 1,
  roomPools: 1,
  poolTightness: 1,
  lampWarmth: 0,
  skyAmbient: 1,
  moonlight: 1,
}

const GRADE = "Look · Grade"
const LIGHTS = "Look · Lights"

export const lookTrimControls: LabControl[] = [
  { key: "lookSaturation", label: "World saturation", group: GRADE, min: 0, max: 3, step: 0.05, unit: "×" },
  { key: "lookExposure", label: "Exposure", group: GRADE, min: 0.5, max: 1.6, step: 0.02, unit: "×" },
  { key: "lookContrast", label: "Contrast", group: GRADE, min: 0.7, max: 1.4, step: 0.02, unit: "×" },
  { key: "lookVignette", label: "Vignette", group: GRADE, min: 0, max: 2, step: 0.05, unit: "×" },
  { key: "lookTemperature", label: "Temperature shift", group: GRADE, min: -0.8, max: 0.8, step: 0.02, unit: "" },
  { key: "beamColour", label: "Colour in the beam", group: GRADE, min: 0, max: 1.6, step: 0.05, unit: "×" },
  { key: "lampColour", label: "Colour in lamplight", group: GRADE, min: 0, max: 1, step: 0.05, unit: "" },
  { key: "lampPower", label: "Lamp power", group: LIGHTS, min: 0, max: 2, step: 0.05, unit: "×" },
  { key: "roomPools", label: "Interior lamp pools", group: LIGHTS, min: 0, max: 2, step: 0.05, unit: "×" },
  { key: "poolTightness", label: "Pool tightness", group: LIGHTS, min: 0.5, max: 1.6, step: 0.02, unit: "×" },
  { key: "lampWarmth", label: "Lamp warmth shift", group: LIGHTS, min: -0.6, max: 0.6, step: 0.02, unit: "" },
  { key: "skyAmbient", label: "Cool sky ambient", group: LIGHTS, min: 0, max: 2, step: 0.05, unit: "×" },
  { key: "moonlight", label: "Moonlight", group: LIGHTS, min: 0, max: 2, step: 0.05, unit: "×" },
]

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/** The grade the renderer gets this frame: `base` (the hour's look) with the trims applied, written into `out`. */
export function trimLook(base: LookSettings, t: Partial<OutbreakLookTrims> | undefined, out: LookSettings): LookSettings {
  Object.assign(out, base)
  if (!t) return out
  out.saturation = clamp(base.saturation * (t.lookSaturation ?? 1), 0, 1.6)
  out.exposure = base.exposure * (t.lookExposure ?? 1)
  out.contrast = clamp(base.contrast * (t.lookContrast ?? 1), 0.6, 1.8)
  out.vignette = base.vignette * (t.lookVignette ?? 1)
  out.temperature = clamp(base.temperature + (t.lookTemperature ?? 0), -1, 1)
  out.selectiveColor = clamp(base.selectiveColor * (t.beamColour ?? 1), 0, 1.5)
  out.practicalWarmth = clamp(base.practicalWarmth + (t.lampColour ?? 0), -0.8, 1.2)
  return out
}

/** The lighting the uniforms get: the hour's lighting with the light trims applied. Pure; `l` is not changed. */
export function trimLighting<L extends {
  skyFill: number
  moonFill: number
  practicalWarmth: number
  lightFalloff: number
  porchPower: number
  windowPower: number
  roomPower: number
  streetPower: number
}>(l: L, t: Partial<OutbreakLookTrims> | undefined) {
  if (!t) return l
  const power = t.lampPower ?? 1
  return {
    skyFill: l.skyFill * (t.skyAmbient ?? 1),
    moonFill: l.moonFill * (t.moonlight ?? 1),
    practicalWarmth: clamp(l.practicalWarmth + (t.lampWarmth ?? 0), 0, 1),
    lightFalloff: l.lightFalloff * (t.poolTightness ?? 1),
    porchPower: l.porchPower * power,
    windowPower: l.windowPower * power,
    roomPower: l.roomPower * power * (t.roomPools ?? 1),
    streetPower: l.streetPower * power,
  }
}
