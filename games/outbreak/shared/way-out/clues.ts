import type { Rect } from "@arcade/kit/sim/geom"
import { propShape, type Building, type Prop, type Town } from "../map"
import { DESTINATION_WORDS, roughDistance, type WayOutPlan } from "./plan"

/**
 * The Way Out's clues (AR-64), in three tiers. Drawings first, a few words under them (D-19's spirit).
 *
 * | Tier | Clue | Where | Fixed by |
 * | --- | --- | --- | --- |
 * | Rumour | radio broadcast | any house radio left playing while a broadcast is on | the hour |
 * | Rumour | scrawled note | on a table or dresser in some homes | town seed per building |
 * | Rumour | evacuation flyer | on some bodies, found by searching them | town seed per body |
 * | Direction | torn map piece | on a counter in every police station (one is always a block south of town) | — |
 * | Direction | road sign | on the pavement along the route, 300 m out | the plan |
 * | Direction | dead soldier with orders | on the verge along the route, 620 m out | the plan |
 * | Confirmed | two kinds of direction clue, or arriving | | |
 *
 * Every tier has more than one way in, so a run is never stuck: the police station and the two roadside clues are
 * always there, and arriving confirms on its own. Clue state is the squad's, in the `wayout` ledger store (`state.ts`).
 */

export type ClueKind = "radio" | "note" | "flyer" | "police" | "sign" | "soldier" | "arrive"

export const CLUE_TIER: Readonly<Record<ClueKind, 1 | 2 | 3>> = { radio: 1, note: 1, flyer: 1, police: 2, sign: 2, soldier: 2, arrive: 3 }

/** Event codes on the store's `last` count; clues first, then what happens at the destination. */
export const CLUE_CODE: Readonly<Record<ClueKind, number>> = { radio: 1, note: 2, flyer: 3, police: 4, sign: 5, soldier: 6, arrive: 7 }
export const EVENT_SIGNAL = 9
export const EVENT_MISSED = 10
export const EVENT_LATE_BOAT = 11
export const EVENT_LEFT_BEHIND = 12
export const EVENT_ESCAPED = 13
export const EVENT_UNSEEN = 14

export function clueKindOfCode(code: number): ClueKind | null {
  for (const [k, v] of Object.entries(CLUE_CODE)) if (v === code) return k as ClueKind
  return null
}

/** A clue lying in the world: a note on a table, a map piece on a counter, the sign, the soldier. */
export type ClueSite = { id: string; kind: ClueKind; x: number; y: number; z: number; yaw: number; buildingId?: string; rect: Rect }

export function hash01(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  h ^= h >>> 15
  h = Math.imul(h, 0x2c1b3c6d)
  h ^= h >>> 12
  return (h >>> 0) / 4294967296
}

const HOMES: readonly string[] = ["house", "ranch", "cottage", "cabin"]
const NOTE_HOSTS: readonly Prop["kind"][] = ["table", "dresser", "nightstand", "counter"]
const MAP_HOSTS: readonly Prop["kind"][] = ["counter", "table", "shelf", "dresser"]
const TOPS: Partial<Record<Prop["kind"], number>> = { table: 0.79, dresser: 1.1, nightstand: 0.66, counter: 1.02, shelf: 1.8 }

const inside = (b: Building) => (p: Prop) => p.x >= b.rect[0] && p.x <= b.rect[2] && p.y >= b.rect[1] && p.y <= b.rect[3]
const round = (n: number) => Number(n.toFixed(3))
const rectAt = (x: number, y: number, r = 0.22): Rect => [x - r, y - r, x + r, y + r]

/** A paper on a piece of furniture in `b`: the first host kind found, a little off its centre (the last host for `last`). */
function paperOn(town: Town, b: Building, hosts: readonly Prop["kind"][], salt: string, last = false): { x: number; y: number; z: number } {
  const props = town.props.filter(inside(b))
  for (const kind of hosts) {
    const all = props.filter((p) => p.kind === kind)
    const host = last ? all.at(-1) : all[0]
    const shape = host ? propShape(host) : undefined
    if (!host || !shape) continue
    const w = shape.rect[2] - shape.rect[0]
    const d = shape.rect[3] - shape.rect[1]
    return { x: round(host.x + (hash01(`${salt}x`) - 0.5) * w * 0.4), y: round(host.y + (hash01(`${salt}y`) - 0.5) * d * 0.3), z: TOPS[kind] ?? shape.height }
  }
  // No furniture: on the floor a little in from the middle.
  return { x: round(b.rect[0] + (b.rect[2] - b.rect[0]) * 0.4), y: round(b.rect[1] + (b.rect[3] - b.rect[1]) * 0.45), z: 0.01 }
}

/** Homes with a scrawled note, fixed per building from the plan's seed. */
export function noteSites(town: Town, seed: number, share: number): ClueSite[] {
  const out: ClueSite[] = []
  if (share <= 0) return out
  for (const b of town.buildings) {
    if (!HOMES.includes(b.archetype ?? b.kind)) continue
    if (hash01(`note:${seed}:${b.id}`) >= share) continue
    const at = paperOn(town, b, NOTE_HOSTS, `note:${b.id}`)
    out.push({ id: `note:${b.id}`, kind: "note", ...at, yaw: round(hash01(`noteyaw:${b.id}`) * 1.2 - 0.6), buildingId: b.id, rect: rectAt(at.x, at.y) })
  }
  return out
}

/** A torn map piece in every police station, on its last counter (the first holds the station's page). */
export function policeSites(town: Town): ClueSite[] {
  const out: ClueSite[] = []
  for (const b of town.buildings) {
    if ((b.archetype ?? b.kind) !== "police") continue
    const at = paperOn(town, b, MAP_HOSTS, `police:${b.id}`, true)
    out.push({ id: `police:${b.id}`, kind: "police", ...at, yaw: round(hash01(`mapyaw:${b.id}`) * 0.8 - 0.4), buildingId: b.id, rect: rectAt(at.x, at.y) })
  }
  return out
}

/** The road sign and the dead soldier along the route. */
export function roadSites(plan: WayOutPlan): ClueSite[] {
  return [
    { id: "sign", kind: "sign", x: plan.sign.x, y: plan.sign.y, z: 0, yaw: plan.sign.yaw, rect: rectAt(plan.sign.x, plan.sign.y, 0.6) },
    { id: "soldier", kind: "soldier", x: plan.soldier.x, y: plan.soldier.y, z: 0, yaw: plan.soldier.yaw, rect: rectAt(plan.soldier.x, plan.soldier.y, 0.55) },
  ]
}

/** Whether the body `key` carries an evacuation flyer. */
export const carriesFlyer = (seed: number, bodyKey: string, share: number) => share > 0 && hash01(`flyer:${seed}:${bodyKey}`) < share

/** Whether a broadcast is on at `hour`: the first `length` hours of every `every`. */
export function broadcastOn(hour: number, every: number, length: number): boolean {
  const e = Math.max(0.25, every)
  return ((hour % e) + e) % e < Math.min(e, Math.max(0, length))
}

/** "Dawn, Day 6": the dawn after night `n` is the morning of Day n + 1. */
export const deadlineText = (night: number) => `dawn, Day ${night + 1}`

/** What each clue says, in as few words as it can: the drawing carries the rest. */
export function clueWords(kind: ClueKind, plan: WayOutPlan, deadlineNight: number): { title: string; lines: string[] } {
  const w = DESTINATION_WORDS[plan.kind]
  switch (kind) {
    case "radio":
      return { title: "…evacuation…", lines: [`“…last ${w.craft}… the ${w.place}… before ${deadlineText(deadlineNight)}…”`] }
    case "note":
      return { title: "They're getting people out", lines: [`“The ${w.place}. Too far to walk. Find a car.”`] }
    case "flyer":
      return { title: "Evacuation", lines: [`${w.short}. Last one leaves ${deadlineText(deadlineNight)}.`] }
    case "police":
      return { title: "A torn map", lines: [`${w.short}, ${plan.bearing}. ${roughDistance(plan.distance)} by road.`, "Too far on foot."] }
    case "sign":
      return { title: `${w.short} →`, lines: [`${roughDistance(Math.max(0, plan.distance - plan.sign.along))}`] }
    case "soldier":
      return { title: "Orders", lines: [`Hold the ${w.place} until ${deadlineText(deadlineNight)}.`, `The road in from the ${plan.arrival} is open.`] }
    case "arrive":
      return { title: w.short, lines: ["Signal them. Then hold until dawn."] }
  }
}
