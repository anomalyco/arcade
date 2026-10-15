import type { QualityScaling, QualityTiers } from "@arcade/kit/quality"

export type CarrierQuality = QualityScaling & {
  /** Bloom mip chain depth (1..5). */
  bloomLevels: number
}

/** Balanced is what Carrier drew before tiers (1.5× cap, full bloom); High adds full Retina. */
export const CARRIER_QUALITY: QualityTiers<CarrierQuality> = {
  high: { tier: "high", label: "High (2×)", dprCap: 2, minScale: 0.7, bloomLevels: 5 },
  balanced: { tier: "balanced", label: "Balanced (1.5×)", dprCap: 1.5, minScale: 0.6, bloomLevels: 5 },
  low: { tier: "low", label: "Low (1×)", dprCap: 1, minScale: 0.5, bloomLevels: 3 },
}
