// Dev-only bots: what the BOTS panel (src/dev/bots-tab.ts) asks a dev room for, what the room (server/bots.ts) says
// back, and the typed settings both sides share. Bots are crew players without a socket: a bot joins a carrier and runs
// one ship operation (shared/ops.ts: its `role` is the op id, "hornet", "boat", "ciws-port", "helm"...) under the same
// crew rules as a player, and the room feeds what its brain does through the same message handler a client's messages
// go through. Only a room started in dev mode accepts these (shared/protocol.ts DEV_MESSAGES).

import { opById, isOpId } from "./ops"

/** What a bot's brain does, per kind of operation it runs. */
export const JET_BEHAVIORS = ["straight", "orbit", "eight", "evasive", "dogfight", "bomber"] as const
export const BOAT_BEHAVIORS = ["idle", "patrol", "attack"] as const
export const GUN_BEHAVIORS = ["hold", "engage"] as const
export const HELM_BEHAVIORS = ["stop", "cruise", "circle", "chase"] as const
export type JetBehavior = (typeof JET_BEHAVIORS)[number]
export type BoatBehavior = (typeof BOAT_BEHAVIORS)[number]
export type GunBehavior = (typeof GUN_BEHAVIORS)[number]
export type HelmBehavior = (typeof HELM_BEHAVIORS)[number]
export type BotBehavior = JetBehavior | BoatBehavior | GunBehavior | HelmBehavior

export type BotKind = "jet" | "boat" | "gun" | "helm"

/** The kind of bot an operation makes (null: not an operation). */
export function botKind(role: string): BotKind | null {
  const op = opById(role)
  if (!op) return null
  if (op.kind === "helm") return "helm"
  if (op.kind === "gun") return "gun"
  return op.boat ? "boat" : "jet"
}

export const BEHAVIORS: Readonly<Record<BotKind, readonly BotBehavior[]>> = { jet: JET_BEHAVIORS, boat: BOAT_BEHAVIORS, gun: GUN_BEHAVIORS, helm: HELM_BEHAVIORS }

/** Every tunable a bot has. Numbers are clamped to `BOT_RANGES`; `target` / `targetShip` are ids (-1: the nearest enemy). */
export type BotSettings = {
  behavior: BotBehavior
  /** Jets: altitude held on patrols, bomb runs and target practice (m). */
  alt: number
  /** Jets: airspeed held (m/s). */
  speed: number
  /** Orbit, figure-eight and boat patrol radius (m). */
  radius: number
  /** Boats and helms: throttle order 0..1. */
  throttle: number
  /** 0..1: reaction time, stick authority, how often it reads a missile and flares, jinks. */
  skill: number
  /** 0..1: how hard it presses: afterburner, closing range, how soon it opens fire and launches missiles. */
  aggression: number
  /** 0..1: aim error and the cone it holds the trigger in. */
  accuracy: number
  weapons: boolean
  flares: boolean
  /** Infinite ammunition: stores, flares and cells refill after every shot. */
  ammo: boolean
  invulnerable: boolean
  /** Launch again after being destroyed (when the operation's slot is ready). */
  respawn: boolean
  /** Player to hunt (dogfight, boats, gunners), -1 any enemy. */
  target: number
  /** Ship to bomb, attack or chase, -1 the nearest enemy carrier. */
  targetShip: number
}

export const BOT_DEFAULTS: Readonly<BotSettings> = {
  behavior: "dogfight",
  alt: 800,
  speed: 160,
  radius: 1500,
  throttle: 0.6,
  skill: 0.6,
  aggression: 0.6,
  accuracy: 0.55,
  weapons: true,
  flares: true,
  ammo: false,
  invulnerable: false,
  respawn: true,
  target: -1,
  targetShip: -1,
}

/** Numeric settings: label, unit, range and step (the panel's sliders; the room clamps to the same). */
export const BOT_RANGES = {
  alt: { label: "Altitude", unit: "m", min: 60, max: 3000, step: 10 },
  speed: { label: "Airspeed", unit: "m/s", min: 70, max: 230, step: 5 },
  radius: { label: "Pattern radius", unit: "m", min: 200, max: 4000, step: 50 },
  throttle: { label: "Throttle (boat, helm)", unit: "×", min: 0, max: 1, step: 0.05 },
  skill: { label: "Skill", unit: "", min: 0, max: 1, step: 0.05 },
  aggression: { label: "Aggression", unit: "", min: 0, max: 1, step: 0.05 },
  accuracy: { label: "Accuracy", unit: "", min: 0, max: 1, step: 0.05 },
} as const satisfies Partial<Record<keyof BotSettings, { label: string; unit: string; min: number; max: number; step: number }>>

const FLAGS = ["weapons", "flares", "ammo", "invulnerable", "respawn"] as const
const IDS = ["target", "targetShip"] as const

/** At most this many bots per spawn, per command and per room. */
export const BOT_SPAWN_MAX = 8
export const BOT_IDS_MAX = 24
export const BOT_ROOM_MAX = 24

/** Where an air start (or a boat's drop) begins: plan position, height and heading (rad, 0 north). */
export type BotAt = [x: number, y: number, z: number, heading: number]

export type BotCmd =
  /** `n` bots of operation `role` join ship `ship`. `start` "air" puts jets in the air (and boats in the water) at
   *  `at`, side by side; "deck" launches them from the catapult (boats from the crane) as a player does. `rules`:
   *  obey the operation's caps and recharges (false: a bot takes an extra slot when every one is busy). */
  | { c: "spawn"; role: string; ship: number; n: number; start: "air" | "deck"; rules: boolean; at: BotAt; s: BotSettings }
  /** New settings (any subset) for these bots. */
  | { c: "set"; ids: number[]; s: Partial<BotSettings> }
  /** Shoot these bots down (they respawn if set to) or remove them from the room. */
  | { c: "kill"; ids: number[] }
  | { c: "remove"; ids: number[] }
  /** Remove every bot. */
  | { c: "clear" }

/** One live bot as the room reports it (~2 Hz, dev rooms only). */
export type BotInfo = {
  id: number
  name: string
  role: string
  ship: number
  group: number
  /** "launch", "flying", "down", "waiting", "manned", "driving", "helm", or the crew error that holds it up. */
  state: string
  /** What it is doing: "dogfight → ADA 1.2 km". */
  note: string
  hp: number
  s: BotSettings
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)
const isId = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= -1 && (v as number) < 1e6
const clampTo = (v: number, r: { min: number; max: number }) => Math.max(r.min, Math.min(r.max, v))
const isBehavior = (v: unknown): v is BotBehavior => typeof v === "string" && Object.values(BEHAVIORS).some((l) => l.includes(v as BotBehavior))

/** Validates (and clamps) a partial settings object from the wire; null if any field is malformed. */
export function botSettingsPatch(v: unknown): Partial<BotSettings> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const out: Partial<BotSettings> = {}
  for (const key of Object.keys(o)) {
    const x = o[key]
    if (key === "behavior") {
      if (!isBehavior(x)) return null
      out.behavior = x
    } else if (key in BOT_RANGES) {
      if (!isNum(x)) return null
      out[key as keyof typeof BOT_RANGES] = clampTo(x, BOT_RANGES[key as keyof typeof BOT_RANGES])
    } else if ((FLAGS as readonly string[]).includes(key)) {
      if (typeof x !== "boolean") return null
      out[key as (typeof FLAGS)[number]] = x
    } else if ((IDS as readonly string[]).includes(key)) {
      if (!isId(x)) return null
      out[key as (typeof IDS)[number]] = x
    } else return null
  }
  return out
}

/** A complete settings object from the wire, or null. */
export function botSettings(v: unknown): BotSettings | null {
  const p = botSettingsPatch(v)
  if (!p) return null
  for (const key of Object.keys(BOT_DEFAULTS)) if (!(key in p)) return null
  return p as BotSettings
}

/** A behavior that suits a bot of `kind` (the kind's first one otherwise). */
export function behaviorFor(kind: BotKind, b: BotBehavior): BotBehavior {
  const list = BEHAVIORS[kind]
  return list.includes(b) ? b : list[0]!
}

function idList(v: unknown): number[] | null {
  return Array.isArray(v) && v.length >= 1 && v.length <= BOT_IDS_MAX && v.every((x) => Number.isInteger(x) && x >= 0 && x < 1e6) ? (v as number[]) : null
}

/** Plan coordinates beyond this are off the map (shared/plane.ts PLANE.edge is 9 km). */
const AT_LIMIT = 9000

/** Validates an untrusted bot command (the inside of a `bot` message). */
export function botCmdOf(v: unknown): BotCmd | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  switch (o.c) {
    case "spawn": {
      if (!isOpId(o.role) || !Number.isInteger(o.ship) || (o.ship as number) < 0) return null
      if (!Number.isInteger(o.n) || (o.n as number) < 1 || (o.n as number) > BOT_SPAWN_MAX) return null
      if ((o.start !== "air" && o.start !== "deck") || typeof o.rules !== "boolean") return null
      const at = o.at
      if (!Array.isArray(at) || at.length !== 4 || !at.every(isNum)) return null
      if (Math.abs(at[0]) > AT_LIMIT || Math.abs(at[2]) > AT_LIMIT || at[1] < 0 || at[1] > 3500) return null
      const s = botSettings(o.s)
      if (!s) return null
      return { c: "spawn", role: o.role, ship: o.ship as number, n: o.n as number, start: o.start, rules: o.rules, at: at as BotAt, s }
    }
    case "set": {
      const ids = idList(o.ids)
      const s = botSettingsPatch(o.s)
      return ids && s ? { c: "set", ids, s } : null
    }
    case "kill":
    case "remove": {
      const ids = idList(o.ids)
      return ids ? { c: o.c, ids } : null
    }
    case "clear":
      return { c: "clear" }
  }
  return null
}

/** Validates the room's bot list. */
export function botInfoOf(v: unknown): BotInfo | null {
  if (!v || typeof v !== "object") return null
  const o = v as Record<string, unknown>
  const s = botSettings(o.s)
  if (!Number.isInteger(o.id) || typeof o.name !== "string" || o.name.length > 32 || typeof o.role !== "string" || !Number.isInteger(o.ship) || !Number.isInteger(o.group)) return null
  if (typeof o.state !== "string" || o.state.length > 24 || typeof o.note !== "string" || o.note.length > 64 || !isNum(o.hp) || !s) return null
  return { id: o.id as number, name: o.name, role: o.role, ship: o.ship as number, group: o.group as number, state: o.state, note: o.note, hp: o.hp, s }
}

/** Callsigns: a bot is "BOT·VIPER" (CREW.nameMax is 16). */
export const BOT_CALLSIGNS = ["VIPER", "JESTER", "ICEMAN", "COUGAR", "HANGMAN", "PHOENIX", "ROOSTER", "SLIDER", "MERLIN", "GOOSE", "STINGER", "HOLLY", "WOLF", "RAPTOR", "BANDIT", "SPECTRE", "COBRA", "HAVOC", "TALON", "RAVEN", "GHOST", "BLAZE", "NOMAD", "ZERO"]
export const BOT_PREFIX = "BOT·"
export const botName = (n: number): string => `${BOT_PREFIX}${BOT_CALLSIGNS[n % BOT_CALLSIGNS.length]}${n >= BOT_CALLSIGNS.length ? Math.floor(n / BOT_CALLSIGNS.length) + 1 : ""}`
