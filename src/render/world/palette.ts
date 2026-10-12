// "STORMFRONT" — world palette and the shared scene lighting/atmosphere constants.
// Dependency-free so any module (aircraft, effects, UI, post) can import it.
// Hex values are display (sRGB) colours. The game renders with filmic (ACES) tone mapping.

// ---------------------------------------------------------------------------------------------
// Shared scene lighting (import these to match the world)

/** Unit vector toward the dim, diffuse key light: high overhead, leaning toward the cloud break. */
export const SUN_DIRECTION: readonly [number, number, number] = [0.28, 0.86, -0.43]
/** Cool, dim key light (storm light filtered through cloud). */
export const SUN_COLOR = "#aebdbb"
export const SUN_INTENSITY = 1.1
/** Hemisphere fill: slate-green sky above, near-black sea below. Low ambient. */
export const HEMI_SKY_COLOR = "#5a6865"
export const HEMI_GROUND_COLOR = "#131a19"
export const HEMI_INTENSITY = 1.0
/** Direction (horizontal, unit) of the brighter break in the clouds near the horizon. */
export const BREAK_DIRECTION: readonly [number, number] = [0.55, -0.835]
/** Mist/fog colour at the horizon away from the break, and toward the break. */
export const FOG_COLOR = "#303b38"
export const FOG_BREAK_COLOR = "#66736c"
export const FOG_TOWARD_SUN = FOG_BREAK_COLOR
export const FOG_AWAY_FROM_SUN = FOG_COLOR
/**
 * Height fog: density(h) = FOG_DENSITY_BASE + FOG_DENSITY_SEA * exp(-h / FOG_HEIGHT_FALLOFF).
 * Visibility ≈ 4 km at sea level, much further above the cloud-mist layer.
 */
export const FOG_DENSITY_BASE = 0.00007
export const FOG_DENSITY_SEA = 0.0005
export const FOG_HEIGHT_FALLOFF = 420
/** Equivalent linear range for consumers that still use THREE.Fog. */
export const FOG_NEAR = 150
export const FOG_FAR = 5_500
/** Sky: dark slate-green clouds. */
export const SKY_ZENITH = "#1c2725"
export const SKY_HORIZON = FOG_COLOR
export const CLOUD_DARK = "#161f1e"
export const CLOUD_LIGHT = "#33403d"
/** Lightning flash colour (HDR multiplier applied in shaders). */
export const LIGHTNING_COLOR = "#dfe8ff"
/** Rain streak colour. */
export const RAIN_COLOR = "#9aa8a6"
/** Shadows are off in the storm (no hard sun). Kept for compatibility. */
export const SHADOW_MAP_SIZE = { low: 0, balanced: 0, high: 0 } as const
export const SHADOW_RADIUS = { low: 0, balanced: 0, high: 0 } as const
/** Outline colour for any (subtle) outline pass. */
export const INK_COLOR = "#0e1312"
export const INK_FADE: readonly [number, number] = [300, 1_200]
/** Removed looks; kept so old imports compile. Radius 0 = none. */
export const WATCHER_DIRECTION: readonly [number, number, number] = [0, 1, 0]
export const WATCHER_RADIUS = 0

// ---------------------------------------------------------------------------------------------
// World palette

export const PALETTE = {
  // land: dark wet rock, deep green vegetation, wet dark sand
  sand: "#5d5849",
  sandWet: "#3f3c33",
  grass: "#2d4529",
  grassLight: "#365231",
  grassDeep: "#243a22",
  forestFloor: "#1f331d",
  rock: "#363a37",
  rockLight: "#464b47",
  rockDark: "#2a2d2b",
  snow: "#6c7471",
  seabed: "#2b302c",
  // trees
  treeLight: "#22381f",
  treeMid: "#1d3220",
  treeDeep: "#16281a",
  trunk: "#221d19",
  palmLeaf: "#24391f",
  // water
  shallow: "#3a4d48",
  water: "#2e3b38",
  deep: "#1f2b2a",
  foam: "#b8c4c0",
  // sky
  zenith: SKY_ZENITH,
  horizon: FOG_COLOR,
  // built
  offWhite: "#7d8380",
  concrete: "#6b6f6c",
  paving: "#5e6260",
  pavingDark: "#4c504e",
  marking: "#b8bdb9",
  glass: "#2c3438",
  roof: "#5a5f5c",
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

/** Team colours (muted) — strong colour only on team markings. */
export const TEAM_COLORS = ["#3c6ea8", "#c98a2e", "#4e8a5a", "#b04a44"]
export const TEAM_PASTELS = TEAM_COLORS
