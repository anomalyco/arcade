// Test helpers for crews: lay players out on chosen ships without going through the joining and balance rules.
import { type Crew, type Role, crewCount, playerOf, shipOf } from "../shared/crew"

/**
 * Moves player `id` aboard ship `shipId` as `role` directly (tests only: no balance, room or lock checks), keeping the
 * crew's invariants: helm/pilot lists, captaincy (the first aboard an empty ship captains it), empty marks.
 */
export function place(c: Crew, id: number, shipId: number, role: Role = "pilot", now = 0): void {
  const p = playerOf(c, id)!
  const from = shipOf(c, p.ship)
  const to = shipOf(c, shipId)!
  if (from) {
    if (from.helm === id) from.helm = null
    from.pilots = from.pilots.filter((x) => x !== id)
    for (const a of from.aircraft) if (a.pilot === id) a.pilot = null
    if (from.captain === id) {
      const next = c.players.filter((x) => x.ship === from.id && x.id !== id).sort((a, b) => a.since - b.since || a.id - b.id)[0]
      from.captain = next?.id ?? null
    }
    if (crewCount(from) === 0) {
      from.emptySince = now
      from.locked = false
      from.captain = null
    }
  }
  if (role === "helm") {
    if (to.helm !== null) place(c, to.helm, to.id, "pilot", now)
    to.helm = id
  } else to.pilots.push(id)
  if (p.ship !== to.id) p.since = now
  p.ship = to.id
  p.team = to.team
  p.role = role
  p.plane = -1
  p.mount = -1
  to.emptySince = null
  if (to.captain === null) to.captain = id
}

/** Adds a player `id` straight onto ship `shipId` (tests only). */
export function add(c: Crew, id: number, shipId: number, role: Role = "pilot", now = 0): void {
  const to = shipOf(c, shipId)!
  c.players.push({ id, name: `p${id}`, team: to.team, ship: -1, role, plane: -1, mount: -1, sortie: 0, waitSince: now, since: now })
  place(c, id, shipId, role, now)
}
