import type { Weather } from "../../shared/weather"
import type { Atmosphere } from "./atmosphere"
import type { Grade } from "./post"

type Vec3 = readonly [number, number, number]

/**
 * How the weather maps onto the existing look knobs (atmosphere, grade, ocean look). Pure functions from a base look
 * (the sunny defaults) and a weather to the values for this frame, so the sunny concept look is exactly restored when
 * the weather clears. Live-tunable through `WEATHER_FX`.
 */
export const WEATHER_FX = {
  /** Overcast sky overhead and at the horizon (the fog colour) at full cover, before darkening. */
  zenith: [0.26, 0.28, 0.32] as Vec3,
  horizon: [0.42, 0.45, 0.48] as Vec3,
  /** The overcast at night (the day greys fade to these as the time of day's daylight goes): slate navy. */
  nightZenith: [0.018, 0.028, 0.075] as Vec3,
  nightHorizon: [0.045, 0.07, 0.15] as Vec3,
  /** Share of the brightness the darkest clouds remove from the sky and fog. */
  skyDark: 0.7,
  /** Sun colour tint under full cover (lighting follows weather.sun; the disc, halo and glints follow `overcast`). */
  sunTint: [0.85, 0.9, 1.0] as Vec3,
  /** Cloud cover where the sun starts to veil and where it is gone. */
  veil: [0.15, 0.92] as readonly [number, number],
  /** Ambient (sky light) share left under the darkest clouds. */
  ambient: 0.62,
  /** Lightning: added sky radiance and ambient at a full flash. */
  flashSky: [1.1, 1.2, 1.5] as Vec3,
  flashAmbient: 2.2,
  /** Grade: saturation and exposure lost at desat/darken 1, extra vignette. */
  desat: 0.72,
  darken: 0.4,
  vignette: 0.18,
  /** Ocean: storm water colours (deep body: slate blue-grey; crest scatter: green-grey) at full cover. */
  deep: [0.24, 0.33, 0.37] as Vec3,
  scatter: [0.28, 0.52, 0.42] as Vec3,
  /** Storm water at night: navy slate. */
  nightDeep: [0.06, 0.11, 0.24] as Vec3,
  /** Subsurface strength kept in a storm (muted, never gone). */
  sss: 0.55,
  /** Foam threshold drop (deviations) and amount gain at weather.foam = 1. */
  foamSigma: 0.45,
  foamGain: 0.25,
  /** Glitter kept and roughness added at full rain (rain dimples scatter the sun path). */
  glitter: 0.15,
  roughness: 0.02,
}

const mix = (a: number, b: number, u: number) => a + (b - a) * u
const set3 = (out: number[], a: Vec3, b: Vec3, u: number, scale = 1, add: Vec3 = [0, 0, 0], k = 0) => {
  for (let i = 0; i < 3; i++) out[i] = mix(a[i]!, b[i]!, u) * scale + add[i]! * k
}

const blendOut: [number, number, number][] = [
  [0, 0, 0],
  [0, 0, 0],
]
let blendFlip = 0
/** a → b by u without allocating (two alternating scratch vectors). */
const blend = (a: Vec3, b: Vec3, u: number): Vec3 => {
  if (u >= 1) return b
  blendFlip ^= 1
  const o = blendOut[blendFlip]!
  for (let i = 0; i < 3; i++) o[i] = mix(a[i]!, b[i]!, u)
  return o
}

type MutableAtmosphere = { -readonly [K in keyof Atmosphere]: Atmosphere[K] extends Vec3 | undefined ? [number, number, number] : Atmosphere[K] }

export function makeAtmosphere(base: Atmosphere): MutableAtmosphere {
  return { ...base, sunDir: [...base.sunDir], sunColor: [...base.sunColor], zenith: [...base.zenith], horizon: [...base.horizon], sunView: base.sunView ? [...base.sunView] : undefined }
}

/** 0..1: how much the overcast hides the sun (disc, halo, glints, cloud shadows). Light rain veils it partly. */
export function weatherVeil(w: Weather): number {
  const [a, b] = WEATHER_FX.veil
  const u = Math.min(1, Math.max(0, (w.cloud - a) / (b - a)))
  return u * u * (3 - 2 * u)
}

/**
 * The atmosphere for this frame: overcast sky, dim sun, lightning flash. Storms read without haze: fog stays sunny.
 * `daylight` (0..1, the time of day's sky brightness against noon, src/render/daynight.ts) dims the overcast greys, so
 * a storm at night is dark and its lightning the key light. The sun and its disc follow the base (the time of day).
 */
export function weatherAtmosphere(base: Atmosphere, w: Weather, flash: number, out: MutableAtmosphere, daylight = 1): MutableAtmosphere {
  const fx = WEATHER_FX
  const cover = w.cloud
  const dark = 1 - fx.skyDark * w.dark
  // The night grade is lifted (src/render/daynight.ts): a flash adds less, so it lights the storm without blowing out.
  const fl = flash * mix(0.12, 1, daylight)
  // The sky itself barely brightens at night: the flash lights the sea and the ship (ambient), the sky stays a dark deck.
  const flSky = flash * daylight * daylight
  for (let i = 0; i < 3; i++) out.sunDir[i] = base.sunDir[i]!
  if (base.sunView) {
    out.sunView ??= [0, 0, 0]
    for (let i = 0; i < 3; i++) out.sunView[i] = base.sunView[i]!
  } else out.sunView = undefined
  set3(out.zenith, base.zenith, blend(fx.nightZenith, fx.zenith, daylight), cover, mix(1, dark, cover), fx.flashSky, flSky * 0.6)
  set3(out.horizon, base.horizon, blend(fx.nightHorizon, fx.horizon, daylight), cover, mix(1, dark, cover), fx.flashSky, flSky * 0.5)
  // Lighting follows weather.sun; the disc, halo, glow and glints fade with the overcast.
  set3(out.sunColor, base.sunColor, fx.sunTint, cover * 0.7)
  out.sunIntensity = base.sunIntensity * w.sun
  out.overcast = Math.max(base.overcast ?? 0, weatherVeil(w))
  out.ambient = base.ambient * mix(1, fx.ambient, w.dark) + fx.flashAmbient * fl
  out.fog = base.fog
  return out
}

/**
 * The grade for this frame: desaturated and darker in rain, a flash of bloom with lightning. At night (`daylight` → 0)
 * the storm keeps more of its colour, so it reads navy instead of grey.
 */
export function weatherGrade(base: Grade, w: Weather, flash: number, out: Grade, daylight = 1): Grade {
  const fx = WEATHER_FX
  out.saturation = base.saturation * (1 - fx.desat * w.desat * mix(0.2, 1, daylight))
  out.exposure = base.exposure * (1 - fx.darken * w.darken * mix(0.4, 1, daylight))
  out.warmth = base.warmth * (1 - w.desat)
  out.vignette = base.vignette + fx.vignette * w.darken
  out.bloom = base.bloom + flash * 0.25
  out.threshold = base.threshold
  out.grain = base.grain * (1 + w.rain)
  return out
}

/** The ocean look fields the weather drives (a structural subset of `OceanLook`). */
export type WeatherOceanLook = {
  deep: number[]
  scatter: number[]
  foamAmount: number
  foamSigma: number
  glitter: number
  roughness: number
  sss: number
  cloudShadow: number
  stormFoam: number
  rain: number
  wind: number
  windX: number
  windZ: number
}

/**
 * Slate storm water, wind-streaked foam, rain-roughened surface. `wind` is the sea's unit wind direction (the foam
 * streaks follow it, turned by weather.windDir). At night (`daylight` → 0) the water keeps more of its navy.
 */
export function weatherOcean(base: Readonly<WeatherOceanLook>, w: Weather, out: WeatherOceanLook, wind: readonly [number, number] = [1, 0], daylight = 1): WeatherOceanLook {
  const fx = WEATHER_FX
  const grey = Math.min(1, w.cloud * 0.6 + w.dark * 0.4)
  const deep = blend(fx.nightDeep, fx.deep, daylight)
  for (let i = 0; i < 3; i++) {
    out.deep[i] = mix(base.deep[i]!, deep[i]!, grey)
    out.scatter[i] = mix(base.scatter[i]!, fx.scatter[i]!, grey)
  }
  out.foamSigma = base.foamSigma - fx.foamSigma * w.foam
  out.foamAmount = base.foamAmount * (1 + fx.foamGain * w.foam)
  out.glitter = base.glitter * mix(1, fx.glitter, Math.max(w.rain, w.cloud * 0.8))
  out.roughness = base.roughness + fx.roughness * w.rain
  out.sss = base.sss * mix(1, fx.sss, grey)
  out.cloudShadow = base.cloudShadow * (1 - weatherVeil(w))
  out.stormFoam = w.foam
  out.rain = w.rain
  out.wind = w.wind
  const turn = (w.windDir * Math.PI) / 180
  out.windX = wind[0] * Math.cos(turn) - wind[1] * Math.sin(turn)
  out.windZ = wind[0] * Math.sin(turn) + wind[1] * Math.cos(turn)
  return out
}
