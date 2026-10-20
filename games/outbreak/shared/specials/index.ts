import { registerOutbreakSharedFeature } from "../feature-registry"
import { withCoopSpecials } from "../night-ramp/coop"
import { nightRampTuning, withNightRampSpecials } from "../night-ramp/ramp"
import { DEFAULT_SPECIALS_TUNING, specialsTuning, type SpecialsTuning } from "./kinds"
import { createSpecialsState, specialHitOutcome, stepSpecials, stepSpecialsLate, type SpecialsState } from "./specials"
import { specialsNetSection } from "./net"
import type { SpecialsSnapshot } from "./net-types"

/** Specials tuning with the night ramp's per-night chance and the co-op thinning applied. */
function tuningFor(players: number, resolved: Parameters<typeof specialsTuning>[0] & { features?: Readonly<Record<string, Record<string, unknown>>> }): SpecialsTuning {
  const ramp = nightRampTuning(resolved?.features)
  return withCoopSpecials(withNightRampSpecials(specialsTuning(resolved), ramp), ramp, players)
}

export const outbreakSpecialsSharedFeature = registerOutbreakSharedFeature<SpecialsState, SpecialsSnapshot, SpecialsTuning>({
  id: "specials",
  // After hordes (16), so members that materialized this tick are rolled before the crowd steps.
  order: 17,
  netSection: specialsNetSection,
  tuning: { namespace: "specials", defaults: DEFAULT_SPECIALS_TUNING },
  createState: (sim) => {
    sim.combat.hitRule = (z, hit) => specialHitOutcome(sim, z, hit)
    return createSpecialsState(sim.hour)
  },
  cloneState: (state, targetSim) => {
    targetSim.combat.hitRule = (z, hit) => specialHitOutcome(targetSim, z, hit)
    return structuredClone(state)
  },
  stepWorld: ({ sim, dt, resolved, state }) => {
    stepSpecials(sim, state, tuningFor(sim.slots.length, resolved), dt, resolved.flashlight)
  },
  stepWorldLate: ({ sim, dt, resolved, state }) => {
    stepSpecialsLate(sim, state, tuningFor(sim.slots.length, resolved), dt)
  },
})
