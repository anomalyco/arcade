import type { LabControl } from "@arcade/kit/lab-panel"

/**
 * The survivor's presentation style. Today's box figure stays the default; the simple styles are single-tone figures
 * from `@arcade/kit/avatar/simple-figure` with a flat matte surface and a tight grazing rim, so the hero reads by
 * silhouette and motion against the detailed world (docs/rendering-techniques.md §7, the Big Walk / Playdead rule).
 * Every survivor drawn on this client (co-op teammates included) uses the same style.
 */
export const HERO_STYLES = [
  { id: "today", label: "Today (jacket & jeans)" },
  { id: "mannequin", label: "Matte mannequin" },
  { id: "silhouette", label: "Flat-tone silhouette" },
  { id: "capsule", label: "Capsule figure" },
] as const

/** `aux` on simple-figure vertices: Outbreak's actor shading gives them the hero surface. */
export const HERO_AUX = 5

export type HeroLookSettings = {
  heroStyle: number
  /** Linear albedo of the single tone (0 black, 1 white). */
  heroTone: number
  /** −1 cool grey-blue … 1 warm putty. */
  heroWarmth: number
  /** Strength of the tight grazing rim. */
  heroRim: number
  /** Rim exponent: higher is a thinner line on the silhouette edge. */
  heroRimTight: number
  /** 0 keeps the lighting's full form shading, 1 compresses it toward one flat tone. */
  heroFlat: number
  /** Colour the hero keeps from the light that falls on it (0 grey, 1 full). */
  heroSaturation: number
}

type HeroSurface = Omit<HeroLookSettings, "heroStyle">

/** Each simple style's own surface; choosing a style in the Lab loads these, then the knobs tune them. */
export const HERO_STYLE_SURFACES: readonly HeroSurface[] = [
  { heroTone: 0.42, heroWarmth: 0.25, heroRim: 1, heroRimTight: 4, heroFlat: 0.3, heroSaturation: 0.5 },
  { heroTone: 0.42, heroWarmth: 0.25, heroRim: 1, heroRimTight: 4, heroFlat: 0.3, heroSaturation: 0.5 },
  { heroTone: 0.016, heroWarmth: 0, heroRim: 1.8, heroRimTight: 3, heroFlat: 0.85, heroSaturation: 0.2 },
  { heroTone: 0.5, heroWarmth: -0.15, heroRim: 0.8, heroRimTight: 5, heroFlat: 0.15, heroSaturation: 0.8 },
]

export const DEFAULT_HERO_LOOK: HeroLookSettings = { heroStyle: 0, ...HERO_STYLE_SURFACES[0]! }

/** Which simple-figure shape a style draws (0: today's boxes). */
export function heroShape(style: number): 0 | 1 | 2 {
  const s = Math.round(style)
  return s === 1 || s === 2 ? 1 : s === 3 ? 2 : 0
}

const GROUP = "Look · Hero"

export const heroLookControls: LabControl[] = [
  { key: "heroStyle", label: "Survivor style", group: GROUP, options: HERO_STYLES.map((s, value) => ({ label: s.label, value })) },
  { key: "heroTone", label: "Tone", group: GROUP, min: 0, max: 0.8, step: 0.005, unit: "" },
  { key: "heroWarmth", label: "Tone warmth", group: GROUP, min: -1, max: 1, step: 0.05, unit: "" },
  { key: "heroRim", label: "Grazing rim", group: GROUP, min: 0, max: 3, step: 0.05, unit: "×" },
  { key: "heroRimTight", label: "Rim tightness", group: GROUP, min: 1, max: 10, step: 0.25, unit: "" },
  { key: "heroFlat", label: "Flatten shading", group: GROUP, min: 0, max: 1, step: 0.05, unit: "" },
  { key: "heroSaturation", label: "Colour from light", group: GROUP, min: 0, max: 1, step: 0.05, unit: "" },
]

/**
 * The linear tint for a simple figure: the tone, shifted warm or cool, with a little of a co-op seat's jacket colour so
 * teammates stay distinguishable (`seat` is null offline and for the first seat).
 */
export function heroTint(look: HeroSurface, seat: readonly [number, number, number] | null): [number, number, number] {
  const t = Math.max(0, look.heroTone)
  const w = Math.max(-1, Math.min(1, look.heroWarmth))
  const base: [number, number, number] = [t * (1 + 0.14 * w), t * (1 + 0.02 * w), t * (1 - 0.2 * w)]
  if (!seat) return base
  const seatLum = 0.2126 * seat[0] + 0.7152 * seat[1] + 0.0722 * seat[2] || 1
  return base.map((b, i) => b * (0.7 + 0.3 * (seat[i]! / seatLum))) as [number, number, number]
}
