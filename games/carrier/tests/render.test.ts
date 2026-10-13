import { describe, expect, test } from "bun:test"
import { Camera, DEFAULT_VIEW, FAR, NEAR, frustumGroundRect, parseCam } from "../src/render/camera"
import { FRAME, FRAME_FLOATS, FRAME_WGSL } from "../src/render/frame"
import { splitFoliage } from "../src/render/lit"
import { MAT, Mesh, VERT_BYTES } from "../src/render/mesh"

const clip = (m: Float32Array, p: readonly number[]) => {
  const [x, y, z] = p as [number, number, number]
  const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!
  return { depth: (m[2]! * x + m[6]! * y + m[10]! * z + m[14]!) / w, w }
}

describe("frame", () => {
  test("packing offsets match the WGSL struct", () => {
    const sizes: Record<string, number> = { mat4x4f: 16, vec4f: 4 }
    const fields = [...FRAME_WGSL.matchAll(/^\s*(\w+): (\w+),/gm)].map((m) => [m[1]!, sizes[m[2]!]!] as const)
    let at = 0
    for (const [name, size] of fields) {
      const offsets: Record<string, number> = FRAME
      expect(offsets[name]).toBe(at)
      at += size
    }
    expect(fields.length).toBe(Object.keys(FRAME).length)
    expect(at).toBe(FRAME_FLOATS)
  })
})

describe("camera", () => {
  test("reversed Z maps near to 1 and far to 0", () => {
    const cam = new Camera()
    cam.compute(16 / 9)
    const at = (d: number) => cam.eye.map((e, i) => e + cam.forward[i]! * d)
    expect(clip(cam.viewProj, at(NEAR)).depth).toBeCloseTo(1, 4)
    expect(clip(cam.viewProj, at(FAR)).depth).toBeCloseTo(0, 4)
    expect(clip(cam.viewProj, at(1000)).depth).toBeGreaterThan(clip(cam.viewProj, at(2000)).depth)
  })

  test("the focus sits below the screen centre and the horizon is in view by default", () => {
    const cam = new Camera()
    cam.compute(1.5)
    const focus = cam.project(cam.x, 0, cam.z, 1000, 1000)
    expect(focus.ok).toBe(true)
    expect(focus.x).toBeCloseTo(500, 3)
    expect(focus.y).toBeGreaterThan(600)
    const s = Math.sin(cam.yaw)
    const c = Math.cos(cam.yaw)
    const horizon = cam.project(cam.eye[0] + s * 30000, 0, cam.eye[2] - c * 30000, 1000, 1000)
    expect(horizon.y).toBeGreaterThan(80)
    expect(horizon.y).toBeLessThan(300)
  })

  test("ground rect covers the focus and stays finite at any pitch", () => {
    const cam = new Camera()
    for (const pitch of [8, 24, 50, 85]) {
      cam.set({ ...DEFAULT_VIEW, x: 1200, z: -300, pitch: (pitch * Math.PI) / 180 })
      cam.compute(1.6)
      const [x0, z0, x1, z1] = cam.groundRect()
      for (const v of [x0, z0, x1, z1]) expect(Number.isFinite(v)).toBe(true)
      expect(x0).toBeLessThan(1200)
      expect(x1).toBeGreaterThan(1200)
      expect(z0).toBeLessThan(-300)
      expect(z1).toBeGreaterThan(-300)
      expect(x1 - x0).toBeLessThan(2 * FAR * 1.01 * 2)
    }
  })

  test("ground rect is empty when the slab is out of view", () => {
    const cam = new Camera()
    cam.compute(1.6)
    const r = frustumGroundRect(cam.viewProj, 50_000, 60_000, [0, 0, 0, 0])
    expect(r[0]).toBe(Infinity)
  })

  test("panning follows yaw", () => {
    const cam = new Camera()
    cam.set({ ...DEFAULT_VIEW, yaw: Math.PI / 2 })
    cam.update(1, 0, 1, false, 1.5)
    expect(cam.x).toBeGreaterThan(100)
    expect(Math.abs(cam.z)).toBeLessThan(1e-6)
  })

  test("?cam parses degrees and clamps", () => {
    const v = parseCam("100,-200,90,30,900")!
    expect(v.x).toBe(100)
    expect(v.z).toBe(-200)
    expect(v.yaw).toBeCloseTo(Math.PI / 2)
    expect(v.pitch).toBeCloseTo(Math.PI / 6)
    expect(v.dist).toBe(900)
    expect(parseCam("1,x")).toBeNull()
    expect(parseCam(null)).toBeNull()
  })
})

describe("static split", () => {
  test("foliage triangles go to their own stream", () => {
    const m = new Mesh()
    m.facet([0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 0, 0], MAT.lit)
    m.facet([0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 1, 0], MAT.foliage, 0.3)
    m.facet([0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], MAT.glow)
    const data = m.pack()
    const solid = new Uint8Array(data.byteLength)
    const foliage = new Uint8Array(data.byteLength)
    const [s, f] = splitFoliage(data, solid, 0, foliage, 0)
    expect(s).toBe(VERT_BYTES * 6)
    expect(f).toBe(VERT_BYTES * 3)
    // The foliage triangle's colour byte (green) survives the copy.
    expect(foliage[17]).toBe(255)
  })
})
