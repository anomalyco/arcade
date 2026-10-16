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
    const shelved = [...labs, ...catalog.archived()]
    for (const s of stations) expect(shelved.some(l => l.id === s.id)).toBe(true)
    expect(catalog.collections().every(c => c.labs.length > 0)).toBe(true)
    expect(catalog.collections().map(c => c.id)).toEqual(["world", "characters", "outbreak", "games", "assets"])
  })

  test("a lab is found by its ref or, for old station links, by its id", () => {
    expect(catalog.find("world/look-and-world")?.title).toBe("Look and world")
    expect(catalog.find("look-and-world")?.ref).toBe("world/look-and-world")
    // Old links to an archived lab still open it.
    expect(catalog.find("archive/weather")?.title).toBe("Weather")
    expect(catalog.find("nope")).toBeUndefined()
  })

  test("stepping walks the lab's own collection and wraps", () => {
    const labs = catalog.collections().find(c => c.id === "world")!.labs
    expect(catalog.step(labs[0]!.ref, 1)?.ref).toBe(labs[1]!.ref)
    expect(catalog.step(labs[0]!.ref, -1)?.ref).toBe(labs.at(-1)!.ref)
  })

  test("a lab a station became unchanged opens that station; a split one opens a station built from the lab", () => {
    const world = catalog.find("world/look-and-world")!
    expect(world.station()).toBe(stations.find(s => s.id === "look-and-world")!)
    const splatter = catalog.find("world/effects-splatter")!
    const built = splatter.station()
    expect(built.demo).toMatchObject({ kind: "section", section: "splatter" })
    const original = stations.find(s => s.id === "effects")!.variants!.filter(v => v.setup?.[0]?.command === "scene.select-section")
    expect(built.variants!.map(v => v.setup)).toEqual(original.map(v => v.setup!.slice(1)))
  })

  test("search matches every word against title, kind and collection", () => {
    const world = catalog.find("world/look-and-world")!
    expect(matches(world, "street")).toBe(true)
    expect(matches(world, "look world")).toBe(true)
    expect(matches(world, "world carrier")).toBe(false)
  })
})

describe("labs come and go", () => {
  test("new, duplicate, keep, archive, restore and delete", () => {
    const catalog = createCatalog(stations, memorySceneStorage())
    const rug = catalog.create("rug")
    expect(rug).toMatchObject({ ref: "drafts/rug-lab", status: "draft", kind: { id: "rug" } })
    expect(rug.station().demo).toMatchObject({ kind: "section", section: "rugs" })
    const copy = catalog.duplicate("world/look-and-world")
    expect(copy).toMatchObject({ ref: "world/look-and-world-copy", status: "draft" })
    expect(copy.variants.map(v => v.id)).toEqual(catalog.find("world/look-and-world")!.variants.map(v => v.id))
    expect(catalog.keep(copy.ref).status).toBe("kept")
    catalog.archive(copy.ref)
    expect(catalog.all().some(l => l.ref === copy.ref)).toBe(false)
    expect(catalog.archived().map(l => l.ref)).toContain(copy.ref)
    expect(catalog.restore(copy.ref).status).toBe("kept")
    catalog.remove(copy.ref)
    expect(catalog.find(copy.ref)).toBeUndefined()
  })

  test("a station's lab archives and restores in this browser, but isn't deleted here", () => {
    const catalog = createCatalog(stations, memorySceneStorage())
    catalog.archive("world/effects")
    expect(catalog.archived().find(l => l.ref === "world/effects")).toMatchObject({ source: "edited" })
    expect(catalog.deletable("world/effects")).toBe(false)
    expect(() => catalog.remove("world/effects")).toThrow("station file")
    expect(catalog.restore("world/effects").source).toBe("repo")
  })

  test("the superseded labs ship archived, folded at the bottom of Home, and restore in this browser", () => {
    const catalog = createCatalog(stations, memorySceneStorage())
    expect(catalog.archived().map(l => l.id).sort()).toEqual(["explosions", "explosions-splatter", "lighting", "looks", "materials", "smoke-fire", "vegetation", "weather"])
    expect(catalog.all().some(l => l.id === "weather")).toBe(false)
    expect(catalog.restore("archive/weather").status).toBe("kept")
    expect(catalog.all().some(l => l.ref === "archive/weather")).toBe(true)
  })

  test("only section kinds can start a new lab", () => {
    const catalog = createCatalog(stations, memorySceneStorage())
    expect(catalog.kinds.map(k => k.id)).toContain("rug")
    expect(catalog.kinds.map(k => k.id)).not.toContain("hud")
    expect(() => catalog.create("hud")).toThrow()
  })
})
