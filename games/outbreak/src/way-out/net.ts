import type { OutbreakClientFeatureNetHooks } from "../feature-registry"
import type { NetSession } from "../net-session"
import { WAY_OUT_STORE } from "../../shared/way-out/state"

const cleared = new WeakMap<NetSession, string>()

/** The road's collision changes after its ledger arrives, before replaying predicted driving. */
export const wayOutNetHooks: OutbreakClientFeatureNetHooks = {
  onReconcileLocal: (net) => {
    const counts = net.sim.progression.ledger.store(WAY_OUT_STORE)?.counts ?? {}
    const key = Object.keys(counts).filter((k) => k.startsWith("rb:") && counts[k]).sort().join(",")
    const previous = cleared.get(net) ?? ""
    cleared.set(net, key)
    if (key !== previous) net.sim.rebuildSolids()
  },
}
