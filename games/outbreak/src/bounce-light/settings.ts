import type { PlanBounceInput } from "@arcade/kit/gpu/gi/plan-bounce"
import type { LabControl } from "@arcade/kit/lab-panel"

/**
 * Bounced light (AR-115): one bounce of coloured light in plan space, so fire, muzzle flashes, the flashlight pool,
 * lamps and lit windows spill their colour onto nearby floors and walls, softly held by walls
 * (`@arcade/kit/gpu/gi/plan-bounce`). On at ×3 by default (D-47); `bouncedLight` 0 is Today.
 */
export type OutbreakBounceSettings = {
  /** 0 Today (no bounced light), 1 Bounced light. */
  bouncedLight: number
  /** × one bounce. */
  bounceStrength: number
  /** How far bounced light reaches from where it lands, in metres. */
  bounceRange: number
  /** Grid size: metres per texel (0.25 fine, 0.5 default, 1 coarse). */
  bounceTexel: number
  /** How much light floors send back (reflectance). */
  bounceFloor: number
  /** How much more a lit wall sends back than a floor (walls are tall and face the light). */
  bounceWalls: number
  /** How much bounced light counts as light for the colour rule (colour only inside light). */
  bounceColour: number
}

export const DEFAULT_BOUNCE_SETTINGS: OutbreakBounceSettings = {
  bouncedLight: 1,
  bounceStrength: 3,
  bounceRange: 5,
  bounceTexel: 0.5,
  bounceFloor: 0.35,
  bounceWalls: 1.5,
  bounceColour: 1,
}

const G = "Bounced light"

export const bounceControls: readonly LabControl[] = [
  {
    key: "bouncedLight",
    label: "Bounced light",
    group: G,
    type: "select",
    options: [
      { value: 0, label: "Today (off)" },
      { value: 1, label: "Bounced light" },
    ],
  },
  { key: "bounceStrength", label: "Strength", group: G, min: 0, max: 8, step: 0.05, unit: "×" },
  { key: "bounceRange", label: "Range", group: G, min: 1, max: 12, step: 0.25, unit: "m" },
  {
    key: "bounceTexel",
    label: "Resolution",
    group: G,
    type: "select",
    options: [
      { value: 0.25, label: "Fine (0.25 m)" },
      { value: 0.5, label: "Default (0.5 m)" },
      { value: 1, label: "Coarse (1 m)" },
    ],
  },
  { key: "bounceFloor", label: "Floor reflectance", group: G, min: 0, max: 1, step: 0.01, unit: "" },
  { key: "bounceWalls", label: "Wall bounce", group: G, min: 0, max: 4, step: 0.05, unit: "×" },
  { key: "bounceColour", label: "Bounce gives colour", group: G, min: 0, max: 3, step: 0.05, unit: "×" },
]

/** The kit input for this frame, or null when bounced light is off. */
export function bounceInput(s: OutbreakBounceSettings, centerX: number, centerZ: number): PlanBounceInput | null {
  if (s.bouncedLight < 0.5 || !(s.bounceStrength > 0)) return null
  return {
    centerX,
    centerZ,
    strength: s.bounceStrength,
    range: s.bounceRange,
    texel: s.bounceTexel,
    albedo: s.bounceFloor,
    walls: s.bounceWalls,
    // The scene hook's colour weight (`outbreakGiIrr`).
    params: [s.bounceColour, 0, 0],
  }
}
