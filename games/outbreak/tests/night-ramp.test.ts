import { describe, expect, test } from "bun:test"
import { CoopSim } from "../shared/coop-sim"
import {
  DEFAULT_NIGHT_RAMP_TUNING,
  lateAmmoDrop,
  nightEscalation,
  withNightRampSpecials,
  type NightRampTuning,
} from "../shared/night-ramp/ramp"
import type { NightRampState } from "../shared/night-ramp/runtime"
import { NO_ESCALATION } from "../shared/pacing"
import { DEFAULT_SPECIALS_TUNING, specialChance } from "../shared/specials/kinds"

const T = DEFAULT_NIGHT_RAMP_TUNING
const TODAY: NightRampTuning = { ...T, nightRampMode: 0 }
const BASE = { zombieCount: 16, maxActiveNearPlayer: 3 }

describe("night ramp (D-40 Gentle Start, Rising)", () => {
  test("Today is no escalation, Today's specials and no rounds", () => {
    expect(nightEscalation(TODAY, { night: 3, dark: true }, BASE)).toEqual(NO_ESCALATION)
    expect(withNightRampSpecials(DEFAULT_SPECIALS_TUNING, TODAY)).toBe(DEFAULT_SPECIALS_TUNING)
    for (let id = 1; id < 50; id++) expect(lateAmmoDrop(TODAY, 4, 7, id)).toEqual([])
  })

  test("Night 1 holds chasers and population; Day 2 lets go", () => {
    const n1 = nightEscalation(T, { night: 1, dark: true }, BASE)
    expect(n1.chaserCap).toBe(T.nightOneChasers)
    expect(n1.populationScale).toBe(T.nightOnePopulation)
    expect(nightEscalation(T, { night: 1, dark: false }, BASE)).toEqual(NO_ESCALATION)
  })

  test("every later night adds zombies and chasers up to the ceilings", () => {
    const pop = [2, 3, 4, 5, 6, 8, 12].map((night) => nightEscalation(T, { night, dark: true }, BASE).populationBonus)
    for (let i = 1; i < pop.length; i++) expect(pop[i]!).toBeGreaterThanOrEqual(pop[i - 1]!)
    expect(pop[0]).toBe(T.nightPopulationStep)
    expect(BASE.zombieCount + pop[pop.length - 1]!).toBe(T.nightPopulationCeiling)
    const chasers = nightEscalation(T, { night: 12, dark: true }, BASE).chaserBonus
    expect(BASE.maxActiveNearPlayer + chasers).toBe(T.nightChaserCeiling)
  })

  test("special zombies get likelier each night, up to the night ramp's cap", () => {
    const t = withNightRampSpecials(DEFAULT_SPECIALS_TUNING, T)
    const today = (night: number) => specialChance(DEFAULT_SPECIALS_TUNING, { darkness: 1, night })
    const rising = (night: number) => specialChance(t, { darkness: 1, night })
    expect(rising(4)).toBeGreaterThan(today(4) * 1.5)
    expect(rising(5)).toBeGreaterThan(rising(4))
    expect(rising(20)).toBeCloseTo(T.nightSpecialCap, 6)
  })

  test("from the set night about half the dead carry a few rounds, fixed per zombie", () => {
    expect(lateAmmoDrop(T, T.lateAmmoFromNight - 1, 7, 3)).toEqual([])
    const drops = Array.from({ length: 400 }, (_, id) => lateAmmoDrop(T, T.lateAmmoFromNight, 7, id))
    const carriers = drops.filter((d) => d.length > 0)
    expect(carriers.length / drops.length).toBeGreaterThan(T.lateAmmoChance - 0.1)
    expect(carriers.length / drops.length).toBeLessThan(T.lateAmmoChance + 0.1)
    for (const d of carriers) {
      expect(d[0]!.item).toBe("ammo")
      expect(d[0]!.count).toBeGreaterThanOrEqual(T.lateAmmoMin)
      expect(d[0]!.count).toBeLessThanOrEqual(T.lateAmmoMax)
    }
    expect(lateAmmoDrop(T, 3, 7, 11)).toEqual(lateAmmoDrop(T, 3, 7, 11))
  })

  test("the sim counts nights and hands the director its escalation", () => {
    const sim = new CoopSim(7, 7, 0.22)
    sim.addSurvivor("player", 0)
    sim.stepWorld(1 / 20, 240)
    expect(sim.getFeatureState<NightRampState>("nightRamp")!.night).toBe(1)
    expect(sim.ai.pacing.escalation.chaserCap).toBe(T.nightOneChasers)
    sim.stepWorld(1 / 20, 240, { nightRampMode: 0 } as never)
    expect(sim.ai.pacing.escalation).toEqual(NO_ESCALATION)
  })
})
