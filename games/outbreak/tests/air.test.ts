import { describe, expect, test } from "bun:test"
import { Particles } from "@arcade/kit/fx/particles"
import { makeTown } from "../shared/map"
import { DEFAULT_AIR_SETTINGS } from "../src/air/settings"
import { smokeSources, WorldSmoke } from "../src/air/smoke"

const town = makeTown(7)
const flat = () => 0

describe("world smoke", () => {
  test("placement is a pure function of the town and seed", () => {
    const a = smokeSources(town, DEFAULT_AIR_SETTINGS)
    expect(a.length).toBeGreaterThan(0)
    expect(smokeSources(makeTown(7), DEFAULT_AIR_SETTINGS)).toEqual(a)
    const other = smokeSources(town, { ...DEFAULT_AIR_SETTINGS, smokeSeed: DEFAULT_AIR_SETTINGS.smokeSeed + 1 })
    expect(other.map((s) => s.key)).not.toEqual(a.map((s) => s.key))
    expect(new Set(a.map((s) => s.key)).size).toBe(a.length)
  })

  test("every source of a kind smokes at 1, none at 0, and wrecks always smoke", () => {
    const none = { ...DEFAULT_AIR_SETTINGS, smokeManholes: 0, smokeDrains: 0, smokeCars: 0, smokeChimneys: 0 }
    expect(smokeSources(town, none)).toEqual([])
    const wreck = smokeSources(town, none, [{ id: "v1", x: 10, y: 20, h: 0 }])
    expect(wreck).toHaveLength(1)
    expect(wreck[0]!.kind).toBe("car")
    const all = smokeSources(town, { ...none, smokeManholes: 1 })
    expect(all.length).toBeGreaterThan(0)
    expect(all.every((s) => s.kind === "steam")).toBe(true)
  })

  test("emits only near the survivor, within the source budget, and nothing when off", () => {
    const s = { ...DEFAULT_AIR_SETTINGS, smokeManholes: 1, smokeDrains: 1, smokeMaxSources: 3 }
    const src = smokeSources(town, s)[0]!
    const fx = new WorldSmoke()
    const p = new Particles()
    for (let i = 0; i < 60; i++) fx.emit(p, town, s, 1 / 60, { x: src.x, y: src.z }, 0, false, flat, [])
    expect(fx.shown.sources).toBeLessThanOrEqual(3)
    expect(p.count).toBeGreaterThan(0)
    const off = new Particles()
    const quiet = new WorldSmoke()
    for (let i = 0; i < 60; i++) quiet.emit(off, town, { ...s, worldSmoke: 0 }, 1 / 60, { x: src.x, y: src.z }, 0, false, flat, [])
    expect(off.count).toBe(0)
    const far = new Particles()
    for (let i = 0; i < 60; i++) new WorldSmoke().emit(far, town, s, 1 / 60, { x: src.x + 5000, y: src.z + 5000 }, 0, false, flat, [])
    expect(far.count).toBe(0)
  })

  test("thins by day", () => {
    const s = { ...DEFAULT_AIR_SETTINGS, smokeManholes: 1, smokeDayThin: 1 }
    const src = smokeSources(town, s)[0]!
    const day = new Particles()
    const fx = new WorldSmoke()
    for (let i = 0; i < 60; i++) fx.emit(day, town, s, 1 / 60, { x: src.x, y: src.z }, 1, false, flat, [])
    expect(day.count).toBe(0)
  })
})
