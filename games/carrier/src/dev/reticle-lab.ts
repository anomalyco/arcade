import { RETICLE, RETICLE_CONTROLS, RETICLE_DEFAULTS } from "../weapons/reticle"
import type { DevSection } from "./dev-panel"

/**
 * RETICLES: the gun and seeker reticles' typed settings (src/weapons/reticle.ts RETICLE) on the dev panel's Flight tab,
 * with their approved defaults and Reset. Every value is read live each frame.
 */
export const reticleSection: DevSection = {
  id: "reticle",
  tab: "Flight",
  bind: (panel) => panel.addControls(RETICLE, RETICLE_CONTROLS, RETICLE_DEFAULTS),
}
