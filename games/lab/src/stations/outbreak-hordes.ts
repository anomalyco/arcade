import type { StationCommand, StationVariant } from "@arcade/kit/lab/stations/types"
import { defineStation } from "./define"

const page = "/arcade/outbreak/?seed=7&peaceful=1"
const set = (key: string, value: number | boolean) => ({ command: "scene.set-param", args: { key, value } })
const stage = (scene: string, size: number, overlay = false): StationCommand[] => [
  set("timeScale", 0),
  set("zoom", 65),
  set("hordes.hordeFlowOverlay", overlay),
  { command: "hordes.stage", args: { scene, size } },
  set("hour", 23),
]

const variants: StationVariant[] = [
  {
    id: "street",
    label: "Street Horde (800)",
    note: "800 zombies walk the main street north to south at night, in 30 m legs, each leg one shared flow field. The camera follows the horde.",
    setup: stage("street", 800),
  },
  {
    id: "split",
    label: "Building Split",
    note: "A horde west of the hardware store heads for a point east of it and splits around both sides; nobody cuts through the walls.",
    setup: stage("split", 150, true),
  },
  {
    id: "funnel",
    label: "Door Funnel",
    note: "The hardware store's front door is open and the goal is inside: the horde funnels through the 1.4 m doorway.",
    setup: stage("funnel", 120, true),
  },
  {
    id: "barricade",
    label: "Barricade Pile-Up",
    note: "Same goal behind three barricade planks: the horde piles against the door and bashes the planks down.",
    setup: stage("barricade", 120),
  },
  {
    id: "gunshot",
    label: "Gunshot Peel",
    note: "Two hordes and one gunshot up north. Hordes hear 2.5× farther than a zombie, through walls: the near horde peels off, the far one keeps wandering.",
    setup: stage("gunshot", 300),
  },
  {
    id: "crossroads",
    label: "Crossroads (1,000)",
    note: "1,000 zombies idle up the north and east streets. Use Hordes → Fire a gunshot here to pull both onto the survivor.",
    setup: stage("crossroads", 1000),
  },
]

export default defineStation({
  id: "outbreak-hordes",
  title: "Outbreak flow-field hordes",
  summary:
    "Roaming hordes of 500–1,000 zombies. Out of range a horde is a point on the map that hears loud noises through walls and walks toward them; near a survivor it materializes and its members follow shared flow fields around buildings and through doors. Tunables are in the Hordes group, with a flow-field overlay and a camera that follows the horde.",
  order: 122,
  prop: "figure",
  color: 0x8a6ad4,
  status: "live",
  demo: { kind: "page", url: page },
  defaultVariant: "street",
  variants: variants.map((v) => ({ ...v, url: page })),
  board: { feature: "AR-17", decision: "D-10" },
  metrics: [
    {
      label: "Crowd sim tick p95, 1,000 zombies (A* → flow fields)",
      value: "1.94 → 2.33 ms · stuck 3.4% → 0.7%",
      source: "games/outbreak/scripts/horde-bench.ts",
    },
    {
      label: "Co-op, 4 players, live horde (500 / 1,000)",
      value: "24 / 41 KB/s per player down",
      source: "games/outbreak/scripts/coop-bench.ts --horde=",
    },
  ],
  paths: [
    "packages/kit/sim/flow-field.ts",
    "games/outbreak/shared/hordes/index.ts",
    "games/outbreak/src/hordes",
    "games/outbreak/scripts/horde-proof.ts",
  ],
  branches: ["flow-hordes*"],
  links: [{ label: "Play Outbreak", href: "/arcade/outbreak/?seed=7" }],
  layout: {
    left: [{ widget: "status" }, { widget: "metrics" }],
    dock: [{ widget: "variants" }],
  },
})
