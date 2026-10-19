import { INTERACT_RANGE, type InteractAction, type InteractionHandler, type RawInteractCandidate } from "../interact"
import { buildingAt } from "../progression/loot"
import { ds } from "../radios/radios"
import type { OutbreakSim } from "../sim-types"
import { BODY_SLOTS, bodyDropId, bodyLoot, bodySites, DEFAULT_BODIES_TUNING, type BodiesTuning, type BodySite } from "./bodies"

/** Per-sim bodies state: the bodies in the world now (their contents are ledger stores) and the tuning last used. */
export type BodiesState = { sites: BodySite[]; key: string; tuning: BodiesTuning }

export function createBodiesState(sim: OutbreakSim): BodiesState {
  const state: BodiesState = { sites: [], key: "", tuning: DEFAULT_BODIES_TUNING }
  syncBodySites(sim, state)
  return state
}

export function bodiesTuning(features: Readonly<Record<string, Record<string, unknown>>> | undefined): BodiesTuning {
  return (features?.bodies as BodiesTuning | undefined) ?? DEFAULT_BODIES_TUNING
}

/** Re-finds the bodies when buildings stream in or out. */
export function syncBodySites(sim: OutbreakSim, state: BodiesState): void {
  const town = sim.town
  const key = `${town.buildings.length}:${town.props.length}:${town.buildings[0]?.id ?? ""}:${town.buildings.at(-1)?.id ?? ""}:${(town.vehicles ?? []).length}`
  if (key === state.key) return
  state.key = key
  state.sites = bodySites(town)
}

/** A store for every body in the world (a body streamed back keeps the store it had: searched stays searched). */
export function ensureBodyStores(sim: OutbreakSim, state: BodiesState): void {
  const ledger = sim.progression.ledger
  const rate = sim.progression.tuning.lootRate
  for (const b of state.sites) {
    if (ledger.store(b.id)) continue
    ledger.createStore({ id: b.id, mode: "slots", scope: "shared", size: BODY_SLOTS, revealed: false, at: { x: b.x, y: b.y }, initial: bodyLoot(sim.town, b.key, rate) })
  }
}

/** Whether a body rises when someone reaches for it. */
export const rises = (b: BodySite, tuning: BodiesTuning) => !b.vignette && b.riseRoll < tuning.bodyRiseChance

/** How near a body a survivor must kneel to search it. */
const REACH = 1.0

/** E at a body: search it (a short, quiet channel), then take what it had. One that is rising offers nothing. */
export function bodyHandler(sim: OutbreakSim, id: string): InteractionHandler {
  const of = () => sim.getFeatureState<BodiesState>(id)
  const rect = (b: BodySite): [number, number, number, number] => [b.x - 0.45, b.y - 0.45, b.x + 0.45, b.y + 0.45]
  return {
    kind: "body",
    candidates: (town, actor) => {
      const state = of()
      if (!state || actor.peekingWindowId) return []
      const here = buildingAt(town, actor.x, actor.y)?.id ?? null
      const out: RawInteractCandidate[] = []
      for (const b of state.sites) {
        if (Math.hypot(actor.x - b.x, actor.y - b.y) > REACH + 0.45) continue
        if ((buildingAt(town, b.x, b.y)?.id ?? null) !== here) continue
        const st = sim.progression.ledger.store(b.id)
        if (!st || st.counts.rise) continue
        let primary: InteractAction
        if (!st.revealed) primary = { id: "search", label: "Search" }
        else if (sim.progression.contents(b.id).length) primary = { id: "take", label: "Take all" }
        else continue
        out.push({ kind: "body", id: b.id, label: "Body", rect: rect(b), worldX: b.x, worldY: b.y, primary, actions: [primary] })
      }
      return out
    },
    execute: (_town, actor, targetId, action) => {
      const state = of()
      const b = state?.sites.find((s) => s.id === targetId)
      const slot = sim.progression.slotOf(actor)
      if (!state || !b || !slot || Math.hypot(actor.x - b.x, actor.y - b.y) > INTERACT_RANGE + 0.45) return { handled: false }
      const ledger = sim.progression.ledger
      const st = ledger.store(b.id)
      if (!st || st.counts.rise) return { handled: false }
      if (action === "take") return { handled: sim.progression.take(slot, b.id), kind: "body", targetId, action }
      if (action !== "search" || st.revealed) return { handled: false }
      const t = state.tuning
      if (rises(b, t)) {
        // It was only nearly dead: it stirs as the survivor reaches for it (`stepBodies` stands it up).
        st.counts.rise = Math.max(1, ds(sim.time))
        st.rev = ++ledger.rev
        return { handled: true, kind: "body", targetId, action, noise: t.bodySearchNoise, noiseKind: "search" }
      }
      const res = ledger.start({ kind: "reveal", actor: slot.id, store: b.id, duration: t.bodySearchTime, noise: t.bodySearchNoise, label: "Searching the body" }, {}, { x: b.x, y: b.y })
      sim.progression.feedback(slot, res.events)
      return { handled: res.ok, kind: "body", targetId, action, noise: res.noise, noiseKind: "search" }
    },
  }
}

/** Once per tick: a body that began to rise gets up as one of the dead, after the survivor who woke it, and what it carried falls where it lay. */
export function stepBodies(sim: OutbreakSim, state: BodiesState): void {
  ensureBodyStores(sim, state)
  const ledger = sim.progression.ledger
  const t = ds(sim.time)
  for (const b of state.sites) {
    const st = ledger.store(b.id)
    if (!st?.counts.rise || st.counts.risen) continue
    if (t < st.counts.rise + ds(state.tuning.bodyRiseDelay)) continue
    st.counts.risen = 1
    const stacks = st.slots.filter((s) => s !== null)
    st.slots = st.slots.map(() => null)
    st.revealed = true
    st.rev = ++ledger.rev
    if (stacks.length && !ledger.store(bodyDropId(b.key))) {
      ledger.createStore({ id: bodyDropId(b.key), mode: "slots", scope: "shared", size: stacks.length, at: { x: b.x, y: b.y }, initial: stacks })
    }
    const z = sim.ai.spawnZombie(sim.town, b.x, b.y, "chase")
    let near: { x: number; y: number; d: number } | null = null
    for (const s of sim.slots) {
      const p = s.survivor
      if (p.health <= 0) continue
      const d = Math.hypot(p.x - b.x, p.y - b.y)
      if (!near || d < near.d) near = { x: p.x, y: p.y, d }
    }
    if (near) {
      z.targetX = near.x
      z.targetY = near.y
      z.targetKind = "proximity"
      z.aim = Math.atan2(near.y - b.y, near.x - b.x)
    }
    sim.ai.emitNoise(b.x, b.y, 8, "groan", sim.time, "body", 0.8)
  }
}
