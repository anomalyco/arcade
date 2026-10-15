import { describe, expect, test } from "bun:test"
import {
  MotionBlurBurst,
  PreviousTransforms,
  motionBlurControls,
  motionBlurDefaults,
} from "./motion-blur"

describe("motion-blur settings, burst impulse, and transform history", () => {
  test("motionBlurDefaults and motionBlurControls cover shutter and impulse burst", () => {
    const defaults = motionBlurDefaults()
    expect(defaults.enabled).toBe(true)
    expect(defaults.strength).toBeCloseTo(0.65, 5)
    expect(defaults.shutter).toBeCloseTo(0.5, 5)
    expect(defaults.burst).toBe(1)
    expect(defaults.burstDecay).toBe(14)

    for (const c of motionBlurControls) {
      expect(c.key in defaults).toBe(true)
      if ("min" in c) {
        expect(c.max).toBeGreaterThan(c.min)
        expect(c.step).toBeGreaterThan(0)
      }
    }
  })

  test("MotionBlurBurst accumulates directional and radial impulses, clamps bounds, and decays to zero", () => {
    const burst = new MotionBlurBurst()
    expect(burst.active).toBe(false)

    burst.add({ dir: 0, directional: 0.008, radial: 0.005, boost: 0.5 }, 1)
    expect(burst.active).toBe(true)
    expect(burst.dx).toBeCloseTo(0.008, 5)
    expect(burst.dy).toBeCloseTo(0, 5)
    expect(burst.radial).toBeCloseTo(0.005, 5)
    expect(burst.shutterBoost).toBeCloseTo(0.5, 5)

    // Clamping under repeated impulses
    for (let i = 0; i < 20; i++) {
      burst.add({ dir: 0.4, directional: 0.01, radial: 0.01, boost: 0.4 }, 1.5)
    }
    expect(Math.abs(burst.dx)).toBeLessThanOrEqual(0.028)
    expect(Math.abs(burst.dy)).toBeLessThanOrEqual(0.028)
    expect(Math.abs(burst.radial)).toBeLessThanOrEqual(0.032)
    expect(burst.shutterBoost).toBeLessThanOrEqual(1.5)

    // Exponential decay to exact zero
    for (let i = 0; i < 60; i++) {
      burst.step(1 / 60, 14)
    }
    expect(burst.active).toBe(false)
    expect(burst.dx).toBe(0)
    expect(burst.dy).toBe(0)
    expect(burst.radial).toBe(0)
    expect(burst.shutterBoost).toBe(0)
  })

  test("MotionBlurBurst ignores impulses when scale is 0", () => {
    const burst = new MotionBlurBurst()
    burst.add({ dir: 1, directional: 0.01, radial: 0.01, boost: 0.5 }, 0)
    expect(burst.active).toBe(false)
  })

  test("PreviousTransforms tracks identity and rejects teleports", () => {
    const history = new PreviousTransforms(4, 10)
    const out = new Float32Array(8)
    const a = new Float32Array([1, 2, 3, 4])
    history.begin()
    history.write("a", a, 0, out, 0)
    expect([...out.subarray(0, 4)]).toEqual([1, 2, 3, 4])
    a[0] = 3
    history.begin()
    history.write("a", a, 0, out, 0)
    expect(out[0]).toBe(1)
  })
})
