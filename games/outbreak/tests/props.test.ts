import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import { PROP_IDS } from "@arcade/kit/props/catalogue"
import { PropLibrary } from "@arcade/kit/props/models"
import { makeTown } from "../shared/map"
import { LocalSession } from "../shared/session"
import { PropDressing } from "../src/props/dressing"
import { furnishedHouses, propFloorFootprints, propLamps, usedPropIds } from "../src/props/furnish"
import { DEFAULT_PROP_SETTINGS, PROP_LOD_HYSTERESIS } from "../src/props/settings"
import { DEFAULT_OUTBREAK_VIEW } from "../src/settings"
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
    const view: [number, number, number, number] = [-1.5, 15, 50, 48] // west edge < 0 triggers streamed window at zoom 38

    // Kick off loading and wait for disk assets to resolve
    dressing.collect(town, view, DEFAULT_PROP_SETTINGS, 38, { clutterScale: 1, minPropLod: 0 }, true, () => rebuilds++)
    for (let i = 0; i < 20 && !dressing.ready; i++) await new Promise(r => setTimeout(r, 5))
    expect(dressing.ready).toBe(true)
    expect(modelsAdded).toBeGreaterThan(20)

    const batches = dressing.collect(town, view, DEFAULT_PROP_SETTINGS, 38, { clutterScale: 1, minPropLod: 0 }, true, () => rebuilds++)
    expect(batches.length).toBeGreaterThan(5)
    expect(propDressingState.on).toBe(true)

    // If all prop assets fail to load, PropDressing flips propDressingState.on off and rebuilds the level for box furniture
    const origWarn = console.warn
    console.warn = () => {}
    try {
      const brokenLib = new PropLibrary("broken/", async () => new Response(null, { status: 404 }))
      const broken = new PropDressing(host, 63, brokenLib)
      let fallbackRebuilds = 0
      broken.collect(town, view, DEFAULT_PROP_SETTINGS, 38, { clutterScale: 1, minPropLod: 0 }, true, () => fallbackRebuilds++)
      for (let i = 0; i < 20 && !broken.ready; i++) await new Promise(r => setTimeout(r, 5))
      const empty = broken.collect(town, view, DEFAULT_PROP_SETTINGS, 38, { clutterScale: 1, minPropLod: 0 }, true, () => fallbackRebuilds++)
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

  test("stages prop loading: start-house anchors and clutter load before unused catalogue props, with box fallbacks until ready or on partial failure", async () => {
    Object.assign(propDressingState, { on: true, density: 1, seed: 0 })
    const town = makeTown(7)
    const houses = furnishedHouses(town)
    const stage1Ids = usedPropIds(houses)
    const anchorIds = [...new Set(houses.flatMap(h => h.anchors.map(a => a.id)))]
    expect(stage1Ids.slice(0, anchorIds.length)).toEqual(anchorIds)
    expect(stage1Ids.length).toBe(16)
    expect(PROP_IDS.length).toBe(26)

    const requested: string[] = []
    let releaseStage1!: () => void
    const stage1Gate = new Promise<void>(r => { releaseStage1 = r })
    let stage1Bytes = 0
    let totalBytes = 0
    const stagedLib = new PropLibrary("staged/", async url => {
      const id = url.slice("staged/".length, -".prop".length)
      requested.push(id)
      const file = Bun.file(resolve(assetsDir, `${id}.prop`))
      const buf = await file.arrayBuffer()
      totalBytes += buf.byteLength
      if (stage1Ids.includes(id)) {
        stage1Bytes += buf.byteLength
        await stage1Gate
      }
      return new Response(buf, { status: 200 })
    })

    let nextModel = 0
    const host = { addModel: () => nextModel++, setModel: () => {} }
    const dressing = new PropDressing(host, 63, stagedLib)
    const view: [number, number, number, number] = [18, 20, 42, 42]

    // Frame 1 while Stage 1 fetches are still in flight: only start-house props were requested, and anchors draw box fallbacks
    const whileLoading = dressing.collect(town, view, DEFAULT_PROP_SETTINGS, 38, { clutterScale: 1, minPropLod: 0 }, true, () => {})
    expect(requested).toEqual(stage1Ids)
    expect(dressing.furnishedReady).toBe(false)
    expect(whileLoading.length).toBeGreaterThan(0)
    const fallbackModels = new Set(whileLoading.map(b => b.model))

    // Release Stage 1: start houses become furnishedReady before unused catalogue props are fetched on the deferred turn
    releaseStage1()
    for (let i = 0; i < 20 && !dressing.furnishedReady; i++) await new Promise(r => setTimeout(r, 1))
    expect(dressing.furnishedReady).toBe(true)
    expect(requested).toEqual(stage1Ids)
    // The bedroom stands a dresser rather than the sideboard (AR-69).
    expect(stage1Bytes).toBe(2945748)

    const furnishedBatches = dressing.collect(town, view, DEFAULT_PROP_SETTINGS, 38, { clutterScale: 1, minPropLod: 0 }, true, () => {})
    expect(furnishedBatches.some(b => !fallbackModels.has(b.model))).toBe(true)

    // Deferred Stage 2 completes on the idle/macrotask turn
    for (let i = 0; i < 20 && !dressing.ready; i++) await new Promise(r => setTimeout(r, 5))
    expect(dressing.ready).toBe(true)
    expect(requested.length).toBe(PROP_IDS.length)
    expect(totalBytes).toBe(4330934)

    // Partial failure: if "bed" 404s while other props load, "bed" keeps its box fallback while loaded props use .prop models
    const origWarn = console.warn
    console.warn = () => {}
    try {
      const partialLib = new PropLibrary("partial/", async url => {
        const name = url.slice("partial/".length)
        if (name === "bed.prop") return new Response(null, { status: 404 })
        const file = Bun.file(resolve(assetsDir, name))
        return new Response(await file.arrayBuffer(), { status: 200 })
      })
      const partial = new PropDressing(host, 63, partialLib)
      partial.collect(town, view, DEFAULT_PROP_SETTINGS, 38, { clutterScale: 1, minPropLod: 0 }, true, () => {})
      for (let i = 0; i < 20 && !partial.furnishedReady; i++) await new Promise(r => setTimeout(r, 5))
      expect(partial.models.has("bed")).toBe(false)
      expect(partial.models.has("chesterfield-sofa")).toBe(true)
      expect(partial.models.model("bed", 0)).toBeDefined()
      expect(propDressingState.on).toBe(true)
    } finally {
      console.warn = origWarn
    }
  })

  test("applies zoom hysteresis around propLodZoom so small zoom oscillations do not flip between LOD0 and LOD1", async () => {
    Object.assign(propDressingState, { on: true, density: 1, seed: 0 })
    const town = makeTown(7)
    let nextModel = 0
    const host = { addModel: () => nextModel++, setModel: () => {} }
    const dressing = new PropDressing(host, 63, diskLibrary())
    const view: [number, number, number, number] = [18, 20, 42, 42]
    const s = { ...DEFAULT_PROP_SETTINGS, propLodZoom: 34 }

    dressing.collect(town, view, s, 33, { clutterScale: 1, minPropLod: 0 }, true, () => {})
    for (let i = 0; i < 20 && !dressing.furnishedReady; i++) await new Promise(r => setTimeout(r, 5))
    expect(dressing.furnishedReady).toBe(true)

    const at33 = dressing.collect(town, view, s, 33, { clutterScale: 1, minPropLod: 0 }, true, () => {}).map(b => b.model)
    const at35 = dressing.collect(town, view, s, 35, { clutterScale: 1, minPropLod: 0 }, true, () => {}).map(b => b.model)
    // Within hysteresis band (34 ± 2.5): stays on LOD0
    expect(at35).toEqual(at33)

    // Crossing above 36.5 switches to LOD1
    const at37 = dressing.collect(town, view, s, 37, { clutterScale: 1, minPropLod: 0 }, true, () => {}).map(b => b.model)
    expect(at37).not.toEqual(at33)

    // Crossing back to 33 (within 34 - 2.5 = 31.5) stays on LOD1
    const backTo33 = dressing.collect(town, view, s, 33, { clutterScale: 1, minPropLod: 0 }, true, () => {}).map(b => b.model)
    expect(backTo33).toEqual(at37)

    // Crossing below 31.5 switches back to LOD0
    const at31 = dressing.collect(town, view, s, 31, { clutterScale: 1, minPropLod: 0 }, true, () => {}).map(b => b.model)
    expect(at31).toEqual(at33)
  })

  test("the default camera distance sits clear of the LOD hysteresis band", () => {
    const { zoom } = DEFAULT_OUTBREAK_VIEW
    const { propLodZoom } = DEFAULT_PROP_SETTINGS
    expect(Math.abs(zoom - propLodZoom)).toBeGreaterThan(PROP_LOD_HYSTERESIS)
  })
})
