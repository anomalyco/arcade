// Crews: who is aboard which ship, and as what. Pure and deterministic: the room (server/core.ts) owns the one
// authoritative `Crew`, applies these functions to it and broadcasts the result; tests drive them directly. Every
// operation mutates the crew in place and returns an `Outcome`: the events it caused, or why it was refused (and then
// nothing changed). Times (`now`, `emptySince`, `readyAt`, `waitSince`) are the room clock (server Date.now() ms).
//
// The model:
// - A room holds up to `CREW.roomMax` (32) players in two teams (`TEAMS`) of `CREW.shipsPerTeam` (2) ships each; a ship
//   belongs to one team for life. The room keeps every team at full strength: the ships exist from the first join
//   (`ensureFleet`), crewed or not, and a ship sunk in battle is replaced after `CREW.refitMs`.
// - Everyone aboard a ship has a role: its HELM (throttle and rudder; at most one player), a PILOT (in the air or
//   waiting on deck), or a GUNNER manning one of its guns (`mount`, shared/gunnery.ts). A ship holds `CAPACITY` (8)
//   people in all, whatever their roles; the operation caps still apply (2 Hornets, 1 F-35C, one gunner per mount).
// - Ship operations (shared/ops.ts, run with `runOp`): TAKE HELM, LAUNCH a vehicle and man a gun are the only ways to
//   change role aboard; taking a gun frees the helm or another gun, launching or taking the helm leaves the gun. Vehicle slots (`Aircraft`, `cap` per vehicle operation, so CREW.aircraft Hornets per ship) limit how
//   many jets are out at once. A slot is free when no pilot holds it and its `readyAt` has passed. A jet that is
//   destroyed (`recover(.., "crashed")`) leaves its slot recharging for its operation's `recharge`; a jet that lands or
//   returns frees its slot at once.
// - Pilots without a jet wait on deck until they launch from the menu (`runOp(.., "hornet")`, a `launch` event; their
//   `sortie` counts up, so their client puts a jet on the catapult). Nothing launches by itself. The helm launching
//   hands off the helm. A pilot on deck takes a free helm with `runOp(.., "helm")`.
// - Squads (shared/squad.ts): every crewed ship has a captain (`captain`), the creator or else the first aboard, then
//   the longest-serving member (`since`) when the captain leaves. A `locked` ship takes no new members (JOIN, the
//   auto-assign below); a kicked player is kept off the ship by `bans` for a while. An emptied ship has no captain and
//   unlocks.
// - Joining the room puts you on the team with fewer players (ties: the lower team id), aboard its most crewed ship
//   with room (ties: the older ship); if that team has no ship with room, the other team's. Locked ships are skipped.
//   You take the helm if it is free, else you join as a pilot on deck.
// - Teams stay balanced: switching team (boarding or creating a ship on the other team) is allowed only if afterwards
//   the teams differ by at most one player, or by less than before. Boarding a ship on the other team switches you.
// - Creating a ship: only on a team with fewer than `shipsPerTeam` ships (one was sunk and its replacement is not out
//   yet); you become its helm. Otherwise refused (`fleet-full`).
// - Empty ships: a ship whose last crew leaves stays afloat, its sim running, for anyone to board. Only a ship beyond
//   its team's `shipsPerTeam` sinks once it has been empty for `CREW.emptyMs`.
// - Sunk in battle (shared/fleet.ts): `scuttle` removes the ship and moves its crew to other ships of the team: each to
//   the most crewed one with room (locked ships too: a rescue isn't a JOIN), else a replacement ship at once; gunners
//   and the helm arrive as pilots on deck (or the new ship's helm). With no overflow the replacement comes out after
//   `CREW.refitMs`. Airborne pilots keep
//   flying: they move with their jet (same sortie, a slot on the new ship, an extra one past the cap if needed) and
//   land on any friendly ship. A pilot who lands on another ship of the team (`recover(.., "landed", ship)`) joins it
//   if it has room.
// - Helm vacated (left, moved, launched): a `helm` event with player null. The room's ship sim then holds the last
//   throttle order and centres the rudder; the ship sails on until someone takes the helm.
//
// Room codes for the lobby live here too, since the server and the client both need them.

import { makeSlots, opById, opError, readySlot } from "./ops"
import { Rng } from "./rng"

export { slotReady } from "./ops"

export const CREW = {
  teams: 2,
  shipsPerTeam: 2,
  /** People aboard one ship, whatever their roles (helm, pilots, gunners). */
  capacity: 8,
  /** Hornet slots per ship: at most this many of its jets out at once (shared/ops.ts `cap`). */
  aircraft: opById("hornet")!.cap,
  /** A destroyed Hornet's slot recharges for this long before it can launch again (ms; shared/ops.ts `recharge`). */
  recharge: opById("hornet")!.recharge * 1000,
  /** Joining never puts a team more than this many players ahead (see joinCrew). */
  lead: 2,
  /** Players per room (teams × ships × capacity); the lobby's quick join treats a room at this count as full. */
  roomMax: 32,
  /** A surplus ship (beyond shipsPerTeam) sinks this long after its last crew left (ms). */
  emptyMs: 60_000,
  /** A ship sunk in battle is replaced this long after (ms), unless its crew needed the new ship at once. */
  refitMs: 15_000,
  nameMax: 16,
} as const

/** People a ship holds, whatever their roles. */
export const CAPACITY = CREW.capacity

/** Concept ring colours: team 0 orange, team 1 cyan; pink and lime are spare for more teams. */
export const PALETTE = ["#ff9a2e", "#38d3f0", "#ff5fa8", "#a6e83a"] as const
export const TEAMS: readonly { name: string; color: string }[] = [
  { name: "SUNSET", color: PALETTE[0] },
  { name: "LAGOON", color: PALETTE[1] },
]

const SHIP_NAMES = ["RESOLUTE", "VALIANT", "INTREPID", "ENDEAVOUR", "HORIZON", "TEMPEST", "MERIDIAN", "RANGER", "ORION", "HALCYON", "SENTINEL", "MONSOON", "TRIDENT", "AURORA", "CORSAIR", "VANGUARD", "TYPHOON", "ALBATROSS", "NAUTILUS", "STARLING"]

/**
 * One vehicle slot: the operation it belongs to (shared/ops.ts, "hornet"), the pilot flying it, and when it can launch
 * again after its vehicle was destroyed (room ms).
 */
export type Aircraft = { op: string; pilot: number | null; readyAt: number }

export type CrewShip = {
  id: number
  /** "CV-07 RESOLUTE". */
  name: string
  hull: number
  team: number
  /** Formation slot within its team, 0..shipsPerTeam-1 (for spawn positions). */
  slot: number
  /** The helm's player id, null when nobody drives. */
  helm: number | null
  /** Everyone aboard but the helm (pilots flying or on deck, and gunners: their `role` says which), in boarding order. */
  pilots: number[]
  aircraft: Aircraft[]
  /** When its last crew left (room clock, ms), null while crewed. */
  emptySince: number | null
  /** The squad's captain (shared/squad.ts), null while empty. */
  captain: number | null
  /** No new members while locked. */
  locked: boolean
  /** Players kicked from it and until when they can't come back (room ms). */
  bans: { player: number; until: number }[]
}

export type Role = "helm" | "pilot" | "gunner"

export type CrewPlayer = {
  id: number
  name: string
  team: number
  ship: number
  role: Role
  /** The aircraft slot this pilot is flying, -1 when on deck (or at the helm). */
  plane: number
  /** The gun this gunner mans (carrier-spec WEAPON_MOUNTS index), -1 for every other role. */
  mount: number
  /** Counts this player's launches: each new one is a fresh jet on the catapult. */
  sortie: number
  /** Since when this pilot has been waiting on deck (room ms). */
  waitSince: number
  /** When they boarded their current ship (room ms): the longest-serving member becomes captain. */
  since: number
}

/** Plain JSON, so the room can send it as is. `made` counts ships ever created (names and hull numbers). `refitAt`
 *  (room ms, per team): a sunk ship's replacement comes out from then (the room's own; clients don't get it). */
export type Crew = { seed: number; made: number; nextShip: number; ships: CrewShip[]; players: CrewPlayer[]; refitAt?: number[] }

/** How a sortie ends: landed on its carrier (the slot frees at once) or destroyed (crashed, shot down, lost off the
 *  map: the slot recharges). There is no manual way out of a flight. */
export type RecoverHow = "landed" | "crashed"

export type CrewEvent =
  | { k: "join"; player: number; ship: number; role: Role }
  /** `plane` is the aircraft slot they were flying, -1 if none. */
  | { k: "leave"; player: number; ship: number; plane: number }
  | { k: "board"; player: number; from: number; to: number; role: Role }
  | { k: "team"; player: number; team: number }
  /** A pilot took aircraft slot `slot`: a new jet on the catapult (`sortie` counted up). */
  | { k: "launch"; player: number; ship: number; slot: number }
  /** A pilot's jet is gone (landed or destroyed) and they wait on deck; the slot is ready at `readyAt`. */
  | { k: "recover"; player: number; ship: number; slot: number; how: RecoverHow; readyAt: number }
  /** A player manned gun `mount` of their ship (shared/ops.ts `gun` operations). */
  | { k: "gun"; player: number; ship: number; mount: number }
  /** Who has the helm now; null: nobody (hold the throttle, centre the rudder). */
  | { k: "helm"; ship: number; player: number | null }
  | { k: "new"; ship: number; team: number; by: number | null }
  | { k: "sink"; ship: number }
  /** Ship `ship`'s captain is now `player` (promoted, or the captain left). */
  | { k: "captain"; ship: number; player: number | null }
  | { k: "lock"; ship: number; locked: boolean }
  /** `by` kicked `player` off `ship`; a `board` event follows with where they went. */
  | { k: "kick"; ship: number; player: number; by: number }

export type CrewError =
  | "joined"
  | "no-player"
  | "no-ship"
  | "same-ship"
  | "helm-taken"
  | "at-helm"
  | "at-gun"
  | "not-helm"
  | "not-flying"
  | "ship-full"
  | "fleet-full"
  | "unbalanced"
  | "bad-team"
  | "room-full"
  | "bad-op"
  | "flying"
  | "in-use"
  | "recharging"
  | "locked"
  | "kicked"
  | "not-captain"
  | "not-member"
  | "self"

export type Outcome = { events: CrewEvent[]; error?: CrewError }

const fail = (error: CrewError): Outcome => ({ events: [], error })

export function makeCrew(seed: number): Crew {
  return { seed: seed >>> 0, made: 0, nextShip: 1, ships: [], players: [], refitAt: Array.from({ length: CREW.teams }, () => 0) }
}

export const playerOf = (c: Crew, id: number): CrewPlayer | undefined => c.players.find((p) => p.id === id)
export const shipOf = (c: Crew, id: number): CrewShip | undefined => c.ships.find((s) => s.id === id)
/** The ship a player is aboard, and so their team (for the flight side's colours). */
export const shipOfPlayer = (c: Crew, id: number): CrewShip | undefined => {
  const p = playerOf(c, id)
  return p && shipOf(c, p.ship)
}
export const roleOf = (p: CrewPlayer): Role => p.role
/** Everyone aboard: the helm plus the rest (pilots and gunners). */
export const crewCount = (s: CrewShip): number => (s.helm !== null ? 1 : 0) + s.pilots.length
export const hasRoom = (s: CrewShip): boolean => crewCount(s) < CAPACITY
export const teamCount = (c: Crew, team: number): number => c.players.filter((p) => p.team === team).length
export const teamShips = (c: Crew, team: number): CrewShip[] => c.ships.filter((s) => s.team === team)
/** The helm's player id, or null. */
export const helmOf = (s: CrewShip): number | null => s.helm

/** A display name: trimmed, single-spaced, at most CREW.nameMax characters, "SAILOR" if nothing is left. */
export function crewName(v: string | null | undefined): string {
  const s = (v ?? "").replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, CREW.nameMax).trim()
  return s || "SAILOR"
}

/** Name and hull number of the n-th ship a room makes: CV-07 first (the number on the deck), then distinct others. */
export function shipName(seed: number, n: number): { name: string; hull: number } {
  const rng = new Rng(seed ^ 0x5a17c0de)
  const names = [...SHIP_NAMES]
  for (let i = names.length - 1; i > 0; i--) {
    const j = rng.int(i + 1)
    ;[names[i], names[j]] = [names[j]!, names[i]!]
  }
  const hulls = [7]
  while (hulls.length <= n % 90) {
    const h = 10 + rng.int(90)
    if (!hulls.includes(h)) hulls.push(h)
  }
  const hull = hulls[n % 90]!
  const name = names[n % names.length]!
  return { hull, name: `CV-${String(hull).padStart(2, "0")} ${name}` }
}

/** Whether moving one player from team `from` to team `to` keeps the teams balanced (see the header). */
export function canSwitchTeam(c: Crew, from: number, to: number): boolean {
  if (from === to) return true
  const a = teamCount(c, from)
  const b = teamCount(c, to)
  const after = Math.abs(b + 1 - (a - 1))
  return after <= 1 || after < Math.abs(b - a)
}

/** Why `id` can't take their own ship's helm now, or null if they can. */
export function takeHelmError(c: Crew, id: number): CrewError | null {
  const p = playerOf(c, id)
  if (!p) return "no-player"
  const s = shipOf(c, p.ship)
  if (!s) return "no-ship"
  if (p.role === "helm") return "at-helm"
  if (s.helm !== null) return "helm-taken"
  return null
}

/**
 * Why `id` can't board ship `shipId` at `now` (as `want`, or whichever role is free), or null if they can. The Tab menu
 * greys JOIN with this. Without `now`, any kick ban counts.
 */
export function joinShipError(c: Crew, id: number, shipId: number, want?: Role, now = -Infinity): CrewError | null {
  const p = playerOf(c, id)
  if (!p) return "no-player"
  const to = shipOf(c, shipId)
  if (!to) return "no-ship"
  if (to.id === p.ship) return "same-ship"
  if (want === "helm" && to.helm !== null) return "helm-taken"
  if (!hasRoom(to)) return "ship-full"
  if (to.bans.some((b) => b.player === id && b.until > now)) return "kicked"
  if (to.locked) return "locked"
  if (!canSwitchTeam(c, p.team, to.team)) return "unbalanced"
  return null
}

/** Why `id` can't commission a ship on `team` now, or null if they can. */
export function createShipError(c: Crew, id: number, team: number): CrewError | null {
  const p = playerOf(c, id)
  if (!p) return "no-player"
  if (!Number.isInteger(team) || team < 0 || team >= CREW.teams) return "bad-team"
  // Only a team short of ships (one sunk, its replacement not out yet) can commission one.
  if (teamShips(c, team).length >= CREW.shipsPerTeam) return "fleet-full"
  if (!canSwitchTeam(c, p.team, team)) return "unbalanced"
  return null
}

function setHelm(s: CrewShip, id: number | null, ev: CrewEvent[]): void {
  s.helm = id
  ev.push({ k: "helm", ship: s.id, player: id })
}

/** Ends a pilot's flight: their slot frees (ready at `readyAt`) and they wait on deck. */
function land(p: CrewPlayer, s: CrewShip, readyAt: number, now: number): number {
  const slot = p.plane
  const a = s.aircraft[slot]
  if (a && a.pilot === p.id) {
    a.pilot = null
    a.readyAt = readyAt
  }
  p.plane = -1
  p.waitSince = now
  return slot
}

/**
 * Takes `p` off their role, and unless they stay aboard (`leaving` false: a role change on the same ship), off the
 * ship: the captaincy passes on and an emptied ship is marked empty. A jet in the air just frees its slot.
 */
function vacate(c: Crew, p: CrewPlayer, now: number, ev: CrewEvent[], leaving = true): void {
  const s = shipOf(c, p.ship)
  if (!s) return
  if (p.role === "helm" && s.helm === p.id) setHelm(s, null, ev)
  if (p.role !== "helm") {
    if (p.plane >= 0) land(p, s, now, now)
    s.pilots = s.pilots.filter((x) => x !== p.id)
  }
  p.mount = -1
  if (!leaving) return
  if (s.captain === p.id) {
    // The longest-serving member left aboard takes over.
    const next = c.players.filter((x) => x.ship === s.id && x !== p && (x.id === s.helm || s.pilots.includes(x.id))).sort((a, b) => a.since - b.since || a.id - b.id)[0]
    s.captain = next?.id ?? null
    ev.push({ k: "captain", ship: s.id, player: s.captain })
  }
  if (crewCount(s) === 0) {
    s.emptySince = now
    s.locked = false
  }
}

/** Puts `p` aboard `s` as `role` (room checked by the caller). A pilot waits on deck until they launch. */
function board(p: CrewPlayer, s: CrewShip, role: Role, now: number, ev: CrewEvent[]): void {
  if (p.ship !== s.id) p.since = now
  if (s.captain === null) {
    s.captain = p.id
    ev.push({ k: "captain", ship: s.id, player: p.id })
  }
  p.ship = s.id
  p.team = s.team
  p.role = role
  p.plane = -1
  p.mount = -1
  s.emptySince = null
  if (role === "helm") setHelm(s, p.id, ev)
  else {
    s.pilots.push(p.id)
    p.waitSince = now
  }
}

const done = (ev: CrewEvent[]): Outcome => ({ events: ev })

/** The role someone boarding `s` gets: `want` if given (a gun seat boards as a pilot on deck), else the helm if free,
 *  else pilot. */
const boardingRole = (s: CrewShip, want?: Role): Role => (want === "gunner" ? "pilot" : want) ?? (s.helm === null ? "helm" : "pilot")

function newShip(c: Crew, team: number, by: number | null, now: number, ev: CrewEvent[]): CrewShip | null {
  const mine = teamShips(c, team)
  if (mine.length >= CREW.shipsPerTeam) {
    const empty = mine.filter((s) => s.emptySince !== null).sort((a, b) => a.emptySince! - b.emptySince! || a.id - b.id)[0]
    if (!empty) return null
    sink(c, empty, ev)
  }
  const used = new Set(teamShips(c, team).map((s) => s.slot))
  let slot = 0
  while (used.has(slot)) slot++
  const { name, hull } = shipName(c.seed, c.made++)
  const s: CrewShip = { id: c.nextShip++, name, hull, team, slot, helm: null, pilots: [], aircraft: makeSlots(), emptySince: now, captain: null, locked: false, bans: [] }
  c.ships.push(s)
  ev.push({ k: "new", ship: s.id, team, by })
  return s
}

function sink(c: Crew, s: CrewShip, ev: CrewEvent[]): void {
  c.ships = c.ships.filter((x) => x !== s)
  ev.push({ k: "sink", ship: s.id })
}

/** The team a new player goes to: fewer players first, ties to the lower id. */
function teamOrder(c: Crew): number[] {
  return Array.from({ length: CREW.teams }, (_, t) => t).sort((a, b) => teamCount(c, a) - teamCount(c, b) || a - b)
}

/**
 * Brings every team up to `CREW.shipsPerTeam` ships: new, empty ships (at the team's spawn), except while a sunk ship's
 * replacement is still being refitted (`refitAt`). Runs on every join and every room tick.
 */
export function ensureFleet(c: Crew, now: number, ev: CrewEvent[] = []): CrewEvent[] {
  for (let t = 0; t < CREW.teams; t++) {
    if (now < (c.refitAt?.[t] ?? 0)) continue
    while (teamShips(c, t).length < CREW.shipsPerTeam) if (!newShip(c, t, null, now, ev)) break
  }
  return ev
}

/** A new player joins the room (see the header for where they go). */
export function joinCrew(c: Crew, id: number, name: string, now: number): Outcome {
  if (playerOf(c, id)) return fail("joined")
  if (c.players.length >= CREW.roomMax) return fail("room-full")
  const ev: CrewEvent[] = ensureFleet(c, now)
  const order = teamOrder(c)
  const roomy = (t: number) =>
    teamShips(c, t)
      .filter((s) => hasRoom(s) && !s.locked)
      .sort((a, b) => crewCount(b) - crewCount(a) || a.id - b.id)[0]
  const ship = order.reduce<CrewShip | undefined>((found, t) => found ?? roomy(t), undefined)
  if (!ship) return fail("room-full")
  const role = boardingRole(ship)
  const p: CrewPlayer = { id, name: crewName(name), team: ship.team, ship: ship.id, role, plane: -1, mount: -1, sortie: 0, waitSince: now, since: now }
  c.players.push(p)
  ev.push({ k: "join", player: id, ship: ship.id, role })
  board(p, ship, role, now, ev)
  return done(ev)
}

/** A player leaves the room. Their jet, if they had one, is gone with them (its slot frees at once). */
export function leaveCrew(c: Crew, id: number, now: number): Outcome {
  const p = playerOf(c, id)
  if (!p) return fail("no-player")
  const ev: CrewEvent[] = [{ k: "leave", player: id, ship: p.ship, plane: p.plane }]
  vacate(c, p, now, ev)
  c.players = c.players.filter((x) => x !== p)
  return done(ev)
}

export function renameCrew(c: Crew, id: number, name: string): Outcome {
  const p = playerOf(c, id)
  if (!p) return fail("no-player")
  p.name = crewName(name)
  return { events: [] }
}

/** A pilot takes their ship's free helm (a jet in the air is gone; its slot frees at once). */
export function takeHelm(c: Crew, id: number, now: number): Outcome {
  const error = takeHelmError(c, id)
  if (error) return fail(error)
  const p = playerOf(c, id)!
  const s = shipOf(c, p.ship)!
  const ev: CrewEvent[] = []
  vacate(c, p, now, ev, false)
  board(p, s, "helm", now, ev)
  return done(ev)
}

/** Boards another ship as `want`, or (without it) at the helm if free, else as a pilot. Another team's ship switches you. */
export function joinShip(c: Crew, id: number, shipId: number, now: number, want?: Role): Outcome {
  const error = joinShipError(c, id, shipId, want, now)
  if (error) return fail(error)
  const p = playerOf(c, id)!
  const to = shipOf(c, shipId)!
  const ev: CrewEvent[] = []
  const from = p.ship
  const team = p.team
  vacate(c, p, now, ev)
  const role = boardingRole(to, want)
  ev.push({ k: "board", player: id, from, to: to.id, role })
  board(p, to, role, now, ev)
  if (team !== to.team) ev.push({ k: "team", player: id, team: to.team })
  return done(ev)
}

/** Commissions a new ship on `team` with the caller at its helm (see the header for caps and team switching). */
export function createShip(c: Crew, id: number, team: number, now: number): Outcome {
  const error = createShipError(c, id, team)
  if (error) return fail(error)
  const p = playerOf(c, id)!
  const ev: CrewEvent[] = []
  const from = p.ship
  const oldTeam = p.team
  vacate(c, p, now, ev)
  const s = newShip(c, team, id, now, ev)!
  ev.push({ k: "board", player: id, from, to: s.id, role: "helm" })
  board(p, s, "helm", now, ev)
  if (oldTeam !== team) ev.push({ k: "team", player: id, team })
  return done(ev)
}

/** The helm hands off and becomes a pilot on deck (a reconnecting pilot; the menu launches with `runOp`). */
export function launch(c: Crew, id: number, now: number): Outcome {
  const p = playerOf(c, id)
  if (!p) return fail("no-player")
  const s = shipOf(c, p.ship)
  if (!s) return fail("no-ship")
  if (p.role !== "helm") return fail("not-helm")
  const ev: CrewEvent[] = []
  vacate(c, p, now, ev, false)
  board(p, s, "pilot", now, ev)
  return done(ev)
}

/**
 * A pilot's flight ended: back on deck. A destroyed jet (`crashed`) leaves its slot recharging for its operation's
 * `recharge`; a jet that landed frees it at once.
 */
export function recover(c: Crew, id: number, how: RecoverHow, now: number, landedOn = -1): Outcome {
  const p = playerOf(c, id)
  if (!p) return fail("no-player")
  const s = shipOf(c, p.ship)
  if (!s) return fail("no-ship")
  if (p.role !== "pilot" || p.plane < 0) return fail("not-flying")
  const readyAt = how === "crashed" ? now + (opById(s.aircraft[p.plane]?.op ?? "")?.recharge ?? 0) * 1000 : now
  const slot = land(p, s, readyAt, now)
  trimSlots(s)
  const ev: CrewEvent[] = [{ k: "recover", player: id, ship: s.id, slot, how, readyAt }]
  // Landed on another ship of the team: aboard it now, if it has room.
  const to = how === "landed" && landedOn !== s.id ? shipOf(c, landedOn) : undefined
  if (to && to.team === s.team && hasRoom(to)) {
    vacate(c, p, now, ev)
    ev.push({ k: "board", player: id, from: s.id, to: to.id, role: "pilot" })
    board(p, to, "pilot", now, ev)
  }
  return done(ev)
}

/** Drops free slots past a ship's catalogue (extra ones made for rescued airborne pilots) from the end. */
function trimSlots(s: CrewShip): void {
  const base = makeSlots().length
  while (s.aircraft.length > base && s.aircraft[s.aircraft.length - 1]!.pilot === null) s.aircraft.pop()
}

/**
 * Ship `shipId` was sunk in battle (shared/fleet.ts): it is removed and its crew moves to other ships of its team (see
 * the header). The `sink` event comes first, then a `board` (and `new`) per member.
 */
export function scuttle(c: Crew, shipId: number, now: number): Outcome {
  const s = shipOf(c, shipId)
  if (!s) return fail("no-ship")
  const ev: CrewEvent[] = []
  const members = c.players.filter((p) => p.ship === s.id).sort((a, b) => (a.id === s.helm ? -1 : b.id === s.helm ? 1 : s.pilots.indexOf(a.id) - s.pilots.indexOf(b.id)))
  const flying = new Map(members.filter((p) => p.role === "pilot" && p.plane >= 0).map((p) => [p.id, s.aircraft[p.plane]?.op ?? "hornet"]))
  sink(c, s, ev)
  // The team is short a ship: its replacement comes out after the refit (or at once below, if the crew needs it).
  if (c.refitAt) c.refitAt[s.team] = now + CREW.refitMs
  for (const p of members) {
    const op = flying.get(p.id)
    const to =
      c.ships
        .filter((x) => x.team === s.team && hasRoom(x))
        .sort((a, b) => crewCount(b) - crewCount(a) || a.id - b.id)[0] ?? newShip(c, s.team, null, now, ev)
    if (!to) {
      // Nowhere to go (cannot happen: the sunk ship freed a place in the fleet); stay with the wreck's id.
      continue
    }
    const role: Role = op === undefined && to.helm === null ? "helm" : "pilot"
    ev.push({ k: "board", player: p.id, from: s.id, to: to.id, role })
    if (p.ship !== to.id) p.since = now
    if (to.captain === null) {
      to.captain = p.id
      ev.push({ k: "captain", ship: to.id, player: p.id })
    }
    p.ship = to.id
    p.role = role
    p.mount = -1
    to.emptySince = null
    if (role === "helm") {
      p.plane = -1
      setHelm(to, p.id, ev)
      continue
    }
    to.pilots.push(p.id)
    if (op === undefined) {
      p.plane = -1
      p.waitSince = now
      continue
    }
    // Still flying: a slot on the new ship for the same jet (sortie unchanged, so the client keeps flying it).
    let slot = to.aircraft.findIndex((a) => a.op === op && a.pilot === null)
    if (slot < 0) {
      to.aircraft.push({ op, pilot: null, readyAt: 0 })
      slot = to.aircraft.length - 1
    }
    to.aircraft[slot]!.pilot = p.id
    p.plane = slot
  }
  return done(ev)
}

/**
 * Runs ship operation `opId` (shared/ops.ts) for `id` at `now`: TAKE HELM, or LAUNCH a vehicle into a ready slot (the
 * helm launching hands off the helm). Refused with `opError`'s reason.
 */
export function runOp(c: Crew, id: number, opId: string, now: number): Outcome {
  const error = opError(c, id, opId, now)
  if (error) return fail(error)
  const op = opById(opId)!
  if (op.kind === "helm") return takeHelm(c, id, now)
  const p = playerOf(c, id)!
  const s = shipOf(c, p.ship)!
  const ev: CrewEvent[] = []
  if (p.role === "helm") {
    setHelm(s, null, ev)
    p.role = "pilot"
    s.pilots.push(p.id)
  }
  if (op.kind === "gun") {
    // Takes the seat: the helm handed off above; a pilot on deck or another gun's gunner switches.
    p.role = "gunner"
    p.mount = op.mount ?? -1
    ev.push({ k: "gun", player: p.id, ship: s.id, mount: p.mount })
    return done(ev)
  }
  // Launching leaves a gun.
  p.role = "pilot"
  p.mount = -1
  const slot = readySlot(s, op.id, now)
  s.aircraft[slot]!.pilot = p.id
  p.plane = slot
  p.sortie++
  ev.push({ k: "launch", player: p.id, ship: s.id, slot })
  return done(ev)
}

/**
 * Sinks surplus ships (beyond a team's shipsPerTeam) empty for CREW.emptyMs, brings refitted replacements out, and
 * forgets lapsed kick bans. Call on the room's tick.
 */
export function tickCrew(c: Crew, now: number): Outcome {
  const ev: CrewEvent[] = []
  for (const s of [...c.ships]) if (s.emptySince !== null && now - s.emptySince >= CREW.emptyMs && teamShips(c, s.team).length > CREW.shipsPerTeam) sink(c, s, ev)
  if (c.players.length) ensureFleet(c, now, ev)
  for (const s of c.ships) if (s.bans.length && s.bans.some((b) => b.until <= now)) s.bans = s.bans.filter((b) => b.until > now)
  return done(ev)
}

/**
 * Where a new ship starts. Next to a friend (its team's oldest other ship) if there is one: abeam on the team's side and
 * a little astern per slot, on the friend's heading. Otherwise in line abreast across the open water at the origin,
 * team 0 to port of `heading`, team 1 to starboard: each team's pair 220 m apart, its second ship 120 m astern (an
 * echelon), 340 m between the teams (inside the 600 m of open sea around the spawn).
 * Plan frame of shared/ship.ts: the bow points along (sin h, -cos h), starboard along (cos h, sin h).
 */
export function spawnAt(team: number, slot: number, heading: number, friend?: { x: number; z: number; heading: number }): { x: number; z: number; heading: number } {
  const side = team === 0 ? -1 : 1
  if (friend) {
    const h = friend.heading
    const lat = side * 280
    const back = -120 * (slot + 1)
    return { x: friend.x + Math.cos(h) * lat + Math.sin(h) * back, z: friend.z + Math.sin(h) * lat - Math.cos(h) * back, heading: h }
  }
  const lat = side * (170 + slot * 220)
  const back = -120 * slot
  return { x: Math.cos(heading) * lat + Math.sin(heading) * back, z: Math.sin(heading) * lat - Math.cos(heading) * back, heading }
}

// Room codes.

/** No 0/o, 1/l/i: codes are read aloud and typed from a screen. */
export const CODE_CHARS = "abcdefghjkmnpqrstuvwxyz23456789"
export const CODE_LENGTH = 4

/** A fresh room code. */
export function randomCode(rand: () => number = Math.random): string {
  let out = ""
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_CHARS[Math.floor(rand() * CODE_CHARS.length)]
  return out
}

/** A typed or linked room code: lowercase letters and digits, at most 8, or null if nothing usable is left. */
export function roomCode(v: string | null | undefined): string | null {
  const s = (v ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 8)
  return s.length >= 3 ? s : null
}
