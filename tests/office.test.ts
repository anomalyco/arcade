import { describe, expect, test } from "bun:test"
import { PLAYER_RADIUS } from "../shared/config"
import { distToRect } from "../shared/geom"
import { LIGHT_BUDGET } from "../shared/maps/builder"
import { type Plan, contact, layout } from "../shared/maps/layout"
import { generateOffice } from "../shared/maps/office"
import { Rng } from "../shared/rng"
import { Nav } from "../shared/sim/nav"

const SEEDS = Array.from({ length: 40 }, (_, i) => i * 7919 + 13)

/** Independent cycles through corridors and walk-in openings: a ring, linked spines or an open plan with several ways in. */
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

  test("makes every kind of floor plan", () => {
    const kinds = new Set(SEEDS.map((s) => layout(new Rng(s)).archetype))
    expect([...kinds].sort()).toEqual(["atrium", "ring", "sidecore", "spine"])
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

      // Straight corridors of one width: long axis-aligned runs, few dead ends, and a way round.
      const p = layout(new Rng(seed))
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
      expect(p.ends.length).toBeLessThanOrEqual(4)
      expect(loops(p)).toBeGreaterThanOrEqual(1)
      // Rooms on the planning grid don't overlap.
      for (const a of p.rooms)
        for (const b of p.rooms) if (a.id < b.id) expect(a.rect[0] < b.rect[2] - 1e-3 && a.rect[2] > b.rect[0] + 1e-3 && a.rect[1] < b.rect[3] - 1e-3 && a.rect[3] > b.rect[1] + 1e-3).toBe(false)
    })
  }
})
