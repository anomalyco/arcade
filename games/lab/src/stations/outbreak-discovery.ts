import type { StationCommand, StationVariant } from "@arcade/kit/lab/overworld/types"
import { defineStation } from "./define"

const page = "/arcade/outbreak/?seed=7&peaceful=1"
const stage = (scene: string): StationCommand[] => [
  { command: "scene.set-param", args: { key: "timeScale", value: 0 } },
  { command: "discovery.stage", args: { scene } },
]

const variants: StationVariant[] = [
  { id: "low-flashlight", label: "Low flashlight", note: "12% battery at night: the beam narrows, shortens, warms to amber and sputters. No ring, no words.", setup: stage("low-flashlight") },
  { id: "weakened-barricade", label: "Weakened barricade", note: "Three boards at half strength from inside: one flush, one bowed and split, one hanging from a nail.", setup: stage("weakened-barricade") },
  { id: "open-containers", label: "Opened containers", note: "Searched furniture stays open with what is left inside: the dresser drawer, the cabinet and fridge doors, the shelf.", setup: stage("open-containers") },
  { id: "drops", label: "Drops on the floor", note: "What the squad leaves lies on the floor as props, with no floating labels.", setup: stage("drops") },
]

export default defineStation({
  id: "outbreak-discovery",
  title: "Outbreak: Discovered, Not Told",
  summary:
    "State read from the world instead of labels: the flashlight's charge in its beam, barricade health in its boards, containers that open to show what is inside, and prompt words that fade once you know them. Tunables are in the Discovery group.",
  order: 121,
  prop: "panels",
  color: 0xd8b878,
  status: "live",
  demo: { kind: "page", url: page },
  defaultVariant: "weakened-barricade",
  variants: variants.map((v) => ({ ...v, url: page })),
  board: { feature: "AR-29", decision: "D-19" },
  metrics: [{ label: "Discovery tests", value: "6 game", source: "games/outbreak/tests/discovery.test.ts" }],
  paths: ["games/outbreak/shared/discovery", "games/outbreak/src/discovery"],
  branches: ["discovery*"],
  links: [{ label: "Play Outbreak", href: "/arcade/outbreak/?seed=7" }],
})
