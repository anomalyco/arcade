import type { DeathState, LifeState } from "./rules"

export const lifeIn = (state: DeathState | undefined, index: number): LifeState => state?.records[index]?.state ?? "alive"

/** Shared by the room's interest selection and the client's camera/listener. */
export function spectateTarget(
  state: DeathState | undefined,
  slots: readonly { index: number }[],
  localIndex: number,
  previous: number | null,
): number | null {
  if (lifeIn(state, localIndex) !== "dead") return null
  const others = slots.filter((s) => s.index !== localIndex)
  if (previous !== null && others.some((s) => s.index === previous) && lifeIn(state, previous) === "alive") return previous
  return others.find((s) => lifeIn(state, s.index) === "alive")?.index ?? others.find((s) => lifeIn(state, s.index) === "down")?.index ?? null
}
