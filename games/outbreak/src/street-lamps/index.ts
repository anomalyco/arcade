import { registerOutbreakClientFeature } from "../feature-registry"
import { DEFAULT_STREET_LAMP_SETTINGS, streetLampControls } from "./settings"

/**
 * Lens street lamps (Lab › Look · Street lamps, Today one setting away): `lens.ts` reshapes the resolved street lamps
 * in `scene/frame-lighting.ts` (head, radius, flux, street cone, polar shadow), the scene's lightAttenuation reads the
 * cone (`shaders.ts`), `evalLampAir` lights the air from the lens (`lighting.ts`) and the fog takes them as lens lamps.
 */
export const outbreakStreetLampsFeature = registerOutbreakClientFeature({
  id: "street-lamps",
  order: 32,
  settingsGroup: { subsystem: "streetLamps", defaults: DEFAULT_STREET_LAMP_SETTINGS },
  labControls: () => streetLampControls,
  harnessState: (host) => ({ streetLamps: { on: host.settings.streetLamps.streetLampStyle > 0.5 } }),
})
