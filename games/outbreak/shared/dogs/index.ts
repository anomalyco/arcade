import { registerOutbreakSharedFeature } from "../feature-registry"
import { DEFAULT_DOG_TUNING, type DogTuning } from "./dogs"
import { createDogsState, dogHandler, dogTuning, stepDogs, syncDogSites, type DogsState } from "./runtime"

/**
 * Chained dogs (AR-56): a dog in a yard barks at anything near, warning survivors and calling the dead; feed it and it
 * hushes and befriends you; the dead it calls can kill it. One ledger store per dog; this feature keeps where the dogs
 * are and each barking dog's beat. Tunables live in the Discovery settings.
 */
export const outbreakDogsSharedFeature = registerOutbreakSharedFeature<DogsState, undefined, DogTuning>({
  id: "dogs",
  order: 30,
  tuning: { namespace: "dogs", defaults: DEFAULT_DOG_TUNING, legacyNamespaces: ["discovery"] },
  createState: (sim) => createDogsState(sim),
  registerInteractions: (sim, registry) => registry.register(dogHandler(sim, "dogs")),
  onChunkSync: (sim, state) => syncDogSites(sim, state),
  stepWorld: ({ sim, resolved, state }) => {
    state.tuning = dogTuning(resolved.features)
    stepDogs(sim, state, state.tuning)
  },
})
