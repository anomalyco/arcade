import { registerOutbreakSharedFeature } from "../feature-registry"
import { deathNetSection } from "./net"
import { DEFAULT_DEATH_TUNING, deathTuning, type DeathSnapshot, type DeathState, type DeathTuning } from "./rules"
import { createDeathState, downedHandler, fallenHandler, feedOnDowned, stepDeath, stepDeathMovement, stepReviver } from "./runtime"

/**
 * Death (AR-61): down at 0 HP, revived by a teammate's held E, dead on bleed-out, back at the squad's next dawn, and
 * the run over when everyone is dead. Runs after every other feature so it sees each tick's damage last.
 */
export const outbreakDeathSharedFeature = registerOutbreakSharedFeature<DeathState, DeathSnapshot, DeathTuning, DeathSnapshot>({
  id: "death",
  order: 40,
  tuning: { namespace: "death", defaults: DEFAULT_DEATH_TUNING },
  createState: (sim) => createDeathState(sim.hour),
  registerInteractions: (sim, registry) => {
    const of = () => sim.getFeatureState<DeathState>("death")
    registry.register(downedHandler(sim, of))
    registry.register(fallenHandler(sim, of))
  },
  stepSurvivorMovement: (ctx) => stepDeathMovement(ctx, deathTuning(ctx.resolved.features)),
  stepSurvivorActions: (ctx) => stepReviver(ctx, deathTuning(ctx.resolved.features)),
  modifySurvivorDamage: (_sim, slot, damage, state, source) => {
    if (source === "crowd") feedOnDowned(state, slot, damage)
    return damage
  },
  transformAISurvivor: (_sim, slot, view, state) =>
    state.records[slot.index]?.state === "dead" ? { ...view, visibility: 0, noise: 0, flashlightOn: false } : view,
  refreshPrompt: (_sim, slot, state) => {
    if ((state.records[slot.index]?.state ?? "alive") === "alive") return false
    slot.prompt = undefined
    slot.peek = null
    return true
  },
  stepWorldLate: ({ sim, dt, resolved, state }) => {
    state.tuning = deathTuning(resolved.features)
    stepDeath(sim, state, state.tuning, dt)
  },
  netSection: deathNetSection,
  clientMessages: { restart: () => ({ t: "restart" }) },
})
