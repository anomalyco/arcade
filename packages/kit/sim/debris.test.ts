import { describe, expect, test } from "bun:test"
import { DebrisObstacles, placeDebris, type DebrisRule } from "./debris"

const rules: DebrisRule[] = [
  { item: "leaf", group: "leaves", along: [{ box: { min: [0, 0], max: [6, 4] } }], offset: [0.05, 0.6], spacing: 0.8, chance: 0.7, cluster: { count: [2, 6], spread: 0.3 }, scale: [0.8, 1.2] },
  { item: "weed", group: "weeds", along: [{ line: [[-10, 10], [10, 10]] }], offset: [0, 0.4], side: 0, spacing: 1.5, scale: [0.6, 1], align: 0.3 },
]
const obstacles = new DebrisObstacles([{ circle: { c: [3, -0.5], r: 0.6 }, pad: 0.1 }, { box: { min: [-2, 9], max: [2, 11] } }])
const place = (leaves: number, weeds = 1) => placeDebris(rules, obstacles, { seed: 7, density: { leaves, weeds } })
const id = (d: { item: string; x: number; z: number }) => `${d.item}:${d.x.toFixed(5)},${d.z.toFixed(5)}`

describe("debris placement", () => {
  test("is deterministic", () => { expect(place(1)).toEqual(place(1)) })
  test("raising a density only adds items and never moves the placed ones", () => {
    const low = new Set(place(0.4).map(id)), mid = new Set(place(1).map(id)), high = new Set(place(2.5).map(id))
    expect(low.size).toBeGreaterThan(0)
    expect(mid.size).toBeGreaterThan(low.size)
    expect(high.size).toBeGreaterThan(mid.size)
    for (const k of low) expect(mid.has(k)).toBe(true)
    for (const k of mid) expect(high.has(k)).toBe(true)
  })
  test("one group's density leaves the other group untouched", () => {
    const weeds = (d: number) => place(d).filter(i => i.group === "weeds").map(id)
    expect(weeds(0.2)).toEqual(weeds(2))
  })
  test("zero density places nothing", () => { expect(place(0, 0)).toEqual([]) })
  test("box features collect outside the box, inside the offset band, clear of obstacles", () => {
    for (const d of place(2.5)) {
      expect(obstacles.clearance(d.x, d.z)).toBeGreaterThanOrEqual(0)
      if (d.item !== "leaf") continue
      const qx = Math.abs(d.x - 3) - 3, qz = Math.abs(d.z - 2) - 2
      const outside = Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0)
      expect(outside).toBeGreaterThan(-0.31)
      expect(outside).toBeLessThan(0.61 + 0.31)
    }
  })
  test("lines place on both sides when asked and align to the feature", () => {
    const weeds = place(1).filter(i => i.item === "weed")
    expect(weeds.some(w => w.z > 10.01)).toBe(true)
    expect(weeds.some(w => w.z < 9.99)).toBe(true)
    for (const w of weeds) expect(Math.abs(Math.sin(w.yaw))).toBeLessThan(Math.sin(0.31))
  })
})
