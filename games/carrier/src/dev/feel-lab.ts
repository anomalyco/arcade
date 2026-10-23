import { FEEL, FEEL_CONTROLS, FEEL_DEFAULTS } from "../flight/feel"
import type { DevSection } from "./dev-panel"

/**
 * FEEL: how the flight camera and the screen answer the jet (src/flight/feel.ts: chase lean and lag, g pull-in, the
 * catapult kick, cockpit head motion, gun recoil, release bumps, grey-out and red-out) on the dev panel's Flight tab.
 */
export const feelSection: DevSection = {
  id: "feel",
  tab: "Flight",
  bind: (panel) => {
    panel.addControls(FEEL, FEEL_CONTROLS, FEEL_DEFAULTS)
  },
}
