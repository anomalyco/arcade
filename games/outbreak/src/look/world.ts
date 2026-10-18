import type { LabControl } from "@arcade/kit/lab-panel"
import type { LookSettings } from "@arcade/kit/look"

export const GROUND_STYLES = [
  { id: "today", label: "Today (stippled)", value: 0 },
  { id: "weathered-suburban", label: "Weathered Suburban", value: 1 },
  { id: "rain-slick", label: "Rain-Slick Nocturne", value: 2 },
  { id: "cracked-overgrown", label: "Cracked & Overgrown", value: 3 },
] as const

export const LIGHT_SAT_STYLES = [
  { id: "today", label: "Today (orange wash)", value: 0 },
  { id: "true-pigment", label: "True Pigment in Light", value: 1 },
  { id: "warm-cool-split", label: "Warm Beam / Cold Moon Split (v4)", value: 2 },
  { id: "deep-amber", label: "Deep Amber Halation (RE)", value: 3 },
  { id: "paintover-v5", label: "Paintover Contrast & Dusk Split (v5)", value: 4 },
  { id: "shroud-v6", label: "Dark Shroud & Desaturated Unlit (v6)", value: 5 },
] as const

export const MODEL_STYLES = [
  { id: "today", label: "Today (LOD1 at zoom 46)", value: 0 },
  { id: "clean-satin", label: "Clean LOD0 + Grounded Satin (v4)", value: 1 },
  { id: "crisp-rim", label: "Crisp Bevel & Rim Relief", value: 2 },
  { id: "matte-cavity", label: "Weathered Matte (Fast LOD1)", value: 3 },
  { id: "smart-lod0-satin", label: "Smart LOD0 Anchors + Crisp Satin (v5)", value: 4 },
] as const

export const STYLE_GRADES = [
  { id: "today", label: "Today", value: 0 },
  { id: "survival-horror", label: "Survival Horror (RE Biohazard v4)", value: 1 },
  { id: "bleach-nocturne", label: "Bleach Nocturne (28 Days)", value: 2 },
  { id: "amber-lantern", label: "Amber Lantern & Deep Shroud", value: 3 },
  { id: "paintover-v5", label: "Paintover Contrast & Daylight/Dusk (v5)", value: 4 },
  { id: "shroud-v6", label: "Dark Shroud & Desaturated Unlit (v6)", value: 5 },
] as const

/**
 * Trims on top of the day cycle: the Day → Dusk → Noir blend still sets the look and the lights for the hour, and
 * these scale or offset what it produces, so a tuned look survives the clock moving. Every default is the identity,
 * which is today's look.
 */
export type OutbreakLookTrims = {
  /** Curated preset last applied (`look/presets.ts`); editing a knob afterwards keeps the name as a starting point. */
  lookIdea: string
  /** Rendering round Axis A — Ground material & breakup style (`0` Today, `1` Weathered Suburban, `2` Rain-Slick Nocturne, `3` Cracked & Overgrown). */
  groundStyle: number
  /** Rendering round Axis B — Lighting saturation curve (`0` Today, `1` True Pigment in Light, `2` Warm Beam / Cold Moon Split, `3` Deep Amber Halation). */
  lightSatStyle: number
  /** Rendering round Axis C — Model & furniture shading (`0` Today, `1` Clean LOD0 + Grounded Satin, `2` Crisp Bevel & Rim Relief, `3` Weathered Matte). */
  modelStyle: number
  /** Rendering round Axis D — Overall style & grade (`0` Today, `1` Survival Horror, `2` Bleach Nocturne, `3` Amber Lantern). */
  styleGrade: number
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
  /**
   * Colour comes from light (1) or from the old hue-based grade (0). At night only surfaces lit by a real light (the
   * flashlight, lamps, windows, headlights, muzzle flash and their bounce) keep colour, in proportion to the light they
   * get; moonlit and dark surfaces go near-monochrome. Fades in with darkness, so the day keeps its colour.
   */
  lightColour: number
  /** Saturation of unlit surfaces while the light rule holds. */
  worldSaturation: number
  /** How much colour light brings back (the grade's selective colour while the light rule holds). */
  litColour: number
  /** Extra colour inside the survivor's sight, as a share of full lit colour. Keep it small. */
  visionLift: number
  /** How much baked lamp bounce counts as light for colour. */
  bounceColour: number
  /** × darkness of the shroud outside the current light (0 off, 1 default, > 1 deeper shroud). */
  shroudDarkness: number
  /** How heavily unlit & shaded surfaces outside the current light desaturate toward monochrome (0 off, 1 default). */
  outOfLightDesat: number
  /** How strongly out-of-sight & unexplored areas darken beyond the live vision cone (0 off, 1 default). */
  outOfSightDarkening: number
  /** Share of air cells holding a dust mote; motes only show where a light reaches them (0 is off). */
  dustAmount: number
  /** × how brightly motes catch the light. */
  dustBrightness: number
  /** × mote size. */
  dustSize: number
  /** Motes under lamps and sconces too, not only in the flashlight beam (1 on). */
  dustLamps: number
  /** × the baked room light indoors: the room lamps' pools and their bounce (also scaled by the hour and room-lamp power). */
  bakedLight: number
  /** Live table lamps from the furniture library: how many near the camera (-1 by quality tier, 0 baked pools only). */
  tableLamps: number
  /** × live table-lamp power. */
  tableLampPower: number
}

export const DEFAULT_LOOK_TRIMS: OutbreakLookTrims = {
  lookIdea: "today",
  groundStyle: 1,
  lightSatStyle: 5,
  modelStyle: 4,
  styleGrade: 5,
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
  lightColour: 1,
  worldSaturation: 0.03,
  litColour: 0.92,
  visionLift: 0.03,
  bounceColour: 0.6,
  shroudDarkness: 1,
  outOfLightDesat: 1,
  outOfSightDarkening: 1,
  dustAmount: 0.6,
  dustBrightness: 1,
  dustSize: 1,
  dustLamps: 1,
  bakedLight: 4,
  tableLamps: -1,
  tableLampPower: 1,
}

const ROUND = "Look · Rendering round"
const GRADE = "Look · Grade"
const LIGHTS = "Look · Lights"
const LIGHT_COLOUR = "Look · Light colour"
const AIR = "Look · Air"

export const lookTrimControls: LabControl[] = [
  { key: "groundStyle", label: "Ground style", group: ROUND, options: GROUND_STYLES.map(s => ({ label: s.label, value: s.value })) },
  { key: "lightSatStyle", label: "Lighting saturation", group: ROUND, options: LIGHT_SAT_STYLES.map(s => ({ label: s.label, value: s.value })) },
  { key: "modelStyle", label: "Model & prop shading", group: ROUND, options: MODEL_STYLES.map(s => ({ label: s.label, value: s.value })) },
  { key: "styleGrade", label: "Overall style & grade", group: ROUND, options: STYLE_GRADES.map(s => ({ label: s.label, value: s.value })) },
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
  { key: "bakedLight", label: "Baked room light (pools + bounce)", group: LIGHTS, min: 0, max: 8, step: 0.05, unit: "×" },
  { key: "tableLamps", label: "Live table lamps", group: LIGHTS, type: "select", options: [{ value: -1, label: "Quality tier" }, { value: 0, label: "Off (baked only)" }, { value: 1, label: "1" }, { value: 2, label: "2" }, { value: 4, label: "4" }] },
  { key: "tableLampPower", label: "Table lamp power", group: LIGHTS, min: 0, max: 3, step: 0.05, unit: "×" },
  { key: "lightColour", label: "Colour only from light", group: LIGHT_COLOUR, min: 0, max: 1, step: 1, unit: "" },
  { key: "worldSaturation", label: "Unlit world saturation", group: LIGHT_COLOUR, min: 0, max: 1, step: 0.01, unit: "" },
  { key: "litColour", label: "Lit colour strength", group: LIGHT_COLOUR, min: 0, max: 1.5, step: 0.02, unit: "×" },
  { key: "visionLift", label: "Vision area lift", group: LIGHT_COLOUR, min: 0, max: 0.5, step: 0.01, unit: "" },
  { key: "bounceColour", label: "Lamp bounce gives colour", group: LIGHT_COLOUR, min: 0, max: 2, step: 0.05, unit: "×" },
  { key: "shroudDarkness", label: "Shroud darkness", group: LIGHT_COLOUR, min: 0, max: 2, step: 0.05, unit: "×" },
  { key: "outOfLightDesat", label: "Out-of-light desaturation", group: LIGHT_COLOUR, min: 0, max: 1.5, step: 0.05, unit: "×" },
  { key: "outOfSightDarkening", label: "Out-of-sight darkening", group: LIGHT_COLOUR, min: 0, max: 2, step: 0.05, unit: "×" },
  { key: "dustAmount", label: "Dust motes", group: AIR, min: 0, max: 1, step: 0.05, unit: "" },
  { key: "dustBrightness", label: "Mote brightness", group: AIR, min: 0, max: 4, step: 0.05, unit: "×" },
  { key: "dustSize", label: "Mote size", group: AIR, min: 0.4, max: 3, step: 0.05, unit: "×" },
  { key: "dustLamps", label: "Motes under lamps", group: AIR, min: 0, max: 1, step: 1, unit: "" },
]

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const mix = (a: number, b: number, t: number) => a * (1 - t) + b * t

/**
 * How strongly the light-colour rule holds at this darkness (0 day, 1 night). The scene shader computes the same
 * weight from the sun (`outbreakLightRule` in `lighting.ts`), so the grade and the colour mask agree.
 */
export function lightRuleWeight(t: Partial<OutbreakLookTrims> | undefined, darkness: number): number {
  const x = clamp((darkness - 0.2) / 0.6, 0, 1)
  return (t?.lightColour ?? 0) * x * x * (3 - 2 * x)
}

/**
 * The grade the renderer gets this frame: `base` (the hour's look) with the trims applied, written into `out`. Under
 * the light-colour rule unlit surfaces drop to `worldSaturation` (× the saturation trim), the hue-based warm-practical lift is off (lamplight
 * brings its colour back through the mask instead) and selective colour is `litColour` (× the beam-colour trim).
 */
export function trimLook(base: LookSettings, t: Partial<OutbreakLookTrims> | undefined, out: LookSettings, darkness = 1): LookSettings {
  Object.assign(out, base)
  if (!t) return out
  const rule = lightRuleWeight(t, darkness)
  const satStyle = Math.round(t.lightSatStyle ?? DEFAULT_LOOK_TRIMS.lightSatStyle)
  const grade = Math.round(t.styleGrade ?? DEFAULT_LOOK_TRIMS.styleGrade)
  const worldSat = satStyle === 3 ? Math.min(t.worldSaturation ?? DEFAULT_LOOK_TRIMS.worldSaturation, 0.03) : (t.worldSaturation ?? DEFAULT_LOOK_TRIMS.worldSaturation)
  const litCol = satStyle === 3 ? Math.max(t.litColour ?? DEFAULT_LOOK_TRIMS.litColour, 0.98) : (t.litColour ?? DEFAULT_LOOK_TRIMS.litColour)
  const gradeContrast = grade === 2 ? 1.18 : grade === 3 ? 1.14 : 1
  const gradeExp = grade === 2 ? 1.02 : grade === 3 ? 1.06 : 1
  const gradeVig = grade === 2 ? 1.24 : grade === 3 ? 1.32 : 1
  const gradeTemp = grade === 2 ? -0.14 : grade === 3 ? 0.10 : 0
  out.saturation = mix(clamp(base.saturation * (t.lookSaturation ?? 1), 0, 1.6), clamp(worldSat * (t.lookSaturation ?? 1), 0, 1.6), rule)
  out.exposure = base.exposure * (t.lookExposure ?? 1) * gradeExp
  out.contrast = clamp(base.contrast * (t.lookContrast ?? 1) * gradeContrast, 0.6, 1.8)
  out.vignette = base.vignette * (t.lookVignette ?? 1) * gradeVig
  out.temperature = clamp(base.temperature + (t.lookTemperature ?? 0) + gradeTemp, -1, 1)
  out.selectiveColor = mix(clamp(base.selectiveColor * (t.beamColour ?? 1), 0, 1.5), clamp(litCol * (t.beamColour ?? 1), 0, 1.5), rule)
  out.practicalWarmth = mix(clamp(base.practicalWarmth + (t.lampColour ?? 0), -0.8, 1.2), 0, rule)
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
  const grade = Math.round(t.styleGrade ?? DEFAULT_LOOK_TRIMS.styleGrade)
  const power = (t.lampPower ?? 1) * (grade === 3 ? 1.28 : 1)
  const roomMult = (t.roomPools ?? 1) * (grade === 3 ? 1.35 : 1)
  const skyMult = (t.skyAmbient ?? 1) * (grade === 2 ? 1.18 : grade === 3 ? 0.82 : 1)
  const moonMult = (t.moonlight ?? 1) * (grade === 2 ? 1.28 : 1)
  const warmthShift = (t.lampWarmth ?? 0) + (grade === 3 ? 0.14 : grade === 2 ? -0.10 : 0)
  const tightMult = (t.poolTightness ?? 1) * (grade === 3 ? 1.12 : 1)
  return {
    skyFill: l.skyFill * skyMult,
    moonFill: l.moonFill * moonMult,
    practicalWarmth: clamp(l.practicalWarmth + warmthShift, 0, 1),
    lightFalloff: l.lightFalloff * tightMult,
    porchPower: l.porchPower * power,
    windowPower: l.windowPower * power,
    roomPower: l.roomPower * power * roomMult,
    streetPower: l.streetPower * power,
  }
}
