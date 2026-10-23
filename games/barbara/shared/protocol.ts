import type { RoomClientFrame, RoomFrame } from "@arcade/kit/net/room-core"
import type { InputOps } from "@arcade/kit/net/jitter-buffer"
import { cleanPlayerName } from "@arcade/kit/sim/matchmaking"
import { FEEL, SIGNAL_HOLD_SECONDS, type MapKnowledge, type Player, type PlayerInput, type Tape, type WoodsEvent } from "./sim"
import { TAPE_HEIGHT } from "./sim"
import type { DistantState } from "./distant"
import type { NightPhase, NightReason, NightState } from "./night"
import type { WoodsWorld } from "./world"

/**
 * The woods room's wire format (JSON over the room WebSocket, `@arcade/kit/net/room-core` frames plus a snapshot).
 * Inputs are quantized before the client predicts with them, so the room steps exactly the numbers the client did.
 */
export const GAME = "barbara"
export const TICK_HZ = 30
export const TICK_DT = 1 / TICK_HZ
/** Snapshots every 2 ticks: 15 Hz. */
export const SNAP_EVERY = 2
export const MAX_PLAYERS = 6
/** Bots fill a room up to this many walkers; they leave as people arrive. */
export const TEAM = 4
/** A dropped person's seat, place and map are held this long for a reconnect. */
export const GRACE_MS = 90_000
export const ROOM_CODE = /^[a-z0-9]{4,8}$/
/** The room runs the default feel, and clients predict their own walking with it (Lab knobs don't change the room). */
export const ROOM_FEEL = FEEL
export const MAX_NAME = 16

const q = (v: number, k: number) => Math.round(v * k) / k
const wrapAngle = (a: number) => a - Math.round(a / (2 * Math.PI)) * 2 * Math.PI

/** Rounds an input to what survives the wire (`packIntent`/`unpackIntent`). */
export function quantizeInput(i: PlayerInput): PlayerInput {
  return unpackIntent(packIntent(i))
}
export function packIntent(i: PlayerInput): number[] {
  const bits = (i.light ? 1 : 0) | (i.tie ? 2 : 0) | (i.map ? 4 : 0) | (i.sprint ? 8 : 0) | (i.jump ? 16 : 0)
  return [Math.round(i.mx * 100), Math.round(i.mz * 100), Math.round(wrapAngle(i.yaw) * 1000), Math.round(i.pitch * 1000), bits]
}
export function unpackIntent(a: readonly number[]): PlayerInput {
  const n = (k: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Number.isFinite(a[k]) ? a[k]! : 0))
  const bits = n(4, 0, 31) | 0
  let mx = n(0, -100, 100) / 100, mz = n(1, -100, 100) / 100
  const len = Math.hypot(mx, mz)
  if (len > 1) { mx /= len; mz /= len }
  return { mx, mz, yaw: n(2, -3200, 3200) / 1000, pitch: n(3, -1500, 1500) / 1000, light: !!(bits & 1), tie: !!(bits & 2), map: !!(bits & 4), sprint: !!(bits & 8), jump: !!(bits & 16) }
}

/** Tie/map are held; a jump press is carried over stalls and never repeated by a stand-in. */
export const intentOps: InputOps<PlayerInput> = {
  merge: (a, b) => ({ ...b, jump: !!(a.jump || b.jump) }),
  standIn: (last) => ({ ...last, jump: false }),
  hasEdges: (i) => !!i.jump,
}

// ---------------------------------------------------------------- client → room

export type Hello = { type: "hello"; token?: string; build?: string; name?: string }
/** `again`: start the next night from the debrief (anyone in the room, once the night has ended). */
export type ClientMsg = Hello | { type: "intent"; seq: number; i: PlayerInput } | { type: "name"; name: string } | { type: "again" }

export function decodeClient(raw: unknown): (ClientMsg | RoomClientFrame<PlayerInput>) | null {
  if (typeof raw !== "string" || raw.length > 2048) return null
  let m: { type?: unknown; t?: unknown; token?: unknown; build?: unknown; name?: unknown; seq?: unknown; i?: unknown }
  try { m = JSON.parse(raw) } catch { return null }
  if (!m || typeof m !== "object") return null
  if (m.type === "ping" && typeof m.t === "number") return { type: "ping", t: m.t }
  if (m.type === "hello") return { type: "hello", token: typeof m.token === "string" ? m.token.slice(0, 64) : undefined, build: typeof m.build === "string" ? m.build.slice(0, 32) : undefined, name: cleanPlayerName(m.name, MAX_NAME, "") }
  if (m.type === "again") return { type: "again" }
  if (m.type === "name") { const name = cleanPlayerName(m.name, MAX_NAME, ""); return name ? { type: "name", name } : null }
  if (m.type === "intent" && typeof m.seq === "number" && Number.isInteger(m.seq) && m.seq >= 0 && Array.isArray(m.i)) return { type: "intent", seq: m.seq, i: unpackIntent(m.i as number[]) }
  return null
}

// ---------------------------------------------------------------- room → client

/** Player row: id, x·100, z·100, vx·100, vz·100, yaw·1000, pitch·1000, bits, tie progress·100, tie tree (−1), battery·100, hop y·1000, hop v·1000. */
export type PlayerRow = number[]
export const BIT = { light: 1, flicker: 2, bot: 4, signal: 8, untie: 16, map: 32, away: 64, spare: 128, swap: 256 } as const

/** The night as a room sends it when it changes (`NightState` without what a client works out from the seed). */
export type NightWire = { seed: number; phase: NightPhase; start: number; dawn: number; end: number; reason: NightReason; finds: number[][]; taken: number[]; calls: number }
const ms = (v: number) => Math.round(v * 1000) / 1000
export function nightWire(n: NightState): NightWire {
  return { seed: n.seed, phase: n.phase, start: ms(n.start), dawn: ms(n.dawn), end: ms(n.end), reason: n.reason, finds: n.finds.map((f) => (f.held === undefined ? [f.clue, f.by, ms(f.at)] : [f.clue, f.by, ms(f.at), f.held])), taken: n.taken.slice(), calls: n.calls }
}
/** A client's night from the room's (its layout is placed again only when the seed changes). */
export function applyNightWire(n: NightState, w: NightWire): void {
  Object.assign(n, { phase: w.phase, start: w.start, dawn: w.dawn, end: w.end, reason: w.reason, taken: w.taken.slice(), calls: w.calls ?? 0 })
  n.finds = w.finds.map(([clue, by, at, held]) => (held === undefined ? { clue: clue!, by: by!, at: at! } : { clue: clue!, by: by!, at: at!, held }))
}

/** Who is in the room: seat id (public), player id in the sim, name, connected. */
export type RosterRow = { id: string; pid: number; name: string; connected: boolean }

export type Snapshot = {
  type: "s"
  /** Room clock (s). */
  t: number
  /** Last input sequence the room applied for you. */
  ack: number
  /** Your player id. */
  me: number
  /** Your authoritative motion: x, z, vx, vz, map raise, hop y, hop v, yaw, pitch, light (0/1). */
  you?: number[]
  p: PlayerRow[]
  /** Everyone's names by player id, when the set of walkers changes. */
  names?: Record<number, string>
  /** All tapes [id, tree, yaw·1000, by, at·10], on join only; `tape-tied`/`tape-removed` events keep them after. */
  tapes?: number[][]
  /** Marker id → finders, when it changes. */
  found?: Record<number, number[]>
  /** Your map's new pencil marks, as changes since the last snapshot (all of it with `reset`, on join). */
  map?: MapDelta
  /** The room's distant-sound schedule, on join only (`distant` events carry each sound after). */
  distant?: DistantState
  /** The night (clock, finds, spares taken), when it changes. */
  night?: NightWire
}

/**
 * Changes to your map: own path points from index `from`; tape ids learned (`tapes`) and gone (`gone`); the markers;
 * copied friends' paths as points appended from index `at` (0 = replace) and the friends whose copies were dropped.
 */
export type MapDelta = {
  reset?: true
  from: number
  trail: number[]
  tapes?: number[]
  gone?: number[]
  markers?: number[]
  /** Clue ids on your map, all of them, when that changes. */
  clues?: number[]
  heard?: { from: number; at: number; trail: number[] }[]
  unheard?: number[]
}

/** A client's copy of its map from the room's deltas. */
export function applyMapDelta(m: MapKnowledge, d: MapDelta): void {
  if (d.reset) { m.trail = []; m.tapes = []; m.markers = []; m.heard = []; m.clues = [] }
  m.trail.length = Math.min(m.trail.length, d.from)
  m.trail.push(...d.trail)
  if (d.gone) m.tapes = m.tapes.filter((id) => !d.gone!.includes(id))
  if (d.tapes) for (const id of d.tapes) if (!m.tapes.includes(id)) m.tapes.push(id)
  if (d.markers) m.markers = d.markers
  if (d.clues) m.clues = d.clues
  if (d.unheard) m.heard = m.heard.filter((h) => !d.unheard!.includes(h.from))
  for (const h of d.heard ?? []) {
    let e = m.heard.find((x) => x.from === h.from)
    if (!e) m.heard.push((e = { from: h.from, serial: 0, trail: [] }))
    e.trail.length = Math.min(e.trail.length, h.at)
    e.trail.push(...h.trail)
  }
}

export type ServerMsg = RoomFrame<RosterRow, WoodsEvent> | Snapshot

export function playerRow(p: Player, away: boolean): PlayerRow {
  const bits = (p.light ? BIT.light : 0) | (p.flickerLeft > 0 ? BIT.flicker : 0) | (p.bot ? BIT.bot : 0) | (p.signal > SIGNAL_HOLD_SECONDS ? BIT.signal : 0) | (p.tie?.removing ? BIT.untie : 0) | (p.mapRaise > 0.5 ? BIT.map : 0) | (away ? BIT.away : 0) | (p.spare ? BIT.spare : 0) | (p.swap > 0 ? BIT.swap : 0)
  return [p.id, Math.round(p.x * 100), Math.round(p.z * 100), Math.round(p.vx * 100), Math.round(p.vz * 100), Math.round(wrapAngle(p.yaw) * 1000), Math.round(p.pitch * 1000), bits, p.tie ? Math.round(p.tie.progress * 100) : 0, p.tie ? p.tie.tree : -1, Math.ceil(p.charge * 100), Math.round(p.air.y * 1000), Math.round(p.air.v * 1000)]
}

export const tapeRow = (t: Tape): number[] => [t.id, t.tree, Math.round(t.yaw * 1000), t.by, Math.round(t.at * 10)]
export function tapeFromRow(world: WoodsWorld, r: readonly number[]): Tape | null {
  const tree = world.trees[r[1]!]
  return tree ? { id: r[0]!, tree: tree.id, x: tree.x, y: tree.y + TAPE_HEIGHT, z: tree.z, yaw: r[2]! / 1000, by: r[3]!, at: r[4]! / 10 } : null
}

export const roundTrail = (trail: readonly number[], from = 0) => trail.slice(from).map((v) => q(v, 100))
export const encodeServer = (m: ServerMsg) => JSON.stringify(m)
export function decodeServer(raw: string): ServerMsg | null {
  try { const m = JSON.parse(raw); return m && typeof m.type === "string" ? m : null } catch { return null }
}
