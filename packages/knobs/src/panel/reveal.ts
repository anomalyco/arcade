import { springEasing } from "../core/spring.js"

const EASE_OUT = "cubic-bezier(.2,.8,.2,1)"
// Opening and closing ride springs with no bounce (.22 s and .18 s): they leave at once and
// settle softly, where an ease-in close starts late and lands hard.
const OPEN = springEasing((2 * Math.PI) / 0.22, 1)
const CLOSE = springEasing((2 * Math.PI) / 0.18, 1)
/** How far the content drifts with the moving edge (px), at most, so it isn't a still crop. */
const DRIFT = 10
/** Where in a close the content has faded out, so nothing lingers cropped as the edge arrives. */
const FADED = 0.6

const running = new WeakMap<HTMLElement, Animation>()
const drifting = new WeakMap<HTMLElement, Animation[]>()
const activeNodes = new Set<HTMLElement>()
let revealVersion = 0

export const isAnyRevealing = () => activeNodes.size > 0
export const isRevealingIn = (root: HTMLElement) => {
  for (const node of activeNodes) {
    if (root.contains(node)) return true
  }
  return false
}
export const getRevealVersion = () => revealVersion
export const isRevealing = (node: HTMLElement) => activeNodes.has(node)

/**
 * Eases an in-flow element from height `from` to the height it has now, after its content
 * changed, so what's below glides. Read `from` before the change (mid-flight is fine).
 */
export function resize(node: HTMLElement, from: number) {
  const win = node.ownerDocument.defaultView!
  const prev = running.get(node)
  if (prev) {
    running.delete(node)
    activeNodes.delete(node)
    prev.cancel()
  }
  revealVersion++
  const to = node.getBoundingClientRect().height
  if (
    node.hidden ||
    Math.abs(to - from) < 0.5 ||
    win.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    node.style.overflow = ""
    return
  }
  node.style.overflow = "hidden"
  const ease = win.getComputedStyle(node).getPropertyValue("--k-reveal-ease").trim() || EASE_OUT
  const animation = node.animate([{ height: `${from}px` }, { height: `${to}px` }], {
    duration: 200,
    easing: ease,
  })
  running.set(node, animation)
  activeNodes.add(node)
  const settle = () => {
    if (running.get(node) !== animation) return
    running.delete(node)
    activeNodes.delete(node)
    revealVersion++
    node.style.overflow = ""
  }
  animation.oncancel = settle
  animation.onfinish = settle
}

/**
 * Slides `node`'s children with its moving edge, by up to `by` px: down into place as it opens,
 * up as it closes, from wherever they are when it turns around. Transforms only, so the GPU
 * renderer (which reads live rects while a reveal runs) draws the same.
 */
function drift(node: HTMLElement, show: boolean, by: number, timing: KeyframeAnimationOptions) {
  const prev = drifting.get(node)
  const kids = [...node.children].filter((k): k is HTMLElement => k instanceof HTMLElement)
  let from = show ? -by : 0
  if (prev?.length) {
    const first = kids[0]
    const m = first ? new DOMMatrix(getComputedStyle(first).transform) : undefined
    if (m) from = m.f
    for (const a of prev) a.cancel()
  }
  drifting.delete(node)
  if (by < 0.5 || kids.length > 48) return
  const to = show ? 0 : -by
  drifting.set(
    node,
    kids.map((k) =>
      k.animate(
        [{ transform: `translateY(${from}px)` }, { transform: `translateY(${to}px)` }],
        timing,
      ),
    ),
  )
}

/**
 * Shows or hides an in-flow element by animating its height (and margins/padding) open or shut,
 * so the content below glides instead of jumping. Interruptible: reversing mid-flight continues
 * from the current height.
 */
export function reveal(node: HTMLElement, show: boolean, after?: () => void, delay = 0) {
  const win = node.ownerDocument.defaultView!
  const leaving = node.dataset.leaving === "true"
  if (show && !node.hidden && !leaving) return after?.()
  if (!show && (node.hidden || leaving)) return
  const fromHeight = node.hidden ? 0 : node.getBoundingClientRect().height
  const fromOpacity = node.hidden ? 0 : Number(win.getComputedStyle(node).opacity)
  const prev = running.get(node)
  if (prev) {
    running.delete(node)
    activeNodes.delete(node)
    revealVersion++
    prev.cancel()
  }
  node.hidden = false
  delete node.dataset.leaving
  if (win.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    node.hidden = !show
    revealVersion++
    return after?.()
  }
  const cs = win.getComputedStyle(node)
  const height = node.getBoundingClientRect().height
  const open: Keyframe = {
    height: `${height}px`,
    minHeight: "0px",
    marginTop: cs.marginTop,
    marginBottom: cs.marginBottom,
    paddingTop: cs.paddingTop,
    paddingBottom: cs.paddingBottom,
    opacity: 1,
  }
  const f = height > 0 ? Math.min(1, fromHeight / height) : 0
  const scaled = (v: string) => `${(parseFloat(v) || 0) * f}px`
  const current: Keyframe = {
    height: `${fromHeight}px`,
    minHeight: "0px",
    marginTop: scaled(cs.marginTop),
    marginBottom: scaled(cs.marginBottom),
    paddingTop: scaled(cs.paddingTop),
    paddingBottom: scaled(cs.paddingBottom),
    opacity: fromOpacity,
  }
  const closed: Keyframe = {
    height: "0px",
    minHeight: "0px",
    marginTop: "0px",
    marginBottom: "0px",
    paddingTop: "0px",
    paddingBottom: "0px",
    opacity: 0,
  }
  node.style.overflow = "hidden"
  if (!show) node.dataset.leaving = "true"
  // --k-reveal-ease retunes the opening curve (the meta page's "Reveal curve").
  const custom = show ? cs.getPropertyValue("--k-reveal-ease").trim() : ""
  const curve = custom ? { easing: custom, ms: 180 } : show ? OPEN : CLOSE
  const timing: KeyframeAnimationOptions = {
    duration: curve.ms,
    easing: curve.easing,
    // A turn in a cascade: hold the starting frame until it comes.
    delay,
    fill: "backwards",
  }
  const animation = node.animate(
    show
      ? [current, open]
      : [current, { opacity: 0, offset: Math.max(0, FADED - (1 - f) * FADED) }, closed],
    timing,
  )
  // Disclosures (an inline editor, a folding card) carry their content with the edge.
  if (node.dataset.drift !== undefined) drift(node, show, Math.min(DRIFT, height * 0.12), timing)
  running.set(node, animation)
  activeNodes.add(node)
  revealVersion++
  const settle = () => {
    if (running.get(node) === animation) {
      running.delete(node)
      activeNodes.delete(node)
      revealVersion++
    }
  }
  animation.oncancel = settle
  animation.onfinish = () => {
    settle()
    node.style.overflow = ""
    if (!show) {
      node.hidden = true
      delete node.dataset.leaving
    }
    after?.()
  }
}
