import type { StationCommand, StationVariant } from "@arcade/kit/lab/stations/types"
import { defineStation } from "./define"

const page = "/arcade/outbreak/?seed=7&peaceful=1"
const set = (key: string, value: number | boolean | string): StationCommand => ({ command: "scene.set-param", args: { key, value } })
const stage = (scene: string, zoom = 30, ...extra: StationCommand[]): StationCommand[] => [
  set("behaviour.zbMode", 1),
  set("behaviour.zbOverlay", 1),
  set("timeScale", 1),
  set("zoom", zoom),
  { command: "behaviour.stage", args: { scene } },
  ...extra,
]

const variants: StationVariant[] = [
  { id: "listen", group: "Senses", label: "Stop and listen", note: "Four curious dead ahead, facing away. Make a noise (a door, a shot, a sprint): they stop, turn their heads and listen before they come to look.", setup: stage("listen") },
  { id: "follow", group: "Senses", label: "Follow the one that noticed", note: "One zombie spots you; the sociable dead around it turn a beat later and follow it, each after its own reaction time.", setup: stage("follow") },
  { id: "search", group: "Senses", label: "Search the house, give up slowly", note: "It saw you go into the house: it goes where you were, sniffs, looks in at the windows and doors, then gives up and wanders off.", setup: stage("search", 34) },
  { id: "flinch", group: "Senses", label: "Flinch from the beam", note: "Torch on, two dead ahead and facing you: the beam in their faces makes them flinch and shield their eyes.", setup: stage("flinch", 24) },
  { id: "rest", group: "Day and night", label: "Still by day", note: "Noon: the dead sit, slump and stand swaying. Walk close or fire and they get up over a beat.", setup: stage("rest", 34) },
  { id: "herd", group: "Day and night", label: "Night herd", note: "A loose herd drifts down the street after its leader.", setup: stage("herd", 38) },
  { id: "light", group: "Day and night", label: "Drawn to the lamp", note: "Night, torch off: curious dead drift in to stand under a lamp and look up at it.", setup: stage("light", 38) },
  { id: "lightning", group: "Day and night", label: "Lightning freezes them", note: "A storm with lightning every few seconds: each strike freezes the dead out in the open, looking up.", setup: stage("lightning", 36, { command: "weather.set", args: { state: "storm" } }, set("weather.weatherLightningPerMinute", 20)) },
  { id: "feed", group: "The world", label: "Feeding on a body", note: "Three hungry dead find a body and crouch over it; a third is shouldered off. Disturb them and they rise.", setup: stage("feed", 26) },
  { id: "climb", group: "The world", label: "Climbing a fence", note: "Three dead after you across a yard fence climb it, slower than you vault; one may snag.", setup: stage("climb", 26) },
  { id: "crowd", group: "Compare", label: "Night street (Alive)", note: "24 different dead on one night street: listening, following, pausing, herding and searching, each with its own walk.", setup: stage("crowd", 40) },
  { id: "crowd-today", group: "Compare", label: "Night street (Today)", note: "The same street with Zombie behaviour: Today, the crowd as it was before AR-91.", setup: [...stage("crowd", 40), set("behaviour.zbMode", 0)] },
]

export default defineStation({
  id: "outbreak-zombie-behaviour",
  title: "Outbreak zombie behaviour",
  summary:
    "Each zombie gets a personality from its seed (curious, persistent, sociable, hungry, torpid, fresh or long dead) that shapes how it hears, follows, searches and gives up, rests by day, herds at night, feeds, climbs, and walks. The overlay labels what each is doing. Tunables are in Backquote › Zombie behaviour; Today turns it all off.",
  order: 131,
  prop: "panels",
  color: 0x7a9a5c,
  status: "live",
  demo: { kind: "page", url: page },
  defaultVariant: "crowd",
  pickOne: true,
  variants: variants.map((v) => ({ ...v, url: page })),
  board: { feature: "AR-91" },
  metrics: [{ label: "Behaviour tests", value: "15", source: "games/outbreak/tests/behaviour.test.ts, coop-behaviour-parity.test.ts" }],
  paths: ["games/outbreak/shared/behaviour", "games/outbreak/src/behaviour"],
  branches: ["outbreak-zombie-behaviour*"],
  links: [{ label: "Play Outbreak", href: "/arcade/outbreak/?seed=7" }],
})
