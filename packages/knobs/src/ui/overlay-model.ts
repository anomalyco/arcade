// The overlays' pure parts: where a floating layer goes beside its anchor, and fuzzy matching
// for the command palette.

export interface Box {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}
export type Side = "top" | "bottom" | "left" | "right"
export type Placement = Side | `${Side}-start` | `${Side}-end`

export interface Placed {
  readonly x: number
  readonly y: number
  /** The placement after flipping. */
  readonly placement: Placement
  /** The anchor's nearest point, in the layer's own px: where it grows from. */
  readonly origin: { readonly x: number; readonly y: number }
}

const opposite: Record<Side, Side> = { top: "bottom", bottom: "top", left: "right", right: "left" }

/**
 * Places a `size` layer on `placement`'s side of `anchor`, `offset` px away: flipped to the
 * other side when it doesn't fit and that side has more room, then shifted along the side to stay
 * `margin` px inside `view`.
 */
export function place(o: {
  anchor: Box
  size: { readonly w: number; readonly h: number }
  view: Box
  placement?: Placement
  offset?: number
  margin?: number
}): Placed {
  const { anchor: a, size, view: v } = o
  const offset = o.offset ?? 6
  const margin = o.margin ?? 8
  const [want, align = "center"] = (o.placement ?? "bottom").split("-") as [
    Side,
    ("start" | "end")?,
  ]
  const room = (s: Side) =>
    s === "top"
      ? a.y - v.y
      : s === "bottom"
        ? v.y + v.h - (a.y + a.h)
        : s === "left"
          ? a.x - v.x
          : v.x + v.w - (a.x + a.w)
  const need = (s: Side) => (s === "top" || s === "bottom" ? size.h : size.w) + offset + margin
  let side = want
  if (room(want) < need(want) && room(opposite[want]) > room(want)) side = opposite[want]
  const vertical = side === "top" || side === "bottom"
  let x: number
  let y: number
  if (vertical) {
    y = side === "bottom" ? a.y + a.h + offset : a.y - offset - size.h
    x = align === "start" ? a.x : align === "end" ? a.x + a.w - size.w : a.x + (a.w - size.w) / 2
    x = clamp(x, v.x + margin, v.x + v.w - margin - size.w)
  } else {
    x = side === "right" ? a.x + a.w + offset : a.x - offset - size.w
    y = align === "start" ? a.y : align === "end" ? a.y + a.h - size.h : a.y + (a.h - size.h) / 2
    y = clamp(y, v.y + margin, v.y + v.h - margin - size.h)
  }
  // Grows from the anchor's centre along the edge it touches.
  const origin = vertical
    ? { x: clamp(a.x + a.w / 2 - x, 0, size.w), y: side === "bottom" ? 0 : size.h }
    : { x: side === "right" ? 0 : size.w, y: clamp(a.y + a.h / 2 - y, 0, size.h) }
  return {
    x: Math.round(x),
    y: Math.round(y),
    placement: (align === "center" ? side : `${side}-${align}`) as Placement,
    origin,
  }
}

const clamp = (v: number, lo: number, hi: number) => (hi < lo ? lo : Math.max(lo, Math.min(hi, v)))

export interface FuzzyMatch {
  readonly score: number
  /** The matched characters' indices in the text, ascending. */
  readonly indices: readonly number[]
}

const boundary = (text: string, i: number) => {
  if (i === 0) return true
  const prev = text[i - 1]!
  const ch = text[i]!
  if (/[\s\-_/.:·,()[\]]/.test(prev)) return true
  // camelCase and a digit run's start.
  return (
    (prev === prev.toLowerCase() && ch !== ch.toLowerCase()) || (/\d/.test(ch) && !/\d/.test(prev))
  )
}

/**
 * Matches `query`'s characters in order anywhere in `text` (case-insensitive), or null. The best
 * alignment wins: a match at the start, at word starts and in runs scores higher; gaps cost a
 * little. Spaces in the query are ignored.
 */
export function fuzzy(query: string, text: string): FuzzyMatch | null {
  const q = query.toLowerCase().replace(/\s+/g, "")
  if (!q) return { score: 0, indices: [] }
  const t = text.toLowerCase()
  const n = t.length
  const m = q.length
  if (m > n) return null
  // Quick reject: every character, in order.
  for (let i = 0, j = 0; i < m; i++, j++) {
    j = t.indexOf(q[i]!, j)
    if (j < 0) return null
  }
  const START = 12
  const WORD = 8
  const RUN = 6
  const GAP = 0.6
  const LEAD = 0.15
  const NONE = -1e9
  // best[i][j]: q[0..i] matched with q[i] at t[j]; from[i][j]: where q[i-1] sat.
  const best = new Float64Array(m * n).fill(NONE)
  const from = new Int32Array(m * n).fill(-1)
  const bonus = new Float64Array(n)
  for (let j = 0; j < n; j++) bonus[j] = j === 0 ? START : boundary(text, j) ? WORD : 0
  for (let j = 0; j < n; j++) if (t[j] === q[0]) best[j] = 1 + bonus[j]! - LEAD * j
  for (let i = 1; i < m; i++) {
    // The best earlier cell in row i-1, decayed by the gap to j.
    let carry = NONE
    let carryAt = -1
    for (let j = i; j < n; j++) {
      const prev = best[(i - 1) * n + j - 1]!
      if (carry - GAP > prev) {
        carry -= GAP
      } else {
        carry = prev
        carryAt = j - 1
      }
      if (t[j] !== q[i] || carry <= NONE / 2) continue
      const run = best[(i - 1) * n + j - 1]!
      const viaRun = run > NONE / 2 ? run + RUN : NONE
      const viaGap = carry
      const k = i * n + j
      if (viaRun >= viaGap) {
        best[k] = 1 + bonus[j]! + viaRun
        from[k] = j - 1
      } else {
        best[k] = 1 + bonus[j]! + viaGap
        from[k] = carryAt
      }
    }
  }
  let end = -1
  let score = NONE
  for (let j = m - 1; j < n; j++) {
    const s = best[(m - 1) * n + j]!
    if (s > score) {
      score = s
      end = j
    }
  }
  if (end < 0) return null
  const indices = new Array<number>(m)
  for (let i = m - 1, j = end; i >= 0; i--) {
    indices[i] = j
    j = from[i * n + j]!
  }
  // Shorter texts edge out longer ones on a tie.
  return { score: score - n * 0.01, indices }
}

export interface Rankable {
  readonly label: string
  readonly keywords?: readonly string[]
  readonly section?: string
}
export interface Ranked<T> {
  readonly item: T
  readonly score: number
  /** Indices in the label (empty when only a keyword or the section matched). */
  readonly indices: readonly number[]
}

/**
 * Items matching `query`, best first; a label match beats a keyword's or the section's. Matches
 * scattered thinly (letters strewn across words) are left out: a keyword or section must match
 * at word starts or in runs, a label at least loosely.
 */
export function rank<T extends Rankable>(items: readonly T[], query: string): Ranked<T>[] {
  const out: Ranked<T>[] = []
  const m = query.replace(/\s+/g, "").length
  items.forEach((item) => {
    const own = fuzzy(query, item.label)
    if (own && (m < 2 || own.score / m >= 2)) {
      out.push({ item, score: own.score, indices: own.indices })
      return
    }
    let alt: FuzzyMatch | null = null
    for (const k of [
      ...(item.keywords ?? []),
      ...(item.section ? [`${item.section} ${item.label}`] : []),
    ]) {
      const f = fuzzy(query, k)
      if (f && f.score / Math.max(1, m) >= 5 && (!alt || f.score > alt.score)) alt = f
    }
    if (alt) out.push({ item, score: alt.score - 6, indices: [] })
  })
  // Stable: equal scores keep their given order.
  return out
    .map((r, i) => [r, i] as const)
    .sort((a, b) => b[0].score - a[0].score || a[1] - b[1])
    .map(([r]) => r)
}

/** `text` split into runs at `indices`: `[{ text, hit }]`, for highlighting. */
export function marks(text: string, indices: readonly number[]) {
  const runs: { text: string; hit: boolean }[] = []
  const hit = new Set(indices)
  for (let i = 0; i < text.length; i++) {
    const on = hit.has(i)
    const last = runs[runs.length - 1]
    if (last && last.hit === on) last.text += text[i]
    else runs.push({ text: text[i]!, hit: on })
  }
  return runs
}
