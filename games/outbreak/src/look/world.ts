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
  /** Flashlight colour warmth (0 cool xenon, 0.28 neutral-warm ~4800K white, 1 legacy amber torch). */
  beamWarmth: number
  /** Flashlight core tightness & spill falloff (0 legacy wide cone, 1 tight hotspot with soft dark spill). */
  beamTightness: number
  /** Wet grazing rim, specular highlights, and eye/wound glints on zombies in the dark (0 legacy ambient lift, 1 default). */
  zombieRimSpec: number
  /** Dark-concentrated film grain at night (0 off, 0.05 default). */
  nightGrain: number
  /** Lens vignette strength at night (0.35 default, 0.82 legacy). */
  nightVignette: number
  /** Crisp edge on the drawn sight cone and a tight body halo (0 legacy wide feather, 1 Darkwood ~5° edge). Presentation only. */
  coneSharpness: number
  /** How much of the out-of-sight shroud holds by day (0 legacy: fades by day, 1 as strong as at night). */
  dayShroud: number
  /** Charcoal treatment outside sight: near-monochrome cold slate and darker (0 off, 1 Darkwood). */
  shroudCharcoal: number
  /** Coarse crawling grain in the out-of-sight shroud (0 off). */
  shroudGrain: number
  /** Share of colour that lamp-lit places keep while out of sight (0 grey memory, 1 full colour). */
  shroudLampKeep: number
  /** Sickly overcast day palette: olive greens, khaki earth, dark canopies (0 off, 1 Darkwood). */
  dayMuted: number
  /** Lens vignette floor at every hour (0 off: the hour's own vignette by day). */
  dayVignette: number
  /** Film grain floor at every hour (0 off). */
  dayGrain: number
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
  lookSaturation: 1,
  lookExposure: 1,
  lookContrast: 1.06,
  lookVignette: 1,
  lookTemperature: 0,
  lampColour: 0,
  beamColour: 1,
  lampPower: 1,
  roomPools: 1,
  poolTightness: 1,
  lampWarmth: 0,
  skyAmbient: 0.7,
  moonlight: 0.7,
  lightColour: 1,
  worldSaturation: 0.03,
  litColour: 0.92,
  visionLift: 0.03,
  bounceColour: 0.6,
  shroudDarkness: 1,
  outOfLightDesat: 1,
  outOfSightDarkening: 1,
  beamWarmth: 0.56,
  beamTightness: 1.1,
  zombieRimSpec: 1,
  nightGrain: 0.085,
  nightVignette: 0.52,
  coneSharpness: 1,
  dayShroud: 1,
  shroudCharcoal: 1,
  shroudGrain: 1,
  shroudLampKeep: 0.55,
  dayMuted: 1,
  dayVignette: 0.42,
  dayGrain: 0.05,
  dustAmount: 0.6,
  dustBrightness: 1,
  dustSize: 1,
  dustLamps: 1,
  bakedLight: 4,
  tableLamps: -1,
  tableLampPower: 1,
}

const GRADE = "Look · Grade"
const LIGHTS = "Look · Lights"
const LIGHT_COLOUR = "Look · Light colour"
const AIR = "Look · Air"
const SHROUD = "Look · Sight shroud"

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
  { key: "beamWarmth", label: "Flashlight beam warmth (4800K=0.28)", group: LIGHTS, min: 0, max: 1, step: 0.02, unit: "" },
  { key: "beamTightness", label: "Flashlight hotspot tightness", group: LIGHTS, min: 0, max: 2, step: 0.05, unit: "×" },
  { key: "zombieRimSpec", label: "Zombie wet rim & glints", group: LIGHT_COLOUR, min: 0, max: 2, step: 0.05, unit: "×" },
  { key: "nightGrain", label: "Night dark-shadow grain", group: GRADE, min: 0, max: 0.4, step: 0.01, unit: "" },
  { key: "nightVignette", label: "Night lens vignette", group: GRADE, min: 0, max: 1.2, step: 0.02, unit: "" },
  { key: "coneSharpness", label: "Sight cone edge crispness", group: SHROUD, min: 0, max: 1, step: 0.05, unit: "" },
  { key: "dayShroud", label: "Shroud holds by day", group: SHROUD, min: 0, max: 1, step: 0.05, unit: "" },
  { key: "shroudCharcoal", label: "Charcoal outside sight", group: SHROUD, min: 0, max: 1.5, step: 0.05, unit: "×" },
  { key: "shroudGrain", label: "Shroud grain", group: SHROUD, min: 0, max: 3, step: 0.05, unit: "×" },
  { key: "shroudLampKeep", label: "Lamp-lit colour kept out of sight", group: SHROUD, min: 0, max: 1, step: 0.05, unit: "" },
  { key: "dayMuted", label: "Sickly overcast day palette", group: GRADE, min: 0, max: 1.5, step: 0.05, unit: "×" },
  { key: "dayVignette", label: "Vignette at every hour", group: GRADE, min: 0, max: 1.2, step: 0.02, unit: "" },
  { key: "dayGrain", label: "Grain at every hour", group: GRADE, min: 0, max: 0.4, step: 0.01, unit: "" },
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
  const worldSat = t.worldSaturation ?? DEFAULT_LOOK_TRIMS.worldSaturation
  const litCol = t.litColour ?? DEFAULT_LOOK_TRIMS.litColour
  out.saturation = mix(clamp(base.saturation * (t.lookSaturation ?? 1), 0, 1.6), clamp(worldSat * (t.lookSaturation ?? 1), 0, 1.6), rule)
  out.exposure = base.exposure * (t.lookExposure ?? 1)
  out.contrast = clamp(base.contrast * (t.lookContrast ?? 1), 0.6, 1.8)
  const baseVig = base.vignette * (t.lookVignette ?? 1)
  const nightVig = (t.nightVignette ?? base.vignette) * (t.lookVignette ?? 1)
  out.vignette = Math.max(mix(baseVig, nightVig, rule), (t.dayVignette ?? 0) * (t.lookVignette ?? 1))
  const nightGrain = t.nightGrain ?? base.grain
  out.grain = Math.max(mix(base.grain, Math.max(base.grain, nightGrain), rule), t.dayGrain ?? 0)
  out.temperature = clamp(base.temperature + (t.lookTemperature ?? 0), -1, 1)
  out.selectiveColor = mix(clamp(base.selectiveColor * (t.beamColour ?? 1), 0, 1.5), clamp(litCol * (t.beamColour ?? 1), 0, 1.5), rule)
  out.practicalWarmth = mix(clamp(base.practicalWarmth + (t.lampColour ?? 0), -0.8, 1.2), 0, rule)
  return out
}

/**
 * Resolves the flashlight's linear RGB from `beamWarmth` (0 cool 6000K white, 0.28 neutral-warm ~4800K `[1.0, 0.93, 0.82]`,
 * 1.0 `baseRgb` legacy amber torch).
 */
export function resolveBeamColor(baseRgb: readonly [number, number, number], beamWarmth = 1): [number, number, number] {
  const w = clamp(beamWarmth, 0, 1)
  if (w >= 0.999) return [baseRgb[0], baseRgb[1], baseRgb[2]]
  const neutralWarm: readonly [number, number, number] = [1.0, 0.93, 0.82]
  if (w <= 0.28) {
    const u = w / 0.28
    const cool: readonly [number, number, number] = [0.92, 0.96, 1.0]
    return [
      Number(mix(cool[0], neutralWarm[0], u).toFixed(4)),
      Number(mix(cool[1], neutralWarm[1], u).toFixed(4)),
      Number(mix(cool[2], neutralWarm[2], u).toFixed(4)),
    ]
  }
  const u = (w - 0.28) / 0.72
  return [
    Number(mix(neutralWarm[0], baseRgb[0], u).toFixed(4)),
    Number(mix(neutralWarm[1], baseRgb[1], u).toFixed(4)),
    Number(mix(neutralWarm[2], baseRgb[2], u).toFixed(4)),
  ]
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
