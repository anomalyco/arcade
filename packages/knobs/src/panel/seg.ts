import { afterBatch, inBatch, measure } from "./measure.js"
import { livePill } from "./swipe.js"

/**
 * Places a segmented control's selected pill (`.knobs-seg-pill`) under the button whose
 * `data-value` is `value`. The pill is placed by its edges so the edge facing the move can lead
 * (see .knobs-seg-pill); a resize (a token gliding) carries it with its option instead of
 * animating it, and the first placement doesn't animate. With no matching button the pill fades.
 * While a pan holds the pill (see `panOptions`), it stays with the fingers. Showing the value it
 * already shows reads no layout (a resize, `resized`, re-places it).
 */
export function placeSegPill(
  seg: HTMLElement,
  buttons: readonly HTMLButtonElement[],
  value: string,
  resized = false,
) {
  let active: HTMLButtonElement | undefined
  for (const b of buttons) {
    const on = b.dataset.value === value
    if (b.getAttribute("aria-checked") !== String(on)) b.setAttribute("aria-checked", String(on))
    if (on) active = b
  }
  const pill = seg.querySelector<HTMLElement>(".knobs-seg-pill")
  if (!pill || livePill(seg)) return
  if (!active) {
    if (pill.dataset.placed) pill.dataset.off = ""
    return
  }
  if (!resized && pill.dataset.placed && !("off" in pill.dataset) && pill.dataset.value === value)
    return
  const button = active
  const place = ({ left, right }: Box) => {
    const wasOff = "off" in pill.dataset
    delete pill.dataset.off
    const now = performance.now()
    const sliding = now < Number(pill.dataset.slideUntil ?? 0)
    const first =
      !pill.dataset.placed || wasOff || (resized && pill.dataset.value === value && !sliding)
    pill.dataset.value = value
    const at = parseFloat(pill.style.left)
    // Coming back from no selection, it fades in where it lands instead of sliding there.
    if (first) pill.style.transition = wasOff ? "opacity .15s" : "none"
    else if (left !== at && !resized) {
      pill.dataset.dir = left > at ? "right" : "left"
      pill.dataset.slideUntil = String(now + 400)
    }
    pill.style.left = `${left}px`
    pill.style.right = `${right}px`
    if (first) {
      pill.dataset.placed = "true"
      // Restored a frame later rather than by forcing layout, which a gliding token would do on
      // every frame.
      seg.ownerDocument.defaultView?.requestAnimationFrame(() => (pill.style.transition = ""))
    }
  }
  const known = early.get(seg)?.get(button)
  if (known) place(known)
  else measure(() => box(seg, button), place)
}

type Box = { left: number; right: number }
const box = (seg: HTMLElement, button: HTMLElement): Box => ({
  left: button.offsetLeft,
  right: seg.clientWidth - button.offsetLeft - button.offsetWidth,
})
const early = new WeakMap<HTMLElement, Map<HTMLElement, Box>>()

/**
 * Reads where each option sits ahead of a batch's writes (see measure.ts), while layout is still
 * clean: choosing an option doesn't move any, so the pill then places without reading layout
 * after the batch has dirtied it.
 */
export function primeSegPill(seg: HTMLElement, buttons: readonly HTMLElement[]) {
  if (!inBatch() || early.has(seg)) return
  early.set(seg, new Map(buttons.map((b) => [b, box(seg, b)])))
  afterBatch(() => early.delete(seg))
}
