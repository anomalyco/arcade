import { coopPopulationScale, TODAY_COOP, type CoopCurve } from "../pacing"
import type { SpecialsTuning } from "../specials/kinds"

/**
 * Co-op scaling (AR-92): how the director grows with the squad. Today's scaling was linear (population +0.35× and
 * chasers +0.6× per extra survivor, every survivor's gunfire counted in full), so four survivors met 2× the dead and
 * 2.8× the chasers within a minute, with the director's noise heat pinned at its ceiling. The sub-linear curve grows
 * each by `perSurvivor × (survivors − 1)^exponent`, counts the squad's noise as `survivors^noiseExponent` shooters,
 * holds Night 1 near the solo Gentle Start, and keeps new zombies away from every survivor. Lab › Co-op scaling;
 * `coopScaleMode: 0` is Today. Values live in the night ramp's tuning namespace.
 */
export type CoopScalingTuning = {
  /** 1: sub-linear. 0: Today (linear). */
  coopScaleMode: number
  /** Population each extra survivor adds before the curve. */
  coopPopulationPerSurvivor: number
  /** Chaser cap each extra survivor adds before the curve (times the solo cap). */
  coopChasersPerSurvivor: number
  /** Exponent on extra survivors (1 = linear). */
  coopCurve: number
  /** The squad's noise heat is divided by survivors^this (0 = every shot counts in full). */
  coopNoiseShare: number
  /** Chasers each extra survivor adds to the Night 1 hold, before the curve. */
  coopNightOneChasers: number
  /** In a squad, no new zombie comes into the world nearer than this to any survivor, m (solo keeps its own 16 m). */
  coopSpawnClearance: number
  /** Special-zombie chance is divided by the co-op population scale to this power (1: specials don't grow with the squad; 0: Today). */
  coopSpecialShare: number
}

export const DEFAULT_COOP_SCALING: CoopScalingTuning = {
  coopScaleMode: 1,
  coopPopulationPerSurvivor: 0.3,
  coopChasersPerSurvivor: 0.45,
  coopCurve: 0.7,
  coopNoiseShare: 0.75,
  coopNightOneChasers: 0.4,
  coopSpawnClearance: 22,
  coopSpecialShare: 1,
}

export const coopScalingControls = [
  {
    key: "nightRamp.coopScaleMode",
    field: "coopScaleMode",
    label: "Co-op scaling",
    group: "Co-op scaling",
    options: [
      { label: "Today (linear)", value: 0 },
      { label: "Sub-linear", value: 1 },
    ],
  },
  { key: "nightRamp.coopPopulationPerSurvivor", field: "coopPopulationPerSurvivor", label: "Population per extra survivor", group: "Co-op scaling", min: 0, max: 1, step: 0.05, unit: "×" },
  { key: "nightRamp.coopChasersPerSurvivor", field: "coopChasersPerSurvivor", label: "Chasers per extra survivor", group: "Co-op scaling", min: 0, max: 1, step: 0.05, unit: "×" },
  { key: "nightRamp.coopCurve", field: "coopCurve", label: "Curve (1 = linear)", group: "Co-op scaling", min: 0.3, max: 1, step: 0.05, unit: "" },
  { key: "nightRamp.coopNoiseShare", field: "coopNoiseShare", label: "Squad noise share", group: "Co-op scaling", min: 0, max: 1, step: 0.05, unit: "" },
  { key: "nightRamp.coopNightOneChasers", field: "coopNightOneChasers", label: "Night 1 chasers per extra survivor", group: "Co-op scaling", min: 0, max: 2, step: 0.1, unit: "" },
  { key: "nightRamp.coopSpawnClearance", field: "coopSpawnClearance", label: "New zombies at least", group: "Co-op scaling", min: 0, max: 40, step: 1, unit: "m" },
  { key: "nightRamp.coopSpecialShare", field: "coopSpecialShare", label: "Specials kept to the solo count", group: "Co-op scaling", min: 0, max: 1, step: 0.05, unit: "" },
] as const

/** The director's co-op curve for these settings. */
export function coopCurve(t: CoopScalingTuning): CoopCurve {
  if (t.coopScaleMode <= 0) return TODAY_COOP
  return {
    mode: 1,
    populationPerSurvivor: t.coopPopulationPerSurvivor,
    chasersPerSurvivor: t.coopChasersPerSurvivor,
    exponent: t.coopCurve,
    noiseExponent: t.coopNoiseShare,
    openingChasersPerSurvivor: t.coopNightOneChasers,
    spawnClearance: t.coopSpawnClearance,
  }
}

/**
 * The Specials group's tuning with the special-zombie chance thinned for the squad: a bigger crowd already rolls more
 * zombies, so without this six survivors met 3–4× the solo specials on Night 1 and the first one a minute sooner.
 */
export function withCoopSpecials(specials: SpecialsTuning, t: CoopScalingTuning, players: number): SpecialsTuning {
  if (t.coopScaleMode <= 0 || players <= 1 || t.coopSpecialShare <= 0) return specials
  const thin = Math.pow(coopPopulationScale(players, coopCurve(t)), t.coopSpecialShare)
  return { ...specials, specialRate: specials.specialRate / thin }
}
