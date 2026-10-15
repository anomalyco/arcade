import { describe, expect, test } from "bun:test"
import type { LabControl, LabRow } from "./lab-navigation"
import { describe as describeRow, fromKnobs, isStructuralKey, nextTuningSeed, orderRows, seededPatch, toKnobs } from "./lab-tuning"

const range: LabControl = { key: "size", label: "Size", group: "Fireball", min: 0, max: 2, step: 0.05, unit: "m · retrigger" }
const select: LabControl = { key: "style", label: "Style", group: "Look", type: "select", options: [{ value: 0, label: "Current" }, { value: 1, label: "Surface" }, { value: 2, label: "Ink" }] }
const toggle: LabControl = { key: "beam", label: "Beam", group: "Look", type: "toggle", on: 1, off: 0 }
const seed: LabControl = { key: "seed", label: "Seed", group: "Fireball", min: 1, max: 999, step: 1, unit: "" }
const row = (control: LabControl): LabRow & { control: LabControl } => ({ group: control.group ?? "Controls", control })

describe("LabControl as knobs", () => {
  test("ranges keep their bounds, step and unit without the retrigger note", () => {
    expect(describeRow(row(range), { size: 1.25 }, { size: 0.4 })).toEqual({ key: "size", label: "Size", group: "Fireball", kind: "number", default: 1.25, min: 0, max: 2, step: 0.05, unit: "m" })
  })
  test("selects become choices by string id and map back to their typed values", () => {
    const d = describeRow(row(select), { style: 1 }, { style: 1 })!
    expect(d).toMatchObject({ kind: "choice", default: "1", choices: [{ id: "0", label: "Current" }, { id: "1", label: "Surface" }, { id: "2", label: "Ink" }] })
    expect(toKnobs(select, 2)).toBe("2")
    expect(fromKnobs(select, "2")).toBe(2)
  })
  test("toggles with numeric on/off become switches and come back as numbers", () => {
    expect(toKnobs(toggle, 1)).toBe(true)
    expect(toKnobs(toggle, 0)).toBe(false)
    expect(fromKnobs(toggle, true)).toBe(1)
    expect(fromKnobs(toggle, false)).toBe(0)
  })
  test("a select without options isn't drawn; a broken range gets safe bounds", () => {
    expect(describeRow(row({ key: "x", label: "X", type: "select", options: [] }), {}, {})).toBeNull()
    expect(describeRow(row({ key: "y", label: "Y", min: 1, max: 1, step: 0 }), {}, { y: 1 })).toMatchObject({ min: 1, max: 1.01, step: 0.01 })
  })
  test("groups follow the Details order, advanced (folded) groups last", () => {
    const rows = [row({ ...range, group: "A" }), row({ ...range, key: "b", group: "B" }), row({ ...range, key: "c", group: "C" })]
    expect(orderRows(rows, ["C"], new Set(["A"])).map(r => r.group)).toEqual(["C", "B", "A"])
  })
})

describe("seeded Random and Mutate", () => {
  const controls = [range, select, toggle, seed]
  const settings = { size: 1, style: 0, beam: 1, seed: 7 }

  test("the same seed gives the same values; another seed gives others", () => {
    const a = seededPatch(controls, settings, 41, "random")
    expect(seededPatch(controls, settings, 41, "random")).toEqual(a)
    expect(seededPatch(controls, settings, 42, "random")).not.toEqual(a)
  })
  test("Random lands on the step lattice and leaves switches and seeds alone", () => {
    for (let s = 1; s < 50; s++) {
      const patch = seededPatch(controls, settings, s, "random")
      expect(Object.keys(patch).sort()).toEqual(["size", "style"])
      const steps = (patch.size as number) / 0.05
      expect(Math.abs(steps - Math.round(steps))).toBeLessThan(1e-9)
      expect(patch.size).toBeGreaterThanOrEqual(0)
      expect(patch.size).toBeLessThanOrEqual(2)
    }
  })
  test("Mutate moves a range 8–12% of its span and stays in range", () => {
    for (let s = 1; s < 50; s++) {
      const moved = seededPatch([range], { size: 1 }, s, "mutate").size as number
      expect(Math.abs(moved - 1)).toBeGreaterThanOrEqual(0.15 - 1e-9)
      expect(Math.abs(moved - 1)).toBeLessThanOrEqual(0.25 + 1e-9)
    }
    expect(seededPatch([range], { size: 2 }, 3, "mutate").size).toBeLessThan(2)
  })
  test("gated and derived rows are skipped", () => {
    expect(seededPatch([{ ...range, enabled: () => false }, { ...range, key: "d", derived: true }], { size: 1, d: 1 }, 5, "random")).toEqual({})
  })
  test("structural keys are never tuned", () => {
    for (const key of ["effect", "environment", "room", "keyLabels", "seed", "effectSeed", "tuningSeed"]) expect(isStructuralKey(key)).toBe(true)
    expect(isStructuralKey("size")).toBe(false)
  })
  test("the tuning seed walks deterministically and stays positive", () => {
    let s = 1
    const seen = new Set<number>()
    for (let i = 0; i < 1000; i++) { s = nextTuningSeed(s); expect(s).toBeGreaterThan(0); expect(s).toBeLessThan(1_000_000); seen.add(s) }
    expect(seen.size).toBeGreaterThan(990)
    expect(nextTuningSeed(41)).toBe(nextTuningSeed(41))
  })
})
