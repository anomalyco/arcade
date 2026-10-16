import { DEFAULT_SOFT_BEAN, type SoftBeanShape } from "@arcade/kit/avatar/simple-figure"
import type { LabControl } from "@arcade/kit/lab-panel"

/**
 * The survivor's presentation style. Today's box figure stays the default; the simple styles are single-tone figures
 * from `@arcade/kit/avatar/simple-figure` with a flat matte surface and a tight grazing rim, so the hero reads by
 * silhouette and motion against the detailed world (docs/rendering-techniques.md §7, the Big Walk / Playdead rule).
 * Soft Bean (the hero concept's design 1) is a round toy in one matte colour per player, lit with soft wrap and a
 * sheen toward its edges so lamps and the flashlight model its roundness. Every survivor drawn on this client (co-op
 * teammates included) uses the same style.
 */
export const HERO_STYLES = [
  { id: "today", label: "Today (jacket & jeans)" },
  { id: "mannequin", label: "Matte mannequin" },
  { id: "silhouette", label: "Flat-tone silhouette" },
  { id: "capsule", label: "Capsule figure" },
  { id: "bean", label: "Soft Bean" },
] as const

export const SOFT_BEAN_STYLE = 4

/** `aux` on simple-figure vertices: Outbreak's actor shading gives them the hero surface. */
export const HERO_AUX = 5
/** `aux` on Soft Bean's vertices: wrap lighting, sheen and its own colour in the dark (`look/shader.ts`). */
export const BEAN_AUX = 6

type HeroSurface = {
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

/** Soft Bean's shape, colours and surface. Hues are degrees on the colour wheel, one per co-op seat. */
export type SoftBeanSettings = {
  beanHead: number
  beanBody: number
  beanLimb: number
  beanRound: number
  /** 1 draws two dot eyes, 0 no face. */
  beanFace: number
  beanHue: number
  beanHue2: number
  beanHue3: number
  beanHue4: number
  beanSaturation: number
  beanLightness: number
  /** How far light wraps past the terminator (0 hard, 1 half-lambert-soft). */
  beanWrap: number
  /** Brightening toward the silhouette in the light's colour, like matte vinyl or clay. */
  beanSheen: number
  /** Sheen exponent: higher hugs the edge. */
  beanSheenTight: number
  /** How much of the player colour survives where no light falls, through the night grade (0 grey, 1 full). */
  beanOwnColour: number
}

export type HeroLookSettings = { heroStyle: number } & HeroSurface & SoftBeanSettings

/**
 * Seat hues follow the co-op name tags (amber, blue, red, green). Own colour 0.45: enough that teammates stay apart in
 * an unlit room, while the beam and lamps still make the figure clearly more colourful than the dark around it.
 */
export const DEFAULT_SOFT_BEAN_LOOK: SoftBeanSettings = {
  beanHead: DEFAULT_SOFT_BEAN.head,
  beanBody: DEFAULT_SOFT_BEAN.body,
  beanLimb: DEFAULT_SOFT_BEAN.limb,
  beanRound: DEFAULT_SOFT_BEAN.round,
  beanFace: 1,
  beanHue: 40,
  beanHue2: 212,
  beanHue3: 4,
  beanHue4: 128,
  beanSaturation: 0.72,
  beanLightness: 0.52,
  beanWrap: 0.6,
  beanSheen: 0.8,
  beanSheenTight: 3,
  beanOwnColour: 0.45,
}

/** Each simple style's own surface; choosing a style in the Lab loads these, then the knobs tune them. */
export const HERO_STYLE_SURFACES: readonly HeroSurface[] = [
  { heroTone: 0.42, heroWarmth: 0.25, heroRim: 1, heroRimTight: 4, heroFlat: 0.3, heroSaturation: 0.5 },
  { heroTone: 0.42, heroWarmth: 0.25, heroRim: 1, heroRimTight: 4, heroFlat: 0.3, heroSaturation: 0.5 },
  { heroTone: 0.016, heroWarmth: 0, heroRim: 1.8, heroRimTight: 3, heroFlat: 0.85, heroSaturation: 0.2 },
  { heroTone: 0.5, heroWarmth: -0.15, heroRim: 0.8, heroRimTight: 5, heroFlat: 0.15, heroSaturation: 0.8 },
  // Soft Bean ignores these (its own knobs below); kept so every style loads a full surface.
  { heroTone: 0.5, heroWarmth: -0.15, heroRim: 0.8, heroRimTight: 5, heroFlat: 0.15, heroSaturation: 0.8 },
]

export const DEFAULT_HERO_LOOK: HeroLookSettings = { heroStyle: 0, ...HERO_STYLE_SURFACES[0]!, ...DEFAULT_SOFT_BEAN_LOOK }

/** Which simple-figure shape a style draws (0: today's boxes, 3: Soft Bean). */
export function heroShape(style: number): 0 | 1 | 2 | 3 {
  const s = Math.round(style)
  return s === 1 || s === 2 ? 1 : s === 3 ? 2 : s === SOFT_BEAN_STYLE ? 3 : 0
}

export function softBeanShape(look: SoftBeanSettings): SoftBeanShape {
  return { head: look.beanHead, body: look.beanBody, limb: look.beanLimb, round: look.beanRound, face: look.beanFace >= 0.5 }
}

const GROUP = "Look · Hero"
const isBean = (s: Readonly<Record<string, unknown>>) => Math.round(Number(s.heroStyle)) === SOFT_BEAN_STYLE
const isSimple = (s: Readonly<Record<string, unknown>>) => !isBean(s)
const bean = (control: LabControl): LabControl => ({ ...control, group: GROUP, visible: isBean })
const simple = (control: LabControl): LabControl => ({ ...control, group: GROUP, visible: isSimple })

export const heroLookControls: LabControl[] = [
  { key: "heroStyle", label: "Survivor style", group: GROUP, options: HERO_STYLES.map((s, value) => ({ label: s.label, value })) },
  simple({ key: "heroTone", label: "Tone", min: 0, max: 0.8, step: 0.005, unit: "" }),
  simple({ key: "heroWarmth", label: "Tone warmth", min: -1, max: 1, step: 0.05, unit: "" }),
  simple({ key: "heroRim", label: "Grazing rim", min: 0, max: 3, step: 0.05, unit: "×" }),
  simple({ key: "heroRimTight", label: "Rim tightness", min: 1, max: 10, step: 0.25, unit: "" }),
  simple({ key: "heroFlat", label: "Flatten shading", min: 0, max: 1, step: 0.05, unit: "" }),
  simple({ key: "heroSaturation", label: "Colour from light", min: 0, max: 1, step: 0.05, unit: "" }),
  bean({ key: "beanHead", label: "Head size", subsection: "Shape", min: 0.7, max: 1.5, step: 0.01, unit: "×" }),
  bean({ key: "beanBody", label: "Body girth", subsection: "Shape", min: 0.7, max: 1.4, step: 0.01, unit: "×" }),
  bean({ key: "beanLimb", label: "Limb thickness", subsection: "Shape", min: 0.6, max: 1.5, step: 0.01, unit: "×" }),
  bean({ key: "beanRound", label: "Roundness", subsection: "Shape", min: 0, max: 1, step: 0.05, unit: "" }),
  bean({ key: "beanFace", label: "Dot eyes", subsection: "Shape", on: 1, off: 0 }),
  bean({ key: "beanHue", label: "Player 1 hue", subsection: "Colour", min: 0, max: 360, step: 1, unit: "°" }),
  bean({ key: "beanHue2", label: "Player 2 hue", subsection: "Colour", min: 0, max: 360, step: 1, unit: "°" }),
  bean({ key: "beanHue3", label: "Player 3 hue", subsection: "Colour", min: 0, max: 360, step: 1, unit: "°" }),
  bean({ key: "beanHue4", label: "Player 4 hue", subsection: "Colour", min: 0, max: 360, step: 1, unit: "°" }),
  bean({ key: "beanSaturation", label: "Saturation", subsection: "Colour", min: 0, max: 1, step: 0.01, unit: "" }),
  bean({ key: "beanLightness", label: "Lightness", subsection: "Colour", min: 0.1, max: 0.9, step: 0.01, unit: "" }),
  bean({ key: "beanOwnColour", label: "Own colour in the dark", subsection: "Colour", min: 0, max: 1, step: 0.05, unit: "" }),
  bean({ key: "beanWrap", label: "Light wrap", subsection: "Surface", min: 0, max: 1, step: 0.05, unit: "" }),
  bean({ key: "beanSheen", label: "Sheen", subsection: "Surface", min: 0, max: 2, step: 0.05, unit: "×" }),
  bean({ key: "beanSheenTight", label: "Sheen tightness", subsection: "Surface", min: 1, max: 8, step: 0.25, unit: "" }),
]

/** Soft Bean's linear albedo for a co-op seat (0 offline and the first seat): HSL in sRGB, then to linear. */
export function beanTint(look: SoftBeanSettings, seat: number): [number, number, number] {
  const hues = [look.beanHue, look.beanHue2, look.beanHue3, look.beanHue4]
  const h = ((((hues[((seat % 4) + 4) % 4] ?? look.beanHue) % 360) + 360) % 360) / 60
  const s = Math.max(0, Math.min(1, look.beanSaturation))
  const l = Math.max(0, Math.min(1, look.beanLightness))
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs((h % 2) - 1))
  const [r, g, b] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x]
  const m = l - c / 2
  return [r + m, g + m, b + m].map(v => Math.max(0, v) ** 2.2) as [number, number, number]
}

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
