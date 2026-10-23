import type { ForestLookSettings } from "@arcade/kit/forest/settings"
import type { ForestStormSettings } from "@arcade/kit/forest/storm"
import { MOONLIT_LAKE } from "@arcade/kit/water/lake-preset"
import { nightProgress, weatherAt, type NightWeather, type WeatherSpell } from "../shared/night-weather"

/**
 * Curated Looks: each bundles the forest's sky, fog, light and camera settings with the storm's rain, lightning and
 * wind, picked at the top of the Lab panel (Looks & Triggers › Look). Today is the game as shipped (the round-7 forest
 * look: physical sky, highlight shoulder with source-side bloom containment). A Look sets every setting any Look
 * touches, from Today's values where it doesn't name one, so switching between them never leaves one behind; knobs edited
 * afterwards stay until the next pick.
 */
export const LOOK_IDS = ["today", "moonlit", "newmoon", "groundfog", "stormcoming", "downpour", "tonight"] as const
export type LookId = (typeof LOOK_IDS)[number]

/** Game feel values a Look may set (the ridge beacon). */
export type LookFeel = { ridgeGlow?: number }

export type Look = {
  label: string
  note: string
  forest: Partial<ForestLookSettings>
  storm: Partial<ForestStormSettings>
  feel?: LookFeel
}

/** An overcast sky: no stars, no Milky Way, a little airglow through the cloud. */
const OVERCAST: Partial<ForestLookSettings> = { skyMode: "physical", skyMoon: "none", skyStars: 0, skyMilkyWay: 0, skyZodiacal: 0, skyAirglow: 0.35, stars: 0 }

export const LOOKS: Record<LookId, Look> = {
  today: {
    label: "Today",
    note: "BARBARA as shipped: the catalogue night sky with no moon, mist in the hollows, torches and camp lights.",
    forest: {}, storm: {},
  },
  moonlit: {
    label: "Clear moonlit",
    note: "A full moon low in the south: silver light and long trunk shadows through the canopy, clear air, the moonlit lake with its glitter path.",
    // The moonlit lake's approved sky, air and fixed exposure (`MOONLIT_LAKE`, #466).
    forest: { ...MOONLIT_LAKE, skyMilkyWay: 0.4, skyHaze: 0.1, depthDensity: 0.02, depthStart: 24 },
    storm: {},
  },
  newmoon: {
    label: "New moon, pitch black",
    note: "No moon and clear, dry air: far more stars and the Milky Way over the crowns, no sky light reaching the floor, the camp's power out and the ridge beacon dark. Black outside the torches.",
    // About 1.4 stops under Today and the eye can't open past its base (adaptLift 0); the stars and Milky Way are
    // pushed up past that, so the sky through the gaps is the brightest thing that isn't a torch.
    forest: {
      skyMode: "physical", skyMoon: "none", skyStars: 3, skyMilkyWay: 2.6, skyAirglow: 0.1, skyZodiacal: 0, skyExtinction: 0.06, skyScintillation: 0.06,
      sky: 0.08, skylight: 0, windows: 0, stringLights: 0, exposure: 0.6, adaptLift: 0, fogBrightness: 0, mistDensity: 0.015, depthDensity: 0.012, noise: 0.6,
    },
    storm: {},
    feel: { ridgeGlow: 0 },
  },
  groundfog: {
    label: "Ground fog",
    note: "A bank lying knee to waist high in the hollows and between the trunks, still and thick. Your torch is in it, so the beam lights it from inside; dark wherever no light falls.",
    forest: {
      // A height-limited layer the torch sits in (top ~1–2 m with the hollows' lift), so the beam travels inside it,
      // not above it; no glow of its own (fogBrightness 0, depthMist on), so only lit fog shows. Full near scatter is a
      // number, not clear air off, so Tonight's fog rolls in without a snap.
      mist: "drift", mistDensity: 0.2, mistHeight: 1.6, mistGaps: 0.02, mistDrift: 0.05, mistScale: 14, fogBrightness: 0, canopyMist: 1,
      beamMist: 2.5, beamAir: 0.6, phaseFloor: 0.15, phaseG: 0.62, nearScatter: 1, depthMist: true, depthDensity: 0.03, wind: 0.4,
    },
    storm: {},
  },
  stormcoming: {
    label: "Storm coming",
    note: "Overcast, lit dull orange by distant towns. Lightning flickers in the cloud on the horizon kilometres off, thunder long after; the wind rising in the crowns, no rain yet.",
    forest: { ...OVERCAST, skyAirglow: 0.5, wind: 2.2, gust: 1.6, branchSway: 1.4, flutter: 1.5 },
    storm: { strikes: 6, strikeNear: 4000, strikeFar: 12000, strikeCloud: 0.6, flashLux: 0.2, flashSky: 4, flashMist: 0.5, cloudGlow: 0.003, stormWind: 1.8, gustPeak: 2.4, boltBrightness: 0.6 },
  },
  downpour: {
    label: "Downpour",
    note: "Heavy rain bright in every beam and window, drips off the branches, bark and litter soaked dark and shining, lightning close by.",
    forest: { ...OVERCAST, skyAirglow: 0.2, wind: 2, gust: 1.4, depthDensity: 0.09, mistDensity: 0.05 },
    storm: { rain: 1, rainDensity: 2, rainGlow: 4, wetness: 1, puddles: 0.9, drips: 2, strikes: 3, strikeNear: 300, strikeFar: 2500, strikeCloud: 0.2, flashLux: 1.1, flashSky: 0.12, cloudGlow: 0.0007, stormWind: 1.6 },
  },
  tonight: {
    label: "Tonight (changes)",
    note: "The night's own weather, the same for everyone in a room: clear, then fog settling, a storm brewing and breaking, a starry spell, each changing slowly into the next.",
    forest: {}, storm: {},
  },
}

type Bag = Record<string, unknown>

/** Every key any Look sets, per part. */
const keysOf = (part: "forest" | "storm" | "feel") => [...new Set(Object.values(LOOKS).flatMap((l) => Object.keys((l[part] ?? {}) as Bag)))]

type Parts = { forest: Bag; storm: Bag; feel: Bag }

/** Applies `id` over Today's `base` values: every key any Look touches is set (this Look's value or Today's). */
export function applyLook(id: LookId, targets: Parts, base: Parts): void {
  blendLooks(id, id, 0, targets, base)
}

/** `a` changing into `b` (`k` 0..1): numbers in between, anything else switches halfway. */
export function blendLooks(a: LookId, b: LookId, k: number, targets: Parts, base: Parts, keep: ReadonlySet<string> = NONE): void {
  for (const part of ["forest", "storm", "feel"] as const) {
    const wa = (LOOKS[a][part] ?? {}) as Bag, wb = (LOOKS[b][part] ?? {}) as Bag
    for (const key of keysOf(part)) {
      if (keep.has(key)) { targets[part][key] = base[part][key]; continue }
      const va = key in wa ? wa[key] : base[part][key], vb = key in wb ? wb[key] : base[part][key]
      targets[part][key] = typeof va === "number" && typeof vb === "number" ? va + (vb - va) * k : k < 0.5 ? va : vb
    }
  }
}

const NONE: ReadonlySet<string> = new Set()
/** Settings a weather spell leaves as Today's: the camp's power and the ridge beacon don't come and go with the sky. */
export const WEATHER_KEEPS: ReadonlySet<string> = new Set(["windows", "stringLights", "ridgeGlow"])

/** The Look each spell of the night's weather (`shared/night-weather.ts`) wears. */
export const WEATHER_LOOK: Record<NightWeather, LookId> = { clear: "today", starry: "newmoon", fog: "groundfog", brewing: "stormcoming", rain: "downpour" }

/** Tonight's weather at shared time `t` as two Looks and the mix, held at the night's end (the end card). */
export function tonightAt(spells: readonly WeatherSpell[], night: { start: number; dawn: number; end: number }, t: number) {
  const w = weatherAt(spells, nightProgress(Math.min(t, night.end || t), night.start, night.dawn))
  return { ...w, a: WEATHER_LOOK[w.from], b: WEATHER_LOOK[w.to] }
}

/**
 * Tonight's strike settings at whole second `k` of the shared clock (`SharedStormClock.settingsAt`): read at the
 * slot, not at a client's frame time, so clients at any frame rate agree on every strike through a change.
 */
export function tonightStrikes(spells: readonly WeatherSpell[], night: { start: number; dawn: number; end: number }, k: number, base: Bag) {
  const w = tonightAt(spells, night, k)
  const sa = LOOKS[w.a].storm as Bag, sb = LOOKS[w.b].storm as Bag
  const v = (key: keyof ForestStormSettings) => {
    const a = (key in sa ? sa[key] : base[key]) as number, b = (key in sb ? sb[key] : base[key]) as number
    return a + (b - a) * w.mix
  }
  return { rate: v("strikes"), cloud: v("strikeCloud"), near: v("strikeNear"), far: v("strikeFar") }
}

/** Today's values for every key a Look touches, read from the live settings before any Look is applied. */
export function lookBase(targets: Parts): Parts {
  const pick = (part: "forest" | "storm" | "feel") => Object.fromEntries(keysOf(part).map((k) => [k, targets[part][k]]))
  return { forest: pick("forest"), storm: pick("storm"), feel: pick("feel") }
}
