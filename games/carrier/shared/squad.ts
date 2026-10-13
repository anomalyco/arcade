// Squads: every ship's crew is a squad with a captain. Pure, like shared/crew.ts (which keeps the captain current as
// players board and leave); the room applies these to its one crew and validates every request, so only a ship's
// captain can use its powers.
//
// The rules:
// - Who is captain: whoever commissions a ship (CREATE SHIP); on a ship the room made (auto-assign), the first player
//   aboard. When the captain leaves the ship (room, another ship, kicked), the longest-serving member (earliest
//   `since`, then the lower id) takes over; an empty ship has no captain and is unlocked.
// - PROMOTE: the captain hands the captaincy to another member of the ship.
// - LOCK / UNLOCK: a locked ship takes no new members at all (JOIN from the Tab menu, quick join's auto-assign, a
//   kicked player's new home); everyone aboard stays. Invite links only pick the room, so they don't bypass it.
// - KICK: the captain removes a member, who is moved to another ship on the same team with room (unlocked first: the
//   most crewed, then the oldest), else onto a new ship of their own, else onto a locked ship with room. They can't
//   come back to the ship they were kicked from for `SQUAD.kickMs`.

import {
  type Crew,
  type CrewError,
  type CrewEvent,
  type CrewShip,
  type Outcome,
  createShip,
  createShipError,
  crewCount,
  hasRoom,
  joinShip,
  playerOf,
  shipOf,
  teamShips,
} from "./crew"

export const SQUAD = {
  /** A kicked player can't rejoin that ship for this long (ms, room clock). */
  kickMs: 60_000,
} as const

const fail = (error: CrewError): Outcome => ({ events: [], error })

/** Whether player `id` is banned from ship `s` by a recent kick. */
export const kickedFrom = (s: CrewShip, id: number, now: number): boolean => s.bans.some((b) => b.player === id && b.until > now)

/** Seconds until `id` may rejoin `s` after a kick, 0 if they may. */
export function kickLeft(s: CrewShip, id: number, now: number): number {
  const until = Math.max(0, ...s.bans.filter((b) => b.player === id).map((b) => b.until))
  return Math.max(0, Math.ceil((until - now) / 1000))
}

/** The members of ship `s`, longest-serving first (the order captaincy passes in). */
export function members(c: Crew, s: CrewShip): number[] {
  return c.players
    .filter((p) => p.ship === s.id)
    .sort((a, b) => a.since - b.since || a.id - b.id)
    .map((p) => p.id)
}

/** The ship `by` captains, if any. */
export function captainShip(c: Crew, by: number): CrewShip | undefined {
  const p = playerOf(c, by)
  const s = p && shipOf(c, p.ship)
  return s && s.captain === by ? s : undefined
}

/** Why `by` can't act on member `target` of their ship (promote, kick), or null if they can. */
function overError(c: Crew, by: number, target: number): CrewError | null {
  if (!playerOf(c, by)) return "no-player"
  const s = captainShip(c, by)
  if (!s) return "not-captain"
  if (target === by) return "self"
  const t = playerOf(c, target)
  if (!t) return "no-player"
  if (t.ship !== s.id) return "not-member"
  return null
}

export const promoteError = (c: Crew, by: number, target: number): CrewError | null => overError(c, by, target)

/** The captain hands the captaincy to another member. */
export function promote(c: Crew, by: number, target: number): Outcome {
  const error = promoteError(c, by, target)
  if (error) return fail(error)
  const s = captainShip(c, by)!
  s.captain = target
  return { events: [{ k: "captain", ship: s.id, player: target }] }
}

export function lockError(c: Crew, by: number): CrewError | null {
  if (!playerOf(c, by)) return "no-player"
  return captainShip(c, by) ? null : "not-captain"
}

/** The captain locks (no new members) or unlocks their ship. */
export function setLock(c: Crew, by: number, locked: boolean): Outcome {
  const error = lockError(c, by)
  if (error) return fail(error)
  const s = captainShip(c, by)!
  if (s.locked === locked) return { events: [] }
  s.locked = locked
  return { events: [{ k: "lock", ship: s.id, locked }] }
}

/** Where a kicked player goes: another ship on the team with room (unlocked first), or null for a new ship. */
function kickTarget(c: Crew, from: CrewShip, target: number, now: number): CrewShip | "new" | null {
  const others = teamShips(c, from.team)
    .filter((s) => s !== from && hasRoom(s) && !kickedFrom(s, target, now))
    .sort((a, b) => crewCount(b) - crewCount(a) || a.id - b.id)
  const open = others.find((s) => !s.locked)
  if (open) return open
  if (!createShipError(c, target, from.team)) return "new"
  return others[0] ?? null
}

export function kickError(c: Crew, by: number, target: number, now: number): CrewError | null {
  const error = overError(c, by, target)
  if (error) return error
  return kickTarget(c, captainShip(c, by)!, target, now) ? null : "fleet-full"
}

/** The captain kicks a member: moved to another ship of the team (see the header), banned from this one for a while. */
export function kick(c: Crew, by: number, target: number, now: number): Outcome {
  const error = kickError(c, by, target, now)
  if (error) return fail(error)
  const from = captainShip(c, by)!
  const to = kickTarget(c, from, target, now)!
  const ev: CrewEvent[] = [{ k: "kick", ship: from.id, player: target, by }]
  // A locked ship takes a kicked player only when nothing else can: lift the lock for the move, then restore it.
  const relock = to !== "new" && to.locked
  if (relock) to.locked = false
  const moved = to === "new" ? createShip(c, target, from.team, now) : joinShip(c, target, to.id, now)
  if (relock) to.locked = true
  if (moved.error) return fail(moved.error)
  from.bans = from.bans.filter((b) => b.until > now && b.player !== target)
  from.bans.push({ player: target, until: now + SQUAD.kickMs })
  ev.push(...moved.events)
  return { events: ev }
}
