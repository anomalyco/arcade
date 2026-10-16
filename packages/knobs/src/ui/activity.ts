import { createRollingText, type RollingTextController } from "@kitlangton/rolling-number"
import { Spring, springMotion } from "../core/spring.js"
import {
  diffActivity,
  flattenActivity,
  formatDuration,
  groupTitle,
  indexActivity,
  isActivityKey,
  keepSelection,
  navigateActivity,
  railSegments,
  showsSelection,
  stackRows,
  type ActivityEvent,
  type ActivityInput,
  type ActivityRow,
  type RailNode,
} from "./activity-model.js"
import { applyLook, frameLoop, ICONS, reducedMotion, svg, syncFrame, type UiLook } from "./look.js"

export interface ActivityOptions extends UiLook {
  readonly events: readonly ActivityEvent[]
  /** The selected event's id. */
  readonly selected?: string | null
  /** Groups open from the start. */
  readonly expanded?: Iterable<string>
  /** Keys and clicks moved the selection (a host's `select()` doesn't call it). */
  readonly onSelect?: (id: string, event: ActivityEvent, source: "key" | "pointer") => void
  /** Enter on the selected row (on a group with no `onActivate`, Enter opens or closes it). */
  readonly onActivate?: (id: string, event: ActivityEvent) => void
  readonly onToggle?: (id: string, expanded: boolean) => void
  /** Makes the duration chip a button. */
  readonly onPlay?: (id: string, event: ActivityEvent) => void
  /**
   * Where the newest events are: `"bottom"` (the default; oldest first) or `"top"`. `add()` puts
   * an event there, and new events slide in from that side.
   */
  readonly newest?: "top" | "bottom"
  /** Stay pinned to the newest end when it was in view as events arrive (default true). */
  readonly follow?: boolean
  /**
   * Where the keys come from: `"focus"` (the default) while the rail has focus, or `"page"` from
   * anywhere a focused field or widget doesn't take them.
   */
  readonly keys?: "focus" | "page"
  /** Icons (SVG markup or a glyph) for your own kinds, or in place of built-in ones. */
  readonly icons?: Readonly<Record<string, string>>
  /** Tints (CSS colours) for your own kinds, or in place of built-in ones. */
  readonly tints?: Readonly<Record<string, string>>
  /** The rail's accessible name. */
  readonly label?: string
  /** Shown with no events. */
  readonly empty?: string
}

export interface Activity {
  readonly element: HTMLElement
  /** New events: those that stay glide to their places, new ones bloom in, gone ones soften out. */
  set(events: readonly ActivityEvent[]): void
  /** One more event at the newest end. */
  add(event: ActivityEvent): void
  /** Selects (opening its group); `null` clears. Doesn't call `onSelect`. */
  select(id: string | null): void
  readonly selected: string | null
  expand(id: string, expanded?: boolean): void
  isExpanded(id: string): boolean
  focus(): void
  destroy(): void
  /** The same as `destroy`, as the other pieces name it. */
  dispose(): void
}

const ACTIVITY_ICONS: Record<string, string> = {
  you: svg(
    '<circle cx="8" cy="5.5" r="2.5"/><path d="M3.2 13.5c.8-2.4 2.6-3.8 4.8-3.8s4 1.4 4.8 3.8"/>',
  ),
  agent: svg('<path d="M8 2.2 9.4 6.6 13.8 8 9.4 9.4 8 13.8 6.6 9.4 2.2 8 6.6 6.6Z"/>'),
  proposal: svg(
    '<rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1.2"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1.2"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1.2"/><rect x="9" y="9" width="4.5" height="4.5" rx="1.2"/>',
  ),
  review: svg('<rect x="2" y="3.5" width="12" height="9" rx="2.2"/><path d="M7 6.3v3.4L9.8 8Z"/>'),
  pr: svg(
    '<circle cx="4.5" cy="3.8" r="1.6"/><circle cx="4.5" cy="12.2" r="1.6"/><circle cx="11.5" cy="12.2" r="1.6"/><path d="M4.5 5.4v5.2M11.5 10.6V6.8a2 2 0 0 0-2-2H7.2M8.8 3.2 7.2 4.8l1.6 1.6"/>',
  ),
  build: svg(
    '<path d="M8 2.2 13.5 5v6L8 13.8 2.5 11V5Z"/><path d="M2.5 5 8 7.9 13.5 5M8 7.9v5.9"/>',
  ),
  blocked: svg('<path d="M3.8 14V2.6M3.8 3h8l-1.9 3 1.9 3h-8"/>'),
  shipped: svg('<circle cx="8" cy="8" r="5.8"/><path d="m5.6 8.2 1.7 1.7 3.2-3.6"/>'),
}
const PLAY =
  '<svg viewBox="0 0 8 8" aria-hidden="true"><path d="M1.5 1v6l5.2-3Z" fill="currentColor"/></svg>'

const REFLOW = springMotion({ duration: 0.4, bounce: 0 })
const OPEN = springMotion({ duration: 0.22, bounce: 0 })
const CLOSE = springMotion({ duration: 0.18, bounce: 0 })
const BLOOM = springMotion({ duration: 0.3, bounce: 0 })
const EXIT = springMotion({ duration: 0.24, bounce: 0 })
const FADE = springMotion({ duration: 0.16, bounce: 0 })
/** How far the line keeps clear of a node: an event's icon, a child's dot. */
const CLEAR = [11, 5] as const
const PAD = 6
const SLIDE = 8

type Motion = { omega: number; zeta: number }
const tune = (s: Spring, m: Motion) => {
  s.omega = m.omega
  s.zeta = m.zeta
  return s
}

interface View {
  id: string
  el: HTMLElement
  node: HTMLElement
  actor: HTMLElement
  title: HTMLElement
  meta: HTMLElement
  thumbs: HTMLElement
  chip: HTMLElement | null
  caret: HTMLElement
  time: HTMLElement
  roll: RollingTextController | null
  chipRoll: RollingTextController | null
  y: Spring
  p: Spring
  depth: 0 | 1
  /** Slides out from under (or back under) this group, clipped at its bottom edge. */
  under: string | null
  /** A new event's side: -1 from above, 1 from below, 0 in place. */
  from: -1 | 0 | 1
  leaving: boolean
  event: ActivityEvent | undefined
  state: string
}

/**
 * A vertical rail of events: who did what, one line each, with a kind's icon on one continuous
 * line. Groups open in place with their children on the same line. ↑/↓, Home/End move the
 * selection (a tint that shows only once keys move it), ←/→ close and open groups, Enter
 * activates. New events bloom in while the rest glide; every move is an interruptible spring.
 */
export function activity(container: HTMLElement, options: ActivityOptions): Activity {
  const doc = container.ownerDocument
  const win = doc.defaultView!
  const newest = options.newest ?? "bottom"
  const keysFrom = options.keys ?? "focus"
  let events = options.events
  let index = indexActivity(events)
  const expanded = new Set(options.expanded ?? [])
  let rows: ActivityRow[] = []
  let selected: string | null = options.selected ?? null
  let showing = false

  const root = doc.createElement("div")
  root.className = "knobs-activity knobs-scroll-fade"
  root.tabIndex = 0
  root.setAttribute("role", "tree")
  if (options.label) root.setAttribute("aria-label", options.label)
  applyLook(root, options)
  const space = doc.createElement("div")
  space.className = "knobs-activity-space"
  const hl = doc.createElement("div")
  hl.className = "knobs-activity-hl"
  hl.setAttribute("aria-hidden", "true")
  const line = doc.createElementNS("http://www.w3.org/2000/svg", "svg")
  line.setAttribute("class", "knobs-activity-line")
  line.setAttribute("aria-hidden", "true")
  const path = doc.createElementNS("http://www.w3.org/2000/svg", "path")
  line.append(path)
  const empty = doc.createElement("div")
  empty.className = "knobs-activity-empty"
  empty.hidden = true
  space.append(hl, line)
  root.append(empty, space)
  container.append(root)

  // Row heights from the tokens.
  let heights: [number, number] = [32, 26]
  const measure = () => {
    syncFrame(root)
    const probe = (depth: 0 | 1) => {
      const p = doc.createElement("div")
      p.className = "knobs-activity-row"
      p.dataset.depth = String(depth)
      p.style.visibility = "hidden"
      space.append(p)
      const h = p.getBoundingClientRect().height
      p.remove()
      return h
    }
    heights = [probe(0) || 32, probe(1) || 26]
  }
  measure()

  const uid = `ka${Math.random().toString(36).slice(2, 7)}`
  const domIds = new Map<string, string>()
  const domId = (id: string) => {
    let d = domIds.get(id)
    if (!d) domIds.set(id, (d = `${uid}-${domIds.size}`))
    return d
  }

  const views = new Map<string, View>()
  const makeView = (row: ActivityRow): View => {
    const el = doc.createElement("div")
    el.className = "knobs-activity-row"
    el.setAttribute("role", "treeitem")
    el.id = domId(row.id)
    el.dataset.id = row.id
    const node = doc.createElement("span")
    node.className = "knobs-activity-node"
    const main = doc.createElement("span")
    main.className = "knobs-activity-main knobs-scroll-fade-x"
    const actor = doc.createElement("span")
    actor.className = "knobs-activity-actor"
    const title = doc.createElement("span")
    title.className = "knobs-activity-title"
    main.append(actor, title)
    const meta = doc.createElement("span")
    meta.className = "knobs-activity-meta"
    const thumbs = doc.createElement("span")
    thumbs.className = "knobs-activity-thumbs"
    const caret = doc.createElement("span")
    caret.className = "knobs-activity-caret"
    caret.innerHTML = ICONS.caret
    const time = doc.createElement("span")
    time.className = "knobs-activity-time"
    el.append(node, main, meta)
    space.append(el)
    const v: View = {
      id: row.id,
      el,
      node,
      actor,
      title,
      meta,
      thumbs,
      chip: null,
      caret,
      time,
      roll: null,
      chipRoll: null,
      y: new Spring(0, REFLOW.omega, REFLOW.zeta, 0.05),
      p: new Spring(1, BLOOM.omega, BLOOM.zeta, 0.002),
      depth: row.depth,
      under: null,
      from: 0,
      leaving: false,
      event: undefined,
      state: "",
    }
    views.set(row.id, v)
    return v
  }
  const dropView = (v: View) => {
    v.roll?.destroy()
    v.chipRoll?.destroy()
    v.el.remove()
    views.delete(v.id)
  }

  /** Text that rolls when it changes (times, durations), from the first paint at rest. */
  const rollInto = (host: HTMLElement, roll: RollingTextController | null, text: string) => {
    if (!text) {
      roll?.destroy()
      host.textContent = ""
      return null
    }
    if (roll) {
      roll.update({ text })
      return roll
    }
    return createRollingText(host, {
      text,
      charset: "0123456789",
      transition: "direct",
      animated: !reducedMotion(win),
    })
  }

  const bind = (v: View, row: ActivityRow) => {
    const e = row.event
    const state = `${row.depth}|${row.group}|${row.expanded}|${selected === row.id}`
    if (v.event === e && v.state === state) return
    const changed = v.event !== e
    v.event = e
    v.state = state
    v.depth = row.depth
    const el = v.el
    el.dataset.depth = String(row.depth)
    el.setAttribute("aria-level", String(row.depth + 1))
    el.setAttribute("aria-selected", String(selected === row.id))
    if (row.group) el.setAttribute("aria-expanded", String(row.expanded))
    else el.removeAttribute("aria-expanded")
    if (!changed) return
    if (e.kind) el.dataset.kind = e.kind
    else delete el.dataset.kind
    el.toggleAttribute("data-current", Boolean(e.current))
    el.toggleAttribute("data-dimmed", Boolean(e.dimmed))
    const tint = e.tint ?? (e.kind ? options.tints?.[e.kind] : undefined)
    if (tint) el.style.setProperty("--ka-tint", tint)
    else el.style.removeProperty("--ka-tint")
    // The node.
    const icon =
      e.icon ??
      (row.depth === 1
        ? undefined
        : ((e.kind && (options.icons?.[e.kind] ?? ACTIVITY_ICONS[e.kind])) ?? undefined))
    if (icon instanceof Node) v.node.replaceChildren(icon)
    else if (icon === undefined) {
      if (!v.node.firstElementChild?.classList.contains("knobs-activity-dot"))
        v.node.innerHTML = '<i class="knobs-activity-dot"></i>'
    } else if (icon.trimStart().startsWith("<")) {
      if (v.node.innerHTML !== icon) v.node.innerHTML = icon
    } else {
      const glyph = doc.createElement("span")
      glyph.className = "knobs-activity-glyph"
      glyph.textContent = icon
      v.node.replaceChildren(glyph)
    }
    // The words.
    const kids = e.children?.length ?? 0
    v.actor.textContent = e.actor ?? ""
    const title = e.title ?? (kids ? groupTitle(kids) : "")
    if (v.title.textContent !== title) v.title.textContent = title
    el.setAttribute("aria-label", [e.actor, title, e.time].filter(Boolean).join(", "))
    // Trailing.
    const parts: Node[] = []
    const thumbs = e.thumbs?.slice(0, 4) ?? []
    const shown = [...v.thumbs.querySelectorAll("img")].map((i) => i.getAttribute("src"))
    if (thumbs.join("\n") !== shown.join("\n"))
      v.thumbs.replaceChildren(
        ...thumbs.map((src) => {
          const img = doc.createElement("img")
          img.src = src
          img.alt = ""
          img.loading = "lazy"
          img.draggable = false
          return img
        }),
      )
    if (thumbs.length) parts.push(v.thumbs)
    if (e.duration !== undefined) {
      const button = Boolean(options.onPlay)
      if (!v.chip || (v.chip.tagName === "BUTTON") !== button) {
        v.chipRoll?.destroy()
        v.chipRoll = null
        v.chip = doc.createElement(button ? "button" : "span")
        v.chip.className = "knobs-activity-chip"
        if (button) {
          ;(v.chip as HTMLButtonElement).type = "button"
          v.chip.tabIndex = -1
          v.chip.setAttribute("aria-label", "Play")
        }
        v.chip.innerHTML = `${PLAY}<span></span>`
      }
      v.chipRoll = rollInto(
        v.chip.lastElementChild as HTMLElement,
        v.chipRoll,
        formatDuration(e.duration),
      )
      parts.push(v.chip)
    }
    if (kids) parts.push(v.caret)
    v.roll = rollInto(v.time, v.roll, e.time ?? "")
    if (e.time) parts.push(v.time)
    const now = [...v.meta.children]
    if (now.length !== parts.length || now.some((n, i) => n !== parts[i]))
      v.meta.replaceChildren(...parts)
  }

  const nodeY = (v: View) => v.y.x + heights[v.depth] / 2
  let targets = new Map<string, number>()

  const lineTop = new Spring(0, REFLOW.omega, REFLOW.zeta, 0.05)
  const lineBottom = new Spring(0, REFLOW.omega, REFLOW.zeta, 0.05)
  const hlY = new Spring(0, REFLOW.omega, REFLOW.zeta, 0.05)
  const hlH = new Spring(0, REFLOW.omega, REFLOW.zeta, 0.05)
  const height = new Spring(0, REFLOW.omega, REFLOW.zeta, 0.05)
  let following = false

  const place = (v: View, reduced: boolean) => {
    const p = Math.max(0, Math.min(1, v.p.x))
    let y = v.y.x
    let clip = 0
    let transform = ""
    let filter = ""
    if (v.under !== null) {
      const parent = views.get(v.under)
      const bottom = (parent ? parent.y.x : (targets.get(v.under) ?? 0)) + heights[0]
      clip = Math.min(heights[v.depth], Math.max(0, bottom - y))
    } else if (p < 1 && !reduced) {
      y += (1 - p) * SLIDE * v.from
      transform = ` scale(${(0.97 + 0.03 * p).toFixed(4)})`
      const blur = (1 - p) * 3
      if (blur > 0.05) filter = `blur(${blur.toFixed(2)}px)`
    }
    v.el.style.transform = `translate3d(0,${Math.round(y * 2) / 2}px,0)${transform}`
    v.el.style.clipPath = clip > 0 ? `inset(${clip}px 0 0 0)` : ""
    v.el.style.opacity = p < 0.999 ? p.toFixed(3) : ""
    v.el.style.filter = filter
  }

  const drawLine = () => {
    const nodes: RailNode[] = []
    for (const v of views.values()) {
      const p = Math.max(0, Math.min(1, v.p.x))
      if (p <= 0.001) continue
      const y = nodeY(v)
      // A child still under its group's edge is hidden there: the line runs on past it.
      if (v.under !== null) {
        const parent = views.get(v.under)
        if (parent && y < parent.y.x + heights[0]) continue
      }
      nodes.push({ y, r: CLEAR[v.depth] * Math.min(1, p * 1.5) })
    }
    const segs = railSegments(nodes, lineTop.x, lineBottom.x)
    path.setAttribute("d", segs.map(([a, b]) => `M1 ${a.toFixed(2)}V${b.toFixed(2)}`).join(""))
  }

  const placeHighlight = () => {
    hl.style.transform = `translate3d(0,${Math.round(hlY.x * 2) / 2}px,0)`
    hl.style.height = `${Math.max(0, hlH.x).toFixed(2)}px`
  }

  const loop = frameLoop(win, (dt) => {
    const reduced = reducedMotion(win)
    let moving = false
    for (const s of [lineTop, lineBottom, hlY, hlH, height]) {
      s.step(dt)
      if (!s.resting) moving = true
    }
    for (const v of [...views.values()]) {
      v.y.step(dt)
      v.p.step(dt)
      if (v.y.resting && v.p.resting) {
        if (v.leaving) {
          dropView(v)
          continue
        }
        v.under = null
        v.from = 0
      } else moving = true
      place(v, reduced)
    }
    drawLine()
    placeHighlight()
    space.style.height = `${Math.max(0, height.x).toFixed(1)}px`
    if (following) root.scrollTop = newest === "bottom" ? root.scrollHeight : 0
    if (!moving) following = false
    return moving
  })

  const atNewestEnd = () =>
    newest === "bottom"
      ? root.scrollTop + root.clientHeight >= root.scrollHeight - 4
      : root.scrollTop <= 4

  type Cause = "snap" | "set" | "open" | "close"

  /**
   * Brings the views in line with `rows`. `"snap"` places everything; `"set"` glides rows that
   * stay (calm), blooms new ones in from the newest side and softens gone ones out; `"open"` and
   * `"close"` move the toggled group's children out from under it (or back) with the rows below,
   * like a drawer, on the reveal springs (.22 s open, .18 s close).
   */
  function sync(cause: Cause, toggled?: string) {
    const reduced = reducedMotion(win)
    const animate = cause !== "snap"
    const glide = cause === "open" ? OPEN : cause === "close" ? CLOSE : REFLOW
    const before = [...views.values()].filter((v) => !v.leaving).map((v) => v.id)
    rows = flattenActivity(events, expanded)
    selected = keepSelection(rows, selected, (id) => index.get(id)?.parent)
    const stack = stackRows(
      rows.map((r) => heights[r.depth]),
      PAD,
    )
    targets = new Map(rows.map((r, i) => [r.id, stack.y[i]!]))
    const { entered } = diffActivity(
      before,
      rows.map((r) => r.id),
    )
    const fresh = new Set(entered)
    // The rows a toggle opens or shuts move as one block with the rows below, like a drawer.
    let opened = 0
    if (cause === "open")
      for (const r of rows) if (r.parent === toggled && fresh.has(r.id)) opened += heights[r.depth]
    let shut = 0
    const live = new Set(rows.map((r) => r.id))
    if (cause === "close")
      for (const v of views.values())
        if (!live.has(v.id) && !v.leaving && index.get(v.id)?.parent === toggled)
          shut += heights[v.depth]
    const following0 = animate && options.follow !== false && atNewestEnd()
    const lastIndex = rows.length - 1
    rows.forEach((row, i) => {
      const goal = stack.y[i]!
      let v = views.get(row.id)
      if (v && v.leaving) {
        // Back before it left: it comes back from where it is.
        v.leaving = false
        delete v.el.dataset.leaving
        tune(v.p, cause === "open" ? OPEN : BLOOM).set(1)
      }
      if (!v) {
        v = makeView(row)
        if (!animate) {
          v.y.snap(goal)
          v.p.snap(1)
        } else if (reduced) {
          v.y.snap(goal)
          tune(v.p, FADE).snap(0).set(1)
        } else {
          const parent = row.parent !== null ? views.get(row.parent) : undefined
          if (parent && !parent.leaving) {
            // Out from under its group, the block of children with the rows below.
            v.under = row.parent
            const drawer = cause === "open" && row.parent === toggled
            v.y.snap(drawer ? goal - opened + parent.y.x - parent.y.target : parent.y.x)
            tune(v.y, drawer ? OPEN : glide).set(goal)
            tune(v.p, drawer ? OPEN : BLOOM)
              .snap(0)
              .set(1)
          } else {
            v.y.snap(goal)
            v.from = newest === "bottom" ? 1 : -1
            tune(v.p, BLOOM).snap(0).set(1)
          }
        }
      } else if (!animate || reduced) v.y.snap(goal)
      else tune(v.y, glide).set(goal)
      bind(v, row)
    })
    // Gone: children fold back under their group; anything else softens out where it is.
    for (const v of [...views.values()]) {
      if (live.has(v.id) || v.leaving) continue
      if (!animate) {
        dropView(v)
        continue
      }
      v.leaving = true
      v.el.dataset.leaving = ""
      v.el.setAttribute("aria-selected", "false")
      if (reduced) {
        tune(v.p, FADE).set(0)
        continue
      }
      const group = index.get(v.id)?.parent ?? null
      const parent = group !== null ? views.get(group) : undefined
      if (parent && !parent.leaving && v.depth === 1) {
        v.under = group
        const drawer = cause === "close" && group === toggled
        tune(v.y, drawer ? CLOSE : glide).set(
          drawer ? v.y.target - shut : (targets.get(group!) ?? parent.y.target),
        )
        tune(v.p, drawer ? CLOSE : EXIT).set(0)
      } else {
        v.from = 0
        tune(v.p, EXIT).set(0)
      }
    }
    // The line's ends, the selection's tint and the content's height follow.
    const first = rows[0]
    const last = rows[lastIndex]
    const firstY = first ? targets.get(first.id)! + heights[first.depth] / 2 : PAD
    const lastY = last ? targets.get(last.id)! + heights[last.depth] / 2 : PAD
    const bottom = stack.bottom + PAD
    if (!animate || reduced) {
      lineTop.snap(firstY)
      lineBottom.snap(lastY)
      height.snap(bottom)
    } else {
      // A first row: the line starts at its node rather than growing from the old top.
      if (!before.length) {
        lineTop.snap(firstY)
        lineBottom.snap(firstY)
      }
      tune(lineTop, glide).set(firstY)
      tune(lineBottom, cause === "set" ? BLOOM : glide).set(lastY)
      tune(height, glide).set(bottom)
    }
    moveHighlight(animate && !reduced ? glide : null)
    hl.hidden = !selected
    empty.hidden = rows.length > 0
    empty.textContent = options.empty ?? "Nothing yet"
    root.setAttribute("aria-activedescendant", selected ? domId(selected) : "")
    if (!selected) root.removeAttribute("aria-activedescendant")
    if (following0 && fresh.size) following = true
    for (const v of views.values()) place(v, reduced)
    drawLine()
    placeHighlight()
    space.style.height = `${height.x.toFixed(1)}px`
    loop.wake()
  }

  /** The tint goes to the selected row: gliding while it shows, placed while it doesn't. */
  const moveHighlight = (motion: Motion | null) => {
    const y = selected ? targets.get(selected) : undefined
    if (y === undefined) return
    const h = heights[rows.find((r) => r.id === selected)?.depth ?? 0]
    if (!motion || !showing) {
      hlY.snap(y)
      hlH.snap(h)
      return
    }
    tune(hlY, motion).set(y)
    tune(hlH, motion).set(h)
  }

  const setShowing = (input: ActivityInput) => {
    const next = showsSelection(showing, input, keysFrom)
    if (next === showing) return
    showing = next
    root.toggleAttribute("data-keys", next)
  }

  const rebind = () => {
    for (const row of rows) {
      const v = views.get(row.id)
      if (v && !v.leaving) bind(v, row)
    }
  }

  const reveal = (id: string) => {
    const y = targets.get(id)
    if (y === undefined) return
    const h = heights[rows.find((r) => r.id === id)?.depth ?? 0]
    const top = root.scrollTop
    const view = root.clientHeight
    if (view <= 0 || root.scrollHeight <= view) return
    const behavior: ScrollBehavior = reducedMotion(win) ? "auto" : "smooth"
    if (y - PAD < top) root.scrollTo({ top: y - PAD, behavior })
    else if (y + h + PAD > top + view) root.scrollTo({ top: y + h + PAD - view, behavior })
  }

  /** Selects `id`: the tint glides there (by distance, .3 s or .42 s) when it shows. */
  const choose = (id: string | null, source: "key" | "pointer" | "code") => {
    if (source === "key") {
      const wasShowing = showing
      setShowing("key")
      if (!wasShowing) moveHighlight(null)
    } else if (source === "pointer") setShowing("pointer")
    if (id === selected) return
    const from = selected ? targets.get(selected) : undefined
    selected = id
    rebind()
    hl.hidden = !id
    if (id) {
      const to = targets.get(id)
      const far = from !== undefined && to !== undefined && Math.abs(to - from) > 400
      const reduced = reducedMotion(win)
      moveHighlight(
        reduced || from === undefined
          ? null
          : springMotion({ duration: far ? 0.42 : 0.3, bounce: 0 }),
      )
      root.setAttribute("aria-activedescendant", domId(id))
      if (source === "key") reveal(id)
      const event = index.get(id)?.event
      if (event && source !== "code") options.onSelect?.(id, event, source)
    } else root.removeAttribute("aria-activedescendant")
    loop.wake()
  }

  const toggle = (id: string, open: boolean) => {
    const row = rows.find((r) => r.id === id)
    if (!row?.group || row.expanded === open) return
    if (open) expanded.add(id)
    else expanded.delete(id)
    sync(open ? "open" : "close", id)
    options.onToggle?.(id, open)
  }

  // Pointer: a click selects with no ring; a group's row opens or closes it.
  root.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return
    setShowing("pointer")
    const el = (e.target as Element).closest<HTMLElement>(".knobs-activity-row")
    const id = el?.dataset.id
    if (!el || !id || el.dataset.leaving !== undefined) return
    e.preventDefault()
    root.focus({ preventScroll: true })
    if ((e.target as Element).closest(".knobs-activity-chip")) return
    const row = rows.find((r) => r.id === id)
    choose(id, "pointer")
    if (row?.group) toggle(id, !row.expanded)
  })
  root.addEventListener("click", (e) => {
    const chip = (e.target as Element).closest(".knobs-activity-chip")
    const id = chip?.closest<HTMLElement>(".knobs-activity-row")?.dataset.id
    const event = id ? index.get(id)?.event : undefined
    if (chip && id && event && options.onPlay) {
      e.stopPropagation()
      options.onPlay(id, event)
    }
  })
  const onPointer = () => setShowing("pointer")
  if (keysFrom === "page") win.addEventListener("pointerdown", onPointer, true)

  const typing = (t: EventTarget | null) =>
    t instanceof HTMLElement &&
    (t.isContentEditable ||
      t instanceof HTMLSelectElement ||
      t instanceof HTMLTextAreaElement ||
      (t instanceof HTMLInputElement &&
        !t.readOnly &&
        !["range", "checkbox", "radio", "button"].includes(t.type)))
  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return
    if (keysFrom === "page") {
      if (e.target !== root && (typing(e.target) || !root.getClientRects().length)) return
      // A focused widget that takes arrows (a panel's row, a tree, a slider) keeps them.
      const t = e.target as Element | null
      if (
        t !== root &&
        t?.closest?.(".knobs-panel,[role=tree],[role=listbox],[role=grid],[role=slider]")
      )
        return
    }
    let handled = true
    if (isActivityKey(e.key) && !e.shiftKey) {
      const r = navigateActivity(rows, selected, e.key)
      if (r.toggle) {
        setShowing("key")
        toggle(r.toggle.id, r.toggle.expanded)
      } else if (r.select) choose(r.select, "key")
      else setShowing("key")
    } else if (e.key === "Enter" && selected) {
      setShowing("key")
      const row = rows.find((r) => r.id === selected)
      const event = index.get(selected)?.event
      if (options.onActivate && event) options.onActivate(selected, event)
      else if (row?.group) toggle(row.id, !row.expanded)
      else handled = false
    } else handled = false
    if (handled) {
      e.preventDefault()
      e.stopPropagation()
    }
  }
  if (keysFrom === "page") win.addEventListener("keydown", onKey)
  else root.addEventListener("keydown", onKey)
  root.addEventListener("blur", () => setShowing("blur"))

  const remeasure = () => {
    const was = heights.join()
    measure()
    if (heights.join() !== was) sync("snap")
  }
  const ro = new ResizeObserver(remeasure)
  ro.observe(root)
  root.addEventListener("knobs-restyle", () => {
    measure()
    sync("snap")
  })

  sync("snap")

  const handle: Activity = {
    element: root,
    set(next) {
      events = next
      index = indexActivity(events)
      for (const id of [...expanded]) if (!index.has(id)) expanded.delete(id)
      sync("set")
    },
    add(event) {
      handle.set(newest === "bottom" ? [...events, event] : [event, ...events])
    },
    select(id) {
      if (id !== null) {
        const parent = index.get(id)?.parent
        if (parent && !expanded.has(parent)) {
          expanded.add(parent)
          sync("open", parent)
        }
      }
      choose(id, "code")
    },
    get selected() {
      return selected
    },
    expand: (id, open = !expanded.has(id)) => toggle(id, open),
    isExpanded: (id) => expanded.has(id),
    focus: () => root.focus({ preventScroll: true }),
    destroy() {
      loop.stop()
      ro.disconnect()
      if (keysFrom === "page") {
        win.removeEventListener("keydown", onKey)
        win.removeEventListener("pointerdown", onPointer, true)
      }
      for (const v of [...views.values()]) dropView(v)
      root.remove()
    },
    dispose: () => handle.destroy(),
  }
  return handle
}
