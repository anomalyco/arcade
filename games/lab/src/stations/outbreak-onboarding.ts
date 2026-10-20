import type { StationVariant } from "@arcade/kit/lab/stations/types"
import { defineStation } from "./define"

const page = "/arcade/outbreak/?seed=7&peaceful=1"
const beat = (id: string) => [{ command: "onboarding.beat", args: { beat: id } }]
const set = (key: string, value: number | boolean) => ({ command: "scene.set-param", args: { key, value } })

// One variant per beat of the training room, in the order the house lays them out; each jumps there with the beats
// before it done. Play from any of them; walk out of the front yard to cut to the run.
const beats: [string, string, string][] = [
  ["move", "Wake", "Beside the bed at dawn: WASD over you until you have moved."],
  ["light", "Flashlight", "F and the bulb glyph until the light is on."],
  ["search", "Search the dresser", "E and the search glyph over the dresser; in reach, the prompt and outline take over."],
  ["take", "Take what's in it", "Two planks and two chemicals: picking the chemicals up fills the bandage in on the recipe board."],
  ["craft", "Recipe board", "E at the workbench opens the board; a digit makes the bandage."],
  ["door-open", "Open the hall door", "E and the door-open glyph over the bedroom door."],
  ["door-close", "Shut it behind you", "Once through, E and the door-close glyph."],
  ["crouch", "Crouch over the glass", "Hold Ctrl near the glass the dead broke in through: crouched, it doesn't crunch."],
  ["board", "Board the window", "B and the board-up glyph over the window it came through; the prompt shows the board pips."],
  ["sprint", "Sprint", "Shift while you move."],
  ["front-door", "Front door", "E at the front door."],
  ["melee", "The chained one", "V (shove) at the zombie chained in the yard; LMB finishes it once it is down. Then the street."],
]

const variants: StationVariant[] = [
  ...beats.map(([id, label, note]) => ({ id, group: "Training room", label, note, setup: beat(id) })),
  { id: "prompt-clear", group: "Prompts", label: "Clear prompts (default)", note: "Verbs for each action's first three uses, the outline on the target, B on doors and windows, a stamp after.", setup: [set("promptClarity", 1), ...beat("door-open")] },
  { id: "prompt-today", group: "Prompts", label: "Today (glyph only)", note: "D-25 Bold Glyph as it was: no words, no outline, boarding unprompted.", setup: [set("promptClarity", 0), ...beat("door-open")] },
]

export default defineStation({
  id: "outbreak-onboarding",
  title: "Outbreak onboarding",
  summary:
    "The training room (your house at dawn, wordless key caps and glyphs, 2–3 minutes, hold Esc to skip) and the clearer E prompts that came out of Aiden's \"everything is E\". Pick a beat to jump there, or a prompt style.",
  order: 137,
  prop: "figure",
  color: 0xf1c46a,
  status: "review",
  statusNote: "AR-89",
  demo: { kind: "page", url: page },
  defaultVariant: ["move"],
  variants: variants.map((v) => ({ ...v, url: page })),
  board: { feature: "AR-89" },
  paths: ["games/outbreak/src/onboarding", "games/outbreak/shared/onboarding", "games/outbreak/src/prompt-clarity", "docs/outbreak-onboarding.md"],
  branches: ["outbreak-onboarding*", "outbreak-training*"],
  links: [
    { label: "Play Outbreak", href: "/arcade/outbreak/" },
    { label: "How it works", href: "https://github.com/anomalyco/arcade/blob/main/docs/outbreak-onboarding.md" },
  ],
  layout: {
    left: [{ widget: "status" }],
    dock: [{ widget: "variants" }],
  },
})
