import type { CurveInterp, CurvePoint, GradientSpace, GradientStop } from "./ramps"

export type LabValue = boolean | number | string
export type LabSettings = Record<string, LabValue>
export type LabControl = {
  key: string
  /** Property name on the bound subsystem `settings` object when `key` is prefixed (e.g. `key: "ai.walkSpeed"`, `field: "walkSpeed"`). */
  field?: string
  /** Legacy flat keys migrated to `key` when loading presets, URLs, or saved browser variants. */
  legacyKeys?: readonly string[]
  label: string
  group?: string
  unit?: string
  /** The control's group starts folded. */
  folded?: boolean
  /** Mirrors scene state (for example the selection's position) rather than an authored default. */
  derived?: boolean
  visible?: (settings: Readonly<LabSettings>) => boolean
  change?: (value: LabValue) => void
  enabled?: (settings: Readonly<LabSettings>) => boolean
  /** A collapsible sub-heading inside the group (knobs' `subsection`); sub-headings start folded. */
  subsection?: string
  /**
   * Draws this range and the range `pair.key` (its upper end) as one low–high row with two thumbs that can't cross.
   * Both keys stay separate settings; the pair is only how they show.
   */
  pair?: { key: string; label: string }
  /** True while the value differs across a multi-selection: the row reads "—" until edited, and the edit sets them all. */
  mixed?: (settings: Readonly<LabSettings>) => boolean
} & (
  | { type?: "range"; min: number; max: number; step?: number }
  | { type?: "select"; options: readonly { value: number | string; label: string }[] }
  | { type?: "toggle"; on?: number; off?: number }
  | { type: "action"; run: (button: HTMLButtonElement) => void | Promise<void> }
  /**
   * A live value the panel shows and nobody edits (knobs' readout rows): a number or text (`watch`), rows of cells or a
   * key-value record (`table`), or a bar over `scale` (`meter`). `read` is polled only while the row is on screen.
   */
  | { type: "readout"; read: () => LabReadoutValue; display?: "watch" | "table" | "meter"; columns?: readonly string[]; scale?: LabReadoutScale; hz?: number }
  /** A row of buttons (knobs' toolbar): commands that hold no value, such as presets, spawns or auditions. */
  | { type: "buttons"; items: readonly LabButton[] }
  /** A colour over 0…1. The setting holds the stops as JSON text (see `ramps.ts`). */
  | { type: "gradient"; space?: GradientSpace; presets?: Readonly<Record<string, readonly GradientStop[]>> }
  /** A number over 0…1, y in `range` ([0, 1] by default). The setting holds the points as JSON text (see `ramps.ts`). */
  | { type: "curve"; range?: readonly [number, number]; interp?: CurveInterp; presets?: Readonly<Record<string, readonly CurvePoint[]>> }
)
/** What a readout row shows: a number or text, table rows (cells by column) or a key-value record. */
export type LabReadoutValue = number | string | readonly (readonly (string | number)[])[] | Readonly<Record<string, string | number>>
/** A meter's range and where it turns the warning and critical colours. */
export type LabReadoutScale = { min: number; max: number; warn?: number; critical?: number }
/** One button of a `buttons` row; its key is unique across the panel. */
export type LabButton = { key: string; label: string; run: () => void | Promise<void>; enabled?: (settings: Readonly<LabSettings>) => boolean }
/** Rows that hold a setting: everything but actions, readouts and button rows. */
export type LabValueControl = Exclude<LabControl, { type: "action" | "readout" | "buttons" }>
export const holdsValue = (control: LabControl): control is LabValueControl =>
  control.type !== "action" && control.type !== "readout" && control.type !== "buttons"
/** Gradient and curve rows: edited in knobs' ramp editors, never stepped, cycled or randomized by the Lab itself. */
export const isRampControl = (control: LabControl): control is Extract<LabControl, { type: "gradient" | "curve" }> =>
  control.type === "gradient" || control.type === "curve"
/** On/off rows: what is left once actions, ranges, choices and ramps are set aside. */
export type LabSwitch = Exclude<LabControl, { type: "action" | "readout" | "buttons" | "gradient" | "curve" } | { min: number } | { options: readonly unknown[] }>
export const isSwitchControl = (control: LabControl): control is LabSwitch =>
  holdsValue(control) && !isRampControl(control) && !("min" in control) && !("options" in control)
export type LabRow = { group: string; control?: LabControl }
/**
 * A tab over a panel's groups (the Lab's Details inspector, a game's floating panel): the groups it shows, each by its
 * id or as `[id, label]` when the tab makes part of the name redundant ("Tree Structure" on the Trees tab reads
 * "Structure"). Ids stay the groups' identity. `match` takes groups by id that no tab lists (for groups added later);
 * the `rest` tab takes every group no tab lists or matches, which would otherwise show on every tab.
 */
export type LabTab = {
  label: string
  groups: readonly (string | readonly [group: string, label: string])[]
  match?: (group: string) => boolean
  rest?: boolean
}

/** Resolves the property name on a subsystem `settings` object for a `LabControl`. */
export function resolveControlField(control: LabControl, settings: Readonly<Record<string, unknown>>): string {
  if (control.field) return control.field
  if (control.key in settings) return control.key
  const dot = control.key.indexOf(".")
  if (dot > 0) {
    const leaf = control.key.slice(dot + 1)
    if (leaf in settings) return leaf
  }
  return control.key
}
const wrap = (index: number, length: number) => (index % length + length) % length

export function inferControlUnit(key: string, label: string, explicit?: string): string {
  if (explicit !== undefined) return explicit
  if (/\b(ms)\b/i.test(label) || /Ms$/.test(key)) return "ms"
  if (/\b(m\/s)\b/i.test(label) || /(speed|lift)/i.test(key) && !/rate|anim|slow/i.test(key)) return "m/s"
  if (/(life|duration|interval|fade|delay|time|persistence|retrigger)/i.test(key) && !/rate/i.test(key)) return "s"
  if (/(radius|size|width|length|height|distance|spacing|targetX|targetZ|ahead|puddle|depth)/i.test(key)) return "m"
  if (/(angle|azimuth|elevation|yaw|pitch)$/i.test(key)) return "°"
  if (/^rate$/i.test(key)) return "/s"
  return ""
}

export function formatLabValue(value: LabValue, step = 0.01, unit = ""): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return String(value)
  const decimals = step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3
  const rounded = Number(value.toFixed(Math.min(4, decimals + 1)))
  const text = Number.isInteger(rounded) ? String(rounded) : String(rounded)
  return unit ? `${text} ${unit}` : text
}

/** DOM-free navigation and edits, shared by pointer, keyboard and search. */
export class LabNavigation {
  readonly rows: LabRow[] = []
  readonly folded = new Set<string>()
  readonly defaults: LabSettings
  active: LabRow | undefined
  /** Optional view filter (Details' selection relevance; search and Modified are knobs'). Applies to keyboard navigation too. */
  filter: ((row: LabRow) => boolean) | undefined

  constructor(readonly settings: LabSettings, controls: LabControl[], private change?: (key: string, value: LabValue) => void) {
    this.defaults = { ...settings }
    this.append(controls)
  }

  append(controls: readonly LabControl[]): LabRow[] {
    const groups = new Map<string, LabControl[]>()
    for (const control of controls) {
      const group = control.group ?? "Controls"
      if (!groups.has(group)) groups.set(group, [])
      groups.get(group)!.push(control)
      if (control.folded) this.folded.add(group)
    }
    const created: LabRow[] = []
    for (const [group, items] of groups) {
      const existingHeader = this.rows.some(row => !row.control && row.group === group)
      const newRows: LabRow[] = [
        ...(existingHeader ? [] : [{ group }]),
        ...items.map(control => ({ group, control })),
      ]
      if (existingHeader) {
        let lastIdx = -1
        for (let i = 0; i < this.rows.length; i++) if (this.rows[i]!.group === group) lastIdx = i
        this.rows.splice(lastIdx + 1, 0, ...newRows)
      } else {
        this.rows.push(...newRows)
      }
      created.push(...newRows)
    }
    this.active ??= this.visibleRows[0] ?? this.rows[0]
    return created
  }

  isRowVisible(row: LabRow): boolean {
    if (row.control) {
      if (row.control.visible && !row.control.visible(this.settings)) return false
      return this.filter ? this.filter(row) : true
    }
    const groupControls = this.rows.filter(r => r.control && r.group === row.group)
    if (!groupControls.length) return !this.filter
    return groupControls.some(r => this.isRowVisible(r))
  }

  isModified(control: LabControl): boolean {
    if (!holdsValue(control) || control.derived || !(control.key in this.defaults)) return false
    const value = this.settings[control.key], initial = this.defaults[control.key]
    if (typeof value === "number" && typeof initial === "number") {
      const step = "min" in control ? control.step ?? 0.01 : 1e-6
      return Math.abs(value - initial) > step * 1e-3
    }
    return value !== initial
  }

  get visibleRows() {
    return this.rows.filter(row => {
      if (!this.isRowVisible(row)) return false
      return !row.control || !this.folded.has(row.group)
    })
  }
  move(direction: number, groups = false) {
    const rows = groups ? this.rows.filter(row => !row.control && this.isRowVisible(row)) : this.visibleRows
    if (!rows.length) return
    const index = groups ? rows.findIndex(row => row.group === this.active?.group) : rows.indexOf(this.active!)
    this.active = rows[wrap(index + direction, rows.length)]
  }
  fold(closed = !this.folded.has(this.active?.group ?? "")) {
    if (!this.active) return
    const group = this.active.group
    if (closed) this.folded.add(group)
    else this.folded.delete(group)
    this.active = this.rows.find(row => row.group === group && !row.control)
  }
  jump(row: LabRow) { this.folded.delete(row.group); this.active = row }
  set(control: LabControl, value: LabValue) {
    if (!holdsValue(control)) return
    this.settings[control.key] = value
    control.change?.(value)
    this.change?.(control.key, value)
  }
  adjust(direction: number, shift = false, alt = false) {
    const c = this.active?.control
    if (!c || !holdsValue(c) || isRampControl(c) || c.enabled?.(this.settings) === false) return
    if ("min" in c) {
      const delta = direction * (c.step ?? .01) * (shift ? 10 : 1) * (alt ? 0.1 : 1)
      this.set(c, Number(Math.max(c.min, Math.min(c.max, Number(this.settings[c.key]) + delta)).toPrecision(12)))
    } else if ("options" in c) {
      if (!c.options.length) return
      const index = c.options.findIndex(o => o.value === this.settings[c.key])
      this.set(c, c.options[wrap(index + direction, c.options.length)]!.value)
    } else this.set(c, this.settings[c.key] === (c.on ?? true) ? c.off ?? false : c.on ?? true)
  }
  exact(text: string) {
    const c = this.active?.control, value = Number(text)
    if (!c || !("min" in c) || c.enabled?.(this.settings) === false || !text.trim() || !Number.isFinite(value)) return false
    this.set(c, Math.max(c.min, Math.min(c.max, value)))
    return true
  }
  reset(group = false, targetGroup = this.active?.group) {
    for (const row of this.rows) if (row.control && (group ? row.group === targetGroup : row === this.active)) {
      if (row.control.key in this.defaults) this.set(row.control, this.defaults[row.control.key]!)
    }
  }
  randomize(group = this.active?.group) {
    for (const { control: c, group: name } of this.rows) {
      if (!c || name !== group || c.key === "effect" || c.key === "environment" || c.key === "room" || c.key === "keyLabels") continue
      if ("min" in c) {
        const step = c.step ?? .01
        const steps = Math.floor((c.max - c.min) / step + 1e-9)
        this.set(c, Number((c.min + Math.floor(Math.random() * (steps + 1)) * step).toPrecision(12)))
      } else if ("options" in c && c.options.length) this.set(c, c.options[Math.floor(Math.random() * c.options.length)]!.value)
    }
  }
  json(group = this.active?.group) {
    return JSON.stringify(Object.fromEntries(this.rows.filter(row => row.group === group && row.control).map(row => [row.control!.key, this.settings[row.control!.key]])), null, 2)
  }
  search(query: string) {
    const needle = query.toLowerCase().replace(/\s/g, "")
    return this.rows.flatMap(row => {
      if (!row.control || !this.isRowVisible(row)) return []
      const text = `${row.control.label} ${row.group} ${row.control.key}`.toLowerCase()
      let end = -1, score = 0
      for (const char of needle) {
        const at = text.indexOf(char, end + 1)
        if (at < 0) return []
        score += at - end - 1
        end = at
      }
      return [{ row, score }]
    }).sort((a, b) => a.score - b.score).map(result => result.row)
  }
}
