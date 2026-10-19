import { distToRect, pushOut, type Rect } from "@arcade/kit/sim/geom"
import type { StoreState } from "@arcade/kit/sim/ledger"
import type { DeathState } from "../death/rules"
import type { OutbreakSimStepSurvivorContext } from "../feature-registry"
import type { InteractAction, InteractionHandler, RawInteractCandidate } from "../interact"
import type { OutbreakSim, Survivor, SurvivorSlot } from "../sim-types"
import { aabbOf, boxOf, CHEM_REFUEL, distToBox, speedOf, VEH_ENTER_SPEED, VEH_REACH, type OutbreakVehicle, type VehicleRefuelRule } from "../vehicles"
import { EVENT_BLOWN, EVENT_CUT, EVENT_HOTWIRED } from "./clues"
import { landmarkRects } from "./landmark"
import { roadblocksOf, ROADBLOCK_WORDS, type Roadblock } from "./roadblocks"
import { planOf, wayOutStore, type WayOutState } from "./runtime"
import { ds, WAY_OUT_STORE } from "./state"
import type { WayOutTuning } from "./tuning"

/**
 * The car project and the roadblocks (AR-64). With the car project on, the gas station pumps are dry and only gas cans
 * fill a tank (poured in when you get in), and a toolbox hotwires a car with no keys. Roadblocks stop cars on the
 * route until dynamite clears them or bolt cutters open a chained gate. Everything every seat sees is in the `wayout`
 * store: `rb:<i>` (1 blown, 2 cut), `rbs:<i>` (seen), and the holds in progress (`hw*`, `cut*`).
 */

/** A hold lapses this long after the last tick E was held at it (s; bridges dropped input ticks). */
const HOLD_GRACE = 0.3
/** A hold's progress is counted in ten-thousandths. */
export const HOLD_FULL = 10000
/** How near the padlock a survivor must stand to cut it (m). */
const CUT_REACH = 1.7
/** A roadblock counts as seen from this near (m). */
const SEEN_RANGE = 45

export const BOLT_CUTTERS = "bolt-cutters"

export const carProjectOn = (t: WayOutTuning) => Boolean(t.wayOut && t.carProject)

/** How tanks are filled while the car project is on: a gas can per pour, into any tank with room; the pumps are dry. */
export function wayOutRefuel(t: WayOutTuning): VehicleRefuelRule {
  if (!carProjectOn(t)) return CHEM_REFUEL
  return { item: "fuel", count: 1, fill: Math.max(1, t.canFill), topUp: true, pumps: false, name: "Gas Can" }
}

/** The roadblocks still standing (none while the way out is off). */
export function standingBlocks(sim: OutbreakSim, t: WayOutTuning): Roadblock[] {
  if (!t.wayOut) return []
  const st = sim.progression.ledger.store(WAY_OUT_STORE)
  return roadblocksOf(planOf(sim, t), t).filter((b) => !st?.counts[`rb:${b.index}`])
}

/** Solid boxes cars hit: the destination's (`landmark.ts`) are added by the caller, the roadblocks here. */
export const blockCarRects = (sim: OutbreakSim, t: WayOutTuning): Rect[] => standingBlocks(sim, t).map((b) => b.car)

/** Pushes a walking survivor out of every standing roadblock near them (through the gap is clear). */
export function pushOutOfBlocks(sim: OutbreakSim, survivor: Survivor, radius: number, t: WayOutTuning): void {
  for (const b of standingBlocks(sim, t)) {
    if (Math.abs(survivor.x - b.x) > 16 || Math.abs(survivor.y - b.y) > 16) continue
    pushOut(survivor, radius, b.walk)
  }
}

/** How near a gas station a stopped car is at its pumps (m, as `shared/vehicles.ts` has it), and how often to say so (s). */
const PUMP_REACH = 6.5
const PUMP_TELL_EVERY = 45

/** A driver stopped at a gas station hears the pumps are dry, so nobody waits for a fill that will not come. */
export function tellPumpsDry(sim: OutbreakSim, state: WayOutState): void {
  if (!carProjectOn(state.tuning)) return
  for (const v of sim.vehicles.list) {
    if (v.wreck || !v.seats[0] || speedOf(v) > 1.2 || v.fuel >= v.maxFuel - 1) continue
    if (sim.time - (state.pumpsToldAt[v.id] ?? -Infinity) < PUMP_TELL_EVERY) continue
    const atPumps = sim.town.buildings.some((b) => (b.archetype ?? b.kind) === "gas_station" && distToRect(v.x, v.y, b.rect) < PUMP_REACH)
    if (!atPumps) continue
    state.pumpsToldAt[v.id] = sim.time
    const driver = sim.slots.find((s) => s.id === v.seats[0])
    if (driver) sim.progression.notify(driver, "The pumps are dry. Gas cans only.", "warning", "vehicle")
  }
}

/** The dead's body radius against the destination's solids and the roadblocks (m, as the nav mesh uses). */
const DEAD_RADIUS = 0.28

/**
 * The dead do not walk through the destination's hull, booth or wall, nor a roadblock: after the crowd steps, any
 * near one is pushed back out (they slide along it, and squeeze through a roadblock's gap as people do).
 */
export function keepDeadOut(sim: OutbreakSim, t: WayOutTuning): void {
  if (!t.wayOut) return
  const plan = planOf(sim, t)
  const landmark = landmarkRects(plan)
  const blocks = standingBlocks(sim, t)
  for (const a of sim.ai.agents) {
    if (a.state === "dead") continue
    if (Math.abs(a.x - plan.x) < 40 && Math.abs(a.y - plan.y) < 40) pushOut(a, DEAD_RADIUS, landmark)
    for (const b of blocks) if (Math.abs(a.x - b.x) < 14 && Math.abs(a.y - b.y) < 14) pushOut(a, DEAD_RADIUS, b.walk)
  }
}

function touch(sim: OutbreakSim, st: StoreState): void {
  st.rev = ++sim.progression.ledger.rev
}

function event(sim: OutbreakSim, st: StoreState, code: number, by?: SurvivorSlot, at?: { x: number; y: number }): void {
  if (at) {
    st.counts.ex = Math.round(at.x * 10)
    st.counts.ey = Math.round(at.y * 10)
  }
  st.counts.last = code
  st.counts.lastAt = Math.max((st.counts.lastAt ?? 0) + 1, ds(sim.time))
  st.counts.lastBy = by ? by.index + 1 : 0
  touch(sim, st)
}

function tell(sim: OutbreakSim, text: string): void {
  for (const s of sim.slots) sim.progression.notify(s, text, "result", "wayout")
}

/** A roadblock is gone: blown (1) or cut (2). */
export function clearBlock(sim: OutbreakSim, state: WayOutState, index: number, how: 1 | 2, by?: SurvivorSlot): boolean {
  const st = wayOutStore(sim, state.tuning)
  if (st.counts[`rb:${index}`]) return false
  st.counts[`rb:${index}`] = how
  st.counts[`rbs:${index}`] = 1
  if (st.counts.cutI === index + 1) st.counts.cut = 0
  const b = roadblocksOf(planOf(sim, state.tuning), state.tuning)[index]
  event(sim, st, how === 1 ? EVENT_BLOWN : EVENT_CUT, by, b ? (how === 2 ? b.lock : b) : undefined)
  tell(sim, how === 1 ? "The roadblock is blown apart. The road is open." : "The chain is cut. The gate swings open.")
  return true
}

/**
 * Once per tick (`stepWorld`): blasts heard this tick clear the roadblocks they reach, roadblocks come into sight,
 * and holds nobody is keeping up lapse. Returns whether a roadblock went, so car collision is rebuilt.
 */
export function stepRoadblocks(sim: OutbreakSim, state: WayOutState): boolean {
  const t = state.tuning
  if (!t.wayOut) return false
  const st = sim.progression.ledger.store(WAY_OUT_STORE)
  const blocks = roadblocksOf(planOf(sim, t), t)
  let changed = false
  const events = sim.ai.noiseBus.events
  let seen = state.blastSeen
  for (const e of events) {
    if (e.id <= state.blastSeen) continue
    seen = Math.max(seen, e.id)
    if (e.kind !== "explosion") continue
    for (const b of blocks) {
      if (st?.counts[`rb:${b.index}`] || distToRect(e.x, e.y, b.car) > t.blastReach) continue
      changed = clearBlock(sim, state, b.index, 1, sim.slots.find((s) => s.id === e.sourceId)) || changed
    }
  }
  state.blastSeen = seen
  for (const b of blocks) {
    if (st?.counts[`rbs:${b.index}`]) continue
    if (sim.slots.some((s) => Math.hypot(s.survivor.x - b.x, s.survivor.y - b.y) <= SEEN_RANGE)) {
      const store = wayOutStore(sim, t)
      store.counts[`rbs:${b.index}`] = 1
      touch(sim, store)
    }
  }
  const store = sim.progression.ledger.store(WAY_OUT_STORE)
  if (store) {
    const now = sim.time
    if (store.counts.hw && now - (store.counts.hwAt ?? 0) / 10 > HOLD_GRACE) {
      store.counts.hw = 0
      touch(sim, store)
    }
    if (store.counts.cut && now - (store.counts.cutAt ?? 0) / 10 > HOLD_GRACE) {
      store.counts.cut = 0
      touch(sim, store)
    }
  }
  return changed
}

const carries = (sim: OutbreakSim, slotId: string, item: string) => sim.progression.ledger.count(slotId, item) > 0

/** A car this survivor could hotwire: no keys in it and none on them, a toolbox in their pack, parked and with a free seat. */
function hotwirable(sim: OutbreakSim, v: OutbreakVehicle, slotId: string): boolean {
  return !v.wreck && !v.hasKeys && speedOf(v) <= VEH_ENTER_SPEED && v.seats.includes("") && carries(sim, slotId, "toolbox") && !carries(sim, slotId, "key")
}

/** E held at a car with a toolbox (`hotwire:<id>`) or at a chained gate with bolt cutters (`gate:<i>`). */
export function stepWayOutHolds(ctx: OutbreakSimStepSurvivorContext<WayOutState>, t: WayOutTuning): { topologyChanged?: boolean } | void {
  const { sim, slot, command, dt, state } = ctx
  if (!t.wayOut || !command.interactHeld || slot.survivor.vehicleId) return
  const death = sim.getFeatureState<DeathState>("death")
  if ((death?.records[slot.index]?.state ?? "alive") !== "alive") return
  const target = slot.prompt
  if (target?.kind === "hotwire" && carProjectOn(t)) {
    const v = sim.vehicles.byId(Number(target.id.slice(8)))
    if (!v || !hotwirable(sim, v, slot.id)) return
    const st = wayOutStore(sim, t)
    if (st.counts.hwV !== v.id) st.counts.hw = 0
    const before = st.counts.hw ?? 0
    st.counts.hwV = v.id
    st.counts.hwAt = ds(sim.time)
    st.counts.hwBy = slot.index + 1
    st.counts.hx = Math.round(v.x * 10)
    st.counts.hy = Math.round(v.y * 10)
    st.counts.hw = Math.min(HOLD_FULL, before + Math.round((dt / Math.max(0.1, t.hotwireTime)) * HOLD_FULL))
    if (Math.floor(st.counts.hw / 2000) !== Math.floor(before / 2000)) sim.ai.emitNoise(v.x, v.y, t.hotwireNoise, "search", sim.time, slot.id, 0.7)
    if (st.counts.hw >= HOLD_FULL) {
      v.hasKeys = true
      v.modified = true
      st.counts.hw = 0
      event(sim, st, EVENT_HOTWIRED, slot, v)
      sim.progression.notify(slot, "Hotwired. It'll start.", "result", "vehicle")
    } else touch(sim, st)
    return
  }
  if (target?.kind === "gate") {
    const index = Number(target.id.slice(5))
    const b = standingBlocks(sim, t).find((x) => x.index === index)
    if (!b || b.kind !== "gate" || !carries(sim, slot.id, BOLT_CUTTERS)) return
    if (Math.hypot(slot.survivor.x - b.lock.x, slot.survivor.y - b.lock.y) > CUT_REACH + 0.4) return
    const st = wayOutStore(sim, t)
    if (st.counts.cutI !== index + 1) st.counts.cut = 0
    const before = st.counts.cut ?? 0
    st.counts.cutI = index + 1
    st.counts.cutAt = ds(sim.time)
    st.counts.hx = Math.round(b.lock.x * 10)
    st.counts.hy = Math.round(b.lock.y * 10)
    st.counts.cut = Math.min(HOLD_FULL, before + Math.round((dt / Math.max(0.1, t.cutTime)) * HOLD_FULL))
    if (Math.floor(st.counts.cut / 2500) !== Math.floor(before / 2500)) sim.ai.emitNoise(b.lock.x, b.lock.y, t.cutNoise, "bash", sim.time, slot.id, 0.6)
    if (st.counts.cut >= HOLD_FULL) return { topologyChanged: clearBlock(sim, state, index, 2, slot) }
    touch(sim, st)
  }
}

/** Hold E at a car with no keys, carrying a toolbox: hotwire it (`stepWayOutHolds` fills it). */
export function hotwireHandler(sim: OutbreakSim, of: () => WayOutState | undefined): InteractionHandler {
  return {
    kind: "hotwire",
    candidates: (_town, actor) => {
      const state = of()
      if (!state || !carProjectOn(state.tuning) || actor.peekingWindowId || (actor as Partial<Survivor>).vehicleId) return []
      const me = sim.progression.slotOf(actor)
      if (!me) return []
      const out: RawInteractCandidate[] = []
      for (const v of sim.vehicles.list) {
        if (Math.abs(v.x - actor.x) > 6 || Math.abs(v.y - actor.y) > 6 || !hotwirable(sim, v, me.id)) continue
        if (distToBox(actor.x, actor.y, boxOf(v, v.spec)) > VEH_REACH) continue
        const primary: InteractAction = { id: "install", label: "Hotwire", hold: true }
        // The car's own prompt has the same box: a hair more priority puts this one in its place, and nothing else's.
        out.push({ kind: "hotwire", id: `hotwire:${v.id}`, label: `${v.spec.label} · No keys`, rect: aabbOf(v, v.spec), worldX: v.x, worldY: v.y, primary, actions: [primary], priority: 0.05 })
      }
      return out
    },
    execute: (_town, _actor, targetId, action) => ({ handled: action === "install", kind: "hotwire", targetId, action }),
  }
}

/** Hold E at a chained gate's padlock, carrying bolt cutters: cut it (`stepWayOutHolds` fills it). */
export function gateHandler(sim: OutbreakSim, of: () => WayOutState | undefined): InteractionHandler {
  return {
    kind: "gate",
    candidates: (_town, actor) => {
      const state = of()
      if (!state?.tuning.wayOut || actor.peekingWindowId) return []
      const me = sim.progression.slotOf(actor)
      if (!me || !carries(sim, me.id, BOLT_CUTTERS)) return []
      const out: RawInteractCandidate[] = []
      for (const b of standingBlocks(sim, state.tuning)) {
        if (b.kind !== "gate" || Math.hypot(actor.x - b.lock.x, actor.y - b.lock.y) > CUT_REACH) continue
        const primary: InteractAction = { id: "disarm", label: "Cut chain", hold: true }
        const { x, y } = b.lock
        out.push({ kind: "gate", id: `gate:${b.index}`, label: ROADBLOCK_WORDS.gate.name, rect: [x - 0.3, y - 0.3, x + 0.3, y + 0.3], worldX: x, worldY: y, primary, actions: [primary], priority: 2 })
      }
      return out
    },
    execute: (_town, _actor, targetId, action) => ({ handled: action === "disarm", kind: "gate", targetId, action }),
  }
}
