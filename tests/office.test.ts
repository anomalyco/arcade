import { describe, expect, test } from "bun:test"
import { PLAYER_RADIUS } from "../shared/config"
import { distToRect } from "../shared/geom"
import { LIGHT_BUDGET } from "../shared/maps/builder"
import { type Plan, contact, counted, entrances, layout } from "../shared/maps/layout"
import { generateOffice } from "../shared/maps/office"
import { Rng } from "../shared/rng"
import { Nav } from "../shared/sim/nav"

const SEEDS = Array.from({ length: 40 }, (_, i) => i * 7919 + 13)
const plans = new Map(SEEDS.map((s) => [s, layout(new Rng(s))]))

/** Independent cycles through corridors and walk-in openings: a ring, linked spines, rooms with two ways in. */
function loops(p: Plan): number {
  const nodes = p.corridors.length + p.rooms.filter((r) => r.kind !== "shaft").length
  let edges = 0
  p.corridors.forEach((a, i) => p.corridors.forEach((b, j) => j > i && contact(a, b) && edges++))
  // Several openings between the same two zones are one way through, unless they're far apart.
  const seen: { a: number; b: number; x: number; y: number }[] = []
  for (const o of p.openings) {
    if (o.kind === "glass") continue
    const x = (o.x0 + o.x1) / 2
    const y = (o.y0 + o.y1) / 2
    if (seen.some((s) => ((s.a === o.a && s.b === o.b) || (s.a === o.b && s.b === o.a)) && Math.hypot(s.x - x, s.y - y) < 6)) continue
    seen.push({ a: o.a, b: o.b, x, y })
    edges++
  }
  return edges - nodes + 1
}

/** A thumbnail of the plan: what's under each cell of a 24 by 16 grid (outside, corridor, open area, core, room). */
function thumb(p: Plan): number[] {
  const OPEN = new Set(["hall", "cafe", "demo", "atrium", "foyer"])
  const CORE = new Set(["core", "shaft", "stair", "bathroom"])
  const out: number[] = []
  for (let j = 0; j < 16; j++)
    for (let i = 0; i < 24; i++) {
      const x = ((i + 0.5) / 24) * p.W
      const y = ((j + 0.5) / 16) * p.H
      const inside = (r: readonly number[]) => x >= r[0]! && x < r[2]! && y >= r[1]! && y < r[3]!
      const room = p.rooms.find((r) => inside(r.rect))
      out.push(p.voids.some(inside) ? 0 : p.corridors.some(inside) ? 1 : !room ? 4 : OPEN.has(room.kind) ? 2 : CORE.has(room.kind) ? 3 : 4)
    }
  return out
}

/** Share of thumbnail cells that differ between two plans, the closer of the four ways round. */
function apart(a: number[], b: number[]): number {
  let best = 1
  for (const mx of [false, true])
    for (const my of [false, true]) {
      let n = 0
      for (let k = 0; k < a.length; k++) {
        const i = k % 24
        const j = Math.floor(k / 24)
        if (a[k] !== b[(my ? 15 - j : j) * 24 + (mx ? 23 - i : i)]) n++
      }
      best = Math.min(best, n / a.length)
    }
  return best
}

/** Share of walkable cells more than 3.5 m (by grid steps) from anything solid. */
function bare(nav: Nav): number {
  const d = new Int32Array(nav.grid.length).fill(-1)
  const queue: number[] = []
  for (let i = 0; i < nav.grid.length; i++) if (nav.grid[i]) (d[i] = 0, queue.push(i))
  for (let h = 0; h < queue.length; h++) {
    const c = queue[h]!
    for (const n of [c + 1, c - 1, c + nav.w, c - nav.w]) {
      if (n < 0 || n >= nav.grid.length || d[n] >= 0 || Math.abs((n % nav.w) - (c % nav.w)) > 1) continue
      d[n] = d[c]! + 1
      queue.push(n)
    }
  }
  let free = 0
  let far = 0
  for (let i = 0; i < nav.grid.length; i++) if (!nav.grid[i]) (free++, d[i]! > 7 && far++)
  return far / free
}

describe("procedural office", () => {
  test("is deterministic", () => {
    expect(JSON.stringify(generateOffice(1234))).toBe(JSON.stringify(generateOffice(1234)))
    expect(JSON.stringify(generateOffice(1234))).not.toBe(JSON.stringify(generateOffice(1235)))
  })

  test("generates quickly", () => {
    generateOffice(1)
    const t = performance.now()
    for (const s of SEEDS.slice(0, 10)) generateOffice(s)
    expect((performance.now() - t) / 10).toBeLessThan(30)
  })

  test("makes many kinds of floor", () => {
    const all = [...plans.values()]
    expect(new Set(all.map((p) => p.archetype)).size).toBeGreaterThanOrEqual(6)
    // Plates other than a plain rectangle: L, T, U and H wings, notches, cut corners, light wells.
    const shapes = new Set(all.flatMap((p) => p.tags.filter((t) => ["L", "T", "U", "H", "notchN", "notchS", "corners", "courtyard"].includes(t))))
    expect(shapes.size).toBeGreaterThanOrEqual(5)
    expect(all.filter((p) => p.voids.length).length / all.length).toBeGreaterThan(0.25)
    // Zone templates: every one turns up somewhere.
    const zones = new Set(all.flatMap((p) => p.tags))
    for (const t of ["rows", "hall", "rowhall", "cluster", "cafe", "server", "labs", "suite", "demo", "twincore", "island"]) expect(zones).toContain(t)
    // And no two floors share the same mix.
    const mixes = new Set(all.map((p) => `${p.archetype} ${p.tags.join(" ")}`))
    expect(mixes.size).toBeGreaterThanOrEqual(all.length * 0.9)
  })

  test("floors look different from each other, even mirrored", () => {
    const thumbs = SEEDS.map((s) => thumb(plans.get(s)!))
    const d: number[] = []
    for (let a = 0; a < thumbs.length; a++) for (let b = a + 1; b < thumbs.length; b++) d.push(apart(thumbs[a]!, thumbs[b]!))
    d.sort((x, y) => x - y)
    expect(d[0]!).toBeGreaterThan(0.1)
    expect(d[Math.floor(d.length * 0.05)]!).toBeGreaterThan(0.3)
  })

  test("rooms flow into each other: nearly all have two ways in", () => {
    let rooms = 0
    let multi = 0
    for (const p of plans.values()) {
      const mine = p.rooms.filter(counted)
      const two = mine.filter((r) => entrances(p, r.id) >= 2)
      if (mine.length >= 10) expect(two.length / mine.length).toBeGreaterThan(0.6)
      rooms += mine.length
      multi += two.length
      // The rooms left with one door are the ones you'd expect: toilets, stairs, closets, server rooms.
      const odd = mine.filter((r) => entrances(p, r.id) < 2 && !["bathroom", "stair", "closet", "server"].includes(r.kind))
      expect(odd.length).toBeLessThanOrEqual(2)
    }
    expect(multi / rooms).toBeGreaterThan(0.75)
  })

  test("bots path across the whole floor quickly", () => {
    const m = generateOffice(99)
    const nav = new Nav(m)
    const far = [...m.spawns].sort((a, b) => a.x + a.y - (b.x + b.y))
    const t = performance.now()
    for (let k = 0; k < 20; k++) expect(nav.path(far[k % 4]!, far[far.length - 1 - (k % 4)]!)).not.toBeNull()
    expect((performance.now() - t) / 20).toBeLessThan(15)
  })

  for (const seed of SEEDS) {
    test(`floor ${seed}: a believable connected office with spread spawns and sparse lights`, () => {
      const m = generateOffice(seed)
      expect(m.size[0]).toBeGreaterThanOrEqual(45)
      expect(m.size[0]).toBeLessThanOrEqual(60)
      expect(m.size[1]).toBeGreaterThanOrEqual(32)
      expect(m.size[1]).toBeLessThanOrEqual(42)

      const nav = new Nav(m)
      expect(m.spawns.length).toBeGreaterThanOrEqual(12)
      const reach = nav.reachable(m.spawns[0]!)
      const solids = [...m.walls.map((w) => w.rect), ...m.windows, ...m.glass, ...m.props.filter((p) => p.solid).map((p) => p.rect)]
      for (const s of m.spawns) {
        expect(nav.inMask(reach, s)).toBe(true)
        expect(solids.every((r) => distToRect(s.x, s.y, r) >= PLAYER_RADIUS)).toBe(true)
        expect((m.voids ?? []).some((v) => s.x > v[0] && s.x < v[2] && s.y > v[1] && s.y < v[3])).toBe(false)
      }
      // Spread out: no two spawns within 5 m.
      for (const a of m.spawns) for (const b of m.spawns) if (a !== b) expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(5)
      // Nearly every walkable cell is reachable: no rooms sealed off by furniture.
      let free = 0
      let reached = 0
      for (let i = 0; i < nav.grid.length; i++) {
        if (nav.grid[i]) continue
        free++
        if (reach[i]) reached++
      }
      expect(reached / free).toBeGreaterThan(0.97)
      // No huge empty floor: almost all of it is within a few metres of a wall or something to hide behind.
      expect(bare(nav)).toBeLessThan(0.04)

      expect(m.lights.length).toBeLessThanOrEqual(LIGHT_BUDGET)
      m.lights.forEach((l, i) => expect(l.id).toBe(i))
      expect(m.lights.length).toBeGreaterThanOrEqual(10)
      expect(m.lights.length).toBeLessThanOrEqual(34)
      // Mostly dark: lit floor (light discs at half radius) covers well under half the floor.
      const lit = m.lights.reduce((s, l) => s + Math.PI * (l.r / 2) ** 2, 0)
      expect(lit / (m.size[0] * m.size[1])).toBeLessThan(0.4)

      // A service core: lift shafts and a fire stair with its EXIT sign.
      expect(m.walls.some((w) => w.style === "core")).toBe(true)
      expect(m.lights.some((l) => l.kind === "exit")).toBe(true)
      expect(m.props.some((p) => p.kind === "exitdoor")).toBe(true)

      const p = plans.get(seed)!
      // Straight corridors of one width (where there are corridors at all), few dead ends, and ways round.
      if (p.corridors.length) {
        const widths = p.corridors.map((c) => Math.min(c[2] - c[0], c[3] - c[1]))
        for (const w of widths) {
          expect(w).toBeCloseTo(widths[0]!, 5)
          expect(w).toBeGreaterThan(2.1 - 1e-6)
          expect(w).toBeLessThan(2.7 + 1e-6)
        }
        const lengths = p.corridors.map((c) => Math.max(c[2] - c[0], c[3] - c[1]))
        const total = lengths.reduce((s, l) => s + l, 0)
        expect(lengths.filter((l) => l >= 9).reduce((s, l) => s + l, 0) / total).toBeGreaterThan(0.85)
        expect(Math.max(...lengths)).toBeGreaterThan(25)
      } else expect(p.archetype).toBe("open")
      expect(p.ends.length).toBeLessThanOrEqual(4)
      expect(loops(p)).toBeGreaterThanOrEqual(p.archetype === "open" ? 3 : 6)
      // Rooms on the planning grid don't overlap each other, the corridors or the outside, and fill the floor.
      const zones = [...p.rooms.map((r) => r.rect), ...p.corridors, ...p.voids]
      expect(zones.reduce((s, z) => s + (z[2] - z[0]) * (z[3] - z[1]), 0)).toBeCloseTo(p.W * p.H, 0)
      for (let a = 0; a < zones.length; a++)
        for (let b = a + 1; b < zones.length; b++) {
          const [x, y] = [zones[a]!, zones[b]!]
          expect(x[0] < y[2] - 1e-3 && x[2] > y[0] + 1e-3 && x[1] < y[3] - 1e-3 && x[3] > y[1] + 1e-3).toBe(false)
        }
    })
  }
})
