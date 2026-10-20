import { registerOutbreakClientFeature } from "../feature-registry"
import { currentDetails } from "./presenter"
import { DEFAULT_DETAIL_SETTINGS, detailControls } from "./settings"

/** World details (`presenter.ts`, drawn from `scene/frame-renderer.ts`); Lab › Details. */
export const outbreakDetailsFeature = registerOutbreakClientFeature({
  id: "details",
  order: 47,
  settingsGroup: { subsystem: "details", defaults: DEFAULT_DETAIL_SETTINGS },
  labControls: () => detailControls,
  harnessState: () => {
    const d = currentDetails()
    return { details: d ? { ...d.shown, life: { ...d.touches.shown } } : null }
  },
})
