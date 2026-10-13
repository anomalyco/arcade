export type LabValue = boolean | number | string
export type LabSettings = Record<string, LabValue>
type ControlBase = { key: string; label: string; group?: string; change?: (value: LabValue) => void }
export type LabControl = ControlBase & (
  | { type?: "toggle"; on?: number; off?: number }
  | { type: "select"; options: readonly { label: string; value: string | number }[] }
  | { type: "range"; min: number; max: number; step?: number }
  | { type: "action"; run: (button: HTMLButtonElement) => void | Promise<void> }
)
export type LabOptions = { open?: boolean; presets?: boolean; shortcut?: boolean }
type Binding = { control: LabControl; settings: LabSettings; input: HTMLInputElement | HTMLSelectElement; output?: HTMLOutputElement }

/** Presentation-only switches. No gameplay input leaves this host. */
export class LabPanel {
  readonly host = document.createElement("aside")
  readonly header: HTMLElement
  private panel: HTMLElement
  private pill: HTMLButtonElement
  private bindings: Binding[] = []
  private rows: HTMLElement
  private presets: HTMLElement
  private allowPresets: boolean

  constructor(settings: LabSettings, controls: LabControl[], params: URLSearchParams, release: () => void, options: LabOptions = {}) {
    this.host.dataset.lab = ""
    const root = this.host.attachShadow({ mode: "open" })
    root.innerHTML = `<style>
      :host{position:fixed;z-index:1000;right:10px;top:10px;color:#e4e9ed;font:11px/1.5 system-ui;max-width:calc(100vw - 20px)}
      *{box-sizing:border-box} [hidden]{display:none!important}
      button,select{font:inherit;color:inherit;background:#263039;border:1px solid #ffffff30;border-radius:5px;padding:4px 7px;cursor:pointer}
      .pill{display:block;margin-left:auto;margin-bottom:6px}
      section{width:285px;max-width:calc(100vw - 20px);max-height:calc(100dvh - 58px);overflow:auto;background:#10161af5;border:1px solid #ffffff30;border-radius:8px;padding:10px}
      header{font:10px/1.6 ui-monospace,monospace;white-space:pre-line;font-variant-numeric:tabular-nums;margin-bottom:8px}
      nav{display:flex;gap:5px;margin-bottom:6px}
      label{display:flex;align-items:center;gap:7px;padding:4px 0;cursor:pointer}
       input{accent-color:#a4dce7;margin:0}
       select{margin-left:auto;max-width:195px;min-width:0}
       input[type=range]{margin-left:auto;width:120px;min-width:0}
       output{min-width:30px;text-align:right;font-variant-numeric:tabular-nums}
       .action{margin:4px 7px 4px 0}
       h3{font:inherit;font-weight:600;margin:8px 0 3px;color:#a4b1bc}
    </style><button class="pill" type="button" aria-expanded="false">~ Lab</button><section aria-label="Debug controls"><header>FPS — · Frame ms — / —\nGPU ms —</header><nav><button data-preset="on">All On</button><button data-preset="off">All Off</button></nav><div data-controls></div></section>`
    this.panel = root.querySelector("section")!
    this.presets = root.querySelector<HTMLElement>("nav")!
    this.allowPresets = options.presets !== false
    this.header = root.querySelector("header")!
    this.pill = root.querySelector(".pill")!
    this.rows = root.querySelector<HTMLElement>("[data-controls]")!
    this.addControls(settings, controls)
    root.querySelectorAll<HTMLButtonElement>("[data-preset]").forEach((button) => {
      button.onclick = () => {
        for (const binding of this.bindings) {
          const c = binding.control
          if (c.type && c.type !== "toggle") continue
          this.set(binding, button.dataset.preset === "on" ? c.on ?? true : c.off ?? false)
        }
        this.sync()
      }
    })
    this.pill.onclick = () => this.toggle()
    for (const type of ["pointerdown", "pointerup", "pointermove", "mousedown", "mouseup", "mousemove", "click", "dblclick", "wheel", "touchstart", "touchmove", "touchend", "keydown", "keyup", "contextmenu"]) {
      this.host.addEventListener(type, (event) => {
        event.stopPropagation()
        if (["pointerdown", "mousedown", "touchstart"].includes(type)) release()
        if (event instanceof KeyboardEvent && event.code === "Backquote") {
          event.preventDefault()
          if (type === "keydown" && !event.repeat) this.toggle()
        }
      })
    }
    // Games already own their input shortcut; standalone consumers can opt into the shared listener.
    if (options.shortcut) addEventListener("keydown", event => {
      if (event.code !== "Backquote" || event.repeat || event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return
      event.preventDefault()
      this.toggle()
    })
    const lab = options.open ?? (params.get("perf") === "1" || params.get("lab") === "1")
    this.panel.hidden = !lab
    this.pill.hidden = !lab
    this.sync()
    document.body.append(this.host)
  }

  /** Replace section controls while preserving the shell, shortcut and telemetry. */
  clearControls() {
    this.bindings.length = 0
    this.rows.replaceChildren()
    this.presets.hidden = true
  }

  /** Bind additional game-owned settings without copying them into another state object. */
  addControls(settings: LabSettings, controls: readonly LabControl[]) {
    let group: string | undefined
    for (const control of controls) {
      if (control.group && control.group !== group) {
        const heading = document.createElement("h3")
        heading.textContent = control.group
        this.rows.append(heading)
      }
      group = control.group
      if (control.type === "action") {
        const button = document.createElement("button")
        button.type = "button"
        button.className = "action"
        button.dataset.key = control.key
        button.textContent = control.label
        button.onclick = async () => {
          button.disabled = true
          try { await control.run(button) }
          catch (error) { button.textContent = "Failed"; console.error(error) }
          finally { button.disabled = false }
        }
        this.rows.append(button)
        continue
      }
      const label = document.createElement("label")
      const input = control.type === "select" ? document.createElement("select") : document.createElement("input")
      const binding: Binding = { control, settings, input }
      input.dataset.key = control.key
      input.setAttribute("aria-label", control.label)
      if (control.type === "select" && input instanceof HTMLSelectElement) {
        for (const option of control.options) input.add(new Option(option.label, String(option.value)))
        input.onchange = () => {
          const option = control.options.find(option => String(option.value) === input.value)
          if (option) this.set(binding, option.value)
        }
        label.append(control.label, input)
      } else if (input instanceof HTMLInputElement) {
        if (control.type === "range") {
          input.type = "range"
          input.min = String(control.min); input.max = String(control.max); input.step = String(control.step ?? 1)
          binding.output = document.createElement("output")
          input.oninput = () => this.set(binding, input.valueAsNumber)
          label.append(control.label, input, binding.output)
        } else if (!control.type || control.type === "toggle") {
          input.type = "checkbox"
          input.onchange = () => this.set(binding, input.checked ? control.on ?? true : control.off ?? false)
          label.append(input, control.label)
        }
      }
      this.bindings.push(binding)
      this.rows.append(label)
    }
    this.presets.hidden = !this.allowPresets || !this.bindings.some(({ control }) => !control.type || control.type === "toggle")
    this.sync()
  }

  private set(binding: Binding, value: LabValue) {
    binding.settings[binding.control.key] = value
    binding.control.change?.(value)
    this.sync()
  }
  sync() {
    this.pill.setAttribute("aria-expanded", String(this.visible))
    for (const { control, settings, input, output } of this.bindings) {
      if (input instanceof HTMLInputElement && (!control.type || control.type === "toggle")) input.checked = settings[control.key] === (control.on ?? true)
      else input.value = String(settings[control.key])
      if (output) output.textContent = String(settings[control.key])
    }
  }
  toggle() { this.panel.hidden = !this.panel.hidden; this.sync() }
  get visible() { return !this.panel.hidden }
}
