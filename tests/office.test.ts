import { describe, expect, test } from "bun:test"
import { MAX_LIGHTS, PLAYER_RADIUS } from "../shared/config"
import { rectCenter } from "../shared/geom"
import { generateOffice } from "../shared/maps/office"
import { lightAt } from "../shared/sim/light"
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
    test(`floor ${seed}: spawns, doors and breakers are reachable; spawns are dark; lights fit`, () => {
      const m = generateOffice(seed)
      const nav = new Nav(m)
      expect(m.spawns.length).toBe(10)
      expect(m.spawns.filter((s) => s.x < m.size[0] / 2).length).toBe(5)
      const reach = nav.reachable(m.spawns[0]!)
      for (const s of m.spawns) expect(nav.inMask(reach, s)).toBe(true)

      // Both sides of every door are walkable and connected, so every room can be entered.
      for (const d of m.doors) {
        const c = rectCenter(d.rect)
        const horizontal = d.rect[2] - d.rect[0] > d.rect[3] - d.rect[1]
        for (const k of [-0.7, 0.7]) {
          const p = horizontal ? { x: c.x, y: c.y + k } : { x: c.x + k, y: c.y }
          expect({ seed, door: d.id, side: k, ok: nav.walkable(p) && nav.inMask(reach, p) }).toEqual({ seed, door: d.id, side: k, ok: true })
        }
      }
      for (const b of m.breakers) {
        const near = [0, 1, 2, 3].map((i) => ({ x: b.x + Math.cos((i * Math.PI) / 2) * 0.5, y: b.y + Math.sin((i * Math.PI) / 2) * 0.5 }))
        expect(near.some((p) => nav.walkable(p) && nav.inMask(reach, p))).toBe(true)
      }

      const occ = [...m.walls.map((w) => w.rect), ...m.doors.filter((d) => !m.openDoors.includes(d.id)).map((d) => d.rect)]
      const lights = m.lights.map((l) => ({ x: l.x, y: l.y, r: l.r, power: l.power, cone: l.cone }))
      for (const s of m.spawns) expect(lightAt(s.x, s.y, lights, occ)).toBeLessThan(0.3)

      expect(m.lights.length).toBeLessThanOrEqual(MAX_LIGHTS - 8)
      m.lights.forEach((l, i) => expect(l.id).toBe(i))
      expect(m.lights.some((l) => l.kind === "exit")).toBe(true)
      expect(m.lights.some((l) => l.kind === "vending")).toBe(true)
      expect(m.breakers.length).toBe(1)
      void PLAYER_RADIUS
    })
  }
})
