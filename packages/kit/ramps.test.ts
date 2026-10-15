import { describe, expect, test } from "bun:test"
import { curveTable, curveText, gradientTable, gradientText, parseCurve, parseGradient, sameCurve, sampleTable } from "./ramps"

describe("ramps", () => {
  test("curve text is knobs' normalized points, and parses back", () => {
    const text = curveText([{ x: 1, y: 0 }, { x: 0.2, y: 0.5 }, { x: 0.01, y: 1 }])
    expect(JSON.parse(text)).toEqual([{ x: 0, y: 1 }, { x: 0.2, y: 0.5 }, { x: 1, y: 0 }])
    expect(parseCurve(text, [])).toEqual([{ x: 0, y: 1 }, { x: 0.2, y: 0.5 }, { x: 1, y: 0 }])
    expect(parseCurve("[1,2]", [{ x: 0, y: 0 }])).toEqual([{ x: 0, y: 0 }])
    expect(parseCurve(undefined, [])).toEqual([])
  })
  test("gradient text holds oklch stops; a white ramp samples to exactly 1", () => {
    const text = gradientText([{ at: 0, color: "#ffffff" }, { at: 1, color: "#fff" }])
    const stops = parseGradient(text, [])
    expect(stops).toHaveLength(2)
    expect(stops[0]!.color.startsWith("oklch(")).toBe(true)
    const table = gradientTable(stops)
    for (const v of table) expect(Math.abs(v - 1)).toBeLessThan(1e-4)
  })
  test("tables sample linearly between their entries and clamp outside 0…1", () => {
    const table = curveTable([{ x: 0, y: 0 }, { x: 1, y: 2 }], "linear", 3)
    expect([...table]).toEqual([0, 1, 2])
    expect(sampleTable(table, 0.25)).toBeCloseTo(0.5)
    expect(sampleTable(table, -1)).toBe(0)
    expect(sampleTable(table, 9)).toBe(2)
    expect(sampleTable(table, Number.NaN)).toBe(0)
    const rgb = new Float32Array([0, 1, 2, 1, 2, 3])
    expect(sampleTable(rgb, 0.5, 3, 2)).toBeCloseTo(2.5)
  })
  test("sameCurve tolerates rounding but not a moved point", () => {
    const a = [{ x: 0, y: 1 }, { x: 1, y: 0 }]
    expect(sameCurve(a, [{ x: 0, y: 1.00001 }, { x: 1, y: 0 }])).toBe(true)
    expect(sameCurve(a, [{ x: 0, y: 0.9 }, { x: 1, y: 0 }])).toBe(false)
    expect(sameCurve(a, [...a, { x: 1, y: 0 }])).toBe(false)
  })
})
