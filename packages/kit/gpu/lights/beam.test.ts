import { describe, expect, test } from "bun:test"
import { SceneLights } from "../scene-frame"
import { BEAM_PROFILES, DARKWOOD_BEAM, HOT_CORE_BEAM, beamCone, beamControls, beamProfile, beamReach, packBeamProfile } from "./beam"

describe("beam profile", () => {
  test("hot core on axis, edge near the half-angle, nothing past the spill", () => {
    for (const p of Object.values(BEAM_PROFILES)) {
      const axis = beamProfile(0, p)
      expect(axis).toBeGreaterThan(1 + p.core * 0.95)
      expect(beamProfile(0.5, p)).toBeLessThan(axis)
      expect(beamProfile(1.2, p)).toBeLessThan(0.1)
      expect(beamProfile(p.spillWidth * 1.7, p)).toBe(0)
      expect(beamProfile(3, p)).toBe(0)
    }
  })

  test("falls monotonically outside the cone, through the spill", () => {
    for (const p of [DARKWOOD_BEAM, HOT_CORE_BEAM]) {
      let prev = Infinity
      for (let t = 1; t < p.spillWidth * 1.7; t += 0.01) {
        const v = beamProfile(t, p)
        expect(v).toBeLessThanOrEqual(prev + 1e-9)
        prev = v
      }
    }
  })

  test("Darkwood is a wide even wedge; hot core is peaky", () => {
    const flat = (p: typeof DARKWOOD_BEAM) => beamProfile(0.6, p) / beamProfile(0, p)
    expect(flat(DARKWOOD_BEAM)).toBeGreaterThan(0.75)
    expect(flat(HOT_CORE_BEAM)).toBeLessThan(0.55)
  })

  test("packs into the uniform, the cone slot and the scene frame", () => {
    expect(Array.from(packBeamProfile(DARKWOOD_BEAM)).map((v) => +v.toFixed(4))).toEqual([0.8, 0.2, 0.34, 0.02, 1.5, 0.1, 0, 0])
    expect(beamCone([0, -2, 0], 0.36)).toEqual([0, 0, -1, 5.36])
    expect(beamCone([0, 0.6, 0.8], 0.36)).toEqual([0, 0.8, 0.6, 5.36])
    expect(() => beamCone([0, 0, 0], 0.36)).toThrow()
    expect(() => beamCone([0, -1, 0], 1.6)).toThrow()
    const lights = new SceneLights()
    lights.update([{ x: 0, y: 0, h: 1.3, r: 9, color: [1, 1, 1], power: 1, beam: { axis: [0.6, -0.3, 0.8], halfAngle: 0.36 } }], [])
    expect(lights.lights[11]!).toBeCloseTo(5.36, 5)
    expect(beamReach(0.36, DARKWOOD_BEAM)).toBeCloseTo(0.36 * 1.5 * 1.7, 6)
  })

  test("Lab rows cover every field", () => {
    expect(beamControls().map((r) => r.key).sort()).toEqual(Object.keys(DARKWOOD_BEAM).sort())
  })
})
