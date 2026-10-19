import { pushOut } from "@arcade/kit/sim/geom"
import { registerOutbreakSharedFeature } from "../feature-registry"
import { landmarkRects } from "./landmark"
import { clueHandler, createWayOutState, planOf, runWon, signalHandler, stepWayOut, type WayOutState } from "./runtime"
import { DEFAULT_WAY_OUT_TUNING, wayOutTuning, type WayOutTuning } from "./tuning"

/**
 * The Way Out (AR-64): a far-off place to escape from, found through clues, reached across the overworld, signalled
 * and held until dawn. What every seat sees is the `wayout` ledger store (`state.ts`), so it adds nothing to the wire.
 * Runs after death so it sees each tick's downs and kills. Off (Lab › Way Out) is endless survival.
 */
export const outbreakWayOutSharedFeature = registerOutbreakSharedFeature<WayOutState, undefined, WayOutTuning>({
  id: "wayOut",
  order: 45,
  tuning: { namespace: "wayOut", defaults: DEFAULT_WAY_OUT_TUNING },
  createState: (sim) => createWayOutState(sim),
  registerInteractions: (sim, registry) => {
    const of = () => sim.getFeatureState<WayOutState>("wayOut")
    registry.register(clueHandler(sim, of))
    registry.register(signalHandler(sim, of))
  },
  // The destination's hull, booth, hangar or wall stops survivors and cars (appended after the vehicles feature's rebuild).
  onChunkSync: (sim, state) => {
    if (state.tuning.wayOut) sim.vehicleSolids.push(...landmarkRects(planOf(sim, state.tuning)))
  },
  onTopologyChanged: (sim, state) => {
    if (state.tuning.wayOut) sim.vehicleSolids.push(...landmarkRects(planOf(sim, state.tuning)))
  },
  pushOutSurvivor: (sim, survivor, radius, state) => {
    if (!state.tuning.wayOut) return
    const plan = planOf(sim, state.tuning)
    if (Math.abs(survivor.x - plan.x) > 40 || Math.abs(survivor.y - plan.y) > 40) return
    pushOut(survivor, radius, landmarkRects(plan))
  },
  // Once out, the escaped stand still, unseen and unhurt, while the card is up.
  stepSurvivorMovement: ({ sim, slot }) => {
    if (!runWon(sim)) return false
    Object.assign(slot.survivor, { vx: 0, vy: 0, noise: 0 })
    return true
  },
  transformAISurvivor: (sim, _slot, view) => (runWon(sim) ? { ...view, visibility: 0, noise: 0, flashlightOn: false } : view),
  modifySurvivorDamage: (sim, _slot, damage) => (runWon(sim) ? 0 : damage),
  refreshPrompt: (sim, slot) => {
    if (!runWon(sim)) return false
    slot.prompt = undefined
    slot.peek = null
    return true
  },
  stepWorldLate: ({ sim, resolved, state }) => {
    state.tuning = wayOutTuning(resolved.features)
    stepWayOut(sim, state)
  },
})
