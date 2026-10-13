export type LabValue = boolean | number | string
export type LabSettings = Record<string, LabValue>
export type LabControl = { key: string; label: string; group?: string; change?: (value: LabValue) => void; enabled?: (settings: Readonly<LabSettings>) => boolean } & (
  { type?: "range"; min: number; max: number; step?: number } | { type?: "select"; options: readonly { value: number | string; label: string }[] } | { type?: "toggle"; on?: number; off?: number } | { type: "action"; run: (button: HTMLButtonElement) => void | Promise<void> }
)
export type LabRow = { group: string; control?: LabControl }
const wrap = (index: number, length: number) => (index % length + length) % length

/** DOM-free navigation and edits, shared by pointer, keyboard and search. */
export class LabNavigation {
  readonly rows: LabRow[] = []
  readonly folded = new Set<string>()
  readonly defaults: LabSettings
  active: LabRow | undefined

  constructor(readonly settings: LabSettings, controls: LabControl[], private change?: (key: string, value: LabValue) => void) {
    this.defaults = { ...settings }
    const groups = new Map<string, LabControl[]>()
    for (const control of controls) {
      const group = control.group ?? "Controls"
      if (!groups.has(group)) groups.set(group, [])
      groups.get(group)!.push(control)
    }
    for (const [group, controls] of groups) this.rows.push({ group }, ...controls.map(control => ({ group, control })))
    this.active = this.rows[0]
  }

  get visibleRows() { return this.rows.filter(row => !row.control || !this.folded.has(row.group)) }
  move(direction: number, groups = false) {
    const rows = groups ? this.rows.filter(row => !row.control) : this.visibleRows
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
    if (control.type === "action") return
    this.settings[control.key] = value
    control.change?.(value)
    this.change?.(control.key, value)
  }
  adjust(direction: number, shift = false, alt = false) {
    const c = this.active?.control
    if (!c || c.type === "action" || c.enabled?.(this.settings) === false) return
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
  reset(group = false) {
    for (const row of this.rows) if (row.control && (group ? row.group === this.active?.group : row === this.active)) {
      this.set(row.control, this.defaults[row.control.key]!)
    }
  }
  randomize(group = this.active?.group) {
    for (const { control: c, group: name } of this.rows) {
      if (!c || name !== group) continue
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
      if (!row.control) return []
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
