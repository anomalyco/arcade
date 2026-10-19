// CPU-only review bench. No browser or audio context: the production sim, co-op loopback and sound director.
// bun scripts/cpu-review-bench.ts [--out=report.json]
// Add --baseline=/absolute/path/to/base/games/outbreak for alternating old/new audio and tuning measurements.
import { CoopSim, hashSimState } from "../shared/coop-sim"
import { TICK_DT } from "../shared/clock"
import { COOP_TUNING } from "../shared/coop-config"
import { DEFAULT_FLASHLIGHT_TUNING } from "../shared/flashlight"
import type { SessionTuning } from "../shared/session"
import { DEFAULT_STAMINA_TUNING } from "../shared/stamina"
import { SoundDirector } from "../src/audio/director"
import { soundWorld } from "../src/audio/world"
import { runCoopBenchScenario } from "./coop-bench"

const rounds = 7
const ticks = 600
const summarize = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  return { median: sorted[sorted.length >> 1], min: sorted[0], max: sorted.at(-1), values }
}

function simulation(zombies: number, tuning: SessionTuning = COOP_TUNING) {
  const sim = new CoopSim(7, 7, 0.22, { zombieCount: zombies, directorPacing: 0 })
  for (let i = 0; i < 4; i++) sim.addSurvivor(`p${i}`, i)
  sim.ai.syncPopulation(sim.town, 27.7, 41)
  const commands = sim.slots.map((_, i) => ({ mx: Math.cos(i), my: Math.sin(i), aim: i, interact: false }))
  const start = performance.now()
  for (let tick = 0; tick < ticks; tick++) {
    // Turn back each second so streamed chunk residents cannot change the requested population.
    if (tick % 60 === 0) for (const cmd of commands) { cmd.mx = -cmd.mx; cmd.my = -cmd.my }
    for (let i = 0; i < sim.slots.length; i++) sim.stepSurvivor(sim.slots[i]!, commands[i]!, TICK_DT, tuning)
    sim.stepWorld(TICK_DT, 120, tuning)
  }
  const ms = (performance.now() - start) / ticks
  if (sim.ai.agents.length !== zombies) throw new Error(`Expected ${zombies} zombies, got ${sim.ai.agents.length}`)
  return { ms, zombies: sim.ai.agents.length, trace: hashSimState(sim.toSnapshot()) }
}

function audio(spread: boolean, Director = SoundDirector) {
  const sim = new CoopSim(7)
  for (let i = 0; i < 4; i++) {
    const p = sim.addSurvivor(`p${i}`, i).survivor
    if (spread) { p.x += (i % 2) * 960; p.y += Math.floor(i / 2) * 960 }
  }
  sim.syncWorldChunks()
  const director = new Director()
  const listener = sim.slots[0]!.survivor
  const frames = 3000
  let events = 0
  const trace: string[] = []
  const start = performance.now()
  for (let frame = 0; frame < frames; frame++) {
    sim.time = frame / 60
    if (frame % 60 === 30) {
      const door = sim.town.doors[Math.floor(frame / 60) % sim.town.doors.length]!
      door.open = !door.open
      const portal = sim.ai.portalStates.get(door.id)!
      portal.barricadePlanks = (portal.barricadePlanks + 1) % 4
      portal.lastBashTime = sim.time
    }
    const sounds = director.observe(soundWorld(sim), listener)
    events += sounds.length
    if (sounds.length) trace.push(`${frame}:${JSON.stringify(sounds)}`)
  }
  return { ms: (performance.now() - start) / frames, portals: sim.ai.portalStates.size, events, trace: Bun.hash(trace.join("\n")).toString(16) }
}

const report: Record<string, unknown> = {}
const baseline = process.argv.find((s) => s.startsWith("--baseline="))?.slice(11)
if (baseline) {
  const { SoundDirector: BeforeDirector } = await import(`${baseline}/src/audio/director.ts`)
  const oldTuning = { stamina: DEFAULT_STAMINA_TUNING, flashlight: DEFAULT_FLASHLIGHT_TUNING }
  const cases = [
    ...[16, 30].map((zombies) => ({ name: `sim-${zombies}`, before: () => simulation(zombies, oldTuning), after: () => simulation(zombies) })),
    ...[false, true].map((spread) => ({ name: `audio-${spread ? "spread" : "together"}`, before: () => audio(spread, BeforeDirector), after: () => audio(spread) })),
  ]
  for (const c of cases) {
    c.before(); c.after()
    const before: number[] = [], after: number[] = [], ratios: number[] = []
    for (let i = 0; i < rounds; i++) {
      const pair = i % 2 ? [c.after(), c.before()].reverse() : [c.before(), c.after()]
      const a = pair[0]!, b = pair[1]!
      if (a.trace !== b.trace) throw new Error(`${c.name}: behavior changed`)
      before.push(a.ms); after.push(b.ms); ratios.push(b.ms / a.ms)
    }
    report[c.name] = { before: summarize(before), after: summarize(after), ratio: summarize(ratios), tracesEqual: true }
  }
} else {
  for (const zombies of [16, 30]) {
    simulation(zombies)
    const runs = Array.from({ length: rounds }, () => simulation(zombies))
    report[`sim-${zombies}`] = { msPerTick: summarize(runs.map((r) => r.ms)), endZombies: runs.map((r) => r.zombies), traces: runs.map((r) => r.trace) }
    const cfg = { players: 4, zombies, spread: false, lossRate: 0, latencyTicks: 3, jitterTicks: 1, seconds: 10 }
    runCoopBenchScenario(cfg)
    report[`coop-${zombies}`] = Array.from({ length: rounds }, () => runCoopBenchScenario(cfg))
  }
  for (const spread of [false, true]) {
    audio(spread)
    const runs = Array.from({ length: rounds }, () => audio(spread))
    report[`audio-${spread ? "spread" : "together"}`] = { msPerFrame: summarize(runs.map((r) => r.ms)), portals: runs[0]!.portals, events: runs.map((r) => r.events), traces: runs.map((r) => r.trace) }
  }
}
console.log(JSON.stringify(report, null, 2))
const out = process.argv.find((s) => s.startsWith("--out="))?.slice(6)
if (out) await Bun.write(out, JSON.stringify(report, null, 2))
