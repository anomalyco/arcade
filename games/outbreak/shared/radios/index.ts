import { registerOutbreakSharedFeature } from "../feature-registry"
import { DEFAULT_RADIO_TUNING, type RadioTuning } from "./radios"
import { createRadiosState, radioHandler, radioTuning, stepRadios, syncRadioSites, type RadiosState } from "./runtime"

/**
 * House radios (AR-56): switch one on and it calls the dead to that house until its battery dies, someone switches it
 * off, or they reach it and knock it down. State is one ledger store per radio; this feature only keeps where the
 * radios are and the tuning it last stepped with. Its tunables live in the Discovery settings, the namespace the
 * client already sends.
 */
export const outbreakRadiosSharedFeature = registerOutbreakSharedFeature<RadiosState, undefined, RadioTuning>({
  id: "radios",
  // After progression (20) and discovery (24), which keep the ledger's world stores.
  order: 26,
  tuning: { namespace: "radios", defaults: DEFAULT_RADIO_TUNING, legacyNamespaces: ["discovery"] },
  createState: (sim) => createRadiosState(sim),
  registerInteractions: (sim, registry) => registry.register(radioHandler(sim, "radios")),
  onChunkSync: (sim, state) => syncRadioSites(sim, state),
  onTopologyChanged: (sim, state) => syncRadioSites(sim, state),
  stepWorld: ({ sim, dt, resolved, state }) => {
    state.tuning = radioTuning(resolved.features)
    stepRadios(sim, state, dt, state.tuning)
  },
})
