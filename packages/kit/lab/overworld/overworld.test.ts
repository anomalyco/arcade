import { describe, expect, test } from "bun:test"
import { dioramaVertices, layoutPlots, overviewCamera, plotAt, PLOT_SPACING } from "./diorama"
import { gridVariants, orderStations, validateStations, type LabStation } from "./types"

const station = (id: string, order: number, extra: Partial<LabStation> = {}): LabStation => ({
  id, title: id, summary: `${id} summary`, order, prop: "burst", color: 0xff8800, status: "live",
  demo: { kind: "section", section: "effects" }, ...extra,
})

describe("overworld stations", () => {
  test("order sets quick-travel keys 1–9 then 0", () => {
    const list = Array.from({ length: 12 }, (_, i) => station(`s-${i}`, 100 - i))
    const ordered = orderStations(list)
    expect(ordered[0]!.station.id).toBe("s-11")
    expect(ordered.map(o => o.key)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", null, null])
  })
  test("validation reports bad ids, boards, grids and variants without throwing", () => {
    const problems = validateStations([
      station("ok", 1),
      station("ok", 2),
      station("Bad Id", 3),
      station("board", 4, { board: { feature: "ar12" } }),
      station("grid", 5, { grid: "nope" }),
      station("page", 6, { demo: { kind: "page", url: "https://example.com" } }),
      station("variants", 7, { variants: [{ id: "a", label: "A" }, { id: "a", label: "A2" }], defaultVariant: "b" }),
    ])
    expect(problems.join("\n")).toContain("duplicate id")
    expect(problems.join("\n")).toContain("lowercase")
    expect(problems.join("\n")).toContain("AR-12")
    expect(problems.join("\n")).toContain('unknown grid preset "nope"')
    expect(problems.join("\n")).toContain("Arcade paths")
    expect(problems.join("\n")).toContain('duplicate variant "a"')
    expect(problems.join("\n")).toContain('defaultVariant "b"')
  })
  test("grid variants turn tiles into set-param commands", () => {
    const smoke = gridVariants("smoke")
    expect(smoke.length).toBe(4)
    expect(smoke[0]!.setup).toContainEqual({ command: "scene.set-param", args: { key: "effect", value: "smoke" } })
    expect(gridVariants("smoke", ["ground-fog"]).map(v => v.id)).toEqual(["ground-fog"])
  })
})

describe("overworld diorama", () => {
  const stations = Array.from({ length: 13 }, (_, i) => station(`s-${i}`, i))
  const plots = layoutPlots(stations)
  test("plots sit on a grid without overlapping and are found by ground point", () => {
    const keys = new Set(plots.map(p => `${p.x},${p.z}`))
    expect(keys.size).toBe(13)
    for (const a of plots) for (const b of plots) if (a !== b) expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThanOrEqual(PLOT_SPACING - 1e-6)
    expect(plotAt(plots, plots[6]!.x + 2, plots[6]!.z - 2)?.station.id).toBe("s-6")
    expect(plotAt(plots, plots[0]!.x - PLOT_SPACING / 2, plots[0]!.z - PLOT_SPACING / 2)).toBeNull()
  })
  test("the overview camera keeps every plot inside the viewport margins", () => {
    for (const aspect of [16 / 10, 4 / 3, 21 / 9]) {
      const c = overviewCamera(plots, aspect)
      expect(c.distance).toBeGreaterThan(8)
      expect(c.distance).toBeLessThan(105)
    }
    expect(overviewCamera(plots, 4 / 3).distance).toBeGreaterThan(overviewCamera(plots, 21 / 9).distance)
  })
  test("geometry is whole triangles in the Lab mesh format", () => {
    const v = dioramaVertices(plots)
    expect(v.length % 30).toBe(0)
    expect(v.every(Number.isFinite)).toBe(true)
  })
})
