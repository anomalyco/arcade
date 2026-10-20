// Every player-facing line of the game shell, in one place to edit: the home screen, the title card, the pause menu
// and the first-time hint. Timings are in seconds.

export const GAME_TITLE = "ASHWOOD"

export const HOME = {
  /** Under the title. */
  subtitle: "Ashwood Station · 1984",
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
  /** Play, the instant it is pressed (before the title card has faded up). */
  starting: "Loading…",
}

/** The prelude: one screen, typed out once in full and left up (picked in prelude-lab, panel B). */
export const TITLE_CARD = {
  /** Centred lines; an empty string is a blank line. */
  lines: [
    "October 19, 1984",
    "",
    "Six researchers work at Ashwood Research Station,",
    "a remote government lab in the mountains.",
    "",
    "On October 17, their radio went silent.",
    "No one has heard from them since.",
    "",
    "You've been sent up there to find out why.",
  ],
  /** Typewriter speed, characters per second (an even rhythm). */
  typeRate: 14,
  /** Extra pause at each line end, in characters' time. */
  lineEnd: 4,
  /** Seconds of black before the first character. */
  lead: 0.9,
  /** Seconds the finished text holds before it dims. */
  dwell: 6,
  /** Seconds the text takes to dim, and the level it dims to, before the intro takes over. */
  dimTime: 3,
  dimTo: 0.16,
  skip: "Space to skip",
  /** Shown on the black after the prelude while the intro is still loading. */
  loading: "Loading…",
  /** Seconds after Play during which clicks and keys don't skip the prelude (an impatient second click on Play). */
  skipGuard: 0.8,
}

export const HINT = {
  look: "Click to look",
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
