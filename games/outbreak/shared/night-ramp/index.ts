import { registerOutbreakSharedFeature } from "../feature-registry"
import { DEFAULT_NIGHT_RAMP_TUNING, nightRampTuning, type NightRampTuning } from "./ramp"
import { createNightRampState, stepNightRamp, stepNightRampLate, type NightRampState } from "./runtime"

export const outbreakNightRampSharedFeature = registerOutbreakSharedFeature<NightRampState, undefined, NightRampTuning>({
  id: "nightRamp",
  order: 18,
  tuning: { namespace: "nightRamp", defaults: DEFAULT_NIGHT_RAMP_TUNING },
  createState: (sim) => createNightRampState(sim.hour),
  stepWorld: ({ sim, resolved, state }) => stepNightRamp(sim, state, nightRampTuning(resolved.features)),
  stepWorldLate: ({ sim, resolved, state }) => stepNightRampLate(sim, state, nightRampTuning(resolved.features)),
})
