// popover(anchor, content): a floating layer beside its anchor. It flips and shifts to stay in
// view, grows from the anchor on a spring (scale and blur, interruptible), takes focus and gives
// it back, and closes on Esc or a click outside.
import type { UiLook } from "./look.js"
import {
  type Anchor,
  anchorBox,
  focusables,
  focusReturn,
  layerElement,
  presence,
  pushLayer,
  trapFocus,
  viewBox,
} from "./layer.js"
import { type Placement, place } from "./overlay-model.js"

export interface PopoverOptions {
  /** `bottom` by default; `top`, `left`, `right`, each with `-start` or `-end`. */
  readonly placement?: Placement
  /** Px between the anchor and the layer (6). */
  readonly offset?: number
  /** `dialog` by default; `menu`, `listbox`… for what the content is. */
  readonly role?: string
  readonly label?: string
  /**
   * Where focus goes when it opens: the first focusable element (`first`, the default), the
   * layer itself (`layer`), or nowhere (`none`, focus stays where it was).
   */
  readonly focus?: "first" | "layer" | "none"
  /** Tab stays inside (a modal popover). */
  readonly trap?: boolean
  /** A click outside closes it (true). */
  readonly closeOnOutside?: boolean
  readonly look?: UiLook
  /** Extra class names for the layer. */
  readonly className?: string
  onClose?(reason: PopoverCloseReason): void
}
export type PopoverCloseReason = "escape" | "outside" | "close"

export interface Popover {
  readonly element: HTMLElement
  /** Closes it (animated); resolves once it's gone. */
  close(): Promise<void>
  /** Places it again (after its content or anchor moved). */
  reposition(): void
  readonly open: boolean
}

export function popover(
  anchor: Anchor,
  content: HTMLElement | string | ((close: () => void) => HTMLElement),
  options: PopoverOptions = {},
): Popover {
  const doc =
    (anchor as HTMLElement).ownerDocument ??
    (content instanceof HTMLElement ? content.ownerDocument : document)
  const el = layerElement(
    doc,
    `knobs-layer knobs-popover-layer${options.className ? ` ${options.className}` : ""}`,
    options.look,
  )
  el.setAttribute("role", options.role ?? "dialog")
  if (options.label) el.setAttribute("aria-label", options.label)
  el.tabIndex = -1
  let open = true
  let closing: Promise<void> | undefined
  const close = (reason: PopoverCloseReason = "close") => {
    if (closing) return closing
    open = false
    unstack()
    untrap()
    ro.disconnect()
    win.removeEventListener("resize", reposition)
    doc.removeEventListener("scroll", onScroll, true)
    giveBack()
    options.onClose?.(reason)
    closing = motion.hide().then(() => el.remove())
    return closing
  }
  const body =
    typeof content === "function"
      ? content(() => void close())
      : typeof content === "string"
        ? Object.assign(doc.createElement("div"), {
            className: "knobs-popover-text",
            textContent: content,
          })
        : content
  el.append(body)
  const win = doc.defaultView!
  const giveBack = focusReturn(doc, el)
  const reposition = () => {
    if (!open) return
    const p = place({
      anchor: anchorBox(anchor),
      size: { w: el.offsetWidth, h: el.offsetHeight },
      view: viewBox(doc),
      placement: options.placement ?? "bottom",
      offset: options.offset ?? 6,
    })
    el.style.left = `${p.x}px`
    el.style.top = `${p.y}px`
    el.style.transformOrigin = `${p.origin.x}px ${p.origin.y}px`
    el.dataset.placement = p.placement
    const side = p.placement.split("-")[0]
    const nudge = 6
    motion.from(
      side === "left" ? nudge : side === "right" ? -nudge : 0,
      side === "top" ? nudge : side === "bottom" ? -nudge : 0,
    )
  }
  const motion = presence(el)
  reposition()
  // Anchored to an element, it follows the element through scrolls and resizes.
  const onScroll = (e: Event) => {
    if (!el.contains(e.target as Node)) reposition()
  }
  win.addEventListener("resize", reposition)
  doc.addEventListener("scroll", onScroll, true)
  const ro = new win.ResizeObserver(() => reposition())
  ro.observe(el)
  const unstack = pushLayer(doc, {
    el,
    inside: () => [anchor instanceof win.HTMLElement ? anchor : null],
    outside: options.closeOnOutside !== false,
    modal: options.trap,
    dismiss: (reason) => void close(reason),
  })
  const untrap = options.trap ? trapFocus(el) : () => {}
  motion.show()
  const focus = options.focus ?? "first"
  if (focus !== "none")
    (focus === "first" ? (focusables(el)[0] ?? el) : el).focus({ preventScroll: true })
  // Focus leaving for the page (Tab past the end, a click elsewhere) closes it.
  el.addEventListener("focusout", (e) => {
    const to = e.relatedTarget as Node | null
    if (
      !options.trap &&
      to &&
      !el.contains(to) &&
      !(anchor instanceof win.HTMLElement && anchor.contains(to))
    )
      void close("outside")
  })
  return {
    element: el,
    close: () => close("close"),
    reposition,
    get open() {
      return open
    },
  }
}
