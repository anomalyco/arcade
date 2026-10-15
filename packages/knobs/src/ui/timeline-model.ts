// The timeline's pure parts: the visible window and its zoom, the ruler's adaptive ticks, frames,
// and the playhead's pull toward markers.

/** The visible window: `start` seconds at the left edge, `span` seconds across. */
export interface TimeView {
  readonly start: number
  readonly span: number
}

export type TimeUnits = "seconds" | "frames"

export interface Tick {
  readonly t: number
  readonly label: string
}
export interface Ticks {
  readonly major: readonly Tick[]
  readonly minor: readonly number[]
  /** Seconds between major ticks. */
  readonly step: number
}

const SECOND_STEPS = [0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600]
const FRAME_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 9000, 18000]

/** A frame's time, rounded to the nearest frame. */
export const toFrame = (t: number, fps: number) => Math.round(t * fps)
export const frameTime = (t: number, fps: number) => Math.round(t * fps) / fps

/** "1.5s", "12s", "1:05", "1:02:05" for seconds; the frame number for frames. */
export function timeLabel(t: number, units: TimeUnits, fps: number, step = 1): string {
  if (units === "frames") return String(toFrame(t, fps))
  const sign = t < 0 ? "-" : ""
  const a = Math.abs(t)
  if (a >= 60 || (step >= 60 && a > 0)) {
    const s = Math.round(a)
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const sec = String(s % 60).padStart(2, "0")
    return `${sign}${h ? `${h}:${String(m).padStart(2, "0")}` : m}:${sec}`
  }
  const decimals = step < 0.1 ? 2 : step < 1 ? 1 : 0
  return `${sign}${Number(a.toFixed(decimals))}s`
}

/**
 * Ticks for a view `width` px wide: major ticks at least `minGap` px apart on a nice step (whole
 * frames in frame units), labelled; minor ones between them, down to single frames once a frame
 * is `frameGap` px wide.
 */
export function rulerTicks(
  view: TimeView,
  width: number,
  o: { fps: number; units?: TimeUnits; minGap?: number; frameGap?: number },
): Ticks {
  const units = o.units ?? "seconds"
  const fps = o.fps
  const pxPerSec = width / Math.max(1e-9, view.span)
  const minGap = o.minGap ?? 72
  const steps = units === "frames" ? FRAME_STEPS.map((f) => f / fps) : SECOND_STEPS
  const step = steps.find((s) => s * pxPerSec >= minGap) ?? steps[steps.length - 1]!
  // Minor: the finest of 1/2, 1/4, 1/5, 1/10 of the step that stays ≥ 7px, or single frames.
  const frame = 1 / fps
  let minor = 0
  for (const div of [10, 5, 4, 2]) {
    const m = step / div
    if (m * pxPerSec < 7) continue
    if (units === "frames" && Math.abs(m * fps - Math.round(m * fps)) > 1e-6) continue
    minor = m
    break
  }
  // Once frames are wide enough to see, minors are frames: never finer, as nothing lies between.
  if (frame * pxPerSec >= (o.frameGap ?? 6)) minor = Math.min(frame, step)
  const end = view.start + view.span
  const major: Tick[] = []
  const first = Math.ceil(view.start / step - 1e-9)
  for (let i = first; i * step <= end + 1e-9; i++) {
    const t = round(i * step)
    major.push({ t, label: timeLabel(t, units, fps, step) })
  }
  const minors: number[] = []
  if (minor > 0) {
    const firstMinor = Math.ceil(view.start / minor - 1e-9)
    for (let i = firstMinor; i * minor <= end + 1e-9; i++) {
      const t = i * minor
      if (Math.abs(t / step - Math.round(t / step)) > 1e-6) minors.push(round(t))
    }
  }
  return { major, minor: minors, step }
}

const round = (t: number) => Math.round(t * 1e6) / 1e6

/** Clamps a view to `[0, duration]` with a little room (`pad` of the span) at either end. */
export function clampView(
  view: TimeView,
  duration: number,
  o: { minSpan?: number; pad?: number } = {},
): TimeView {
  const pad = o.pad ?? 0.04
  const maxSpan = duration * (1 + pad * 2)
  const span = Math.min(maxSpan, Math.max(o.minSpan ?? 0.05, view.span))
  const lo = -duration * pad
  const hi = duration * (1 + pad) - span
  const start = hi < lo ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, view.start))
  return { start, span }
}

/** Zooms by `factor` (above 1 zooms in) keeping time `at` under the same point. */
export function zoomView(view: TimeView, factor: number, at: number): TimeView {
  const span = view.span / factor
  const k = (at - view.start) / view.span
  return { start: at - k * span, span }
}

/** The view panned so `t` sits at least `margin` (of the span) inside it, or unchanged. */
export function followView(view: TimeView, t: number, margin = 0.08): TimeView {
  const m = view.span * margin
  if (t < view.start + m) return { ...view, start: t - m }
  if (t > view.start + view.span - m) return { ...view, start: t - view.span + m }
  return view
}

/**
 * The playhead's soft pull toward a marker while it's scrubbed: within `radius` px it follows the
 * pointer by a curve that's flat at the marker (it sticks there) and meets the pointer at the
 * edge, with no jump. Returns the time to show and the marker it rests on, if any.
 */
export function magnet(
  raw: number,
  stops: readonly number[],
  pxPerSec: number,
  radius = 10,
  stick = 0.3,
): { t: number; stop: number | null } {
  let best: number | null = null
  let bestPx = Number.POSITIVE_INFINITY
  for (const s of stops) {
    const px = Math.abs(raw - s) * pxPerSec
    if (px < bestPx) {
      bestPx = px
      best = s
    }
  }
  if (best === null || bestPx >= radius) return { t: raw, stop: null }
  const u = bestPx / radius
  const pulled = best + (Math.sign(raw - best) * (u * u * radius)) / pxPerSec
  return { t: pulled, stop: u < stick ? best : null }
}

/**
 * Where a scrub lands: on a marker it's resting on, else on the nearest frame (with `frames`),
 * clamped to `[0, duration]`.
 */
export function scrubTime(
  raw: number,
  o: {
    duration: number
    fps: number
    pxPerSec: number
    stops?: readonly number[]
    frames?: boolean
    radius?: number
  },
): { t: number; shown: number; stop: number | null } {
  const clamped = Math.min(o.duration, Math.max(0, raw))
  const m = o.stops?.length
    ? magnet(clamped, o.stops, o.pxPerSec, o.radius)
    : { t: clamped, stop: null }
  const t = m.stop ?? (o.frames === false ? m.t : frameTime(m.t, o.fps))
  return { t: Math.min(o.duration, Math.max(0, t)), shown: m.stop ?? m.t, stop: m.stop }
}

/** The marker before (`-1`) or after (`1`) time `t`, by a frame's margin, or null. */
export function adjacentMarker<M extends { readonly time: number }>(
  markers: readonly M[],
  t: number,
  dir: 1 | -1,
  fps: number,
): M | null {
  const eps = 0.5 / fps
  const sorted = [...markers].sort((a, b) => a.time - b.time)
  if (dir > 0) return sorted.find((m) => m.time > t + eps) ?? null
  return [...sorted].reverse().find((m) => m.time < t - eps) ?? null
}

/** Advances playing time by `dt`, looping inside `loop` (or the whole) when asked. */
export function advance(
  t: number,
  dt: number,
  o: { duration: number; loop?: { start: number; end: number } | null; repeat?: boolean },
): { t: number; ended: boolean; wrapped: boolean } {
  const lo = o.loop ? o.loop.start : 0
  const hi = o.loop ? o.loop.end : o.duration
  let next = t + dt
  if (hi - lo <= 1e-6) return { t: lo, ended: true, wrapped: false }
  if (next < hi) return { t: next, ended: false, wrapped: false }
  if (o.loop || o.repeat) {
    next = lo + ((next - lo) % (hi - lo))
    return { t: next, ended: false, wrapped: true }
  }
  return { t: hi, ended: true, wrapped: false }
}
