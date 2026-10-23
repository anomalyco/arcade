/**
 * Measured human skin albedo, for people built from photo textures (`scripts/people/build-rocketbox.ts`): a photo's
 * skin carries the colour of its capture light, and under a warm torch a red-orange photo face reads hot. Moving its
 * median onto the measured curve at the same lightness keeps the person's own complexion and every pore, but with a
 * real skin's hue.
 */
import { checkAlbedo, luminance, type Rgb } from "../gpu/materials/wear"

/**
 * Linear albedo of Fitzpatrick skin types I (lightest) to VI, from physicallybased.info (Palmqvist, after Jacques'
 * "Optical properties of biological tissues" review, Donner & Jensen's layered skin model and spectraldb.com
 * measurements). `ALBEDO_RANGES.skin` spans their luminance.
 */
export const SKIN_TONES: readonly Rgb[] = [
  [0.847, 0.638, 0.552],
  [0.799, 0.485, 0.347],
  [0.623, 0.433, 0.343],
  [0.436, 0.227, 0.131],
  [0.283, 0.148, 0.079],
  [0.09, 0.05, 0.02],
]

/** Red over green of the measured tones: how warm real skin gets (1.33 for type I to 1.92 for type IV). */
export const SKIN_RED_GREEN = { min: 1.3, max: 1.95 } as const

/**
 * A measured skin's hue at `rgb`'s own luminance. The skin type comes from `typeLuminance` (default `rgb`'s): the
 * measured tone at that lightness, interpolated between types and clamped to the measured range, then scaled to keep
 * `rgb`'s luminance so a photo's lighting and contrast survive.
 */
export function skinTone(rgb: Rgb, typeLuminance = luminance(rgb)): Rgb {
  const l = typeLuminance, ls = SKIN_TONES.map(luminance)
  let tone = SKIN_TONES[SKIN_TONES.length - 1]!
  if (l >= ls[0]!) tone = SKIN_TONES[0]!
  else {
    for (let i = 1; i < SKIN_TONES.length; i++) {
      if (l < ls[i]!) continue
      const t = (l - ls[i]!) / (ls[i - 1]! - ls[i]!), a = SKIN_TONES[i]!, b = SKIN_TONES[i - 1]!
      tone = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
      break
    }
  }
  const k = luminance(rgb) / luminance(tone)
  return [tone[0] * k, tone[1] * k, tone[2] * k]
}

/** Whether a linear skin albedo is a real skin's: inside `ALBEDO_RANGES.skin` and no redder than measured skin. */
export function checkSkin(rgb: Rgb): { ok: boolean; luminance: number; redGreen: number } {
  const redGreen = rgb[0] / Math.max(rgb[1], 1e-6), c = checkAlbedo(rgb, "skin")
  return { ok: c.ok && redGreen >= SKIN_RED_GREEN.min && redGreen <= SKIN_RED_GREEN.max, luminance: c.luminance, redGreen }
}
