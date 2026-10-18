import { DEFAULT_HERO_LOOK, HERO_STYLE_SURFACES, type HeroLookSettings } from "./hero"
import { DEFAULT_LOOK_TRIMS, type OutbreakLookTrims } from "./world"

export type OutbreakLookKnobs = Omit<OutbreakLookTrims, "lookIdea"> & HeroLookSettings

/**
 * A curated idea for Outbreak's look: a named, versioned set of every Look knob. Applying one sets all of them, so
 * presets never leak into each other; `today` is the identity and doubles as Reset. Bump `version` when a preset's
 * values change meaning, so stills and board options can say which one they show.
 */
export type OutbreakLookPreset = {
  id: string
  label: string
  version: number
  note: string
  knobs: OutbreakLookKnobs
}

const { lookIdea: _, ...TRIMS } = DEFAULT_LOOK_TRIMS
const TODAY: OutbreakLookKnobs = { ...TRIMS, ...DEFAULT_HERO_LOOK }
/** The Darkwood v8 knobs at their pre-v8 identity, for every preset that predates them. */
const PRE_V8 = { coneSharpness: 0, dayShroud: 0, shroudCharcoal: 0, shroudGrain: 0, shroudLampKeep: 1, dayMuted: 0, dayVignette: 0, dayGrain: 0 } as const
const V7: OutbreakLookKnobs = { ...TODAY, ...PRE_V8, lightSatStyle: 6, styleGrade: 6, beamWarmth: 0.28, beamTightness: 1, nightGrain: 0.05, nightVignette: 0.35, skyAmbient: 1, moonlight: 1 }
const hero = (style: number): Pick<HeroLookSettings, "heroStyle"> & (typeof HERO_STYLE_SURFACES)[number] => ({ heroStyle: style, ...HERO_STYLE_SURFACES[style]! })

export const OUTBREAK_LOOK_PRESETS: readonly OutbreakLookPreset[] = [
  {
    id: "today",
    label: "Today",
    version: 8,
    note: "The shipped look (v8): Darkwood pass — a crisp sight cone with a dark, grainy charcoal shroud outside it by day and night, near-black nights where the dirty halogen flashlight and the few lamps are the world, a sickly overcast olive-khaki day, and heavy grain and vignette at every hour.",
    knobs: TODAY,
  },
  {
    id: "today-v7",
    label: "Before: Today v7 (Dying Light pass)",
    version: 7,
    note: "The Dying Light pass (PR #246): sunlit daytime colour with desaturated shade, warm copper-amber dusk, neutral-warm 4800K tight-core flashlight, wet rim & specular on zombies, highlight-only bloom with dark-weighted night grain.",
    knobs: V7,
  },
  {
    id: "today-v6",
    label: "Before: Today v6 (dark shroud pass)",
    version: 6,
    note: "The third rendering pass (PR #244): darker out-of-light shroud and heavy unlit desaturation with warm beam & lamp pools and grounded co-op survivors.",
    knobs: { ...V7, groundStyle: 1, lightSatStyle: 5, modelStyle: 4, styleGrade: 5, beamWarmth: 1, beamTightness: 0, zombieRimSpec: 0, nightGrain: 0, nightVignette: 0.82 },
  },
  {
    id: "today-v5",
    label: "Before: Today v5 (paint-over pass)",
    version: 5,
    note: "The second paint-over pass (PR #243): high-contrast sunlit day, copper-indigo sunset dusk, golden beam & practical pools against brighter cobalt moonlit silhouettes, and full-bright hero exemption outside light.",
    knobs: { ...V7, groundStyle: 1, lightSatStyle: 4, modelStyle: 4, styleGrade: 4, worldSaturation: 0.06, visionLift: 0.08, shroudDarkness: 0.16, outOfLightDesat: 0.25, outOfSightDarkening: 0.25, beamWarmth: 1, beamTightness: 0, zombieRimSpec: 0, nightGrain: 0, nightVignette: 0.82 },
  },
  {
    id: "today-v4",
    label: "Before: Today v4 (first overhaul)",
    version: 4,
    note: "The first rendering overhaul (PR #242): weathered suburban ground, warm/cool split, uniform LOD0 satin props, and survival-horror shadow toe.",
    knobs: { ...V7, groundStyle: 1, lightSatStyle: 2, modelStyle: 1, styleGrade: 1, worldSaturation: 0.06, visionLift: 0.08, beamWarmth: 1, beamTightness: 0, zombieRimSpec: 0, nightGrain: 0, nightVignette: 0.82 },
  },
  {
    id: "legacy-today",
    label: "Before: pre-overhaul look",
    version: 1,
    note: "The pre-overhaul look before removing the ochre/sepia washes and upgrading the lighting & post-processing stack.",
    knobs: { ...V7, groundStyle: 0, lightSatStyle: 0, modelStyle: 0, styleGrade: 0, worldSaturation: 0.06, visionLift: 0.08, beamWarmth: 1, beamTightness: 0, zombieRimSpec: 0, nightGrain: 0, nightVignette: 0.82 },
  },
  {
    id: "hue-colour",
    label: "Before: colour by hue",
    version: 1,
    note: "The look before the light-colour rule: the whole sight area keeps colour and warm surfaces keep theirs.",
    knobs: { ...V7, lightColour: 0 },
  },
  {
    id: "deeper-noir",
    label: "Deeper noir",
    version: 1,
    note: "Darker, greyer street; only the beam brings colour back.",
    knobs: { ...TODAY, lookSaturation: 0.4, lookExposure: 0.8, lookContrast: 1.18, lookVignette: 1.4, skyAmbient: 0.6, lampPower: 0.8, beamColour: 1.25 },
  },
  {
    id: "warm-practicals",
    label: "Warmer practicals",
    version: 1,
    note: "Amber porch and window pools that keep their colour through the grade.",
    knobs: { ...TODAY, lampColour: 0.9, lampWarmth: 0.4, lampPower: 1.5, roomPools: 1.6, poolTightness: 0.8, lookSaturation: 1.3, lookTemperature: 0.08 },
  },
  {
    id: "cold-moonlight",
    label: "Colder moonlight",
    version: 1,
    note: "Blue-grey moonlit street, dimmer lamps.",
    knobs: { ...TODAY, moonlight: 1.8, skyAmbient: 1.8, lookTemperature: -0.5, lookExposure: 1.12, lampPower: 0.75, lampWarmth: -0.2, lookSaturation: 1.2 },
  },
  {
    id: "vivid-world",
    label: "Vivid world, grey hero",
    version: 1,
    note: "The world keeps much more colour; the survivor is a grey mannequin.",
    knobs: { ...TODAY, ...hero(1), heroWarmth: 0, heroSaturation: 0, lookSaturation: 2.6, lookExposure: 1.1, skyAmbient: 1.3, lampColour: 0.45 },
  },
  {
    id: "big-walk",
    label: "Big Walk contrast",
    version: 1,
    note: "A flat dark figure with a crisp rim against a richer, brighter house.",
    knobs: { ...TODAY, ...hero(2), lookSaturation: 1.8, lookExposure: 1.14, skyAmbient: 1.35, roomPools: 1.35, lampColour: 0.35, lookContrast: 1.06 },
  },
  {
    id: "re-biohazard",
    label: "RE Biohazard (rendering round)",
    version: 1,
    note: "Weathered suburban asphalt & turf, true pigment inside warm light against cold moonlit shadows, clean LOD0 satin furniture, and survival-horror shadow toe.",
    knobs: { ...V7, groundStyle: 1, lightSatStyle: 2, modelStyle: 1, styleGrade: 1 },
  },
  {
    id: "rain-nocturne",
    label: "Rain-Slick Nocturne (rendering round)",
    version: 1,
    note: "Rain-slick wheel ruts & puddles catching the beam, warm/cool lighting split, crisp bevel & rim relief on props, and taut overcast grade.",
    knobs: { ...V7, groundStyle: 2, lightSatStyle: 2, modelStyle: 2, styleGrade: 2 },
  },
  {
    id: "overgrown-lantern",
    label: "Overgrown & Amber (rendering round)",
    version: 1,
    note: "Cracked & moss-overgrown street, deep amber lamp halation with rich bounce colour, grounded satin props, and intimate lantern pools.",
    knobs: { ...V7, groundStyle: 3, lightSatStyle: 3, modelStyle: 1, styleGrade: 3 },
  },
]

export function lookPreset(id: string): OutbreakLookPreset | undefined {
  return OUTBREAK_LOOK_PRESETS.find(p => p.id === id)
}
