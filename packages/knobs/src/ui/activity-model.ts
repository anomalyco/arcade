// The activity rail's logic apart from the DOM: groups flattened into rows, the keys that move
// the selection, when the selection shows (only after keys), what changed between two sets of
// events, where rows stack and where the line runs between the nodes.

/** The built-in kinds, each with its icon and tint. */
export type ActivityKind =
  | "you"
  | "agent"
  | "proposal"
  | "review"
  | "pr"
  | "build"
  | "blocked"
  | "shipped"

export interface ActivityEvent {
  /** Unique, and the same across `set()`: rows keep their identity and glide. */
  readonly id: string
  /** A built-in kind (its icon and tint), or a name of your own with `icon` and `tint`. */
  readonly kind?: ActivityKind | (string & {})
  /** Who: "You", "Agent", "Ryan". */
  readonly actor?: string
  /** One line; it fades at its end when cut off. A group without one says "3 updates". */
  readonly title?: string
  /** Trailing, already formatted ("2m", "9:41"); it rolls when it changes. */
  readonly time?: string
  /** A duration chip, "▶ 0:32": seconds, or text as it should read. */
  readonly duration?: number | string
  /** Small thumbnails before the time (image URLs; four at most show). */
  readonly thumbs?: readonly string[]
  /** SVG markup, a glyph or a node in place of the kind's icon. */
  readonly icon?: string | Node
  /** A CSS colour in place of the kind's tint. */
  readonly tint?: string
  /** Makes a group that opens in place ("Agent · 3 updates"). One level deep. */
  readonly children?: readonly ActivityEvent[]
  /** The live or latest step: its node takes a ring. */
  readonly current?: boolean
  /** Quieter: past steps, minor updates. */
  readonly dimmed?: boolean
}

export interface ActivityRow {
  readonly id: string
  readonly event: ActivityEvent
  /** 0 for an event, 1 for one inside an open group. */
  readonly depth: 0 | 1
  readonly parent: string | null
  /** Has children: it opens and closes. */
  readonly group: boolean
  readonly expanded: boolean
}

/** The rows on show: every event, and the children of open groups right after their group. */
export function flattenActivity(
  events: readonly ActivityEvent[],
  expanded: ReadonlySet<string>,
): ActivityRow[] {
  const rows: ActivityRow[] = []
  for (const event of events) {
    const kids = event.children ?? []
    const group = kids.length > 0
    const open = group && expanded.has(event.id)
    rows.push({ id: event.id, event, depth: 0, parent: null, group, expanded: open })
    if (open)
      for (const child of flatChildren(kids))
        rows.push({
          id: child.id,
          event: child,
          depth: 1,
          parent: event.id,
          group: false,
          expanded: false,
        })
  }
  return rows
}

/** Groups are one level deep: a child's own children follow it on the same level. */
function flatChildren(events: readonly ActivityEvent[]): ActivityEvent[] {
  const out: ActivityEvent[] = []
  for (const e of events) {
    out.push(e)
    if (e.children?.length) out.push(...flatChildren(e.children))
  }
  return out
}

/** Every event by id, children included, with its group. */
export function indexActivity(
  events: readonly ActivityEvent[],
): Map<string, { event: ActivityEvent; parent: string | null }> {
  const index = new Map<string, { event: ActivityEvent; parent: string | null }>()
  for (const event of events) {
    index.set(event.id, { event, parent: null })
    for (const child of flatChildren(event.children ?? []))
      index.set(child.id, { event: child, parent: event.id })
  }
  return index
}

export type ActivityKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "Home" | "End"

export const isActivityKey = (key: string): key is ActivityKey =>
  key === "ArrowUp" ||
  key === "ArrowDown" ||
  key === "ArrowLeft" ||
  key === "ArrowRight" ||
  key === "Home" ||
  key === "End"

/**
 * What a key does from the selected row: ↑/↓ move (from nothing, to the first or the last),
 * Home/End go to the ends, → opens a closed group and steps into an open one, ← closes an open
 * group and steps out of a child to its group.
 */
export function navigateActivity(
  rows: readonly ActivityRow[],
  selected: string | null,
  key: ActivityKey,
): { select?: string; toggle?: { id: string; expanded: boolean } } {
  if (!rows.length) return {}
  const i = selected === null ? -1 : rows.findIndex((r) => r.id === selected)
  const row = i >= 0 ? rows[i]! : undefined
  switch (key) {
    case "ArrowDown":
      return { select: rows[i < 0 ? 0 : Math.min(rows.length - 1, i + 1)]!.id }
    case "ArrowUp":
      return { select: rows[i < 0 ? rows.length - 1 : Math.max(0, i - 1)]!.id }
    case "Home":
      return { select: rows[0]!.id }
    case "End":
      return { select: rows[rows.length - 1]!.id }
    case "ArrowRight":
      if (!row?.group) return {}
      if (!row.expanded) return { toggle: { id: row.id, expanded: true } }
      return rows[i + 1]?.parent === row.id ? { select: rows[i + 1]!.id } : {}
    case "ArrowLeft":
      if (!row) return {}
      if (row.group && row.expanded) return { toggle: { id: row.id, expanded: false } }
      return row.parent !== null ? { select: row.parent } : {}
  }
}

/**
 * Where the selection goes when its row leaves the rows on show: to its group when that closed
 * over it, else nowhere.
 */
export function keepSelection(
  rows: readonly ActivityRow[],
  selected: string | null,
  parentOf: (id: string) => string | null | undefined,
): string | null {
  if (selected === null) return null
  if (rows.some((r) => r.id === selected)) return selected
  const parent = parentOf(selected)
  return parent && rows.some((r) => r.id === parent) ? parent : null
}

/** What last moved the selection: keys show it as a tint, a pointer hides it. */
export type ActivityInput = "key" | "pointer" | "blur" | "code"

/**
 * Whether the selection's tint shows: keys turn it on, a pointer turns it off (a click selects
 * with no ring), losing focus turns it off unless the page's keys drive it, and a host's
 * `select()` leaves it as it was.
 */
export function showsSelection(
  showing: boolean,
  input: ActivityInput,
  keys: "focus" | "page" = "focus",
): boolean {
  if (input === "key") return true
  if (input === "pointer") return false
  if (input === "blur") return keys === "page" ? showing : false
  return showing
}

/** Which ids came, went and stayed between two orders of rows. */
export function diffActivity(
  before: readonly string[],
  after: readonly string[],
): { entered: string[]; left: string[]; kept: string[] } {
  const was = new Set(before)
  const now = new Set(after)
  return {
    entered: after.filter((id) => !was.has(id)),
    left: before.filter((id) => !now.has(id)),
    kept: after.filter((id) => was.has(id)),
  }
}

/** Rows stacked top to bottom from `top`: each one's y, and the bottom of the last. */
export function stackRows(
  heights: readonly number[],
  top = 0,
  gap = 0,
): { y: number[]; bottom: number } {
  const y: number[] = []
  let at = top
  heights.forEach((h, i) => {
    y.push(at)
    at += h + (i < heights.length - 1 ? gap : 0)
  })
  return { y, bottom: at }
}

export interface RailNode {
  /** The node's centre. */
  readonly y: number
  /** How far the line keeps clear of it on each side. */
  readonly r: number
}

/**
 * The line through the nodes, as segments between neighbours that stop clear of each node, and
 * only within `[from, to]` (the line's ends, which glide as rows come and go). One continuous
 * thread at rest: nothing past the last node, nothing before the first.
 */
export function railSegments(
  nodes: readonly RailNode[],
  from: number,
  to: number,
): [number, number][] {
  const sorted = [...nodes].sort((a, b) => a.y - b.y)
  const out: [number, number][] = []
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]!
    const b = sorted[i + 1]!
    const top = Math.max(from, a.y + a.r)
    const bottom = Math.min(to, b.y - b.r)
    if (bottom - top > 0.25) out.push([top, bottom])
  }
  return out
}

/** "0:32", "4:05", "1:02:03"; text passes through as it is. */
export function formatDuration(duration: number | string): string {
  if (typeof duration === "string") return duration
  const s = Math.max(0, Math.round(duration))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, "0")
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`
}

/** A group's title when it has none of its own: "1 update", "3 updates". */
export function groupTitle(count: number): string {
  return `${count} update${count === 1 ? "" : "s"}`
}
