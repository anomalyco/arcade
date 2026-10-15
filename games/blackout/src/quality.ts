import type { QualityScaling, QualityTiers } from "@arcade/kit/quality"

export type BlackoutQuality = QualityScaling & {
  /** Bloom mip chain depth (1..5). */
  bloomLevels: number
  /** Ray-marched smoke volumes (grenades, fires); the Lab's Volume Smoke switch still turns them off on any tier. */
  volumes: boolean
}

/** Balanced is what Blackout drew before tiers (1.5× cap, everything on); High adds full Retina. */
export const BLACKOUT_QUALITY: QualityTiers<BlackoutQuality> = {
  high: { tier: "high", label: "High (2×)", dprCap: 2, minScale: 0.7, bloomLevels: 5, volumes: true },
  balanced: { tier: "balanced", label: "Balanced (1.5×)", dprCap: 1.5, minScale: 0.6, bloomLevels: 5, volumes: true },
  low: { tier: "low", label: "Low (1×)", dprCap: 1, minScale: 0.5, bloomLevels: 3, volumes: false },
}
