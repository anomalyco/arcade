import { describe, expect, test } from "bun:test"
import { FLOATS_PER_VERT, Mesh } from "@arcade/kit/gpu/mesh"
import { LIGHT_FLOATS } from "@arcade/kit/limits"
import type { Rect } from "@arcade/kit/sim/geom"
import { makeTown } from "../shared/map"
import { collectMirrors, MIRROR_W, mirrorFootprint } from "../src/interiors/mesh"
import { furnishedHouses } from "../src/props/furnish"
import { packReflectionLights, REFLECTION_LIGHT_FLOATS, REFLECTION_LIGHTS } from "../src/reflections/lights"
import { mirrorModel } from "../src/reflections/mirror"
import { DEFAULT_REFLECTION_TRIMS, mirrorsShown, packReflectionUniforms, REFLECTION_UNIFORM_FLOATS } from "../src/reflections/settings"
import { MAT_MIRROR } from "../src/reflections/wgsl"

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

const overlaps = (a: Rect, b: Rect) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]

describe("reflections", () => {
  test("mirrors are deterministic, the start house always has one, others are rare", () => {
    for (const seed of [7, 11, 23, 42]) {
      const town = makeTown(seed)
      const a = collectMirrors(town)
      expect(collectMirrors(makeTown(seed))).toEqual(a)
      const start = a.filter((s) => s.start)
      expect(start.length).toBe(1)
      expect(start[0]!.buildingId).toBe("ash")
      expect(start[0]!.cracked).toBe(false)
    }
    let others = 0
    let houses = 0
    for (let seed = 1; seed <= 80; seed++) {
      const town = makeTown(seed)
      houses += town.buildings.length - 1
      others += collectMirrors(town).filter((s) => !s.start).length
    }
    expect(others).toBeGreaterThan(0)
    expect(others / houses).toBeLessThan(0.15)
    const ash = collectMirrors(makeTown(7)).find((s) => s.start)!
    // Beside the inner door on the dining side, clear of the built-in kitchen run.
    expect(ash.x).toBeCloseTo(30.43, 1)
    expect(ash.z).toBeCloseTo(29.7, 2)
  })

  test("a mirror stands clear of doors, furniture and clutter", () => {
    const town = makeTown(7)
    const houses = furnishedHouses(town)
    for (const s of collectMirrors(town)) {
      const fp = mirrorFootprint(s)
      for (const d of town.doors) {
        if (d.rect[1] > s.z + 0.3 || d.rect[3] < s.z - 0.3) continue
        expect(Math.max(d.rect[0] - (s.x + MIRROR_W / 2), s.x - MIRROR_W / 2 - d.rect[2])).toBeGreaterThan(1.45)
      }
      for (const h of houses) {
        if (h.building !== s.buildingId) continue
        for (const p of [...h.anchors, ...h.clutter]) if (p.y < 0.05) expect(overlaps(fp, p.footprint)).toBe(false)
      }
      for (const p of town.props) {
        const r: Rect = [p.x - 0.2, p.y - 0.2, p.x + 0.2, p.y + 0.2]
        expect(overlaps(fp, r)).toBe(false)
      }
    }
  })

  test("the mirror model faces outward and its glass carries uv", () => {
    for (const cracked of [false, true]) {
      const m = mirrorModel(cracked)
      expectWound(m)
      let glass = 0
      for (let i = 0; i < m.v.length; i += FLOATS_PER_VERT) {
        if (m.v[i + 9] !== MAT_MIRROR) continue
        glass++
        expect(m.v[i + 5]!).toBeGreaterThan(0.9)
      }
      expect(glass).toBe(6)
    }
  })

  test("Today packs nothing and draws no mirrors", () => {
    const out = new Float32Array(REFLECTION_UNIFORM_FLOATS).fill(9)
    packReflectionUniforms({ ...DEFAULT_REFLECTION_TRIMS, reflections: 0 }, 1, out, 0)
    expect([out[0], out[1], out[2], out[3], out[6]]).toEqual([0, 0, 0, 0, 0])
    expect(mirrorsShown({ ...DEFAULT_REFLECTION_TRIMS, reflections: 0 })).toBe(0)
    packReflectionUniforms(DEFAULT_REFLECTION_TRIMS, 0.5, out, 0)
    expect([out[0], out[1], out[3], out[6]]).toEqual([1, 1, 0.5, 1])
  })

  test("wet reflections take outdoor lights near the view and skip table lamps, sconces and the flashlight", () => {
    const town = makeTown(7)
    const ash = town.buildings.find((b) => b.id === "ash")!
    const lights = new Float32Array(16 * LIGHT_FLOATS)
    const put = (i: number, x: number, z: number, type: number, h = 4) => {
      const b = i * LIGHT_FLOATS
      lights.fill(0, b, b + LIGHT_FLOATS)
      lights[b] = x
      lights[b + 1] = h
      lights[b + 2] = z
      lights[b + 4] = 1
      lights[b + 5] = 0.5
      lights[b + 6] = 0.25
      lights[b + 7] = 2
      lights[b + 11] = type
    }
    put(0, 30, 40, -1) // sight
    put(1, 30, 40, 2) // flashlight
    put(2, 30, 38, -1) // streetlamp
    put(3, 30, 30, -3) // table lamp
    put(4, 30, 30, 1.25) // sconce
    put(5, 30, 30, -1) // a plain lamp inside the house
    put(6, 30, 35.6, 1, 1.5) // window, its cone facing the street
    lights[6 * LIGHT_FLOATS + 9] = 1
    lights[6 * LIGHT_FLOATS + 10] = 0.5
    put(7, 300, 300, -1) // off screen
    const out = new Float32Array(REFLECTION_LIGHTS * REFLECTION_LIGHT_FLOATS)
    const eye: [number, number, number] = [30, 30, 60]
    const slots = packReflectionLights(lights, 8, [ash], [20, 25, 40, 45], eye, () => 0, out, 0)
    // Nearest image to the view's centre first: the window's lands at z 36.8, the streetlamp's at 40.6.
    expect(slots).toEqual([6, 2])
    // The streetlamp's image sits k = 4 / 34 of the way to the eye, its colour scaled by power.
    const lamp = REFLECTION_LIGHT_FLOATS
    const k = 4 / 34
    expect(out[lamp]).toBeCloseTo(30)
    expect(out[lamp + 1]).toBeCloseTo(38 + (60 - 38) * k)
    expect(out[lamp + 2]).toBeCloseTo(22)
    expect(out[lamp + 4]).toBeCloseTo(2)
    expect(out[2 * REFLECTION_LIGHT_FLOATS + 3]).toBe(0)
    // A window whose cone faces away from its image gives none.
    lights[6 * LIGHT_FLOATS + 9] = -1
    expect(packReflectionLights(lights, 8, [ash], [20, 25, 40, 45], eye, () => 0, out, 0)).toEqual([2])
    for (let i = 0; i < 16; i++) put(i, 30 + i * 0.1, 40, -1)
    expect(packReflectionLights(lights, 16, [], [20, 25, 40, 45], eye, () => 0, out, 0).length).toBe(REFLECTION_LIGHTS)
  })
})
