import type { StationCommand, StationVariant } from "@arcade/kit/lab/overworld/types"
import { defineStation } from "./define"

const page = "/arcade/outbreak/?seed=7&peaceful=1"
const stage = (scene: string, timeScale = 1): StationCommand[] => [
  { command: "scene.set-param", args: { key: "timeScale", value: timeScale } },
  { command: "wayout.stage", args: { scene } },
]

const variants: StationVariant[] = [
  { id: "radio", group: "Rumour", label: "Radio broadcast", note: "A house radio left playing while a broadcast is on (the first 45 minutes of every second hour). Stand near it and the rumour comes through the static: the place, and the dawn it leaves by.", setup: stage("radio", 20) },
  { id: "note", group: "Rumour", label: "Scrawled note", note: "Some homes hold a note on a table or dresser (14%, fixed per house). Read it: the place, too far to walk, find a car.", setup: stage("note") },
  { id: "flyer", group: "Rumour", label: "Flyer on a body", note: "Three bodies in ten carry an evacuation flyer. Search the body to find it.", setup: stage("flyer") },
  { id: "police-map", group: "Direction", label: "Torn map at the police station", note: "Every police station has a torn map piece on a counter; one always stands a block south of town. It gives the bearing and the distance by road.", setup: stage("police-map") },
  { id: "road-sign", group: "Direction", label: "Road sign", note: "300 m out along the route, a green sign points the way. Two kinds of direction clue confirm the place.", setup: stage("road-sign") },
  { id: "soldier", group: "Direction", label: "Dead soldier with orders", note: "620 m out along the route. His orders name the dawn and which road in is open.", setup: stage("soldier") },
  { id: "car-repair", group: "The car", label: "Hotwire and fuel a car", note: "A car with no keys and an empty tank. With a toolbox in your pack, hold E to hotwire it (noisy). The pumps are dry: only gas cans fill a tank, poured in when you get in, 40% each. The goal line shows how far the tank goes.", setup: stage("car-repair") },
  { id: "roadblock", group: "The car", label: "A roadblock at night", note: "The route's first roadblock: a pile-up, a police roadblock or a chained gate across the road and both verges. People squeeze through a gap at one kerb; cars cannot. Dynamite clears any of them, bolt cutters open a gate (hold E at the padlock), or drive round by the next road. A car waits behind you.", setup: stage("roadblock") },
  { id: "destination", group: "The way out", label: "The destination at night", note: "Confirmed: the place and the route are pinned on the map (N) and the compass ring. It is lit by its own floodlights and a red beacon. Signal with E at the post, a flare in the zone, or the horn.", setup: stage("destination") },
  { id: "final-stand", group: "The way out", label: "The final stand", note: "Signalled an hour before dawn: siege waves come in from all sides every 14 s, growing, on top of the night ramp. Hold the zone until it gets light.", setup: stage("final-stand", 120) },
  { id: "escape-card", group: "The way out", label: "The escape card", note: "Escaped by the place's craft on Night n: who made it, kills, time. Restart, New town or Lobby.", setup: stage("escape-card") },
]

export default defineStation({
  id: "outbreak-way-out",
  title: "Outbreak: The Way Out",
  summary:
    "A goal you can win. Each town has one way out far outside it (a harbour ferry, an army checkpoint, an airfield or a dam, 1.5–3 km by road), found through clues in three tiers (rumour, direction, confirmed), reached by car (hotwired with a toolbox, fuelled from gas cans, past roadblocks), signalled, and held until dawn. The last evacuation leaves at the dawn after Night 5. Tunables are in Backquote › Way Out (Off is endless survival), with reveal, teleport, stand and win actions.",
  order: 126,
  prop: "panels",
  color: 0xd9a441,
  status: "live",
  demo: { kind: "page", url: page },
  defaultVariant: "destination",
  pickOne: true,
  variants: variants.map((v) => ({ ...v, url: page })),
  board: { feature: "AR-64" },
  metrics: [{ label: "Way Out tests", value: "22 sim", source: "games/outbreak/tests/way-out.test.ts" }],
  paths: ["games/outbreak/shared/way-out", "games/outbreak/src/way-out"],
  branches: ["outbreak-way-out*"],
  links: [{ label: "Play Outbreak", href: "/arcade/outbreak/?seed=7" }],
})
