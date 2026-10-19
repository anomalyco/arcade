import { describe, expect, test } from "bun:test"
import { FLOATS_PER_VERT, MAT, Mesh } from "@arcade/kit/gpu/mesh"
import { makeTown } from "../shared/map"
import { baseRun, tallCabinet, upperRun, WALNUT_KITCHEN } from "../src/interiors/cabinetry"
import { emitInteriorDecor } from "../src/interiors/mesh"
import { interiorSettings, planInterior } from "../src/interiors/plan"
import { boardPlank, emitCraftWindow, emitFaceWindow } from "../src/interiors/windows"
import { interiorDeclarationsWgsl, outbreakInteriorRefs } from "../src/interiors/wgsl"
import { bloodWord } from "../src/details/models"

/** Every triangle's winding agrees with its stored normal, so back-face culling keeps the visible side. */
function expectWound(m: Mesh): void {
  const v = m.v, F = FLOATS_PER_VERT
  let bad = 0
  for (let i = 0; i < v.length; i += F * 3) {
    const ax = v[i]!, ay = v[i + 1]!, az = v[i + 2]!
    const ux = v[i + F]! - ax, uy = v[i + F + 1]! - ay, uz = v[i + F + 2]! - az
    const wx = v[i + 2 * F]! - ax, wy = v[i + 2 * F + 1]! - ay, wz = v[i + 2 * F + 2]! - az
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx
    const l = Math.hypot(nx, ny, nz)
    if (l < 1e-9) continue
    if ((nx * v[i + 3]! + ny * v[i + 4]! + nz * v[i + 5]!) / l < 0.5) bad++
  }
  expect(bad).toBe(0)
}

function bounds(m: Mesh): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < m.v.length; i += FLOATS_PER_VERT) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k]!, m.v[i + k]!); max[k] = Math.max(max[k]!, m.v[i + k]!) }
  return { min, max }
}

describe("interior craft pass (AR-69)", () => {
  test("windows: street trim on the street side, drapes in the room, glass only in the glass pass, wound outward", () => {
    for (const out of [1, -1] as const) {
      for (const rect of [[10, 20, 12.5, 20.22], [10, 20, 10.22, 22.5]] as const) {
        const low = new Mesh(), high = new Mesh(), glass = new Mesh()
        emitCraftWindow({ low, high, glass }, rect, { out, theme: "mansion", lamp: 3, glow: () => [[0.5, 0.3, 0.1], [0.4, 0.2, 0.1]] })
        for (const m of [low, high, glass]) expectWound(m)
        for (let i = 9; i < glass.v.length; i += FLOATS_PER_VERT) expect(glass.v[i]).toBe(MAT.glass)
        for (const m of [low, high]) for (let i = 9; i < m.v.length; i += FLOATS_PER_VERT) expect(m.v[i]).not.toBe(MAT.glass)
        const alongX = rect[2] - rect[0] > rect[3] - rect[1]
        const k = alongX ? 2 : 0
        const street = out > 0 ? (alongX ? rect[3] : rect[2]) : alongX ? rect[1] : rect[0]
        const room = out > 0 ? (alongX ? rect[1] : rect[0]) : alongX ? rect[3] : rect[2]
        const b = bounds(high), l = bounds(low)
        // The sill projects past the street face; drapes and pelmet hang into the room, never through the wall.
        if (out > 0) { expect(l.max[k]!).toBeGreaterThan(street + 0.05); expect(b.min[k]!).toBeLessThan(room - 0.1) }
        else { expect(l.min[k]!).toBeLessThan(street - 0.05); expect(b.max[k]!).toBeGreaterThan(room + 0.1) }
        // Low parts stay under the cut line; everything stays within a hand's width of the opening along the wall.
        expect(l.max[1]!).toBeLessThanOrEqual(0.88)
        const u = alongX ? 0 : 2
        expect(b.min[u]!).toBeGreaterThan((alongX ? rect[0] : rect[1]) - 0.35)
        expect(b.max[u]!).toBeLessThan((alongX ? rect[2] : rect[3]) + 0.35)
      }
    }
  })

  test("face windows and barricade boards are wound to face out of their wall", () => {
    for (const toward of [1, -1] as const) for (const alongX of [true, false]) {
      const m = new Mesh()
      emitFaceWindow(m, alongX, 5, toward, 1, 2.2, 1, 2, [0.5, 0.3, 0.1], 2, "plain")
      expectWound(m)
      const k = alongX ? 2 : 0
      const b = bounds(m)
      // Nothing sinks into the wall it hangs on.
      if (toward > 0) expect(b.min[k]!).toBeGreaterThanOrEqual(5 - 1e-6)
      else expect(b.max[k]!).toBeLessThanOrEqual(5 + 1e-6)
      const p = new Mesh()
      boardPlank(p, alongX, 5, toward, 1, 2.6, 1.3, 0.1, false)
      expectWound(p)
      const pb = bounds(p)
      if (toward > 0) expect(pb.min[k]!).toBeGreaterThanOrEqual(5 - 1e-6)
      else expect(pb.max[k]!).toBeLessThanOrEqual(5 + 1e-6)
    }
  })

  test("cabinetry stands on the room side of its wall, on the floor, with a real sink well", () => {
    const m = new Mesh()
    const f = { alongX: true, inner: 30, out: -1 as const }
    tallCabinet(m, f, 0, 0.9, WALNUT_KITCHEN)
    baseRun(m, f, 0.95, 4.5, WALNUT_KITCHEN, { sink: [1.8, 2.7], splash: 1.02 })
    upperRun(m, f, 0.95, 1.6, WALNUT_KITCHEN, { lamp: 4 })
    expectWound(m)
    const b = bounds(m)
    expect(b.min[2]!).toBeGreaterThanOrEqual(30 - 1e-6)
    expect(b.max[2]!).toBeLessThan(30.72)
    expect(b.min[1]!).toBeGreaterThanOrEqual(0.13 - 1e-6)
    // The well floor sits well below the counter top inside the sink span.
    let well = Infinity
    for (let i = 0; i < m.v.length; i += FLOATS_PER_VERT) if (m.v[i]! > 1.85 && m.v[i]! < 2.65 && m.v[i + 4]! > 0.9) well = Math.min(well, m.v[i + 1]!)
    expect(well).toBeLessThan(0.82)
  })

  test("skirting, rails and pictures dress plain rooms in the craft pass and nothing in Today", () => {
    const town = makeTown(7)
    const b = town.buildings.find(o => o.kind !== "house")!
    expect(planInterior(b, town.houseSeed).theme).toBe("plain")
    const before = interiorSettings.craft
    try {
      interiorSettings.craft = 0
      const today = new Mesh()
      emitInteriorDecor(today, b, town)
      expect(today.v.length).toBe(0)
      interiorSettings.craft = 1
      const craft = new Mesh()
      emitInteriorDecor(craft, b, town)
      expect(craft.v.length).toBeGreaterThan(0)
      expectWound(craft)
    } finally {
      interiorSettings.craft = before
    }
  })

  test("blood writing is wound to face the room and deterministic per phrase", () => {
    const a = new Mesh(), b = new Mesh()
    bloodWord(a, "DONT OPEN", 0.3)
    bloodWord(b, "DONT OPEN", 0.3)
    expectWound(a)
    expect(a.v).toEqual(b.v)
    const c = new Mesh()
    bloodWord(c, "STAY QUIET", 0.26)
    expect(c.v.length).toBeGreaterThan(0)
  })
})

describe("interior texture addressing", () => {
  const wgsl = interiorDeclarationsWgsl(outbreakInteriorRefs)
  const body = (name: string) => wgsl.slice(wgsl.indexOf(`fn ${name}(`), wgsl.indexOf("\n}\n", wgsl.indexOf(`fn ${name}(`)))

  test("wallpaper, parquet and floor plates wrap with the repeat sampler at a size-aware mip", () => {
    const tile = body("interiorTileSample")
    expect(tile).toContain("materialSampler")
    expect(tile).toContain("fract(uv)")
    expect(tile).toContain("textureDimensions(detailTex)")
    expect(tile).toContain("textureNumLevels(detailTex)")
    for (const fn of ["themedWall", "themedFloor", "interiorFloorPlate"]) {
      expect(body(fn)).toContain("interiorTileSample(")
      // The clamp-to-edge detail sampler smears world-space tiles at their edge.
      expect(body(fn)).not.toContain("detailSamp")
      expect(body(fn)).not.toContain("materialMipLod")
    }
  })
})
