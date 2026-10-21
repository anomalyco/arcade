import { describe, expect, test } from "bun:test"
import { FLOATS_PER_VERT } from "../mesh"
import { streetCone } from "./physical"
import { STREET_LAMP_DEFAULTS, armFromPoles, createStreetLampSettings, packStreetLamp, profileFlux, pushLens, spotFlux, streetFluxGain, streetProfile, type Vec3 } from "./street"

const s = STREET_LAMP_DEFAULTS
const dir = (x: number, y: number, z: number): Vec3 => { const l = Math.hypot(x, y, z); return [x / l, y / l, z / l] }
/** Ground illuminance (relative) under a lamp 1 m up at plan offset (x along the road, y towards the street). */
const ground = (x: number, y: number) => { const d = dir(-y, -1, x); return streetProfile(d, [-1, 0], { ...s, glow: 0 }) * Math.pow(-d[1], 3) }

describe("street photometry", () => {
  test("1 at nadir, half the pool at each reach, asymmetric across the road", () => {
    expect(streetProfile([0, -1, 0], [1, 0], { ...s, glow: 0 })).toBeCloseTo(1, 5)
    expect(ground(s.along, 0)).toBeCloseTo(0.5, 1)
    expect(ground(0, s.street)).toBeCloseTo(0.5, 2)
    expect(ground(0, -s.house)).toBeCloseTo(0.5, 2)
    expect(ground(0, 1.2)).toBeGreaterThan(ground(0, -1.2) * 3)
  })
  test("batwing: peak candela well off nadir, along the road (IES short or medium: 1–3.75 MH)", () => {
    let best = 0, at = 0
    for (let x = 0; x < 6; x += 0.05) { const I = streetProfile(dir(0, -1, x), [1, 0], s); if (I > best) { best = I; at = x } }
    expect(at).toBeGreaterThan(1)
    expect(at).toBeLessThan(3.75)
    expect(best).toBeGreaterThan(2.5)
  })
  test("nothing above the cutoff but the sag lens's side glow", () => {
    const up = streetProfile(dir(1, 0.3, 0), [1, 0], s)
    expect(up).toBeLessThan(s.glow)
    expect(streetProfile(dir(0, -0.05, 1), [1, 0], { ...s, glow: 0 })).toBeLessThan(1e-3)
  })
  test("flux gain matches the round spot's flux", () => {
    const cosO = Math.cos(1.1), cosI = Math.cos(1.1 * 0.45)
    const k = streetFluxGain(createStreetLampSettings({ flux: 1 }), cosO, cosI)
    const f = profileFlux((d) => streetProfile(d, [1, 0], s), 64) * k
    expect(f / spotFlux(cosO, cosI)).toBeCloseTo(1, 3)
    expect(k).toBeLessThan(1)
  })
  test("packs twelve floats", () => {
    const p = packStreetLamp({ ...s, mode: "today" })
    expect(p.length).toBe(12)
    expect(p[8]).toBeCloseTo(s.air, 5)
    expect(p[9]).toBeCloseTo(s.haze, 5)
    expect(p[3]).toBeCloseTo(Math.cos((s.cutoff * Math.PI) / 180), 5)
    expect(p[4]).toBe(0)
  })
})

describe("lens emitter", () => {
  test("the arm comes from the slender pole collider beside the head", () => {
    const poles = [{ min: [6.63, 0, 129.48], max: [6.87, 6.4, 129.72] }, { min: [0, 0, 0], max: [10, 3, 10] }]
    const arm = armFromPoles([4.59, 6.4, 129.6], poles)!
    expect(arm[0]).toBeCloseTo(-1, 5)
    expect(arm[1]).toBeCloseTo(0, 5)
    expect(armFromPoles([40, 6, 40], poles)).toBeNull()
  })
  test("packs into the light cone slot", () => {
    expect(streetCone([0, 2], 0.3, 0.14)).toEqual([0, 1, 0.3, 7.14])
    expect(() => streetCone([1, 0], 0.3, 0.6)).toThrow()
  })
  test("the bowl spans the lens ellipse, sags below its rim and is hottest in the core", () => {
    const v: number[] = []
    pushLens(v, { center: [0, 6.45, 0], arm: [1, 0], a: 0.3, b: 0.14, depth: 0.075 }, [1, 0.55, 0.18], 41)
    const n = v.length / FLOATS_PER_VERT
    let minY = 9, maxX = 0, maxZ = 0, hot = 0, rim = 9
    for (let i = 0; i < n; i++) {
      const o = i * FLOATS_PER_VERT
      minY = Math.min(minY, v[o + 1]!); maxX = Math.max(maxX, Math.abs(v[o]!)); maxZ = Math.max(maxZ, Math.abs(v[o + 2]!))
      hot = Math.max(hot, v[o + 10]!); rim = Math.min(rim, v[o + 10]!)
      expect(v[o + 9]).toBe(41)
    }
    expect(minY).toBeCloseTo(6.375, 3)
    expect(maxX).toBeCloseTo(0.3, 3)
    expect(maxZ).toBeCloseTo(0.14, 3)
    expect(hot).toBeGreaterThan(0.95)
    expect(rim).toBeLessThan(0.8)
  })
})
