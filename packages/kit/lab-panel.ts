import {
  LabNavigation,
  holdsValue,
  formatLabValue,
  inferControlUnit,
  isSwitchControl,
  resolveControlField,
  type LabControl,
  type LabRow,
  type LabSettings,
  type LabTab,
  type LabValue,
} from "./lab-navigation"
import type { HostHistory } from "@arcade/knobs"
import type { Command, CommandsFromOptions } from "@arcade/knobs/ui"
import { attachLabPanelControl } from "./dev-control"
import { ensureLabKnobsStyles, LabKnobsView, type LabKnobsHost, type LabKnobsViewOptions } from "./lab-knobs"
export { formatLabValue, holdsValue, inferControlUnit, isRampControl, resolveControlField } from "./lab-navigation"
export type { LabButton, LabControl, LabReadoutScale, LabReadoutValue, LabRow, LabSettings, LabTab, LabValue } from "./lab-navigation"
export type { LabKnobsView } from "./lab-knobs"
export type LabOptions = {
  open?: boolean
  /** All on / All off buttons when the panel has switches. */
  presets?: boolean
  shortcut?: boolean
  /**
   * `"open"` (the default): an open floating panel keeps every key from the game. `"focus"`: play with the panel open.
   * Keys reach the game unless focus is in the panel; a click outside the panel (on the game) or pointer lock hands
   * input back to the game while the panel stays up, and a click on the panel takes it again. Games gate their input
   * on `holdsInput` rather than `visible`.
   */
  capture?: "open" | "focus"
  layout?: "floating" | "inspector"
  /** Random (the dice); Reset and Copy stay. */
  groupActions?: boolean
  /** The pill that shows a closed floating panel. */
  pill?: boolean
  /**
   * Floating panel: the groups that start open (the first group when omitted); the others start folded. What the user
   * folds and opens is remembered per page. Inspector groups start open.
   */
  openGroups?: readonly string[]
  /**
   * Places every control added (in the constructor and by any later `addControls`) where the game wants it: a game with
   * many subsystems regroups their rows into a few sections with sub-headings without each subsystem knowing. Keys
   * stay as they are, so saved values and URLs keep working.
   */
  arrange?: (control: LabControl) => LabControl
  /** Called with each setting a panel edit changes (the same as passing a function as `options`). */
  onChange?: (key: string, value: LabValue) => void
  /** Saved variants are kept per this id (by default per page and section); `false` turns them off. */
  variants?: string | false | (() => string | false)
  /** The host's undo stack (the Lab workbench); knobs' Undo and Redo follow it. Without it knobs keeps its own history. */
  history?: HostHistory
  onTransaction?: (label: string, before: LabSettings, after: LabSettings) => void
  onToggle?: (visible: boolean) => void
  onFocusChange?: (focused: boolean, activeRow?: LabRow) => void
  /** Inspector layout: per-row pin button for an external watch list. */
  onPin?: (control: LabControl, group: string) => void
  isPinned?: (key: string) => boolean
}

/** Details view state for the inspector layout: group priority and a row filter. */
export type LabPanelView = {
  order?: readonly string[]
  filter?: (row: LabRow, modified: boolean) => boolean
}

// The floating shell around knobs' panel in knobs' own dark look: no box of its own (the knobs panel is the card), the
// telemetry above it as a glass card at the same radius, and the pill as a capsule.
const CSS = `
[data-lab-panel]{position:fixed;z-index:1000;right:10px;top:10px;width:300px;max-width:calc(100vw - 20px);max-height:calc(100dvh - 20px);display:flex;flex-direction:column;align-items:stretch;gap:6px;color:rgba(255,255,255,.92);font:12px/1.35 system-ui,-apple-system,"SF Pro Text",sans-serif}
[data-lab-panel][data-tabs]:not([data-layout=inspector]){width:320px}
[data-lab-panel][data-layout=inspector]{position:relative;right:auto;top:auto;z-index:auto;width:100%;height:100%;max-width:none;max-height:none;gap:0}
[data-lab-panel] [hidden]{display:none!important}
[data-lab-panel]>.lab-panel-pill{align-self:flex-end;font:inherit;color:inherit;background:rgba(28,28,30,.88);border:0;border-radius:999px;box-shadow:inset 0 0 0 1px rgba(255,255,255,.1),inset 0 1px 0 rgba(255,255,255,.09),0 12px 36px rgba(0,0,0,.52);padding:4px 12px;cursor:pointer;-webkit-backdrop-filter:blur(24px) saturate(1.6);backdrop-filter:blur(24px) saturate(1.6)}
[data-lab-panel]>.lab-panel-body{display:flex;flex-direction:column;gap:6px;min-height:0;overflow:auto;border-radius:12px}
[data-lab-panel][data-layout=inspector]>.lab-panel-body{flex:1;gap:0;border-radius:0}
[data-lab-panel] .lab-panel-telemetry{font:10.5px/1.5 ui-monospace,"SF Mono",Menlo,monospace;white-space:pre-line;font-variant-numeric:tabular-nums;color:rgba(255,255,255,.64);padding:8px 12px;border-radius:12px;background:rgba(28,28,30,.88);box-shadow:inset 0 0 0 1px rgba(255,255,255,.1),inset 0 1px 0 rgba(255,255,255,.09);-webkit-backdrop-filter:blur(24px) saturate(1.6);backdrop-filter:blur(24px) saturate(1.6)}
[data-lab-panel] .lab-panel-telemetry:empty{display:none}
[data-lab-panel][data-layout=inspector] .lab-panel-telemetry{display:none}
[data-lab-panel] .lab-panel-empty{padding:12px;color:rgba(255,255,255,.42)}
`

/** The game's path segment (`/arcade/<game>/…`): saved variants and folds are kept per game. */
const pagePrefix = () => location.pathname.match(/\/arcade\/([^/]+)/)?.[1] ?? "page"

/**
 * Presentation controls, drawn by knobs. LabNavigation and the settings objects stay the source of truth; this class
 * keeps the API games and the Lab use (sync, reveal, setView, header, Backquote) and turns knobs' edits into one
 * transaction per gesture. Floating panels own the keyboard while open, ahead of the game's listeners.
 */
export class LabPanel implements LabKnobsHost {
  readonly host = document.createElement("aside")
  /** Telemetry line(s) above the controls (floating layout). */
  readonly header = document.createElement("header")
  readonly navigation: LabNavigation
  readonly tuning: LabKnobsHost["tuning"] = { seed: 1, last: null }
  readonly history?: HostHistory
  readonly pin?: LabKnobsHost["pin"]
  private body = document.createElement("div")
  private pill = document.createElement("button")
  private empty = document.createElement("div")
  private views = new Set<LabKnobsView>()
  /** Views whose rows the panel's own view leaves out, so a setting shows once (a station's controls card). */
  private claims = new Set<LabKnobsView>()
  private main: LabKnobsView | null = null
  private events = new AbortController()
  private allowPresets = true
  private groupActions = true
  private focusOnly = false
  private layoutMode: "floating" | "inspector" = "floating"
  private onTransaction?: (label: string, before: LabSettings, after: LabSettings) => void
  private onToggle?: (visible: boolean) => void
  private onFocusChange?: (focused: boolean, activeRow?: LabRow) => void
  private variants: LabOptions["variants"]
  private pending: { label: string; before: LabSettings } | null = null
  private fanOut = false
  private previousFocus: HTMLElement | null = null
  private leaving = false
  private detachControl?: () => void
  private view: LabPanelView = {}
  private tabs: readonly LabTab[] = []
  private openGroups?: readonly string[]
  private arrange?: (control: LabControl) => LabControl

  constructor(settings: LabSettings, controls: LabControl[], params: URLSearchParams, private release: () => void, options?: LabOptions | ((key: string, value: LabValue) => void)) {
    const opts = typeof options === "object" ? options : {}
    const change = typeof options === "function" ? options : opts.onChange
    this.allowPresets = opts.presets !== false
    this.groupActions = opts.groupActions !== false
    this.focusOnly = opts.capture === "focus"
    this.layoutMode = opts.layout ?? "floating"
    this.onTransaction = opts.onTransaction
    this.onToggle = opts.onToggle
    this.onFocusChange = opts.onFocusChange
    this.variants = opts.variants
    this.openGroups = opts.openGroups
    this.arrange = opts.arrange
    this.history = opts.history
    if (opts.onPin) this.pin = { toggle: opts.onPin, has: key => Boolean(opts.isPinned?.(key)) }
    this.navigation = new LabNavigation({}, [], (key, value) => {
      change?.(key, value)
    })
    ensureLabKnobsStyles()
    if (!document.querySelector("style[data-lab-panel-css]")) {
      const style = document.createElement("style")
      style.dataset.labPanelCss = ""
      style.textContent = CSS
      document.head.append(style)
    }
    this.host.dataset.lab = ""
    this.host.dataset.labPanel = ""
    this.host.dataset.layout = this.layoutMode
    this.host.dataset.capture = this.focusOnly ? "focus" : "open"
    this.host.setAttribute("aria-label", "Debug controls")
    this.pill.type = "button"
    this.pill.className = "lab-panel-pill"
    this.pill.textContent = "~ Lab"
    this.pill.setAttribute("aria-expanded", "false")
    this.pill.onclick = () => this.toggle()
    this.body.className = "lab-panel-body"
    this.header.className = "lab-panel-telemetry"
    this.header.textContent = "FPS — · Frame ms — / —\nGPU ms —"
    this.empty.className = "lab-panel-empty"
    this.empty.textContent = "No matching settings"
    this.empty.hidden = true
    this.body.append(this.header, this.empty)
    this.host.append(this.pill, this.body)
    this.addControls(settings, controls)

    for (const type of ["pointerdown", "pointerup", "pointermove", "mousedown", "mouseup", "mousemove", "click", "dblclick", "wheel", "touchstart", "touchmove", "touchend", "contextmenu"]) {
      this.host.addEventListener(type, event => {
        event.stopPropagation()
        if (type === "pointerdown" || type === "mousedown" || type === "touchstart") release()
      })
    }
    // Keys knobs didn't claim still stop at a floating panel (games listen on window); browser shortcuts pass. In the
    // Lab's inspector they go on to the workbench, which leaves them alone while the panel has focus.
    for (const type of ["keydown", "keyup", "keypress"] as const) {
      this.host.addEventListener(type, event => {
        const e = event as KeyboardEvent
        if (type === "keydown" && e.key === "Escape" && !e.defaultPrevented) this.escape()
        if (!e.metaKey && !e.ctrlKey && this.layoutMode !== "inspector") event.stopPropagation()
      })
    }
    this.host.addEventListener("keydown", event => {
      this.release()
      this.leaving = event.key === "Escape"
      // Escape closes a floating panel from anywhere in it but a text field (where knobs clears or leaves it first).
      if (event.key === "Escape" && this.layoutMode === "floating" && !this.typingTarget(event)) {
        event.preventDefault()
        event.stopPropagation()
        this.leaving = false
        this.escape()
      }
    }, { capture: true })
    // knobs lets go of focus during Escape's keydown or not at all (an Escape that only clears the search): a keyup still
    // in the panel means it stayed, and a later blur (a click on the game) isn't leaving.
    this.host.addEventListener("keyup", () => { this.leaving = false }, { capture: true })
    this.host.addEventListener("focusin", () => this.onFocusChange?.(true, this.navigation.active))
    this.host.addEventListener("focusout", event => {
      if (this.host.contains(event.relatedTarget as Node | null)) {
        this.leaving = false
        return
      }
      // knobs' Esc lets go of focus; the Lab hands it back to the canvas and a floating panel closes.
      if (this.leaving && !event.relatedTarget) queueMicrotask(() => this.escape())
      this.leaving = false
      this.onFocusChange?.(false, this.navigation.active)
    })
    for (const type of ["keydown", "keyup", "keypress"] as const) window.addEventListener(type, event => this.keyboard(event), { capture: true, signal: this.events.signal })
    // Comparison panes deliver keys as messages rather than DOM keyboard events.
    window.addEventListener("message", event => {
      const m = event.data
      if (!params.has("mux") || event.source !== parent || event.origin !== (document.referrer ? new URL(document.referrer).origin : location.origin) || m?.run !== (params.get("muxRun") ?? "")) return
      if (m.type !== "mux-key" || !["keydown", "keyup"].includes(m.kind) || typeof m.key !== "string" || typeof m.code !== "string") return
      const key = new KeyboardEvent(m.kind, { key: m.key, code: m.code, shiftKey: m.shiftKey, altKey: m.altKey, metaKey: m.metaKey, ctrlKey: m.ctrlKey, bubbles: true, cancelable: true })
      if (this.keyboard(key, true)) event.stopImmediatePropagation()
    }, { capture: true, signal: this.events.signal })
    window.addEventListener("blur", () => { if (this.visible) release() }, { signal: this.events.signal })
    if (this.focusOnly && this.layoutMode === "floating") {
      // Play with the panel open: a press anywhere but the panel (and its menus) gives input back to the game, and so
      // does pointer lock. The panel stays up.
      document.addEventListener("pointerdown", event => {
        if (this.visible && !this.owns(event.target)) this.handBack()
      }, { capture: true, signal: this.events.signal })
      document.addEventListener("pointerlockchange", () => {
        if (document.pointerLockElement) this.handBack()
      }, { signal: this.events.signal })
      // knobs' menus sit on <body>: keys typed in them stop before the game's window listeners.
      for (const type of ["keydown", "keyup", "keypress"] as const) document.addEventListener(type, event => {
        if (this.visible && event.target instanceof Element && event.target.closest(".knobs-menu")) event.stopPropagation()
      }, { signal: this.events.signal })
    }

    const lab = opts.open ?? (params.get("perf") === "1" || params.get("lab") === "1")
    this.body.hidden = true
    this.pill.hidden = opts.pill === false || !lab || this.layoutMode === "inspector"
    if (this.layoutMode !== "inspector") document.body.append(this.host)
    if (lab) {
      if (this.layoutMode === "inspector") {
        this.body.hidden = false
        this.sync()
      } else this.toggle()
    }
    this.detachControl = attachLabPanelControl(this)
  }

  // ── knobs host ───────────────────────────────────────────────────────────────────────────────────────────────────

  begin(label: string) {
    if (this.pending) return
    this.pending = { label, before: this.snapshotSettings() }
  }

  end() {
    const pending = this.pending
    this.pending = null
    if (pending) this.commitTransaction(pending.label, pending.before)
  }

  edited(from: LabKnobsView) {
    if (this.fanOut) return
    this.fanOut = true
    queueMicrotask(() => {
      this.fanOut = false
      for (const view of this.views) if (view !== from) view.sync()
      from.sync()
    })
  }

  /**
   * Another knobs card over these settings (a station widget): its own rows, the same write path, transactions,
   * tuning seed and history. Dispose it when the widget goes.
   */
  mountView(container: HTMLElement, options: LabKnobsViewOptions & { claim?: boolean }): LabKnobsView {
    const { claim, ...rest } = options
    const view = new LabKnobsView(this, container, { keys: this.keys(), ...rest })
    const dispose = view.dispose.bind(view)
    view.dispose = () => {
      this.views.delete(view)
      dispose()
      if (this.claims.delete(view)) this.main?.sync()
    }
    this.views.add(view)
    if (claim) {
      this.claims.add(view)
      this.main?.sync()
    }
    return view
  }

  private claimed(row: LabRow): boolean {
    for (const view of this.claims) if (view.includes(row)) return true
    return false
  }

  /** The view showing a setting: the panel's own, or the card that claimed it. */
  private viewFor(key: string): LabKnobsView | null {
    if (this.main?.rowElement(key)) return this.main
    for (const view of this.claims) if (view.rowElement(key)) return view
    return null
  }

  // ── LabPanel API ─────────────────────────────────────────────────────────────────────────────────────────────────

  isInteracting(): boolean {
    return this.pending !== null || [...this.views].some(view => view.interacting)
  }

  /** Whether keyboard focus is inside the panel or one of its views (knobs rows, editors, buttons or menus). */
  hasFocus(): boolean {
    return this.owns(document.activeElement)
  }

  /**
   * Whether the panel has the game's input now: while a floating panel is open with capture `"open"`, and otherwise
   * while focus is in it. Games gate keys, look and pointer lock on this rather than on `visible`.
   */
  get holdsInput(): boolean {
    if (this.layoutMode === "floating" && !this.focusOnly) return this.visible
    return this.visible && (this.hasFocus() || this.isInteracting())
  }

  private owns(target: EventTarget | null): boolean {
    if (!(target instanceof Node)) return false
    if (this.host.contains(target) || [...this.views].some(view => view.element.contains(target))) return true
    return target instanceof Element && Boolean(target.closest(".knobs-menu"))
  }

  /** Focus leaves the panel for the game; the panel stays open. */
  private handBack() {
    this.leaving = false
    // A nudge or reset still settling would keep holdsInput true past the click that handed input back.
    for (const view of this.views) view.letGo()
    if (!this.hasFocus()) return
    this.end()
    const active = document.activeElement
    if (active instanceof HTMLElement) active.blur()
    this.onFocusChange?.(false, this.navigation.active)
  }

  private snapshotSettings(): LabSettings {
    const out: LabSettings = {}
    for (const key of Object.keys(this.navigation.settings)) out[key] = this.navigation.settings[key]!
    return out
  }

  private commitTransaction(label: string, before: LabSettings | null) {
    if (!before || !this.onTransaction) return
    const after = this.snapshotSettings()
    if (Object.keys(after).some(k => after[k] !== before[k])) this.onTransaction(label, before, after)
  }

  clearControls() {
    this.end()
    this.navigation.rows.length = 0
    this.navigation.active = undefined
    this.navigation.folded.clear()
    for (const key of Object.keys(this.navigation.settings)) delete this.navigation.settings[key]
    for (const key of Object.keys(this.navigation.defaults)) delete this.navigation.defaults[key]
    this.main?.dispose()
    this.main = null
  }

  /** `defaults` supplies approved values for Reset and modified highlighting; otherwise the current values are captured. */
  addControls(settings: LabSettings, controls: readonly LabControl[], defaults?: Readonly<LabSettings>) {
    if (this.arrange) controls = controls.map(this.arrange)
    for (const c of controls) if (holdsValue(c)) {
      const field = resolveControlField(c, settings)
      Object.defineProperty(this.navigation.settings, c.key, {
        configurable: true,
        enumerable: true,
        get: () => settings[field],
        set: value => { settings[field] = value },
      })
      if (!(c.key in this.navigation.defaults)) {
        this.navigation.defaults[c.key] = defaults && field in defaults ? defaults[field]! : settings[field]!
      }
    }
    this.navigation.append(controls)
    this.sync()
  }

  private keys() {
    return this.groupActions ? {} : { random: false, mutate: false } as const
  }

  private variantsId(): string | undefined {
    const raw = typeof this.variants === "function" ? this.variants() : this.variants
    if (raw === false) return undefined
    if (typeof raw === "string") return raw
    return `arcade-${pagePrefix()}`
  }

  /** The panel's own knobs view: every row, after the Details filter and order. Built when first needed. */
  private ensureMain(): LabKnobsView | null {
    if (this.main) return this.main
    if (!this.navigation.rows.some(row => row.control)) return null
    const switches = this.navigation.rows.flatMap(row => row.control && isSwitchControl(row.control) ? [row.control] : [])
    const floating = this.layoutMode === "floating"
    this.main = new LabKnobsView(this, this.body, {
      id: `${pagePrefix()}-${this.layoutMode}-panel`,
      variantsId: this.variantsId(),
      folding: floating ? { start: "folded", open: () => this.openGroups ?? [] } : { start: "open" },
      rememberFolds: true,
      include: row => (!this.navigation.filter || this.navigation.filter(row)) && !this.claimed(row),
      order: () => this.view.order ?? [],
      keys: this.keys(),
      search: true,
      tabs: this.tabs,
      // A floating panel shows a close button: Backquote isn't the only way out.
      close: this.layoutMode === "floating" ? () => { if (this.visible) this.toggle() } : undefined,
      actions: this.allowPresets && switches.length ? [
        { label: "All on", run: () => { for (const c of switches) this.navigation.set(c, c.on ?? true) } },
        { label: "All off", run: () => { for (const c of switches) this.navigation.set(c, c.off ?? false) } },
      ] : undefined,
    })
    this.views.add(this.main)
    const dispose = this.main.dispose.bind(this.main)
    const main = this.main
    main.dispose = () => { this.views.delete(main); dispose() }
    return this.main
  }

  /** Reset one control to its default as a single authored transaction. */
  resetControl(key: string): boolean {
    const row = this.navigation.rows.find(r => r.control?.key === key)
    const c = row?.control
    if (!c || !holdsValue(c) || !(key in this.navigation.defaults)) return false
    this.begin(`Reset ${c.label}`)
    this.navigation.set(c, this.navigation.defaults[key]!)
    this.end()
    this.sync()
    return true
  }

  isModified(key: string): boolean {
    const c = this.navigation.rows.find(r => r.control?.key === key)?.control
    return Boolean(c && this.navigation.isModified(c))
  }

  /** Modified controls among rows whose own `visible` condition holds (ignores the Details view filter). */
  modifiedControls(): LabControl[] {
    const out: LabControl[] = []
    for (const row of this.navigation.rows) {
      const c = row.control
      if (!c || !holdsValue(c)) continue
      if (c.visible && !c.visible(this.navigation.settings)) continue
      if (this.navigation.isModified(c)) out.push(c)
    }
    return out
  }

  /**
   * Tabs over the panel's groups (the Lab sets each section's). Call before `addControls`; a change rebuilds the
   * panel's own view.
   */
  setTabs(tabs: readonly LabTab[] = []) {
    if (JSON.stringify(tabs) === JSON.stringify(this.tabs)) return
    this.tabs = tabs
    // A floating panel widens a little so a tab strip's labels fit.
    this.host.toggleAttribute("data-tabs", tabs.length > 0)
    if (this.main) {
      this.main.dispose()
      this.main = null
      this.sync()
    }
  }

  /** The tab the panel shows, when it has tabs. */
  get tab(): string | undefined { return this.main?.tab }

  /** Shows one of the panel's tabs (see `setTabs`) by its label; false when there is no such tab. */
  setTab(label: string): boolean {
    return this.ensureMain()?.selectTab(label) ?? false
  }

  /** The panel's search text and Modified chip. */
  get search(): { query: string; modified: boolean } {
    return this.main?.search() ?? { query: "", modified: false }
  }

  /** Sets the panel's search text and Modified chip, as typing and clicking would. */
  setSearch(next: { query?: string; modified?: boolean }) {
    this.ensureMain()?.setSearch(next)
  }

  /** The panel's own view (and its station cards) as ⌘K commands: actions, presets, fields and resets. */
  commands(options: CommandsFromOptions = {}): Command[] {
    return [...(this.main ? [this.main] : []), ...this.claims].flatMap(view => view.commands(options))
  }

  /** The settings the panel's own view shows on screen now (after its tab, folds and search). */
  shownKeys(): string[] {
    return this.main?.shownKeys() ?? []
  }

  /** Apply Details ordering and filtering (inspector layout). */
  setView(view: LabPanelView) {
    this.view = view
    this.navigation.filter = view.filter ? row => view.filter!(row, Boolean(row.control && this.navigation.isModified(row.control))) : undefined
    this.sync()
  }

  get currentView(): LabPanelView { return this.view }

  /** Activate, scroll to, focus and flash a control row. Returns false if the key is not mounted or not visible. */
  reveal(key: string, focus = true): boolean {
    const row = this.navigation.rows.find(r => r.control?.key === key)
    if (!row || !this.navigation.isRowVisible(row)) return false
    if (!this.visible) this.toggle()
    this.navigation.jump(row)
    this.sync()
    for (const v of this.views) v.show(key)
    const view = this.viewFor(key)
    const element = view?.rowElement(key)
    if (!view || !element) return false
    if (focus) view.focus(key)
    element.scrollIntoView({ block: "center" })
    element.removeAttribute("data-lab-flash")
    void element.offsetWidth
    element.setAttribute("data-lab-flash", "")
    setTimeout(() => element.removeAttribute("data-lab-flash"), 1400)
    return true
  }

  /** Locate a control row element without stealing focus; optionally opens a hidden floating panel. */
  getControlElement(key: string, revealIfFolded = false): HTMLElement | null {
    const row = this.navigation.rows.find(r => r.control?.key === key)
    if (!row || !this.navigation.isRowVisible(row)) return null
    if (revealIfFolded && !this.visible) {
      this.pill.hidden = false
      this.body.hidden = false
      this.sync()
    }
    if (revealIfFolded) for (const view of this.views) view.show(key)
    const element = this.viewFor(key)?.rowElement(key) ?? null
    if (revealIfFolded) element?.scrollIntoView({ block: "nearest" })
    return element
  }

  /** Refresh values advanced by the game outside panel input. */
  refresh(): void { this.sync() }

  sync() {
    this.pill.setAttribute("aria-expanded", String(this.visible))
    if (this.navigation.active && !this.navigation.isRowVisible(this.navigation.active)) this.navigation.active = this.navigation.visibleRows[0]
    // A closed floating panel waits: it catches up when it opens.
    if (!this.visible && this.layoutMode === "floating") return
    this.ensureMain()
    for (const view of this.views) view.sync()
    this.empty.hidden = !this.navigation.filter || this.navigation.rows.some(r => r.control && this.navigation.isRowVisible(r))
  }

  focusFirst() {
    this.navigation.active ??= this.navigation.visibleRows[0]
    this.sync()
    this.main?.focus(this.navigation.active?.control?.key)
  }

  setReturnFocus(el: HTMLElement | null) {
    this.previousFocus = el
  }

  private escape() {
    if (this.layoutMode === "inspector") {
      if (this.previousFocus?.isConnected) this.previousFocus.focus({ preventScroll: true })
      this.onFocusChange?.(false, this.navigation.active)
    } else if (this.visible) this.toggle()
  }

  private typingTarget(event: KeyboardEvent) {
    const target = event.composedPath()[0]
    return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable)
  }

  /** Backquote toggles; an open floating panel (capture "open") keeps every other key from the game. */
  private keyboard(event: KeyboardEvent, forwarded = false) {
    if (!this.host.isConnected) return false
    const first = event.composedPath()[0]
    const inside = this.owns(first ?? null)
    const typing = this.typingTarget(event)
    if (event.code === "Backquote" && !typing && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.stopImmediatePropagation()
      event.preventDefault()
      if (event.type === "keydown" && !event.repeat) this.toggle()
      return true
    }
    if (forwarded) {
      // A comparison pane's key: hand it to the focused control, as if typed there.
      if (!this.visible) return false
      if (!this.hasFocus()) this.focusFirst()
      ;(document.activeElement ?? this.host).dispatchEvent(new KeyboardEvent(event.type, event))
      return true
    }
    if (inside || this.focusOnly || this.layoutMode === "inspector" || !this.visible) return false
    if (event.metaKey || event.ctrlKey) return false
    // Open capture: the game doesn't see keys while the overlay is open. A key from outside brings focus back.
    event.stopImmediatePropagation()
    event.preventDefault()
    if (event.type !== "keydown") return true
    if (event.key === "Escape") { this.toggle(); return true }
    this.focusFirst()
    ;(document.activeElement ?? this.host).dispatchEvent(new KeyboardEvent("keydown", event))
    return true
  }

  toggle() {
    const opening = this.body.hidden
    // Closing a panel the player is playing beside leaves the game as it is.
    if (opening || !this.focusOnly || this.hasFocus()) this.release()
    // Opening frees the pointer for the panel; a click back on the game locks it again.
    if (opening && this.layoutMode === "floating" && document.pointerLockElement) document.exitPointerLock()
    this.body.hidden = !this.body.hidden
    this.pill.setAttribute("aria-expanded", String(this.visible))
    if (this.visible) {
      this.sync()
      if (this.layoutMode !== "inspector") {
        if (!this.hasFocus()) this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
        this.focusFirst()
      }
    } else {
      this.sync()
      if (this.hasFocus()) {
        if (this.previousFocus?.isConnected && this.previousFocus !== document.body) {
          this.previousFocus.focus({ preventScroll: true })
        }
        if (this.hasFocus()) (document.activeElement as HTMLElement | null)?.blur()
      }
    }
    this.onToggle?.(this.visible)
  }

  dispose() {
    this.detachControl?.()
    this.release()
    this.events.abort()
    for (const view of [...this.views]) view.dispose()
    this.host.remove()
  }

  get visible() { return !this.body.hidden }
}
