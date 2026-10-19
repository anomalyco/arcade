import { registerOutbreakSharedFeature } from "../feature-registry"
import { DEFAULT_FIRE_TUNING, type FireTuning } from "./fire"
import { createFireState, fireTuning, stepFireActions, stepFireLate, stepFireWorld, type FireState } from "./runtime"

/**
 * Fire & explosives: the flamethrower, dynamite, firecrackers, molotovs, the flare gun and bear traps. Progression
 * leaves these items alone on the button (`heldUse` "use"); they are used here. What every seat sees is ledger stores
 * (`fire.ts`), so the feature adds nothing to the wire.
 */
export const outbreakFireSharedFeature = registerOutbreakSharedFeature<FireState, undefined, FireTuning>({
  id: "fire",
  order: 29,
  tuning: { namespace: "fire", defaults: DEFAULT_FIRE_TUNING },
  createState: (sim) => createFireState(sim.seed),
  stepSurvivorActions: ({ sim, slot, command, dt, predict, resolved, state }) => {
    if (predict) return
    state.tuning = fireTuning(resolved.features)
    stepFireActions(sim, slot, command, dt, state, resolved.features)
  },
  stepWorld: ({ sim, resolved, state }) => {
    state.tuning = fireTuning(resolved.features)
    return { topologyChanged: stepFireWorld(sim, state) }
  },
  stepWorldLate: ({ sim, dt, state }) => stepFireLate(sim, state, dt),
})
