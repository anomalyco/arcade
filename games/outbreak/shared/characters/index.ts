import { registerOutbreakSharedFeature } from "../feature-registry"
import { charactersTuning, createCharactersState, DEFAULT_CHARACTERS_TUNING, stepHabits, type CharactersState, type CharactersTuning } from "./habits"

/**
 * Characters (AR-88): the dead hint at who they were. Callings and wear are read from the seed on every client
 * (`callings.ts`); habit loops pin a few new zombies to places in the town until they notice you (`habits.ts`,
 * `sites.ts`). No net section: clients derive everything from the seed, the position and the AI state they already get.
 */
export const outbreakCharactersSharedFeature = registerOutbreakSharedFeature<CharactersState, never, CharactersTuning>({
  id: "characters",
  // After specials (17), so a zombie has taken its kind before it can be given a habit.
  order: 18,
  tuning: { namespace: "characters", defaults: DEFAULT_CHARACTERS_TUNING },
  createState: () => createCharactersState(),
  cloneState: (state) => structuredClone(state),
  onChunkSync: (_sim, state) => {
    state.dirty = true
  },
  stepWorldLate: ({ sim, resolved, state }) => {
    state.tuning = charactersTuning(resolved.features)
    stepHabits(sim, state)
  },
})
