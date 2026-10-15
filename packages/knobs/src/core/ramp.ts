// Gradients (colour over a 0…1 parameter) and curves (a number over 0…1): their values, how hosts
// sample them, and the samples both renderers draw from.
import {
  colorHex,
  fitColor,
  formatColor,
  maxChroma,
  oklchToRgb,
  parseColor,
  rgbToOklch,
  type Oklch,
} from "./color.js"

/** A gradient stop: where it sits (0…1) and its colour, as an `oklch(L C H)` string. */
export interface GradientStop {
  readonly at: number
  readonly color: string
}
/** How a gradient blends between its stops: perceptually (`oklab`) or as CSS does (`srgb`). */
export type GradientSpace = "oklab" | "srgb"
/** A curve point: x across 0…1, y in the curve's range. */
export interface CurvePoint {
  readonly x: number
  readonly y: number
}
/** `smooth` is a monotone cubic: it never overshoots its points, so a falloff stays a falloff. */
export type CurveInterp = "smooth" | "linear" | "step"

export const MAX_STOPS = 32
export const MAX_POINTS = 64
/** How many evenly spaced samples a gradient strip and a curve are drawn from (both renderers). */
export const GRADIENT_SAMPLES = 64
export const CURVE_SAMPLES = 129

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)
const round4 = (v: number) => Math.round(v * 1e4) / 1e4 || 0

/** Stops as given, sorted by position (ties keep their order) and clamped; undefined if fewer than two. */
export function normalizeStops(input: unknown): readonly GradientStop[] | undefined {
  if (!Array.isArray(input)) return undefined
  const stops: GradientStop[] = []
  for (const s of input.slice(0, MAX_STOPS)) {
    if (typeof s !== "object" || s === null) continue
    const { at, color } = s as Record<string, unknown>
    const parsed = parseColor(color)
    if (!finite(at) || !parsed) continue
    stops.push(Object.freeze({ at: round4(clamp(at, 0, 1)), color: formatColor(fitColor(parsed)) }))
  }
  if (stops.length < 2) return undefined
  return Object.freeze(
    stops
      .map((s, i) => [s, i] as const)
      .sort((a, b) => a[0].at - b[0].at || a[1] - b[1])
      .map(([s]) => s),
  )
}

/**
 * Points sorted by x and clamped into `range`, the first at x 0 and the last at x 1 (the ends are
 * pinned); undefined if fewer than two.
 */
export function normalizePoints(
  input: unknown,
  range: readonly [number, number],
): readonly CurvePoint[] | undefined {
  if (!Array.isArray(input)) return undefined
  const pts: CurvePoint[] = []
  const span = range[1] - range[0]
  // y keeps five digits of the range: plenty, and short in code.
  const roundY = (y: number) =>
    span > 0
      ? Number(
          (range[0] + (Math.round(((y - range[0]) / span) * 1e5) / 1e5) * span).toPrecision(12),
        )
      : range[0]
  for (const p of input.slice(0, MAX_POINTS)) {
    if (typeof p !== "object" || p === null) continue
    const { x, y } = p as Record<string, unknown>
    if (!finite(x) || !finite(y)) continue
    pts.push({ x: round4(clamp(x, 0, 1)), y: roundY(clamp(y, range[0], range[1])) })
  }
  if (pts.length < 2) return undefined
  const sorted = pts
    .map((p, i) => [p, i] as const)
    .sort((a, b) => a[0].x - b[0].x || a[1] - b[1])
    .map(([p]) => p)
  sorted[0] = { ...sorted[0]!, x: 0 }
  sorted[sorted.length - 1] = { ...sorted[sorted.length - 1]!, x: 1 }
  return Object.freeze(sorted.map((p) => Object.freeze(p)))
}

type Lab = readonly [number, number, number]
const toLab = ({ l, c, h }: Oklch): Lab => [
  l,
  c * Math.cos((h * Math.PI) / 180),
  c * Math.sin((h * Math.PI) / 180),
]
const fromLab = ([l, a, b]: Lab): Oklch => {
  const c = Math.hypot(a, b)
  return { l, c, h: c < 1e-5 ? 0 : ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 }
}
const linearOf = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)

/** A gradient prepared for many samples: each stop's colour in the space it blends in. */
function prepare(stops: readonly GradientStop[], space: GradientSpace) {
  const at = stops.map((s) => s.at)
  const ok = stops.map((s) => parseColor(s.color) ?? { l: 0, c: 0, h: 0 })
  const lab = ok.map(toLab)
  const rgb = ok.map((c) => oklchToRgb(c))
  /** The colour at `t` as gamma-encoded sRGB (0…1), gamut-mapped by chroma like a colour field. */
  return (t: number): [number, number, number] => {
    const n = at.length
    let i = 0
    while (i < n && at[i]! <= t) i++
    // Before the first stop and after the last, the end colours hold.
    if (i === 0) return [...rgb[0]!]
    if (i === n) return [...rgb[n - 1]!]
    const a = i - 1
    const span = at[i]! - at[a]!
    const f = span > 0 ? (t - at[a]!) / span : 1
    if (space === "srgb") {
      const p = rgb[a]!
      const q = rgb[i]!
      return [p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f, p[2] + (q[2] - p[2]) * f]
    }
    const p = lab[a]!
    const q = lab[i]!
    return oklchToRgb(
      fromLab([p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f, p[2] + (q[2] - p[2]) * f]),
    )
  }
}

export interface SampleGradientOptions {
  /** How the stops blend (the field's own `space`); `oklab` by default. Pass the field itself. */
  readonly space?: GradientSpace
}
/**
 * The gradient's colour at `t` (0…1, clamped): an `oklch()` string by default, `"hex"` for
 * `#rrggbb`, `"rgb"` for gamma-encoded sRGB channels (0…1) or `"linear"` for linear-light ones (a
 * shader's). Blends in the field's `space`: `sampleGradient(v.smoke, age, { ...field, as: "linear" })`.
 */
export function sampleGradient(
  stops: readonly GradientStop[],
  t: number,
  options?: SampleGradientOptions & { readonly as?: "css" | "hex" },
): string
export function sampleGradient(
  stops: readonly GradientStop[],
  t: number,
  options: SampleGradientOptions & { readonly as: "rgb" | "linear" },
): [number, number, number]
export function sampleGradient(
  stops: readonly GradientStop[],
  t: number,
  options: SampleGradientOptions & { readonly as?: "css" | "hex" | "rgb" | "linear" } = {},
): string | [number, number, number] {
  const valid = normalizeStops(stops) ?? stops
  if (!valid.length) return options.as === "rgb" || options.as === "linear" ? [0, 0, 0] : "#000000"
  const rgb = prepare(valid, options.space ?? "oklab")(clamp(Number.isFinite(t) ? t : 0, 0, 1))
  if (options.as === "rgb") return rgb
  if (options.as === "linear") return [linearOf(rgb[0]), linearOf(rgb[1]), linearOf(rgb[2])]
  const color = formatColor(fitColor(rgbToOklch(...rgb)))
  return options.as === "hex" ? colorHex(color) : color
}

/** `n` evenly spaced samples (t = i / (n − 1)) as gamma-encoded sRGB triples, flat. */
export function gradientSamples(
  stops: readonly GradientStop[],
  space: GradientSpace,
  n = GRADIENT_SAMPLES,
): number[] {
  const at = prepare(stops, space)
  const out: number[] = []
  for (let i = 0; i < n; i++) out.push(...at(i / (n - 1)))
  return out
}

/** A CSS `linear-gradient(…)` of the gradient (sampled, so `oklab` blends match). */
export function gradientCss(
  stops: readonly GradientStop[],
  options: SampleGradientOptions & { readonly direction?: string } = {},
): string {
  const valid = normalizeStops(stops) ?? stops
  const s = gradientSamples(valid, options.space ?? "oklab", 17)
  const parts: string[] = []
  for (let i = 0; i < 17; i++) {
    const [r, g, b] = [s[i * 3]!, s[i * 3 + 1]!, s[i * 3 + 2]!].map((v) => Math.round(v * 255))
    parts.push(`rgb(${r} ${g} ${b}) ${round4((i / 16) * 100)}%`)
  }
  return `linear-gradient(${options.direction ?? "to right"},${parts.join(",")})`
}

/** The colour halfway between two stops, for a stop added between them. */
export function stopColorAt(stops: readonly GradientStop[], space: GradientSpace, t: number) {
  return formatColor(fitColor(rgbToOklch(...prepare(stops, space)(clamp(t, 0, 1)))))
}

/**
 * Tangents for a monotone cubic (Steffen's): each lies within its neighbours' secants, so the curve
 * never overshoots a point and stays flat where the points do.
 */
function tangents(xs: readonly number[], ys: readonly number[]): number[] {
  const n = xs.length
  const h: number[] = []
  const s: number[] = []
  for (let i = 0; i < n - 1; i++) {
    h.push(xs[i + 1]! - xs[i]!)
    s.push(h[i]! > 0 ? (ys[i + 1]! - ys[i]!) / h[i]! : 0)
  }
  const m = new Array<number>(n).fill(0)
  if (n === 2) {
    m[0] = m[1] = s[0]!
    return m
  }
  const sign = Math.sign
  for (let i = 1; i < n - 1; i++) {
    const h0 = h[i - 1]!
    const h1 = h[i]!
    if (h0 <= 0 || h1 <= 0) continue
    const p = (s[i - 1]! * h1 + s[i]! * h0) / (h0 + h1)
    m[i] =
      (sign(s[i - 1]!) + sign(s[i]!)) *
      Math.min(Math.abs(s[i - 1]!), Math.abs(s[i]!), 0.5 * Math.abs(p))
  }
  const end = (a: number, b: number, ha: number, hb: number) => {
    if (ha <= 0) return 0
    const p = a * (1 + ha / (ha + hb)) - (b * ha) / (ha + hb)
    if (sign(p) !== sign(a)) return 0
    return Math.abs(p) > 2 * Math.abs(a) ? 2 * a : p
  }
  m[0] = end(s[0]!, s[1]!, h[0]!, h[1]!)
  m[n - 1] = end(s[n - 2]!, s[n - 3]!, h[n - 2]!, h[n - 3]!)
  return m
}

/** A curve prepared for many samples. */
function prepareCurve(points: readonly CurvePoint[], interp: CurveInterp) {
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  const m = interp === "smooth" ? tangents(xs, ys) : []
  const n = xs.length
  return (x: number): number => {
    if (!n) return 0
    if (x <= xs[0]!) return ys[0]!
    if (x >= xs[n - 1]!) return ys[n - 1]!
    let i = 0
    while (i < n - 2 && xs[i + 1]! <= x) i++
    const x0 = xs[i]!
    const span = xs[i + 1]! - x0
    if (interp === "step" || span <= 0) return ys[i]!
    const t = (x - x0) / span
    if (interp === "linear") return ys[i]! + (ys[i + 1]! - ys[i]!) * t
    const t2 = t * t
    const t3 = t2 * t
    return (
      (2 * t3 - 3 * t2 + 1) * ys[i]! +
      (t3 - 2 * t2 + t) * span * m[i]! +
      (-2 * t3 + 3 * t2) * ys[i + 1]! +
      (t3 - t2) * span * m[i + 1]!
    )
  }
}

export interface SampleCurveOptions {
  /** How the points join (the field's own `interp`); `smooth` by default. Pass the field itself. */
  readonly interp?: CurveInterp
}
/** The curve's y at `x` (clamped to 0…1): `sampleCurve(v.falloff, distance / radius, field)`. */
export function sampleCurve(
  points: readonly CurvePoint[],
  x: number,
  options: SampleCurveOptions = {},
): number {
  return prepareCurve(points, options.interp ?? "smooth")(Number.isFinite(x) ? x : 0)
}

/**
 * `n` samples of the curve as x, y pairs: evenly spaced in x, except that the sample nearest each
 * point lands on it exactly (corners stay sharp; a step rises straight up). The count never
 * changes, so two curves' samples can be blended point for point.
 */
export function curveSamples(
  points: readonly CurvePoint[],
  interp: CurveInterp,
  n = CURVE_SAMPLES,
): number[] {
  const at = prepareCurve(points, interp)
  const xs = Array.from({ length: n }, (_, i) => i / (n - 1))
  for (const p of points) {
    const j = Math.round(p.x * (n - 1))
    xs[j] = p.x
    if (interp === "step" && j > 0 && p.x > 0) xs[j - 1] = p.x
  }
  xs.sort((a, b) => a - b)
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    const x = xs[i]!
    // Where a step rises, the first of its two samples still holds the level before it.
    const rising = interp === "step" && xs[i + 1] === x && xs[i - 1] !== x
    out.push(x, at(rising ? x - 1e-9 : x))
  }
  return out
}

/** Built-in curve shapes, y over 0…1 (mapped onto the field's range). */
export const CURVE_SHAPES = {
  linear: [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
  ],
  "ease-out": [
    { x: 0, y: 0 },
    { x: 0.35, y: 0.62 },
    { x: 1, y: 1 },
  ],
  "inverse²": [
    { x: 0, y: 1 },
    { x: 0.1, y: 0.85 },
    { x: 0.25, y: 0.47 },
    { x: 0.5, y: 0.15 },
    { x: 1, y: 0 },
  ],
  smoothstep: [
    { x: 0, y: 0 },
    { x: 0.25, y: 0.156 },
    { x: 0.5, y: 0.5 },
    { x: 0.75, y: 0.844 },
    { x: 1, y: 1 },
  ],
  bell: [
    { x: 0, y: 0 },
    { x: 0.25, y: 0.25 },
    { x: 0.5, y: 1 },
    { x: 0.75, y: 0.25 },
    { x: 1, y: 0 },
  ],
} as const satisfies Record<string, readonly CurvePoint[]>

/** A 0…1 shape in a y range. */
export const inRange = (shape: readonly CurvePoint[], range: readonly [number, number]) =>
  shape.map((p) => ({ x: p.x, y: range[0] + p.y * (range[1] - range[0]) }))

/** Whether two point or stop lists are the same, to a rounding. */
export function sameRamp(
  a: readonly (CurvePoint | GradientStop)[],
  b: readonly (CurvePoint | GradientStop)[],
): boolean {
  if (a.length !== b.length) return false
  return a.every((p, i) => {
    const q = b[i]!
    if ("at" in p && "at" in q) return Math.abs(p.at - q.at) < 1e-4 && p.color === q.color
    if ("x" in p && "x" in q) return Math.abs(p.x - q.x) < 1e-4 && Math.abs(p.y - q.y) < 1e-6
    return false
  })
}

const between = (min: number, max: number, r: number) => min + (max - min) * r
const signed = (random: () => number) => (random() < 0.5 ? -1 : 1)

/**
 * A fresh gradient with as many stops: positions spread evenly with a little play, colours a
 * walk through a few neighbouring hues from dark to light (or back), so it reads as one ramp.
 */
export function randomStops(count: number, random: () => number): GradientStop[] {
  const n = Math.max(2, count)
  const hue = random() * 360
  const turn = signed(random) * between(20, 70, random())
  const rising = random() < 0.5
  const [l0, l1] = [between(0.2, 0.4, random()), between(0.75, 0.95, random())]
  const vivid = between(0.3, 0.9, random())
  return Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1)
    const jitter = i === 0 || i === n - 1 ? 0 : (random() - 0.5) * (0.5 / (n - 1))
    const at = clamp(t + jitter, 0, 1)
    const l = rising ? l0 + (l1 - l0) * t : l1 + (l0 - l1) * t
    const h = (hue + turn * t + 360) % 360
    const c = vivid * maxChroma(l, h) * between(0.7, 1, random())
    return { at, color: formatColor(fitColor({ l, c, h })) }
  })
}

/**
 * The stops nudged: each colour turns a few degrees and shifts lightness and chroma a touch (as a
 * colour field mutates), and each position moves a little without passing its neighbours.
 */
export function mutateStops(
  stops: readonly GradientStop[],
  random: () => number,
  hue: readonly [number, number],
  lightness: readonly [number, number],
): GradientStop[] {
  const out = stops.map((s) => ({ ...s }))
  for (const [i, s] of out.entries()) {
    const c = parseColor(s.color) ?? { l: 0.5, c: 0, h: 0 }
    const max0 = maxChroma(c.l, c.h)
    const rel = max0 > 1e-4 ? clamp(c.c / max0, 0, 1) : 0.5
    const h = (c.h + signed(random) * between(hue[0], hue[1], random()) + 360) % 360
    const l = clamp(c.l + signed(random) * between(lightness[0], lightness[1], random()), 0, 1)
    const r = clamp(rel + signed(random) * between(0.04, 0.1, random()), 0, 1)
    s.color = formatColor(fitColor({ l, c: r * maxChroma(l, h), h }))
    const lo = i > 0 ? out[i - 1]!.at : 0
    const hi = i < out.length - 1 ? stops[i + 1]!.at : 1
    s.at = round4(clamp(s.at + signed(random) * between(0.02, 0.05, random()), lo, hi))
  }
  return out
}

/** A built-in shape, picked at random, with its inner points shifted a touch. */
export function randomPoints(range: readonly [number, number], random: () => number): CurvePoint[] {
  const shapes = Object.values(CURVE_SHAPES)
  const shape = shapes[Math.floor(Math.min(0.999999, random()) * shapes.length)]!
  const flip = random() < 0.3
  return inRange(
    shape.map((p, i) => ({
      x: p.x,
      y:
        i === 0 || i === shape.length - 1
          ? flip
            ? 1 - p.y
            : p.y
          : clamp((flip ? 1 - p.y : p.y) + (random() - 0.5) * 0.12, 0, 1),
    })),
    range,
  )
}

/** Each point nudged a little in y (and the inner ones in x, between their neighbours). */
export function mutatePoints(
  points: readonly CurvePoint[],
  range: readonly [number, number],
  random: () => number,
  share: readonly [number, number],
): CurvePoint[] {
  const span = range[1] - range[0]
  const out = points.map((p) => ({ ...p }))
  for (const [i, p] of out.entries()) {
    const by = span * between(share[0], share[1], random()) * 0.6
    let y = p.y + signed(random) * by
    if (y > range[1] || y < range[0]) y = p.y - (y - p.y)
    p.y = clamp(y, range[0], range[1])
    if (i === 0 || i === out.length - 1) continue
    const lo = out[i - 1]!.x + 0.01
    const hi = points[i + 1]!.x - 0.01
    if (hi > lo) p.x = round4(clamp(p.x + signed(random) * between(0.02, 0.05, random()), lo, hi))
  }
  return out
}
