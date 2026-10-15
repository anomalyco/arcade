// Readouts: rows that show live values the host pushes (or a getter polled while they show) and
// hold nothing in the store's state. The store keeps each readout's latest value and history here,
// so a panel mounted later (or mounted again) starts from what has already arrived.

/** A number or text that changes on its own: FPS, a count, a status. */
export type WatchValue = number | string
export type LogLevel = "debug" | "info" | "warn" | "error"
export interface LogEntry {
  readonly text: string
  readonly level?: LogLevel
  /** When it happened (ms since the epoch); when it was pushed by default. */
  readonly time?: number
}
/** A table's rows (cells by column), or a key-value record. */
export type TableRows =
  | readonly (readonly (string | number)[])[]
  | Readonly<Record<string, unknown>>

/** A fixed-size history of numbers, oldest first. */
export class Ring {
  private data: Float64Array
  private start = 0
  length = 0
  constructor(readonly capacity: number) {
    this.data = new Float64Array(Math.max(1, capacity))
  }
  push(v: number) {
    const cap = this.data.length
    if (this.length < cap) this.data[(this.start + this.length++) % cap] = v
    else {
      this.data[this.start] = v
      this.start = (this.start + 1) % cap
    }
  }
  /** The `i`th sample, 0 the oldest. */
  at(i: number) {
    return this.data[(this.start + i) % this.data.length]!
  }
  last() {
    return this.length ? this.at(this.length - 1) : Number.NaN
  }
  clear() {
    this.start = this.length = 0
  }
  /** The smallest and largest finite samples (NaN when there are none). */
  extent(): [number, number] {
    let lo = Infinity
    let hi = -Infinity
    for (let i = 0; i < this.length; i++) {
      const v = this.at(i)
      if (!Number.isFinite(v)) continue
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    return lo <= hi ? [lo, hi] : [Number.NaN, Number.NaN]
  }
  toArray() {
    return Array.from({ length: this.length }, (_, i) => this.at(i))
  }
}

/** A log's entries, oldest first, the oldest dropped past `max`; `total` counts every one pushed. */
export class EntryLog {
  entries: (LogEntry & { readonly seq: number; readonly time: number })[] = []
  total = 0
  constructor(readonly max: number) {}
  push(entry: LogEntry) {
    const time = entry.time ?? Date.now()
    this.entries.push({ ...entry, level: entry.level ?? "info", time, seq: this.total++ })
    if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max)
  }
  clear() {
    this.entries = []
  }
}

/** What a readout has received, kept by the store per key. */
export interface ReadoutState {
  /** Bumps on every push, so a row can tell it has something new. */
  seq: number
  /** The latest value as pushed (`watch`, `meter`, `table`), else the last sample. */
  value: unknown
  /** `sparkline`: one ring; `graph`: one per series id. */
  readonly series?: Map<string, Ring>
  readonly log?: EntryLog
}

/** A readout field's own options, as far as the history goes. */
export interface ReadoutShape {
  readonly kind: string
  readonly history?: number
  readonly series?: readonly { readonly id: string }[]
  readonly max?: number
}

export function readoutState(field: ReadoutShape): ReadoutState {
  if (field.kind === "sparkline")
    return { seq: 0, value: null, series: new Map([["", new Ring(field.history ?? 60)]]) }
  if (field.kind === "graph")
    return {
      seq: 0,
      value: null,
      series: new Map((field.series ?? []).map((s) => [s.id, new Ring(field.history ?? 120)])),
    }
  if (field.kind === "log") return { seq: 0, value: null, log: new EntryLog(field.max ?? 1000) }
  return { seq: 0, value: null }
}

const levels = new Set(["debug", "info", "warn", "error"])
const asEntry = (v: unknown): LogEntry | undefined =>
  typeof v === "string"
    ? { text: v }
    : v && typeof v === "object" && typeof (v as LogEntry).text === "string"
      ? {
          text: (v as LogEntry).text,
          ...(levels.has((v as LogEntry).level as string) ? { level: (v as LogEntry).level } : {}),
          ...(typeof (v as LogEntry).time === "number" ? { time: (v as LogEntry).time } : {}),
        }
      : undefined

/**
 * Takes a pushed value into a readout's state. `null` clears a history (and blanks a value);
 * a sparkline takes a number or an array that replaces its history, a graph a number (its first
 * series) or `{ [series]: number }`, a log a string, an entry or an array of them.
 */
export function pushReadout(field: ReadoutShape, state: ReadoutState, value: unknown) {
  state.seq++
  if (value === null || value === undefined) {
    state.value = null
    for (const ring of state.series?.values() ?? []) ring.clear()
    state.log?.clear()
    return
  }
  if (field.kind === "sparkline") {
    const ring = state.series!.get("")!
    if (Array.isArray(value)) {
      ring.clear()
      for (const v of value) ring.push(Number(v))
    } else ring.push(Number(value))
    state.value = ring.last()
    return
  }
  if (field.kind === "graph") {
    const record =
      typeof value === "number"
        ? { [field.series?.[0]?.id ?? ""]: value }
        : (value as Record<string, unknown>)
    // Every series takes a sample at once (NaN for one left out), so they stay in step.
    for (const [id, ring] of state.series!) {
      const v = record[id]
      ring.push(typeof v === "number" ? v : Number.NaN)
    }
    state.value = record
    return
  }
  if (field.kind === "log") {
    const list = Array.isArray(value) ? value : [value]
    for (const item of list) {
      const entry = asEntry(item)
      if (entry) state.log!.push(entry)
    }
    state.value = state.log!.entries.at(-1) ?? null
    return
  }
  state.value = value
}

/** Shared by the store and the panel bundles (the global symbol registry). */
export const READOUT: unique symbol = Symbol.for("knobs.readout") as never
/** What panels use to follow a store's readouts. */
export interface ReadoutPort {
  state(key: string): ReadoutState | undefined
  /** Calls `cb(key)` after each push; returns the unsubscribe. */
  listen(cb: (key: string) => void): () => void
}
