import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import { PropLibrary } from "@arcade/kit/props/models"
import { makeTown } from "../shared/map"
import { LocalSession } from "../shared/session"
import { PropDressing } from "../src/props/dressing"
import { furnishedHouses, propFloorFootprints, propLamps } from "../src/props/furnish"
import { DEFAULT_PROP_SETTINGS } from "../src/props/settings"
import { propDressingState, propLevelSignature } from "../src/props/state"
import { buildVignetteLevel } from "../src/vignette/presets"

const initial = { ...propDressingState }
const off = () => Object.assign(propDressingState, { on: false, density: 1, seed: 0 })
const restore = () => Object.assign(propDressingState, initial)

const assetsDir = resolve(import.meta.dir, "../../../packages/kit/props/assets")
const diskLibrary = () =>
  new PropLibrary("disk/", async url => {
    const file = Bun.file(resolve(assetsDir, url.slice("disk/".length)))
    return (await file.exists()) ? new Response(await file.arrayBuffer(), { status: 200 }) : new Response(null, { status: 404 })
  })

describe("prop dressing exports for the level bake", () => {
  beforeEach(off)
  afterEach(restore)

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

  test("furnishes both start houses consistently even when StreamingWorld shifts active chunks", () => {
    Object.assign(propDressingState, { on: true, density: 1, seed: 0 })
    const full = makeTown(7)
    const expected = furnishedHouses(full)
    expect(expected.map(h => h.building)).toEqual(["ash", "elm"])

    // Move survivor outside the 96 m classic box so active 3×3 chunks shift to (3..5, 0..2)
    const session = new LocalSession(7, 7, 0.22, { zombieCount: 0 }, undefined, "streaming")
    session.view.player.x = 128
    session.view.player.y = 33
    session.rebuildCollision()
    expect(session.view.town.activeChunkKeys).toBeDefined()
    expect(session.view.town.buildings.some(b => b.id === "ash")).toBe(false)

    const streamedHouses = furnishedHouses(session.view.town)
    expect(streamedHouses.map(h => h.building)).toEqual(["ash", "elm"])
    expect(streamedHouses[0]!.anchors.length).toBe(expected[0]!.anchors.length)
    expect(streamedHouses[1]!.anchors.length).toBe(expected[1]!.anchors.length)
  })

  test("PropDressing keeps drawing furniture when the camera crosses into the streamed window, and restores fallback boxes if assets fail", async () => {
    Object.assign(propDressingState, { on: true, density: 1, seed: 0 })
    const town = makeTown(7)
    let modelsAdded = 0
    let rebuilds = 0
    const host = { addModel: () => modelsAdded++, setModel: () => {} }
    const dressing = new PropDressing(host, 63, diskLibrary())
    const view: [number, number, number, number] = [-1.5, 15, 50, 48] // west edge < 0 triggers streamed window at zoom 46

    // Kick off loading and wait for disk assets to resolve
    dressing.collect(town, view, DEFAULT_PROP_SETTINGS, 46, { clutterScale: 1, minPropLod: 0 }, true, () => rebuilds++)
    for (let i = 0; i < 20 && !dressing.ready; i++) await new Promise(r => setTimeout(r, 5))
    expect(dressing.ready).toBe(true)
    expect(modelsAdded).toBeGreaterThan(20)

    const batches = dressing.collect(town, view, DEFAULT_PROP_SETTINGS, 46, { clutterScale: 1, minPropLod: 0 }, true, () => rebuilds++)
    expect(batches.length).toBeGreaterThan(5)
    expect(propDressingState.on).toBe(true)

    // If all prop assets fail to load, PropDressing flips propDressingState.on off and rebuilds the level for box furniture
    const origWarn = console.warn
    console.warn = () => {}
    try {
      const brokenLib = new PropLibrary("broken/", async () => new Response(null, { status: 404 }))
      const broken = new PropDressing(host, 63, brokenLib)
      let fallbackRebuilds = 0
      broken.collect(town, view, DEFAULT_PROP_SETTINGS, 46, { clutterScale: 1, minPropLod: 0 }, true, () => fallbackRebuilds++)
      for (let i = 0; i < 20 && !broken.ready; i++) await new Promise(r => setTimeout(r, 5))
      const empty = broken.collect(town, view, DEFAULT_PROP_SETTINGS, 46, { clutterScale: 1, minPropLod: 0 }, true, () => fallbackRebuilds++)
      expect(empty.length).toBe(0)
      expect(propDressingState.on).toBe(false)
      expect(fallbackRebuilds).toBeGreaterThan(0)
    } finally {
      console.warn = origWarn
    }
  })

  test("buildVignetteLevel preserves box furniture even when propDressingState.on is true", () => {
    const town = makeTown(7)
    Object.assign(propDressingState, { on: false, density: 1, seed: 0 })
    const offBytes = buildVignetteLevel(town).chunks.reduce((n, c) => n + c.data.byteLength, 0)

    Object.assign(propDressingState, { on: true, density: 1, seed: 0 })
    const onBytes = buildVignetteLevel(town).chunks.reduce((n, c) => n + c.data.byteLength, 0)
    expect(onBytes).toBe(offBytes)
    expect(propDressingState.on).toBe(true)
  })
})
