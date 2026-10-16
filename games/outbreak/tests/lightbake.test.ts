import { describe, expect, test } from "bun:test"
import { makeTown } from "../shared/map"
import { addLampPool, gridClear, wallGrid } from "../src/lightbake"
import { bakedRoomLamp, bakeOutbreakBounce } from "../src/lighting"

describe("baked room light", () => {
  test("a lamp's pool lights its own room and stops at a wall, brightest under the lamp", () => {
    const res = 32
    const solid = wallGrid([[8, 0, 8.4, 16]], 0, 0, res, 0.5)
    expect(gridClear(solid, res, 4, 8, 12, 8)).toBe(true)
    expect(gridClear(solid, res, 4, 8, 20, 8)).toBe(false)
    const acc = new Float32Array(res * res * 3)
    addLampPool(acc, solid, res, 0, 0, 0.5, { x: 6, z: 8, h: 1.4, r: 4, color: [1, 0.5, 0.1], power: 0.2 })
    const at = (x: number, z: number) => acc[(Math.floor(z / 0.5) * res + Math.floor(x / 0.5)) * 3]!
    expect(at(6, 8)).toBeGreaterThan(at(4, 8))
    expect(at(4, 8)).toBeGreaterThan(0)
    expect(at(9, 8)).toBe(0)
  })

  test("the start house bakes pools for its accent lamps only, deterministically", () => {
    const town = makeTown(7)
    const pools = town.lamps.map(l => bakedRoomLamp(l, town.buildings)).filter(Boolean)
    expect(pools.length).toBe(14)
    const a = bakeOutbreakBounce(town)
    const b = bakeOutbreakBounce(makeTown(7))
    expect([...a.data]).toEqual([...b.data])
    // Ash's living-room lamp (24.75, 33.15) lights the floor under it.
    const i = Math.floor(33.15 / 0.5) * 192 + Math.floor(24.75 / 0.5)
    expect(a.linear![i * 3]).toBeGreaterThan(0.5)
  })
})
