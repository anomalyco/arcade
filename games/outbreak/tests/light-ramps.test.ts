import { describe, expect, test } from "bun:test"
import { curveText, sampleCurve, sampleTable } from "@arcade/kit/ramps"
import {
  DEFAULT_LIGHT_CURVES,
  LIGHT_CURVE_KEYS,
  LIGHT_CURVES,
  LIGHT_RAMP_FLOATS,
  LIGHT_RAMP_SAMPLES,
  lightRampTable,
  packLightRamps,
} from "../src/light-ramps"
import { outbreakLightingStructWgsl, OUTBREAK_RAMP_UNIFORM_OFFSET } from "../src/lighting"
import { createOutbreakSettings, migrateOutbreakPreset } from "../src/settings"

const formulas = {
  beamFalloffCurve: (x: number) => (1 - x ** 4) ** 2,
  lampFalloffCurve: (x: number) => (1 - x * x) ** 2,
  unseenDepthCurve: (x: number) => 0.38 + 0.62 * x,
}

describe("falloff curves", () => {
  test("each default traces the formula the shaders keep running while it is untouched", () => {
    for (const key of LIGHT_CURVE_KEYS) {
      const points = JSON.parse(DEFAULT_LIGHT_CURVES[key])
      for (let i = 0; i <= 40; i++) expect(Math.abs(sampleCurve(points, i / 40) - formulas[key](i / 40))).toBeLessThan(0.02)
    }
  })
  test("defaults leave every flag at 0, so the shaders take the exact formula", () => {
    const out = new Float32Array(LIGHT_RAMP_FLOATS).fill(7)
    packLightRamps({ ...DEFAULT_LIGHT_CURVES }, out, 0)
    expect([...out.subarray(0, 3)]).toEqual([0, 0, 0])
    // A default that went through knobs (points re-serialized) still counts as the default.
    const roundTrip = JSON.stringify(JSON.parse(DEFAULT_LIGHT_CURVES.lampFalloffCurve).map((p: { x: number; y: number }) => ({ y: p.y, x: p.x })))
    expect(lightRampTable("lampFalloffCurve", roundTrip)).toBeNull()
    packLightRamps({}, out, 0)
    expect([...out.subarray(0, 3)]).toEqual([0, 0, 0])
  })
  test("a reshaped curve sets its flag and bakes its table into its own slot", () => {
    const out = new Float32Array(LIGHT_RAMP_FLOATS)
    const linear = curveText([{ x: 0, y: 1 }, { x: 1, y: 0 }])
    packLightRamps({ ...DEFAULT_LIGHT_CURVES, lampFalloffCurve: linear }, out, 0)
    expect([...out.subarray(0, 3)]).toEqual([0, 1, 0])
    const slot = out.subarray(4 + LIGHT_CURVES.lampFalloffCurve.table * LIGHT_RAMP_SAMPLES, 4 + (LIGHT_CURVES.lampFalloffCurve.table + 1) * LIGHT_RAMP_SAMPLES)
    expect(slot[0]).toBeCloseTo(1, 5)
    expect(slot[LIGHT_RAMP_SAMPLES - 1]).toBeCloseTo(0, 5)
    expect(sampleTable(Float32Array.from(slot), 0.25)).toBeCloseTo(0.75, 3)
  })
  test("the WGSL block puts the flags and tables on vec4 boundaries after the unseen block", () => {
    expect(OUTBREAK_RAMP_UNIFORM_OFFSET % 4).toBe(0)
    expect(outbreakLightingStructWgsl).toContain("rampOn: vec4f")
    expect(outbreakLightingStructWgsl).toContain(`ramps: array<vec4f, ${(LIGHT_CURVE_KEYS.length * LIGHT_RAMP_SAMPLES) / 4}>`)
    expect(outbreakLightingStructWgsl).toContain("fn outbreakRamp(table: u32, x: f32) -> f32")
  })
  test("curves live in their subsystems and presets validate them", () => {
    const settings = createOutbreakSettings()
    expect(settings.flashlight.beamFalloffCurve).toBe(DEFAULT_LIGHT_CURVES.beamFalloffCurve)
    expect(settings.lighting.lampFalloffCurve).toBe(DEFAULT_LIGHT_CURVES.lampFalloffCurve)
    expect(settings.unseen.unseenDepthCurve).toBe(DEFAULT_LIGHT_CURVES.unseenDepthCurve)
    const ok = migrateOutbreakPreset({ version: 2, subsystems: { unseen: { unseenDepthCurve: [{ x: 0, y: 0 }, { x: 1, y: 1 }] } } })
    expect(ok.ok && ok.preset.subsystems.unseen?.unseenDepthCurve).toBe(curveText([{ x: 0, y: 0 }, { x: 1, y: 1 }]))
    expect(migrateOutbreakPreset({ version: 2, subsystems: { lighting: { lampFalloffCurve: "soft" } } }).ok).toBe(false)
  })
})
