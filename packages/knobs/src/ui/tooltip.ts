// Tooltips: one per document, shown after a pause over (or keyboard focus on) a target, and
// handed straight to a neighbour while one is up or just went. A shortcut shows as key chips.
// `tooltip(el, text)` registers a target; any element with `data-tip` works too.
import { comboParts } from "../core/keys.js"
import type { UiLook } from "./look.js"
import { anchorBox, layerElement, presence, viewBox } from "./layer.js"
import { type Placement, place } from "./overlay-model.js"

export interface TooltipOptions {
  /** A key or combination (`"Mod+K"`, `"Space"`): shown as chips after the text. */
  readonly shortcut?: string
  /** `top` by default. */
  readonly placement?: Placement
  /** Ms over the target before it shows (500); a hand-off shows at once. */
  readonly delay?: number
  readonly look?: UiLook
}
/** Text, a function read each time it shows, or text with options. */
export type TooltipContent =
  | string
  | (() => string)
  | ({ readonly text: string | (() => string) } & TooltipOptions)

interface Tip {
  readonly text: string | (() => string)
  readonly opts: TooltipOptions
}
const tips = new WeakMap<Element, Tip>()
const HANDOFF_MS = 400

interface Controller {
  hide(now?: boolean): void
}
const controllers = new WeakMap<Document, Controller>()

/** The tip `el` (or its nearest tipped ancestor) carries. */
function tipOf(start: EventTarget | null): { el: HTMLElement; tip: Tip } | null {
  let node = start instanceof Element ? start : null
  while (node) {
    const own = tips.get(node)
    if (own) return { el: node as HTMLElement, tip: own }
    const data = node.getAttribute("data-tip")
    if (data) {
      const shortcut = node.getAttribute("data-tip-shortcut") ?? undefined
      const placement = (node.getAttribute("data-tip-placement") as Placement | null) ?? undefined
      return {
        el: node as HTMLElement,
        tip: {
          text: data,
          opts: { ...(shortcut ? { shortcut } : {}), ...(placement ? { placement } : {}) },
        },
      }
    }
    node = node.parentElement
  }
  return null
}

function controllerOf(doc: Document): Controller {
  const existing = controllers.get(doc)
  if (existing) return existing
  const win = doc.defaultView!
  let layer: HTMLElement | undefined
  let motion: ReturnType<typeof presence> | undefined
  let text: HTMLElement
  let keys: HTMLElement
  let target: HTMLElement | null = null
  let pending: { el: HTMLElement; tip: Tip } | null = null
  let timer = 0
  let hiddenAt = -Infinity
  /** Pressed: no tip until the pointer leaves it. */
  let quiet: HTMLElement | null = null
  let keyboard = false
  const build = (look?: UiLook) => {
    layer = layerElement(doc, "knobs-layer knobs-tooltip", look)
    layer.id = `knobs-tooltip-${Math.random().toString(36).slice(2, 8)}`
    layer.setAttribute("role", "tooltip")
    text = doc.createElement("span")
    text.className = "knobs-tooltip-text"
    keys = doc.createElement("span")
    keys.className = "knobs-tooltip-keys"
    layer.append(text, keys)
    motion = presence(layer, { scale: 0.96, blur: 3, duration: 0.24 })
  }
  const show = (el: HTMLElement, tip: Tip, instant: boolean) => {
    if (!layer?.isConnected) build(tip.opts.look)
    target?.removeAttribute("aria-describedby")
    target = el
    text.textContent = typeof tip.text === "function" ? tip.text() : tip.text
    keys.replaceChildren(
      ...(tip.opts.shortcut ? comboParts(tip.opts.shortcut) : []).map((k) => {
        const kbd = doc.createElement("kbd")
        kbd.className = "knobs-kbd"
        kbd.textContent = k
        return kbd
      }),
    )
    keys.hidden = !tip.opts.shortcut
    const p = place({
      anchor: anchorBox(el),
      size: { w: layer!.offsetWidth, h: layer!.offsetHeight },
      view: viewBox(doc),
      placement: tip.opts.placement ?? "top",
      offset: 6,
    })
    layer!.style.left = `${p.x}px`
    layer!.style.top = `${p.y}px`
    layer!.style.transformOrigin = `${p.origin.x}px ${p.origin.y}px`
    const side = p.placement.split("-")[0]
    motion!.from(0, side === "top" ? 3 : side === "bottom" ? -3 : 0)
    el.setAttribute("aria-describedby", layer!.id)
    if (instant) motion!.snap(1)
    else motion!.show()
  }
  const hide = (now = false) => {
    win.clearTimeout(timer)
    pending = null
    if (!target) return
    target.removeAttribute("aria-describedby")
    target = null
    hiddenAt = performance.now()
    if (now) motion?.snap(0)
    else void motion?.hide()
  }
  const want = (found: { el: HTMLElement; tip: Tip } | null) => {
    if (!found) return hide()
    if (found.el === target || found.el === pending?.el) return
    if (found.el === quiet) return
    win.clearTimeout(timer)
    const handoff = target !== null || performance.now() - hiddenAt < HANDOFF_MS
    if (handoff) {
      pending = null
      show(found.el, found.tip, true)
      return
    }
    if (target) hide()
    pending = found
    timer = win.setTimeout(() => {
      pending = null
      if (found.el.isConnected) show(found.el, found.tip, false)
    }, found.tip.opts.delay ?? 500)
  }
  doc.addEventListener("pointerover", (e) => {
    if ((e as PointerEvent).pointerType === "touch") return
    keyboard = false
    want(tipOf(e.target))
  })
  doc.addEventListener("pointerout", (e) => {
    const to = (e as PointerEvent).relatedTarget as Node | null
    const from = tipOf(e.target)
    if (!from) return
    if (to && from.el.contains(to)) return
    if (quiet === from.el) quiet = null
    // Over another tipped element: pointerover hands it off.
    if (!tipOf(to)) hide()
  })
  doc.addEventListener(
    "pointerdown",
    (e) => {
      const found = tipOf(e.target)
      if (found) quiet = found.el
      hide(true)
    },
    true,
  )
  doc.addEventListener(
    "keydown",
    (e) => {
      keyboard = true
      if (e.key === "Escape" && target) hide()
    },
    true,
  )
  doc.addEventListener("focusin", (e) => {
    const found = tipOf(e.target)
    // Keyboard focus only: a click's focus doesn't pop a tip.
    if (found && keyboard && (e.target as HTMLElement).matches(":focus-visible")) want(found)
  })
  doc.addEventListener("focusout", (e) => {
    if (target && target.contains(e.target as Node)) hide()
  })
  doc.addEventListener("scroll", () => target && hide(true), true)
  const c: Controller = { hide }
  controllers.set(doc, c)
  return c
}

/** Shows `content` over `el` after a pause (or on keyboard focus). Returns the remover. */
export function tooltip(
  el: HTMLElement,
  content: TooltipContent,
  options: TooltipOptions = {},
): () => void {
  const { text, ...rest } =
    typeof content === "string" || typeof content === "function" ? { text: content } : content
  tips.set(el, { text, opts: { ...options, ...rest } })
  const c = controllerOf(el.ownerDocument)
  const shortcut = rest.shortcut ?? options.shortcut
  if (shortcut && !el.hasAttribute("aria-keyshortcuts"))
    el.setAttribute("aria-keyshortcuts", shortcut)
  return () => {
    tips.delete(el)
    c.hide(true)
  }
}

/** Turns on `data-tip` (and `data-tip-shortcut`, `data-tip-placement`) tooltips in a document. */
export function tooltips(doc: Document = document) {
  controllerOf(doc)
}
