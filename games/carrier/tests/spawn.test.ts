import { describe, expect, test } from "bun:test"
import { DRAFT } from "../shared/carrier-spec"
import { makeArchipelago, terrainHeight } from "../shared/islands"
import { SPAWN_RING, fleetSpawn } from "../shared/spawn"

describe("fleet spawn", () => {
  test("ships start spread around the map, in open water, facing inward", () => {
    for (const seed of [1, 7, 42, 2026, 0xdeadbeef, 95028]) {
      const arch = makeArchipelago(seed)
      const at = [0, 1].flatMap((team) => [0, 1].map((slot) => ({ team, ...fleetSpawn(arch, team, slot) })))
      for (let i = 0; i < at.length; i++) {
        const p = at[i]!
        expect(Math.hypot(p.x, p.z)).toBeGreaterThan(SPAWN_RING - 2600)
        expect(terrainHeight(arch, p.x, p.z)).toBeLessThan(-DRAFT - 5)
        // Bow toward the middle: heading points at the origin within a few degrees.
        const toward = Math.atan2(-p.x, p.z)
        const d = Math.atan2(Math.sin(p.heading - toward), Math.cos(p.heading - toward))
        expect(Math.abs(d)).toBeLessThan(0.05)
        for (let j = i + 1; j < at.length; j++) {
          const q = at[j]!
          const gap = Math.hypot(p.x - q.x, p.z - q.z)
          expect(gap).toBeGreaterThan(p.team === q.team ? 1200 : 6000)
        }
      }
    }
  })

  test("deterministic per world", () => {
    const a = makeArchipelago(9)
    expect(fleetSpawn(a, 1, 0)).toEqual(fleetSpawn(makeArchipelago(9), 1, 0))
  })
})
