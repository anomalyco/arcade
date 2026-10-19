// Every player-facing line of the game shell, in one place to edit: the home screen, the title card, the pause menu
// and the first-time hint. Timings are in seconds.

export const GAME_TITLE = "STATIC"

export const HOME = {
  /** Under the title. */
  subtitle: "Pine Hollow Station · 1984",
  /** The VCR overlay in the corners. */
  osdChannel: "CH 03",
  osdStamp: "OCT 19 1984  01:52",
  loading: "acquiring signal",
  /** Under the loading static until the first key or click starts the sound. */
  prompt: "press any key",
  ready: "",
  failed: "No signal. This browser needs WebGPU.",
}

export const MENU = {
  play: "Play",
  character: "Character",
  settings: "Settings",
  credits: "Credits",
  quit: "Quit to title",
  back: "Back",
  resume: "Resume",
  paused: "Paused",
  waiting: "Tuning in…",
}

export type TitleCard = {
  /** Lines typed one after another; the first is set larger. */
  lines: string[]
  /** Seconds the finished card stays up before it fades. */
  hold: number
}

export const TITLE_CARD = {
  cards: [
    { lines: ["October 19, 1984", "Pine Hollow Station", "Interagency Office of Propagation Studies"], hold: 2.4 },
    { lines: ["Six staff on the Sublevel rotation", "are unaccounted for."], hold: 2.4 },
    { lines: ["Last night, a receiver in town picked up", "a transmission on the station's frequency.", "Nobody at the station answers the phone."], hold: 2.8 },
    { lines: ["It's probably nothing.", "You've been sent to take a look."], hold: 2.6 },
  ] satisfies TitleCard[],
  /** Typewriter speed, characters per second. */
  typeRate: 38,
  /** Pause between lines of one card. */
  linePause: 0.45,
  fadeIn: 0.9,
  fadeOut: 1.4,
  /** Black between cards. */
  gap: 0.6,
  /** Black before the first card and after the last. */
  lead: 1.2,
  tail: 1.0,
  skip: "Space to skip",
}

export const HINT = {
  look: "Click to look",
  /** Seconds the first-time controls hint stays up once the player has looked around. */
  seconds: 12,
}

export const CREDITS = {
  intro: "A game made in the browser with three.js.",
  mixamo: "Characters and animations: Mixamo, © Adobe Systems Incorporated. Used under the Adobe General Terms of Use; not for redistribution outside the game.",
  cmu: "Motion capture: CMU Graphics Lab Motion Capture Database (mocap.cs.cmu.edu), created with funding from NSF EIA-0196217.",
  textures: "Textures: Poly Haven and ambientCG, CC0 1.0.",
  font: "Typewriter face: Special Elite by Astigmatic, Apache License 2.0.",
  modelsHeading: "Models (CC BY 4.0, modified: rescaled, re-centred, optimised)",
  cc0: "Other models: Poly Haven, CC0 1.0.",
}
