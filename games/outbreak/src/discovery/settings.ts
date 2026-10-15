import type { LabControl } from "@arcade/kit/lab-panel"

export const DEFAULT_DISCOVERY_SETTINGS = {
  /** The flashlight shows its charge: below the flicker threshold the beam narrows, warms to amber and dims its reach. */
  discoveryLowBeam: true,
  /** How much narrower the beam gets as the battery runs out, as a share of its cone. */
  discoveryLowBeamNarrow: 0.25,
  /** How much shorter the beam reaches as the battery runs out, as a share of its range. */
  discoveryLowBeamShorten: 0.3,
  /** How far the beam warms towards amber as the battery runs out (0 keeps its colour). */
  discoveryLowBeamAmber: 0.85,
  /** Opened containers show what is left inside as small props in a pulled-out drawer, instead of a list. */
  discoveryOpenContainers: true,
  /** Ground drops show as props on the floor instead of a floating label. */
  discoveryGroundProps: true,
  /** Size of the item props in opened containers and on the floor. */
  discoveryPropScale: 1,
  /** Prompt verbs fade once the player has used that kind of thing a few times, leaving the bare key cap. */
  discoveryFadeWords: true,
  /** Uses of a kind of prompt (doors, windows, containers…) before its words fade. */
  discoveryFadeUses: 3,
  /** At a workbench the camera leans in, so the mat and the corkboard's sketches can be read. */
  discoveryBenchFocus: true,
  /** Camera distance while leaning in at a workbench. */
  discoveryBenchZoom: 7.5,
  /** How far towards the bench the camera centre moves while leaning in (0 stays on the survivor). */
  discoveryBenchCentre: 0.8,
  /** Seconds the mat's materials shake and settle after a try that came to nothing. */
  discoveryClatterTime: 0.55,
}

export type DiscoverySettings = typeof DEFAULT_DISCOVERY_SETTINGS

export const discoveryControls: LabControl[] = [
  { key: "discoveryLowBeam", label: "Low battery shows in the beam", group: "Discovery" },
  { key: "discoveryLowBeamNarrow", label: "Low beam narrows by", group: "Discovery", min: 0, max: 0.6, step: 0.05, unit: "×" },
  { key: "discoveryLowBeamShorten", label: "Low beam shortens by", group: "Discovery", min: 0, max: 0.7, step: 0.05, unit: "×" },
  { key: "discoveryLowBeamAmber", label: "Low beam amber", group: "Discovery", min: 0, max: 1, step: 0.05, unit: "" },
  { key: "discoveryOpenContainers", label: "Opened containers show contents", group: "Discovery" },
  { key: "discoveryGroundProps", label: "Drops lie on the floor", group: "Discovery" },
  { key: "discoveryPropScale", label: "Item prop size", group: "Discovery", min: 0.5, max: 2, step: 0.05, unit: "×" },
  { key: "discoveryFadeWords", label: "Prompt words fade with use", group: "Discovery" },
  { key: "discoveryFadeUses", label: "Uses before words fade", group: "Discovery", min: 1, max: 10, step: 1, unit: "" },
  { key: "discoveryBenchFocus", label: "Camera leans in at the bench", group: "Discovery" },
  { key: "discoveryBenchZoom", label: "Bench camera distance", group: "Discovery", min: 6, max: 30, step: 0.5, unit: "m" },
  { key: "discoveryBenchCentre", label: "Bench camera centring", group: "Discovery", min: 0, max: 1, step: 0.05, unit: "" },
  { key: "discoveryClatterTime", label: "Failed try shake", group: "Discovery", min: 0, max: 1.5, step: 0.05, unit: "s" },
]
