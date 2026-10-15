import { describe, expect, test } from "bun:test"
import { resolveControlField, type LabControl, type LabRow } from "./lab-navigation"
import { createRemoteControls, type State, type Value } from "@arcade/knobs"
import { describe as describeRow, fromKnobs, isStructuralKey, isTunable, migrateKnobsVariantJson, nextTuningSeed, orderRows, seededRandom, toKnobs } from "./lab-tuning"

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
  test("groups follow the Details order, then the order they were added", () => {
    const rows = [row({ ...range, group: "A" }), row({ ...range, key: "b", group: "B" }), row({ ...range, key: "c", group: "C" })]
    expect(orderRows(rows, ["C"]).map(r => r.group)).toEqual(["C", "A", "B"])
  })
  test("seeds stay out of Random, gated rows are disabled now, folded groups say so", () => {
    expect(describeRow(row(seed), {}, { seed: 7 })).toMatchObject({ random: false })
    expect(describeRow(row({ ...range, enabled: s => s.beam === 1 }), {}, { size: 1, beam: 0 })).toMatchObject({ disabled: true })
    expect(describeRow(row({ ...range, enabled: s => s.beam === 1 }), {}, { size: 1, beam: 1 })).not.toHaveProperty("disabled")
    expect(describeRow(row({ ...range, folded: true }), {}, { size: 1 })).toMatchObject({ folded: true })
  })
})

describe("seeded Random and Mutate through knobs", () => {
  const controls = [range, select, toggle, seed, { ...range, key: "gated", enabled: () => false } as LabControl]
  const settings = { size: 1, style: 0, beam: 1, seed: 7, gated: 1 }
  /** A knobs store over the controls as the Lab sets it up: draws from `seed`, rolls only what isTunable allows. */
  const roll = (rollSeed: number, mode: "randomize" | "mutate") => {
    const descriptors = controls.map(c => describeRow(row(c), settings, settings)!)
    const values = Object.fromEntries(controls.map(c => [c.key, toKnobs(c, settings[c.key as keyof typeof settings])!])) as State
    const patch: Record<string, Value> = {}
    const store = createRemoteControls(`test-${rollSeed}-${mode}`, descriptors, {
      values,
      nullDefaults: false,
      random: seededRandom(rollSeed),
      tunable: key => isTunable(controls.find(c => c.key === key)!, settings),
      onSet: (key, value) => { if (value !== null) patch[key] = value },
    })
    store[mode]()
    return patch
  }

  test("the same seed gives the same values; another seed gives others", () => {
    const a = roll(41, "randomize")
    expect(roll(41, "randomize")).toEqual(a)
    expect(roll(42, "randomize")).not.toEqual(a)
  })
  test("Random lands on the step lattice and leaves switches, seeds and gated rows alone", () => {
    for (let s = 1; s < 30; s++) {
      const patch = roll(s, "randomize")
      for (const key of Object.keys(patch)) expect(["size", "style"]).toContain(key)
      if ("size" in patch) {
        const steps = (patch.size as number) / 0.05
        expect(Math.abs(steps - Math.round(steps))).toBeLessThan(1e-9)
        expect(patch.size).toBeGreaterThanOrEqual(0)
        expect(patch.size).toBeLessThanOrEqual(2)
      }
    }
  })
  test("Mutate stays in range and never touches switches or seeds", () => {
    for (let s = 1; s < 30; s++) {
      const patch = roll(s, "mutate")
      for (const key of Object.keys(patch)) expect(["size", "style"]).toContain(key)
      if ("size" in patch) expect(patch.size).toBeGreaterThanOrEqual(0)
    }
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
  test("resolveControlField and migrateKnobsVariantJson support namespaced keys and legacy aliases", () => {
    const aiWalk: LabControl = {
      key: "ai.walkSpeed",
      field: "walkSpeed",
      legacyKeys: ["aiWalkSpeed"],
      label: "Wander speed",
      group: "AI",
      min: 0.4,
      max: 2.2,
      step: 0.05,
    }
    expect(resolveControlField(aiWalk, { walkSpeed: 0.95 })).toBe("walkSpeed")
    expect(resolveControlField({ key: "ai.chaseSpeed", label: "Chase", min: 1, max: 5 }, { chaseSpeed: 2.3 })).toBe("chaseSpeed")
    const raw = JSON.stringify({
      version: 1,
      controls: "lab:arcade-outbreak",
      variants: [{ id: "v1", name: "Fast shamblers", values: { aiWalkSpeed: 1.4, walkSpeed: 3.8 } }],
    })
    const migrated = JSON.parse(migrateKnobsVariantJson(raw, [row(aiWalk)]))
    expect(migrated.variants[0].values).toEqual({ "ai.walkSpeed": 1.4, walkSpeed: 3.8 })
  })
})
