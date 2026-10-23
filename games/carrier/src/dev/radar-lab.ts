import { RADAR, RADAR_CONTROLS, RADAR_DEFAULTS } from "../flight/radar"
import type { DevSection } from "./dev-panel"

/**
 * RADAR: the pilot's radar, full map and target markers (src/flight/radar.ts RADAR) on the dev panel's Flight tab, with
 * their approved defaults and Reset. Every value is read live each frame.
 */
export const radarSection: DevSection = {
  id: "radar",
  tab: "Flight",
  bind: (panel) => panel.addControls(RADAR, RADAR_CONTROLS, RADAR_DEFAULTS),
}
