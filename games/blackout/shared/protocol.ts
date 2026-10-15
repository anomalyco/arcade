import { LOWER_CODE_CHARS, cleanPlayerName, randomRoomCode } from "@arcade/kit/sim/matchmaking"
import type { RoomFrame } from "@arcade/kit/net/room-core"
import { EQUIP_IDS, type Equip, GUN_IDS, type Gun } from "./config"
import { type MapChoice, mapChoiceOf } from "./maps"
import { type ModeId, modeOf } from "./sim/modes"
import type { RosterRow, Snapshot } from "./sim/view"
import type { Intent, SimEvent } from "./sim/world"
import { spellConfig, type SpellConfig, type CastIntent } from "./sim/spell-config"
import { type PackedSnapshot, packSnapshot, unpackSnapshot } from "./wire"

export type ClientMsg =
  | { type: "spells"; config: SpellConfig }
  /** `build` is the client's BUILD (shared/build.gen.ts); the server tells a mismatched client to reload. */
  /** `token` is the private seat token from an earlier welcome, to reclaim the seat after a drop. */
  | { type: "hello"; name: string; token?: string; gun: Gun; equip: Equip; build?: string }
  | { type: "intent"; seq: number; i: Intent; prev?: readonly Intent[] }
  | { type: "gun"; gun: Gun }
  | { type: "equip"; equip: Equip }
  | { type: "vote"; mode: ModeId }
  /** Room host, team modes: move a player to a team, or shuffle everyone. */
  | { type: "team"; id: string; team: 0 | 1 }
  | { type: "shuffle" }
  /** Room host: restart the match in the current mode, or switch to another; a new floor unless newFloor is false. */
  | { type: "host"; action: "reset"; newFloor: boolean }
  | { type: "host"; action: "mode"; mode: ModeId; newFloor: boolean }
  /** Room host: what the room plays on from the next new map (office, downtown or a random kind each match). */
  | { type: "host"; action: "maps"; maps: MapChoice }
  | { type: "ping"; t: number }

export type ServerMsg = RoomFrame<RosterRow, SimEvent> | Snapshot

export const NAME_MAX = 14

/** Snapshots go out packed (`./wire`); every other float is rounded to 3 decimals to keep frames small. */
export function encodeServer(msg: ServerMsg): string {
  return JSON.stringify(msg.type === "snap" ? packSnapshot(msg) : msg, (_k, v: unknown) => (typeof v === "number" && !Number.isInteger(v) ? Math.round(v * 1000) / 1000 : v))
}

export function decodeServer(raw: string): ServerMsg | null {
  try {
    const m = JSON.parse(raw) as ServerMsg | PackedSnapshot
    if (!m || typeof m.type !== "string") return null
    return m.type === "snap" && "P" in m ? unpackSnapshot(m) : (m as ServerMsg)
  } catch {
    return null
  }
}

export const encodeClient = (msg: ClientMsg) => JSON.stringify(msg)

export const cleanName = (v: unknown): string => cleanPlayerName(v, NAME_MAX, "stranger")

const num = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : 0)

const gunOf = (v: unknown): Gun => (GUN_IDS as readonly unknown[]).includes(v) ? (v as Gun) : "rifle"
const equipOf = (v: unknown): Equip => (EQUIP_IDS as readonly unknown[]).includes(v) ? (v as Equip) : "frag"

function parseIntent(raw: unknown): Intent | null {
  if (!raw || typeof raw !== "object") return null
  const i = raw as Record<string, unknown>
  const c = i.cast as Record<string, unknown> | undefined
  const cast: CastIntent | undefined =
    c && typeof c === "object" && (c.spell === null || c.spell === "moon" || c.spell === "necromancy") && [c.x, c.y, c.quality].every((v) => typeof v === "number" && Number.isFinite(v))
      ? { spell: c.spell, quality: num(c.quality, 0, 1), x: num(c.x, -1000, 1000), y: num(c.y, -1000, 1000) }
      : undefined
  const view = typeof i.view === "number" && Number.isFinite(i.view) && i.view >= 0 ? num(i.view, 0, 1e7) : undefined
  return {
    mx: num(i.mx, -1, 1),
    my: num(i.my, -1, 1),
    aim: num(i.aim, -7, 7),
    fire: i.fire === true,
    ...(i.firePressed === true ? { firePressed: true } : {}),
    reload: i.reload === true,
    sprint: i.sprint === true,
    equip: i.equip === true,
    tx: num(i.tx, -1000, 1000),
    ty: num(i.ty, -1000, 1000),
    use: i.use === true,
    melee: i.melee === true,
    ...(cast ? { cast } : {}),
    ...(i.enter === true ? { enter: true } : {}),
    ...(i.seat === true ? { seat: true } : {}),
    ...(i.horn === true ? { horn: true } : {}),
    ...(view !== undefined ? { view } : {}),
  }
}

/** Validates an untrusted client frame. Returns null for anything malformed. */
export function decodeClient(raw: unknown): ClientMsg | null {
  if (typeof raw !== "string" || raw.length > 2048) return null
  let o: Record<string, unknown>
  try {
    const v = JSON.parse(raw)
    if (!v || typeof v !== "object") return null
    o = v as Record<string, unknown>
  } catch {
    return null
  }
  switch (o.type) {
    case "hello": {
      const token = typeof o.token === "string" && /^[a-f0-9]{32}$/.test(o.token) ? o.token : undefined
      const build = typeof o.build === "string" && /^[a-f0-9]{1,32}$/.test(o.build) ? o.build : undefined
      return { type: "hello", name: cleanName(o.name), token, gun: gunOf(o.gun), equip: equipOf(o.equip), build }
    }
    case "intent": {
      if (typeof o.seq !== "number" || !Number.isInteger(o.seq) || o.seq < 0) return null
      const i = parseIntent(o.i)
      if (!i) return null
      let prev: Intent[] | undefined
      if (Array.isArray(o.prev) && o.prev.length <= 3) {
        const parsed = o.prev.map(parseIntent).filter((x): x is Intent => x !== null)
        if (parsed.length === o.prev.length && parsed.length > 0) prev = parsed
      }
      return prev ? { type: "intent", seq: o.seq, i, prev } : { type: "intent", seq: o.seq, i }
    }
    case "gun":
      return { type: "gun", gun: gunOf(o.gun) }
    case "spells":
      return { type: "spells", config: spellConfig(o.config) }
    case "equip":
      return { type: "equip", equip: equipOf(o.equip) }
    case "vote": {
      const mode = modeOf(o.mode)
      return mode ? { type: "vote", mode } : null
    }
    case "team":
      return typeof o.id === "string" && /^[a-z0-9]{1,16}$/.test(o.id) && (o.team === 0 || o.team === 1) ? { type: "team", id: o.id, team: o.team } : null
    case "shuffle":
      return { type: "shuffle" }
    case "host": {
      const newFloor = o.newFloor !== false
      if (o.action === "reset") return { type: "host", action: "reset", newFloor }
      if (o.action === "maps") {
        const maps = mapChoiceOf(o.maps)
        return maps ? { type: "host", action: "maps", maps } : null
      }
      const mode = modeOf(o.mode)
      return o.action === "mode" && mode ? { type: "host", action: "mode", mode, newFloor } : null
    }
    case "ping":
      return { type: "ping", t: num(o.t, 0, Number.MAX_SAFE_INTEGER) }
    default:
      return null
  }
}

export const CODE_CHARS = LOWER_CODE_CHARS
export const randomCode = (rand: () => number = Math.random): string => randomRoomCode(CODE_CHARS, rand)
