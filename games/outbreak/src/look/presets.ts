import { DEFAULT_FLASHLIGHT_BEAM, V7_FLASHLIGHT_BEAM, type FlashlightBeamSettings } from "../lighting"
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
  /** The flashlight's beam shape (Backquote › Flashlight); ideas without their own use today's. */
  beam: FlashlightBeamSettings
}

const { lookIdea: _, ...TRIMS } = DEFAULT_LOOK_TRIMS
const TODAY: OutbreakLookKnobs = { ...TRIMS, ...DEFAULT_HERO_LOOK }
/** The Darkwood v8 knobs at their pre-v8 identity, for every preset that predates them. */
const PRE_V8 = { coneSharpness: 0, dayShroud: 0, shroudCharcoal: 0, shroudGrain: 0, shroudLampKeep: 1, dayMuted: 0, dayVignette: 0, dayGrain: 0, sightGlow: 0, groundDetail: 0 } as const
const V7: OutbreakLookKnobs = {
  ...TODAY,
  ...PRE_V8,
  beamWarmth: 0.28,
  beamTightness: 1,
  nightGrain: 0.05,
  nightVignette: 0.35,
  skyAmbient: 1,
  moonlight: 1,
  lookContrast: 1,
  dustAmount: 0.6,
  dustBrightness: 1,
  dustSize: 1,
}
const hero = (style: number): Pick<HeroLookSettings, "heroStyle"> & (typeof HERO_STYLE_SURFACES)[number] => ({ heroStyle: style, ...HERO_STYLE_SURFACES[style]! })

export const OUTBREAK_LOOK_PRESETS: readonly OutbreakLookPreset[] = [
  {
    id: "today",
    label: "Today",
    version: 8,
    note: "The shipped look (v8): Darkwood pass — a crisp sight cone with a dark, grainy charcoal shroud outside it by day and night, near-black nights where the dirty halogen flashlight and the few lamps are the world, a sickly overcast olive-khaki day, and heavy grain and vignette at every hour.",
    knobs: TODAY,
    beam: DEFAULT_FLASHLIGHT_BEAM,
  },
  {
    id: "today-v7",
    label: "Before: Today v7 (Dying Light pass)",
    version: 7,
    note: "The Dying Light pass (PR #246): sunlit daytime colour with desaturated shade, warm copper-amber dusk, neutral-warm 4800K tight-core flashlight, wet rim & specular on zombies, highlight-only bloom with dark-weighted night grain.",
    knobs: V7,
    beam: V7_FLASHLIGHT_BEAM,
  },
  {
    id: "deeper-noir",
    label: "Deeper noir",
    version: 1,
    note: "Darker, greyer street; only the beam brings colour back.",
    knobs: { ...TODAY, lookSaturation: 0.4, lookExposure: 0.8, lookContrast: 1.18, lookVignette: 1.4, skyAmbient: 0.6, lampPower: 0.8, beamColour: 1.25 },
    beam: DEFAULT_FLASHLIGHT_BEAM,
  },
  {
    id: "warm-practicals",
    label: "Warmer practicals",
    version: 1,
    note: "Amber porch and window pools that keep their colour through the grade.",
    knobs: { ...TODAY, lampColour: 0.9, lampWarmth: 0.4, lampPower: 1.5, roomPools: 1.6, poolTightness: 0.8, lookSaturation: 1.3, lookTemperature: 0.08 },
    beam: DEFAULT_FLASHLIGHT_BEAM,
  },
  {
    id: "vivid-world",
    label: "Vivid world, grey hero",
    version: 1,
    note: "The world keeps much more colour; the survivor is a grey mannequin.",
    knobs: { ...TODAY, ...hero(1), heroWarmth: 0, heroSaturation: 0, lookSaturation: 2.6, lookExposure: 1.1, skyAmbient: 1.3, lampColour: 0.45 },
    beam: DEFAULT_FLASHLIGHT_BEAM,
  },
  {
    id: "big-walk",
    label: "Big Walk contrast",
    version: 1,
    note: "A flat dark figure with a crisp rim against a richer, brighter house.",
    knobs: { ...TODAY, ...hero(2), lookSaturation: 1.8, lookExposure: 1.14, skyAmbient: 1.35, roomPools: 1.35, lampColour: 0.35, lookContrast: 1.06 },
    beam: DEFAULT_FLASHLIGHT_BEAM,
  },
]

export function lookPreset(id: string): OutbreakLookPreset | undefined {
  return OUTBREAK_LOOK_PRESETS.find(p => p.id === id)
}
