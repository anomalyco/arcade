import { type Crew, TEAMS, playerOf, shipOf } from "../../shared/crew"

export type Linear = [number, number, number]

/** Neutral accent for a jet or ship with no known team. */
export const NO_TEAM: Linear = [0.55, 0.58, 0.62]

const cache = new Map<number, Linear>()

/** A team's colour (shared/crew.ts TEAMS, the single source) as linear RGB for the shaders. */
export function teamColor(team: number | undefined): Linear {
  if (team === undefined || !TEAMS[team]) return NO_TEAM
  let c = cache.get(team)
  if (!c) {
    const h = Number.parseInt(TEAMS[team]!.color.slice(1), 16)
    c = [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255].map((v) => v ** 2.2) as Linear
    cache.set(team, c)
  }
  return c
}

/** The colour of crew ship `id`'s team. */
export const shipTeamColor = (crew: Crew | null, id: number): Linear => teamColor(crew ? shipOf(crew, id)?.team : undefined)

/** The colour of player `id`'s team. */
export const playerTeamColor = (crew: Crew | null, id: number): Linear => teamColor(crew ? playerOf(crew, id)?.team : undefined)
