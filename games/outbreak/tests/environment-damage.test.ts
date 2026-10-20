import { expect, test } from "bun:test"
import { TICK_DT } from "../shared/clock"
import { CoopSim } from "../shared/coop-sim"
import { specialsOf } from "../shared/specials/specials"
import { wayOutStore } from "../shared/way-out/runtime"
import { DEFAULT_WAY_OUT_TUNING } from "../shared/way-out/tuning"

function gassed(): CoopSim {
  const sim = new CoopSim(7, 7, 0.22, { zombieCount: 0, directorPacing: 0, startHour: 23 })
  sim.addSurvivor("player", 0)
  sim.ai.agents.length = 0
  const p = sim.slots[0]!.survivor
  Object.assign(p, { x: 45, y: 46, health: 100, stamina: 1 })
  specialsOf(sim).clouds.push({ id: 1, x: p.x, y: p.y, born: sim.time, until: sim.time + 10, radius: 3 })
  return sim
}

test("bloater gas hurts a survivor who has not escaped", () => {
  const sim = gassed()
  sim.stepWorld(TICK_DT, 1)
  expect(sim.slots[0]!.survivor.health).toBeLessThan(100)
})

test("bloater gas cannot hurt a survivor who escaped the Way Out", () => {
  const sim = gassed()
  wayOutStore(sim, DEFAULT_WAY_OUT_TUNING).counts.won = 1
  sim.stepWorld(TICK_DT, 1)
  expect(sim.slots[0]!.survivor.health).toBe(100)
})
