import { describe, expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import { join } from "node:path"
import { checkAgainstKind, checkKinds } from "@arcade/kit/lab/scenes/kinds"
import { checkCollection, checkScene } from "@arcade/kit/lab/scenes/model"
import { openCommands } from "@arcade/kit/lab/scenes/migrate"
import { createSceneStore, memorySceneStorage } from "@arcade/kit/lab/scenes/store"
import type { LabStation, StationCommand } from "@arcade/kit/lab/stations/types"
import { migrateStations, STATION_AREAS } from "../src/scenes/from-stations"
import { LAB_KINDS } from "../src/scenes/kinds"

const dir = join(import.meta.dir, "../src/stations")
const files = readdirSync(dir).filter(f => f.endsWith(".ts") && f !== "index.ts" && f !== "define.ts")
const stations: LabStation[] = await Promise.all(files.map(async f => (await import(join(dir, f))).default as LabStation))
const NOW = "2026-10-15T09:00:00.000Z"
const { collections, scenes, notes } = migrateStations(stations, NOW)
const key = (c: StationCommand) => JSON.stringify([c.command, c.args ?? {}])

describe("lab kinds", () => {
  test("every kind checks, and every Lab section has exactly one kind", () => {
    expect(checkKinds(LAB_KINDS)).toEqual([])
    const sections = ["effects", "weather", "lighting", "looks", "materials", "foliage", "physics", "spawn", "audio", "getaway-effects", "blackout-effects", "fire-water", "splatter", "outbreak-vignette", "styles"]
    for (const section of sections) expect({ section, kinds: LAB_KINDS.filter(k => k.host.kind === "section" && k.host.section === section).length }).toEqual({ section, kinds: 1 })
  })
  test("no kind is a catch-all: only the vehicle lab has an add-picker", () => {
    expect(LAB_KINDS.filter(k => k.add?.length).map(k => k.id)).toEqual(["vehicle"])
  })
})

describe("stations as labs", () => {
  test("every station migrates to valid kept scenes in a named area", () => {
    for (const s of scenes) expect({ id: s.id, problems: checkScene(s).ok ? [] : (checkScene(s) as { problems: string[] }).problems }).toEqual({ id: s.id, problems: [] })
    for (const c of collections) expect(checkCollection(c).ok).toBe(true)
    expect(scenes.every(s => s.status === "kept")).toBe(true)
    const placed = new Set(scenes.map(s => s.id))
    for (const st of stations) expect(placed.has(st.id)).toBe(true)
    for (const st of stations) expect(STATION_AREAS.some(a => a.stations.includes(st.id))).toBe(true)
  })
  test("every migrated lab fits its kind", () => {
    for (const s of scenes) expect({ id: s.id, kind: s.kind, problems: checkAgainstKind(s, LAB_KINDS) }).toEqual({ id: s.id, kind: s.kind, problems: [] })
    expect(Object.fromEntries(scenes.map(s => [s.id, s.kind]))).toMatchObject({ weather: "weather", looks: "look", outbreak: "scene-look", "explosions-splatter": "splatter", characters: "walk-cycle", "outbreak-hud": "hud" })
  })
  test("opening a migrated scene runs the same commands the station ran, for the scene and each variant", () => {
    for (const st of stations) {
      if (st.demo.kind !== "section") continue
      const scene = scenes.find(s => s.id === st.id)!
      const want = (st.demo.setup ?? []).map(key).sort()
      expect({ station: st.id, commands: openCommands(scene, "").map(key).sort() }).toEqual({ station: st.id, commands: want })
      for (const v of scene.variants) {
        const original = st.variants!.find(x => x.id === v.id)!
        const ran = openCommands(scene, v.id).slice(openCommands(scene, "").length)
        expect({ station: st.id, variant: v.id, commands: ran.map(key).sort() }).toEqual({ station: st.id, variant: v.id, commands: (original.setup ?? []).map(key).sort() })
      }
    }
  })
  test("variants that switched section became their own scenes, and grid variants became the scene's grid", () => {
    expect(scenes.find(s => s.id === "explosions-splatter")?.host).toEqual({ kind: "section", section: "splatter" })
    expect(scenes.find(s => s.id === "outbreak")?.layout?.grid).toBe("fog")
    expect(notes.some(n => n.includes("explosions-splatter"))).toBe(true)
  })
  test("the migrated scenes load into a store as repo scenes without problems", () => {
    const store = createSceneStore({ storage: memorySceneStorage(), repo: { scenes, collections }, now: () => new Date(NOW) })
    expect(store.problems).toEqual([])
    expect(store.collections().find(c => c.collection.id === "look-and-light")?.scenes.map(e => e.scene.id)).toEqual(["weather", "vegetation", "looks", "styles", "lighting", "materials"])
    expect(store.sweep()).toEqual({ archived: [], deleted: [] })
  })
})
