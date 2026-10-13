import { LabNavigation, type LabControl, type LabRow, type LabSettings, type LabValue } from "./lab-navigation"
export type { LabControl, LabSettings, LabValue } from "./lab-navigation"

/** Presentation controls. Open panels capture keys before the game's bubble listeners. */
export class LabPanel {
  readonly host = document.createElement("aside")
  readonly header: HTMLElement
  private panel: HTMLElement
  private pill: HTMLButtonElement
  private navigation: LabNavigation
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

  constructor(settings: LabSettings, controls: LabControl[], params: URLSearchParams, private release: () => void, change?: (key: string, value: LabValue) => void) {
    this.navigation = new LabNavigation(settings, controls, (key, value) => {
      change?.(key, value)
      for (const copy of this.copies.values()) copy.textContent = "Copy"
    })
    this.host.dataset.lab = ""
    const root = this.host.attachShadow({ mode: "open" })
    root.innerHTML = `<style>
      :host{position:fixed;z-index:1000;right:10px;top:10px;color:#e4e9ed;font:11px/1.5 system-ui;max-width:calc(100vw - 20px)}
      *{box-sizing:border-box} [hidden]{display:none!important}
      button,select,input[type=text]{font:inherit;color:inherit;background:#263039;border:1px solid #ffffff30;border-radius:5px;padding:4px 7px}
      button,select{cursor:pointer} select{margin-left:auto;max-width:190px} label:has(:disabled){opacity:.4}
      .pill{display:block;margin-left:auto;margin-bottom:6px}
      section{width:285px;max-width:calc(100vw - 20px);max-height:calc(100dvh - 58px);overflow:auto;background:#10161af5;border:1px solid #ffffff30;border-radius:8px;padding:10px}
      header{font:10px/1.6 ui-monospace,monospace;white-space:pre-line;font-variant-numeric:tabular-nums;margin-bottom:8px}
      nav{display:flex;gap:5px;margin-bottom:6px}
      label{display:flex;align-items:center;gap:7px;padding:4px 0;cursor:pointer}
      input{accent-color:#a4dce7;margin:0} label.range{display:grid;grid-template-columns:1fr 65px;gap:2px 7px}
      input[type=range]{grid-column:1 / -1;width:100%;cursor:ew-resize} input.exact{width:65px;padding:2px}
      output{text-align:right;font-variant-numeric:tabular-nums}
      h3{display:flex;align-items:center;justify-content:space-between;font:inherit;font-weight:600;margin:8px 0 3px;color:#a4b1bc}
      .fold{border:0;padding:0;background:none} .actions{display:flex;gap:5px} button:disabled{opacity:.4;cursor:default}
      [data-active=true],button:focus-visible{outline:2px solid #a4dce7;outline-offset:2px;border-radius:3px}
      .search{position:sticky;top:0;background:#10161a;z-index:1} .search input{width:100%}
      [role=listbox]{max-height:180px;overflow:auto} [role=option]{display:block;width:100%;text-align:left}
      [aria-selected=true]{background:#3b5360} [aria-invalid=true]{outline:2px solid #f88}
      .hint{position:sticky;bottom:-10px;margin:8px -4px -4px;padding:4px;background:#10161a;color:#a4b1bc;font-size:9px;white-space:nowrap;overflow-x:auto}
    </style><button class="pill" type="button" aria-expanded="false">~ Lab</button><section aria-label="Debug controls"><header>FPS — · Frame ms — / —\nGPU ms —</header><nav><button data-preset="on">All On</button><button data-preset="off">All Off</button></nav><div class="search" hidden><input type="text" aria-label="Search controls" role="combobox" aria-autocomplete="list" aria-controls="lab-matches" aria-expanded="true"><div id="lab-matches" role="listbox"></div></div><div data-controls></div><div class="hint">↑↓ · ←→ ⇧/⌥ · ↵/␣ · Esc · /⌘K · ⇥/⇧⇥ · R · 0/⇧0 · C · ~</div></section>`
    this.panel = root.querySelector("section")!
    this.header = root.querySelector("header")!
    this.pill = root.querySelector(".pill")!
    this.searchBox = root.querySelector(".search input")!
    this.results = root.querySelector("[role=listbox]")!
    root.querySelector<HTMLElement>(".hint")!.title = "↑↓ rows · ←→ adjust · Shift ×10 / Alt ×0.1 · Enter/Space edit or fold · Esc cancel/close · / or Cmd-K search · Tab/Shift-Tab groups · R randomize group · 0 reset control / Shift-0 group · C copy JSON · Backquote close"
    const rows = root.querySelector("[data-controls]")!
    for (const row of this.navigation.rows) {
      const element = row.control ? this.control(row.control) : this.group(row.group)
      element.tabIndex = -1
      element.dataset.row = row.control?.key ?? row.group
      element.addEventListener("pointerdown", event => { if (event.target !== this.editor) this.cancelEdit(); this.navigation.active = row; this.sync() })
      element.addEventListener("focusin", () => { this.navigation.active = row; this.sync() })
      this.elements.set(row, element)
      rows.append(element)
    }
    root.querySelector<HTMLElement>("nav")!.hidden = !controls.some(c => !("min" in c) && !("options" in c))
    root.querySelectorAll<HTMLButtonElement>("[data-preset]").forEach(button => {
      button.onclick = () => {
        for (const c of controls) if (!("min" in c) && !("options" in c)) this.navigation.set(c, button.dataset.preset === "on" ? c.on ?? true : c.off ?? false)
        this.sync()
      }
    })
    this.pill.onclick = () => this.toggle()
    this.searchBox.oninput = () => { this.match = 0; this.search() }
    for (const type of ["pointerdown", "pointerup", "pointermove", "mousedown", "mouseup", "mousemove", "click", "dblclick", "wheel", "touchstart", "touchmove", "touchend", "contextmenu"]) {
      this.host.addEventListener(type, event => {
        event.stopPropagation()
        if (["pointerdown", "mousedown", "touchstart"].includes(type)) release()
      })
    }
    for (const type of ["keydown", "keyup", "keypress"] as const) window.addEventListener(type, event => this.keyboard(event), { capture: true, signal: this.events.signal })
    // Comparison panes deliver keys as messages rather than DOM keyboard events.
    window.addEventListener("message", event => {
      const m = event.data
      if (!params.has("mux") || event.source !== parent || event.origin !== (document.referrer ? new URL(document.referrer).origin : location.origin) || m?.run !== (params.get("muxRun") ?? "")) return
      if (m.type !== "mux-key" || !["keydown", "keyup"].includes(m.kind) || typeof m.key !== "string" || typeof m.code !== "string") return
      const key = new KeyboardEvent(m.kind, { key: m.key, code: m.code, shiftKey: m.shiftKey, altKey: m.altKey, metaKey: m.metaKey, ctrlKey: m.ctrlKey })
      if (this.keyboard(key, true)) event.stopImmediatePropagation()
    }, { capture: true, signal: this.events.signal })
    window.addEventListener("blur", () => { this.held.clear(); if (this.visible) release() }, { signal: this.events.signal })
    const lab = params.get("perf") === "1" || params.get("lab") === "1"
    this.panel.hidden = true
    this.pill.hidden = !lab
    document.body.append(this.host)
    if (lab) this.toggle()
    else this.sync()
  }

  private group(group: string) {
    const heading = document.createElement("h3"), fold = document.createElement("button"), actions = document.createElement("span")
    fold.className = "fold"; fold.type = "button"; fold.dataset.group = group
    fold.onclick = () => { this.navigation.active = this.navigation.rows.find(row => !row.control && row.group === group); this.navigation.fold(); this.focus() }
    const random = document.createElement("button")
    random.type = "button"; random.textContent = "Randomize"; random.setAttribute("aria-label", `Randomize ${group}`)
    random.disabled = !this.navigation.rows.some(row => row.group === group && row.control && ("min" in row.control || "options" in row.control && row.control.options.length > 0))
    random.onclick = () => { this.navigation.randomize(group); this.sync() }
    const reset = document.createElement("button")
    reset.type = "button"; reset.textContent = "Reset"; reset.setAttribute("aria-label", `Reset ${group}`)
    reset.onclick = () => {
      this.navigation.active = this.navigation.rows.find(row => !row.control && row.group === group)
      this.navigation.reset(true); this.sync()
    }
    const copy = document.createElement("button")
    copy.type = "button"; copy.textContent = "Copy"; copy.dataset.copy = ""; copy.setAttribute("aria-label", `Copy ${group} JSON`)
    copy.onclick = () => { void this.copy(group) }
    this.copies.set(group, copy)
    actions.className = "actions"; actions.append(random, reset, copy); heading.append(fold, actions)
    return heading
  }
  private control(c: LabControl) {
    const label = document.createElement("label")
    let input: HTMLInputElement | HTMLSelectElement
    if ("options" in c) {
      const select = document.createElement("select")
      for (const option of c.options) select.add(new Option(option.label, String(option.value)))
      select.onchange = () => {
        const option = c.options.find(o => String(o.value) === select.value)
        if (option) this.navigation.set(c, option.value)
        this.sync()
      }
      input = select; label.append(c.label, select)
    } else {
      input = document.createElement("input")
      if ("min" in c) {
        label.className = "range"; input.type = "range"
        input.min = String(c.min); input.max = String(c.max); input.step = "any"
        input.oninput = () => { this.navigation.set(c, (input as HTMLInputElement).valueAsNumber); this.sync() }
        const output = document.createElement("output")
        output.ondblclick = () => this.edit()
        label.append(c.label, output, input)
      } else {
        input.type = "checkbox"
        input.onchange = () => { this.navigation.set(c, (input as HTMLInputElement).checked ? c.on ?? true : c.off ?? false); this.sync() }
        label.append(input, c.label)
      }
    }
    input.dataset.key = c.key; input.setAttribute("aria-label", c.label)
    this.inputs.set(c, input)
    return label
  }
  private sync() {
    this.pill.setAttribute("aria-expanded", String(this.visible))
    for (const [row, element] of this.elements) {
      element.hidden = !!row.control && this.navigation.folded.has(row.group)
      element.dataset.active = String(this.visible && row === this.navigation.active)
      if (!row.control) {
        const fold = element.querySelector<HTMLButtonElement>(".fold")!
        fold.textContent = `${this.navigation.folded.has(row.group) ? "▸" : "▾"} ${row.group}`
        fold.setAttribute("aria-expanded", String(!this.navigation.folded.has(row.group)))
      }
    }
    for (const [c, input] of this.inputs) {
      input.disabled = c.enabled?.(this.navigation.settings) === false
      if ("options" in c || "min" in c) input.value = String(this.navigation.settings[c.key])
      else if (input instanceof HTMLInputElement) input.checked = this.navigation.settings[c.key] === (c.on ?? true)
      if ("min" in c) input.parentElement!.querySelector("output")!.value = String(this.navigation.settings[c.key])
    }
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
    if (!this.visible && !this.held.has(event.code) && !(toggle && !typing)) return false
    event.stopImmediatePropagation()
    if (event.type === "keyup") { this.held.delete(event.code); event.preventDefault(); return true }
    if (event.type === "keypress") { if (!this.editor && this.searchBox.parentElement!.hidden) event.preventDefault(); return true }
    const repeat = event.repeat || this.held.has(event.code)
    this.held.add(event.code)
    this.release()
    if (toggle) { event.preventDefault(); if (!repeat) this.toggle(); return true }
    if (!this.visible) { event.preventDefault(); return true }
    const key = event.key.toLowerCase()
    if (this.editor) {
      this.editor.focus()
      if (event.key === "Escape") { event.preventDefault(); this.cancelEdit(); this.focus() }
      else if (event.key === "Enter") {
        event.preventDefault()
        if (this.navigation.exact(this.editor.value)) { this.cancelEdit(); this.focus() }
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
    if (event.key === "/" || (event.metaKey || event.ctrlKey) && key === "k") {
      this.searchBox.parentElement!.hidden = false; this.searchBox.value = ""; this.match = 0; this.search(); this.searchBox.focus(); return true
    }
    if (event.key === "Escape") this.toggle()
    else if (event.key === "ArrowUp" || event.key === "ArrowDown") this.move(event.key === "ArrowDown" ? 1 : -1)
    else if (event.key === "Tab") { this.navigation.move(event.shiftKey ? -1 : 1, true); this.focus() }
    else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      if (this.navigation.active?.control) this.navigation.adjust(event.key === "ArrowRight" ? 1 : -1, event.shiftKey, event.altKey)
      else this.navigation.fold(event.key === "ArrowLeft")
      this.focus()
    } else if ((event.key === "Enter" || event.key === " ") && !repeat) {
      const focused = this.host.shadowRoot!.activeElement
      if (focused instanceof HTMLButtonElement && !focused.classList.contains("fold")) focused.click()
      else if (!this.navigation.active?.control) { this.navigation.fold(); this.focus() }
      else if ("min" in this.navigation.active.control) this.edit()
      else { this.navigation.adjust(1); this.focus() }
    } else if (!event.metaKey && !event.ctrlKey && !event.altKey && !repeat) {
      if (key === "r") this.navigation.randomize()
      else if (key === "0" || event.shiftKey && (key === ")" || event.code === "Digit0")) this.navigation.reset(event.shiftKey)
      else if (key === "c") void this.copy()
      this.sync()
    }
    return true
  }
  toggle() {
    this.release()
    this.cancelEdit(); this.searchBox.parentElement!.hidden = true
    this.panel.hidden = !this.panel.hidden
    if (this.visible) { this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null; this.focus() }
    else { this.sync(); this.previousFocus?.focus({ preventScroll: true }) }
  }
  dispose() { this.release(); this.events.abort(); this.host.remove() }
  get visible() { return !this.panel.hidden }
}
