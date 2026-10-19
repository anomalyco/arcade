import { applyNetNoises, syncClientHearing } from "../../shared/noises/apply"
import { registerOutbreakClientFeature } from "../feature-registry"
import type { NetSession } from "../net-session"

const applied = new WeakMap<NetSession, number>()

/**
 * Co-op noises (`shared/noises`): the room's noise bus, replicated, fills the client's so sound cues, fog ripples,
 * crows and callouts see what the room's dead hear.
 */
export const outbreakNoisesFeature = registerOutbreakClientFeature({
  id: "noises",
  order: 45,
  netSession: {
    onApplyWorld: (net, shared) => {
      applied.set(net, applyNetNoises(net.sim, shared.noises, applied.get(net) ?? 0))
    },
    onSyncFrame: (net) => syncClientHearing(net.sim),
  },
})
