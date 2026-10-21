import { registerOutbreakClientFeature } from "../feature-registry"
import { DEFAULT_MIST_SETTINGS, mistControls } from "./settings"

/**
 * Low mist in yards and gutters (Lab › Look · Low mist, Today one setting away): the kit fog bank on the shared fog
 * volume (`mist/wgsl.ts`, slot 2 in `shaders.ts`), set up each frame by `air/lamp-fog.ts`.
 */
export const outbreakMistFeature = registerOutbreakClientFeature({
  id: "mist",
  order: 33,
  settingsGroup: { subsystem: "mist", defaults: DEFAULT_MIST_SETTINGS },
  labControls: () => mistControls,
  harnessState: (host) => ({ mist: { on: host.settings.mist.mistStyle > 0.5 } }),
})
