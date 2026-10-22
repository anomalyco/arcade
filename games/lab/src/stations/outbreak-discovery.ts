import type { StationCommand, StationVariant } from "@arcade/kit/lab/overworld/types"
import { defineStation } from "./define"

const page = "/arcade/outbreak/?seed=7&peaceful=1"
const stage = (scene: string): StationCommand[] => [
  { command: "scene.set-param", args: { key: "timeScale", value: 0 } },
  { command: "discovery.stage", args: { scene } },
]

const radio = (scene: string): StationCommand[] => [
  { command: "scene.set-param", args: { key: "timeScale", value: 0 } },
  { command: "radios.stage", args: { scene } },
]

/** World interactions (AR-56): each feature's own `<feature>.stage` command. */
const world = (command: string, scene: string): StationCommand[] => [
  { command: "scene.set-param", args: { key: "timeScale", value: 1 } },
  { command, args: { scene } },
]

const variants: StationVariant[] = [
  { id: "low-flashlight", group: "House", label: "Low flashlight", note: "12% battery at night: the beam narrows, shortens, warms to amber and sputters. No ring, no words.", setup: stage("low-flashlight") },
  { id: "weakened-barricade", group: "House", label: "Weakened barricade", note: "Three boards at half strength from inside: one flush, one bowed and split, one hanging from a nail.", setup: stage("weakened-barricade") },
  { id: "open-containers", group: "House", label: "Opened containers", note: "Searched furniture stays open with what is left inside: the dresser drawer, the cabinet and fridge doors, the shelf.", setup: stage("open-containers") },
  { id: "drops", group: "House", label: "Drops on the floor", note: "What the squad leaves lies on the floor as props, with no floating labels.", setup: stage("drops") },
  { id: "bench-board", group: "Bench and pages", label: "Recipe board", note: "Plank, scrap and chem picked up, so their recipes have filled in on the bench. E opened the board: a digit makes a row, and the rows still to find say where.", setup: stage("bench-board") },
  { id: "corkboard", group: "Bench and pages", label: "Corkboard", note: "Sketches pinned in three players' colours, and faint ideas waiting on the toolbox and the generator.", setup: stage("corkboard") },
  { id: "dark-bench", group: "Bench and pages", label: "Bench at night", note: "A spiked board on the board with the flashlight off: too dark to make it. Press F and press 1 again.", setup: stage("dark-bench") },
  { id: "page", group: "Bench and pages", label: "A page in the hardware store", note: "A printed flyer lies on a shelf. E reads it: the squad learns the reinforced barricade and the flyer goes up on the corkboard.", setup: stage("page") },
  { id: "page-read", group: "Bench and pages", label: "Reading a page", note: "The pharmacy's chart held up to the camera after reading it: two materials and what they make, no words.", setup: stage("page-read") },
  { id: "found-pages", group: "Bench and pages", label: "Found pages on the corkboard", note: "A sketch made at the bench beside a flyer, a chart and a photo found in town, each pinned in the finder's colour.", setup: stage("found-pages") },
  { id: "held-out", group: "House", label: "A held-out window", note: "A window someone boarded from inside and strapped with steel, as streamed warehouses have (staged on the hardware store). Stand still and look at it to learn how.", setup: stage("held-out") },
  { id: "crouch", group: "Stealth and noise", label: "Crouch over a tripwire", note: "Cans strung across the pharmacy's front step. Walk through and they rattle; hold Z and you step over them, slower, quieter and smaller to the dead.", setup: stage("crouch") },
  { id: "tripwire", group: "Stealth and noise", label: "Disarm a tripwire", note: "On the pharmacy's step, facing the cans. E works them loose without a sound, and whoever does learns to make one; the cans go in hand to string across another door.", setup: stage("tripwire") },
  { id: "closet", group: "Stealth and noise", label: "Hiding in a closet", note: "Inside the bedroom closet at night, the room through the louvres. The dead cannot see or hear you; one that saw you go in searches where you were. E steps out.", setup: stage("closet") },
  { id: "peephole", group: "Stealth and noise", label: "Peephole", note: "Shift+E at a shut front door looks out through it at the porch without opening up. E stops.", setup: stage("peephole") },
  { id: "bottle", group: "Stealth and noise", label: "Throwing a bottle", note: "Bottles in hand on the street. Click to throw one: it breaks where it lands, loud, and beside a car it can set the alarm off.", setup: stage("bottle") },
  { id: "car-alarm", group: "Stealth and noise", label: "Car alarm", note: "A car with its window put in and the alarm going: indicators flashing and a wail every beat until the battery dies. Half the abandoned cars have one.", setup: stage("car-alarm") },
  { id: "radio-off", group: "Stealth and noise", label: "House radio", note: "Ash's radio on the living-room table at night. E switches it on: it plays until its battery runs down, calling the dead to the house; E again saves what is left.", setup: radio("radio-off") },
  { id: "radio-lure", group: "Stealth and noise", label: "Radio as a lure", note: "The radio playing in Ash's house with the front door open and six of the dead on the street. They turn and go in to it, and once they stand at it a moment they knock it to the floor.", setup: radio("radio-lure") },
  { id: "lamp-street", group: "World interactions", label: "Shoot out a street lamp", note: "Night, pistol in hand, aimed at the head of the street lamp by Ash's house. Click: the glass pops and rains on the pavement, the lamp is dark for good, and the dead see less of you under it.", setup: world("lights.stage", "lamp-street") },
  { id: "lamp-porch", group: "World interactions", label: "Porch light switch", note: "On Ash's porch step facing the switch. E switches the porch light off (and on again); face the door and the door keeps the prompt.", setup: world("lights.stage", "lamp-porch") },
  { id: "lamp-out", group: "World interactions", label: "A lamp shot out", note: "The street lamp by Ash's house already shot out: glass under it and a dark pool where the light was.", setup: world("lights.stage", "lamp-out") },
  { id: "flare-hand", group: "World interactions", label: "Road flares in hand", note: "Night on the street south of Ash's house, three road flares in hand and six of the dead up the road. Click to throw one: it burns red for half a minute and the dead who can see it go and stand in its light.", setup: world("flares.stage", "flare-hand") },
  { id: "flare-lit", group: "World interactions", label: "A burning flare", note: "The same street with a flare already burning in the road: red light, smoke, and the dead turning towards it.", setup: world("flares.stage", "flare-lit") },
  { id: "body", group: "World interactions", label: "A body to search", note: "Dusk beside the dead survivor by Ash's porch. E searches it like a drawer (short and quiet) and what it carried shows above it; E or the digits take it.", setup: world("bodies.stage", "body") },
  { id: "body-rising", group: "World interactions", label: "A body that rises", note: "The same body as it stirs under your hand: rarely (fixed per body from the seed) one was only nearly dead. It gets up and comes for you, and what it carried falls where it lay.", setup: world("bodies.stage", "body-rising") },
  { id: "dog", group: "World interactions", label: "Chained dog", note: "Dusk at Elm's side yard, a tin of food in hand. The dog barks at you and at the dead, which warns you and calls them; E feeds it and it hushes and knows you.", setup: world("dogs.stage", "dog") },
  { id: "dog-fed", group: "World interactions", label: "A fed dog", note: "The same dog just fed: tail going, its bowl by the kennel. From now on it only barks at the dead.", setup: world("dogs.stage", "dog-fed") },
  { id: "dog-dead", group: "World interactions", label: "A dog the dead got to", note: "Stay among the dead a barking dog called for long enough and they kill it.", setup: world("dogs.stage", "dog-dead") },
  { id: "repair", group: "House", label: "Crowbar repair", note: "A worn barricade and a crowbar in hand. B re-nails it to full instead of adding a board; practice makes it faster and quieter.", setup: stage("repair") },
  { id: "broken-in", group: "Vignettes", label: "Broken in", note: "A house broken into through its side window: glass on the floor, a survivor down with a snapped bat, the zombie that came through. Walk over the glass upright and it crunches; crouch to step softly. The bat left a scrap.", setup: stage("broken-in") },
  { id: "hid", group: "Vignettes", label: "Hid in the closet", note: "The dead in front of a bedroom closet, spent casings at its door, a battery left behind. Somebody hid in there and lived.", setup: stage("hid") },
  { id: "lured", group: "Vignettes", label: "Lured away", note: "Bottles broken in a line away from the pharmacy door, the dead bunched at the last one, and one bottle left unthrown.", setup: stage("lured") },
  { id: "spent-alarm", group: "Vignettes", label: "The alarm car", note: "A car whose alarm wailed until its battery died, the dead it called piled round it. Other cars still have theirs.", setup: stage("spent-alarm") },
]

export default defineStation({
  id: "outbreak-discovery",
  title: "Outbreak: Discovered, Not Told",
  summary:
    "State read from the world instead of labels: the flashlight's charge in its beam, barricade health in its boards, containers that open to show what is inside, prompt words that fade once you know them, and a workbench whose recipe board fills in as the squad picks up materials, pinning a pencil sketch to the corkboard. Knowledge is found too: flyers, charts and photos left in buildings, a reinforced window to study, and hands that board up faster and quieter with practice or from watching a teammate. New verbs are learned by doing: crouching, closets and peepholes, bottles, can tripwires, car alarms and house radios as lures, and crowbar repairs. World interactions: street lamps and porch lights you can shoot out or switch off, road flares that pull the dead into their red light, dead survivors to search (one now and then rises), and chained dogs that bark at everything until fed. Small seeded scenes in every district show what happened to the people before you: a house broken into, someone who hid, bottles that drew the dead away, a car alarm that called them. Tunables are in the Discovery, Progression, Verbs, Radios, Lights out, Flares, Bodies and Dogs groups (flare light and smoke under Night lights).",
  order: 121,
  prop: "panels",
  color: 0xd8b878,
  status: "live",
  demo: { kind: "page", url: page },
  defaultVariant: "weakened-barricade",
  // Each scene stages the whole house, so the groups are sections of one choice rather than axes that stack.
  pickOne: true,
  variants: variants.map((v) => ({ ...v, url: page })),
  board: { feature: "AR-29", decision: "D-19" },
  metrics: [{ label: "Discovery tests", value: "6 + recipe board + 12 found + 19 verbs + 6 vignettes + 8 radios + 15 world interactions + 4 co-op", source: "games/outbreak/tests/discovery.test.ts, recipe-board.test.ts, found.test.ts, verbs.test.ts, vignettes.test.ts, radios.test.ts, world-interactions.test.ts, coop.test.ts" }],
  paths: ["games/outbreak/shared/discovery", "games/outbreak/src/discovery", "games/outbreak/shared/radios", "games/outbreak/src/radios", "games/outbreak/shared/lights-out", "games/outbreak/shared/flares", "games/outbreak/shared/bodies", "games/outbreak/shared/dogs"],
  branches: ["discovery*"],
  links: [{ label: "Play Outbreak", href: "/arcade/outbreak/?seed=7" }],
})
