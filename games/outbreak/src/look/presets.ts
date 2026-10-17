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
const hero = (style: number): Pick<HeroLookSettings, "heroStyle"> & (typeof HERO_STYLE_SURFACES)[number] => ({ heroStyle: style, ...HERO_STYLE_SURFACES[style]! })

export const OUTBREAK_LOOK_PRESETS: readonly OutbreakLookPreset[] = [
  {
    id: "today",
    label: "Today",
    version: 3,
    note: "The shipped look: Noir grade by hour, colour only where light falls, Colour Blocks survivors and Former Townsfolk zombies.",
    knobs: TODAY,
  },
  {
    id: "hue-colour",
    label: "Before: colour by hue",
    version: 1,
    note: "The look before the light-colour rule: the whole sight area keeps colour and warm surfaces keep theirs.",
    knobs: { ...TODAY, lightColour: 0 },
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
]

export function lookPreset(id: string): OutbreakLookPreset | undefined {
  return OUTBREAK_LOOK_PRESETS.find(p => p.id === id)
}
