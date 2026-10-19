import type { LabControl } from "@arcade/kit/lab-panel"

/**
 * Lab settings for Outbreak's persistent blood (Backquote › Blood): stains placed in the world from the town seed and
 * the stains fights leave behind. Presentation only; every client places the same ambient stains for the same town.
 */
export type OutbreakBloodSettings = {
  /** Seeded ambient stains in streets, yards and houses (pools, smears, drag trails, handprints). */
  bloodWorld: boolean
  /** How many ambient stains per house, shop and street block (0 none, 1 default, 2 heavy). */
  bloodWorldDensity: number
  /** Share of homes and shops where something happened: a pool, a drag trail to a door, prints on the walls. */
  bloodIncidents: number
  /** Reroll the ambient stains (separate from the town seed and from parameter Randomize). */
  bloodSeed: number
  /** Fights leave stains that stay after the wet splatter fades. */
  bloodPersist: boolean
  /** Persistent fight stains kept at once; the oldest is reused when full. */
  bloodBudget: number
  /** Size of the pool that spreads under a body. */
  bloodPoolSize: number
  /** Seconds a pool takes to spread to its full size. */
  bloodPoolSpread: number
  /** Crawling zombies smear a trail behind them. */
  bloodTrails: boolean
  /** Bloody footprints after walking through a pool (0 off). */
  bloodFootprints: number
  /** Dirt worked into the blood: grime specks on stains and a browner, less saturated fresh splatter. */
  bloodGrime: number
  /** Value of the blood pigment (stain albedo multiplier, about 1 = Darkwood's wine-brown). */
  bloodValue: number
}

export const DEFAULT_BLOOD_SETTINGS: OutbreakBloodSettings = {
  bloodWorld: true,
  bloodWorldDensity: 1,
  bloodIncidents: 0.5,
  bloodSeed: 0,
  bloodPersist: true,
  bloodBudget: 320,
  bloodPoolSize: 1,
  bloodPoolSpread: 7,
  bloodTrails: true,
  bloodFootprints: 8,
  bloodGrime: 0.6,
  bloodValue: 1,
}

const GROUP = "Blood"

export const bloodControls: LabControl[] = [
  { key: "bloodWorld", label: "Stains around the world", group: GROUP, type: "toggle" },
  { key: "bloodWorldDensity", label: "World stain density", group: GROUP, min: 0, max: 2, step: 0.05, unit: "×" },
  { key: "bloodIncidents", label: "Places where something happened", group: GROUP, min: 0, max: 1, step: 0.05, unit: "" },
  { key: "bloodSeed", label: "World stain reroll", group: GROUP, min: 0, max: 99, step: 1, unit: "" },
  { key: "bloodPersist", label: "Fight stains stay", group: GROUP, type: "toggle" },
  { key: "bloodBudget", label: "Fight stain budget", group: GROUP, min: 32, max: 512, step: 16, unit: "" },
  { key: "bloodPoolSize", label: "Pool under a body", group: GROUP, min: 0, max: 1.8, step: 0.05, unit: "×" },
  { key: "bloodPoolSpread", label: "Pool spread time", group: GROUP, min: 0.5, max: 30, step: 0.5, unit: "s" },
  { key: "bloodTrails", label: "Crawler drag trails", group: GROUP, type: "toggle" },
  { key: "bloodFootprints", label: "Bloody footprints", group: GROUP, min: 0, max: 16, step: 1, unit: "steps" },
  { key: "bloodGrime", label: "Grime in the blood", group: GROUP, min: 0, max: 1, step: 0.05, unit: "" },
  { key: "bloodValue", label: "Blood value", group: GROUP, min: 0.4, max: 2, step: 0.05, unit: "×" },
]
