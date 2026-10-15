export type StyleId =
  | "tiny-pixel"
  | "one-bit"
  | "comic-cel"
  | "papercraft"
  | "ink-hatch"
  | "watercolour"
  | "tactical-breach"
  | "hotline-neon"
  | "ascii-terminal"

export type PeopleStyleId = "blocky" | "capsule" | "pawn" | "rig"

export type StyleCameraViewId = "room" | "action" | "wide"

export type StyleScaleVerdict = "scales" | "partial" | "fails"

export type StyleRecipe = {
  /** Vertical pixel resolution (64..240) for pixel/1-bit/ASCII styles, or detail scale. */
  pixelSize: number
  /** Palette index (0..3) within the style. */
  palette: number
  /** Outline or crease width in pixels (0..3). */
  outlineWidth: number
  /** Ordered dither, paper tooth, or CRT scanline strength (0..1.5). */
  dither: number
  /** Halftone dot size, cross-hatch spacing, pigment bloom, or tactical grid weight (2..16). */
  halftoneSize: number
  /** Toon light ramp steps, hatch tiers, or quantisation bands (2..8). */
  rampSteps: number
  /** Muzzle flash, tracer, comic starburst, or telegraph intensity multiplier (0..2). */
  fxPunch: number
  /** Snap camera and low-res sampling UVs to world/pixel increments to eliminate shimmer. */
  pixelSnap: boolean
}

export type StylePresentationModule = {
  readonly id: StyleId
  readonly index: number
  readonly name: string
  readonly shortName: string
  readonly tagline: string
  readonly defaultPeople: PeopleStyleId
  readonly defaults: StyleRecipe
  readonly palettes: readonly [string, string, string, string]
  /** WGSL function `evalStyle_<index>(uv: vec2f) -> vec3f` compiled into the style presentation shader. */
  readonly wgsl: string
  /** Scaling assessment for full Outbreak (96×96 m streaming town, fog of war, day/night, co-op). */
  readonly scaling: {
    readonly verdict: StyleScaleVerdict
    readonly summary: string
    readonly whatItTakes: string
  }
}

export const STYLE_ORDER: readonly StyleId[] = [
  "tiny-pixel",
  "one-bit",
  "comic-cel",
  "papercraft",
  "ink-hatch",
  "watercolour",
  "tactical-breach",
  "hotline-neon",
  "ascii-terminal",
]

export function isStyleId(v: unknown): v is StyleId {
  return typeof v === "string" && (STYLE_ORDER as readonly string[]).includes(v)
}

export function isPeopleStyleId(v: unknown): v is PeopleStyleId {
  return v === "blocky" || v === "capsule" || v === "pawn" || v === "rig"
}

export function isStyleCameraViewId(v: unknown): v is StyleCameraViewId {
  return v === "room" || v === "action" || v === "wide"
}
