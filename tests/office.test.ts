import { describe, expect, test } from "bun:test"
import { MAX_LIGHTS } from "../shared/config"
import { generateOffice } from "../shared/maps/office"
import { Nav } from "../shared/sim/nav"

const SEEDS = Array.from({ length: 40 }, (_, i) => i * 7919 + 13)

describe("procedural office", () => {
  test("is deterministic", () => {
    expect(JSON.stringify(generateOffice(1234))).toBe(JSON.stringify(generateOffice(1234)))
    expect(JSON.stringify(generateOffice(1234))).not.toBe(JSON.stringify(generateOffice(1235)))
  })

  test("generates quickly", () => {
    const t = performance.now()
    for (const s of SEEDS.slice(0, 10)) generateOffice(s)
    expect((performance.now() - t) / 10).toBeLessThan(60)
  })

  for (const seed of SEEDS) {
    test(`floor ${seed}: spawns spread out and connected, lights fit`, () => {
      const m = generateOffice(seed)
      const nav = new Nav(m)
      expect(m.spawns.length).toBe(12)
      const reach = nav.reachable(m.spawns[0]!)
      for (const s of m.spawns) expect(nav.inMask(reach, s)).toBe(true)
      expect(m.lights.length).toBeLessThanOrEqual(MAX_LIGHTS - 8)
      m.lights.forEach((l, i) => expect(l.id).toBe(i))
      expect(m.lights.some((l) => l.kind === "exit")).toBe(true)
      expect(m.lights.some((l) => l.kind === "vending")).toBe(true)
    })
  }
})
