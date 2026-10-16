// The bento's pure model: where every tile goes, which tile an arrow key reaches, and how much a
// moving tile blurs. Aspects are width / height throughout.

export interface BentoRect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/**
 * `fit`: everything on one screen in justified rows. `hero`: one screen, one tile large beside or
 * above the rest. `rows`: justified rows that scroll.
 */
export type BentoMode = "fit" | "hero" | "rows"

export interface BentoPlan {
  readonly mode: BentoMode
  /** One per item, in the items' order, in content coordinates. */
  readonly rects: readonly BentoRect[]
  readonly width: number
  /** The content's height: the view's in `fit` and `hero`, every row's in `rows`. */
  readonly height: number
  /** Tile area over the area it lays out in (the view for one screen, the content for rows). */
  readonly coverage: number
  /** The most any tile is cropped: its shown aspect over its own, less one (0: none). */
  readonly crop: number
  /** Group headings (`rows` with groups): the group, its top and the first item's index. */
  readonly headers: readonly {
    readonly group: string
    readonly y: number
    readonly index: number
  }[]
}

export interface BentoLayout {
  /** The view's size. */
  readonly width: number
  readonly height: number
  /** Between tiles (2). */
  readonly gap?: number
  /** Around the tiles (the gap). */
  readonly padding?: number
  /** How far a tile may be cropped to fill a row, as a fraction of its width (.08). */
  readonly tolerance?: number
  /** Scrolling rows' target height (about a third of the view, 120–420). */
  readonly rowHeight?: number
  /** Whether a few items may lay out on one screen (true). */
  readonly fit?: boolean
  /** The shortest a tile may be on one screen before the set scrolls instead (a sixth of the view, at least 80). */
  readonly minTile?: number
  /** One per item: items with the same group sit together under its heading (scrolling rows). */
  readonly groups?: readonly (string | undefined)[]
  /** Heading height for groups (28). */
  readonly header?: number
  /** An item that asks to be the hero; otherwise the first item becomes one when that shows more. */
  readonly hero?: number
}

/** Above this many items, sets scroll rather than fit one screen. */
export const FIT_MAX = 24

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x))
const sum = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0)

/** Scrolling rows' target height for a view. */
export const rowTarget = (width: number, height: number) =>
  clamp(Math.round(Math.min(height / 3, width / 2.6)), 120, 420)

interface Row {
  start: number
  end: number
  h: number
  /** Widths, one per item. */
  ws: number[]
}

/**
 * Greedy justified rows: items join a row until it would be shorter than `target`, and the row
 * ends at whichever count lands nearer the target. Every full row spans the width at its own
 * height, so nothing is cropped. A row only looks at items from its own start, so a change never
 * moves the rows before it. The last row spans the width when that leaves it no more than a
 * quarter taller than the target, or when cropping its tiles within `tol` fills it; otherwise it
 * stays at the target height, left-aligned.
 */
export function justify(
  aspects: readonly number[],
  start: number,
  end: number,
  width: number,
  target: number,
  gap: number,
  tol: number,
): Row[] {
  const rows: Row[] = []
  let i = start
  while (i < end) {
    let total = 0
    let j = i
    let h = Number.POSITIVE_INFINITY
    let closed = false
    while (j < end) {
      const k = j - i + 1
      const next = (width - (k - 1) * gap) / (total + aspects[j]!)
      if (next <= target) {
        if (k === 1 || Math.abs(Math.log(next / target)) <= Math.abs(Math.log(h / target))) {
          total += aspects[j]!
          j++
          h = next
        }
        closed = true
        break
      }
      total += aspects[j]!
      h = next
      j++
    }
    const slice = aspects.slice(i, j)
    if (closed || h <= target * 1.25) {
      rows.push({ start: i, end: j, h, ws: slice.map((a) => a * h) })
    } else {
      const free = width - (j - i - 1) * gap
      const f = free / (target * total)
      const ws = slice.map((a) => a * target * (f - 1 <= tol ? f : 1))
      rows.push({ start: i, end: j, h: target, ws })
    }
    i = j
  }
  return rows
}

/** Splits `xs` in order into `k` runs whose largest total is as small as possible. */
export function partition(xs: readonly number[], k: number): number[] {
  const n = xs.length
  k = clamp(k, 1, n)
  const prefix = [0]
  for (const x of xs) prefix.push(prefix.at(-1)! + x)
  const cost = Array.from({ length: k + 1 }, () => new Float64Array(n + 1).fill(Infinity))
  const cut = Array.from({ length: k + 1 }, () => new Int32Array(n + 1))
  cost[0]![0] = 0
  for (let j = 1; j <= k; j++)
    for (let i = j; i <= n; i++)
      for (let m = j - 1; m < i; m++) {
        const c = Math.max(cost[j - 1]![m]!, prefix[i]! - prefix[m]!)
        if (c < cost[j]![i]!) {
          cost[j]![i] = c
          cut[j]![i] = m
        }
      }
  const counts: number[] = []
  for (let j = k, i = n; j > 0; j--) {
    const m = cut[j]![i]!
    counts.unshift(i - m)
    i = m
  }
  return counts
}

interface Block {
  /** Relative to the block's top-left. */
  rects: BentoRect[]
  w: number
  h: number
  area: number
  crop: number
  minH: number
}

/**
 * The items as rows inside `w × h`: split into `r` rows of even width, each justified to the
 * full width, then all scaled down together if they're too tall. A block that came out narrower
 * than the box by no more than `tol` is cropped to the full width instead. Best of every `r`.
 */
function rowsBlock(
  aspects: readonly number[],
  w: number,
  h: number,
  gap: number,
  tol: number,
): Block | null {
  const n = aspects.length
  if (!n || w <= 0 || h <= 0) return null
  let best: Block | null = null
  const most = Math.min(n, Math.max(2, Math.ceil(Math.sqrt(n) * 2)))
  for (let r = 1; r <= most; r++) {
    const counts = partition(aspects, r)
    let at = 0
    const groups = counts.map((c) => aspects.slice(at, (at += c)))
    const heights = groups.map((g) => (w - (g.length - 1) * gap) / sum(g))
    const budget = h - (r - 1) * gap
    if (budget <= 0 || heights.some((x) => x <= 0)) break
    const s = Math.min(1, budget / sum(heights))
    const fill = s < 1 && 1 / s - 1 <= tol ? 1 / s : 1
    const rects: BentoRect[] = []
    let y = 0
    let blockW = 0
    groups.forEach((g, k) => {
      const rh = heights[k]! * s
      const rowW = sum(g.map((a) => a * rh * fill)) + (g.length - 1) * gap
      blockW = Math.max(blockW, rowW)
      let x = 0
      for (const a of g) {
        rects.push({ x, y, w: a * rh * fill, h: rh })
        x += a * rh * fill + gap
      }
      y += rh + gap
    })
    // Rows narrower than the block centre in it.
    let i = 0
    groups.forEach((g, k) => {
      const rowW = sum(g.map((a) => a * heights[k]! * s * fill)) + (g.length - 1) * gap
      const dx = (blockW - rowW) / 2
      for (let m = 0; m < g.length; m++, i++) {
        const q = rects[i]!
        rects[i] = { ...q, x: q.x + dx }
      }
    })
    const area = sum(rects.map((q) => q.w * q.h))
    const block: Block = {
      rects,
      w: blockW,
      h: y - gap,
      area,
      crop: fill - 1,
      minH: Math.min(...rects.map((q) => q.h)),
    }
    if (!best || block.area > best.area * 1.0001) best = block
  }
  return best
}

const offset = (rects: readonly BentoRect[], dx: number, dy: number) =>
  rects.map((q) => ({ x: q.x + dx, y: q.y + dy, w: q.w, h: q.h }))

/** One tile large on the left (or above) and the rest as rows beside it, at the best split. */
function heroBlock(
  aspects: readonly number[],
  hero: number,
  w: number,
  h: number,
  gap: number,
  tol: number,
): Block | null {
  const a = aspects[hero]!
  const rest = aspects.filter((_, i) => i !== hero)
  if (!rest.length) return null
  let best: Block | null = null
  const place = (
    heroRect: BentoRect,
    restBlock: Block | null,
    restAt: (b: Block) => [number, number],
    bw: number,
    bh: number,
  ) => {
    if (!restBlock) return
    const [rx, ry] = restAt(restBlock)
    const others = offset(restBlock.rects, rx, ry)
    const rects = [...others.slice(0, hero), heroRect, ...others.slice(hero)]
    const area = heroRect.w * heroRect.h + restBlock.area
    if (!best || area > best.area * 1.0001)
      best = { rects, w: bw, h: bh, area, crop: restBlock.crop, minH: restBlock.minH }
  }
  for (let f = 0.4; f <= 0.761; f += 0.04) {
    // Beside: the hero as tall as fits in a column f of the width.
    {
      const hw = Math.min(w * f, h * a)
      const hh = hw / a
      const block = rowsBlock(rest, w - hw - gap, h, gap, tol)
      if (block) {
        const bw = hw + gap + block.w
        const bh = Math.max(hh, block.h)
        place(
          { x: 0, y: (bh - hh) / 2, w: hw, h: hh },
          block,
          (b) => [hw + gap, (bh - b.h) / 2],
          bw,
          bh,
        )
      }
    }
    // Above: the hero as wide as fits in a band f of the height.
    {
      const hh = Math.min(h * f, w / a)
      const hw = hh * a
      const block = rowsBlock(rest, w, h - hh - gap, gap, tol)
      if (block) {
        const bw = Math.max(hw, block.w)
        place(
          { x: (bw - hw) / 2, y: 0, w: hw, h: hh },
          block,
          (b) => [(bw - b.w) / 2, hh + gap],
          bw,
          hh + gap + block.h,
        )
      }
    }
  }
  return best
}

/**
 * Plans the tiles for a view. A set of up to `FIT_MAX` items lays out on one screen when its
 * smallest tile stays at least `minTile` tall: as justified rows (the row count that shows the
 * most), or with a hero when one is asked for or the first item as a hero shows 4% more. Larger
 * sets, groups and narrow views scroll in greedy justified rows near `rowHeight`. Tiles keep their
 * own aspect except where a crop within `tolerance` fills a row.
 */
export function planBento(aspects: readonly number[], layout: BentoLayout): BentoPlan {
  const gap = layout.gap ?? 2
  const pad = layout.padding ?? gap
  const tol = layout.tolerance ?? 0.08
  const vw = Math.max(0, layout.width)
  const vh = Math.max(0, layout.height)
  const w = Math.max(1, vw - pad * 2)
  const h = Math.max(1, vh - pad * 2)
  const as = aspects.map((a) => (Number.isFinite(a) && a > 0 ? clamp(a, 0.05, 20) : 1))
  const empty: BentoPlan = {
    mode: "rows",
    rects: [],
    width: vw,
    height: 0,
    coverage: 0,
    crop: 0,
    headers: [],
  }
  if (!as.length || vw <= 0) return empty
  const grouped = layout.groups?.some((g) => g !== undefined) ?? false
  const minTile = layout.minTile ?? Math.max(80, vh / 6)

  if ((layout.fit ?? true) && !grouped && as.length <= FIT_MAX && vh > 0) {
    const rows = rowsBlock(as, w, h, gap, tol)
    let pick: { mode: BentoMode; block: Block } | null =
      rows && rows.minH >= minTile ? { mode: "fit", block: rows } : null
    const asked = layout.hero !== undefined && layout.hero >= 0 && layout.hero < as.length
    const hero = as.length > 2 ? heroBlock(as, asked ? layout.hero! : 0, w, h, gap, tol) : null
    if (hero && hero.minH >= minTile && (asked || !pick || hero.area > pick.block.area * 1.04))
      pick = { mode: "hero", block: hero }
    if (pick) {
      const { block } = pick
      const rects = offset(block.rects, pad + (w - block.w) / 2, pad + (h - block.h) / 2)
      return {
        mode: pick.mode,
        rects,
        width: vw,
        height: vh,
        coverage: block.area / (vw * vh),
        crop: block.crop,
        headers: [],
      }
    }
  }

  const target = layout.rowHeight ?? rowTarget(vw, vh)
  const header = layout.header ?? 28
  const rects: BentoRect[] = new Array(as.length)
  const headers: { group: string; y: number; index: number }[] = []
  let y = pad
  let crop = 0
  let area = 0
  let i = 0
  while (i < as.length) {
    const group = layout.groups?.[i]
    let end = i + 1
    while (end < as.length && layout.groups?.[end] === group) end++
    if (group !== undefined) {
      if (i > 0) y += header / 2
      headers.push({ group, y, index: i })
      y += header
    }
    for (const row of justify(as, i, end, w, target, gap, tol)) {
      let x = pad
      row.ws.forEach((rw, k) => {
        rects[row.start + k] = { x, y, w: rw, h: row.h }
        crop = Math.max(crop, rw / (as[row.start + k]! * row.h) - 1)
        area += rw * row.h
        x += rw + gap
      })
      y += row.h + gap
    }
    i = end
  }
  const height = y - gap + pad
  return { mode: "rows", rects, width: vw, height, coverage: area / (vw * height), crop, headers }
}

/** The indices whose rects meet `top…bottom`; `rows` plans are in reading order, so this bisects. */
export function windowOf(plan: BentoPlan, top: number, bottom: number): number[] {
  const { rects } = plan
  if (plan.mode !== "rows") return rects.map((_, i) => i)
  let lo = 0
  let hi = rects.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (rects[mid]!.y + rects[mid]!.h < top) lo = mid + 1
    else hi = mid
  }
  const out: number[] = []
  for (let i = lo; i < rects.length && rects[i]!.y <= bottom; i++) out.push(i)
  return out
}

export type BentoDirection = "left" | "right" | "up" | "down"

const overlapY = (a: BentoRect, b: BentoRect) =>
  Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) >= Math.min(a.h, b.h) * 0.5

/**
 * The tile an arrow reaches, by geometry. Left and right step along the row and wrap to the next
 * or previous item at its ends; up and down go to the nearest row that way and the tile there
 * whose centre is closest. Returns `from` when there's nowhere to go.
 */
export function neighbour(rects: readonly BentoRect[], from: number, dir: BentoDirection): number {
  const f = rects[from]
  if (!f) return from
  const fx = f.x + f.w / 2
  const fy = f.y + f.h / 2
  if (dir === "left" || dir === "right") {
    const right = dir === "right"
    let best = -1
    let bestD = Number.POSITIVE_INFINITY
    rects.forEach((r, i) => {
      if (i === from || !overlapY(f, r)) return
      const d = (r.x + r.w / 2 - fx) * (right ? 1 : -1)
      if (d > 1 && d < bestD) {
        bestD = d
        best = i
      }
    })
    if (best >= 0) return best
    return clamp(from + (right ? 1 : -1), 0, rects.length - 1)
  }
  const down = dir === "down"
  let edge = Number.POSITIVE_INFINITY
  for (const r of rects) {
    const d = (r.y + r.h / 2 - fy) * (down ? 1 : -1)
    if (d > f.h * 0.25 && !overlapY(f, r)) edge = Math.min(edge, down ? r.y : -(r.y + r.h))
  }
  if (!Number.isFinite(edge)) return from
  let best = from
  let bestD = Number.POSITIVE_INFINITY
  rects.forEach((r, i) => {
    const d = (r.y + r.h / 2 - fy) * (down ? 1 : -1)
    if (i === from || d <= f.h * 0.25 || overlapY(f, r)) return
    const near = down ? r.y - edge : -(r.y + r.h) - edge
    // Only the nearest row: tiles that start within half a tile of its edge.
    if (near > Math.min(r.h, f.h) * 0.5) return
    const dx = Math.abs(r.x + r.w / 2 - fx)
    if (dx < bestD) {
      bestD = dx
      best = i
    }
  })
  return best
}

/** `rect` fitted inside `w × h` at `aspect`, centred, `inset` from the edges. */
export function fitRect(aspect: number, w: number, h: number, inset = 0): BentoRect {
  const bw = Math.max(1, w - inset * 2)
  const bh = Math.max(1, h - inset * 2)
  const fw = Math.min(bw, bh * aspect)
  const fh = fw / aspect
  return { x: (w - fw) / 2, y: (h - fh) / 2, w: fw, h: fh }
}

/** Motion blur for a tile moving at `speed` px/s: rises with speed to `max`, 0 below a crawl. */
export function motionBlur(speed: number, max = 3, per = 1600) {
  const b = Math.min(max, Math.abs(speed) / per)
  return b < 0.25 ? 0 : Math.round(b * 4) / 4
}
