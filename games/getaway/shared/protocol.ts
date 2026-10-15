import { UPPER_CODE_CHARS, cleanPlayerName, randomRoomCode } from "@arcade/kit/sim/matchmaking"
import { seedOf as rawSeedOf } from "@arcade/kit/sim/rng"
import { VEHICLE_BY_ID, VEHICLES, type Role } from "./config"
import type { Body, Input } from "./sim/vehicle"
import type { SimEvent, WorldView } from "./sim/world"
import { type PackedSnapshot, packSnapshot, unpackSnapshot } from "./wire"

export type Picks = Record<Role, string>

export type ClientMsg =
  /** `token` resumes an earlier seat after a reconnect (keeps your car and score). */
  | { type: "hello"; name: string; picks: Picks; token?: string; id?: string }
  | { type: "input"; seq: number; input: Input }
  | { type: "ping"; t: number }
  | { type: "chat"; text: string }

export type RosterEntry = { id: string; name: string; human: boolean; connected: boolean }

/** A chat line. "system" lines (joins and leaves) have no sender id and read as "<name> <text>". */
export type ChatMsg = { type: "chat"; from: string; name: string; role: Role | "system"; text: string; t: number }

export const CHAT_MAX = 140

export type ServerMsg =
  | { type: "welcome"; id: string; token?: string; room: string; seed: number; tick: number }
  /**
   * `ack` is the last input seq the server applied for you; `you` is your car's authoritative body after that input.
   * `you` includes exact y/vy, airborne, landing and tunnel-crossing state for deterministic replay; the view carries
   * interpolated height and the tunnel counter so discontinuities snap rather than blend across the city.
   * `idleIn` is the seconds until you're kicked for idling, only while that warning is up.
   */
  | { type: "snapshot"; tick: number; ack: number; view: WorldView; you: Body | null; idleIn?: number }
  | { type: "events"; events: SimEvent[] }
  | { type: "roster"; players: RosterEntry[] }
  | { type: "pong"; t: number }
  | ChatMsg
  | { type: "error"; code: "full" | "bad" | "idle"; message: string }

/**
 * Packs snapshots into positional arrays (`./wire.ts`) with view floats rounded to 3 decimals, while the authoritative
 * body (`you`) and `phaseT` stay exact so client replay crosses phase boundaries on the same tick as the server.
 */
export function encodeServer(msg: ServerMsg): string {
  if (msg.type === "snapshot") return JSON.stringify(packSnapshot(msg))
  return JSON.stringify(msg, (_k: string, v: unknown) => (typeof v === "number" && !Number.isInteger(v) ? Math.round(v * 1000) / 1000 : v))
}

export function decodeServer(raw: string): ServerMsg | null {
  try {
    const m = JSON.parse(raw) as ServerMsg | PackedSnapshot
    if (!m || typeof m.type !== "string") return null
    if (m.type === "snapshot" && "k" in m) return unpackSnapshot(m)
    return m as ServerMsg
  } catch {
    return null
  }
}

export function encodeClient(msg: ClientMsg): string {
  return JSON.stringify(msg)
}

const clamp = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : 0)

/** Quantizes an input the same way on both ends so the client's prediction matches what the server applies. */
export function quantizeInput(i: Input): Input {
  const q = (v: number) => Math.round(v * 1000) / 1000
  const out: Input = { throttle: q(i.throttle), brake: q(i.brake), steer: q(i.steer), handbrake: !!i.handbrake, boost: !!i.boost }
  if (i.gadget === 0 || i.gadget === 1) out.gadget = i.gadget
  if (i.engine) out.engine = true
  return out
}

function decodeInput(v: unknown): Input | null {
  if (!v || typeof v !== "object") return null
  const o = v as Record<string, unknown>
  const gadget = o.gadget === 0 || o.gadget === 1 ? o.gadget : null
  return quantizeInput({ throttle: clamp(o.throttle, -1, 1), brake: clamp(o.brake, 0, 1), steer: clamp(o.steer, -1, 1), handbrake: o.handbrake === true, boost: o.boost === true, gadget, engine: o.engine === true })
}

function decodePicks(v: unknown): Picks {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {}
  const pick = (role: Role) => {
    const id = o[role]
    const veh = typeof id === "string" ? VEHICLE_BY_ID.get(id) : undefined
    return veh && veh.role === role ? veh.id : VEHICLES.find((x) => x.role === role)!.id
  }
  return { robber: pick("robber"), cop: pick("cop") }
}

/** Chat text: control and bidi-override characters stripped, whitespace collapsed, at most CHAT_MAX characters. */
export function cleanChat(v: unknown): string {
  if (typeof v !== "string") return ""
  const s = v.replace(/[\p{Cc}\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, " ").replace(/\s+/g, " ").trim()
  return Array.from(s).slice(0, CHAT_MAX).join("").trim()
}

export const cleanName = (v: unknown): string => cleanPlayerName(v, 16, "Driver")

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
      const token = typeof o.token === "string" && /^[a-z0-9]{12,40}$/i.test(o.token) ? o.token : undefined
      const id = typeof o.id === "string" && /^[a-z0-9]{4,16}$/.test(o.id) ? o.id : undefined
      return { type: "hello", name: cleanName(o.name), picks: decodePicks(o.picks), ...(token ? { token } : {}), ...(id ? { id } : {}) }
    }
    case "input": {
      const input = decodeInput(o.input)
      if (!input || typeof o.seq !== "number" || !Number.isInteger(o.seq) || o.seq < 0) return null
      return { type: "input", seq: o.seq, input }
    }
    case "ping":
      return { type: "ping", t: typeof o.t === "number" && Number.isFinite(o.t) ? o.t : 0 }
    case "chat": {
      const text = cleanChat(o.text)
      return text ? { type: "chat", text } : null
    }
  }
  return null
}

/** Room codes are 1-12 letters/digits, case-insensitive. */
export function normalizeRoom(code: string): string | null {
  const c = code.toUpperCase()
  return /^[A-Z0-9]{1,12}$/.test(c) ? c : null
}

export const CODE_CHARS = UPPER_CODE_CHARS
export const randomCode = (rand: () => number = Math.random): string => randomRoomCode(CODE_CHARS, rand)

export function seedOf(room: string): number {
  return rawSeedOf(room) % 1_000_000
}
