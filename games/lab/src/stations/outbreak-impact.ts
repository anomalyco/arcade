import type { StationCommand, StationVariant } from "@arcade/kit/lab/stations/types"
import { defineStation } from "./define"

const page = "/arcade/outbreak/?seed=7&peaceful=1"
const set = (key: string, value: number) => ({ command: "scene.set-param", args: { key, value } })
/** The same staged fight and scripted inputs either way; only the Impact setting differs. */
const stage = (scene: string, style: number): StationCommand[] => [set("timeScale", 1), set("impactStyle", style), { command: "impact.stage", args: { scene } }]

const fights: { id: string; label: string; note: string }[] = [
  { id: "melee", label: "Fire axe", note: "A charged heavy swing cleaves two of three charging dead, then a light swing rocks the third." },
  { id: "pistol", label: "Pistol", note: "Three in a line down the street: five shots stagger, kill, then drop the ones behind." },
  { id: "blast", label: "Dynamite", note: "A stick thrown into a knot of eight, then a second one onto the bodies." },
  { id: "car", label: "Run-over", note: "A pickup floored into four charging dead, then braking." },
]

const variants: StationVariant[] = fights.flatMap((f) => [
  {
    id: f.id,
    group: f.label,
    label: "Physical",
    note: `${f.note} Directional hit reactions, ragdoll deaths from the pose they died in, bodies pushed by blasts and cars, weapon-weighted hit-stop.`,
    setup: stage(f.id, 1),
  },
  { id: `${f.id}-today`, group: f.label, label: "Today", note: `${f.note} Today's canned stagger and collapse.`, setup: stage(f.id, 0) },
])

export default defineStation({
  id: "outbreak-impact",
  title: "Outbreak combat oomph",
  summary:
    "The same fights played Today and Physical. Physical gives the living directional hit reactions on springs (the trunk rocks away from the blow and overshoots, off-centre hits twist the shoulders, the head whips, the knees buckle) and drops the dead as Verlet ragdolls started from the exact pose they died in, pushed by the blow that killed them: a pistol round crumples, a fire axe folds, dynamite and cars throw. Bodies already down are blown along by blasts and tumble from under wheels, and hit-stop and shake scale with the weapon. All presentation, seeded from replicated events. Lab › Feel (Impact: Today / Physical) and Physics.",
  order: 131,
  prop: "panels",
  color: 0xc4473a,
  status: "live",
  demo: { kind: "page", url: page },
  defaultVariant: "melee",
  pickOne: true,
  variants: variants.map((v) => ({ ...v, url: page })),
  board: { feature: "AR-90" },
  metrics: [{ label: "Impact tests", value: "11 kit + 11 game", source: "packages/kit/avatar/bone-ragdoll.test.ts, games/outbreak/tests/impact.test.ts" }],
  paths: ["games/outbreak/src/impact", "packages/kit/avatar/bone-ragdoll.ts", "packages/kit/avatar/hit-reaction.ts"],
  branches: ["outbreak-oomph*"],
  links: [{ label: "Play Outbreak", href: "/arcade/outbreak/?seed=7" }],
})
