import type { QualityScaling, QualityTiers } from "@arcade/kit/quality"

/** The Lot's tiers trade resolution only. High is the 1.5× cap the Lot always drew at. */
export const LOT_QUALITY: QualityTiers<QualityScaling> = {
  high: { tier: "high", label: "High (1.5×)", dprCap: 1.5, minScale: 0.75 },
  balanced: { tier: "balanced", label: "Balanced (1.25×)", dprCap: 1.25, minScale: 0.7 },
  low: { tier: "low", label: "Low (1×)", dprCap: 1, minScale: 0.6 },
}
