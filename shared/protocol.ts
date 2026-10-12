import { GADGET_IDS, LOOKS, MAP_IDS, MODES, WEAPON_IDS, type Gadget, type MapId, type Mode, type Stance } from "./config"
import type { RosterRow, Snapshot } from "./sim/view"
import type { Intent, Loadout, SimEvent } from "./sim/world"

export type ClientMsg =
  | { type: "hello"; name: string; id?: string; loadout: Loadout }
  | { type: "intent"; seq: number; i: Intent }
  | { type: "loadout"; loadout: Loadout }
  | { type: "start"; mode: Mode; rounds: number; map: MapId }
  | { type: "ping"; t: number }

export type ServerMsg =
  | { type: "welcome"; id: string; room: string }
  | Snapshot
  | { type: "roster"; players: RosterRow[] }
  | { type: "ev"; events: SimEvent[] }
  | { type: "error"; code: "full" | "bad"; message: string }
  | { type: "pong"; t: number }

export const NAME_MAX = 14

/** Rounds floats to 3 decimals to keep frames small. */
export function encodeServer(msg: ServerMsg): string {
  return JSON.stringify(msg, (_k, v: unknown) => (typeof v === "number" && !Number.isInteger(v) ? (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : 1e9) : v))
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

const num = (v: unknown, lo: number, hi: number, fallback = 0) => (typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback)
const oneOf = <T extends string>(v: unknown, xs: readonly T[], fallback: T): T => (typeof v === "string" && (xs as readonly string[]).includes(v) ? (v as T) : fallback)

const STANCES: readonly Stance[] = ["sneak", "walk", "run"]

export function decodeLoadout(v: unknown): Loadout {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {}
  const g = Array.isArray(o.gadgets) ? o.gadgets : []
  const g0 = oneOf<Gadget>(g[0], GADGET_IDS, "flare")
  let g1 = oneOf<Gadget>(g[1], GADGET_IDS, "decoy")
  if (g1 === g0) g1 = GADGET_IDS.find((x) => x !== g0)!
  return { weapon: oneOf(o.weapon, WEAPON_IDS, "pistol"), gadgets: [g0, g1], look: Math.round(num(o.look, 0, LOOKS.length - 1)) }
}

function decodeIntent(v: unknown): Intent | null {
  if (!v || typeof v !== "object") return null
  const o = v as Record<string, unknown>
  return {
    mx: num(o.mx, -1, 1),
    my: num(o.my, -1, 1),
    stance: oneOf(o.stance, STANCES, "walk"),
    aim: num(o.aim, -Math.PI * 2, Math.PI * 2),
    fire: o.fire === true,
    reload: o.reload === true,
    gadget: o.gadget === 0 || o.gadget === 1 ? o.gadget : -1,
    tx: num(o.tx, -100, 200),
    ty: num(o.ty, -100, 200),
    use: o.use === true,
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
      const id = typeof o.id === "string" && /^[a-z0-9]{6,16}$/.test(o.id) ? o.id : undefined
      return { type: "hello", name: cleanName(o.name), id, loadout: decodeLoadout(o.loadout) }
    }
    case "intent": {
      const i = decodeIntent(o.i)
      if (!i || typeof o.seq !== "number" || !Number.isInteger(o.seq) || o.seq < 0) return null
      return { type: "intent", seq: o.seq, i }
    }
    case "loadout":
      return { type: "loadout", loadout: decodeLoadout(o.loadout) }
    case "start":
      return { type: "start", mode: oneOf(o.mode, MODES, "tdm"), rounds: o.rounds === 3 ? 3 : 5, map: oneOf(o.map, MAP_IDS, "office") }
    case "ping":
      return { type: "ping", t: num(o.t, 0, Number.MAX_SAFE_INTEGER) }
    default:
      return null
  }
}
