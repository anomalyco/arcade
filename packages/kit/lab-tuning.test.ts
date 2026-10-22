import { describe, expect, test } from "bun:test"
import { holdsValue, isRampControl, isSwitchControl, resolveControlField, type LabControl, type LabRow } from "./lab-navigation"
import { curveText, gradientText } from "./ramps"
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
  test("readouts and button rows hold no value: readouts poll `read`, buttons become a toolbar", () => {
    const read = () => "42 kn"
    const watch: LabControl = { key: "wind", label: "Wind", group: "Weather", type: "readout", read }
    expect(describeRow(row(watch), {}, {})).toEqual({ key: "wind", label: "Wind", group: "Weather", kind: "watch", get: read })
    const meter: LabControl = { key: "peak", label: "Peak", group: "Audio", type: "readout", display: "meter", scale: { min: 0, max: 1, critical: 0.95 }, read: () => 0.5 }
    expect(describeRow(row(meter), {}, {})).toMatchObject({ kind: "meter", min: 0, max: 1, critical: 0.95 })
    const buttons: LabControl = { key: "presets", label: "Presets", group: "Weather", type: "buttons", items: [{ key: "clear", label: "Clear", run: () => {} }, { key: "storm", label: "Storm", run: () => {}, enabled: s => s.live === true }] }
    expect(describeRow(row(buttons), {}, { live: false })).toEqual({ key: "presets", label: "Presets", group: "Weather", kind: "toolbar", items: [{ key: "clear", label: "Clear" }, { key: "storm", label: "Storm", disabled: true }] })
    for (const c of [watch, meter, buttons]) {
      expect(holdsValue(c)).toBe(false)
      expect(isSwitchControl(c)).toBe(false)
      expect(isTunable(c, {})).toBe(false)
      expect(toKnobs(c, 1)).toBeUndefined()
    }
  })
  test("a select without options isn't drawn; a broken range gets safe bounds", () => {
    expect(describeRow(row({ key: "x", label: "X", type: "select", options: [] }), {}, {})).toBeNull()
    expect(describeRow(row({ key: "y", label: "Y", min: 1, max: 1, step: 0 }), {}, { y: 1 })).toMatchObject({ min: 1, max: 1.01, step: 0.01 })
  })
  test("groups follow the Details order, then the order they were added", () => {
    const rows = [row({ ...range, group: "A" }), row({ ...range, key: "b", group: "B" }), row({ ...range, key: "c", group: "C" })]
    expect(orderRows(rows, ["C"]).map(r => r.group)).toEqual(["C", "A", "B"])
  })
  test("a group's sub-headings keep their rows together, after the rows without one", () => {
    const rows = [row({ ...range, key: "a" }), row({ ...range, key: "b", subsection: "Advanced" }), row({ ...range, key: "c" }), row({ ...range, key: "d", subsection: "Advanced" })]
    expect(orderRows(rows, []).map(r => r.control.key)).toEqual(["a", "c", "b", "d"])
  })
  test("seeds draw as seed rows, full-turn headings as dials, a pair as one range", () => {
    expect(describeRow(row(seed), {}, { seed: 7 })).toMatchObject({ kind: "seed", default: 7, min: 1, max: 999 })
    const yaw: LabControl = { key: "yaw", label: "Yaw", group: "Spot", min: -180, max: 180, step: 1 }
    expect(describeRow(row(yaw), {}, { yaw: 30 })).toMatchObject({ kind: "angle", min: -180, max: 180 })
    expect(describeRow(row({ ...yaw, key: "pitch", label: "Pitch", min: 5, max: 85 }), {}, { pitch: 30 })).toMatchObject({ kind: "number" })
    const low: LabControl = { key: "lo", label: "Small", group: "Drops", min: 0.01, max: 0.1, step: 0.005, pair: { key: "hi", label: "Drop size" } }
    const high: LabControl = { key: "hi", label: "Large", group: "Drops", min: 0.03, max: 0.2, step: 0.005 }
    expect(describeRow(row(low), {}, { lo: 0.02, hi: 0.08 }, { pair: high })).toMatchObject({ kind: "range", label: "Drop size", default: [0.02, 0.08], min: 0.01, max: 0.2 })
  })
  test("tabs and sub-headings reach the descriptor", () => {
    expect(describeRow(row({ ...range, subsection: "Advanced" }), {}, { size: 1 }, { tab: "Trees", groupLabel: "Structure" })).toMatchObject({ tab: "Trees", groupLabel: "Structure", subsection: "Advanced" })
  })
  test("a pair saved as two numbers migrates to one range value", () => {
    const low: LabControl = { key: "lo", label: "Small", group: "Drops", min: 0, max: 1, pair: { key: "hi", label: "Drop size" } }
    const raw = JSON.stringify({ variants: [{ name: "a", values: { lo: 0.2, hi: 0.6 } }] })
    expect(JSON.parse(migrateKnobsVariantJson(raw, [row(low)])).variants[0].values).toEqual({ lo: [0.2, 0.6] })
  })
  test("curves and gradients travel as JSON text and draw as knobs' ramp editors", () => {
    const sizeCurve: LabControl = { key: "sizeOverLife", label: "Size over life", group: "Over life", type: "curve", range: [0, 2], interp: "linear" }
    const tint: LabControl = { key: "tintOverLife", label: "Tint over life", group: "Over life", type: "gradient" }
    const text = curveText([{ x: 0, y: 1 }, { x: 1, y: 0.5 }], { range: [0, 2] })
    const white = gradientText([{ at: 0, color: "#ffffff" }, { at: 1, color: "#ffffff" }])
    expect(describeRow(row(sizeCurve), { sizeOverLife: text }, { sizeOverLife: text })).toMatchObject({ kind: "curve", range: [0, 2], interp: "linear", random: false, default: [{ x: 0, y: 1 }, { x: 1, y: 0.5 }] })
    expect(describeRow(row(tint), { tintOverLife: white }, { tintOverLife: white })).toMatchObject({ kind: "gradient", random: false })
    const points = toKnobs(sizeCurve, text)!
    expect(fromKnobs(sizeCurve, points)).toBe(text)
    expect(fromKnobs(tint, toKnobs(tint, white)!)).toBe(white)
    // Broken text falls back to a usable ramp instead of throwing.
    expect(toKnobs(sizeCurve, "nope")).toEqual([{ x: 0, y: 0 }, { x: 1, y: 1 }])
    expect(fromKnobs(sizeCurve, 1 as Value)).toBeUndefined()
    expect(isTunable(sizeCurve, {})).toBe(false)
    expect(isRampControl(tint) && !isSwitchControl(tint)).toBe(true)
  })
  test("a ramp survives a round trip through knobs unchanged", () => {
    const c: LabControl = { key: "fog", label: "Fog", group: "Sky", type: "curve", range: [0, 0.4] }
    const text = curveText([{ x: 0, y: 0.04 }, { x: 0.5, y: 0.2 }, { x: 1, y: 0.1 }], { range: [0, 0.4] })
    const settings = { fog: text }
    const remote = createRemoteControls("ramps", [describeRow(row(c), settings, settings)!])
    expect(fromKnobs(c, remote.get().fog as Value)).toBe(text)
  })
  test("seeds stay out of Random, gated rows are disabled now, folded groups say so", () => {
    expect(describeRow(row(seed), {}, { seed: 7 })).toMatchObject({ random: false, kind: "seed" })
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
