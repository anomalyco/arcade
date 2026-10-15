// confirm({ title }): asks before something that can't be taken back. Resolves true or false;
// Tab stays inside, Esc and a click outside cancel, and focus returns where it was.
import type { UiLook } from "./look.js"
import { focusReturn, layerElement, presence, pushLayer, trapFocus } from "./layer.js"

export interface ConfirmOptions {
  readonly title: string
  readonly body?: string
  /** The confirming button's label ("OK"). */
  readonly confirm?: string
  readonly cancel?: string
  /** It deletes or discards: the button reads in the critical colour, and Cancel takes focus. */
  readonly destructive?: boolean
  readonly look?: UiLook
  readonly doc?: Document
}

export function confirm(options: ConfirmOptions): Promise<boolean> {
  const doc = options.doc ?? document
  const scrim = layerElement(doc, "knobs-layer knobs-scrim", options.look)
  const el = layerElement(doc, "knobs-layer knobs-confirm", options.look)
  el.setAttribute("role", "alertdialog")
  el.setAttribute("aria-modal", "true")
  const id = Math.random().toString(36).slice(2, 8)
  const title = doc.createElement("h2")
  title.className = "knobs-confirm-title"
  title.id = `knobs-confirm-title-${id}`
  title.textContent = options.title
  el.setAttribute("aria-labelledby", title.id)
  el.append(title)
  if (options.body) {
    const body = doc.createElement("p")
    body.className = "knobs-confirm-body"
    body.id = `knobs-confirm-body-${id}`
    body.textContent = options.body
    el.setAttribute("aria-describedby", body.id)
    el.append(body)
  }
  const row = doc.createElement("div")
  row.className = "knobs-confirm-buttons"
  const button = (label: string, cls: string) => {
    const b = doc.createElement("button")
    b.type = "button"
    b.className = `knobs-confirm-btn ${cls}`
    b.textContent = label
    return b
  }
  const no = button(options.cancel ?? "Cancel", "knobs-confirm-cancel")
  const yes = button(options.confirm ?? "OK", "knobs-confirm-ok")
  if (options.destructive) yes.dataset.destructive = ""
  row.append(no, yes)
  el.append(row)
  const giveBack = focusReturn(doc, el)
  const motion = presence(el, { scale: 0.92, blur: 8, dy: 6, duration: 0.34 })
  const fade = presence(scrim, { scale: 1, blur: 0, duration: 0.3 })
  return new Promise<boolean>((resolve) => {
    let done = false
    const finish = (ok: boolean) => {
      if (done) return
      done = true
      unstack()
      untrap()
      giveBack()
      resolve(ok)
      void fade.hide().then(() => scrim.remove())
      void motion.hide().then(() => el.remove())
    }
    const unstack = pushLayer(doc, {
      el,
      modal: true,
      dismiss: () => finish(false),
    })
    const untrap = trapFocus(el)
    no.onclick = () => finish(false)
    yes.onclick = () => finish(true)
    fade.show()
    motion.show()
    ;(options.destructive ? no : yes).focus({ preventScroll: true })
  })
}
