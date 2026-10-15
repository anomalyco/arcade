import type { LabControl } from "@arcade/kit/lab-panel"

export const HUD_MODE_CALLOUTS = 0
export const HUD_MODE_LOG = 1

export const DEFAULT_HUD_SETTINGS = {
  /** 0 = callouts above the survivor, 1 = the old bottom-left status log. */
  hudMode: HUD_MODE_CALLOUTS,
  /** Callout font size in CSS pixels. */
  calloutSize: 12,
  /** Screen gap between the top of the survivor's head and the lowest callout, in CSS pixels. */
  calloutOffset: 10,
  /** Multiplies how long result, warning and info callouts stay up. */
  calloutDuration: 1,
  /** Most callouts stacked above one actor at once. */
  calloutMax: 3,
}

export type HudSettings = typeof DEFAULT_HUD_SETTINGS

export const hudControls: LabControl[] = [
  {
    key: "hudMode",
    label: "Action feedback",
    group: "HUD",
    options: [
      { label: "Above survivor", value: HUD_MODE_CALLOUTS },
      { label: "Bottom-left log", value: HUD_MODE_LOG },
    ],
  },
  { key: "calloutSize", label: "Callout size", group: "HUD", min: 9, max: 20, step: 0.5, unit: "px" },
  { key: "calloutOffset", label: "Callout offset", group: "HUD", min: 0, max: 60, step: 1, unit: "px" },
  { key: "calloutDuration", label: "Callout duration", group: "HUD", min: 0.5, max: 3, step: 0.1, unit: "×" },
  { key: "calloutMax", label: "Max stacked", group: "HUD", min: 1, max: 4, step: 1, unit: "" },
]
