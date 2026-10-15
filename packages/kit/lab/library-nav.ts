/** Pure helpers for moving focus through a wrapped grid of Library tiles. */

export type TileRect = { x: number; y: number; width: number; height: number }
export type GridMove = "left" | "right" | "up" | "down" | "home" | "end" | "pageUp" | "pageDown"

/**
 * The index focus moves to from `from`. Left/right follow reading order; up/down go to the nearest row above or
 * below (rows can be uneven because group headings break them) and pick the tile whose centre is closest
 * horizontally. Page moves jump `pageRows` rows. Returns `from` at an edge.
 */
export function gridNeighbor(rects: readonly TileRect[], from: number, move: GridMove, pageRows = 3): number {
  const n = rects.length
  if (!n) return -1
  if (from < 0 || from >= n) return 0
  if (move === "home") return 0
  if (move === "end") return n - 1
  if (move === "left") return Math.max(0, from - 1)
  if (move === "right") return Math.min(n - 1, from + 1)
  const rows = rowsOf(rects)
  const row = rows.findIndex(r => r.includes(from))
  const delta = move === "up" ? -1 : move === "down" ? 1 : move === "pageUp" ? -pageRows : pageRows
  const targetRow = Math.max(0, Math.min(rows.length - 1, row + delta))
  if (targetRow === row) return from
  const cx = rects[from]!.x + rects[from]!.width / 2
  let best = rows[targetRow]![0]!
  let bestDist = Infinity
  for (const i of rows[targetRow]!) {
    const d = Math.abs(rects[i]!.x + rects[i]!.width / 2 - cx)
    if (d < bestDist) {
      bestDist = d
      best = i
    }
  }
  return best
}

/** Groups tile indices into visual rows by their top edge (within half a tile height). */
export function rowsOf(rects: readonly TileRect[]): number[][] {
  const rows: number[][] = []
  let top = -Infinity
  rects.forEach((r, i) => {
    if (Math.abs(r.y - top) > r.height / 2) {
      rows.push([])
      top = r.y
    }
    rows[rows.length - 1]!.push(i)
  })
  return rows
}

/** A single printable character typed without modifiers starts a type-to-filter search. */
export function isFilterKey(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey">): boolean {
  return event.key.length === 1 && event.key !== " " && !event.metaKey && !event.ctrlKey && !event.altKey
}
