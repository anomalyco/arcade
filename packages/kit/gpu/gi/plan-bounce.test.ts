import { describe, expect, test } from "bun:test"
import { validateWgsl } from "../test-naga"
import { OCC_FLOATS } from "../../limits"
import { makeSceneShader } from "../shaders"
import {
  PLAN_BOUNCE_EXTENT,
  PLAN_BOUNCE_HEIGHT_SCALE,
  PLAN_BOUNCE_LEVELS,
  packPlanBounceUniforms,
  planBounceDownShader,
  planBounceEmitShader,
  planBounceGatherShader,
  planBounceSceneWgsl,
  planBounceWindow,
  rasterPlanOccupancy,
} from "./plan-bounce"

describe("planBounceWindow", () => {
  test("covers the extent around the centre and snaps to the coarsest mip cell", () => {
    for (const texel of [0.25, 0.5, 1]) {
      const snap = texel * (1 << (PLAN_BOUNCE_LEVELS - 1))
      for (const [x, z] of [[0, 0], [13.7, -41.2], [1003.3, 77.9]] as const) {
        const w = planBounceWindow(x, z, texel)
        expect(w.size * texel).toBeCloseTo(PLAN_BOUNCE_EXTENT, 6)
        expect(Math.abs(w.originX / snap - Math.round(w.originX / snap))).toBeLessThan(1e-9)
        expect(Math.abs(w.originZ / snap - Math.round(w.originZ / snap))).toBeLessThan(1e-9)
        expect(Math.abs(w.originX + PLAN_BOUNCE_EXTENT / 2 - x)).toBeLessThanOrEqual(snap / 2 + 1e-9)
      }
    }
  })

  test("small camera moves keep the same grid (no shimmer from re-anchoring)", () => {
    const a = planBounceWindow(10.1, 20.1, 0.5)
    const b = planBounceWindow(10.9, 20.6, 0.5)
    expect(b).toEqual(a)
  })

  test("odd texel requests fall back to the nearest supported size", () => {
    expect(planBounceWindow(0, 0, 0.4).size).toBe(128)
    expect(planBounceWindow(0, 0, 0.9).size).toBe(64)
  })
})

describe("rasterPlanOccupancy", () => {
  const occ = (rects: number[][]) => {
    const out = new Float32Array(rects.length * OCC_FLOATS)
    rects.forEach((r, i) => out.set(r, i * OCC_FLOATS))
    return out
  }

  test("a wall thinner than a texel still fills a column, people are skipped, tallest wins", () => {
    const size = 16
    const heights = new Uint8Array(size * size)
    const scratch = new Uint8Array(size * size)
    const data = occ([
      [4.1, 0, 4.25, 8, 2.8, 0, 0, 0], // thin wall at x 4.1..4.25
      [2, 2, 2.4, 2.4, 0.9, 0, 0, 0], // low furniture
      [2, 2, 2.4, 2.4, 2.0, 0, 0, 0], // a taller piece on the same texel
      [6, 6, 0.3, 0, 1.7, 1, 0, 0], // a person: skipped
    ])
    expect(rasterPlanOccupancy(data, 4, 0, 0, 0.5, size, heights, scratch)).toBe(true)
    const at = (x: number, z: number) => (heights[Math.floor(z / 0.5) * size + Math.floor(x / 0.5)]! / 255) * PLAN_BOUNCE_HEIGHT_SCALE
    expect(at(4.2, 1)).toBeCloseTo(2.8, 1)
    expect(at(4.2, 7.9)).toBeCloseTo(2.8, 1)
    expect(at(3.8, 1)).toBe(0)
    expect(at(4.6, 1)).toBe(0)
    expect(at(2.2, 2.2)).toBeCloseTo(2.0, 1)
    expect(at(6, 6)).toBe(0)
    // Same input: nothing to upload.
    expect(rasterPlanOccupancy(data, 4, 0, 0, 0.5, size, heights, scratch)).toBe(false)
  })

  test("only occluders overlapping the window count", () => {
    const size = 8
    const heights = new Uint8Array(size * size)
    const scratch = new Uint8Array(size * size)
    rasterPlanOccupancy(occ([[-10, -10, -9, -9, 3, 0, 0, 0]]), 1, 0, 0, 1, size, heights, scratch)
    expect(heights.every((h) => h === 0)).toBe(true)
  })
})

describe("packPlanBounceUniforms", () => {
  test("range in texels, defaults for reflectance, edge fade in texels", () => {
    const w = planBounceWindow(0, 0, 0.5)
    const u = packPlanBounceUniforms({ centerX: 0, centerZ: 0, strength: 1.5, range: 6, texel: 0.5 }, w, 12, 4)
    expect(u[2]).toBe(0.5)
    expect(u[3]).toBe(128)
    expect(u[4]).toBe(1.5)
    expect(u[5]).toBe(12)
    expect(u[6]).toBeCloseTo(0.35)
    expect(u[7]).toBeCloseTo(1.5)
    expect(u[8]).toBe(12)
    expect(u[9]).toBe(4)
    expect(u[11]).toBe(2)
    expect(u[12]).toBe(6)
  })

  test("negative strength reads as off", () => {
    const u = packPlanBounceUniforms({ centerX: 0, centerZ: 0, strength: -1, range: 6, texel: 1 }, planBounceWindow(0, 0, 1), 1, 1)
    expect(u[4]).toBe(0)
  })
})

describe("WGSL validates with naga", () => {
  const sources: Record<string, string> = {
    emit: planBounceEmitShader(),
    "emit with a game hook": planBounceEmitShader({
      declarations: "fn torch(c: f32) -> f32 { return smoothstep(0.8, 1.0, c); }",
      attenuation: "var att = power * win * torch(L.cone.z); if (wall && L.cone.w < -2.5) { continue; }",
    }),
    down: planBounceDownShader,
    gather: planBounceGatherShader,
    scene: makeSceneShader({ lampGrid: false, declarations: planBounceSceneWgsl, bounce: "planBounceAt(o.world.xz + n.xz * 0.3) * planBounceStrength()" }),
  }
  for (const [name, code] of Object.entries(sources)) {
    test(name, () => {
      validateWgsl(code)
    })
  }
})
