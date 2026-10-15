import type { StationVariant } from "@arcade/kit/lab/stations/types"
import { defineStation } from "./define"

const page = "/arcade/archers/playground.html?nolab"

const items = [
  ["bomb", "Bomb arrows", "Bursts where it lands and takes out anyone close."],
  ["laser", "Laser arrows", "Instant, goes through everyone in its path and bounces off walls."],
  ["drill", "Drill arrows", "Bores up through a ledge to hit the archer standing on it."],
  ["bramble", "Bramble arrows", "Grows a thorn hedge where it sticks; the target walks into it."],
  ["shield", "Shield", "Takes one hit: the first arrow breaks it, the second kills."],
  ["wings", "Wings", "Flap with jump in the air, hold it to glide."],
] as const

const variants: StationVariant[] = [
  {
    id: "belltower",
    label: "Bell Tower (4 bots)",
    note: "The arena preview: four bots on the production World, rounds back to back.",
    url: `${page}#round/belltower`,
    setup: [{ command: "archers.scene", args: { scene: "round", arena: "belltower" } }],
  },
  {
    id: "cloister",
    label: "Cloister (4 bots)",
    note: "The second arena with four bots.",
    url: `${page}#round/cloister`,
    setup: [{ command: "archers.scene", args: { scene: "round", arena: "cloister" } }],
  },
  {
    id: "practice",
    label: "Practice vs bots",
    note: "Click in and play (WASD or arrows, Space jump, Shift draw, E dodge) while the Moves knobs change running, jumping, walls, dodging and arrows live.",
    url: `${page}#practice/belltower/1`,
    setup: [{ command: "archers.scene", args: { scene: "practice", arena: "belltower", bots: 1 } }],
  },
  ...items.map(([id, label, note]): StationVariant => ({
    id,
    label,
    note: `${note} A scripted shooter and target on the real World, looping.`,
    url: `${page}#items/${id}`,
    setup: [{ command: "archers.scene", args: { scene: "items", item: id } }],
  })),
]

export default defineStation({
  id: "archers",
  title: "Archers: arenas, moves and power-ups",
  summary:
    "Archers' arenas with four bots, practice against bots with every movement and combat number on the Moves knobs (defaults are the shipped values; Reset restores them), and a gallery of the six power-ups, all on the production World, renderer and HUD.",
  order: 136,
  prop: "figure",
  color: 0xff7a2a,
  status: "in-progress",
  demo: { kind: "page", url: `${page}#round/belltower` },
  defaultVariant: "belltower",
  variants,
  board: { feature: "AR-39" },
  metrics: [
    { label: "Move knobs", value: "29 (run, jump, walls and ledges, dodge and catch, arrows and stomps, wings)", source: "games/archers/shared/tuning.ts" },
    { label: "Power-ups", value: "6 (bomb, laser, drill, bramble, shield, wings)", source: "games/archers/shared/world.ts" },
  ],
  paths: ["games/archers/"],
  branches: ["archers*"],
  links: [
    { label: "Archers", href: "/arcade/archers/" },
    { label: "Play online", href: "/arcade/archers/?online" },
  ],
  layout: {
    left: [{ widget: "status" }],
    right: [{ widget: "controls", groups: ["Scene", "Moves"], title: "Moves" }],
    dock: [{ widget: "variants" }],
  },
})
