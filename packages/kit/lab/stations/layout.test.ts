import { describe, expect, test } from "bun:test"
import { addWidget, defaultLayout, featuredGroups, moveWidget, nudgeWidget, parseLayout, removeWidget, resolveLayout, saveLayout, savedLayout, stationLayout, toStationLayout, updateWidget } from "./layout"
import { gridVariants, orderStations, validateStations, type LabStation } from "./types"

const station = (id: string, order: number, extra: Partial<LabStation> = {}): LabStation => ({
  id, title: id, summary: `${id} summary`, order, status: "live", demo: { kind: "section", section: "effects" }, ...extra,
})

function memory() {
  const data = new Map<string, string>()
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data }
}

describe("stations", () => {
  test("order sets quick-travel keys 1–9 then 0", () => {
    const list = Array.from({ length: 12 }, (_, i) => station(`s-${i}`, 100 - i))
    const ordered = orderStations(list)
    expect(ordered[0]!.station.id).toBe("s-11")
    expect(ordered.map(o => o.key)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", null, null])
  })
  test("validation reports bad ids, boards, grids, variants and layouts without throwing", () => {
    const problems = validateStations([
      station("ok", 1),
      station("ok", 2),
      station("Bad Id", 3),
      station("board", 4, { board: { feature: "ar12" } }),
      station("grid", 5, { grid: "nope" }),
      station("page", 6, { demo: { kind: "page", url: "https://example.com" } }),
      station("variants", 7, { variants: [{ id: "a", label: "A" }, { id: "a", label: "A2" }], defaultVariant: "b" }),
      station("layout", 8, { layout: { left: [{ widget: "nope" as never }] } }),
    ]).join("\n")
    for (const text of ["duplicate id", "lowercase", "AR-12", 'unknown grid preset "nope"', "Arcade paths", 'duplicate variant "a"', "defaultVariant", 'unknown widget "nope"']) expect(problems).toContain(text)
  })
  test("old station files with prop and color still check", () => {
    expect(validateStations([station("old", 1, { prop: "burst", color: 0xff8800 })])).toEqual([])
  })
  test("grid variants become scene.set-param setups", () => {
    const variants = gridVariants("smoke")
    expect(variants.length).toBeGreaterThan(1)
    expect(variants[0]!.setup!.every(s => s.command === "scene.set-param")).toBe(true)
  })
})

describe("station layouts", () => {
  const weather = station("weather", 1, { variants: [{ id: "rain", label: "Rain" }], metrics: [{ label: "GPU", value: "1 ms" }], paths: ["packages/kit/weather"] })

  test("the default puts status left, two groups of controls right and the working tools in the dock", () => {
    const layout = resolveLayout(defaultLayout(weather, ["Stage", "Precipitation", "Wind"]))
    expect(layout.left.map(w => w.id)).toEqual(["status", "metrics"])
    expect(layout.right).toEqual([{ widget: "controls", groups: ["Stage", "Precipitation"], id: "controls" }])
    expect(layout.dock.map(w => w.id)).toEqual(["variants", "compare", "perf", "voice", "notes", "changes"])
  })
  test("the controls card features groups with tuning sliders", () => {
    expect(featuredGroups([{ name: "Stage", tunable: 0 }, { name: "Emitter", tunable: 1 }, { name: "Fireball", tunable: 3 }, { name: "Smoke", tunable: 4 }, { name: "Debris", tunable: 2 }])).toEqual(["Fireball", "Smoke"])
    expect(featuredGroups([{ name: "Stage", tunable: 0 }, { name: "Emitter", tunable: 1 }])).toEqual(["Emitter"])
    expect(featuredGroups([{ name: "Stage", tunable: 0 }])).toEqual(["Stage"])
  })
  test("page stations get no controls or compare", () => {
    const layout = resolveLayout(defaultLayout(station("page", 1, { demo: { kind: "page", url: "/arcade/x" } }), ["A"]))
    expect(layout.right).toEqual([])
    expect(layout.dock.map(w => w.widget)).not.toContain("compare")
  })
  test("ids are unique per kind and survive a round trip through the file shape", () => {
    const layout = resolveLayout({ right: [{ widget: "controls", groups: ["A"] }, { widget: "controls", groups: ["B"] }] })
    expect(layout.right.map(w => w.id)).toEqual(["controls", "controls-2"])
    expect(toStationLayout(layout).right).toEqual([{ widget: "controls", groups: ["A"] }, { widget: "controls", groups: ["B"], id: "controls-2" }])
    expect(resolveLayout(toStationLayout(layout))).toEqual(layout)
  })
  test("move, nudge, remove, add and configure", () => {
    let layout = resolveLayout(defaultLayout(weather, ["Stage"]))
    layout = moveWidget(layout, "status", "dock", 0)
    expect(layout.dock[0]!.id).toBe("status")
    expect(layout.left.map(w => w.id)).toEqual(["metrics"])
    layout = nudgeWidget(layout, "status", 1)
    expect(layout.dock.map(w => w.id).slice(0, 2)).toEqual(["variants", "status"])
    layout = removeWidget(layout, "notes")
    layout = removeWidget(layout, "changes")
    expect(layout.dock.map(w => w.id)).not.toContain("notes")
    layout = addWidget(layout, { widget: "controls", groups: ["Wind"] }, "left")
    expect(layout.left.at(-1)).toEqual({ widget: "controls", groups: ["Wind"], id: "controls-2" })
    layout = updateWidget(layout, "controls-2", { title: "Wind", groups: [] })
    expect(layout.left.at(-1)).toEqual({ widget: "controls", id: "controls-2", title: "Wind" })
  })
  test("a malformed saved layout is rejected whole", () => {
    expect(parseLayout({ left: [{ widget: "status" }] })).toEqual({ left: [{ widget: "status" }] })
    for (const bad of [null, [], { middle: [] }, { left: [{ widget: "nope" }] }, { left: [{ widget: "status", extra: 1 }] }, { left: [{ widget: "controls", groups: [3] }] }, { left: [{ widget: "status", id: "Bad Id" }] }]) {
      expect(parseLayout(bad)).toBeNull()
    }
  })
  test("saved layouts override the file, and forgetting one goes back to it", () => {
    const storage = memory()
    const withFile = station("w", 1, { layout: { dock: [{ widget: "perf" }] } })
    expect(stationLayout(withFile, [], storage).dock.map(w => w.id)).toEqual(["perf"])
    saveLayout(storage, "w", { left: [{ widget: "notes" }] })
    expect(savedLayout(storage, "w")).toEqual({ left: [{ widget: "notes" }] })
    expect(stationLayout(withFile, [], storage).left.map(w => w.id)).toEqual(["notes"])
    saveLayout(storage, "w", null)
    expect(stationLayout(withFile, [], storage).dock.map(w => w.id)).toEqual(["perf"])
    storage.data.set("arcade.lab.station-layouts.v1", JSON.stringify({ version: 1, layouts: { w: { left: [{ widget: "nope" }] } } }))
    expect(savedLayout(storage, "w")).toBeNull()
  })
})
