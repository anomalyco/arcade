// The single curated world palette (ISLANDERS-style). Everything in the world draws from these.
// Hex values are display (sRGB) colours; the game renders without tone mapping.

export const PALETTE = {
  // land: bright terrace tops, slate cliffs
  sand: "#f0dca0",
  meadow: "#cfd66e",
  grass: "#aecb62",
  highland: "#93b65e",
  ochre: "#c8b06a",
  peak: "#e9e2cc",
  forestFloor: "#7ea457",
  cliff: "#a8957f",
  cliffShade: "#857464",
  wetRock: "#71848a",
  cliffHigh: "#b3a28c",
  seabed: "#b9c79a",
  // trees
  treeLight: "#8fbf55",
  treeMid: "#5f9a4c",
  treeDeep: "#3f7a49",
  trunk: "#8a6a50",
  // water
  shallow: "#7ee6d6",
  water: "#2fb3c6",
  deep: "#1f7fa6",
  foam: "#f4fbf6",
  // sky / haze
  horizon: "#acd6e6",
  zenith: "#7dbcdc",
  // built
  offWhite: "#f3eee2",
  paving: "#a7adb0",
  pavingDark: "#8b9297",
  marking: "#fbf8f0",
  glass: "#4f6f86",
  // lights
  sunLight: "#fff0d8",
  hemiSky: "#cfe4f2",
  hemiGround: "#8d9aa0",
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
