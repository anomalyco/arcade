import { Spring, springMotion } from "../core/spring.js"
import { arrowOf } from "./prefs.js"
import type { MountPanelOptions } from "../core/store.js"
import type { Panel } from "./panel.js"
import { isRevealingIn, resize, reveal } from "./reveal.js"
import { createChoice } from "./choice.js"

export interface MountPageOptions extends MountPanelOptions {
  /** Section order; sections not listed follow in the order they first appear. */
  readonly sections?: readonly string[]
  /** The narrowest a column may get before the page drops one (px). Default 300. */
  readonly columnWidth?: number
  /** `/` filters rows by label, live. Default true. */
  readonly filter?: boolean
}

export interface PageCardOptions {
  readonly title?: string
  /** The section the card sits in; a new one is added after the others. */
  readonly section?: string
  /** Any content, placed in the card's body (more can follow with `card.body.append`). */
  readonly element?: HTMLElement
  /**
   * Makes the card collapsible, starting folded (`true`) or open (`false`): its header toggles it
   * (a click, or Enter where it's focused) and shows a caret. A reload brings back what it was
   * last in this tab.
   */
  readonly collapsed?: boolean
  /** One quiet line on the right of a folded card's header, e.g. "iPhone · 0.142.4 · connected". */
  readonly summary?: string | Node
}

export interface PageItem {
  readonly label: string
  readonly detail?: string
  onSelect?(): void
}

export interface PageAction {
  readonly label: string
  run(): void
  readonly disabled?: boolean
}

/** A control in a custom card; `set` shows a value that arrived from elsewhere (no `onChange`). */
export interface PageControl<T> {
  readonly element: HTMLElement
  get(): T
  set(value: T): void
}

export interface PageCard {
  /** The card itself. */
  readonly element: HTMLElement
  /** Where content goes. */
  readonly body: HTMLElement
  /** Right side of the card's header, for a badge or a small button. */
  readonly accessory: HTMLElement
  /**
   * A choice row, like a choice field (no `label` spans the card): segmented while the labels fit
   * and there are at most four, a drop-down menu otherwise; `display` fixes one or the other.
   */
  choice<T extends string>(options: {
    readonly label?: string
    readonly options: readonly (T | { readonly value: T; readonly label: string })[]
    readonly value: T
    readonly display?: "menu" | "segmented"
    onChange(value: T): void
  }): PageControl<T>
  /** A switch row. */
  toggle(options: {
    readonly label: string
    readonly value: boolean
    onChange(value: boolean): void
  }): PageControl<boolean>
  /**
   * A row of buttons; `set` swaps them, keyed by label: buttons that stay glide to their place,
   * the rest cross-fade, and the row folds away while it's empty.
   */
  actions(items: readonly PageAction[]): {
    readonly element: HTMLElement
    set(items: readonly PageAction[]): void
  }
  /** A list row: a label, a quieter detail and, with `onSelect`, a keyboard stop (Enter). */
  item(options: PageItem): HTMLElement
  /**
   * Rows kept by key: `set` updates the ones that stay, folds new ones open and removed ones
   * shut, so the card's height eases and the cards below glide.
   */
  list(items?: readonly (PageItem & { readonly key: string })[]): {
    readonly element: HTMLElement
    set(items: readonly (PageItem & { readonly key: string })[]): void
  }
  /** Folds a row (or anything in the card) open or shut. */
  show(element: HTMLElement, visible: boolean): void
  /**
   * Folds the card down to its header (or back open, with `false`); the cards below in its
   * column glide. Makes a card collapsible if it wasn't.
   */
  collapse(collapsed?: boolean): void
  /** Whether the card is folded to its header. */
  readonly collapsed: boolean
  /** Replaces the folded header's summary (`null` clears it). */
  summary(content: string | Node | null): void
  /** Empties the body. */
  clear(): void
  remove(): void
}

/**
 * What's on screen elsewhere (a phone's current screen): group ids (or custom card titles) and
 * section ids. `null` clears it.
 */
export interface PageHighlight {
  readonly groups?: readonly string[]
  readonly sections?: readonly string[]
}

export interface Page extends Panel {
  /** A card of your own in the page's grid, styled by the same tokens. */
  card(options: PageCardOptions): PageCard
  /**
   * Emphasizes what's on screen: highlighted cards and sections keep full strength, with a small
   * dot by the title of each highlighted section (or of a card highlighted on its own); the rest
   * dims a little, readable and fully interactive (a dimmed card you focus comes back up). Every
   * change glides on the panel spring and can be interrupted. `null` clears it.
   *
   * `reveal: true` glides the first highlighted card (or its section's heading) into view when
   * it's off screen, unless the user scrolled, pressed a key or touched the page in the last two
   * seconds, or is dragging.
   */
  highlight(target: PageHighlight | null, options?: { readonly reveal?: boolean }): void
}

export interface PageLayout {
  /** Each showing section's label (the overlay draws their text). */
  readonly sections: readonly { readonly element: HTMLElement; readonly head: HTMLElement | null }[]
  add(tile: HTMLElement, section: string): void
  /** Folds the card away, then takes it out of the page. */
  remove(tile: HTMLElement): void
  /** Re-balances the columns when their count changed (or always, with `force`). */
  pack(force?: boolean): void
  /**
   * Applies a structural change (the filter, cards shown or hidden) and animates the result:
   * `rows` whose `hidden` changed fold open or shut, cards glide to their new places.
   */
  change(mutate: () => void, rows?: readonly HTMLElement[]): void
  /** Steps the motion now, at the start of the overlay's frame (`now` from requestAnimationFrame). */
  frame(now: number): void
  /** A card's content changed at once (it was drawn `from` px tall): its height eases there. */
  resize(tile: HTMLElement, from: number): void
  /** Emphasizes the cards and sections in `target` and dims the rest (see `Page.highlight`). */
  highlight(target: PageHighlight | null): void
  /** Highlighted cards and section headings that show, top to bottom. */
  highlighted(): HTMLElement[]
  /**
   * How a card or section heading is emphasized right now: `dim` (0 full … the token's
   * `--k-page-dim`) and its dot (`mark` 0…1), as the DOM draws them.
   */
  emphasis(
    node: HTMLElement,
  ): { readonly dim: number; readonly mark: number; readonly dot?: HTMLElement } | undefined
  /** While cards glide or change height, or something folds inside them. */
  readonly moving: boolean
  readonly version: number
  dispose(): void
}

/**
 * Splits `heights` into at most `n` contiguous runs whose tallest is as short as possible, so
 * reading down a column and on to the next follows the original order.
 */
export function balancedRuns(heights: readonly number[], n: number, gap = 0): number[] {
  return pageColumns(
    heights.map((height) => ({ height, section: 0 })),
    n,
    { gap },
  ).map((c) => c.end - c.start)
}

export interface PageColumnItem {
  readonly height: number
  /** Cards of a section are contiguous; sections are numbered in reading order. */
  readonly section: number
}

export type PageColumnEntry =
  | { readonly kind: "label"; readonly section: number; readonly continued: boolean }
  | { readonly kind: "card"; readonly index: number }

export interface PageColumn {
  /** The column holds items `start` to `end - 1`. */
  readonly start: number
  readonly end: number
  readonly height: number
  /** Top to bottom: a label over each section's first card here, then the cards. */
  readonly entries: readonly PageColumnEntry[]
}

/**
 * Lays a page's cards into `n` independent columns that keep their reading order (down a
 * column, then the next). A column holds part of one section (a long section takes several
 * adjacent columns) or several whole sections stacked; it never ends one section and starts
 * another midway. The tallest column is as short as possible, and the rest as even as they can
 * be. Each column opens with its section's label (`continued` when the section began in the
 * column before); a section stacked below another gets a label and `space` above it.
 */
export function pageColumns(
  items: readonly PageColumnItem[],
  n: number,
  options: {
    readonly gap?: number
    /** A section's label height (0 for none). */
    readonly label?: (section: number) => number
    readonly space?: number
  } = {},
): PageColumn[] {
  const m = items.length
  if (m === 0) return []
  const k = Math.max(1, Math.min(n, m))
  const gap = options.gap ?? 0
  const space = options.space ?? 0
  const label = options.label ?? (() => 0)
  const sec = items.map((i) => i.section)
  const starts = (i: number) => i === 0 || sec[i - 1] !== sec[i]
  const ends = (j: number) => j === m || sec[j] !== sec[j - 1]
  // cost[i][j]: a column of items i…j-1 (Infinity when it would split a section and hold another).
  const cost = Array.from({ length: m + 1 }, () => new Array<number>(m + 1).fill(Infinity))
  for (let i = 0; i < m; i++) {
    const top = label(sec[i]!)
    let h = top > 0 ? top + gap : 0
    let mixed = false
    for (let j = i + 1; j <= m; j++) {
      const at = j - 1
      if (at > i && sec[at] !== sec[at - 1]) {
        mixed = true
        const l = label(sec[at]!)
        if (l > 0) h += l + space + gap
      }
      h += items[at]!.height + (at > i ? gap : 0)
      if (!mixed || (starts(i) && ends(j))) cost[i]![j] = h
    }
  }
  const solve = (score: (before: number, run: number) => number, limit: number) => {
    const best = Array.from({ length: k + 1 }, () => new Array<number>(m + 1).fill(Infinity))
    const cut = Array.from({ length: k + 1 }, () => new Array<number>(m + 1).fill(0))
    best[0]![0] = 0
    for (let c = 1; c <= k; c++)
      for (let j = c; j <= m; j++)
        for (let i = c - 1; i < j; i++) {
          const run = cost[i]![j]!
          const before = best[c - 1]![i]!
          if (run > limit || before === Infinity) continue
          const v = score(before, run)
          if (v < best[c]![j]! - 1e-6) {
            best[c]![j] = v
            cut[c]![j] = i
          }
        }
    return { best, cut }
  }
  const tallest = solve(Math.max, Infinity).best[k]![m]!
  // Among layouts as short as that, the most even (least sum of squared heights).
  const { cut } = solve((before, run) => before + run * run, tallest + 0.5)
  const columns: PageColumn[] = []
  let j = m
  for (let c = k; c >= 1; c--) {
    const i = cut[c]![j]!
    const entries: PageColumnEntry[] = []
    for (let at = i; at < j; at++) {
      if ((at === i || sec[at] !== sec[at - 1]) && label(sec[at]!) > 0)
        entries.push({ kind: "label", section: sec[at]!, continued: !starts(at) })
      entries.push({ kind: "card", index: at })
    }
    columns.unshift({ start: i, end: j, height: cost[i]![j]!, entries })
    j = i
  }
  return columns
}

interface Section {
  readonly name: string
  readonly rank: number
  readonly label: HTMLElement | null
  readonly tiles: HTMLElement[]
  /** Blank labels topping the section's later columns, so their cards line up with the first. */
  readonly spacers: HTMLElement[]
}

/** A card's motion: its offset from where the layout puts it, and its height while that eases. */
interface Motion {
  readonly x: Spring
  readonly y: Spring
  h?: Spring
  /** A section label fading in. */
  o?: Spring
  /** Growing in from nothing or folding away (from or to this height): padding and the gap below ease with the height. */
  fold?: number
}

/** Cards glide on a spring that barely overshoots; heights ease without any. */
const GLIDE = { omega: 22, zeta: 0.9 }
const SIZE = { omega: 24, zeta: 1 }
/** Column changes from a resize wait this long, so dragging the window doesn't churn. */
const RESIZE_MS = 120

export function createPageLayout(
  doc: Document,
  host: HTMLElement,
  options: {
    order: readonly string[]
    columnWidth: number
    /** What a section's heading says (its name by default). */
    sectionLabel?(name: string): string
    /** Cards moved in the DOM (re-sort anything kept in page order). */
    onLayout(): void
    /** Motion started or settled (the overlay re-reads rects). */
    wake(): void
  },
): PageLayout {
  const win = doc.defaultView!
  const sections: Section[] = []
  let appeared = 0
  let cols = 0
  let version = 0
  let ready = false
  const el = (cls: string, tag: keyof HTMLElementTagNameMap = "div") => {
    const node = doc.createElement(tag)
    node.className = cls
    return node
  }
  const grid = el("knobs-columns")
  host.append(grid)
  const columns: HTMLElement[] = []
  /** Cards added since the last layout; they grow in when it runs. */
  const pending = new Set<HTMLElement>()
  /** Cards folding away: what to do once they're gone. */
  const leaving = new Map<HTMLElement, () => void>()
  const motions = new Map<HTMLElement, Motion>()
  /** Each card's natural height when last seen, to tell a sudden change from a gradual one. */
  const known = new WeakMap<HTMLElement, number>()
  const reduced = () => win.matchMedia("(prefers-reduced-motion: reduce)").matches
  const gapOf = () => parseFloat(getComputedStyle(grid).columnGap) || 0

  const sectionFor = (name: string) => {
    let s = sections.find((x) => x.name === name)
    if (s) return s
    const listed = options.order.indexOf(name)
    const rank =
      name === "" && listed < 0 ? -1 : listed >= 0 ? listed : options.order.length + appeared++
    let label: HTMLElement | null = null
    if (name) {
      label = el("knobs-section-head", "h2")
      label.dataset.section = name
      const text = el("knobs-section-name", "span")
      text.textContent = options.sectionLabel?.(name) ?? name
      label.append(text)
    }
    s = { name, rank, label, tiles: [], spacers: [] }
    const after = sections.findIndex((x) => x.rank > rank)
    if (after < 0) sections.push(s)
    else sections.splice(after, 0, s)
    return s
  }
  const tilesInOrder = () => sections.flatMap((s) => s.tiles)
  const sectionOf = (tile: HTMLElement) => sections.find((s) => s.tiles.includes(tile))
  const showing = (tile: HTMLElement) => !tile.hidden && !leaving.has(tile)

  function fit() {
    const gap = gapOf()
    const shown = tilesInOrder().filter(showing).length
    const across = Math.floor((grid.clientWidth + gap) / (options.columnWidth + gap))
    return Math.max(1, Math.min(8, shown, across))
  }

  // ── Emphasis ────────────────────────────────────────────────────────────────────────────────
  /** A card's or heading's emphasis: `e` 1 full … 0 dimmed, and its dot `m` 0…1. */
  interface Glow {
    readonly e: Spring
    readonly m: Spring
    veil?: HTMLElement
    dot?: HTMLElement
  }
  let lit: { groups: Set<string>; sections: Set<string> } | null = null
  const glows = new Map<HTMLElement, Glow>()
  const glowing = new Set<HTMLElement>()
  let dimAmount = 0.4
  /** The panel spring (--k-spring: duration bounce), which every token change glides on too. */
  const panelSpring = () => {
    const [duration, bounce] = getComputedStyle(host)
      .getPropertyValue("--k-spring")
      .trim()
      .split(/\s+/)
      .map(Number)
    return Number.isFinite(duration) && Number.isFinite(bounce)
      ? springMotion({ duration: duration!, bounce: bounce! })
      : { omega: 30, zeta: 0.88 }
  }
  const idOf = (tile: HTMLElement) => tile.dataset.group ?? tile.dataset.card
  const focusedIn = (node: HTMLElement) => node.contains(doc.activeElement)
  /** Whether a card is highlighted, and whether it wears its own dot (not its section's). */
  const litTile = (tile: HTMLElement) => {
    if (!lit) return { on: true, own: false }
    const section = sectionOf(tile)?.name ?? ""
    const byGroup = idOf(tile) !== undefined && lit.groups.has(idOf(tile)!)
    const bySection = lit.sections.has(section)
    return { on: byGroup || bySection, own: byGroup && !bySection }
  }
  function glowFor(node: HTMLElement) {
    let g = glows.get(node)
    if (!g) {
      g = { e: new Spring(1, 30, 0.88, 0.002), m: new Spring(0, 30, 0.88, 0.002) }
      glows.set(node, g)
    }
    return g
  }
  function writeGlow(node: HTMLElement, g: Glow) {
    const e = Math.min(1, Math.max(0, g.e.x))
    const m = Math.min(1.2, Math.max(0, g.m.x))
    const dim = (1 - e) * dimAmount
    const isHead = node.classList.contains("knobs-section-head")
    if (isHead) {
      const text = node.querySelector<HTMLElement>(":scope > .knobs-section-name")
      if (text) text.style.opacity = dim > 0.0005 ? String(1 - dim) : ""
    } else if (dim > 0.0005 || g.veil) {
      if (!g.veil) {
        g.veil = doc.createElement("span")
        g.veil.className = "knobs-veil"
        g.veil.setAttribute("aria-hidden", "true")
      }
      if (g.veil.parentElement !== node) node.append(g.veil)
      g.veil.style.opacity = String(dim)
      g.veil.hidden = dim <= 0.0005
    }
    if (m > 0.002 || g.dot) {
      // A card's dot sits on the card itself, level with its header (one there is).
      const parent = isHead || node.querySelector(":scope > .knobs-group-head") ? node : null
      if (parent) {
        if (!g.dot) {
          g.dot = doc.createElement("i")
          g.dot.className = "knobs-mark"
          g.dot.setAttribute("aria-hidden", "true")
        }
        if (g.dot.parentElement !== parent) parent.append(g.dot)
        g.dot.style.opacity = String(Math.min(1, m))
        g.dot.style.transform = `scale(${0.4 + 0.6 * m})`
        g.dot.hidden = m <= 0.002
      }
    }
  }
  /** Points every card and heading at its emphasis; they glide there. */
  function retarget() {
    const animate = ready && !reduced()
    const { omega, zeta } = panelSpring()
    const shownSections = new Set<string>()
    for (const t of tilesInOrder()) {
      const { on, own } = litTile(t)
      const name = sectionOf(t)?.name ?? ""
      if (on) shownSections.add(name)
      t.classList.toggle("knobs-highlighted", Boolean(lit) && on)
      t.classList.toggle("knobs-dimmed", Boolean(lit) && !on)
      aim(t, on || focusedIn(t) ? 1 : 0, own ? 1 : 0)
    }
    for (const s of sections) {
      if (!s.label) continue
      const on = !lit || lit.sections.has(s.name) || shownSections.has(s.name)
      s.label.classList.toggle("knobs-highlighted", Boolean(lit) && on)
      s.label.classList.toggle("knobs-dimmed", Boolean(lit) && !on)
      aim(s.label, on ? 1 : 0, lit?.sections.has(s.name) ? 1 : 0)
    }
    function aim(node: HTMLElement, e: number, m: number) {
      const known = glows.get(node)
      if (!known && e === 1 && m === 0) return
      const g = glowFor(node)
      for (const sp of [g.e, g.m]) {
        sp.omega = omega
        sp.zeta = zeta
      }
      g.e.set(e)
      g.m.set(m)
      if (!animate) {
        g.e.snap(e)
        g.m.snap(m)
        writeGlow(node, g)
      } else if (!g.e.resting || !g.m.resting) glowing.add(node)
    }
    run()
    options.wake()
  }
  const onFocus = () => {
    if (lit) retarget()
  }
  host.addEventListener("focusin", onFocus)
  host.addEventListener("focusout", onFocus)

  // ── Motion ──────────────────────────────────────────────────────────────────────────────────
  let raf = 0
  let last = 0
  let gapPx = 0
  const motionFor = (node: HTMLElement) => {
    let m = motions.get(node)
    if (!m) {
      m = {
        x: new Spring(0, GLIDE.omega, GLIDE.zeta, 0.05),
        y: new Spring(0, GLIDE.omega, GLIDE.zeta, 0.05),
      }
      motions.set(node, m)
    }
    return m
  }
  const sizeSpring = (from: number, to: number) =>
    new Spring(from, SIZE.omega, SIZE.zeta, 0.25).set(to)
  function write(node: HTMLElement, m: Motion) {
    const x = m.x.x
    const y = m.y.x
    node.style.transform =
      Math.abs(x) > 0.01 || Math.abs(y) > 0.01 ? `translate(${x}px,${y}px)` : ""
    if (m.o) node.style.opacity = String(Math.min(1, Math.max(0, m.o.x)))
    if (m.h) {
      const h = Math.max(0, m.h.x)
      node.style.height = `${h}px`
      node.style.overflow = "clip"
      if (m.fold !== undefined) {
        const f = Math.min(1, m.fold > 0 ? h / m.fold : 0)
        // Borders can't fold, so the margin takes up what they keep.
        node.style.paddingTop = node.style.paddingBottom = `calc(var(--k-pad) * ${f})`
        node.style.marginBottom = `${-gapPx * (1 - f) - Math.max(0, 2 - h)}px`
      }
    }
  }
  function clear(node: HTMLElement) {
    node.style.transform = ""
    node.style.height = ""
    node.style.overflow = ""
    node.style.marginBottom = ""
    node.style.paddingTop = node.style.paddingBottom = ""
    node.style.opacity = ""
  }
  function settle(node: HTMLElement, m: Motion) {
    motions.delete(node)
    clear(node)
    if (m.h) known.set(node, m.h.target)
    const done = leaving.get(node)
    if (done) {
      leaving.delete(node)
      node.removeAttribute("inert")
      delete node.dataset.leaving
      done()
    }
  }
  const tick = (now: number) => {
    raf = 0
    gapPx = gapOf()
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000))
    last = now
    for (const [node, m] of motions) {
      m.x.step(dt)
      m.y.step(dt)
      m.h?.step(dt)
      m.o?.step(dt)
      if (m.x.resting && m.y.resting && (!m.h || m.h.resting) && (!m.o || m.o.resting))
        settle(node, m)
      else write(node, m)
    }
    for (const node of glowing) {
      const g = glows.get(node)!
      g.e.step(dt)
      g.m.step(dt)
      writeGlow(node, g)
      if (g.e.resting && g.m.resting) glowing.delete(node)
    }
    if (motions.size || glowing.size) raf = win.requestAnimationFrame(tick)
    else {
      version++
      options.wake()
    }
  }
  function run() {
    if (raf || (!motions.size && !glowing.size)) return
    last = performance.now()
    raf = win.requestAnimationFrame(tick)
    options.wake()
  }
  function snapAll() {
    for (const [node, m] of motions) {
      if (m.h) m.h.snap(m.h.target)
      settle(node, m)
    }
  }

  /** Natural heights (as if nothing held them), read in one layout pass. */
  function naturals(tiles: readonly HTMLElement[]) {
    const held = tiles.filter((t) => t.style.height)
    const saved = held.map((t) => t.style.cssText)
    for (const t of held) {
      t.style.height = ""
      t.style.marginBottom = ""
      t.style.paddingTop = t.style.paddingBottom = ""
    }
    const out = new Map(tiles.map((t) => [t, t.offsetHeight]))
    held.forEach((t, i) => (t.style.cssText = saved[i]!))
    return out
  }

  // ── Layout ──────────────────────────────────────────────────────────────────────────────────
  const spacer = (s: Section, i: number) => {
    let node = s.spacers[i]
    if (!node) {
      node = el("knobs-section-head")
      node.dataset.continued = s.name
      node.setAttribute("aria-hidden", "true")
      node.textContent = "\u00a0"
      s.spacers.push(node)
    }
    return node
  }
  const nodes = () => {
    const out: HTMLElement[] = []
    for (const column of columns)
      for (const child of column.children)
        if (!(child as HTMLElement).hidden) out.push(child as HTMLElement)
    return out
  }

  function relayout(mutate?: () => void, rows: readonly HTMLElement[] = []) {
    const animate = ready && !reduced()
    if (!animate) snapAll()
    // First: where everything is drawn now.
    const first = new Map<HTMLElement, DOMRect>()
    if (animate) for (const node of nodes()) first.set(node, node.getBoundingClientRect())
    // Rows still folding shut count as hidden.
    const closing = new Set(rows.filter((r) => r.dataset.leaving === "true"))
    for (const r of closing) r.hidden = true
    const wasHidden = new Map(rows.map((r) => [r, r.hidden]))
    const wasShowing = new Set(tilesInOrder().filter((t) => t.isConnected && showing(t)))
    // Cards folding away are hidden as far as the change is concerned.
    for (const t of leaving.keys()) t.hidden = true
    mutate?.()
    for (const t of pending) t.style.display = ""
    // Cards hidden by the change fold away where they are; ones it brought back stay.
    for (const t of [...leaving.keys()])
      if (!t.hidden || !t.isConnected) {
        leaving.delete(t)
        t.removeAttribute("inert")
        delete t.dataset.leaving
      }
    for (const t of tilesInOrder())
      if (t.hidden && wasShowing.has(t) && animate) leaving.set(t, () => (t.hidden = true))
    for (const t of leaving.keys()) {
      t.hidden = false
      t.inert = true
      t.dataset.leaving = ""
    }

    // Balance the cards that show, at their final heights.
    const order = tilesInOrder()
    const shown = order.filter(showing)
    const n = Math.max(1, Math.min(8, shown.length || 1, fit()))
    cols = n
    host.style.setProperty("--k-cols", String(n))
    while (columns.length < n) {
      const column = el("knobs-column")
      columns.push(column)
      grid.append(column)
    }
    const probe = sections.find((s) => s.label)?.label
    if (probe && !probe.isConnected) columns[0]!.append(probe)
    const gap = gapOf()
    gapPx = gap
    const labelHeight = probe ? probe.offsetHeight - gap * 0.25 : 0
    const heights = naturals(shown)
    const shownSections = sections.filter((s) => s.tiles.some(showing))
    const plan = pageColumns(
      shown.map((t) => ({
        height: heights.get(t)!,
        section: shownSections.indexOf(sectionOf(t)!),
      })),
      n,
      {
        gap,
        space: gap * 0.75,
        label: (i) => (shownSections[i]!.label ? labelHeight : 0),
      },
    )
    // Columns top to bottom; hidden and folding cards stay after the card before them.
    const want: HTMLElement[][] = Array.from({ length: n }, () => [])
    const used = new Map<Section, number>()
    plan.forEach((column, c) => {
      for (const e of column.entries) {
        if (e.kind === "card") want[c]!.push(shown[e.index]!)
        else {
          const s = shownSections[e.section]!
          if (!e.continued) want[c]!.push(s.label!)
          else {
            const i = used.get(s) ?? 0
            used.set(s, i + 1)
            want[c]!.push(spacer(s, i))
          }
        }
      }
    })
    if (!plan.length) want[0]!.push(...order)
    else
      order.forEach((t, i) => {
        if (showing(t)) return
        for (let p = i - 1; p >= 0; p--) {
          const c = want.findIndex((list) => list.includes(order[p]!))
          if (c < 0) continue
          want[c]!.splice(want[c]!.indexOf(order[p]!) + 1, 0, t)
          return
        }
        const top = want[0]!
        top.splice(top[0]?.classList.contains("knobs-section-head") ? 1 : 0, 0, t)
      })
    // Removed cards fold away after whatever they followed.
    const orphans = [...leaving.keys()]
      .filter((t) => !sectionOf(t))
      .map((t) => [t, t.previousElementSibling] as const)
    const active = doc.activeElement as HTMLElement | null
    want.forEach((list, c) => {
      const column = columns[c]!
      list.forEach((node, i) => {
        if (column.children[i] !== node) column.insertBefore(node, column.children[i] ?? null)
      })
      while (column.children.length > list.length) column.lastElementChild!.remove()
    })
    while (columns.length > n) columns.pop()!.remove()
    for (const [t, prev] of orphans) {
      if (prev?.isConnected && prev.parentElement?.classList.contains("knobs-column")) prev.after(t)
      else {
        const m = motions.get(t)
        if (m) settle(t, m)
        else leaving.get(t)?.()
        leaving.delete(t)
      }
    }
    // Moving a card takes focus with it; put it back without scrolling.
    if (active && active !== doc.activeElement && active.isConnected)
      active.focus({ preventScroll: true, focusVisible: false } as FocusOptions)

    // Rows the change showed or hid fold open or shut from where they were.
    for (const [row, was] of wasHidden) {
      const now = row.hidden
      if (closing.has(row)) {
        // Folding on, or back open from where it got to.
        row.hidden = false
        if (!now) reveal(row, true)
      } else if (now !== was && animate) {
        row.hidden = was
        reveal(row, !now)
      }
    }
    for (const t of order) if (!t.hidden) known.set(t, heights.get(t) ?? t.offsetHeight)
    if (!animate) {
      for (const t of pending) pending.delete(t)
      version++
      options.onLayout()
      return
    }

    // Heights: anything that changed at once eases from what was drawn; new cards grow in.
    const after = naturals(order.filter((t) => !t.hidden))
    for (const t of order) {
      if (t.hidden) continue
      const m = motions.get(t)
      const was = first.get(t)
      if (leaving.has(t)) {
        const from = m?.h?.x ?? was?.height ?? after.get(t)!
        const mm = motionFor(t)
        mm.h = mm.h ?? sizeSpring(from, 0)
        mm.h.set(0)
        mm.fold = Math.max(mm.fold ?? 0, from)
      } else if (!was) {
        const mm = motionFor(t)
        mm.h = sizeSpring(0, after.get(t)!)
        mm.fold = after.get(t)!
      } else {
        const target = heights.get(t)!
        const drawn = m?.h ? m.h.x : was.height
        if (m?.h) {
          m.h.set(target)
          if (m.fold !== undefined) m.fold = target
        } else if (Math.abs(after.get(t)! - drawn) > 0.5 && !isRevealingIn(t)) {
          const mm = motionFor(t)
          mm.h = sizeSpring(drawn, target)
        }
      }
    }
    pending.clear()
    // Labels of sections that just appeared fade in.
    for (const s of sections)
      if (s.label?.isConnected && !first.has(s.label)) {
        const m = motionFor(s.label)
        m.o = new Spring(0, SIZE.omega, SIZE.zeta, 0.01).set(1)
      }
    for (const [node, m] of motions) write(node, m)
    // Last, then invert: each card and label starts where it was drawn and glides home.
    for (const node of nodes()) {
      const from = first.get(node)
      if (!from) continue
      const m = motions.get(node)
      const to = node.getBoundingClientRect()
      const dx = from.left - (to.left - (m?.x.x ?? 0))
      const dy = from.top - (to.top - (m?.y.x ?? 0))
      if (!m && Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue
      const mm = m ?? motionFor(node)
      mm.x.x = dx
      mm.y.x = dy
      mm.x.set(0)
      mm.y.set(0)
      write(node, mm)
    }
    version++
    options.onLayout()
    run()
  }

  // A card whose content changed at once (rows swapped, a custom card's content) eases to its new
  // height, before the change is painted; the cards below in its column follow. Folds already
  // animating inside it are left to move it. Nothing moves to another column.
  /** Cards a fold inside was moving when last seen: its final step isn't a sudden change. */
  const folding = new WeakSet<HTMLElement>()
  function ease(list: readonly HTMLElement[], heights: ReadonlyMap<HTMLElement, number>) {
    const animate = ready && !reduced()
    for (const t of list) {
      const natural = heights.get(t)!
      const drawn = known.get(t)
      known.set(t, natural)
      const inside = isRevealingIn(t)
      const settling = folding.has(t)
      if (inside) folding.add(t)
      else folding.delete(t)
      if (!animate || leaving.has(t)) continue
      const m = motions.get(t)
      if (m?.h) {
        // A fold starting inside takes over from an ease that has nearly arrived.
        if (inside && m.fold === undefined && Math.abs(m.h.x - natural) < 4) {
          m.h.snap(natural)
          if (m.x.resting && m.y.resting) settle(t, m)
          else {
            delete m.h
            const transform = t.style.transform
            clear(t)
            t.style.transform = transform
          }
          continue
        }
        m.h.set(natural)
        if (m.fold !== undefined) m.fold = natural
        continue
      }
      if (drawn === undefined || Math.abs(natural - drawn) < 0.5 || inside || settling) continue
      const mm = motionFor(t)
      mm.h = sizeSpring(drawn, natural)
      write(t, mm)
    }
    run()
  }
  const contents = new ResizeObserver((entries) => {
    const tiles = new Set<HTMLElement>()
    for (const e of entries) {
      const tile = (e.target as HTMLElement).parentElement
      if (tile && !tile.hidden && sectionOf(tile)) tiles.add(tile)
    }
    if (tiles.size) ease([...tiles], naturals([...tiles]))
  })
  const watch = (tile: HTMLElement) => {
    for (const child of tile.children) contents.observe(child)
  }

  let resizeTimer: ReturnType<typeof setTimeout> | undefined
  const resize = new ResizeObserver(() => {
    if (!ready || resizeTimer || fit() === cols) return
    resizeTimer = setTimeout(() => {
      resizeTimer = undefined
      pack()
    }, RESIZE_MS)
  })
  resize.observe(grid)

  function pack(force = false) {
    if (!force && !pending.size && fit() === cols) return
    relayout()
    if (!ready) win.requestAnimationFrame(() => (ready = true))
  }

  return {
    get sections() {
      return sections
        .filter((s) => s.label?.isConnected)
        .map((s) => ({ element: s.label!, head: s.label }))
    },
    add(tile, name) {
      sectionFor(name).tiles.push(tile)
      if (ready) {
        pending.add(tile)
        tile.style.display = "none"
        queueMicrotask(() => pending.size && pack(true))
      }
      ;(columns[0] ?? grid).append(tile)
      watch(tile)
      if (lit) queueMicrotask(retarget)
    },
    remove(tile) {
      glows.delete(tile)
      glowing.delete(tile)
      const s = sectionOf(tile)
      if (s) s.tiles.splice(s.tiles.indexOf(tile), 1)
      for (const child of tile.children) contents.unobserve(child)
      pending.delete(tile)
      const drawn = tile.isConnected && !tile.hidden ? tile.offsetHeight : 0
      if (!ready || reduced() || !drawn) {
        leaving.delete(tile)
        motions.delete(tile)
        tile.remove()
        return
      }
      const m = motionFor(tile)
      m.h = m.h ?? sizeSpring(drawn, 0)
      m.h.set(0)
      m.fold = Math.max(m.fold ?? 0, drawn)
      gapPx = gapOf()
      tile.inert = true
      tile.dataset.leaving = ""
      leaving.set(tile, () => tile.remove())
      write(tile, m)
      run()
    },
    pack,
    change(mutate, rows) {
      relayout(mutate, rows)
    },
    frame(now) {
      // The overlay draws before ResizeObserver runs, so sudden height changes are caught here
      // too, and the motion steps before it reads where things are.
      if (ready) {
        const free = tilesInOrder().filter(
          (t) => !t.hidden && !leaving.has(t) && !motions.get(t)?.h && known.has(t),
        )
        const heights = new Map(free.map((t) => [t, t.offsetHeight]))
        const changed = free.filter((t) => Math.abs(heights.get(t)! - known.get(t)!) >= 0.5)
        if (changed.length) ease(changed, heights)
      }
      if (raf) {
        win.cancelAnimationFrame(raf)
        tick(now)
      }
    },
    resize(tile, from) {
      const natural = naturals([tile]).get(tile)!
      known.set(tile, natural)
      if (!ready || reduced() || leaving.has(tile)) return
      const m = motions.get(tile)
      if (m?.h) {
        m.h.set(natural)
        if (m.fold !== undefined) m.fold = natural
      } else if (Math.abs(natural - from) >= 0.5) {
        const mm = motionFor(tile)
        mm.h = sizeSpring(from, natural)
        gapPx = gapOf()
        write(tile, mm)
      }
      run()
    },
    highlight(target) {
      const groups = new Set(target?.groups ?? [])
      const named = new Set(target?.sections ?? [])
      lit = target ? { groups, sections: named } : null
      dimAmount =
        parseFloat(getComputedStyle(host).getPropertyValue("--k-page-dim")) >= 0
          ? parseFloat(getComputedStyle(host).getPropertyValue("--k-page-dim"))
          : 0.4
      retarget()
    },
    highlighted() {
      if (!lit) return []
      const out: HTMLElement[] = []
      for (const t of tilesInOrder()) if (showing(t) && litTile(t).on) out.push(t)
      // A section highlighted as a whole starts at its heading.
      for (const s of sections)
        if (s.label?.isConnected && lit.sections.has(s.name)) out.push(s.label)
      return out
        .map((node) => ({ node, r: node.getBoundingClientRect() }))
        .filter((x) => x.r.height > 0)
        .sort((a, b) => a.r.top - b.r.top || a.r.left - b.r.left)
        .map((x) => x.node)
    },
    emphasis(node) {
      const g = glows.get(node)
      if (!g) return undefined
      const e = Math.min(1, Math.max(0, g.e.x))
      return {
        dim: (1 - e) * dimAmount,
        mark: Math.min(1, Math.max(0, g.m.x)),
        ...(g.dot && !g.dot.hidden ? { dot: g.dot } : {}),
      }
    },
    get moving() {
      return motions.size > 0 || glowing.size > 0 || isRevealingIn(grid)
    },
    get version() {
      return version
    },
    dispose() {
      if (raf) win.cancelAnimationFrame(raf)
      host.removeEventListener("focusin", onFocus)
      host.removeEventListener("focusout", onFocus)
      clearTimeout(resizeTimer)
      resize.disconnect()
      contents.disconnect()
    },
  }
}

/**
 * A card's title without its section's name repeated in front: "Transcript · Arrivals" under
 * Transcript reads "Arrivals". `prefixes` are what the section is called (its id and label); the
 * name has to be followed by a separator (· • : / | › » or a dash), and something has to remain.
 */
export function cardTitle(title: string, prefixes: readonly string[]): string {
  const lower = title.toLowerCase()
  for (const prefix of prefixes) {
    if (!prefix || !lower.startsWith(prefix.toLowerCase())) continue
    const rest = /^\s*[·•:/|›»—–-]\s*(\S.*)$/u.exec(title.slice(prefix.length))
    if (rest) return rest[1]!
  }
  return title
}

/** Whether a field, group or card answers the filter: every word appears somewhere in `text`. */
export function matchesFilter(query: string, ...text: (string | undefined)[]) {
  const hay = text.filter(Boolean).join(" ").toLowerCase()
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => hay.includes(word))
}

export function createCustomCard(
  doc: Document,
  options: PageCardOptions,
  hooks: {
    wake(): void
    remove(tile: HTMLElement): void
    /** What the header shows for `title` (a repeated section prefix dropped). */
    title?(title: string): string
    /** The card's content changed at once (it was `from` px tall): its height eases there. */
    resize?(tile: HTMLElement, from: number): void
    /** Where a collapsible card's state is kept (per tab), by title. */
    folded?: { get(title: string): boolean | undefined; set(title: string, folded: boolean): void }
  },
): PageCard {
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
    const node = doc.createElement(tag)
    if (cls) node.className = cls
    if (text !== undefined) node.textContent = text
    return node
  }
  const tile = el("div", "knobs-tile knobs-live")
  const head = el("div", "knobs-group-head")
  const accessory = el("span")
  const shown = options.title ? (hooks.title?.(options.title) ?? options.title) : ""
  if (options.title) {
    tile.dataset.card = options.title
    tile.setAttribute("aria-label", shown)
    const title = el("span", "knobs-group-title")
    title.append(el("span", "knobs-group-label", shown))
    head.append(title, accessory)
    tile.append(head)
  }
  const body = el("div", "knobs-tile-body")
  tile.append(body)
  if (options.element) body.append(options.element)

  // Collapsible: the header folds the body away; a summary shows on its right meanwhile.
  let folded = false
  let summaryEl: HTMLElement | undefined
  const collapsible = () => tile.hasAttribute("data-collapsible")
  const makeCollapsible = () => {
    if (collapsible() || !options.title) return
    tile.toggleAttribute("data-collapsible", true)
    const side = el("span", "knobs-card-side")
    summaryEl = el("span", "knobs-card-summary")
    accessory.replaceWith(side)
    side.append(summaryEl, accessory)
    const right = el("span", "knobs-card-right")
    side.replaceWith(right)
    const caret = doc.createElementNS("http://www.w3.org/2000/svg", "svg")
    caret.setAttribute("class", "knobs-caret")
    caret.setAttribute("viewBox", "0 0 10 10")
    caret.setAttribute("aria-hidden", "true")
    const chevron = doc.createElementNS("http://www.w3.org/2000/svg", "path")
    chevron.setAttribute("d", "M3.75 2.25 6.5 5 3.75 7.75")
    caret.append(chevron)
    right.append(side, caret)
    head.tabIndex = 0
    head.dataset.knobsStop = ""
    head.setAttribute("role", "button")
    head.setAttribute("aria-label", shown)
    head.setAttribute("aria-expanded", "true")
    head.addEventListener("click", (event) => {
      const hit = (event.target as Element).closest(
        "button,a,input,select,textarea,[data-knobs-stop],[role=button]",
      )
      if (hit && hit !== head) return
      fold(!folded)
    })
    head.addEventListener("keydown", (event) => {
      if (event.target !== head || event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key !== "Enter" && event.key !== " ") return
      event.preventDefault()
      event.stopPropagation()
      fold(!folded)
    })
  }
  const setSummary = (content: string | Node | null) => {
    if (!summaryEl) return
    summaryEl.replaceChildren(...(content === null ? [] : [content]))
    summaryEl.title = summaryEl.textContent ?? ""
  }
  /** Folds or opens the body; `animate: false` places it (a card restored on reload). */
  const fold = (next: boolean, animate = true) => {
    makeCollapsible()
    if (!collapsible() || next === folded) return
    folded = next
    // Opening from hidden, the body first shows at its folded (clear) look, so it fades in.
    if (!next && body.hidden) {
      body.hidden = false
      void getComputedStyle(body).opacity
    }
    tile.toggleAttribute("data-collapsed", next)
    head.setAttribute("aria-expanded", String(!next))
    body.setAttribute("aria-hidden", String(next))
    body.inert = next
    // Focus inside a body folding away stays on the card, at its header.
    if (next && body.contains(doc.activeElement))
      head.focus({ preventScroll: true, focusVisible: false } as FocusOptions)
    if (animate && tile.isConnected && !still() && hooks.resize) {
      // The card's height springs on the page's own motion (the cards below glide with it);
      // meanwhile a folding body leaves the flow where it is and fades, clipped by the card.
      const from = tile.getBoundingClientRect().height
      if (next) {
        body.style.top = `${body.offsetTop}px`
        body.dataset.folding = ""
        // Gone once it has faded (or soon after, should no transition run).
        const done = (event?: TransitionEvent) => {
          if (event && (event.target !== body || event.propertyName !== "opacity")) return
          body.removeEventListener("transitionend", done)
          clearTimeout(timer)
          if (!folded || !("folding" in body.dataset)) return
          body.hidden = true
          delete body.dataset.folding
          body.style.top = ""
        }
        const timer = setTimeout(done, 900)
        body.addEventListener("transitionend", done)
      } else {
        body.hidden = false
        delete body.dataset.folding
        body.style.top = ""
      }
      hooks.resize(tile, from)
    } else {
      body.hidden = next
      delete body.dataset.folding
      body.style.top = ""
    }
    if (options.title) hooks.folded?.set(options.title, next)
    hooks.wake()
  }
  if (options.collapsed !== undefined) {
    makeCollapsible()
    if (options.summary !== undefined) setSummary(options.summary)
    const saved = options.title ? hooks.folded?.get(options.title) : undefined
    fold(saved ?? options.collapsed, false)
  }
  /** Rows join the inset card above them, as fields do; anything else starts a new one. */
  const inset = () => {
    const last = body.lastElementChild
    if (last?.classList.contains("knobs-card")) return last as HTMLElement
    const card = el("div", "knobs-card")
    body.append(card)
    return card
  }
  const arrows = arrowOf
  const quiet = (node: HTMLElement) =>
    node.focus({ preventScroll: true, focusVisible: false } as FocusOptions)
  const still = () =>
    doc.defaultView?.matchMedia("(prefers-reduced-motion: reduce)").matches ?? false
  /** Fills a list row: a label, a quieter detail and, with `onSelect`, a keyboard stop. */
  const fill = (row: HTMLElement, o: PageItem) => {
    row.replaceChildren(el("span", undefined, o.label))
    if (o.detail) row.append(el("span", "knobs-item-detail", o.detail))
    const select = o.onSelect
    if (select) {
      row.tabIndex = 0
      row.dataset.knobsStop = ""
      row.setAttribute("role", "button")
    } else {
      row.removeAttribute("tabindex")
      delete row.dataset.knobsStop
      row.removeAttribute("role")
    }
    row.onclick = select ? () => select() : null
    row.onkeydown = select
      ? (event) => {
          if (event.key !== "Enter" && event.key !== " ") return
          event.preventDefault()
          select()
        }
      : null
    return row
  }
  const item = (o: PageItem) => fill(el("div", "knobs-row knobs-item"), o)
  const choices: { dispose(): void }[] = []
  const disposeChoices = () => {
    while (choices.length) choices.pop()!.dispose()
  }

  return {
    element: tile,
    body,
    accessory,
    choice<T extends string>(o: {
      readonly label?: string
      readonly options: readonly (T | { readonly value: T; readonly label: string })[]
      readonly value: T
      readonly display?: "menu" | "segmented"
      onChange(value: T): void
    }) {
      const list = o.options.map((x) => (typeof x === "string" ? { value: x, label: x } : x))
      const row = el("div", o.label ? "knobs-row" : "knobs-row knobs-row-full")
      if (o.label) row.append(el("span", undefined, o.label))
      let value = o.value
      inset().append(row)
      // The panel's own choice control: segments while they fit, a menu when they don't.
      const control = createChoice(doc, row, {
        label: o.label,
        items: list,
        display: o.display,
        value: () => value,
        choose: (next) => {
          if (next === value) return
          value = next as T
          control.show(value)
          o.onChange(value)
          hooks.wake()
        },
        wake: hooks.wake,
      })
      choices.push(control)
      for (const node of [control.seg, control.menu]) {
        node.dataset.knobsStop = ""
        node.addEventListener("keydown", (event) => {
          const d = arrows(event)
          if (!d || event.metaKey || event.altKey) return
          event.preventDefault()
          event.stopPropagation()
          control.step(d, true)
        })
      }
      control.show(value, true)
      return {
        element: row,
        get: () => value,
        set(next: T) {
          if (next === value) return
          value = next
          control.show(value)
          hooks.wake()
        },
      }
    },
    toggle(o) {
      const row = el("div", "knobs-row")
      row.append(el("span", undefined, o.label))
      const toggle = el("button", "knobs-toggle")
      toggle.type = "button"
      toggle.dataset.knobsStop = ""
      toggle.setAttribute("role", "switch")
      toggle.setAttribute("aria-label", o.label)
      toggle.append(el("i"))
      let value = o.value
      const paint = () => toggle.setAttribute("aria-checked", String(value))
      const flip = () => {
        value = !value
        paint()
        o.onChange(value)
        hooks.wake()
      }
      toggle.onclick = flip
      toggle.addEventListener("keydown", (event) => {
        if (!arrows(event)) return
        event.preventDefault()
        event.stopPropagation()
        flip()
      })
      paint()
      row.append(toggle)
      inset().append(row)
      return {
        element: row,
        get: () => value,
        set(next: boolean) {
          if (next === value) return
          value = next
          paint()
          hooks.wake()
        },
      }
    },
    actions(items) {
      const bar = el("div", "knobs-custom-actions")
      // One ↑↓ stop for the row; ←→ move along it and focus lands on the last button used.
      bar.tabIndex = -1
      bar.dataset.knobsStop = ""
      let last: HTMLButtonElement | undefined
      const buttons = () =>
        [...bar.querySelectorAll<HTMLButtonElement>(":scope > button:not([data-gone])")].filter(
          (b) => !b.disabled,
        )
      bar.addEventListener("focus", () => {
        const list = buttons()
        ;(last && list.includes(last) ? last : list[0])?.focus({ preventScroll: true })
      })
      bar.addEventListener("focusin", (event) => {
        if (event.target instanceof HTMLButtonElement) last = event.target
      })
      bar.addEventListener("keydown", (event) => {
        const d = arrows(event)
        const list = buttons()
        const at = list.indexOf(event.target as HTMLButtonElement)
        if (!d || at < 0) return
        event.preventDefault()
        event.stopPropagation()
        list[(at + d + list.length) % list.length]?.focus()
      })
      const set = (next: readonly PageAction[]) => {
        const kept = new Map(
          [...bar.querySelectorAll<HTMLButtonElement>(":scope > button:not([data-gone])")].map(
            (b) => [b.textContent ?? "", b],
          ),
        )
        const live = bar.isConnected && !bar.parentElement?.closest("[hidden]") && !still()
        const from = new Map([...kept.values()].map((b) => [b, b.getBoundingClientRect()]))
        const box = bar.getBoundingClientRect()
        const height = bar.hidden || bar.dataset.leaving ? 0 : box.height
        const list = next.map((a) => {
          const b = kept.get(a.label) ?? el("button", undefined, a.label)
          kept.delete(a.label)
          b.type = "button"
          b.disabled = Boolean(a.disabled)
          b.onclick = () => {
            a.run()
            hooks.wake()
          }
          return b
        })
        const gone = [...kept.values()]
        const ghosts = [...bar.querySelectorAll<HTMLButtonElement>(":scope > [data-gone]")]
        if (doc.activeElement && gone.includes(doc.activeElement as HTMLButtonElement))
          (list[0] ?? bar).focus({ preventScroll: true })
        bar.replaceChildren(...list, ...(live ? [...ghosts, ...gone] : []))
        if (!live) {
          bar.hidden = list.length === 0
          hooks.wake()
          return
        }
        // Buttons that left fade where they were, under the ones arriving (or in place, as the
        // emptied row folds away).
        for (const b of gone) {
          const r = from.get(b)!
          b.dataset.gone = ""
          b.tabIndex = -1
          b.inert = true
          if (list.length)
            b.style.cssText = `position:absolute;left:${r.left - box.left}px;top:${r.top - box.top}px;width:${r.width}px;height:${r.height}px;margin:0`
          b.animate([{ opacity: 1 }, { opacity: 0, transform: "scale(.97)" }], {
            duration: 160,
            easing: "cubic-bezier(.4,0,.8,.4)",
            fill: "forwards",
          }).onfinish = () => b.remove()
        }
        if (list.length === 0) reveal(bar, false)
        else if (height === 0) reveal(bar, true)
        else resize(bar, height)
        const now = bar.getBoundingClientRect()
        for (const b of list) {
          const r = from.get(b)
          if (r) {
            const to = b.getBoundingClientRect()
            const dx = r.left - box.left - (to.left - now.left)
            const dy = r.top - box.top - (to.top - now.top)
            if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5)
              b.animate([{ transform: `translate(${dx}px,${dy}px)` }, { transform: "none" }], {
                duration: 240,
                easing: "cubic-bezier(.2,.8,.2,1)",
              })
          } else
            b.animate(
              [
                { opacity: 0, transform: "scale(.97)" },
                { opacity: 1, transform: "none" },
              ],
              {
                duration: 200,
                delay: gone.length ? 50 : 0,
                easing: "cubic-bezier(.2,.8,.2,1)",
                fill: "backwards",
              },
            )
        }
        hooks.wake()
      }
      bar.hidden = items.length === 0
      set(items)
      body.append(bar)
      return { element: bar, set }
    },
    item(o) {
      const row = item(o)
      inset().append(row)
      return row
    },
    list(items = []) {
      const card = el("div", "knobs-card")
      card.style.position = "relative"
      const rows = new Map<string, HTMLElement>()
      const set = (next: readonly (PageItem & { readonly key: string })[]) => {
        const live = card.isConnected && !card.parentElement?.closest("[hidden]") && !still()
        const keys = new Set(next.map((x) => x.key))
        const gone = [...rows].filter(([key]) => !keys.has(key))
        const swap = live && gone.length > 0 && next.some((x) => !rows.has(x.key))
        const box = card.getBoundingClientRect()
        const height = card.hidden || card.dataset.leaving ? 0 : box.height
        // Rows replaced by others cross-fade while the card eases to its new height; rows only
        // added or only removed fold open or shut, and the rows below glide.
        for (const [key, row] of gone) {
          rows.delete(key)
          row.dataset.gone = ""
          if (!live) row.remove()
          else if (!swap) reveal(row, false, () => row.remove())
          else {
            const r = row.getBoundingClientRect()
            row.style.cssText = `position:absolute;left:${r.left - box.left}px;top:${r.top - box.top}px;width:${r.width}px;margin:0`
            row.animate([{ opacity: 1 }, { opacity: 0 }], {
              duration: 140,
              easing: "cubic-bezier(.4,0,.8,.4)",
              fill: "forwards",
            }).onfinish = () => row.remove()
          }
        }
        let before: Element | null = card.firstElementChild
        for (const x of next) {
          let row = rows.get(x.key)
          if (row) fill(row, x)
          else {
            row = item(x)
            rows.set(x.key, row)
            if (live && !swap) row.hidden = true
            else if (swap)
              row.animate([{ opacity: 0 }, { opacity: 1 }], {
                duration: 200,
                delay: 40,
                easing: "cubic-bezier(.2,.8,.2,1)",
                fill: "backwards",
              })
          }
          while (before && (before as HTMLElement).dataset.gone !== undefined && before !== row)
            before = before.nextElementSibling
          if (row !== before) card.insertBefore(row, before)
          else before = before.nextElementSibling
          if (row.hidden) reveal(row, true)
        }
        // Focus on a row that left moves to the first one left.
        const focused = doc.activeElement as HTMLElement | null
        if (focused?.closest("[data-gone]") && card.contains(focused))
          [...rows.values()].find((r) => r.tabIndex >= 0)?.focus({ preventScroll: true })
        if (!next.length) {
          if (live) reveal(card, false)
          else card.hidden = true
        } else if (card.hidden || card.dataset.leaving) {
          if (live) reveal(card, true)
          else card.hidden = false
        } else if (swap) resize(card, height)
        hooks.wake()
      }
      card.hidden = items.length === 0
      set(items)
      body.append(card)
      return { element: card, set }
    },
    show(element, visible) {
      if (element.isConnected && !still()) reveal(element, visible)
      else element.hidden = !visible
      hooks.wake()
    },
    collapse(next = true) {
      fold(next)
    },
    get collapsed() {
      return folded
    },
    summary(content) {
      makeCollapsible()
      setSummary(content)
      hooks.wake()
    },
    clear() {
      disposeChoices()
      body.replaceChildren()
      hooks.wake()
    },
    remove() {
      disposeChoices()
      hooks.remove(tile)
    },
  }
}
