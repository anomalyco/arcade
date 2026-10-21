import { describe, expect, test } from "bun:test"
import { validateWgsl } from "../test-naga"
import { physicalLightHooks } from "../lights/physical"
import { makeSceneShader } from "../shaders"
import {
  SPOT_SHADOW_DEFAULTS,
  SPOT_SHADOW_UNIFORM_FLOATS,
  SpotShadowPicker,
  packSpotShadows,
  spotShadowReach,
  spotShadowControls,
  spotViewProj,
  type SpotCandidate,
  type Vec3,
} from "./spot-shadows"

const lamp = (id: number, x: number, z: number, intensity = 1000): SpotCandidate => ({ id, pos: [x, 7, z], axis: [0, -1, 0], cosOuter: Math.cos(1.1), range: 40, intensity })
const apply = (m: Float32Array, p: Vec3) => {
  const c = [0, 1, 2, 3].map((r) => m[r]! * p[0] + m[4 + r]! * p[1] + m[8 + r]! * p[2] + m[12 + r]!)
  return [c[0]! / c[3]!, c[1]! / c[3]!, c[2]! / c[3]!]
}

describe("spot shadow picker", () => {
  test("gives slots to the most important lamps near the camera, in a stable order", () => {
    const p = new SpotShadowPicker(2)
    const slots = p.update([lamp(1, 100, 0), lamp(2, 5, 0), lamp(3, 0, 8), lamp(4, -30, 0)], [0, 1.7, 0], 1 / 60)
    expect(slots.map((s) => s.id).sort()).toEqual([2, 3])
    // A first frame (or a camera jump) snaps the weights instead of fading in.
    expect(slots.every((s) => s.weight === 1 && s.dirty)).toBe(true)
  })

  test("holders keep their slot against a slightly better newcomer (1.6× hysteresis), then hand over with a fade", () => {
    const p = new SpotShadowPicker(1)
    p.update([lamp(1, 0, 6)], [0, 1.7, 0], 1 / 60)
    // Lamp 2 is a little more important: no swap.
    let slots = p.update([lamp(1, 0, 6), lamp(2, 0, 6, 1300)], [0, 1.7, 0], 1 / 60)
    expect(slots[0]!.id).toBe(1)
    expect(slots[0]!.dirty).toBe(false)
    // Much more important: lamp 1 fades out over 0.35 s, then lamp 2 takes the slot and its map renders.
    for (let t = 0; t < 0.3; t += 1 / 60) slots = p.update([lamp(1, 0, 6), lamp(2, 0, 6, 4000)], [0, 1.7, 0], 1 / 60)
    expect(slots[0]!.id).toBe(1)
    expect(slots[0]!.weight).toBeLessThan(0.3)
    for (let t = 0; t < 0.1; t += 1 / 60) slots = p.update([lamp(1, 0, 6), lamp(2, 0, 6, 4000)], [0, 1.7, 0], 1 / 60)
    expect(slots[0]!.id).toBe(2)
    slots = p.update([lamp(1, 0, 6), lamp(2, 0, 6, 4000)], [0, 1.7, 0], 1 / 60)
    expect(slots[0]!.weight).toBeGreaterThan(0)
  })

  test("maps re-render only on hand-over, a moved light or a changed world", () => {
    const p = new SpotShadowPicker(1)
    p.update([lamp(1, 0, 6)], [0, 1.7, 0], 1 / 60)
    expect(p.update([lamp(1, 0, 6)], [0.1, 1.7, 0], 1 / 60)[0]!.dirty).toBe(false)
    expect(p.update([lamp(1, 0.5, 6)], [0.1, 1.7, 0], 1 / 60)[0]!.dirty).toBe(true)
    p.invalidate()
    expect(p.update([lamp(1, 0.5, 6)], [0.1, 1.7, 0], 1 / 60)[0]!.dirty).toBe(true)
    expect(p.update([lamp(1, 0.5, 6)], [0.1, 1.7, 0], 1 / 60)[0]!.dirty).toBe(false)
  })

  test("turning the pool on with the camera still snaps the maps in (a settings change is not motion)", () => {
    const p = new SpotShadowPicker(0)
    p.update([lamp(1, 0, 6)], [0, 1.7, 0], 1 / 60)
    p.resize(2)
    expect(p.update([lamp(1, 0, 6)], [0, 1.7, 0], 1 / 60)[0]).toMatchObject({ id: 1, weight: 1, dirty: true })
    // A lamp that comes into range later still fades in.
    const slots = p.update([lamp(1, 0, 6), lamp(2, 3, 6)], [0, 1.7, 0], 1 / 60)
    expect(slots[1]).toMatchObject({ id: 2, weight: 0 })
  })

  test("walking toward a light grows its shadow in with distance instead of popping it on", () => {
    const p = new SpotShadowPicker(1)
    const l = lamp(1, 0, 0) // range 40: no slot past 55 m, full strength inside 45 m
    const out = new Float32Array(SPOT_SHADOW_UNIFORM_FLOATS)
    const strength: number[] = []
    for (let z = 60; z >= 40; z -= 2.1 / 60) {
      packSpotShadows(out, p.update([l], [0, 1.7, z], 1 / 60), () => 0, { count: 1, size: 1024, bias: 1 })
      strength.push(out[0] ? out[4 + 21]! : 0)
    }
    // Monotonic, and no frame-to-frame step bigger than 1 % of full strength.
    for (let i = 1; i < strength.length; i++) {
      expect(strength[i]!).toBeGreaterThanOrEqual(strength[i - 1]! - 1e-6)
      expect(strength[i]! - strength[i - 1]!).toBeLessThan(0.01)
    }
    expect(strength.at(-1)).toBe(1)
    expect(spotShadowReach(l, [0, 7, 50])).toBeCloseTo(0.5, 6)
  })

  test("zero slots is Today: nothing is assigned", () => {
    const p = new SpotShadowPicker(0)
    expect(p.update([lamp(1, 0, 6)], [0, 1.7, 0], 1 / 60)).toEqual([])
    expect(SPOT_SHADOW_DEFAULTS.count).toBe(0)
    expect(spotShadowControls()[0]).toMatchObject({ key: "count", min: 0 })
  })
})

describe("spot projection and packing", () => {
  test("the axis lands at the map centre, the near plane at depth 0 and the range at 1", () => {
    const m = spotViewProj([3, 7, -2], [0, -1, 0], 1.1, 0.25, 40)
    const centre = apply(m, [3, 0, -2])
    expect(centre[0]).toBeCloseTo(0, 5)
    expect(centre[1]).toBeCloseTo(0, 5)
    expect(apply(m, [3, 7 - 0.25, -2])[2]).toBeCloseTo(0, 4)
    expect(apply(m, [3, 7 - 40, -2])[2]).toBeCloseTo(1, 4)
    // A point on the cone edge projects to the frustum edge.
    const edge = apply(m, [3 + Math.tan(1.1) * 5, 2, -2])
    expect(Math.abs(edge[0]!)).toBeCloseTo(1, 3)
    const tilted = spotViewProj([0, 1.3, 0], [0.6, -0.2, 0.77], 0.5, 0.25, 20)
    const ahead = apply(tilted, [0.6 * 5, 1.3 - 0.2 * 5, 0.77 * 5])
    expect(Math.hypot(ahead[0]!, ahead[1]!)).toBeLessThan(1e-4)
  })

  test("packs live slots with their frame index, weight and texel size; skips lights not in the frame", () => {
    const p = new SpotShadowPicker(2)
    const slots = p.update([lamp(1, 0, 6), lamp(2, 0, -6)], [0, 1.7, 0], 1 / 60)
    const out = new Float32Array(SPOT_SHADOW_UNIFORM_FLOATS)
    packSpotShadows(out, slots, (id) => (id === 2 ? 5 : -1), { count: 2, size: 1024, bias: 1 })
    expect(out[0]).toBe(1)
    expect(out[1]).toBe(1024)
    expect(out[4 + 20]).toBe(5)
    expect(out[4 + 21]).toBe(1)
    expect(out[4 + 22]).toBeCloseTo((2 * Math.tan(1.1)) / 1024, 6)
    expect(out[4 + 24]).toBe(40)
  })
})

describe("WGSL validates with naga", () => {
  test("physical scene with spot shadows", () => {
    validateWgsl(makeSceneShader({ ...physicalLightHooks({ spotShadows: true }), lampGrid: false }))
  })
})
