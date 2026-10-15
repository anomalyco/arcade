// Readouts as numbers and shapes: formatting, the scale a history is drawn on, and each graphic
// as a short list of drawing ops in local px. The DOM paints the ops on a 2D canvas and the GPU
// overlay paints the same ops, so both renderers draw the same picture.
import { Spring } from "../core/spring.js"
import type { Ring } from "../core/readout.js"
import { mixRgba, type Rgba, withAlpha } from "./rgba.js"

export type PlotOp =
  | {
      readonly t: "line"
      readonly pts: readonly number[]
      readonly color: Rgba
      readonly width: number
    }
  /** The area between a line and `base` (a y), fading to `fade` × its alpha at the base. */
  | {
      readonly t: "area"
      readonly pts: readonly number[]
      readonly base: number
      readonly color: Rgba
      readonly fade: number
    }
  | {
      readonly t: "rect"
      readonly x: number
      readonly y: number
      readonly w: number
      readonly h: number
      readonly color: Rgba
      readonly r?: number
    }
  | {
      readonly t: "dot"
      readonly x: number
      readonly y: number
      readonly r: number
      readonly color: Rgba
    }

/** The colours readouts draw with, read from the tokens. */
export interface Palette {
  readonly accent: Rgba
  readonly text: Rgba
  readonly label: Rgba
  readonly dim: Rgba
  readonly line: Rgba
  readonly surfaceHi: Rgba
  readonly warn: Rgba
  readonly critical: Rgba
  /** Corner radius (px); 0 squares the bars. */
  readonly radius: number
}

/** Series colours after the first (the accent). */
export const SERIES = ["#5ac8fa", "#ff9f0a", "#bf5af2", "#30d158", "#ff6482"]

/** A number as text: `decimals` places, else fewer as it grows (2 under 10, 1 under 100, 0 past). */
export function formatNumber(v: number, decimals?: number): string {
  if (!Number.isFinite(v)) return "—"
  const a = Math.abs(v)
  const d = decimals ?? (a >= 100 ? 0 : a >= 10 ? 1 : 2)
  const s = v.toFixed(d)
  return /^-0(\.0*)?$/.test(s) ? s.slice(1) : s
}

/** A step of 1, 2 or 5 × 10ⁿ near `span / 4`: a scale snaps to these, so it moves rarely. */
export function niceStep(span: number) {
  if (!(span > 0)) return 1
  const raw = span / 4
  const p = 10 ** Math.floor(Math.log10(raw))
  const m = raw / p
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p
}

/**
 * The range a history is drawn on: its samples' extent (and `keep`, such as thresholds), snapped
 * out to a nice step, with fixed bounds where given. A flat history gets room around it.
 */
export function fitRange(
  lo: number,
  hi: number,
  fixed: { min?: number; max?: number } = {},
  keep: readonly number[] = [],
): [number, number] {
  let a = Number.isFinite(lo) ? lo : 0
  let b = Number.isFinite(hi) ? hi : 1
  for (const k of keep) {
    a = Math.min(a, k)
    b = Math.max(b, k)
  }
  if (fixed.min !== undefined) a = fixed.min
  if (fixed.max !== undefined) b = fixed.max
  if (b - a < 1e-9) {
    const pad = Math.abs(b) * 0.1 || 1
    if (fixed.min === undefined) a -= pad
    if (fixed.max === undefined) b += pad
  }
  const step = niceStep(b - a)
  if (fixed.min === undefined) a = Math.floor(a / step + 1e-9) * step
  if (fixed.max === undefined) b = Math.ceil(b / step - 1e-9) * step
  if (b <= a) b = a + step
  return [a, b]
}

/**
 * A scale that eases to each new range on a spring, interruptibly, instead of jumping. The span
 * eases in log space, so a line rescaling by 5× moves at an even pace rather than mostly at once.
 */
export class EasedRange {
  private readonly lo = new Spring(0, 10, 1, 1e-4)
  private readonly span = new Spring(0, 10, 1, 1e-4)
  private placed = false
  private goal: [number, number] = [0, 1]
  /** Sets where it's headed; `snap` places it there at once (the first range, reduced motion). */
  to(lo: number, hi: number, snap = false) {
    this.goal = [lo, hi]
    const span = Math.max(1e-9, hi - lo)
    // The springs settle to a fraction of the span, whatever its units.
    this.lo.eps = span * 1e-4
    if (snap || !this.placed) {
      this.lo.snap(lo)
      this.span.snap(Math.log(span))
      this.placed = true
    } else {
      this.lo.set(lo)
      this.span.set(Math.log(span))
    }
  }
  /** Steps both bounds; true while they're still moving. */
  step(dt: number) {
    this.lo.step(dt)
    this.span.step(dt)
    return !(this.lo.resting && this.span.resting)
  }
  get value(): [number, number] {
    if (this.lo.resting && this.span.resting) return [this.goal[0], this.goal[1]]
    return [this.lo.x, this.lo.x + Math.exp(this.span.x)]
  }
  get target(): [number, number] {
    return this.goal
  }
}

/**
 * A history's samples as points across `w`, newest at the right edge; a history that isn't full
 * yet starts part way across. NaN samples break the line: each run is its own list.
 */
export function historyRuns(
  ring: Ring,
  capacity: number,
  range: readonly [number, number],
  w: number,
  top: number,
  bottom: number,
): number[][] {
  const runs: number[][] = []
  const n = ring.length
  const span = range[1] - range[0] || 1
  const dx = capacity > 1 ? w / (capacity - 1) : 0
  let run: number[] = []
  for (let i = 0; i < n; i++) {
    const v = ring.at(i)
    if (!Number.isFinite(v)) {
      if (run.length >= 4) runs.push(run)
      else if (run.length === 2) runs.push([run[0]! - 0.5, run[1]!, run[0]! + 0.5, run[1]!])
      run = []
      continue
    }
    const x = w - (n - 1 - i) * dx
    const k = Math.min(1.08, Math.max(-0.08, (v - range[0]) / span))
    run.push(x, bottom - k * (bottom - top))
  }
  if (run.length >= 4) runs.push(run)
  else if (run.length === 2) runs.push([run[0]! - 0.5, run[1]!, run[0]! + 0.5, run[1]!])
  return runs
}

/** The sample index under `x` (local px), or -1. */
export function sampleAt(x: number, w: number, capacity: number, length: number) {
  if (length === 0 || w <= 0) return -1
  const dx = capacity > 1 ? w / (capacity - 1) : w
  const i = length - 1 - Math.round((w - x) / dx)
  return i >= 0 && i < length ? i : -1
}

export interface SparkScene {
  readonly ops: PlotOp[]
}
/** A sparkline: a soft area under its line, the newest sample dotted; hovered, its min and max. */
export function sparkScene(o: {
  ring: Ring
  capacity: number
  range: readonly [number, number]
  w: number
  h: number
  color: Rgba
  palette: Palette
  hover: boolean
}): PlotOp[] {
  const { ring, w, h, color } = o
  if (w <= 0 || h <= 0 || ring.length === 0) return []
  const top = 2
  const bottom = h - 1.5
  const runs = historyRuns(ring, o.capacity, o.range, w - 2, top, bottom)
  const ops: PlotOp[] = []
  for (const pts of runs)
    ops.push({ t: "area", pts, base: h, color: withAlpha(color, 0.22), fade: 0 })
  for (const pts of runs) ops.push({ t: "line", pts, color, width: 1.25 })
  const last = runs.at(-1)
  if (last && Number.isFinite(ring.last()))
    ops.push({ t: "dot", x: last.at(-2)!, y: last.at(-1)!, r: 1.75, color })
  if (o.hover) {
    const [lo, hi] = ring.extent()
    let iLo = -1
    let iHi = -1
    for (let i = 0; i < ring.length; i++) {
      const v = ring.at(i)
      if (iLo < 0 && v === lo) iLo = i
      if (v === hi) iHi = i
    }
    const span = o.range[1] - o.range[0] || 1
    const dx = o.capacity > 1 ? (w - 2) / (o.capacity - 1) : 0
    for (const [i, v] of [
      [iHi, hi],
      [iLo, lo],
    ] as const) {
      if (i < 0) continue
      const y = bottom - ((v - o.range[0]) / span) * (bottom - top)
      ops.push({
        t: "rect",
        x: 0,
        y: Math.round(y) - 0.25,
        w,
        h: 0.5,
        color: withAlpha(o.palette.dim, 0.7),
      })
      ops.push({
        t: "dot",
        x: w - 2 - (ring.length - 1 - i) * dx,
        y,
        r: 2.25,
        color: o.palette.text,
      })
    }
  }
  return ops
}

/** Dashes along a horizontal line at `y`: 4 px on, 3 off. */
export function dashes(y: number, x0: number, x1: number, color: Rgba, on = 4, off = 3): PlotOp[] {
  const out: PlotOp[] = []
  for (let x = x0; x < x1; x += on + off)
    out.push({ t: "rect", x, y: y - 0.5, w: Math.min(on, x1 - x), h: 1, color })
  return out
}

export interface GraphLine {
  readonly ring: Ring
  readonly color: Rgba
  readonly area: boolean
}
/** A graph: thresholds dashed, each series' area and line, a baseline; hovered, a crosshair. */
export function graphScene(o: {
  lines: readonly GraphLine[]
  capacity: number
  range: readonly [number, number]
  thresholds: readonly { value: number; color: Rgba }[]
  w: number
  h: number
  palette: Palette
  hover: number
}): PlotOp[] {
  const { w, h, range } = o
  if (w <= 0 || h <= 0) return []
  const top = 3
  const bottom = h - 1
  const span = range[1] - range[0] || 1
  const yOf = (v: number) => bottom - ((v - range[0]) / span) * (bottom - top)
  const ops: PlotOp[] = [{ t: "rect", x: 0, y: h - 1, w, h: 1, color: o.palette.line }]
  for (const t of o.thresholds) {
    const y = yOf(t.value)
    if (y < top - 2 || y > bottom + 1) continue
    ops.push(...dashes(Math.round(y) + 0.5, 0, w, t.color))
  }
  for (const line of o.lines) {
    if (!line.area) continue
    for (const pts of historyRuns(line.ring, o.capacity, range, w, top, bottom))
      ops.push({ t: "area", pts, base: bottom, color: withAlpha(line.color, 0.28), fade: 0.15 })
  }
  for (const line of o.lines)
    for (const pts of historyRuns(line.ring, o.capacity, range, w, top, bottom))
      ops.push({ t: "line", pts, color: line.color, width: 1.5 })
  if (o.hover >= 0) {
    const length = o.lines[0]?.ring.length ?? 0
    const dx = o.capacity > 1 ? w / (o.capacity - 1) : 0
    const x = w - (length - 1 - o.hover) * dx
    ops.push({
      t: "rect",
      x: Math.round(x) - 0.5,
      y: 0,
      w: 1,
      h,
      color: withAlpha(o.palette.text, 0.28),
    })
    for (const line of o.lines) {
      const v = line.ring.at(o.hover)
      if (Number.isFinite(v)) ops.push({ t: "dot", x, y: yOf(v), r: 2.75, color: line.color })
    }
  }
  return ops
}

/** The colour a meter's value takes: the accent, the warning colour from `warn`, critical past `critical`. */
export function levelOf(v: number, warn?: number, critical?: number, prev = 0, band = 0) {
  // A level is left only once the value falls `band` below its threshold, so noise doesn't flicker it.
  const past = (at: number | undefined, level: number) =>
    at !== undefined && v >= at - (prev >= level ? band : 0)
  if (past(critical, 2)) return 2
  if (past(warn, 1)) return 1
  return 0
}
export function levelColor(p: Palette, level: number): Rgba {
  return level > 1 ? mixRgba(p.warn, p.critical, level - 1) : mixRgba(p.accent, p.warn, level)
}

/** A meter: a slim track with its fill (eased), or cells; indeterminate, a band that sweeps across. */
export function meterScene(o: {
  /** 0–1, as eased. */
  fraction: number
  /** 0 (ok) to 2 (critical), as eased, for a continuous bar's colour. */
  level: number
  min: number
  max: number
  warn?: number
  critical?: number
  segments?: number
  /** 0–1 through the sweep, or undefined when the value is known. */
  sweep?: number
  w: number
  h: number
  palette: Palette
}): PlotOp[] {
  const { w, palette: p } = o
  if (w <= 0) return []
  const bh = Math.min(o.h, 6)
  const y = (o.h - bh) / 2
  const r = p.radius > 0 ? bh / 2 : 0
  const ops: PlotOp[] = []
  if (o.sweep !== undefined) {
    ops.push({ t: "rect", x: 0, y, w, h: bh, color: p.surfaceHi, r })
    // Eased in and out across, the band a third of the track; clipped to the track.
    const s = o.sweep
    const e = s < 0.5 ? 2 * s * s : 1 - (-2 * s + 2) ** 2 / 2
    const band = w / 3
    const x0 = -band + e * (w + band)
    const a = Math.max(0, x0)
    const b = Math.min(w, x0 + band)
    if (b > a) ops.push({ t: "rect", x: a, y, w: b - a, h: bh, color: p.accent, r })
    return ops
  }
  const n = o.segments ?? 0
  if (n > 1) {
    const gap = 2
    const cw = (w - gap * (n - 1)) / n
    for (let i = 0; i < n; i++) {
      const x = i * (cw + gap)
      ops.push({ t: "rect", x, y, w: cw, h: bh, color: p.surfaceHi, r: Math.min(r, cw / 2) })
      const fill = Math.max(0, Math.min(1, o.fraction * n - i))
      if (fill <= 0.001) continue
      // Each cell takes the colour of where it sits on the scale.
      const at = o.min + ((i + 0.5) / n) * (o.max - o.min)
      const color = levelColor(p, levelOf(at, o.warn, o.critical))
      ops.push({ t: "rect", x, y, w: cw * fill, h: bh, color, r: Math.min(r, (cw * fill) / 2) })
    }
    return ops
  }
  ops.push({ t: "rect", x: 0, y, w, h: bh, color: p.surfaceHi, r })
  const fw = Math.max(0, Math.min(1, o.fraction)) * w
  if (fw > 0.25)
    ops.push({
      t: "rect",
      x: 0,
      y,
      w: fw,
      h: bh,
      color: levelColor(p, o.level),
      r: Math.min(r, fw / 2),
    })
  return ops
}

/** Paints ops on a 2D canvas (already scaled to CSS px). */
export function paintOps(ctx: CanvasRenderingContext2D, ops: readonly PlotOp[]) {
  const css = (c: Rgba) =>
    `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${c[3]})`
  for (const op of ops) {
    if (op.t === "rect") {
      ctx.fillStyle = css(op.color)
      if (op.r && op.r > 0) {
        ctx.beginPath()
        ctx.roundRect(op.x, op.y, op.w, op.h, op.r)
        ctx.fill()
      } else ctx.fillRect(op.x, op.y, op.w, op.h)
    } else if (op.t === "dot") {
      ctx.fillStyle = css(op.color)
      ctx.beginPath()
      ctx.arc(op.x, op.y, op.r, 0, Math.PI * 2)
      ctx.fill()
    } else if (op.t === "line") {
      ctx.strokeStyle = css(op.color)
      ctx.lineWidth = op.width
      ctx.lineJoin = ctx.lineCap = "round"
      ctx.beginPath()
      for (let i = 0; i < op.pts.length; i += 2)
        if (i) ctx.lineTo(op.pts[i]!, op.pts[i + 1]!)
        else ctx.moveTo(op.pts[0]!, op.pts[1]!)
      ctx.stroke()
    } else {
      const pts = op.pts
      let top = Infinity
      for (let i = 1; i < pts.length; i += 2) top = Math.min(top, pts[i]!)
      const g = ctx.createLinearGradient(0, top, 0, op.base)
      g.addColorStop(0, css(op.color))
      g.addColorStop(1, css(withAlpha(op.color, op.fade)))
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.moveTo(pts[0]!, op.base)
      for (let i = 0; i < pts.length; i += 2) ctx.lineTo(pts[i]!, pts[i + 1]!)
      ctx.lineTo(pts[pts.length - 2]!, op.base)
      ctx.closePath()
      ctx.fill()
    }
  }
}
