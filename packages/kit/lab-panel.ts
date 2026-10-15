import {
  LabNavigation,
  formatLabValue,
  inferControlUnit,
  type LabControl,
  type LabRow,
  type LabSettings,
  type LabValue,
} from "./lab-navigation"
import { attachLabPanelControl } from "./dev-control"
import { ensureLabKnobsStyles, LabKnobsView, type LabKnobsHost, type LabKnobsViewOptions } from "./lab-knobs"
export { formatLabValue, inferControlUnit } from "./lab-navigation"
export type { LabControl, LabRow, LabSettings, LabValue } from "./lab-navigation"
export type { LabKnobsView } from "./lab-knobs"
export type LabOptions = {
  open?: boolean
  /** All on / All off buttons when the panel has switches. */
  presets?: boolean
  shortcut?: boolean
  capture?: "open" | "focus"
  layout?: "floating" | "inspector"
  /** Random (the dice); Reset and Copy stay. */
  groupActions?: boolean
  /** The pill that shows a closed floating panel. */
  pill?: boolean
  /** Saved variants are kept per this id (by default per page and section); `false` turns them off. */
  variants?: string | false | (() => string | false)
  /** The host's undo and redo (the Lab workbench). Without them knobs keeps its own history. */
  history?: { undo(): void; redo(): void }
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

const CSS = `
[data-lab-panel]{position:fixed;z-index:1000;right:10px;top:10px;width:300px;max-width:calc(100vw - 20px);max-height:calc(100dvh - 20px);display:flex;flex-direction:column;align-items:stretch;gap:6px;color:#d8dbe0;font:11.5px/1.35 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif}
[data-lab-panel][data-layout=inspector]{position:relative;right:auto;top:auto;z-index:auto;width:100%;height:100%;max-width:none;max-height:none;gap:0}
[data-lab-panel] [hidden]{display:none!important}
[data-lab-panel]>.lab-panel-pill{align-self:flex-end;font:inherit;color:inherit;background:#141518;border:1px solid #2c2f35;border-radius:999px;padding:3px 10px;cursor:pointer}
[data-lab-panel]>.lab-panel-body{display:flex;flex-direction:column;min-height:0;overflow:auto;border-radius:8px;background:#141518;border:1px solid #23252a;box-shadow:0 12px 36px rgba(0,0,0,.5)}
[data-lab-panel][data-layout=inspector]>.lab-panel-body{flex:1;border:0;border-radius:0;box-shadow:none;background:transparent}
[data-lab-panel] .lab-panel-telemetry{font:10px/1.5 ui-monospace,"SF Mono",Menlo,monospace;white-space:pre-line;font-variant-numeric:tabular-nums;color:#8b9098;padding:8px 10px 0}
[data-lab-panel][data-layout=inspector] .lab-panel-telemetry{display:none}
[data-lab-panel] .lab-panel-empty{padding:12px;color:#5b6068}
`

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
  readonly history?: { undo(): void; redo(): void }
  readonly pin?: LabKnobsHost["pin"]
  private body = document.createElement("div")
  private pill = document.createElement("button")
  private empty = document.createElement("div")
  private views = new Set<LabKnobsView>()
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
  private generation = 0

  constructor(settings: LabSettings, controls: LabControl[], params: URLSearchParams, private release: () => void, options?: LabOptions | ((key: string, value: LabValue) => void)) {
    const change = typeof options === "function" ? options : undefined
    const opts = typeof options === "object" ? options : {}
    this.allowPresets = opts.presets !== false
    this.groupActions = opts.groupActions !== false
    this.focusOnly = opts.capture === "focus"
    this.layoutMode = opts.layout ?? "floating"
    this.onTransaction = opts.onTransaction
    this.onToggle = opts.onToggle
    this.onFocusChange = opts.onFocusChange
    this.variants = opts.variants
    this.history = opts.history
    if (opts.onPin) this.pin = { toggle: opts.onPin, has: key => Boolean(opts.isPinned?.(key)) }
    this.navigation = new LabNavigation({}, [], (key, value) => {
      if (controls.some(control => control.key === key)) change?.(key, value)
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
    }, { capture: true })
    this.host.addEventListener("focusin", () => this.onFocusChange?.(true, this.navigation.active))
    this.host.addEventListener("focusout", event => {
      if (this.host.contains(event.relatedTarget as Node | null)) return
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
  mountView(container: HTMLElement, options: LabKnobsViewOptions): LabKnobsView {
    const view = new LabKnobsView(this, container, { keys: this.keys(), ...options })
    const dispose = view.dispose.bind(view)
    view.dispose = () => { this.views.delete(view); dispose() }
    this.views.add(view)
    return view
  }

  // ── LabPanel API ─────────────────────────────────────────────────────────────────────────────────────────────────

  isInteracting(): boolean {
    return this.pending !== null || [...this.views].some(view => view.interacting)
  }

  /** Whether keyboard focus is inside the panel or one of its views (knobs rows, editors or buttons). */
  hasFocus(): boolean {
    const active = document.activeElement
    return this.host.contains(active) || [...this.views].some(view => view.element.contains(active))
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
    this.generation++
  }

  /** `defaults` supplies approved values for Reset and modified highlighting; otherwise the current values are captured. */
  addControls(settings: LabSettings, controls: readonly LabControl[], defaults?: Readonly<LabSettings>) {
    for (const c of controls) if (c.type !== "action") {
      Object.defineProperty(this.navigation.settings, c.key, { configurable: true, enumerable: true, get: () => settings[c.key], set: value => { settings[c.key] = value } })
      if (!(c.key in this.navigation.defaults)) this.navigation.defaults[c.key] = defaults && c.key in defaults ? defaults[c.key]! : settings[c.key]!
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
    const prefix = location.pathname.match(/\/arcade\/([^/]+)/)?.[1] ?? "page"
    return `arcade-${prefix}`
  }

  /** The panel's own knobs view: every row, after the Details filter and order. Built when first needed. */
  private ensureMain(): LabKnobsView | null {
    if (this.main) return this.main
    if (!this.navigation.rows.some(row => row.control)) return null
    const switches = this.navigation.rows.filter(row => row.control && row.control.type !== "action" && !("min" in row.control) && !("options" in row.control))
    const generation = this.generation
    const id = `${this.layoutMode}-${this.variantsId() ?? "panel"}-${generation}`
    this.main = new LabKnobsView(this, this.body, {
      id,
      variantsId: this.variantsId(),
      floating: this.layoutMode === "floating",
      include: row => !this.navigation.filter || this.navigation.filter(row),
      order: () => this.view.order ?? [],
      keys: this.keys(),
      actions: this.allowPresets && switches.length ? [
        { label: "All on", run: () => { for (const { control: c } of switches) if (c && c.type !== "action" && !("min" in c) && !("options" in c)) this.navigation.set(c, c.on ?? true) } },
        { label: "All off", run: () => { for (const { control: c } of switches) if (c && c.type !== "action" && !("min" in c) && !("options" in c)) this.navigation.set(c, c.off ?? false) } },
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
    if (!c || c.type === "action" || !(key in this.navigation.defaults)) return false
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
      if (!c || c.type === "action") continue
      if (c.visible && !c.visible(this.navigation.settings)) continue
      if (this.navigation.isModified(c)) out.push(c)
    }
    return out
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
    const element = this.main?.rowElement(key)
    if (!element) return false
    if (focus) this.main!.focus(key)
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
    const element = this.main?.rowElement(key) ?? null
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
    const inside = this.host.contains(event.composedPath()[0] as Node | null)
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
    this.release()
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
        if (this.previousFocus?.isConnected) this.previousFocus.focus({ preventScroll: true })
        else (document.activeElement as HTMLElement | null)?.blur()
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
