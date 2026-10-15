// toast(message): a pill at the bottom centre that says what just happened, then goes. One at a
// time: a new message replaces the one showing in place. Pages show their status here too.
import { injectUiStyles, type UiLook } from "./look.js"
import { layerElement, presence } from "./layer.js"

export interface ToastOptions {
  /** Ms it stays (3200; errors 6000). */
  readonly linger?: number
  readonly tone?: "info" | "warn" | "error"
  /** A button in the pill (Undo, say). */
  readonly action?: { readonly label: string; run(): void }
  readonly look?: UiLook
  /** Where it lives, to take that element's tokens (a page); the overlay layer by default. */
  readonly within?: HTMLElement
  readonly doc?: Document
}
export interface Toast {
  dismiss(): void
}

interface Region {
  el: HTMLElement
  text: HTMLElement
  button: HTMLButtonElement
  motion: ReturnType<typeof presence>
  timer: number
}
const regions = new WeakMap<Node, Region>()

export function toast(message: string, options: ToastOptions = {}): Toast {
  const doc = options.within?.ownerDocument ?? options.doc ?? document
  const win = doc.defaultView!
  const key: Node = options.within ?? doc
  let r = regions.get(key)
  if (!r || !r.el.isConnected) {
    const el = options.within
      ? Object.assign(doc.createElement("div"), { className: "knobs-ui knobs-toast" })
      : layerElement(doc, "knobs-layer knobs-toast", options.look)
    if (options.within) {
      injectUiStyles(doc)
      options.within.append(el)
    }
    el.setAttribute("role", "status")
    el.setAttribute("aria-live", "polite")
    const text = doc.createElement("span")
    text.className = "knobs-toast-text"
    const button = doc.createElement("button")
    button.type = "button"
    button.className = "knobs-toast-action"
    el.append(text, button)
    const region: Region = {
      el,
      text,
      button,
      motion: presence(el, { scale: 0.96, blur: 4, dy: 10, duration: 0.36 }),
      timer: 0,
    }
    r = region
    regions.set(key, region)
    // Hovered, it waits.
    el.addEventListener("pointerenter", () => win.clearTimeout(region.timer))
    el.addEventListener("pointerleave", () => {
      if (region.motion.shown) arm(region, 1600)
    })
  }
  const region = r
  const arm = (reg: Region, ms: number) => {
    win.clearTimeout(reg.timer)
    reg.timer = win.setTimeout(() => void reg.motion.hide(), ms)
  }
  region.text.textContent = message
  region.el.dataset.tone = options.tone ?? "info"
  const action = options.action
  region.button.hidden = !action
  region.button.textContent = action?.label ?? ""
  region.button.onclick = action
    ? () => {
        action.run()
        void region.motion.hide()
      }
    : null
  region.motion.show()
  arm(region, options.linger ?? (options.tone === "error" ? 6000 : 3200))
  return {
    dismiss() {
      if (region.text.textContent !== message) return
      win.clearTimeout(region.timer)
      void region.motion.hide()
    },
  }
}
