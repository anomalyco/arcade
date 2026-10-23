import { SIGHT_CAM, SIGHT_CAM_CONTROLS, SIGHT_CAM_DEFAULTS } from "../flight/camera"
import { SIGHT_STYLE, SIGHT_STYLE_CONTROLS, SIGHT_STYLE_DEFAULTS } from "../weapons/bombsight"
import type { DevSection } from "./dev-panel"

/**
 * SIGHT: the F-35C bombsight's typed settings (view: src/flight/camera.ts SIGHT_CAM; symbols: src/weapons/bombsight.ts
 * SIGHT_STYLE) on the dev panel's Flight tab, with their approved defaults and Reset. Every value is read live each frame.
 */
export const sightSection: DevSection = {
  id: "sight",
  tab: "Flight",
  bind: (panel) => {
    panel.addControls(SIGHT_CAM, SIGHT_CAM_CONTROLS, SIGHT_CAM_DEFAULTS)
    panel.addControls(SIGHT_STYLE, SIGHT_STYLE_CONTROLS, SIGHT_STYLE_DEFAULTS)
  },
}
