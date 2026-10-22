import { HOTBAR_SIZE } from "../../shared/progression/catalog"
import type { Box, Thumb } from "../portraits/thumb"

/**
 * Where the case's art goes, in cells (AR-94, after Kit's "clearly this doesn't fit"): the lid's quick slots share the
 * case's width instead of running past it, and a portrait on the grid is exactly its footprint (turned a quarter when
 * the item is). Quick slots hold fitted thumbnails (`portraits/thumb.ts`). Pure, so tests can check every item at
 * every case size.
 */

export type Rect = Box & { x: number; y: number }

/** The lid, in cells: the gap between quick slots, their height and the margin art keeps inside one. */
export const LID = { gap: 0.1, height: 1.1, pad: 0.1 } as const

/** The five quick slots across the lid, exactly as wide as a case `cols` cells across. */
export function lidSlots(cols: number): Rect[] {
  const w = (cols - LID.gap * (HOTBAR_SIZE - 1)) / HOTBAR_SIZE
  return Array.from({ length: HOTBAR_SIZE }, (_, i) => ({ x: i * (w + LID.gap), y: 0, w, h: LID.height }))
}

/** A portrait on the grid: exactly its footprint, the image drawn as it lies and turned a quarter when the item is. */
export function artOnGrid(shape: Box, turned: boolean): Thumb {
  return { w: shape.w, h: shape.h, angle: turned ? 90 : 0 }
}
