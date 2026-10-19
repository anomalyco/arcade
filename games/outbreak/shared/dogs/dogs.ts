import { distToRect, type Rect } from "@arcade/kit/sim/geom"
import type { StoreState } from "@arcade/kit/sim/ledger"
import { EXTERIOR_VEHICLE_COLLIDERS, propShape, type Building, type Town } from "../map"

/**
 * Chained dogs (AR-56, D-37 pick 8): a few yards keep a dog on a chain by its kennel. It barks at anything that comes
 * near, the living and the dead alike, which warns a survivor that something is coming and calls more of the dead to
 * that yard. Feed it and it goes quiet for a while, and from then on it knows you: it only barks at the dead. Stay too
 * long among the dead it called and it is killed. Pure geometry and store naming; the state is one ledger store per dog.
 *
 * | Store | Counts | Meaning |
 * | --- | --- | --- |
 * | `dog:<building>` | `bark`, `since`, `fed`, `hush`, `near`, `dead` (times in deciseconds) | barking since `since`; fed (a friend to survivors); quiet until `hush`; the dead at it since `near`; killed |
 */

export type DogTuning = {
  /** How near something must come for the dog to bark at it, in metres. */
  dogSense: number
  /** How far each bark carries to the dead, in metres. */
  dogBarkNoise: number
  /** Seconds between barks. */
  dogBeat: number
  /** Seconds the dead must be at the dog before they kill it. */
  dogKillTime: number
  /** Seconds a fed dog stays quiet. */
  dogHushTime: number
}

export const DEFAULT_DOG_TUNING: DogTuning = {
  dogSense: 11,
  dogBarkNoise: 22,
  dogBeat: 1.1,
  dogKillTime: 3,
  dogHushTime: 120,
}

/** Lab controls for chained dogs (Backquote › Dogs); the values live in the Discovery settings. */
export const dogControls = [
  { key: "dogSense", label: "Dog barks at things within", group: "Dogs", min: 2, max: 25, step: 0.5, unit: "m" },
  { key: "dogBarkNoise", label: "Bark carries", group: "Dogs", min: 0, max: 50, step: 1, unit: "m" },
  { key: "dogBeat", label: "Bark every", group: "Dogs", min: 0.3, max: 4, step: 0.1, unit: "s" },
  { key: "dogKillTime", label: "Dead kill the dog after", group: "Dogs", min: 0.5, max: 15, step: 0.5, unit: "s" },
  { key: "dogHushTime", label: "Fed dog quiet for", group: "Dogs", min: 5, max: 600, step: 5, unit: "s" },
] as const

export const dogStoreId = (buildingId: string) => `dog:${buildingId}`

export type DogSite = {
  id: string
  buildingId: string
  /** The stake the chain is fixed to. */
  x: number
  y: number
  /** Chain length: how far from the stake the dog can go. */
  chain: number
  /** The kennel, beside the stake, and which way its door faces. */
  kennel: { x: number; y: number; yaw: number }
}

/** Homes that might keep a dog in the yard, and how many do, fixed per building. */
const DOG_HOMES: readonly string[] = ["house", "ranch", "cottage", "cabin"]
const DOG_CHANCE = 0.2
const CHAIN = 2.2

function hash01(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  h ^= h >>> 15
  h = Math.imul(h, 0x2c1b3c6d)
  h ^= h >>> 12
  return (h >>> 0) / 4294967296
}

/** Whether a yard spot is open: away from every building, wall, fence, door, piece of furniture and wreck by `r`. */
function open(town: Town, x: number, y: number, r: number): boolean {
  for (const b of town.buildings) if (distToRect(x, y, b.rect) < r) return false
  for (const b of town.barriers) if (distToRect(x, y, b.rect) < r * 0.6) return false
  for (const d of town.doors) if (distToRect(x, y, d.rect) < r) return false
  for (const p of town.props) {
    const s = propShape(p)
    if (s && distToRect(x, y, s.rect) < r * 0.6) return false
  }
  for (const v of (town.vehicles ?? EXTERIOR_VEHICLE_COLLIDERS) as readonly Rect[]) if (distToRect(x, y, v) < r) return false
  return true
}

/** A home's dog, if it keeps one: staked in a side yard where the camera sees it, the kennel against the stake. */
export function dogSite(town: Town, b: Building): DogSite | null {
  if (!DOG_HOMES.includes(b.archetype ?? b.kind)) return null
  if (hash01(`${town.seed}:dog:${b.id}`) >= DOG_CHANCE) return null
  const [x0, y0, x1, y1] = b.rect
  const my = (y0 + y1) / 2
  const east = hash01(`${town.seed}:dog-side:${b.id}`) < 0.5
  const spots = east ? [[x1 + 2.6, my + 1], [x0 - 2.6, my + 1], [x1 + 2.6, y1 - 1], [x0 - 2.6, y1 - 1]] : [[x0 - 2.6, my + 1], [x1 + 2.6, my + 1], [x0 - 2.6, y1 - 1], [x1 + 2.6, y1 - 1]]
  for (const [x, y] of spots as [number, number][]) {
    if (!open(town, x, y, 1.1)) continue
    // The chain's reach must stay in the yard, out of every building.
    let ok = true
    for (let i = 0; i < 8 && ok; i++) {
      const a = (i / 8) * Math.PI * 2
      if (town.buildings.some((o) => distToRect(x + Math.cos(a) * CHAIN, y + Math.sin(a) * CHAIN, o.rect) < 0.2)) ok = false
    }
    if (!ok) continue
    const side = x > x1 ? 1 : -1
    return {
      id: dogStoreId(b.id),
      buildingId: b.id,
      x: Number(x.toFixed(2)),
      y: Number(y.toFixed(2)),
      chain: CHAIN,
      // The kennel stands on the far side of the stake from the house, its door towards it.
      kennel: { x: Number((x + side * 0.75).toFixed(2)), y: Number((y - 0.2).toFixed(2)), yaw: side > 0 ? Math.PI : 0 },
    }
  }
  return null
}

export function dogSites(town: Town): DogSite[] {
  const out: DogSite[] = []
  for (const b of town.buildings) {
    const d = dogSite(town, b)
    if (d) out.push(d)
  }
  return out
}

export type DogState = "quiet" | "barking" | "fed" | "dead"

/** What a dog is doing at `time`, from its store. */
export function dogState(st: StoreState | undefined, time: number): DogState {
  if (!st) return "quiet"
  if (st.counts.dead) return "dead"
  if (Math.round(time * 10) < (st.counts.hush ?? 0)) return "fed"
  return st.counts.bark ? "barking" : "quiet"
}
