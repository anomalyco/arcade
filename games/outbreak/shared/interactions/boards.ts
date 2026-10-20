import { distToRect } from "@arcade/kit/sim/geom"
import { INTERACT_RANGE, type InteractAction, type InteractionHandler, type InteractionRegistry, type RawInteractCandidate } from "../interact"
import type { OutbreakSim } from "../sim-types"
import type { InteractionsTuning } from "./tuning"

/** Hold E at a boarded door or window: one board comes off and goes back in the belt (`progression.startUnboard`). */
export const PRY_OFF: InteractAction = { id: "pry", label: "Pry off a board", hold: true }

/** Boards nailed across a doorway whose door the dead tore off (`shared/breach`), where no door prompt is left. */
export const BOARDS_KIND = "boards"

/**
 * Wraps the door and window handlers so a boarded opening's Hold E pries a board off (its tap is still refused:
 * "Blocked by barricade"). Unboarded openings, and every opening with the toggle off, are left exactly as they were.
 * A doorway with no door left (torn off by the dead) gets a `boards` target of its own while boarded.
 */
export function registerPryBoards(sim: OutbreakSim, registry: InteractionRegistry, tuning: () => InteractionsTuning | undefined): void {
  const boarded = (id: string) => (tuning()?.pryBoards ?? 0) > 0 && sim.ai.getBarricadePlanks(id) > 0
  for (const kind of ["door", "window"] as const) {
    const inner = registry.get(kind)
    if (!inner) continue
    const handler: InteractionHandler = {
      kind,
      candidates(town, actor) {
        // A boarded window's tap (Peek) waits for the release, so a hold reaches the pry without peeking first.
        return inner.candidates(town, actor).map((c) =>
          boarded(c.id) ? { ...c, secondary: PRY_OFF, deferPrimary: true, actions: [...c.actions.filter((a) => !a.hold), PRY_OFF] } : c,
        )
      },
      execute(town, actor, targetId, action) {
        if (action !== "pry" || !boarded(targetId)) return inner.execute(town, actor, targetId, action)
        const portal = kind === "door" ? town.doors.find((d) => d.id === targetId) : town.windows.find((w) => w.id === targetId)
        if (!portal) return { handled: false }
        const res = sim.progression.startUnboard(actor, portal)
        return { handled: res.handled, kind, targetId, action, noise: res.noise, noiseKind: "barricade" }
      },
    }
    registry.register(handler)
  }
  registry.register({
    kind: BOARDS_KIND,
    candidates(town, actor) {
      const out: RawInteractCandidate[] = []
      const doors = registry.get("door")
      for (const d of town.doors) {
        if (!boarded(d.id) || distToRect(actor.x, actor.y, d.rect) > INTERACT_RANGE) continue
        // Only where the door handler offers nothing (its door is gone).
        if (doors?.candidates(town, actor).some((c) => c.id === d.id)) continue
        out.push({ kind: BOARDS_KIND, id: d.id, rect: d.rect, worldX: (d.rect[0] + d.rect[2]) / 2, worldY: (d.rect[1] + d.rect[3]) / 2, primary: PRY_OFF, secondary: PRY_OFF, actions: [PRY_OFF] })
      }
      return out
    },
    execute(town, actor, targetId, action) {
      // Only the hold pries; a tap does nothing.
      if (action !== "pry" || !actor.holdTriggered || !boarded(targetId)) return { handled: false }
      const door = town.doors.find((d) => d.id === targetId)
      if (!door) return { handled: false }
      const res = sim.progression.startUnboard(actor, door)
      return { handled: res.handled, kind: BOARDS_KIND, targetId, action, noise: res.noise, noiseKind: "barricade" }
    },
  })
}
