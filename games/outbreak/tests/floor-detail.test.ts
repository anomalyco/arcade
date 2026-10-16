import { describe, expect, test } from "bun:test"
import { Mesh } from "@arcade/kit/gpu/mesh"
import { makeTown } from "../shared/map"
import { generateWorldChunk } from "../shared/world"
import { emitWallCapMoulding, floorPlateFor, interiorSettings } from "../src/interiors"
import { planInterior } from "../src/interiors/plan"

describe("floor detail", () => {
  test("every themed house but the station gets a library plate, the same one every time", () => {
    const town = makeTown(7)
    const chunk = generateWorldChunk(7, 7, 2, 1)
    const buildings = [...town.buildings, ...chunk.buildings]
    let plated = 0
    for (const b of buildings) {
      const plate = floorPlateFor(b, town.houseSeed)
      const theme = planInterior(b, town.houseSeed).theme
      if (theme === "station") expect(plate).toBeNull()
      else {
        expect(plate?.url).toContain(`floor-${theme}-`)
        plated++
      }
      expect(floorPlateFor(b, town.houseSeed)).toEqual(plate)
    }
    expect(plated).toBeGreaterThan(0)
  })

  test("moulded wall tops add six triangles a side, all at or under the 2.8 m roof cut, and none when off", () => {
    const m = new Mesh()
    emitWallCapMoulding(m, 0, 0, 4, 0.18)
    expect(m.count).toBe(36)
    for (let i = 1; i < m.v.length; i += 11) expect(m.v[i]!).toBeLessThanOrEqual(2.8)
    interiorSettings.wallCaps = 0
    const off = new Mesh()
    emitWallCapMoulding(off, 0, 0, 4, 0.18)
    interiorSettings.wallCaps = 1
    expect(off.count).toBe(0)
  })
})
