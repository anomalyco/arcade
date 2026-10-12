import { describe, expect, test } from "bun:test"
import { PLAYER_RADIUS } from "../shared/config"
import { distToRect } from "../shared/geom"
import { LIGHT_BUDGET } from "../shared/maps/builder"
import { layout } from "../shared/maps/layout"
import { generateOffice } from "../shared/maps/office"
import { Rng } from "../shared/rng"
import { Nav } from "../shared/sim/nav"

const SEEDS = Array.from({ length: 40 }, (_, i) => i * 7919 + 13)

/** Corridor shape of a floor: share of cells, dead ends, and loops bigger than a 2x2 knot of corridor cells. */
function corridorStats(seed: number) {
  const p = layout(new Rng(seed))
  const c = (x: number, y: number) => x >= 0 && y >= 0 && x < p.gw && y < p.gh && p.zone[y * p.gw + x] === 0
  let cells = 0
  let links = 0
  let deadEnds = 0
  let knots = 0
  for (let y = 0; y < p.gh; y++)
    for (let x = 0; x < p.gw; x++) {
      if (!c(x, y)) continue
      cells++
      if (c(x + 1, y)) links++
      if (c(x, y + 1)) links++
      if (c(x + 1, y) && c(x, y + 1) && c(x + 1, y + 1)) knots++
      if ([c(x + 1, y), c(x - 1, y), c(x, y + 1), c(x, y - 1)].filter(Boolean).length === 1) deadEnds++
    }
  // Corridors are one connected network, so independent cycles = links - cells + 1.
  return { share: cells / (p.gw * p.gh), deadEnds, loops: links - cells + 1 - knots }
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
    expect((performance.now() - t) / 10).toBeLessThan(100)
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
    test(`floor ${seed}: a big connected labyrinth with spread spawns and sparse lights`, () => {
      const m = generateOffice(seed)
      expect(m.size[0]).toBeGreaterThan(95)
      expect(m.size[1]).toBeGreaterThan(65)

      const nav = new Nav(m)
      expect(m.spawns.length).toBeGreaterThanOrEqual(24)
      const reach = nav.reachable(m.spawns[0]!)
      const solids = [...m.walls.map((w) => w.rect), ...m.windows, ...m.glass, ...m.props.filter((p) => p.solid).map((p) => p.rect)]
      for (const s of m.spawns) {
        expect(nav.inMask(reach, s)).toBe(true)
        expect(solids.every((r) => distToRect(s.x, s.y, r) >= PLAYER_RADIUS)).toBe(true)
      }
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
      expect(m.lights.some((l) => l.kind === "exit")).toBe(true)
      expect(m.lights.some((l) => l.kind === "vending")).toBe(true)
      // Mostly dark: lit floor (light discs at half radius) covers well under half the floor.
      const lit = m.lights.reduce((s, l) => s + Math.PI * (l.r / 2) ** 2, 0)
      expect(lit / (m.size[0] * m.size[1])).toBeLessThan(0.35)

      const c = corridorStats(seed)
      expect(c.share).toBeGreaterThan(0.18)
      expect(c.deadEnds).toBeGreaterThanOrEqual(4)
      expect(c.loops).toBeGreaterThanOrEqual(3)
    })
  }
})
