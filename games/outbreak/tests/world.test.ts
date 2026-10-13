import { describe, expect, test } from "bun:test"
import { clearLine } from "@arcade/kit/sim/geom"
import { advanceHour, dayCycle } from "../shared/day-cycle"
import { makeTown, sightRects, solidRects, toggleDoor } from "../shared/map"
import { Vision } from "../shared/vision"
import { LocalSession } from "../shared/session"

describe("neighbourhood", () => {
  test("same seed reproduces all nine chunks, structures and props", () => {
    expect(makeTown(7)).toEqual(makeTown(7))
    expect(makeTown(8)).not.toEqual(makeTown(7))
    const town = makeTown(7)
    expect(town.chunks).toHaveLength(9)
    expect(town.chunks[8]).toEqual([64, 64, 96, 96])
    expect(town.buildings.map(b => b.kind)).toEqual(["house", "house", "hardware", "pharmacy"])
    expect(town.doors).toHaveLength(8)
  })
  test("windows and fences pass eye LOS but block movement; walls block both", () => {
    const town = makeTown(7)
    const sight = sightRects(town)
    expect(clearLine(24.5, 39, 24.5, 35, sight)).toBe(true)
    expect(clearLine(24.5, 39, 24.5, 35, solidRects(town))).toBe(false)
    expect(clearLine(23, 39, 23, 35, sight)).toBe(false)
    expect(clearLine(19, 19, 19, 21, sight)).toBe(true)
    expect(clearLine(19, 19, 19, 21, solidRects(town))).toBe(false)
    const vision = new Vision()
    vision.update(24.5, 39, -Math.PI / 2, sight)
    expect(vision.visible(24.5, 35)).toBe(true)
    vision.update(23, 39, -Math.PI / 2, sight)
    expect(vision.visible(23, 35)).toBe(false)
  })
  test("nearby door toggles sight and movement, distant doors cannot toggle", () => {
    const town = makeTown(7)
    expect(clearLine(27.7, 39, 27.7, 35, sightRects(town))).toBe(false)
    expect(toggleDoor(town, 0, 0)).toBeUndefined()
    expect(toggleDoor(town, 27.7, 39)?.open).toBe(true)
    expect(clearLine(27.7, 39, 27.7, 35, sightRects(town))).toBe(true)
    expect(clearLine(27.7, 39, 27.7, 35, solidRects(town))).toBe(true)
    expect(toggleDoor(town, 27.7, 37.9)).toBeUndefined()
    expect(toggleDoor(town, 27.7, 39)?.open).toBe(false)
  })
  test("session can walk through an open door, but not a closed one", () => {
    const session = new LocalSession(7), p = session.view.player
    Object.assign(p, { x: 27.7, y: 39 })
    const cmd = { mx: 0, my: -1, aim: -Math.PI / 2, interact: false }
    for (let i = 0; i < 60; i++) session.update(1 / 60, cmd, 0)
    expect(p.y).toBeGreaterThan(38)
    session.update(1 / 60, { ...cmd, interact: true }, 0)
    for (let i = 0; i < 60; i++) session.update(1 / 60, cmd, 0)
    expect(p.y).toBeLessThan(36)
    expect(session.view.revision).toBe(1)
  })
})

describe("polar exploration", () => {
  test("110 degree cone, 360 close awareness, and persistent explored shroud", () => {
    const v = new Vision()
    v.update(44, 44, 0, [])
    expect(v.state(50, 44)).toBe("visible")
    expect(v.state(43, 44)).toBe("visible")
    expect(v.state(40, 44)).toBe("unexplored")
    expect(v.visible(49, 52)).toBe(false)
    v.update(44, 44, Math.PI, [])
    expect(v.state(50, 44)).toBe("explored")
    expect(v.state(40, 44)).toBe("visible")
    expect(v.state(90, 90)).toBe("unexplored")
  })
  test("polar rays stop at doors, then reveal the next room on opening", () => {
    const town = makeTown(7), v = new Vision()
    v.update(27.7, 31, -Math.PI / 2, sightRects(town))
    expect(v.state(27.7, 27)).toBe("unexplored")
    toggleDoor(town, 27.7, 31)
    v.update(27.7, 31, -Math.PI / 2, sightRects(town))
    expect(v.state(27.7, 27)).toBe("visible")
    toggleDoor(town, 27.7, 31)
    v.update(27.7, 31, -Math.PI / 2, sightRects(town))
    expect(v.state(27.7, 27)).toBe("explored")
  })
  test("close awareness does not see through a wall", () => {
    const v = new Vision()
    v.update(22.5, 30, 0, sightRects(makeTown(7)))
    expect(v.visible(21.5, 30)).toBe(false)
  })
})

describe("day cycle", () => {
  test("clock wraps in both directions and is independent of step partition", () => {
    expect(advanceHour(23.5, 30, 120)).toBe(0.5)
    expect(advanceHour(.5, -30, 120)).toBe(23.5)
    expect(advanceHour(18, 100, 0)).toBe(18)
    let hour = 18
    for (let i = 0; i < 60; i++) hour = advanceHour(hour, 1, 120)
    expect(hour).toBeCloseTo(advanceHour(18, 60, 120), 10)
  })
  test("dusk turns lamps on and night lowers ambient; arc stays normalized", () => {
    const noon = dayCycle(12), dusk = dayCycle(18), night = dayCycle(0)
    expect(noon.lamps).toBe(0)
    expect(dusk.lamps).toBeGreaterThan(.8)
    expect(night.lamps).toBe(1)
    expect(noon.ambient[0]).toBeGreaterThan(dusk.ambient[0])
    expect(dusk.ambient[0]).toBeGreaterThan(night.ambient[0])
    for (let h = 0; h < 24; h += .1) expect(Math.hypot(...dayCycle(h).direction)).toBeCloseTo(1, 8)
    expect(dayCycle(24)).toEqual(dayCycle(0))
  })
})
