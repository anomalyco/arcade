import { QUALITY_PROFILES, type QualityScaling, type QualityTiers } from "@arcade/kit/quality"

/**
 * The office look's tiers. High keeps Today's 1.5× pixel cap; Balanced and Low trade pixels and the look's own passes
 * (bounce grid, dusty shafts, contact shading). The tier sizes the canvas with the look on or off (Today draws no look passes).
 * The player picks the mode in the game shell's Settings (`createShellQuality` in main.ts, saved per browser).
 */
export interface LookQuality extends QualityScaling {
  /** Bounced light grid, metres per texel (0 off). */
  readonly bounceTexel: number
  /** Dusty shafts' march resolution, 1/n of the screen per axis (0 off). */
  readonly shaftDownscale: number
  readonly shaftSteps: number
  /** Contact shading against the occluder footprints (floor junctions, under desks). */
  readonly contactShading: boolean
}

export const LOOK_QUALITY: QualityTiers<LookQuality> = {
  high: { ...QUALITY_PROFILES.high, label: "High (1.5×)", dprCap: 1.5, minScale: .85, bounceTexel: .25, shaftDownscale: 2, shaftSteps: 14, contactShading: true },
  balanced: { ...QUALITY_PROFILES.balanced, label: "Balanced (1.25×)", dprCap: 1.25, minScale: .75, bounceTexel: .5, shaftDownscale: 4, shaftSteps: 10, contactShading: true },
  low: { ...QUALITY_PROFILES.low, label: "Low (1.0×)", dprCap: 1, minScale: .6, bounceTexel: .5, shaftDownscale: 0, shaftSteps: 0, contactShading: false },
}
