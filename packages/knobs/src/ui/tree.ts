import { Spring, springMotion } from "../core/spring.js"
import { applyLook, frameLoop, ICONS, reducedMotion, type UiLook } from "./look.js"
import {
  dropTarget,
  flatten,
  indexTree,
  navigate,
  select,
  stepMove,
  topmost,
  typeahead,
  validMove,
  virtualWindow,
  zoneAt,
  type DropTarget,
  type FlatRow,
  type NavKey,
  type Selection,
  type TreeAccess,
  type TreeFilter,
  type TreeMove,
} from "./tree-model.js"

/** A row accessory that flips a flag: visibility, a lock, or one of your own. */
export interface TreeToggle<T> {
  /** `"visible"` and `"locked"` bring their own icons. */
  readonly id: string
  readonly label: string
  /** Whether the item is in its usual state (visible, unlocked): only the other one shows at rest. */
  get(item: T): boolean
  /** Flip it for these ids (the selection, when the row is in it). */
  set(ids: readonly string[], value: boolean): void
  /** SVG markup for each state. */
  icon?(on: boolean): string
}

export interface TreeRowContext {
  readonly id: string
  readonly depth: number
  readonly expanded: boolean
  readonly selected: boolean
  readonly element: HTMLElement
}

export interface TreeOptions<T> extends UiLook {
  readonly items: readonly T[]
  /** Item → id (unique); `item.id` unless set. */
  readonly getId?: (item: T) => string
  /** Item → children (`item.children` unless set); an array, even empty, takes drops. */
  readonly getChildren?: (item: T) => readonly T[] | null | undefined
  /** Item → label (`item.label`, else its id). */
  readonly getLabel?: (item: T) => string
  /** A glyph, SVG markup or node before the label. */
  readonly icon?: (item: T) => string | Node | undefined
  /** Dimmed text after the label (a count, a kind). */
  readonly detail?: (item: T) => string | undefined
  /** Your own content in place of the label. */
  readonly render?: (item: T, row: TreeRowContext) => Node | string | undefined | void
  readonly selection?: Iterable<string>
  readonly onSelect?: (ids: readonly string[], primary: string | null) => void
  readonly expanded?: Iterable<string>
  readonly onToggle?: (id: string, expanded: boolean) => void
  /** Drag and ⌥↑↓ report moves; apply them (`applyMove` does for plain items) and `update`. */
  readonly onMove?: (move: TreeMove) => void
  readonly canDrop?: (move: TreeMove) => boolean
  /** F2 or Enter renames in place. */
  readonly onRename?: (id: string, label: string) => void
  /** A double-click (and Enter, without `onRename`). */
  readonly onActivate?: (id: string) => void
  readonly toggles?: readonly TreeToggle<T>[]
  readonly filter?: TreeFilter<T>
  /** Pixels; `--k-row` unless set. */
  readonly rowHeight?: number
  /** The tree's accessible name. */
  readonly label?: string
  /** Shown with no rows. */
  readonly empty?: string
}

export interface Tree<T> {
  readonly element: HTMLElement
  /** New items: rows that stay glide to their new places, others fold in and out. */
  update(items: readonly T[]): void
  select(ids: Iterable<string>, primary?: string | null): void
  readonly selection: readonly string[]
  readonly active: string | null
  expand(id: string, expanded?: boolean): void
  isExpanded(id: string): boolean
  /** A query (label substring) or a test; matching rows show with their ancestors. */
  filter(filter: TreeFilter<T>): void
  /** The ids on show, top to bottom. */
  rows(): readonly string[]
  focus(id?: string): void
  /** Opens its ancestors and scrolls it into view. */
  reveal(id: string): void
  rename(id: string): void
  /** Draws rows again from their items (after you change them in place). */
  refresh(): void
  dispose(): void
}

const MOVE = springMotion({ duration: 0.34, bounce: 0.02 })
const EDGE = 28

interface View<T> {
  id: string
  el: HTMLElement
  caret: HTMLElement
  icon: HTMLElement
  label: HTMLElement
  text: HTMLElement
  detail: HTMLElement
  tools: HTMLElement
  y: Spring
  /** Slides out from under (or back under) this row, clipped below its bottom edge. */
  under: string | null
  leaving: boolean
  bound: string
  item: T | undefined
}

/**
 * An outliner: virtualised rows (thousands scroll at full speed), springing open and shut with
 * the children cascading out from under their parent. Roving focus (↑↓, ← to close or go up, → to
 * open or go down, Home/End, type-ahead, Space), ⇧/⌘ multi-selection, drag to reorder and
 * reparent (⌥↑↓ by keys), inline rename, visibility and lock toggles, and a filter that keeps
 * matching rows' ancestors.
 */
export function tree<T>(container: HTMLElement, options: TreeOptions<T>): Tree<T> {
  const doc = container.ownerDocument
  const win = doc.defaultView!
  const access: TreeAccess<T> = {
    id: options.getId ?? ((item) => String((item as { id?: unknown }).id)),
    children:
      options.getChildren ?? ((item) => (item as { children?: readonly T[] | null }).children),
    label:
      options.getLabel ??
      ((item) => {
        const it = item as { label?: unknown; id?: unknown }
        return String(it.label ?? it.id ?? "")
      }),
  }
  let items = options.items
  let filter: TreeFilter<T> = options.filter
  const expanded = new Set(options.expanded ?? [])
  let sel: Selection = { ids: [...(options.selection ?? [])], anchor: null }
  let active: string | null = sel.ids[0] ?? null
  let rows: FlatRow<T>[] = []
  let rowIndex = new Map<string, number>()
  let index = indexTree(items, access)
  const renamed = new Map<string, string>()

  const root = doc.createElement("div")
  root.className = "knobs-tree"
  root.tabIndex = 0
  root.setAttribute("role", "tree")
  root.setAttribute("aria-multiselectable", "true")
  if (options.label) root.setAttribute("aria-label", options.label)
  applyLook(root, options)
  const space = doc.createElement("div")
  space.className = "knobs-tree-space"
  const line = doc.createElement("div")
  line.className = "knobs-tree-line"
  const empty = doc.createElement("div")
  empty.className = "knobs-tree-empty"
  empty.hidden = true
  root.append(space, line, empty)
  container.append(root)

  // Sizes from the tokens: row height, indent and inset.
  let h = 26
  let indent = 14
  let inset = 8
  const measure = () => {
    const probe = doc.createElement("div")
    probe.style.cssText =
      "position:absolute;visibility:hidden;height:var(--ku-row);width:var(--ku-indent);padding-left:var(--ku-inset)"
    root.append(probe)
    const r = probe.getBoundingClientRect()
    h = options.rowHeight ?? (r.height || 26)
    indent = parseFloat(getComputedStyle(probe).width) || 14
    inset = parseFloat(getComputedStyle(probe).paddingLeft) || 8
    probe.remove()
  }
  measure()

  const domIds = new Map<string, string>()
  const uid = `kt${Math.random().toString(36).slice(2, 7)}`
  const domId = (id: string) => {
    let d = domIds.get(id)
    if (!d) domIds.set(id, (d = `${uid}-${domIds.size}`))
    return d
  }

  const views = new Map<string, View<T>>()
  const pool: View<T>[] = []
  const makeView = (id: string): View<T> => {
    const v = pool.pop() ?? createView()
    v.id = id
    v.under = null
    v.leaving = false
    v.bound = ""
    v.item = undefined
    v.el.id = domId(id)
    v.el.dataset.id = id
    v.el.style.clipPath = ""
    v.el.style.opacity = ""
    root.append(v.el)
    views.set(id, v)
    return v
  }
  function createView(): View<T> {
    const el = doc.createElement("div")
    el.className = "knobs-tree-row"
    el.setAttribute("role", "treeitem")
    const caret = doc.createElement("span")
    caret.className = "knobs-tree-caret"
    caret.innerHTML = ICONS.caret
    const icon = doc.createElement("span")
    icon.className = "knobs-tree-icon"
    const label = doc.createElement("span")
    label.className = "knobs-tree-label"
    const text = doc.createElement("span")
    text.className = "knobs-tree-text"
    label.append(text)
    const detail = doc.createElement("span")
    detail.className = "knobs-tree-detail"
    const tools = doc.createElement("span")
    tools.className = "knobs-tree-tools"
    el.append(caret, icon, label, detail, tools)
    return {
      id: "",
      el,
      caret,
      icon,
      label,
      text,
      detail,
      tools,
      y: new Spring(0, MOVE.omega, MOVE.zeta, 0.1),
      under: null,
      leaving: false,
      bound: "",
      item: undefined,
    }
  }
  const dropView = (v: View<T>) => {
    views.delete(v.id)
    v.el.remove()
    delete v.el.dataset.drop
    delete v.el.dataset.dragged
    if (pool.length < 200) pool.push(v)
  }

  const isSelected = (id: string) => selected.has(id)
  let selected = new Set(sel.ids)

  const bind = (v: View<T>, row: FlatRow<T>, force = false) => {
    const state = `${row.depth}|${row.expanded}|${row.hasChildren}|${isSelected(row.id)}|${active === row.id}|${row.match?.join()}|${row.ancestor}|${renamed.get(row.id) ?? ""}`
    if (!force && v.item === row.item && v.bound === state) return
    const itemChanged = force || v.item !== row.item
    v.bound = state
    v.item = row.item
    const el = v.el
    el.style.paddingLeft = `${Math.max(0, inset - 6) + row.depth * indent}px`
    el.setAttribute("aria-level", String(row.depth + 1))
    if (row.hasChildren) el.setAttribute("aria-expanded", String(row.expanded))
    else el.removeAttribute("aria-expanded")
    el.setAttribute("aria-selected", String(isSelected(row.id)))
    el.toggleAttribute("data-active", active === row.id)
    el.toggleAttribute("data-ancestor", Boolean(row.ancestor))
    const label = renamed.get(row.id) ?? access.label(row.item)
    el.setAttribute("aria-label", label)
    const custom = options.render?.(row.item, {
      id: row.id,
      depth: row.depth,
      expanded: row.expanded,
      selected: isSelected(row.id),
      element: el,
    })
    if (custom !== undefined && custom !== null) {
      if (typeof custom === "string") v.text.textContent = custom
      else v.text.replaceChildren(custom)
    } else if (row.match) {
      const [a, b] = row.match
      const mark = doc.createElement("mark")
      mark.className = "knobs-tree-mark"
      mark.textContent = label.slice(a, b)
      v.text.replaceChildren(label.slice(0, a), mark, label.slice(b))
    } else if (v.text.textContent !== label || v.text.childElementCount) v.text.textContent = label
    if (itemChanged || force) {
      const glyph = options.icon?.(row.item)
      v.icon.hidden = glyph === undefined
      if (glyph instanceof Node) v.icon.replaceChildren(glyph)
      else if (glyph !== undefined) {
        if (glyph.trimStart().startsWith("<")) v.icon.innerHTML = glyph
        else v.icon.textContent = glyph
      }
      const detail = options.detail?.(row.item)
      v.detail.hidden = !detail
      v.detail.textContent = detail ?? ""
    }
    const off: string[] = []
    if (options.toggles?.length) {
      if (v.tools.childElementCount !== options.toggles.length) {
        v.tools.replaceChildren(
          ...options.toggles.map((t) => {
            const b = doc.createElement("button")
            b.type = "button"
            b.className = "knobs-tree-toggle"
            b.tabIndex = -1
            b.dataset.toggle = t.id
            return b
          }),
        )
      }
      options.toggles.forEach((t, i) => {
        const on = t.get(row.item)
        if (!on) off.push(t.id)
        const b = v.tools.children[i] as HTMLElement
        if (b.getAttribute("aria-pressed") !== String(on) || !b.firstChild) {
          b.setAttribute("aria-pressed", String(on))
          b.setAttribute("aria-label", t.label)
          b.title = t.label
          b.innerHTML = t.icon?.(on) ?? builtinIcon(t.id, on)
        }
      })
    } else v.tools.hidden = true
    if (off.length) el.dataset.off = off.join(" ")
    else delete el.dataset.off
  }

  let lastRows: FlatRow<T>[] = []
  const recompute = () => {
    lastRows = rows
    rows = flatten(items, access, expanded, filter)
    rowIndex = new Map(rows.map((r, i) => [r.id, i]))
    root.setAttribute("aria-rowcount", String(rows.length))
    empty.hidden = rows.length > 0
    empty.textContent = options.empty ?? (filter ? "Nothing matches" : "Nothing here")
  }

  const loop = frameLoop(win, (dt) => frame(dt))
  let spaceHeight = 0
  const setSpace = (px: number) => {
    if (Math.abs(px - spaceHeight) < 0.5) return
    spaceHeight = px
    space.style.height = `${px}px`
  }

  const place = (v: View<T>) => {
    const y = v.y.x
    v.el.style.transform = `translate3d(0,${Math.round(y * 2) / 2}px,0)`
    let clipTop = 0
    if (v.under !== null) {
      const parent = views.get(v.under)
      const parentY = parent ? parent.y.x : (rowIndex.get(v.under) ?? 0) * h
      clipTop = Math.min(h, Math.max(0, parentY + h - y))
    }
    v.el.style.clipPath = clipTop > 0 ? `inset(${clipTop}px 0 0 0)` : ""
    v.el.style.opacity = clipTop > 0 ? String(Math.max(0, 1 - clipTop / h)) : ""
  }

  function frame(dt: number): boolean {
    let moving = false
    let bottom = rows.length * h
    for (const v of views.values()) {
      v.y.step(dt)
      if (!v.y.resting) moving = true
    }
    for (const v of [...views.values()]) {
      place(v)
      bottom = Math.max(bottom, v.y.x + h)
      if (v.y.resting) {
        if (v.leaving) dropView(v)
        else {
          v.under = null
          place(v)
        }
      }
    }
    setSpace(moving ? bottom : rows.length * h)
    trim()
    return moving
  }

  /** Drops views that are out of the window and at rest. */
  const trim = () => {
    const [start, end] = windowNow()
    const top = start * h
    const bottom = end * h
    for (const v of [...views.values()]) {
      if (pinned.has(v.id) || v.leaving) continue
      const i = rowIndex.get(v.id)
      if (i !== undefined && i >= start && i < end) continue
      // Out of the window: gone once it's at rest, or now if it's out of sight on its way.
      if (v.y.resting || v.y.x + h < top || v.y.x > bottom) dropView(v)
    }
  }

  const viewport = () => root.clientHeight || 400
  const windowNow = () => virtualWindow(root.scrollTop, viewport(), h, rows.length)
  const pinned = new Set<string>()

  /**
   * Brings views in line with `rows`: `"snap"` places everything; `"animate"` springs rows that
   * stay to their new places, reveals new ones from under their parent and folds removed ones
   * back under theirs; `"scroll"` only adds and drops rows at the window's edges. Rows opened or
   * shut under `toggled` move as one block with the rows below, like a drawer, so none cross.
   */
  function sync(mode: "snap" | "animate" | "scroll", toggled?: string) {
    const animate = mode !== "snap" && !reducedMotion(win)
    const [start, end] = windowNow()
    const wanted = new Set<string>()
    for (let i = start; i < end; i++) wanted.add(rows[i]!.id)
    for (const id of pinned) if (rowIndex.has(id)) wanted.add(id)
    const before = new Map(lastRows.map((r, i) => [r.id, i]))
    const shifts: [number, number][] = []
    // Rows already drawn go to their new places.
    for (const v of views.values()) {
      const i = rowIndex.get(v.id)
      if (i === undefined) continue
      if (mode !== "scroll") {
        if (animate) v.y.set(i * h)
        else v.y.snap(i * h)
        v.leaving = false
      }
      shifts.push([i, v.y.target - v.y.x])
    }
    const shiftNear = (i: number) => {
      let best = 0
      let dist = Number.POSITIVE_INFINITY
      for (const [j, s] of shifts)
        if (Math.abs(j - i) < dist) {
          dist = Math.abs(j - i)
          best = s
        }
      return best
    }
    const toggledView = toggled ? views.get(toggled) : undefined
    const drawer = (ids: Iterable<{ id: string }>, keep: (id: string) => boolean) => {
      let n = 0
      if (toggledView) for (const r of ids) if (keep(r.id) && isUnder(r.id, toggled!)) n++
      return n * h
    }
    const opened = mode === "animate" ? drawer(rows, (id) => !before.has(id)) : 0
    const shut = mode === "animate" ? drawer(lastRows, (id) => !rowIndex.has(id)) : 0
    for (const id of wanted) {
      const i = rowIndex.get(id)!
      const row = rows[i]!
      let v = views.get(id)
      if (!v) {
        v = makeView(id)
        const goal = i * h
        if (!animate) v.y.snap(goal)
        else {
          let from = goal - shiftNear(i)
          if (mode === "animate" && !before.has(id)) {
            // New: out from under the row that opened (the whole block slides down together), or
            // its nearest drawn ancestor.
            const under = toggledView && isUnder(id, toggled!) ? toggled! : nearestDrawn(id)
            const parent = under ? views.get(under) : undefined
            if (parent) {
              v.under = under
              from = under === toggled ? goal - opened + parent.y.x - parent.y.target : parent.y.x
            }
          }
          v.y.snap(from)
          v.y.set(goal)
        }
      }
      bind(v, row)
    }
    // Rows gone from the tree fold back under their nearest remaining ancestor.
    for (const v of [...views.values()]) {
      if (rowIndex.has(v.id)) continue
      if (!animate) {
        dropView(v)
        continue
      }
      if (mode === "scroll") continue
      const under = toggled && isUnder(v.id, toggled) ? toggled : nearestDrawn(v.id)
      const parent = under ? views.get(under) : undefined
      if (!parent) {
        dropView(v)
        continue
      }
      v.leaving = true
      v.under = under
      v.y.set(under === toggled ? v.y.target - shut : parent.y.target)
      v.el.removeAttribute("data-active")
      v.el.setAttribute("aria-selected", "false")
    }
    trim()
    let moving = false
    for (const v of views.values()) {
      place(v)
      if (!v.y.resting) moving = true
    }
    if (moving) loop.wake()
    else setSpace(rows.length * h)
    updateActiveDescendant()
  }

  const isUnder = (id: string, ancestor: string) => {
    for (let p = index.get(id)?.parent ?? null; p !== null; p = index.get(p)?.parent ?? null)
      if (p === ancestor) return true
    return false
  }
  const nearestDrawn = (id: string) => {
    for (let p = index.get(id)?.parent ?? null; p !== null; p = index.get(p)?.parent ?? null)
      if (views.has(p) && rowIndex.has(p)) return p
    return null
  }

  const updateActiveDescendant = () => {
    if (active && views.has(active)) root.setAttribute("aria-activedescendant", domId(active))
    else root.removeAttribute("aria-activedescendant")
  }

  const rebindAll = (force = false) => {
    for (const v of views.values()) {
      const i = rowIndex.get(v.id)
      if (i !== undefined && !v.leaving) bind(v, rows[i]!, force)
    }
    updateActiveDescendant()
  }

  const scrollToRow = (id: string) => {
    const i = rowIndex.get(id)
    if (i === undefined) return
    const top = i * h
    const vh = viewport()
    if (top < root.scrollTop) root.scrollTop = top
    else if (top + h > root.scrollTop + vh) root.scrollTop = top + h - vh
  }

  const setSelection = (next: Selection, primary: string | null, notify = true) => {
    sel = next
    selected = new Set(next.ids)
    if (primary !== null) active = primary
    rebindAll()
    if (notify) options.onSelect?.(next.ids, primary)
  }

  const setActive = (id: string | null) => {
    active = id
    if (id) {
      scrollToRow(id)
      sync("scroll")
    }
    rebindAll()
  }

  const toggle = (id: string, open: boolean, notify = true) => {
    const i = rowIndex.get(id)
    if (i === undefined || !rows[i]!.hasChildren || filter) {
      if (open) expanded.add(id)
      else expanded.delete(id)
      return
    }
    if (open === expanded.has(id)) return
    if (open) expanded.add(id)
    else expanded.delete(id)
    recompute()
    sync("animate", id)
    if (notify) options.onToggle?.(id, open)
  }

  // Pointer: select, open, drag.
  let press:
    | {
        id: string
        x: number
        y: number
        pointer: number
        deferred: boolean
        mods: { shift: boolean; toggle: boolean }
      }
    | undefined
  let dragging:
    | {
        ids: readonly string[]
        ghost: HTMLElement
        target?: DropTarget
        x: number
        y: number
        hoverAt: number
        hoverId: string | null
      }
    | undefined
  const rowAt = (target: EventTarget | null) =>
    (target as Element | null)?.closest?.<HTMLElement>(".knobs-tree-row") ?? null

  root.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return
    const el = rowAt(e.target)
    const id = el?.dataset.id
    if (!el || !id || !rowIndex.has(id) || views.get(id)?.leaving) return
    if ((e.target as Element).closest(".knobs-tree-edit")) return
    const toggleBtn = (e.target as Element).closest<HTMLElement>(".knobs-tree-toggle")
    if (toggleBtn) {
      e.preventDefault()
      return
    }
    e.preventDefault()
    root.focus({ preventScroll: true })
    delete root.dataset.keyboard
    if ((e.target as Element).closest(".knobs-tree-caret")) {
      const row = rows[rowIndex.get(id)!]!
      if (row.hasChildren) toggle(id, !row.expanded)
      setActive(id)
      return
    }
    const mods = { shift: e.shiftKey, toggle: e.metaKey || e.ctrlKey }
    const deferred = !mods.shift && !mods.toggle && isSelected(id)
    if (!deferred) setSelection(select(rows, sel, id, mods), id)
    else setActive(id)
    press = { id, x: e.clientX, y: e.clientY, pointer: e.pointerId, deferred, mods }
    root.setPointerCapture(e.pointerId)
  })
  root.addEventListener("pointermove", (e) => {
    if (root.dataset.keyboard !== undefined) delete root.dataset.keyboard
    if (!press || e.pointerId !== press.pointer) return
    if (!dragging) {
      if (!options.onMove || Math.hypot(e.clientX - press.x, e.clientY - press.y) < 4) return
      beginDrag(press.id)
    }
    if (dragging) {
      dragging.x = e.clientX
      dragging.y = e.clientY
      dragMove()
    }
  })
  const endPress = (e: PointerEvent, cancel = false) => {
    if (!press || e.pointerId !== press.pointer) return
    const p = press
    press = undefined
    if (dragging) return endDrag(cancel)
    if (p.deferred && !cancel) setSelection(select(rows, sel, p.id), p.id)
  }
  root.addEventListener("pointerup", (e) => endPress(e))
  root.addEventListener("pointercancel", (e) => endPress(e, true))
  root.addEventListener("lostpointercapture", (e) => endPress(e, true))
  root.addEventListener("click", (e) => {
    const b = (e.target as Element).closest<HTMLElement>(".knobs-tree-toggle")
    const id = rowAt(e.target)?.dataset.id
    if (!b || !id) return
    e.stopPropagation()
    const t = options.toggles?.find((x) => x.id === b.dataset.toggle)
    const row = rows[rowIndex.get(id) ?? -1]
    if (!t || !row) return
    const ids = isSelected(id) ? sel.ids : [id]
    t.set(ids, !t.get(row.item))
    rebindAll(true)
  })
  root.addEventListener("dblclick", (e) => {
    const id = rowAt(e.target)?.dataset.id
    if (
      !id ||
      (e.target as Element).closest(".knobs-tree-caret,.knobs-tree-toggle,.knobs-tree-edit")
    )
      return
    if (options.onActivate) options.onActivate(id)
    else {
      const row = rows[rowIndex.get(id) ?? -1]
      if (row?.hasChildren) toggle(id, !row.expanded)
    }
  })
  root.addEventListener("scroll", () => sync("scroll"), { passive: true })

  function beginDrag(id: string) {
    const ids = topmost(items, access, isSelected(id) ? sel.ids : [id])
    const ghost = doc.createElement("div")
    ghost.className = "knobs-ui knobs-tree-ghost"
    if (options.preset) ghost.dataset.preset = options.preset.name
    if (options.theme) ghost.dataset.theme = options.theme
    ghost.textContent =
      ids.length === 1
        ? (renamed.get(ids[0]!) ?? access.label(index.get(ids[0]!)!.item))
        : `${ids.length} items`
    doc.body.append(ghost)
    dragging = { ids, ghost, x: press!.x, y: press!.y, hoverAt: 0, hoverId: null }
    root.dataset.dragging = ""
    for (const d of ids) views.get(d)?.el.setAttribute("data-dragged", "")
    autoScroll.wake()
  }
  const draggedSet = () => new Set(dragging?.ids ?? [])
  function dragMove() {
    if (!dragging) return
    const d = dragging
    d.ghost.style.transform = `translate(${d.x + 12}px,${d.y + 10}px)`
    const rect = root.getBoundingClientRect()
    const localY = d.y - rect.top + root.scrollTop
    const over = Math.max(0, Math.min(rows.length - 1, Math.floor(localY / h)))
    const row = rows[over]
    let target: DropTarget | undefined
    if (row) {
      const fraction = Math.max(0, Math.min(1, localY / h - over))
      const zone = zoneAt(fraction, row.container && !draggedSet().has(row.id))
      const depth = Math.round((d.x - rect.left - Math.max(0, inset - 6) - 16) / indent)
      target =
        localY >= rows.length * h
          ? dropTarget(rows, access, rows.length - 1, "after", d.ids, depth)
          : dropTarget(rows, access, over, zone, d.ids, depth)
      if (
        target &&
        (!validMove(items, access, target.move) || options.canDrop?.(target.move) === false)
      )
        target = undefined
      // Resting over a closed parent opens it.
      const into = target?.into
      if (into && !expanded.has(into) && rows[rowIndex.get(into)!]?.hasChildren) {
        if (d.hoverId !== into) {
          d.hoverId = into
          d.hoverAt = performance.now()
        } else if (performance.now() - d.hoverAt > 650) toggle(into, true)
      } else d.hoverId = null
    }
    d.target = target
    for (const v of views.values()) {
      if (v.id === target?.into) v.el.dataset.drop = "into"
      else delete v.el.dataset.drop
    }
    if (target?.line) {
      line.toggleAttribute("data-shown", true)
      const y = (target.line.after + 1) * h
      line.style.transform = `translateY(${y}px)`
      line.style.left = `${Math.max(0, inset - 6) + 16 + target.line.depth * indent}px`
    } else line.removeAttribute("data-shown")
  }
  function endDrag(cancel: boolean) {
    const d = dragging
    if (!d) return
    dragging = undefined
    autoScroll.stop()
    d.ghost.remove()
    delete root.dataset.dragging
    line.removeAttribute("data-shown")
    for (const v of views.values()) {
      delete v.el.dataset.drop
      delete v.el.dataset.dragged
    }
    if (!cancel && d.target) options.onMove?.(d.target.move)
  }
  const autoScroll = frameLoop(win, () => {
    if (!dragging) return false
    const rect = root.getBoundingClientRect()
    const y = dragging.y
    let v = 0
    if (y < rect.top + EDGE) v = -Math.min(EDGE, rect.top + EDGE - y)
    else if (y > rect.bottom - EDGE) v = Math.min(EDGE, y - (rect.bottom - EDGE))
    if (v) {
      const before = root.scrollTop
      root.scrollTop += v * 0.6
      if (root.scrollTop !== before) dragMove()
    }
    if (dragging.hoverId) dragMove()
    return true
  })

  // Keys.
  let typed = ""
  let typedAt = 0
  root.addEventListener("keydown", (e) => {
    if ((e.target as Element).closest(".knobs-tree-edit")) return
    if (dragging) {
      if (e.key === "Escape") {
        e.preventDefault()
        e.stopPropagation()
        press = undefined
        endDrag(true)
      }
      return
    }
    root.dataset.keyboard = ""
    const nav = [
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "Home",
      "End",
      "PageUp",
      "PageDown",
    ]
    let handled = true
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      const ids = sel.ids.length ? sel.ids : active ? [active] : []
      const move = options.onMove
        ? stepMove(items, access, ids, e.key === "ArrowUp" ? -1 : 1)
        : undefined
      if (move && options.canDrop?.(move) !== false) options.onMove!(move)
    } else if (nav.includes(e.key) && !e.metaKey && !e.ctrlKey) {
      const page = Math.max(1, Math.floor(viewport() / h) - 1)
      const r = navigate(rows, active, e.key as NavKey, page)
      if (r.toggle) toggle(r.toggle.id, r.toggle.expanded)
      else if (r.active) {
        if (
          e.shiftKey &&
          (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "Home" || e.key === "End")
        )
          setSelection(
            select(rows, { ids: sel.ids, anchor: sel.anchor ?? active }, r.active, { shift: true }),
            r.active,
          )
        else setSelection(select(rows, sel, r.active), r.active)
        scrollToRow(r.active)
        sync("scroll")
      }
    } else if (e.key === " " && active) {
      setSelection(select(rows, sel, active, { toggle: e.metaKey || e.ctrlKey }), active)
    } else if ((e.key === "Enter" || e.key === "F2") && active) {
      if (options.onRename) startRename(active)
      else if (e.key === "Enter") options.onActivate?.(active)
      else handled = false
    } else if (e.key.toLowerCase() === "a" && (e.metaKey || e.ctrlKey)) {
      setSelection({ ids: rows.map((r) => r.id), anchor: active }, active)
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey && e.key !== " ") {
      const now = performance.now()
      typed = now - typedAt > 700 ? e.key : typed + e.key
      typedAt = now
      const next = typeahead(rows, active, typed, (item) => access.label(item))
      if (next && next !== active) {
        setSelection(select(rows, sel, next), next)
        scrollToRow(next)
        sync("scroll")
      }
    } else handled = false
    if (handled) {
      e.preventDefault()
      e.stopPropagation()
    }
  })
  root.addEventListener("focus", () => {
    if (!active && rows.length) {
      active = sel.ids.find((id) => rowIndex.has(id)) ?? rows[0]!.id
      rebindAll()
    }
  })

  // Renaming in place.
  let editing: { id: string; input: HTMLInputElement } | undefined
  function startRename(id: string) {
    if (!options.onRename || !rowIndex.has(id)) return
    finishRename(false)
    scrollToRow(id)
    pinned.add(id)
    sync("scroll")
    const v = views.get(id)
    if (!v) return
    const input = doc.createElement("input")
    input.className = "knobs-tree-edit"
    input.type = "text"
    input.spellcheck = false
    input.value = renamed.get(id) ?? access.label(index.get(id)!.item)
    input.setAttribute("aria-label", "Rename")
    v.label.append(input)
    v.el.dataset.editing = ""
    editing = { id, input }
    input.focus({ preventScroll: true })
    input.select()
    input.addEventListener("keydown", (e) => {
      e.stopPropagation()
      if (e.key === "Enter") {
        e.preventDefault()
        finishRename(true)
      } else if (e.key === "Escape") {
        e.preventDefault()
        finishRename(false)
      }
    })
    input.addEventListener("blur", () => finishRename(true, false))
    input.addEventListener("pointerdown", (e) => e.stopPropagation())
  }
  function finishRename(commit: boolean, refocus = true) {
    const ed = editing
    if (!ed) return
    editing = undefined
    const value = ed.input.value.trim()
    const v = views.get(ed.id)
    ed.input.remove()
    if (v) delete v.el.dataset.editing
    pinned.delete(ed.id)
    const before = index.get(ed.id) ? access.label(index.get(ed.id)!.item) : ""
    if (commit && value && value !== before) {
      renamed.set(ed.id, value)
      options.onRename?.(ed.id, value)
    }
    rebindAll()
    if (refocus) root.focus({ preventScroll: true })
  }

  const ro = new ResizeObserver(() => {
    const was = h
    measure()
    if (h !== was) {
      sync("snap")
      return
    }
    sync("scroll")
  })
  ro.observe(root)

  recompute()
  sync("snap")

  return {
    element: root,
    update(next) {
      items = next
      index = indexTree(items, access)
      renamed.clear()
      for (const id of [...expanded]) if (!index.has(id)) expanded.delete(id)
      const kept = sel.ids.filter((id) => index.has(id))
      if (kept.length !== sel.ids.length)
        setSelection({ ids: kept, anchor: sel.anchor }, null, false)
      recompute()
      if (active && !rowIndex.has(active)) active = null
      // Every row binds afresh: items may have changed in place.
      for (const v of views.values()) v.item = undefined
      sync("animate")
    },
    select(ids, primary) {
      const list = [...ids]
      setSelection({ ids: list, anchor: list[0] ?? null }, primary ?? list[0] ?? null, false)
      if (active) {
        scrollToRow(active)
        sync("scroll")
      }
    },
    get selection() {
      return sel.ids
    },
    get active() {
      return active
    },
    expand: (id, open = !expanded.has(id)) => toggle(id, open),
    isExpanded: (id) => expanded.has(id),
    filter(next) {
      filter = next
      recompute()
      if (active && !rowIndex.has(active)) active = rows[0]?.id ?? null
      sync("animate")
    },
    rows: () => rows.map((r) => r.id),
    focus(id) {
      if (id) setActive(id)
      root.focus({ preventScroll: true })
    },
    reveal(id) {
      let opened = false
      for (let p = index.get(id)?.parent ?? null; p !== null; p = index.get(p)?.parent ?? null)
        if (!expanded.has(p)) {
          expanded.add(p)
          opened = true
        }
      if (opened) {
        recompute()
        sync("animate")
      }
      scrollToRow(id)
      sync("scroll")
    },
    rename: (id) => startRename(id),
    refresh: () => rebindAll(true),
    dispose() {
      loop.stop()
      autoScroll.stop()
      ro.disconnect()
      dragging?.ghost.remove()
      root.remove()
    },
  }
}

function builtinIcon(id: string, on: boolean) {
  if (id === "visible") return on ? ICONS.eye : ICONS.eyeOff
  if (id === "locked") return on ? ICONS.unlock : ICONS.lock
  return on ? "●" : "○"
}
