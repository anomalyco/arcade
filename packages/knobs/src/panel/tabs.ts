import { Edges } from "./motion.js"
import { arrowOf } from "./prefs.js"

export interface TabSpec {
  readonly id: string
  readonly label: string
}

/**
 * A panel's tab strip: text tabs over a hairline, the chosen one marked by an underline that
 * slides to it (its leading edge first, the trailing one following, as the selection pills do).
 * The strip is one ↑↓ stop; ←/→ on it switch tabs.
 */
export interface TabStrip {
  readonly element: HTMLElement
  readonly bar: HTMLElement
  /** The underline's edges for the GPU overlay (px from the strip's left). */
  readonly edges: Edges
  buttons: HTMLButtonElement[]
  readonly tabs: readonly TabSpec[]
  readonly active: string | undefined
  /** Swaps in another set of tabs, keeping the strip. */
  set(tabs: readonly TabSpec[], active: string | undefined): void
  /** Marks `id` chosen and slides the underline to it (or places it, when `animate` is false). */
  select(id: string, animate?: boolean): void
  focus(options?: FocusOptions): void
  dispose(): void
}

export function createTabStrip(doc: Document, choose: (id: string) => void): TabStrip {
  const element = doc.createElement("div")
  element.className = "knobs-tabs"
  element.setAttribute("role", "tablist")
  element.hidden = true
  const bar = doc.createElement("span")
  bar.className = "knobs-tabs-bar"
  bar.setAttribute("aria-hidden", "true")
  element.append(bar)
  let tabs: readonly TabSpec[] = []
  let active: string | undefined
  let placed = false
  const strip: TabStrip = {
    element,
    bar,
    edges: new Edges(),
    buttons: [],
    get tabs() {
      return tabs
    },
    get active() {
      return active
    },
    set(next, chosen) {
      const same =
        next.length === tabs.length &&
        next.every((t, i) => t.id === tabs[i]!.id && t.label === tabs[i]!.label)
      tabs = next
      element.hidden = next.length === 0
      if (!same) {
        for (const b of strip.buttons) b.remove()
        strip.buttons = next.map((t) => {
          const b = doc.createElement("button")
          b.type = "button"
          b.className = "knobs-tab"
          b.textContent = t.label
          b.dataset.tab = t.id
          b.setAttribute("role", "tab")
          b.tabIndex = -1
          b.onclick = () => choose(t.id)
          element.insertBefore(b, bar)
          return b
        })
        placed = false
      }
      if (chosen !== undefined) strip.select(chosen, false)
    },
    select(id, animate = true) {
      active = id
      let on: HTMLButtonElement | undefined
      for (const b of strip.buttons) {
        const is = b.dataset.tab === id
        if (b.getAttribute("aria-selected") !== String(is))
          b.setAttribute("aria-selected", String(is))
        b.tabIndex = is ? 0 : -1
        if (is) on = b
      }
      if (!on) return
      place(on, animate && placed)
    },
    focus(options) {
      ;(strip.buttons.find((b) => b.dataset.tab === active) ?? strip.buttons[0])?.focus(options)
    },
    dispose: () => ro.disconnect(),
  }
  /** Puts the underline under `on`'s text; a move slides it, leading edge first. */
  function place(on: HTMLButtonElement, animate: boolean) {
    const left = on.offsetLeft
    const right = element.clientWidth - left - on.offsetWidth
    if (!element.clientWidth) return
    const at = parseFloat(bar.style.left)
    if (!animate) bar.style.transition = "none"
    else if (left !== at) bar.dataset.dir = left > at ? "right" : "left"
    bar.style.left = `${left}px`
    bar.style.right = `${right}px`
    if (!animate) {
      void bar.offsetWidth
      bar.style.transition = ""
    }
    placed = true
  }
  // A resize (a token gliding, the column narrowing) carries the underline with its tab.
  const ro = new ResizeObserver(() => {
    const on = strip.buttons.find((b) => b.dataset.tab === active)
    if (on) place(on, false)
  })
  ro.observe(element)
  element.addEventListener("keydown", (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const dir = arrowOf(event)
    if (!dir || !tabs.length) return
    event.preventDefault()
    event.stopPropagation()
    const at = tabs.findIndex((t) => t.id === active)
    const next = tabs[(at + dir + tabs.length) % tabs.length]!
    choose(next.id)
    strip.focus({ preventScroll: true })
  })
  return strip
}
