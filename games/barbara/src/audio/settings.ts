import type { LabControl } from "@arcade/kit/lab-panel"

/** The soundscape's mix, bound to the LabPanel (Backquote) › Sound. Levels are × the approved mix (1 = default). */
export const SOUND = {
  soundWind: 1,
  soundLeaves: 1,
  soundInsects: 1,
  soundLake: 1,
  soundCamp: 1,
  soundRoom: 1,
  soundFlares: 1,
  distantLevel: 1,
  soundReverb: 1,
  soundThunder: 1,
  soundRain: 1,
}
export type SoundSettings = typeof SOUND

export const SOUND_CONTROLS: LabControl[] = [
  { key: "distantLevel", label: "Distant sounds: loudness", group: "Sound", min: 0, max: 3, step: 0.05, unit: "×" },
  { key: "soundReverb", label: "Forest reverb", group: "Sound", min: 0, max: 2.5, step: 0.05, unit: "×" },
  { key: "soundWind", label: "Wind in the canopy", group: "Sound", subsection: "Layers", min: 0, max: 3, step: 0.05, unit: "×" },
  { key: "soundLeaves", label: "Leaves and needles", group: "Sound", subsection: "Layers", min: 0, max: 3, step: 0.05, unit: "×" },
  { key: "soundInsects", label: "Crickets", group: "Sound", subsection: "Layers", min: 0, max: 3, step: 0.05, unit: "×" },
  { key: "soundLake", label: "Lake and dock", group: "Sound", subsection: "Layers", min: 0, max: 3, step: 0.05, unit: "×" },
  { key: "soundCamp", label: "String-light buzz", group: "Sound", subsection: "Layers", min: 0, max: 3, step: 0.05, unit: "×" },
  { key: "soundRoom", label: "Forest room tone", group: "Sound", subsection: "Layers", min: 0, max: 3, step: 0.05, unit: "×" },
  { key: "soundFlares", label: "Road flares", group: "Sound", subsection: "Layers", min: 0, max: 3, step: 0.05, unit: "×" },
  { key: "soundThunder", label: "Thunder", group: "Sound", subsection: "Storm", min: 0, max: 3, step: 0.05, unit: "×" },
  { key: "soundRain", label: "Rain and drips", group: "Sound", subsection: "Storm", min: 0, max: 3, step: 0.05, unit: "×" },
]
