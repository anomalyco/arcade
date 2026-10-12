import { RESPAWN_SECONDS } from "../config"
import { MODES, type ModeId, SearchAndDestroy } from "./modes"
import type { Player, World } from "./world"

/**
 * The room host (whoever created the room, then the longest-connected human) picks sides in team modes: moving a
 * player or shuffling everyone. Picks stick (Player.hostTeam) across matches until the next shuffle; auto-balance
 * only places newcomers and players the host hasn't placed.
 */

/** Modes where the teams are the game itself, not sides to pick. */
const FIXED_TEAMS: readonly string[] = ["inf"]

/** Whether the host can pick sides in the mode. */
export const hostPicks = (mode: ModeId): boolean => MODES[mode].teams && !FIXED_TEAMS.includes(mode)

/** The human who has been in the room longest. */
export const nextHost = (w: World): string => w.order.find((id) => w.players.get(id)?.human) ?? ""

/** The host moves a player to a team. Ignored from anyone else, outside team modes or for a bad team. */
export function moveTeam(w: World, by: string, id: string, team: number): boolean {
  if (by !== w.host || !hostPicks(w.mode.id) || (team !== 0 && team !== 1)) return false
  const p = w.players.get(id)
  if (!p) return false
  place(w, p, team)
  return true
}

/** The host deals everyone onto random, even teams: humans first, so they're split as evenly as the bots. */
export function shuffleTeams(w: World, by: string): boolean {
  if (by !== w.host || !hostPicks(w.mode.id)) return false
  const all = [...w.players.values()]
  for (let i = all.length - 1; i > 0; i--) {
    const j = w.rng.int(i + 1)
    ;[all[i], all[j]] = [all[j]!, all[i]!]
  }
  all.sort((a, b) => Number(b.human) - Number(a.human))
  const first = w.rng.int(2)
  all.forEach((p, i) => place(w, p, (first + i) % 2))
  return true
}

/**
 * Pins the player to the team. Someone alive mid-match leaves the fight without a death or a score and respawns on
 * the new side after the usual delay (next round in search and destroy), dropping anything they carried.
 */
function place(w: World, p: Player, team: number): void {
  p.hostTeam = team
  if (p.team === team) return
  if (p.alive && w.phase === "play") {
    w.mode.leave(w, p)
    p.alive = false
    p.respawnAt = w.mode instanceof SearchAndDestroy ? Infinity : w.time + RESPAWN_SECONDS
  }
  p.team = team
}
