import { EQUIP_IDS, type Equip, GUN_IDS, type Gun } from "./config"
import { type ModeId, modeOf } from "./sim/modes"
import type { RosterRow, Snapshot } from "./sim/view"
import type { Intent, SimEvent } from "./sim/world"

export type ClientMsg =
  | { type: "hello"; name: string; id?: string; gun: Gun; equip: Equip }
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
  | { type: "ping"; t: number }

export type ServerMsg =
  | { type: "welcome"; id: string; room: string }
  | Snapshot
  | { type: "roster"; players: RosterRow[] }
  | { type: "ev"; events: SimEvent[] }
  | { type: "error"; message: string }
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

export function cleanName(v: unknown): string {
  const s = typeof v === "string" ? v.replace(/[^\p{L}\p{N} _.'-]/gu, "").trim().slice(0, NAME_MAX) : ""
  return s || "stranger"
}

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
      return { type: "hello", name: cleanName(o.name), id, gun: gunOf(o.gun), equip: equipOf(o.equip) }
    }
    case "intent": {
      const i = o.i && typeof o.i === "object" ? (o.i as Record<string, unknown>) : null
      if (!i || typeof o.seq !== "number" || !Number.isInteger(o.seq) || o.seq < 0) return null
      return { type: "intent", seq: o.seq, i: { mx: num(i.mx, -1, 1), my: num(i.my, -1, 1), aim: num(i.aim, -7, 7), fire: i.fire === true, reload: i.reload === true, sprint: i.sprint === true, equip: i.equip === true, tx: num(i.tx, -1000, 1000), ty: num(i.ty, -1000, 1000), use: i.use === true, melee: i.melee === true } }
    }
    case "gun":
      return { type: "gun", gun: gunOf(o.gun) }
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
      const mode = modeOf(o.mode)
      return o.action === "mode" && mode ? { type: "host", action: "mode", mode, newFloor } : null
    }
    case "ping":
      return { type: "ping", t: num(o.t, 0, Number.MAX_SAFE_INTEGER) }
    default:
      return null
  }
}

export const CODE_CHARS = "abcdefghjkmnpqrstuvwxyz23456789"

/** A fresh four-character room code. */
export function randomCode(rand: () => number = Math.random): string {
  let out = ""
  for (let i = 0; i < 4; i++) out += CODE_CHARS[Math.floor(rand() * CODE_CHARS.length)]
  return out
}
