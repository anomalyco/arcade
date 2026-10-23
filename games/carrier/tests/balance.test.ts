import { describe, expect, test } from "bun:test"
import { FLEET } from "../shared/fleet"
import { WEAPONS } from "../shared/weapons"
import { type MatchSpec, runMatch } from "../scripts/balance/match"
import { degenerate, rate, stat, summarize } from "../scripts/balance/metrics"
import { applyOverrides, overridesOfJson, parseOverride, parseSweep } from "../scripts/balance/tunables"

const spec = (s: Partial<MatchSpec>): MatchSpec => ({ seed: 3, variant: "test", ships: 4, crew: ["helm", "hornet", "f35", "ciws-port"], minutes: 2, base: {}, sides: [], overrides: [], ...s })
const strip = <T extends { speed?: number }>(r: T): Omit<T, "speed"> => {
  const { speed: _, ...rest } = r
  return rest
}

describe("balance simulator", () => {
  test("a match is deterministic per seed", () => {
    const a = runMatch(spec({}))
    const b = runMatch(spec({}))
    expect(JSON.stringify(strip(b))).toBe(JSON.stringify(strip(a)))
    // Something happened: the jets flew and the carriers sailed for the zone.
    expect(a.sorties.hornet + a.sorties.f35).toBeGreaterThanOrEqual(8)
    expect(a.timeline.length).toBeGreaterThan(3)
    const c = runMatch(spec({ seed: 4 }))
    expect(JSON.stringify(strip(c))).not.toBe(JSON.stringify(strip(a)))
  }, 60_000)

  test("a short match plays to its target", () => {
    const r = runMatch(spec({ ships: 2, crew: ["helm", "hornet"], minutes: 8, rules: { target: 30, capture: 5 } }))
    expect(r.ended).toBe(true)
    expect(r.winner).toBeGreaterThanOrEqual(0)
    expect(Math.max(...r.scores)).toBeGreaterThanOrEqual(30)
    expect(r.zoneHold[r.winner]).toBeGreaterThan(10)
    expect(r.captures.reduce((a, b) => a + b, 0)).toBeGreaterThan(0)
    const s = summarize("short", [r])
    expect(s.ended.p).toBe(1)
    expect(degenerate(s)).not.toContain("no zone was ever captured")
  }, 60_000)

  test("overrides apply to the shared tunables and restore", () => {
    const bomb = FLEET.bomb
    const g = WEAPONS.missile.maxG
    const undo = applyOverrides([parseOverride("FLEET.bomb=60"), parseOverride("WEAPONS.missile.maxG=30"), parseOverride("OPS.hornet.recharge=12")])
    expect(FLEET.bomb as number).toBe(60)
    expect(WEAPONS.missile.maxG as number).toBe(30)
    undo()
    expect(FLEET.bomb).toBe(bomb)
    expect(WEAPONS.missile.maxG).toBe(g)
    expect(() => applyOverrides([parseOverride("FLEET.nope=1")])).toThrow()
    expect(() => applyOverrides([parseOverride("NOPE.x=1")])).toThrow()
    expect(() => parseOverride("FLEET.bomb")).toThrow()
    expect(parseSweep("FLEET.bomb=60,80").map((o) => o.value)).toEqual([60, 80])
    expect(overridesOfJson({ FLEET: { bomb: 70 }, "WEAPONS.gun.damage": 3 })).toEqual([
      { path: "FLEET.bomb", value: 70 },
      { path: "WEAPONS.gun.damage", value: 3 },
    ])
  })

  test("statistics", () => {
    const s = stat([1, 2, 3, 4])
    expect(s.mean).toBe(2.5)
    expect(s.ci).toBeCloseTo((3.182 * Math.sqrt(5 / 3)) / 2, 6)
    const r = rate(5, 10)
    expect(r.p).toBe(0.5)
    expect(r.lo).toBeCloseTo(0.2366, 3)
    expect(r.hi).toBeCloseTo(0.7634, 3)
  })
})
