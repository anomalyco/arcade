import type { LabControl } from "@arcade/kit/lab-panel"

/** Today: tap E for the action, hold E for the second one (Shift+E and B for the rest). */
export const INTERACT_MENU_TODAY = 0
/** Hold E for a radial of every action on the target; a tap still takes E's own (default). */
export const INTERACT_MENU_RADIAL = 1

/** The radial E menu (playtest Oct 21, 1:45:21); the values live in the HUD settings (Backquote › Controls). */
export const DEFAULT_RADIAL_SETTINGS = {
  interactMenu: INTERACT_MENU_RADIAL,
  /** How long E is held before the radial opens (a shorter press is a tap). */
  radialDelay: 0.2,
  /** Distance from the centre to each wedge (CSS px). */
  radialRadius: 64,
}

export type RadialSettings = typeof DEFAULT_RADIAL_SETTINGS

export const radialControls: LabControl[] = [
  {
    key: "interactMenu",
    label: "E actions",
    group: "Controls",
    options: [
      { label: "Radial (hold E to pick)", value: INTERACT_MENU_RADIAL },
      { label: "Today (tap E, hold E)", value: INTERACT_MENU_TODAY },
    ],
  },
  { key: "radialDelay", label: "Radial opens after", group: "Controls", min: 0.08, max: 0.5, step: 0.01, unit: "s" },
  { key: "radialRadius", label: "Radial size", group: "Controls", min: 40, max: 120, step: 2, unit: "px" },
]
