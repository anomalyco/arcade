import { distToRect } from "@arcade/kit/sim/geom"
import type { InteractAction, InteractionHandler, RawInteractCandidate } from "../interact"
import { INTERACT_RANGE } from "../interact"
import { buildingAt } from "../progression/loot"
import type { OutbreakSim } from "../sim-types"
import {
  DEFAULT_RADIO_TUNING,
  ds,
  RADIO_KNOCK_NOISE,
  radioSites,
  radioState,
  type RadioSite,
  type RadioTuning,
} from "./radios"

/** Per-sim radio state: only the sites in the world now (the radios' own state is in the ledger). */
export type RadiosState = { sites: RadioSite[]; key: string; tuning: RadioTuning }

export function createRadiosState(sim: OutbreakSim): RadiosState {
  const state: RadiosState = { sites: [], key: "", tuning: DEFAULT_RADIO_TUNING }
  syncRadioSites(sim, state)
  return state
}

/** Re-finds the radios when buildings stream in or out. */
export function syncRadioSites(sim: OutbreakSim, state: RadiosState): void {
  const town = sim.town
  const key = `${town.buildings.length}:${town.props.length}:${town.buildings[0]?.id ?? ""}:${town.buildings.at(-1)?.id ?? ""}`
  if (key === state.key) return
  state.key = key
  state.sites = radioSites(town)
}

export function radioTuning(features: Readonly<Record<string, Record<string, unknown>>> | undefined): RadioTuning {
  return (features?.radios as RadioTuning | undefined) ?? DEFAULT_RADIO_TUNING
}

/**
 * E at a radio: switch it on, or off again. A dead or broken radio offers nothing. The state is looked up on each call,
 * because a fork or a restored snapshot replaces the sim's feature states.
 */
export function radioHandler(sim: OutbreakSim, id: string): InteractionHandler {
  const of = () => sim.getFeatureState<RadiosState>(id)
  return {
    kind: "radio",
    candidates: (town, actor) => {
      const state = of()
      if (!state || actor.peekingWindowId) return []
      const here = buildingAt(town, actor.x, actor.y)?.id ?? null
      const out: RawInteractCandidate[] = []
      for (const site of state.sites) {
        if (site.buildingId !== here || distToRect(actor.x, actor.y, site.rect) > 1.4) continue
        const st = sim.progression.ledger.store(site.id)
        const now = radioState(st, sim.time)
        if (now === "dead" || now === "broken") continue
        const playing = now === "playing"
        const primary: InteractAction = { id: "toggle", label: playing ? "Switch off" : "Switch on" }
        // Small and on a table: it wins over the table and whatever is near it, as a page does.
        out.push({ kind: "radio", id: site.id, label: "Radio", rect: site.rect, worldX: site.x, worldY: site.y, primary, actions: [primary], priority: 3 })
      }
      return out
    },
    execute: (_town, actor, targetId, action) => {
      const state = of()
      const site = state?.sites.find((s) => s.id === targetId)
      if (!site || action !== "toggle" || distToRect(actor.x, actor.y, site.rect) > INTERACT_RANGE) return { handled: false }
      const owner = sim.slots.find((s) => s.survivor === actor)?.id
      if (!switchRadio(sim, site, sim.time, state!.tuning.radioBattery, owner)) return { handled: false }
      // The switch's click; the radio itself is heard from where it stands (`stepRadios`).
      return { handled: true, kind: "radio", targetId, action, noise: 1.5, noiseKind: "radio" }
    },
  }
}

/**
 * Switches a radio on (with what is left of its battery; `battery` seconds if nobody has touched it) or off. False
 * when it is dead or broken.
 */
export function switchRadio(sim: OutbreakSim, site: RadioSite, time: number, battery: number, owner?: string): boolean {
  const ledger = sim.progression.ledger
  let st = ledger.store(site.id)
  const now = radioState(st, time)
  if (now === "dead" || now === "broken") return false
  if (!st) st = ledger.createStore({ id: site.id, mode: "counters", scope: "shared", owner, at: { x: site.x, y: site.y }, initial: { on: 0, left: ds(battery) } })
  const t = ds(time)
  if (now === "playing") {
    st.counts.left = Math.max(0, (st.counts.until ?? 0) - t)
    st.counts.on = 0
    st.counts.near = 0
  } else {
    st.counts.on = 1
    // Never 0, so a store's `start` always reads as "it has been switched on".
    st.counts.start = Math.max(1, t)
    st.counts.until = t + (st.counts.left ?? 0)
    st.counts.near = 0
    st.counts.beats = 0
    if (owner) st.owner = owner
  }
  st.rev = ++ledger.rev
  return true
}

/**
 * Once per tick: a playing radio calls the dead on its beat until the battery is flat; one of the dead standing at it
 * long enough knocks it to the floor, which ends it for good.
 */
export function stepRadios(sim: OutbreakSim, state: RadiosState, dt: number, tuning: RadioTuning): void {
  const ledger = sim.progression.ledger
  const time = sim.time
  const t = ds(time)
  for (const site of state.sites) {
    const st = ledger.store(site.id)
    if (!st || !st.counts.on || st.counts.broken) continue
    const until = st.counts.until ?? 0
    if (t >= until) {
      st.counts.on = 0
      st.counts.left = 0
      st.counts.near = 0
      st.rev = ++ledger.rev
      continue
    }
    // A burst as it comes on and one on every beat after; `beats` counts them, so none is missed or doubled.
    const due = Math.floor(Math.max(0, time - (st.counts.start ?? 0) / 10) / tuning.radioBeat) + 1
    if ((st.counts.beats ?? 0) < due) {
      st.counts.beats = due
      st.rev = ++ledger.rev
      sim.ai.emitNoise(site.x, site.y, tuning.radioNoise, "radio", time, "radio", 1.6)
    }

    let near = false
    for (const z of sim.ai.agents) {
      if (z.state === "dead") continue
      if (Math.hypot(z.x - site.x, z.y - site.y) <= tuning.radioReach) {
        near = true
        break
      }
    }
    if (near && !st.counts.near) {
      st.counts.near = Math.max(1, t)
      st.rev = ++ledger.rev
    } else if (!near && st.counts.near) {
      st.counts.near = 0
      st.rev = ++ledger.rev
    } else if (near && t - (st.counts.near ?? t) >= ds(tuning.radioBreakTime)) {
      st.counts.broken = 1
      st.counts.on = 0
      st.counts.left = Math.max(0, until - t)
      st.rev = ++ledger.rev
      sim.ai.emitNoise(site.x, site.y, RADIO_KNOCK_NOISE, "bash", time, "radio", 0.8)
    }
  }
}
