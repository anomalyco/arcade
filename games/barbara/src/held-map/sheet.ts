import type { WoodsWorld } from "../../shared/world"

/**
 * The survey sheet's paper layout in millimetres, shared by the print, the pencil layer, the paper mesh and the
 * shader. The sheet is 340 × 400 mm, folded in three each way (creases at thirds); the 300 mm map square sits under a
 * 22 mm top collar, the title, scale and legend fill the bottom collar.
 */
export const SHEET = {
  w: 340,
  h: 400,
  /** Neatline (the map square), mm from the sheet's top-left corner. */
  map: { x: 20, y: 24, size: 300 },
  /** Crease positions: across (u, mm from the left) and down (v, mm from the top). */
  creasesU: [340 / 3, (2 * 340) / 3],
  creasesV: [400 / 3, (2 * 400) / 3],
} as const

/** World (x, z) to sheet millimetres; north (−z) is up. */
export function worldToSheet(world: WoodsWorld, x: number, z: number): [number, number] {
  const h = world.params.half, s = SHEET.map.size / (h * 2)
  return [SHEET.map.x + (x + h) * s, SHEET.map.y + (z + h) * s]
}

/** Map scale denominator (1 : n). */
export const scaleOf = (world: WoodsWorld) => Math.round((world.params.half * 2 * 1000) / SHEET.map.size)

/** A small deterministic random stream (no Math.random: the same sheet every time for the same world). */
export function rng(seed: number) {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13; s >>>= 0
    s ^= s >>> 17
    s ^= s << 5; s >>>= 0
    return s / 4294967296
  }
}
