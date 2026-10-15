import { registerOutbreakSharedFeature } from "../feature-registry"
import { DEFAULT_PACING_TUNING, type PacingTuning } from "../pacing"

export * from "../pacing"

export const outbreakPacingSharedFeature = registerOutbreakSharedFeature<undefined, undefined, PacingTuning>({
  id: "pacing",
  order: 15,
  tuning: {
    namespace: "pacing",
    legacyNamespaces: ["ai"],
    defaults: DEFAULT_PACING_TUNING,
  },
  stepWorld: ({ sim, resolved }) => {
    const config = sim.ai.config
    const src = resolved.ai
    if (!src) return
    if (src.directorPacing !== undefined) config.directorPacing = src.directorPacing
    if (src.startHour !== undefined) config.startHour = src.startHour
    if (src.openingClock !== undefined) config.openingClock = src.openingClock
    if (src.openingCalm !== undefined) config.openingCalm = src.openingCalm
    if (src.safeRadius !== undefined) config.safeRadius = src.safeRadius
    if (src.initialDensity !== undefined) config.initialDensity = src.initialDensity
    if (src.rampTime !== undefined) config.rampTime = src.rampTime
    if (src.noiseSensitivity !== undefined) config.noiseSensitivity = src.noiseSensitivity
    if (src.maxActiveNearPlayer !== undefined) config.maxActiveNearPlayer = src.maxActiveNearPlayer
  },
})
