import type { LabControl } from "@arcade/kit/lab-panel"
import { registerOutbreakClientFeature } from "../feature-registry"
import { propDressingStats } from "./dressing"
import { DEFAULT_PROP_SETTINGS } from "./settings"

const GROUP = "Props"

function controls(): LabControl[] {
  return [
    { key: "propsOn", label: "Furnish start houses (prop library)", group: GROUP, type: "toggle" },
    { key: "propClutter", label: "Clutter density", group: GROUP, min: 0, max: 2, step: 0.05, unit: "×" },
    { key: "propSeed", label: "Clutter reroll", group: GROUP, min: 0, max: 99, step: 1, unit: "" },
    { key: "propLodZoom", label: "Far LOD above zoom", group: GROUP, min: 15, max: 80, step: 1, unit: "m" },
    { key: "propBrightness", label: "Albedo brightness", group: GROUP, min: 0.5, max: 2.5, step: 0.05, unit: "×" },
    { key: "propAO", label: "Baked AO strength", group: GROUP, min: 0, max: 1, step: 0.05, unit: "" },
    { key: "propSaturation", label: "Saturation", group: GROUP, min: 0, max: 1.5, step: 0.05, unit: "×" },
  ]
}

/** Furniture and props from `@arcade/kit/props` in the start block's houses (`dressing.ts`, wired in `main.ts`). */
export const outbreakPropsFeature = registerOutbreakClientFeature({
  id: "props",
  order: 40,
  settingsGroup: { subsystem: "props", defaults: DEFAULT_PROP_SETTINGS },
  labControls: () => controls(),
  harnessState: () => ({ props: propDressingStats() }),
})
