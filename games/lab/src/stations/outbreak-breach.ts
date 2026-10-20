import type { StationCommand, StationVariant } from "@arcade/kit/lab/stations/types"
import { defineStation } from "./define"

const page = "/arcade/outbreak/?seed=7&peaceful=1"
const set = (key: string, value: number) => ({ command: "scene.set-param", args: { key, value } })
const stage = (scene: string, mode = 1): StationCommand[] => [set("timeScale", 1), set("breachMode", mode), { command: "breach.stage", args: { scene } }]

const wear: { id: string; label: string; note: string }[] = [
  { id: "sound", label: "Sound", note: "One of the dead hitting a sound door: it jolts in its frame and knocks ajar against the latch, the handle rattles, dust puffs from the inside face." },
  { id: "cracked", label: "Cracked", note: "Cracks spread from the latch where the hits land; each hit cracks louder." },
  { id: "split", label: "Split", note: "A panel splits down the middle stile, raw wood showing; light from the lit street shows through the gaps." },
  { id: "failing", label: "Failing", note: "Cracks everywhere, the lock plate sprung, the hinges bending off the frame and the door sagging." },
  { id: "holed", label: "Punched through", note: "Two pushing: a panel is punched through and arms reach in, grabbing whoever stands in front of it." },
  { id: "giving", label: "Giving", note: "The warning beat (Doors & barricades › Warning beat, 1.1 s): a loud crack, the door bulges and shakes and groans, then gives." },
]

const breaches: { id: string; label: string; note: string }[] = [
  { id: "hinges", label: "Off the hinges", note: "Kicked off its hinges and slammed flat into the room, the first of the dead falling in over it. The slab stays where it fell: E wedges it back across the frame as one strong board." },
  { id: "split-door", label: "Split down the middle", note: "Split in two (a Brute, or by chance): the hinge half hangs swung in, the latch half falls flat." },
  { id: "crush", label: "Horde crush", note: "Five pushing at once burst the frame: jambs and header fly in with the door, and the crowd spills in one by one." },
  { id: "boards", label: "Boards fly", note: "The last board hangs by a nail for the warning beat, then flies into the room." },
  { id: "burst", label: "Window bursts", note: "A boarded window gives: glass and the board burst in, and the window stays smashed open (the dead climb through)." },
  { id: "brace", label: "Bracing", note: "Leaning on the door from inside while three push: every hit lands at 0.45×, jolts you, and costs stamina." },
]

const variants: StationVariant[] = [
  ...wear.map((w): StationVariant => ({ id: w.id, group: "Wear", label: w.label, note: w.note, setup: stage(w.id) })),
  ...breaches.map((b): StationVariant => ({ id: b.id, group: "Breaches", label: b.label, note: b.note, setup: stage(b.id) })),
  { id: "today", group: "Today", label: "Today", note: "Today: a door pops open on its third hit with no warning and can be shut again good as new; planks vanish.", setup: stage("giving", 0) },
]

export default defineStation({
  id: "outbreak-breach",
  title: "Outbreak door breaches",
  summary:
    "Kit, after co-op: \"When the zombies are breaking down a door, there's no way to tell if they're gonna break through.\" Doors now wear in stages you can read without words (jolts, cracks, a split panel, bent hinges, arms through a punched panel, light and feet's shadows under the door, more fists and deeper thuds for more pushing), hold for a warning beat before they give, and give by how they were pushed: off the hinges, split, a crush that bursts the frame, boards flying, a window bursting. A torn-out door stays open for good; its slab can be wedged back as a board. All in the sim and replicated. Lab › Doors & barricades.",
  order: 132,
  prop: "panels",
  color: 0x8a5a33,
  status: "live",
  demo: { kind: "page", url: page },
  defaultVariant: "giving",
  pickOne: true,
  variants: variants.map((v) => ({ ...v, url: page })),
  board: { feature: "AR-97" },
  metrics: [{ label: "Breach tests", value: "8", source: "games/outbreak/tests/breach.test.ts" }],
  paths: ["games/outbreak/shared/breach", "games/outbreak/src/breach"],
  branches: ["outbreak-breach*"],
  links: [{ label: "Play Outbreak", href: "/arcade/outbreak/?seed=7" }],
})
