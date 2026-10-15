import { Spring, springMotion } from "../core/spring.js"
import { storageKey, browserStorage, type StoragePort } from "../core/storage.js"
import { applyLook, frameLoop, ICONS, notifyLayout, reducedMotion, type UiLook } from "./look.js"
import { tooltip } from "./tooltip.js"
import {
  collapsibleSide,
  drag,
  edgeOf,
  flexible,
  nudge,
  parseLayout,
  serializeLayout,
  solve,
  type PaneSpec,
  type SplitDirection,
  type SplitLayout,
} from "./split-model.js"

export interface PaneAction {
  readonly id?: string
  readonly label: string
  /** SVG markup, text, or a node of your own. */
  readonly icon?: string | Node
  readonly pressed?: boolean
  /** Shown in its tooltip as key chips (the split doesn't bind it). */
  readonly shortcut?: string
  run(event: MouseEvent): void
}

export interface PaneOptions extends PaneSpec {
  /** A header with this title (a dock); collapsed, it's the rail's label too. */
  readonly title?: string
  /** The collapsed rail's label, when it isn't the title. */
  readonly rail?: string
  /** Beside the title, dimmed: a count or a word. */
  readonly count?: string | number
  /** Icon buttons at the header's end. */
  readonly actions?: readonly PaneAction[]
  /** The body scrolls (on by default for panes with a header). */
  readonly scroll?: boolean
  /** Content for the body (or fill `split.pane(id).body` yourself). */
  readonly element?: Node
}

export interface SplitOptions extends UiLook {
  readonly direction?: SplitDirection
  readonly panes: readonly PaneOptions[]
  /** Saves sizes and collapsed panes under this id (with `storage`). */
  readonly id?: string
  /** Where layouts are saved: localStorage unless set; `null` saves nothing. */
  readonly storage?: StoragePort | null
  /** After every change of size or collapse, drag frames and springs included. */
  readonly onLayout?: (layout: SplitLayout) => void
}

export interface SplitPane {
  readonly id: string
  /** The pane itself. */
  readonly element: HTMLElement
  /** Where content goes. */
  readonly body: HTMLElement
  readonly header: HTMLElement | undefined
  /** Its size along the split (px), as shown now. */
  readonly size: number
  readonly collapsed: boolean
  collapse(collapsed?: boolean): void
  resize(size: number): void
  title(text: string, count?: string | number): void
}

export interface Split {
  readonly element: HTMLElement
  pane(id: string): SplitPane
  layout(): SplitLayout
  /** Collapses or opens a pane (springing, interruptibly); no argument toggles. */
  collapse(id: string, collapsed?: boolean): void
  resize(id: string, size: number): void
  /** Back to the panes' own sizes, one pane or all. */
  reset(id?: string): void
  dispose(): void
}

const COLLAPSE = springMotion({ duration: 0.42, bounce: 0.04 })
const SETTLE = springMotion({ duration: 0.3, bounce: 0 })

const iconNode = (doc: Document, icon: string | Node | undefined, label: string) => {
  if (icon instanceof Node) return icon
  const span = doc.createElement("span")
  span.style.display = "contents"
  if (icon && icon.trimStart().startsWith("<")) span.innerHTML = icon
  else span.textContent = icon ?? label.slice(0, 1)
  return span
}

/**
 * Resizable panes along a row or a column, divided by hairlines with a wider grip. Drag a divider
 * to resize (each pane slows into its min and max), double-click it to reset, or focus it and use
 * the arrow keys (⇧ for bigger steps) and Enter to collapse. Collapsing springs the pane down to a
 * slim rail, or to its header in a column, which opens it again. Sizes persist and restore before
 * the first paint. Splits nest: call `split` on another split's pane body.
 */
export function split(container: HTMLElement, options: SplitOptions): Split {
  const doc = container.ownerDocument
  const win = doc.defaultView!
  const direction = options.direction ?? "row"
  const row = direction === "row"
  const specs = options.panes
  const flex = flexible(specs)
  const store = options.storage === undefined ? browserStorage() : options.storage
  const key = options.id ? storageKey(options.id, "split") : undefined
  const saved = (() => {
    if (!store || !key) return undefined
    try {
      return parseLayout(JSON.parse(store.getItem(key) ?? "null"), specs)
    } catch {
      return undefined
    }
  })()
  // Sizes: what each pane last had open (a flexible pane's is its share).
  const sizes: Record<string, number> = { ...saved?.sizes }
  const collapsed: Record<string, boolean> = {}
  for (const p of specs) collapsed[p.id] = saved?.collapsed[p.id] ?? Boolean(p.collapsed)

  const root = doc.createElement("div")
  root.className = "knobs-split"
  root.dataset.direction = direction
  applyLook(root, options)

  interface View {
    spec: PaneOptions
    el: HTMLElement
    clip: HTMLElement
    inner: HTMLElement
    body: HTMLElement
    head?: HTMLElement
    titleEl?: HTMLElement
    countEl?: HTMLElement
    rail?: HTMLButtonElement
    /** The size being animated toward and from: what the pane has open. */
    open: number
    shown: number
  }
  const views = new Map<string, View>()
  const dividers: HTMLElement[] = []
  const springs = new Map<string, Spring>()

  const makePane = (spec: PaneOptions): View => {
    const el = doc.createElement("section")
    el.className = "knobs-pane"
    el.dataset.pane = spec.id
    const clip = doc.createElement("div")
    clip.className = "knobs-pane-clip"
    const inner = doc.createElement("div")
    inner.className = "knobs-pane-inner"
    const body = doc.createElement("div")
    body.className = "knobs-pane-body"
    const view: View = { spec, el, clip, inner, body, open: 0, shown: 0 }
    if (spec.title !== undefined) {
      const head = doc.createElement("header")
      head.className = "knobs-pane-head"
      const title = doc.createElement("span")
      title.className = "knobs-pane-title"
      title.textContent = spec.title
      const count = doc.createElement("span")
      count.className = "knobs-pane-count"
      count.textContent = spec.count === undefined ? "" : String(spec.count)
      const fill = doc.createElement("span")
      fill.className = "knobs-pane-fill"
      head.append(title, count, fill)
      for (const action of spec.actions ?? []) {
        const b = doc.createElement("button")
        b.type = "button"
        b.className = "knobs-pane-btn"
        b.setAttribute("aria-label", action.label)
        tooltip(b, action.label, action.shortcut ? { shortcut: action.shortcut } : {})
        if (action.id) b.dataset.action = action.id
        if (action.pressed !== undefined) b.setAttribute("aria-pressed", String(action.pressed))
        b.append(iconNode(doc, action.icon, action.label))
        b.addEventListener("click", (e) => {
          e.stopPropagation()
          action.run(e)
        })
        head.append(b)
      }
      if (spec.collapsible) {
        const b = doc.createElement("button")
        b.type = "button"
        b.className = "knobs-pane-btn knobs-pane-collapse"
        b.setAttribute("aria-label", `Collapse ${spec.title}`)
        tooltip(b, () => (collapsed[spec.id] ? "Open" : row ? "Collapse" : "Fold"))
        b.innerHTML = row ? ICONS.caret : ICONS.chevronDown
        if (row)
          b.firstElementChild?.setAttribute(
            "style",
            edgeOf(specs, spec.id) === "start" ? "transform:scaleX(-1)" : "",
          )
        else b.firstElementChild?.classList.add("knobs-pane-caret")
        b.addEventListener("click", (e) => {
          e.stopPropagation()
          setCollapsed(spec.id, !collapsed[spec.id])
        })
        head.append(b)
        // In a column the header is the fold: a click on it folds and opens the pane.
        if (!row) {
          head.dataset.toggles = ""
          head.addEventListener("click", () => setCollapsed(spec.id, !collapsed[spec.id]))
        }
      }
      inner.append(head)
      view.head = head
      view.titleEl = title
      view.countEl = count
    }
    inner.append(body)
    clip.append(inner)
    el.append(clip)
    if (spec.scroll ?? spec.title !== undefined) el.dataset.scroll = ""
    if (spec.element) body.append(spec.element)
    // A rail stands in for a collapsed pane, unless a header in a column does.
    if (spec.collapsible && (row || !view.head)) {
      const rail = doc.createElement("button")
      rail.type = "button"
      rail.className = "knobs-pane-rail"
      rail.tabIndex = -1
      const label = spec.rail ?? spec.title ?? spec.id
      rail.setAttribute("aria-label", `Open ${label}`)
      tooltip(rail, `Open ${label}`, { placement: row ? "right" : "top" })
      const text = doc.createElement("span")
      text.textContent = spec.rail ?? spec.title ?? ""
      rail.innerHTML = row
        ? ICONS.caret.replace(
            "<svg",
            `<svg style="transform:scaleX(${edgeOf(specs, spec.id) === "start" ? 1 : -1})"`,
          )
        : ICONS.chevronDown
      rail.append(text)
      rail.addEventListener("click", () => setCollapsed(spec.id, false))
      el.append(rail)
      el.dataset.rail = ""
      view.rail = rail
    }
    return view
  }

  specs.forEach((spec, i) => {
    if (i > 0) {
      const d = doc.createElement("div")
      d.className = "knobs-divider"
      d.tabIndex = 0
      d.dataset.index = String(i - 1)
      d.setAttribute("role", "separator")
      d.setAttribute("aria-orientation", row ? "vertical" : "horizontal")
      const a = specs[i - 1]!
      d.setAttribute("aria-label", `Resize ${a.title ?? a.id} and ${spec.title ?? spec.id}`)
      root.append(d)
      dividers.push(d)
      bindDivider(d, i - 1)
    }
    const view = makePane(spec)
    views.set(spec.id, view)
    root.append(view.el)
  })
  container.append(root)

  const along = (el: Element) => {
    const r = el.getBoundingClientRect()
    return row ? r.width : r.height
  }
  const total = () => along(root)
  const headerSize = (v: View) => (v.head ? v.head.getBoundingClientRect().height : 0)
  let railPx = 0
  const readRail = () => {
    const probe = doc.createElement("div")
    probe.style.cssText =
      "position:absolute;visibility:hidden;width:var(--ku-rail);height:var(--ku-rail)"
    root.append(probe)
    railPx = probe.getBoundingClientRect().width || 26
    probe.remove()
  }
  readRail()
  const rail = (id: string) => {
    const v = views.get(id)!
    return !row && v.head ? headerSize(v) : railPx
  }

  const fixed = () => {
    const out: Record<string, number> = {}
    for (const [id, s] of springs) out[id] = s.x
    return out
  }
  const target = () => solve({ panes: specs, sizes, collapsed, total: total(), rail })
  const current = () =>
    solve({ panes: specs, sizes, collapsed, total: total(), rail, fixed: fixed() })

  let lastReport = ""
  const render = (shown: Record<string, number>) => {
    for (const spec of specs) {
      const v = views.get(spec.id)!
      const size = Math.max(0, shown[spec.id] ?? 0)
      v.shown = size
      v.el.style.flexBasis = `${size}px`
      v.el.style[row ? "width" : "height"] = `${size}px`
      const isCollapsed = collapsed[spec.id]!
      const moving = springs.has(spec.id)
      v.el.toggleAttribute("data-collapsed", isCollapsed)
      v.el.toggleAttribute("data-settled", !moving)
      v.el.setAttribute("aria-hidden", String(isCollapsed && !moving))
      const r = rail(spec.id)
      const open = Math.max(v.open, r + 1)
      // Mid-collapse (or collapsed), the content keeps its open size and slides out by the
      // divider, clipped, while the rail fades in at the edge; nothing inside reflows.
      if (moving || isCollapsed) {
        const p = Math.min(1, Math.max(0, (open - size) / (open - r)))
        if (v.rail) {
          const visible = Math.max(0, ((size - r) / (open - r)) * open)
          const edge = edgeOf(specs, spec.id)
          const side = row
            ? edge === "start"
              ? "right"
              : "left"
            : edge === "start"
              ? "bottom"
              : "top"
          v.clip.style.cssText = `${row ? "width" : "height"}:${visible}px;${side}:0;${
            row
              ? side === "right"
                ? "left:auto"
                : "right:auto"
              : side === "bottom"
                ? "top:auto"
                : "bottom:auto"
          }`
          v.inner.style.cssText = `${row ? "width" : "height"}:${open}px;${side}:0;${
            row
              ? side === "right"
                ? "left:auto"
                : "right:auto"
              : side === "bottom"
                ? "top:auto"
                : "bottom:auto"
          }`
          v.rail.style.opacity = String(Math.max(0, (p - 0.35) / 0.65))
        } else {
          v.clip.style.cssText = ""
          v.inner.style.cssText = `height:${open}px;bottom:auto`
        }
      } else {
        v.clip.style.cssText = ""
        v.inner.style.cssText = ""
        if (v.rail) v.rail.style.opacity = "0"
      }
    }
    dividers.forEach((d, i) => {
      const a = specs[i]!
      const b = specs[i + 1]!
      d.setAttribute("aria-valuenow", String(Math.round(views.get(a.id)!.shown)))
      d.setAttribute("aria-controls", `${a.id} ${b.id}`)
    })
    const layout = snapshot()
    const report = JSON.stringify(layout)
    if (report !== lastReport) {
      lastReport = report
      options.onLayout?.(layout)
      for (const v of views.values()) v.el.dispatchEvent(new Event("knobs-pane-resize"))
      notifyLayout(doc)
    }
  }

  const snapshot = (): SplitLayout => {
    const s: Record<string, number> = {}
    for (const [id, v] of views) s[id] = Math.round(v.shown * 10) / 10
    return { sizes: s, collapsed: { ...collapsed } }
  }

  const persist = () => {
    if (!store || !key) return
    try {
      store.setItem(key, serializeLayout({ sizes, collapsed }))
    } catch {}
  }

  // Each pane's open size, for sliding its content while it collapses and the rail's fade.
  const rememberOpen = (shown: Record<string, number>) => {
    for (const spec of specs)
      if (!collapsed[spec.id] && !springs.has(spec.id)) views.get(spec.id)!.open = shown[spec.id]!
  }

  const loop = frameLoop(win, (dt) => {
    for (const [id, s] of springs) {
      s.step(dt)
      if (s.resting) springs.delete(id)
    }
    const shown = current()
    render(shown)
    if (springs.size === 0) {
      rememberOpen(shown)
      render(shown)
    }
    return springs.size > 0
  })

  /** Springs every pane from where it shows to the layout the state now asks for. */
  const animate = (motion = SETTLE) => {
    const to = target()
    if (reducedMotion(win)) {
      springs.clear()
      render(to)
      rememberOpen(to)
      return
    }
    for (const spec of specs) {
      const from = views.get(spec.id)!.shown
      const goal = to[spec.id]!
      const s = springs.get(spec.id)
      if (s) {
        s.omega = motion.omega
        s.zeta = motion.zeta
        s.set(goal)
      } else if (Math.abs(goal - from) > 0.5) {
        springs.set(spec.id, new Spring(from, motion.omega, motion.zeta, 0.2).set(goal))
      }
    }
    loop.wake()
  }

  function setCollapsed(id: string, value: boolean, save = true) {
    const spec = specs.find((p) => p.id === id)
    if (!spec?.collapsible || collapsed[id] === value) return
    const v = views.get(id)!
    if (value && !springs.has(id)) v.open = v.shown
    if (!value) {
      // Opening, the content lays out at the size it opens to, at once.
      collapsed[id] = false
      v.open = target()[id]!
    }
    collapsed[id] = value
    if (save) persist()
    animate(COLLAPSE)
  }

  const setSizes = (next: Record<string, number>) => {
    for (const [id, s] of Object.entries(next)) sizes[id] = s
  }

  function bindDivider(d: HTMLElement, index: number) {
    const a = specs[index]!
    const b = specs[index + 1]!
    let start: Record<string, number> | undefined
    let from = 0
    let pointer = -1
    d.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return
      e.preventDefault()
      d.focus({ preventScroll: true })
      // A drag takes the panes from wherever a spring had them.
      const shown = current()
      for (const id of [a.id, b.id]) springs.delete(id)
      start = { ...shown }
      for (const id of [a.id, b.id]) if (collapsed[id]) start[id] = rail(id)
      from = row ? e.clientX : e.clientY
      pointer = e.pointerId
      d.setPointerCapture(e.pointerId)
      d.dataset.active = ""
      doc.documentElement.dataset.knobsResizing = direction
    })
    d.addEventListener("pointermove", (e) => {
      if (!start || e.pointerId !== pointer) return
      const delta = (row ? e.clientX : e.clientY) - from
      const result = drag(specs, start, index, delta, collapsed)
      if (result.collapse) {
        const { id, collapsed: now } = result.collapse
        if (!now) for (const [k, s] of Object.entries(result.sizes)) if (k === id) sizes[k] = s
        setCollapsed(id, now, false)
        // The drag goes on from here.
        start = { ...target() }
        if (now) start[id] = rail(id)
        from = row ? e.clientX : e.clientY
        return
      }
      if (collapsed[a.id] || collapsed[b.id]) return
      setSizes(result.sizes)
      for (const id of [a.id, b.id]) springs.delete(id)
      const shown = current()
      render(shown)
      rememberOpen(shown)
    })
    const end = (e: PointerEvent) => {
      if (!start || e.pointerId !== pointer) return
      start = undefined
      delete d.dataset.active
      delete doc.documentElement.dataset.knobsResizing
      // A flexible pane's share is whatever it ended up showing.
      for (const spec of specs)
        if (flex.has(spec.id) && !collapsed[spec.id]) sizes[spec.id] = views.get(spec.id)!.shown
      persist()
    }
    d.addEventListener("pointerup", end)
    d.addEventListener("pointercancel", end)
    d.addEventListener("lostpointercapture", end)
    d.addEventListener("dblclick", (e) => {
      e.preventDefault()
      reset(a.id, b.id)
    })
    d.addEventListener("keydown", (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const back = row ? "ArrowLeft" : "ArrowUp"
      const fwd = row ? "ArrowRight" : "ArrowDown"
      const step = e.shiftKey ? 64 : 16
      let handled = true
      if (e.key === back || e.key === fwd) {
        const goal = target()
        // From a collapsed side, a step opens it first.
        const shut = [a.id, b.id].find((id) => collapsed[id])
        if (shut) setCollapsed(shut, false)
        else {
          setSizes(nudge(specs, goal, index, e.key === fwd ? step : -step))
          persist()
          animate()
        }
      } else if (e.key === "Home" || e.key === "End") {
        const goal = target()
        setSizes(nudge(specs, goal, index, e.key === "End" ? 1e6 : -1e6))
        persist()
        animate()
      } else if (e.key === "Enter" || e.key === " ") {
        const id = collapsibleSide(specs, index)
        if (id) setCollapsed(id, !collapsed[id])
        else handled = false
      } else if (e.key === "Escape") d.blur()
      else handled = false
      if (handled) {
        e.preventDefault()
        e.stopPropagation()
      }
    })
  }

  function reset(...ids: string[]) {
    const which = ids.length ? ids : specs.map((p) => p.id)
    for (const id of which) {
      delete sizes[id]
      const spec = specs.find((p) => p.id === id)
      if (spec?.collapsible) collapsed[id] = Boolean(spec.collapsed)
    }
    // Flexible panes share by their sizes: a reset gives them back equal shares.
    if (which.some((id) => flex.has(id))) for (const id of flex) delete sizes[id]
    persist()
    animate()
  }

  // First layout before the first paint, without motion.
  {
    const first = target()
    for (const spec of specs) {
      const open = { ...collapsed, [spec.id]: false }
      views.get(spec.id)!.open = collapsed[spec.id]
        ? solve({ panes: specs, sizes, collapsed: open, total: total(), rail })[spec.id]!
        : first[spec.id]!
    }
    render(first)
  }

  const ro = new ResizeObserver(() => {
    // A split made before it's in the page (a Solid component) reads its tokens once it is.
    readRail()
    if (springs.size) return loop.wake()
    const shown = target()
    render(shown)
    rememberOpen(shown)
  })
  ro.observe(root)

  const paneApi = (id: string): SplitPane => {
    const v = views.get(id)
    if (!v) throw new Error(`No pane "${id}"`)
    return {
      id,
      element: v.el,
      body: v.body,
      header: v.head,
      get size() {
        return v.shown
      },
      get collapsed() {
        return collapsed[id]!
      },
      collapse: (value = !collapsed[id]) => setCollapsed(id, value),
      resize: (size) => api.resize(id, size),
      title(text, count) {
        if (v.titleEl) v.titleEl.textContent = text
        if (v.countEl && count !== undefined) v.countEl.textContent = String(count)
        const label = v.rail?.querySelector("span")
        if (label) label.textContent = text
      },
    }
  }

  const api: Split = {
    element: root,
    pane: paneApi,
    layout: snapshot,
    collapse: (id, value) => setCollapsed(id, value ?? !collapsed[id]),
    resize(id, size) {
      const i = specs.findIndex((p) => p.id === id)
      if (i < 0) return
      if (collapsed[id]) setCollapsed(id, false)
      if (!flex.has(id)) sizes[id] = size
      else {
        // A flexible pane's size is what its neighbour leaves it.
        const goal = target()
        const j = i > 0 ? i - 1 : i
        const delta = size - goal[id]!
        setSizes(nudge(specs, goal, j, j === i ? delta : -delta))
      }
      persist()
      animate()
    },
    reset: (id) => (id ? reset(id) : reset()),
    dispose() {
      loop.stop()
      ro.disconnect()
      root.remove()
    },
  }
  return api
}
