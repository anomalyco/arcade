import { BIRD_CONTROLS, BIRD_DEFAULTS, BIRDS } from "../render/birds"
import { CANOPY_RAIN, CANOPY_RAIN_CONTROLS, CANOPY_RAIN_DEFAULTS } from "../render/canopy-rain"
import type { DevSection } from "./dev-panel"

/** Life around you on the dev panel: seabirds and canopy rain (World tab). Every value is read live. */
export function lifeSections(): DevSection[] {
  return [
    { id: "birds", tab: "World", bind: (panel) => panel.addControls(BIRDS, BIRD_CONTROLS, BIRD_DEFAULTS) },
    { id: "canopy-rain", tab: "World", bind: (panel) => panel.addControls(CANOPY_RAIN, CANOPY_RAIN_CONTROLS, CANOPY_RAIN_DEFAULTS) },
  ]
}
