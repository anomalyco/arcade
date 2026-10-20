import { registerOutbreakSharedFeature } from "../feature-registry"
import { createTossState, seedThrowables, stepTosses, stepWindup, type TossState } from "./tosses"
import { DEFAULT_INTERACTIONS_TUNING, interactionsTuning, type InteractionsTuning } from "./tuning"

export type InteractionsState = { tuning: InteractionsTuning; toss: TossState }

/**
 * World interactions (AR-96). Throwables: baseballs, bricks, rocks, tin cans and bottles, wound up on the button and
 * thrown on release (progression leaves these items alone: `heldUse` "use", `tossBottles`). What every seat sees is
 * ledger stores, so the feature adds nothing to the wire.
 */
export const outbreakInteractionsSharedFeature = registerOutbreakSharedFeature<InteractionsState, undefined, InteractionsTuning>({
  id: "interactions",
  order: 31,
  tuning: { namespace: "interactions", defaults: DEFAULT_INTERACTIONS_TUNING },
  createState: () => ({ tuning: { ...DEFAULT_INTERACTIONS_TUNING }, toss: createTossState() }),
  stepSurvivorMovement: ({ sim, slot, command, predict, state }) => {
    stepWindup(sim, slot, command, predict, state.toss, state.tuning)
    return false
  },
  stepWorld: ({ sim, resolved, state }) => {
    const t = (state.tuning = interactionsTuning(resolved.features))
    sim.progression.tossBottles = t.throwables > 0
    if (t.throwables > 0) seedThrowables(sim, state.toss, t)
    return { topologyChanged: stepTosses(sim, t) }
  },
})
