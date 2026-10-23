import { expect, test } from "bun:test"
import { FOREST_STORM_DEFAULTS, forestStormControls } from "@arcade/kit/forest/storm"
import { FOREST_LOOK_DEFAULTS } from "@arcade/kit/forest/settings"
import { arrangeControl, LOOKS_SECTION, SECTIONS } from "../src/knobs"
import { applyLook, lookBase, LOOK_IDS, LOOKS } from "../src/looks"

const targets = () => ({ forest: { ...FOREST_LOOK_DEFAULTS } as Record<string, unknown>, storm: { ...FOREST_STORM_DEFAULTS } as Record<string, unknown>, feel: { ridgeGlow: 1 } as Record<string, unknown> })

test("Today changes nothing, and every Look then Today restores the shipped values", () => {
  const t = targets(), shipped = structuredClone(t), base = lookBase(t)
  applyLook("today", t, base)
  expect(t).toEqual(shipped)
  for (const id of LOOK_IDS) {
    applyLook(id, t, base)
    for (const part of ["forest", "storm", "feel"] as const) for (const [k, v] of Object.entries(LOOKS[id][part] ?? {})) expect(t[part][k]).toEqual(v)
    applyLook("today", t, base)
    expect(t).toEqual(shipped)
  }
})

test("switching Looks never leaves one's settings behind", () => {
  const t = targets(), base = lookBase(t)
  applyLook("downpour", t, base)
  applyLook("moonlit", t, base)
  expect(t.storm.rain).toBe(FOREST_STORM_DEFAULTS.rain)
  expect(t.storm.strikes).toBe(FOREST_STORM_DEFAULTS.strikes)
  expect(t.forest.skyMoon).toBe("full")
})

test("only the dry Looks are dry, and only the storm Looks strike", () => {
  for (const id of LOOK_IDS) {
    const storm = LOOKS[id].storm
    expect((storm.strikes ?? 0) > 0).toBe(id === "stormcoming" || id === "downpour")
    expect((storm.rain ?? 0) > 0).toBe(id === "downpour")
  }
})

test("every knob lands in one of the sections; storm rows keep their keys under Weather", () => {
  const rows = forestStormControls("Weather").map(arrangeControl)
  for (const r of rows) {
    expect(SECTIONS).toContain(r.group as (typeof SECTIONS)[number])
    expect(r.group).toBe("Weather")
    expect(r.subsection).toBeTruthy()
  }
  expect(rows.map((r) => r.key)).toEqual(forestStormControls("Weather").map((r) => r.key))
  expect(arrangeControl({ key: "woods.look", label: "Look", group: LOOKS_SECTION, type: "select", options: [] }).group).toBe(LOOKS_SECTION)
  expect(arrangeControl({ key: "x", label: "X", group: "Flashlight", subsection: "Shadows" }).subsection).toBe("Flashlight shadows")
  expect(arrangeControl({ key: "y", label: "Y", group: "Something new" }).group).toBe("Debug")
})
