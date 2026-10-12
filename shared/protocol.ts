import { GADGETS, MAPS, MODES, WEAPONS, type Gadget, type Mode, type Stance, type Weapon } from "./config"
import type { Intent, Loadout, SimEvent } from "./sim/world"
import type { Snapshot } from "./sim/view"

export type ClientMsg =
  | { type: "hello"; name: string; id?: string; loadout: Loadout }
  | { type: "intent"; seq: number; i: Intent }
  | { type: "loadout"; loadout: Loadout }
  | { type: "start"; mode: Mode; rounds: number; map: string }
  | { type: "ping"; t: number }

export type ServerMsg =
  | { type: "welcome"; id: string; room: string }
  | Snapshot
  | { type: "ev"; events: SimEvent[] }
  | { type: "error"; code: "full" | "bad" | "room"; message: string }
  | { type: "pong"; t: number }

export const NAME_MAX = 14

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

export function encodeClient(msg: ClientMsg): string {
  return JSON.stringify(msg)
}

export function cleanName(v: unknown): string {
  const s = typeof v === "string" ? v.replace(/[^\p{L}\p{N} _.'-]/gu, "").trim().slice(0, NAME_MAX) : ""
  return s || "Stranger"
}

const num = (v: unknown, lo: number, hi: number, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback)
const oneOf = <T extends string>(v: unknown, xs: readonly T[], fallback: T): T => (typeof v === "string" && (xs as readonly string[]).includes(v) ? (v as T) : fallback)

const STANCES: readonly Stance[] = ["sneak", "walk", "run"]
const WEAPON_IDS = Object.keys(WEAPONS) as Weapon[]
const GADGET_IDS = Object.keys(GADGETS) as Gadget[]

export function decodeLoadout(v: unknown): Loadout {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {}
  const g = Array.isArray(o.gadgets) ? o.gadgets : []
  const g0 = oneOf(g[0], GADGET_IDS, "flare")
  const g1 = oneOf(g[1], GADGET_IDS, "decoy")
  return { weapon: oneOf(o.weapon, WEAPON_IDS, "pistol"), gadgets: [g0, g1 === g0 ? (g0 === "decoy" ? "flare" : "decoy") : g1] }
}

function decodeIntent(v: unknown): Intent | null {
  if (!v || typeof v !== "object") return null
  const o = v as Record<string, unknown>
  const gadget = o.gadget === 0 || o.gadget === 1 ? o.gadget : -1
  return {
    mx: num(o.mx, -1, 1),
    my: num(o.my, -1, 1),
    stance: oneOf(o.stance, STANCES, "walk"),
    aim: num(o.aim, -10, 10),
    fire: o.fire === true,
    reload: o.reload === true,
    gadget,
    tx: num(o.tx, -200, 200),
    ty: num(o.ty, -200, 200),
    use: o.use === true,
  }
}

/** Validates an untrusted client frame. Returns null for anything malformed. */
export function decodeClient(raw: unknown): ClientMsg | null {
  if (typeof raw !== "string" || raw.length > 4096) return null
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
      return {
        type: "start",
        mode: oneOf(o.mode, MODES, "tdm"),
        rounds: o.rounds === 3 ? 3 : 5,
        map: oneOf(o.map, MAPS, "warehouse"),
      }
    case "ping":
      return { type: "ping", t: num(o.t, 0, Number.MAX_SAFE_INTEGER) }
    default:
      return null
  }
}
