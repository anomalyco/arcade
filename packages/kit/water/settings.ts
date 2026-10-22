/** Presentation only. Games keep their own authoritative height and buoyancy functions. */
export type WaterSettings = {
  mode: "today" | "continuous"
  normalStrength: number
  detailStrength: number
  detailScale: number
  roughness: number
  reflection: number
  foam: number
  wake: number
  colour: string
}

export const OCEAN_WATER: Readonly<WaterSettings> = {
  mode: "continuous", normalStrength: 1, detailStrength: 0.09, detailScale: 4,
  roughness: 0.16, reflection: 1, foam: 0.8, wake: 1, colour: "#bededb",
}
/** Proposed starting values; the forest lake adapter is not integrated yet. */
export const LAKE_WATER: Readonly<WaterSettings> = {
  mode: "continuous", normalStrength: 0.3, detailStrength: 0.018, detailScale: 0.5,
  roughness: 0.09, reflection: 1, foam: 0, wake: 0.3, colour: "#9bb7ac",
}
export function createWaterSettings(): WaterSettings { return { ...OCEAN_WATER, mode: "today" } }

/** Linear colour multiplier; invalid live edits safely preserve the base colour. */
export function waterTint(hex: string): [number, number, number] {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return [1, 1, 1]
  const channel = (start: number) => {
    const v = parseInt(hex.slice(start, start + 2), 16) / 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return [channel(1), channel(3), channel(5)]
}
