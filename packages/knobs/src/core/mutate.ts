import { maxChroma, parseColor } from "./color.js"
import { EASING_Y } from "./easing.js"
import { mutatePoints, mutateStops, type CurvePoint, type GradientStop } from "./ramp.js"
import {
  SPRING,
  hasValue,
  normalizeField,
  same,
  type Schema,
  type Value,
  type ValueField,
  valueKeys,
} from "./schema.js"
import type { SpringValue } from "./spring.js"

/**
 * How far a mutation moves things. Numbers and points move 8–12% of their range either way;
 * springs the same share of the range Random uses; choices and switches change only `flip` of the
 * time. Colours turn a few degrees and shift chroma and lightness slightly.
 */
export const MUTATE = {
  min: 0.08,
  max: 0.12,
  flip: 0.15,
  hue: [4, 12],
  chroma: 0.02,
  lightness: [0.015, 0.045],
  bezier: [0.03, 0.06],
} as const

const between = (min: number, max: number, r: number) => min + (max - min) * r
const signed = (random: () => number) => (random() < 0.5 ? -1 : 1)

/**
 * `v` moved 8–12% of `reach` (the range, by default) either way, bouncing off an end, then put
 * back on the step lattice.
 */
function nudge(
  v: number,
  min: number,
  max: number,
  step: number,
  random: () => number,
  reach = max - min,
) {
  const span = max - min
  if (!(span > 0)) return v
  const sign = signed(random)
  const by = reach * between(MUTATE.min, MUTATE.max, random())
  let next = v + sign * by
  // A value at its limit still moves: past an end, go the other way.
  if (next > max || next < min) next = v - sign * by
  const top = Math.floor(span / step + 1e-9)
  const at = (n: number) => Number((min + n * step).toPrecision(14))
  let steps = Math.max(0, Math.min(top, Math.round((next - min) / step)))
  // Coarse steps could round back onto the current value; take one step instead.
  if (at(steps) === v) {
    const dir = next >= v ? 1 : -1
    steps = Math.max(0, Math.min(top, steps + (steps + dir > top || steps + dir < 0 ? -dir : dir)))
  }
  return at(steps)
}

function shift(field: ValueField, value: Value, random: () => number): unknown {
  switch (field.kind) {
    case "knob":
      return nudge(value as number, field.min, field.max, field.step, random)
    case "point": {
      const p = value as { x: number; y: number }
      return {
        x: nudge(p.x, field.min.x, field.max.x, field.step.x, random),
        y: nudge(p.y, field.min.y, field.max.y, field.step.y, random),
      }
    }
    case "spring": {
      const s = value as SpringValue
      // The same share of the range Random draws from (0.2–0.9 s, bounce 0–0.45).
      const d = SPRING.duration
      const b = SPRING.bounce
      return {
        duration: nudge(s.duration, d.min, d.max, d.step, random, 0.7),
        bounce: nudge(s.bounce, b.min, b.max, b.step, random, 0.45),
      }
    }
    case "color": {
      const c = parseColor(value) ?? { l: 0.7, c: 0.1, h: 0 }
      const max0 = maxChroma(c.l, c.h)
      const rel0 = max0 > 1e-4 ? Math.min(1, Math.max(0, c.c / max0)) : 0.5
      const h = (c.h + signed(random) * between(MUTATE.hue[0], MUTATE.hue[1], random()) + 360) % 360
      const l = Math.min(
        1,
        Math.max(
          0,
          c.l + signed(random) * between(MUTATE.lightness[0], MUTATE.lightness[1], random()),
        ),
      )
      return { l, c: nudge(rel0, 0, 1, 0.01, random) * maxChroma(l, h), h }
    }
    case "easing":
      return (value as readonly number[]).map((v, i) => {
        const [lo, hi] = i % 2 === 0 ? [0, 1] : EASING_Y
        const next = v + signed(random) * between(MUTATE.bezier[0], MUTATE.bezier[1], random())
        return Math.min(hi, Math.max(lo, next))
      })
    case "choice": {
      if (random() >= MUTATE.flip || field.options.length < 2) return value
      return other(field.options, value as string, random)
    }
    case "toggle":
      return random() < MUTATE.flip ? !value : value
    case "vec": {
      const v = value as { x: number; y: number; z?: number }
      const axis = (n: number) => nudge(n, field.min, field.max, field.step, random)
      return field.axes === 3
        ? { x: axis(v.x), y: axis(v.y), z: axis(v.z ?? 0) }
        : { x: axis(v.x), y: axis(v.y) }
    }
    case "range": {
      const [a, b] = value as readonly [number, number]
      return [
        nudge(a, field.min, field.max, field.step, random),
        nudge(b, field.min, field.max, field.step, random),
      ]
    }
    case "angle": {
      const v = value as number
      if (!field.wrap) return nudge(v, field.min, field.max, field.step, random)
      // A wrapping dial turns on past its ends instead of bouncing off them.
      const span = field.max - field.min
      return v + signed(random) * span * between(MUTATE.min, MUTATE.max, random())
    }
    case "seed":
      return nudge(value as number, field.min, field.max, 1, random)
    case "keybind":
      return value
    case "gradient":
      return mutateStops(value as readonly GradientStop[], random, MUTATE.hue, MUTATE.lightness)
    case "curve":
      return mutatePoints(value as readonly CurvePoint[], field.range, random, [
        MUTATE.min,
        MUTATE.max,
      ])
  }
}

const other = (options: readonly string[], value: string, random: () => number) => {
  const rest = options.filter((o) => o !== value)
  return rest[Math.floor(Math.min(0.999999, random()) * rest.length)] ?? value
}

/**
 * Small changes around `current` for `keys` (every field when omitted): a nudge rather than a
 * re-roll. When only switches and choices are asked for and none happened to change, one flips,
 * so a mutation always does something.
 */
export function mutateValues<S extends Schema>(
  schema: S,
  current: Readonly<Record<string, Value>>,
  keys: readonly string[] = valueKeys(schema),
  random = Math.random,
): Record<string, Value> {
  const out: Record<string, Value> = {}
  let changed = false
  for (const key of keys) {
    const field = schema[key]
    if (!field || !hasValue(field)) continue
    const before = current[key] ?? field.value
    const next = normalizeField(field, shift(field, before, random))
    out[key] = next
    if (!same(before, next)) changed = true
  }
  if (!changed) {
    const discrete = keys.filter((k) => {
      const f = schema[k]
      return f?.kind === "toggle" || (f?.kind === "choice" && f.options.length > 1)
    })
    const key = discrete[Math.floor(Math.min(0.999999, random()) * discrete.length)]
    const field = key ? schema[key] : undefined
    if (key && field?.kind === "toggle") out[key] = !(current[key] ?? field.value)
    else if (key && field?.kind === "choice")
      out[key] = other(field.options, String(current[key] ?? field.value), random)
  }
  return out
}
