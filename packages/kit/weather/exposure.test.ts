import { describe, expect, test } from "bun:test"
import { EyeAdaptation, EXPOSURE_DEFAULTS } from "./exposure"

const settings = { ...EXPOSURE_DEFAULTS, mode: "adapt" as const }
const input = (dt: number, luminance: number, glare = 0) => ({ dt, luminance, referenceLuminance: 1, glare })

describe("shared eye adaptation", () => {
  test("a brief flash leaves a darker aftermath that recovers without lifting darkness", () => {
    const eye = new EyeAdaptation()
    const flash = eye.step(input(0.1, 100, 1), settings)
    expect(flash.multiplier).toBeLessThan(1)
    const after = eye.step(input(0.1, 1e-8), settings)
    expect(after.multiplier).toBeGreaterThan(flash.multiplier)
    expect(after.multiplier).toBeLessThan(1)
    const recovered = eye.step(input(30, 1e-8), settings)
    expect(recovered.multiplier).toBeCloseTo(1, 3)
    expect(recovered.multiplier).toBeLessThanOrEqual(1)
    expect(recovered.glare).toBeLessThan(after.glare)
  })

  test("constant stimuli are independent of frame rate and luminance unit scale", () => {
    const run = (hz: number, scale: number) => {
      const eye = new EyeAdaptation()
      for (const luminance of [8, 1]) for (let n = 0; n < hz; n++) {
        eye.step({ dt: 1 / hz, luminance: luminance * scale, referenceLuminance: scale, glare: luminance === 8 ? 1 : 0 }, settings)
      }
      return eye.step(input(0, 1), settings)
    }
    const a = run(30, 1), b = run(144, 100)
    expect(a.multiplier).toBeCloseTo(b.multiplier, 10)
    expect(a.glare).toBeCloseTo(b.glare, 10)
  })

  test("Today resets both histories and paused time deposits no glare dose", () => {
    const eye = new EyeAdaptation()
    expect(eye.step(input(0, 100, 1), settings)).toEqual({ multiplier: 1, adaptationEV: 0, glare: 0 })
    eye.step(input(1, 100, 1), settings)
    expect(eye.step(input(1, 100, 1), EXPOSURE_DEFAULTS)).toEqual({ multiplier: 1, adaptationEV: 0, glare: 0 })
    expect(eye.step(input(0, 1), settings)).toEqual({ multiplier: 1, adaptationEV: 0, glare: 0 })
  })

  test("malformed input cannot poison a view and independent views do not share state", () => {
    const a = new EyeAdaptation(), b = new EyeAdaptation()
    a.step(input(1, 100, 1), settings)
    const frame = a.step({ dt: NaN, luminance: Infinity, referenceLuminance: 0, glare: NaN }, settings)
    expect(Number.isFinite(frame.multiplier)).toBe(true)
    expect(b.step(input(1, 1), settings).multiplier).toBe(1)
  })
})
