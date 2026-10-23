import { describe, expect, test } from "bun:test"
import { vec4 } from "wgpu-matrix"
import { lakeCubeFace } from "./lake-sky"

/** WebGPU cube sampling (the Vulkan face-selection table): face index and texel uv, v = 0 on the first row. */
function cubeSample(d: readonly [number, number, number]): { face: number; u: number; v: number } {
  const [x, y, z] = d, ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z)
  const [face, sc, tc, ma] =
    ax >= ay && ax >= az ? (x > 0 ? [0, -z, -y, ax] : [1, z, -y, ax])
    : ay >= az ? (y > 0 ? [2, x, z, ay] : [3, x, -z, ay])
    : z > 0 ? [4, x, -y, az] : [5, -x, -y, az]
  return { face, u: (sc / ma + 1) / 2, v: (tc / ma + 1) / 2 }
}

/** Where rendering face `face` with its view-projection puts direction d: render-target uv, first row at clip y = +1. */
function rendered(face: number, d: readonly [number, number, number]) {
  const c = vec4.transformMat4([d[0], d[1], d[2], 1], lakeCubeFace(face))
  return { u: (c[0]! / c[3]! + 1) / 2, v: (1 - c[1]! / c[3]!) / 2 }
}

describe("lake reflection cube", () => {
  const dirs: [number, number, number][] = []
  for (const a of [-0.7, -0.2, 0.3, 0.8]) for (const b of [-0.6, 0.1, 0.75]) {
    dirs.push([1, a, b], [-1, a, b], [a, 1, b], [a, -1, b], [a, b, 1], [a, b, -1])
  }

  test("each face renders every direction at the texel WebGPU samples it from", () => {
    for (const d of dirs) {
      const s = cubeSample(d)
      const r = rendered(s.face, d)
      expect(r.u).toBeCloseTo(s.u, 5)
      expect(r.v).toBeCloseTo(s.v, 5)
    }
  })

  test("a horizon ray reads the sky half of its side face, never the ground half", () => {
    for (const d of [[1, 0.05, 0], [-1, 0.05, 0.2], [0.1, 0.05, 1], [0.3, 0.05, -1]] as [number, number, number][]) {
      const s = cubeSample(d)
      expect(s.face === 2 || s.face === 3).toBe(false)
      // Above the horizon is the upper half of a side face (v < 0.5), where the cube rendered the sky above it.
      expect(rendered(s.face, d).v).toBeLessThan(0.5)
      expect(s.v).toBeLessThan(0.5)
    }
  })
})
