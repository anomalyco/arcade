import { DEFAULT_VOLUME_SETTINGS, volumeControls, type MixCategory } from "@arcade/kit/audio"
import type { LabControl } from "@arcade/kit/lab-panel"

/**
 * Outbreak's sound settings. The player's volumes (Master, Effects, Ambience, Zombie voices; `@arcade/kit/audio`
 * volume, saved per game) sit on top of the mix tuned in the Lab's Audio mix group. Levels are percentages.
 * Outbreak has no music, so it shows no Music slider.
 */
export const DEFAULT_AUDIO_SETTINGS = {
  audioMuted: 0,
  ...DEFAULT_VOLUME_SETTINGS,
  audioWeapons: 100,
  audioZombies: 100,
  audioImpacts: 95,
  audioMovement: 85,
  audioAmbience: 65,
  audioUi: 80,
  /** How much walls and closed doors muffle sound, 0..1. */
  audioOcclusion: 1,
  /** Distance rolloff exponent for spatial sounds. */
  audioFalloff: 1.55,
  /** Reverb send level, 0..1. */
  audioReverb: 0.45,
  /** Simultaneous one-shot voices before the lowest-priority voice is stolen. */
  audioVoiceCap: 32,
}

export type AudioSettings = typeof DEFAULT_AUDIO_SETTINGS

/** Which settings level drives each runtime bus. */
export const AUDIO_BUS_LEVELS: Record<MixCategory, keyof AudioSettings> = {
  weapon: "audioWeapons",
  foley: "audioMovement",
  voice: "audioZombies",
  impact: "audioImpacts",
  ambience: "audioAmbience",
  ui: "audioUi",
  engine: "audioMovement",
  tyre: "audioMovement",
  spell: "audioWeapons",
}

/** The volume channels Outbreak has: zombie groans and moans are its voices. */
export const OUTBREAK_VOLUME_CHANNELS = ["master", "effects", "ambience", "voice"] as const

const level = (key: keyof AudioSettings, label: string): LabControl => ({ key, label, group: "Audio mix", min: 0, max: 100, step: 5, unit: "%" })

export const audioControls: LabControl[] = [
  { key: "audioMuted", label: "Mute (M)", group: "Volume", type: "toggle" },
  ...volumeControls(OUTBREAK_VOLUME_CHANNELS, "Volume", { voice: "Zombie voices" }),
  level("audioWeapons", "Weapons & combat"),
  level("audioZombies", "Zombies (vocals)"),
  level("audioImpacts", "Impacts & breaches"),
  level("audioMovement", "Foley & footsteps"),
  level("audioAmbience", "Ambience"),
  level("audioUi", "Interface"),
  { key: "audioOcclusion", label: "Wall occlusion", group: "Audio mix", min: 0, max: 1, step: 0.05, unit: "" },
  { key: "audioFalloff", label: "Distance falloff", group: "Audio mix", min: 0.8, max: 2.5, step: 0.05, unit: "×" },
  { key: "audioReverb", label: "Reverb", group: "Audio mix", min: 0, max: 1, step: 0.05, unit: "" },
  { key: "audioVoiceCap", label: "Voice cap", group: "Audio mix", min: 8, max: 48, step: 1, unit: "voices" },
]
