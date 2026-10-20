import { registerOutbreakSharedFeature } from "../feature-registry"
import { DEFAULT_BODIES_TUNING, type BodiesTuning } from "./bodies"
import { bodiesTuning, bodyHandler, createBodiesState, ensureBodyStores, stepBodies, syncBodySites, type BodiesState } from "./runtime"
import { bodiesNetSection } from "./net"
import type { BodiesSnapshot } from "./net-types"

/**
 * Bodies To Search (AR-56): dead survivors you kneel and search like a container; now and then one rises. Each body's
 * contents are a ledger store; this feature keeps where the bodies are. Tunables live in the Discovery settings.
 */
export const outbreakBodiesSharedFeature = registerOutbreakSharedFeature<BodiesState, BodiesSnapshot, BodiesTuning>({
  id: "bodies",
  order: 29,
  netSection: bodiesNetSection,
  tuning: { namespace: "bodies", defaults: DEFAULT_BODIES_TUNING, legacyNamespaces: ["discovery"] },
  createState: (sim) => createBodiesState(sim),
  registerInteractions: (sim, registry) => registry.register(bodyHandler(sim, "bodies")),
  onChunkSync: (sim, state) => {
    syncBodySites(sim, state)
    ensureBodyStores(sim, state)
  },
  stepWorld: ({ sim, resolved, state }) => {
    state.tuning = bodiesTuning(resolved.features)
    stepBodies(sim, state)
  },
})
