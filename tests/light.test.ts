import { describe, expect, test } from "bun:test"
import { clearLine, rayRect } from "../shared/geom"
import { type LampState, flicker, intensityAt, lampPower, lightAt } from "../shared/sim/light"
import { testMap } from "./helpers"

describe("light model", () => {
  const omni = { x: 0, y: 0, r: 9, power: 1 }

  test("falls off to zero at the radius", () => {
    expect(intensityAt(omni, 0.1, 0)).toBeGreaterThan(0.9)
    expect(intensityAt(omni, 9.1, 0)).toBe(0)
  })

  test("walls cast shadows", () => {
    const wall = [[3, -1, 3.3, 1]] as const
    expect(lightAt(5, 0, [omni], wall)).toBe(0)
    expect(lightAt(5, 3, [omni], wall)).toBeGreaterThan(0)
  })

  test("spot cones only light ahead", () => {
    const spot = { ...omni, cone: [1, 0, 0.7] as const }
    expect(intensityAt(spot, 2, 0)).toBeGreaterThan(0.4)
    expect(intensityAt(spot, -2, 0)).toBe(0)
    expect(intensityAt(spot, 0, 2)).toBe(0)
  })

  test("broken, switched-off and EMP-dimmed lamps give nothing", () => {
    const def = testMap().lights[0]!
    const on: LampState = { broken: false, off: false, dimUntil: 0, failAt: 0 }
    expect(lampPower(def, on, 10)).toBeGreaterThan(0)
    expect(lampPower(def, { ...on, broken: true }, 10)).toBe(0)
    expect(lampPower(def, { ...on, off: true }, 10)).toBe(0)
    expect(lampPower(def, { ...on, dimUntil: 20 }, 10)).toBe(0)
  })

  test("flicker is deterministic, so server and client agree", () => {
    for (let t = 0; t < 30; t += 0.37) expect(flicker(4, 2, t)).toBe(flicker(4, 2, t))
    const samples = Array.from({ length: 600 }, (_, i) => flicker(4, 2, i * 0.05))
    expect(samples.some((v) => v < 0.5)).toBe(true)
    expect(samples.some((v) => v === 1)).toBe(true)
  })

  test("ray and line helpers", () => {
    expect(rayRect(0, 0, 1, 0, [3, -1, 4, 1], 10)).toBeCloseTo(3)
    expect(rayRect(0, 0, 0, 1, [3, -1, 4, 1], 10)).toBe(Infinity)
    expect(clearLine(0, 0, 10, 0, [[4, -1, 5, 1]])).toBe(false)
    expect(clearLine(0, 0, 10, 0, [[4, 2, 5, 5]])).toBe(true)
  })
})
