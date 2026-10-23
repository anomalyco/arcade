import { describe, expect, test } from "bun:test"
import { FlareFx, flareColor, flareEnvelope, flareFlicker, flareSettings, FLARE_DEFAULTS } from "./fx/flare"
import { Particles } from "./fx/particles"
import { stepThrown, throwBody, type ThrownEnv } from "./sim/thrown"

describe("road flare light", () => {
  test("the flicker is a pure function of seed and age, around 1, never black", () => {
    let sum = 0, min = Infinity, max = -Infinity
    const n = 20000
    for (let i = 0; i < n; i++) {
      const v = flareFlicker(5, i * 0.0031)
      sum += v
      min = Math.min(min, v)
      max = Math.max(max, v)
    }
    expect(flareFlicker(5, 12.345)).toBe(flareFlicker(5, 12.345))
    expect(flareFlicker(6, 12.345)).not.toBe(flareFlicker(5, 12.345))
    expect(sum / n).toBeGreaterThan(0.9)
    expect(sum / n).toBeLessThan(1.05)
    expect(min).toBeGreaterThanOrEqual(0.3)
    expect(max).toBeLessThan(1.35)
    expect(flareFlicker(5, 3, 0)).toBe(1)
  })

  test("strike, flare-up, burn, gutter, embers, out", () => {
    const burn = 150
    expect(flareEnvelope(-0.1, burn).phase).toBe("unlit")
    expect(flareEnvelope(0.05, burn).phase).toBe("strike")
    const peak = flareEnvelope(0.2, burn)
    expect(peak.phase).toBe("burn")
    expect(peak.level).toBeGreaterThan(1.8)
    expect(flareEnvelope(30, burn).level).toBeCloseTo(1, 5)
    const gutter = flareEnvelope(burn - 2, burn)
    expect(gutter.phase).toBe("gutter")
    expect(gutter.level).toBeLessThan(0.6)
    expect(gutter.heat).toBeGreaterThan(0.7)
    expect(flareEnvelope(burn + 3, burn).phase).toBe("embers")
    expect(flareEnvelope(burn + 60, burn)).toMatchObject({ phase: "out", level: 0 })
  })

  test("strontium red with a magenta edge; hotter is pinker, guttering warms to orange", () => {
    const c = flareColor(1850)
    expect(c[0]).toBe(1)
    expect(c[1]).toBeLessThan(0.12)
    expect(c[2]).toBeLessThan(0.12)
    expect(c[2]).toBeGreaterThan(0.03)
    expect(flareColor(2400)[1]).toBeGreaterThan(flareColor(1600)[1])
    expect(flareColor(1850, 1)[1]).toBeGreaterThan(c[1])
  })

  test("settings from untrusted input are clamped", () => {
    expect(flareSettings({ burnTime: 9999, intensity: "x", temperature: 1000 })).toMatchObject({ burnTime: 300, intensity: FLARE_DEFAULTS.intensity, temperature: 1500 })
  })

  test("emission runs on fixed ticks: 30, 60 and 144 fps throw off the same amount", () => {
    const counts = [30, 60, 144].map(fps => {
      const pool = new Particles()
      const fx = new FlareFx(3)
      fx.strike(5)
      for (let i = 0; i < fps * 2; i++) fx.step(1 / fps, pool)
      return pool.count
    })
    for (const c of counts) expect(Math.abs(c - counts[1]!)).toBeLessThanOrEqual(Math.ceil(counts[1]! * 0.02))
    expect(counts[1]).toBeGreaterThan(100)
  })

  test("a hitch skips emission instead of bursting", () => {
    const pool = new Particles()
    const fx = new FlareFx(3)
    fx.strike(5)
    fx.step(3, pool)
    expect(pool.count).toBeLessThan(80)
  })

  test("light follows the burn and goes out", () => {
    const fx = new FlareFx(9, { burnTime: 20 })
    fx.strike(10)
    expect(fx.light().level).toBeGreaterThan(0.5)
    fx.strike(60)
    expect(fx.light().level).toBe(0)
    expect(fx.lit).toBe(false)
  })
})

const flat: ThrownEnv = { ground: () => 0 }

describe("thrown body", () => {
  test("lands, bounces, rolls and comes to rest on flat ground", () => {
    const b = throwBody(0, 1.4, 0, 5, 3, 0, 4)
    for (let i = 0; i < 60 * 8 && !b.rest; i++) stepThrown(b, 1 / 60, flat)
    expect(b.rest).toBe(true)
    expect(b.bounces).toBeGreaterThan(0)
    expect(b.y).toBeCloseTo(0.0125, 4)
    expect(b.x).toBeGreaterThan(4)
    expect(b.x).toBeLessThan(12)
  })

  test("the same throw lands to the bit at any frame rate", () => {
    const land = (fps: number) => {
      const b = throwBody(1, 1.5, 2, 4, 3.5, -1.5, 11)
      for (let i = 0; i < fps * 10 && !b.rest; i++) stepThrown(b, 1 / fps, flat)
      return [b.x, b.y, b.z]
    }
    const a = land(60)
    expect(land(30)).toEqual(a)
    expect(land(144)).toEqual(a)
  })

  test("stops against a trunk and can land on a low rock", () => {
    const trunk: ThrownEnv = {
      ground: () => 0,
      obstacles: (x, z, reach, out) => {
        if (Math.abs(x - 3) > reach + 0.3) return 0
        out[0] = 3; out[1] = 0; out[2] = 0.25; out[3] = Infinity
        return 1
      },
    }
    const b = throwBody(0, 1, 0, 9, 0.5, 0, 2)
    for (let i = 0; i < 600 && !b.rest; i++) stepThrown(b, 1 / 60, trunk)
    expect(b.rest).toBe(true)
    expect(b.x).toBeLessThan(3 - 0.25)

    const rock: ThrownEnv = {
      ground: () => 0,
      obstacles: (_x, _z, _r, out) => { out[0] = 3; out[1] = 0; out[2] = 0.8; out[3] = 0.5; return 1 },
    }
    const r = throwBody(2.6, 2.5, 0, 0.3, 0, 0, 2)
    for (let i = 0; i < 600 && !r.rest; i++) stepThrown(r, 1 / 60, rock)
    expect(r.rest).toBe(true)
    expect(r.y).toBeCloseTo(0.5125, 3)
  })

  test("a gentle slope holds it; a steep one lets it roll down", () => {
    const slope = (k: number): ThrownEnv => ({ ground: (x) => -x * k })
    const gentle = throwBody(0, 0.3, 0, 0, 0, 0, 1)
    for (let i = 0; i < 600 && !gentle.rest; i++) stepThrown(gentle, 1 / 60, slope(0.15))
    expect(gentle.rest).toBe(true)
    expect(Math.abs(gentle.x)).toBeLessThan(0.3)
    const steep = throwBody(0, 0.3, 0, 0, 0, 0, 1)
    for (let i = 0; i < 120; i++) stepThrown(steep, 1 / 60, slope(0.6))
    expect(steep.x).toBeGreaterThan(1)
  })
})
