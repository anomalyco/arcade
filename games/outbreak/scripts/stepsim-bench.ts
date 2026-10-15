// Pure `stepSim(state, inputs, dt)` benchmark and determinism trace. Steps scripted survivors through the town three
// ways (the pure transition chained tick to tick, the mutable `CoopSim` in place, and forked pure rollouts) and checks
// they agree hash for hash. The per-tick hash trace excludes `rewind` so traces stay comparable with states recorded
// before lag-compensation history joined `SimState`.
//
// Usage: hivemind run --kind browser -- bun scripts/stepsim-bench.ts [--ticks=600] [--json=out.json]
//   [--golden=trace.json] (fail when any per-tick hash differs from a trace written by an earlier run)
import { readFileSync, writeFileSync } from "node:fs"
import { Rng } from "@arcade/kit/sim/rng"
import { createAIAgent } from "../shared/ai"
import { TICK_DT } from "../shared/clock"
import { CoopSim, forkSimState, hashSimState, stepSim, type SimState } from "../shared/coop-sim"
import type { Command } from "../shared/session"
import type { WorldMode } from "../shared/world"

const arg = (name: string, fallback: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback

const ticks = Number(arg("ticks", "600"))
const jsonOut = arg("json", "")
const golden = arg("golden", "")

type Scenario = {
  name: string
  seed: number
  survivors: number
  mode: WorldMode
  /** Stage the start (positions only), before the first snapshot. */
  stage?: (sim: CoopSim) => void
  cmd?: (tick: number, index: number) => Command
}
const SCENARIOS: Scenario[] = [
  { name: "solo-streaming", seed: 7, survivors: 1, mode: "streaming" },
  { name: "squad-streaming", seed: 11, survivors: 4, mode: "streaming" },
  { name: "solo-classic", seed: 7, survivors: 1, mode: "classic" },
  {
    // Heads east out of the origin window so chunks stream in and out.
    name: "roam-east",
    seed: 7,
    survivors: 2,
    mode: "streaming",
    cmd: (tick, index) => ({ mx: 1, my: Math.sin(tick / 40 + index) * 0.4, aim: 0, interact: false, sprint: true }),
  },
  {
    // Stands in a doorway working the door, so topology changes every few ticks.
    name: "door-worker",
    seed: 7,
    survivors: 1,
    mode: "streaming",
    stage: (sim) => {
      const d = sim.town.doors[0]!
      const p = sim.slots[0]!.survivor
      p.x = (d.rect[0] + d.rect[2]) / 2 + 0.6
      p.y = (d.rect[1] + d.rect[3]) / 2 + 0.6
    },
    cmd: (tick) => ({ mx: 0, my: 0, aim: Math.PI * 1.25, interact: tick % 30 === 0, sprint: false }),
  },
  {
    // 45 zombies, two thirds hunting, while two survivors shoot: lag-compensation history fills up.
    name: "horde-45",
    seed: 7,
    survivors: 2,
    mode: "streaming",
    stage: (sim) => {
      const p = sim.slots[0]!.survivor
      const rng = new Rng(0x5eed)
      sim.ai.agents.length = 0
      for (let id = 1; sim.ai.agents.length < 45; id++) {
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
    },
    cmd: (tick, index) => ({ ...command(tick, index), fire: tick % 20 === index * 10 }),
  },
]

/** Walks loops, sprints, opens whatever is in reach, fires now and then, so doors and chunks change topology. */
function command(tick: number, index: number): Command {
  const phase = tick / 160 + index * 1.7
  return {
    mx: Math.cos(phase),
    my: Math.sin(phase * 0.7),
    aim: phase,
    interact: tick % 45 === index * 7,
    sprint: tick % 300 < 120,
    fire: tick % 97 === 13 + index,
    crouch: tick % 500 > 460,
  }
}

let scenarioCmd = command
const inputs = (tick: number, n: number): Command[] => Array.from({ length: n }, (_, i) => scenarioCmd(tick, i))

function initial(s: Scenario): SimState {
  const sim = new CoopSim(s.seed, s.seed, 0.22, undefined, undefined, s.mode)
  for (let i = 0; i < s.survivors; i++) sim.addSurvivor(i === 0 ? "player" : `p${i}`, i)
  s.stage?.(sim)
  return sim.toSnapshot()
}

/** Hash without `rewind`, so traces compare with states recorded before it was serialised. */
const traceHash = (state: SimState) => hashSimState({ ...state, rewind: undefined } as SimState)

function pct(values: number[], p: number) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0
}
const r3 = (v: number) => Math.round(v * 1000) / 1000

function run(s: Scenario) {
  scenarioCmd = s.cmd ?? command
  const s0 = initial(s)
  const tuning = undefined

  // Pure chain
  const pureMs: number[] = []
  const pureTrace: string[] = []
  let state = s0
  for (let t = 0; t < ticks; t++) {
    const t0 = performance.now()
    state = stepSim(state, inputs(t, s.survivors), TICK_DT, { timeScale: 240, tuning })
    pureMs.push(performance.now() - t0)
    pureTrace.push(traceHash(state))
  }

  // Mutable sim in place
  const mutMs: number[] = []
  const mutTrace: string[] = []
  const sim = CoopSim.fromSnapshot(s0)
  for (let t = 0; t < ticks; t++) {
    const cmds = inputs(t, s.survivors)
    const t0 = performance.now()
    sim.slots.forEach((slot, i) => sim.stepSurvivor(slot, cmds[i]!, TICK_DT))
    sim.stepWorld(TICK_DT, 240)
    mutMs.push(performance.now() - t0)
    mutTrace.push(traceHash(sim.toSnapshot()))
  }
  const mismatch = pureTrace.findIndex((h, i) => h !== mutTrace[i])

  // Fork rollouts: from the midpoint, two pure branches with distinct rollout seeds and one replayed twice.
  const mid = ticks >> 1
  let midState = s0
  for (let t = 0; t < mid; t++) midState = stepSim(midState, inputs(t, s.survivors), TICK_DT, { timeScale: 240 })
  const rollout = (from: SimState) => {
    let st = from
    for (let t = mid; t < ticks; t++) st = stepSim(st, inputs(t, s.survivors), TICK_DT, { timeScale: 240 })
    return hashSimState(st)
  }
  const forkA = rollout(forkSimState(midState, { rolloutSeed: 1 }))
  const forkA2 = rollout(forkSimState(midState, { rolloutSeed: 1 }))
  const forkB = rollout(forkSimState(midState, { rolloutSeed: 2 }))
  const plain = rollout(midState)
  // Same rollout run on the mutable sim from a restored fork.
  const mutFork = CoopSim.fromSnapshot(forkSimState(midState, { rolloutSeed: 1 }))
  for (let t = mid; t < ticks; t++) {
    const cmds = inputs(t, s.survivors)
    mutFork.slots.forEach((slot, i) => mutFork.stepSurvivor(slot, cmds[i]!, TICK_DT))
    mutFork.stepWorld(TICK_DT, 240)
  }

  const out = {
    scenario: s.name,
    ticks,
    pureMsPerTick: r3(pureMs.reduce((a, b) => a + b, 0) / ticks),
    pureP50: r3(pct(pureMs, 0.5)),
    pureP95: r3(pct(pureMs, 0.95)),
    mutableMsPerTick: r3(mutMs.reduce((a, b) => a + b, 0) / ticks),
    mutableP50: r3(pct(mutMs, 0.5)),
    pureMatchesMutable: mismatch < 0,
    firstMismatchTick: mismatch,
    forkRepeatable: forkA === forkA2,
    forkSeedsDiverge: forkA !== forkB,
    forkMatchesMutable: forkA === hashSimState(mutFork.toSnapshot()),
    unforkedMatchesChain: plain === hashSimState(state),
    endHash: pureTrace.at(-1),
    revisionEnd: state.revision,
    trace: pureTrace,
  }
  return out
}

// Warm the JIT on every path first, then measure.
for (const s of SCENARIOS) run(s)
const results = SCENARIOS.map(run)
let goldenFail = 0
if (golden) {
  const prior = JSON.parse(readFileSync(golden, "utf8")) as { scenario: string; trace: string[] }[]
  for (const r of results) {
    const g = prior.find((p) => p.scenario === r.scenario)
    const bad = g ? r.trace.findIndex((h, i) => h !== g.trace[i]) : 0
    if (bad >= 0) goldenFail++
    console.log(`${r.scenario}: golden ${bad < 0 ? "identical" : `differs at tick ${bad}`}`)
  }
}
for (const r of results) {
  const { trace: _trace, ...rest } = r
  console.log(JSON.stringify(rest))
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(results, null, 2))
const ok = results.every((r) => r.pureMatchesMutable && r.forkRepeatable && r.forkMatchesMutable && r.unforkedMatchesChain)
if (!ok || goldenFail) process.exit(1)
