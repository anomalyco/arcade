import { afterEach, describe, expect, test } from "bun:test"
import { makeTown } from "../shared/map"
import { furnishedHouses, propFloorFootprints, propLamps } from "../src/props/furnish"
import { propDressingState, propLevelSignature } from "../src/props/state"

const reset = () => Object.assign(propDressingState, { on: false, density: 1, seed: 0 })

describe("prop dressing exports for the level bake", () => {
  afterEach(reset)

  test("nothing while off, and the level key is unchanged", () => {
    const town = makeTown(7)
    expect(propFloorFootprints(town)).toEqual([])
    expect(propLamps(town)).toEqual([])
    expect(propLevelSignature()).toBe("0")
  })

  test("floor clutter over 0.3 m and table lamps come from the same plan as the drawn props", () => {
    const town = makeTown(7)
    Object.assign(propDressingState, { on: true, density: 1.5, seed: 3 })
    const clutter = furnishedHouses(town).flatMap(h => h.clutter)
    const floor = propFloorFootprints(town)
    expect(floor.length).toBeGreaterThan(0)
    expect(floor.length).toBe(clutter.filter(p => p.y < 0.01 && p.spec.size[1] * p.scale > 0.3).length)
    for (const f of floor) expect(f.height).toBeGreaterThan(0.3)
    const lamps = propLamps(town)
    const placed = clutter.filter(p => p.id === "table-lamp")
    expect(lamps.length).toBeGreaterThan(0)
    expect(lamps.length).toBe(placed.length)
    lamps.forEach((l, i) => {
      expect(l.x).toBe(placed[i]!.x)
      expect(l.h).toBeGreaterThan(placed[i]!.y + 0.3) // shade centre, above the tabletop
      expect(l.h).toBeLessThan(placed[i]!.y + 0.6)
    })
    expect(propLevelSignature()).toBe("1/1.5/3")
  })
})
