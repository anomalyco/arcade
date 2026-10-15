/**
 * Rug palettes from real dye traditions. Every palette fills the same twelve roles so any rug style can use any
 * palette; the styles decide which role paints which part (field, medallion, borders, outlines).
 */

export const ROLE = {
  ground: 0,
  ground2: 1,
  medal: 2,
  medal2: 3,
  border: 4,
  border2: 5,
  ivory: 6,
  gold: 7,
  blue: 8,
  green: 9,
  rose: 10,
  dark: 11,
} as const
export type RugRole = (typeof ROLE)[keyof typeof ROLE]

export type RugPalette = {
  id: RugPaletteId
  label: string
  /** Twelve sRGB colours indexed by `ROLE`. */
  colors: readonly number[]
}

export const RUG_PALETTE_IDS = [
  "madder",
  "kashan",
  "tabriz",
  "antique",
  "isfahan",
  "walnut",
  "tekke",
  "kilim",
  "deco",
  "braid",
  "shag70s",
  "mansion",
] as const
export type RugPaletteId = (typeof RUG_PALETTE_IDS)[number]

//                        ground    ground2   medal     medal2    border    border2   ivory     gold      blue      green     rose      dark
export const RUG_PALETTES: Record<RugPaletteId, RugPalette> = {
  madder: { id: "madder", label: "Madder red (Heriz)", colors: [0x7e2419, 0x5e1a13, 0x1f3354, 0x2f4a6e, 0xc79a52, 0x8a2a1e, 0xdccaa2, 0xc8962e, 0x5d7f9e, 0x4f6b4a, 0xb5655a, 0x2a1a12] },
  kashan: { id: "kashan", label: "Indigo navy (Kashan)", colors: [0x1c2846, 0x14203a, 0x8a2424, 0xa8463a, 0x7a1e1c, 0x1c2846, 0xd8c6a0, 0xc19a48, 0x5b7a9a, 0x506a48, 0xb26a5e, 0x0e1222] },
  tabriz: { id: "tabriz", label: "Ivory field (Tabriz)", colors: [0xd4c29a, 0xc4b088, 0x8a2a24, 0x1f3354, 0x1d2a44, 0x8a2a24, 0xe6dcc2, 0xbf8e3a, 0x51729a, 0x5a7650, 0xb07060, 0x2c2018] },
  antique: { id: "antique", label: "Faded antique", colors: [0xa66e5c, 0x8e5a4a, 0x6c7c8e, 0x8796a4, 0xb59a6c, 0x9a6a54, 0xd4c6a6, 0xb89a62, 0x7d8a9a, 0x7c8466, 0xc29486, 0x4a3a30] },
  isfahan: { id: "isfahan", label: "Saffron & rose (Isfahan)", colors: [0xa2662a, 0x8a5420, 0x24345a, 0x7a2a2c, 0x7a2a2c, 0xc49a4a, 0xe2d4b0, 0xd2a63c, 0x5b7fa6, 0x5c7a46, 0xc07a6c, 0x2a1c14] },
  walnut: { id: "walnut", label: "Walnut (Bakhtiari)", colors: [0x4e3222, 0x3c2618, 0x7c2a1e, 0x2a3a52, 0x6a4a2c, 0x7c2a1e, 0xcfbf98, 0xb8863a, 0x4f6c86, 0x5a6a3c, 0xa8645a, 0x1c120c] },
  tekke: { id: "tekke", label: "Tekke red (Turkmen)", colors: [0x6a1c1a, 0x52151a, 0x8e2a22, 0x1c2236, 0x5e1a18, 0x8e2a22, 0xd8ccb0, 0xb0602a, 0x2a3450, 0x3e5236, 0x9a4a3a, 0x1e1210] },
  kilim: { id: "kilim", label: "Anatolian kilim", colors: [0xa83226, 0x8a2a20, 0x23345a, 0xc86a2a, 0x1d1a18, 0xa83226, 0xe0d6c0, 0xc9a03a, 0x3a5a86, 0x4a6a40, 0xc0705a, 0x1d1a18] },
  deco: { id: "deco", label: "Art Deco", colors: [0x2f5e5c, 0x24504e, 0xe2d6b8, 0xb8913e, 0x1a1a1c, 0x2f5e5c, 0xe8dcc0, 0xc29a44, 0x55606a, 0x6a7a5a, 0xa05a5a, 0x141416] },
  braid: { id: "braid", label: "Braided rag", colors: [0x5c3e2a, 0x8a4a2a, 0x5e6236, 0xc6b48e, 0x2c3448, 0x6a2a2a, 0xcab996, 0xa8823e, 0x46607a, 0x5a6a3a, 0x9a5a4a, 0x2a1e16] },
  shag70s: { id: "shag70s", label: "Harvest shag (70s)", colors: [0xb08a2e, 0xa65222, 0x6b6e2c, 0x4a2e1c, 0xc8b48a, 0x8a6a2a, 0xd0be92, 0xc49a36, 0x5a6a70, 0x6b6e2c, 0xb06a4a, 0x2e1e12] },
  mansion: { id: "mansion", label: "Mansion crimson (RE)", colors: [0x5a1012, 0x420c0e, 0x1a2a2a, 0x2e2a20, 0x2a1a10, 0x6a1416, 0xc8b48a, 0xa8823a, 0x3c5664, 0x34482e, 0x8a3a32, 0x140a08] },
}

export function hexToRgb(hex: number): [number, number, number] {
  return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255]
}
