import { expect, test } from "bun:test"
import { LabNavigation, formatLabValue, inferControlUnit, type LabControl } from "./lab-navigation"

const controls: LabControl[] = [
  { key: "style", label: "Style", group: "Lights", options: [{ value: "soft", label: "Soft" }, { value: "hard", label: "Hard" }] },
  { key: "pool", label: "Pool intensity", group: "Lights", min: 0, max: 2, step: 0.1, enabled: s => s.style === "soft" },
  { key: "spring", label: "Suspension", group: "Chassis" },
  { key: "wide", label: "Wide", group: "Chassis", on: 1.4, off: 1 },
]
function fixture() {
  const settings = { style: "soft", pool: 0.4, spring: true, wide: 1 }
  const applied: unknown[] = []
  const nav = new LabNavigation(settings, controls, (key, value) => applied.push([key, value]))
  const focus = (key: string) => nav.jump(nav.rows.find(r => r.control?.key === key)!)
  return { settings, applied, nav, focus }
}

test("row navigation wraps, group navigation skips rows, folding preserves focus", () => {
  const { nav, focus } = fixture()
  nav.move(1); expect(nav.active?.control?.key).toBe("style")
  nav.move(1); expect(nav.active?.control?.key).toBe("pool")
  nav.move(1, true); expect(nav.active).toEqual({ group: "Chassis" })
  nav.move(-1, true); expect(nav.active).toEqual({ group: "Lights" })
  nav.fold(true); nav.move(1); expect(nav.active?.group).toBe("Chassis")
  nav.move(-1); expect(nav.active).toEqual({ group: "Lights" })
  focus("pool"); expect(nav.folded.has("Lights")).toBe(false)
  nav.move(-1, true); expect(nav.active?.group).toBe("Chassis")
  nav.move(1, true); nav.move(-1); expect(nav.active?.control?.key).toBe("wide")
})

test("adjustments honor fine/coarse increments, bounds, dependencies and option types", () => {
  const { nav, focus, settings, applied } = fixture()
  focus("pool"); nav.adjust(1, false, true); expect(settings.pool).toBe(0.41)
  nav.adjust(1, true); expect(settings.pool).toBe(1.41)
  nav.adjust(1, true); expect(settings.pool).toBe(2)
  nav.adjust(-1, true); nav.adjust(-1, true); nav.adjust(-1); expect(settings.pool).toBe(0)
  focus("style"); nav.adjust(-1); expect(settings.style).toBe("hard")
  focus("pool"); nav.adjust(1); expect(settings.pool).toBe(0)
  focus("spring"); nav.adjust(-1); expect(settings.spring).toBe(false)
  focus("wide"); nav.adjust(1); expect(settings.wide).toBe(1.4)
  expect(applied.at(-1)).toEqual(["wide", 1.4])
})

test("fuzzy search includes folded controls, group names and keys; jump unfolds", () => {
  const { nav } = fixture()
  nav.fold(true)
  expect(nav.search("plint")[0]?.control?.key).toBe("pool")
  expect(nav.search("CHASSIS").map(r => r.control?.key).sort()).toEqual(["spring", "wide"])
  expect(nav.search("xyzxyz")).toEqual([])
  const match = nav.search("pool")[0]!
  nav.jump(match); expect(nav.visibleRows).toContain(match)
})

test("exact edits reject invalid numbers, accept sub-step values and clamp", () => {
  const { nav, focus, settings } = fixture()
  focus("pool")
  for (const value of ["", " ", "NaN", "Infinity", "1x"]) expect(nav.exact(value)).toBe(false)
  expect(settings.pool).toBe(0.4)
  expect(nav.exact(".12345")).toBe(true); expect(settings.pool).toBe(0.12345)
  nav.exact("99"); expect(settings.pool).toBe(2)
  nav.exact("-2"); expect(settings.pool).toBe(0)
})

test("reset restores constructor defaults through callbacks, scoped to control or group", () => {
  const { nav, focus, settings, applied } = fixture()
  focus("pool"); nav.adjust(1); nav.reset(); expect(settings.pool).toBe(0.4)
  focus("spring"); nav.adjust(1)
  focus("pool"); nav.adjust(1)
  focus("style"); nav.adjust(1); nav.reset(true)
  expect(settings).toEqual({ style: "soft", pool: 0.4, spring: false, wide: 1 })
  expect(applied.slice(-2)).toEqual([["style", "soft"], ["pool", 0.4]])
  expect(JSON.parse(nav.json())).toEqual({ style: "soft", pool: 0.4 })
})

test("randomize stays scoped and step-aligned, including disabled controls", () => {
  const { nav, focus, settings } = fixture()
  focus("style")
  for (let i = 0; i < 50; i++) {
    nav.randomize()
    expect(["soft", "hard"]).toContain(settings.style)
    expect(settings.pool).toBeGreaterThanOrEqual(0); expect(settings.pool).toBeLessThanOrEqual(2)
    expect(settings.pool / 0.1).toBeCloseTo(Math.round(settings.pool / 0.1))
    expect(settings.spring).toBe(true)
  }
})

test("append merges existing groups without duplicate headers and respects visible predicates", () => {
  const settings = { effect: "glass", shardSize: 1, paperCount: 4 }
  const nav = new LabNavigation(settings, [
    { key: "effect", label: "Effect", group: "Emitter", options: [{ value: "glass", label: "Glass" }, { value: "paper", label: "Paper" }] },
  ])
  nav.append([
    { key: "shardSize", label: "Shard size", group: "Glass", min: 0.1, max: 2, step: 0.1, visible: s => s.effect === "glass" },
    { key: "paperCount", label: "Paper count", group: "Paper", min: 1, max: 10, step: 1, visible: s => s.effect === "paper", folded: true },
  ])
  nav.append([
    { key: "extra", label: "Extra", group: "Emitter" },
  ])
  const headers = nav.rows.filter(r => !r.control).map(r => r.group)
  expect(headers).toEqual(["Emitter", "Glass", "Paper"])
  expect(nav.folded.has("Paper")).toBe(true)
  expect(nav.visibleRows.map(r => r.control?.key ?? r.group)).toEqual(["Emitter", "effect", "extra", "Glass", "shardSize"])
  expect(nav.search("paper")).toEqual([])
  settings.effect = "paper"
  expect(nav.visibleRows.map(r => r.control?.key ?? r.group)).toEqual(["Emitter", "effect", "extra", "Paper"])
  expect(nav.search("paper")[0]?.control?.key).toBe("paperCount")
  expect(formatLabValue(1.2000000000000002, 0.1, inferControlUnit("shardSize", "Shard size"))).toBe("1.2 m")
})
