import type { ForestLookSettings } from "@arcade/kit/forest/settings"
import type { ForestStormSettings } from "@arcade/kit/forest/storm"
import { MOONLIT_LAKE } from "@arcade/kit/water/lake-preset"

/**
 * Curated Looks: each bundles the forest's sky, fog, light and camera settings with the storm's rain, lightning and
 * wind, picked at the top of the Lab panel (Looks & Triggers › Look). Today is the game as shipped (the round-7 forest
 * look: physical sky, highlight shoulder with source-side bloom containment). A Look sets every setting any Look
 * touches, from Today's values where it doesn't name one, so switching between them never leaves one behind; knobs edited
 * afterwards stay until the next pick.
 */
export const LOOK_IDS = ["today", "moonlit", "newmoon", "groundfog", "stormcoming", "downpour"] as const
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
    note: "No moon, almost no sky, the camp's power out and the ridge beacon dark: black outside the torches, and crisp beams in clear air.",
    forest: { skyMode: "physical", skyMoon: "none", skyStars: 0.5, skyAirglow: 0.12, skyMilkyWay: 0.25, sky: 0.15, skylight: 0, windows: 0, stringLights: 0, adaptLift: 0, fogBrightness: 0, mistDensity: 0.02, depthDensity: 0.02, noise: 0.6 },
    storm: {},
    feel: { ridgeGlow: 0 },
  },
  groundfog: {
    label: "Ground fog",
    note: "A low bank lying knee to waist high in the hollows and between the trunks, still and thick, lit only where a beam or the camp's light falls on it.",
    forest: {
      // Thick in the bank, clear above it, so a beam reads as a layer with a top: the bank takes the beams' light,
      // the air over it hardly any.
      // Picked from a sweep (bank density 0.1–0.5/m, top 0.6–1.4 m): denser swallows the beams before they light it,
      // lower hides under the ferns. A broad phase so your own beam lights the bank you look along.
      mist: "drift", mistDensity: 0.3, mistHeight: 1.3, mistGaps: 0.02, mistDrift: 0.05, mistScale: 14, fogBrightness: 0.0002, canopyMist: 1,
      beamMist: 1.8, beamAir: 1.2, phaseFloor: 0.25, phaseG: 0.62, clearAir: true, depthMist: true, depthDensity: 0.03, wind: 0.4,
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
}

type Bag = Record<string, unknown>

/** Every key any Look sets, per part. */
const keysOf = (part: "forest" | "storm" | "feel") => [...new Set(Object.values(LOOKS).flatMap((l) => Object.keys((l[part] ?? {}) as Bag)))]

/** Applies `id` over Today's `base` values: every key any Look touches is set (this Look's value or Today's). */
export function applyLook(id: LookId, targets: { forest: Bag; storm: Bag; feel: Bag }, base: { forest: Bag; storm: Bag; feel: Bag }): void {
  const look = LOOKS[id]
  for (const part of ["forest", "storm", "feel"] as const) {
    const want = (look[part] ?? {}) as Bag
    for (const k of keysOf(part)) targets[part][k] = k in want ? want[k] : base[part][k]
  }
}

/** Today's values for every key a Look touches, read from the live settings before any Look is applied. */
export function lookBase(targets: { forest: Bag; storm: Bag; feel: Bag }): { forest: Bag; storm: Bag; feel: Bag } {
  const pick = (part: "forest" | "storm" | "feel") => Object.fromEntries(keysOf(part).map((k) => [k, targets[part][k]]))
  return { forest: pick("forest"), storm: pick("storm"), feel: pick("feel") }
}
