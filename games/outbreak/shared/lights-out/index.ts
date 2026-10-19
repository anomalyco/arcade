import { registerOutbreakSharedFeature } from "../feature-registry"
import { DEFAULT_LIGHTS_TUNING, type LightsTuning } from "./lights"
import { applyDarkLamps, createLightsState, lightsTuning, porchSwitchHandler, stepLights, type LightsState } from "./runtime"

/**
 * Lights Out (AR-56): shoot a street lamp or porch light out, or switch a porch light off at its door, and that pool of
 * light is gone, so the dead see less of whoever stands there. State is one ledger store per lamp; this feature keeps
 * the lamps' own power and the shots it has looked at. Tunables live in the Discovery settings.
 */
export const outbreakLightsSharedFeature = registerOutbreakSharedFeature<LightsState, undefined, LightsTuning>({
  id: "lights",
  // After combat has fired this tick's shots (survivor actions) and after progression's world stores (20).
  order: 27,
  tuning: { namespace: "lights", defaults: DEFAULT_LIGHTS_TUNING, legacyNamespaces: ["discovery"] },
  createState: () => createLightsState(),
  registerInteractions: (sim, registry) => registry.register(porchSwitchHandler(sim, "lights")),
  onChunkSync: (sim, state) => applyDarkLamps(sim, state),
  stepWorld: ({ sim, resolved, state }) => {
    state.tuning = lightsTuning(resolved.features)
    stepLights(sim, state)
  },
})
