import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { PROP_SPECS, propSpec } from "./catalogue"
import { MAT } from "../gpu/mesh"
import { decodeProp, encodeProp, type PropAsset } from "./format"
import { DEFAULT_PROP_LOOK, propMesh } from "./mesh"
import { PropBatches, PropModels, yawFacing } from "./models"
import { dressSurfaces, footprintOf, furnishRoom, type Rect, type RoomSpec } from "./placement"

const tri: PropAsset = {
  min: [-0.5, 0, -0.25],
  max: [0.5, 1, 0.25],
  lods: [{
    positions: new Float32Array([-0.5, 0, -0.25, 0.5, 0, 0.25, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    colors: new Uint8Array([200, 100, 50, 10, 20, 30, 255, 255, 255]),
    ao: new Uint8Array([255, 128, 0]),
    mats: new Uint8Array([0, 10, 24]),
    indices: new Uint16Array([0, 1, 2]),
  }],
}

describe("prop format", () => {
  test("round-trips through encode and decode", () => {
    const back = decodeProp(encodeProp(tri))
    expect(back.min).toEqual(tri.min)
    expect(back.lods[0]!.indices).toEqual(tri.lods[0]!.indices)
    expect(back.lods[0]!.colors).toEqual(tri.lods[0]!.colors)
    expect(back.lods[0]!.mats).toEqual(tri.lods[0]!.mats)
    back.lods[0]!.positions.forEach((v, i) => expect(Math.abs(v - tri.lods[0]!.positions[i]!)).toBeLessThan(1e-4))
  })

  test("rejects other files", () => {
    expect(() => decodeProp(new ArrayBuffer(64))).toThrow()
  })

  test("every shipped asset matches its catalogue entry", () => {
    for (const spec of PROP_SPECS) {
      const url = new URL(`./assets/${spec.id}.prop`, import.meta.url)
      if (!existsSync(url)) continue
      const a = decodeProp(readFileSync(url).buffer as ArrayBuffer)
      expect(a.lods.length).toBe(2)
      expect(a.min[1]).toBeCloseTo(0, 2)
      const size = [a.max[0] - a.min[0], a.max[1] - a.min[1], a.max[2] - a.min[2]]
      size.forEach((v, k) => expect(Math.abs(v / spec.size[k]! - 1)).toBeLessThan(0.16))
      a.lods.forEach((lod, i) => expect(lod.indices.length / 3).toBeLessThanOrEqual(spec.lod[i]! * 1.02))
    }
  })
})

describe("prop meshes and batches", () => {
  test("expands indices and applies the look", () => {
    const m = propMesh(tri.lods[0]!, { ...DEFAULT_PROP_LOOK, brightness: 1, ao: 1, saturation: 1 })
    expect(m.v.length).toBe(3 * 11)
    expect(m.v[6]).toBeCloseTo(200 / 255, 3)
    expect(m.v[2 * 11 + 6]).toBeCloseTo(0, 3) // fully occluded corner
    expect([m.v[9], m.v[11 + 9], m.v[2 * 11 + 9]]).toEqual([MAT.lit, MAT.shiny, MAT.lit]) // only lit or shiny
  })

  test("welds split seam vertices across shared positions, encodes AO in sRGB, and keeps MAT.shiny only on all-shiny faces", () => {
    const splitSeam: PropAsset["lods"][number] = {
      // Five triangles (>12 indices) sharing edge (0,0,0)-(1,0,0) with duplicated split vertices (0,1 and 3,4) that have a 0-vs-255 AO jump
      positions: new Float32Array([
        0, 0, 0,  1, 0, 0,  0, 1, 0,
        0, 0, 0,  1, 0, 0,  0, -1, 0,
      ]),
      normals: new Float32Array([
        0, 1, 0,  0, 1, 0,  0, 1, 0,
        0, 1, 0,  0, 1, 0,  0, 1, 0,
      ]),
      colors: new Uint8Array([
        255, 255, 255,  255, 255, 255,  255, 255, 255,
        255, 255, 255,  255, 255, 255,  255, 255, 255,
      ]),
      ao: new Uint8Array([255, 255, 255, 0, 0, 255]),
      mats: new Uint8Array([10, 10, 10, 10, 10, 0]),
      indices: new Uint16Array([0, 1, 2, 3, 4, 5, 0, 1, 2, 3, 4, 5, 0, 1, 2]),
    }
    const m = propMesh(splitSeam, { ...DEFAULT_PROP_LOOK, brightness: 1, ao: 1, saturation: 1 })
    // Duplicated seam vertices (0 and 3 at (0,0,0)) weld to identical color/AO
    expect(m.v[0 * 11 + 6]).toBeCloseTo(m.v[3 * 11 + 6]!, 5)
    expect(m.v[1 * 11 + 6]).toBeCloseTo(m.v[4 * 11 + 6]!, 5)
    // First triangle has all 3 vertices mat=10 -> MAT.shiny; second triangle has mixed [10,10,0] -> MAT.lit
    expect(m.v[0 * 11 + 9]).toBe(MAT.shiny)
    expect(m.v[3 * 11 + 9]).toBe(MAT.lit)
  })

  test("lamp faces above the shade line glow through the given light slot", () => {
    const quad: PropAsset["lods"][number] = {
      ...tri.lods[0]!,
      positions: new Float32Array([-0.5, 0, 0, 0.5, 0, 0, 0, 0.4, 0, -0.5, 0.6, 0, 0.5, 0.6, 0, 0, 1, 0]),
      normals: new Float32Array(18).fill(0),
      colors: new Uint8Array(18).fill(200),
      ao: new Uint8Array(6).fill(255),
      mats: new Uint8Array(6),
      indices: new Uint16Array([0, 1, 2, 3, 4, 5]),
    }
    const m = propMesh(quad, DEFAULT_PROP_LOOK, { from: 0.5, aux: 30 })
    expect([m.v[9], m.v[10]]).toEqual([MAT.lit, 0])
    expect([m.v[3 * 11 + 9], m.v[3 * 11 + 10]]).toEqual([MAT.lamp, 30])
  })

  test("one batch per model, LOD per instance", async () => {
    let next = 0
    const models = new PropModels({ addModel: () => next++ }, undefined)
    const lib = models.library as unknown as { assets: Map<string, PropAsset> }
    lib.assets.set("bed", { ...tri, lods: [tri.lods[0]!, tri.lods[0]!] })
    await models.ensure(["bed"])
    const batches = new PropBatches(models).collect(
      [{ id: "bed", x: 1, y: 0, z: 2, yaw: 0, scale: 1 }, { id: "bed", x: 3, y: 0, z: 2, yaw: 0, scale: 1 }, { id: "bed", x: 9, y: 0, z: 9, yaw: 0, scale: 1 }, { id: "missing", x: 0, y: 0, z: 0, yaw: 0, scale: 1 }],
      p => (p.x > 5 ? 1 : 0),
    )
    expect(batches.map(b => [b.model, b.count])).toEqual([[0, 2], [1, 1]])
  })

  test("yawFacing turns +Z to the requested direction", () => {
    for (const [dx, dz] of [[1, 0], [0, -1], [-1, 0], [0.6, 0.8]] as const) {
      const a = yawFacing(dx, dz)
      expect(-Math.sin(a)).toBeCloseTo(dx, 6)
      expect(Math.cos(a)).toBeCloseTo(dz, 6)
    }
  })
})

describe("room furnishing", () => {
  const room: RoomSpec = {
    rect: [0, 0, 6, 4.5],
    room: "living",
    doors: [[2.5, 4.4, 3.9, 4.6]],
    windows: [[0.5, -0.1, 2.5, 0.05]],
    occupied: [[0.1, 1, 1.3, 3.6], [2, 1.5, 3.2, 3]],
  }
  const opts = { seed: 7, density: 1.4 }

  test("is deterministic per seed and changes with it", () => {
    const a = furnishRoom(room, opts)
    expect(furnishRoom(room, opts)).toEqual(a)
    expect(JSON.stringify(furnishRoom(room, { ...opts, seed: 8 }))).not.toBe(JSON.stringify(a))
  })

  test("keeps inside the room, off colliders and doorways, tall pieces off windows", () => {
    const overlaps = (a: Rect, b: Rect) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
    for (let seed = 1; seed < 40; seed++) {
      const placed = furnishRoom(room, { seed, density: 2 })
      for (const p of placed) {
        expect(p.footprint[0]).toBeGreaterThanOrEqual(-1e-6)
        expect(p.footprint[3]).toBeLessThanOrEqual(4.5 + 1e-6)
        for (const o of room.occupied) expect(overlaps(p.footprint, o)).toBe(false)
        const d = room.doors[0]!
        expect(Math.hypot(Math.max(0, d[0] - p.footprint[2], p.footprint[0] - d[2]), Math.max(0, d[1] - p.footprint[3], p.footprint[1] - d[3]))).toBeGreaterThanOrEqual(0.95 - 1e-6)
        if (p.spec.size[1] * p.scale > 1) expect(overlaps(p.footprint, [0.25, -0.35, 2.75, 0.3])).toBe(false)
        if (p.spec.placement === "wall") expect(p.spec.size[2]).toBeLessThanOrEqual(0.42)
      }
      placed.forEach((p, i) => placed.slice(i + 1).forEach(q => expect(overlaps(p.footprint, q.footprint)).toBe(false)))
    }
  })

  test("dresses tops inside their bounds at their height", () => {
    const top = { x: 3, z: 2, yaw: Math.PI / 2, w: 1.4, d: 0.5, h: propSpec("sideboard").surface!, room: "living" as const }
    const items = dressSurfaces([top], { seed: 3, density: 2 })
    expect(items.length).toBeGreaterThan(0)
    for (const it of items) {
      expect(it.y).toBe(top.h)
      expect(Math.abs(it.x - top.x)).toBeLessThanOrEqual(top.d / 2 + 0.01)
      expect(Math.abs(it.z - top.z)).toBeLessThanOrEqual(top.w / 2 + 0.01)
      expect(it.spec.placement).toBe("tabletop")
    }
  })

  test("footprints turn with yaw", () => {
    expect(footprintOf(0, 0, 2, 1, Math.PI / 2).map(v => Math.round(v * 1e6) / 1e6)).toEqual([-0.5, -1, 0.5, 1])
  })
})
