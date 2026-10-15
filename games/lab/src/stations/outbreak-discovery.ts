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
  { id: "bench-tinker", label: "Bench tinkering", note: "Plank and scrap are on the mat. Hold E to try them; tap E to lay out the next pair you can make up.", setup: stage("bench-tinker") },
  { id: "corkboard", label: "Corkboard", note: "Sketches pinned in three players' colours, an idea waiting on the toolbox, and two crossed-out tries.", setup: stage("corkboard") },
  { id: "dark-bench", label: "Bench at night", note: "Chem and chem on the mat with the flashlight off: too dark to try. Press F and hold E again.", setup: stage("dark-bench") },
  { id: "page", label: "A page in the hardware store", note: "A printed flyer lies on a shelf. E reads it: the squad learns the reinforced barricade and the flyer goes up on the corkboard.", setup: stage("page") },
  { id: "page-read", label: "Reading a page", note: "The pharmacy's chart held up to the camera after reading it: two materials and what they make, no words.", setup: stage("page-read") },
  { id: "found-pages", label: "Found pages on the corkboard", note: "A sketch made at the bench beside a flyer, a chart and a photo found in town, each pinned in the finder's colour.", setup: stage("found-pages") },
  { id: "held-out", label: "A held-out window", note: "A window someone boarded from inside and strapped with steel, as streamed warehouses have (staged on the hardware store). Stand still and look at it to learn how.", setup: stage("held-out") },
]

export default defineStation({
  id: "outbreak-discovery",
  title: "Outbreak: Discovered, Not Told",
  summary:
    "State read from the world instead of labels: the flashlight's charge in its beam, barricade health in its boards, containers that open to show what is inside, prompt words that fade once you know them, and a workbench where two materials tried together on the mat pin a pencil sketch to the corkboard. Knowledge is found too: flyers, charts and photos left in buildings, a reinforced window to study, and hands that board up faster and quieter with practice or from watching a teammate. Tunables are in the Discovery and Progression groups.",
  order: 121,
  prop: "panels",
  color: 0xd8b878,
  status: "live",
  demo: { kind: "page", url: page },
  defaultVariant: "weakened-barricade",
  variants: variants.map((v) => ({ ...v, url: page })),
  board: { feature: "AR-29", decision: "D-19" },
  metrics: [{ label: "Discovery tests", value: "6 + 11 tinkering + 12 found + 2 co-op", source: "games/outbreak/tests/discovery.test.ts, tinker.test.ts, found.test.ts, coop.test.ts" }],
  paths: ["games/outbreak/shared/discovery", "games/outbreak/src/discovery"],
  branches: ["discovery*"],
  links: [{ label: "Play Outbreak", href: "/arcade/outbreak/?seed=7" }],
})
