import { type Vec, clearLine } from "../geom"
import type { MapDef } from "../maps"
import { type Nav, navFor } from "./nav"

/**
 * Where the modes put things on a floor, derived from the map alone (size, spawns, walls) so every floor the generator
 * makes gets them: two team ends at opposite ends of the long axis with spawn spots spread around their spawns, three
 * domination points along the axis, and two bomb sites toward the far (defending) end, spread across.
 */
export type Places = {
  /** Spawn anchors at each end, the low end of the long axis first. */
  ends: [Vec[], Vec[]]
  /** Up to a dozen spread-out spots around each end's anchors, for a whole team spawning at once. */
  slots: [Vec[], Vec[]]
  /** Map spawns on each half, for respawns in domination. */
  halves: [Vec[], Vec[]]
  /** Domination A (low end), B (middle), C (high end). */
  points: [Vec, Vec, Vec]
  /** Bomb sites A and B, both on the high end's side. */
  sites: [Vec, Vec]
  /** Hardpoint zones in the order they come up: the middle, then alternating ends and sides. */
  hills: Vec[]
  /** Capture the flag: each end's flag base, the low end first. */
  bases: [Vec, Vec]
}

const cache = new Map<string, Places>()

export function placesFor(map: MapDef): Places {
  let p = cache.get(map.id)
  if (!p) {
    p = compute(map)
    cache.set(map.id, p)
    if (cache.size > 4) cache.delete(cache.keys().next().value!)
  }
  return p
}

function compute(map: MapDef): Places {
  const nav = navFor(map)
  const horiz = map.size[0] >= map.size[1]
  const len = horiz ? map.size[0] : map.size[1]
  const wide = horiz ? map.size[1] : map.size[0]
  const along = (v: Vec) => (horiz ? v.x : v.y)
  const at = (u: number, c: number): Vec => (horiz ? { x: u * len, y: c * wide } : { x: c * wide, y: u * len })
  const solids = [...map.walls.map((w) => w.rect), ...map.windows, ...map.glass, ...map.props.filter((p) => p.solid).map((p) => p.rect)]
  const seed = map.spawns[0] ?? nav.nearest(at(0.5, 0.5))
  const reach = nav.reachable(seed)
  const spawns = map.spawns.filter((s) => nav.inMask(reach, s))
  const sorted = [...(spawns.length >= 2 ? spawns : map.spawns)].sort((a, b) => along(a) - along(b))
  const k = Math.max(2, Math.round(sorted.length / 4))
  const ends: [Vec[], Vec[]] = [sorted.slice(0, k), sorted.slice(-k).reverse()]
  const mid = sorted.length / 2
  const halves: [Vec[], Vec[]] = [sorted.slice(0, Math.max(1, Math.floor(mid))), sorted.slice(Math.ceil(mid)).reverse()]
  if (!halves[1].length) halves[1] = [sorted[sorted.length - 1]!]
  const slots = ends.map((anchors) => spread(nav, reach, anchors, solids)) as [Vec[], Vec[]]

  const taken: Vec[] = []
  // Each spot stays within its band of the long axis, so A, B and C keep their order and both sites the far half.
  const spot = (u: number, c: number, minGap: number, lo: number, hi: number): Vec => {
    const s = openSpot(nav, reach, at(u, c), len * 0.2, taken, minGap, (v) => along(v) >= lo * len && along(v) <= hi * len)
    taken.push(s)
    return s
  }
  const b = spot(0.5, 0.5, 0, 0.38, 0.62)
  const a = spot(0.2, 0.5, len * 0.22, 0, 0.36)
  const c = spot(0.8, 0.5, len * 0.22, 0.64, 1)
  taken.length = 0
  taken.push(...slots[1].slice(0, 3))
  const sa = spot(0.68, 0.22, 4, 0.56, 0.9)
  const sb = spot(0.68, 0.78, Math.min(12, wide * 0.4), 0.56, 0.9)
  taken.length = 0
  const hills = (
    [
      [0.5, 0.5],
      [0.27, 0.3],
      [0.73, 0.7],
      [0.33, 0.75],
      [0.67, 0.25],
    ] as const
  ).map(([u, c]) => spot(u, c, Math.min(10, len * 0.15), u - 0.14, u + 0.14))
  // Flag bases sit in the open near each end's spawns, a little in from the wall.
  const base = (end: Vec[], lo: number, hi: number): Vec => {
    const cx = end.reduce((s, v) => s + v.x, 0) / end.length
    const cy = end.reduce((s, v) => s + v.y, 0) / end.length
    return openSpot(nav, reach, { x: cx, y: cy }, Math.max(6, len * 0.12), [], 0, (v) => along(v) >= lo * len && along(v) <= hi * len)
  }
  const bases: [Vec, Vec] = [base(ends[0], 0, 0.22), base(ends[1], 0.78, 1)]
  return { ends, slots, halves, points: [a, b, c], sites: [sa, sb], hills, bases }
}

/** Spots around each anchor (the anchor, then rings at 1.3 m and 2.6 m), walkable, reachable, in sight, 1.1 m apart. */
function spread(nav: Nav, reach: Uint8Array, anchors: Vec[], solids: Parameters<typeof clearLine>[4]): Vec[] {
  const out: Vec[] = []
  for (const r of [0, 1.3, 2.6])
    for (const a of anchors)
      for (let i = 0; i < (r ? 8 : 1); i++) {
        const t = (i / 8) * Math.PI * 2 + r
        const v = { x: a.x + Math.cos(t) * r, y: a.y + Math.sin(t) * r }
        if (!nav.walkable(v) || !nav.inMask(reach, v) || !clearLine(a.x, a.y, v.x, v.y, solids)) continue
        if (out.some((o) => Math.hypot(o.x - v.x, o.y - v.y) < 1.1)) continue
        out.push(v)
        if (out.length >= 12) return out
      }
  return out.length ? out : anchors
}

/**
 * The most open reachable spot near `target`: candidates on a 1 m grid within `range` that pass `keep`, scored by how
 * much of a 2.5 m disc around them is walkable, less a little for the distance from the target, and at least `minGap`
 * from `taken`.
 */
function openSpot(nav: Nav, reach: Uint8Array, target: Vec, range: number, taken: Vec[], minGap: number, keep: (v: Vec) => boolean): Vec {
  let best: Vec | null = null
  let bs = -Infinity
  for (let y = target.y - range; y <= target.y + range; y += 1)
    for (let x = target.x - range; x <= target.x + range; x += 1) {
      const v = { x, y }
      const d = Math.hypot(x - target.x, y - target.y)
      if (d > range || !keep(v) || !nav.walkable(v) || !nav.inMask(reach, v)) continue
      if (taken.some((t) => Math.hypot(t.x - x, t.y - y) < minGap)) continue
      const s = openness(nav, v) * 12 - d * 0.5
      if (s > bs) {
        bs = s
        best = v
      }
    }
  return best ?? nav.nearest(target)
}

function openness(nav: Nav, v: Vec): number {
  let free = 0
  let all = 0
  for (let dy = -2.5; dy <= 2.5; dy += 0.5)
    for (let dx = -2.5; dx <= 2.5; dx += 0.5) {
      if (dx * dx + dy * dy > 6.25) continue
      all++
      if (nav.walkable({ x: v.x + dx, y: v.y + dy })) free++
    }
  return free / all
}
