import type { ControlDescriptor, Value } from "@arcade/knobs"
import { inferControlUnit, type LabControl, type LabRow, type LabSettings, type LabValue } from "./lab-navigation"

/**
 * LabControl rows as knobs descriptors, and the values between the two. LabControl and the settings object stay the
 * source of truth: knobs only draws them. Pure, so it is tested without a DOM.
 */

const STRUCTURAL = /^(effect|environment|room|section|keyLabels)$|seed$/i

/** Keys Random and Mutate never touch: the effect and room pickers, the key-label layout and every seed. */
export const isStructuralKey = (key: string) => STRUCTURAL.test(key)

/** The unit knobs shows: LabControl's explicit or inferred unit without the "· retrigger" boundary note. */
export function displayUnit(control: LabControl): string {
  return inferControlUnit(control.key, control.label, control.unit).replace(/\s*·\s*retrigger$/, "").trim()
}

/** Spawn-time values (the unit says "retrigger"): new spawns pick them up, so the row gets a marker. */
export const isSpawnTime = (control: LabControl) => Boolean(control.unit?.includes("retrigger"))

type Range = Extract<LabControl, { min: number }>
type Select = Extract<LabControl, { options: readonly unknown[] }>

function rangeOf(c: Range) {
  const min = Number.isFinite(c.min) ? c.min : 0
  const max = Number.isFinite(c.max) && c.max >= min ? c.max : min + 1
  const step = c.step !== undefined && Number.isFinite(c.step) && c.step > 0 ? c.step : 0.01
  return { min, max: max === min ? min + step : max, step }
}

/** The knobs value for a LabControl's current setting. */
export function toKnobs(control: LabControl, value: LabValue | undefined): Value | undefined {
  if (control.type === "action") return undefined
  if ("min" in control) {
    const n = Number(value)
    return Number.isFinite(n) ? n : rangeOf(control).min
  }
  if ("options" in control) return String(value)
  return value === (control.on ?? true)
}

/** The LabControl setting for a knobs value: choices map back to their typed option, switches to on/off. */
export function fromKnobs(control: LabControl, value: Value): LabValue | undefined {
  if (control.type === "action") return undefined
  if ("min" in control) return typeof value === "number" && Number.isFinite(value) ? value : undefined
  if ("options" in control) return control.options.find(o => String(o.value) === String(value))?.value
  return value ? control.on ?? true : control.off ?? false
}

/**
 * One row as a knobs descriptor, or null when knobs can't draw it (a select with no options). `disabled` is the row's
 * enabled state now, a plain flag: when another setting flips it, the descriptors change and every view redraws the row,
 * including views that don't show the setting that gates it. Seeds and pickers say `random: false`; groups marked
 * `folded` start folded.
 */
export function describe(row: LabRow & { control: LabControl }, defaults: Readonly<LabSettings>, settings: Readonly<LabSettings>): ControlDescriptor | null {
  const c = row.control
  const base = {
    key: c.key,
    label: c.label,
    group: row.group,
    ...(c.enabled?.(settings) === false ? { disabled: true } : {}),
    ...(isStructuralKey(c.key) ? { random: false } : {}),
    ...(c.folded ? { folded: true } : {}),
  }
  if (c.type === "action") return { ...base, kind: "action" }
  const initial = c.key in defaults ? defaults[c.key] : settings[c.key]
  if ("min" in c) {
    const { min, max, step } = rangeOf(c)
    const unit = displayUnit(c)
    return { ...base, kind: "number", default: toKnobs(c, initial) as number, min, max, step, ...(unit ? { unit } : {}) }
  }
  if ("options" in c) {
    const seen = new Set<string>()
    const choices = (c as Select).options.flatMap(o => {
      const id = String(o.value)
      if (seen.has(id)) return []
      seen.add(id)
      return [{ id, label: o.label }]
    })
    if (!choices.length) return null
    const def = String(initial)
    return { ...base, kind: "choice", default: choices.some(o => o.id === def) ? def : choices[0]!.id, choices }
  }
  return { ...base, kind: "toggle", default: toKnobs(c, initial) as boolean }
}

/** Rows in display order: groups ranked by `order`, then in the order they were added (folded groups fold in place). */
export function orderRows<R extends LabRow>(rows: readonly R[], order: readonly string[]): R[] {
  const firstSeen = new Map<string, number>()
  rows.forEach((row, i) => { if (!firstSeen.has(row.group)) firstSeen.set(row.group, i) })
  const rank = (group: string) => {
    const i = order.indexOf(group)
    return i >= 0 ? i : order.length + firstSeen.get(group)!
  }
  return rows.map((row, index) => ({ row, index })).sort((a, b) => rank(a.row.group) - rank(b.row.group) || a.index - b.index).map(x => x.row)
}

/** A small, fast seeded generator (mulberry32), what knobs' Random and Mutate draw from. The same seed always gives the same sequence. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Whether Random and Mutate may change this control: tuning values only, not switches, pickers, seeds or gated rows. */
export function isTunable(control: LabControl, settings: Readonly<LabSettings>): boolean {
  if (control.type === "action" || control.derived || isStructuralKey(control.key)) return false
  if (control.enabled?.(settings) === false) return false
  return "min" in control || ("options" in control && control.options.length > 1)
}

/** The next tuning seed after `seed`: a deterministic walk (1 to 999999), so a recorded seed reproduces every later roll. */
export const nextTuningSeed = (seed: number) => Math.floor(seededRandom(seed ^ 0x5bd1e995)() * 999999) + 1

/**
 * Migrates saved knobs variant JSON (`:variants:v1`) when controls declare `legacyKeys` (for example `aiWalkSpeed` -> `ai.walkSpeed`).
 */
export function migrateKnobsVariantJson(rawJson: string, rows: readonly LabRow[]): string {
  const aliases = new Map<string, string>()
  for (const row of rows) {
    const c = row.control
    if (!c?.legacyKeys) continue
    for (const legacy of c.legacyKeys) aliases.set(legacy, c.key)
  }
  if (!aliases.size) return rawJson
  try {
    const parsed = JSON.parse(rawJson) as Record<string, unknown>
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.variants)) return rawJson
    let changed = false
    const variants = parsed.variants.map((item: unknown) => {
      if (!item || typeof item !== "object") return item
      const rec = item as Record<string, unknown>
      if (!rec.values || typeof rec.values !== "object" || Array.isArray(rec.values)) return item
      const values = { ...(rec.values as Record<string, unknown>) }
      let itemChanged = false
      for (const [legacy, canonical] of aliases) {
        if (legacy in values) {
          if (!(canonical in values)) values[canonical] = values[legacy]
          delete values[legacy]
          itemChanged = true
          changed = true
        }
      }
      return itemChanged ? { ...rec, values } : item
    })
    return changed ? JSON.stringify({ ...parsed, variants }) : rawJson
  } catch {
    return rawJson
  }
}
