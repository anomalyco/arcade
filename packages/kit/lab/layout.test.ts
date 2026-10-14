import { expect, test } from "bun:test"
import { LabNavigation, type LabControl } from "../lab-navigation"
import { filterLibrary, isLibraryAsset, isPlaceable, libraryCategoryOf, sectionLibraryCategory } from "./library"
import { buildOutlinerRows, outlinerGroupOf, outlinerKindOf, rangeSelection } from "./outliner"
import { fuzzyScore, parsePaletteQuery, rankPalette, type PaletteItem } from "./palette"
import type { LabWorldObject } from "./types"

const obj = (id: string, label: string, category: LabWorldObject["category"], extra: Partial<LabWorldObject> = {}): LabWorldObject => ({
  id,
  label,
  category,
  x: 0,
  y: 0,
  z: 0,
  ...extra,
})

const scene: LabWorldObject[] = [
  obj("character:active", "Getaway · Muscle", "character", { vehicle: true, kind: "getaway:muscle" }),
  ...[1, 2, 3, 4, 5].map(n => obj(`prop:${n}`, `Cone #${n}`, "prop", { kind: "cone" })),
  obj("prop:6", "Propane tank #6", "prop", { kind: "propane" }),
  obj("prop:7", "Hydrant #7", "prop", { kind: "hydrant" }),
  obj("light:1", "Lamp (1)", "light", { kind: "lamp" }),
  obj("emitter:origin", "Grenade smoke Origin", "emitter"),
]

test("outliner groups scene objects by type with counts and folds repeated kinds", () => {
  const rows = buildOutlinerRows(scene)
  expect(rows.filter(r => r.type === "group").map(r => (r.type === "group" ? [r.label, r.count] : null))).toEqual([
    ["Vehicles", 1],
    ["Props", 7],
    ["Emitters", 1],
    ["Lights", 1],
  ])
  const fold = rows.find(r => r.type === "fold")
  expect(fold && fold.type === "fold" ? [fold.label, fold.count, fold.expanded] : null).toEqual(["Cone", 5, false])
  expect(rows.some(r => r.type === "object" && r.object.id === "prop:1")).toBe(false)
  expect(rows.some(r => r.type === "object" && r.object.id === "prop:6")).toBe(true)
})

test("outliner expands folds, collapses groups, filters by text and hides types", () => {
  const expanded = buildOutlinerRows(scene, { expanded: new Set(["fold:props:cone"]) })
  expect(expanded.filter(r => r.type === "object" && r.depth === 2).length).toBe(5)
  const collapsed = buildOutlinerRows(scene, { collapsed: new Set(["props"]) })
  expect(collapsed.some(r => r.type === "fold" || (r.type === "object" && r.group === "props"))).toBe(false)
  expect(collapsed.find(r => r.type === "group" && r.group === "props")?.type).toBe("group")
  const filtered = buildOutlinerRows(scene, { query: "cone #3" })
  expect(filtered.filter(r => r.type === "object").map(r => (r.type === "object" ? r.object.id : ""))).toEqual(["prop:3"])
  const hidden = buildOutlinerRows(scene, { hiddenGroups: new Set(["props", "lights"]) })
  expect(hidden.filter(r => r.type === "group").map(r => (r.type === "group" ? r.group : ""))).toEqual(["vehicles", "emitters"])
})

test("outliner kind and group classification, with label fallback", () => {
  expect(outlinerGroupOf(obj("character:active", "Blackout · Soldier", "character"))).toBe("characters")
  expect(outlinerGroupOf(scene[0]!)).toBe("vehicles")
  expect(outlinerGroupOf(obj("specimen:glass", "Glass pane", "specimen"))).toBe("specimens")
  expect(outlinerKindOf(obj("x", "Barrier #12", "prop"))).toBe("barrier")
  expect(outlinerKindOf(obj("x", "Lamp (3)", "light"))).toBe("lamp")
})

test("outliner shift range covers visible rows and folds select all members", () => {
  const rows = buildOutlinerRows(scene)
  expect(rangeSelection(rows, "obj:character:active", "obj:prop:6")).toEqual(["character:active", "prop:1", "prop:2", "prop:3", "prop:4", "prop:5", "prop:6"])
  expect(rangeSelection(rows, "missing", "fold:props:cone")).toEqual(["prop:1", "prop:2", "prop:3", "prop:4", "prop:5"])
})

test("library maps legacy catalog entries and sections to drawer categories", () => {
  expect(libraryCategoryOf({ id: "material-recipe:wood", category: "objects", sectionId: "materials", tag: "Material" })).toBe("materials")
  expect(libraryCategoryOf({ id: "foliage-preset:oak", category: "objects", sectionId: "foliage", tag: "Foliage" })).toBe("foliage")
  expect(libraryCategoryOf({ id: "looks:noir", category: "objects", sectionId: "looks", tag: "Look" })).toBe("looks")
  expect(libraryCategoryOf({ id: "fixture:smoke-room", category: "effects", sectionId: "effects", tag: "Fixture" })).toBe("effects")
  expect(libraryCategoryOf({ id: "lighting-look:night", category: "lighting", sectionId: "spawn", tag: "Preset" })).toBe("lighting")
  expect(sectionLibraryCategory("foliage")).toBe("foliage")
  expect(sectionLibraryCategory("looks")).toBe("looks")
  expect(sectionLibraryCategory("outbreak-vignette")).toBe("effects")
  expect(sectionLibraryCategory("physics")).toBe("objects")
  expect(isLibraryAsset({ id: "scene-obj:prop:1" })).toBe(false)
  expect(isPlaceable("spawn-prop:hydrant")).toBe(true)
  expect(isPlaceable("effects:smoke")).toBe(false)
  const entries = [
    { id: "effects:smoke", label: "Grenade smoke", group: "Shared FX", category: "effects", tag: "Shared", sectionId: "effects" },
    { id: "spawn-prop:cone", label: "Place Cone", group: "Street Props", category: "objects", tag: "Prop", sectionId: "spawn" },
    { id: "scene-obj:prop:1", label: "Cone #1", group: "In Current Scene", category: "objects", tag: "prop", sectionId: "spawn" },
  ]
  expect(filterLibrary(entries, { category: "objects" }).map(e => e.id)).toEqual(["spawn-prop:cone"])
  expect(filterLibrary(entries, { category: "objects", query: "smoke" }).map(e => e.id)).toEqual(["effects:smoke"])
})

test("palette ranks scene objects, settings, library items and commands with kind prefixes", () => {
  const run = () => {}
  const items: PaletteItem[] = [
    { id: "o1", kind: "object", label: "Hydrant #7", run },
    { id: "s1", kind: "setting", label: "Skid width", meta: "Spawn · Vehicle & Skids", run },
    { id: "s2", kind: "setting", label: "Width", meta: "Lighting · Lamp", run },
    { id: "l1", kind: "library", label: "Place Hydrant", meta: "Objects · Street props", run },
    { id: "c1", kind: "command", label: "Toggle Library Drawer", meta: "Navigation", run },
    { id: "c2", kind: "command", label: "Delete Object", disabled: true, run },
  ]
  expect(rankPalette(items, "skid wid").map(i => i.id)).toEqual(["s1"])
  expect(rankPalette(items, "hydrant").map(i => i.id)).toEqual(["o1", "l1"])
  expect(rankPalette(items, ">lib").map(i => i.id)).toEqual(["c1"])
  expect(rankPalette(items, "#width").map(i => i.id)).toEqual(["s2", "s1"])
  expect(parsePaletteQuery("@ cone")).toEqual({ kind: "object", text: "cone" })
  expect(fuzzyScore("Skid width", "skid")!).toBeLessThan(fuzzyScore("Disk wide", "skid") ?? Infinity)
  expect(fuzzyScore("Radius", "xyz")).toBeNull()
})

test("navigation filter hides rows and empty groups; derived controls are never modified", () => {
  const settings = { a: 1, b: 2, c: true, pos: 3 }
  const controls: LabControl[] = [
    { key: "a", label: "Alpha", group: "One", min: 0, max: 10, step: 1 },
    { key: "b", label: "Beta", group: "One", min: 0, max: 10, step: 1 },
    { key: "c", label: "Gamma", group: "Two" },
    { key: "pos", label: "Position", group: "Transform", min: -10, max: 10, derived: true },
  ]
  const nav = new LabNavigation(settings, controls)
  settings.b = 5
  settings.pos = 8
  expect(nav.isModified(controls[0]!)).toBe(false)
  expect(nav.isModified(controls[1]!)).toBe(true)
  expect(nav.isModified(controls[3]!)).toBe(false)
  nav.filter = row => Boolean(row.control && nav.isModified(row.control))
  expect(nav.visibleRows.map(r => r.control?.key ?? `#${r.group}`)).toEqual(["#One", "b"])
  nav.filter = undefined
  expect(nav.visibleRows.length).toBe(7)
})
