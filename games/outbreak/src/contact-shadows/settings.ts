import type { VolumeInput } from "@arcade/kit/gpu/renderer"
import type { LabControl } from "@arcade/kit/lab-panel"
import { fromTier, QUALITY_TIER, type OutbreakQualityProfile } from "../quality"

/**
 * Contact shadows on props (Lab › Look · Contact shadows; Kit's pick, D-52: on at the High and Balanced quality tiers (`quality.ts`), `contactShadowStyle` 0 is Today): the Lot's screen-space contact
 * shadows (#356/#374, `@arcade/kit/gpu/contact-shadows`) as a depth-only volume slot. Each pixel marches a short ray
 * towards the one or two Outbreak lights that light it most (the torch's plan cone, lamps, sconces, fire;
 * `contact-shadows/wgsl.ts`), so furniture, cars, bins and debris sit on the floor where the flashlight and the lamps
 * hit them. Each light darkens only its own share of the pixel's light, so unlit ground stays as dark as it was.
 * The history is kept while the view moves (#374), clipped to the current neighbourhood.
 */
export type OutbreakContactShadowSettings = {
  /** -1 the quality tier's (default: on at High and Balanced, off at Low), 0 Today, 1 screen-space contact shadows. */
  contactShadowStyle: number
  /** March length towards the light, metres. */
  csLength: number
  /** How much of a blocked light is removed. */
  csStrength: number
  /** Blockers thinner than this behind the depth buffer count, metres. */
  csThickness: number
  /** Steps per light (-1 the quality tier's). */
  csSteps: number
  /** Lights marched per pixel (1 or 2; -1 the quality tier's). */
  csLights: number
  /** Fade out by this view distance, metres. */
  csDistance: number
  /** Half resolution (1) or full (0). */
  csHalfRes: number
  /** Share of each new frame while the view moves (1 drops the history in motion). */
  csHistoryMoving: number
}

export const DEFAULT_CONTACT_SHADOW_SETTINGS: OutbreakContactShadowSettings = {
  contactShadowStyle: QUALITY_TIER,
  csLength: 0.7,
  csStrength: 0.85,
  csThickness: 0.35,
  csSteps: QUALITY_TIER,
  csLights: QUALITY_TIER,
  csDistance: 80,
  csHalfRes: 1,
  csHistoryMoving: 0.25,
}

const G = "Look · Contact shadows"

export const contactShadowControls: readonly LabControl[] = [
  {
    key: "contactShadowStyle",
    label: "Contact shadows",
    group: G,
    type: "select",
    options: [
      { value: QUALITY_TIER, label: "Quality tier" },
      { value: 0, label: "Today" },
      { value: 1, label: "Screen-space contact shadows" },
    ],
  },
  { key: "csLength", label: "Length", group: G, min: 0.05, max: 2, step: 0.01, unit: "m" },
  { key: "csStrength", label: "Strength", group: G, min: 0, max: 1, step: 0.01, unit: "" },
  { key: "csThickness", label: "Blocker thickness", group: G, min: 0.02, max: 1.5, step: 0.01, unit: "m" },
  { key: "csSteps", label: "Steps", group: G, type: "select", options: [{ value: QUALITY_TIER, label: "Quality tier" }, ...[4, 6, 8, 12, 16, 24].map((v) => ({ value: v, label: String(v) }))] },
  { key: "csLights", label: "Lights per pixel", group: G, type: "select", options: [{ value: QUALITY_TIER, label: "Quality tier" }, { value: 1, label: "1" }, { value: 2, label: "2" }] },
  { key: "csDistance", label: "Fade distance", group: G, min: 10, max: 150, step: 1, unit: "m" },
  { key: "csHalfRes", label: "Half resolution", group: G, type: "select", options: [{ value: 1, label: "Half" }, { value: 0, label: "Full" }] },
  { key: "csHistoryMoving", label: "History weight in motion", group: G, min: 0.05, max: 1, step: 0.01, unit: "" },
]

/** The settings with "Quality tier" values filled in from the active tier, into `out`. */
export function resolveContactShadows(
  s: OutbreakContactShadowSettings,
  q: Pick<OutbreakQualityProfile, "contactShadows" | "contactShadowLights" | "contactShadowSteps">,
  out: OutbreakContactShadowSettings,
): OutbreakContactShadowSettings {
  Object.assign(out, s)
  out.contactShadowStyle = fromTier(s.contactShadowStyle, q.contactShadows ? 1 : 0)
  out.csLights = fromTier(s.csLights, q.contactShadowLights)
  out.csSteps = fromTier(s.csSteps, q.contactShadowSteps)
  return out
}

/** Volume input for the contact slot (null: Today, no pass and no compile), knobs in its params. */
export function contactVolumeInput(s: OutbreakContactShadowSettings, params: Float32Array): VolumeInput | null {
  if (s.contactShadowStyle < 0.5) return null
  params.set([s.csLength, s.csThickness, s.csStrength, s.csDistance, Math.round(s.csSteps), s.csLights > 1.5 ? 2 : 1, 0, 0], 0)
  return { downscale: s.csHalfRes > 0.5 ? 2 : 1, history: 0.25, moving: s.csHistoryMoving, params }
}
