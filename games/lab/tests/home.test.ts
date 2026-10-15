import { describe, expect, test } from "bun:test"
import { memorySceneStorage } from "@arcade/kit/lab/scenes/store"
import { createCatalog, matches } from "../src/home/catalog"
import { readdirSync } from "node:fs"
import { join } from "node:path"
import { orderStations, type LabStation } from "@arcade/kit/lab/stations/types"

const dir = join(import.meta.dir, "../src/stations")
const files = readdirSync(dir).filter(f => f.endsWith(".ts") && f !== "index.ts" && f !== "define.ts")
const stations = orderStations(await Promise.all(files.map(async f => (await import(join(dir, f))).default as LabStation))).map(o => o.station)

describe("the lab catalog", () => {
  const catalog = createCatalog(stations, memorySceneStorage())

  test("every station is a lab, grouped by collection, with no empty collection", () => {
    const labs = catalog.all()
    for (const s of stations) expect(labs.some(l => l.id === s.id)).toBe(true)
    expect(catalog.collections().every(c => c.labs.length > 0)).toBe(true)
    expect(catalog.collections().map(c => c.id)).toContain("look-and-light")
  })

  test("a lab is found by its ref or, for old station links, by its id", () => {
    expect(catalog.find("look-and-light/weather")?.title).toBe("Weather")
    expect(catalog.find("weather")?.ref).toBe("look-and-light/weather")
    expect(catalog.find("nope")).toBeUndefined()
  })

  test("stepping walks the lab's own collection and wraps", () => {
    const labs = catalog.collections().find(c => c.id === "look-and-light")!.labs
    expect(catalog.step(labs[0]!.ref, 1)?.ref).toBe(labs[1]!.ref)
    expect(catalog.step(labs[0]!.ref, -1)?.ref).toBe(labs.at(-1)!.ref)
  })

  test("a lab a station became unchanged opens that station; a split one opens a station built from the lab", () => {
    const weather = catalog.find("look-and-light/weather")!
    expect(weather.station()).toBe(stations.find(s => s.id === "weather")!)
    const splatter = catalog.find("effects/explosions-splatter")!
    const built = splatter.station()
    expect(built.demo).toMatchObject({ kind: "section", section: "splatter" })
    const original = stations.find(s => s.id === "explosions")!.variants!.filter(v => v.setup?.[0]?.command === "scene.select-section")
    expect(built.variants!.map(v => v.setup)).toEqual(original.map(v => v.setup!.slice(1)))
  })

  test("search matches every word against title, kind and collection", () => {
    const weather = catalog.find("look-and-light/weather")!
    expect(matches(weather, "rain")).toBe(true)
    expect(matches(weather, "look weather")).toBe(true)
    expect(matches(weather, "weather carrier")).toBe(false)
  })
})
