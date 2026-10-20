import { registerOutbreakSharedFeature } from "../feature-registry"
import { registerBreachInteractions } from "./interactions"
import { breachNetSection, type BreachSnapshot } from "./net"
import { breachTuning, createBreachState, DEFAULT_BREACH_TUNING, stepBreach, type BreachState, type BreachTuning } from "./rules"

export const outbreakBreachSharedFeature = registerOutbreakSharedFeature<BreachState, BreachSnapshot, BreachTuning>({
  id: "breach",
  // Late, so its door handler wraps the one the sim built and its bash rules are set before the crowd steps.
  order: 60,
  netSection: breachNetSection,
  tuning: { namespace: "breach", defaults: DEFAULT_BREACH_TUNING },
  createState: () => createBreachState(),
  registerInteractions: (sim, registry) => registerBreachInteractions(sim, registry),
  stepWorld: ({ sim, dt, resolved, state }) => stepBreach(sim, state, breachTuning(resolved.features), dt),
})
