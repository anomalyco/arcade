import { describe, expect, test } from "bun:test"
import { LIGHT_FLOATS, MAX_LIGHTS } from "../limits"
import { LAMP_GRID_CELL, LAMP_GRID_DIM, LAMP_GRID_SLOTS, LampGrid } from "./lamp-grid"

function packLight(
  lights: Float32Array,
  slot: number,
  x: number,
  y: number,
  z: number,
  r: number,
  power: number,
  cone: [number, number, number, number] = [0, 0, 0, 0],
  extra: [number, number, number, number] = [0, 0, 0.16, 0],
): void {
  const b = slot * LIGHT_FLOATS
  lights[b] = x
  lights[b + 1] = y
  lights[b + 2] = z
  lights[b + 3] = r
  lights[b + 4] = 1
  lights[b + 5] = 0.5
  lights[b + 6] = 0.15
  lights[b + 7] = power
  lights[b + 8] = cone[0]
  lights[b + 9] = cone[1]
  lights[b + 10] = cone[2]
  lights[b + 11] = cone[3]
  lights[b + 12] = extra[0]
  lights[b + 13] = extra[1]
  lights[b + 14] = extra[2]
  lights[b + 15] = extra[3]
}

describe("LampGrid (uLampGrid 0.5 m spatial light-list grid)", () => {
  test("assigns 0.5 m cells for static lamps while keeping dynamic prefix out of the grid", () => {
    const grid = new LampGrid()
    expect(grid.width).toBe(LAMP_GRID_DIM)
    expect(grid.height).toBe(LAMP_GRID_DIM)
    expect(grid.cellSize).toBe(LAMP_GRID_CELL)

    const lights = new Float32Array(MAX_LIGHTS * LIGHT_FLOATS)
    // Slot 0: eye, Slot 1: dynamic player flashlight (directLightCount = 2)
    packLight(lights, 0, 20, 1.5, 20, 12, 0)
    packLight(lights, 1, 20, 1.2, 20, 14, 1.2, [1, 0, 0.7, 2], [0, 16, 0.06, -1])
    // Slot 2: static streetlamp at (24, 30), radius 4.0 m
    packLight(lights, 2, 24, 3.8, 30, 4.0, 0.85, [0, 0, 0, 0], [0, 0, 0.22, 0])
    // Slot 3: static porch lamp at (26, 30), radius 3.0 m
    packLight(lights, 3, 26, 2.2, 30, 3.0, 0.55, [0, 0, 0, -1], [0, 0, 0.18, 1])

    const changed = grid.update(lights, 2, 4, 0, 0)
    expect(changed).toBe(true)
    expect(grid.activeCellCount).toBeGreaterThan(0)
    expect(grid.overflowCount).toBe(0)

    // At (25, 30), both static lamps (slots 2 and 3) overlap, while dynamic slots 0 and 1 are excluded
    expect(grid.slotsAtWorld(25.0, 30.0)).toEqual([2, 3])
    // At (21, 30), only slot 2 (streetlamp at x=24, r=4) reaches; slot 3 (at x=26, r=3) does not
    expect(grid.slotsAtWorld(21.0, 30.0)).toEqual([2])
    // Outside both radii
    expect(grid.slotsAtWorld(10.0, 10.0)).toEqual([])
  })

  test("clips interior table lamps, wall sconces, and window spotlights to their room/cone masks", () => {
    const grid = new LampGrid()
    const lights = new Float32Array(MAX_LIGHTS * LIGHT_FLOATS)
    packLight(lights, 0, 20, 1.5, 20, 12, 0)

    // Slot 1: Table lamp at (15, 15), radius 2.6 m, clipped to room [14, 14, 16, 16] (cone.w = -3)
    packLight(lights, 1, 15, 1.1, 15, 2.6, 0.45, [14, 14, 16, -3], [16, -1, 0.08, 0])
    // Slot 2: Wall sconce at (30, 30) on north wall facing +Z (cone.xy = (0, 1), cone.w = 1.25),
    // room span along X: left = 2.0 (`extra.y = -(2 + 1) = -3`), right = 2.0 (`cone.z = -(2 + 1.25) = -3.25`), backCut = 0.08
    packLight(lights, 2, 30, 1.85, 30, 3.2, 0.65, [0, 1, -3.25, 1.25], [0.08, -3.0, 0.08, 0.25])
    // Slot 3: Window lamp at (45, 45) throwing +Z outdoors (cone.xy = (0, 1), cone.w = 1)
    packLight(lights, 3, 45, 1.42, 45, 3.2, 0.5, [0, 1, -0.65, 1], [0, 0, 0.2, 2])

    grid.update(lights, 1, 4, 0, 0)

    // Table lamp reaches inside room [14..16, 14..16] but is clipped across the wall at x = 13.2
    expect(grid.slotsAtWorld(15.2, 15.2)).toEqual([1])
    expect(grid.slotsAtWorld(13.2, 15.2)).toEqual([])

    // Sconce lights in front of wall (z > 30) within room X span [28..32], but not behind the wall (z = 29.2) or down the hall (x = 27.0)
    expect(grid.slotsAtWorld(30.0, 31.2)).toEqual([2])
    expect(grid.slotsAtWorld(30.0, 29.2)).toEqual([])
    expect(grid.slotsAtWorld(27.0, 30.5)).toEqual([])

    // Window lamp lights outdoors (z > 45) but not inside the house behind the sill (z < 44.5)
    expect(grid.slotsAtWorld(45.0, 46.5)).toEqual([3])
    expect(grid.slotsAtWorld(45.0, 44.2)).toEqual([])
  })

  test("handles lamp flicker without rebuilding, and rebuilds when lamps toggle off or break", () => {
    const grid = new LampGrid()
    const lights = new Float32Array(MAX_LIGHTS * LIGHT_FLOATS)
    packLight(lights, 0, 20, 1.5, 20, 12, 0)
    packLight(lights, 1, 32, 3.5, 32, 4.5, 0.8)

    expect(grid.update(lights, 1, 2, 0, 0)).toBe(true)
    grid.markUploaded()
    expect(grid.dirtyRows).toBeNull()
    const buildsAfterInit = grid.buildCount

    // Flicker: power oscillates above 0.001 while position/radius stay constant -> no rebuild needed
    lights[1 * LIGHT_FLOATS + 7] = 0.62
    expect(grid.update(lights, 1, 2, 0, 0)).toBe(false)
    expect(grid.buildCount).toBe(buildsAfterInit)
    expect(grid.dirtyRows).toBeNull()

    // Lamp breaks / toggles off (power = 0) -> rebuilds and clears cell
    lights[1 * LIGHT_FLOATS + 7] = 0
    expect(grid.update(lights, 1, 2, 0, 0)).toBe(true)
    expect(grid.slotsAtWorld(32, 32)).toEqual([])
    expect(grid.dirtyRows).not.toBeNull()
  })

  test("applies priority-scored overflow policy when more than 4 static lamps overlap a cell", () => {
    const grid = new LampGrid()
    const lights = new Float32Array(MAX_LIGHTS * LIGHT_FLOATS)
    packLight(lights, 0, 20, 1.5, 20, 12, 0)

    // 6 static lamps overlapping (40.25, 40.25) with different powers/distances:
    // Slot 1: very weak distant lamp (power 0.05)
    packLight(lights, 1, 43.0, 2.5, 40.25, 4.0, 0.05)
    // Slot 2: medium lamp (power 0.45)
    packLight(lights, 2, 40.25, 2.2, 40.25, 4.0, 0.45)
    // Slot 3: dim lamp (power 0.12)
    packLight(lights, 3, 42.0, 2.5, 40.25, 4.0, 0.12)
    // Slot 4: bright lamp (power 0.90)
    packLight(lights, 4, 40.25, 2.2, 40.25, 4.0, 0.90)
    // Slot 5: bright lamp (power 0.75)
    packLight(lights, 5, 40.5, 2.2, 40.25, 4.0, 0.75)
    // Slot 6: shadow-casting primary room lamp (power 0.50, extra.y = 12 occluders -> 2x shadow boost)
    packLight(lights, 6, 40.25, 1.3, 40.25, 3.6, 0.50, [0, 0, 0, -1], [0, 12, 0.16, 0])

    grid.update(lights, 1, 7, 0, 0)
    expect(grid.overflowCount).toBeGreaterThan(0)

    const kept = grid.slotsAtWorld(40.25, 40.25)
    expect(kept.length).toBe(LAMP_GRID_SLOTS)
    // Weakest slots 1 and 3 are evicted; top 4 slots [2, 4, 5, 6] are kept in ascending slot order
    expect(kept).toEqual([2, 4, 5, 6])
  })

  test("updates grid origin when streaming chunks enter and leave", () => {
    const grid = new LampGrid()
    const lights = new Float32Array(MAX_LIGHTS * LIGHT_FLOATS)
    packLight(lights, 0, 50, 1.5, 50, 12, 0)
    // Static lamp in chunk (3, 1) at world (108, 44)
    packLight(lights, 1, 108, 3.8, 44, 4.5, 0.8)

    // Window anchored at (0, 0) covers [0..96, 0..96]: lamp at x=108 is outside window
    grid.update(lights, 1, 2, 0, 0)
    expect(grid.activeCellCount).toBe(0)

    // Streaming window shifts +1 chunk in X to origin (32, 0), covering [32..128, 0..96]
    const shifted = grid.update(lights, 1, 2, 32, 0)
    expect(shifted).toBe(true)
    expect(grid.activeCellCount).toBeGreaterThan(0)
    expect(grid.slotsAtWorld(108, 44)).toEqual([1])
    expect(grid.slotsAtWorld(40, 44)).toEqual([])
  })
})
