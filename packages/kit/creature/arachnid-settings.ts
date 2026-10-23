/**
 * Typed Lab settings for the arachnid: size, leg length, ride height, step timing and leg thickness, with the labels,
 * units, ranges and defaults Kit approves. A game binds the same object to its LabPanel; the Lab station shows it.
 * Shape changes (size, legs, ride, step) take effect by re-standing the legs where the root is (a retrigger
 * boundary); look changes (thickness) rebuild the meshes in place.
 */
import type { LabControl } from "../lab-navigation"
import { HARVESTMAN_SHAPE, legLengths, type ArachnidShape } from "./arachnid-legs"
import { CREATURE_WALK } from "../sim/creature-motion"

export type ArachnidSettings = {
  /** Body scale: metres per lamplight unit at the body (lamplight's spider is 1; horse-sized is about 3.5). */
  size: number
  /** Leg length against the body (1 = a wolf spider, 2–3 = harvestman proportions). */
  legs: number
  /** Body height over its feet, as a share of a leg's length. */
  ride: number
  /** Swing time against lamplight's (1); above 1 steps slower. */
  swing: number
  /** Lift curve exponent: 0.8 snaps (lamplight), 1.6 sets each foot down softly. */
  lift: number
  /** Femur radius at the hip, metres. */
  legRadius: number
  /** Walking speed as a share of full walking pace. */
  pace: number
}

export const ARACHNID_DEFAULTS: Readonly<ArachnidSettings> = {
  size: 3.5,
  legs: 2.5,
  ride: HARVESTMAN_SHAPE.ride,
  swing: HARVESTMAN_SHAPE.swing,
  lift: HARVESTMAN_SHAPE.lift,
  legRadius: 0.06,
  pace: 0.35,
}

export const createArachnidSettings = (over: Partial<ArachnidSettings> = {}): ArachnidSettings => ({ ...ARACHNID_DEFAULTS, ...over })

/** Metres per creature unit for the legs (the gait's Froude scale). */
export const arachnidScale = (s: ArachnidSettings) => s.size * s.legs
export const arachnidShape = (s: ArachnidSettings): ArachnidShape => ({ hips: 1 / s.legs, ride: s.ride, swing: s.swing, lift: s.lift })
/** Full leg length (hip to foot) in metres, its walking speed in m/s at `pace`. */
export const arachnidLegMetres = (s: ArachnidSettings) => legLengths(3).reduce((a, b) => a + b, 0) * arachnidScale(s)
export const arachnidWalkMetres = (s: ArachnidSettings) => CREATURE_WALK * s.pace * Math.sqrt(arachnidScale(s))

/** LabPanel rows for these settings (`prefix.key` ids, `field` the property). */
export function arachnidControls(s: ArachnidSettings, opts: { prefix?: string; group?: string; change?: (key: keyof ArachnidSettings) => void } = {}): LabControl[] {
  const prefix = opts.prefix ?? "spider", group = opts.group ?? "Spider"
  const row = (field: keyof ArachnidSettings, label: string, min: number, max: number, step: number, unit: string, subsection?: string): LabControl =>
    ({ key: `${prefix}.${field}`, field, label, group, subsection, type: "range", min, max, step, unit, change: () => opts.change?.(field) })
  return [
    row("size", "Body scale", 1, 6, 0.1, "×"),
    row("legs", "Leg length", 1, 3.5, 0.05, "× body"),
    row("ride", "Body height", 0.25, 0.6, 0.01, "× leg"),
    row("pace", "Walk speed", 0.1, 1, 0.05, "× full"),
    row("swing", "Step time", 0.6, 2.5, 0.05, "×", "Step"),
    row("lift", "Step softness", 0.6, 3, 0.05, "", "Step"),
    row("legRadius", "Leg thickness", 0.02, 0.15, 0.005, "m", "Look"),
    { key: `${prefix}.legReach`, label: "Leg length", group, type: "readout", read: () => `${arachnidLegMetres(s).toFixed(1)} m` },
    { key: `${prefix}.walkSpeed`, label: "Walking", group, type: "readout", read: () => `${arachnidWalkMetres(s).toFixed(2)} m/s` },
  ]
}
