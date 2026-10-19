import type { LabControl } from "@arcade/kit/lab-panel"

/**
 * Lab settings for Outbreak's world details (Backquote › Details): the lived-in, then-abandoned layer the Resident
 * Evil mansion paint-over has and the town lacked. Indoors: mail behind the front door, stacked moving boxes, and in
 * houses that were turned over (always where Blood says something happened) toppled chairs, pulled drawers, spilled
 * books and broken crockery. Outdoors: bins and dumpsters, mailboxes, dropped luggage, bikes and prams, police tape
 * round the police cars, and spray-painted search marks and warnings on front walls. Presentation only, seeded from
 * the town, so co-op clients match.
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
  /** Wheelie bins by the driveways and dumpsters beside the shops. */
  dtBins: boolean
  /** A mailbox at the end of each front path. */
  dtMailboxes: boolean
  /** Dropped luggage, bikes and prams on lawns and beside cars (0 none, 1 default, 2 crowded). */
  dtStreetJunk: number
  /** Police tape strung on cones round the police cars (Night lights › Police cars picks which cars). */
  dtPoliceTape: boolean
  /** Reroll which buildings get what (separate from the town seed). */
  dtSeed: number
}

export const DEFAULT_DETAIL_SETTINGS: OutbreakDetailSettings = {
  worldDetails: true,
  dtTurnedOver: 0.35,
  dtMail: true,
  dtBoxes: 0.45,
  dtMarks: 0.3,
  dtBins: true,
  dtMailboxes: true,
  dtStreetJunk: 1,
  dtPoliceTape: true,
  dtSeed: 0,
}

const GROUP = "Details"

export const detailControls: LabControl[] = [
  { key: "worldDetails", label: "World details", group: GROUP, type: "toggle" },
  { key: "dtTurnedOver", label: "Turned-over houses", group: GROUP, min: 0, max: 1, step: 0.05, unit: "" },
  { key: "dtMail", label: "Mail inside front doors", group: GROUP, type: "toggle" },
  { key: "dtBoxes", label: "Moving boxes", group: GROUP, min: 0, max: 1, step: 0.05, unit: "" },
  { key: "dtMarks", label: "Spray-painted marks and warnings", group: GROUP, min: 0, max: 1, step: 0.05, unit: "" },
  { key: "dtBins", label: "Bins and dumpsters", group: GROUP, type: "toggle" },
  { key: "dtMailboxes", label: "Mailboxes", group: GROUP, type: "toggle" },
  { key: "dtStreetJunk", label: "Dropped luggage, bikes and prams", group: GROUP, min: 0, max: 2, step: 0.05, unit: "×" },
  { key: "dtPoliceTape", label: "Police tape round police cars", group: GROUP, type: "toggle" },
  { key: "dtSeed", label: "Reroll", group: GROUP, min: 0, max: 99, step: 1, unit: "" },
]
