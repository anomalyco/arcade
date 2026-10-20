import type { LabControl } from "@arcade/kit/lab-panel"

/** Today: name tags only while a teammate is in sight. */
export const TEAMMATE_MARKERS_TODAY = 0
/** A chevron with name and distance at the screen edge, and a faint ring where an unseen teammate stands (default). */
export const TEAMMATE_MARKERS_ON = 1

/** Teammate markers (playtest: "Where'd you guys go?"); the values live in the HUD settings (Backquote › HUD). */
export const DEFAULT_TEAMMATE_MARKER_SETTINGS = {
  teammateMarkers: TEAMMATE_MARKERS_ON,
  /** Opacity of a marker for a teammate who is fine; a downed one is always full. */
  teammateMarkerOpacity: 0.72,
  /** Distance from the screen edge for the off-screen chevrons (CSS px). */
  teammateMarkerMargin: 28,
}

export type TeammateMarkerSettings = typeof DEFAULT_TEAMMATE_MARKER_SETTINGS

export const teammateMarkerControls: LabControl[] = [
  {
    key: "teammateMarkers",
    label: "Teammate markers",
    group: "Teammates",
    options: [
      { label: "Edge arrows and unseen rings", value: TEAMMATE_MARKERS_ON },
      { label: "Today (name tags in sight)", value: TEAMMATE_MARKERS_TODAY },
    ],
  },
  { key: "teammateMarkerOpacity", label: "Marker opacity", group: "Teammates", min: 0.2, max: 1, step: 0.05, unit: "×" },
  { key: "teammateMarkerMargin", label: "Edge margin", group: "Teammates", min: 8, max: 80, step: 1, unit: "px" },
]
