import type { QualityScaling, QualityTiers } from "@arcade/kit/quality"

export type GetawayQuality = QualityScaling & {
  /** Per-object motion blur (velocity pass and blur); the Lab's motion blur switch still turns it off on any tier. */
  motionBlur: boolean
  /** Ray-marched tyre-smoke and explosion volumes. */
  volumes: boolean
}

/** High is what Getaway drew before tiers (full Retina, every pass), pixel for pixel. */
export const GETAWAY_QUALITY: QualityTiers<GetawayQuality> = {
  high: { tier: "high", label: "High (2×)", dprCap: 2, minScale: 0.7, motionBlur: true, volumes: true },
  balanced: { tier: "balanced", label: "Balanced (1.5×)", dprCap: 1.5, minScale: 0.6, motionBlur: true, volumes: true },
  low: { tier: "low", label: "Low (1×)", dprCap: 1, minScale: 0.5, motionBlur: false, volumes: false },
}
