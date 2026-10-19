import { dayCycle } from "../day-cycle"
import type { OutbreakSim } from "../sim-types"
import { lateAmmoDrop, lateAmmoDropId, nightEscalation, type NightRampTuning } from "./ramp"

/** Night count, and the dead already looked at for rounds. Plain JSON. */
export type NightRampState = { night: number; wasDark: boolean; dead: Record<number, 1> }

export function createNightRampState(hour: number): NightRampState {
  const dark = dayCycle(hour).darkness >= 0.5
  return { night: dark ? 1 : 0, wasDark: dark, dead: {} }
}

/** Counts nights and hands the director this tick's escalation (before the crowd steps). */
export function stepNightRamp(sim: OutbreakSim, state: NightRampState, t: NightRampTuning): void {
  const dark = dayCycle(sim.hour).darkness >= 0.5
  if (dark && !state.wasDark) state.night++
  state.wasDark = dark
  sim.ai.pacing.escalation = nightEscalation(t, { night: state.night, dark }, sim.ai.config)
}

/** After the crowd steps: the dead that fell this tick may leave a few rounds where they lie. */
export function stepNightRampLate(sim: OutbreakSim, state: NightRampState, t: NightRampTuning): void {
  const ledger = sim.progression.ledger
  for (const z of sim.ai.agents) {
    if (z.state !== "dead" || state.dead[z.id]) continue
    state.dead[z.id] = 1
    const initial = lateAmmoDrop(t, state.night, sim.town.seed, z.id)
    const id = lateAmmoDropId(z.id)
    if (initial.length === 0 || ledger.store(id)) continue
    ledger.createStore({ id, mode: "slots", scope: "shared", size: 1, at: { x: z.x, y: z.y }, initial })
  }
  const tracked = Object.keys(state.dead)
  if (tracked.length > sim.ai.agents.length) {
    const live = new Set(sim.ai.agents.map((z) => z.id))
    for (const id of tracked) if (!live.has(Number(id))) delete state.dead[Number(id)]
  }
}
