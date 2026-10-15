import { describe, expect, test } from "bun:test"
import { makeTown, sightRects } from "../shared/map"
import { Vision } from "../shared/vision"
import { generateWorldChunk } from "../shared/world"
import { blockName, chunkFeatures, groupSightings, MapMemory, MAP_TILE } from "../src/map/memory"
import { LEVELS, pickLevel } from "../src/map/tiles"

const source = (cx: number, cy: number) => generateWorldChunk(7, 7, cx, cy, "streaming")

describe("map memory", () => {
  test("copies explored vision cells into 1 m chunk tiles near the viewer only", () => {
    const town = makeTown(7)
    const vision = new Vision()
    vision.update(27.7, 41, 0, sightRects(town))
    const memory = new MapMemory()
    const updated = memory.observe(vision, source)
    expect(updated).toBeGreaterThan(0)
    let cells = 0
    for (const c of memory.chunks.values()) cells += c.count
    // Every explored 1 m cell came from at least one explored 0.5 m vision cell, and pooling 2 × 2 never loses one.
    expect(cells).toBeGreaterThan(vision.exploredCount / 4 - 1)
    expect(cells).toBeLessThanOrEqual(vision.exploredCount)
    expect(memory.explored(30, 41)).toBe(true)
    expect(memory.explored(90, 90)).toBe(false)
    // A second pass with nothing new changes nothing.
    memory.drainChanged()
    expect(memory.observe(vision, source)).toBe(0)
    expect(memory.drainChanged()).toEqual([])
  })

  test("marks buildings known once the ground beside them is seen, and safehouses by their workbench", () => {
    const town = makeTown(7)
    const vision = new Vision()
    vision.update(27.7, 41, -Math.PI / 2, sightRects(town))
    const memory = new MapMemory()
    memory.observe(vision, source)
    const all = [...memory.chunks.values()].flatMap((c) => c.buildings)
    const ash = all.find((b) => b.id === "ash")
    expect(ash?.known).toBe(true)
    expect(ash?.poi).toBe("safehouse")
    expect(all.find((b) => b.id === "hardware")?.poi).toBe("hardware")
  })

  test("keeps cells from a window that moved away through Vision's saved tiles", () => {
    const town = makeTown(7)
    const vision = new Vision()
    vision.update(27.7, 41, 0, sightRects(town))
    const before = vision.exploredCount
    vision.setWindowOrigin(96, 0)
    const memory = new MapMemory()
    memory.observeSaved(vision, 0, 0, source)
    let cells = 0
    for (const c of memory.chunks.values()) cells += c.count
    expect(before).toBeGreaterThan(0)
    expect(cells).toBeGreaterThan(before / 4 - 1)
  })

  test("chunk features carry roads, trees and POIs from the generator", () => {
    const f = chunkFeatures(generateWorldChunk(7, 7, 4, 1, "streaming"))
    expect(f.lx).toBe(1)
    expect(f.ly).toBe(1)
    const civic = [...Array(9).keys()].map((i) => chunkFeatures(generateWorldChunk(7, 7, 6 + (i % 3), i / 3 | 0, "streaming")))
    expect(civic.flatMap((c) => c.buildings.map((b) => b.poi))).toContain("police")
  })

  test("sightings record seen zombies and clear once the spot is seen empty", () => {
    const memory = new MapMemory()
    const all = () => true
    memory.observeZombies([{ x: 10, y: 10, state: "wander" }, { x: 11, y: 12, state: "chase" }, { x: 60, y: 60, state: "dead" }], all, 5, 240)
    expect(memory.sightings.size).toBe(1)
    expect([...memory.sightings.values()][0]!.count).toBe(2)
    // Out of sight: the last-known group stays.
    memory.observeZombies([], () => false, 20, 240)
    expect(memory.sightings.size).toBe(1)
    // Looking at the spot again with nobody there clears it.
    memory.observeZombies([], all, 30, 240)
    expect(memory.sightings.size).toBe(0)
    // Old sightings expire.
    memory.observeZombies([{ x: 10, y: 10, state: "wander" }], all, 40, 240)
    memory.observeZombies([], () => false, 400, 240)
    expect(memory.sightings.size).toBe(0)
  })

  test("neighbouring sighting cells group into one horde", () => {
    const groups = groupSightings([
      { key: 1, x: 10, y: 10, count: 4, seenAt: 3 },
      { key: 2, x: 18, y: 12, count: 2, seenAt: 9 },
      { key: 3, x: 80, y: 80, count: 1, seenAt: 1 },
    ])
    expect(groups).toHaveLength(2)
    expect(groups[0]!.count).toBe(6)
    expect(groups[0]!.seenAt).toBe(9)
    expect(groups[0]!.x).toBeCloseTo((10 * 4 + 18 * 2) / 6)
  })

  test("markers get free letters and survive a round trip", () => {
    const memory = new MapMemory()
    const a = memory.addMarker(1, 2)
    const b = memory.addMarker(3, 4)
    expect([a.label, b.label]).toEqual(["A", "B"])
    memory.removeMarker(a.id)
    expect(memory.addMarker(5, 6).label).toBe("A")
    const saved = memory.markers.map((m) => ({ x: m.x, y: m.y, label: m.label }))
    const other = new MapMemory()
    other.setMarkers([...saved, { x: Number.NaN, y: 0 }])
    expect(other.markers.map((m) => m.label).sort()).toEqual(["A", "B"])
  })

  test("reveal fills a disc with a ragged edge", () => {
    const memory = new MapMemory()
    const n = memory.reveal(48, 48, 40, source)
    expect(n).toBeGreaterThan(Math.PI * 34 * 34)
    expect(n).toBeLessThan(Math.PI * 41 * 41)
    expect(memory.explored(48, 48)).toBe(true)
    expect(memory.explored(48 + 45, 48)).toBe(false)
    expect([...memory.chunks.values()].every((c) => c.explored.length === MAP_TILE * MAP_TILE)).toBe(true)
  })

  test("block names are stable and the start block keeps its street name", () => {
    expect(blockName(7, 0, 0, "suburb")).toBe("Ash & Elm")
    expect(blockName(7, 3, -2, "industrial")).toBe(blockName(7, 3, -2, "industrial"))
  })
})

describe("map tile levels", () => {
  test("levels halve in density and pick the finest level at or above the screen density", () => {
    for (let i = 1; i < LEVELS.length; i++) expect(LEVELS[i]!.d).toBe(LEVELS[i - 1]!.d / 2)
    expect(LEVELS.every((l) => l.size <= 512)).toBe(true)
    expect(LEVELS[pickLevel(6)]!.d).toBe(8)
    expect(LEVELS[pickLevel(8)]!.d).toBe(8)
    expect(LEVELS[pickLevel(40)]!.d).toBe(16)
    expect(LEVELS[pickLevel(0.01)]!.d).toBe(0.0625)
  })
})
