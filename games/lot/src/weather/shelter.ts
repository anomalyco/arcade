/**
 * Shelter shared by everything the rain touches: the drops and splashes stop here, the ground under it stays as it was,
 * and the sound under it changes (the open-lot hiss drops, the roof drums). Plan rects [x0, z0, x1, z1] (m).
 */
export const SHELTER = {
  /** The imported lobby and corridor slice. */
  lobby: [-55, -22, 35, 22],
  /** The booth's roof (its walls are 7.3–10.7 × 126.1–128.9; the roof overhangs them by 15 cm). */
  booth: [7.15, 125.95, 10.85, 129.05],
  /** The entrance canopy over the doors. */
  canopy: [-6.5, 22, 6.5, 25.2],
} as const satisfies Record<string, readonly [number, number, number, number]>

export const SHELTER_RECTS = Object.values(SHELTER)

/** Roof edges that drip: [x0, z0, x1, z1, height] (m). */
export const EAVES = [
  [7.15, 125.95, 10.85, 125.95, 2.95], [10.85, 125.95, 10.85, 129.05, 2.95], [10.85, 129.05, 7.15, 129.05, 2.95], [7.15, 129.05, 7.15, 125.95, 2.95],
  [-6.5, 25.2, 6.5, 25.2, 3.3],
] as const

export const sheltered = (x: number, z: number, r: readonly [number, number, number, number]) => x > r[0] && x < r[2] && z > r[1] && z < r[3]
