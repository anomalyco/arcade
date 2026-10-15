import type { RoomFrame } from "@arcade/kit/net/room-core"
import { LOWER_CODE_CHARS, cleanPlayerName, randomRoomCode } from "@arcade/kit/sim/matchmaking"
import { MAX_PLAYERS } from "./config"
import type { SimState } from "./world"

/**
 * Online play is rollback over an input relay (`@arcade/kit/net/rollback`): the room decides which buttons every seat
 * ran on every tick and broadcasts that frame; every client steps the same deterministic world with it and predicts
 * ahead with its own buttons. Nothing but buttons and seat changes crosses the wire after the join.
 */

/** A seat changes hands, applied before the frame's tick on every copy of the world. */
export type Cmd = { k: "seat"; slot: number; name: string; human: boolean }

/** What every archer slot ran on one tick (bots' slots are ignored: everyone computes bots), and any seat changes. */
export type Frame = { i: number[]; c?: Cmd[] }

export type RosterRow = { id: string; slot: number; name: string }

export type ClientMsg =
  | { type: "hello"; name?: string; token?: string; build?: string }
  | { type: "ping"; t: number }
  /** Held buttons from tick `t` on (sent when they change, and every few ticks while something is held). */
  | { type: "in"; t: number; b: number }
  /** This client's world hashed differently from the room's: send the whole state. */
  | { type: "resync" }

export type ServerMsg =
  | RoomFrame<RosterRow, never>
  /** The frame for tick `t`; `h` is the world's hash after it (every HASH_EVERY ticks); `a` is your input slack. */
  | { type: "f"; t: number; i: number[]; c?: Cmd[]; h?: number; a: number | null }
  /** The whole world after tick `t` (on join, reconnect or resync), with that tick's frame inputs. */
  | { type: "state"; t: number; s: SimState; i: number[]; a: number | null }

export const NAME_MAX = 10
/** Ticks between world hashes in the frame stream. */
export const HASH_EVERY = 30

export const randomCode = (rand: () => number = Math.random) => randomRoomCode(LOWER_CODE_CHARS, rand)
export const cleanName = (v: unknown, fallback: string) => cleanPlayerName(v, NAME_MAX, fallback).toUpperCase()

/** Exact JSON: the world must cross the wire bit for bit. */
export const encodeServer = (msg: ServerMsg) => JSON.stringify(msg)
export const encodeClient = (msg: ClientMsg) => JSON.stringify(msg)

export function decodeServer(raw: string): ServerMsg | null {
  try {
    const m = JSON.parse(raw) as ServerMsg
    return m && typeof m.type === "string" ? m : null
  } catch {
    return null
  }
}

const int = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi

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
      const name = typeof o.name === "string" ? o.name : undefined
      return { type: "hello", name, token, build }
    }
    case "ping":
      return int(o.t, 0, Number.MAX_SAFE_INTEGER) ? { type: "ping", t: o.t } : null
    case "in":
      return int(o.t, 0, 2 ** 31) && int(o.b, 0, 127) ? { type: "in", t: o.t, b: o.b } : null
    case "resync":
      return { type: "resync" }
    default:
      return null
  }
}

export const emptyInputs = () => new Array<number>(MAX_PLAYERS).fill(0)
