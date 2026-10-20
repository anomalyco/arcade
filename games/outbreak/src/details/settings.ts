import type { LabControl } from "@arcade/kit/lab-panel"

/**
 * Lab settings for Outbreak's world details (Backquote › Details): the lived-in, then-abandoned layer the Resident
 * Evil mansion paint-over has and the town lacked. Indoors: mail behind the front door, stacked moving boxes, and in
 * houses that were turned over (always where Blood says something happened) toppled chairs, pulled drawers, spilled
 * books and broken crockery. Outdoors: bins and dumpsters, mailboxes, dropped luggage, bikes and prams, police tape
 * round the police cars, and spray-painted search marks and warnings on front walls. Life: crows that scatter, a
 * television flickering in a dark living room, dogs barking far off at night. Presentation only; placement is seeded
 * from the town, so co-op clients match (the crows' flight and the barks are each client's own).
 *
 * Life touches (Details · Life, `touches.ts`) are the smaller layer on top: moths at lit lamps, flies over bodies and
 * bins, eyes under the trees that catch the torch and bolt, breath in the cold; and leftover life (`leftovers.ts`,
 * `sprinkler.ts`): washing on the line, cars left with a door open, a sprinkler on its timer, brass where it fell, and
 * a town that runs down night by night. The glowing and moving ones are seen only where a real light reaches them;
 * where things are is seeded from the town and replicated state, so co-op clients agree.
 */
export type OutbreakDetailSettings = {
  /** Every world detail on or off. */
  worldDetails: boolean
  /** Share of homes and shops that were turned over (toppled chairs, drawers, books, crockery). Places where Blood says something happened always are. */
  dtTurnedOver: number
  /** Mail and newspapers on the floor inside front doors. */
  dtMail: boolean
  /** Share of buildings with stacked moving boxes in a corner. */
  dtBoxes: number
  /** Share of buildings with a spray-painted search mark or warning on the front wall. */
  dtMarks: number
  /** Indoor warnings hand-written in blood (AR-69: dripping, uneven strokes, varied phrases); off is Today's spray font. */
  dtBloodWriting: boolean
  /** Wheelie bins by the driveways and dumpsters beside the shops. */
  dtBins: boolean
  /** A mailbox at the end of each front path. */
  dtMailboxes: boolean
  /** Dropped luggage, bikes and prams on lawns and beside cars (0 none, 1 default, 2 crowded). */
  dtStreetJunk: number
  /** Police tape strung on cones round the police cars (Night lights › Police cars picks which cars). */
  dtPoliceTape: boolean
  /** Crows pecking on lawns and at bodies that scatter when you come close or fire (0 none, 1 default, 2 more flocks). */
  dtCrows: number
  /** How close (m) a survivor gets before a flock takes off. */
  dtCrowScare: number
  /** Share of homes with a television still on, flickering in the dark living room. */
  dtTvs: number
  /** Brightness of a television's flicker on the room. */
  dtTvPower: number
  /** Dogs barking far off at night. */
  dtDistantDogs: boolean
  /** Reroll which buildings get what (separate from the town seed). */
  dtSeed: number
  /** Life touches (Details · Life): small things that move, live and leave traces. Off is Today. */
  lifeTouches: boolean
  /** Moths circling the lit porch lights, street lamps and lit windows (0 none, 1 default, 2 thick). */
  lfMoths: number
  /** Flies over bodies and bins, only seen in light (0 none, 1 default, 2 thick). */
  lfFlies: number
  /** Animals under the trees whose eyes catch the torch, then bolt (0 none, 1 default, 2 more). */
  lfEyeshine: number
  /** Once in a while, from the second night, a pair of eyes in the trees that does not run. */
  lfWatcher: boolean
  /** Survivors' breath in the cold night air, seen where a light catches it (0 none, 1 default, 2 heavy). */
  lfBreath: number
  /** Share of homes with washing on a line in the yard, moving in the wind. */
  lfLaundry: number
  /** Share of parked cars left with a door open and the dome light on. */
  lfOpenDoors: number
  /** A lawn sprinkler on a timer that still comes on at first light. */
  lfSprinkler: boolean
  /** Brass from every shot stays where it fell. */
  lfCasings: boolean
  /** The town runs down night by night: dome lights and televisions die, the sprinkler loses pressure. */
  lfDecay: boolean
}

export const DEFAULT_DETAIL_SETTINGS: OutbreakDetailSettings = {
  worldDetails: true,
  dtTurnedOver: 0.35,
  dtMail: true,
  dtBoxes: 0.45,
  dtMarks: 0.3,
  dtBloodWriting: true,
  dtBins: true,
  dtMailboxes: true,
  dtStreetJunk: 1,
  dtPoliceTape: true,
  dtCrows: 1,
  dtCrowScare: 5.5,
  dtTvs: 0.35,
  dtTvPower: 1,
  dtDistantDogs: true,
  dtSeed: 0,
  lifeTouches: true,
  lfMoths: 1,
  lfFlies: 1,
  lfEyeshine: 1,
  lfWatcher: true,
  lfBreath: 1,
  lfLaundry: 0.2,
  lfOpenDoors: 0.15,
  lfSprinkler: true,
  lfCasings: true,
  lfDecay: true,
}

const GROUP = "Details"
const LIFE = "Details · Life"

export const detailControls: LabControl[] = [
  { key: "worldDetails", label: "World details", group: GROUP, type: "toggle" },
  { key: "dtTurnedOver", label: "Turned-over houses", group: GROUP, min: 0, max: 1, step: 0.05, unit: "" },
  { key: "dtMail", label: "Mail inside front doors", group: GROUP, type: "toggle" },
  { key: "dtBoxes", label: "Moving boxes", group: GROUP, min: 0, max: 1, step: 0.05, unit: "" },
  { key: "dtMarks", label: "Spray-painted marks and warnings", group: GROUP, min: 0, max: 1, step: 0.05, unit: "" },
  { key: "dtBloodWriting", label: "Indoor warnings in blood (off: Today)", group: GROUP, type: "toggle" },
  { key: "dtBins", label: "Bins and dumpsters", group: GROUP, type: "toggle" },
  { key: "dtMailboxes", label: "Mailboxes", group: GROUP, type: "toggle" },
  { key: "dtStreetJunk", label: "Dropped luggage, bikes and prams", group: GROUP, min: 0, max: 2, step: 0.05, unit: "×" },
  { key: "dtPoliceTape", label: "Police tape round police cars", group: GROUP, type: "toggle" },
  { key: "dtCrows", label: "Crows", group: GROUP, min: 0, max: 2, step: 0.05, unit: "×" },
  { key: "dtCrowScare", label: "Crows take off within", group: GROUP, min: 2, max: 12, step: 0.25, unit: "m" },
  { key: "dtTvs", label: "Televisions left on", group: GROUP, min: 0, max: 1, step: 0.05, unit: "" },
  { key: "dtTvPower", label: "Television flicker brightness", group: GROUP, min: 0, max: 3, step: 0.05, unit: "×" },
  { key: "dtDistantDogs", label: "Distant dogs at night", group: GROUP, type: "toggle" },
  { key: "dtSeed", label: "Reroll", group: GROUP, min: 0, max: 99, step: 1, unit: "" },
  { key: "lifeTouches", label: "Life touches (off: Today)", group: LIFE, type: "toggle" },
  { key: "lfMoths", label: "Moths at lit lamps", group: LIFE, min: 0, max: 2, step: 0.05, unit: "×" },
  { key: "lfFlies", label: "Flies over bodies and bins", group: LIFE, min: 0, max: 2, step: 0.05, unit: "×" },
  { key: "lfEyeshine", label: "Eyes under the trees", group: LIFE, min: 0, max: 2, step: 0.05, unit: "×" },
  { key: "lfWatcher", label: "Eyes that don't run (rare)", group: LIFE, type: "toggle" },
  { key: "lfBreath", label: "Breath in the cold", group: LIFE, min: 0, max: 2, step: 0.05, unit: "×" },
  { key: "lfLaundry", label: "Washing on the line", group: LIFE, min: 0, max: 1, step: 0.05, unit: "" },
  { key: "lfOpenDoors", label: "Cars left with a door open", group: LIFE, min: 0, max: 1, step: 0.05, unit: "" },
  { key: "lfSprinkler", label: "Sprinkler at first light", group: LIFE, type: "toggle" },
  { key: "lfCasings", label: "Brass stays where it fell", group: LIFE, type: "toggle" },
  { key: "lfDecay", label: "Town runs down night by night", group: LIFE, type: "toggle" },
]
