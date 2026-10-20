import type { StationCommand, StationVariant } from "@arcade/kit/lab/overworld/types"
import { defineStation } from "./define"

const page = "/arcade/outbreak/?seed=7&peaceful=1"
const set = (key: string, value: number): StationCommand => ({ command: "scene.set-param", args: { key, value } })
/** Every variant puts the new look back (kit fire, capsule fire light, world smoke, backlit dust) unless it asks for Today. */
const look = (today = false): StationCommand[] => [
  set("fireStyle", today ? 0 : 1),
  set("fireLightShape", today ? 0 : 1),
  set("worldSmoke", today ? 0 : 1),
  set("beamDustStyle", today ? 0 : 2),
]
const stage = (scene: string, today = false): StationCommand[] => [set("timeScale", 1), ...look(today), { command: "fire.stage", args: { scene } }]
const air = (scene: string): StationCommand[] => [set("timeScale", 1), ...look(), { command: "air.stage", args: { scene } }]

const variants: StationVariant[] = [
  { id: "armory", group: "Items", label: "Every item", note: "Dusk on the road south of Ash's house: the flamethrower, dynamite, firecrackers, a molotov, the flare gun, a bear trap and a gas can laid out in a row, and one of each in the pack.", setup: stage("armory") },
  { id: "flamethrower", group: "Flamethrower", label: "Flamethrower at night", note: "Fuel in the tank and two gas cans. Hold fire to spray: a short cone, loud and bright, so the dead come. A full tank lasts nine seconds; R (or an empty tank) refuels from a gas can.", setup: stage("flamethrower") },
  { id: "flamethrower-today", group: "Flamethrower", label: "Flamethrower (Today's look)", note: "The same scene with the old sprite fire, no world smoke and the old beam dust, for comparison: Lab › Fire & explosives look › Fire style, World smoke and Beam dust switch each back.", setup: stage("flamethrower", true) },
  { id: "burning", group: "Flamethrower", label: "The dead burning", note: "Four already alight: they lurch in panic, light the road round them, set others alight and fall charred. Fire on the road and scorch marks.", setup: stage("burning") },
  { id: "tree", group: "Flamethrower", label: "A burning tree", note: "22:00, a molotov's fire at a tree's trunk. The crown catches, burns for 24 seconds and lights the street like a bonfire on a pole (a capsule light up the trunk), drops burning leaves, may jump to a neighbour, and stands bare and charred for good. Hedges and shrubs in fire or scorch char too.", setup: stage("tree") },
  { id: "dynamite", group: "Explosives", label: "Dynamite in hand", note: "Fire throws it on a lit fuse. The blast throws the dead down, blows in barricades and doors, leaves a crater and pulls every horde in earshot.", setup: stage("dynamite") },
  { id: "dynamite-lit", group: "Explosives", label: "Dynamite thrown", note: "One already thrown into the knot of the dead, fuse spitting.", setup: stage("dynamite-lit") },
  { id: "firecrackers", group: "Explosives", label: "Firecrackers", note: "A string thrown up the road, skittering and popping for seven seconds: a moving lure.", setup: stage("firecrackers") },
  { id: "molotov", group: "Explosives", label: "Molotov", note: "A bottle and chem make one anywhere. It bursts into a pool of fire that sets the dead alight.", setup: stage("molotov") },
  { id: "smoke-steam", group: "Smoke & dust", label: "Sewer steam in the beam", note: "22:00, a manhole venting steam on the wind. It stays dark until the flashlight finds it; backlit dust motes drift in the beam. Lab › World smoke and Beam dust.", setup: air("steam") },
  { id: "dust-backlit", group: "Smoke & dust", label: "Dust in the beam", note: "A few tiny soft motes riding a slow air current, only where light is (the beam, lamp pools, fire light), brightest in the beam's core and turning slowly to catch it. Lab › Beam dust › Backlit; AR-68's soft motes and Today's are the other two styles.", setup: stage("flamethrower") },
  { id: "smoke-car", group: "Smoke & dust", label: "Smouldering car", note: "An abandoned car smoking from the engine bay with a dull red glow under the bonnet. Every wreck the survivors make smokes too.", setup: air("car") },
  { id: "flare-gun", group: "One-offs", label: "Flare gun", note: "Three shots, each a road flare dropped 26 m away: it pulls the dead into its red light, far from you.", setup: stage("flare-gun") },
  { id: "bear-trap", group: "One-offs", label: "Bear trap", note: "Set one ahead. The first of the dead to step in is bitten and held for eight seconds.", setup: stage("bear-trap") },
]

export default defineStation({
  id: "outbreak-fire",
  title: "Outbreak fire & explosives",
  summary:
    "The flamethrower (found in a hardware store's back room, or made at a bench with a pressure tank, a gas can and scrap), dynamite, firecrackers, molotovs, a flare gun and bear traps. Fire is the kit explosion look (rolling lit billows, soot and embers) and it is light: the stream, burning figures and blasts light the street through the night-lights lamp grid, and leave scorch marks. Manholes, drains, smouldering cars and chimneys smoke on the wind, dark until a light finds them, trees and hedges burn and stay charred, and a few backlit dust motes drift wherever there is light. Tunables are in the Fire & explosives, Fire & explosives look, World smoke and Beam dust groups; each look switches back to Today in one setting.",
  order: 125,
  prop: "panels",
  color: 0xe0703a,
  status: "live",
  demo: { kind: "page", url: page },
  defaultVariant: "flamethrower",
  pickOne: true,
  variants: variants.map((v) => ({ ...v, url: page })),
  board: { feature: "AR-68" },
  metrics: [{ label: "Fire tests", value: "23 sim + 2 sound", source: "games/outbreak/tests/fire.test.ts, audio.test.ts" }],
  paths: ["games/outbreak/shared/fire", "games/outbreak/src/fire", "games/outbreak/src/air", "games/outbreak/src/scene/fx-particles.ts", "packages/kit/fx"],
  branches: ["outbreak-fire*"],
  links: [{ label: "Play Outbreak", href: "/arcade/outbreak/?seed=7" }],
})
