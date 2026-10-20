import { distToRect, type Rect } from "@arcade/kit/sim/geom"
import { INTERACT_RANGE, type InteractionHandler, type InteractionRegistry, type RawInteractCandidate } from "../interact"
import type { OutbreakSim } from "../sim-types"
import { wedgeSlab, type BreachState } from "./rules"

/** A torn-out door lying where it fell, as an interaction target. */
export const SLAB_KIND = "door-slab"
const SLAB_HALF = 0.6

/** The slab's footprint around its rest spot, for prompts. */
export function slabRect(x: number, y: number): Rect {
  return [x - SLAB_HALF, y - SLAB_HALF, x + SLAB_HALF, y + SLAB_HALF]
}

/**
 * A torn-out door can't be shut or locked again: its prompts go (B still boards the gap), and while its slab lies
 * inside, E at the slab wedges it back across the frame as one strong board.
 */
export function registerBreachInteractions(sim: OutbreakSim, registry: InteractionRegistry): void {
  // Read the state each time: a forked sim gets its own state object after the handlers are registered.
  const live = (): BreachState | undefined => {
    const st = sim.getFeatureState<BreachState>("breach")
    return st?.on ? st : undefined
  }
  const doors = registry.get("door")
  if (doors) {
    const broken = (id: string) => Boolean(live()?.portals[id]?.broken)
    const wrapped: InteractionHandler = {
      kind: "door",
      candidates: (town, actor) => doors.candidates(town, actor).filter((c) => !broken(c.id)),
      execute: (town, actor, targetId, action) => (broken(targetId) ? { handled: false } : doors.execute(town, actor, targetId, action)),
    }
    registry.register(wrapped)
  }
  registry.register({
    kind: SLAB_KIND,
    candidates: (town, actor) => {
      const out: RawInteractCandidate[] = []
      const state = live()
      if (!state) return out
      for (const id in state.portals) {
        const w = state.portals[id]!
        if (!w.debris || !w.broken) continue
        const door = town.doors.find((d) => d.id === id)
        if (!door || sim.ai.getBarricadePlanks(id) >= 3) continue
        const rect = slabRect(w.debris.x, w.debris.y)
        if (distToRect(actor.x, actor.y, rect) > INTERACT_RANGE) continue
        const wedge = { id: "install" as const, label: "Wedge door in frame" }
        out.push({ kind: SLAB_KIND, id, rect, worldX: w.debris.x, worldY: w.debris.y, label: "Door", primary: wedge, actions: [wedge] })
      }
      return out
    },
    execute: (_town, actor, targetId, action) => {
      const state = live()
      const w = state?.portals[targetId]
      if (action !== "install" || !w?.debris || distToRect(actor.x, actor.y, slabRect(w.debris.x, w.debris.y)) > INTERACT_RANGE) return { handled: false }
      if (!state || !wedgeSlab(sim, state, targetId)) return { handled: false }
      actor.noise = Math.max(actor.noise, 9)
      return { handled: true, kind: SLAB_KIND, targetId, action, topologyChanged: true, noise: actor.noise, noiseKind: "door" }
    },
  })
}
