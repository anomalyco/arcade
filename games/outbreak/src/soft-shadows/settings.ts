import { CAPSULE_CHARACTER_LIGHTS, CAPSULE_SHADOW_DEFAULTS, type CapsuleShadowSettings } from "@arcade/kit/gpu/shadows/capsule-shadows"
import type { LabControl } from "@arcade/kit/lab-panel"

/**
 * Soft character shadows (AR-113, Lab: Backquote › Look · Character shadows): survivors, zombies, the downed and the
 * dead cast analytic capsule shadows from their rig bones (`@arcade/kit/gpu/shadows/capsule-shadows`): a contact
 * shadow under them and a soft shadow away from each strong light nearby (lamps, torches, fire) and from the sun or
 * moon. `softShadowMode` 0 is
 * Today: the streetlamp blob and boot AO under the survivor and the two nearest zombies, and hard round casters in the
 * flashlight.
 */
export type OutbreakSoftShadowSettings = {
  /** 0 Today, 1 soft capsule shadows. */
  softShadowMode: number
  /** × contact shadow under and around bodies. */
  softShadowContact: number
  /** × shadow away from each light. */
  softShadowStrength: number
  /** × each light's fixture size for the penumbra (larger is softer). */
  softShadowLightSize: number
  /** Softest edge floor: the smallest angular radius a light counts as, radians. */
  softShadowMinAngle: number
  /** Longest shadow, metres (fades over its last 40%). */
  softShadowReach: number
  /** Lights per body, strongest first. */
  softShadowLights: number
  /** Weakest light (estimated at the body) that still casts. */
  softShadowMinLight: number
  /** × shadow away from the sun or moon. */
  softShadowSun: number
  /** Sun and moon penumbra, radians (angular radius). */
  softShadowSunAngle: number
}

const K = CAPSULE_SHADOW_DEFAULTS

export const DEFAULT_SOFT_SHADOW_SETTINGS: OutbreakSoftShadowSettings = {
  softShadowMode: 0,
  softShadowContact: K.contact,
  softShadowStrength: K.shadow,
  softShadowLightSize: K.lightSize,
  softShadowMinAngle: K.minAngle,
  softShadowReach: K.reach,
  softShadowLights: K.lights,
  softShadowMinLight: K.minLight,
  softShadowSun: K.sun,
  softShadowSunAngle: K.sunAngle,
}

const GROUP = "Look · Character shadows"

export const softShadowControls: LabControl[] = [
  {
    key: "softShadowMode",
    label: "Character shadows",
    group: GROUP,
    type: "select",
    options: [
      { value: 0, label: "Today (lamp blob + boot AO)" },
      { value: 1, label: "Soft capsule shadows" },
    ],
  },
  { key: "softShadowContact", label: "Contact shadow under bodies", group: GROUP, min: 0, max: 2, step: 0.05, unit: "×" },
  { key: "softShadowStrength", label: "Shadow from each light", group: GROUP, min: 0, max: 1, step: 0.05, unit: "×" },
  { key: "softShadowLightSize", label: "Light size (penumbra)", group: GROUP, min: 0.25, max: 8, step: 0.05, unit: "× fixture" },
  { key: "softShadowMinAngle", label: "Softest edge floor", group: GROUP, min: 0, max: 0.2, step: 0.005, unit: "rad" },
  { key: "softShadowReach", label: "Longest shadow", group: GROUP, min: 1, max: 12, step: 0.25, unit: "m" },
  { key: "softShadowLights", label: "Lights per body", group: GROUP, min: 1, max: CAPSULE_CHARACTER_LIGHTS, step: 1 },
  { key: "softShadowMinLight", label: "Weakest light that casts", group: GROUP, min: 0, max: 1, step: 0.01, unit: "" },
  { key: "softShadowSun", label: "Shadow from the sun and moon", group: GROUP, min: 0, max: 1, step: 0.05, unit: "×" },
  { key: "softShadowSunAngle", label: "Sun and moon softness", group: GROUP, min: 0.005, max: 0.3, step: 0.005, unit: "rad" },
]

/** True when soft capsule shadows replace Today's. */
export const softShadowsOn = (s: Pick<OutbreakSoftShadowSettings, "softShadowMode"> | undefined): boolean => (s?.softShadowMode ?? 0) > 0.5

/** The kit's settings from Outbreak's. */
export function capsuleSettings(s: OutbreakSoftShadowSettings): CapsuleShadowSettings {
  return {
    mode: s.softShadowMode,
    contact: s.softShadowContact,
    shadow: s.softShadowStrength,
    lightSize: s.softShadowLightSize,
    minAngle: s.softShadowMinAngle,
    reach: s.softShadowReach,
    lights: s.softShadowLights,
    minLight: s.softShadowMinLight,
    sun: s.softShadowSun,
    sunAngle: s.softShadowSunAngle,
  }
}
