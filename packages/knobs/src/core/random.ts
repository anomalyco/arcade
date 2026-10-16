import { maxChroma, parseColor } from "./color.js"
import { EASING_Y, EASINGS } from "./easing.js"
import {
  mutatePoints,
  mutateStops,
  randomPoints,
  randomStops,
  type CurvePoint,
  type GradientStop,
} from "./ramp.js"
import { SPRING, hasValue, normalize, type Schema, type ValueField, type Values } from "./schema.js"
import type { SpringValue } from "./spring.js"

const lattice = (min: number, max: number, step: number, r: number) =>
  min + Math.floor(r * (Math.floor((max - min) / step + 1e-9) + 1)) * step
const between = (min: number, max: number, r: number) => min + (max - min) * r

/** One field's roll across its whole range (see `randomValues`). */
export function pick(field: ValueField, random: () => number) {
  const r = () => Math.max(0, Math.min(1 - Number.EPSILON, random()))
  switch (field.kind) {
    case "knob":
      return lattice(field.min, field.max, field.step, r())
    case "choice":
      return field.options[Math.floor(r() * field.options.length)]
    case "toggle":
      return r() >= 0.5
    // Springs, colours and curves stay in the range people actually use.
    case "spring":
      return { duration: between(0.2, 0.9, r()), bounce: between(0, 0.45, r()) }
    case "color": {
      const l = between(0.5, 0.85, r())
      const h = between(0, 360, r())
      return { l, c: between(0.25, 0.85, r()) * maxChroma(l, h), h }
    }
    case "point":
      return {
        x: lattice(field.min.x, field.max.x, field.step.x, r()),
        y: lattice(field.min.y, field.max.y, field.step.y, r()),
      }
    case "easing": {
      const curves = Object.values(EASINGS)
      return curves[Math.floor(r() * curves.length)]
    }
    case "vec": {
      const axis = () => lattice(field.min, field.max, field.step, r())
      return field.axes === 3 ? { x: axis(), y: axis(), z: axis() } : { x: axis(), y: axis() }
    }
    case "range":
      return [
        lattice(field.min, field.max, field.step, r()),
        lattice(field.min, field.max, field.step, r()),
      ]
    case "angle": {
      // A wrapping angle never lands on its max (the same direction as its min).
      const top = field.wrap ? field.max - field.step : field.max
      return lattice(field.min, Math.max(field.min, top), field.step, r())
    }
    case "seed":
      return lattice(field.min, field.max, 1, r())
    case "keybind":
      return field.value
    // A ramp keeps its stop count and reads as one ramp; a curve takes a built-in shape.
    case "gradient":
      return randomStops(field.value.length, r)
    case "curve":
      return randomPoints(field.range, r)
  }
}

/**
 * How far Random strays from an active preset. A number lands in a window 35% of its range wide,
 * centred on the preset's value and slid inward at an end so it keeps its width: far enough to
 * be a new take, near enough to stay recognisably that preset (Mutate moves 8–12% from the
 * current values; a free roll covers 100%). Choices and opted-in switches keep the preset's
 * pick, changing `switch` of the time. Colours keep their family: hue within ±`hue`°,
 * lightness ±`lightness`, chroma ±`chroma` of what that hue can hold. Seeds roll freely: a new
 * pattern is what a seed is for.
 */
export const AROUND = {
  spread: 0.35,
  switch: 0.3,
  hue: 20,
  lightness: 0.06,
  chroma: 0.15,
} as const

/** A step-lattice value drawn from a window `AROUND.spread` of the range wide around `v`. */
function near(v: number, min: number, max: number, step: number, r: number, reach = max - min) {
  const span = max - min
  if (!(span > 0)) return v
  const width = Math.min(span, reach * AROUND.spread)
  const lo = Math.max(min, Math.min(max - width, v - width / 2))
  const top = Math.floor(span / step + 1e-9)
  const a = Math.max(0, Math.ceil((lo - min) / step - 1e-9))
  const b = Math.min(top, Math.floor((lo + width - min) / step + 1e-9))
  const n = b < a ? Math.round((v - min) / step) : a + Math.floor(r * (b - a + 1))
  return Number((min + Math.max(0, Math.min(top, n)) * step).toPrecision(14))
}
const unit = (r: number) => r * 2 - 1

/**
 * One field's roll around `base` (an active preset's value): see `AROUND`. Fields with nothing
 * to vary around (keys, seeds) roll as `pick` does.
 */
export function around(field: ValueField, base: unknown, random: () => number): unknown {
  const r = () => Math.max(0, Math.min(1 - Number.EPSILON, random()))
  switch (field.kind) {
    case "knob":
      return near(base as number, field.min, field.max, field.step, r())
    case "choice": {
      if (field.options.length < 2 || r() >= AROUND.switch) return base
      const rest = field.options.filter((o) => o !== base)
      return rest[Math.floor(r() * rest.length)]
    }
    case "toggle":
      return r() < AROUND.switch ? !base : base
    case "spring": {
      // The share of the range Random draws springs from (0.2–0.9 s, bounce 0–0.45).
      const s = base as SpringValue
      const d = SPRING.duration
      const b = SPRING.bounce
      return {
        duration: near(s.duration, d.min, d.max, d.step, r(), 0.7),
        bounce: near(s.bounce, b.min, b.max, b.step, r(), 0.45),
      }
    }
    case "color": {
      const c = parseColor(base) ?? { l: 0.7, c: 0.1, h: 0 }
      const max0 = maxChroma(c.l, c.h)
      const rel = max0 > 1e-4 ? Math.min(1, Math.max(0, c.c / max0)) : 0.5
      const h = (c.h + unit(r()) * AROUND.hue + 360) % 360
      const l = Math.min(1, Math.max(0, c.l + unit(r()) * AROUND.lightness))
      const k = Math.min(1, Math.max(0, rel + unit(r()) * AROUND.chroma))
      return { l, c: k * maxChroma(l, h), h }
    }
    case "point": {
      const p = base as { x: number; y: number }
      return {
        x: near(p.x, field.min.x, field.max.x, field.step.x, r()),
        y: near(p.y, field.min.y, field.max.y, field.step.y, r()),
      }
    }
    case "easing":
      return (base as readonly number[]).map((v, i) => {
        const [lo, hi] = i % 2 === 0 ? [0, 1] : EASING_Y
        return near(v, lo, hi, 0.001, r())
      })
    case "vec": {
      const v = base as { x: number; y: number; z?: number }
      const axis = (n: number) => near(n, field.min, field.max, field.step, r())
      return field.axes === 3
        ? { x: axis(v.x), y: axis(v.y), z: axis(v.z ?? 0) }
        : { x: axis(v.x), y: axis(v.y) }
    }
    case "range": {
      const [a, b] = base as readonly [number, number]
      return [
        near(a, field.min, field.max, field.step, r()),
        near(b, field.min, field.max, field.step, r()),
      ]
    }
    case "angle": {
      const v = base as number
      if (!field.wrap) return near(v, field.min, field.max, field.step, r())
      // A wrapping dial's window turns past its ends instead of sliding inward.
      const span = field.max - field.min
      return v + unit(r()) * span * (AROUND.spread / 2)
    }
    case "gradient":
      return mutateStops(
        base as readonly GradientStop[],
        r,
        [AROUND.hue / 2, AROUND.hue],
        [AROUND.lightness / 2, AROUND.lightness],
      )
    case "curve":
      return mutatePoints(base as readonly CurvePoint[], field.range, r, [
        AROUND.spread / 2,
        AROUND.spread,
      ])
    case "seed":
    case "keybind":
      return pick(field, random)
  }
}

export function randomValues<S extends Schema>(schema: S, random = Math.random): Values<S> {
  return normalize(
    schema,
    Object.fromEntries(
      Object.entries(schema).flatMap(([key, field]) =>
        hasValue(field) ? [[key, pick(field, random)]] : [],
      ),
    ),
  )
}
