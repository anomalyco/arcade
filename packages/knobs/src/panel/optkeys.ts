// While a row with options is focused (a choice, a curve's or easing's presets), tiny digit hints
// in hint mode's look sit on its options: 1–9 pick them. They fade in once focus settles on the
// row (so running down the rows doesn't flash them) and fade out when it moves on; the GPU draws
// the same badges from this layer (`data-shown` is the moment both fade by).
import type { RowOptions } from "./editors.js"
import { digitHints } from "./scope.js"

/** How long (ms) focus rests on a row before its digits show. */
const SETTLE_MS = 140
/** How long a hint takes to fade out before it leaves the DOM (ms). */
const FADE_MS = 180

export function createOptionKeys(doc: Document, root: HTMLElement, wake: () => void) {
  const layer = doc.createElement("div")
  layer.className = "knobs-optkeys"
  layer.setAttribute("aria-hidden", "true")
  let shown: { options: RowOptions; targets: readonly Element[]; nodes: HTMLElement[] } | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const fadeOut = (nodes: readonly HTMLElement[]) => {
    for (const node of nodes) {
      node.removeAttribute("data-shown")
      setTimeout(() => node.remove(), FADE_MS)
    }
  }
  /** Places `node` on `target`'s top-left corner (an option), or left of it (the stand-in). */
  const place = (node: HTMLElement, target: Element, range: boolean) => {
    const box = root.getBoundingClientRect()
    const r = target.getBoundingClientRect()
    const left = (range ? r.left - 4 : r.left + 1) - box.left - root.clientLeft + root.scrollLeft
    const top =
      (range ? r.top + r.height / 2 : r.top + 1) - box.top - root.clientTop + root.scrollTop
    node.style.left = `${Math.round(left)}px`
    node.style.top = `${Math.round(top)}px`
  }
  const sameTargets = (a: readonly Element[], b: readonly Element[]) =>
    a.length === b.length && a.every((t, i) => t === b[i])
  return {
    /** Shows `options`' digits (undefined hides them); the same ones again just re-place. */
    show(options: RowOptions | undefined) {
      const live = options ? options.shown() : []
      const targets = options ? (live.length ? live : [options.anchor]) : []
      if (shown && options === shown.options && sameTargets(targets, shown.targets)) {
        const range = !live.length
        shown.nodes.forEach((node, i) => place(node, targets[i]!, range))
        return
      }
      clearTimeout(timer)
      if (shown) fadeOut(shown.nodes)
      shown = undefined
      wake()
      if (!options) return
      const labels = digitHints(options.count, live.length > 0)
      if (!labels.length) return
      if (!layer.isConnected) root.append(layer)
      const range = !live.length
      const nodes = labels.map((label, i) => {
        const node = doc.createElement("kbd")
        node.className = range ? "knobs-optkey knobs-optkey-range" : "knobs-optkey"
        node.textContent = label
        place(node, targets[i]!, range)
        layer.append(node)
        return node
      })
      shown = { options, targets, nodes }
      timer = setTimeout(() => {
        for (const node of nodes) node.setAttribute("data-shown", "")
        wake()
      }, SETTLE_MS)
    },
    dispose() {
      clearTimeout(timer)
      layer.remove()
    },
  }
}
export type OptionKeys = ReturnType<typeof createOptionKeys>
