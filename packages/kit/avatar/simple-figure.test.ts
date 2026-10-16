import { expect, test } from "bun:test"
import { FLOATS_PER_VERT, MAT } from "../gpu/mesh"
import { simpleFigureMeshes } from "./simple-figure"

const bounds = (v: readonly number[]) => {
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < v.length; i += FLOATS_PER_VERT) {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k]!, v[i + k]!)
      hi[k] = Math.max(hi[k]!, v[i + k]!)
    }
  }
  return { lo, hi }
}

for (const shape of ["mannequin", "capsule"] as const) {
  test(`${shape}: white cloth triangles with outward unit normals and the aux mark`, () => {
    const meshes = simpleFigureMeshes(shape, { aux: 5 })
    for (const [bone, mesh] of Object.entries(meshes)) {
      const v = mesh.v
      expect(v.length % (FLOATS_PER_VERT * 3)).toBe(0)
      expect(v.length).toBeGreaterThan(0)
      let outward = 0
      let total = 0
      for (let t = 0; t < v.length; t += FLOATS_PER_VERT * 3) {
        const p = [0, 1, 2].map(i => [v[t + i * FLOATS_PER_VERT]!, v[t + i * FLOATS_PER_VERT + 1]!, v[t + i * FLOATS_PER_VERT + 2]!])
        const n = [v[t + 3]!, v[t + 4]!, v[t + 5]!]
        expect(Math.hypot(n[0]!, n[1]!, n[2]!)).toBeCloseTo(1, 4)
        const e1 = [0, 1, 2].map(k => p[1]![k]! - p[0]![k]!)
        const e2 = [0, 1, 2].map(k => p[2]![k]! - p[0]![k]!)
        const f = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!]
        total++
        if (f[0]! * n[0]! + f[1]! * n[1]! + f[2]! * n[2]! > 0) outward++
        expect(v[t + 6]).toBe(1)
        expect(v[t + 9]).toBe(MAT.cloth)
        expect(v[t + 10]).toBe(5)
      }
      // Winding agrees with the smooth normals, so back-face culling keeps the outside.
      expect(outward / total, bone).toBeGreaterThan(0.97)
    }
  })

  test(`${shape}: limbs span their rig bones`, () => {
    const meshes = simpleFigureMeshes(shape)
    const thigh = bounds(meshes.thigh.v)
    expect(thigh.lo[1]).toBeLessThan(-0.4)
    expect(thigh.hi[1]).toBeGreaterThan(0.02)
    const fore = bounds(meshes.foreArm.v)
    expect(fore.lo[1]).toBeLessThan(-0.3)
    const head = bounds(meshes.head.v)
    expect(head.hi[1]).toBeGreaterThan(0.25)
    expect(head.hi[1]).toBeLessThan(0.3)
    const foot = bounds(meshes.foot.v)
    expect(foot.lo[1]).toBeGreaterThan(-0.095)
    expect(foot.hi[0]).toBeGreaterThan(0.11)
  })
}
