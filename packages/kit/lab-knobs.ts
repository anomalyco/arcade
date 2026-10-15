import { createRemoteControls, type ChangeMeta, type ControlDescriptor, type PanelKeys, type RemoteControls, type StoragePort, type TokenPreset, type Value } from "@arcade/knobs"
import { mountPanel, type Panel } from "@arcade/knobs/panel"
import type { LabControl, LabNavigation, LabRow, LabSettings } from "./lab-navigation"
import { describe, fromKnobs, isSpawnTime, isTunable, nextTuningSeed, orderRows, seededPatch, toKnobs } from "./lab-tuning"

/** The Lab's dark chrome as knobs tokens: dense rows, the Lab's greys and its one blue accent. */
export const arcadePreset: TokenPreset = {
  name: "arcade",
  dark: {
    bg: "#141518",
    surface: "rgba(216,219,224,.045)",
    "surface-hi": "rgba(216,219,224,.09)",
    line: "#23252a",
    "line-hi": "#2c2f35",
    text: "#d8dbe0",
    label: "#8b9098",
    dim: "#5b6068",
    accent: "#4d8dff",
    modified: "#4d8dff",
    page: "#0c0d0f",
    font: '-apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif',
    mono: 'ui-monospace,"SF Mono",Menlo,monospace',
    "font-size": "11.5px",
    row: "26px",
    pad: "8px",
    inset: "8px",
    gap: "3px",
    radius: "6px",
    "panel-radius": "8px",
    glass: 0,
    glow: 0.25,
    "readout-mark": 1,
    "value-font": "var(--k-mono)",
  },
  css: `&{--k-width:100%}&[data-lab-floating]{--k-width:300px}`,
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
  readonly history?: { undo(): void; redo(): void }
  /** Pins a row to the Lab's Watch list, when the host has one. */
  readonly pin?: { toggle(control: LabControl, group: string): void; has(key: string): boolean }
}

export type LabKnobsViewOptions = {
  /** Identity for knobs' saved variants (browser storage); omit for no saved variants. */
  id: string
  variantsId?: string
  title?: string | false
  /** Which rows this view shows, on top of each control's own `visible`. All of them by default. */
  include?: (row: LabRow) => boolean
  /** Group order; groups not listed follow in the order they were added. */
  order?: () => readonly string[]
  keys?: PanelKeys
  floating?: boolean
  /** Panel-level buttons under the cards (for example All on / All off). */
  actions?: readonly { label: string; run: () => void }[]
}

type Row = LabRow & { control: LabControl }

/** Saved variants persist in the browser; the values themselves never do (the settings object owns them). */
function variantStorage(id: string | undefined): StoragePort | null {
  if (!id) return null
  let local: Storage | null = null
  try { local = localStorage } catch { return null }
  const own = (key: string) => key.endsWith(":variants:v1")
  return {
    getItem: key => (own(key) ? local!.getItem(key) : null),
    setItem: (key, value) => { if (own(key)) local!.setItem(key, value) },
  }
}

/**
 * A knobs panel over some of a LabNavigation's rows. Edits go back through `LabNavigation.set` (so pointer, keys,
 * reset and Random share one write path and one transaction per gesture); outside changes reach knobs only when a
 * value or a row's visibility changed, so an idle view costs nothing per frame.
 */
export class LabKnobsView {
  readonly element = document.createElement("div")
  private store: RemoteControls
  private panel: Panel
  private rows = new Map<string, Row>()
  private shown: Record<string, Value> = {}
  private shape = ""
  private descriptors: ControlDescriptor[] = []
  private held = new Set<string>()
  private idle = 0
  private label = ""
  private disposed = false

  constructor(private host: LabKnobsHost, container: HTMLElement, private options: LabKnobsViewOptions) {
    this.element.className = "lab-knobs"
    container.append(this.element)
    const self = this
    const remote = createRemoteControls(`lab:${options.id}`, [], {
      enabled: true,
      nullDefaults: false,
      storage: variantStorage(options.variantsId),
      theme: "dark",
      density: "compact",
      onSet: (key, value, meta) => this.onSet(key, value, meta),
      onReset: target => this.onReset(target),
      onAction: key => void this.onAction(key),
    })
    // Random and Mutate draw from the Lab's recorded tuning seed instead of Math.random, skip switches, seeds and
    // structural pickers, and hand the host's undo the whole roll. Holds mark a drag's start and end.
    const own = {
      randomize(keys?: readonly string[]) { self.roll("random", keys) },
      mutate(keys?: readonly string[]) { self.roll("mutate", keys) },
      hold(key: string, on = true) {
        remote.hold(key, on)
        if (on) self.held.add(key)
        else if (self.held.delete(key) && !self.held.size) self.settle()
      },
      ...(host.history ? { undo: () => host.history!.undo(), redo: () => host.history!.redo() } : {}),
      code: () => self.copyText(),
    }
    this.store = Object.freeze(Object.defineProperties({}, { ...Object.getOwnPropertyDescriptors(remote), ...Object.getOwnPropertyDescriptors(own) })) as RemoteControls
    this.refreshShape(true)
    // knobs brings back the last focused row after a reload; the Lab's canvas keeps focus instead.
    try { sessionStorage.removeItem(`knobs:${encodeURIComponent(`lab:${options.id}`)}:session:v1`) } catch { /* no session storage */ }
    this.panel = mountPanel(this.store, this.element, {
      title: options.title ?? false,
      preset: arcadePreset,
      theme: "dark",
      density: "compact",
      renderer: "dom",
      variants: Boolean(options.variantsId),
      history: !host.history,
      haptics: false,
      keys: { leave: "Escape", ...options.keys },
      copy: () => this.copyText(),
      actions: options.actions?.map(a => ({ label: a.label, run: () => { this.host.begin(a.label); a.run(); this.host.end(); this.host.edited(this) } })),
    })
    if (options.floating) this.panel.element.dataset.labFloating = ""
    this.decorate()
  }

  /** Pushes outside changes to knobs: a new shape when rows came, went or changed visibility, else changed values. */
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
    if (patch) this.store.sync(patch)
    this.decorate()
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

  /** Whether a knobs gesture (a drag, a key held on a slider, an inline number edit) is in progress. */
  get interacting() {
    const active = document.activeElement
    return this.held.size > 0 || this.idle !== 0 || (active instanceof HTMLInputElement && this.element.contains(active))
  }

  get keys(): string[] { return [...this.rows.keys()] }

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
    return orderRows(rows, this.options.order?.() ?? [], nav.folded)
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
    this.descriptors = descriptors
    this.rows = kept
    this.shown = {}
    for (const [key, row] of kept) {
      const value = toKnobs(row.control, nav.settings[key])
      if (value !== undefined) this.shown[key] = value
    }
    this.store.update(descriptors, this.shown, { land })
    if (this.panel) this.decorate()
    return true
  }

  private onSet(key: string, value: Value | null, meta: ChangeMeta) {
    const row = this.rows.get(key)
    const nav = this.host.navigation
    if (!row || value === null) return
    const next = fromKnobs(row.control, value)
    if (next === undefined) return
    if (row.control.enabled?.(nav.settings) === false) {
      // A dependency-gated row: put knobs back on the real value.
      queueMicrotask(() => { this.shown[key] = value; this.sync() })
      return
    }
    this.shown[key] = value
    if (meta.source !== "compare") this.host.begin(this.labelFor(row, meta))
    nav.set(row.control, next)
    this.host.edited(this)
    if (meta.source === "compare") return
    // A drag ends on release; keys and discrete changes settle once they stop arriving.
    if (!this.held.size) this.schedule(meta.source === "local" && "min" in row.control ? 350 : 0)
  }

  private onReset(target: { key?: string; group?: string }) {
    const nav = this.host.navigation
    const rows = [...this.rows.values()].filter(r => r.control.type !== "action" && (target.key ? r.control.key === target.key : target.group ? r.group === target.group : true))
    if (!rows.length) return
    const name = target.key ? rows[0]!.control.label : target.group ?? "all"
    this.host.begin(`Reset ${name}`)
    for (const r of rows) {
      if (!(r.control.key in nav.defaults)) continue
      nav.set(r.control, nav.defaults[r.control.key]!)
      const v = toKnobs(r.control, nav.defaults[r.control.key])
      if (v !== undefined) this.shown[r.control.key] = v
    }
    this.host.end()
    this.host.edited(this)
  }

  private async onAction(key: string) {
    const row = this.rows.get(key)
    const c = row?.control
    if (!c || c.type !== "action" || c.enabled?.(this.host.navigation.settings) === false) return
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

  private roll(mode: "random" | "mutate", keys?: readonly string[]) {
    const nav = this.host.navigation
    const pool = (keys ?? [...this.rows.keys()]).filter(k => !this.store.isLocked(k))
    const rows = pool.map(k => this.rows.get(k)).filter((r): r is Row => Boolean(r))
    const groups = [...new Set(rows.map(r => r.group))]
    // A group with its own seeded "Randomize <group>" action keeps using it (it may reseed its effect on purpose).
    if (mode === "random" && groups.length === 1) {
      const custom = nav.rows.find(r => r.group === groups[0] && r.control?.type === "action" && r.control.label === `Randomize ${groups[0]}`)
      if (custom && this.rows.has(custom.control!.key)) return void this.onAction(custom.control!.key)
    }
    const controls = rows.map(r => r.control).filter(c => isTunable(c, nav.settings))
    if (!controls.length) return
    const tuning = this.host.tuning
    const seed = tuning.seed
    const patch = seededPatch(controls, nav.settings, seed, mode)
    tuning.last = { seed, mode, keys: controls.map(c => c.key) }
    tuning.seed = nextTuningSeed(seed)
    const knobsPatch: Record<string, Value> = {}
    for (const c of controls) if (c.key in patch) {
      const v = toKnobs(c, patch[c.key])
      if (v !== undefined) knobsPatch[c.key] = v
    }
    this.label = `${mode === "random" ? "Randomize" : "Mutate"} ${groups.length === 1 ? groups[0] : "all"}`
    this.store.set(knobsPatch, { source: mode === "random" ? "randomize" : "mutate" })
    this.label = ""
  }

  private labelFor(row: Row, meta: ChangeMeta) {
    if (this.label) return this.label
    if (meta.source === "undo" || meta.source === "redo") return meta.source === "undo" ? "Undo" : "Redo"
    if (meta.source === "preset" || meta.source === "variant") return "Preset"
    return row.control.label
  }

  private schedule(ms: number) {
    clearTimeout(this.idle)
    this.idle = window.setTimeout(() => this.settle(), ms) || -1
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

  /** What knobs has no field for: disabled rows, spawn-time markers and Watch pins, on knobs' own row elements. */
  private decorate() {
    const nav = this.host.navigation
    for (const [key, row] of this.rows) {
      const el = this.rowElement(key)
      if (!el) continue
      const off = row.control.enabled?.(nav.settings) === false
      if (el.hasAttribute("data-lab-disabled") !== off) el.toggleAttribute("data-lab-disabled", off)
      if (isSpawnTime(row.control) && !el.hasAttribute("data-lab-spawn")) {
        el.setAttribute("data-lab-spawn", "")
        el.title = `${row.control.label}: a spawn-time value. Retrigger (Space) to see the change.`
      }
      const pin = this.host.pin
      if (pin && row.control.type !== "action") {
        let button = el.querySelector<HTMLButtonElement>(":scope > .lab-knobs-pin")
        if (!button) {
          button = document.createElement("button")
          button.type = "button"
          button.className = "lab-knobs-pin"
          button.tabIndex = -1
          button.title = "Pin to Watch"
          button.setAttribute("aria-label", `Pin ${row.control.label} to Watch`)
          button.addEventListener("pointerdown", event => event.stopPropagation())
          button.addEventListener("click", event => {
            event.stopPropagation()
            pin.toggle(row.control, row.group)
            this.decorate()
          })
          el.append(button)
        }
        const pressed = String(pin.has(key))
        if (button.getAttribute("aria-pressed") !== pressed) button.setAttribute("aria-pressed", pressed)
      }
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
  // Games style bare elements (Blackout: \`button { border; padding; letter-spacing }\`), and knobs' own base rules have
  // no specificity. The doubled :is() is (0,0,2): above a game's element rules, below every knobs class rule.
  style.textContent = `
:where(.lab-knobs,[data-lab-panel]) .knobs-panel{letter-spacing:normal;text-transform:none;text-shadow:none}
:where(.lab-knobs,[data-lab-panel]) :is(button,input,select,textarea):is(button,input,select,textarea){font:inherit;color:inherit;letter-spacing:inherit;text-transform:none;background:var(--k-surface);border:0;border-radius:var(--k-radius);padding:revert;margin:revert;min-width:0;min-height:revert;box-shadow:none;outline:revert;user-select:revert}
.lab-knobs{min-width:0}
.lab-knobs .knobs-panel.knobs-inline{width:100%}
.knobs-row[data-lab-disabled]{opacity:.38;pointer-events:none}
.knobs-row[data-lab-spawn]>span:first-child::after,.knobs-row[data-lab-spawn] .knobs-label::after{content:"";display:inline-block;width:5px;height:5px;margin-left:5px;border-radius:50%;background:#d9a03c;vertical-align:middle}
.knobs-row{position:relative}
.lab-knobs-pin{position:absolute;left:-2px;top:50%;width:12px;height:16px;margin-top:-8px;padding:0;border:0;border-radius:3px;background:none;color:#5b6068;cursor:pointer;opacity:0;font:10px/16px system-ui;z-index:2}
.lab-knobs-pin::before{content:"•"}
.knobs-row:hover>.lab-knobs-pin,.lab-knobs-pin[aria-pressed="true"]{opacity:1}
.lab-knobs-pin[aria-pressed="true"]{color:#4d8dff}
.lab-knobs-pin:hover{color:#d8dbe0}
[data-lab-flash]{animation:lab-knobs-flash 1.3s ease-out}
@keyframes lab-knobs-flash{0%,35%{background:color-mix(in srgb,#4d8dff 38%,transparent)}100%{background:transparent}}
`
  document.head.append(style)
}
