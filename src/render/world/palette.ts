// "BRIGHT STYLIZED" — the world palette and the shared scene lighting/atmosphere constants.
// Dependency-free so any module (aircraft, effects, UI) can import it.
// Hex values are display (sRGB) colours; the world renders without tone mapping.

// ---------------------------------------------------------------------------------------------
// Shared scene lighting (import these to match the world)

/** Unit vector toward the sun: ~45° above the horizon, from the south-west. */
export const SUN_DIRECTION: readonly [number, number, number] = [-0.5, 0.7071, 0.5]
/** White-warm key light. */
export const SUN_COLOR = "#fff3e0"
export const SUN_INTENSITY = 2.6
/** Hemisphere fill: soft blue sky from above, warm green-gray bounce from below. */
export const HEMI_SKY_COLOR = "#bcdcff"
export const HEMI_GROUND_COLOR = "#8f9a78"
export const HEMI_INTENSITY = 1.5
/** Clear, light atmospheric perspective. One colour; matches the sky at the horizon. */
export const FOG_COLOR = "#cfe5f6"
/** Kept for compatibility: the haze is no longer directional (both equal FOG_COLOR). */
export const FOG_TOWARD_SUN = FOG_COLOR
export const FOG_AWAY_FROM_SUN = FOG_COLOR
/** Balanced-quality fog range (m); other presets live in settings.ts WORLD_QUALITY. */
export const FOG_NEAR = 2_500
export const FOG_FAR = 15_000
/** Sky gradient. */
export const SKY_ZENITH = "#3f8ee0"
export const SKY_HORIZON = FOG_COLOR
/** Shadow map size per quality (0 = no shadows), and the half-extent (m) of the sun's shadow box. */
export const SHADOW_MAP_SIZE = { low: 0, balanced: 1024, high: 2048 } as const
export const SHADOW_RADIUS = { low: 0, balanced: 350, high: 500 } as const
/** Outline colour for any (subtle) outline pass. The world itself draws no ink. */
export const INK_COLOR = "#1f2a36"
export const INK_FADE: readonly [number, number] = [400, 1_600]
/** The Watcher was removed in the BRIGHT STYLIZED look; kept so old imports compile. Radius 0 = none. */
export const WATCHER_DIRECTION: readonly [number, number, number] = [0, 1, 0]
export const WATCHER_RADIUS = 0

// ---------------------------------------------------------------------------------------------
// World palette

export const PALETTE = {
  // land
  sand: "#efd9a2",
  sandWet: "#d9c08a",
  grass: "#6fba4a",
  grassLight: "#94cc58",
  grassDeep: "#4a9440",
  forestFloor: "#4a8c35",
  rock: "#8d8274",
  rockLight: "#aaa092",
  rockDark: "#6f665c",
  snow: "#f6f8fb",
  seabed: "#d6c48f",
  // trees
  treeLight: "#7fc94a",
  treeMid: "#57ad3c",
  treeDeep: "#3c8d33",
  trunk: "#8a5f3d",
  palmLeaf: "#6cbc43",
  // water
  shallow: "#3fe0d0",
  water: "#1aa4d8",
  deep: "#0f62b0",
  foam: "#ffffff",
  // sky
  zenith: SKY_ZENITH,
  horizon: FOG_COLOR,
  // built
  offWhite: "#f2f2ee",
  concrete: "#b8bcbf",
  paving: "#9da3a8",
  pavingDark: "#7f868c",
  marking: "#ffffff",
  glass: "#5b7fa6",
  roof: "#d8dde2",
  // lights (legacy aliases)
  sunLight: SUN_COLOR,
  hemiSky: HEMI_SKY_COLOR,
  hemiGround: HEMI_GROUND_COLOR,
} as const

/** Linear-space bytes (three treats vertex/instance colours as linear working-space values). */
function rgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16)
  const lin = (c: number) => {
    const s = c / 255
    return Math.round((s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)) * 255)
  }
  return [lin((v >> 16) & 255), lin((v >> 8) & 255), lin(v & 255)]
}

export const PALETTE_RGB = Object.fromEntries(Object.entries(PALETTE).map(([k, v]) => [k, rgb(v)])) as Record<keyof typeof PALETTE, [number, number, number]>

/** Team colours (bold accents) and slightly softened variants for large surfaces. */
export const TEAM_COLORS = ["#2f6fd1", "#e0902a", "#2fae5a", "#d13f3f"]
export const TEAM_PASTELS = ["#4d86e0", "#eea040", "#45bf6d", "#e05555"]
