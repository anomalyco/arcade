import type { Rect, Vec } from "../geom"
import { Rng } from "../rng"
import { Nav } from "../sim/nav"
import { Builder } from "./builder"
import { lots } from "./downtown-lots"
import { streets } from "./downtown-street"
import { type Block, type Junction, type Street, type Town, type Walk, SHOP_H, drive, rd } from "./downtown-town"
import { type Side, step, weighted } from "./geo"
import type { MapDef, Prop } from "./types"

export { SHOP_H, drive }

/** Block number for the HUD: "DOWNTOWN · BLK 07". */
export const blockOf = (seed: number) => 1 + (seed % 48)

/** A road cross-section: total asphalt width, travel lanes, parking lanes (0 none, 1 one side, 2 both). */
type Section = { w: number; lanes: number; park: number }
const SECTIONS: readonly (readonly [Section, number])[] = [
  [{ w: 7, lanes: 2, park: 0 }, 1.5],
  [{ w: 9.5, lanes: 2, park: 1 }, 3],
  [{ w: 12, lanes: 2, park: 2 }, 2.5],
  [{ w: 14, lanes: 4, park: 0 }, 1.4],
]
const PARK_W = 2.5
const SPAWNS = 18

type Axis = { e0: number; e1: number; roads: Section[]; blocks: number[]; size: number }

/** One axis of the street grid: edge strip, road, block, road, ..., road, edge strip. */
function axis(r: Rng, n: number, sw: number): Axis {
  for (let k = 0; ; k++) {
    const e0 = step(r, sw + 4, sw + 5.5, 0.5)
    const e1 = step(r, sw + 4, sw + 5.5, 0.5)
    // The ring road round the outside is the narrow kind; the streets through the middle are the wide ones.
    const roads = Array.from({ length: n + 1 }, (_, i) => (i === 0 || i === n ? SECTIONS[r.next() < 0.7 ? 0 : 1]![0] : k > 30 ? SECTIONS[r.int(2)]![0] : weighted(r, SECTIONS)))
    const blocks = Array.from({ length: n }, () => (n === 2 ? step(r, 19, 25, 0.5) : step(r, 15, 18, 0.5)))
    const size = e0 + e1 + roads.reduce((s, x) => s + x.w, 0) + blocks.reduce((s, x) => s + x, 0)
    if (size >= 62 && size <= 90) return { e0, e1, roads, blocks, size }
  }
}

/**
 * Procedural downtown at night from a seed: a grid of streets (some blocks merged into superblocks, a jogged
 * crossing, dead-end stubs closed off by hoardings) wrapped in a ring road, edge strips of tall buildings closing the
 * map. Blocks hold buildings cut by alleys with a few enterable shops, a plaza with a fountain and a subway entrance,
 * a fenced parking lot, a park; sidewalks carry lamps, signals, trees and street furniture; parked cars line the
 * wider roads. Every road keeps at least two clear 3.5 m lanes for vehicles, and the roads form loops.
 */
export function generateDowntown(seed: number): MapDef {
  const r = new Rng((seed ^ 0x5bd1e995) >>> 0)
  const sw = step(r, 2.5, 3.5, 0.5)
  const nx = r.next() < 0.6 ? 2 : 3
  const ny = nx === 3 ? 2 : r.next() < 0.65 ? 2 : 3
  const ax = axis(r, nx, sw)
  const ay = axis(r, ny, sw)
  const W = ax.size
  const H = ay.size
  const b = new Builder()
  const t: Town = { b, r, W, H, sw, streets: [], blocks: [], junctions: [], walks: [], taken: [], lit: [], shops: 0, curbs: [], vehicles: [] }

  // Road positions along each axis.
  const place = (a: Axis) => {
    const roads: { a: number; b: number; s: Section }[] = []
    const blocks: [number, number][] = []
    let u = a.e0
    a.roads.forEach((s, i) => {
      roads.push({ a: u, b: u + s.w, s })
      u += s.w
      if (i < a.blocks.length) {
        blocks.push([u, u + a.blocks[i]!])
        u += a.blocks[i]!
      }
    })
    return { roads, blocks }
  }
  const X = place(ax)
  const Y = place(ay)
  // Vertical road i in block row j may be jogged sideways: x offset per (i, j).
  const jog = (i: number, j: number) => jogs.get(i * 16 + j) ?? 0
  const jogs = new Map<number, number>()
  // Cells (block i, j) merged into superblocks: cell id -> block id.
  const cellBlock = new Map<number, number>()
  const cellRect = (i: number, j: number): Rect => [X.roads[i]!.b + jog(i, j), Y.roads[j]!.b, X.roads[i + 1]!.a + jog(i + 1, j), Y.roads[j + 1]!.a]
  const removedV = new Set<number>()
  const removedH = new Set<number>()
  const merged = new Set<number>()
  if (r.next() < 0.55) {
    const opts: (() => void)[] = []
    for (let i = 1; i < nx; i++)
      for (let j = 0; j < ny; j++)
        opts.push(() => {
          removedV.add(i * 16 + j)
          merged.add((i - 1) * 16 + j)
          merged.add(i * 16 + j)
        })
    for (let j = 1; j < ny; j++)
      for (let i = 0; i < nx; i++)
        opts.push(() => {
          removedH.add(j * 16 + i)
          merged.add(i * 16 + j - 1)
          merged.add(i * 16 + j)
        })
    if (opts.length) r.pick(opts)()
  }
  if (nx >= 2 && r.next() < 0.5) {
    const i = 1 + r.int(nx - 1)
    const j = r.int(ny)
    const d = (r.next() < 0.5 ? -1 : 1) * step(r, 2.5, 4.5, 0.5)
    const ok = !removedV.has(i * 16 + j) && !merged.has((i - 1) * 16 + j) && !merged.has(i * 16 + j) && X.blocks[i - 1]![1] - X.blocks[i - 1]![0] + d >= 13 && X.blocks[i]![1] - X.blocks[i]![0] - d >= 13
    if (ok) jogs.set(i * 16 + j, d)
  }

  // Streets: horizontal roads as spans (cut where a merge removed a piece), vertical segments between them.
  const L = X.roads[0]!.a
  const R = X.roads[nx]!.b
  const T = Y.roads[0]!.a
  const B = Y.roads[ny]!.b
  const parkSides = (s: Section): [number, number] => (s.park === 2 ? [PARK_W, PARK_W] : s.park === 1 ? (r.next() < 0.5 ? [PARK_W, 0] : [0, PARK_W]) : [0, 0])
  Y.roads.forEach((y, j) => {
    const cuts: [number, number][] = []
    for (let i = 0; i < nx; i++) if (removedH.has(j * 16 + i)) cuts.push([X.roads[i]!.b, X.roads[i + 1]!.a])
    let x = L
    const park = parkSides(y.s)
    for (const [c0, c1] of [...cuts, [R, R] as [number, number]]) {
      if (c0 - x > 0.5) t.streets.push({ rect: [x, y.a, c0, y.b], axis: "x", lanes: y.s.lanes, park, stub: false })
      x = c1
    }
  })
  X.roads.forEach((x, i) => {
    const park = parkSides(x.s)
    for (let j = 0; j < ny; j++) {
      if (removedV.has(i * 16 + j)) continue
      const d = jog(i, j)
      t.streets.push({ rect: [x.a + d, Y.roads[j]!.b, x.b + d, Y.roads[j + 1]!.a], axis: "y", lanes: x.s.lanes, park, stub: false })
    }
  })

  // Dead-end stubs out through the edge strips, closed at the map edge.
  const stubs: { rect: Rect; side: Side }[] = []
  const cand: (() => void)[] = []
  for (let i = 1; i < nx; i++) {
    const x = X.roads[i]!
    cand.push(() => stubs.push({ rect: [x.a + jog(i, 0), 0, x.b + jog(i, 0), T], side: "n" }))
    cand.push(() => stubs.push({ rect: [x.a + jog(i, ny - 1), B, x.b + jog(i, ny - 1), H], side: "s" }))
  }
  for (let j = 1; j < ny; j++) {
    const y = Y.roads[j]!
    cand.push(() => stubs.push({ rect: [0, y.a, L, y.b], side: "w" }))
    cand.push(() => stubs.push({ rect: [R, y.a, W, y.b], side: "e" }))
  }
  const nStubs = Math.min(cand.length, weighted(r, [[0, 1], [1, 2.2], [2, 1.3]] as const))
  for (let k = 0; k < nStubs; k++) cand.splice(r.int(cand.length), 1)[0]!()
  for (const s of stubs) {
    const sec = s.side === "n" || s.side === "s" ? X.roads.find((x) => Math.abs(x.b - x.a - (s.rect[2] - s.rect[0])) < 1e-6)!.s : Y.roads.find((y) => Math.abs(y.b - y.a - (s.rect[3] - s.rect[1])) < 1e-6)!.s
    t.streets.push({ rect: s.rect, axis: s.side === "n" || s.side === "s" ? "y" : "x", lanes: sec.lanes, park: [0, 0], stub: true, end: s.side })
  }

  // Blocks: grid cells, merged pairs as one.
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const id = i * 16 + j
      if (cellBlock.has(id)) continue
      let rc = cellRect(i, j)
      cellBlock.set(id, t.blocks.length)
      if (removedV.has((i + 1) * 16 + j)) {
        const o = cellRect(i + 1, j)
        rc = [rc[0], rc[1], o[2], rc[3]]
        cellBlock.set((i + 1) * 16 + j, t.blocks.length)
      } else if (removedH.has((j + 1) * 16 + i)) {
        const o = cellRect(i, j + 1)
        rc = [rc[0], rc[1], rc[2], o[3]]
        cellBlock.set(i * 16 + j + 1, t.blocks.length)
      }
      t.blocks.push({ rect: rc, lot: [rc[0] + sw, rc[1] + sw, rc[2] - sw, rc[3] - sw], kind: "buildings", big: merged.has(id) })
    }

  junctions(t)
  b.floor("asphalt", 0, 0, W, H)
  // Sidewalks round every block, and along the inner side of the edge strips (and the stubs).
  for (const k of t.blocks) {
    b.floor("sidewalk", ...k.rect)
    const [x0, y0, x1, y1] = k.rect
    t.walks.push({ rect: [x0, y0, x1, y0 + sw], curb: "n" }, { rect: [x0, y1 - sw, x1, y1], curb: "s" }, { rect: [x0, y0 + sw, x0 + sw, y1 - sw], curb: "w" }, { rect: [x1 - sw, y0 + sw, x1, y1 - sw], curb: "e" })
    t.curbs.push(k.rect)
  }
  edges(t, L, R, T, B, stubs)
  lots(t)
  streets(t)

  // Closing off: hoardings across the stubs at the map edge.
  for (const s of stubs) {
    const [x0, y0, x1, y1] = s.rect
    const pad = sw
    if (s.side === "n") b.wall(x0 - pad, 0, x1 + pad, 0.4, 2.4, "hoarding")
    else if (s.side === "s") b.wall(x0 - pad, H - 0.4, x1 + pad, H, 2.4, "hoarding")
    else if (s.side === "w") b.wall(0, y0 - pad, 0.4, y1 + pad, 2.4, "hoarding")
    else b.wall(W - 0.4, y0 - pad, W, y1 + pad, 2.4, "hoarding")
  }
  b.roads.push(...t.streets.map((s) => ({ rect: s.rect, axis: s.axis, lanes: s.lanes, park: s.park })))
  const nav = repair(b, t, seed)
  const map = { ...b.build({ kind: "downtown", id: `downtown-${seed}`, seed, name: `Downtown · BLK ${blockOf(seed)}`, size: [rd(W), rd(H)] }), vehicles: t.vehicles }
  b.spawns.push(...spawns(nav, r, t))
  return map
}

/** Where vertical streets meet horizontal ones: the box and which arms leave it. */
function junctions(t: Town): void {
  const E = 1e-6
  const map = new Map<string, Junction>()
  for (const v of t.streets) {
    if (v.axis !== "y") continue
    for (const h of t.streets) {
      if (h.axis !== "x") continue
      if (v.rect[0] < h.rect[0] - E || v.rect[2] > h.rect[2] + E) continue
      const above = Math.abs(v.rect[3] - h.rect[1]) < E
      const below = Math.abs(v.rect[1] - h.rect[3]) < E
      if (!above && !below) continue
      const box: Rect = [v.rect[0], h.rect[1], v.rect[2], h.rect[3]]
      const key = box.join(",")
      const j = map.get(key) ?? { rect: box, n: false, s: false, w: v.rect[0] - h.rect[0] > 1, e: h.rect[2] - v.rect[2] > 1 }
      if (above) j.n = true
      if (below) j.s = true
      map.set(key, j)
    }
  }
  // Horizontal stubs carry a horizontal road on past the ring: that junction gains an arm.
  for (const h of t.streets) {
    if (h.axis !== "x" || !h.stub) continue
    for (const j of map.values()) {
      if (Math.abs(j.rect[1] - h.rect[1]) > E || Math.abs(j.rect[3] - h.rect[3]) > E) continue
      if (Math.abs(h.rect[2] - j.rect[0]) < E) j.w = true
      if (Math.abs(h.rect[0] - j.rect[2]) < E) j.e = true
    }
  }
  t.junctions = [...map.values()]
}

/**
 * Edge strips: buildings all round the map behind a sidewalk facing the ring road, cut by any stubs (which get
 * sidewalks of their own).
 */
function edges(t: Town, L: number, R: number, T: number, B: number, stubs: { rect: Rect; side: Side }[]): void {
  const { b, sw, W, H } = t
  const walks: Walk[] = [
    { rect: [L - sw, T - sw, R + sw, T], curb: "s" },
    { rect: [L - sw, B, R + sw, B + sw], curb: "n" },
    { rect: [L - sw, T, L, B], curb: "e" },
    { rect: [R, T, R + sw, B], curb: "w" },
  ]
  for (const w of walks) {
    b.floor("sidewalk", ...w.rect)
    t.walks.push(w)
    t.curbs.push(w.rect)
  }
  // Stub sidewalks, and the corridors they cut through the strips.
  const cuts: Rect[] = []
  for (const s of stubs) {
    const [x0, y0, x1, y1] = s.rect
    const pair: Walk[] =
      s.side === "n"
        ? [{ rect: [x0 - sw, 0, x0, T - sw], curb: "e" }, { rect: [x1, 0, x1 + sw, T - sw], curb: "w" }]
        : s.side === "s"
          ? [{ rect: [x0 - sw, B + sw, x0, H], curb: "e" }, { rect: [x1, B + sw, x1 + sw, H], curb: "w" }]
          : s.side === "w"
            ? [{ rect: [0, y0 - sw, L - sw, y0], curb: "s" }, { rect: [0, y1, L - sw, y1 + sw], curb: "n" }]
            : [{ rect: [R + sw, y0 - sw, W, y0], curb: "s" }, { rect: [R + sw, y1, W, y1 + sw], curb: "n" }]
    for (const w of pair) {
      b.floor("sidewalk", ...w.rect)
      t.walks.push(w)
      t.curbs.push(w.rect)
    }
    cuts.push(s.side === "n" || s.side === "s" ? [x0 - sw, y0, x1 + sw, y1] : [x0, y0 - sw, x1, y1 + sw])
  }
  // The four strips of building land, minus the stub corridors. Each piece fronts the ring road (and a stub).
  const strips: { rect: Rect; front: Side }[] = [
    { rect: [0, 0, W, T - sw], front: "s" },
    { rect: [0, B + sw, W, H], front: "n" },
    { rect: [0, T - sw, L - sw, B + sw], front: "e" },
    { rect: [R + sw, T - sw, W, B + sw], front: "w" },
  ]
  for (const s of strips) {
    let pieces: Rect[] = [s.rect]
    for (const c of cuts) pieces = pieces.flatMap((p) => cutRect(p, c))
    for (const p of pieces) if (p[2] - p[0] > 0.5 && p[3] - p[1] > 0.5) t.blocks.push({ rect: p, lot: p, kind: "edge", front: s.front, big: false })
  }
}

/** Rect a minus rect c where c cuts straight across a (splits it into at most two). */
function cutRect(a: Rect, c: Rect): Rect[] {
  if (c[0] >= a[2] || c[2] <= a[0] || c[1] >= a[3] || c[3] <= a[1]) return [a]
  const out: Rect[] = []
  if (c[0] > a[0] && c[2] >= a[2] - 1e-6 && c[1] <= a[1] && c[3] >= a[3]) return [[a[0], a[1], c[0], a[3]]]
  if (c[1] <= a[1] + 1e-6 && c[3] >= a[3] - 1e-6) {
    if (c[0] > a[0]) out.push([a[0], a[1], c[0], a[3]])
    if (c[2] < a[2]) out.push([c[2], a[1], a[2], a[3]])
    return out
  }
  if (c[1] > a[1]) out.push([a[0], a[1], a[2], c[1]])
  if (c[3] < a[3]) out.push([a[0], c[3], a[2], a[3]])
  return out
}

// Checks and spawns ---------------------------------------------------------------------------------------------------

/** A sidewalk spot that is walkable, to flood the map from. */
function hub(nav: Nav, t: Town): Vec {
  for (const s of t.streets) {
    const v = { x: (s.rect[0] + s.rect[2]) / 2, y: (s.rect[1] + s.rect[3]) / 2 }
    if (nav.walkable(v)) return v
  }
  return nav.nearest({ x: t.W / 2, y: t.H / 2 })
}

/** Removes props and small cover that seal off pockets of open ground, until everything walkable is reachable. */
function repair(b: Builder, t: Town, seed: number): Nav {
  const COVER = new Set(["car", "dumpster", "planter", "barrier", "wreck"])
  for (let pass = 0; ; pass++) {
    const nav = new Nav(b.build({ kind: "downtown", id: `downtown-${seed}`, seed, name: "", size: [t.W, t.H] }))
    if (pass >= 5) return nav
    const reach = nav.reachable(hub(nav, t))
    const stuck: Vec[] = []
    const seen = new Uint8Array(nav.grid.length)
    for (let i = 0; i < nav.grid.length; i++) {
      if (nav.grid[i] || reach[i] || seen[i]) continue
      const comp = [i]
      seen[i] = 1
      for (let k = 0; k < comp.length; k++) {
        const c = comp[k]!
        for (const n of [c + 1, c - 1, c + nav.w, c - nav.w]) {
          if (n < 0 || n >= nav.grid.length || seen[n] || nav.grid[n] || reach[n]) continue
          if (Math.abs((n % nav.w) - (c % nav.w)) > 1) continue
          seen[n] = 1
          comp.push(n)
        }
      }
      if (comp.length >= 6) for (const c of comp) stuck.push({ x: ((c % nav.w) + 0.5) * 0.5, y: (Math.floor(c / nav.w) + 0.5) * 0.5 })
    }
    if (!stuck.length) return nav
    const near = (rc: Rect, d: number) => stuck.some((s) => s.x > rc[0] - d && s.x < rc[2] + d && s.y > rc[1] - d && s.y < rc[3] + d)
    const before = b.props.length + b.walls.length
    b.props = b.props.filter((q: Prop) => !q.solid || !near(q.rect, 1))
    if (b.props.length + b.walls.length === before) b.walls = b.walls.filter((w) => !(COVER.has(w.style) || w.style === "shelf" || w.style === "hedge" || w.style === "fence") || !near(w.rect, 1))
    if (b.props.length + b.walls.length === before) return nav
  }
}

/** Reachable spots off the roads, spread evenly by farthest-point sampling, away from walls. */
function spawns(nav: Nav, r: Rng, t: Town): Vec[] {
  const reach = nav.reachable(hub(nav, t))
  const onRoad = (x: number, y: number) => t.streets.some((s) => x > s.rect[0] - 0.3 && x < s.rect[2] + 0.3 && y > s.rect[1] - 0.3 && y < s.rect[3] + 0.3)
  const pool: Vec[] = []
  for (let cy = 2; cy < nav.h - 2; cy += 2)
    for (let cx = 2; cx < nav.w - 2; cx += 2) {
      const i = cy * nav.w + cx
      if (!reach[i] || nav.grid[i - 1] || nav.grid[i + 1] || nav.grid[i - nav.w] || nav.grid[i + nav.w]) continue
      const v = { x: (cx + 0.5) * 0.5, y: (cy + 0.5) * 0.5 }
      if (!onRoad(v.x, v.y) && !t.vehicles.some((q) => Math.hypot(q.x - v.x, q.y - v.y) < 3)) pool.push(v)
    }
  const out: Vec[] = [pool[r.int(pool.length)]!]
  const dist = pool.map((q) => Math.hypot(q.x - out[0]!.x, q.y - out[0]!.y))
  while (out.length < SPAWNS && out.length < pool.length) {
    let best = 0
    for (let k = 1; k < pool.length; k++) if (dist[k]! > dist[best]!) best = k
    const s = pool[best]!
    out.push(s)
    for (let k = 0; k < pool.length; k++) dist[k] = Math.min(dist[k]!, Math.hypot(pool[k]!.x - s.x, pool[k]!.y - s.y))
  }
  return out
}

export type { Block, Street, Town }
