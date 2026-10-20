import { registerOutbreakSharedFeature } from "../feature-registry"
import { DEFAULT_SECRETS_TUNING, type SecretsTuning } from "./catalog"
import { cellarHandler, createSecretsState, stepSecrets, syncSecrets, type SecretsState } from "./cellar"

/**
 * Secrets and lore (AR-85, `docs/outbreak-secrets.md`): which secrets a run has and where is a pure function of the
 * town's seeds and this tuning; the only simulation is the radio man's cellar, whose padlock and stash are shared
 * ledger stores (nothing new on the wire). Everything else is drawn and noticed by `src/secrets/`.
 */
export const outbreakSecretsSharedFeature = registerOutbreakSharedFeature<SecretsState, undefined, SecretsTuning>({
  id: "secrets",
  // After progression (20), which keeps the ledger.
  order: 31,
  tuning: { namespace: "secrets", defaults: DEFAULT_SECRETS_TUNING },
  createState: (sim) => createSecretsState(sim),
  cloneState: (state) => ({ ...state }),
  registerInteractions: (sim, registry) => registry.register(cellarHandler(sim, "secrets")),
  onChunkSync: (sim, state) => syncSecrets(sim, state),
  onTopologyChanged: (sim, state) => syncSecrets(sim, state),
  stepWorld: ({ sim, resolved, state }) => stepSecrets(sim, state, resolved.features),
})
