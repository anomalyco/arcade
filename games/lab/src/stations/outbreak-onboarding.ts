import type { StationVariant } from "@arcade/kit/lab/stations/types"
import { defineStation } from "./define"

const page = "/arcade/outbreak/?seed=7&peaceful=1"
// `lobby=1` opens the lobby, and the practice space with it, despite the other parameters.
const lobbyPage = "/arcade/outbreak/?lobby=1&seed=7"
const beat = (id: string) => [{ command: "onboarding.beat", args: { beat: id } }]
const set = (key: string, value: number | boolean) => ({ command: "scene.set-param", args: { key, value } })

// One variant per beat of the training room, in the order the house lays them out; each jumps there with the beats
// before it done. Play from any of them; walk out of the front yard to cut to the run.
const beats: [string, string, string][] = [
  ["move", "Wake", "Beside the bed at dawn: WASD over you until you have moved."],
  ["light", "Flashlight", "F and the bulb glyph until the light is on."],
  ["search", "Search the dresser", "E and the search glyph over the dresser; in reach, the prompt and outline take over."],
  ["take", "Take what's in it", "Two planks and two chemicals: picking the chemicals up fills the bandage in on the recipe board."],
  ["case", "Open the case", "Tab over you until the Attaché Case is open: what you just took lies in it at its shape."],
  ["craft", "Recipe board", "E at the workbench opens the board; a digit makes the bandage."],
  ["door-open", "Open the hall door", "E and the door-open glyph over the bedroom door."],
  ["door-close", "Shut it behind you", "Once through, E and the door-close glyph."],
  ["crouch", "Crouch over the glass", "Hold Z near the glass the dead broke in through: crouched, it doesn't crunch."],
  ["board", "Board the window", "B and the board-up glyph over the window it came through; the prompt shows the board pips."],
  ["sprint", "Sprint", "Shift while you move."],
  ["front-door", "Front door", "E at the front door."],
  ["melee", "The chained one", "V (shove) at the zombie chained in the yard; LMB finishes it once it is down. Then the street."],
]

const practice: StationVariant[] = [
  { id: "practice", group: "Lobby practice", label: "Practise while you pick (default)", note: "The lobby docks left over Ash at dawn: walk, F, E, B, Tab, the recipe board and the chained one with the kit you picked. Enter plays.", url: lobbyPage, setup: [set("lobbyPractice", 1)] },
  { id: "practice-board", group: "Lobby practice", label: "At the window", note: "In the practice space at the east window with your kit's planks: B boards it.", url: lobbyPage, setup: [set("lobbyPractice", 1), ...beat("board")] },
  { id: "practice-melee", group: "Lobby practice", label: "The chained one", note: "Swing or shoot with the kit you picked; it comes back three seconds after it goes down. Change the kit in the panel to try another.", url: lobbyPage, setup: [set("lobbyPractice", 1), ...beat("melee")] },
  { id: "practice-today", group: "Lobby practice", label: "Today (paused lobby)", note: "The lobby as it was: a menu over a still frame.", url: lobbyPage, setup: [set("lobbyPractice", 0)] },
]

const variants: StationVariant[] = [
  ...practice,
  ...beats.map(([id, label, note]) => ({ id, group: "Training room", label, note, url: page, setup: beat(id) })),
  { id: "prompt-clear", group: "Prompts", label: "Clear prompts (default)", note: "Verbs for each action's first three uses, the outline on the target, B on doors and windows, a stamp after.", url: page, setup: [set("promptClarity", 1), ...beat("door-open")] },
  { id: "prompt-today", group: "Prompts", label: "Today (glyph only)", note: "D-25 Bold Glyph as it was: no words, no outline, boarding unprompted.", url: page, setup: [set("promptClarity", 0), ...beat("door-open")] },
]

export default defineStation({
  id: "outbreak-onboarding",
  title: "Outbreak onboarding",
  summary:
    "Practise in the lobby (Kit: \"While loading out you can train\"): you stand in your house at dawn with the kit you picked while you choose and wait, solo or in a room. The guided training room (one setting away) and the clearer E prompts from Aiden's \"everything is E\" are here too.",
  order: 139,
  prop: "figure",
  color: 0xf1c46a,
  status: "review",
  statusNote: "AR-89",
  demo: { kind: "page", url: page },
  defaultVariant: ["practice"],
  variants,
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
