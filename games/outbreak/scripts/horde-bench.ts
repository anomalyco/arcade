// Horde CPU benchmark and determinism check: one survivor walking a street loop among N zombies, two thirds of them
// hunting, with a gunshot every 2 s. Measures the full shared tick (stepSurvivor + stepWorld) and the crowd step alone.
//
// Usage (via the fleet): hivemind run --kind browser -- bun scripts/horde-bench.ts [--zombies=28,150,500,1000] [--seconds=6]
//   [--json=out.json] [--label=after]
import { writeFileSync } from "node:fs"
import { Rng } from "@arcade/kit/sim/rng"
import { createAIAgent } from "../shared/ai"
import { TICK_DT } from "../shared/clock"
import { CoopSim, hashSimState } from "../shared/coop-sim"
import { PISTOL_NOISE } from "../shared/combat"
import type { Command } from "../shared/session"

const arg = (name: string, fallback: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback

const counts = arg("zombies", "28,150,500,1000").split(",").map(Number)
const seconds = Number(arg("seconds", "6"))
const label = arg("label", "current")
const jsonOut = arg("json", "")
const flowFields = Number(arg("flow", "1"))

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0
const r3 = (v: number) => Math.round(v * 1000) / 1000

/** A seeded street horde: two thirds chase the survivor, the rest wander. */
export function hordeSim(count: number, seed = 7, flowFields = 1): CoopSim {
  const sim = new CoopSim(seed, seed, 0.22, { zombieCount: count, directorPacing: 0, startHour: 23, flowFields })
  sim.addSurvivor("player", 0)
  sim.ai.agents.length = 0
  const rng = new Rng(0x5eed ^ count)
  const p = sim.slots[0]!.survivor
  for (let id = 1; sim.ai.agents.length < count; id++) {
    const x = rng.range(3, 93)
    const y = rng.range(3, 93)
    if (Math.hypot(x - p.x, y - p.y) < 12 || !sim.ai.nav.walkable({ x, y })) continue
    const a = createAIAgent(id, sim.town.seed, x, y)
    if (id % 3 !== 0) {
      a.state = "chase"
      a.awareness = 1
      a.targetX = p.x
      a.targetY = p.y
    }
    sim.ai.agents.push(a)
  }
  return sim
}

export function hordeCommand(tick: number): Command {
  const phase = tick / 140
  return { mx: Math.cos(phase), my: Math.sin(phase), aim: phase, interact: false, sprint: tick % 300 < 90 }
}

export function stepHorde(sim: CoopSim, tick: number): void {
  const slot = sim.slots[0]!
  slot.survivor.health = slot.survivor.maxHealth
  sim.stepSurvivor(slot, hordeCommand(tick), TICK_DT)
  if (tick % 120 === 60) {
    sim.ai.emitNoise(slot.survivor.x, slot.survivor.y, PISTOL_NOISE, "gunshot", sim.time, slot.id, 2.2)
  }
  sim.stepWorld(TICK_DT, 240)
}

function run(count: number) {
  const sim = hordeSim(count, 7, flowFields)
  const ticks = Math.round(seconds / TICK_DT)
  const tickMs: number[] = []
  const shotMs: number[] = []
  const ai = sim.ai
  const crowdMs: number[] = []
  const stepSurvivors = ai.stepSurvivors.bind(ai)
  ai.stepSurvivors = (...args: Parameters<typeof ai.stepSurvivors>) => {
    const t0 = performance.now()
    const res = stepSurvivors(...args)
    crowdMs.push(performance.now() - t0)
    return res
  }
  let midState = ""
  let mid: ReturnType<CoopSim["toSnapshot"]> | undefined
  // Stuck share: hunters (chase/investigate, more than 2.5 m from the survivor) that moved under 0.4 m in a second.
  const lastPos = new Map<number, [number, number]>()
  let stuckSamples = 0
  let huntSamples = 0
  for (let t = 0; t < ticks; t++) {
    if (t % 60 === 0) {
      const p = sim.slots[0]!.survivor
      for (const a of sim.ai.agents) {
        const prev = lastPos.get(a.id)
        lastPos.set(a.id, [a.x, a.y])
        if (!prev || t === 0) continue
        if (a.state !== "chase" && a.state !== "investigate") continue
        if (Math.hypot(a.x - p.x, a.y - p.y) < 2.5) continue
        huntSamples++
        if (Math.hypot(a.x - prev[0], a.y - prev[1]) < 0.4) stuckSamples++
      }
    }
    if (t === ticks >> 1) {
      mid = sim.toSnapshot()
      midState = hashSimState(mid)
    }
    const t0 = performance.now()
    stepHorde(sim, t)
    const dt = performance.now() - t0
    tickMs.push(dt)
    if (t % 120 === 60 || t % 120 === 61) shotMs.push(dt)
  }
  const endHash = hashSimState(sim.toSnapshot())

  // Restore the mid-run snapshot into a fresh sim and replay: the end state must hash identically.
  const replay = CoopSim.fromSnapshot(mid!)
  for (let t = ticks >> 1; t < ticks; t++) stepHorde(replay, t)
  const replayHash = hashSimState(replay.toSnapshot())

  const sorted = [...tickMs].sort((a, b) => a - b)
  const crowd = [...crowdMs].sort((a, b) => a - b)
  const states: Record<string, number> = {}
  for (const a of sim.ai.agents) states[a.state] = (states[a.state] ?? 0) + 1
  return {
    zombies: count,
    tickMs: { p50: r3(pct(sorted, 0.5)), p95: r3(pct(sorted, 0.95)), p99: r3(pct(sorted, 0.99)), max: r3(pct(sorted, 1)) },
    crowdMs: { p50: r3(pct(crowd, 0.5)), p95: r3(pct(crowd, 0.95)), max: r3(pct(crowd, 1)) },
    gunshotTickMs: r3(Math.max(...shotMs)),
    stuckShare: r3(stuckSamples / Math.max(1, huntSamples)),
    within5m: sim.ai.agents.filter((a) => {
      const p = sim.slots[0]!.survivor
      return a.state !== "dead" && Math.hypot(a.x - p.x, a.y - p.y) < 5
    }).length,
    flow: { builds: sim.ai.flow.builds, hits: sim.ai.flow.hits, deferred: sim.ai.flow.deferred },
    states,
    midHash: midState,
    endHash,
    replayMatches: replayHash === endHash,
  }
}

const results = import.meta.main ? counts.map(run) : []
if (import.meta.main) console.log(JSON.stringify({ label, flowFields, seconds, results }, null, 2))
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ label, flowFields, seconds, results }, null, 2))
