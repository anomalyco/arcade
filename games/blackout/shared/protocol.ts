import { LOWER_CODE_CHARS, cleanPlayerName, randomRoomCode } from "@arcade/kit/sim/matchmaking"
import { EQUIP_IDS, type Equip, GUN_IDS, type Gun } from "./config"
import { type MapChoice, mapChoiceOf } from "./maps"
import { type ModeId, modeOf } from "./sim/modes"
import type { RosterRow, Snapshot } from "./sim/view"
import type { Intent, SimEvent } from "./sim/world"
import { spellConfig, type SpellConfig, type CastIntent } from "./sim/spell-config"

export type ClientMsg =
  | { type: "spells"; config: SpellConfig }
  /** `build` is the client's BUILD (shared/build.gen.ts); the server tells a mismatched client to reload. */
  | { type: "hello"; name: string; id?: string; gun: Gun; equip: Equip; build?: string }
  | { type: "intent"; seq: number; i: Intent }
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

export type ServerMsg =
  | { type: "welcome"; id: string; room: string }
  | Snapshot
  | { type: "roster"; players: RosterRow[] }
  | { type: "ev"; events: SimEvent[] }
  | { type: "error"; message: string }
  /** The server runs different shared code than this client: reload the page. */
  | { type: "reload" }
  /** Seconds until you're kicked for idling, during the warning; 0 clears it. */
  | { type: "idle"; seconds: number }
  | { type: "pong"; t: number }

export const NAME_MAX = 14

/** Rounds floats to 3 decimals to keep frames small. */
export function encodeServer(msg: ServerMsg): string {
  return JSON.stringify(msg, (_k, v: unknown) => (typeof v === "number" && !Number.isInteger(v) ? Math.round(v * 1000) / 1000 : v))
}

export function decodeServer(raw: string): ServerMsg | null {
  try {
    const m = JSON.parse(raw) as ServerMsg
    return m && typeof m.type === "string" ? m : null
  } catch {
    return null
  }
}

export const encodeClient = (msg: ClientMsg) => JSON.stringify(msg)

export const cleanName = (v: unknown): string => cleanPlayerName(v, NAME_MAX, "stranger")

const num = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : 0)

const gunOf = (v: unknown): Gun => (GUN_IDS as readonly unknown[]).includes(v) ? (v as Gun) : "rifle"
const equipOf = (v: unknown): Equip => (EQUIP_IDS as readonly unknown[]).includes(v) ? (v as Equip) : "frag"

/** Validates an untrusted client frame. Returns null for anything malformed. */
export function decodeClient(raw: unknown): ClientMsg | null {
  if (typeof raw !== "string" || raw.length > 1024) return null
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
      const id = typeof o.id === "string" && /^[a-z0-9]{6,16}$/.test(o.id) ? o.id : undefined
      const build = typeof o.build === "string" && /^[a-f0-9]{1,32}$/.test(o.build) ? o.build : undefined
      return { type: "hello", name: cleanName(o.name), id, gun: gunOf(o.gun), equip: equipOf(o.equip), build }
    }
    case "intent": {
      const i = o.i && typeof o.i === "object" ? (o.i as Record<string, unknown>) : null
      if (!i || typeof o.seq !== "number" || !Number.isInteger(o.seq) || o.seq < 0) return null
      const c = i.cast as Record<string, unknown> | undefined
      const cast: CastIntent | undefined = c && typeof c === "object" && (c.spell === null || c.spell === "moon" || c.spell === "necromancy") && [c.x,c.y,c.quality].every(v => typeof v === "number" && Number.isFinite(v))
        ? { spell: c.spell, quality: num(c.quality, 0, 1), x: num(c.x,-1000,1000), y: num(c.y,-1000,1000) } : undefined
      if (cast) i.cast = cast
      else delete i.cast
      return { type: "intent", seq: o.seq, i: { mx: num(i.mx, -1, 1), my: num(i.my, -1, 1), aim: num(i.aim, -7, 7), fire: i.fire === true, ...(i.firePressed === true ? { firePressed: true } : {}), reload: i.reload === true, sprint: i.sprint === true, equip: i.equip === true, tx: num(i.tx, -1000, 1000), ty: num(i.ty, -1000, 1000), use: i.use === true, melee: i.melee === true, ...(cast ? { cast } : {}), ...(i.enter === true ? { enter: true } : {}), ...(i.seat === true ? { seat: true } : {}), ...(i.horn === true ? { horn: true } : {}) } }
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
