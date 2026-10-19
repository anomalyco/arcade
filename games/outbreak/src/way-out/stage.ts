import { radioStoreId, ds as rds } from "../../shared/radios/radios"
import type { RadiosState } from "../../shared/radios/runtime"
import type { BodiesState } from "../../shared/bodies/runtime"
import type { CoopSim } from "../../shared/coop-sim"
import type { WayOutTuning } from "../../shared/way-out/tuning"
import { broadcastOn, carriesFlyer } from "../../shared/way-out/clues"
import { arrivalHeading } from "../../shared/way-out/landmark"
import { clueSites, evacuate, nearDawnHour, planOf, revealTo, seedOf, signalEvac, type WayOutState } from "../../shared/way-out/runtime"
import { roadblocksOf } from "../../shared/way-out/roadblocks"
import { WAY_OUT_STORE } from "../../shared/way-out/state"
import type { DiscoveryHost } from "../discovery/stage"

/**
 * Lab views of The Way Out (station `outbreak-way-out`), each staged on the offline session:
 * - `radio`: a house radio playing while a broadcast is on, the survivor beside it (the rumour comes as it plays).
 * - `note` / `flyer`: beside a home's note, or kneeling at a body that carries a flyer (search it).
 * - `police-map`: in the police station a block south of town, at the torn map piece.
 * - `road-sign` / `soldier`: at the sign and the dead soldier along the route.
 * - `car-repair`: by day beside a car with no keys and an empty tank, carrying a toolbox and two gas cans (hold E to
 *   hotwire it, then get in to pour them in).
 * - `roadblock`: at night before the route's first roadblock, carrying bolt cutters and dynamite, a car behind you.
 * - `destination`: at the destination at night, confirmed, before the signal.
 * - `final-stand`: signalled, the siege on, an hour before dawn, armed.
 * - `escape-card`: the squad got out; the card.
 */
export const WAY_OUT_SCENES = ["radio", "note", "flyer", "police-map", "road-sign", "soldier", "car-repair", "roadblock", "destination", "final-stand", "escape-card"] as const
export type WayOutScene = (typeof WAY_OUT_SCENES)[number]

export type WayOutStageSession = { sim: CoopSim }

const stateOf = (sim: CoopSim) => sim.getFeatureState<WayOutState>("wayOut")!

/** Clears the run's way-out progress (the store goes; the next tick makes a fresh one). */
export function resetWayOut(sim: CoopSim): void {
  const ledger = sim.progression.ledger
  if (ledger.store(WAY_OUT_STORE)) ledger.deleteStore(WAY_OUT_STORE)
  const st = stateOf(sim)
  st.siege = []
}

/** Grants items to the local survivor (what does not fit is dropped by the ledger as usual). */
export function giveAll(sim: CoopSim, actor: string, items: readonly (readonly [string, number])[]): void {
  for (const [item, count] of items) sim.progression.ledger.apply({ kind: "grant", actor, item, count })
  const slot = sim.slots.find((s) => s.id === actor)
  if (slot) sim.progression.project(slot)
}

/** Everything the car project and the roadblocks ask for. */
export const CAR_PARTS: readonly (readonly [string, number])[] = [
  ["toolbox", 1],
  ["car-battery", 1],
  ["bolt-cutters", 1],
  ["fuel", 3],
  ["dynamite", 2],
]

function clearDead(sim: CoopSim): void {
  for (const z of sim.ai.agents) z.state = "dead"
}

/** Moves the local survivor to a place along or beside the plan, facing the way given. */
export function teleportTo(host: DiscoveryHost, sim: CoopSim, to: "destination" | "sign" | "soldier" | "police" | "signal" | "roadblock", tuning: WayOutTuning): { x: number; y: number } {
  const plan = planOf(sim, tuning)
  const h = arrivalHeading(plan.arrival)
  let x = plan.x - Math.cos(h) * 20
  let y = plan.y - Math.sin(h) * 20
  let aim = h
  if (to === "signal") {
    x = plan.signal.x - Math.cos(h) * 1.2
    y = plan.signal.y - Math.sin(h) * 1.2
  } else if (to === "sign" || to === "soldier") {
    const spot = to === "sign" ? plan.sign : plan.soldier
    x = spot.x + Math.cos(spot.yaw) * 1.3
    y = spot.y + Math.sin(spot.yaw) * 1.3
    aim = spot.yaw + Math.PI
  } else if (to === "roadblock") {
    // 14 m short of the first roadblock, on the town side, facing it.
    const b = roadblocksOf(plan, tuning)[0]
    if (!b) return teleportTo(host, sim, "sign", tuning)
    x = b.x - b.dx * 14
    y = b.y - b.dy * 14
    aim = Math.atan2(b.dy, b.dx)
  } else if (to === "police") {
    // The police station in block (0, 1): stream it in, then stand at its map piece.
    host.pose(48, 112, Math.PI / 2)
    const site = clueSites(sim, stateOf(sim), plan).find((s) => s.kind === "police")
    if (site) {
      x = site.x
      y = site.y + 0.8
      aim = -Math.PI / 2
    }
  }
  host.pose(x, y, aim)
  return { x, y }
}

/** Stages a view; returns where the survivor stands. */
export function stageWayOut(host: DiscoveryHost, session: WayOutStageSession, scene: WayOutScene, tuning: WayOutTuning): { x: number; y: number } {
  const sim = session.sim
  const ledger = sim.progression.ledger
  const view = host.view()
  resetWayOut(sim)
  clearDead(sim)
  const state = stateOf(sim)
  state.tuning = tuning
  switch (scene) {
    case "radio": {
      host.setHour(20.1)
      let hour = 20.1
      for (let h = 20; h < 23; h += 0.05) if (broadcastOn(h, tuning.broadcastEvery, tuning.broadcastLength)) { hour = h + 0.02; break }
      host.setHour(hour)
      const r = sim.getFeatureState<RadiosState>("radios")?.sites[0]
      if (!r) return teleportTo(host, sim, "sign", tuning)
      if (!ledger.store(radioStoreId(r.buildingId))) ledger.createStore({ id: radioStoreId(r.buildingId), mode: "counters", scope: "shared", initial: {} })
      const st = ledger.store(radioStoreId(r.buildingId))!
      st.counts = { on: 1, start: rds(sim.time), until: rds(sim.time + 120) }
      st.rev = ++ledger.rev
      host.pose(r.x + 0.9, r.y + 0.9, Math.atan2(-0.9, -0.9))
      return { x: r.x + 0.9, y: r.y + 0.9 }
    }
    case "note": {
      host.setHour(21)
      const note = clueSites(sim, state, planOf(sim, tuning)).find((s) => s.kind === "note")
      if (!note) return teleportTo(host, sim, "sign", tuning)
      host.pose(note.x, note.y + 0.75, -Math.PI / 2)
      return { x: note.x, y: note.y + 0.75 }
    }
    case "flyer": {
      host.setHour(21)
      const seed = seedOf(sim)
      const sites = sim.getFeatureState<BodiesState>("bodies")?.sites ?? []
      const body = sites.find((b) => !b.vignette && carriesFlyer(seed, b.key, tuning.flyerShare)) ?? sites.find((b) => carriesFlyer(seed, b.key, tuning.flyerShare))
      if (!body) return teleportTo(host, sim, "sign", tuning)
      const st = ledger.store(body.id)
      if (st) {
        st.revealed = false
        delete st.counts.rise
        st.rev = ++ledger.rev
      }
      host.pose(body.x, body.y + 0.85, -Math.PI / 2)
      return { x: body.x, y: body.y + 0.85 }
    }
    case "police-map":
      host.setHour(21)
      return teleportTo(host, sim, "police", tuning)
    case "road-sign":
      host.setHour(19.5)
      revealTo(sim, state, 1)
      return teleportTo(host, sim, "sign", tuning)
    case "soldier":
      host.setHour(22)
      revealTo(sim, state, 2)
      return teleportTo(host, sim, "soldier", tuning)
    case "car-repair": {
      host.setHour(10)
      revealTo(sim, state, 2)
      // On the road a block south of the town's crossroads, clear of the cars parked there.
      const at = { x: 41.8, y: 70 }
      sim.vehicles.spawnVehicle("sedan", 44, 70, Math.PI / 2, { fuel: 0, hasKeys: false, hasBattery: true })
      giveAll(sim, view.actorId, [["toolbox", 1], ["fuel", 2]])
      host.pose(at.x, at.y, 0)
      return at
    }
    case "roadblock": {
      host.setHour(22)
      revealTo(sim, state, 3)
      const at = teleportTo(host, sim, "roadblock", tuning)
      const b = roadblocksOf(planOf(sim, tuning), tuning)[0]
      if (b) sim.vehicles.spawnVehicle("sedan", b.x - b.dx * 22, b.y - b.dy * 22, Math.atan2(b.dy, b.dx), { fuel: 70 })
      giveAll(sim, view.actorId, [["bolt-cutters", 1], ["dynamite", 2]])
      return at
    }
    case "destination":
      host.setHour(23)
      revealTo(sim, state, 3)
      return teleportTo(host, sim, "destination", tuning)
    case "final-stand": {
      host.setHour(nearDawnHour() - 1)
      revealTo(sim, state, 3)
      const at = teleportTo(host, sim, "signal", tuning)
      ledger.apply({ kind: "grant", actor: view.actorId, item: "ammo", count: 24 })
      signalEvac(sim, state, sim.slots[0])
      return at
    }
    case "escape-card": {
      host.setHour(nearDawnHour() + 0.2)
      revealTo(sim, state, 3)
      const at = teleportTo(host, sim, "signal", tuning)
      evacuate(sim, state)
      return at
    }
  }
}
