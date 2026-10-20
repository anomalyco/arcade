import { INV_AT, type InventoryOp } from "./types"

const SLOT_BITS = 7
const AT_BITS = 3
const SLOT_MAX = (1 << SLOT_BITS) - 1
const COUNT_MAX = 255
const TO = AT_BITS + SLOT_BITS
const TURN = 2 * TO
const COUNT = TURN + 1
/** Packed moves stay under 2^30 (a uvar of at most five bytes). */
const PACKED_MAX = 2 ** (COUNT + 8)

/** Packs a move into one positive integer for the command tuple. */
export function packInventoryOp(op: InventoryOp): number {
  const f = INV_AT.indexOf(op.from.at)
  const t = INV_AT.indexOf(op.to.at)
  if (f < 0 || t < 0) return 0
  const fs = Math.max(0, Math.min(SLOT_MAX, op.from.slot | 0))
  const ts = Math.max(0, Math.min(SLOT_MAX, op.to.slot | 0))
  const count = Math.max(0, Math.min(COUNT_MAX, (op.count ?? 0) | 0))
  return 1 + f + fs * 2 ** AT_BITS + t * 2 ** TO + ts * 2 ** (TO + AT_BITS) + (op.to.r ? 2 ** TURN : 0) + count * 2 ** COUNT
}

/** Reads a packed move; null for 0 or anything malformed. Never throws. */
export function unpackInventoryOp(n: unknown): InventoryOp | null {
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0 || n > PACKED_MAX) return null
  const v = n - 1
  const bits = (at: number, width: number) => Math.floor(v / 2 ** at) % 2 ** width
  const fromAt = INV_AT[bits(0, AT_BITS)]
  const toAt = INV_AT[bits(TO, AT_BITS)]
  if (!fromAt || !toAt) return null
  const count = bits(COUNT, 8)
  const to = { at: toAt, slot: bits(TO + AT_BITS, SLOT_BITS), ...(bits(TURN, 1) ? { r: true } : {}) }
  return { from: { at: fromAt, slot: bits(AT_BITS, SLOT_BITS) }, to, ...(count ? { count } : {}) }
}
