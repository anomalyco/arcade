// Outliner logic apart from the DOM: flattening with expansion and a filter, roving focus keys,
// type-ahead, selection, moves (drag and ⌥↑↓), drop targets and the virtual window.

/** How a tree reads your items. */
export interface TreeAccess<T> {
  id(item: T): string
  /** Children, or nothing for a leaf. An empty array is a parent with none (it takes drops). */
  children(item: T): readonly T[] | null | undefined
  label(item: T): string
}

export interface FlatRow<T> {
  readonly id: string
  readonly item: T
  readonly depth: number
  readonly parent: string | null
  /** Position among its parent's children (all of them, filtered or not). */
  readonly index: number
  readonly hasChildren: boolean
  /** Takes children (a drop "into" it). */
  readonly container: boolean
  readonly expanded: boolean
  /** Where the filter matched its label, if it did. */
  readonly match?: readonly [number, number]
  /** Shown only because something under it matched. */
  readonly ancestor?: boolean
}

export type TreeFilter<T> = string | ((item: T) => boolean) | null | undefined

/** Where the filter matches a label: a case-insensitive substring. */
export function matchLabel(label: string, query: string): readonly [number, number] | undefined {
  const q = query.trim().toLowerCase()
  if (!q) return undefined
  const at = label.toLowerCase().indexOf(q)
  return at < 0 ? undefined : [at, at + q.length]
}

/**
 * The rows on show, top to bottom: expanded parents' children follow them. With a filter, rows
 * that match show with every ancestor (opened while it runs, marked `ancestor` when they don't
 * match themselves).
 */
export function flatten<T>(
  roots: readonly T[],
  access: TreeAccess<T>,
  expanded: ReadonlySet<string>,
  filter?: TreeFilter<T>,
): FlatRow<T>[] {
  const out: FlatRow<T>[] = []
  const query = typeof filter === "string" ? filter.trim() : ""
  const test =
    typeof filter === "function"
      ? filter
      : query
        ? (item: T) => matchLabel(access.label(item), query) !== undefined
        : undefined
  // With a filter, which items have a match at or under them.
  const keep = new Map<T, boolean>()
  const kept = (item: T): boolean => {
    const known = keep.get(item)
    if (known !== undefined) return known
    let k = test!(item)
    for (const c of access.children(item) ?? []) if (kept(c)) k = true
    keep.set(item, k)
    return k
  }
  const walk = (items: readonly T[], depth: number, parent: string | null) => {
    items.forEach((item, index) => {
      if (test && !kept(item)) return
      const kids = access.children(item)
      const id = access.id(item)
      const self = test ? test(item) : true
      const hasChildren = Boolean(kids?.length) && (!test || kids!.some(kept))
      const open = hasChildren && (test ? true : expanded.has(id))
      const match = query ? matchLabel(access.label(item), query) : undefined
      out.push({
        id,
        item,
        depth,
        parent,
        index,
        hasChildren,
        container: kids != null,
        expanded: open,
        ...(match ? { match } : {}),
        ...(test && !self ? { ancestor: true } : {}),
      })
      if (open) walk(kids!, depth + 1, id)
    })
  }
  walk(roots, 0, null)
  return out
}

/** Every item by id, with its parent and position. */
export function indexTree<T>(
  roots: readonly T[],
  access: TreeAccess<T>,
): Map<string, { item: T; parent: string | null; index: number; depth: number }> {
  const out = new Map<string, { item: T; parent: string | null; index: number; depth: number }>()
  const walk = (items: readonly T[], parent: string | null, depth: number) =>
    items.forEach((item, index) => {
      const id = access.id(item)
      out.set(id, { item, parent, index, depth })
      walk(access.children(item) ?? [], id, depth + 1)
    })
  walk(roots, null, 0)
  return out
}

/** The ids of an item's ancestors, nearest first. */
export function ancestors(
  index: ReadonlyMap<string, { parent: string | null }>,
  id: string,
): string[] {
  const out: string[] = []
  for (let p = index.get(id)?.parent ?? null; p !== null; p = index.get(p)?.parent ?? null)
    out.push(p)
  return out
}

export type NavKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "Home" | "End"
export interface NavResult {
  readonly active: string | null
  /** Open or close a parent instead of moving. */
  readonly toggle?: { readonly id: string; readonly expanded: boolean }
}

/** Roving focus: ↑↓ move, ← closes or goes to the parent, → opens or goes to the first child. */
export function navigate<T>(
  rows: readonly FlatRow<T>[],
  active: string | null,
  key: NavKey | "PageUp" | "PageDown",
  page = 10,
): NavResult {
  if (rows.length === 0) return { active: null }
  const i = active === null ? -1 : rows.findIndex((r) => r.id === active)
  const at = (n: number) => rows[Math.min(rows.length - 1, Math.max(0, n))]!.id
  if (i < 0) return { active: key === "End" || key === "ArrowUp" ? at(rows.length - 1) : at(0) }
  const row = rows[i]!
  switch (key) {
    case "ArrowDown":
      return { active: at(i + 1) }
    case "ArrowUp":
      return { active: at(i - 1) }
    case "PageDown":
      return { active: at(i + page) }
    case "PageUp":
      return { active: at(i - page) }
    case "Home":
      return { active: at(0) }
    case "End":
      return { active: at(rows.length - 1) }
    case "ArrowLeft":
      if (row.hasChildren && row.expanded)
        return { active: row.id, toggle: { id: row.id, expanded: false } }
      return { active: row.parent ?? row.id }
    case "ArrowRight":
      if (row.hasChildren && !row.expanded)
        return { active: row.id, toggle: { id: row.id, expanded: true } }
      if (row.hasChildren) return { active: rows[i + 1]?.id ?? row.id }
      return { active: row.id }
  }
}

/**
 * Type-ahead: the next row whose label starts with what's been typed, after the active one (or
 * from it, once the word is longer than a letter, so typing on refines in place).
 */
export function typeahead<T>(
  rows: readonly FlatRow<T>[],
  active: string | null,
  typed: string,
  label: (item: T) => string,
): string | null {
  const q = typed.toLowerCase()
  if (!q || rows.length === 0) return active
  const i = Math.max(
    0,
    rows.findIndex((r) => r.id === active),
  )
  // Repeating one letter cycles through the rows that start with it.
  const same = q.length > 1 && [...q].every((c) => c === q[0])
  const word = same ? q[0]! : q
  const from = q.length > 1 && !same ? i : i + 1
  for (let k = 0; k < rows.length; k++) {
    const row = rows[(from + k) % rows.length]!
    if (label(row.item).toLowerCase().startsWith(word)) return row.id
  }
  return active
}

export interface Selection {
  readonly ids: readonly string[]
  readonly anchor: string | null
}

/**
 * A click or keyboard selection: plain picks one, ⌘/Ctrl adds or removes, ⇧ takes the range from
 * the anchor in the order shown (⇧⌘ adds it to what's there).
 */
export function select<T>(
  rows: readonly FlatRow<T>[],
  current: Selection,
  id: string,
  mods: { readonly shift?: boolean; readonly toggle?: boolean } = {},
): Selection {
  if (mods.shift && current.anchor !== null) {
    const a = rows.findIndex((r) => r.id === current.anchor)
    const b = rows.findIndex((r) => r.id === id)
    if (a >= 0 && b >= 0) {
      const [lo, hi] = a < b ? [a, b] : [b, a]
      const range = rows.slice(lo, hi + 1).map((r) => r.id)
      const ids = mods.toggle ? [...new Set([...current.ids, ...range])] : range
      return { ids, anchor: current.anchor }
    }
  }
  if (mods.toggle) {
    const has = current.ids.includes(id)
    return { ids: has ? current.ids.filter((x) => x !== id) : [...current.ids, id], anchor: id }
  }
  return { ids: [id], anchor: id }
}

/** The topmost of `ids`: none whose ancestor is also among them, in tree order. */
export function topmost<T>(roots: readonly T[], access: TreeAccess<T>, ids: Iterable<string>) {
  const set = new Set(ids)
  const index = indexTree(roots, access)
  const out: string[] = []
  const walk = (items: readonly T[]) => {
    for (const item of items) {
      const id = access.id(item)
      if (set.has(id)) out.push(id)
      else walk(access.children(item) ?? [])
    }
  }
  walk(roots)
  return out.filter((id) => index.has(id))
}

/**
 * A move: take `ids` out (with their subtrees), then insert them in order at `index` among
 * `parent`'s remaining children (`null` is the top level).
 */
export interface TreeMove {
  readonly ids: readonly string[]
  readonly parent: string | null
  readonly index: number
}

/** Whether a move keeps the tree a tree: nothing goes inside itself. */
export function validMove<T>(roots: readonly T[], access: TreeAccess<T>, move: TreeMove): boolean {
  if (move.parent === null) return true
  const index = indexTree(roots, access)
  if (!index.has(move.parent)) return false
  const above = new Set([move.parent, ...ancestors(index, move.parent)])
  return !move.ids.some((id) => above.has(id))
}

/** The tree's defaults: `item.id`, `item.children`, and `item.label` or the id. */
export const plainAccess: TreeAccess<{
  readonly id: string
  readonly label?: string
  readonly children?: readonly unknown[] | null
}> = {
  id: (item) => item.id,
  children: (item) => item.children as never,
  label: (item) => item.label ?? item.id,
}

/**
 * Applies a move to plain `{ id, children }` items (or any, through `access`), returning new
 * arrays along the changed paths (items themselves are copied only where their children change).
 * `make(item, children)` builds a parent with new children; the default spreads the item.
 */
export function applyMove<T extends { readonly id: string }>(
  roots: readonly T[],
  move: TreeMove,
): T[]
export function applyMove<T>(
  roots: readonly T[],
  access: TreeAccess<T>,
  move: TreeMove,
  make?: (item: T, children: T[]) => T,
): T[]
export function applyMove<T>(
  roots: readonly T[],
  accessOrMove: TreeAccess<T> | TreeMove,
  maybeMove?: TreeMove,
  make: (item: T, children: T[]) => T = (item, children) => ({ ...item, children }) as T,
): T[] {
  const plain = "ids" in accessOrMove
  const access = plain ? (plainAccess as unknown as TreeAccess<T>) : accessOrMove
  const move = plain ? accessOrMove : maybeMove!
  if (!validMove(roots, access, move)) return [...roots]
  const moving = new Set(move.ids)
  const taken = new Map<string, T>()
  const strip = (items: readonly T[]): T[] => {
    const out: T[] = []
    let changed = false
    for (const item of items) {
      const id = access.id(item)
      if (moving.has(id)) {
        taken.set(id, item)
        changed = true
        continue
      }
      const kids = access.children(item)
      if (kids) {
        const next = strip(kids)
        if (next !== kids) {
          out.push(make(item, next))
          changed = true
          continue
        }
      }
      out.push(item)
    }
    return changed ? out : (items as T[])
  }
  const rest = strip(roots)
  const insert = move.ids.map((id) => taken.get(id)).filter((x): x is T => x !== undefined)
  const place = (items: T[]) => {
    const at = Math.max(0, Math.min(items.length, move.index))
    return [...items.slice(0, at), ...insert, ...items.slice(at)]
  }
  if (move.parent === null) return place([...rest])
  const into = (items: readonly T[]): T[] =>
    items.map((item) => {
      if (access.id(item) === move.parent)
        return make(item, place([...(access.children(item) ?? [])]))
      const kids = access.children(item)
      if (!kids?.length) return item
      const next = into(kids)
      return next.some((x, i) => x !== kids[i]) ? make(item, next) : item
    })
  return into(rest)
}

/**
 * ⌥↑/⌥↓: the selected rows step past their neighbour among their siblings. Rows under different
 * parents move with the first one's parent; at an end they stay.
 */
export function stepMove<T>(
  roots: readonly T[],
  access: TreeAccess<T>,
  ids: readonly string[],
  dir: -1 | 1,
): TreeMove | undefined {
  const top = topmost(roots, access, ids)
  if (!top.length) return undefined
  const index = indexTree(roots, access)
  const parent = index.get(top[0]!)!.parent
  const group = top.filter((id) => index.get(id)!.parent === parent)
  const siblings = parent === null ? roots : (access.children(index.get(parent)!.item) ?? [])
  const at = group.map((id) => index.get(id)!.index).sort((a, b) => a - b)
  const first = at[0]!
  const last = at[at.length - 1]!
  if (dir < 0 ? first === 0 : last === siblings.length - 1) return undefined
  // Index among the siblings once the group is out.
  const before = dir < 0 ? first - 1 : last + 2 - group.length
  return { ids: group, parent, index: before }
}

export type DropZone = "before" | "after" | "into"

export interface DropTarget {
  readonly move: TreeMove
  /** Draw a line after row `line` (−1: above the first row) at `depth`… */
  readonly line?: { readonly after: number; readonly depth: number }
  /** …or wash the row a drop goes into. */
  readonly into?: string
}

/** Which zone of a row the pointer is over (0–1 down the row): parents take a middle band. */
export function zoneAt(fraction: number, container: boolean): DropZone {
  if (!container) return fraction < 0.5 ? "before" : "after"
  return fraction < 0.25 ? "before" : fraction > 0.75 ? "after" : "into"
}

/**
 * Where a drop lands. Over the top of a row it goes before it; over the middle of a parent, into
 * it (at the end); over the bottom, after it, or first inside it when it's open. Below the last
 * row of a branch, `depth` (from the pointer's x) picks how far out it goes.
 */
export function dropTarget<T>(
  rows: readonly FlatRow<T>[],
  access: TreeAccess<T>,
  over: number,
  zone: DropZone,
  ids: readonly string[],
  depth?: number,
): DropTarget | undefined {
  if (rows.length === 0)
    return { move: { ids, parent: null, index: 0 }, line: { after: -1, depth: 0 } }
  const i = Math.max(0, Math.min(rows.length - 1, over))
  const row = rows[i]!
  const moving = new Set(ids)
  // Children index among the parent's children once the moving rows are out.
  const slot = (parent: string | null, before: number) => {
    let n = before
    for (const r of rows) if (r.parent === parent && r.index < before && moving.has(r.id)) n--
    return n
  }
  if (zone === "into") {
    if (!row.container) return dropTarget(rows, access, i, "after", ids, depth)
    const kids = access.children(row.item) ?? []
    const index = kids.filter((k) => !moving.has(access.id(k))).length
    return { move: { ids, parent: row.id, index }, into: row.id }
  }
  if (zone === "before")
    return {
      move: { ids, parent: row.parent, index: slot(row.parent, row.index) },
      line: { after: i - 1, depth: row.depth },
    }
  if (row.hasChildren && row.expanded)
    return {
      move: { ids, parent: row.id, index: slot(row.id, 0) },
      line: { after: i, depth: row.depth + 1 },
    }
  // After the last row of one or more branches: the pointer's depth picks the level.
  const next = rows[i + 1]
  const shallowest = next ? next.depth : 0
  const want = Math.max(shallowest, Math.min(row.depth, depth ?? row.depth))
  let target: FlatRow<T> = row
  for (let k = i; k >= 0 && target.depth > want; k--) if (rows[k]!.depth === want) target = rows[k]!
  if (target.depth !== want) target = row
  return {
    move: { ids, parent: target.parent, index: slot(target.parent, target.index + 1) },
    line: { after: i, depth: target.depth },
  }
}

/** The rows a scroller of `height` at `scrollTop` shows, with `overscan` either side. */
export function virtualWindow(
  scrollTop: number,
  height: number,
  rowHeight: number,
  count: number,
  overscan = 6,
): readonly [number, number] {
  if (count === 0 || rowHeight <= 0) return [0, 0]
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan)
  const end = Math.min(count, Math.ceil((scrollTop + height) / rowHeight) + overscan)
  return [start, Math.max(start, end)]
}
