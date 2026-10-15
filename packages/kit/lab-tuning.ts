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

/** One row as a knobs descriptor, or null when knobs can't draw it (a select with no options). */
export function describe(row: LabRow & { control: LabControl }, defaults: Readonly<LabSettings>, settings: Readonly<LabSettings>): ControlDescriptor | null {
  const c = row.control
  const base = { key: c.key, label: c.label, group: row.group }
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

/** Rows in display order: groups ranked by `order`, then in the order they were added; folded (advanced) groups last. */
export function orderRows<R extends LabRow>(rows: readonly R[], order: readonly string[], folded: ReadonlySet<string>): R[] {
  const firstSeen = new Map<string, number>()
  rows.forEach((row, i) => { if (!firstSeen.has(row.group)) firstSeen.set(row.group, i) })
  const rank = (group: string) => {
    const i = order.indexOf(group)
    return i >= 0 ? i : order.length + (folded.has(group) ? rows.length : 0) + firstSeen.get(group)!
  }
  return rows.map((row, index) => ({ row, index })).sort((a, b) => rank(a.row.group) - rank(b.row.group) || a.index - b.index).map(x => x.row)
}

/** A small, fast seeded generator (mulberry32). The same seed always gives the same sequence. */
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

const onLattice = (min: number, step: number, n: number) => Number((min + n * step).toPrecision(12))

/** Whether Random and Mutate may change this control: tuning values only, not switches, pickers, seeds or gated rows. */
export function isTunable(control: LabControl, settings: Readonly<LabSettings>): boolean {
  if (control.type === "action" || control.derived || isStructuralKey(control.key)) return false
  if (control.enabled?.(settings) === false) return false
  return "min" in control || ("options" in control && control.options.length > 1)
}

/**
 * Random or Mutate for `controls`, drawn from `seed` in the order given. Ranges land on their step lattice; Mutate moves
 * a range 8-12% of its span and changes a choice 15% of the time. Switches stay as they are, as they always have in the
 * Lab: they gate features rather than tune them.
 */
export function seededPatch(controls: readonly LabControl[], settings: Readonly<LabSettings>, seed: number, mode: "random" | "mutate"): LabSettings {
  const random = seededRandom(seed)
  const patch: LabSettings = {}
  for (const c of controls) {
    if (!isTunable(c, settings)) continue
    if ("min" in c) {
      const { min, max, step } = rangeOf(c)
      const top = Math.floor((max - min) / step + 1e-9)
      if (mode === "random") patch[c.key] = onLattice(min, step, Math.min(top, Math.floor(random() * (top + 1))))
      else {
        const v = Number(settings[c.key])
        const current = Number.isFinite(v) ? v : min
        const sign = random() < 0.5 ? -1 : 1
        const by = (max - min) * (0.08 + 0.04 * random())
        let next = current + sign * by
        if (next > max || next < min) next = current - sign * by
        let n = Math.max(0, Math.min(top, Math.round((next - min) / step)))
        if (onLattice(min, step, n) === current) {
          const dir = (sign > 0 && n < top) || n === 0 ? 1 : -1
          n = Math.max(0, Math.min(top, n + dir))
        }
        patch[c.key] = onLattice(min, step, n)
      }
    } else if ("options" in c) {
      const options = c.options
      if (mode === "random") patch[c.key] = options[Math.floor(random() * options.length)]!.value
      else if (random() < 0.15) {
        const at = options.findIndex(o => o.value === settings[c.key])
        const others = options.filter((_, i) => i !== at)
        patch[c.key] = others[Math.floor(random() * others.length)]!.value
      }
    }
  }
  return patch
}

/** The next tuning seed after `seed`: a deterministic walk (1 to 999999), so a recorded seed reproduces every later roll. */
export const nextTuningSeed = (seed: number) => Math.floor(seededRandom(seed ^ 0x5bd1e995)() * 999999) + 1
