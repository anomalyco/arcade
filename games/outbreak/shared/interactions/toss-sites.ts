import { distToRect, type Rect } from "@arcade/kit/sim/geom"
import { propShape, solidRects, type Building, type Town } from "../map"
import type { ThrowableItem } from "./throwables"

export type ThrowableSite = { id: string; buildingId: string; x: number; y: number; item: ThrowableItem }

export const yardDropId = (buildingId: string) => `drop:v:yard:${buildingId}`

function hash01(s: string, salt: number): number {
  let h = 2166136261 ^ salt
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  h = Math.imul(h ^ (h >>> 15), 2246822507)
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296
}

function pick<T>(u: number, table: readonly (readonly [T, number])[]): T {
  let total = 0
  for (const [, w] of table) total += w
  let acc = 0
  for (const [v, w] of table) {
    acc += w / total
    if (u < acc) return v
  }
  return table[table.length - 1]![0]
}

const YARD: readonly (readonly [ThrowableItem, number])[] = [["brick", 3], ["rock", 3], ["baseball", 2], ["tin-can", 1]]
const FLOOR: readonly (readonly [ThrowableItem, number])[] = [["tin-can", 4], ["baseball", 3], ["bottle", 2]]

const clear = (x: number, y: number, solids: readonly Rect[], r: number) => solids.every((s) => distToRect(x, y, s) > r)

/** Doors on a building's outside wall, with the way out of each. */
function outerDoors(town: Town, b: Building): { x: number; y: number; nx: number; ny: number }[] {
  const out: { x: number; y: number; nx: number; ny: number }[] = []
  const [x0, y0, x1, y1] = b.rect
  for (const d of town.doors) {
    const cx = (d.rect[0] + d.rect[2]) / 2
    const cy = (d.rect[1] + d.rect[3]) / 2
    if (cx < x0 - 0.4 || cx > x1 + 0.4 || cy < y0 - 0.4 || cy > y1 + 0.4) continue
    const edges: [number, number, number][] = [
      [Math.abs(cy - y0), 0, -1],
      [Math.abs(cy - y1), 0, 1],
      [Math.abs(cx - x0), -1, 0],
      [Math.abs(cx - x1), 1, 0],
    ]
    let best = edges[0]!
    for (const e of edges) if (e[0] < best[0]) best = e
    if (best[0] < 0.45) out.push({ x: cx, y: cy, nx: best[1], ny: best[2] })
  }
  return out
}

/**
 * Where a house has a throwable lying about, if it has one: a brick, rock or baseball by the front door or in the yard,
 * or a can, baseball or bottle on a floor beside a table or counter. A pure function of the town and `chance`.
 */
export function throwableSite(town: Town, b: Building, chance: number, solids: readonly Rect[] = solidRects(town)): ThrowableSite | null {
  if (b.kind !== "house") return null
  if (hash01(b.id, 1) >= chance) return null
  const indoor = hash01(b.id, 2) < 0.4
  const site = (x: number, y: number, table: typeof YARD): ThrowableSite => ({ id: yardDropId(b.id), buildingId: b.id, x: Number(x.toFixed(2)), y: Number(y.toFixed(2)), item: pick(hash01(b.id, 3), table) })
  if (indoor) {
    const inside = (x: number, y: number) => x > b.rect[0] + 0.5 && x < b.rect[2] - 0.5 && y > b.rect[1] + 0.5 && y < b.rect[3] - 0.5
    for (const p of town.props) {
      if ((p.kind !== "table" && p.kind !== "counter" && p.kind !== "coffee") || !inside(p.x, p.y)) continue
      const shape = propShape(p)
      if (!shape) continue
      for (let k = 0; k < 4; k++) {
        const a = hash01(b.id, 10 + k) * Math.PI * 2
        const reach = Math.max(shape.rect[2] - shape.rect[0], shape.rect[3] - shape.rect[1]) / 2 + 0.35
        const x = p.x + Math.cos(a) * reach
        const y = p.y + Math.sin(a) * reach
        if (inside(x, y) && clear(x, y, solids, 0.18)) return site(x, y, FLOOR)
      }
    }
  }
  for (const d of outerDoors(town, b)) {
    for (let k = 0; k < 4; k++) {
      const side = (hash01(b.id, 20 + k) - 0.5) * 3
      const out = 1.6 + hash01(b.id, 30 + k) * 2.2
      const x = d.x + d.nx * out + d.ny * side
      const y = d.y + d.ny * out + d.nx * side
      if (x > b.rect[0] && x < b.rect[2] && y > b.rect[1] && y < b.rect[3]) continue
      if (clear(x, y, solids, 0.25)) return site(x, y, YARD)
    }
  }
  return null
}
