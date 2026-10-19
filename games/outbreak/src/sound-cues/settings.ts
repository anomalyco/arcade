import type { LabControl } from "@arcade/kit/lab-panel"

/** Today: the small ground ripples the Unseen shroud switched on (fog-of-war sound cues). */
export const SOUND_CUES_TODAY = 0
/** A ring the size the dead hear each noise, a label at its source and arrows at the screen edge (default). */
export const SOUND_CUES_REACH = 1
/** A small pulsing mark and label at each source; only your own noises draw their reach. */
export const SOUND_CUES_MARKS = 2

/** Sound cue settings (AR-67); the values live in the HUD settings (Backquote › Sound cues). */
export const DEFAULT_SOUND_CUE_SETTINGS = {
  /** 1 Reach rings (default), 2 Source marks, 0 Today. */
  soundCueStyle: SOUND_CUES_REACH,
  /** Multiplies every cue's opacity. */
  soundCueOpacity: 1,
  /** Draw how far your own footsteps carry while you move. */
  soundCueOwnSteps: true,
  /** Name what made each sound ("Shot", "Glass") and how far it carries. */
  soundCueLabels: true,
  /** Marks for the dead you can hear moving out of sight (never their exact spot). */
  soundCueUnseen: true,
}

export type SoundCueSettings = typeof DEFAULT_SOUND_CUE_SETTINGS

export const soundCueControls: LabControl[] = [
  {
    key: "soundCueStyle",
    label: "Sound cues",
    group: "Sound cues",
    options: [
      { label: "Reach rings", value: SOUND_CUES_REACH },
      { label: "Source marks", value: SOUND_CUES_MARKS },
      { label: "Today (ground ripples)", value: SOUND_CUES_TODAY },
    ],
  },
  { key: "soundCueOpacity", label: "Cue opacity", group: "Sound cues", min: 0.2, max: 1.5, step: 0.05, unit: "×" },
  { key: "soundCueOwnSteps", label: "Show my footsteps' reach", group: "Sound cues" },
  { key: "soundCueLabels", label: "Name the sound and its reach", group: "Sound cues" },
  { key: "soundCueUnseen", label: "Unseen dead moving nearby", group: "Sound cues" },
]
