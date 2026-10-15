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
]
