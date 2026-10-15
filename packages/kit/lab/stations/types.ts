import type { LabValue } from "../../lab-navigation"
import { VARIATION_GRID_PRESETS } from "../variation-grid"

/** One command the station runs through the Lab's command registry, as `arcade run <command> '<args>'` would. */
export type StationCommand = { command: string; args?: Record<string, LabValue> }

export type StationVariant = {
  id: string
  label: string
  note?: string
  /** Commands that put the station's demo into this variant. */
  setup?: readonly StationCommand[]
  /** For page demos: the page URL that shows this variant. */
  url?: string
  /** For stations pinned to an existing board decision: the option letter this variant corresponds to. */
  boardOption?: string
}

export type StationStatus = "live" | "in-progress" | "review" | "planned"

/** The old Overworld's diorama props. Still accepted in station files; nothing draws them now. */
export type StationProp =
  | "burst" | "smoke" | "cloud" | "tree" | "panels" | "lamp" | "swatches" | "figure" | "speaker" | "house" | "office" | "car" | "ship"

/**
 * What runs when the station is focused. `section` selects a Lab section by id (loading `game`'s adapters first when
 * the section belongs to a game), then runs `setup`. `page` shows another Arcade page in the viewport.
 */
export type StationDemo =
  | { kind: "section"; section: string; game?: string; setup?: readonly StationCommand[]; camera?: StationCamera }
  | { kind: "page"; url: string }

/** Orbit camera for a section demo: yaw and pitch in degrees, distance in metres. */
export type StationCamera = { yaw?: number; pitch?: number; distance?: number; target?: readonly [number, number, number] }

export type StationMetric = { label: string; value: string; source?: string }
export type StationLink = { label: string; href: string }

export type LabStation = {
  /** Stable id used by `arcade station <id>`, URLs and the board. */
  id: string
  title: string
  /** One or two plain sentences: what this station shows. */
  summary: string
  /** Position in the station list; the first ten get keys 1–9 and 0. */
  order: number
  /** Accepted for older station files; unused. */
  prop?: StationProp
  /** The station's accent colour as 0xRRGGBB (its list chip and widget edge). */
  color?: number
  status: StationStatus
  statusNote?: string
  demo: StationDemo
  variants?: readonly StationVariant[]
  /** The variant the demo's setup already shows, highlighted when the station opens. */
  defaultVariant?: string
  /** Variation-grid preset to open from the station panel (`grid.open`). */
  grid?: string
  /** Board feature (and decision, if one already exists) that voice notes from this station go to. */
  board?: { feature: string; decision?: string }
  /** Measured numbers worth showing next to the demo, each with where it was measured. */
  metrics?: readonly StationMetric[]
  /** Repository paths whose recent commits the panel lists (dev server only). */
  paths?: readonly string[]
  /** Branch names (or prefixes ending in `*`) whose unmerged work the panel lists. */
  branches?: readonly string[]
  links?: readonly StationLink[]
  /** Widgets around the viewport. Without it the station gets `defaultLayout`; Kit's saved edits override both. */
  layout?: StationLayout
}

/** Where a widget sits: the Outliner column, the top of the Details column, or the dock under the viewport. */
export type StationSlot = "left" | "right" | "dock"
export const STATION_SLOTS: readonly StationSlot[] = ["left", "right", "dock"]

export type StationWidgetKind = "status" | "controls" | "variants" | "compare" | "perf" | "metrics" | "changes" | "notes" | "voice" | "links"

/**
 * One widget. `controls` shows knobs cards for the section's `groups` (Details group titles) and single `keys`;
 * every other kind reads the station file. `id` tells two widgets of the same kind apart.
 */
export type StationWidget = {
  widget: StationWidgetKind
  id?: string
  title?: string
  groups?: readonly string[]
  keys?: readonly string[]
}

export type StationLayout = { [S in StationSlot]?: readonly StationWidget[] }

/** What the voice-note recorder and `station.list` read about the open station. */
export type StationSnapshot = {
  view: "lab" | "station"
  station: LabStation | null
  variant: StationVariant | null
  section: string | null
  url: string
}
export type StationEvent =
  | { kind: "station"; station: string | null }
  | { kind: "variant"; station: string; variant: string }

/** Lab settings from a variation-grid preset's tiles, as station variants. */
export function gridVariants(preset: string, pick?: readonly string[]): StationVariant[] {
  const config = VARIATION_GRID_PRESETS[preset]
  if (!config) throw new Error(`Unknown variation grid preset "${preset}"`)
  const tiles = pick ? pick.map(id => config.tiles.find(tile => tile.id === id)).filter(tile => tile !== undefined) : config.tiles
  return tiles.map(tile => ({
    id: tile.id ?? tile.label.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    label: tile.label,
    note: tile.subtitle,
    setup: [
      ...Object.entries(tile.settings ?? {}).map(([key, value]) => ({ command: "scene.set-param", args: { key, value } })),
      ...Object.entries(tile.lighting ?? {}).map(([key, value]) => ({ command: "scene.set-param", args: { key, value } })),
    ],
  }))
}

const ID = /^[a-z][a-z0-9-]{1,40}$/
const FEATURE = /^[A-Z]+-\d+$/
const DECISION = /^D-\d+$/

/** Checks a station list; returns readable problems instead of throwing so one bad file can't take the hub down. */
export function validateStations(stations: readonly LabStation[]): string[] {
  const problems: string[] = []
  const ids = new Set<string>()
  for (const s of stations) {
    const at = `station "${s.id}"`
    if (!ID.test(s.id)) problems.push(`${at}: id must be lowercase letters, digits and dashes`)
    if (ids.has(s.id)) problems.push(`${at}: duplicate id`)
    ids.add(s.id)
    if (!s.title.trim()) problems.push(`${at}: missing title`)
    if (!s.summary.trim()) problems.push(`${at}: missing summary`)
    if (!Number.isFinite(s.order)) problems.push(`${at}: order must be a number`)
    if (s.board && !FEATURE.test(s.board.feature)) problems.push(`${at}: board.feature must look like AR-12`)
    if (s.board?.decision && !DECISION.test(s.board.decision)) problems.push(`${at}: board.decision must look like D-6`)
    if (s.grid && !VARIATION_GRID_PRESETS[s.grid]) problems.push(`${at}: unknown grid preset "${s.grid}"`)
    if (s.demo.kind === "page" && !s.demo.url.startsWith("/arcade/")) problems.push(`${at}: page demos must be Arcade paths`)
    const variants = new Set<string>()
    for (const v of s.variants ?? []) {
      if (variants.has(v.id)) problems.push(`${at}: duplicate variant "${v.id}"`)
      variants.add(v.id)
    }
    if (s.defaultVariant && !variants.has(s.defaultVariant)) problems.push(`${at}: defaultVariant "${s.defaultVariant}" is not one of its variants`)
    for (const slot of Object.keys(s.layout ?? {})) {
      if (!STATION_SLOTS.includes(slot as StationSlot)) problems.push(`${at}: layout slot "${slot}" must be left, right or dock`)
      for (const w of s.layout?.[slot as StationSlot] ?? []) if (!WIDGET_KINDS.includes(w.widget)) problems.push(`${at}: unknown widget "${w.widget}"`)
    }
  }
  return problems
}

/** Stations in strip order, with their quick-travel key (1–9, then 0). */
export function orderStations(stations: readonly LabStation[]): { station: LabStation; key: string | null }[] {
  return [...stations]
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map((station, i) => ({ station, key: i < 9 ? String(i + 1) : i === 9 ? "0" : null }))
}

export const WIDGET_KINDS: readonly StationWidgetKind[] = ["status", "controls", "variants", "compare", "perf", "metrics", "changes", "notes", "voice", "links"]

export const STATUS_LABEL: Record<StationStatus, string> = {
  live: "Live",
  "in-progress": "In progress",
  review: "In review",
  planned: "Planned",
}
