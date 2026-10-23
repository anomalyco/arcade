import { WATER_CONTROLS } from "@arcade/kit/water/controls"
import { createWaterSettings } from "@arcade/kit/water/settings"
import type { Ocean } from "../render/ocean"
import type { DevSection } from "./dev-panel"

export function waterSection(ocean: Ocean): DevSection {
  return { id: "water", tab: "Water", bind: panel => panel.addControls(ocean.water, WATER_CONTROLS, createWaterSettings()) }
}
