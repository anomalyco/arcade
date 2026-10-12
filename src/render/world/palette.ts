// "GOLDEN ELDRITCH" — the world palette and the shared scene lighting/atmosphere constants.
// Dependency-free so any module (aircraft, effects, UI) can import it.
// Hex values are display (sRGB) colours; the game renders without tone mapping.

// ---------------------------------------------------------------------------------------------
// Shared scene lighting (import these to match the world)

/** Unit vector toward the sun: ~10° above the horizon, west-south-west. */
export const SUN_DIRECTION: readonly [number, number, number] = [-0.8924, 0.1736, 0.4167]
/** Warm apricot key light. */
export const SUN_COLOR = "#ffc98f"
export const SUN_INTENSITY = 2.9
/** Hemisphere fill: rose-peach from above, cool lilac from below/shadow side. */
export const HEMI_SKY_COLOR = "#f4cdb8"
export const HEMI_GROUND_COLOR = "#7466ab"
export const HEMI_INTENSITY = 2.3
/** Directional haze: looking toward the sun the air is warm gold, away from it violet. */
export const FOG_TOWARD_SUN = "#ffc896"
export const FOG_AWAY_FROM_SUN = "#a493c6"
/** Single colour for THREE.Fog (used by materials not patched with applyGoldenHaze). */
export const FOG_COLOR = "#d6abb0"
/** Balanced-quality fog range (m); other presets live in settings.ts WORLD_QUALITY. */
export const FOG_NEAR = 600
export const FOG_FAR = 13_600
/** Warm-dark ink for outlines (~1–1.5 px, distance-faded). */
export const INK_COLOR = "#3b2a3f"
/** Distance (m) over which ink fades out: [start, end]. */
export const INK_FADE: readonly [number, number] = [700, 3_200]
/** Direction to the centre of the Watcher (opposite the sun, ~22° up) and its angular radius (rad). */
export const WATCHER_DIRECTION: readonly [number, number, number] = [0.8402, 0.3746, -0.3923]
export const WATCHER_RADIUS = 0.245

// ---------------------------------------------------------------------------------------------
// World palette

export const PALETTE = {
  // land: warm sand, olive → sage greens, terracotta/ochre cliffs, lilac shade
  sand: "#f7ddb0",
  meadow: "#bad58c",
  grass: "#94c194",
  highland: "#8db8a0",
  ochre: "#c8a777",
  peak: "#efd2a6",
  forestFloor: "#6f9c80",
  cliff: "#b9806a",
  cliffShade: "#8e6470",
  wetRock: "#7d6f92",
  cliffHigh: "#c99a78",
  seabed: "#c6b98f",
  lilacShade: "#8f7fbf",
  // trees
  treeLight: "#a9bb6c",
  treeMid: "#78985e",
  treeDeep: "#4f6f4e",
  trunk: "#8e5e48",
  // water
  shallow: "#43c6b8",
  water: "#1d7489",
  deep: "#21486e",
  goldShallow: "#f2c77c",
  foam: "#fff3dc",
  glitter: "#ffe2a0",
  // sky
  skyPeach: "#ffcf9c",
  skyRose: "#f3a7a6",
  skyLavender: "#a995c9",
  skyIndigo: "#3a3a78",
  watcher: "#efe6ee",
  watcherShade: "#8e86b8",
  aurora: "#9fe8d0",
  auroraLilac: "#c6a8ff",
  // built
  offWhite: "#f5e6cf",
  paving: "#b3a598",
  pavingDark: "#94877f",
  marking: "#fff6e6",
  glass: "#4d5f88",
  gold: "#ffc86e",
  // legacy aliases used by the scene lights
  sunLight: SUN_COLOR,
  hemiSky: HEMI_SKY_COLOR,
  hemiGround: HEMI_GROUND_COLOR,
  horizon: FOG_COLOR,
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

/** Team accent colours softened toward the palette (roofs, runway band, domes). */
export const TEAM_COLORS = ["#2f6fd1", "#e0902a", "#2fae5a", "#d13f3f"]
export const TEAM_PASTELS = ["#7f8fd6", "#e8a35e", "#7dae7a", "#dc7b6c"]
