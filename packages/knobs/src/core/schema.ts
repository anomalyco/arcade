import { fitColor, formatColor, parseColor, type Oklch } from "./color.js"
import { EASING_Y, namedEasing, type Bezier, type EasingName } from "./easing.js"
import { normalizeCombo } from "./keys.js"
import type { LogEntry, TableRows } from "./readout.js"
import {
  CURVE_SHAPES,
  inRange,
  normalizePoints,
  normalizeStops,
  type CurveInterp,
  type CurvePoint,
  type GradientSpace,
  type GradientStop,
} from "./ramp.js"
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
  /** One muted line under the group's card title on a page (the first field that gives one wins). */
  readonly groupDescription?: string
  /** One muted line under the section's heading on a page (the first field that gives one wins). */
  readonly sectionDescription?: string
  readonly shortcut?: string
  /** `false` keeps the field out of Random and Mutate, as a lock does, but by declaration. */
  readonly random?: boolean
  /**
   * The row dims and takes no edits from the pointer or keys (focus can still reach it, to read
   * it); Random, Mutate and Reset skip it. A function decides from the current values, e.g.
   * `(v) => v.light !== "spot"`.
   */
  readonly disabled?: boolean | ((values: State) => boolean)
  /** Shows the value at full strength but takes no edits; Random, Mutate and Reset skip it. */
  readonly readOnly?: boolean | ((values: State) => boolean)
  /**
   * The group's card starts folded (the first field of a group that says wins), and its header
   * folds and opens it, in a panel or a page. `groupFolded` (on the mount, then the store)
   * overrides it, and on a page what the user last chose wins over both.
   */
  readonly folded?: boolean
  /**
   * On a page, the field's section starts folded to its heading (the first field of a section
   * that says wins), and the heading folds and opens it. `sectionFolded` (on the mount, then the
   * store) overrides it, and what the user last chose wins over both.
   */
  readonly sectionFolded?: boolean
  /**
   * The panel tab the field sits on (`mountPanel` draws a tab strip once any field names one).
   * Fields without a tab show on every tab.
   */
  readonly tab?: string
  /**
   * A collapsible sub-heading inside the field's group: a flat heading with a hairline, never a
   * card inside the card. Consecutive fields that share it sit under one heading.
   */
  readonly subsection?: string
}
/** Meta keys copied from a field's options or a descriptor onto the field. */
export const META_KEYS = [
  "label",
  "group",
  "groupLabel",
  "section",
  "sectionLabel",
  "groupDescription",
  "sectionDescription",
  "shortcut",
  "random",
  "disabled",
  "readOnly",
  "folded",
  "sectionFolded",
  "tab",
  "subsection",
] as const satisfies readonly (keyof FieldMeta)[]
/** The meta `source` gives, without undefined keys. */
export function pickMeta(source: FieldMeta | undefined, skip: readonly string[] = []): FieldMeta {
  const out: Record<string, unknown> = {}
  if (source)
    for (const k of META_KEYS) if (source[k] !== undefined && !skip.includes(k)) out[k] = source[k]
  return out as FieldMeta
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
/** Colour over a 0…1 parameter (over life, over the day): stops sorted by position. */
export interface GradientField extends FieldMeta {
  readonly kind: "gradient"
  readonly value: readonly GradientStop[]
  /** How the stops blend: `oklab` (perceptual, the default) or `srgb` (as CSS does). */
  readonly space: GradientSpace
  /** Named ramps offered as chips in the editor. */
  readonly presets?: Readonly<Record<string, readonly GradientStop[]>>
}
/** A number over 0…1 (a falloff, a response): points sorted by x, the ends pinned at 0 and 1. */
export interface CurveField extends FieldMeta {
  readonly kind: "curve"
  readonly value: readonly CurvePoint[]
  /** The y range, 0…1 by default. */
  readonly range: readonly [number, number]
  readonly interp: CurveInterp
  /** Named shapes offered as chips (y in `range`), after the built-in ones unless `shapes: false`. */
  readonly presets?: Readonly<Record<string, readonly CurvePoint[]>>
  /** The built-in shapes (linear, ease-out, inverse², smoothstep, bell) as chips; on by default. */
  readonly shapes: boolean
}
/** A button row. It holds no value: pressing it calls `run` and the store's `onAction(key)`. */
export interface ActionField extends FieldMeta {
  readonly kind: "action"
  readonly run?: () => void
}
export interface Vec3 {
  readonly x: number
  readonly y: number
  readonly z: number
}
/** `vec2` / `vec3`: inline x, y (and z) number cells, each scrubbed or typed. */
export interface VecField<N extends 2 | 3 = 2 | 3> extends FieldMeta {
  readonly kind: "vec"
  readonly axes: N
  readonly value: N extends 3 ? Vec3 : Point
  readonly min: number
  readonly max: number
  readonly step: number
  readonly unit?: string
  readonly decimals?: number
  /** Shows a link toggle: while linked, changing one cell scales the others with it. */
  readonly link?: boolean
  /** Starts linked (implies `link`). */
  readonly linked?: boolean
}
/** A `[low, high]` pair on one slider with two thumbs that can't cross. */
export interface RangeField extends FieldMeta {
  readonly kind: "range"
  readonly value: readonly [number, number]
  readonly min: number
  readonly max: number
  readonly step: number
  readonly unit?: string
  readonly decimals?: number
}
/** Degrees on a dial; `wrap` (a full turn by default) carries 359° on to 0°. */
export interface AngleField extends FieldMeta {
  readonly kind: "angle"
  readonly value: number
  readonly min: number
  readonly max: number
  readonly step: number
  readonly wrap: boolean
}
/** A whole number with a die that rolls a new one; out of Random and Mutate unless `random: true`. */
export interface SeedField extends FieldMeta {
  readonly kind: "seed"
  readonly value: number
  readonly min: number
  readonly max: number
}
/** A key combination such as `"Meta+Shift+K"` (`""` for none), captured by pressing it. */
export interface KeybindField extends FieldMeta {
  readonly kind: "keybind"
  readonly value: string
}
/** A toolbar button: an optional icon, a label and a shortcut chip. */
export interface ToolbarItem {
  /** Reported to `onAction`; the label by default. */
  readonly id?: string
  readonly label: string
  /** A built-in icon name (`play`, `frame`, `retrigger`, …) or SVG path data on a 256 grid. */
  readonly icon?: string
  /** A key or combination (`"Space"`, `"f"`, `"Shift+P"`): it presses the button. */
  readonly shortcut?: string
  /** The shortcut works anywhere on the page, not only while the panel has focus. */
  readonly global?: boolean
  readonly disabled?: boolean
  readonly run?: () => void
}
/** A row of buttons that wrap; holds no value. Each press calls its `run` and `onAction(id)`. */
export interface ToolbarField extends FieldMeta {
  readonly kind: "toolbar"
  readonly items: readonly ToolbarItem[]
}
export type ValueField =
  | Knob
  | Choice
  | Toggle
  | SpringField
  | ColorField
  | PointField
  | EasingField
  | VecField
  | RangeField
  | AngleField
  | SeedField
  | KeybindField
  | GradientField
  | CurveField
/** A readout's own: polled while its row shows, instead of pushed with `controls.watch`. */
interface ReadoutMeta extends FieldMeta {
  /** Read each frame while the row is on screen (pushing with `controls.watch` is the other way). */
  readonly get?: () => unknown
  readonly unit?: string
  /** Digits after the point; by default fewer as the number grows (2 under 10, 1 under 100). */
  readonly decimals?: number
  /** Text for a value, in place of the number and unit. */
  readonly format?: (value: number) => string
  /** How often the text may change, per second (4 by default): readable, never a blur. */
  readonly hz?: number
}
/** A live number or text, with an optional unit; holds nothing in the store's values. */
export interface WatchField extends ReadoutMeta {
  readonly kind: "watch"
}
/** A watch with a small history graph in its row, auto-scaled. */
export interface SparklineField extends ReadoutMeta {
  readonly kind: "sparkline"
  /** Samples kept (60 by default). */
  readonly history: number
  /** A fixed floor or ceiling for the scale; it fits the samples otherwise. */
  readonly min?: number
  readonly max?: number
  /** The line's colour (any CSS colour), the accent by default. */
  readonly color?: string
}
export interface GraphSeries {
  readonly id: string
  readonly label?: string
  /** Any CSS colour; the accent, then a palette, by default. */
  readonly color?: string
  /** Fills the area under the line. */
  readonly area?: boolean
}
export interface GraphThreshold {
  readonly value: number
  readonly label?: string
  readonly color?: string
}
/** A taller row: a multi-series line or area graph with thresholds and a hover crosshair. */
export interface GraphField extends ReadoutMeta {
  readonly kind: "graph"
  readonly series: readonly GraphSeries[]
  /** Samples kept per series (120 by default). */
  readonly history: number
  /** The plot's height in px (64 by default). */
  readonly height: number
  /** A fixed range; each bound left out fits the samples (with thresholds kept in view). */
  readonly min?: number
  readonly max?: number
  readonly thresholds: readonly GraphThreshold[]
}
/** A bar for a value out of a maximum; `null` makes it indeterminate. */
export interface MeterField extends ReadoutMeta {
  readonly kind: "meter"
  readonly min: number
  readonly max: number
  /** Splits the bar into this many cells. */
  readonly segments?: number
  /** From this value on, the bar turns the warning colour (`--k-warn`). */
  readonly warn?: number
  /** From this value on, the critical colour (`--k-critical`). */
  readonly critical?: number
}
/** A compact table of 2–4 columns: rows of cells, or a key-value record. */
export interface TableField extends ReadoutMeta {
  readonly kind: "table"
  /** Column headings; the first sits under the row's label. */
  readonly columns?: readonly string[]
}
/** A scrolling log with levels, a filter, follow-tail and copy. */
export interface LogField extends ReadoutMeta {
  readonly kind: "log"
  /** Lines shown (8 by default). */
  readonly lines: number
  /** Entries kept (1000 by default). */
  readonly max: number
}
export type ReadoutField =
  | WatchField
  | SparklineField
  | GraphField
  | MeterField
  | TableField
  | LogField
export type Field = ValueField | ActionField | ToolbarField | ReadoutField
const READOUT_KINDS = new Set(["watch", "sparkline", "graph", "meter", "table", "log"])
/** Whether a field is a readout (it shows pushed values and holds none). */
export const isReadout = (field: { readonly kind: string }): field is ReadoutField =>
  READOUT_KINDS.has(field.kind)
/** Whether a field holds a value (actions, toolbars and readouts don't). */
export const hasValue = (field: Field): field is ValueField =>
  field.kind !== "action" && field.kind !== "toolbar" && !READOUT_KINDS.has(field.kind)
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
              : F extends VecField<3>
                ? Vec3
                : F extends VecField<2>
                  ? Point
                  : F extends RangeField
                    ? readonly [number, number]
                    : F extends AngleField | SeedField
                      ? number
                      : F extends KeybindField
                        ? string
                        : F extends GradientField
                          ? readonly GradientStop[]
                          : F extends CurveField
                            ? readonly CurvePoint[]
                            : never
/** The keys of a schema's readouts (what `controls.watch` takes). */
export type ReadoutKeys<S extends Schema> = {
  [K in keyof S]: [S[K] & ReadoutField] extends [never] ? never : K
}[keyof S] &
  string
/** What a readout takes from `controls.watch` (`null` clears it). */
export type ReadoutInput<F> = F extends WatchField
  ? number | string | null
  : F extends SparklineField
    ? number | readonly number[] | null
    : F extends GraphField
      ? number | Readonly<Record<string, number>> | null
      : F extends MeterField
        ? number | null
        : F extends TableField
          ? TableRows | null
          : F extends LogField
            ? string | LogEntry | readonly (string | LogEntry)[] | null
            : never
/** Action keys map to `never`: they hold no value and are absent at runtime. */
export type Values<S extends Schema> = {
  readonly [K in keyof S]: FieldValue<S[K]>
}
export type Value =
  | number
  | string
  | boolean
  | SpringValue
  | Point
  | Vec3
  | Bezier
  | readonly [number, number]
  | readonly GradientStop[]
  | readonly CurvePoint[]
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
  return Object.keys(schema).filter((k) => hasValue(schema[k]!))
}
function withMeta<T extends object>(base: T, meta?: FieldMeta): T {
  checkShortcut(meta?.shortcut)
  return Object.freeze({ ...base, ...pickMeta(meta) })
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
      ...pickMeta(meta, ["label", "shortcut"]),
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

interface NumberOptions {
  readonly min: number
  readonly max: number
  readonly step?: number
  readonly unit?: string
  readonly decimals?: number
}
/** Checks a number field's bounds and returns its step (a hundredth of the range by default). */
function bounds(o: NumberOptions, what: string): number {
  const step = o.step ?? ((o.max - o.min) / 100 || 1)
  if (![o.min, o.max, step].every(Number.isFinite) || o.max < o.min || step <= 0)
    throw new Error(`${what} needs finite bounds and a positive step.`)
  if (o.decimals !== undefined && !(Number.isInteger(o.decimals) && o.decimals >= 0))
    throw new Error(`${what}'s decimals must be a whole number.`)
  return step
}
const numberMeta = (o: NumberOptions) => ({
  ...(o.unit !== undefined ? { unit: o.unit } : {}),
  ...(o.decimals !== undefined ? { decimals: o.decimals } : {}),
})
type VecOptions = FieldMeta & NumberOptions & { readonly link?: boolean; readonly linked?: boolean }
function vec<N extends 2 | 3>(axes: N, value: Point | Vec3, options: VecOptions): VecField<N> {
  const step = bounds(options, "A vector")
  const field = {
    kind: "vec" as const,
    axes,
    value: value as VecField<N>["value"],
    min: options.min,
    max: options.max,
    step,
    ...numberMeta(options),
    ...(options.link || options.linked ? { link: true } : {}),
    ...(options.linked ? { linked: true } : {}),
  } as VecField<N>
  return withMeta(
    { ...field, value: normalizeField(field, value) as VecField<N>["value"] },
    options,
  )
}
/** Inline x and y cells: `vec2({ x: 0, y: 1 }, { min: -10, max: 10, step: 0.1 })`. */
export function vec2(value: Point, options: VecOptions): VecField<2> {
  return vec(2, value, options)
}
/** Inline x, y and z cells, with an optional link for uniform scaling (`link: true`). */
export function vec3(value: Vec3, options: VecOptions): VecField<3> {
  return vec(3, value, options)
}
/** A low–high pair on one slider: `range([0.2, 0.8], { min: 0, max: 1 })`. */
export function range(value: readonly [number, number], options: FieldMeta & NumberOptions) {
  const step = bounds(options, "A range")
  const field: RangeField = {
    kind: "range",
    value,
    min: options.min,
    max: options.max,
    step,
    ...numberMeta(options),
  }
  return withMeta(
    { ...field, value: normalizeField(field, value) as readonly [number, number] },
    options,
  )
}
/** Degrees on a dial (0–360 and wrapping by default): `angle(45)`, `angle(30, { min: -90, max: 90 })`. */
export function angle(
  value: number,
  options: FieldMeta & { min?: number; max?: number; step?: number; wrap?: boolean } = {},
): AngleField {
  const min = options.min ?? 0
  const max = options.max ?? 360
  const step = options.step ?? 1
  bounds({ min, max, step }, "An angle")
  const field: AngleField = {
    kind: "angle",
    value,
    min,
    max,
    step,
    wrap: options.wrap ?? max - min === 360,
  }
  return withMeta({ ...field, value: normalizeField(field, value) as number }, options)
}
/** A seed with a die that rolls a new one; Random and Mutate leave it alone unless `random: true`. */
export function seed(
  value: number,
  options: FieldMeta & { min?: number; max?: number } = {},
): SeedField {
  const field: SeedField = {
    kind: "seed",
    value,
    min: Math.ceil(options.min ?? 0),
    max: Math.floor(options.max ?? 999_999),
  }
  bounds({ min: field.min, max: field.max, step: 1 }, "A seed")
  return withMeta(
    { ...field, value: normalizeField(field, value) as number },
    { random: false, ...options },
  )
}
/** A key combination captured by pressing it (`"Meta+Shift+K"`, `""` for none). */
export function keybind(value = "", meta?: FieldMeta): KeybindField {
  const field: KeybindField = { kind: "keybind", value: normalizeCombo(value) }
  return withMeta(field, { random: false, ...meta })
}
/**
 * Colour over a 0…1 parameter: `gradient([{ at: 0, color: "#fff4d6" }, { at: 1, color: "#20242c" }])`.
 * Colours take what `color` takes and are kept as `oklch()` strings. `space` blends in `oklab`
 * (default) or `srgb`; `presets` are named ramps offered as chips. Sample it with `sampleGradient`.
 */
export function gradient(
  stops: readonly {
    readonly at: number
    readonly color: string | { l: number; c: number; h: number }
  }[],
  options: FieldMeta & {
    readonly space?: GradientSpace
    readonly presets?: Readonly<Record<string, readonly { at: number; color: string }[]>>
  } = {},
): GradientField {
  const value = normalizeStops(stops)
  if (!value) throw new Error("A gradient needs at least two stops with a position and a colour.")
  const presets = options.presets
    ? Object.freeze(
        Object.fromEntries(
          Object.entries(options.presets).flatMap(([name, p]) => {
            const s = normalizeStops(p)
            return s ? [[name, s]] : []
          }),
        ),
      )
    : undefined
  return withMeta(
    {
      kind: "gradient" as const,
      value,
      space: options.space ?? "oklab",
      ...(presets && Object.keys(presets).length ? { presets } : {}),
    },
    options,
  )
}
/**
 * A number over 0…1: `curve([{ x: 0, y: 1 }, { x: 1, y: 0 }], { range: [0, 1], interp: "smooth" })`.
 * The ends are pinned at x 0 and 1. `smooth` is a monotone cubic (no overshoot); `linear` and
 * `step` join the points as they say. Sample it with `sampleCurve`.
 */
export function curve(
  points: readonly CurvePoint[] | keyof typeof CURVE_SHAPES,
  options: FieldMeta & {
    readonly range?: readonly [number, number]
    readonly interp?: CurveInterp
    readonly presets?: Readonly<Record<string, readonly CurvePoint[]>>
    readonly shapes?: boolean
  } = {},
): CurveField {
  const range = options.range ?? [0, 1]
  if (!(Number.isFinite(range[0]) && Number.isFinite(range[1]) && range[1] > range[0]))
    throw new Error("A curve's range needs finite bounds, max above min.")
  const given = typeof points === "string" ? inRange(CURVE_SHAPES[points], range) : points
  const value = normalizePoints(given, range)
  if (!value) throw new Error("A curve needs at least two points.")
  const presets = options.presets
    ? Object.freeze(
        Object.fromEntries(
          Object.entries(options.presets).flatMap(([name, p]) => {
            const s = normalizePoints(p, range)
            return s ? [[name, s]] : []
          }),
        ),
      )
    : undefined
  return withMeta(
    {
      kind: "curve" as const,
      value,
      range: Object.freeze([range[0], range[1]]) as unknown as readonly [number, number],
      interp: options.interp ?? "smooth",
      shapes: options.shapes ?? true,
      ...(presets && Object.keys(presets).length ? { presets } : {}),
    },
    options,
  )
}
/** A wrapping row of buttons with icons and shortcut chips; holds no value. */
export function toolbar(items: readonly ToolbarItem[], meta?: FieldMeta): ToolbarField {
  if (!items.length) throw new Error("A toolbar needs at least one item.")
  return withMeta(
    {
      kind: "toolbar" as const,
      items: Object.freeze(items.map((item) => Object.freeze({ ...item }))),
    },
    meta,
  )
}

type ReadoutOptions = Omit<ReadoutMeta, "shortcut" | "random" | "readOnly">
const readoutMeta = (o: ReadoutOptions) => {
  if (o.decimals !== undefined && !(Number.isInteger(o.decimals) && o.decimals >= 0))
    throw new Error("A readout's decimals must be a whole number.")
  if (o.hz !== undefined && !(o.hz > 0)) throw new Error("A readout's hz must be above 0.")
  return {
    ...pickMeta(o),
    ...(o.get ? { get: o.get } : {}),
    ...(o.unit !== undefined ? { unit: o.unit } : {}),
    ...(o.decimals !== undefined ? { decimals: o.decimals } : {}),
    ...(o.format ? { format: o.format } : {}),
    ...(o.hz !== undefined ? { hz: o.hz } : {}),
  }
}
const whole = (n: number | undefined, fallback: number, what: string) => {
  const v = n ?? fallback
  if (!(Number.isInteger(v) && v > 0)) throw new Error(`${what} must be a whole number above 0.`)
  return v
}
/** A live value: `watch({ label: "FPS", decimals: 0 })`, then `controls.watch("fps", 59.9)`. */
export function watch(options: ReadoutOptions = {}): WatchField {
  return Object.freeze({ kind: "watch" as const, ...readoutMeta(options) })
}
/** A watch with a small history graph: `sparkline({ label: "Frame", unit: "ms", min: 0 })`. */
export function sparkline(
  options: ReadoutOptions & {
    history?: number
    min?: number
    max?: number
    color?: string
  } = {},
): SparklineField {
  return Object.freeze({
    kind: "sparkline" as const,
    ...readoutMeta(options),
    history: whole(options.history, 60, "A sparkline's history"),
    ...(options.min !== undefined ? { min: options.min } : {}),
    ...(options.max !== undefined ? { max: options.max } : {}),
    ...(options.color ? { color: options.color } : {}),
  })
}
/**
 * A multi-series graph: `graph({ series: [{ id: "cpu" }, { id: "gpu" }], unit: "ms",
 * thresholds: [{ value: 16.7, label: "60 fps" }] })`; push `{ cpu, gpu }` each frame.
 */
export function graph(
  options: ReadoutOptions & {
    series?: readonly (GraphSeries | string)[]
    history?: number
    height?: number
    min?: number
    max?: number
    thresholds?: readonly (GraphThreshold | number)[]
  } = {},
): GraphField {
  const series = (options.series ?? [{ id: "value" }]).map((s) =>
    Object.freeze(typeof s === "string" ? { id: s } : { ...s }),
  )
  if (!series.length || new Set(series.map((s) => s.id)).size !== series.length)
    throw new Error("A graph needs series with distinct ids.")
  return Object.freeze({
    kind: "graph" as const,
    ...readoutMeta(options),
    series: Object.freeze(series),
    history: whole(options.history, 120, "A graph's history"),
    height: whole(options.height, 64, "A graph's height"),
    ...(options.min !== undefined ? { min: options.min } : {}),
    ...(options.max !== undefined ? { max: options.max } : {}),
    thresholds: Object.freeze(
      (options.thresholds ?? []).map((t) =>
        Object.freeze(typeof t === "number" ? { value: t } : t),
      ),
    ),
  })
}
/** A bar: `meter({ label: "Memory", max: 512, unit: "MB", warn: 384, critical: 480 })`. */
export function meter(
  options: ReadoutOptions & {
    min?: number
    max?: number
    segments?: number
    warn?: number
    critical?: number
  } = {},
): MeterField {
  const min = options.min ?? 0
  const max = options.max ?? 1
  if (!(Number.isFinite(min) && Number.isFinite(max) && max > min))
    throw new Error("A meter needs finite bounds, max above min.")
  return Object.freeze({
    kind: "meter" as const,
    ...readoutMeta(options),
    min,
    max,
    ...(options.segments !== undefined
      ? { segments: whole(options.segments, 1, "A meter's segments") }
      : {}),
    ...(options.warn !== undefined ? { warn: options.warn } : {}),
    ...(options.critical !== undefined ? { critical: options.critical } : {}),
  })
}
/** A small table: `table({ label: "Passes", columns: ["Pass", "ms", "Draws"] })`. */
export function table(options: ReadoutOptions & { columns?: readonly string[] } = {}): TableField {
  if (options.columns && (options.columns.length < 1 || options.columns.length > 6))
    throw new Error("A table takes 1–6 columns.")
  return Object.freeze({
    kind: "table" as const,
    ...readoutMeta(options),
    ...(options.columns ? { columns: Object.freeze([...options.columns]) } : {}),
  })
}
/** A log: `log({ label: "Events", lines: 8 })`, then `controls.watch("events", { level, text })`. */
export function log(options: ReadoutOptions & { lines?: number; max?: number } = {}): LogField {
  return Object.freeze({
    kind: "log" as const,
    ...readoutMeta(options),
    lines: whole(options.lines, 8, "A log's lines"),
    max: whole(options.max, 1000, "A log's max"),
  })
}

/** Clamped and, on a whole-number field, whole: values are kept as given otherwise (see knob). */
const keep = (v: number, min: number, max: number, step: number) => {
  const clamped = Math.min(max, Math.max(min, v))
  return Number.isInteger(step) && Number.isInteger(min)
    ? Math.round(clamped)
    : Number(clamped.toPrecision(14))
}
/** An angle carried into `[min, max)` a whole turn at a time. */
export const wrapAngle = (v: number, min: number, max: number) => {
  const span = max - min
  return span > 0 ? ((((v - min) % span) + span) % span) + min : min
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
    case "vec": {
      const v = isRecord(input) ? input : {}
      const base = field.value as Partial<Vec3>
      const axis = (k: "x" | "y" | "z") =>
        keep(num(v[k], base[k] ?? 0), field.min, field.max, field.step)
      return Object.freeze(
        field.axes === 3
          ? { x: axis("x"), y: axis("y"), z: axis("z") }
          : { x: axis("x"), y: axis("y") },
      )
    }
    case "range": {
      const v = Array.isArray(input) && input.length === 2 ? input : field.value
      const a = keep(num(v[0], field.value[0]), field.min, field.max, field.step)
      const b = keep(num(v[1], field.value[1]), field.min, field.max, field.step)
      return Object.freeze([Math.min(a, b), Math.max(a, b)]) as unknown as readonly [number, number]
    }
    case "angle": {
      if (typeof input !== "number" || !Number.isFinite(input)) return field.value
      const v = field.wrap ? wrapAngle(input, field.min, field.max) : input
      const kept = keep(v, field.min, field.max, field.step)
      return field.wrap && kept >= field.max ? field.min : kept
    }
    case "seed":
      return typeof input === "number" && Number.isFinite(input)
        ? Math.round(Math.min(field.max, Math.max(field.min, input)))
        : field.value
    case "keybind":
      return typeof input === "string" ? normalizeCombo(input) : field.value
    case "gradient":
      return normalizeStops(input) ?? field.value
    case "curve":
      return normalizePoints(input, field.range) ?? field.value
  }
}
export function normalize<S extends Schema>(schema: S, input: unknown): Values<S> {
  const record = isRecord(input) ? input : {}
  return Object.freeze(
    Object.fromEntries(
      Object.entries(schema).flatMap(([key, field]) =>
        hasValue(field) ? [[key, normalizeField(field, record[key])]] : [],
      ),
    ),
  ) as Values<S>
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
/** Value equality: springs, points, beziers, gradients and curves compare by their numbers. */
export function same(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a)
  return (
    ka.length === Object.keys(b).length &&
    ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
  )
}
export function equal(a: State, b: State): boolean {
  return (
    Object.keys(a).length === Object.keys(b).length &&
    Object.keys(a).every((key) => same(a[key], b[key]))
  )
}
