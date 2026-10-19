import { registerOutbreakClientFeature } from "../feature-registry"
import { currentNightLights } from "./presenter"
import { DEFAULT_NIGHT_LIGHT_SETTINGS, nightLightControls } from "./settings"

/** Coloured night practicals (`presenter.ts`, drawn and lit from `scene/frame-renderer.ts`); Lab › Night lights. */
export const outbreakNightLightsFeature = registerOutbreakClientFeature({
  id: "night-lights",
  order: 46,
  settingsGroup: { subsystem: "nightLights", defaults: DEFAULT_NIGHT_LIGHT_SETTINGS },
  labControls: () => nightLightControls,
  harnessState: () => ({ nightLights: currentNightLights()?.shown ?? null }),
})
