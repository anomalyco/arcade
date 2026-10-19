import type { Rect } from "@arcade/kit/sim/geom"
import { hash01 } from "./hash"
import { alongRoute, straightAt, type WayOutPlan } from "./plan"
import type { WayOutTuning } from "./tuning"

/**
 * Roadblocks across the route (AR-64), between the dead soldier and the destination. A pure function of the plan, so
 * every seat agrees without sending them. Each spans the road and both verges and stops cars; people squeeze through
 * a gap at one kerb, so on foot nobody is ever stuck. Dynamite clears any of them, bolt cutters open a chained gate,
 * and a car can always go round by a parallel road.
 */

export type RoadblockKind = "wreck" | "police" | "gate"

export const ROADBLOCK_WORDS: Readonly<Record<RoadblockKind, { name: string; how: string }>> = {
  wreck: { name: "A pile-up", how: "Blow it up or go round" },
  police: { name: "A police roadblock", how: "Blow it up or go round" },
  gate: { name: "A chained gate", how: "Cut the chain, blow it or go round" },
}

export type Roadblock = {
  index: number
  kind: RoadblockKind
  /** Its middle, on the road's centre line. */
  x: number
  y: number
  along: number
  /** The way the route travels through it (an axis). */
  dx: number
  dy: number
  /** Which kerb the gap for people is at: +1 left of travel, -1 right. */
  side: number
  /** What stops cars: the road and both verges. */
  car: Rect
  /** What stops people: all of it but the gap. */
  walk: Rect[]
  /** The gap people squeeze through, and the gate's padlock. */
  gap: { x: number; y: number }
  lock: { x: number; y: number }
}

/** Half the width a roadblock spans across the road (m): the road is 12 m kerb to kerb, the rest is verge. */
export const BLOCK_HALF_WIDTH = 12
/** Half its depth along the road (m). */
export const BLOCK_DEPTH: Readonly<Record<RoadblockKind, number>> = { wreck: 1.6, police: 1.1, gate: 0.35 }
/** The gap people use, across the road from its centre line (m); a car (1.8 m and wider) does not fit. */
const GAP_FROM = 6.1
const GAP_TO = 7.3
/** No roadblock this near the destination or another roadblock, along the route (m). */
const NEAR_END = 140
const SPACING = 90

const round = (n: number) => Number(n.toFixed(2))

/** A rect from road-frame bounds: `a0..a1` along the route, `l0..l1` across it (left of travel positive). */
function frameRect(cx: number, cy: number, dx: number, dy: number, a0: number, a1: number, l0: number, l1: number): Rect {
  // Left of travel is (dy, -dx) in plan space (y south).
  const xs = [cx + dx * a0 + dy * l0, cx + dx * a1 + dy * l1]
  const ys = [cy + dy * a0 - dx * l0, cy + dy * a1 - dx * l1]
  return [round(Math.min(xs[0]!, xs[1]!)), round(Math.min(ys[0]!, ys[1]!)), round(Math.max(xs[0]!, xs[1]!)), round(Math.max(ys[0]!, ys[1]!))]
}

const cache = new Map<string, Roadblock[]>()

/** The route's roadblocks, nearest town first. */
export function roadblocksOf(plan: WayOutPlan, t: Pick<WayOutTuning, "roadblocks">): Roadblock[] {
  const n = Math.max(0, Math.min(4, Math.round(t.roadblocks)))
  const key = `${plan.key}:${n}`
  const hit = cache.get(key)
  if (hit) return hit
  const out: Roadblock[] = []
  const len = plan.distance
  const start = Math.min(len - NEAR_END, Math.max(plan.soldier.along + 140, len * 0.3))
  const end = Math.max(start, len - NEAR_END - 80)
  const taken = [plan.sign.along, plan.soldier.along]
  for (let i = 0; i < n; i++) {
    let along = straightAt(plan.route, start + ((end - start) * (i + 0.5)) / n)
    while (taken.some((a) => Math.abs(a - along) < SPACING) && along + 96 <= len - NEAR_END) along += 96
    if (taken.some((a) => Math.abs(a - along) < SPACING) || along > len - NEAR_END + 1) continue
    taken.push(along)
    const p = alongRoute(plan.route, along)
    const roll = hash01(`rb:${plan.key}:${i}`)
    const kind: RoadblockKind = roll < 0.4 ? "gate" : roll < 0.75 ? "wreck" : "police"
    const side = hash01(`rbside:${plan.key}:${i}`) < 0.5 ? 1 : -1
    const d = BLOCK_DEPTH[kind]
    const W = BLOCK_HALF_WIDTH
    const walk =
      side > 0
        ? [frameRect(p.x, p.y, p.dx, p.dy, -d, d, -W, GAP_FROM), frameRect(p.x, p.y, p.dx, p.dy, -d, d, GAP_TO, W)]
        : [frameRect(p.x, p.y, p.dx, p.dy, -d, d, -W, -GAP_TO), frameRect(p.x, p.y, p.dx, p.dy, -d, d, -GAP_FROM, W)]
    const mid = (side * (GAP_FROM + GAP_TO)) / 2
    out.push({
      index: out.length,
      kind,
      x: p.x,
      y: p.y,
      along,
      dx: p.dx,
      dy: p.dy,
      side,
      car: frameRect(p.x, p.y, p.dx, p.dy, -d, d, -W, W),
      walk,
      gap: { x: round(p.x + p.dy * mid), y: round(p.y - p.dx * mid) },
      // The gate's padlock hangs where its two leaves meet, on the town side.
      lock: { x: round(p.x - p.dx * (d + 0.25)), y: round(p.y - p.dy * (d + 0.25)) },
    })
  }
  out.sort((a, b) => a.along - b.along)
  out.forEach((b, i) => (b.index = i))
  if (cache.size > 32) cache.delete(cache.keys().next().value!)
  cache.set(key, out)
  return out
}
