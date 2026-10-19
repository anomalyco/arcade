/**
 * The Way Out (AR-64): typed tuning for the run's goal. `wayOut: 0` (Lab › Way Out › "Off") is the game as it was,
 * endless survival until everyone is dead. Lab tuning only changes the offline session; co-op rooms use the defaults.
 */

export type WayOutTuning = {
  /** 1: there is a way out to find and reach. 0: Off, endless survival. */
  wayOut: number
  /** -1: the town's seed picks the destination. 0–3: ferry, checkpoint, airfield, dam. */
  destination: number
  /** Shortest and longest road distance from the town's crossroads to the destination (m). */
  minDistance: number
  maxDistance: number
  /** The last evacuation leaves at the dawn after this night. */
  deadlineNight: number
  /** 0: missing it leaves endless survival. 1: one late boat, `lateNights` later. */
  missedRule: number
  lateNights: number
  /** Radio broadcasts: one every this many hours, playing this long (game hours). */
  broadcastEvery: number
  broadcastLength: number
  /** How near a playing radio a survivor must be to make out the broadcast (m). */
  radioHear: number
  /** Share of homes with a scrawled note, and of bodies carrying an evacuation flyer. */
  noteShare: number
  flyerShare: number
  /** How far along the route the road sign and the dead soldier lie (m). */
  signAt: number
  soldierAt: number
  /** Within this of the destination you have arrived (and it is confirmed); the evac takes those inside it (m). */
  evacRadius: number
  /** 0: the evac comes at the next dawn after the signal. 1: after `standHold` seconds. */
  standRule: number
  standHold: number
  /** The siege while you hold: a wave every `siegeEvery` s of `siegeWave` (+1 each `siegeGrowth` waves), at most `siegeMax` alive. */
  siegeEvery: number
  siegeWave: number
  siegeGrowth: number
  siegeMax: number
  /** How far out the siege spawns (m). */
  siegeRadius: number
  /** 1: the car is a project: the pumps are dry, only gas cans fill a tank, and a toolbox hotwires a car with no keys. 0: cars as they were. */
  carProject: number
  /** Fuel one gas can pours into a tank (% of a full tank). */
  canFill: number
  /** Seconds holding E to hotwire a car with a toolbox, and how far the noise carries (m). */
  hotwireTime: number
  hotwireNoise: number
  /** Roadblocks across the route, between the dead soldier and the destination. */
  roadblocks: number
  /** Seconds holding E to cut a chained gate with bolt cutters, and how far the noise carries (m). */
  cutTime: number
  cutNoise: number
  /** A dynamite blast this near a roadblock clears it (m from its edge). */
  blastReach: number
}

export const DEFAULT_WAY_OUT_TUNING: WayOutTuning = {
  wayOut: 1,
  destination: -1,
  minDistance: 1500,
  maxDistance: 3000,
  deadlineNight: 5,
  missedRule: 0,
  lateNights: 2,
  broadcastEvery: 2,
  broadcastLength: 0.75,
  radioHear: 9,
  noteShare: 0.14,
  flyerShare: 0.3,
  signAt: 300,
  soldierAt: 620,
  evacRadius: 16,
  standRule: 0,
  standHold: 180,
  siegeEvery: 14,
  siegeWave: 4,
  siegeGrowth: 3,
  siegeMax: 30,
  siegeRadius: 30,
  carProject: 1,
  canFill: 40,
  hotwireTime: 6,
  hotwireNoise: 14,
  roadblocks: 2,
  cutTime: 4,
  cutNoise: 10,
  blastReach: 3,
}

export const MISSED_ENDLESS = 0
export const MISSED_LATE_BOAT = 1
export const STAND_UNTIL_DAWN = 0
export const STAND_FIXED = 1

export function wayOutTuning(features: Readonly<Record<string, Record<string, unknown>>> | undefined): WayOutTuning {
  return (features?.wayOut as WayOutTuning | undefined) ?? DEFAULT_WAY_OUT_TUNING
}

const G = "Way Out"

/** Lab controls (Backquote › Way Out). */
export const wayOutControls = [
  {
    key: "wayOut.wayOut",
    field: "wayOut",
    label: "Way out",
    group: G,
    options: [
      { label: "Off (endless survival)", value: 0 },
      { label: "On", value: 1 },
    ],
  },
  {
    key: "wayOut.destination",
    field: "destination",
    label: "Destination",
    group: G,
    options: [
      { label: "From the town's seed", value: -1 },
      { label: "Harbour ferry", value: 0 },
      { label: "Army checkpoint", value: 1 },
      { label: "Airfield", value: 2 },
      { label: "Dam", value: 3 },
    ],
  },
  { key: "wayOut.minDistance", field: "minDistance", label: "Nearest by road", group: G, min: 300, max: 4000, step: 50, unit: "m" },
  { key: "wayOut.maxDistance", field: "maxDistance", label: "Farthest by road", group: G, min: 300, max: 6000, step: 50, unit: "m" },
  { key: "wayOut.deadlineNight", field: "deadlineNight", label: "Last evac: dawn after night", group: G, min: 1, max: 12, step: 1, unit: "" },
  {
    key: "wayOut.missedRule",
    field: "missedRule",
    label: "Missing it",
    group: G,
    options: [
      { label: "Endless survival", value: MISSED_ENDLESS },
      { label: "One late boat", value: MISSED_LATE_BOAT },
    ],
  },
  { key: "wayOut.lateNights", field: "lateNights", label: "Late boat after", group: G, min: 1, max: 6, step: 1, unit: "nights" },
  { key: "wayOut.broadcastEvery", field: "broadcastEvery", label: "Broadcast every", group: G, min: 0.5, max: 12, step: 0.25, unit: "h" },
  { key: "wayOut.broadcastLength", field: "broadcastLength", label: "Broadcast lasts", group: G, min: 0.1, max: 6, step: 0.05, unit: "h" },
  { key: "wayOut.radioHear", field: "radioHear", label: "Hear a radio within", group: G, min: 2, max: 30, step: 0.5, unit: "m" },
  { key: "wayOut.noteShare", field: "noteShare", label: "Homes with a note", group: G, min: 0, max: 1, step: 0.01, unit: "×" },
  { key: "wayOut.flyerShare", field: "flyerShare", label: "Bodies with a flyer", group: G, min: 0, max: 1, step: 0.01, unit: "×" },
  { key: "wayOut.signAt", field: "signAt", label: "Road sign along the route", group: G, min: 60, max: 2000, step: 10, unit: "m" },
  { key: "wayOut.soldierAt", field: "soldierAt", label: "Dead soldier along the route", group: G, min: 60, max: 3000, step: 10, unit: "m" },
  { key: "wayOut.evacRadius", field: "evacRadius", label: "Evac takes those within", group: G, min: 4, max: 40, step: 1, unit: "m" },
  {
    key: "wayOut.standRule",
    field: "standRule",
    label: "The evac comes",
    group: G,
    options: [
      { label: "At dawn", value: STAND_UNTIL_DAWN },
      { label: "After a fixed hold", value: STAND_FIXED },
    ],
  },
  { key: "wayOut.standHold", field: "standHold", label: "Fixed hold", group: G, min: 10, max: 900, step: 10, unit: "s" },
  { key: "wayOut.siegeEvery", field: "siegeEvery", label: "Siege wave every", group: G, min: 2, max: 60, step: 1, unit: "s" },
  { key: "wayOut.siegeWave", field: "siegeWave", label: "Siege wave size", group: G, min: 0, max: 16, step: 1, unit: "" },
  { key: "wayOut.siegeGrowth", field: "siegeGrowth", label: "Wave grows every", group: G, min: 1, max: 20, step: 1, unit: "waves" },
  { key: "wayOut.siegeMax", field: "siegeMax", label: "Siege at most", group: G, min: 0, max: 80, step: 1, unit: "alive" },
  { key: "wayOut.siegeRadius", field: "siegeRadius", label: "Siege spawns at", group: G, min: 10, max: 60, step: 1, unit: "m" },
  {
    key: "wayOut.carProject",
    field: "carProject",
    label: "The car",
    group: G,
    options: [
      { label: "As before (pumps work)", value: 0 },
      { label: "A project (gas cans only, hotwire)", value: 1 },
    ],
  },
  { key: "wayOut.canFill", field: "canFill", label: "A gas can fills", group: G, min: 5, max: 100, step: 5, unit: "%" },
  { key: "wayOut.hotwireTime", field: "hotwireTime", label: "Hotwire hold", group: G, min: 0.5, max: 30, step: 0.5, unit: "s" },
  { key: "wayOut.hotwireNoise", field: "hotwireNoise", label: "Hotwire noise", group: G, min: 0, max: 40, step: 1, unit: "m" },
  { key: "wayOut.roadblocks", field: "roadblocks", label: "Roadblocks on the route", group: G, min: 0, max: 4, step: 1, unit: "" },
  { key: "wayOut.cutTime", field: "cutTime", label: "Cut a chain", group: G, min: 0.5, max: 20, step: 0.5, unit: "s" },
  { key: "wayOut.cutNoise", field: "cutNoise", label: "Cutting noise", group: G, min: 0, max: 40, step: 1, unit: "m" },
  { key: "wayOut.blastReach", field: "blastReach", label: "Dynamite clears a block within", group: G, min: 0, max: 10, step: 0.5, unit: "m" },
] as const
