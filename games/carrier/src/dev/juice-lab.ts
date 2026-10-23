import { FLIGHT_FX, FLIGHT_FX_CONTROLS, FLIGHT_FX_DEFAULTS } from "../render/flight-fx"
import type { DevSection } from "./dev-panel"

/**
 * JUICE: the flight effects (src/render/flight-fx.ts FLIGHT_FX: the burner FOV kick, vapour, the vapour
 * cone, heat shimmer, the burner's light-up, sea spray and wake) on the dev panel's Flight tab, with their approved
 * defaults and Reset. Every value is read live each frame.
 */
export const juiceSection: DevSection = {
  id: "juice",
  tab: "Flight",
  bind: (panel) => panel.addControls(FLIGHT_FX, FLIGHT_FX_CONTROLS, FLIGHT_FX_DEFAULTS),
}
