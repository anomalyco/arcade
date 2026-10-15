// Behaviour-parity fingerprint for refactors that must not change the simulation.
//
//   bun scripts/parity.ts --out before.json          on the base commit
//   bun scripts/parity.ts --out after.json --against before.json
//
// It records, for fixed seeds and scripted inputs: SimState hashes every 30 ticks from the mutable CoopSim and from
// the pure stepSim path, the hashes of the binary shared/personal snapshot bytes, and full survivor-bot batch results.
// Any difference names the first diverging probe. Imports only stable entry points (coop-sim, bot-runner,
// net-protocol, clock) so the same file runs before and after a module move.
import { Rng } from "@arcade/kit/sim/rng"
import { runHeadlessBotGame, type BotRunConfig } from "../shared/bot-runner"
import { TICK_DT } from "../shared/clock"
import { CoopSim, hashSimState, stepSim, type SimState } from "../shared/coop-sim"
import { encodePersonal, encodeShared } from "../shared/net-protocol"
import type { Command } from "../shared/session"

const argv = process.argv.slice(2)
const option = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined)
const quick = argv.includes("--quick")

function fnv(bytes: Uint8Array | string): string {
  let h = 0x811c9dc5 >>> 0
  if (typeof bytes === "string") for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes.charCodeAt(i), 0x01000193) >>> 0
  else for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i]!, 0x01000193) >>> 0
  return h.toString(16).padStart(8, "0")
}

/** A seeded, varied command stream that exercises movement, interaction, combat, inventory and discovery verbs. */
function scriptedCommand(rng: Rng, tick: number, aim: number): Command {
  const phase = Math.floor(tick / 45) % 8
  const angle = rng.next() * Math.PI * 2
  const c: Command = {
    mx: phase === 7 ? 0 : Math.cos(angle) * (phase % 2 ? 1 : 0.5),
    my: phase === 7 ? 0 : Math.sin(angle) * (phase % 2 ? 1 : 0.5),
    aim: aim + (rng.next() - 0.5) * 0.6,
    interact: rng.next() < 0.08,
    interactHeld: phase === 3 || phase === 6,
    sprint: phase === 1 && rng.next() < 0.7,
    crouch: phase === 5,
    jump: rng.next() < 0.01,
    fire: rng.next() < 0.03,
    fireHeld: phase === 4,
    reload: rng.next() < 0.01,
    melee: rng.next() < 0.02,
    barricade: rng.next() < 0.015,
    flashlight: rng.next() < 0.005,
    ping: rng.next() < 0.01,
  }
  if (rng.next() < 0.02) c.hotbarSlot = rng.int(5)
  if (rng.next() < 0.01) c.hotbarDelta = rng.next() < 0.5 ? -1 : 1
  if (rng.next() < 0.01) c.drop = true
  if (rng.next() < 0.02) c.pick = { mode: (["take", "bench", "craft", "pack"] as const)[rng.int(4)]!, index: rng.int(3) }
  return c
}

type Scenario = { seed: number; players: number; ticks: number; worldMode?: "streaming" | "procedural" | "classic" }

function runScenario(s: Scenario): { sim: string[]; wire: string[]; pure: string[] } {
  const sim = new CoopSim(s.seed, s.seed, 0.22, undefined, s.worldMode ?? "streaming")
  for (let i = 0; i < s.players; i++) sim.addSurvivor(i === 0 ? "player" : `p${i}`, i)
  const rng = new Rng((s.seed * 7919 + 13) >>> 0 || 1)
  const out = { sim: [] as string[], wire: [] as string[], pure: [] as string[] }
  let pureState: SimState = sim.toSnapshot()
  const pureRng = new Rng((s.seed * 7919 + 13) >>> 0 || 1)
  const pureTicks = quick ? 60 : 120
  for (let tick = 1; tick <= s.ticks; tick++) {
    for (const slot of sim.slots) sim.stepSurvivor(slot, scriptedCommand(rng, tick, slot.survivor.aim), TICK_DT)
    sim.stepWorld(TICK_DT, 240)
    if (tick % 30 === 0) {
      out.sim.push(`${tick}:${hashSimState(sim.toSnapshot())}`)
      const shared = encodeShared(sim, tick, new Map())
      const personal = sim.slots.map((slot) => fnv(encodePersonal(tick, slot.survivor, null, slot.notices)))
      out.wire.push(`${tick}:${fnv(shared)}:${personal.join(",")}`)
    }
    if (tick <= pureTicks) {
      const inputs = pureState.slots.map((slot) => scriptedCommand(pureRng, tick, slot.survivor.aim))
      pureState = stepSim(pureState, inputs, TICK_DT)
      if (tick % 30 === 0) out.pure.push(`${tick}:${hashSimState(pureState)}`)
    }
  }
  return out
}

const scenarios: Scenario[] = quick
  ? [{ seed: 7, players: 1, ticks: 600 }]
  : [
      { seed: 7, players: 1, ticks: 1800 },
      { seed: 1234, players: 4, ticks: 1200 },
      { seed: 99, players: 2, ticks: 900, worldMode: "procedural" },
      { seed: 5, players: 1, ticks: 600, worldMode: "classic" },
    ]

const bots: BotRunConfig[] = quick
  ? [{ seed: 7, preset: "Skilled", maxDurationSeconds: 90, timeScale: 240 }]
  : [
      { seed: 7, preset: "Skilled", maxDurationSeconds: 300, timeScale: 240 },
      { seed: 101, preset: "Casual", maxDurationSeconds: 300, timeScale: 240 },
      { seed: 42, preset: "Expert", playerCount: 4, maxDurationSeconds: 180, timeScale: 240 },
      { seed: 3, preset: "Novice", maxDurationSeconds: 240, timeScale: 240, worldMode: "procedural" },
      // Full four-cycle runs: tinkering, crouching, tripwires, glass and a car alarm all happen in these.
      { seed: 11, preset: "Expert", playerCount: 2, maxDurationSeconds: 1260, timeScale: 240 },
      { seed: 23, preset: "Perfect", maxDurationSeconds: 1260, timeScale: 240 },
      { seed: 5, preset: "Skilled", playerCount: 3, maxDurationSeconds: 1260, timeScale: 240 },
      { seed: 77, preset: "Casual", playerCount: 4, maxDurationSeconds: 1260, timeScale: 240 },
    ]

const t0 = performance.now()
const result: Record<string, unknown> = {}
for (const s of scenarios) result[`sim seed=${s.seed} players=${s.players} mode=${s.worldMode ?? "streaming"}`] = runScenario(s)
for (const b of bots) {
  const run = runHeadlessBotGame(b)
  const { timeline, series, ...summary } = run
  result[`bots seed=${b.seed} preset=${b.preset} players=${b.playerCount ?? 1}`] = {
    summary: JSON.stringify(summary),
    timeline: fnv(JSON.stringify(timeline)),
    series: fnv(JSON.stringify(series)),
  }
}
const seconds = ((performance.now() - t0) / 1000).toFixed(1)

const outPath = option("--out")
if (outPath) await Bun.write(outPath, JSON.stringify(result, null, 1))
const againstPath = option("--against")
if (againstPath) {
  const before = (await Bun.file(againstPath).json()) as Record<string, unknown>
  const diffs: string[] = []
  const walk = (a: unknown, b: unknown, path: string) => {
    if (diffs.length > 20) return
    if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) {
      if (a !== b) diffs.push(`${path}: ${String(a).slice(0, 160)} → ${String(b).slice(0, 160)}`)
      return
    }
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) walk((a as any)[k], (b as any)[k], `${path}.${k}`)
  }
  walk(before, result, "")
  if (diffs.length) {
    console.error(`parity: ${diffs.length} difference(s) against ${againstPath}\n${diffs.join("\n")}`)
    process.exit(1)
  }
  console.log(`parity: identical to ${againstPath} (${Object.keys(result).length} probes, ${seconds}s)`)
} else {
  console.log(`parity: recorded ${Object.keys(result).length} probes in ${seconds}s${outPath ? ` → ${outPath}` : ""}`)
}
