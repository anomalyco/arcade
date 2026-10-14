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
export { formatLabValue, inferControlUnit } from "./lab-navigation"
export type { LabControl, LabRow, LabSettings, LabValue } from "./lab-navigation"
export type LabOptions = {
  open?: boolean
  presets?: boolean
  shortcut?: boolean
  capture?: "open" | "focus"
  layout?: "floating" | "inspector"
  /** Group header Randomize/Reset/Copy buttons; keyboard shortcuts stay available. */
  groupActions?: boolean
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

const RESET_ICON = `<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="M3.5 8a4.5 4.5 0 1 0 1.4-3.3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M4.6 1.8v3.1h3.1" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`
const PIN_ICON = `<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="M6 2h4l-.6 4.2 2.4 2.3v1H4.2v-1l2.4-2.3z" fill="currentColor"/><path d="M8 9.5V14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`

/** Presentation controls. Open panels capture keys before the game's bubble listeners. */
export class LabPanel {
  readonly host = document.createElement("aside")
  readonly header: HTMLElement
  private panel: HTMLElement
  private pill: HTMLButtonElement
  readonly navigation: LabNavigation
  private inputs = new Map<LabControl, HTMLInputElement | HTMLSelectElement>()
  private elements = new Map<LabRow, HTMLElement>()
  private copies = new Map<string, HTMLButtonElement>()
  private searchBox: HTMLInputElement
  private results: HTMLElement
  private matches: LabRow[] = []
  private match = 0
  private editor: HTMLInputElement | null = null
  private previousFocus: HTMLElement | null = null
  private held = new Set<string>()
  private events = new AbortController()
  private allowPresets = true
  private groupActions = true
  private focusOnly = false
  private layoutMode: "floating" | "inspector" = "floating"
  private onTransaction?: (label: string, before: LabSettings, after: LabSettings) => void
  private onToggle?: (visible: boolean) => void
  private onFocusChange?: (focused: boolean, activeRow?: LabRow) => void
  private gestureBefore: LabSettings | null = null
  private gestureLabel = ""
  private fScrub: { control: LabControl; startX: number; startValue: number; before: LabSettings } | null = null
  private lastPointerX = 0
  private detachControl?: () => void
  private onPin?: (control: LabControl, group: string) => void
  private isPinned?: (key: string) => boolean
  private baseOrder: string[] = []
  private view: LabPanelView = {}

  constructor(settings: LabSettings, controls: LabControl[], params: URLSearchParams, private release: () => void, options?: LabOptions | ((key: string, value: LabValue) => void)) {
    const change = typeof options === "function" ? options : undefined
    this.allowPresets = typeof options === "object" ? options.presets !== false : true
    this.groupActions = typeof options === "object" ? options.groupActions !== false : true
    this.focusOnly = typeof options === "object" && options.capture === "focus"
    this.layoutMode = typeof options === "object" && options.layout ? options.layout : "floating"
    this.onTransaction = typeof options === "object" ? options.onTransaction : undefined
    this.onToggle = typeof options === "object" ? options.onToggle : undefined
    this.onFocusChange = typeof options === "object" ? options.onFocusChange : undefined
    this.onPin = typeof options === "object" ? options.onPin : undefined
    this.isPinned = typeof options === "object" ? options.isPinned : undefined
    this.navigation = new LabNavigation({}, [], (key, value) => {
      if (controls.some(control => control.key === key)) change?.(key, value)
      for (const copy of this.copies.values()) copy.textContent = "Copy"
    })
    this.host.dataset.lab = ""
    this.host.dataset.layout = this.layoutMode
    this.host.dataset.capture = this.focusOnly ? "focus" : "open"
    const root = this.host.attachShadow({ mode: "open" })
    root.innerHTML = `<style>
      :host{position:fixed;z-index:1000;right:10px;top:10px;color:#e4e9ed;font:11px/1.45 system-ui,-apple-system,sans-serif;max-width:calc(100vw - 20px)}
      :host([data-layout=inspector]){position:relative;right:auto;top:auto;z-index:10;width:100%;height:100%;max-width:none;display:flex;flex-direction:column;min-height:0}
      *{box-sizing:border-box} [hidden]{display:none!important}
      button,select,input[type=text]{font:inherit;color:inherit;background:#1e252c;border:1px solid #ffffff24;border-radius:4px;padding:3px 7px}
      button:hover:not(:disabled),select:hover:not(:disabled){background:#28313a;border-color:#ffffff3d}
      button,select{cursor:pointer} select{margin-left:auto;max-width:175px} label:has(:disabled){opacity:.4}
      .pill{display:block;margin-left:auto;margin-bottom:6px}
      :host([data-layout=inspector]) .pill{display:none}
      section{width:285px;max-width:calc(100vw - 20px);max-height:calc(100dvh - 58px);overflow:auto;background:#111519f5;border:1px solid #ffffff24;border-radius:8px;padding:10px}
      :host([data-layout=inspector]) section{width:100%;max-width:none;max-height:none;height:100%;border:0;border-radius:0;background:#12161b;padding:10px 12px;display:flex;flex-direction:column;overflow:hidden}
      :host([data-layout=inspector]) [data-controls]{flex:1;overflow-y:auto;padding-right:2px;margin-right:-2px}
      header{font:10px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-line;font-variant-numeric:tabular-nums;margin-bottom:8px;color:#9fb0bd;padding-bottom:6px;border-bottom:1px solid #ffffff14;overflow:hidden;text-overflow:ellipsis}
      nav{display:flex;gap:5px;margin-bottom:6px}
      label{display:flex;align-items:center;gap:7px;padding:4px 2px;cursor:pointer;border-radius:4px}
      input{accent-color:#7cc5d6;margin:0}
      label.range{display:grid;grid-template-columns:1fr auto;gap:3px 7px}
      input[type=range]{grid-column:1 / -1;width:100%;cursor:ew-resize;height:14px}
      input.exact{width:72px;padding:1px 4px;text-align:right;font-variant-numeric:tabular-nums}
      output{text-align:right;font:10.5px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-numeric:tabular-nums;color:#b8c7d2;cursor:ew-resize;padding:1px 4px;border-radius:3px;user-select:none}
      output:hover{background:#ffffff12;color:#e4e9ed}
      h3{display:flex;align-items:center;justify-content:space-between;font:600 10.5px/1.4 system-ui,-apple-system,sans-serif;letter-spacing:.02em;margin:10px 0 4px;padding-top:6px;border-top:1px solid #ffffff14;color:#99a8b4}
      h3:first-child{margin-top:2px;padding-top:0;border-top:0}
      .fold{border:0;padding:2px 0;background:none;font-weight:600;color:#c7d3dc;text-align:left}
      .fold:hover{background:none!important;color:#fff}
      .actions{display:flex;gap:4px}
      .actions button{padding:2px 5px;font-size:10px;color:#b4c2cc}
      button[data-key]{width:100%;margin:3px 0;padding:5px 8px;text-align:center;font-weight:500;background:#202932}
      button:disabled{opacity:.38;cursor:default}
      [data-active=true],button:focus-visible,select:focus-visible{outline:1.5px solid #7cc5d6;outline-offset:1px;border-radius:4px;background:#1a232b}
      :host([data-capture=focus]:not(:focus-within)) [data-active=true]{outline-color:transparent;background:none}
      .search{position:sticky;top:0;background:#12161b;z-index:2;padding-bottom:6px;margin-bottom:6px;border-bottom:1px solid #ffffff1a}
      .search input{width:100%}
      [role=listbox]{max-height:180px;overflow:auto;margin-top:4px;display:flex;flex-direction:column;gap:2px}
      [role=option]{display:block;width:100%;text-align:left;font-size:10.5px}
      [aria-selected=true]{background:#2e4350;border-color:#7cc5d666} [aria-invalid=true]{outline:2px solid #f88}
      .hint{position:sticky;bottom:-10px;margin:8px -4px -4px;padding:5px 4px;background:#111519;color:#8fa0ad;font-size:9.5px;white-space:nowrap;overflow-x:auto;border-top:1px solid #ffffff12}
      :host([data-layout=inspector]) .hint{display:none}
      .field{display:contents} .rst,.pin,.gmods{display:none}
      :host([data-layout=inspector]){--acc:var(--lab-accent,#4d8dff);--tx:#d8dbe0;--tx2:#8b9098;--tx3:#5b6068;--line:#23252a;--line2:#2c2f35;--fieldbg:#0e0f11;--mono:ui-monospace,"SF Mono",Menlo,monospace;color:var(--tx);font:12px/1.3 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif}
      :host([data-layout=inspector]) section{background:#141518;padding:0}
      :host([data-layout=inspector]) header{display:none}
      :host([data-layout=inspector]) nav{padding:4px 8px;margin:0;border-bottom:1px solid var(--line)}
      :host([data-layout=inspector]) [data-controls]{padding:0 0 28px;margin:0}
      :host([data-layout=inspector]) .search{padding:6px 8px;margin:0;background:#141518;border-color:var(--line)}
      :host([data-layout=inspector]) button,:host([data-layout=inspector]) select,:host([data-layout=inspector]) input[type=text]{background:var(--fieldbg);border:0;box-shadow:inset 0 0 0 1px var(--line);border-radius:3px;font-size:11px}
      :host([data-layout=inspector]) h3{height:24px;margin:0;padding:0 4px 0 2px;border-top:1px solid var(--line);gap:4px;font:600 11px/1 inherit;color:var(--tx);letter-spacing:0}
      :host([data-layout=inspector]) h3:first-child{border-top:0}
      :host([data-layout=inspector]) h3:hover{background:#ffffff08}
      :host([data-layout=inspector]) .fold{flex:1;min-width:0;height:22px;box-shadow:none;background:none;color:var(--tx);font-weight:600;font-size:11px;padding:0 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      :host([data-layout=inspector]) .gmods{display:inline;font:600 10px/1 var(--mono);color:var(--acc);padding:0 4px}
      :host([data-layout=inspector]) .actions{opacity:0;gap:1px}
      :host([data-layout=inspector]) h3:hover .actions,:host([data-layout=inspector]) h3:focus-within .actions,:host([data-layout=inspector]) h3[data-active=true] .actions{opacity:1}
      :host([data-layout=inspector]) .actions button{width:20px;height:18px;padding:0;box-shadow:none;background:none;color:var(--tx3);font-size:0;display:grid;place-items:center}
      :host([data-layout=inspector]) .actions button::before{font-size:12px;line-height:1}
      :host([data-layout=inspector]) .actions button[aria-label^="Randomize"]::before{content:"⚄"}
      :host([data-layout=inspector]) .actions button[aria-label^="Reset"]::before{content:"↺"}
      :host([data-layout=inspector]) .actions button[data-copy]::before{content:"⧉"}
      :host([data-layout=inspector]) .actions button:hover:not(:disabled){background:#ffffff12;color:var(--tx)}
      :host([data-layout=inspector]) label{display:grid;grid-template-columns:42% minmax(0,1fr) 16px 16px;align-items:center;gap:0 5px;height:24px;padding:0 4px 0 12px;border-radius:0;cursor:default}
      :host([data-layout=inspector]) label:hover{background:#ffffff07}
      :host([data-layout=inspector]) label.range{grid-template-columns:42% minmax(0,1fr) 16px 16px;gap:0 5px}
      :host([data-layout=inspector]) .name{grid-column:1;grid-row:1;color:var(--tx2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
      :host([data-layout=inspector]) label[data-modified=true] .name{color:var(--tx)}
      :host([data-layout=inspector]) label[data-boundary=spawn] .name::after{content:"";display:inline-block;width:5px;height:5px;margin-left:5px;border-radius:50%;background:#d9a03c;vertical-align:middle}
      :host([data-layout=inspector]) .field output{white-space:nowrap;overflow:hidden}
      :host([data-layout=inspector]) label > select{grid-column:2;grid-row:1;max-width:none;width:100%;min-width:0;margin:0;height:18px;padding:0 4px}
      :host([data-layout=inspector]) label > input[type=checkbox]{grid-column:2;grid-row:1;justify-self:start;width:14px;height:14px;accent-color:var(--acc)}
      :host([data-layout=inspector]) label[data-modified=true] > select{color:color-mix(in srgb,var(--acc) 70%,var(--tx));box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--acc) 45%,transparent)}
      :host([data-layout=inspector]) label[data-modified=true] > input[type=checkbox]{outline:1px solid color-mix(in srgb,var(--acc) 50%,transparent);outline-offset:2px}
      :host([data-layout=inspector]) .field{grid-column:2;grid-row:1;display:block;position:relative;height:18px;border-radius:3px;background:var(--fieldbg);box-shadow:inset 0 0 0 1px var(--line);overflow:hidden}
      :host([data-layout=inspector]) .field::before{content:"";position:absolute;left:0;top:0;bottom:0;width:calc(var(--p,0) * 100%);background:#d8dbe012;pointer-events:none}
      :host([data-layout=inspector]) label[data-modified=true] .field::before{background:color-mix(in srgb,var(--acc) 20%,transparent)}
      :host([data-layout=inspector]) .field:hover{box-shadow:inset 0 0 0 1px var(--line2)}
      :host([data-layout=inspector]) .field input[type=range]{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;pointer-events:none}
      :host([data-layout=inspector]) .field output{position:absolute;inset:0;display:flex;align-items:center;justify-content:flex-end;padding:0 6px;border-radius:3px;font:11px/1 var(--mono);color:var(--tx);background:none}
      :host([data-layout=inspector]) .field output:hover{background:none}
      :host([data-layout=inspector]) label[data-modified=true] output{color:color-mix(in srgb,var(--acc) 70%,var(--tx));font-weight:600}
      :host([data-layout=inspector]) .field input.exact{position:absolute;inset:0;width:100%;height:100%;padding:0 6px;text-align:right;font:11px/1 var(--mono);box-shadow:inset 0 0 0 1px var(--acc)}
      :host([data-layout=inspector]) .rst,:host([data-layout=inspector]) .pin{display:grid;place-items:center;width:16px;height:16px;padding:0;box-shadow:none;background:none;color:var(--tx3);visibility:hidden}
      :host([data-layout=inspector]) .rst{grid-column:3;grid-row:1} :host([data-layout=inspector]) .pin{grid-column:4;grid-row:1}
      :host([data-layout=inspector]) label[data-modified=true] .rst{visibility:visible;color:var(--acc)}
      :host([data-layout=inspector]) label:hover .pin,:host([data-layout=inspector]) .pin[aria-pressed=true]{visibility:visible}
      :host([data-layout=inspector]) .pin[aria-pressed=true]{color:var(--acc)}
      :host([data-layout=inspector]) .rst:hover,:host([data-layout=inspector]) .pin:hover{background:#ffffff12!important;color:var(--tx)}
      :host([data-layout=inspector]) button[data-key]{display:inline-flex;align-items:center;width:auto;height:20px;margin:3px 0 3px 8px;padding:0 8px;font-weight:500;background:#191a1e;color:var(--tx)}
      :host([data-layout=inspector]) h3 + button[data-key],:host([data-layout=inspector]) label + button[data-key]{margin-left:12px}
      :host([data-layout=inspector]) button[data-key]:hover:not(:disabled){background:#1e2024;box-shadow:inset 0 0 0 1px var(--line2)}
      :host([data-layout=inspector]) [data-active=true]{outline:0;background:color-mix(in srgb,var(--acc) 14%,transparent);border-radius:0}
      :host([data-layout=inspector]) button[data-key][data-active=true]{box-shadow:inset 0 0 0 1px var(--acc);border-radius:3px}
      :host([data-layout=inspector][data-capture=focus]:not(:focus-within)) [data-active=true]{background:none}
      :host([data-layout=inspector][data-capture=focus]:not(:focus-within)) button[data-key][data-active=true]{background:#191a1e;box-shadow:inset 0 0 0 1px var(--line)}
      :host([data-layout=inspector]) [data-flash=true]{animation:flash 1.3s ease-out}
      @keyframes flash{0%,35%{background:color-mix(in srgb,var(--acc) 38%,transparent)}100%{background:transparent}}
      :host([data-layout=inspector]) .empty{padding:12px;color:var(--tx3)}
    </style><button class="pill" type="button" aria-expanded="false">~ Lab</button><section aria-label="Debug controls"><header>FPS — · Frame ms — / —\nGPU ms —</header><nav><button data-preset="on">All On</button><button data-preset="off">All Off</button></nav><div class="search" hidden><input type="text" aria-label="Search controls" role="combobox" aria-autocomplete="list" aria-controls="lab-matches" aria-expanded="true" placeholder="Filter inspector controls…"><div id="lab-matches" role="listbox"></div></div><div data-controls></div><div class="empty" hidden>No matching settings</div><div class="hint">↑↓ · ←→ ⇧/⌥ · ↵/␣ · Esc · /⌘K · ⇥/⇧⇥ · R · 0/⇧0 · C · ~</div></section>`
    this.panel = root.querySelector("section")!
    this.header = root.querySelector("header")!
    this.pill = root.querySelector(".pill")!
    this.searchBox = root.querySelector(".search input")!
    this.results = root.querySelector("[role=listbox]")!
    root.querySelector<HTMLElement>(".hint")!.title = "↑↓ rows · ←→ adjust · Shift ×10 / Alt ×0.1 · Enter/Space edit or fold · Esc cancel/close · / or Cmd-K search · Tab/Shift-Tab groups · R randomize group · 0 reset control / Shift-0 group · C copy JSON · Backquote close"
    this.addControls(settings, controls)
    root.querySelectorAll<HTMLButtonElement>("[data-preset]").forEach(button => {
      button.onclick = () => {
        const before = this.snapshotSettings()
        for (const {control:c} of this.navigation.rows) if (c && c.type !== "action" && !("min" in c) && !("options" in c)) this.navigation.set(c, button.dataset.preset === "on" ? c.on ?? true : c.off ?? false)
        this.commitTransaction(button.dataset.preset === "on" ? "All On" : "All Off", before)
        this.sync()
      }
    })
    this.pill.onclick = () => this.toggle()
    this.searchBox.oninput = () => { this.match = 0; this.search() }
    for (const type of ["pointerdown", "pointerup", "pointermove", "mousedown", "mouseup", "mousemove", "click", "dblclick", "wheel", "touchstart", "touchmove", "touchend", "contextmenu"]) {
      this.host.addEventListener(type, event => {
        if (type === "pointermove" && event instanceof PointerEvent) {
          this.lastPointerX = event.clientX
          if (this.fScrub && ("min" in this.fScrub.control)) {
            const c = this.fScrub.control
            const step = (c.step ?? 0.01) * (event.shiftKey ? 10 : 1) * (event.altKey ? 0.1 : 1)
            const steps = Math.trunc((event.clientX - this.fScrub.startX) / 4)
            const next = Number(Math.max(c.min, Math.min(c.max, this.fScrub.startValue + steps * step)).toPrecision(12))
            this.navigation.set(c, next)
            this.sync()
          }
        }
        event.stopPropagation()
        if (["pointerdown", "mousedown", "touchstart"].includes(type)) release()
      })
    }
    this.host.addEventListener("focusin", () => this.onFocusChange?.(true, this.navigation.active))
    this.host.addEventListener("focusout", event => {
      if (!this.host.contains(event.relatedTarget as Node | null)) this.onFocusChange?.(false, this.navigation.active)
    })
    for (const type of ["keydown", "keyup", "keypress"] as const) window.addEventListener(type, event => this.keyboard(event), { capture: true, signal: this.events.signal })
    // Comparison panes deliver keys as messages rather than DOM keyboard events.
    window.addEventListener("message", event => {
      const m = event.data
      if (!params.has("mux") || event.source !== parent || event.origin !== (document.referrer ? new URL(document.referrer).origin : location.origin) || m?.run !== (params.get("muxRun") ?? "")) return
      if (m.type !== "mux-key" || !["keydown", "keyup"].includes(m.kind) || typeof m.key !== "string" || typeof m.code !== "string") return
      const key = new KeyboardEvent(m.kind, { key: m.key, code: m.code, shiftKey: m.shiftKey, altKey: m.altKey, metaKey: m.metaKey, ctrlKey: m.ctrlKey })
      if (this.keyboard(key, true)) event.stopImmediatePropagation()
    }, { capture: true, signal: this.events.signal })
    window.addEventListener("blur", () => {
      this.held.clear()
      if (this.fScrub) {
        this.navigation.set(this.fScrub.control, this.fScrub.startValue)
        this.fScrub = null
        this.sync()
      }
      if (this.visible) release()
    }, { signal: this.events.signal })
    const lab = (typeof options === "object" ? options.open : undefined) ?? (params.get("perf") === "1" || params.get("lab") === "1")
    this.panel.hidden = true
    this.pill.hidden = !lab || this.layoutMode === "inspector"
    if (this.layoutMode !== "inspector") document.body.append(this.host)
    if (lab) {
      if (this.layoutMode === "inspector") {
        this.panel.hidden = false
        this.sync()
      } else {
        this.toggle()
      }
    } else this.sync()
    this.detachControl = attachLabPanelControl(this)
  }

  isInteracting(): boolean {
    return this.gestureBefore !== null || this.fScrub !== null || this.editor !== null
  }

  private snapshotSettings(): LabSettings {
    const out: LabSettings = {}
    for (const key of Object.keys(this.navigation.settings)) out[key] = this.navigation.settings[key]!
    return out
  }

  private commitTransaction(label: string, before: LabSettings | null) {
    if (!before || !this.onTransaction) return
    const after = this.snapshotSettings()
    const changed = Object.keys(after).some(k => after[k] !== before[k])
    if (changed) this.onTransaction(label, before, after)
  }

  clearControls() {
    this.cancelEdit()
    this.fScrub = null; this.gestureBefore = null
    this.navigation.rows.length = 0; this.navigation.active = undefined
    this.navigation.folded.clear()
    for (const key of Object.keys(this.navigation.settings)) delete this.navigation.settings[key]
    for (const key of Object.keys(this.navigation.defaults)) delete this.navigation.defaults[key]
    this.inputs.clear(); this.elements.clear(); this.copies.clear()
    this.baseOrder.length = 0
    this.host.shadowRoot!.querySelector("[data-controls]")!.replaceChildren()
    this.host.shadowRoot!.querySelector<HTMLElement>("nav")!.hidden = true
  }
  /** `defaults` supplies approved values for Reset and modified highlighting; otherwise the current values are captured. */
  addControls(settings: LabSettings, controls: readonly LabControl[], defaults?: Readonly<LabSettings>) {
    for (const c of controls) if (c.type !== "action") {
      Object.defineProperty(this.navigation.settings, c.key, { configurable: true, enumerable: true, get: () => settings[c.key], set: value => { settings[c.key] = value } })
      if (!(c.key in this.navigation.defaults)) this.navigation.defaults[c.key] = defaults && c.key in defaults ? defaults[c.key]! : settings[c.key]!
    }
    for (const c of controls) { const g = c.group ?? "Controls"; if (!this.baseOrder.includes(g)) this.baseOrder.push(g) }
    const added = this.navigation.append(controls)
    for (const row of added) {
      const element = row.control ? this.control(row.control) : this.group(row.group)
      element.tabIndex = -1; element.dataset.row = row.control?.key ?? row.group
      element.addEventListener("pointerdown", event => { if (event.target !== this.editor) this.cancelEdit(); this.navigation.active = row; this.sync(); this.onFocusChange?.(true, row) })
      element.addEventListener("focusin", () => { this.navigation.active = row; this.sync(); this.onFocusChange?.(true, row) })
      this.elements.set(row, element)
    }
    this.host.shadowRoot!.querySelector<HTMLElement>("nav")!.hidden = !this.allowPresets || !this.navigation.rows.some(({ control: c }) => c && c.type !== "action" && !("min" in c) && !("options" in c))
    this.sync()
  }
  private group(group: string) {
    const heading = document.createElement("h3"), fold = document.createElement("button"), actions = document.createElement("span")
    fold.className = "fold"; fold.type = "button"; fold.dataset.group = group
    fold.onclick = () => { this.navigation.active = this.navigation.rows.find(row => !row.control && row.group === group); this.navigation.fold(); this.focus() }
    const random = document.createElement("button")
    random.type = "button"; random.textContent = "Randomize"; random.setAttribute("aria-label", `Randomize ${group}`)
    random.onclick = () => {
      const custom = this.navigation.rows.find(row => row.group === group && row.control?.type === "action" && row.control.label === `Randomize ${group}`)
      if (custom) {
        ;(this.elements.get(custom) as HTMLButtonElement | undefined)?.click()
        return
      }
      const before = this.snapshotSettings()
      this.navigation.randomize(group)
      this.commitTransaction(`Randomize ${group}`, before)
      this.sync()
    }
    const reset = document.createElement("button")
    reset.type = "button"; reset.textContent = "Reset"; reset.setAttribute("aria-label", `Reset ${group}`)
    reset.onclick = () => {
      const before = this.snapshotSettings()
      this.navigation.reset(true, group)
      this.commitTransaction(`Reset ${group}`, before)
      this.sync()
    }
    const copy = document.createElement("button")
    copy.type = "button"; copy.textContent = "Copy"; copy.dataset.copy = ""; copy.setAttribute("aria-label", `Copy ${group} JSON`)
    copy.onclick = () => { void this.copy(group) }
    this.copies.set(group, copy)
    const mods = document.createElement("span")
    mods.className = "gmods"; mods.dataset.mods = ""; mods.title = "Modified settings in this group"
    actions.className = "actions"; actions.hidden = !this.groupActions; actions.append(random, reset, copy); heading.append(fold, mods, actions)
    return heading
  }
  private control(c: LabControl) {
    if (c.type === "action") {
      const button = document.createElement("button")
      button.type = "button"; button.dataset.key = c.key; button.textContent = c.label
      button.onclick = async () => {
        if (c.enabled?.(this.navigation.settings) === false) return
        const before = this.snapshotSettings()
        button.disabled = true
        try {
          await c.run(button)
          this.commitTransaction(c.label, before)
        } catch (error) { button.textContent = "Failed"; console.error(error) }
        finally { button.disabled = false; this.sync() }
      }
      return button
    }
    const label = document.createElement("label")
    const name = document.createElement("span")
    name.className = "name"; name.textContent = c.label; name.title = c.label
    let input: HTMLInputElement | HTMLSelectElement
    if ("options" in c) {
      const select = document.createElement("select")
      for (const option of c.options) select.add(new Option(option.label, String(option.value)))
      select.onchange = () => {
        const option = c.options.find(o => String(o.value) === select.value)
        if (option) {
          const before = this.snapshotSettings()
          this.navigation.set(c, option.value)
          this.commitTransaction(c.label, before)
        }
        this.sync()
      }
      input = select; label.append(name, select)
    } else {
      input = document.createElement("input")
      if ("min" in c) {
        label.className = "range"; input.type = "range"
        input.min = String(c.min); input.max = String(c.max); input.step = "any"
        let rangeBefore: LabSettings | null = null
        input.addEventListener("pointerdown", () => { rangeBefore = this.snapshotSettings() })
        input.oninput = () => {
          rangeBefore ??= this.snapshotSettings()
          this.navigation.set(c, (input as HTMLInputElement).valueAsNumber)
          this.sync()
        }
        input.onchange = () => {
          this.commitTransaction(c.label, rangeBefore)
          rangeBefore = null
        }
        const output = document.createElement("output")
        output.title = "Drag horizontally to scrub (Shift ×10, Alt ×0.1) · Double-click for exact entry"
        output.ondblclick = () => this.edit()
        let scrubStart: { x: number; value: number; before: LabSettings; moved: boolean } | null = null
        output.addEventListener("pointerdown", event => {
          if (c.enabled?.(this.navigation.settings) === false || event.button !== 0) return
          event.preventDefault()
          output.setPointerCapture(event.pointerId)
          scrubStart = {
            x: event.clientX,
            value: Number(this.navigation.settings[c.key]),
            before: this.snapshotSettings(),
            moved: false,
          }
        })
        output.addEventListener("pointermove", event => {
          if (!scrubStart) return
          const dx = event.clientX - scrubStart.x
          if (Math.abs(dx) < 3 && !scrubStart.moved) return
          scrubStart.moved = true
          const step = (c.step ?? 0.01) * (event.shiftKey ? 10 : 1) * (event.altKey ? 0.1 : 1)
          const steps = Math.trunc(dx / 4)
          const next = Number(Math.max(c.min, Math.min(c.max, scrubStart.value + steps * step)).toPrecision(12))
          this.navigation.set(c, next)
          this.sync()
        })
        const finishScrub = () => {
          if (!scrubStart) return
          if (scrubStart.moved) this.commitTransaction(c.label, scrubStart.before)
          scrubStart = null
        }
        output.addEventListener("pointerup", finishScrub)
        output.addEventListener("pointercancel", finishScrub)
        const field = document.createElement("span")
        field.className = "field"; field.append(output, input)
        label.append(name, field)
      } else {
        input.type = "checkbox"
        input.onchange = () => {
          const before = this.snapshotSettings()
          this.navigation.set(c, (input as HTMLInputElement).checked ? c.on ?? true : c.off ?? false)
          this.commitTransaction(c.label, before)
          this.sync()
        }
        label.append(input, name)
      }
    }
    input.dataset.key = c.key; input.setAttribute("aria-label", c.label)
    this.inputs.set(c, input)
    if (this.layoutMode === "inspector") {
      const reset = document.createElement("button")
      reset.type = "button"; reset.className = "rst"; reset.tabIndex = -1; reset.innerHTML = RESET_ICON
      reset.title = "Reset to default (0)"; reset.setAttribute("aria-label", `Reset ${c.label} to default`)
      reset.onclick = event => { event.preventDefault(); this.resetControl(c.key) }
      label.append(reset)
      if (this.onPin) {
        const pin = document.createElement("button")
        pin.type = "button"; pin.className = "pin"; pin.tabIndex = -1; pin.innerHTML = PIN_ICON
        pin.title = "Pin to Watch"; pin.setAttribute("aria-label", `Pin ${c.label} to Watch`)
        pin.onclick = event => {
          event.preventDefault()
          const row = this.navigation.rows.find(r => r.control === c)
          this.onPin?.(c, row?.group ?? c.group ?? "Controls")
          this.sync()
        }
        label.append(pin)
      }
    }
    return label
  }

  /** Reset one control to its default as a single authored transaction. */
  resetControl(key: string): boolean {
    const row = this.navigation.rows.find(r => r.control?.key === key)
    const c = row?.control
    if (!c || c.type === "action" || !(key in this.navigation.defaults)) return false
    const before = this.snapshotSettings()
    this.navigation.set(c, this.navigation.defaults[key]!)
    this.commitTransaction(`Reset ${c.label}`, before)
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

  /** Apply Details ordering and filtering (inspector layout). Re-sorts rows and remounts their elements. */
  setView(view: LabPanelView) {
    this.view = view
    this.navigation.filter = view.filter ? row => view.filter!(row, Boolean(row.control && this.navigation.isModified(row.control))) : undefined
    const order = view.order ?? []
    const rank = (group: string) => {
      const i = order.indexOf(group)
      return i >= 0 ? i : order.length + Math.max(0, this.baseOrder.indexOf(group))
    }
    const sorted = this.navigation.rows.map((row, index) => ({ row, index })).sort((a, b) => rank(a.row.group) - rank(b.row.group) || a.index - b.index).map(x => x.row)
    const changed = sorted.some((row, i) => row !== this.navigation.rows[i])
    if (changed) {
      this.navigation.rows.splice(0, this.navigation.rows.length, ...sorted)
      this.host.shadowRoot!.querySelector("[data-controls]")!.replaceChildren()
    }
    this.sync()
  }

  get currentView(): LabPanelView { return this.view }

  /** Unfold, activate, scroll to and flash a control row. Returns false if the key is not mounted or not visible. */
  reveal(key: string, focus = true): boolean {
    const row = this.navigation.rows.find(r => r.control?.key === key)
    if (!row || !this.navigation.isRowVisible(row)) return false
    if (!this.visible) this.toggle()
    this.navigation.jump(row)
    this.sync()
    const element = this.elements.get(row)
    if (!element) return false
    if (focus) element.focus({ preventScroll: true })
    element.scrollIntoView({ block: "center" })
    element.dataset.flash = "false"
    void element.offsetWidth
    element.dataset.flash = "true"
    setTimeout(() => { if (element.dataset.flash === "true") element.dataset.flash = "false" }, 1400)
    return true
  }
  /** Locate a control row element without stealing focus; optionally unfolds its group and opens a hidden floating panel. */
  getControlElement(key: string, revealIfFolded = false): HTMLElement | null {
    const row = this.navigation.rows.find(r => r.control?.key === key)
    if (!row || !this.navigation.isRowVisible(row)) return null
    if (revealIfFolded) {
      let changed = false
      if (!this.visible) {
        this.pill.hidden = false
        this.panel.hidden = false
        changed = true
      }
      if (this.navigation.folded.has(row.group)) {
        this.navigation.folded.delete(row.group)
        changed = true
      }
      if (changed) this.sync()
      this.elements.get(row)?.scrollIntoView({ block: "nearest" })
    }
    return this.elements.get(row) ?? null
  }
  /** Refresh values advanced by the game outside panel input. */
  refresh(): void { this.sync() }

  sync() {
    this.pill.setAttribute("aria-expanded", String(this.visible))
    const container = this.host.shadowRoot!.querySelector("[data-controls]")!
    if (this.navigation.active && !this.navigation.isRowVisible(this.navigation.active)) {
      this.navigation.active = this.navigation.visibleRows[0]
    }
    let cursor: ChildNode | null = container.firstChild
    for (const row of this.navigation.rows) {
      const element = this.elements.get(row)
      if (!element) continue
      const rowVisible = this.navigation.isRowVisible(row)
      if (!rowVisible) {
        if (element.parentElement === container) {
          if (cursor === element) cursor = element.nextSibling
          element.remove()
        }
        continue
      }
      if (element.parentElement !== container) {
        container.insertBefore(element, cursor)
      } else if (cursor === element) {
        cursor = element.nextSibling
      }
      element.hidden = !!row.control && this.navigation.folded.has(row.group)
      element.dataset.active = String(this.visible && row === this.navigation.active)
      if (!row.control) {
        const fold = element.querySelector<HTMLButtonElement>(".fold")!
        fold.textContent = `${this.navigation.folded.has(row.group) ? "▸" : "▾"} ${row.group}`
        fold.setAttribute("aria-expanded", String(!this.navigation.folded.has(row.group)))
        const random = element.querySelector<HTMLButtonElement>(`[aria-label="Randomize ${row.group}"]`)
        if (random) {
          random.hidden = this.navigation.rows.some(r => r.group === row.group && r.control?.type === "action" && r.control.label === `Randomize ${row.group}` && this.navigation.isRowVisible(r))
          random.disabled = !this.navigation.rows.some(r => r.group === row.group && this.navigation.isRowVisible(r) && r.control && ("min" in r.control || ("options" in r.control && r.control.options.length > 0)))
        }
      }
    }
    for (const [c, input] of this.inputs) {
      input.disabled = c.enabled?.(this.navigation.settings) === false
      if ("options" in c || "min" in c) input.value = String(this.navigation.settings[c.key])
      else if (c.type !== "action" && input instanceof HTMLInputElement) input.checked = this.navigation.settings[c.key] === (c.on ?? true)
      if ("min" in c) {
        const raw = inferControlUnit(c.key, c.label, c.unit)
        const unit = this.layoutMode === "inspector" ? raw.replace(/\s*·\s*retrigger$/, "") : raw
        input.parentElement!.querySelector("output")!.value = formatLabValue(this.navigation.settings[c.key]!, c.step, unit)
      }
      if (this.layoutMode === "inspector") {
        const label = input.closest("label")
        if (label) {
          label.dataset.modified = String(this.navigation.isModified(c))
          if (c.unit?.includes("retrigger") && !label.dataset.boundary) {
            label.dataset.boundary = "spawn"
            label.querySelector(".name")?.setAttribute("title", `${c.label} · spawn-time value: retrigger (Space) to see the change`)
          }
          if ("min" in c) {
            const span = c.max - c.min
            const p = span > 0 ? (Number(this.navigation.settings[c.key]) - c.min) / span : 0
            input.parentElement!.style.setProperty("--p", String(Math.max(0, Math.min(1, p))))
          }
          const pin = label.querySelector<HTMLButtonElement>(".pin")
          if (pin) pin.setAttribute("aria-pressed", String(Boolean(this.isPinned?.(c.key))))
        }
      }
    }
    if (this.layoutMode === "inspector") {
      for (const [row, element] of this.elements) {
        if (row.control) continue
        const mods = element.querySelector<HTMLElement>("[data-mods]")
        if (!mods) continue
        let n = 0
        for (const r of this.navigation.rows) if (r.group === row.group && r.control && (!r.control.visible || r.control.visible(this.navigation.settings)) && this.navigation.isModified(r.control)) n++
        mods.textContent = n ? String(n) : ""
      }
      const empty = this.host.shadowRoot!.querySelector<HTMLElement>(".empty")
      if (empty) empty.hidden = !this.navigation.filter || this.navigation.rows.some(r => r.control && this.navigation.isRowVisible(r))
    }
  }
  focusFirst() {
    this.navigation.active ??= this.navigation.visibleRows[0]
    this.focus()
  }
  private focus() {
    this.sync()
    const element = this.navigation.active && this.elements.get(this.navigation.active)
    element?.focus({ preventScroll: true }); element?.scrollIntoView({ block: "nearest" })
  }
  private move(direction: number) {
    const root = this.host.shadowRoot!, presets = root.querySelector<HTMLElement>("nav")!
    const rows = this.navigation.visibleRows
    const elements = [...(presets.hidden ? [] : presets.querySelectorAll<HTMLButtonElement>("button")), ...rows.map(row => this.elements.get(row)!)]
    if (!elements.length) return
    const focused = root.activeElement
    const current = focused instanceof HTMLButtonElement && focused.dataset.preset ? focused : this.navigation.active && this.elements.get(this.navigation.active)
    const index = current ? elements.indexOf(current) : -1
    const next = elements[(index + direction + elements.length) % elements.length]!
    const row = rows.find(row => this.elements.get(row) === next)
    if (row) { this.navigation.active = row; this.focus() }
    else {
      this.sync()
      for (const element of this.elements.values()) element.dataset.active = "false"
      next.focus(); next.scrollIntoView({ block: "nearest" })
    }
  }
  private edit() {
    const c = this.navigation.active?.control
    if (!c || !("min" in c) || c.enabled?.(this.navigation.settings) === false) return
    this.cancelEdit()
    const input = document.createElement("input")
    input.type = "text"; input.inputMode = "decimal"; input.className = "exact"
    input.setAttribute("aria-label", `Exact ${c.label}`); input.value = String(this.navigation.settings[c.key])
    const output = this.inputs.get(c)!.parentElement!.querySelector("output")!
    output.hidden = true; output.after(input)
    this.editor = input; input.focus(); input.select()
  }
  private cancelEdit() {
    if (!this.editor) return
    this.editor.parentElement!.querySelector("output")!.hidden = false
    this.editor.remove(); this.editor = null
  }
  private search() {
    this.matches = this.navigation.search(this.searchBox.value)
    this.match = Math.max(0, Math.min(this.match, this.matches.length - 1))
    this.results.replaceChildren()
    this.matches.forEach((row, index) => {
      const button = document.createElement("button")
      button.id = `lab-match-${index}`; button.type = "button"; button.setAttribute("role", "option")
      button.setAttribute("aria-selected", String(index === this.match))
      button.textContent = `${row.group} / ${row.control!.label}`
      button.onclick = () => this.choose(row)
      this.results.append(button)
    })
    this.searchBox.setAttribute("aria-activedescendant", this.matches.length ? `lab-match-${this.match}` : "")
    this.results.children[this.match]?.scrollIntoView({ block: "nearest" })
  }
  private choose(row: LabRow) { this.searchBox.parentElement!.hidden = true; this.navigation.jump(row); this.focus() }
  private async copy(group = this.navigation.active?.group) {
    if (!group) return
    const button = this.copies.get(group)!
    try { await navigator.clipboard.writeText(this.navigation.json(group)); button.textContent = "Copied" }
    catch { button.textContent = "Copy failed" }
  }
  /** Synthetic mux keys have no browser text-editing default action. */
  private textKey(input: HTMLInputElement, event: KeyboardEvent, forwarded: boolean) {
    if (!forwarded || event.metaKey || event.ctrlKey || event.altKey) return
    const start = input.selectionStart ?? input.value.length, end = input.selectionEnd ?? start
    if (event.key.length === 1) input.setRangeText(event.key, start, end, "end")
    else if (event.key === "Backspace") input.setRangeText("", start === end ? Math.max(0, start - 1) : start, end, "end")
    else if (event.key === "Delete") input.setRangeText("", start, start === end ? end + 1 : end, "end")
    else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const at = event.key === "ArrowLeft" ? Math.max(0, start - 1) : Math.min(input.value.length, end + 1)
      input.setSelectionRange(at, at)
    }
    input.dispatchEvent(new Event("input", { bubbles: true }))
  }
  private keyboard(event: KeyboardEvent, forwarded = false) {
    if (!this.host.isConnected) return false
    const toggle = event.code === "Backquote"
    const target = event.composedPath()[0]
    const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLElement && target.isContentEditable
    if (this.focusOnly && document.activeElement !== this.host && !this.held.has(event.code) && !(toggle && !typing)) return false
    if (!this.visible && !this.held.has(event.code) && !(toggle && !typing)) return false
    const key = event.key.toLowerCase()
    if ((event.metaKey || event.ctrlKey) && !this.editor && this.searchBox.parentElement!.hidden && (key !== "k" || this.layoutMode === "inspector")) {
      return false
    }
    if (
      this.layoutMode === "inspector" &&
      !this.editor &&
      this.searchBox.parentElement!.hidden &&
      !typing &&
      (key === "p" || key === "π" || event.key === "F8" || (event.altKey && (event.code === "KeyP" || event.code === "BracketLeft" || event.code === "BracketRight")))
    ) {
      return false
    }
    event.stopImmediatePropagation()
    if (event.type === "keyup") {
      this.held.delete(event.code)
      if (key === "f" && this.fScrub) {
        this.commitTransaction(this.fScrub.control.label, this.fScrub.before)
        this.fScrub = null
      }
      if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && this.gestureBefore) {
        this.commitTransaction(this.gestureLabel, this.gestureBefore)
        this.gestureBefore = null
      }
      event.preventDefault()
      return true
    }
    if (event.type === "keypress") { if (!this.editor && this.searchBox.parentElement!.hidden) event.preventDefault(); return true }
    const repeat = event.repeat || this.held.has(event.code)
    this.held.add(event.code)
    this.release()
    if (toggle) { event.preventDefault(); if (!repeat) this.toggle(); return true }
    if (!this.visible) { event.preventDefault(); return true }
    if (this.editor) {
      this.editor.focus()
      if (event.key === "Escape") { event.preventDefault(); this.cancelEdit(); this.focus() }
      else if (event.key === "Enter") {
        event.preventDefault()
        const before = this.snapshotSettings()
        const label = this.navigation.active?.control?.label ?? "Exact edit"
        if (this.navigation.exact(this.editor.value)) {
          this.commitTransaction(label, before)
          this.cancelEdit()
          this.focus()
        }
        else this.editor.setAttribute("aria-invalid", "true")
      } else if (event.key === "Tab") { event.preventDefault(); this.cancelEdit(); this.navigation.move(event.shiftKey ? -1 : 1, true); this.focus() }
      else this.textKey(this.editor, event, forwarded)
      return true
    }
    if (!this.searchBox.parentElement!.hidden) {
      this.searchBox.focus()
      if (event.key === "Escape") { event.preventDefault(); this.searchBox.parentElement!.hidden = true; this.focus() }
      else if (event.key === "Enter") { event.preventDefault(); const row = this.matches[this.match]; if (row) this.choose(row) }
      else if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); this.match += event.key === "ArrowDown" ? 1 : -1; this.search() }
      else if (event.key === "Tab") { event.preventDefault(); this.searchBox.focus() }
      else this.textKey(this.searchBox, event, forwarded)
      return true
    }
    event.preventDefault()
    if (event.key === "Escape" && this.fScrub) {
      this.navigation.set(this.fScrub.control, this.fScrub.startValue)
      this.fScrub = null
      this.sync()
      return true
    }
    if (event.key === "/" || (event.metaKey || event.ctrlKey) && key === "k") {
      this.searchBox.parentElement!.hidden = false; this.searchBox.value = ""; this.match = 0; this.search(); this.searchBox.focus(); return true
    }
    if (event.key === "Escape") {
      if (this.layoutMode === "inspector") {
        if (this.previousFocus) this.previousFocus.focus({ preventScroll: true })
        else this.host.blur()
        this.onFocusChange?.(false, this.navigation.active)
      } else {
        this.toggle()
      }
    }
    else if (event.key === "ArrowUp" || event.key === "ArrowDown") this.move(event.key === "ArrowDown" ? 1 : -1)
    else if (event.key === "Tab") { this.navigation.move(event.shiftKey ? -1 : 1, true); this.focus() }
    else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      if (this.navigation.active?.control) {
        if (!this.gestureBefore) {
          this.gestureBefore = this.snapshotSettings()
          this.gestureLabel = this.navigation.active.control.label
        }
        this.navigation.adjust(event.key === "ArrowRight" ? 1 : -1, event.shiftKey, event.altKey)
      }
      else this.navigation.fold(event.key === "ArrowLeft")
      this.focus()
    } else if ((event.key === "Enter" || event.key === " ") && !repeat) {
      const focused = this.host.shadowRoot!.activeElement
      if (focused instanceof HTMLButtonElement && !focused.classList.contains("fold")) focused.click()
      else if (!this.navigation.active?.control) { this.navigation.fold(); this.focus() }
      else if ("min" in this.navigation.active.control) this.edit()
      else {
        const before = this.snapshotSettings()
        this.navigation.adjust(1)
        this.commitTransaction(this.navigation.active.control.label, before)
        this.focus()
      }
    } else if (!event.metaKey && !event.ctrlKey && !event.altKey && !repeat) {
      if (key === "f" && this.navigation.active?.control && "min" in this.navigation.active.control) {
        const c = this.navigation.active.control
        this.fScrub = { control: c, startX: this.lastPointerX, startValue: Number(this.navigation.settings[c.key]), before: this.snapshotSettings() }
      }
      else if (key === "r") {
        const row = this.navigation.rows.find(row => row.group === this.navigation.active?.group && row.control?.type === "action" && row.control.label === `Randomize ${row.group}`)
        if (row) (this.elements.get(row) as HTMLButtonElement).click()
        else {
          const before = this.snapshotSettings()
          this.navigation.randomize()
          this.commitTransaction(`Randomize ${this.navigation.active?.group ?? "Group"}`, before)
        }
      }
      else if (key === "0" || event.shiftKey && (key === ")" || event.code === "Digit0")) {
        const before = this.snapshotSettings()
        this.navigation.reset(event.shiftKey)
        this.commitTransaction(event.shiftKey ? `Reset ${this.navigation.active?.group ?? "Group"}` : `Reset ${this.navigation.active?.control?.label ?? "Control"}`, before)
      }
      else if (key === "c") void this.copy()
      this.sync()
    }
    return true
  }
  setReturnFocus(el: HTMLElement | null) {
    this.previousFocus = el
  }
  toggle() {
    this.release()
    this.cancelEdit(); this.searchBox.parentElement!.hidden = true
    this.panel.hidden = !this.panel.hidden
    if (this.visible) {
      if (this.layoutMode !== "inspector") {
        this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
        this.focus()
      } else {
        this.sync()
      }
    }
    else { this.sync(); this.previousFocus?.focus({ preventScroll: true }) }
    this.onToggle?.(this.visible)
  }
  dispose() { this.detachControl?.(); this.release(); this.events.abort(); this.host.remove() }
  get visible() { return !this.panel.hidden }
}
