import { registerOutbreakSharedFeature } from "../feature-registry"
import { createTrainingState, holdTrainingHour, stepChain, trainingDamage, type TrainingState } from "./training"

/**
 * The training room (AR-89): inert unless `stageTraining` turned this sim into one (only the client's offline
 * training session does), so real runs, bots and co-op rooms never see it. Nothing on the wire.
 */
export const outbreakOnboardingSharedFeature = registerOutbreakSharedFeature<TrainingState>({
  id: "onboarding",
  order: 90,
  createState: () => createTrainingState(),
  stepWorld: ({ sim, state }) => holdTrainingHour(sim, state),
  stepWorldLate: ({ sim, state }) => stepChain(sim, state),
  modifySurvivorDamage: (_sim, slot, damage, state) => trainingDamage(slot.survivor, damage, state),
})
