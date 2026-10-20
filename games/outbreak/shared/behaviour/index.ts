import { registerOutbreakSharedFeature } from "../feature-registry"
import { createBehaviourState, stepBehaviourAfter, stepBehaviourBefore, type BehaviourState } from "./mind"
import { behaviourNetSection } from "./net"
import type { BehaviourSnapshot } from "./net-types"
import { behaviourTuning, DEFAULT_BEHAVIOUR_TUNING, type BehaviourTuning } from "./tuning"

/**
 * Zombie behaviour (AR-91): personalities, senses and memory, followers and herds, day rest, feeding, climbing and
 * the weather's and the torch's pull on the dead (`mind.ts`). It runs after specials (17), night ramp (18) and
 * characters (18), so it sees each zombie's kind and habit before the crowd steps, and reads the crowd after them.
 */
export const outbreakBehaviourSharedFeature = registerOutbreakSharedFeature<BehaviourState, BehaviourSnapshot, BehaviourTuning, unknown>({
  id: "behaviour",
  order: 19,
  netSection: behaviourNetSection,
  tuning: { namespace: "behaviour", defaults: DEFAULT_BEHAVIOUR_TUNING },
  createState: () => createBehaviourState(),
  cloneState: (state) => structuredClone(state),
  stepWorld: ({ sim, resolved, state }) => {
    stepBehaviourBefore(sim, state, behaviourTuning(resolved.features), resolved.features)
  },
  stepWorldLate: ({ sim, state }) => {
    stepBehaviourAfter(sim, state)
  },
})
