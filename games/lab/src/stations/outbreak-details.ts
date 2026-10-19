import type { StationCommand, StationVariant } from "@arcade/kit/lab/stations/types"
import { defineStation } from "./define"

const page = "/arcade/outbreak/?seed=7&peaceful=1&infiniteAmmo=1"
const set = (key: string, value: number | boolean | string) => ({ command: "scene.set-param", args: { key, value } })
const pose = (x: number, y: number, aim: number, extra: Record<string, boolean | number> = {}) => ({ command: "player.pose", args: { x, y, aim, ...extra } })
const shot = (hour: number, zoom: number, ...rest: StationCommand[]): StationCommand[] => [set("timeScale", 0), set("hour", hour), set("zoom", zoom), ...rest]

const today = [set("worldDetails", true), set("dtTurnedOver", 0.35), set("dtMail", true), set("dtBoxes", 0.45), set("dtMarks", 0.3), set("dtBins", true), set("dtMailboxes", true), set("dtStreetJunk", 1), set("dtPoliceTape", true), set("dtCrows", 1), set("dtTvs", 0.35), set("dtDistantDogs", true)]

// Two groups that compose: how much Detail, then where and when.
const variants: StationVariant[] = [
  { id: "details-today", group: "Details", boardOption: "1", label: "Today", note: "Mail behind front doors, moving boxes, a third of the houses turned over (always where Blood says something happened), bins and mailboxes at the street, dropped luggage, bikes and prams, tape round the police cars, a few spray-painted marks; crows on lawns and at bodies that scatter when you come close or fire, televisions flickering in dark living rooms, dogs barking far off at night.", setup: today },
  { id: "details-heavy", group: "Details", boardOption: "2", label: "Every house", note: "Every house turned over, boxes and marks everywhere, twice the dropped junk: for tuning, not for play.", setup: [...today, set("dtTurnedOver", 1), set("dtBoxes", 1), set("dtMarks", 1), set("dtStreetJunk", 2)] },
  { id: "details-quiet", group: "Details", label: "No life", note: "Every static detail, but no crows, televisions or distant dogs.", setup: [...today, set("dtCrows", 0), set("dtTvs", 0), set("dtDistantDogs", false)] },
  { id: "details-off", group: "Details", label: "Off (before)", note: "The town as it was: furniture, RE dressing, clutter and blood, none of the details.", setup: [set("worldDetails", false)] },
  { id: "house-night", group: "Shot", label: "Start house, night", note: "Ash turned over at 21:00 by flashlight: chairs on their backs by the table, a dumped drawer, smashed plates by the counter, mail behind the door.", setup: shot(21, 34, set("dtTurnedOver", 1), pose(27.7, 31.2, -0.3, { openDoor: true, flashlight: true })) },
  { id: "street-day", group: "Shot", label: "Ash's front, day", note: "Mailbox and bins at the sidewalk, a bike and a suitcase on the lawn, a search mark on the front wall, 14:00.", setup: shot(14, 38, pose(29, 39.5, -Math.PI / 2)) },
  { id: "police-night", group: "Shot", label: "Police car, night", note: "Every car a police car, so the tape on its cones shows in the beam, 22:00.", setup: shot(22, 36, set("nlCruisers", 1), pose(50.5, 44.5, 0.1, { flashlight: true })) },
]

export default defineStation({
  id: "outbreak-details",
  title: "Outbreak world details",
  summary:
    "The detail pass that closes the RE Mansion gaps (D-30): lived-in, then-abandoned rooms (mail, boxes, turned-over furniture, crockery) and streets (bins, mailboxes, luggage, bikes, prams, police tape, spray-painted marks), seeded per building, plus life: crows that scatter, flickering televisions, distant dogs. Backquote › Details.",
  order: 124,
  prop: "house",
  color: 0x5e4a32,
  status: "review",
  demo: { kind: "page", url: page },
  defaultVariant: ["details-today", "house-night"],
  variants: variants.map((v) => ({ ...v, url: page })),
  board: { feature: "AR-60" },
  paths: ["games/outbreak/src/details", "games/outbreak/src/scene/frame-renderer.ts"],
  links: [{ label: "Play Outbreak", href: "/arcade/outbreak/?seed=7" }],
})
