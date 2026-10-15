import { registerOutbreakSharedFeature } from "../feature-registry"
import { DEFAULT_PROGRESSION_TUNING, type ProgressionTuning } from "./tuning"

export * from "./catalog"
export * from "./loot"
export * from "./progression"
export * from "./tuning"
export * from "./types"
export { Ledger, type LedgerEvent, type Stack, type StoreState } from "@arcade/kit/sim/ledger"

export const outbreakProgressionSharedFeature = registerOutbreakSharedFeature<
  undefined,
  undefined,
  ProgressionTuning
>({
  id: "progression",
  order: 20,
  tuning: {
    namespace: "progression",
    defaults: DEFAULT_PROGRESSION_TUNING,
  },
  onChunkSync: (sim) => {
    sim.progression.ensureContainerStores()
  },
  onTopologyChanged: (sim) => {
    sim.progression.ensureContainerStores()
  },
  stepWorld: ({ sim, dt }) => sim.progression.step(dt, sim.world()),
})
