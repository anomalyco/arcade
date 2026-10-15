import { STATION_SLOTS, WIDGET_KINDS, type LabStation, type StationLayout, type StationSlot, type StationWidget } from "./types"

/** A widget with a stable id inside its station's layout. */
export type PlacedWidget = StationWidget & { id: string }
export type ResolvedLayout = Record<StationSlot, PlacedWidget[]>

/** A section's Details group and how many tuning sliders it has (seeds and pickers don't count). */
export type GroupInfo = { name: string; tunable: number }

/** The groups a station's controls card shows by default: the first two with real tuning sliders. */
export function featuredGroups(groups: readonly GroupInfo[]): string[] {
  for (const least of [2, 1]) {
    const picked = groups.filter(g => g.tunable >= least).map(g => g.name)
    if (picked.length) return picked.slice(0, 2)
  }
  return groups.slice(0, 1).map(g => g.name)
}

/**
 * The layout a station gets when its file has none: what it is on the left, knobs for its section's main groups on
 * the right, and the things you reach for while looking (variants, compare, live numbers, notes) in the dock.
 */
export function defaultLayout(station: LabStation, groups: readonly string[]): StationLayout {
  const section = station.demo.kind === "section"
  const w = (widget: StationWidget["widget"], extra: Partial<StationWidget> = {}): StationWidget => ({ widget, ...extra })
  return {
    left: [
      w("status"),
      ...(station.metrics?.length ? [w("metrics")] : []),
    ],
    right: section && groups.length ? [w("controls", { groups: groups.slice(0, 2) })] : [],
    dock: [
      ...(station.variants?.length ? [w("variants")] : []),
      ...(section ? [w("compare")] : []),
      w("perf"),
      w("voice"),
      w("notes"),
      ...(station.paths?.length || station.branches?.length ? [w("changes")] : []),
    ],
  }
}

/** Gives every widget an id (its kind, then kind-2, kind-3…) and drops anything malformed. */
export function resolveLayout(layout: StationLayout): ResolvedLayout {
  const used = new Set<string>()
  const out = { left: [], right: [], dock: [] } as ResolvedLayout
  for (const slot of STATION_SLOTS) {
    for (const widget of layout[slot] ?? []) {
      if (!WIDGET_KINDS.includes(widget.widget)) continue
      let id = widget.id && !used.has(widget.id) ? widget.id : widget.widget
      for (let n = 2; used.has(id); n++) id = `${widget.widget}-${n}`
      used.add(id)
      out[slot].push({ ...widget, id })
    }
  }
  return out
}

/** The layout as a station file writes it: ids only where they aren't the widget's kind. */
export function toStationLayout(layout: ResolvedLayout): StationLayout {
  const out: Record<string, StationWidget[]> = {}
  for (const slot of STATION_SLOTS) {
    out[slot] = layout[slot].map(({ id, ...widget }) => (id === widget.widget ? widget : { ...widget, id }))
  }
  return out as StationLayout
}

export function findWidget(layout: ResolvedLayout, id: string): { slot: StationSlot; index: number; widget: PlacedWidget } | null {
  for (const slot of STATION_SLOTS) {
    const index = layout[slot].findIndex(w => w.id === id)
    if (index >= 0) return { slot, index, widget: layout[slot][index]! }
  }
  return null
}

const clone = (layout: ResolvedLayout): ResolvedLayout => ({ left: [...layout.left], right: [...layout.right], dock: [...layout.dock] })

/** Moves a widget to `slot` at `index` (clamped; the end when omitted). */
export function moveWidget(layout: ResolvedLayout, id: string, slot: StationSlot, index?: number): ResolvedLayout {
  const found = findWidget(layout, id)
  if (!found) return layout
  const next = clone(layout)
  next[found.slot].splice(found.index, 1)
  const at = Math.max(0, Math.min(next[slot].length, index ?? next[slot].length))
  next[slot].splice(at, 0, found.widget)
  return next
}

/** One step earlier or later in its slot. */
export function nudgeWidget(layout: ResolvedLayout, id: string, delta: -1 | 1): ResolvedLayout {
  const found = findWidget(layout, id)
  return found ? moveWidget(layout, id, found.slot, found.index + delta) : layout
}

export function removeWidget(layout: ResolvedLayout, id: string): ResolvedLayout {
  const found = findWidget(layout, id)
  if (!found) return layout
  const next = clone(layout)
  next[found.slot].splice(found.index, 1)
  return next
}

export function addWidget(layout: ResolvedLayout, widget: StationWidget, slot: StationSlot): ResolvedLayout {
  const used = new Set(STATION_SLOTS.flatMap(s => layout[s].map(w => w.id)))
  let id = widget.widget as string
  for (let n = 2; used.has(id); n++) id = `${widget.widget}-${n}`
  const next = clone(layout)
  next[slot].push({ ...widget, id })
  return next
}

export function updateWidget(layout: ResolvedLayout, id: string, patch: Partial<Omit<StationWidget, "widget">>): ResolvedLayout {
  const found = findWidget(layout, id)
  if (!found) return layout
  const next = clone(layout)
  const merged: PlacedWidget = { ...found.widget, ...patch, id }
  for (const key of ["title", "groups", "keys"] as const) if (merged[key] === undefined || (Array.isArray(merged[key]) && !merged[key].length)) delete merged[key]
  next[found.slot][found.index] = merged
  return next
}

const strings = (value: unknown) => Array.isArray(value) && value.every(v => typeof v === "string" && v.length > 0 && v.length <= 120)

/** A saved or pasted layout, checked whole: anything malformed rejects all of it (null) rather than half-applying. */
export function parseLayout(raw: unknown): StationLayout | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const out: Record<string, StationWidget[]> = {}
  for (const [slot, list] of Object.entries(raw)) {
    if (!STATION_SLOTS.includes(slot as StationSlot) || !Array.isArray(list) || list.length > 24) return null
    const widgets: StationWidget[] = []
    for (const item of list) {
      if (!item || typeof item !== "object") return null
      const { widget, id, title, groups, keys, ...rest } = item as Record<string, unknown>
      if (Object.keys(rest).length) return null
      if (typeof widget !== "string" || !WIDGET_KINDS.includes(widget as StationWidget["widget"])) return null
      if (id !== undefined && (typeof id !== "string" || !/^[a-z][a-z0-9-]{0,40}$/.test(id))) return null
      if (title !== undefined && (typeof title !== "string" || title.length > 80)) return null
      if (groups !== undefined && !strings(groups)) return null
      if (keys !== undefined && !strings(keys)) return null
      widgets.push({
        widget: widget as StationWidget["widget"],
        ...(id !== undefined ? { id: id as string } : {}),
        ...(title !== undefined ? { title: title as string } : {}),
        ...(groups !== undefined ? { groups: groups as string[] } : {}),
        ...(keys !== undefined ? { keys: keys as string[] } : {}),
      })
    }
    out[slot] = widgets
  }
  return out as StationLayout
}

const STORAGE_KEY = "arcade.lab.station-layouts.v1"
type Saved = { version: 1; layouts: Record<string, StationLayout> }

function readSaved(storage: Pick<Storage, "getItem"> | null): Saved {
  try {
    const raw = JSON.parse(storage?.getItem(STORAGE_KEY) ?? "null") as Saved | null
    if (raw?.version !== 1 || !raw.layouts || typeof raw.layouts !== "object") return { version: 1, layouts: {} }
    const layouts: Record<string, StationLayout> = {}
    for (const [id, layout] of Object.entries(raw.layouts)) {
      const parsed = parseLayout(layout)
      if (parsed) layouts[id] = parsed
    }
    return { version: 1, layouts }
  } catch {
    return { version: 1, layouts: {} }
  }
}

/** Kit's saved layout for a station in this browser, if any. */
export function savedLayout(storage: Pick<Storage, "getItem"> | null, station: string): StationLayout | null {
  return readSaved(storage).layouts[station] ?? null
}

/** Saves (or with null forgets) a station's layout in this browser. */
export function saveLayout(storage: Pick<Storage, "getItem" | "setItem"> | null, station: string, layout: StationLayout | null) {
  if (!storage) return
  const saved = readSaved(storage)
  if (layout) saved.layouts[station] = layout
  else delete saved.layouts[station]
  try { storage.setItem(STORAGE_KEY, JSON.stringify(saved)) } catch { /* full or private: the layout lasts this page */ }
}

/** The layout a station opens with: Kit's saved one, else its file's, else the default. */
export function stationLayout(station: LabStation, groups: readonly string[], storage: Pick<Storage, "getItem"> | null): ResolvedLayout {
  return resolveLayout(savedLayout(storage, station.id) ?? station.layout ?? defaultLayout(station, groups))
}
