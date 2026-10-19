import { describe, expect, test } from "bun:test"
import {
  TEMPORAL_DEFAULTS,
  halton,
  internalSize,
  jitterPhases,
  jitterViewProj,
  temporalEnabled,
  temporalJitter,
  temporalScale,
} from "./temporal"

describe("temporal AA settings and jitter", () => {
  test("defaults keep today's MSAA path", () => {
    expect(temporalEnabled(TEMPORAL_DEFAULTS)).toBe(false)
    expect(temporalEnabled(null)).toBe(false)
    expect(temporalEnabled({ ...TEMPORAL_DEFAULTS, mode: "taa" })).toBe(true)
  })

  test("only upscaling lowers the internal size, clamped to 0.5..1", () => {
    expect(temporalScale({ ...TEMPORAL_DEFAULTS, mode: "taa", renderScale: 0.5 })).toBe(1)
    expect(temporalScale({ ...TEMPORAL_DEFAULTS, mode: "taau", renderScale: 0.67 })).toBeCloseTo(0.67)
    expect(temporalScale({ ...TEMPORAL_DEFAULTS, mode: "taau", renderScale: 0.2 })).toBe(0.5)
    expect(internalSize(3456, 1894, 0.67)).toEqual([2316, 1269])
    expect(internalSize(1, 1, 0.5)).toEqual([1, 1])
  })

  test("Halton(2,3) jitter is centred, inside the pixel and covers it evenly", () => {
    expect(halton(1, 2)).toBe(0.5)
    expect(halton(2, 3)).toBeCloseTo(2 / 3)
    const phases = jitterPhases(1)
    expect(phases).toBe(8)
    expect(jitterPhases(0.67)).toBe(18)
    expect(jitterPhases(0.5)).toBe(32)
    let sx = 0
    let sy = 0
    for (let i = 0; i < phases; i++) {
      const [x, y] = temporalJitter(i, phases)
      expect(Math.abs(x)).toBeLessThan(0.5)
      expect(Math.abs(y)).toBeLessThan(0.5)
      sx += x
      sy += y
    }
    expect(Math.abs(sx / phases)).toBeLessThan(0.07)
    expect(Math.abs(sy / phases)).toBeLessThan(0.07)
    expect(temporalJitter(phases, phases)).toEqual(temporalJitter(0, phases))
  })

  test("jitterViewProj moves projected points by the jitter in pixels (y down)", () => {
    // A perspective-ish column-major matrix with w depending on z.
    const vp = new Float32Array([1.2, 0.1, 0, 0.2, 0, 0.9, 0.3, 0.5, 0.1, -0.4, 0.8, 1, 0.5, 0.2, 0.1, 3])
    const j = vp.slice()
    const w = 800
    const h = 600
    jitterViewProj(j, 0.25, -0.4, w, h)
    const project = (m: Float32Array, p: number[]) => {
      const c = [0, 1, 2, 3].map((r) => m[r]! * p[0]! + m[4 + r]! * p[1]! + m[8 + r]! * p[2]! + m[12 + r]!)
      return [((c[0]! / c[3]!) * 0.5 + 0.5) * w, (0.5 - (c[1]! / c[3]!) * 0.5) * h]
    }
    for (const p of [[0, 0, 0], [1.5, -2, 4], [-3, 1, 7]]) {
      const a = project(vp, p)
      const b = project(j, p)
      expect(b[0]! - a[0]!).toBeCloseTo(0.25, 3)
      expect(b[1]! - a[1]!).toBeCloseTo(-0.4, 3)
    }
  })
})
