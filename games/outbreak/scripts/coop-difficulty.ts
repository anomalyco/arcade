// Co-op difficulty: survivor bots play the opening (evening and Night 1, at the co-op clock) with 1, 2, 4 and 6
// survivors, and the co-op probe (shared/coop-ramp.ts) prints what each squad met and what happened to it. The CI
// version with bands is in tests/difficulty-ramp.test.ts; docs/outbreak-difficulty.md (Co-op) explains it.
//
// Usage (CPU only, from games/outbreak):
//   bun scripts/coop-difficulty.ts                                  # 1/2/4/6 × Skilled, Novice × 6 seeds
//   bun scripts/coop-difficulty.ts --players=4,6 --presets=Skilled --seeds=12 --workers=2
//   bun scripts/coop-difficulty.ts --set=coopScaleMode=0            # try session tuning (Co-op scaling: Today)
//   bun scripts/coop-difficulty.ts --json=out.json
import { writeFileSync } from "node:fs"
import { availableParallelism } from "node:os"
import type { BotRunConfig } from "../shared/bot-runner"
import { COOP_TIME_SCALE } from "../shared/coop-config"
import { COOP_OPENING_SECONDS, COOP_EARLY_SECONDS, summarizeCoop, type CoopSummary } from "../shared/coop-ramp"
import type { SessionTuning } from "../shared/sim-types"
import type { BotSkillPresetId } from "../shared/survivor-bot"
import { runCoopBatch } from "./difficulty-ramp-pool"

async function main() {
  const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
  const seedArg = arg("seeds") ?? "6"
  const seeds = seedArg.includes(",") ? seedArg.split(",").map(Number) : Array.from({ length: Number(seedArg) }, (_, i) => 101 + i * 6)
  const presets = (arg("presets")?.split(",") ?? ["Skilled", "Novice"]) as BotSkillPresetId[]
  const players = (arg("players") ?? "1,2,4,6").split(",").map(Number)
  const seconds = Number(arg("seconds") ?? COOP_OPENING_SECONDS)
  const workers = Number(arg("workers") ?? Math.max(1, Math.min(2, availableParallelism() - 2)))
  const set: Record<string, number> = {}
  for (const pair of arg("set")?.split(",") ?? []) {
    const [k, v] = pair.split("=")
    if (k && v !== undefined && Number.isFinite(Number(v))) set[k] = Number(v)
  }
  const sessionTuning = Object.keys(set).length ? (set as SessionTuning) : undefined

  const jobs: BotRunConfig[] = presets.flatMap((preset) =>
    players.flatMap((playerCount) =>
      seeds.map((seed) => ({ seed, preset, playerCount, maxDurationSeconds: seconds, timeScale: COOP_TIME_SCALE, tickDt: 1 / 15, sessionTuning })),
    ),
  )
  const t0 = performance.now()
  const runs = await runCoopBatch(jobs, workers)
  console.log(`coop-difficulty: ${runs.length} runs in ${((performance.now() - t0) / 1000).toFixed(1)} s on ${workers} workers, ${seconds} s each (evening 0–60 s, Night 1 60–420 s)`)

  const summaries: CoopSummary[] = []
  for (const preset of presets) for (const n of players) summaries.push(summarizeCoop(runs.filter((r) => r.preset === preset && r.players === n), COOP_EARLY_SECONDS))
  const f = (v: number | null, d = 0) => (v === null ? "–" : v.toFixed(d))
  console.log(
    "\n| Preset | Players | Down | Dead | Wiped | First down s | Down < 120 s (runs/survivors) | Living E/N1 | Chasers E/N1 (peak) | Specials N1 | Noise N1 | Ammo/surv | Dmg/surv | Alarms | First chase/special/dog s | Nearest spawn m | Spawns < 20 m |",
  )
  console.log("| --- | --: | --: | --: | --: | --: | --: | --- | --- | --: | --: | --: | --: | --: | --- | --: | --: |")
  for (const s of summaries) {
    const [e, n1] = [s.phases[0], s.phases[1]]
    console.log(
      `| ${s.preset} | ${s.players} | ${Math.round(s.downRate * 100)}% | ${Math.round(s.deathRate * 100)}% | ${Math.round(s.wipeRate * 100)}% | ${f(s.medianFirstDown)} | ${Math.round(s.earlyDownRate * 100)}%/${Math.round(s.earlySurvivorDownRate * 100)}% | ${f(e?.living ?? null, 1)}/${f(n1?.living ?? null, 1)} | ${f(e?.chasers ?? null, 1)}/${f(n1?.chasers ?? null, 1)} (${f(n1?.peakChasers ?? null, 1)}) | ${f(n1?.specials ?? null, 2)} | ${f(n1?.noiseHeat ?? null, 2)} | ${s.ammoSpentPerSurvivor.toFixed(1)} | ${s.damagePerSurvivor.toFixed(0)} | ${s.alarmsPerRun.toFixed(1)} | ${f(s.medianFirstChase)}/${f(s.medianFirstSpecial)}/${f(s.medianFirstDogBark)} | ${f(s.nearestSpawn, 1)} | ${s.spawnsWithin20.toFixed(1)} |`,
    )
  }
  const json = arg("json")
  if (json) writeFileSync(json, JSON.stringify({ seeds, presets, players, seconds, set, summaries, runs }, null, 1))
}

await main()
