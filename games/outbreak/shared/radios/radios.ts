import type { StoreState } from "@arcade/kit/sim/ledger"
import type { Rect } from "@arcade/kit/sim/geom"
import { propShape, type Building, type Prop, type Town } from "../map"

/**
 * House radios (AR-56): a battery radio on a living-room table that a survivor can switch on and leave playing. While
 * it plays it calls the dead to that house on a beat, as a car alarm does, until its battery runs down, someone
 * switches it off, or the dead reach it and knock it to the floor. Pure geometry and store naming; the state is one
 * ledger store per radio, so it snapshots, saves, streams and reaches co-op clients like the car alarms.
 *
 * | Store | Counts | Meaning |
 * | --- | --- | --- |
 * | `radio:<building>` | `on`, `start`, `until`, `left`, `beats`, `near`, `broken` (times in deciseconds) | playing since `start` until its battery dies at `until`; battery `left` while off; bursts the dead have heard this play; the dead at it since `near`; knocked down |
 *
 * No store means a radio nobody has touched, with a full battery.
 */

export type RadioTuning = {
  /** How far each burst of the radio carries to the dead, in metres. */
  radioNoise: number
  /** Seconds between the bursts the dead hear while it plays. */
  radioBeat: number
  /** Seconds of play in a radio's battery, across every time it is switched on. */
  radioBattery: number
  /** Seconds the dead must stand at a playing radio before they knock it down. */
  radioBreakTime: number
  /** How close to a radio one of the dead must stand to knock it down, in metres. */
  radioReach: number
}

export const DEFAULT_RADIO_TUNING: RadioTuning = {
  radioNoise: 32,
  radioBeat: 1.5,
  radioBattery: 60,
  radioBreakTime: 2.5,
  radioReach: 1.6,
}

/** Lab controls for the radios' simulation (Backquote › Radios); the values live in the Discovery settings. */
export const radioControls = [
  { key: "radioNoise", label: "Radio reach", group: "Radios", min: 4, max: 40, step: 1, unit: "m" },
  { key: "radioBeat", label: "Radio burst every", group: "Radios", min: 0.5, max: 4, step: 0.1, unit: "s" },
  { key: "radioBattery", label: "Radio battery", group: "Radios", min: 5, max: 240, step: 5, unit: "s" },
  { key: "radioBreakTime", label: "Dead knock it down after", group: "Radios", min: 0.5, max: 10, step: 0.5, unit: "s" },
  { key: "radioReach", label: "Dead knock it down within", group: "Radios", min: 0.6, max: 3, step: 0.1, unit: "m" },
] as const

/** How loud the radio's thud is when the dead knock it off its table. */
export const RADIO_KNOCK_NOISE = 6

/** Deciseconds: store counts are integers, so times are kept to a tenth of a second. */
export const ds = (seconds: number) => Math.round(seconds * 10)

export const radioStoreId = (buildingId: string) => `radio:${buildingId}`

export type RadioSite = {
  id: string
  buildingId: string
  /** Plan position of the radio on its table. */
  x: number
  y: number
  /** Height of the table top it stands on. */
  z: number
  yaw: number
  /** The radio's own footprint, for prompts. */
  rect: Rect
}

/** Homes that keep a radio in the living room. */
export const RADIO_ARCHETYPES: readonly string[] = ["house", "ranch", "cottage", "cabin"]
/** About this share of homes still has one, fixed per building. */
const RADIO_CHANCE = 0.7
/** What a radio stands on: the living room's coffee table, else a dining table (neither is searched). */
const HOSTS: readonly Prop["kind"][] = ["coffee", "table"]
/** Their tops: the generated furniture's (0.46 m and 0.76 m), a little under the collision boxes, so it never floats. */
const TOPS: Partial<Record<Prop["kind"], number>> = { coffee: 0.46, table: 0.76 }

function hash01(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return (h >>> 0) / 4294967296
}

/** Where a building's radio stands, if it has one: on a corner of its coffee table, angled a little. */
export function radioSite(town: Town, b: Building): RadioSite | null {
  if (!RADIO_ARCHETYPES.includes(b.archetype ?? b.kind)) return null
  if (hash01(`radio:${b.id}`) >= RADIO_CHANCE) return null
  const inside = (p: Prop) => p.x >= b.rect[0] && p.x <= b.rect[2] && p.y >= b.rect[1] && p.y <= b.rect[3]
  let host: Prop | undefined
  for (const kind of HOSTS) {
    host = town.props.find((p) => p.kind === kind && inside(p))
    if (host) break
  }
  const shape = host ? propShape(host) : undefined
  if (!host || !shape) return null
  const [x0, y0, x1, y1] = shape.rect
  // The south corner, the side the camera looks at, clear of the table's edge.
  const x = Number((x0 + (x1 - x0) * 0.32).toFixed(3))
  const y = Number((y0 + (y1 - y0) * 0.7).toFixed(3))
  return {
    id: radioStoreId(b.id),
    buildingId: b.id,
    x,
    y,
    z: TOPS[host.kind] ?? shape.height,
    yaw: Number((hash01(b.id) * 0.6 - 0.3).toFixed(3)),
    rect: [x - 0.17, y - 0.1, x + 0.17, y + 0.1],
  }
}

export function radioSites(town: Town): RadioSite[] {
  const out: RadioSite[] = []
  for (const b of town.buildings) {
    const site = radioSite(town, b)
    if (site) out.push(site)
  }
  return out
}

/** What a radio is doing at `time`, read from its store (or none: untouched, off, full battery). */
export type RadioState = "off" | "playing" | "dead" | "broken"

export function radioState(st: StoreState | undefined, time: number): RadioState {
  if (!st) return "off"
  if (st.counts.broken) return "broken"
  if (st.counts.on && ds(time) < (st.counts.until ?? 0)) return "playing"
  if (st.counts.on) return "dead"
  return (st.counts.left ?? 1) > 0 ? "off" : "dead"
}

/** Seconds of battery left at `time`. */
export function radioBatteryLeft(st: StoreState | undefined, time: number, tuning: RadioTuning): number {
  if (!st) return tuning.radioBattery
  if (st.counts.on) return Math.max(0, ((st.counts.until ?? 0) - ds(time)) / 10)
  return Math.max(0, (st.counts.left ?? 0) / 10)
}
