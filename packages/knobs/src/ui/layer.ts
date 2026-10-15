// What every overlay shares: one fixed layer above the page (and the GPU overlay), a spring that
// brings a layer in and out (scale, blur and a nudge from where it came from, interruptible both
// ways), a stack so Esc and outside clicks reach the topmost layer only, and focus helpers.
import { Spring } from "../core/spring.js"
import { applyLook, frameLoop, lookDefaults, reducedMotion, type UiLook } from "./look.js"

/** The look every overlay takes unless given its own (a preset and theme, as panels take). */
export function overlayLook(look: UiLook) {
  lookDefaults.current = look
}
export const lookOf = (look?: UiLook): UiLook => ({ ...lookDefaults.current, ...look })

const roots = new WeakMap<Document, HTMLElement>()
/** The document's overlay layer: fixed, above everything, passing the pointer through. */
export function layerRoot(doc: Document): HTMLElement {
  let root = roots.get(doc)
  if (root?.isConnected) return root
  root = doc.createElement("div")
  root.className = "knobs-layers"
  doc.body.append(root)
  roots.set(doc, root)
  return root
}

/** A new overlay element in the layer, with the pieces' look. */
export function layerElement(doc: Document, cls: string, look?: UiLook) {
  const el = doc.createElement("div")
  el.className = cls
  layerRoot(doc).append(el)
  applyLook(el, lookOf(look))
  return el
}

export interface PresenceOptions {
  /** Scale it grows from (0.94). */
  readonly scale?: number
  /** Blur (px) it sharpens from (6). */
  readonly blur?: number
  /** Where it slides from, px (toward its anchor). */
  readonly dx?: number
  readonly dy?: number
  /** Perceptual duration in, s (0.32). */
  readonly duration?: number
  /** Bounce in (0.2); exits never bounce. */
  readonly bounce?: number
  /** Perceptual duration out, s (0.2): exits run shorter than entrances. */
  readonly exit?: number
  /** Called once it has gone (faded all the way out). */
  onGone?(): void
  /** Each frame, with progress (0 → 1, may overshoot a little). */
  onFrame?(p: number): void
}

export interface Presence {
  show(): void
  hide(): Promise<void>
  /** Jumps to shown (a hand-off between neighbours) or gone, with no motion. */
  snap(to?: 0 | 1): void
  readonly shown: boolean
  /** Changes where it slides from (after a flip). */
  from(dx: number, dy: number): void
  dispose(): void
}

/** Brings `el` in and out on a spring: opacity, scale and blur from its transform-origin. */
export function presence(el: HTMLElement, o: PresenceOptions = {}): Presence {
  const win = el.ownerDocument.defaultView!
  const spring = new Spring(0, 1, 1, 0.002)
  let dx = o.dx ?? 0
  let dy = o.dy ?? 0
  let gone: (() => void)[] = []
  let shown = false
  const render = () => {
    const reduced = reducedMotion(win)
    const p = spring.x
    const q = Math.max(0, Math.min(1, p))
    const scale = reduced ? 1 : (o.scale ?? 0.94) + (1 - (o.scale ?? 0.94)) * p
    const blur = reduced ? 0 : (1 - q) * (o.blur ?? 6)
    const t = reduced ? 0 : 1 - p
    el.style.opacity = q.toFixed(3)
    el.style.transform =
      p === 1
        ? ""
        : `translate(${(dx * t).toFixed(2)}px,${(dy * t).toFixed(2)}px) scale(${scale.toFixed(4)})`
    el.style.filter = blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : ""
    el.style.pointerEvents = shown ? "" : "none"
    o.onFrame?.(p)
  }
  const loop = frameLoop(win, (dt) => {
    spring.step(dt)
    render()
    if (!spring.resting) return true
    if (!shown) {
      const done = gone
      gone = []
      for (const f of done) f()
      o.onGone?.()
    }
    return false
  })
  const tune = (seconds: number, zeta: number) => {
    const reduced = reducedMotion(win)
    spring.omega = (2 * Math.PI) / (reduced ? 0.16 : seconds)
    spring.zeta = reduced ? 1 : zeta
  }
  render()
  return {
    show() {
      shown = true
      gone = []
      el.style.pointerEvents = ""
      tune(o.duration ?? 0.32, 1 - (o.bounce ?? 0.2))
      spring.set(1)
      loop.wake()
    },
    hide() {
      shown = false
      el.style.pointerEvents = "none"
      tune(o.exit ?? 0.2, 1)
      spring.set(0)
      loop.wake()
      return new Promise<void>((resolve) => gone.push(resolve))
    },
    snap(to = 1) {
      shown = to === 1
      spring.snap(to)
      loop.stop()
      render()
      if (!shown) {
        const done = gone
        gone = []
        for (const f of done) f()
        o.onGone?.()
      } else gone = []
    },
    get shown() {
      return shown
    },
    from(x, y) {
      dx = x
      dy = y
    },
    dispose() {
      loop.stop()
      for (const f of gone) f()
      gone = []
    },
  }
}

// ——— the stack: Esc and outside clicks go to the topmost layer ———

export interface Dismissible {
  readonly el: HTMLElement
  /** Pointer-downs inside these don't count as outside (the anchor, say). */
  readonly inside?: () => readonly (Element | null | undefined)[]
  /** Esc and outside clicks reach the layers under a modal one only through it. */
  readonly modal?: boolean
  readonly outside?: boolean
  dismiss(reason: "escape" | "outside"): void
}
const stacks = new WeakMap<Document, Dismissible[]>()
export function pushLayer(doc: Document, layer: Dismissible): () => void {
  let stack = stacks.get(doc)
  if (!stack) {
    const s: Dismissible[] = []
    stack = s
    stacks.set(doc, s)
    doc.addEventListener(
      "keydown",
      (e) => {
        const top = s[s.length - 1]
        if (!top || e.key !== "Escape" || e.defaultPrevented) return
        e.preventDefault()
        e.stopPropagation()
        top.dismiss("escape")
      },
      true,
    )
    doc.addEventListener(
      "pointerdown",
      (e) => {
        const top = s[s.length - 1]
        if (!top || top.outside === false) return
        const target = e.target as Node | null
        if (!target || top.el.contains(target)) return
        if (top.inside?.().some((n) => n?.contains(target))) return
        // A layer under the top one (a popover's own tooltip) is inside too.
        if (s.some((l) => l !== top && l.el.contains(target))) return
        if (top.modal) {
          e.preventDefault()
          e.stopPropagation()
        }
        top.dismiss("outside")
      },
      true,
    )
  }
  stack.push(layer)
  return () => {
    const i = stack!.indexOf(layer)
    if (i >= 0) stack!.splice(i, 1)
  }
}

// ——— focus ———

const FOCUSABLE =
  'button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
export const focusables = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.hidden && el.getClientRects().length > 0,
  )

/** Keeps Tab inside `root`; returns the remover. */
export function trapFocus(root: HTMLElement): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Tab") return
    const list = focusables(root)
    if (!list.length) return
    const i = list.indexOf(root.ownerDocument.activeElement as HTMLElement)
    const next = e.shiftKey ? list[(i <= 0 ? list.length : i) - 1]! : list[(i + 1) % list.length]!
    e.preventDefault()
    next.focus()
  }
  root.addEventListener("keydown", onKey)
  return () => root.removeEventListener("keydown", onKey)
}

/** Where focus was, to return it there when the layer closes (if focus is still in the layer). */
export function focusReturn(doc: Document, layer: HTMLElement) {
  const was = doc.activeElement as HTMLElement | null
  return () => {
    const now = doc.activeElement
    if (now && now !== doc.body && !layer.contains(now)) return
    if (was?.isConnected) was.focus({ preventScroll: true })
  }
}

export type Anchor = HTMLElement | DOMRect | { readonly x: number; readonly y: number }
export const anchorBox = (a: Anchor) => {
  if (typeof (a as HTMLElement).getBoundingClientRect === "function") {
    const r = (a as HTMLElement).getBoundingClientRect()
    return { x: r.left, y: r.top, w: r.width, h: r.height }
  }
  const r = a as DOMRect
  return { x: r.x, y: r.y, w: r.width ?? 0, h: r.height ?? 0 }
}
export const viewBox = (doc: Document) => ({
  x: 0,
  y: 0,
  w: doc.documentElement.clientWidth,
  h: doc.documentElement.clientHeight,
})
