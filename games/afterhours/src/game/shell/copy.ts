// Every player-facing line of the game shell, in one place to edit: the home screen, the title card, the pause menu
// and the first-time hint. Timings are in seconds.

export const GAME_TITLE = "ASHWOOD"

export const HOME = {
  /** Under the title. */
  subtitle: "Ashwood Outpost · 1984",
  /** The VCR overlay in the corners. */
  osdChannel: "CH 03",
  osdStamp: "OCT 19 1984  01:52",
  loading: "acquiring signal",
  /** Under the loading static until the first key or click starts the sound. */
  prompt: "press any key for sound",
  /** The prompt's acknowledgement, briefly, once a key or click has started the sound. */
  promptDone: "sound on",
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
    { lines: ["October 19, 1984", "Ashwood Outpost", "Interagency Office of Propagation Studies"], hold: 2.4 },
    { lines: ["The station's radio has been silent for two days."], hold: 2.4 },
    { lines: ["Nobody answers the phone."], hold: 2.2 },
    { lines: ["You've been sent to find out why."], hold: 2.8 },
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
  /** Seconds of play the controls strip stays full each run before it fades to a low-opacity line ("First minutes"). */
  stripSeconds: 180,
  /** Seconds a one-time contextual hint stays up. */
  contextSeconds: 6,
  /** The one-time contextual hints, after their key cap. */
  context: {
    flashlight: "flashlight",
    map: "map",
    crouch: "crouch",
  },
}

export const CREDITS = {
  intro: "Ashwood. A game made in the browser with three.js.",
  mixamo: "Characters and animations: Mixamo, © Adobe Systems Incorporated. Used under the Adobe General Terms of Use; not for redistribution outside the game.",
  cmu: "Motion capture: CMU Graphics Lab Motion Capture Database (mocap.cs.cmu.edu), created with funding from NSF EIA-0196217.",
  textures: "Textures: Poly Haven and ambientCG, CC0 1.0.",
  font: "Typewriter face: Special Elite by Astigmatic, Apache License 2.0.",
  titleFont: "Title face: Rubik Glitch by The Rubik Filtered Project Authors, SIL Open Font License 1.1.",
  modelsHeading: "Models (CC BY 4.0, modified: rescaled, re-centred, optimised)",
  cc0: "Other models: Poly Haven, CC0 1.0.",
}
