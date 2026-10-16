// Page-wide hint mode. Panels, knobs/ui pieces and a host's own elements register here; `s`
// anywhere on the page (outside a text field) gives every visible target a code, across all of
// them, and typing one focuses or presses it. One coordinator per document assigns the codes;
// panels draw their own badges (in both renderers) and everything else shares one page layer.
// The registry lives on the document, so copies of this module in separate bundles (knobs/panel,
// knobs/ui) share it.
import { assignHintCodes, type HintSpot, resolveHintCodes } from "./hints.js"

/** Code letters, home row first: groups take the first letters, their targets the second. */
export const HINT_LETTERS = "asdfghjkleruiowtyqpcvnmxzb"
const HOME_ROW = 9

/**
 * Codes for groups of targets (a panel's controls, a tree's rows…), in order: each group takes a
 * letter of its own (home row first) and its targets a second letter, home row first; a group of
 * one is just its letter. While letters are spare, big groups take more of them so their second
 * letters stay on the home row. With more groups than letters, they share letters in order. Codes
 * are prefix-free and at most two letters; a target past 676 gets `""` (no code).
 */
export function assignPageCodes(counts: readonly number[]): string[][] {
  const n = HINT_LETTERS.length
  const result = counts.map((c) => new Array<string>(c).fill(""))
  const need = counts.map((c) => (c > 0 ? Math.ceil(c / n) : 0))
  let used = need.reduce((a, b) => a + b, 0)
  if (used <= n) {
    while (used < n) {
      let best = -1
      let most = HOME_ROW
      counts.forEach((c, i) => {
        const per = need[i] ? Math.ceil(c / need[i]!) : 0
        if (per > most) {
          best = i
          most = per
        }
      })
      if (best < 0) break
      need[best]!++
      used++
    }
    let letter = 0
    counts.forEach((c, i) => {
      const k = need[i]!
      let at = 0
      for (let chunk = 0; chunk < k; chunk++) {
        const size = Math.floor(c / k) + (chunk < c % k ? 1 : 0)
        const first = HINT_LETTERS[letter++]!
        for (let j = 0; j < size; j++)
          result[i]![at + j] = size === 1 ? first : first + HINT_LETTERS[j]!
        at += size
      }
    })
    return result
  }
  let slot = 0
  counts.forEach((c, i) => {
    for (let j = 0; j < c; j++, slot++) {
      const first = Math.floor(slot / n)
      if (first < n) result[i]![j] = HINT_LETTERS[first]! + HINT_LETTERS[slot % n]!
    }
  })
  return result
}

/** Where a group sits: the top-left of its targets, and how it ranks (panels first). */
export interface HintGroupPlace {
  readonly rank: number
  readonly left: number
  readonly top: number
}

/** Columns this wide read top to bottom, left to right. */
const COLUMN = 200

/** The order groups take letters in: by rank, then down each column, left to right. */
export function orderHintGroups(groups: readonly HintGroupPlace[]): number[] {
  return groups
    .map((g, i) => ({ g, i }))
    .sort(
      (a, b) =>
        a.g.rank - b.g.rank ||
        Math.floor(a.g.left / COLUMN) - Math.floor(b.g.left / COLUMN) ||
        a.g.top - b.g.top ||
        a.g.left - b.g.left ||
        a.i - b.i,
    )
    .map((x) => x.i)
}

/** A target: an element and what pressing its code does (focus, or click, by default). */
export interface PageHintTarget {
  readonly el: HTMLElement
  /** For codes when it's the only group on the page; its aria-label or text by default. */
  readonly label?: string
  /** The badge goes just after this (a row's label), else at the element's left edge. */
  readonly labelEl?: HTMLElement
  readonly activate?: () => void
}

/** Draws a group's badges itself (a panel, in its renderer); the coordinator hears the keys. */
export interface HintPainter {
  show(targets: readonly HintSpot[], codes: readonly string[]): void
  narrow(query: string): void
  clear(): void
}

export interface HintSourceOptions {
  /**
   * Whether `s` anywhere on the page starts hint mode while this is registered (`true`, the
   * default). knobs/ui pieces pass `false`: they join hint mode without turning it on.
   */
  readonly listen?: boolean
  /** Draws the badges itself. */
  readonly paint?: HintPainter
  /** Lower ranks take letters first: panels 0, knobs/ui pieces 1, the host's own 2 (the default). */
  readonly rank?: number
}

export interface PageHints {
  /**
   * Adds a group of targets: `targets()` is read each time hint mode starts and may list elements
   * or `PageHintTarget`s; hidden, disabled and scrolled-away ones are skipped. Returns a function
   * that removes it.
   */
  register(
    root: HTMLElement,
    targets: () => Iterable<HTMLElement | PageHintTarget>,
    options?: HintSourceOptions,
  ): () => void
  /** Starts hint mode across the page; `false` when there was nothing to label. */
  start(): boolean
  stop(): void
  readonly active: boolean
  /**
   * Whether `s` anywhere on the page starts hint mode: a panel or host has registered, and there's
   * something else on the page to label too.
   */
  readonly listening: boolean
}

interface Source {
  readonly root: HTMLElement
  readonly targets: () => Iterable<HTMLElement | PageHintTarget>
  readonly listen: boolean
  readonly paint?: HintPainter
  readonly rank: number
}

interface Resolved extends HintSpot {
  readonly label: string
  readonly activate: () => void
}

interface Group {
  readonly source?: Source
  readonly targets: Resolved[]
}

/** The page's hint key. */
export const PAGE_HINT_KEY = "s"
const KEY = Symbol.for("knobs.pageHints.v1")

/** The page's hint registry (one per document). */
export function pageHints(doc: Document = document): PageHints {
  const holder = doc as unknown as Record<symbol, PageHints | undefined>
  const registry = holder[KEY] ?? createRegistry(doc)
  holder[KEY] = registry
  return registry
}

/**
 * The page's hint registry, for `document`: `hints.register(root, () => targets)`. Elements with a
 * `data-hint` attribute (its value is the label; empty uses the aria-label or text) join without
 * registering, grouped by their nearest `[data-hint-group]`.
 */
export const hints = {
  register(
    root: HTMLElement,
    targets: () => Iterable<HTMLElement | PageHintTarget>,
    options?: HintSourceOptions,
  ) {
    return pageHints(root.ownerDocument).register(root, targets, options)
  },
  start: (doc: Document = document) => pageHints(doc).start(),
  stop: (doc: Document = document) => pageHints(doc).stop(),
}

/**
 * Whether a key belongs to the page's hint mode rather than a piece's own letters (a tree's
 * type-ahead): it's the hint key and something on the page has turned hint mode on.
 */
export function claimsHintKey(doc: Document, key: string) {
  const holder = doc as unknown as Record<symbol, PageHints | undefined>
  return key === PAGE_HINT_KEY && Boolean(holder[KEY]?.listening)
}

export const isTyping = (target: EventTarget | null) => {
  const el = target as HTMLElement | null
  if (!el || typeof el.tagName !== "string") return false
  const tag = el.tagName
  if (tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable) return true
  return (
    tag === "INPUT" &&
    !["range", "checkbox", "radio", "button", "submit", "reset", "color"].includes(
      (el as HTMLInputElement).type,
    )
  )
}

const PRESSABLE =
  "button,a[href],summary,[role=button],[role=tab],[role=radio],[role=switch],[role=checkbox],[role=menuitem],[role=option]"

/** Pressing a code: fields and focusable things take focus; buttons and the rest are clicked. */
function activateElement(el: HTMLElement) {
  const pressable =
    el.matches(PRESSABLE) || (el.tabIndex < 0 && !el.matches("input,select,textarea"))
  if (el.tabIndex >= 0 || el.matches("input,select,textarea"))
    el.focus({ preventScroll: true, focusVisible: true } as FocusOptions)
  if (pressable) el.click()
}

const labelOf = (el: HTMLElement) =>
  (el.dataset.hint || el.getAttribute("aria-label") || el.textContent || "").trim()

function createRegistry(doc: Document): PageHints {
  const win = doc.defaultView
  const sources: Source[] = []
  let session: Session | null = null
  let listening = false

  const onDocKey = (e: KeyboardEvent) => {
    if (session || e.defaultPrevented || e.repeat || e.isComposing) return
    if (e.metaKey || e.ctrlKey || e.altKey || e.key !== PAGE_HINT_KEY) return
    if (isTyping(e.target) || !wide()) return
    if (registry.start()) e.preventDefault()
  }
  /**
   * Whether `s` outside a panel starts hint mode: something that listens has registered, and
   * there's more than it to label (a lone panel keeps its key to itself, as it always has).
   */
  const wide = () =>
    listening &&
    (sources.length > 1 ||
      [...doc.querySelectorAll("[data-hint]")].some((el) => !el.closest(".knobs-panel")))
  const relisten = () => {
    const next = sources.some((s) => s.listen)
    if (next === listening) return
    listening = next
    if (next) doc.addEventListener("keydown", onDocKey)
    else doc.removeEventListener("keydown", onDocKey)
  }

  const shown = (el: HTMLElement) => {
    if (!el.isConnected || (el as HTMLButtonElement).disabled) return false
    if (el.closest("[hidden],[inert],[data-leaving]")) return false
    if (el.getClientRects().length === 0) return false
    const check = (el as { checkVisibility?: (o: object) => boolean }).checkVisibility
    return check ? check.call(el, { visibilityProperty: true }) : true
  }

  const collect = (): Group[] => {
    const seen = new Set<HTMLElement>()
    const take = (item: HTMLElement | PageHintTarget): Resolved | null => {
      const t: PageHintTarget =
        typeof (item as Node).nodeType === "number"
          ? { el: item as HTMLElement }
          : (item as PageHintTarget)
      const el = t.el
      if (seen.has(el) || !shown(el)) return null
      const label = (t.label ?? labelOf(el)).trim()
      seen.add(el)
      return {
        el,
        label: label || "x",
        ...(t.labelEl ? { labelEl: t.labelEl } : {}),
        activate: t.activate ?? (() => activateElement(el)),
      }
    }
    const groups: Group[] = []
    for (const source of [...sources].sort((a, b) => a.rank - b.rank)) {
      const targets: Resolved[] = []
      for (const item of source.targets()) {
        const t = take(item)
        if (t) targets.push(t)
      }
      if (targets.length) groups.push({ source, targets })
    }
    // The host's own: [data-hint] outside panels (which label theirs), by [data-hint-group].
    const byGroup = new Map<Element | null, Resolved[]>()
    for (const el of doc.querySelectorAll<HTMLElement>("[data-hint]")) {
      if (el.closest(".knobs-panel")) continue
      const t = take(el)
      if (!t) continue
      const key = el.closest("[data-hint-group]")
      const list = byGroup.get(key)
      if (list) list.push(t)
      else byGroup.set(key, [t])
    }
    for (const targets of byGroup.values()) groups.push({ targets })
    return groups
  }

  /** Whether the target's middle shows inside every box that clips it and the window. */
  const inView = (el: HTMLElement, clips: Map<Element, DOMRect | null>) => {
    if (!win) return true
    const r = el.getBoundingClientRect()
    const y = r.top + Math.min(r.height / 2, 10)
    let top = 0
    let left = 0
    let right = win.innerWidth
    let bottom = win.innerHeight
    for (let p = el.parentElement; p && p !== doc.body; p = p.parentElement) {
      let clip = clips.get(p)
      if (clip === undefined) {
        const cs = win.getComputedStyle(p)
        clip =
          cs.overflowX !== "visible" || cs.overflowY !== "visible"
            ? p.getBoundingClientRect()
            : null
        clips.set(p, clip)
      }
      if (!clip) continue
      top = Math.max(top, clip.top)
      left = Math.max(left, clip.left)
      right = Math.min(right, clip.right)
      bottom = Math.min(bottom, clip.bottom)
    }
    return y >= top && y <= bottom && r.right > left + 2 && r.left < right - 2
  }

  const registry: PageHints = {
    register(root, targets, options = {}) {
      const source: Source = {
        root,
        targets,
        listen: options.listen !== false,
        rank: options.rank ?? 2,
        ...(options.paint ? { paint: options.paint } : {}),
      }
      sources.push(source)
      relisten()
      return () => {
        const i = sources.indexOf(source)
        if (i < 0) return
        sources.splice(i, 1)
        if (session?.has(source)) registry.stop()
        relisten()
      }
    },
    start() {
      registry.stop()
      let groups = collect()
      if (groups.length === 0) return false
      let codes: string[][]
      if (groups.length === 1) {
        // One group: the codes a lone panel has always had, from its labels.
        const only = groups[0]!.targets
        codes = [assignHintCodes(only.map((t) => ({ key: t.label, display: t.label })))]
      } else {
        const clips = new Map<Element, DOMRect | null>()
        groups = groups
          .map((g) => ({ ...g, targets: g.targets.filter((t) => inView(t.el, clips)) }))
          .filter((g) => g.targets.length > 0)
        if (groups.length === 0) return false
        const order = orderHintGroups(
          groups.map((g) => {
            let left = Infinity
            let top = Infinity
            for (const t of g.targets) {
              const r = t.el.getBoundingClientRect()
              left = Math.min(left, r.left)
              top = Math.min(top, r.top)
            }
            return { rank: g.source?.rank ?? 2, left, top }
          }),
        )
        groups = order.map((i) => groups[i]!)
        codes =
          groups.length === 1
            ? [assignHintCodes(groups[0]!.targets.map((t) => ({ key: t.label, display: t.label })))]
            : assignPageCodes(groups.map((g) => g.targets.length))
      }
      session = createSession(doc, groups, codes, () => {
        session = null
      })
      return true
    },
    stop() {
      session?.stop()
      session = null
    },
    get active() {
      return session !== null
    },
    get listening() {
      return wide()
    },
  }
  return registry
}

interface Session {
  has(source: Source): boolean
  stop(): void
}

function createSession(
  doc: Document,
  groups: readonly Group[],
  codes: readonly string[][],
  ended: () => void,
): Session {
  const win = doc.defaultView
  const entries: { target: Resolved; code: string }[] = []
  const painters: HintPainter[] = []
  const shared: { spots: Resolved[]; codes: string[] } = { spots: [], codes: [] }
  groups.forEach((g, i) => {
    const spots: Resolved[] = []
    const mine: string[] = []
    g.targets.forEach((t, j) => {
      const code = codes[i]![j]
      if (!code) return
      entries.push({ target: t, code })
      spots.push(t)
      mine.push(code)
    })
    if (!spots.length) return
    if (g.source?.paint) {
      painters.push(g.source.paint)
      g.source.paint.show(spots, mine)
    } else {
      shared.spots.push(...spots)
      shared.codes.push(...mine)
    }
  })
  if (shared.spots.length) {
    const layer = layerPainter(doc, groups)
    painters.push(layer)
    layer.show(shared.spots, shared.codes)
  }
  const allCodes = entries.map((e) => e.code)

  let query = ""
  let over = false
  const stop = () => {
    if (over) return
    over = true
    for (const p of painters) p.clear()
    win?.removeEventListener("keydown", onKey, true)
    doc.removeEventListener("scroll", onScroll, true)
    doc.removeEventListener("pointerdown", onPointer, true)
    win?.removeEventListener("resize", stop)
    win?.removeEventListener("blur", stop)
    ended()
  }
  const finish = (i: number | undefined) => {
    const hit = i === undefined ? undefined : entries[i]
    stop()
    hit?.target.activate()
  }
  const narrow = () => {
    const r = resolveHintCodes(allCodes, query)
    if (r.uniqueMatchIndex >= 0) return finish(r.uniqueMatchIndex)
    for (const p of painters) p.narrow(query)
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.isComposing || ["Shift", "Meta", "Control", "Alt", "CapsLock"].includes(e.key)) return
    e.preventDefault()
    e.stopImmediatePropagation()
    if (e.metaKey || e.ctrlKey) return stop()
    if (e.key === "Escape") stop()
    else if (e.key === "Backspace") {
      query = query.slice(0, -1)
      narrow()
    } else if (e.key === "Enter") finish(resolveHintCodes(allCodes, query).matchIndices[0])
    else if (/^[a-zA-Z]$/.test(e.key)) {
      query += e.key.toLowerCase()
      narrow()
    }
  }
  // Scrolling more than a little moves the targets from under their badges: hint mode ends.
  const scrolled = new Map<EventTarget, number>()
  const offset = (t: EventTarget) =>
    t === doc
      ? (win?.scrollY ?? 0) + (win?.scrollX ?? 0)
      : (t as Element).scrollTop + (t as Element).scrollLeft
  const onScroll = (e: Event) => {
    const t = e.target
    if (!t) return
    const at = offset(t)
    const from = scrolled.get(t)
    if (from === undefined) scrolled.set(t, at)
    else if (Math.abs(at - from) > 24) stop()
  }
  const onPointer = () => stop()
  win?.addEventListener("keydown", onKey, true)
  doc.addEventListener("scroll", onScroll, true)
  doc.addEventListener("pointerdown", onPointer, true)
  win?.addEventListener("resize", stop)
  win?.addEventListener("blur", stop)
  return {
    has: (source) => groups.some((g) => g.source === source),
    stop,
  }
}

const STYLE_ID = "knobs-page-hints-css"
// The panels' hint look (styles.ts: .knobs-hint) on a fixed layer over the page.
const CSS = `
.knobs-page-hints{position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483000}
.knobs-page-hint{position:fixed;transform:translateY(-50%);display:inline-flex;align-items:center;height:15px;padding:0 4px;border-radius:var(--kh-radius);background:var(--kh-accent);color:var(--kh-bg);
  box-shadow:0 1px 3px rgba(0,0,0,calc(.35 * var(--kh-lift)));font:700 var(--kh-size)/1 var(--kh-mono);letter-spacing:.04em;text-transform:uppercase;white-space:nowrap;pointer-events:none;
  animation:knobs-page-hint-in .1s var(--kh-ease)}
.knobs-page-hint[hidden]{display:none}
.knobs-page-hint>.knobs-hint-typed{opacity:var(--kh-typed)}
[data-knobs-hint-miss]{opacity:.32;transition:opacity .1s}
@keyframes knobs-page-hint-in{from{opacity:0;transform:translateY(calc(4px - 50%)) scale(.985)}to{opacity:1;transform:translateY(-50%)}}
@media(prefers-reduced-motion:reduce){@keyframes knobs-page-hint-in{from{opacity:0}to{opacity:1}}}
`

/** The page layer's look: a panel's tokens where there's one, else a knobs/ui piece's. */
function hintTokens(doc: Document, groups: readonly Group[]) {
  const win = doc.defaultView
  const read = (el: Element | null | undefined, names: string[]) => {
    if (!el || !win) return ""
    const cs = win.getComputedStyle(el)
    for (const name of names) {
      const v = cs.getPropertyValue(name).trim()
      if (v) return v
    }
    return ""
  }
  const panel = doc.querySelector(".knobs-panel")
  const piece = groups.find((g) => g.source && !g.source.paint)?.source?.root
  const pick = (k: string, fallback: string) =>
    read(panel, [`--k-${k}`]) || read(piece, [`--ku-${k}`, `--k-${k}`]) || fallback
  return {
    "--kh-accent": pick("accent", "#fff"),
    "--kh-bg": pick("bg", "#1c1c1e"),
    "--kh-mono": pick("mono", "ui-monospace,Menlo,monospace"),
    "--kh-radius": read(panel, ["--k-radius-sm"]) || "4px",
    "--kh-size": read(panel, ["--k-text-cap"]) || "10px",
    "--kh-typed": read(panel, ["--k-hint-typed-opacity"]) || ".42",
    "--kh-lift": read(panel, ["--k-lift"]) || "1",
    "--kh-ease": read(panel, ["--k-ease"]) || "cubic-bezier(.2,.8,.2,1)",
  }
}

/** Badges for everything that doesn't draw its own, on one fixed layer over the page. */
function layerPainter(doc: Document, groups: readonly Group[]): HintPainter {
  const layer = doc.createElement("div")
  layer.className = "knobs-page-hints"
  layer.setAttribute("aria-hidden", "true")
  let spots: readonly HintSpot[] = []
  let codes: readonly string[] = []
  let nodes: { tag: HTMLElement; typed: HTMLElement; rest: HTMLElement }[] = []
  return {
    show(next, nextCodes) {
      if (!doc.getElementById(STYLE_ID)) {
        const style = doc.createElement("style")
        style.id = STYLE_ID
        style.textContent = CSS
        doc.head.append(style)
      }
      spots = next
      codes = nextCodes
      for (const [k, v] of Object.entries(hintTokens(doc, groups))) layer.style.setProperty(k, v)
      nodes = spots.map((t, i) => {
        const tag = doc.createElement("kbd")
        tag.className = "knobs-page-hint"
        const typed = doc.createElement("span")
        typed.className = "knobs-hint-typed"
        const rest = doc.createElement("span")
        rest.textContent = codes[i] ?? ""
        tag.append(typed, rest)
        const r = (t.labelEl ?? t.el).getBoundingClientRect()
        const left = t.labelEl ? r.right + 6 : r.left + 1
        tag.style.left = `${Math.round(left)}px`
        tag.style.top = `${Math.round(r.top + r.height / 2)}px`
        layer.append(tag)
        return { tag, typed, rest }
      })
      doc.body.append(layer)
    },
    narrow(query) {
      const r = resolveHintCodes(codes, query)
      nodes.forEach((n, i) => {
        const b = r.badges[i]!
        n.tag.hidden = !b.match
        n.typed.textContent = b.typed
        n.rest.textContent = b.rest
        spots[i]!.el.toggleAttribute("data-knobs-hint-miss", !b.match)
      })
    },
    clear() {
      for (const t of spots) t.el.removeAttribute("data-knobs-hint-miss")
      layer.remove()
      layer.replaceChildren()
      spots = []
      nodes = []
    },
  }
}
