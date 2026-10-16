import { Spring, springMotion } from "../core/spring.js"
import { storageKey, browserStorage, type StoragePort } from "../core/storage.js"
import {
  applyLook,
  frameLoop,
  ICONS,
  notifyLayout,
  reducedMotion,
  syncFrame,
  type UiLook,
} from "./look.js"
import { hints } from "../panel/page-hints.js"
import { tooltip } from "./tooltip.js"
import {
  chevronTurn,
  collapsibleSide,
  drag,
  edgeOf,
  flexible,
  foldFaces,
  foldProgress,
  nudge,
  parseLayout,
  serializeLayout,
  solve,
  type FoldFaces,
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
  /**
   * Header actions, collapse buttons and the rails of collapsed panes take codes in the page's
   * hint mode (`s`), on by default; a code presses its button.
   */
  readonly hints?: boolean
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

// Folding and opening a pane: smooth, or calm for a touch brisker.
const FOLD_SPRINGS = {
  smooth: { duration: 0.45, bounce: 0 },
  calm: { duration: 0.4, bounce: 0 },
} as const
const COLLAPSE = springMotion(FOLD_SPRINGS.smooth)
const SETTLE = springMotion({ duration: 0.3, bounce: 0 })
/** The content's blur as it fades out (px), and the rail label's. */
const CONTENT_BLUR = 3
const LABEL_BLUR = 2

/** Sets an inline style property only when it changes. */
const put = (el: HTMLElement | SVGElement, prop: string, value: string) => {
  if (el.style.getPropertyValue(prop) !== value) el.style.setProperty(prop, value)
}
/** Out of reach of assistive tech (a folded pane's content). */
const hide = (el: HTMLElement, hidden: boolean) => {
  if (hidden) el.setAttribute("aria-hidden", "true")
  else el.removeAttribute("aria-hidden")
}
/** A face at opacity `a`, blurred by up to `blur` px as it fades. */
const fade = (el: HTMLElement, a: number, blur: number) => {
  put(el, "opacity", a >= 1 ? "" : a.toFixed(3))
  put(el, "filter", a >= 1 || a <= 0 || !blur ? "" : `blur(${(blur * (1 - a)).toFixed(2)}px)`)
}

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
  // Inside another split's pane, that pane is only a slot: this split's panes are the cards.
  const host = container.closest<HTMLElement>(".knobs-pane")
  host?.setAttribute("data-nested", "")

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
    railLabel?: HTMLElement
    /** The rail's chevron, which stands in for the header's collapse button and turns with it. */
    chevron?: HTMLElement
    turn?: HTMLElement
    /** The header's collapse icon (hidden while the rail's chevron stands in for it). */
    toggleIcon?: Element
    edge: "start" | "end"
    /** The size being animated toward and from: what the pane has open. */
    open: number
    shown: number
    /** Folding or opening (until its spring rests): its content keeps the open size meanwhile. */
    folding: boolean
    faces: FoldFaces
    /** Its header's height, measured. */
    headPx: number
    /** Where the collapse icon sits against the rail's chevron, measured (see `measureChevrons`). */
    chev: { iconEnd: number; chevEnd: number; dy: number; scale: number }
  }
  const views = new Map<string, View>()
  const dividers: HTMLElement[] = []
  const springs = new Map<string, Spring>()

  const makePane = (spec: PaneOptions): View => {
    const el = doc.createElement("section")
    el.className = "knobs-pane"
    el.dataset.pane = spec.id
    const edge = edgeOf(specs, spec.id)
    el.dataset.edge = edge
    const clip = doc.createElement("div")
    clip.className = "knobs-pane-clip"
    const inner = doc.createElement("div")
    inner.className = "knobs-pane-inner"
    const body = doc.createElement("div")
    body.className = "knobs-pane-body"
    const shut = Boolean(collapsed[spec.id])
    const view: View = {
      spec,
      el,
      clip,
      inner,
      body,
      edge,
      open: 0,
      shown: 0,
      folding: false,
      faces: { content: shut ? 0 : 1, rail: shut ? 1 : 0 },
      headPx: 0,
      chev: { iconEnd: 0, chevEnd: 0, dy: 0, scale: 1 },
    }
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
          b.firstElementChild?.setAttribute("style", edge === "start" ? "transform:scaleX(-1)" : "")
        else b.firstElementChild?.classList.add("knobs-pane-caret")
        view.toggleIcon = b.firstElementChild ?? undefined
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
    if (spec.scroll ?? spec.title !== undefined) {
      el.dataset.scroll = ""
      body.classList.add("knobs-scroll-fade")
    }
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
      text.className = "knobs-pane-rail-label"
      text.textContent = spec.rail ?? spec.title ?? ""
      // The chevron: a slot that keeps its place in the rail (it's measured) and, inside it, the
      // icon that turns and travels to the header's collapse button.
      const chevron = doc.createElement("span")
      chevron.className = "knobs-pane-chevron"
      const turn = doc.createElement("span")
      turn.className = "knobs-pane-turn"
      turn.innerHTML = row
        ? ICONS.caret.replace("<svg", `<svg style="transform:scaleX(${edge === "start" ? 1 : -1})"`)
        : ICONS.chevronDown
      chevron.append(turn)
      rail.append(chevron, text)
      rail.addEventListener("click", () => setCollapsed(spec.id, false))
      el.append(rail)
      el.dataset.rail = ""
      view.rail = rail
      view.railLabel = text
      view.chevron = chevron
      view.turn = turn
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
  // A card sits half a gap inside its slot (--ku-pane-m; 0 in the flat frame).
  let paneM = 0
  const marginOf = (v: View) => (v.el.hasAttribute("data-nested") ? 0 : paneM)
  const headerSize = (v: View) => (v.head ? v.headPx + marginOf(v) * 2 : 0)
  let railPx = 0
  let measured = false
  /** Reads the tokens the layout takes (the rail, the cards' inset) and the headers' heights. */
  const measure = () => {
    syncFrame(root)
    const probe = doc.createElement("div")
    probe.style.cssText =
      "position:absolute;visibility:hidden;width:var(--ku-rail);height:var(--ku-pane-m)"
    root.append(probe)
    const r = probe.getBoundingClientRect()
    paneM = r.height
    railPx = (r.width || 26) + paneM * 2
    probe.remove()
    for (const v of views.values()) if (v.head) v.headPx = v.head.getBoundingClientRect().height
    measured = root.isConnected && r.width > 0
  }
  /**
   * Where each header's collapse icon sits against its rail's chevron: from the inner's end and
   * the rail's end (both of which travel with the pane's moving edge), and down. Read at rest,
   * after a render, so the chevron lands on the icon to the pixel.
   */
  const measureChevrons = () => {
    if (!row) return
    for (const v of views.values()) {
      if (!v.chevron || !v.toggleIcon || !v.rail) continue
      const inner = v.inner.getBoundingClientRect()
      const icon = v.toggleIcon.getBoundingClientRect()
      const rail = v.rail.getBoundingClientRect()
      const chev = v.chevron.getBoundingClientRect()
      if (!inner.width || !chev.width) continue
      v.chev = {
        iconEnd: inner.right - (icon.left + icon.width / 2),
        chevEnd: rail.right - (chev.left + chev.width / 2),
        dy: icon.top + icon.height / 2 - inner.top - (chev.top + chev.height / 2 - rail.top),
        scale: icon.width / chev.width,
      }
    }
  }
  measure()
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

  // The side a pane folds toward, where its content and rail hold on while it moves.
  const SIDES = { row: ["right", "left"], column: ["bottom", "top"] } as const
  const sides = (v: View) => {
    const [a, b] = SIDES[direction]
    return v.edge === "start" ? ([a, b] as const) : ([b, a] as const)
  }

  /**
   * One pane folding, opening or at rest. The card (the clip) is the one shape: it follows the
   * pane's size. While it folds, its content keeps the open size, holds on to the moving edge and
   * slides under the card's far side, fading (and blurring) out early; the rail's label fades in
   * late, in place at the edge; the chevron turns half a turn and travels from the header's
   * collapse button to the rail. Nothing inside reflows, and every value follows the size, so a
   * fold that turns back mid-flight carries on from where it is.
   */
  const renderFold = (v: View, size: number) => {
    const id = v.spec.id
    const isCollapsed = collapsed[id]!
    const folding = isCollapsed || v.folding
    const r = rail(id)
    const open = folding ? Math.max(v.open, r + 1) : size
    const p = folding ? foldProgress(size, open, r) : 0
    v.faces = foldFaces(v.faces, p)
    const m = marginOf(v)
    const settled = !springs.has(id)
    // Folded and still, the content is hidden (visibility) rather than faded: no opacity left on
    // it, which would make a stacking context that sends a panel mounted inside to the DOM.
    const content = isCollapsed && settled ? 1 : v.faces.content
    // The fading face gets a layer of its own while it moves, so the fade doesn't repaint it.
    put(v.rail ? v.inner : v.body, "will-change", v.folding ? "opacity, filter" : "")
    if (!v.rail) {
      // A column's dock folds to its header: the header stays, the body fades.
      put(v.inner, "height", folding ? `${open - m * 2}px` : "")
      put(v.inner, "bottom", folding ? "auto" : "")
      fade(v.body, content, CONTENT_BLUR)
      if (v.toggleIcon)
        put(v.toggleIcon as SVGElement, "transform", p ? `rotate(${(-90 * p).toFixed(2)}deg)` : "")
      hide(v.body, isCollapsed && settled)
      return
    }
    const [side, far] = sides(v)
    put(v.inner, row ? "width" : "height", folding ? `${open - m * 2}px` : "")
    put(v.inner, side, folding ? "0" : "")
    put(v.inner, far, folding ? "auto" : "")
    fade(v.inner, content, CONTENT_BLUR)
    hide(v.clip, isCollapsed && settled)
    // The chevron stands in for the header's collapse icon when there's one to morph from.
    const morph = row && Boolean(v.toggleIcon) && !v.el.hasAttribute("data-nested")
    v.el.toggleAttribute("data-morph", morph)
    if (morph) {
      put(v.rail, "opacity", "1")
      fade(v.railLabel!, v.faces.rail, LABEL_BLUR)
      const c = v.chev
      // The icon's offset from the chevron, both measured from their ends at the moving edge;
      // at the end edge the inner reaches past the rail by the rest of the open size.
      const dx = c.chevEnd - c.iconEnd + (v.edge === "end" ? open - r : 0)
      const k = 1 - p
      put(
        v.turn!,
        "transform",
        k === 0
          ? ""
          : `translate(${(dx * k).toFixed(2)}px,${(c.dy * k).toFixed(2)}px) rotate(${chevronTurn(p, v.edge).toFixed(2)}deg) scale(${(1 + (c.scale - 1) * k).toFixed(4)})`,
      )
    } else {
      // No header to morph from (or a slot of a nested split): the rail fades in whole.
      const a = v.faces.rail
      put(v.rail, "opacity", a >= 1 ? "1" : a.toFixed(3))
      put(v.railLabel!, "opacity", "")
      put(
        v.railLabel!,
        "filter",
        a >= 1 || a <= 0 ? "" : `blur(${(LABEL_BLUR * (1 - a)).toFixed(2)}px)`,
      )
      put(v.turn!, "transform", "")
    }
  }

  let lastReport = ""
  const render = (shown: Record<string, number>) => {
    for (const spec of specs) {
      const v = views.get(spec.id)!
      const size = Math.max(0, shown[spec.id] ?? 0)
      v.shown = size
      put(v.el, "flex-basis", `${size}px`)
      put(v.el, row ? "width" : "height", `${size}px`)
      v.el.toggleAttribute("data-collapsed", collapsed[spec.id]!)
      v.el.toggleAttribute("data-settled", !springs.has(spec.id))
      if (spec.collapsible) renderFold(v, size)
    }
    dividers.forEach((d, i) => {
      const a = specs[i]!
      const b = specs[i + 1]!
      const now = String(Math.round(views.get(a.id)!.shown))
      if (d.getAttribute("aria-valuenow") !== now) d.setAttribute("aria-valuenow", now)
      if (!d.hasAttribute("aria-controls")) d.setAttribute("aria-controls", `${a.id} ${b.id}`)
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

  // Each pane's open size, which its content keeps while it folds.
  const rememberOpen = (shown: Record<string, number>) => {
    for (const spec of specs)
      if (!collapsed[spec.id] && !springs.has(spec.id)) views.get(spec.id)!.open = shown[spec.id]!
  }

  const loop = frameLoop(win, (dt) => {
    for (const [id, s] of springs) {
      s.step(dt)
      if (s.resting) {
        springs.delete(id)
        views.get(id)!.folding = false
      }
    }
    const shown = current()
    if (springs.size === 0) rememberOpen(shown)
    render(shown)
    return springs.size > 0
  })

  /** Springs every pane from where it shows to the layout the state now asks for. */
  const animate = (motion = SETTLE) => {
    const to = target()
    // Opening, the content lays out at the size it opens to, at once.
    for (const v of views.values()) if (v.folding && !collapsed[v.spec.id]) v.open = to[v.spec.id]!
    if (reducedMotion(win)) {
      // No travel: the panes take their sizes and the face that arrives fades in, briefly.
      springs.clear()
      const arriving = [...views.values()]
        .filter((v) => v.folding)
        .map((v) => (collapsed[v.spec.id] ? v.rail : v.rail ? v.inner : v.body))
      for (const v of views.values()) v.folding = false
      rememberOpen(to)
      render(to)
      for (const el of arriving)
        el?.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: 160,
          easing: "cubic-bezier(.2,.8,.2,1)",
        })
      return
    }
    for (const spec of specs) {
      const v = views.get(spec.id)!
      const goal = to[spec.id]!
      const s = springs.get(spec.id)
      if (s) {
        s.omega = motion.omega
        s.zeta = motion.zeta
        s.set(goal)
      } else if (Math.abs(goal - v.shown) > 0.5) {
        springs.set(spec.id, new Spring(v.shown, motion.omega, motion.zeta, 0.2).set(goal))
      } else v.folding = false
    }
    loop.wake()
  }

  /** Marks a pane folding (or opening); `animate` moves it. */
  const fold = (id: string, value: boolean) => {
    const v = views.get(id)!
    // Its content keeps the size it had open; turning back mid-fold, the one it was keeping.
    if (value && !v.folding) v.open = v.shown
    collapsed[id] = value
    v.folding = true
  }

  /** Hands a pane to the pointer: its spring stops where it is. */
  const release = (id: string) => {
    springs.delete(id)
    views.get(id)!.folding = false
  }

  function setCollapsed(id: string, value: boolean, save = true) {
    const spec = specs.find((p) => p.id === id)
    if (!spec?.collapsible || collapsed[id] === value) return
    fold(id, value)
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
      // A drag takes the panes from wherever a spring had them (a folding one finishes).
      const shown = current()
      for (const id of [a.id, b.id]) if (!collapsed[id]) release(id)
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
      for (const id of [a.id, b.id]) release(id)
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
    let folds = false
    for (const id of which) {
      delete sizes[id]
      const spec = specs.find((p) => p.id === id)
      const shut = Boolean(spec?.collapsed)
      if (spec?.collapsible && collapsed[id] !== shut) {
        fold(id, shut)
        folds = true
      }
    }
    // Flexible panes share by their sizes: a reset gives them back equal shares.
    if (which.some((id) => flex.has(id))) for (const id of flex) delete sizes[id]
    persist()
    animate(folds ? COLLAPSE : SETTLE)
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
    measureChevrons()
    render(first)
  }

  /** Lays the panes out again; `remeasure` reads the tokens and the chevrons afresh. */
  const relayout = (remeasure: boolean) => {
    if (remeasure) measure()
    if (springs.size) {
      if (remeasure) measureChevrons()
      return loop.wake()
    }
    const shown = target()
    rememberOpen(shown)
    render(shown)
    if (remeasure) {
      measureChevrons()
      render(shown)
    }
  }
  // Every resize lays out again (a neighbour's spring, nested, comes through here each frame);
  // a split made before it's in the page (a Solid component) reads its tokens once it is.
  const ro = new ResizeObserver(() => relayout(!measured))
  ro.observe(root)
  // restyle() changed the look: the rail and the cards' inset come from the tokens.
  const restyled = () => relayout(true)
  root.addEventListener("knobs-restyle", restyled)

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
        if (v.railLabel) v.railLabel.textContent = text
      },
    }
  }

  const unregisterHints =
    options.hints === false
      ? undefined
      : hints.register(
          root,
          () =>
            [...views.values()].flatMap((v) => [
              ...(v.head?.querySelectorAll<HTMLElement>(":scope > .knobs-pane-btn") ?? []),
              ...(v.rail && collapsed[v.spec.id] ? [v.rail] : []),
            ]),
          { listen: false, rank: 1 },
        )

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
      unregisterHints?.()
      loop.stop()
      ro.disconnect()
      root.removeEventListener("knobs-restyle", restyled)
      host?.removeAttribute("data-nested")
      root.remove()
    },
  }
  return api
}
