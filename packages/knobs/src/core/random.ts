import { maxChroma } from "./color.js"
import { EASINGS } from "./easing.js"
import { hasValue, normalize, type Schema, type ValueField, type Values } from "./schema.js"

const lattice = (min: number, max: number, step: number, r: number) =>
  min + Math.floor(r * (Math.floor((max - min) / step + 1e-9) + 1)) * step
const between = (min: number, max: number, r: number) => min + (max - min) * r

function pick(field: ValueField, random: () => number) {
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
