export type LabControl = { key: string; label: string; on?: number; off?: number }

/** Presentation-only switches. No gameplay input leaves this host. */
export class LabPanel {
  readonly host = document.createElement("aside")
  readonly header: HTMLElement
  private panel: HTMLElement
  private pill: HTMLButtonElement
  private inputs = new Map<LabControl, HTMLInputElement>()

  constructor(private settings: Record<string, boolean | number>, controls: LabControl[], params: URLSearchParams, release: () => void) {
    this.host.dataset.lab = ""
    const root = this.host.attachShadow({ mode: "open" })
    root.innerHTML = `<style>
      :host{position:fixed;z-index:1000;right:10px;top:10px;color:#e4e9ed;font:11px/1.5 system-ui;max-width:calc(100vw - 20px)}
      *{box-sizing:border-box} [hidden]{display:none!important}
      button{font:inherit;color:inherit;background:#263039;border:1px solid #ffffff30;border-radius:5px;padding:4px 7px;cursor:pointer}
      .pill{display:block;margin-left:auto;margin-bottom:6px}
      section{width:285px;max-width:calc(100vw - 20px);max-height:calc(100dvh - 58px);overflow:auto;background:#10161af5;border:1px solid #ffffff30;border-radius:8px;padding:10px}
      header{font:10px/1.6 ui-monospace,monospace;white-space:pre-line;font-variant-numeric:tabular-nums;margin-bottom:8px}
      nav{display:flex;gap:5px;margin-bottom:6px}
      label{display:flex;align-items:center;gap:7px;padding:4px 0;cursor:pointer}
      input{accent-color:#a4dce7;margin:0}
    </style><button class="pill" type="button" aria-expanded="false">~ Lab</button><section aria-label="Debug controls"><header>FPS — · Frame ms — / —\nGPU ms —</header><nav><button data-preset="on">All On</button><button data-preset="off">All Off</button></nav><div data-controls></div></section>`
    this.panel = root.querySelector("section")!
    this.header = root.querySelector("header")!
    this.pill = root.querySelector(".pill")!
    const rows = root.querySelector("[data-controls]")!
    for (const control of controls) {
      const label = document.createElement("label")
      const input = document.createElement("input")
      input.type = "checkbox"
      input.dataset.key = control.key
      input.setAttribute("aria-label", control.label)
      input.onchange = () => this.set(control, input.checked)
      this.inputs.set(control, input)
      label.append(input, control.label)
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
    this.settings[control.key] = enabled ? control.on ?? true : control.off ?? false
  }
  private sync() {
    this.pill.setAttribute("aria-expanded", String(this.visible))
    for (const [control, input] of this.inputs) input.checked = this.settings[control.key] === (control.on ?? true)
  }
  toggle() { this.panel.hidden = !this.panel.hidden; this.sync() }
  get visible() { return !this.panel.hidden }
}
