import { describe, expect, test } from "bun:test"
import { coldSodiumTint, lampFlicker, sodiumCycle } from "./flicker"

const sample = (kind: Parameters<typeof lampFlicker>[0], seed: number, seconds: number, amount: number, dt = 1 / 60) => {
  const out: { t: number; level: number; warmth: number }[] = []
  for (let t = 0; t < seconds; t += dt) out.push({ t, ...lampFlicker(kind, seed, t, amount) })
  return out
}

describe("lamp flicker", () => {
  test("steady lamps and zero amount never change", () => {
    for (const kind of ["steady", "fluorescent", "sodium", "incandescent"] as const) {
      for (const t of [0, 1.3, 77.7, 1e5]) expect(lampFlicker(kind, 3, t, 0)).toEqual({ level: 1, warmth: 1 })
    }
    expect(lampFlicker("steady", 3, 12, 2)).toEqual({ level: 1, warmth: 1 })
  })

  test("pure: the same instant gives the same answer at any frame rate or order", () => {
    for (const kind of ["fluorescent", "sodium", "incandescent", "beacon"] as const) {
      for (let i = 0; i < 200; i++) {
        const t = i * 0.731
        const a = lampFlicker(kind, 11, t, 1)
        lampFlicker(kind, 11, t + 50, 1)
        expect(lampFlicker(kind, 11, t, 1)).toEqual(a)
      }
    }
  })

  test("levels stay in range", () => {
    for (const kind of ["fluorescent", "sodium", "incandescent", "beacon"] as const) {
      for (const s of sample(kind, 5, 300, 1.5, 0.05)) {
        expect(s.level).toBeGreaterThanOrEqual(0)
        expect(s.level).toBeLessThanOrEqual(1.06)
        expect(s.warmth).toBeGreaterThanOrEqual(0)
        expect(s.warmth).toBeLessThanOrEqual(1)
      }
    }
  })

  test("a dying sodium lamp sags, goes dark cold, then restrikes and warms", () => {
    const seed = 2
    const c = sodiumCycle(seed)
    const run = sample("sodium", seed, (c.burn + c.sag + c.off + c.restrike) * 6, 1, 0.05)
    const dark = run.filter((s) => s.level < 0.02)
    expect(dark.length).toBeGreaterThan(0)
    expect(dark.every((s) => s.warmth === 0)).toBe(true)
    // After the first dark stretch, warmth climbs monotonically back to 1.
    const end = run.findIndex((s, i) => i > 0 && run[i - 1]!.warmth === 0 && s.warmth > 0)
    expect(end).toBeGreaterThan(0)
    let prev = 0
    for (let i = end; i < run.length && run[i]!.warmth < 1; i++) {
      expect(run[i]!.warmth).toBeGreaterThanOrEqual(prev)
      prev = run[i]!.warmth
    }
    const tint = coldSodiumTint([1, 0.6, 0.2], 0)
    expect(tint[1]).toBeCloseTo(0.27, 5)
    expect(coldSodiumTint([1, 0.6, 0.2], 1)).toEqual([1, 0.6, 0.2])
  })

  test("fluorescent tubes are mostly on, fail now and then, and fail more with amount", () => {
    const downtime = (amount: number) => {
      let down = 0
      let n = 0
      for (let seed = 0; seed < 24; seed++) {
        for (const s of sample("fluorescent", seed, 120, amount, 0.02)) {
          n++
          if (s.level < 0.5) down++
        }
      }
      return down / n
    }
    const low = downtime(0.5)
    const high = downtime(2)
    expect(downtime(1)).toBeGreaterThan(0.005)
    expect(downtime(1)).toBeLessThan(0.15)
    expect(high).toBeGreaterThan(low)
  })

  test("lamps with different seeds disagree", () => {
    const a = sample("fluorescent", 1, 60, 1, 0.1).map((s) => s.level)
    const b = sample("fluorescent", 2, 60, 1, 0.1).map((s) => s.level)
    expect(a).not.toEqual(b)
  })
})
