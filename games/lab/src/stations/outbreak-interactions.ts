import type { StationCommand, StationVariant } from "@arcade/kit/lab/stations/types"
import { defineStation } from "./define"

const page = "/arcade/outbreak/?seed=7&peaceful=1"
const set = (key: string, value: number): StationCommand => ({ command: "scene.set-param", args: { key, value } })
const stage = (scene: string): StationCommand[] => [set("timeScale", 1), set("interactions.throwables", 1), { command: "interactions.stage", args: { scene } }]

const variants: StationVariant[] = [
  { id: "baseball", group: "Throwables", label: "Baseball bonk", note: "Dusk, three baseballs in hand, three of the dead up the road. Hold the left button: the arc and its landing ring grow as you wind up (red when it will hit). A quick throw flies at head height and bonks one down; it lies there to be picked up again.", setup: stage("baseball") },
  { id: "can", group: "Throwables", label: "Tin can lure", note: "Night, a knot of five ahead. Wind up fully and lob a can over their heads: it lands behind them with a clatter and they turn to it.", setup: stage("can") },
  { id: "bottle", group: "Throwables", label: "Bottle", note: "The same knot with bottles: they shatter where they land, loud, and leave glass that crunches underfoot. Near an abandoned car, its alarm goes off.", setup: stage("bottle") },
  { id: "drag", group: "Drag & brace", label: "Drag a dresser to the door", note: "Night in Ash's house, a loose dresser between you and the front door, the dead in the street. E takes hold of it (you slow to half pace, no sprinting); walk it to the door and E braces it: the door slams shut and the dead must bash through the dresser.", setup: stage("drag") },
  { id: "brace", group: "Drag & brace", label: "Dead bashing a braced door", note: "The dresser already braced against Ash's front door and four of the dead coming for it. They bash it until it is shoved into the room and falls over; E on it (Pull away / Drag) puts it back up.", setup: stage("brace") },
  { id: "brick", group: "Throwables", label: "Brick through a window", note: "Four metres off one of Ash's shut windows with a brick. It goes through the glass and lands inside; the window is open to climb now.", setup: stage("brick") },
]

export default defineStation({
  id: "outbreak-interactions",
  title: "Outbreak world interactions",
  summary:
    "New ways to act on the world (Kit after the co-op playtest: \"baseballs you can throw? The ability to drag items. Or board up windows?\"). Throwables: baseballs, bricks, rocks, tin cans and bottles lie in yards, on porches and on floors; hold the left button to wind up with an arc preview, release to throw. They fly over heads in a long lob, hit the first of the dead near either end, bounce off walls and cars, roll, and are heard where they land. Loose furniture (chairs, tables, dressers, mattresses) is dragged with E, slowly, and set down against a door or window it braces it: the dead bash the planks off first, then the furniture, until it is shoved over. A downed teammate can be dragged to safety (tap E; hold still revives). Every rule is authoritative in the shared sim and rides the ledger to co-op seats. Lab › Interactions (each interaction's Today is one setting away).",
  order: 137,
  prop: "panels",
  color: 0xd8b25a,
  status: "live",
  demo: { kind: "page", url: page },
  defaultVariant: "baseball",
  pickOne: true,
  variants: variants.map((v) => ({ ...v, url: page })),
  board: { feature: "AR-96" },
  metrics: [{ label: "Interaction tests", value: "13 sim + 2 co-op", source: "games/outbreak/tests/interactions-throwables.test.ts, interactions-drag.test.ts, coop-ledger-features.test.ts" }],
  paths: ["games/outbreak/shared/interactions", "games/outbreak/src/interactions"],
  branches: ["outbreak-interactions*"],
  links: [{ label: "Play Outbreak", href: "/arcade/outbreak/?seed=7" }],
})
