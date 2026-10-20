/** The ends of an inventory move (AR-94); `ops.ts` packs and applies them. */
export const INV_AT = ["hotbar", "pack", "belt", "target", "ground", "mate", "me"] as const
export type InvAt = (typeof INV_AT)[number]

/**
 * One end of a move. `slot` is the store's slot for hotbar and pack, the index in `BELT_ITEMS` for the belt, the index in
 * the target's contents (strip order), the teammate's seat index for `mate`, and unused for `ground` and `me` (routed).
 */
export type InvRef = { at: InvAt; slot: number }

/** A move of `count` (0: the whole stack) from one end to the other. */
export type InventoryOp = { from: InvRef; to: InvRef; count?: number }
