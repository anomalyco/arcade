import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { checkAgainstKind, checkKinds, labChrome, labWidgets } from "@arcade/kit/lab/scenes/kinds"
import { resolveLayout, trimLayout } from "@arcade/kit/lab/stations/layout"
import { checkCollection, checkScene } from "@arcade/kit/lab/scenes/model"
import { openCommands } from "@arcade/kit/lab/scenes/migrate"
import { createSceneStore, memorySceneStorage } from "@arcade/kit/lab/scenes/store"
import type { LabStation, StationCommand } from "@arcade/kit/lab/stations/types"
import { migrateStations, STATION_AREAS } from "../src/scenes/from-stations"
import { FEEL_ARENA } from "../src/scenes/examples/feel-arena"
import { kindForStation, LAB_KINDS } from "../src/scenes/kinds"

const dir = join(import.meta.dir, "../src/stations")
const files = readdirSync(dir).filter(f => f.endsWith(".ts") && f !== "index.ts" && f !== "define.ts")
const stations: LabStation[] = await Promise.all(files.map(async f => (await import(join(dir, f))).default as LabStation))
const NOW = "2026-10-15T09:00:00.000Z"
const { collections, scenes, notes } = migrateStations(stations, NOW)
const key = (c: StationCommand) => JSON.stringify([c.command, c.args ?? {}])

describe("lab kinds", () => {
  test("every kind checks, and every Lab section has exactly one kind", () => {
    expect(checkKinds(LAB_KINDS)).toEqual([])
    const sections = ["effects", "weather", "lighting", "looks", "materials", "foliage", "physics", "spawn", "audio", "getaway-effects", "blackout-effects", "fire-water", "splatter", "outbreak-vignette", "styles", "rugs", "world"]
    for (const section of sections) expect({ section, kinds: LAB_KINDS.filter(k => k.host.kind === "section" && k.host.section === section).length }).toEqual({ section, kinds: 1 })
  })
  test("the Feel arena example fits the Feel kind, and every featured knob is one its variants or settings use", () => {
    expect(checkScene(FEEL_ARENA).ok).toBe(true)
    expect(checkAgainstKind(FEEL_ARENA, LAB_KINDS)).toEqual([])
    for (const key of FEEL_ARENA.layout!.featured!.keys!) expect(key in FEEL_ARENA.settings).toBe(true)
    expect(LAB_KINDS.find(k => k.id === "feel")!.actions!.map(a => `${a.key} ${a.label}`)).toEqual(["S Shot", "V Shove", "T Hit taken", "X Kill", "B Explosion"])
  })
  test("no kind is a catch-all: only the vehicle lab has an add-picker", () => {
    expect(LAB_KINDS.filter(k => k.add?.length).map(k => k.id)).toEqual(["vehicle"])
  })
})

// Kit, 2026-10-15: a lab shows only what its subject needs; every panel is opt-in per lab kind; no voice-notes panel.
describe("labs show only what their subject needs", () => {
  test("only the vehicle lab has an Outliner, page labs show none of the Lab's own chrome, and no kind keeps notes", () => {
    expect(LAB_KINDS.filter(k => labChrome(k).includes("outliner")).map(k => k.id)).toEqual(["vehicle"])
    for (const k of LAB_KINDS.filter(k => k.host.kind === "page")) expect({ kind: k.id, chrome: labChrome(k) }).toEqual({ kind: k.id, chrome: [] })
    expect(LAB_KINDS.filter(k => k.panels.includes("notes") || k.panels.includes("work")).map(k => k.id)).toEqual([])
  })
  test("no station file lists a card its lab kind leaves out", () => {
    for (const st of stations) {
      const kind = kindForStation(st)
      if (!kind || !st.layout) continue
      const layout = resolveLayout(st.layout)
      const trimmed = trimLayout(layout, labWidgets(kind, st))
      expect({ station: st.id, layout: toIds(trimmed) }).toEqual({ station: st.id, layout: toIds(layout) })
    }
  })
  test("Outbreak look: its Look and Beam and unseen knobs, the variants, Play Outbreak and a short status and measured block", () => {
    const st = stations.find(s => s.id === "outbreak-look")!
    const layout = trimLayout(resolveLayout(st.layout!), labWidgets(kindForStation(st)!, st))
    expect(toIds(layout)).toEqual({ left: ["status", "metrics"], right: ["controls", "sections"], dock: ["variants"] })
    expect(layout.right.map(w => w.title)).toEqual(["Look", "Beam and unseen"])
    expect(st.links?.map(l => l.label)).toEqual(["Play Outbreak"])
  })
  test("the vehicle lab's Details groups are Spawn section groups", () => {
    const spawn = readFileSync(join(import.meta.dir, "../../../packages/kit/lab/spawn.ts"), "utf8")
    for (const g of LAB_KINDS.find(k => k.id === "vehicle")!.groups!) expect({ group: g, found: spawn.includes(`group:"${g}"`) }).toEqual({ group: g, found: true })
  })
})

const toIds = (l: ReturnType<typeof resolveLayout>) => ({ left: l.left.map(w => w.id), right: l.right.map(w => w.id), dock: l.dock.map(w => w.id) })

describe("stations as labs", () => {
  test("every station migrates to valid kept scenes in a named area", () => {
    for (const s of scenes) expect({ id: s.id, problems: checkScene(s).ok ? [] : (checkScene(s) as { problems: string[] }).problems }).toEqual({ id: s.id, problems: [] })
    for (const c of collections) expect(checkCollection(c).ok).toBe(true)
    const archivedArea = STATION_AREAS.find(a => a.archived)!.stations
    for (const s of scenes) expect({ id: s.id, status: s.status }).toEqual({ id: s.id, status: archivedArea.some(id => s.id === id || s.id.startsWith(`${id}-`)) ? "archived" : "kept" })
    const placed = new Set(scenes.map(s => s.id))
    for (const st of stations) expect(placed.has(st.id)).toBe(true)
    // A new station file needs a line in STATION_AREAS (games/lab/src/scenes/from-stations.ts): the collection Home lists it in.
    const withoutArea = stations.filter(st => !STATION_AREAS.some(a => a.stations.includes(st.id))).map(st => `${st.id}: add it to STATION_AREAS`)
    expect(withoutArea).toEqual([])
  })
  test("every migrated lab fits its kind", () => {
    // A new station file needs a lab kind (games/lab/src/scenes/kinds.ts: LAB_KINDS, and PAGE_STATIONS for a page station).
    const misfits = scenes.flatMap(s => checkAgainstKind(s, LAB_KINDS).map(p => `${s.id}: ${p}${s.kind === "page" || s.kind === "section" ? " (give it a kind in kinds.ts)" : ""}`))
    expect(misfits).toEqual([])
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
    expect(scenes.find(s => s.id === "effects-splatter")?.host).toEqual({ kind: "section", section: "splatter" })
    expect(scenes.find(s => s.id === "outbreak")?.layout?.grid).toBe("fog")
    expect(notes.some(n => n.includes("explosions-splatter"))).toBe(true)
  })
  test("the migrated scenes load into a store as repo scenes without problems", () => {
    const store = createSceneStore({ storage: memorySceneStorage(), repo: { scenes, collections }, now: () => new Date(NOW) })
    expect(store.problems).toEqual([])
    expect(store.collections().find(c => c.collection.id === "world")?.scenes.map(e => e.scene.id)).toEqual(["look-and-world", "effects", "effects-splatter"])
    // The superseded look, light, weather, material, vegetation and effect labs wait in the archive.
    expect(store.collections().find(c => c.collection.id === "archive")?.scenes).toEqual([])
    expect(store.scenes({ archived: true }).filter(e => e.scene.status === "archived").map(e => e.scene.id).sort()).toEqual(["explosions", "explosions-splatter", "lighting", "looks", "materials", "smoke-fire", "vegetation", "weather"])
    expect(store.sweep()).toEqual({ archived: [], deleted: [] })
  })
})
