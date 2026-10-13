type LabSettings = Record<string, boolean | number | string>
export type LabControl = { key: string; label: string; group?: string; enabled?: (settings: Readonly<LabSettings>) => boolean } & (
  { min: number; max: number; step: number } | { options: readonly { value: number | string; label: string }[] } | { on?: number; off?: number }
)

/** Presentation-only controls. No gameplay input leaves this host. */
export class LabPanel {
  readonly host = document.createElement("aside")
  readonly header: HTMLElement
  private panel: HTMLElement
  private pill: HTMLButtonElement
  private inputs = new Map<LabControl, HTMLInputElement | HTMLSelectElement>()

  constructor(private settings: LabSettings, controls: LabControl[], params: URLSearchParams, release: () => void) {
    this.host.dataset.lab = ""
    const root = this.host.attachShadow({ mode: "open" })
    root.innerHTML = `<style>
      :host{position:fixed;z-index:1000;right:10px;top:10px;color:#e4e9ed;font:11px/1.5 system-ui;max-width:calc(100vw - 20px)}
      *{box-sizing:border-box} [hidden]{display:none!important}
      button,select{font:inherit;color:inherit;background:#263039;border:1px solid #ffffff30;border-radius:5px;padding:4px 7px;cursor:pointer}
      select{margin-left:auto;max-width:190px} label:has(:disabled){opacity:.4}
      .pill{display:block;margin-left:auto;margin-bottom:6px}
      section{width:285px;max-width:calc(100vw - 20px);max-height:calc(100dvh - 58px);overflow:auto;background:#10161af5;border:1px solid #ffffff30;border-radius:8px;padding:10px}
      header{font:10px/1.6 ui-monospace,monospace;white-space:pre-line;font-variant-numeric:tabular-nums;margin-bottom:8px}
      nav{display:flex;gap:5px;margin-bottom:6px}
      label{display:flex;align-items:center;gap:7px;padding:4px 0;cursor:pointer}
       input{accent-color:#a4dce7;margin:0}
       label.range{display:grid;grid-template-columns:1fr 42px;gap:2px 7px}
       input[type=range]{grid-column:1 / -1;width:100%;cursor:ew-resize}
       output{text-align:right;font-variant-numeric:tabular-nums}
       h3{display:flex;align-items:center;justify-content:space-between;font:inherit;font-weight:600;margin:8px 0 3px;color:#a4b1bc}
    </style><button class="pill" type="button" aria-expanded="false">~ Lab</button><section aria-label="Debug controls"><header>FPS — · Frame ms — / —\nGPU ms —</header><nav><button data-preset="on">All On</button><button data-preset="off">All Off</button></nav><div data-controls></div></section>`
    this.panel = root.querySelector("section")!
    root.querySelector<HTMLElement>("nav")!.hidden = !controls.some(c => !("min" in c) && !("options" in c))
    this.header = root.querySelector("header")!
    this.pill = root.querySelector(".pill")!
    const rows = root.querySelector("[data-controls]")!
    let group: string | undefined
    for (const control of controls) {
      if (control.group && control.group !== group) {
        const heading = document.createElement("h3")
        heading.textContent = control.group
        if (controls.some(c => c.group === control.group && ("min" in c || "options" in c))) {
          const copy = document.createElement("button")
          copy.type = "button"
          copy.textContent = "Copy"
          copy.setAttribute("aria-label", `Copy ${control.group} JSON`)
          copy.onclick = async () => {
            const values = Object.fromEntries(controls.filter(c => c.group === control.group).map(c => [c.key, this.settings[c.key]]))
            try {
              await navigator.clipboard.writeText(JSON.stringify(values, null, 2))
              copy.textContent = "Copied"
            } catch { copy.textContent = "Copy failed" }
          }
          heading.append(copy)
        }
        rows.append(heading)
      }
      group = control.group
      const label = document.createElement("label")
      if ("options" in control) {
        const select = document.createElement("select")
        select.dataset.key = control.key
        select.setAttribute("aria-label", control.label)
        for (const option of control.options) select.add(new Option(option.label, String(option.value)))
        select.onchange = () => {
          const option = control.options.find(option => String(option.value) === select.value)
          if (!option) return
          this.settings[control.key] = option.value
          rows.querySelectorAll("h3 button").forEach(button => { button.textContent = "Copy" })
          this.sync()
        }
        label.append(control.label, select)
        this.inputs.set(control, select)
        rows.append(label)
        continue
      }
      const input = document.createElement("input")
      input.dataset.key = control.key
      input.setAttribute("aria-label", control.label)
      if ("min" in control) {
        label.className = "range"
        input.type = "range"
        input.min = String(control.min)
        input.max = String(control.max)
        input.step = String(control.step)
        const output = document.createElement("output")
        input.oninput = () => {
          this.settings[control.key] = input.valueAsNumber
          output.value = input.value
          rows.querySelectorAll("h3 button").forEach(button => { button.textContent = "Copy" })
          this.sync()
        }
        label.append(control.label, output, input)
      } else {
        input.type = "checkbox"
        input.onchange = () => { this.set(control, input.checked); this.sync() }
        label.append(input, control.label)
      }
      this.inputs.set(control, input)
      rows.append(label)
    }
    root.querySelectorAll<HTMLButtonElement>("[data-preset]").forEach((button) => {
      button.onclick = () => {
        for (const control of controls) this.set(control, button.dataset.preset === "on")
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
    // Players never see the lab: Backquote opens it, and ?lab=1 or ?perf=1 shows it with its button.
    const lab = params.get("perf") === "1" || params.get("lab") === "1"
    this.panel.hidden = !lab
    this.pill.hidden = !lab
    this.sync()
    document.body.append(this.host)
  }

  private set(control: LabControl, enabled: boolean) {
    if ("min" in control || "options" in control) return
    this.settings[control.key] = enabled ? control.on ?? true : control.off ?? false
  }
  private sync() {
    this.pill.setAttribute("aria-expanded", String(this.visible))
    for (const [control, input] of this.inputs) {
      input.disabled = control.enabled?.(this.settings) === false
      if ("options" in control) {
        input.value = String(this.settings[control.key])
      } else if ("min" in control) {
        input.value = String(this.settings[control.key])
        input.parentElement!.querySelector("output")!.value = input.value
      } else if (input instanceof HTMLInputElement) input.checked = this.settings[control.key] === (control.on ?? true)
    }
  }
  toggle() { this.panel.hidden = !this.panel.hidden; this.sync() }
  get visible() { return !this.panel.hidden }
}
