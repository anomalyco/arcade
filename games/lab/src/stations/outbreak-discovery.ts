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
  { id: "crouch", label: "Crouch over a tripwire", note: "Cans strung a stride inside the pharmacy door. Walk through and they rattle; hold Ctrl and you step over them, slower, quieter and smaller to the dead.", setup: stage("crouch") },
  { id: "tripwire", label: "Disarm a tripwire", note: "Inside the pharmacy facing the cans. E works them loose without a sound, and whoever does learns to make one; the cans go in hand to string across another door.", setup: stage("tripwire") },
  { id: "closet", label: "Hiding in a closet", note: "Inside the bedroom closet at night, the room through the louvres. The dead cannot see or hear you; one that saw you go in searches where you were. E steps out.", setup: stage("closet") },
  { id: "peephole", label: "Peephole", note: "Shift+E at a shut front door looks out through it at the porch without opening up. E stops.", setup: stage("peephole") },
  { id: "bottle", label: "Throwing a bottle", note: "Bottles in hand on the street. Click to throw one: it breaks where it lands, loud, and beside a car it can set the alarm off.", setup: stage("bottle") },
  { id: "car-alarm", label: "Car alarm", note: "A car with its window put in and the alarm going: indicators flashing and a wail every beat until the battery dies. Half the abandoned cars have one.", setup: stage("car-alarm") },
  { id: "repair", label: "Crowbar repair", note: "A worn barricade and a crowbar in hand. B re-nails it to full instead of adding a board; practice makes it faster and quieter.", setup: stage("repair") },
]

export default defineStation({
  id: "outbreak-discovery",
  title: "Outbreak: Discovered, Not Told",
  summary:
    "State read from the world instead of labels: the flashlight's charge in its beam, barricade health in its boards, containers that open to show what is inside, prompt words that fade once you know them, and a workbench where two materials tried together on the mat pin a pencil sketch to the corkboard. Knowledge is found too: flyers, charts and photos left in buildings, a reinforced window to study, and hands that board up faster and quieter with practice or from watching a teammate. New verbs are learned by doing: crouching, closets and peepholes, bottles, can tripwires and car alarms as lures, and crowbar repairs. Tunables are in the Discovery, Progression and Verbs groups.",
  order: 121,
  prop: "panels",
  color: 0xd8b878,
  status: "live",
  demo: { kind: "page", url: page },
  defaultVariant: "weakened-barricade",
  variants: variants.map((v) => ({ ...v, url: page })),
  board: { feature: "AR-29", decision: "D-19" },
  metrics: [{ label: "Discovery tests", value: "6 + 12 tinkering + 12 found + 19 verbs + 3 co-op", source: "games/outbreak/tests/discovery.test.ts, tinker.test.ts, found.test.ts, verbs.test.ts, coop.test.ts" }],
  paths: ["games/outbreak/shared/discovery", "games/outbreak/src/discovery"],
  branches: ["discovery*"],
  links: [{ label: "Play Outbreak", href: "/arcade/outbreak/?seed=7" }],
})
