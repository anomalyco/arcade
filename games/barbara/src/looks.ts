import type { ForestLookSettings } from "@arcade/kit/forest/settings"
import type { ForestStormSettings } from "@arcade/kit/forest/storm"

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
    note: "The physical sky with a full moon high in the south-west: moonlight and its shadows through the canopy, clearer air.",
    forest: { skyMode: "physical", skyMoon: "full", skyMoonAzimuth: 215, skyMoonAltitude: 30, skyMoonLux: 0.14, skyHaze: 0.12, skyMilkyWay: 0.5, mistDensity: 0.05, depthDensity: 0.035, depthStart: 16 },
    storm: {},
  },
  newmoon: {
    label: "New moon, pitch black",
    note: "No moon, a faint sky, the camp's power out and the ridge beacon dark: only torches.",
    forest: { skyMode: "physical", skyMoon: "none", skyStars: 0.7, skyAirglow: 0.6, sky: 0.5, skylight: 0.35, windows: 0, stringLights: 0, adaptLift: 0.3 },
    storm: {},
    feel: { ridgeGlow: 0 },
  },
  groundfog: {
    label: "Ground fog",
    note: "A low fog bank lying in every hollow, thick and still, glowing only where a beam or the camp lights it.",
    forest: { mist: "drift", mistDensity: 0.14, mistHeight: 1.7, mistGaps: 0.12, mistDrift: 0.06, mistScale: 14, fogBrightness: 0.0008, beamMist: 1.35, depthDensity: 0.06, wind: 0.5 },
    storm: {},
  },
  stormcoming: {
    label: "Storm coming",
    note: "Overcast. Lightning flickers along the horizon kilometres off, thunder a long time later; the wind rising, no rain yet.",
    forest: { ...OVERCAST, wind: 1.7, gust: 1.2 },
    storm: { strikes: 3, strikeNear: 3500, strikeFar: 11000, strikeCloud: 0.55, flashLux: 0.4, flashSky: 0.08, cloudGlow: 0.0005, stormWind: 1.4, boltBrightness: 0.8 },
  },
  downpour: {
    label: "Downpour",
    note: "Heavy rain in every beam and window, drips under the trees, lightning close by, everything soaked and shining.",
    forest: { ...OVERCAST, skyAirglow: 0.25, wind: 2, gust: 1.4, depthDensity: 0.07, mistDensity: 0.06 },
    storm: { rain: 1, rainDensity: 1.4, rainGlow: 2.5, wetness: 1, puddles: 0.8, drips: 1.5, strikes: 4, strikeNear: 300, strikeFar: 2500, strikeCloud: 0.2, flashLux: 1.1, flashSky: 0.12, cloudGlow: 0.0007, stormWind: 1.6 },
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
