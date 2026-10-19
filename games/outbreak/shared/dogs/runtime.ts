import { clearLine } from "@arcade/kit/sim/geom"
import type { InteractAction, InteractionHandler, RawInteractCandidate } from "../interact"
import { sightRects } from "../map"
import { buildingAt } from "../progression/loot"
import { ds } from "../radios/radios"
import type { OutbreakSim } from "../sim-types"
import { DEFAULT_DOG_TUNING, dogSites, type DogSite, type DogTuning } from "./dogs"

/** Per-sim dog state: the dogs in the world now, each barking dog's barks so far, and the tuning last used. */
export type DogsState = { sites: DogSite[]; key: string; barks: Record<string, number>; tuning: DogTuning }

export function createDogsState(sim: OutbreakSim): DogsState {
  const state: DogsState = { sites: [], key: "", barks: {}, tuning: DEFAULT_DOG_TUNING }
  syncDogSites(sim, state)
  return state
}

export function dogTuning(features: Readonly<Record<string, Record<string, unknown>>> | undefined): DogTuning {
  return (features?.dogs as DogTuning | undefined) ?? DEFAULT_DOG_TUNING
}

export function syncDogSites(sim: OutbreakSim, state: DogsState): void {
  const town = sim.town
  const key = `${town.buildings.length}:${town.props.length}:${town.buildings[0]?.id ?? ""}:${town.buildings.at(-1)?.id ?? ""}`
  if (key === state.key) return
  state.key = key
  state.sites = dogSites(town)
}

/** How near the dead must get to the dog's stake, past its chain, to be at it. */
const BITE = 0.9

/**
 * Once per tick: a dog barks on a beat while anything is near and in sight (the dead, or a survivor it does not know);
 * each bark is a noise the dead come to. One of the dead staying at the dog long enough kills it. Store changes only
 * when a dog starts or stops barking, is reached, or dies, so the beat itself costs the wire nothing.
 */
export function stepDogs(sim: OutbreakSim, state: DogsState, tuning: DogTuning): void {
  const ledger = sim.progression.ledger
  const time = sim.time
  const t = ds(time)
  const blockers = sightRects(sim.town)
  for (const d of state.sites) {
    let st = ledger.store(d.id)
    if (!st) st = ledger.createStore({ id: d.id, mode: "counters", scope: "shared", at: { x: d.x, y: d.y }, initial: { bark: 0, dead: 0 } })
    if (st.counts.dead) continue
    let threat = false
    let at = false
    for (const z of sim.ai.agents) {
      if (z.state === "dead") continue
      const dist = Math.hypot(z.x - d.x, z.y - d.y)
      if (dist <= d.chain + BITE) at = true
      if (!threat && dist <= tuning.dogSense && clearLine(d.x, d.y, z.x, z.y, blockers)) threat = true
      if (threat && at) break
    }
    if (!threat && !st.counts.fed) {
      for (const s of sim.slots) {
        const p = s.survivor
        if (p.health <= 0 || sim.progression.verbs.hiddenIn(s.id)) continue
        if (Math.hypot(p.x - d.x, p.y - d.y) <= tuning.dogSense && clearLine(d.x, d.y, p.x, p.y, blockers)) {
          threat = true
          break
        }
      }
    }
    const barking = threat && t >= (st.counts.hush ?? 0)
    if (barking && !st.counts.bark) {
      st.counts.bark = 1
      st.counts.since = Math.max(1, t)
      st.rev = ++ledger.rev
      state.barks[d.id] = 0
    } else if (!barking && st.counts.bark) {
      st.counts.bark = 0
      st.rev = ++ledger.rev
      delete state.barks[d.id]
    }
    if (barking) {
      const due = Math.floor(Math.max(0, time - (st.counts.since ?? 0) / 10) / Math.max(0.1, tuning.dogBeat)) + 1
      if ((state.barks[d.id] ?? 0) < due) {
        state.barks[d.id] = due
        sim.ai.emitNoise(d.x, d.y, tuning.dogBarkNoise, "bark", time, d.id, 1.3)
      }
    }
    if (at && !st.counts.near) {
      st.counts.near = Math.max(1, t)
      st.rev = ++ledger.rev
    } else if (!at && st.counts.near) {
      st.counts.near = 0
      st.rev = ++ledger.rev
    } else if (at && t - (st.counts.near ?? t) >= ds(tuning.dogKillTime)) {
      st.counts.dead = 1
      st.counts.bark = 0
      st.counts.near = 0
      st.rev = ++ledger.rev
      delete state.barks[d.id]
      sim.ai.emitNoise(d.x, d.y, 6, "bark", time, d.id, 0.8)
    }
  }
}

/** E at a chained dog: feed it (a tin of food) and it goes quiet for a while, and is a friend from then on. */
export function dogHandler(sim: OutbreakSim, id: string): InteractionHandler {
  const of = () => sim.getFeatureState<DogsState>(id)
  const reach = (d: DogSite) => d.chain + 0.9
  return {
    kind: "dog",
    candidates: (town, actor) => {
      const state = of()
      if (!state || actor.peekingWindowId || buildingAt(town, actor.x, actor.y)) return []
      const out: RawInteractCandidate[] = []
      for (const d of state.sites) {
        if (Math.hypot(actor.x - d.x, actor.y - d.y) > reach(d)) continue
        const st = sim.progression.ledger.store(d.id)
        if (!st || st.counts.dead || ds(sim.time) < (st.counts.hush ?? 0)) continue
        const primary: InteractAction = { id: "feed", label: "Feed" }
        // The dog comes to the end of its chain towards whoever stands there; the prompt sits on the dog.
        const ang = Math.atan2(actor.y - d.y, actor.x - d.x)
        const k = Math.min(d.chain, Math.max(0, Math.hypot(actor.x - d.x, actor.y - d.y) - 0.7))
        const x = d.x + Math.cos(ang) * k
        const y = d.y + Math.sin(ang) * k
        out.push({ kind: "dog", id: d.id, label: "Dog", rect: [x - 0.35, y - 0.25, x + 0.35, y + 0.25], worldX: x, worldY: y, primary, actions: [primary] })
      }
      return out
    },
    execute: (_town, actor, targetId, action) => {
      const state = of()
      const d = state?.sites.find((s) => s.id === targetId)
      const slot = sim.progression.slotOf(actor)
      if (!state || !d || !slot || action !== "feed" || Math.hypot(actor.x - d.x, actor.y - d.y) > reach(d) + 0.4) return { handled: false }
      const ledger = sim.progression.ledger
      const st = ledger.store(d.id)
      if (!st || st.counts.dead) return { handled: false }
      const res = ledger.apply({ kind: "run", actor: slot.id, rule: "feed:dog" })
      if (!res.ok) {
        sim.progression.notify(slot, "It wants food", "info", "dog")
        return { handled: false }
      }
      st.counts.fed = 1
      st.counts.hush = ds(sim.time + state.tuning.dogHushTime)
      st.counts.bark = 0
      st.rev = ++ledger.rev
      delete state.barks[d.id]
      sim.progression.project(slot)
      return { handled: true, kind: "dog", targetId, action }
    },
  }
}
