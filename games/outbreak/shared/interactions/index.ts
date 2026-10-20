import type { DeathState } from "../death/rules"
import { registerOutbreakSharedFeature } from "../feature-registry"
import type { OutbreakSim } from "../sim-types"
import { createDragState, dragSpeed, furnitureHandler, holdsFor, pushOutOfFurniture, restingFurniture, seedFurniture, stepDragged, stepHauls, type DragState } from "./drag"
import { createTossState, seedThrowables, stepTosses, stepWindup, type TossState } from "./tosses"
import { DEFAULT_INTERACTIONS_TUNING, interactionsTuning, type InteractionsTuning } from "./tuning"

const isDown = (sim: OutbreakSim, index: number) => sim.getFeatureState<DeathState>("death")?.records[index]?.state === "down"

export type InteractionsState = { tuning: InteractionsTuning; toss: TossState; drag: DragState }

/**
 * World interactions (AR-96). Throwables: baseballs, bricks, rocks, tin cans and bottles, wound up on the button and
 * thrown on release (progression leaves these items alone: `heldUse` "use", `tossBottles`). Loose furniture dragged
 * with E and braced against doors and windows, held for the crowd through `sim.ai.portalHolds`; downed teammates
 * hauled (`toggleHaul`, from the death feature's prompt). What every seat sees is ledger stores, so the feature adds
 * nothing to the wire.
 */
export const outbreakInteractionsSharedFeature = registerOutbreakSharedFeature<InteractionsState, undefined, InteractionsTuning>({
  id: "interactions",
  order: 31,
  tuning: { namespace: "interactions", defaults: DEFAULT_INTERACTIONS_TUNING },
  createState: () => ({ tuning: { ...DEFAULT_INTERACTIONS_TUNING }, toss: createTossState(), drag: createDragState() }),
  registerInteractions: (sim, registry) => {
    registry.register(furnitureHandler(sim, () => sim.getFeatureState<InteractionsState>("interactions")))
  },
  movementScale: (sim, slot, state) => dragSpeed(sim, state.drag, slot, state.tuning),
  pushOutSurvivor: (sim, survivor, radius, state) => pushOutOfFurniture(sim, state.drag, survivor, radius),
  survivorObstacles: (sim, state) => restingFurniture(sim, state.drag),
  stepSurvivorMovement: ({ sim, slot, command, predict, state }) => {
    stepWindup(sim, slot, command, predict, state.toss, state.tuning)
    return false
  },
  stepWorld: ({ sim, resolved, state }) => {
    const t = (state.tuning = interactionsTuning(resolved.features))
    sim.progression.tossBottles = t.throwables > 0
    if (t.throwables > 0) seedThrowables(sim, state.toss, t)
    if (t.furniture > 0) seedFurniture(sim, state.drag, t)
    const holds = sim.ai.portalHolds as (ReturnType<typeof holdsFor> | null)
    if (holds?.sim !== sim) sim.ai.portalHolds = holdsFor(sim, state.drag)
    stepDragged(sim, state.drag)
    stepHauls(sim, (index) => isDown(sim, index))
    return { topologyChanged: stepTosses(sim, t) }
  },
})
