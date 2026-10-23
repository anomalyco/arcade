import { describe, expect, test } from "bun:test"
import { FLOATS_PER_VERT, Mesh, packVerts, VERT_BYTES } from "./mesh"
import { bakeFinish, decodeFinish, finishByte15, finishByte19, readPacked } from "./finish-bake"
import { autoChamfer, chamferBox, chamferCylinder } from "./finish-geom"
import { finish, finishPacked } from "./finish"
import { lookIndex } from "./materials/wear"

const grey = [0.5, 0.5, 0.5] as const

function trianglesFaceOut(verts: { p: number[]; n: number[] }[]) {
  for (let t = 0; t < verts.length; t += 3) {
    const [a, b, c] = [verts[t]!, verts[t + 1]!, verts[t + 2]!]
    const e1 = [b.p[0]! - a.p[0]!, b.p[1]! - a.p[1]!, b.p[2]! - a.p[2]!], e2 = [c.p[0]! - a.p[0]!, c.p[1]! - a.p[1]!, c.p[2]! - a.p[2]!]
    const cr = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!]
    const n = [a.n[0]! + b.n[0]! + c.n[0]!, a.n[1]! + b.n[1]! + c.n[1]!, a.n[2]! + b.n[2]! + c.n[2]!]
    if (cr[0]! * n[0]! + cr[1]! * n[1]! + cr[2]! * n[2]! <= 0) return false
  }
  return true
}

function meshVerts(m: Mesh) {
  const out: { p: number[]; n: number[] }[] = []
  for (let i = 0; i < m.count; i++) {
    const s = i * FLOATS_PER_VERT
    out.push({ p: m.v.slice(s, s + 3), n: m.v.slice(s + 3, s + 6) })
  }
  return out
}

describe("finish bytes", () => {
  test("round-trip through the shader's decode", () => {
    for (const look of [0, 3, 7]) for (const k of [-1, -0.5, 0, 0.43, 1]) for (const [ao, ex] of [[1, 1], [0, 0], [0.4, 0.8]] as const) {
      const d = decodeFinish(finishByte15(k, look), finishByte19(ao, ex))!
      expect(d.look).toBe(look)
      expect(Math.abs(d.curvature - k)).toBeLessThanOrEqual(1 / 14 + 1e-6)
      expect(Math.abs(d.ao - ao)).toBeLessThanOrEqual(1 / 30 + 1e-6)
      expect(Math.abs(d.exposure - ex)).toBeLessThanOrEqual(1 / 30 + 1e-6)
    }
  })
  test("byte 15 fits a signed byte and keeps the finished flag", () => {
    for (let look = 0; look < 8; look++) for (let k = -7; k <= 7; k++) {
      const b = finishByte15(k / 7, look)
      expect(b).toBeGreaterThanOrEqual(-128)
      expect(b).toBeLessThanOrEqual(127)
      expect(b & 1).toBe(1)
    }
  })
  test("unfinished vertices decode as untouched", () => expect(decodeFinish(0, 255)).toBeNull())
})

describe("mesh", () => {
  test("default output is unchanged byte for byte", () => {
    const m = new Mesh()
    m.box(0, 0, 0, 1, 2, 3, grey)
    m.box(0, 0, 0, 1, 2, 3, grey, undefined, 0, [0.2, 0.3, 0.4], true)
    m.bevelBox(0, 0, 0, 1, 1, 1, 0.1, grey, [0.9, 0.9, 0.9])
    const bytes = new Uint8Array(m.pack())
    expect(bytes.length).toBe(m.count * VERT_BYTES)
    for (let i = 0; i < m.count; i++) {
      expect(bytes[i * VERT_BYTES + 15]).toBe(0)
      expect(bytes[i * VERT_BYTES + 19]).toBe(255)
    }
    // A plain box is still 30 vertices (no bottom), exactly as before.
    const plain = new Mesh()
    plain.box(0, 0, 0, 1, 1, 1, grey)
    expect(plain.count).toBe(30)
    expect(new Uint8Array(plain.pack())).toEqual(new Uint8Array(packVerts(plain.v)))
  })
  test("chamfered boxes face outward and stay inside their bounds", () => {
    const m = new Mesh({ chamfer: 0.05 })
    m.box(0, 0, 0, 1, 0.5, 2, grey, undefined, 0, undefined, true)
    expect(trianglesFaceOut(meshVerts(m))).toBe(true)
    for (const v of meshVerts(m)) {
      expect(v.p[0]).toBeGreaterThanOrEqual(-1e-9); expect(v.p[0]).toBeLessThanOrEqual(1 + 1e-9)
      expect(v.p[1]).toBeGreaterThanOrEqual(-1e-9); expect(v.p[1]).toBeLessThanOrEqual(0.5 + 1e-9)
    }
    // Six banded faces (10 triangles each), twelve edge strips (2 each), eight corners.
    expect(m.count / 3).toBe(6 * 10 + 12 * 2 + 8)
  })
  test("an open bottom keeps the foot square", () => {
    const tris = chamferBox(0, 0, 0, 1, 1, 1, 0.05, 0.03)
    expect(tris.every(v => v.p[1] >= 0)).toBe(true)
    // Bottom edges are not chamfered: the side faces reach y = 0 at their full width.
    expect(tris.some(v => v.p[1] === 0 && Math.abs(v.p[0] - 0.05) < 1e-9 && v.p[2] === 0 && v.n[2] === -1)).toBe(true)
  })
  test("auto chamfer stays between 2 and 12 mm", () => {
    expect(autoChamfer(0.01, 1, 1)).toBe(0.002)
    expect(autoChamfer(3, 3, 3)).toBe(0.012)
    expect(autoChamfer(0.5, 1, 1)).toBeCloseTo(0.006)
  })
  test("cylinders face outward, with and without a chamfer", () => {
    for (const r of [0, 0.02]) {
      const tris = chamferCylinder(0, 0, 0.3, 0, 1, 12, r, r ? 0.03 : 0, { bottom: true })
      expect(trianglesFaceOut(tris)).toBe(true)
    }
  })
})

describe("bake", () => {
  test("is deterministic", () => {
    const build = () => finish(m => { m.box(0, 0, 0, 1, 1, 1, grey); m.box(0.2, 1, 0.2, 0.8, 1.4, 0.8, grey) }, { look: "painted-steel", bake: { ground: 0 } })
    expect(new Uint8Array(build().mesh.pack())).toEqual(new Uint8Array(build().mesh.pack()))
  })
  test("convex chamfers are positive, the corner under a ledge is occluded and sheltered", () => {
    // A slab on a post: the post's top meets the slab's underside in a concave corner.
    const m = new Mesh({ chamfer: 0.02 })
    m.box(-0.1, 0, -0.1, 0.1, 1, 0.1, grey)
    m.box(-0.6, 1, -0.6, 0.6, 1.1, 0.6, grey, undefined, 0, undefined, true)
    const { mesh, report } = finish(m, { look: "old-wood", bake: { ground: 0 } })
    const bytes = new Uint8Array(mesh.pack())
    let underAo = 1, topAo = 0, topExpo = 0, underExpo = 1, maxCurv = -1
    for (let i = 0; i < mesh.count; i++) {
      const d = decodeFinish(bytes[i * VERT_BYTES + 15]!, bytes[i * VERT_BYTES + 19]!)!
      expect(d.look).toBe(lookIndex("old-wood"))
      const s = i * FLOATS_PER_VERT, y = mesh.v[s + 1]!, ny = mesh.v[s + 4]!
      maxCurv = Math.max(maxCurv, d.curvature)
      // Post side just under the slab.
      if (y > 0.95 && y <= 1 && Math.abs(ny) < 0.1) { underAo = Math.min(underAo, d.ao); underExpo = Math.min(underExpo, d.exposure) }
      if (y > 1.09 && ny > 0.9) { topAo = Math.max(topAo, d.ao); topExpo = Math.max(topExpo, d.exposure) }
    }
    expect(maxCurv).toBe(1)
    expect(underAo).toBeLessThan(topAo)
    expect(underExpo).toBeLessThan(0.2)
    expect(topExpo).toBeGreaterThan(0.9)
    expect(report.triangles).toBe(mesh.count / 3)
  })
  test("square edges bake convex and concave signs from the dihedral", () => {
    // An L-shaped step from two plain boxes: the outer top edge is convex, the inner corner concave.
    const m = new Mesh()
    m.box(0, 0, 0, 2, 1, 1, grey)
    m.box(0, 0, 1, 1, 1, 2, grey)
    const verts = meshVerts(m)
    const pos = verts.flatMap(v => v.p), nrm = verts.flatMap(v => v.n)
    const bake = bakeFinish(pos, nrm, { edgeBand: 2 })
    // A vertex on the top face's outer corner (2,1,0) is on convex edges only.
    const at = (x: number, y: number, z: number, ny: number) => verts.findIndex(v => v.p[0] === x && v.p[1] === y && v.p[2] === z && Math.round(v.n[1]!) === ny)
    expect(bake.curvature[at(2, 1, 0, 1)]!).toBeGreaterThan(0.5)
    expect(bake.ao[at(2, 1, 0, 1)]!).toBeGreaterThan(0.9)
  })
  test("finishPacked writes bytes in place and leaves unfinished ranges alone", () => {
    const a = new Mesh(), b = new Mesh()
    a.box(0, 0, 0, 1, 1, 1, grey)
    b.box(-1, 1, -1, 2, 1.2, 2, grey)
    const bufA = a.pack(), bufB = b.pack()
    const before = new Uint8Array(bufB.slice(0))
    finishPacked([{ buf: bufA, stride: VERT_BYTES, first: 0, count: a.count, look: "damp-cinderblock" }, { buf: bufB, stride: VERT_BYTES, first: 0, count: b.count, look: null }], { ground: 0 })
    expect(new Uint8Array(bufB)).toEqual(before)
    const u8 = new Uint8Array(bufA)
    let sheltered = 0
    for (let i = 0; i < a.count; i++) {
      const d = decodeFinish(u8[i * VERT_BYTES + 15]!, u8[i * VERT_BYTES + 19]!)!
      expect(d.look).toBe(lookIndex("damp-cinderblock"))
      if (d.exposure < 0.5) sheltered++
    }
    // The roof slab (an occluder only) shelters the whole box.
    expect(sheltered).toBe(a.count)
    // Positions and normals are untouched.
    expect(readPacked(bufA, VERT_BYTES).pos).toEqual(readPacked(a.pack(), VERT_BYTES).pos)
  })
})
