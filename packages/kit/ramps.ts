import {
  curve,
  gradient,
  sampleCurve,
  sampleGradient,
  type CurveInterp,
  type CurvePoint,
  type GradientSpace,
  type GradientStop,
} from "@arcade/knobs"
export { sampleTable } from "./ramp-table"
export { sampleCurve, sampleGradient }

/**
 * Gradient and curve settings. A LabSettings value is a primitive, so a ramp is kept as JSON text (`[{ x, y }]` or
 * `[{ at, color }]`) in knobs' normalized form, and read back with `parseCurve`/`parseGradient`. Consumers that sample
 * per frame or per particle bake a lookup table once per change (`curveTable`, `gradientTable`) instead of sampling the
 * ramp itself. DOM-free.
 */
export type { CurveInterp, CurvePoint, GradientSpace, GradientStop }

export type CurveOptions = { range?: readonly [number, number]; interp?: CurveInterp }
export type GradientOptions = { space?: GradientSpace }

/** Points in knobs' normalized form (sorted, ends pinned to x 0 and 1, clamped into `range`). */
export function normalizeCurve(points: readonly CurvePoint[], options: CurveOptions = {}): readonly CurvePoint[] {
  return curve(points, { range: options.range ?? [0, 1] }).value
}

/** Stops in knobs' normalized form (sorted, colours as `oklch()` strings). */
export function normalizeGradient(stops: readonly { at: number; color: string }[]): readonly GradientStop[] {
  return gradient(stops).value
}

/** A curve as the JSON text a LabSettings value holds. */
export const curveText = (points: readonly CurvePoint[], options: CurveOptions = {}) =>
  JSON.stringify(normalizeCurve(points, options).map(p => ({ x: p.x, y: p.y })))

/** A gradient as the JSON text a LabSettings value holds. */
export const gradientText = (stops: readonly { at: number; color: string }[]) =>
  JSON.stringify(normalizeGradient(stops).map(s => ({ at: s.at, color: s.color })))

const parse = (value: unknown): unknown => {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

/** A curve setting's points (JSON text or an array), normalized, or `fallback` when it isn't a curve. */
export function parseCurve(value: unknown, fallback: readonly CurvePoint[], options: CurveOptions = {}): readonly CurvePoint[] {
  const raw = parse(value)
  if (!Array.isArray(raw)) return fallback
  try {
    return normalizeCurve(raw as CurvePoint[], options)
  } catch {
    return fallback
  }
}

/** A gradient setting's stops (JSON text or an array), normalized, or `fallback` when it isn't a gradient. */
export function parseGradient(value: unknown, fallback: readonly GradientStop[]): readonly GradientStop[] {
  const raw = parse(value)
  if (!Array.isArray(raw)) return fallback
  try {
    return normalizeGradient(raw as GradientStop[])
  } catch {
    return fallback
  }
}

/** Whether a value reads as a curve (for preset validation). */
export const isCurveValue = (value: unknown) => parseCurve(value, []).length >= 2
/** Whether a value reads as a gradient (for preset validation). */
export const isGradientValue = (value: unknown) => parseGradient(value, []).length >= 2

/** Two curves with the same points, to within `epsilon` (a default left alone reads as the default). */
export function sameCurve(a: readonly CurvePoint[], b: readonly CurvePoint[], epsilon = 1e-4): boolean {
  return a.length === b.length && a.every((p, i) => Math.abs(p.x - b[i]!.x) <= epsilon && Math.abs(p.y - b[i]!.y) <= epsilon)
}

export const RAMP_TABLE_SIZE = 64

/** `n` evenly spaced samples of a curve over x 0…1. */
export function curveTable(points: readonly CurvePoint[], interp: CurveInterp = "smooth", n = RAMP_TABLE_SIZE): Float32Array {
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = sampleCurve(points, i / (n - 1), { interp })
  return out
}

/** `n` evenly spaced samples of a gradient over 0…1 as linear-light RGB triples (a shader's colours), flat. */
export function gradientTable(stops: readonly GradientStop[], space: GradientSpace = "oklab", n = RAMP_TABLE_SIZE): Float32Array {
  const out = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) out.set(sampleGradient(stops, i / (n - 1), { space, as: "linear" }), i * 3)
  return out
}
