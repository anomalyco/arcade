import type { LabControl } from "@arcade/kit/lab-panel"

/**
 * Reflections (Look › Reflections): lights mirrored in puddles and wet paving, and the mirrors in the houses. They live
 * in the look trims, so look presets carry them; `reflections` 0 is Today (none of it).
 */
export type ReflectionTrims = {
  /** 0 Today (no reflections), 1 reflections on. */
  reflections: number
  /** × how bright lamps, windows, fire and police lights read in standing water and wet paving (0 off). */
  wetReflections: number
  /** Standing water in the street potholes, wet or dry weather (1 on). */
  puddleReflections: number
  /** Lab wetness 0..1 for the ground when the weather is dry; rain sets its own and the larger wins. */
  reflectWetness: number
  /** 0 no mirrors, 1 the start house's mirror only, 2 that and a rare (sometimes cracked) mirror in other houses. */
  mirrors: number
  /** What a mirror shows: 0 the baked room light only, 1 plus the flashlight, 2 plus the people standing in front of it. */
  mirrorDetail: number
  /** Foxing, worn silvering at the edges and grime on the glass (0 new glass). */
  mirrorAge: number
}

export const DEFAULT_REFLECTION_TRIMS: ReflectionTrims = {
  reflections: 1,
  wetReflections: 1,
  puddleReflections: 1,
  reflectWetness: 0,
  mirrors: 2,
  mirrorDetail: 2,
  mirrorAge: 1,
}

/** Today: the look before reflections. */
export const TODAY_REFLECTIONS: Pick<ReflectionTrims, "reflections"> = { reflections: 0 }

const GROUP = "Look · Reflections"

export const reflectionControls: LabControl[] = [
  { key: "reflections", label: "Reflections", group: GROUP, type: "select", options: [{ value: 0, label: "Today" }, { value: 1, label: "Reflections" }] },
  { key: "wetReflections", label: "Wet reflection strength", group: GROUP, min: 0, max: 2, step: 0.05, unit: "×" },
  { key: "puddleReflections", label: "Puddle reflections (street potholes)", group: GROUP, type: "toggle" },
  { key: "reflectWetness", label: "Wet ground when dry (rain sets its own)", group: GROUP, min: 0, max: 1, step: 0.05, unit: "" },
  {
    key: "mirrors",
    label: "Mirrors",
    group: GROUP,
    type: "select",
    options: [
      { value: 0, label: "Off" },
      { value: 1, label: "Start house" },
      { value: 2, label: "Start house + rare in others" },
    ],
  },
  {
    key: "mirrorDetail",
    label: "Mirror detail",
    group: GROUP,
    type: "select",
    options: [
      { value: 0, label: "Baked room light" },
      { value: 1, label: "+ flashlight" },
      { value: 2, label: "+ people in front" },
    ],
  },
  { key: "mirrorAge", label: "Mirror age (foxing, worn silver)", group: GROUP, min: 0, max: 1.5, step: 0.05, unit: "" },
]

/** Floats packed by `packReflectionUniforms`: `refl` then `mirror` (two vec4f). */
export const REFLECTION_UNIFORM_FLOATS = 8

/**
 * refl: wet strength (0 off), pothole puddles on, Lab wetness, rain ripple; mirror: detail, age, on, reserved.
 * `ripple` is the weather's raindrop ripple intensity (0 when dry).
 */
export function packReflectionUniforms(t: Partial<ReflectionTrims> | undefined, ripple: number, out: Float32Array, offset: number): void {
  const d = DEFAULT_REFLECTION_TRIMS
  const on = (t?.reflections ?? d.reflections) > 0.5
  out[offset] = on ? Math.max(0, t?.wetReflections ?? d.wetReflections) : 0
  out[offset + 1] = on && (t?.puddleReflections ?? d.puddleReflections) > 0.5 ? 1 : 0
  out[offset + 2] = on ? Math.min(1, Math.max(0, t?.reflectWetness ?? d.reflectWetness)) : 0
  out[offset + 3] = on ? Math.min(1, Math.max(0, ripple)) : 0
  out[offset + 4] = Math.round(t?.mirrorDetail ?? d.mirrorDetail)
  out[offset + 5] = Math.max(0, t?.mirrorAge ?? d.mirrorAge)
  out[offset + 6] = on && (t?.mirrors ?? d.mirrors) > 0 ? 1 : 0
  out[offset + 7] = 0
}

/** Whether mirrors are drawn this frame, and which: 0 none, 1 the start house's, 2 every house's. */
export function mirrorsShown(t: Partial<ReflectionTrims> | undefined): number {
  const d = DEFAULT_REFLECTION_TRIMS
  if ((t?.reflections ?? d.reflections) < 0.5) return 0
  return Math.round(t?.mirrors ?? d.mirrors)
}
