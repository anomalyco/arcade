// Split layout math, apart from the DOM: pane sizes from specs and saved state, divider drags,
// soft clamping and the saved layout's shape. Every size is in CSS pixels.

export type SplitDirection = "row" | "column"

export interface PaneSpec {
  readonly id: string
  /** Pixels. Panes without one share what the sized panes leave, by their last sizes. */
  readonly size?: number
  /** Pixels; 48 unless set. */
  readonly min?: number
  readonly max?: number
  /** Collapses to its rail (or header) from its divider, header or `collapse()`. */
  readonly collapsible?: boolean
  /** Starts collapsed (a saved layout wins). */
  readonly collapsed?: boolean
}

/** What a split saves and reports: each pane's size and whether it's collapsed. */
export interface SplitLayout {
  readonly sizes: Readonly<Record<string, number>>
  readonly collapsed: Readonly<Record<string, boolean>>
}

export const DEFAULT_MIN = 48
/** How far past its minimum a collapsible pane is dragged before it collapses. */
export const COLLAPSE_PAST = 40

export const paneMin = (p: PaneSpec) => Math.max(0, p.min ?? DEFAULT_MIN)
export const paneMax = (p: PaneSpec) => Math.max(paneMin(p), p.max ?? Number.POSITIVE_INFINITY)

/** Panes that fill: those without a `size`, or else the last one. */
export function flexible(panes: readonly PaneSpec[]): Set<string> {
  const free = panes.filter((p) => p.size === undefined).map((p) => p.id)
  if (free.length === 0 && panes.length > 0) free.push(panes[panes.length - 1]!.id)
  return new Set(free)
}

/**
 * Approaches a bound without passing it: 1:1 until `knee` px short of it, then easing in, so a
 * drag slows into its limit instead of stopping dead (and never bands past it).
 */
export function softClamp(x: number, min: number, max: number, knee = 12): number {
  if (max < min) return min
  const k = Math.min(knee, (max - min) / 2)
  if (k <= 0) return Math.min(max, Math.max(min, x))
  if (x > max - k) return max - k * Math.exp(-(x - (max - k)) / k)
  if (x < min + k) return min + k * Math.exp(-(min + k - x) / k)
  return x
}

export interface SolveInput {
  readonly panes: readonly PaneSpec[]
  /** Last sizes (px); flexible panes use theirs as shares. */
  readonly sizes: Readonly<Record<string, number>>
  readonly collapsed: Readonly<Record<string, boolean>>
  /** The container's length along the split, dividers included. */
  readonly total: number
  /** Room each divider takes. */
  readonly divider?: number
  /** A collapsed pane's length (its rail or header). */
  readonly rail?: (id: string) => number
  /** Sizes held exactly, whatever else is true (a pane mid-collapse). */
  readonly fixed?: Readonly<Record<string, number>>
}

/**
 * Lays panes out along the split. Sized panes keep their size (clamped to min and max) and
 * flexible ones share the rest by their last sizes; when there isn't room for every flexible
 * pane's minimum, sized panes give way, the largest first, down to their own minimums.
 */
export function solve(input: SolveInput): Record<string, number> {
  const { panes, sizes, collapsed, fixed = {} } = input
  const rail = input.rail ?? (() => 0)
  const room = Math.max(0, input.total - (input.divider ?? 1) * Math.max(0, panes.length - 1))
  const flex = flexible(panes)
  const out: Record<string, number> = {}
  const held = (p: PaneSpec) => fixed[p.id] !== undefined || collapsed[p.id]
  let used = 0
  for (const p of panes) {
    if (fixed[p.id] !== undefined) out[p.id] = Math.max(0, fixed[p.id]!)
    else if (collapsed[p.id]) out[p.id] = rail(p.id)
    else if (!flex.has(p.id))
      out[p.id] = Math.min(paneMax(p), Math.max(paneMin(p), sizes[p.id] ?? p.size ?? paneMin(p)))
    else continue
    used += out[p.id]!
  }
  const free = panes.filter((p) => flex.has(p.id) && !held(p))
  const needed = free.reduce((n, p) => n + paneMin(p), 0)
  // Sized panes give way to the flexible panes' minimums, largest first.
  let short = needed - (room - used)
  if (short > 0) {
    const sized = panes
      .filter((p) => !flex.has(p.id) && !held(p))
      .sort((a, b) => out[b.id]! - out[a.id]!)
    for (const p of sized) {
      if (short <= 0) break
      const give = Math.min(short, out[p.id]! - paneMin(p))
      out[p.id]! -= give
      used -= give
      short -= give
    }
  }
  distribute(free, room - used, sizes, out)
  // With every flexible pane collapsed, the last open pane takes up the slack.
  if (free.length === 0) {
    const last = [...panes].reverse().find((p) => !held(p))
    if (last) out[last.id] = Math.max(0, out[last.id]! + room - used)
  }
  return out
}

/** Shares `space` among `panes` by their last sizes, within each one's min and max. */
function distribute(
  panes: readonly PaneSpec[],
  space: number,
  sizes: Readonly<Record<string, number>>,
  out: Record<string, number>,
) {
  let open = [...panes]
  let left = Math.max(0, space)
  // Panes that hit a bound take it and leave the rest to the others.
  for (let pass = 0; pass < panes.length + 1 && open.length; pass++) {
    const weight = (p: PaneSpec) => Math.max(1, sizes[p.id] ?? p.size ?? 1)
    const total = open.reduce((n, p) => n + weight(p), 0)
    const bound = open.find((p) => {
      const share = (left * weight(p)) / total
      return share < paneMin(p) || share > paneMax(p)
    })
    if (!bound) {
      for (const p of open) out[p.id] = (left * weight(p)) / total
      return
    }
    const share = (left * weight(bound)) / total
    out[bound.id] = share < paneMin(bound) ? paneMin(bound) : paneMax(bound)
    left = Math.max(0, left - out[bound.id]!)
    open = open.filter((p) => p !== bound)
  }
  for (const p of open) out[p.id] = left / open.length
}

export interface DragResult {
  /** New sizes for the two panes beside the divider. */
  readonly sizes: Record<string, number>
  /** A collapsible pane dragged well past its minimum collapses; dragged back, it opens. */
  readonly collapse?: { readonly id: string; readonly collapsed: boolean }
}

/**
 * Moves the divider after pane `index` by `delta` px from where the drag began (`start` holds
 * every pane's size then). The panes on either side trade the distance, each slowing into its
 * own bounds.
 */
export function drag(
  panes: readonly PaneSpec[],
  start: Readonly<Record<string, number>>,
  index: number,
  delta: number,
  collapsed: Readonly<Record<string, boolean>> = {},
): DragResult {
  const a = panes[index]!
  const b = panes[index + 1]!
  const pair = start[a.id]! + start[b.id]!
  // The divider may travel as far as both panes' bounds allow.
  const lo = Math.max(paneMin(a), pair - paneMax(b))
  const hi = Math.min(paneMax(a), pair - paneMin(b))
  const raw = start[a.id]! + delta
  // Past a collapsible pane's minimum by COLLAPSE_PAST, it collapses (the pointer keeps going).
  for (const [pane, size] of [
    [a, raw],
    [b, pair - raw],
  ] as const) {
    if (!pane.collapsible) continue
    const was = Boolean(collapsed[pane.id])
    const now = size < paneMin(pane) - COLLAPSE_PAST
    if (now !== was) {
      const rest = Math.min(Math.max(lo, raw), hi)
      return {
        sizes: { [a.id]: rest, [b.id]: pair - rest },
        collapse: { id: pane.id, collapsed: now },
      }
    }
    if (now) return { sizes: { [a.id]: start[a.id]!, [b.id]: start[b.id]! } }
  }
  const next = softClamp(raw, lo, hi)
  return { sizes: { [a.id]: next, [b.id]: pair - next } }
}

/** Steps a divider by keys: the pane before it grows by `delta`, within both panes' bounds. */
export function nudge(
  panes: readonly PaneSpec[],
  sizes: Readonly<Record<string, number>>,
  index: number,
  delta: number,
): Record<string, number> {
  const a = panes[index]!
  const b = panes[index + 1]!
  const pair = sizes[a.id]! + sizes[b.id]!
  const lo = Math.max(paneMin(a), pair - paneMax(b))
  const hi = Math.min(paneMax(a), pair - paneMin(b))
  const next = Math.min(hi, Math.max(lo, sizes[a.id]! + delta))
  return { [a.id]: next, [b.id]: pair - next }
}

/**
 * Which pane a divider collapses (Enter, its button): the sized one beside it, else the
 * collapsible one, preferring the pane at the edge.
 */
export function collapsibleSide(panes: readonly PaneSpec[], index: number): string | undefined {
  const flex = flexible(panes)
  const pair = [panes[index]!, panes[index + 1]!].filter((p) => p.collapsible)
  const sized = pair.filter((p) => !flex.has(p.id))
  const pick = sized.length ? sized : pair
  if (pick.length === 2) return index === 0 ? pick[0]!.id : pick[1]!.id
  return pick[0]?.id
}

/**
 * Which edge a pane collapses toward: panes before the first flexible pane go to the start,
 * the rest to the end.
 */
export function edgeOf(panes: readonly PaneSpec[], id: string): "start" | "end" {
  const flex = flexible(panes)
  const first = panes.findIndex((p) => flex.has(p.id))
  return panes.findIndex((p) => p.id === id) < first ? "start" : "end"
}

/** A saved layout, kept only where it names known panes with sane values. */
export function parseLayout(raw: unknown, panes: readonly PaneSpec[]): SplitLayout | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const known = new Set(panes.map((p) => p.id))
  const sizes: Record<string, number> = {}
  const collapsed: Record<string, boolean> = {}
  const r = raw as { sizes?: Record<string, unknown>; collapsed?: Record<string, unknown> }
  for (const [id, v] of Object.entries(r.sizes ?? {}))
    if (known.has(id) && typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 100000)
      sizes[id] = v
  for (const [id, v] of Object.entries(r.collapsed ?? {}))
    if (known.has(id) && typeof v === "boolean") collapsed[id] = v
  return { sizes, collapsed }
}

/** A layout as saved: sizes rounded to a tenth of a pixel. */
export function serializeLayout(layout: SplitLayout): string {
  const sizes: Record<string, number> = {}
  for (const [id, v] of Object.entries(layout.sizes)) sizes[id] = Math.round(v * 10) / 10
  const collapsed: Record<string, boolean> = {}
  for (const [id, v] of Object.entries(layout.collapsed)) if (v) collapsed[id] = true
  return JSON.stringify({ sizes, collapsed })
}
