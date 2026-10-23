import { describe, expect, test } from "bun:test"
import { Particles } from "./fx/particles"
import { WoodFx, woodControls, woodDefaults } from "./fx/wood"

const DT = 1 / 60

describe("wood fx", () => {
  test("chips out of a kerf fly, bounce and come to rest on the ground, where they stay", () => {
    const fx = new WoodFx(woodDefaults(), 500)
    const pool = new Particles()
    for (let i = 0; i < 30; i++) fx.kerf(pool, DT, "t", 0, 0.55, 0, 1, 0)
    expect(fx.liveCount).toBeGreaterThan(20)
    expect(pool.count).toBeGreaterThan(10)
    for (let i = 0; i < 60 * 4; i++) fx.step(DT)
    const live = fx.chips.filter((c) => c.live)
    expect(live.every((c) => c.rest >= 0 && c.y === 0)).toBe(true)
    // They landed off to the side of the cut, not where the saw points.
    const meanZ = live.reduce((a, c) => a + c.z, 0) / live.length
    expect(Math.abs(meanZ)).toBeGreaterThan(0.3)
    const at = live.map((c) => [c.x, c.z])
    for (let i = 0; i < 60; i++) fx.step(DT)
    expect(fx.chips.filter((c) => c.live).map((c) => [c.x, c.z])).toEqual(at)
  })

  test("settled chips age out after their life, and the pool wraps oldest first", () => {
    const s = { ...woodDefaults(), woodChipLife: 1 }
    const fx = new WoodFx(s, 40)
    fx.splinters(0, 0.5, 0, 1, 0, 0.25)
    expect(fx.liveCount).toBe(Math.min(40, s.woodSplinters))
    for (let i = 0; i < 60 * 6; i++) fx.step(DT)
    expect(fx.liveCount).toBe(0)
    for (let i = 0; i < 10; i++) fx.chop(0, 1, 0, 1, 0)
    expect(fx.liveCount).toBe(40)
  })

  test("revving thickens the exhaust", () => {
    const fx = new WoodFx()
    const idle = new Particles()
    const rev = new Particles()
    for (let i = 0; i < 120; i++) {
      fx.exhaust(idle, DT, "idle", 0, 1, 0, 1, 0, 0)
      fx.exhaust(rev, DT, "rev", 0, 1, 0, 1, 0, 1)
    }
    expect(rev.count).toBeGreaterThan(idle.count * 2.5)
  })

  test("a heavier trunk raises more dust", () => {
    const fx = new WoodFx()
    const light = fx.landing(new Particles(), 0, 0, 1, 0, 12, 1.6, 0.5, 0.4)
    const heavy = fx.landing(new Particles(), 0, 0, 1, 0, 28, 2.8, 0.5, 1.4)
    expect(heavy).toBeGreaterThan(light * 2)
  })

  test("every setting has a knob", () => {
    expect(woodControls().map((c) => c.key).sort()).toEqual(Object.keys(woodDefaults()).sort())
  })
})
