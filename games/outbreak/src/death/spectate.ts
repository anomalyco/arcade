import type { SurvivorSlot } from "../../shared/coop-sim"
import type { DeathState, LifeState } from "../../shared/death/rules"
import type { LocalSession } from "../../shared/session"
import type { NetSession } from "../net-session"

/** The local survivor's slot: the offline session's own, or the room's predicted one. */
export function localSlot(session: LocalSession | NetSession): SurvivorSlot {
  return "local" in session ? session.local : session.slot
}

export const lifeIn = (state: DeathState | undefined, index: number): LifeState => state?.records[index]?.state ?? "alive"

/**
 * Who a dead survivor watches: the teammate they were watching while still standing, else the first standing one,
 * else the first still down. Null when nobody is left (or the local survivor is not dead).
 */
export function spectateTarget(
  state: DeathState | undefined,
  slots: readonly Pick<SurvivorSlot, "index">[],
  localIndex: number,
  previous: number | null,
): number | null {
  if (lifeIn(state, localIndex) !== "dead") return null
  const others = slots.filter((s) => s.index !== localIndex)
  if (previous !== null && others.some((s) => s.index === previous) && lifeIn(state, previous) === "alive") return previous
  const standing = others.find((s) => lifeIn(state, s.index) === "alive")
  if (standing) return standing.index
  return others.find((s) => lifeIn(state, s.index) === "down")?.index ?? null
}
