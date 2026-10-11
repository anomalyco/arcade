// The single curated world palette (ISLANDERS-style). Everything in the world draws from these.
// Hex values are display (sRGB) colours; the game renders without tone mapping.

export const PALETTE = {
  // land
  sand: "#ecdcae",
  meadow: "#b5cf7a",
  grass: "#8fba63",
  forest: "#5f9a5c",
  highland: "#a7ad7e",
  rock: "#c2a68a",
  rockLight: "#d6c2a8",
  cliff: "#a08a7b",
  snow: "#f5f2ea",
  // trees (reuse the land greens, a touch richer so they read against the ground)
  treeLight: "#9cc466",
  treeMid: "#6fa85a",
  treeDeep: "#4f8a58",
  trunk: "#9a7458",
  // water
  shallow: "#93e0d2",
  water: "#5cb0d2",
  deep: "#3d84b8",
  foam: "#f6f3e8",
  // sky
  horizon: "#e3eef0",
  zenith: "#8fbfe2",
  // built
  offWhite: "#f1ebdf",
  paving: "#a9adb0",
  pavingDark: "#8e9398",
  marking: "#fbf8f0",
  glass: "#4f6f86",
  roof: "#d98b6a",
  // lights
  sunLight: "#ffe9cc",
  hemiSky: "#c9dcf2",
  hemiGround: "#d9cdb0",
  // cosmic accents
  starMint: "#cdf2dc",
  auroraLilac: "#b7a6e6",
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
export const TEAM_PASTELS = ["#6f97d8", "#e3a861", "#6dbb84", "#d97a72"]
