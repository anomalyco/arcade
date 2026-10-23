// Messages between the client (src/net.ts) and the Room Durable Object (server/core.ts). The high-rate ones (jets,
// ships, boats, turrets, aims, boat orders, triggers, hit reports) travel as binary frames (shared/wire.ts), the rest as
// JSON text frames on the same socket; both decode to the same messages, through the same checks.
// Times: `epoch`, `now` and `s` are server Date.now() milliseconds; `c` is the client's performance.now(), echoed back.
// To add a message: a variant in ClientMsg/ServerMsg and a case in decodeClient/decodeServer (unknown types decode to
// null and are ignored, so old and new clients never break each other beyond the build handshake).

import { type Aircraft, CREW, type Crew, type CrewPlayer, type CrewShip, type RecoverHow, type Role } from "./crew"
import { type HullTuple, isHullTuple } from "./fleet"
import { isOpId } from "./ops"
import { TIME_SPEED_MAX } from "./daycycle"
import { WEATHER_KINDS, type WeatherKind, unpackWeather } from "./weather"
import { KILL_WEAPONS } from "./weapons"
import { type BoatCtlTuple, type BoatTuple, isBoatCtl, isBoatTuple } from "./boat"
import { unpackObjective } from "./objective"
import { type BotCmd, type BotInfo, botCmdOf, botInfoOf } from "./bots"
import { cleanChat } from "./chat"
import { DECK_JET_WEAPONS, type DeckJetWeapon, type DeckRound } from "./deck-jets"
import { decodeClientWire, decodeServerWire, encodeWire, quantizePlane, wireBytes } from "./wire"
import { type AimTuple, type GunBoomTuple, type GunFireTuple, type InterceptTuple, type TurretTuple, isAimTuple, isGunBoomTuple, isGunFireTuple, isInterceptTuple, isTurretTuple } from "./gunnery"

export const DEFAULT_ROOM = "open-sea"
export const ROOM_MAX = 32

/** A room's world: waves and islands are pure functions of the seed, sea time is (server now - epoch) / 1000. */
export type World = { seed: number; epoch: number }

export type ClientMsg =
  /**
   * `build` is the client's BUILD (shared/build.gen.ts). `resume` is the world a reconnecting client already shows; an
   * empty room adopts it instead of making a new one, so a lone player's network blip doesn't change the world. `name`
   * is the player's name; `back` is the ship and role a reconnecting client had: the helm again if it is still free, a
   * pilot again (back on the deck) otherwise. `token` is the private seat token issued in `welcome`.
   */
  | { type: "hello"; build: string; resume?: World; name?: string; back?: { ship: number; role: Role }; token?: string }
  | { type: "ping"; c: number }
  /** The helm's orders for its ship: throttle -1..1 (negative is astern; the sim clamps it) and rudder -1..1. Ignored from anyone but that ship's helm. */
  | { type: "helm"; o: number; r: number }
  /** Crew requests (shared/crew.ts rules; refused ones get a `nope`). */
  /** Run a ship operation (shared/ops.ts: "helm" takes the helm, "hornet" launches one): the menu's only path. */
  | { type: "op"; op: string }
  /** Board another ship as `as`, or at its helm if free, else as a pilot. */
  | { type: "board"; ship: number; as?: Role }
  /** Commission a ship on the team that has none (shared/crew.ts createShip). */
  | { type: "newship" }
  /** A flight ended (landed on its own carrier, or destroyed). */
  | { type: "recover"; how: RecoverHow }
  /** Captain powers (shared/squad.ts), on the sender's own ship; ignored with a `nope` from anyone else. */
  | { type: "promote"; player: number }
  | { type: "kick"; player: number }
  | { type: "lock"; locked: boolean }
  /** The sender's own jet, about 20 times a second while it holds a plane slot (the client is authoritative for it). */
  | { type: "plane"; p: PlaneTuple }
  /**
   * Room weather override (the debug menu's BROADCAST): fade over `f` seconds to a kind's preset, to a custom weather
   * (shared/weather.ts packWeather), or back to the seeded timeline ("auto"). The room starts it a moment ahead of its
   * own sea time and tells everyone.
   */
  | { type: "weather"; to: WeatherKind | "auto" | number[]; f: number }
  /**
   * Room clock override (the debug menu's TIME tab): run forward over `f` seconds to clock hour `h` (null: back to the
   * seeded timeline), then at `s` × normal speed (0 freezes it). Like the weather, the room starts it a moment ahead.
   */
  | { type: "time"; h: number | null; s: number; f: number }
  // Weapons (shared/combat.ts header: who decides what).
  /** The sender's trigger went down or up (others draw its rounds). */
  | { type: "gun"; on: boolean }
  /** The sender's rounds hit jet `on` `n` times since its last report (the room checks and applies them). */
  | { type: "hits"; on: number; n: number }
  /** The sender fired a missile or released a bomb. */
  | { type: "fire"; m: FireTuple }
  /** The sender dropped a flare burst. */
  | { type: "flare"; f: FlareTuple }
  /** The sender's rounds hit carrier `ship` `n` times since its last report (the room checks and applies them). */
  | { type: "shiphits"; ship: number; n: number }
  /** The sender's seeker: tracking jet `on` (-1 none), locked or not (the room tells that jet). */
  | { type: "seek"; on: number; locked: boolean }
  // Ship guns (shared/gunnery.ts header: who decides what), from a gunner.
  /** The sender's turret: yaw, pitch (mrad, ship-local) and trigger, ~10 Hz while it moves. */
  | { type: "aim"; a: AimTuple }
  /** The sender launched a SAM or fired a 5-inch shell. */
  | { type: "gfire"; g: GunFireTuple }
  /** The sender's CIWS rounds hit jet `on` `n` times since its last report. */
  | { type: "thits"; on: number; n: number }
  /** The sender's CIWS rounds hit carrier `ship` `n` times since its last report. */
  /** The sender's CIWS shot down a missile or bomb (store 0) or a SAM or shell (store 1). */
  | { type: "intercept"; i: InterceptTuple }
  // The boat (shared/boat.ts), from its driver: the room runs the boat's sim on these orders.
  /** The driver's throttle, steer, boost, turret aim and trigger (shared/boat.ts BoatCtlTuple), ~20 Hz while they change. */
  | { type: "boat"; c: BoatCtlTuple }
  /** The boat's 25 mm rounds hit something `n` times since its last report: `k` shared/boat.ts BOAT_HIT (0 a jet or
   *  1 a boat: player `on`; 2 a carrier: ship `on`). */
  | { type: "bhits"; k: number; on: number; n: number }
  /** The sender's rounds hit parked jet `slot` on carrier `ship`'s deck `n` times since its last report (shared/deck-jets.ts):
   *  `w` DECK_ROUND (0 the jet gun, 1 a CIWS, 2 the boat's 25 mm); checked against that weapon's budget and reach. */
  | { type: "deckhits"; w: DeckRound; ship: number; slot: number; n: number }
  /** A chat line (shared/chat.ts: cleaned, rate-limited, stamped by the room); `crew`: only the sender's carrier hears it. */
  | { type: "chat"; text: string; crew?: true }
  /** Dev tools: a bot command from the BOTS panel (shared/bots.ts). Dev rooms only (`DEV_MESSAGES`). */
  | { type: "bot"; cmd: BotCmd }
  /** Dev tools: new objective rules (shared/objective.ts packRules, clamped by the room); the round restarts with them. */
  | { type: "objective"; r: number[] }

/**
 * Dev tools: messages a room accepts only when it runs in dev mode (server configuration, never the client: see
 * server/room.ts). Anywhere else the room answers `nope` "dev-only" and changes nothing. The one gate is in
 * server/core.ts `RoomCore.message`.
 */
export const DEV_MESSAGES: ReadonlySet<ClientMsg["type"]> = new Set<ClientMsg["type"]>(["weather", "time", "bot", "objective"])

export type ServerMsg =
  /** `id` is this connection's player id in the crew. `token` is the private seat token for reconnects. `dev`: the room runs in dev mode (it takes `DEV_MESSAGES`). */
  | { type: "welcome"; seed: number; epoch: number; now: number; players: number; id: number; token?: string; dev?: true }
  /** The server runs different shared code than this client: reload the page. */
  | { type: "reload" }
  /** The room has CREW.roomMax players: pick another. */
  | { type: "full" }
  | { type: "pong"; c: number; s: number }
  /** Joined players, broadcast whenever someone joins or leaves. */
  | { type: "players"; n: number }
  /** Who is aboard which ship, as helm or pilot: the whole crew, sent on join and after every change. */
  | { type: "crew"; crew: Crew }
  /** Every ship's authoritative plan pose, about 10 times a second. Ships not listed have sunk. */
  | { type: "ships"; s: ShipTuple[] }
  /** A crew request was refused (a CrewError, e.g. "helm-taken"). */
  | { type: "nope"; error: string }
  /** Every airborne player's latest jet, about 20 times a second while anyone flies. Players not listed have none. */
  | { type: "planes"; p: PlaneEntry[] }
  /** The room's weather override (shared/weather.ts packOverride), or null for none; on join and on every change. */
  | { type: "weather"; o: number[] | null }
  /** The room's clock override (shared/daycycle.ts packTime), or null for none; on join and on every change. */
  | { type: "time"; o: number[] | null }
  // Weapons: relays of other jets' events, and the room's authoritative combat results.
  | { type: "gun"; id: number; on: boolean }
  | { type: "fire"; id: number; m: FireTuple }
  | { type: "flare"; id: number; f: FlareTuple }
  /** An enemy's seeker on you: 0 off, 1 tracking, 2 locked. */
  | { type: "seek"; by: number; s: 0 | 1 | 2 }
  /** A missile or bomb burst (the room decided where, and whom it hit). */
  | { type: "boom"; b: BoomTuple }
  /** A jet's health changed: damage from `by` with `w`, or repair (by -1, w ""). */
  | { type: "hp"; id: number; hp: number; by: number; w: string }
  /** Jet `on` was destroyed by `by` with `w` (by -1, w "": it crashed on its own). */
  | { type: "kill"; on: number; by: number; w: string }
  /** Kills and deaths this room has counted: [player, kills, deaths], on join and after every kill. */
  | { type: "stats"; s: StatTuple[] }
  /** Every carrier's health, damage zones and fires (shared/fleet.ts HullTuple), on join and whenever one changes. */
  | { type: "hulls"; h: HullTuple[] }
  /** A carrier started sinking: its id, name and team, and who dealt the final blow (-1 nobody). */
  | { type: "sunk"; ship: number; name: string; team: number; by: number }
  /** A jet parked on carrier `ship`'s deck (aircraft slot `slot`) was destroyed by `by` (-1 nobody) with `w`
   *  (shared/deck-jets.ts DeckJetWeapon); the crew that follows has its slot recharging. */
  | { type: "deckkill"; ship: number; slot: number; by: number; w: DeckJetWeapon }
  /** Carriers a and b collided (shared/ship-collide.ts): how hard, 0..1. Damage comes as `hulls`. */
  | { type: "bump"; a: number; b: number; k: number }
  /** Every manned turret's aim and trigger, ~10 Hz while anyone mans one (then once empty). */
  | { type: "turrets"; t: TurretTuple[] }
  /** Another gunner's SAM launch or shell. */
  | { type: "gfire"; id: number; g: GunFireTuple }
  /** A SAM or shell burst (the room decided where, and whom it hit). */
  | { type: "gboom"; b: GunBoomTuple }
  /** Every boat out (shared/boat.ts BoatTuple: its pose, crane state, turret and trigger), ~10 Hz while any is out
   *  (then once empty). Its health, kills and the kill feed travel as `hp` / `kill` like a jet's. */
  | { type: "boats"; b: BoatTuple[] }
  /** Dev rooms: every live bot (shared/bots.ts), ~2 Hz while any exist (then once empty), and to joiners. */
  | { type: "bots"; b: BotInfo[] }
  /** The objective (shared/objective.ts packObjective: round, zones, capture, scores), ~4 Hz while anything moves,
   *  at once on a capture, reveal, relocation or round end, and to joiners. */
  | { type: "obj"; o: number[] }
  /** A chat line from player `from` (name and team as the room knows them); `crew`: the sender's carrier only. */
  | { type: "chat"; from: number; name: string; team: number; text: string; crew?: true }

/** A launch: [sequence, sea time, x, y, z, vx, vy, vz, target (-1 none), kind (0 missile, 1 bomb)]. */
export type FireTuple = [seq: number, t: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, target: number, kind: number]
export const FIRE_LENGTH = 10
/** A flare burst: [sea time, x, y, z, vx, vy, vz]. */
export type FlareTuple = [t: number, x: number, y: number, z: number, vx: number, vy: number, vz: number]
export const FLARE_LENGTH = 7
/** A burst: [owner, sequence, x, y, z, jet hit (-1 none), over water 0/1, bomb 0/1]. */
export type BoomTuple = [owner: number, seq: number, x: number, y: number, z: number, on: number, water: number, bomb: number]
export const BOOM_LENGTH = 8
export type StatTuple = [id: number, kills: number, deaths: number]
const WEAPON_NAMES = ["", ...KILL_WEAPONS]

/**
 * A ship's plan pose: [sea time (s), x, z, heading, forward speed, lateral speed, yaw rate, throttle order, rudder].
 * Receivers dead-reckon it to their own sea time and float the hull on their own sea (see shared/ship.ts).
 */
export type PoseTuple = [t: number, x: number, z: number, heading: number, u: number, v: number, r: number, order: number, rudder: number]
export const POSE_LENGTH = 9
/** One ship in a `ships` frame: its crew ship id, its pose, then its engine output (so a new helm resumes it). */
export type ShipTuple = [id: number, ...pose: PoseTuple, power: number]
export const SHIP_TUPLE_LENGTH = POSE_LENGTH + 2
/**
 * A jet: [sea time (s), mode, x, y, z, qx, qy, qz, qw, vx, vy, vz, throttle 0..1, burner 0..1, gear 0..1, stick pitch,
 * stick roll]. Mode 0 = on its carrier's deck (the launch run): only x matters, the jet's ship-local z on the catapult
 * track, so every client places it on its own copy of the hull. Mode 1 = flying: world position, orientation (body →
 * world) and velocity. Mode 2 = crashed at (x, y, z). Mode 3 = landing on its carrier (shared/landing.ts): x, y, z are
 * the ship-local position and qx, qy, qz the ship-local yaw, pitch and bank (qw unused), placed on each client's own copy
 * of the hull like the catapult run; the velocity is still the world one. Optional tail (additive): the vehicle code
 * (shared/vehicles.ts VEHICLE_KINDS index; absent = the Hornet, what old clients fly; the room overwrites it with the
 * type of the pilot's slot) and the weapons-bay doors 0 (shut) .. 1 (open).
 */
export type PlaneTuple = [t: number, mode: number, x: number, y: number, z: number, qx: number, qy: number, qz: number, qw: number, vx: number, vy: number, vz: number, throttle: number, burner: number, gear: number, pitch: number, roll: number, vehicle?: number, doors?: number]
/** The base tuple; with the vehicle code and the bay doors it is PLANE_TUPLE_FULL long. */
export const PLANE_TUPLE_LENGTH = 17
export const PLANE_TUPLE_FULL = 19
/** One jet in a `planes` frame: its pilot's player id, then the tuple. */
export type PlaneEntry = [id: number, ...plane: PlaneTuple]
export const PLANE_MODE = { deck: 0, flying: 1, crashed: 2, landing: 3 } as const

/**
 * Rounds a jet to the grid the wire carries it on (shared/wire.ts: a 32-player room relays up to 12 jets 20 times a
 * second to everyone): time to the ms, position to 1 cm (catapult and landing poses are ship-local, the same
 * precision), the quaternion to 1/32767 (the landing yaw/pitch/bank to 1e-4 rad, qw the carrier id), velocity to
 * 0.1 m/s, throttle, burner, gear and doors to 1/100 in 0..1, the stick to 1/100. Exactly what a receiver decodes, so
 * the room's combat sim sees the jet its clients draw. In place; returns it.
 */
export function compactPlane(p: PlaneTuple): PlaneTuple {
  return quantizePlane(p as number[]) as PlaneTuple
}
/** Plan coordinates and speeds beyond this are nonsense. */
const POSE_LIMIT = 1e6

/** A room name from a URL: lowercase [a-z0-9-], at most ROOM_MAX characters, DEFAULT_ROOM if nothing is left. */
export function roomName(v: string | null | undefined): string {
  const s = (v ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+/, "")
    .slice(0, ROOM_MAX)
    .replace(/-+$/, "")
  return s || DEFAULT_ROOM
}

/** A binary frame for the high-rate messages (shared/wire.ts), JSON text for the rest. */
export const encode = (msg: ClientMsg | ServerMsg): string | Uint8Array => encodeWire(msg) ?? JSON.stringify(msg)

/** Client frames are tiny; server frames carry the crew and every ship (the same caps in bytes for binary frames). */
const MAX_CLIENT_FRAME = 512
const MAX_SERVER_FRAME = 1 << 16

const isU32 = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 0xffffffff
const isTime = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)
const isCount = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0
const isInt = (v: unknown): v is number => Number.isInteger(v)
const isUnit = (v: unknown, lo: number): v is number => typeof v === "number" && v >= lo && v <= 1
const isStr = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max
const isRole = (v: unknown): v is Role => v === "helm" || v === "pilot" || v === "gunner"

function parse(raw: unknown, max: number, wire: (b: Uint8Array) => Record<string, unknown> | null): Record<string, unknown> | null {
  const bytes = wireBytes(raw)
  if (bytes) return bytes.byteLength <= max ? wire(bytes) : null
  if (typeof raw !== "string" || raw.length > max) return null
  try {
    const v: unknown = JSON.parse(raw)
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function numbers(v: unknown, length: number, max = length): number[] | null {
  if (!Array.isArray(v) || v.length < length || v.length > max) return null
  for (const n of v) if (typeof n !== "number" || !Number.isFinite(n) || Math.abs(n) > POSE_LIMIT) return null
  return v as number[]
}

function planeOf(v: unknown): PlaneTuple | null {
  const n = numbers(v, PLANE_TUPLE_LENGTH, PLANE_TUPLE_FULL)
  if (!n) return null
  const mode = n[1]!
  if (n.length > 17 && !(Number.isInteger(n[17]) && n[17]! >= 0 && n[17]! < 16)) return null
  if (n.length > 18 && !isUnit(n[18], 0)) return null
  return mode === 0 || mode === 1 || mode === 2 || mode === 3 ? (n as PlaneTuple) : null
}

function worldOf(v: unknown): World | undefined {
  if (!v || typeof v !== "object") return undefined
  const { seed, epoch } = v as Record<string, unknown>
  return isU32(seed) && isTime(epoch) && epoch > 0 ? { seed, epoch } : undefined
}

const ids = (v: unknown): v is (number | null)[] => Array.isArray(v) && v.every((x) => x === null || isCount(x))

function aircraftOf(v: unknown): Aircraft | null {
  if (!v || typeof v !== "object") return null
  const o = v as Record<string, unknown>
  return isStr(o.op, 16) && (o.pilot === null || isCount(o.pilot)) && isTime(o.readyAt) ? { op: o.op, pilot: o.pilot as number | null, readyAt: o.readyAt } : null
}

function crewShipOf(v: unknown): CrewShip | null {
  if (!v || typeof v !== "object") return null
  const o = v as Record<string, unknown>
  if (!isCount(o.id) || !isStr(o.name, 40) || !isCount(o.hull) || !isCount(o.team) || o.team >= CREW.ships || !(o.helm === null || isCount(o.helm))) return null
  if (!Array.isArray(o.pilots) || !o.pilots.every(isCount) || !Array.isArray(o.aircraft)) return null
  if (o.emptySince !== null && !isTime(o.emptySince)) return null
  if (!(o.captain === null || isCount(o.captain)) || typeof o.locked !== "boolean" || !Array.isArray(o.bans)) return null
  const bans = o.bans.map((b: unknown) => {
    const x = b as Record<string, unknown> | null
    return x && typeof x === "object" && isCount(x.player) && isTime(x.until) ? { player: x.player, until: x.until } : null
  })
  if (bans.includes(null)) return null
  const aircraft = o.aircraft.map(aircraftOf)
  if (aircraft.includes(null)) return null
  return {
    id: o.id,
    name: o.name,
    hull: o.hull,
    team: o.team,
    helm: o.helm as number | null,
    pilots: o.pilots as number[],
    aircraft: aircraft as Aircraft[],
    emptySince: o.emptySince as number | null,
    captain: o.captain as number | null,
    locked: o.locked,
    bans: bans as { player: number; until: number }[],
    catapultUntil: isTime(o.catapultUntil) ? o.catapultUntil : 0,
  }
}

function crewPlayerOf(v: unknown): CrewPlayer | null {
  if (!v || typeof v !== "object") return null
  const o = v as Record<string, unknown>
  if (!isCount(o.id) || !isStr(o.name, CREW.nameMax) || !isCount(o.team) || !isCount(o.ship) || !isRole(o.role) || !isInt(o.plane) || !isCount(o.sortie) || !isTime(o.waitSince) || !isTime(o.since)) return null
  const mount = isInt(o.mount) && o.mount >= -1 && o.mount < 16 ? o.mount : -1
  return { id: o.id, name: o.name, team: o.team, ship: o.ship, role: o.role, plane: o.plane, mount, sortie: o.sortie, waitSince: o.waitSince, since: o.since }
}

function crewOf(v: unknown): Crew | null {
  if (!v || typeof v !== "object") return null
  const o = v as Record<string, unknown>
  if (!isU32(o.seed) || !isCount(o.made) || !isCount(o.nextShip) || !Array.isArray(o.ships) || !Array.isArray(o.players)) return null
  const ships = o.ships.map(crewShipOf)
  const players = o.players.map(crewPlayerOf)
  if (ships.includes(null) || players.includes(null)) return null
  const crew: Crew = { seed: o.seed, made: o.made, nextShip: o.nextShip, ships: ships as CrewShip[], players: players as CrewPlayer[] }
  if (Array.isArray(o.refitAt) && o.refitAt.length <= 8 && o.refitAt.every(isTime)) crew.refitAt = o.refitAt as number[]
  return crew
}

/** An old client's "returned" (the removed R key) decodes to null and is ignored. */
const HOW: readonly RecoverHow[] = ["landed", "crashed"]

/** Validates an untrusted client frame. Returns null for anything malformed. */
export function decodeClient(raw: unknown): ClientMsg | null {
  const o = parse(raw, MAX_CLIENT_FRAME, decodeClientWire)
  if (!o) return null
  switch (o.type) {
    case "ping":
      return isTime(o.c) ? { type: "ping", c: o.c } : null
    case "helm":
      return isUnit(o.o, -1) && isUnit(o.r, -1) ? { type: "helm", o: o.o, r: o.r } : null
    case "op":
      return isOpId(o.op) ? { type: "op", op: o.op } : null
    case "promote":
    case "kick":
      return isCount(o.player) ? { type: o.type, player: o.player } : null
    case "lock":
      return typeof o.locked === "boolean" ? { type: "lock", locked: o.locked } : null
    case "board":
      if (!isCount(o.ship)) return null
      return isRole(o.as) ? { type: "board", ship: o.ship, as: o.as } : { type: "board", ship: o.ship }
    case "newship":
      return { type: "newship" }
    case "recover":
      if (!HOW.includes(o.how as RecoverHow)) return null
      return { type: "recover", how: o.how as RecoverHow }
    case "shiphits":
      return isCount(o.ship) && isCount(o.n) && o.n > 0 && o.n <= 200 ? { type: "shiphits", ship: o.ship, n: o.n } : null
    case "plane": {
      const p = planeOf(o.p)
      return p ? { type: "plane", p } : null
    }
    case "weather": {
      if (!isTime(o.f) || o.f < 0 || o.f > 600) return null
      if (o.to === "auto" || WEATHER_KINDS.includes(o.to as WeatherKind)) return { type: "weather", to: o.to as WeatherKind | "auto", f: o.f }
      return unpackWeather(o.to) ? { type: "weather", to: o.to as number[], f: o.f } : null
    }
    case "time":
      if (!isTime(o.f) || o.f < 0 || o.f > 600 || !isTime(o.s) || o.s < 0 || o.s > TIME_SPEED_MAX) return null
      return o.h === null || (isTime(o.h) && o.h >= 0 && o.h <= 24) ? { type: "time", h: o.h as number | null, s: o.s, f: o.f } : null
    case "gun":
      return typeof o.on === "boolean" ? { type: "gun", on: o.on } : null
    case "hits":
      return isCount(o.on) && isCount(o.n) && o.n > 0 && o.n <= 200 ? { type: "hits", on: o.on, n: o.n } : null
    case "fire": {
      const m = numbers(o.m, FIRE_LENGTH)
      return m && isCount(m[0]) && isInt(m[8]) && m[8] >= -1 && (m[9] === 0 || m[9] === 1) ? { type: "fire", m: m as FireTuple } : null
    }
    case "flare": {
      const f = numbers(o.f, FLARE_LENGTH)
      return f ? { type: "flare", f: f as FlareTuple } : null
    }
    case "seek":
      return isInt(o.on) && o.on >= -1 && typeof o.locked === "boolean" ? { type: "seek", on: o.on, locked: o.locked } : null
    case "aim":
      return isAimTuple(o.a) ? { type: "aim", a: o.a } : null
    case "gfire":
      return isGunFireTuple(o.g) ? { type: "gfire", g: o.g } : null
    case "thits":
      return isCount(o.on) && isCount(o.n) && o.n > 0 && o.n <= 300 ? { type: "thits", on: o.on, n: o.n } : null
    case "intercept":
      return isInterceptTuple(o.i) ? { type: "intercept", i: o.i } : null
    case "boat":
      return isBoatCtl(o.c) ? { type: "boat", c: o.c } : null
    case "bhits":
      return (o.k === 0 || o.k === 1 || o.k === 2) && isCount(o.on) && isCount(o.n) && o.n > 0 && o.n <= 60 ? { type: "bhits", k: o.k, on: o.on, n: o.n } : null
    case "deckhits":
      return (o.w === 0 || o.w === 1 || o.w === 2) && isCount(o.ship) && isCount(o.slot) && o.slot < 64 && isCount(o.n) && o.n > 0 && o.n <= 300 ? { type: "deckhits", w: o.w, ship: o.ship, slot: o.slot, n: o.n } : null
    case "chat": {
      const text = cleanChat(o.text)
      if (!text) return null
      return o.crew === true ? { type: "chat", text, crew: true } : { type: "chat", text }
    }
    case "objective":
      return Array.isArray(o.r) && o.r.length <= 16 && o.r.every(isTime) ? { type: "objective", r: o.r as number[] } : null
    case "bot": {
      const cmd = botCmdOf(o.cmd)
      return cmd ? { type: "bot", cmd } : null
    }
    case "hello": {
      if (!isStr(o.build, 64)) return null
      const msg: ClientMsg = { type: "hello", build: o.build }
      const resume = worldOf(o.resume)
      if (resume) msg.resume = resume
      if (isStr(o.name, 64)) msg.name = o.name
      const back = o.back as Record<string, unknown> | undefined
      if (back && typeof back === "object" && isCount(back.ship) && isRole(back.role)) msg.back = { ship: back.ship, role: back.role }
      if (isStr(o.token, 64) && o.token.length > 0) msg.token = o.token
      return msg
    }
  }
  return null
}

/** Validates a server frame. Returns null for anything malformed. */
export function decodeServer(raw: unknown): ServerMsg | null {
  const o = parse(raw, MAX_SERVER_FRAME, decodeServerWire)
  if (!o) return null
  switch (o.type) {
    case "welcome": {
      const w = worldOf(o)
      if (!w || !isTime(o.now) || !isCount(o.players) || !isCount(o.id)) return null
      const msg: Extract<ServerMsg, { type: "welcome" }> = { type: "welcome", seed: w.seed, epoch: w.epoch, now: o.now, players: o.players, id: o.id }
      if (isStr(o.token, 64) && o.token.length > 0) msg.token = o.token
      if (o.dev === true) msg.dev = true
      return msg
    }
    case "reload":
      return { type: "reload" }
    case "full":
      return { type: "full" }
    case "pong":
      return isTime(o.c) && isTime(o.s) ? { type: "pong", c: o.c, s: o.s } : null
    case "players":
      return isCount(o.n) ? { type: "players", n: o.n } : null
    case "crew": {
      const crew = crewOf(o.crew)
      return crew ? { type: "crew", crew } : null
    }
    case "ships": {
      if (!Array.isArray(o.s)) return null
      const s = o.s.map((v) => numbers(v, SHIP_TUPLE_LENGTH))
      if (s.some((v) => !v || !isCount(v[0]))) return null
      return { type: "ships", s: s as ShipTuple[] }
    }
    case "nope":
      return isStr(o.error, 32) ? { type: "nope", error: o.error } : null
    case "weather":
      if (o.o === null) return { type: "weather", o: null }
      return Array.isArray(o.o) && o.o.length <= 64 && o.o.every(isTime) ? { type: "weather", o: o.o as number[] } : null
    case "time":
      if (o.o === null) return { type: "time", o: null }
      return Array.isArray(o.o) && o.o.length === 6 && o.o.every(isTime) ? { type: "time", o: o.o as number[] } : null
    case "gun":
      return isCount(o.id) && typeof o.on === "boolean" ? { type: "gun", id: o.id, on: o.on } : null
    case "fire": {
      const m = numbers(o.m, FIRE_LENGTH)
      return isCount(o.id) && m ? { type: "fire", id: o.id, m: m as FireTuple } : null
    }
    case "flare": {
      const f = numbers(o.f, FLARE_LENGTH)
      return isCount(o.id) && f ? { type: "flare", id: o.id, f: f as FlareTuple } : null
    }
    case "seek":
      return isCount(o.by) && (o.s === 0 || o.s === 1 || o.s === 2) ? { type: "seek", by: o.by, s: o.s } : null
    case "boom": {
      const b = numbers(o.b, BOOM_LENGTH)
      return b ? { type: "boom", b: b as BoomTuple } : null
    }
    case "hp":
      return isCount(o.id) && isTime(o.hp) && isInt(o.by) && WEAPON_NAMES.includes(o.w as string) ? { type: "hp", id: o.id, hp: o.hp, by: o.by, w: o.w as string } : null
    case "kill":
      return isCount(o.on) && isInt(o.by) && WEAPON_NAMES.includes(o.w as string) ? { type: "kill", on: o.on, by: o.by, w: o.w as string } : null
    case "hulls":
      return Array.isArray(o.h) && o.h.length <= 64 && o.h.every(isHullTuple) ? { type: "hulls", h: o.h as HullTuple[] } : null
    case "turrets":
      return Array.isArray(o.t) && o.t.length <= 64 && o.t.every(isTurretTuple) ? { type: "turrets", t: o.t as TurretTuple[] } : null
    case "gfire":
      return isCount(o.id) && isGunFireTuple(o.g) ? { type: "gfire", id: o.id, g: o.g } : null
    case "gboom":
      return isGunBoomTuple(o.b) ? { type: "gboom", b: o.b } : null
    case "boats":
      return Array.isArray(o.b) && o.b.length <= 64 && o.b.every(isBoatTuple) ? { type: "boats", b: o.b as BoatTuple[] } : null
    case "bots": {
      if (!Array.isArray(o.b) || o.b.length > 64) return null
      const b = o.b.map(botInfoOf)
      return b.every((x) => x) ? { type: "bots", b: b as BotInfo[] } : null
    }
    case "obj":
      return unpackObjective(o.o) ? { type: "obj", o: o.o as number[] } : null
    case "chat": {
      const text = cleanChat(o.text)
      if (!text || !isCount(o.from) || !isStr(o.name, CREW.nameMax) || !isCount(o.team) || o.team >= CREW.ships) return null
      const m = { type: "chat" as const, from: o.from, name: o.name, team: o.team, text }
      return o.crew === true ? { ...m, crew: true } : m
    }
    case "bump":
      return isCount(o.a) && isCount(o.b) && isTime(o.k) && o.k >= 0 && o.k <= 1 ? { type: "bump", a: o.a, b: o.b, k: o.k } : null
    case "deckkill":
      return isCount(o.ship) && isCount(o.slot) && o.slot < 64 && isInt(o.by) && DECK_JET_WEAPONS.includes(o.w as DeckJetWeapon) ? { type: "deckkill", ship: o.ship, slot: o.slot, by: o.by, w: o.w as DeckJetWeapon } : null
    case "sunk":
      return isCount(o.ship) && isStr(o.name, 40) && isCount(o.team) && isInt(o.by) ? { type: "sunk", ship: o.ship, name: o.name, team: o.team, by: o.by } : null
    case "stats": {
      if (!Array.isArray(o.s)) return null
      const s = o.s.map((v) => numbers(v, 3))
      return s.every((v) => v && isCount(v[0]) && isCount(v[1]) && isCount(v[2])) ? { type: "stats", s: s as StatTuple[] } : null
    }
    case "planes": {
      if (!Array.isArray(o.p)) return null
      const out: PlaneEntry[] = []
      for (const v of o.p) {
        if (!Array.isArray(v) || !isCount(v[0])) return null
        const p = planeOf(v.slice(1))
        if (!p) return null
        out.push([v[0], ...p])
      }
      return { type: "planes", p: out }
    }
  }
  return null
}
