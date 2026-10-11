import { VEHICLE_BY_ID, VEHICLES, type Role } from "./config"
import type { Body, Input } from "./sim/vehicle"
import type { SimEvent, WorldView } from "./sim/world"

export type Picks = Record<Role, string>

export type ClientMsg =
  /** `id` resumes an earlier identity after a reconnect (keeps your car and score). */
  | { type: "hello"; name: string; picks: Picks; id?: string }
  | { type: "input"; seq: number; input: Input }
  | { type: "ping"; t: number }

export type RosterEntry = { id: string; name: string; human: boolean; connected: boolean }

export type ServerMsg =
  | { type: "welcome"; id: string; room: string; seed: number; tick: number }
  /** `ack` is the last input seq the server applied for you; `you` is your car's authoritative body after that input. */
  | { type: "snapshot"; tick: number; ack: number; view: WorldView; you: Body | null }
  | { type: "events"; events: SimEvent[] }
  | { type: "roster"; players: RosterEntry[] }
  | { type: "pong"; t: number }
  | { type: "error"; code: "full" | "bad"; message: string }

/**
 * Rounds every number to 3 decimals to keep snapshots small. The authoritative body and the phase clock stay exact
 * so the client's replay crosses phase boundaries on the same tick as the server.
 */
export function encodeServer(msg: ServerMsg): string {
  const exact = msg.type === "snapshot" ? msg.you : null
  return JSON.stringify(msg, function (this: unknown, k: string, v: unknown) {
    if (typeof v === "number" && this !== exact && k !== "phaseT") return Number.isInteger(v) ? v : Math.round(v * 1000) / 1000
    return v
  })
}

export function decodeServer(raw: string): ServerMsg | null {
  try {
    const m = JSON.parse(raw) as ServerMsg
    return m && typeof m.type === "string" ? m : null
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

export function cleanName(v: unknown): string {
  const s = typeof v === "string" ? v.replace(/[^\p{L}\p{N} _.'-]/gu, "").trim().slice(0, 16) : ""
  return s || "Driver"
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
      const id = typeof o.id === "string" && /^[a-z0-9]{4,16}$/.test(o.id) ? o.id : undefined
      return { type: "hello", name: cleanName(o.name), picks: decodePicks(o.picks), id }
    }
    case "input": {
      const input = decodeInput(o.input)
      if (!input || typeof o.seq !== "number" || !Number.isInteger(o.seq) || o.seq < 0) return null
      return { type: "input", seq: o.seq, input }
    }
    case "ping":
      return { type: "ping", t: typeof o.t === "number" && Number.isFinite(o.t) ? o.t : 0 }
  }
  return null
}

/** Room codes are 1-12 letters/digits, case-insensitive. */
export function normalizeRoom(code: string): string | null {
  const c = code.toUpperCase()
  return /^[A-Z0-9]{1,12}$/.test(c) ? c : null
}

export function seedOf(room: string): number {
  let h = 2166136261
  for (let i = 0; i < room.length; i++) h = Math.imul(h ^ room.charCodeAt(i), 16777619)
  return (h >>> 0) % 1_000_000
}
