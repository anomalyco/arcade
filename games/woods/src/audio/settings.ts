import type { LabControl } from "@arcade/kit/lab-panel"

/** The soundscape's mix, bound to the LabPanel (Backquote) › Sound. Levels are × the approved mix (1 = default). */
export const SOUND = {
  soundWind: 1,
  soundLeaves: 1,
  soundInsects: 1,
  soundLake: 1,
  soundCamp: 1,
  soundRoom: 1,
  distantRate: 1,
  distantLevel: 1,
  soundReverb: 1,
}
export type SoundSettings = typeof SOUND

export const SOUND_CONTROLS: LabControl[] = [
  { key: "soundWind", label: "Wind in the canopy", group: "Sound", min: 0, max: 3, step: 0.05, unit: "×" },
  { key: "soundLeaves", label: "Leaves and needles", group: "Sound", min: 0, max: 3, step: 0.05, unit: "×" },
  { key: "soundInsects", label: "Crickets", group: "Sound", min: 0, max: 3, step: 0.05, unit: "×" },
  { key: "soundLake", label: "Lake and dock", group: "Sound", min: 0, max: 3, step: 0.05, unit: "×" },
  { key: "soundCamp", label: "String-light buzz", group: "Sound", min: 0, max: 3, step: 0.05, unit: "×" },
  { key: "soundRoom", label: "Forest room tone", group: "Sound", min: 0, max: 3, step: 0.05, unit: "×" },
  { key: "distantRate", label: "Distant sounds: how often", group: "Sound", min: 0, max: 6, step: 0.1, unit: "×" },
  { key: "distantLevel", label: "Distant sounds: loudness", group: "Sound", min: 0, max: 3, step: 0.05, unit: "×" },
  { key: "soundReverb", label: "Forest reverb", group: "Sound", min: 0, max: 2.5, step: 0.05, unit: "×" },
]
