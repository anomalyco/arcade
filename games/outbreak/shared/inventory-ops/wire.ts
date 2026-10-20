import { INV_AT, type InventoryOp } from "./types"

const SLOT_BITS = 5
const AT_BITS = 3
const SLOT_MAX = (1 << SLOT_BITS) - 1
const COUNT_MAX = 255

/** Packs a move into one non-zero integer under 2^25 for the command tuple. */
export function packInventoryOp(op: InventoryOp): number {
  const f = INV_AT.indexOf(op.from.at)
  const t = INV_AT.indexOf(op.to.at)
  if (f < 0 || t < 0) return 0
  const fs = Math.max(0, Math.min(SLOT_MAX, op.from.slot | 0))
  const ts = Math.max(0, Math.min(SLOT_MAX, op.to.slot | 0))
  const count = Math.max(0, Math.min(COUNT_MAX, (op.count ?? 0) | 0))
  return 1 + (f | (fs << AT_BITS) | (t << (AT_BITS + SLOT_BITS)) | (ts << (2 * AT_BITS + SLOT_BITS)) | (count << (2 * AT_BITS + 2 * SLOT_BITS)))
}

/** Reads a packed move; null for 0 or anything malformed. Never throws. */
export function unpackInventoryOp(n: unknown): InventoryOp | null {
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0 || n > 1 << 25) return null
  const v = n - 1
  const at = (bits: number) => INV_AT[(v >>> bits) & ((1 << AT_BITS) - 1)]
  const slot = (bits: number) => (v >>> bits) & SLOT_MAX
  const fromAt = at(0)
  const toAt = at(AT_BITS + SLOT_BITS)
  if (!fromAt || !toAt) return null
  const count = (v >>> (2 * AT_BITS + 2 * SLOT_BITS)) & COUNT_MAX
  return { from: { at: fromAt, slot: slot(AT_BITS) }, to: { at: toAt, slot: slot(2 * AT_BITS + SLOT_BITS) }, ...(count ? { count } : {}) }
}
