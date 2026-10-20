import { dayCycle } from "../day-cycle"
import type { OutbreakSim } from "../sim-types"
import { coopCurve } from "./coop"
import { cacheRoll, lateAmmoActive, lateAmmoCount, lateAmmoDrop, lateAmmoDropId, nightEscalation, type NightRampTuning } from "./ramp"

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
  if (!dark && state.wasDark && lateAmmoActive(t, state.night)) leaveDawnCaches(sim, state.night, t)
  state.wasDark = dark
  sim.ai.pacing.escalation = nightEscalation(t, { night: state.night, dark }, sim.ai.config)
  sim.ai.pacing.coop = coopCurve(t)
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

/** At dawn: a few containers someone already searched and emptied hold a few rounds again. */
function leaveDawnCaches(sim: OutbreakSim, night: number, t: NightRampTuning): void {
  const count = Math.max(0, Math.round(t.dawnAmmoCaches))
  if (count === 0) return
  const ledger = sim.progression.ledger
  const picks = [...ledger.stores.values()]
    .filter((st) => st.id.startsWith("loot:") && st.revealed && ledger.count(st.id, "ammo") === 0)
    .map((st) => ({ id: st.id, roll: cacheRoll(sim.town.seed, night, st.id) }))
    .sort((a, b) => a.roll - b.roll || (a.id < b.id ? -1 : 1))
    .slice(0, count)
  for (const pick of picks) {
    ledger.apply({ kind: "grant", actor: "world", item: "ammo", count: lateAmmoCount(t, pick.roll), store: pick.id })
  }
}
