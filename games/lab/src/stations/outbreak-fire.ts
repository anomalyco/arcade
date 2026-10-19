import type { StationCommand, StationVariant } from "@arcade/kit/lab/overworld/types"
import { defineStation } from "./define"

const page = "/arcade/outbreak/?seed=7&peaceful=1"
const stage = (scene: string): StationCommand[] => [
  { command: "scene.set-param", args: { key: "timeScale", value: 1 } },
  { command: "fire.stage", args: { scene } },
]

const variants: StationVariant[] = [
  { id: "armory", group: "Items", label: "Every item", note: "Dusk on the road south of Ash's house: the flamethrower, dynamite, firecrackers, a molotov, the flare gun, a bear trap and a gas can laid out in a row, and one of each in the pack.", setup: stage("armory") },
  { id: "flamethrower", group: "Flamethrower", label: "Flamethrower at night", note: "Fuel in the tank and two gas cans. Hold fire to spray: a short cone, loud and bright, so the dead come. A full tank lasts nine seconds; R (or an empty tank) refuels from a gas can.", setup: stage("flamethrower") },
  { id: "burning", group: "Flamethrower", label: "The dead burning", note: "Four already alight: they lurch in panic, light the road round them, set others alight and fall charred. Fire on the road and scorch marks.", setup: stage("burning") },
  { id: "dynamite", group: "Explosives", label: "Dynamite in hand", note: "Fire throws it on a lit fuse. The blast throws the dead down, blows in barricades and doors, leaves a crater and pulls every horde in earshot.", setup: stage("dynamite") },
  { id: "dynamite-lit", group: "Explosives", label: "Dynamite thrown", note: "One already thrown into the knot of the dead, fuse spitting.", setup: stage("dynamite-lit") },
  { id: "firecrackers", group: "Explosives", label: "Firecrackers", note: "A string thrown up the road, skittering and popping for seven seconds: a moving lure.", setup: stage("firecrackers") },
  { id: "molotov", group: "Explosives", label: "Molotov", note: "A bottle and chem make one anywhere. It bursts into a pool of fire that sets the dead alight.", setup: stage("molotov") },
  { id: "flare-gun", group: "One-offs", label: "Flare gun", note: "Three shots, each a road flare dropped 26 m away: it pulls the dead into its red light, far from you.", setup: stage("flare-gun") },
  { id: "bear-trap", group: "One-offs", label: "Bear trap", note: "Set one ahead. The first of the dead to step in is bitten and held for eight seconds.", setup: stage("bear-trap") },
]

export default defineStation({
  id: "outbreak-fire",
  title: "Outbreak fire & explosives",
  summary:
    "The flamethrower (found in a hardware store's back room, or made at a bench with a pressure tank, a gas can and scrap), dynamite, firecrackers, molotovs, a flare gun and bear traps. Fire is light: the stream, burning figures and blasts light the street through the night-lights lamp grid, and leave scorch marks. Tunables and look are in the Fire & explosives group, with Give and Stage actions.",
  order: 125,
  prop: "panels",
  color: 0xe0703a,
  status: "live",
  demo: { kind: "page", url: page },
  defaultVariant: "flamethrower",
  pickOne: true,
  variants: variants.map((v) => ({ ...v, url: page })),
  board: { feature: "AR-62" },
  metrics: [{ label: "Fire tests", value: "18 sim + 2 sound", source: "games/outbreak/tests/fire.test.ts, audio.test.ts" }],
  paths: ["games/outbreak/shared/fire", "games/outbreak/src/fire"],
  branches: ["outbreak-fire*"],
  links: [{ label: "Play Outbreak", href: "/arcade/outbreak/?seed=7" }],
})
