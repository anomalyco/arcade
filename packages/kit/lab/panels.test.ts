import { describe, expect, test } from "bun:test"
import { libraryIconFor } from "./library-icons"
import { gridNeighbor, isFilterKey, rowsOf, type TileRect } from "./library-nav"
import { clampPanelSize, parsePanelStore } from "./panels"
import { backingSize, resolutionScale } from "./viewport-size"

describe("panel sizes", () => {
  test("clamps to bounds and rounds", () => {
    expect(clampPanelSize(100.4, { min: 168, max: 560 })).toBe(168)
    expect(clampPanelSize(300.6, { min: 168, max: 560 })).toBe(301)
    expect(clampPanelSize(900, { min: 168, max: 560 })).toBe(560)
  })
  test("a max below the min (tiny window) yields the min", () => {
    expect(clampPanelSize(400, { min: 168, max: 40 })).toBe(168)
  })
  test("stored layouts keep only finite sizes and true collapsed flags for known panels", () => {
    const store = parsePanelStore({
      version: 1,
      layouts: {
        workbench: { sizes: { left: 300.2, right: "wide", drawer: Infinity, bogus: 5 }, collapsed: { right: true, left: "yes" } },
        weather: { sizes: {}, collapsed: {} },
        storm: "nope",
      },
    })
    expect(store.layouts).toEqual({ workbench: { sizes: { left: 300 }, collapsed: { right: true } } })
    expect(parsePanelStore({ version: 2, layouts: { a: { sizes: { left: 200 } } } }).layouts).toEqual({})
    expect(parsePanelStore(null).layouts).toEqual({})
  })
})

describe("viewport resolution", () => {
  test("auto caps at 1.5×, device at 2×, css is 1×", () => {
    expect(resolutionScale("auto", 2)).toBe(1.5)
    expect(resolutionScale("auto", 1)).toBe(1)
    expect(resolutionScale("device", 3)).toBe(2)
    expect(resolutionScale("css", 2)).toBe(1)
    expect(resolutionScale("auto", Number.NaN)).toBe(1)
  })
  test("uses the exact device-pixel box when the scale is the pixel ratio", () => {
    expect(backingSize({ width: 600.5, height: 400.25 }, 2, 2, { width: 1201, height: 801 })).toEqual({ width: 1201, height: 801 })
    expect(backingSize({ width: 600.5, height: 400.25 }, 2, 1.5, { width: 1201, height: 801 })).toEqual({ width: 901, height: 600 })
    expect(backingSize({ width: 0, height: 0 }, 1, 1)).toEqual({ width: 1, height: 1 })
  })
})

describe("library grid navigation", () => {
  // Two rows of three, a heading, then a row of two (the heading breaks the grid).
  const r = (x: number, y: number): TileRect => ({ x, y, width: 150, height: 40 })
  const rects = [r(0, 0), r(160, 0), r(320, 0), r(0, 44), r(160, 44), r(320, 44), r(0, 110), r(160, 110)]
  test("rows follow tile tops", () => {
    expect(rowsOf(rects)).toEqual([[0, 1, 2], [3, 4, 5], [6, 7]])
  })
  test("left and right follow reading order and stop at the ends", () => {
    expect(gridNeighbor(rects, 2, "right")).toBe(3)
    expect(gridNeighbor(rects, 0, "left")).toBe(0)
    expect(gridNeighbor(rects, 7, "right")).toBe(7)
  })
  test("up and down keep the column, landing on the nearest tile in a short row", () => {
    expect(gridNeighbor(rects, 1, "down")).toBe(4)
    expect(gridNeighbor(rects, 5, "down")).toBe(7)
    expect(gridNeighbor(rects, 7, "up")).toBe(4)
    expect(gridNeighbor(rects, 1, "up")).toBe(1)
  })
  test("home, end and page moves", () => {
    expect(gridNeighbor(rects, 4, "home")).toBe(0)
    expect(gridNeighbor(rects, 4, "end")).toBe(7)
    expect(gridNeighbor(rects, 0, "pageDown", 2)).toBe(6)
    expect(gridNeighbor([], 0, "down")).toBe(-1)
  })
  test("only plain printable keys start type-to-filter", () => {
    expect(isFilterKey({ key: "p", metaKey: false, ctrlKey: false, altKey: false })).toBe(true)
    expect(isFilterKey({ key: " ", metaKey: false, ctrlKey: false, altKey: false })).toBe(false)
    expect(isFilterKey({ key: "k", metaKey: true, ctrlKey: false, altKey: false })).toBe(false)
    expect(isFilterKey({ key: "ArrowDown", metaKey: false, ctrlKey: false, altKey: false })).toBe(false)
  })
})

describe("library icons", () => {
  const icon = (label: string, group: string, tag: string, category: Parameters<typeof libraryIconFor>[1], id = "x") => libraryIconFor({ id, label, group, tag }, category)
  test("the Foliage drawer from Kit's screenshot gets a distinct icon per kind", () => {
    expect(icon("Tree", "Tools", "Tool", "foliage")).toBe("tree")
    expect(icon("Bush", "Tools", "Tool", "foliage")).toBe("bush")
    expect(icon("Grass", "Tools", "Tool", "foliage")).toBe("grass")
    expect(icon("Outbreak lot (all three)", "Tools", "Tool", "foliage")).toBe("lot")
    expect(icon("Pine", "Tree presets", "Tree", "foliage")).toBe("pine")
    expect(icon("Oak", "Tree presets", "Tree", "foliage")).toBe("tree")
    expect(icon("Weeds / dead grass", "Grass presets", "Grass", "foliage")).toBe("grass")
  })
  test("effects, objects and audio map by meaning", () => {
    expect(icon("Grenade smoke in room", "Starting Fixtures", "Fixture", "effects")).toBe("smoke")
    expect(icon("Glass impact at pane", "Starting Fixtures", "Fixture", "effects")).toBe("shards")
    expect(icon("Propane tank", "Props", "Prop", "objects", "spawn-prop:propane_tank")).toBe("barrel")
    expect(icon("Getaway · Muscle", "Vehicles", "Character", "objects")).toBe("car")
    expect(icon("Anything", "Cues", "Cue", "audio")).toBe("wave")
    expect(icon("Unknown thing", "Misc", "Item", "lighting")).toBe("bulb")
  })
})
