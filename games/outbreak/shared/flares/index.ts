import { registerOutbreakSharedFeature } from "../feature-registry"
import { DEFAULT_FLARE_TUNING, type FlareTuning } from "./flares"
import { createFlaresState, flareTuning, stepFlares, throwFlare, type FlaresState } from "./runtime"

/**
 * Road flares (AR-56): thrown from the hotbar like a bottle, a flare burns red for half a minute and the dead who can
 * see it go and stand in its light. Each burning flare is a ledger store; this feature keeps only each one's beat.
 * Tunables live in the Discovery settings.
 */
export const outbreakFlaresSharedFeature = registerOutbreakSharedFeature<FlaresState, undefined, FlareTuning>({
  id: "flares",
  order: 28,
  tuning: { namespace: "flares", defaults: DEFAULT_FLARE_TUNING, legacyNamespaces: ["discovery"] },
  createState: () => createFlaresState(),
  // Progression leaves a held flare alone when the button is pressed (`act`); it is thrown here.
  stepSurvivorActions: ({ sim, slot, command, predict, resolved, state }) => {
    if (predict || !command.fire || sim.progression.selected(slot.id)?.item !== "flare") return
    state.tuning = flareTuning(resolved.features)
    throwFlare(sim, slot, state.tuning)
  },
  stepWorld: ({ sim, resolved, state }) => {
    state.tuning = flareTuning(resolved.features)
    stepFlares(sim, state, state.tuning)
  },
})
