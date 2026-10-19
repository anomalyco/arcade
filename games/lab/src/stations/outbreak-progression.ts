import type { StationCommand, StationVariant } from "@arcade/kit/lab/overworld/types"
import { defineStation } from "./define"

const page = "/arcade/outbreak/?seed=7&peaceful=1"
const stage = (scene: string): StationCommand[] => [{ command: "scene.set-param", args: { key: "timeScale", value: 0 } }, { command: "progression.stage", args: { scene } }]

const variants: StationVariant[] = [
  { id: "search", label: "Unsearched dresser", note: "E searches quietly (1.2 s), Shift+E smashes it open (0.35 s, loud).", setup: stage("search") },
  { id: "strip", label: "Container strip", note: "Searched: the dresser stays open with what is inside (Discovery group: turn off Opened containers show contents for the old list). E takes all.", setup: stage("strip") },
  { id: "bench", label: "Workbench, day", note: "E installs the toolbox, which fills in reinforcing. E again opens the bench's recipe board; a digit makes a row.", setup: stage("bench") },
  { id: "dark-bench", label: "Workbench, night", note: "Too dark to make bench recipes with the flashlight off. Press F and try again.", setup: stage("dark-bench") },
  { id: "generator", label: "Generator wired", note: "The car battery lights the bench at night and hums at 18 m.", setup: stage("generator") },
  { id: "field-craft", label: "Field craft", note: "C anywhere opens the recipe panel; digits make what the squad has learned (bench recipes say where).", setup: stage("field-craft") },
  { id: "handoff", label: "Hand-offs", note: "A dropped medkit, a supply bundle, a ping and a noisemaker.", setup: stage("handoff") },
  {
    id: "first-night",
    label: "First night opening (17:30 dusk)",
    note: "20 m safe radius around spawn & Ash House, sparse wandering shamblers (25% initial density), the last daylight plus the flashlight at the workbench, and a Pacing group in the Lab.",
    url: "/arcade/outbreak/?seed=7",
    setup: [{ command: "pacing.stage", args: { scene: "opening-calm" } }],
  },
]

export default defineStation({
  id: "outbreak-progression",
  title: "Outbreak inventory and workbench",
  summary:
    "The live game's belt, hotbar, pack and container strips, and the safehouse workbench whose recipe board fills in as the squad picks up materials. Tunables are in the Progression group.",
  order: 113,
  prop: "panels",
  color: 0xc5cfb8,
  status: "live",
  demo: { kind: "page", url: page },
  defaultVariant: "bench",
  variants: variants.map((v) => ({ ...v, url: page })),
  board: { feature: "AR-18", decision: "D-11" },
  metrics: [
    { label: "Ledger and progression tests", value: "10 kit + 27 game + 4 co-op", source: "packages/kit/sim/ledger.test.ts, games/outbreak/tests" },
  ],
  paths: ["games/outbreak/shared/progression.ts", "packages/kit/sim/ledger.ts", "games/outbreak/src/inventory-hud.ts"],
  branches: ["outbreak-progression*"],
  links: [{ label: "Play Outbreak", href: "/arcade/outbreak/?seed=7" }],
})
