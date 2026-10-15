import type { MixCategory } from "@arcade/kit/audio"
import type { LabControl } from "@arcade/kit/lab-panel"

/** Outbreak's mix, tuned in the Lab panel's Audio group. Levels are percentages; mute and master persist per browser. */
export const DEFAULT_AUDIO_SETTINGS = {
  audioMuted: 0,
  audioMaster: 80,
  audioWeapons: 100,
  audioMovement: 100,
  audioZombies: 100,
  audioAmbience: 70,
  audioUi: 80,
  /** How much walls and closed doors muffle sound, 0..1. */
  audioOcclusion: 1,
  /** Reverb send level, 0..1. */
  audioReverb: 0.45,
  /** Simultaneous one-shot voices before the oldest is stolen. */
  audioVoiceCap: 24,
}

export type AudioSettings = typeof DEFAULT_AUDIO_SETTINGS

/** Which settings level drives each runtime bus. */
export const AUDIO_BUS_LEVELS: Record<MixCategory, keyof AudioSettings> = {
  weapon: "audioWeapons",
  foley: "audioMovement",
  voice: "audioZombies",
  impact: "audioZombies",
  ambience: "audioAmbience",
  ui: "audioUi",
  engine: "audioMovement",
  tyre: "audioMovement",
  spell: "audioWeapons",
}

const level = (key: keyof AudioSettings, label: string): LabControl => ({ key, label, group: "Audio", min: 0, max: 100, step: 5, unit: "%" })

export const audioControls: LabControl[] = [
  { key: "audioMuted", label: "Mute (M)", group: "Audio", type: "toggle" },
  level("audioMaster", "Master"),
  level("audioWeapons", "Weapons"),
  level("audioMovement", "Footsteps, doors & looting"),
  level("audioZombies", "Zombies & impacts"),
  level("audioAmbience", "Ambience"),
  level("audioUi", "Interface"),
  { key: "audioOcclusion", label: "Wall occlusion", group: "Audio", min: 0, max: 1, step: 0.05, unit: "" },
  { key: "audioReverb", label: "Reverb", group: "Audio", min: 0, max: 1, step: 0.05, unit: "" },
  { key: "audioVoiceCap", label: "Voice cap", group: "Audio", min: 8, max: 48, step: 1, unit: "voices" },
]
