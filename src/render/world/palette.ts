// "BRIGHT STYLIZED" geometry with the locked Option B "Muted Tactical" palette — and the shared scene lighting/atmosphere constants.
// Dependency-free so any module (aircraft, effects, UI) can import it.
// Hex values are display (sRGB) colours; the world renders without tone mapping.

// ---------------------------------------------------------------------------------------------
// Shared scene lighting (import these to match the world)

/** Unit vector toward the sun: ~45° above the horizon, from the south-west. */
export const SUN_DIRECTION: readonly [number, number, number] = [-0.5, 0.7071, 0.5]
/** White-warm key light. */
export const SUN_COLOR = "#fbf4ea"
export const SUN_INTENSITY = 2.15
/** Hemisphere fill: soft blue sky from above, warm green-gray bounce from below. */
export const HEMI_SKY_COLOR = "#c6d6e0"
export const HEMI_GROUND_COLOR = "#7d8270"
export const HEMI_INTENSITY = 1.45
/** Clear, light atmospheric perspective. One colour; matches the sky at the horizon. */
export const FOG_COLOR = "#dde6ea"
/** Kept for compatibility: the haze is no longer directional (both equal FOG_COLOR). */
export const FOG_TOWARD_SUN = FOG_COLOR
export const FOG_AWAY_FROM_SUN = FOG_COLOR
/** Balanced-quality fog range (m); other presets live in settings.ts WORLD_QUALITY. */
export const FOG_NEAR = 2_500
export const FOG_FAR = 15_000
/** Sky gradient. */
export const SKY_ZENITH = "#8fb3cc"
export const SKY_HORIZON = FOG_COLOR
/** Shadow map size per quality (0 = no shadows), and the half-extent (m) of the sun's shadow box. */
export const SHADOW_MAP_SIZE = { low: 0, balanced: 1024, high: 2048 } as const
export const SHADOW_RADIUS = { low: 0, balanced: 350, high: 500 } as const
/** Outline colour for any (subtle) outline pass. The world itself draws no ink. */
export const INK_COLOR = "#22262a"
export const INK_FADE: readonly [number, number] = [400, 1_600]
/** The Watcher was removed in the BRIGHT STYLIZED look; kept so old imports compile. Radius 0 = none. */
export const WATCHER_DIRECTION: readonly [number, number, number] = [0, 1, 0]
export const WATCHER_RADIUS = 0

// ---------------------------------------------------------------------------------------------
// World palette

export const PALETTE = {
  // land — Option B "Muted Tactical"; only small value steps within each colour
  sand: "#d4c39a",
  sandWet: "#c2b28c",
  grass: "#7f9a5a",
  grassLight: "#88a263",
  grassDeep: "#728c50",
  forestFloor: "#6c8650",
  rock: "#7a746b",
  rockLight: "#868077",
  rockDark: "#6d6860",
  snow: "#eef1f2",
  seabed: "#c2b28c",
  // trees
  treeLight: "#56724a",
  treeMid: "#4f6a3e",
  treeDeep: "#465f37",
  trunk: "#6b5c4c",
  palmLeaf: "#56713f",
  // water
  shallow: "#6fa6a8",
  water: "#4a7f92",
  deep: "#2f5d78",
  foam: "#eef1f2",
  // sky
  zenith: SKY_ZENITH,
  horizon: FOG_COLOR,
  // built
  offWhite: "#e4e5e1",
  concrete: "#a9aca8",
  paving: "#a9aca8",
  pavingDark: "#979a96",
  marking: "#eef1f2",
  glass: "#5f6b73",
  roof: "#b9bcb8",
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
export const TEAM_COLORS = ["#3c6ea8", "#c98a2e", "#4e8a5a", "#b04a44"]
export const TEAM_PASTELS = TEAM_COLORS
