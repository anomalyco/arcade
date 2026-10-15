import { createRemoteControls, type ChangeMeta, type ControlDescriptor, type HostHistory, type PanelKeys, type RemoteControls, type StoragePort, type Value } from "@arcade/knobs"
import { mountPanel, type Panel } from "@arcade/knobs/panel"
import { labPreset, type TokenPreset } from "@arcade/knobs/themes"
import type { LabControl, LabNavigation, LabRow, LabSettings } from "./lab-navigation"
import { describe, fromKnobs, isSpawnTime, isTunable, migrateKnobsVariantJson, nextTuningSeed, orderRows, seededRandom, toKnobs } from "./lab-tuning"

/** The Details action button (`.lab-act` in `packages/kit/lab/style.css`), which knobs has no tokens for. */
const ACT = 'height:20px;min-height:20px;padding:0 6px;border:0;border-radius:0;background:#191a1e!important;box-shadow:inset 0 0 0 1px #23252a;color:#d8dbe0;font:400 11px/20px -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;letter-spacing:0;text-transform:none'
const ACT_HOVER = "background:#1e2024!important;box-shadow:inset 0 0 0 1px #2c2f35;color:#d8dbe0"
const BUTTONS = ":is(.knobs-action,.knobs-custom-actions button,.knobs-transfer button,.knobs-preset-chip)"

/**
 * knobs' `labPreset` (square, flat, the Lab's palette) with the Lab's 24 px rows and its UI font for values as well as
 * labels. The `css` is what knobs has no token for yet: the panel fills its column, 20 px fields and one text size in
 * 24 px rows, and buttons drawn like the Details actions.
 */
export const arcadePreset: TokenPreset = {
  ...labPreset,
  name: "arcade",
  dark: { ...labPreset.dark, row: "24px", "value-font": "var(--k-font)" },
  css: [
    `&{--k-width:100%;--k-control-h:20px;--k-action-h:20px;--k-text-control:var(--k-font-size)}`,
    `& ${BUTTONS}{${ACT}}`,
    `& ${BUTTONS}:is(:hover:not([disabled]),:focus-visible){${ACT_HOVER}}`,
    `& ${BUTTONS}:focus-visible{outline:1px solid #4d8dff;outline-offset:0}`,
    `& .knobs-preset-chip[aria-checked="true"]{background:color-mix(in srgb,#4d8dff 18%,#191a1e)!important;box-shadow:inset 0 0 0 1px color-mix(in srgb,#4d8dff 32%,transparent);font-weight:400}`,
    `& .knobs-action-row{display:flex;align-items:center;padding:0 var(--k-inset)}`,
    `& .knobs-action{width:auto;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`,
    `& .knobs-custom-actions{display:flex;flex-wrap:wrap;gap:4px;margin:6px var(--k-inset) 8px}`,
    `& .knobs-presets{background:transparent;padding:0 var(--k-inset);gap:4px}`,
    `& .knobs-presets-pill{display:none}`,
  ].join(""),
}

/** What a view needs from its LabPanel: the settings, one transaction per gesture, the tuning seed and history. */
export interface LabKnobsHost {
  readonly navigation: LabNavigation
  /** Starts (or joins) the authored transaction for a gesture. */
  begin(label: string): void
  /** Ends the current transaction and hands it to the host's undo. */
  end(): void
  /** A view changed settings: the host refreshes its other views. */
  edited(from: LabKnobsView): void
  /** The tuning seed Random and Mutate draw from; each roll records the seed it used and moves to the next. */
  readonly tuning: { seed: number; last: { seed: number; mode: "random" | "mutate"; keys: string[] } | null }
  /** The host's own undo (the Lab workbench). Without it knobs keeps its own history. */
  readonly history?: HostHistory
  /** Pins a row to the Lab's Watch list, when the host has one. */
  readonly pin?: { toggle(control: LabControl, group: string): void; has(key: string): boolean }
}

export type LabKnobsViewOptions = {
  /** The view's identity (knobs' store id). */
  id: string
  /** Where saved variants are kept in the browser (it becomes the store id); omit for no saved variants. */
  variantsId?: string
  title?: string | false
  /** Which rows this view shows, on top of each control's own `visible`. All of them by default. */
  include?: (row: LabRow) => boolean
  /** Group order; groups not listed follow in the order they were added. */
  order?: () => readonly string[]
  keys?: PanelKeys
  /** Panel-level buttons under the cards (for example All on / All off). */
  actions?: readonly { label: string; run: () => void }[]
}

type Row = LabRow & { control: LabControl }

/** Saved variants live in the browser (knobs keeps only those: `persist: "variants"`), with legacy keys renamed. */
function variantStorage(id: string | undefined, rows: () => readonly LabRow[]): StoragePort | null {
  if (!id) return null
  let local: Storage | null = null
  try { local = localStorage } catch { return null }
  return {
    getItem: key => {
      const raw = local!.getItem(key)
      return raw && key.endsWith(":variants:v1") ? migrateKnobsVariantJson(raw, rows()) : raw
    },
    setItem: (key, value) => local!.setItem(key, value),
  }
}

/**
 * A knobs panel over some of a LabNavigation's rows. Edits go back through `LabNavigation.set` (so pointer, keys,
 * reset and Random share one write path and one transaction per gesture); outside changes reach knobs only when a
 * value, a row's visibility or its enabled state changed, so an idle view costs nothing per frame.
 */
export class LabKnobsView {
  readonly element = document.createElement("div")
  private store: RemoteControls
  private panel: Panel
  private rows = new Map<string, Row>()
  private shown: Record<string, Value> = {}
  private shape = ""
  private mixed = ""
  private held = new Set<string>()
  private idle = 0
  private pins = new Map<string, HTMLButtonElement>()
  /** The roll in progress: its generator, the seed it draws from and the keys it changed. */
  private roll: { draw: () => number; seed: number; mode: "random" | "mutate"; keys: string[] } | null = null
  private disposed = false

  constructor(private host: LabKnobsHost, container: HTMLElement, private options: LabKnobsViewOptions) {
    this.element.className = "lab-knobs"
    container.append(this.element)
    const remote = createRemoteControls(`lab:${options.variantsId ?? options.id}`, [], {
      enabled: true,
      // The settings object is local: there are no late echoes to hold back, so outside changes (undo) land at once.
      echo: 0,
      nullDefaults: false,
      storage: variantStorage(options.variantsId, () => host.navigation.rows),
      persist: "variants",
      // Random and Mutate draw from the Lab's recorded tuning seed and leave switches, seeds and pickers alone.
      random: () => this.draw(),
      tunable: key => { const row = this.rows.get(key); return Boolean(row && isTunable(row.control, host.navigation.settings)) },
      ...(host.history ? { history: host.history } : {}),
      theme: "dark",
      density: "compact",
      onSet: (key, value, meta) => this.onSet(key, value, meta),
      onReset: target => this.onReset(target),
      onAction: key => void this.onAction(key),
    })
    // Two things knobs can't hand over yet: a drag's start and end (one undo entry per gesture), and a group's die
    // when the group has its own seeded "Randomize <group>" action (it may reseed its effect on purpose).
    const self = this
    const own = {
      randomize(keys?: readonly string[]) {
        const custom = self.groupRandomize(keys)
        if (custom) void self.onAction(custom)
        else remote.randomize(keys)
      },
      hold(key: string, on = true) {
        remote.hold(key, on)
        if (on) self.held.add(key)
        else if (self.held.delete(key) && !self.held.size) self.settle()
      },
    }
    this.store = Object.freeze(Object.defineProperties({}, { ...Object.getOwnPropertyDescriptors(remote), ...Object.getOwnPropertyDescriptors(own) })) as RemoteControls
    this.refreshShape(true)
    this.panel = mountPanel(this.store, this.element, {
      title: options.title ?? false,
      preset: arcadePreset,
      theme: "dark",
      density: "compact",
      renderer: "dom",
      variants: Boolean(options.variantsId),
      // The Lab's canvas keeps focus when a section's panel is rebuilt.
      session: false,
      haptics: false,
      keys: { leave: "Escape", ...options.keys },
      copy: () => this.copyText(),
      rowAccessory: key => this.accessory(key),
      actions: options.actions?.map(a => ({ label: a.label, run: () => { this.host.begin(a.label); a.run(); this.host.end(); this.host.edited(this) } })),
    })
  }

  /** Pushes outside changes to knobs: a new shape when rows came, went or changed state, else changed values. */
  sync(land = false) {
    if (this.disposed) return
    if (this.refreshShape(land)) return
    const nav = this.host.navigation
    let patch: Record<string, Value> | null = null
    for (const [key, row] of this.rows) {
      if (row.control.type === "action") continue
      const value = toKnobs(row.control, nav.settings[key])
      if (value === undefined || value === this.shown[key]) continue
      ;(patch ??= {})[key] = value
      this.shown[key] = value
    }
    const mixed = this.mixedKeys()
    const remixed = mixed.join() !== this.mixed
    this.mixed = mixed.join()
    if (patch || remixed) this.store.sync(patch ?? {}, remixed ? { mixed } : undefined)
    this.refreshPins()
  }

  /** The row element for a setting, if this view shows it. */
  rowElement(key: string): HTMLElement | null {
    return this.panel.element.querySelector<HTMLElement>(`.knobs-row[data-field="${CSS.escape(key)}"]`)
  }

  /** Focuses a setting's control (or the first row) inside the panel. */
  focus(key?: string) {
    const row = key ? this.rowElement(key) : null
    const target = row?.querySelector<HTMLElement>('[role="slider"],button,[tabindex="0"]') ?? row
    if (target) target.focus({ preventScroll: true })
    else this.panel.focus()
  }

  /** Opens a folded group, so a revealed row can be seen. */
  unfold(group: string) {
    this.panel.fold(group, false)
  }

  /** Whether a knobs gesture (a drag, a key held on a slider, an inline number edit) is in progress. */
  get interacting() {
    const active = document.activeElement
    return this.held.size > 0 || this.idle !== 0 || (active instanceof HTMLInputElement && this.element.contains(active))
  }

  get keys(): string[] { return [...this.rows.keys()] }

  /** Whether this view shows a row when it is visible (its own filter, not the control's `visible`). */
  includes(row: LabRow): boolean {
    return !this.options.include || this.options.include(row)
  }

  dispose() {
    if (this.disposed) return
    this.settle()
    this.disposed = true
    this.panel.dispose()
    this.element.remove()
  }

  private visibleRows(): Row[] {
    const nav = this.host.navigation
    const include = this.options.include
    const rows = nav.rows.filter((row): row is Row => Boolean(row.control) && (!row.control!.visible || row.control!.visible(nav.settings)) && (!include || include(row)))
    return orderRows(rows, this.options.order?.() ?? [])
  }

  /** Keys whose values differ across a multi-selection (they read "—" until edited). */
  private mixedKeys(): string[] {
    const settings = this.host.navigation.settings
    return [...this.rows.values()].filter(r => r.control.mixed?.(settings)).map(r => r.control.key)
  }

  /** Rebuilds the descriptors when the row set changed; returns true if it did (values were placed too). */
  private refreshShape(land: boolean): boolean {
    const nav = this.host.navigation
    const rows = this.visibleRows()
    const descriptors: ControlDescriptor[] = []
    const kept = new Map<string, Row>()
    for (const row of rows) {
      const d = describe(row, nav.defaults, nav.settings)
      if (!d || kept.has(d.key)) continue
      descriptors.push(d)
      kept.set(d.key, row)
    }
    const shape = JSON.stringify(descriptors)
    if (shape === this.shape) return false
    this.shape = shape
    this.rows = kept
    this.shown = {}
    for (const [key, row] of kept) {
      const value = toKnobs(row.control, nav.settings[key])
      if (value !== undefined) this.shown[key] = value
    }
    const mixed = this.mixedKeys()
    this.mixed = mixed.join()
    this.store.update(descriptors, this.shown, { land, mixed })
    if (this.panel) this.refreshPins()
    return true
  }

  /** The draw for the roll in progress; the first draw of a roll starts it from the current tuning seed. */
  private draw(): number {
    if (!this.roll) {
      const seed = this.host.tuning.seed
      this.roll = { draw: seededRandom(seed), seed, mode: "random", keys: [] }
      // knobs rolls synchronously: once it has, record the seed the roll used and move to the next.
      queueMicrotask(() => {
        const roll = this.roll
        this.roll = null
        if (!roll?.keys.length) return
        this.host.tuning.last = { seed: roll.seed, mode: roll.mode, keys: roll.keys }
        this.host.tuning.seed = nextTuningSeed(roll.seed)
      })
    }
    return this.roll.draw()
  }

  /** A group die's keys, when the group has its own "Randomize <group>" action: that action's key. */
  private groupRandomize(keys?: readonly string[]): string | undefined {
    if (!keys?.length) return undefined
    const groups = new Set(keys.map(k => this.rows.get(k)?.group))
    if (groups.size !== 1) return undefined
    const [group] = groups
    return [...this.rows.values()].find(r => r.group === group && r.control.type === "action" && r.control.label === `Randomize ${group}`)?.control.key
  }

  private onSet(key: string, value: Value | null, meta: ChangeMeta) {
    const row = this.rows.get(key)
    if (!row || value === null) return
    const next = fromKnobs(row.control, value)
    if (next === undefined) return
    this.shown[key] = value
    if ((meta.source === "randomize" || meta.source === "mutate") && this.roll) {
      this.roll.mode = meta.source === "mutate" ? "mutate" : "random"
      this.roll.keys.push(key)
    }
    if (meta.source !== "compare") this.host.begin(this.labelFor(row, meta))
    this.host.navigation.set(row.control, next)
    this.host.edited(this)
    if (meta.source === "compare") return
    // A drag ends on release; keys and discrete changes settle once they stop arriving.
    if (!this.held.size) this.schedule(meta.source === "local" && "min" in row.control ? 350 : 0)
  }

  /** knobs skips disabled rows and then reports the rest key by key: they join one transaction. */
  private onReset(target: { key?: string; group?: string }) {
    const nav = this.host.navigation
    const rows = [...this.rows.values()].filter(r => r.control.type !== "action" && (target.key ? r.control.key === target.key : target.group ? r.group === target.group : true))
    if (!rows.length) return
    this.host.begin(`Reset ${target.key ? rows[0]!.control.label : target.group ?? "all"}`)
    for (const r of rows) {
      if (!(r.control.key in nav.defaults)) continue
      nav.set(r.control, nav.defaults[r.control.key]!)
      const v = toKnobs(r.control, nav.defaults[r.control.key])
      if (v !== undefined) this.shown[r.control.key] = v
    }
    this.host.edited(this)
    this.schedule(0)
  }

  private async onAction(key: string) {
    const c = this.rows.get(key)?.control
    if (!c || c.type !== "action") return
    const button = this.rowElement(key)?.querySelector<HTMLButtonElement>("button") ?? document.createElement("button")
    this.host.begin(c.label)
    button.disabled = true
    try { await c.run(button) }
    catch (error) { console.error(error); button.textContent = "Failed" }
    finally {
      button.disabled = false
      this.host.end()
      this.host.edited(this)
    }
  }

  private labelFor(row: Row, meta: ChangeMeta) {
    if (meta.source === "randomize" || meta.source === "mutate") return `${meta.source === "randomize" ? "Randomize" : "Mutate"} ${meta.group ?? "all"}`
    if (meta.source === "undo" || meta.source === "redo") return meta.source === "undo" ? "Undo" : "Redo"
    if (meta.source === "preset" || meta.source === "variant") return "Preset"
    return row.control.label
  }

  private schedule(ms: number) {
    clearTimeout(this.idle)
    this.idle = window.setTimeout(() => this.settle(), ms)
  }

  private settle() {
    clearTimeout(this.idle)
    this.idle = 0
    this.host.end()
  }

  /** The visible settings as JSON; a Random since the defaults adds the tuning seed that reproduces it. */
  private copyText() {
    const nav = this.host.navigation
    const out: Record<string, unknown> = {}
    for (const [key, row] of this.rows) if (row.control.type !== "action") out[key] = nav.settings[key]
    const last = this.host.tuning.last
    if (last && last.keys.some(k => k in out) && !("tuningSeed" in out)) out.tuningSeed = last.seed
    return JSON.stringify(out, null, 2)
  }

  /** A row's accessory (knobs' slot after the label): the spawn-time marker and the Watch pin. */
  private accessory(key: string): Node | null {
    const row = this.rows.get(key)
    if (!row) return null
    const spawn = isSpawnTime(row.control)
    const pin = this.host.pin && row.control.type !== "action" ? this.host.pin : null
    if (!spawn && !pin) return null
    const box = document.createElement("span")
    box.className = "lab-knobs-accessory"
    if (spawn) {
      const dot = document.createElement("span")
      dot.className = "lab-knobs-spawn"
      dot.title = `${row.control.label}: a spawn-time value. Retrigger (Space) to see the change.`
      box.append(dot)
    }
    if (pin) {
      const button = document.createElement("button")
      button.type = "button"
      button.className = "lab-knobs-pin"
      button.tabIndex = -1
      button.title = "Pin to Watch"
      button.setAttribute("aria-label", `Pin ${row.control.label} to Watch`)
      button.setAttribute("aria-pressed", String(pin.has(key)))
      button.addEventListener("click", () => {
        const current = this.rows.get(key)
        if (current) pin.toggle(current.control, current.group)
        this.refreshPins()
      })
      this.pins.set(key, button)
      box.append(button)
    }
    return box
  }

  /** Pins follow the Watch list, which also changes from outside (its own ×). */
  private refreshPins() {
    const pin = this.host.pin
    if (!pin) return
    for (const [key, button] of this.pins) {
      if (!button.isConnected) { this.pins.delete(key); continue }
      const pressed = String(pin.has(key))
      if (button.getAttribute("aria-pressed") !== pressed) button.setAttribute("aria-pressed", pressed)
    }
  }
}

let styled = false
/** Styles for what the adapter adds to knobs rows. */
export function ensureLabKnobsStyles() {
  if (styled) return
  styled = true
  const style = document.createElement("style")
  style.dataset.labKnobs = ""
  style.textContent = `
.lab-knobs{min-width:0}
.lab-knobs .knobs-panel.knobs-inline{width:100%}
.lab-knobs-accessory{display:inline-flex;align-items:center;gap:4px}
.lab-knobs-spawn{display:inline-block;width:5px;height:5px;border-radius:50%;background:#d9a03c}
.lab-knobs-pin{width:12px;height:16px;padding:0;border:0;background:none;color:#5b6068;cursor:pointer;opacity:0;font:10px/16px system-ui}
.lab-knobs-pin::before{content:"•"}
.knobs-row:hover .lab-knobs-pin,.lab-knobs-pin[aria-pressed="true"]{opacity:1}
.lab-knobs-pin[aria-pressed="true"]{color:#4d8dff}
.lab-knobs-pin:hover{color:#d8dbe0}
[data-lab-flash]{animation:lab-knobs-flash 1.3s ease-out}
@keyframes lab-knobs-flash{0%,35%{background:color-mix(in srgb,#4d8dff 38%,transparent)}100%{background:transparent}}
`
  document.head.append(style)
}
