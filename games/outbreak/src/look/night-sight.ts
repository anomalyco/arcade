import type { OutbreakLookTrims } from "./world"

type NightSightTrims = Partial<Pick<OutbreakLookTrims, "nightSight" | "nightSightRadius" | "nightSightFalloff">>

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/**
 * How strongly night sight falls off this frame (0 none, 1 full): the `nightSight` trim, faded in with darkness the
 * same way the light-colour rule is (`lightRuleWeight`), and off while the survivor carries a light (`lit` 0..1: the
 * flashlight's output or headlights).
 */
export function nightSightTarget(t: NightSightTrims | undefined, darkness: number, lit: number): number {
  const x = clamp((darkness - 0.2) / 0.6, 0, 1)
  const night = x * x * (3 - 2 * x)
  return clamp(t?.nightSight ?? 0, 0, 1) * night * (1 - clamp(lit, 0, 1))
}

/** Eases the weight toward its target (about a third of a second), so a flickering battery doesn't strobe sight. */
export function easeNightSight(current: number, target: number, dt: number): number {
  if (!(dt > 0)) return target
  return current + (target - current) * (1 - Math.exp(-dt / 0.3))
}

/** Metres where night sight is fully dark (radius plus fade). */
export function nightSightReach(t: NightSightTrims | undefined): number {
  return Math.max(0.5, t?.nightSightRadius ?? 4.5) + Math.max(0.5, t?.nightSightFalloff ?? 5)
}

/**
 * The sight range the client's vision uses: shrinks from `range` toward the dark edge of night sight with the weight,
 * so zombies past it stay hidden like anything else out of sight. Presentation only; the sim never reads it.
 */
export function nightSightRange(range: number, t: NightSightTrims | undefined, weight: number): number {
  const w = clamp(weight, 0, 1)
  if (w <= 0) return range
  return range + (Math.min(range, nightSightReach(t) + 1) - range) * w
}
