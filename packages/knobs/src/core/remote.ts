import { colorHex, oklchToRgb, parseColor } from "./color.js"
import type { Bezier } from "./easing.js"
import type { CurveInterp, CurvePoint, GradientSpace, GradientStop } from "./ramp.js"
import { RESET_KEYS, RESHAPE, type Reshape, type ResetKeys } from "./internal.js"
import {
  action,
  angle,
  choice,
  keybind,
  range,
  seed,
  toolbar,
  vec2,
  vec3,
  type Vec3,
  color,
  curve,
  gradient,
  easing,
  flatSpring,
  knob,
  pickMeta,
  point,
  spring,
  toggle,
  type Field,
  type FieldMeta,
  graph,
  type GraphSeries,
  type GraphThreshold,
  isReadout,
  log,
  meter,
  sparkline,
  table,
  watch,
  type Knob,
  type Point,
  type ToolbarShortcut,
  type Schema,
  same,
  type State,
  type Value,
} from "./schema.js"
import type { SpringValue } from "./spring.js"
import type { StoragePort } from "./storage.js"
import {
  defineControls,
  type ChangeMeta,
  type GestureEvent,
  type ControlAction,
  type GroupPreset,
  type Controls,
  type DensityMode,
  type GroupPresetDisplay,
  type HostHistory,
  type PanelKeys,
  type PersistMode,
  type PanelModule,
  type RendererMode,
  type SectionFolded,
  type SyncOptions,
  type ThemeMode,
} from "./store.js"

/** A choice option with its own label: `{ id: "md", label: "Medium" }` (`value` works for `id`). */
export interface ChoiceOption {
  readonly id?: string
  readonly value?: string
  readonly label?: string
}
interface DescriptorMeta extends FieldMeta {
  readonly key: string
}
/**
 * Two flat number keys drawn as one spring card (a curve and two sliders). Values stay flat:
 * `onSet("duration", 0.4)`, `values.bounce`. When the bound keys have number descriptors of their
 * own, their ranges, labels and defaults are used (and they aren't drawn again); otherwise the
 * spring's `default` and the standard spring ranges are.
 */
export interface SpringBindingDescriptor extends DescriptorMeta {
  readonly kind: "spring"
  readonly bind: { readonly duration: string; readonly bounce: string }
  readonly default?: SpringValue
}
/** A button row: pressing it calls `onAction(key)`. `shortcut` takes a combination here. */
export interface ActionDescriptor extends DescriptorMeta {
  readonly kind: "action"
  readonly global?: boolean
  readonly rebind?: boolean
  readonly default?: undefined
  readonly bind?: undefined
}
/** A row of buttons; pressing one calls `onAction(item.key)`. */
export interface ToolbarDescriptor extends DescriptorMeta {
  readonly kind: "toolbar"
  readonly items: readonly {
    readonly key: string
    readonly label: string
    readonly icon?: string
    readonly shortcut?: string | ToolbarShortcut
    readonly global?: boolean
    readonly disabled?: boolean
  }[]
  readonly default?: undefined
  readonly bind?: undefined
}
/**
 * A readout row (`watch`, `sparkline`, `graph`, `meter`, `table`, `log`): it shows what
 * `controls.watch(key, value)` pushes and holds no value. Options as their field constructors take.
 */
export interface ReadoutDescriptor extends DescriptorMeta {
  readonly kind: "watch" | "sparkline" | "graph" | "meter" | "table" | "log"
  readonly unit?: string
  readonly decimals?: number
  readonly hz?: number
  readonly min?: number
  readonly max?: number
  readonly history?: number
  readonly height?: number
  readonly color?: string
  readonly series?: readonly (GraphSeries | string)[]
  readonly thresholds?: readonly (GraphThreshold | number)[]
  readonly segments?: number
  readonly warn?: number
  readonly critical?: number
  readonly columns?: readonly string[]
  readonly lines?: number
  readonly get?: () => unknown
  readonly format?: (value: number) => string
  readonly default?: undefined
  readonly bind?: undefined
}
export type ControlDescriptor =
  | ValueDescriptor
  | SpringBindingDescriptor
  | ActionDescriptor
  | ToolbarDescriptor
  | ReadoutDescriptor
export interface ValueDescriptor extends DescriptorMeta {
  readonly bind?: undefined
  readonly kind:
    | "knob"
    | "number"
    | "choice"
    | "toggle"
    | "bool"
    | "spring"
    | "color"
    | "point"
    | "easing"
    | "vec2"
    | "vec3"
    | "range"
    | "angle"
    | "seed"
    | "keybind"
    | "gradient"
    | "curve"
  /**
   * Springs take `{ duration, bounce }`, colours a CSS string, points and vec2 `{ x, y }`, vec3
   * `{ x, y, z }`, easings `[x1, y1, x2, y2]`, ranges `[low, high]`, keybinds a combination
   * string (`"Meta+K"`), gradients `[{ at, color }]` and curves `[{ x, y }]`.
   */
  readonly default: Value
  readonly min?: number
  readonly max?: number
  readonly step?: number
  readonly unit?: string
  /** Readout digits after the point (the step's own by default). */
  readonly decimals?: number
  /** Choices: segments or a drop-down menu (see `Choice.display`); automatic by default. */
  readonly display?: "menu" | "segmented"
  /** Strings, or `{ id, label }` options; past four, or when they don't fit, a menu. */
  readonly choices?: readonly (string | ChoiceOption)[]
  readonly options?: readonly (string | ChoiceOption)[]
  readonly swiftType?: string
  /** Vectors: show the link toggle for uniform scaling (`linked` starts it on). */
  readonly link?: boolean
  readonly linked?: boolean
  /** Vectors: what the cells are called (`["x", "z"]`), their letters and accessible names. */
  readonly axes?: readonly string[]
  /** Angles: carry past the ends a whole turn (on for a full turn by default). */
  readonly wrap?: boolean
  /** Gradients: blend in `oklab` (default) or `srgb`. */
  readonly space?: GradientSpace
  /** Curves: the y range, `[0, 1]` by default (`min` and `max` work too). */
  readonly range?: readonly [number, number]
  /** Curves: `smooth` (monotone cubic, default), `linear` or `step`. */
  readonly interp?: CurveInterp
  /** Curves: `false` hides the built-in shape chips. */
  readonly shapes?: boolean
  /** Gradients and curves: named ramps or shapes offered as chips. */
  readonly presets?: Readonly<Record<string, readonly GradientStop[] | readonly CurvePoint[]>>
}

export interface RemoteControlsOptions {
  readonly enabled?: boolean | (() => boolean)
  /** Ships the panel as product UI, live in production: `() => import("knobs/panel")` (see `ControlsOptions.ship`). */
  readonly ship?: () => Promise<PanelModule>
  /** How long (ms) a key changed here outranks incoming values for it; 600 by default. */
  readonly echo?: number
  /**
   * `onSet` sends `null` when a key returns to its default (and a key's reset is an `onSet` of
   * `null` too), as the socket protocol expects. `false` sends the value itself, and resets reach
   * only `onReset`.
   */
  readonly nullDefaults?: boolean
  readonly values?: State
  readonly presets?: Readonly<Record<string, State>>
  /** Numbered presets per group, e.g. the phone's preset sets (see `ControlsOptions.groupPresets`). */
  readonly groupPresets?: Readonly<Record<string, readonly GroupPreset[]>>
  /** Display labels by group id, section id and preset id (see `ControlsOptions.groupLabels`). */
  readonly groupLabels?: Readonly<Record<string, string>>
  readonly sectionLabels?: Readonly<Record<string, string>>
  readonly presetLabels?: Readonly<Record<string, string>>
  /** Shorthand for `presetLabels.default`, e.g. "Native". */
  readonly defaultLabel?: string
  /** How a page card shows its group presets (see `ControlsOptions.groupPresetDisplay`). */
  readonly groupPresetDisplay?: GroupPresetDisplay
  /** One muted line under a group's card title or a section's heading on a page, by id. */
  readonly groupDescriptions?: Readonly<Record<string, string>>
  readonly sectionDescriptions?: Readonly<Record<string, string>>
  /** How groups and a page's sections start, folded or open (see `ControlsOptions.groupFolded`). */
  readonly groupFolded?: Readonly<Record<string, boolean>>
  readonly sectionFolded?: SectionFolded
  readonly actions?: readonly ControlAction<State>[]
  readonly storage?: StoragePort | null
  /** What `storage` keeps (see `ControlsOptions.persist`). */
  readonly persist?: PersistMode
  /** What Random and Mutate draw from (see `ControlsOptions.random`). */
  readonly random?: () => number
  /** Whether Random and Mutate may change a key (see `ControlsOptions.tunable`). */
  readonly tunable?: (key: string, values: State) => boolean
  /** An undo stack the host owns (see `HostHistory`). */
  readonly history?: HostHistory
  readonly theme?: ThemeMode
  readonly density?: DensityMode
  readonly renderer?: RendererMode
  /** Default key bindings for its panels (see `MountPanelOptions.keys`). */
  readonly keys?: PanelKeys
  /** `false`: its panels show no modified marks or resets (see `MountPanelOptions.marks`). */
  readonly marks?: boolean
  readonly onSet?: (key: string, value: Value | null, meta: ChangeMeta) => void
  /**
   * A change of several keys at once (a preset, Random, Mutate, resetting a selection, undoing or
   * redoing any of them), in one call instead of an `onSet` per key. The entries are what `onSet`
   * would have received, `null` again meaning back to the default. A change of one key still goes
   * to `onSet`, or here as a single entry when there's no `onSet`. Resetting everything or a
   * group stays `onReset`'s, as with `onSet`.
   */
  readonly onSetBatch?: (
    changes: Array<{ key: string; value: Value | null }>,
    meta: ChangeMeta,
  ) => void
  /** A key went into the hand or out of it: a drag, an inline edit, a burst of arrow keys. */
  readonly onGesture?: (event: GestureEvent) => void
  /** A key, a group, or (`{}`) everything was reset. */
  readonly onReset?: (target: { key?: string; group?: string }) => void
  /** An action row was pressed. */
  readonly onAction?: (key: string) => void
  /**
   * A group preset was chosen. When given, the peer applies its own preset (and sends back its
   * state) instead of receiving `onSet` for each key.
   */
  readonly onPreset?: (target: { group: string; index: number; name: string }) => void
}

export interface RemoteControls extends Controls<Schema> {
  readonly descriptors: readonly ControlDescriptor[]
  /**
   * Swaps in another set of descriptors (another variation, another item) without tearing the
   * panel down. Rows with the same key keep their DOM and spring to their new value; new rows
   * enter and missing ones leave. `values` are the complete values (missing keys sit at their
   * defaults), held back for any key in hand as `sync` does.
   *
   * Undo history starts over when the descriptors change shape or `land` is set: it belonged to
   * the previous set. `land: true` (a different item arrived) also places every value at once,
   * without springing or rolling. `mixed` names the keys whose values differ across a
   * multi-selection (see `SyncOptions.mixed`).
   */
  update(
    descriptors: readonly ControlDescriptor[],
    values?: State,
    options?: { land?: boolean; mixed?: readonly string[] },
  ): void
  swift(group?: string): string
}

const readoutDescriptor = (d: ControlDescriptor): d is ReadoutDescriptor => isReadout(d)
/** A readout descriptor's field: the options it gives, undefined ones left out. */
function readoutField(d: ReadoutDescriptor): Field {
  const { key: _key, kind, default: _d, bind: _b, ...rest } = d
  const opts = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined))
  if (kind === "watch") return watch(opts)
  if (kind === "sparkline") return sparkline(opts)
  if (kind === "graph") return graph(opts)
  if (kind === "meter") return meter(opts)
  if (kind === "table") return table(opts)
  return log(opts)
}

const optionId = (o: string | ChoiceOption) =>
  typeof o === "string" ? o : String(o.id ?? o.value ?? o.label ?? "")

export function descriptorToField(d: ControlDescriptor): Field {
  const meta = pickMeta(d)
  if (d.kind === "action")
    return action(d.label, {
      ...meta,
      ...(d.global ? { global: true } : {}),
      ...(d.rebind ? { rebind: true } : {}),
    })
  if (readoutDescriptor(d)) return readoutField(d)
  if (d.kind === "toolbar")
    return toolbar(
      d.items.map(({ key, ...item }) => ({ ...item, id: key })),
      meta,
    )
  if (d.bind) return flatSpring({}, { ...meta, id: d.key }).duration
  if (d.kind === "knob" || d.kind === "number") {
    const def = typeof d.default === "number" && Number.isFinite(d.default) ? d.default : 0
    const min = d.min ?? Math.min(0, def * 2)
    const max = d.max ?? Math.max(1, def * 2)
    const step = d.step ?? (d.swiftType === "Int" ? 1 : (max - min) / 100 || 1)
    return knob(def, {
      min,
      max,
      step,
      ...(d.unit !== undefined ? { unit: d.unit } : {}),
      ...(d.decimals !== undefined ? { decimals: d.decimals } : {}),
      ...meta,
    })
  }
  if (d.kind === "choice") {
    const given = d.options ?? d.choices ?? [String(d.default)]
    if (given.length === 0) throw new Error(`Choice descriptor ${d.key} needs options.`)
    const list = given.map(optionId)
    const labels = Object.fromEntries(
      given.flatMap((o) =>
        typeof o === "string" || o.label === undefined ? [] : [[optionId(o), o.label]],
      ),
    )
    const def = list.includes(String(d.default)) ? String(d.default) : list[0]!
    return choice(def, list as [string, ...string[]], {
      ...meta,
      labels,
      ...(d.display ? { display: d.display } : {}),
    })
  }
  if (d.kind === "spring") return spring(d.default as SpringValue, meta)
  if (d.kind === "color")
    return color(parseColor(d.default) ? (d.default as string) : "#808080", meta)
  if (d.kind === "point")
    return point(d.default as Point, { min: d.min ?? 0, max: d.max ?? 1, step: d.step, ...meta })
  if (d.kind === "easing") return easing(d.default as Bezier, meta)
  const numbers = {
    ...(d.unit !== undefined ? { unit: d.unit } : {}),
    ...(d.decimals !== undefined ? { decimals: d.decimals } : {}),
    ...(d.step !== undefined ? { step: d.step } : {}),
  }
  if (d.kind === "vec2" || d.kind === "vec3") {
    const v = (d.default ?? {}) as Partial<Vec3>
    const opts = {
      min: d.min ?? -1,
      max: d.max ?? 1,
      ...numbers,
      ...(d.link ? { link: true } : {}),
      ...(d.linked ? { linked: true } : {}),
      ...(d.axes ? { axes: d.axes } : {}),
      ...meta,
    }
    return d.kind === "vec3"
      ? vec3({ x: v.x ?? 0, y: v.y ?? 0, z: v.z ?? 0 }, opts)
      : vec2({ x: v.x ?? 0, y: v.y ?? 0 }, opts)
  }
  if (d.kind === "range") {
    const v = Array.isArray(d.default) ? d.default : [d.min ?? 0, d.max ?? 1]
    return range([Number(v[0]), Number(v[1])], {
      min: d.min ?? 0,
      max: d.max ?? 1,
      ...numbers,
      ...meta,
    })
  }
  if (d.kind === "angle")
    return angle(typeof d.default === "number" ? d.default : 0, {
      ...(d.min !== undefined ? { min: d.min } : {}),
      ...(d.max !== undefined ? { max: d.max } : {}),
      ...(d.step !== undefined ? { step: d.step } : {}),
      ...(d.wrap !== undefined ? { wrap: d.wrap } : {}),
      ...meta,
    })
  if (d.kind === "seed")
    return seed(typeof d.default === "number" ? d.default : 0, {
      ...(d.min !== undefined ? { min: d.min } : {}),
      ...(d.max !== undefined ? { max: d.max } : {}),
      ...meta,
    })
  if (d.kind === "keybind") return keybind(typeof d.default === "string" ? d.default : "", meta)
  if (d.kind === "gradient") {
    const fallback = [
      { at: 0, color: "#000000" },
      { at: 1, color: "#ffffff" },
    ]
    const stops = Array.isArray(d.default) ? (d.default as GradientStop[]) : fallback
    const opts = {
      ...(d.space ? { space: d.space } : {}),
      ...(d.presets ? { presets: d.presets as Record<string, GradientStop[]> } : {}),
      ...meta,
    }
    try {
      return gradient(stops, opts)
    } catch {
      return gradient(fallback, opts)
    }
  }
  if (d.kind === "curve") {
    const range = d.range ?? [d.min ?? 0, d.max ?? 1]
    const opts = {
      range,
      ...(d.interp ? { interp: d.interp } : {}),
      ...(d.shapes !== undefined ? { shapes: d.shapes } : {}),
      ...(d.presets ? { presets: d.presets as Record<string, CurvePoint[]> } : {}),
      ...meta,
    }
    const points = Array.isArray(d.default) ? (d.default as CurvePoint[]) : []
    return points.length >= 2 ? curve(points, opts) : curve("linear", opts)
  }
  return toggle(Boolean(d.default), meta)
}

/**
 * Converts descriptors into a schema. A spring binding becomes its two flat number fields, at the
 * binding's place (their own descriptors, if any, give their ranges and labels).
 */
export function fromDescriptors(descriptors: readonly ControlDescriptor[]): Schema {
  const byKey = new Map(descriptors.map((d) => [d.key, d]))
  const bound = new Set<string>()
  for (const d of descriptors)
    if (d.bind) {
      if (d.bind.duration === d.bind.bounce) throw new Error(`Spring ${d.key} binds one key twice.`)
      bound.add(d.bind.duration).add(d.bind.bounce)
    }
  const entries: [string, Field][] = []
  for (const d of descriptors) {
    if (bound.has(d.key) && !d.bind) continue
    if (!d.bind) {
      entries.push([d.key, descriptorToField(d)])
      continue
    }
    const half = (part: "duration" | "bounce") => {
      const own = byKey.get(d.bind[part])
      if (own && !own.bind && (own.kind === "number" || own.kind === "knob"))
        return descriptorToField({
          ...own,
          group: d.group ?? own.group,
          groupLabel: d.groupLabel ?? own.groupLabel,
        }) as Knob
      return (d.default?.[part] ?? (part === "duration" ? 0.5 : 0)) as number
    }
    const pair = flatSpring(
      { duration: half("duration"), bounce: half("bounce") },
      { id: d.key, ...pickMeta(d, ["shortcut"]) },
    )
    entries.push([d.bind.duration, pair.duration], [d.bind.bounce, pair.bounce])
  }
  return Object.freeze(Object.fromEntries(entries))
}

const decimal = (n: number) => String(Math.round(n * 10000) / 10000)
const swiftLiteral = (d: ValueDescriptor, v: Value): string => {
  if (d.kind === "color") {
    const [r, g, b] = oklchToRgb(parseColor(v) ?? { l: 0, c: 0, h: 0 }).map(decimal)
    return `Color(red: ${r}, green: ${g}, blue: ${b})`
  }
  if (d.kind === "point") {
    const p = v as Point
    return `CGPoint(x: ${decimal(p.x)}, y: ${decimal(p.y)})`
  }
  if (d.kind === "easing") {
    const [x1, y1, x2, y2] = (v as Bezier).map(decimal)
    return `.bezier(startControlPoint: UnitPoint(x: ${x1}, y: ${y1}), endControlPoint: UnitPoint(x: ${x2}, y: ${y2}))`
  }
  if (d.kind === "vec2" || d.kind === "vec3") {
    const p = v as Vec3
    return d.kind === "vec3"
      ? `SIMD3<Double>(${decimal(p.x)}, ${decimal(p.y)}, ${decimal(p.z)})`
      : `SIMD2<Double>(${decimal(p.x)}, ${decimal(p.y)})`
  }
  if (d.kind === "range") {
    const [a, b] = v as readonly [number, number]
    return `${decimal(a)}...${decimal(b)}`
  }
  if (d.kind === "keybind") return JSON.stringify(v)
  if (d.kind === "gradient") {
    const stops = (Array.isArray(v) ? (v as readonly GradientStop[]) : []).map((s) => {
      const [r, g, b] = oklchToRgb(parseColor(s.color) ?? { l: 0, c: 0, h: 0 }).map(decimal)
      return `.init(color: Color(red: ${r}, green: ${g}, blue: ${b}), location: ${decimal(s.at)})`
    })
    return `Gradient(stops: [${stops.join(", ")}])`
  }
  if (d.kind === "curve")
    return `[${(Array.isArray(v) ? (v as readonly CurvePoint[]) : []).map((p) => `CGPoint(x: ${decimal(p.x)}, y: ${decimal(p.y)})`).join(", ")}]`
  if (d.kind === "seed") return String(Math.round(v as number))
  if (typeof v === "boolean") return String(v)
  if (typeof v === "string") return `.${v}`
  if (typeof v !== "number") return JSON.stringify(v)
  if (d.swiftType === "Int") return String(Math.round(v))
  return decimal(v)
}
const swiftTypes = {
  color: "Color",
  point: "CGPoint",
  easing: "UnitCurve",
  vec2: "SIMD2<Double>",
  vec3: "SIMD3<Double>",
  range: "ClosedRange<Double>",
  seed: "Int",
  keybind: "String",
  gradient: "Gradient",
  curve: "[CGPoint]",
} as const

export function formatSwift(
  descriptors: readonly ControlDescriptor[],
  values: State,
  group?: string,
): string {
  const byKey = new Map(descriptors.map((d) => [d.key, d]))
  const done = new Set<string>()
  const lines: string[] = []
  for (const d of descriptors as readonly ValueDescriptor[]) {
    if ((d.kind as string) === "action" || (d.kind as string) === "toolbar" || d.bind) continue
    if (readoutDescriptor(d)) continue
    const changed = d.key in values && !same(values[d.key], d.default)
    if (!changed || done.has(d.key) || (group && d.group !== group)) continue
    const base = d.key.replace(/\.(duration|bounce)$/, "")
    const duration = byKey.get(`${base}.duration`) as ValueDescriptor | undefined
    const bounce = byKey.get(`${base}.bounce`) as ValueDescriptor | undefined
    if (base !== d.key && duration && bounce) {
      done.add(duration.key).add(bounce.key)
      const label = (duration.label ?? duration.key).replace(/ duration$/i, "")
      const dv = values[duration.key] ?? duration.default
      const bv = values[bounce.key] ?? bounce.default
      lines.push(
        `TunableSpring(${JSON.stringify(base)}, ${JSON.stringify(label)}, duration: ${swiftLiteral(duration, dv)}, bounce: ${swiftLiteral(bounce, bv)})` +
          `  // was duration: ${swiftLiteral(duration, duration.default)}, bounce: ${swiftLiteral(bounce, bounce.default)}`,
      )
      continue
    }
    done.add(d.key)
    if (d.kind === "spring") {
      const v = values[d.key] as SpringValue
      const was = d.default as SpringValue
      lines.push(
        `TunableSpring(${JSON.stringify(d.key)}, ${JSON.stringify(d.label ?? d.key)}, duration: ${decimal(v.duration)}, bounce: ${decimal(v.bounce)})` +
          `  // was duration: ${decimal(was.duration)}, bounce: ${decimal(was.bounce)}`,
      )
      continue
    }
    const swiftType =
      d.swiftType ??
      (d.kind === "bool" || d.kind === "toggle"
        ? "Bool"
        : d.kind in swiftTypes
          ? swiftTypes[d.kind as keyof typeof swiftTypes]
          : "Double")
    let call = `Tunable<${swiftType}>(${JSON.stringify(d.key)}, ${JSON.stringify(d.label ?? d.key)}, default: ${swiftLiteral(d, values[d.key])}`
    if (d.kind === "knob" || d.kind === "number") {
      if (d.min !== undefined && d.max !== undefined)
        call += `, in: ${decimal(d.min)}...${decimal(d.max)}`
      if (d.step !== undefined) call += `, step: ${decimal(d.step)}`
    }
    const note = d.kind === "color" ? `${colorHex(values[d.key] as string)} · ` : ""
    lines.push(`${call})  // ${note}was ${swiftLiteral(d, d.default)}`)
  }
  return lines.join("\n")
}

/** How long a local change outranks the peer's state for that key. */
/**
 * The longest echo hold; a key is released early once the remote reports its new value. Raise it
 * (`echo`) for peers that acknowledge slowly: a stale echo and a clamped value look alike.
 */
const ECHO_MS = 600

/** Copies `source`'s properties, getters as getters, then `extra`'s. */
function extend<T extends object, E extends object>(source: T, extra: E): T & E {
  return Object.freeze(
    Object.defineProperties(
      {},
      {
        ...Object.getOwnPropertyDescriptors(source),
        ...Object.getOwnPropertyDescriptors(extra),
      },
    ),
  ) as T & E
}

export function createRemoteControls(
  id: string,
  descriptors: readonly ControlDescriptor[],
  options: RemoteControlsOptions = {},
): RemoteControls {
  let frozenDescriptors = Object.freeze([...descriptors])
  let given = descriptors
  const nullDefaults = options.nullDefaults !== false
  type Change = { key: string; value: Value | null }
  const send = (changes: Change[], meta: ChangeMeta) => {
    if (changes.length === 0) return
    if (options.onSetBatch && (changes.length > 1 || !options.onSet))
      return options.onSetBatch(changes, meta)
    for (const { key, value } of changes) options.onSet?.(key, value, meta)
  }
  const onReset = (target: { key?: string; group?: string }) => {
    if (target.key && nullDefaults)
      send([{ key: target.key, value: null }], { source: "reset", key: target.key })
    options.onReset?.(target)
  }
  // Resetting several keys: with `onSetBatch`, their nulls go in one batch after an `onReset` each.
  const resetKeys: ResetKeys = (keys) => {
    if (!options.onSetBatch || !nullDefaults) return keys.forEach((key) => onReset({ key }))
    for (const key of keys) options.onReset?.({ key })
    send(
      keys.map((key) => ({ key, value: null })),
      { source: "reset" },
    )
  }
  const controls = defineControls(id, fromDescriptors(frozenDescriptors), {
    enabled: options.enabled ?? true,
    ship: options.ship,
    echo: options.echo ?? ECHO_MS,
    storage: options.storage ?? null,
    persist: options.persist,
    random: options.random,
    tunable: options.tunable,
    history: options.history,
    presets: options.presets,
    groupPresets: options.groupPresets,
    onPreset: options.onPreset,
    actions: options.actions,
    theme: options.theme,
    density: options.density,
    renderer: options.renderer,
    keys: options.keys,
    marks: options.marks,
    groupLabels: options.groupLabels,
    sectionLabels: options.sectionLabels,
    presetLabels: options.presetLabels,
    defaultLabel: options.defaultLabel,
    groupPresetDisplay: options.groupPresetDisplay,
    groupDescriptions: options.groupDescriptions,
    sectionDescriptions: options.sectionDescriptions,
    groupFolded: options.groupFolded,
    sectionFolded: options.sectionFolded,
    onChange(patch, _values, meta) {
      if (meta.source === "remote") return
      // A reset to the defaults reaches the peer through onReset; one back to an active preset
      // sends its values, unless the peer applies its own group presets (onPreset).
      if (meta.source === "reset" && !meta.base) return
      const peerPreset =
        meta.source === "preset" ||
        (meta.base && meta.group !== undefined && controls.activeGroupPreset(meta.group) >= 0)
      if (peerPreset && meta.group !== undefined && options.onPreset) return
      const changes: Change[] = []
      for (const [key, val] of Object.entries(patch)) {
        if (val === undefined) continue
        changes.push({ key, value: nullDefaults && same(val, controls.locked[key]) ? null : val })
      }
      send(changes, meta)
    },
    onReset,
    onGesture: options.onGesture,
    ...{ [RESET_KEYS]: resetKeys },
    onAction: (key) => options.onAction?.(key),
  })
  if (options.values) {
    controls.sync(options.values, { replace: true })
  }
  const reshape = (controls as unknown as { [RESHAPE]: Reshape })[RESHAPE]
  return extend(controls, {
    get descriptors() {
      return frozenDescriptors
    },
    update(
      next: readonly ControlDescriptor[],
      values: State = {},
      opts?: { land?: boolean; mixed?: readonly string[] },
    ) {
      // The same array: only the values can have changed.
      if (next === given || next === frozenDescriptors)
        return controls.sync(values, { replace: true, land: opts?.land, mixed: opts?.mixed })
      given = next
      frozenDescriptors = Object.freeze([...next])
      reshape(fromDescriptors(frozenDescriptors), values, opts)
    },
    sync: (values: State, syncOptions?: SyncOptions) => controls.sync(values, syncOptions),
    swift: (group?: string) => formatSwift(frozenDescriptors, controls.modified() as State, group),
  })
}

/** A titled section of settings, as a hosted prototype reports them (viewer.js `pv:settings`). */
export interface SettingsGroup {
  readonly title?: string
  readonly items: readonly SettingsItem[]
}
export type SettingsItem =
  | {
      readonly id: string
      readonly label: string
      readonly kind: "choice"
      readonly choices: readonly { readonly id: string; readonly label?: string }[]
      readonly value?: string | null
    }
  | {
      readonly id: string
      readonly label: string
      readonly kind: "toggle"
      readonly value?: boolean
    }
  | {
      readonly id: string
      readonly label: string
      readonly kind: "action"
      readonly value?: boolean
    }

/**
 * Settings sections as descriptors and values, one row per item: choices (a menu past four
 * options), switches and buttons, each section's title its group.
 *
 * The prototype owns these values, so each setting's default is its `home`: the value the
 * prototype first reported. Pass the first call's `values` back as `home` (merging in settings
 * that appear later) so the shape stays put while the values move; without it, the values
 * reported now are the defaults.
 */
export function fromSettings(
  groups: readonly SettingsGroup[],
  home: State = {},
): { descriptors: ControlDescriptor[]; values: State } {
  const descriptors: ControlDescriptor[] = []
  const values: Record<string, Value> = {}
  for (const g of groups)
    for (const item of g.items) {
      const meta = { key: item.id, label: item.label, ...(g.title ? { group: g.title } : {}) }
      if (item.kind === "action") descriptors.push({ ...meta, kind: "action" })
      else if (item.kind === "toggle") {
        values[item.id] = Boolean(item.value)
        const def = home[item.id]
        descriptors.push({
          ...meta,
          kind: "toggle",
          default: typeof def === "boolean" ? def : values[item.id]!,
        })
      } else if (item.choices.length) {
        const ids = item.choices.map((c) => c.id)
        values[item.id] = item.value != null && ids.includes(item.value) ? item.value : ids[0]!
        const def = home[item.id]
        descriptors.push({
          ...meta,
          kind: "choice",
          default: typeof def === "string" && ids.includes(def) ? def : values[item.id]!,
          choices: item.choices,
        })
      }
    }
  return { descriptors, values }
}
