/**
 * Giving to a teammate (playtest, Oct 20, Kit: "I should add trading so I can give you shit"): G near a standing
 * teammate hands them what G would otherwise drop. The item is dropped at their feet and they pick it up in the same
 * tick, so a full teammate leaves it lying there, still theirs to take, and nothing is ever lost.
 */

/** How close a teammate must stand to be handed something (m). */
export const GIVE_RANGE = 1.8
/** Half-angle in front of the giver that counts as facing a teammate (rad); anyone within `GIVE_TOUCH` counts. */
const GIVE_ARC = 1.1
const GIVE_TOUCH = 1.0

export type GiveCandidate = { index: number; survivor: { x: number; y: number; health: number; vehicleId?: unknown } }

/** The teammate G would hand things to: in reach and in front, or touching; the nearest wins. */
export function giveTarget<T extends GiveCandidate>(
  giver: { index: number; survivor: { x: number; y: number; aim: number; vehicleId?: unknown } },
  slots: readonly T[],
  standing: (slot: T) => boolean = (s) => s.survivor.health > 0,
): T | null {
  const g = giver.survivor
  if (g.vehicleId != null) return null
  let best: T | null = null
  let bestD = Infinity
  for (const s of slots) {
    if (s.index === giver.index || s.survivor.vehicleId != null || !standing(s)) continue
    const dx = s.survivor.x - g.x
    const dy = s.survivor.y - g.y
    const d = Math.hypot(dx, dy)
    if (d > GIVE_RANGE) continue
    const off = Math.abs(Math.atan2(Math.sin(Math.atan2(dy, dx) - g.aim), Math.cos(Math.atan2(dy, dx) - g.aim)))
    if (off > GIVE_ARC && d > GIVE_TOUCH) continue
    if (d < bestD) {
      bestD = d
      best = s
    }
  }
  return best
}

/** A seat's name for notices ("Brendan gave you a Machete"); the room supplies real names. */
export type SeatNames = (index: number) => string

export const defaultSeatName: SeatNames = (index) => `Survivor ${index + 1}`
