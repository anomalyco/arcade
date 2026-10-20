import { registerOutbreakSharedFeature } from "../feature-registry"
import { applyInventoryOp } from "./ops"

/**
 * Inventory moves (AR-94): the `inv` command moves a stack between your hands, pack and belt, what you face, the ground
 * and a teammate in reach. Every Lab › Inventory style sends the same command, so co-op players can each use their own.
 */
export const outbreakInventoryOpsSharedFeature = registerOutbreakSharedFeature({
  id: "inventory-ops",
  order: 25,
  stepSurvivorActions: ({ sim, slot, command }) => {
    if (command.inv) applyInventoryOp(sim, slot, command.inv)
  },
})
