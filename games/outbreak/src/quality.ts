import { AdaptiveQualityController, QUALITY_PROFILES, type QualityProfile, type QualityTiers } from "@arcade/kit/quality"

/**
 * Outbreak's quality tiers: the kit's resolution and pass budgets (`QUALITY_PROFILES`) plus the night looks Auto scales
 * (D-47–D-52). High is Kit's picks as shipped; Balanced is the measured cut (mist at a quarter of the screen, contact
 * shadows from one light in 8 steps: −1.9 ms at the crossroads on the Mac mini, and looks the same); Low turns the
 * mist and contact shadows off, coarsens bounced light and gives bodies one shadow-casting light. Lens street lamps
 * and lit rooms are the same on every tier (rooms are free; lamps cost 0.1–0.65 ms and set where light falls).
 *
 * The Lab stays the authority: each of these settings has a "Quality tier" value (`QUALITY_TIER`, -1, the default),
 * and only then does the tier fill it in (like `look.tableLamps`); any explicit Lab value wins.
 */
export interface OutbreakQualityProfile extends QualityProfile {
  /** Low mist on (`mist.mistStyle` on "Quality tier"). */
  readonly mist: boolean
  /** The mist's fog slot resolution, 1/n of the screen per axis (`mist.mistDownscale`). */
  readonly mistDownscale: number
  /** Screen-space contact shadows on (`contactShadows.contactShadowStyle`). */
  readonly contactShadows: boolean
  /** Lights each pixel marches towards (`contactShadows.csLights`). */
  readonly contactShadowLights: number
  /** Steps per light (`contactShadows.csSteps`). */
  readonly contactShadowSteps: number
  /** Bounced light grid, metres per texel (`bounce.bounceTexel`). */
  readonly bounceTexel: number
  /** Lights per body that cast a soft character shadow (`softShadows.softShadowLights`). */
  readonly softShadowLights: number
}

/** The setting value that means "use the quality tier's". */
export const QUALITY_TIER = -1

/** A Lab value, or the tier's when it is left on "Quality tier". */
export const fromTier = (value: number, tier: number): number => (value < 0 ? tier : value)

export const OUTBREAK_QUALITY_PROFILES: QualityTiers<OutbreakQualityProfile> = {
  high: {
    ...QUALITY_PROFILES.high,
    // Shed a little resolution, then step to Balanced (whose cheaper looks cost less than more lost pixels).
    minScale: 0.85,
    mist: true,
    mistDownscale: 3,
    contactShadows: true,
    contactShadowLights: 2,
    contactShadowSteps: 12,
    bounceTexel: 0.5,
    softShadowLights: 3,
  },
  balanced: {
    ...QUALITY_PROFILES.balanced,
    mist: true,
    mistDownscale: 4,
    contactShadows: true,
    contactShadowLights: 1,
    contactShadowSteps: 8,
    bounceTexel: 0.5,
    softShadowLights: 3,
  },
  low: {
    ...QUALITY_PROFILES.low,
    mist: false,
    mistDownscale: 4,
    contactShadows: false,
    contactShadowLights: 1,
    contactShadowSteps: 8,
    bounceTexel: 1,
    softShadowLights: 1,
  },
}

export type OutbreakQualityController = AdaptiveQualityController<OutbreakQualityProfile>
