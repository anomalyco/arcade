import { createRemoteControls, type ChangeMeta, type ControlDescriptor, type HostHistory, type PanelKeys, type RemoteControls, type StoragePort, type Value } from "@arcade/knobs"
import { mountPanel, type Panel } from "@arcade/knobs/panel"
import { commandsFrom, type Command, type CommandsFromOptions } from "@arcade/knobs/ui"
import { isRampControl, type LabControl, type LabNavigation, type LabRow, type LabSettings, type LabTab, type LabValue } from "./lab-navigation"
import { describe, fromKnobs, isSpawnTime, isTunable, migrateKnobsVariantJson, nextTuningSeed, orderRows, seededRandom, toKnobs } from "./lab-tuning"

/**
 * How the Lab's knobs pieces look: knobs' own default theme and chrome, in its dark mode to sit with the Lab's dark
 * viewport. No preset and no overrides; anything that looks wrong goes to knobs rather than into Arcade CSS.
 */
export const LAB_LOOK = { theme: "dark" } as const

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
  /** A search field under the header, with a Modified chip (`/` focuses it while focus is in the panel). */
  search?: boolean
  /** Tabs over the groups (the Details inspector); groups no tab names show on every tab. */
  tabs?: readonly LabTab[]
  /** A close button in the header (and Esc from the panel) that calls this. */
  close?: () => void
  /**
   * Every group folds from its header. `"open"`: groups start open; otherwise they start folded except the ones
   * `open` names (the first group when it names none). A control's own `folded` still folds its group. Without it,
   * only groups a control folds can fold. Sub-headings always start folded.
   */
  folding?: { start: "open" } | { start: "folded"; open?: () => readonly string[] }
  /** The browser remembers what the user folded and opened (localStorage, under the view's store id). */
  rememberFolds?: boolean
}

/** A row knobs draws; `upper` is the second key of a low–high pair (both stay their own settings). */
type Row = LabRow & { control: LabControl; upper?: LabControl }

const same = (a: Value | undefined, b: Value | undefined) =>
  a === b || (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i] || (typeof v === "object" && JSON.stringify(v) === JSON.stringify(b[i]))))

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

function localStorageOrNull(): StoragePort | null {
  try { return localStorage } catch { return null }
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
  /** A pair's upper key → the knobs key its row goes by (the lower one). */
  private aliases = new Map<string, string>()
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
      tunable: key => {
        const row = this.rows.get(key)
        return Boolean(row && isTunable(row.control, host.navigation.settings) && (!row.upper || isTunable(row.upper, host.navigation.settings)))
      },
      ...(host.history ? { history: host.history } : {}),
      theme: "dark",
      onSet: (key, value, meta) => this.onSet(key, value, meta),
      onReset: target => this.onReset(target),
      onAction: key => void this.onAction(key),
    })
    // knobs can't hand over a drag's start and end yet: the Lab closes one undo entry per gesture when it ends.
    const self = this
    const own = {
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
      ...LAB_LOOK,
      renderer: "dom",
      variants: Boolean(options.variantsId),
      // The Lab's canvas keeps focus when a section's panel is rebuilt.
      session: false,
      haptics: false,
      keys: { leave: "Escape", ...options.keys },
      ...(options.close ? { onClose: options.close } : {}),
      copy: () => this.copyText(),
      rowAccessory: key => this.accessory(key),
      // A group with its own seeded "Randomize <group>" action rolls through it (it may reseed its effect on purpose).
      groupRandom: group => {
        const action = this.groupAction(group)
        if (action) void this.onAction(action)
        return Boolean(action)
      },
      ...(options.search ? { search: { placeholder: "Search details" } } : {}),
      ...(options.tabs?.length ? { tabs: options.tabs.map(t => t.label) } : {}),
      subsectionFolded: true,
      foldStorage: options.rememberFolds ? localStorageOrNull() : null,
      actions: options.actions?.map(a => ({ label: a.label, run: () => { this.host.begin(a.label); a.run(); this.host.end(); this.host.edited(this) } })),
    })
    // knobs names the close button after the store id ("Close lab:arcade-woods").
    this.panel.element.querySelector(".knobs-close")?.setAttribute("aria-label", "Close")
  }

  /** Pushes outside changes to knobs: a new shape when rows came, went or changed state, else changed values. */
  sync(land = false) {
    if (this.disposed) return
    if (this.refreshShape(land)) return
    const nav = this.host.navigation
    let patch: Record<string, Value> | null = null
    for (const [key, row] of this.rows) {
      const value = this.value(row, nav.settings)
      if (value === undefined || same(value, this.shown[key])) continue
      ;(patch ??= {})[key] = value
      this.shown[key] = value
    }
    const mixed = this.mixedKeys()
    const remixed = mixed.join() !== this.mixed
    this.mixed = mixed.join()
    if (patch || remixed) this.store.sync(patch ?? {}, remixed ? { mixed } : undefined)
    this.refreshPins()
  }

  /** The row element for a setting, if this view shows it (a pair's upper key finds the pair's row). */
  rowElement(key: string): HTMLElement | null {
    const field = this.aliases.get(key) ?? key
    return this.panel.element.querySelector<HTMLElement>(`.knobs-row[data-field="${CSS.escape(field)}"]`)
  }

  /** Focuses a setting's control (or the first row) inside the panel. */
  focus(key?: string) {
    const row = key ? this.rowElement(key) : null
    const target = row?.querySelector<HTMLElement>('[role="slider"],button,[tabindex="0"]') ?? row
    // A row in a folded group can't take focus; the panel takes it instead so the game still lets go of keys.
    if (target && !target.closest("[hidden]") && target.getClientRects().length) target.focus({ preventScroll: true })
    if (!this.element.contains(document.activeElement)) this.panel.focus()
    if (!this.element.contains(document.activeElement)) this.panel.element.focus({ preventScroll: true })
  }

  /**
   * Ends the gesture now, for a click that hands input back to the game: an arrow-key burst knobs still holds for a
   * moment after the last keyup, or a nudge or reset's idle window.
   */
  letGo() {
    this.held.clear()
    this.settle()
  }

  private settle() {
    clearTimeout(this.idle)
    this.idle = 0
    this.host.end()
  }

  /** Brings a setting's row on screen: its tab, its folded group, and past a search that hides it. */
  show(key: string) {
    const row = this.rows.get(this.aliases.get(key) ?? key)
    if (!row) return
    const tab = this.tabOf(row.group)
    if (tab && this.panel.tab() !== tab.label) this.panel.tab(tab.label)
    this.panel.unfold(row.control.key)
    const element = this.rowElement(key)
    if (element && !element.getClientRects().length && this.search().query + (this.search().modified ? "m" : "")) this.setSearch({ query: "", modified: false })
  }

  /** The search field's text and whether its Modified chip is on (empty when the view has no search). */
  search(): { query: string; modified: boolean } {
    const input = this.panel.element.querySelector<HTMLInputElement>(".knobs-search input")
    const chip = this.panel.element.querySelector<HTMLElement>('.knobs-search-chip[data-chip="modified"]')
    return { query: input?.value ?? "", modified: chip?.getAttribute("aria-pressed") === "true" }
  }

  /** Sets the search field and the Modified chip, as typing and clicking would. */
  setSearch(next: { query?: string; modified?: boolean }) {
    const input = this.panel.element.querySelector<HTMLInputElement>(".knobs-search input")
    const chip = this.panel.element.querySelector<HTMLButtonElement>('.knobs-search-chip[data-chip="modified"]')
    if (input && next.query !== undefined && input.value !== next.query) {
      input.value = next.query
      input.dispatchEvent(new Event("input", { bubbles: true }))
    }
    if (chip && next.modified !== undefined && (chip.getAttribute("aria-pressed") === "true") !== next.modified) chip.click()
  }

  /** The keys whose rows are on screen now (after tabs, folds and the search). */
  shownKeys(): string[] {
    return [...this.rows.keys()].filter(key => this.rowElement(key)?.getClientRects().length)
  }

  /** The tab showing now, when the view has tabs. */
  get tab(): string | undefined {
    return this.options.tabs?.length ? this.panel.tab() : undefined
  }

  /** Whether a knobs gesture (a drag, a key held on a slider, an inline number edit) is in progress. */
  get interacting() {
    const active = document.activeElement
    return this.held.size > 0 || this.idle !== 0 || (active instanceof HTMLInputElement && this.element.contains(active))
  }

  get keys(): string[] { return [...this.rows.keys()] }

  /** The view's actions, presets and fields as ⌘K commands (knobs' `commandsFrom`). */
  commands(options: CommandsFromOptions = {}): Command[] {
    return this.disposed ? [] : commandsFrom(this.store, options)
  }

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

  /** The tab a group sits on, and how its heading reads there. */
  private tabOf(group: string): { label: string; groupLabel?: string } | undefined {
    const tabs = this.options.tabs ?? []
    for (const tab of tabs)
      for (const g of tab.groups) {
        if (g === group) return { label: tab.label }
        if (typeof g !== "string" && g[0] === group) return { label: tab.label, groupLabel: g[1] }
      }
    const tab = tabs.find(t => t.match?.(group)) ?? tabs.find(t => t.rest)
    return tab ? { label: tab.label } : undefined
  }

  /** The knobs value of a row: its setting, or `[low, high]` for a pair. */
  private value(row: Row, settings: Readonly<LabSettings>): Value | undefined {
    if (row.control.type === "action") return undefined
    const low = toKnobs(row.control, settings[row.control.key])
    if (!row.upper) return low
    const high = toKnobs(row.upper, settings[row.upper.key])
    return low === undefined || high === undefined ? undefined : [low as number, high as number]
  }

  /** Rebuilds the descriptors when the row set changed; returns true if it did (values were placed too). */
  private refreshShape(land: boolean): boolean {
    const nav = this.host.navigation
    const rows = this.visibleRows()
    const descriptors: ControlDescriptor[] = []
    const kept = new Map<string, Row>()
    const aliases = new Map<string, string>()
    const uppers = new Set(rows.flatMap(r => (r.control.pair ? [r.control.pair.key] : [])))
    const folded = this.foldedGroups(rows)
    for (const row of rows) {
      if (uppers.has(row.control.key)) continue
      const upper = row.control.pair ? nav.rows.find(r => r.control?.key === row.control.pair!.key)?.control : undefined
      const tab = this.tabOf(row.group)
      const d = describe(row, nav.defaults, nav.settings, { tab: tab?.label, groupLabel: tab?.groupLabel, pair: upper, folded: folded?.(row.group) })
      if (!d || kept.has(d.key)) continue
      descriptors.push(d)
      kept.set(d.key, upper ? { ...row, upper } : row)
      if (upper) aliases.set(upper.key, d.key)
    }
    const shape = JSON.stringify(descriptors)
    if (shape === this.shape) return false
    this.shape = shape
    this.rows = kept
    this.aliases = aliases
    this.shown = {}
    for (const [key, row] of kept) {
      const value = this.value(row, nav.settings)
      if (value !== undefined) this.shown[key] = value
    }
    const mixed = this.mixedKeys()
    this.mixed = mixed.join()
    this.store.update(descriptors, this.shown, { land, mixed })
    if (this.panel) this.refreshPins()
    return true
  }

  /** How each group starts under `folding`, or undefined when groups fold only where a control says. */
  private foldedGroups(rows: readonly Row[]): ((group: string) => boolean) | undefined {
    const folding = this.options.folding
    if (!folding) return undefined
    const declared = new Set(rows.flatMap(r => (r.control.folded ? [r.group] : [])))
    if (folding.start === "open") return group => declared.has(group)
    const named = folding.open?.() ?? []
    // Otherwise the first group opens (on each tab, when there are tabs).
    const firsts = new Map<string | undefined, string>()
    for (const r of rows) {
      const tab = this.tabOf(r.group)?.label
      if (!firsts.has(tab)) firsts.set(tab, r.group)
    }
    const open = new Set(named.length ? named : firsts.values())
    return group => declared.has(group) || !open.has(group)
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

  /** A group's own "Randomize <group>" action, if it has one: that action's key. */
  private groupAction(group: string): string | undefined {
    return [...this.rows.values()].find(r => r.group === group && r.control.type === "action" && r.control.label === `Randomize ${group}`)?.control.key
  }

  private onSet(key: string, value: Value | null, meta: ChangeMeta) {
    const row = this.rows.get(key)
    if (!row || value === null) return
    const writes: [LabControl, LabValue][] = []
    if (row.upper) {
      if (!Array.isArray(value)) return
      const low = fromKnobs(row.control, value[0] as number), high = fromKnobs(row.upper, value[1] as number)
      if (low === undefined || high === undefined) return
      writes.push([row.control, low], [row.upper, high])
    } else {
      const next = fromKnobs(row.control, value)
      if (next === undefined) return
      writes.push([row.control, next])
    }
    this.shown[key] = value
    if ((meta.source === "randomize" || meta.source === "mutate") && this.roll) {
      this.roll.mode = meta.source === "mutate" ? "mutate" : "random"
      this.roll.keys.push(key)
    }
    // Compare (hold `\`) previews and puts back knobs' last entry: it applies, but no undo step may hold it, so a
    // gesture still settling closes first instead of taking the preview into its after-state.
    if (meta.source === "compare") this.settle()
    else this.host.begin(this.labelFor(row, meta))
    for (const [control, next] of writes) this.host.navigation.set(control, next)
    this.host.edited(this)
    if (meta.source === "compare") return
    // A drag ends on release; keys and discrete changes settle once they stop arriving.
    if (!this.held.size) this.schedule(meta.source === "local" && ("min" in row.control || isRampControl(row.control)) ? 350 : 0)
  }

  /** knobs skips disabled rows and then reports the rest key by key: they join one transaction. */
  private onReset(target: { key?: string; group?: string }) {
    const nav = this.host.navigation
    const rows = [...this.rows.values()].filter(r => r.control.type !== "action" && (target.key ? r.control.key === target.key : target.group ? r.group === target.group : true))
    if (!rows.length) return
    this.host.begin(`Reset ${target.key ? (rows[0]!.upper ? rows[0]!.control.pair!.label : rows[0]!.control.label) : target.group ?? "all"}`)
    for (const r of rows) {
      for (const c of r.upper ? [r.control, r.upper] : [r.control]) if (c.key in nav.defaults) nav.set(c, nav.defaults[c.key]!)
      const v = this.value(r, nav.defaults)
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
    return row.upper ? row.control.pair!.label : row.control.label
  }

  private schedule(ms: number) {
    clearTimeout(this.idle)
    this.idle = window.setTimeout(() => this.settle(), ms)
  }

  /** The visible settings as JSON; a Random since the defaults adds the tuning seed that reproduces it. */
  private copyText() {
    const nav = this.host.navigation
    const out: Record<string, unknown> = {}
    for (const [key, row] of this.rows) if (row.control.type !== "action") {
      out[key] = nav.settings[key]
      if (row.upper) out[row.upper.key] = nav.settings[row.upper.key]
    }
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

/** One button of a LabToolbar: a command, its label, knobs icon and key, and why it is unavailable when it is. */
export type LabToolbarItem = { id: string; label: string; icon?: string; shortcut?: string; disabled?: boolean; title?: string }

const TOOLBAR_KEYS: PanelKeys = {
  random: false, mutate: false, reset: false, resetAll: false, compare: false, hint: false, undo: false, redo: false,
  copy: false, save: false, lock: false, presets: false, group: false, first: false, help: false, menu: false,
}

/**
 * A row of buttons with shortcut chips (knobs' toolbar, in the `arcade` preset), for commands the host owns: the
 * Details actions. It is its own small panel, so a chip's key presses the button only while focus is on the toolbar;
 * elsewhere the host's own bindings (the canvas keys) answer, and knobs' keys in the settings panel stay knobs'.
 */
export class LabToolbar {
  readonly element = document.createElement("div")
  private store: RemoteControls
  private panel: Panel
  private shape = ""
  private titles = new Map<string, string>()

  constructor(container: HTMLElement, private label: string, press: (id: string) => void) {
    this.element.className = "lab-knobs lab-toolbar"
    container.append(this.element)
    this.store = createRemoteControls(`lab-toolbar:${label}`, [], { enabled: true, storage: null, persist: "none", onAction: id => press(id) })
    this.panel = mountPanel(this.store, this.element, {
      title: false,
      header: false,
      ...LAB_LOOK,
      renderer: "dom",
      variants: false,
      session: false,
      haptics: false,
      marks: false,
      keys: TOOLBAR_KEYS,
    })
  }

  /** Shows these buttons; only a change in the buttons themselves rebuilds the row. */
  set(items: readonly LabToolbarItem[]) {
    this.titles = new Map(items.map(i => [i.id, i.title ?? i.label]))
    const tools = items.map(i => ({ key: i.id, label: i.label, ...(i.icon ? { icon: i.icon } : {}), ...(i.shortcut ? { shortcut: i.shortcut } : {}), ...(i.disabled ? { disabled: true } : {}) }))
    const shape = JSON.stringify(tools)
    if (shape !== this.shape) {
      this.shape = shape
      this.store.update(tools.length ? [{ key: "tools", label: this.label, kind: "toolbar", items: tools }] : [], {})
    }
    requestAnimationFrame(() => this.applyTitles())
    this.applyTitles()
  }

  /** The buttons, by command id. */
  button(id: string): HTMLButtonElement | null {
    return this.element.querySelector<HTMLButtonElement>(`.knobs-tool[data-item="${CSS.escape(id)}"]`)
  }

  dispose() {
    this.panel.dispose()
    this.element.remove()
  }

  private applyTitles() {
    for (const [id, title] of this.titles) {
      const b = this.button(id)
      if (b && b.title !== title) b.title = title
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
.lab-knobs-pin{width:12px;height:16px;padding:0;border:0;background:none;color:var(--k-dim);cursor:pointer;opacity:0;font:10px/16px system-ui}
.lab-knobs-pin::before{content:"•"}
.knobs-row:hover .lab-knobs-pin,.lab-knobs-pin[aria-pressed="true"]{opacity:1}
.lab-knobs-pin[aria-pressed="true"]{color:var(--k-accent)}
.lab-knobs-pin:hover{color:var(--k-text)}
[data-lab-flash]{animation:lab-knobs-flash 1.3s ease-out}
@keyframes lab-knobs-flash{0%,35%{background:color-mix(in srgb,var(--k-accent,#fff) 24%,transparent)}100%{background:transparent}}
`
  document.head.append(style)
}
