import { LOWER_CODE_CHARS, cleanPlayerName, randomRoomCode } from "@arcade/kit/sim/matchmaking"
import type { RoomFrame } from "@arcade/kit/net/room-core"
import { characterOf } from "./characters"
import type { RosterRow, Snapshot } from "./view"
import type { Intent, SimEvent } from "./world"

export type ClientMsg =
  /** `build` is the client's BUILD (shared/build.gen.ts); a mismatched client reloads. */
  /** `token` is the private seat token from an earlier welcome, to reclaim the seat after a drop. */
  | { type: "hello"; name: string; token?: string; build?: string; pick?: string }
  | { type: "intent"; seq: number; i: Intent }
  | { type: "pick"; char: string }
  | { type: "ready"; ready: boolean }
  | { type: "ping"; t: number }

export type ServerMsg = RoomFrame<RosterRow, SimEvent> | Snapshot

export const NAME_MAX = 14

/** Rounds floats to 2 decimals to keep frames small. */
export function encodeServer(msg: ServerMsg): string {
  return JSON.stringify(msg, (_k, v: unknown) => (typeof v === "number" && !Number.isInteger(v) ? Math.round(v * 100) / 100 : v))
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
export const cleanName = (v: unknown): string => cleanPlayerName(v, NAME_MAX, "guest")
const num = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : 0)

/** Validates an untrusted client frame. Returns null for anything malformed. */
export function decodeClient(raw: unknown): ClientMsg | null {
  if (typeof raw !== "string" || raw.length > 512) return null
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
      return { type: "hello", name: cleanName(o.name), token, build, pick: characterOf(o.pick)?.id }
    }
    case "intent": {
      const i = o.i && typeof o.i === "object" ? (o.i as Record<string, unknown>) : null
      if (!i || typeof o.seq !== "number" || !Number.isInteger(o.seq) || o.seq < 0) return null
      const cast = typeof i.cast === "number" && Number.isInteger(i.cast) && i.cast >= 0 && i.cast < 4 ? i.cast : -1
      return { type: "intent", seq: o.seq, i: { mx: num(i.mx, -1, 1), my: num(i.my, -1, 1), aim: num(i.aim, -7, 7), tx: num(i.tx, -100, 200), ty: num(i.ty, -100, 200), cast } }
    }
    case "pick":
      return characterOf(o.char) ? { type: "pick", char: o.char as string } : null
    case "ready":
      return { type: "ready", ready: o.ready === true }
    case "ping":
      return { type: "ping", t: num(o.t, 0, Number.MAX_SAFE_INTEGER) }
    default:
      return null
  }
}

export const randomCode = (rand: () => number = Math.random): string => randomRoomCode(LOWER_CODE_CHARS, rand)
