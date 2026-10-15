import { fitColor, formatColor, parseColor, type Oklch } from "./color.js"
import { EASING_Y, namedEasing, type Bezier, type EasingName } from "./easing.js"
import type { SpringValue } from "./spring.js"

export interface FieldMeta {
  readonly label?: string
  readonly group?: string
  /**
   * What the group's header shows when it isn't the `group` id itself (the first field that
   * gives one wins). The id stays the group's identity: presets, resets, highlights and code.
   */
  readonly groupLabel?: string
  /** A page region the field's group sits in (see `mountPage`); panels ignore it. */
  readonly section?: string
  /** What the section's heading shows (the first field that gives one wins); `section` by default. */
  readonly sectionLabel?: string
  readonly shortcut?: string
}
/** Marks a knob as half of a flat spring: two number keys drawn as one spring card. */
export interface SpringPart {
  /** Shared by both halves; the card sits where the first of them is. */
  readonly id: string
  readonly part: "duration" | "bounce"
  /** The card's title (taken from the duration half). */
  readonly label?: string
}
export interface Knob extends FieldMeta {
  readonly kind: "knob"
  readonly value: number
  readonly min: number
  readonly max: number
  readonly step: number
  readonly unit?: string
  /** Digits after the point in the readout; the step's own by default. */
  readonly decimals?: number
  readonly spring?: SpringPart
}
export interface Choice<T extends string = string> extends FieldMeta {
  readonly kind: "choice"
  readonly value: T
  readonly options: readonly T[]
  /** What each option reads as, when it isn't the option itself (`{ md: "Medium" }`). */
  readonly labels?: Readonly<Record<string, string>>
  /**
   * Segments or a drop-down menu. By default it's segmented while the labels fit with room to
   * spare and there are at most four options, and a menu otherwise, switching as the width changes.
   */
  readonly display?: "menu" | "segmented"
}
export interface Toggle extends FieldMeta {
  readonly kind: "toggle"
  readonly value: boolean
}
export interface SpringField extends FieldMeta {
  readonly kind: "spring"
  readonly value: SpringValue
}
/** The value is an `oklch(L C H)` string, usable as-is in CSS and always inside sRGB. */
export interface ColorField extends FieldMeta {
  readonly kind: "color"
  readonly value: string
}
export interface Point {
  readonly x: number
  readonly y: number
}
export interface PointField extends FieldMeta {
  readonly kind: "point"
  readonly value: Point
  readonly min: Point
  readonly max: Point
  readonly step: Point
}
export interface EasingField extends FieldMeta {
  readonly kind: "easing"
  readonly value: Bezier
}
/** A button row. It holds no value: pressing it calls `run` and the store's `onAction(key)`. */
export interface ActionField extends FieldMeta {
  readonly kind: "action"
  readonly run?: () => void
}
export type ValueField =
  | Knob
  | Choice
  | Toggle
  | SpringField
  | ColorField
  | PointField
  | EasingField
export type Field = ValueField | ActionField
export type Schema = Readonly<Record<string, Field>>
export type FieldValue<F extends Field> = F extends Knob
  ? number
  : F extends Choice<infer T>
    ? T
    : F extends Toggle
      ? boolean
      : F extends SpringField
        ? SpringValue
        : F extends ColorField
          ? string
          : F extends PointField
            ? Point
            : F extends EasingField
              ? Bezier
              : never
/** Action keys map to `never`: they hold no value and are absent at runtime. */
export type Values<S extends Schema> = {
  readonly [K in keyof S]: FieldValue<S[K]>
}
export type Value = number | string | boolean | SpringValue | Point | Bezier
export type State = Readonly<Record<string, Value>>

/** Ranges for spring fields: duration in seconds, and SwiftUI's bounce (below 0 is overdamped). */
export const SPRING = {
  duration: { min: 0.05, max: 2, step: 0.01 },
  bounce: { min: -0.5, max: 1, step: 0.01 },
} as const

function checkShortcut(shortcut?: string) {
  if (shortcut !== undefined && !/^[a-z]$/i.test(shortcut))
    throw new Error("Shortcut must be a letter.")
}
/** The keys that hold values (every field but actions). */
export function valueKeys(schema: Schema): string[] {
  return Object.keys(schema).filter((k) => schema[k]!.kind !== "action")
}
function withMeta<T extends object>(base: T, meta?: FieldMeta): T {
  checkShortcut(meta?.shortcut)
  return Object.freeze({
    ...base,
    ...(meta?.label !== undefined ? { label: meta.label } : {}),
    ...(meta?.group !== undefined ? { group: meta.group } : {}),
    ...(meta?.groupLabel !== undefined ? { groupLabel: meta.groupLabel } : {}),
    ...(meta?.section !== undefined ? { section: meta.section } : {}),
    ...(meta?.sectionLabel !== undefined ? { sectionLabel: meta.sectionLabel } : {}),
    ...(meta?.shortcut !== undefined ? { shortcut: meta.shortcut } : {}),
  })
}

export function knob(
  value: number,
  options: Omit<Knob, "kind" | "value" | "step"> & { step?: number },
): Knob {
  const step = options.step ?? ((options.max - options.min) / 100 || 1)
  if (
    ![value, options.min, options.max, step].every(Number.isFinite) ||
    options.max < options.min ||
    step <= 0
  )
    throw new Error("A knob needs finite bounds and a positive step.")
  if (
    options.decimals !== undefined &&
    !(Number.isInteger(options.decimals) && options.decimals >= 0)
  )
    throw new Error("A knob's decimals must be a whole number.")
  checkShortcut(options.shortcut)
  const field: Knob = { ...options, kind: "knob", value, step }
  return Object.freeze({ ...field, value: normalizeField(field, value) as number })
}
export function choice<const T extends readonly [string, ...string[]]>(
  value: T[number],
  options: T,
  meta?: FieldMeta & {
    readonly labels?: Readonly<Partial<Record<T[number], string>>>
    readonly display?: "menu" | "segmented"
  },
): Choice<T[number]> {
  if (!options.includes(value) || new Set(options).size !== options.length)
    throw new Error("Invalid choice options/default.")
  const labels = meta?.labels
    ? Object.freeze(
        Object.fromEntries(
          Object.entries(meta.labels).filter(
            ([k, v]) => options.includes(k) && typeof v === "string" && v !== k,
          ),
        ) as Record<string, string>,
      )
    : undefined
  return withMeta(
    {
      kind: "choice" as const,
      value,
      options: Object.freeze([...options]),
      ...(labels && Object.keys(labels).length ? { labels } : {}),
      ...(meta?.display ? { display: meta.display } : {}),
    },
    meta,
  )
}
/** `action("Replay", { run })`: a button row. Its key also reaches the store's `onAction`. */
export function action(label?: string, meta?: Omit<FieldMeta, "label"> & { run?: () => void }) {
  const field: ActionField = withMeta(
    { kind: "action" as const, ...(meta?.run ? { run: meta.run } : {}) },
    { ...meta, ...(label !== undefined ? { label } : {}) },
  )
  return field
}
type SpringHalf = number | Knob
/**
 * A flat spring: two plain number fields (`{ duration, bounce }` as separate keys) drawn as one
 * spring card with a curve and two sliders. Spread the result into a schema, or rename its halves:
 * `defineControls("m", { ...flatSpring({ duration: 0.45, bounce: 0.3 }, { label: "Spring" }) })`.
 */
export function flatSpring(
  parts: { duration?: SpringHalf; bounce?: SpringHalf } = {},
  meta: Omit<FieldMeta, "shortcut"> & { id?: string } = {},
): { readonly duration: Knob; readonly bounce: Knob } {
  const id = meta.id ?? meta.label ?? `spring-${++springIds}`
  const half = (part: "duration" | "bounce", input: SpringHalf | undefined, fallback: number) => {
    const base =
      typeof input === "object"
        ? input
        : knob(input ?? fallback, {
            ...SPRING[part],
            ...(part === "duration" ? { unit: "s" } : {}),
          })
    return Object.freeze({
      ...base,
      ...(base.label === undefined ? { label: part === "duration" ? "Duration" : "Bounce" } : {}),
      ...(meta.group !== undefined ? { group: meta.group } : {}),
      ...(meta.groupLabel !== undefined ? { groupLabel: meta.groupLabel } : {}),
      ...(meta.section !== undefined ? { section: meta.section } : {}),
      ...(meta.sectionLabel !== undefined ? { sectionLabel: meta.sectionLabel } : {}),
      spring: Object.freeze({
        id,
        part,
        ...(meta.label !== undefined ? { label: meta.label } : {}),
      }),
    }) as Knob
  }
  return {
    duration: half("duration", parts.duration, 0.5),
    bounce: half("bounce", parts.bounce, 0),
  }
}
let springIds = 0
export function toggle(value: boolean, meta?: FieldMeta): Toggle {
  return withMeta({ kind: "toggle" as const, value }, meta)
}
/** `spring({ duration: 0.4, bounce: 0.2 })`, like SwiftUI's `.spring(duration:bounce:)`. */
export function spring(value: Partial<SpringValue> = {}, meta?: FieldMeta): SpringField {
  const field = { kind: "spring" as const, value: { duration: 0.5, bounce: 0 } }
  return withMeta({ ...field, value: normalizeField(field, value) as SpringValue }, meta)
}
/** `color("#4f8cff")`, `color("oklch(0.7 0.15 250)")` or `color({ l, c, h })`. */
export function color(value: string | Oklch, meta?: FieldMeta): ColorField {
  const parsed = parseColor(value)
  if (!parsed) throw new Error("A color needs #rgb, #rrggbb, oklch(L C H) or { l, c, h }.")
  return withMeta({ kind: "color" as const, value: formatColor(fitColor(parsed)) }, meta)
}
type Axis = number | Point
const axes = (v: Axis): Point => (typeof v === "number" ? { x: v, y: v } : v)
/** A 2D pad: `point({ x: 0, y: 0 }, { min: -1, max: 1 })`; bounds and step take a number or `{ x, y }`. */
export function point(
  value: Point,
  options: FieldMeta & { min: Axis; max: Axis; step?: Axis },
): PointField {
  const min = axes(options.min)
  const max = axes(options.max)
  const step = options.step === undefined ? undefined : axes(options.step)
  const field = {
    kind: "point" as const,
    value,
    min: Object.freeze({ ...min }),
    max: Object.freeze({ ...max }),
    step: Object.freeze({
      x: step?.x ?? ((max.x - min.x) / 100 || 1),
      y: step?.y ?? ((max.y - min.y) / 100 || 1),
    }),
  }
  const numbers = [value.x, value.y, min.x, min.y, max.x, max.y, field.step.x, field.step.y]
  if (
    !numbers.every(Number.isFinite) ||
    max.x < min.x ||
    max.y < min.y ||
    field.step.x <= 0 ||
    field.step.y <= 0
  )
    throw new Error("A point needs finite bounds and positive steps.")
  return withMeta({ ...field, value: normalizeField(field as PointField, value) as Point }, options)
}
/** A cubic bezier `[x1, y1, x2, y2]` or a name: ease, ease-in, ease-out, ease-in-out, linear, smooth, snappy, back. */
export function easing(value: Bezier | EasingName, meta?: FieldMeta): EasingField {
  const curve = typeof value === "string" ? namedEasing(value) : value
  if (!curve || curve.length !== 4 || !curve.every(Number.isFinite))
    throw new Error("An easing needs four finite numbers or a known name.")
  const field = { kind: "easing" as const, value: curve }
  return withMeta({ ...field, value: normalizeField(field, curve) as Bezier }, meta)
}

const snap = (v: number, min: number, max: number, step: number) => {
  const bounded = Math.max(min, Math.min(max, v))
  const steps = Math.min(Math.floor((max - min) / step + 1e-9), Math.round((bounded - min) / step))
  return Number((min + steps * step).toPrecision(14))
}
const num = (v: unknown, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback

export function normalizeField(field: ValueField, input: unknown): Value {
  switch (field.kind) {
    case "knob":
      // Declared defaults, presets and remote values are kept exactly (clamped): a default of 0.4
      // on a 0.02 grid from 0.15 stays 0.4, as on the phone. The slider snaps the user's own travel.
      if (typeof input !== "number" || !Number.isFinite(input)) return field.value
      {
        const clamped = Math.min(field.max, Math.max(field.min, input))
        // Whole-number fields (an Int on the phone) stay whole.
        const whole = Number.isInteger(field.step) && Number.isInteger(field.min)
        return whole ? Math.round(clamped) : Number(clamped.toPrecision(14))
      }
    case "choice":
      return typeof input === "string" && field.options.includes(input) ? input : field.value
    case "toggle":
      return typeof input === "boolean" ? input : field.value
    case "spring": {
      const v = isRecord(input) ? input : {}
      const { duration: d, bounce: b } = SPRING
      return Object.freeze({
        duration: snap(num(v.duration, field.value.duration), d.min, d.max, d.step),
        bounce: snap(num(v.bounce, field.value.bounce), b.min, b.max, b.step),
      })
    }
    case "color": {
      const parsed = parseColor(input)
      return parsed ? formatColor(fitColor(parsed)) : field.value
    }
    case "point": {
      const v = isRecord(input) ? input : {}
      return Object.freeze({
        x: snap(num(v.x, field.value.x), field.min.x, field.max.x, field.step.x),
        y: snap(num(v.y, field.value.y), field.min.y, field.max.y, field.step.y),
      })
    }
    case "easing": {
      const v = Array.isArray(input) && input.length === 4 ? input : field.value
      return Object.freeze(
        [0, 1, 2, 3].map((i) =>
          i % 2 === 0
            ? snap(num(v[i], field.value[i]!), 0, 1, 0.01)
            : snap(num(v[i], field.value[i]!), EASING_Y[0], EASING_Y[1], 0.01),
        ),
      ) as unknown as Bezier
    }
  }
}
export function normalize<S extends Schema>(schema: S, input: unknown): Values<S> {
  const record = isRecord(input) ? input : {}
  return Object.freeze(
    Object.fromEntries(
      Object.entries(schema).flatMap(([key, field]) =>
        field.kind === "action" ? [] : [[key, normalizeField(field, record[key])]],
      ),
    ),
  ) as Values<S>
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
/** Value equality: springs, points and curves compare by their numbers. */
export function same(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false
  const ka = Object.keys(a)
  return (
    ka.length === Object.keys(b).length &&
    ka.every((k) => (a as Record<string, unknown>)[k] === (b as Record<string, unknown>)[k])
  )
}
export function equal(a: State, b: State): boolean {
  return (
    Object.keys(a).length === Object.keys(b).length &&
    Object.keys(a).every((key) => same(a[key], b[key]))
  )
}
