import { flashlightColor } from "../../shared/flashlight"
import type { DiscoverySettings } from "./settings"

export type BeamLook = {
  /** 0 above the flicker threshold, rising to 1 as the battery empties. */
  low: number
  cone: number
  range: number
  warmth: number
  color: [number, number, number]
}

/** The deep amber a dying tungsten bulb falls to. */
const AMBER: readonly [number, number, number] = [1, 0.42, 0.1]

/**
 * The flashlight's charge, shown in its beam: above the flicker threshold the beam is as tuned; below it the cone
 * narrows, the reach shortens and the colour warms to amber (the sim's output already dims and sputters).
 */
export function lowBatteryBeam(
  fl: { flashlightCone: number; flashlightRange: number; flashlightWarmth: number; flashlightFlicker: number },
  battery: number,
  depleted: boolean,
  s: Pick<DiscoverySettings, "discoveryLowBeam" | "discoveryLowBeamNarrow" | "discoveryLowBeamShorten" | "discoveryLowBeamAmber">,
  out: BeamLook = { low: 0, cone: 0, range: 0, warmth: 0, color: [1, 1, 1] },
): BeamLook {
  const threshold = Math.max(0.01, fl.flashlightFlicker)
  const low = !s.discoveryLowBeam || depleted ? 0 : 1 - Math.max(0, Math.min(1, battery / threshold))
  // Ease in so the first few percent below the threshold only hint at it.
  const k = low * low * (3 - 2 * low)
  out.low = low
  out.cone = fl.flashlightCone * (1 - s.discoveryLowBeamNarrow * k)
  out.range = fl.flashlightRange * (1 - s.discoveryLowBeamShorten * k)
  out.warmth = fl.flashlightWarmth + (1 - fl.flashlightWarmth) * k
  const base = flashlightColor(out.warmth)
  // The colour turns early: a warm beam is the first sign, before it visibly narrows.
  const a = s.discoveryLowBeamAmber * Math.min(1, low * 1.6)
  out.color[0] = base[0] + (AMBER[0] - base[0]) * a
  out.color[1] = base[1] + (AMBER[1] - base[1]) * a
  out.color[2] = base[2] + (AMBER[2] - base[2]) * a
  return out
}
