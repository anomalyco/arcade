import { describe, expect, test } from "bun:test"
import { TICK_DT } from "../shared/clock"
import { cloneSimState, CoopSim, diffSimState, forkSimState, hashSimState, stepSim, type SimState } from "../shared/coop-sim"
import type { Command } from "../shared/session"

const cmd = (tick: number, i: number): Command => ({
  mx: Math.cos(tick / 50 + i),
  my: Math.sin(tick / 70 + i),
  aim: tick / 30,
  interact: tick % 40 === 3 + i,
  sprint: tick % 120 < 40,
  fire: tick % 25 === 7 + i,
})
const inputs = (tick: number) => [cmd(tick, 0), cmd(tick, 1)]

function start(): SimState {
  const sim = new CoopSim(7, 7, 0.22)
  sim.addSurvivor("player", 0)
  sim.addSurvivor("p1", 1)
  return sim.toSnapshot()
}

/** What `stepSim` did before it kept sims alive: restore into a fresh sim every tick. */
function freshStep(state: SimState, cmds: Command[]): SimState {
  const sim = CoopSim.fromSnapshot(state)
  sim.slots.forEach((slot, i) => sim.stepSurvivor(slot, cmds[i]!, TICK_DT))
  sim.stepWorld(TICK_DT, 240)
  return sim.toSnapshot()
}

describe("stepSim", () => {
  test("chained calls match restoring a fresh sim every tick, rewind history included", () => {
    let a = start()
    let b = start()
    for (let t = 0; t < 90; t++) {
      a = stepSim(a, inputs(t), TICK_DT)
      b = freshStep(b, inputs(t))
      expect(diffSimState(a, b)).toEqual([])
    }
    expect(a.rewind!.length).toBe(24)
  })

  test("never mutates its input, and honours a returned state the caller edited", () => {
    const s1 = stepSim(start(), inputs(0), TICK_DT)
    const before = cloneSimState(s1)
    const s2 = stepSim(s1, inputs(1), TICK_DT)
    expect(diffSimState(s1, before)).toEqual([])
    // s1 was consumed by the live sim; stepping it again restores fresh and agrees.
    expect(diffSimState(stepSim(s1, inputs(1), TICK_DT), s2)).toEqual([])

    const s3 = stepSim(s2, inputs(2), TICK_DT)
    s3.slots[0]!.survivor.x += 3
    s3.slots[1]!.survivor.health = -Infinity
    const edited = cloneSimState(s3)
    expect(diffSimState(stepSim(s3, inputs(3), TICK_DT), freshStep(edited, inputs(3)))).toEqual([])
  })

  test("interleaved forks don't share a sim", () => {
    let base = start()
    for (let t = 0; t < 30; t++) base = stepSim(base, inputs(t), TICK_DT)
    let a = forkSimState(base, { rolloutSeed: 1 })
    let b = forkSimState(base, { rolloutSeed: 2 })
    let refA = cloneSimState(a)
    let refB = cloneSimState(b)
    for (let t = 30; t < 90; t++) {
      a = stepSim(a, inputs(t), TICK_DT)
      b = stepSim(b, [cmd(t + 5, 0), cmd(t + 9, 1)], TICK_DT)
      refA = freshStep(refA, inputs(t))
      refB = freshStep(refB, [cmd(t + 5, 0), cmd(t + 9, 1)])
    }
    expect(diffSimState(a, refA)).toEqual([])
    expect(diffSimState(b, refB)).toEqual([])
    expect(hashSimState(a)).not.toBe(hashSimState(b))
  })

  test("a restored sim keeps lag-compensation history for rewound shots", () => {
    const sim = new CoopSim(7, 7, 0.22)
    sim.addSurvivor("player", 0)
    for (let t = 0; t < 60; t++) {
      sim.stepSurvivor(sim.slots[0]!, cmd(t, 0), TICK_DT)
      sim.stepWorld(TICK_DT, 240)
    }
    const restored = CoopSim.fromSnapshot(cloneSimState(sim.toSnapshot()))
    const viewTime = sim.time - 0.15
    expect(restored.rewind.snapshot()).toEqual(sim.rewind.snapshot())
    expect(restored.rewind.sampleAtTime(viewTime)).toEqual(sim.rewind.sampleAtTime(viewTime))
    const shot: Command = { mx: 0, my: 0, aim: 0.4, interact: false, fire: true }
    sim.stepSurvivor(sim.slots[0]!, shot, TICK_DT, undefined, false, viewTime)
    restored.stepSurvivor(restored.slots[0]!, shot, TICK_DT, undefined, false, viewTime)
    expect(diffSimState(restored.toSnapshot(), sim.toSnapshot())).toEqual([])
  })

  test("hashSimState digests the world without the rewind history", () => {
    const s = stepSim(start(), inputs(0), TICK_DT)
    expect(s.rewind!.length).toBeGreaterThan(0)
    expect(hashSimState({ ...s, rewind: [] })).toBe(hashSimState(s))
    expect(diffSimState({ ...s, rewind: [] }, s).length).toBeGreaterThan(0)
  })
})
