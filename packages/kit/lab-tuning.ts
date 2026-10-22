import type { ControlDescriptor, Value } from "@arcade/knobs"
import { inferControlUnit, isRampControl, type LabControl, type LabRow, type LabSettings, type LabValue } from "./lab-navigation"
import { parseCurve, parseGradient, type CurvePoint, type GradientStop } from "./ramps"

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

/** Seeds draw as knobs' seed row: a whole number with a die that rolls a new one (never part of Random). */
export const isSeed = (control: LabControl): boolean => "min" in control && /seed$/i.test(control.key)

/** Headings (a full turn in degrees: yaw, azimuth, wind direction, texture rotation) draw as an angle dial. */
export const isHeading = (control: LabControl): boolean =>
  "min" in control && /^(°|deg)$/.test(displayUnit(control)) && control.max - control.min === 360

const LINEAR: readonly CurvePoint[] = [{ x: 0, y: 0 }, { x: 1, y: 1 }]
const BLACK_TO_WHITE: readonly GradientStop[] = [{ at: 0, color: "#000000" }, { at: 1, color: "#ffffff" }]

/** The knobs value for a LabControl's current setting. Ramps go from their JSON text to knobs' stops or points. */
export function toKnobs(control: LabControl, value: LabValue | undefined): Value | undefined {
  if (control.type === "action") return undefined
  if (control.type === "curve") return parseCurve(value, LINEAR, { range: control.range }) as Value
  if (control.type === "gradient") return parseGradient(value, BLACK_TO_WHITE) as Value
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
  if (isRampControl(control)) return Array.isArray(value) && value.length >= 2 ? JSON.stringify(value) : undefined
  if ("min" in control) return typeof value === "number" && Number.isFinite(value) ? value : undefined
  if ("options" in control) return control.options.find(o => String(o.value) === String(value))?.value
  return value ? control.on ?? true : control.off ?? false
}

/** Where a row sits in a view: its tab and heading there, and the upper end it pairs with (a low–high range). */
/** `folded`: how the row's group starts when its view folds groups (over the control's own `folded`). */
export type DescribePlace = { tab?: string; groupLabel?: string; pair?: LabControl; folded?: boolean }

/**
 * One row as a knobs descriptor, or null when knobs can't draw it (a select with no options). `disabled` is the row's
 * enabled state now, a plain flag: when another setting flips it, the descriptors change and every view redraws the row,
 * including views that don't show the setting that gates it. Seeds and pickers say `random: false`; groups marked
 * `folded` start folded.
 */
export function describe(row: LabRow & { control: LabControl }, defaults: Readonly<LabSettings>, settings: Readonly<LabSettings>, place: DescribePlace = {}): ControlDescriptor | null {
  const c = row.control
  const upper = place.pair
  const base = {
    key: c.key,
    label: upper ? c.pair!.label : c.label,
    group: row.group,
    ...(place.groupLabel ? { groupLabel: place.groupLabel } : {}),
    ...(place.tab ? { tab: place.tab } : {}),
    ...(c.subsection ? { subsection: c.subsection } : {}),
    ...(c.enabled?.(settings) === false || upper?.enabled?.(settings) === false ? { disabled: true } : {}),
    ...(isStructuralKey(c.key) ? { random: false } : {}),
    ...(place.folded !== undefined ? { folded: place.folded } : c.folded ? { folded: true } : {}),
  }
  if (c.type === "action") return { ...base, kind: "action" }
  const initial = c.key in defaults ? defaults[c.key] : settings[c.key]
  if (c.type === "curve") {
    const range = c.range ?? [0, 1]
    const unit = displayUnit(c)
    return { ...base, kind: "curve", random: false, default: toKnobs(c, initial)!, range, ...(c.interp ? { interp: c.interp } : {}), ...(c.presets ? { presets: c.presets } : {}), ...(unit ? { unit } : {}) }
  }
  if (c.type === "gradient") {
    return { ...base, kind: "gradient", random: false, default: toKnobs(c, initial)!, ...(c.space ? { space: c.space } : {}), ...(c.presets ? { presets: c.presets } : {}) }
  }
  if (upper && "min" in c && "min" in upper) {
    const lo = rangeOf(c), hi = rangeOf(upper)
    const unit = displayUnit(c)
    const top = upper.key in defaults ? defaults[upper.key] : settings[upper.key]
    return { ...base, kind: "range", default: [toKnobs(c, initial) as number, toKnobs(upper, top) as number], min: Math.min(lo.min, hi.min), max: Math.max(lo.max, hi.max), step: Math.min(lo.step, hi.step), ...(unit ? { unit } : {}) }
  }
  if ("min" in c && isSeed(c)) {
    const { min, max } = rangeOf(c)
    return { ...base, kind: "seed", default: Math.round(toKnobs(c, initial) as number), min: Math.ceil(min), max: Math.floor(max) }
  }
  if ("min" in c && isHeading(c)) {
    const { min, max, step } = rangeOf(c)
    return { ...base, kind: "angle", default: toKnobs(c, initial) as number, min, max, step }
  }
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

/**
 * Rows in display order: groups ranked by `order`, then in the order they were added (folded groups fold in place).
 * Inside a group, rows without a sub-heading come first and each sub-heading's rows sit together under it.
 */
export function orderRows<R extends LabRow>(rows: readonly R[], order: readonly string[]): R[] {
  const firstSeen = new Map<string, number>()
  const subFirst = new Map<string, number>()
  rows.forEach((row, i) => {
    if (!firstSeen.has(row.group)) firstSeen.set(row.group, i)
    const sub = row.control?.subsection
    if (sub && !subFirst.has(`${row.group}\u0000${sub}`)) subFirst.set(`${row.group}\u0000${sub}`, i)
  })
  const rank = (group: string) => {
    const i = order.indexOf(group)
    return i >= 0 ? i : order.length + firstSeen.get(group)!
  }
  const subRank = (row: LabRow) => (row.control?.subsection ? 1 + subFirst.get(`${row.group}\u0000${row.control.subsection}`)! : 0)
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => rank(a.row.group) - rank(b.row.group) || subRank(a.row) - subRank(b.row) || a.index - b.index)
    .map(x => x.row)
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
  const pairs = new Map<string, string>()
  for (const row of rows) {
    const c = row.control
    if (c?.pair) pairs.set(c.key, c.pair.key)
    if (!c?.legacyKeys) continue
    for (const legacy of c.legacyKeys) aliases.set(legacy, c.key)
  }
  if (!aliases.size && !pairs.size) return rawJson
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
      // A pair saved as two numbers (before it drew as one range) becomes one [low, high] value.
      for (const [low, high] of pairs) {
        if (typeof values[low] !== "number") continue
        values[low] = [values[low], typeof values[high] === "number" ? values[high] : values[low]]
        delete values[high]
        itemChanged = true
        changed = true
      }
      return itemChanged ? { ...rec, values } : item
    })
    return changed ? JSON.stringify({ ...parsed, variants }) : rawJson
  } catch {
    return rawJson
  }
}
