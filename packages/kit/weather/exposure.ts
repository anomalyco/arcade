/** One eye-adaptation state per view, before the renderer's single final exposure.
 *
 * The caller supplies luminance and a fixed reference in the SAME units (cd/m² or explicitly calibrated scene units).
 * Time constants are gameplay defaults, not a model of the minutes-long recovery after strong retinal bleaching.
 * See artifacts/weather-2026-10-22/RESEARCH.md and the woods NIGHT-VISION.md brief.
 */
import type { LabControl } from "../lab-panel"

export type ExposureSettings = {
  mode: "today" | "adapt"
  /** Response to brighter stimulus (s). */
  attack: number
  /** Recovery into darkness (s). */
  recovery: number
  /** Maximum sensitivity loss in stops. */
  lossEV: number
  /** Maximum lift above the authored exposure; zero preserves unlit darkness. */
  liftEV: number
  /** Dose-driven glare recovery (s). */
  glareRecovery: number
  /** Glare strength for the consumer's local bloom/glare, never a white screen overlay. */
  glareStrength: number
}

export const EXPOSURE_DEFAULTS: Readonly<ExposureSettings> = {
  mode: "today", attack: 0.3, recovery: 3, lossEV: 2, liftEV: 0, glareRecovery: 0.8, glareStrength: 0.3,
}

export type ExposureInput = {
  /** Elapsed simulation seconds; pauses use zero, cuts call reset(). */
  dt: number
  /** Broad view-weighted luminance, excluding HUD, in the same units as referenceLuminance. */
  luminance: number
  /** Fixed luminance at which the game's authored exposure is correct; must be positive. */
  referenceLuminance: number
  /** Direct-source glare stimulus in 0..1, weighted by visible solid angle. Duration determines dose. */
  glare?: number
}

export type ExposureFrame = {
  /** Multiply the authored scene exposure by this exactly once, after sky/cloud composition. */
  multiplier: number
  /** Positive = less sensitivity. */
  adaptationEV: number
  /** Bounded local glare strength; the adapter decides where the source's glare lands. */
  glare: number
}

const finite = (n: number, fallback: number) => Number.isFinite(n) ? n : fallback
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))
const response = (dt: number, tau: number) => -Math.expm1(-dt / Math.max(0.001, finite(tau, 1)))

export class EyeAdaptation {
  private ev = 0
  private dose = 0

  reset() { this.ev = 0; this.dose = 0 }

  step(input: ExposureInput, settings: Readonly<ExposureSettings>): ExposureFrame {
    if (settings.mode === "today") {
      this.reset()
      return { multiplier: 1, adaptationEV: 0, glare: 0 }
    }
    const dt = Math.max(0, finite(input.dt, 0))
    const reference = Math.max(1e-9, finite(input.referenceLuminance, 1))
    const luminance = Math.max(1e-9, finite(input.luminance, reference))
    const loss = clamp(finite(settings.lossEV, 2), 0, 8), lift = clamp(finite(settings.liftEV, 0), 0, 4)
    const target = clamp(Math.log2(luminance / reference), -lift, loss)
    this.ev += (target - this.ev) * response(dt, target > this.ev ? settings.attack : settings.recovery)
    this.ev = clamp(this.ev, -lift, loss)
    const glare = clamp(finite(input.glare ?? 0, 0), 0, 1)
    // Integrating a finite stimulus prevents a short glint and a long exposed lamp from delivering the same dose.
    this.dose += (glare - this.dose) * response(dt, glare > this.dose ? 0.08 : settings.glareRecovery)
    return { multiplier: 2 ** -this.ev, adaptationEV: this.ev, glare: this.dose * clamp(finite(settings.glareStrength, 0), 0, 1) }
  }
}

export function exposureControls(group = "Sky", prefix = "exposure."): LabControl[] {
  const range = (field: keyof ExposureSettings, label: string, min: number, max: number, step: number, unit: string): LabControl =>
    ({ key: prefix + field, field, label, group, subsection: "Eye adaptation", min, max, step, unit })
  return [
    { key: prefix + "mode", field: "mode", label: "Eye adaptation", group, subsection: "Eye adaptation", type: "select",
      options: [{ value: "today", label: "Today" }, { value: "adapt", label: "Adapt" }] },
    range("attack", "Bright response", 0.03, 2, 0.01, "s"),
    range("recovery", "Dark recovery", 0.2, 10, 0.1, "s"),
    range("lossEV", "Maximum darkening", 0, 4, 0.1, "EV"),
    range("liftEV", "Maximum lift", 0, 2, 0.1, "EV"),
    range("glareRecovery", "Glare recovery", 0.1, 3, 0.05, "s"),
    range("glareStrength", "Glare", 0, 1, 0.05, "×"),
  ]
}
