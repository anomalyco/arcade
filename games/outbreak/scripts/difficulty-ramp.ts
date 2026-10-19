// Full difficulty-ramp playtest: survivor bots of every skill preset play many fixed seeds through several nights,
// and the per-hour probe (shared/difficulty-ramp.ts) becomes a report with per-phase tables, hourly curves and PNG
// charts. The fast CI version with tolerance bands is tests/difficulty-ramp.test.ts; docs/outbreak-difficulty.md
// explains both.
//
// Usage (CPU only, from games/outbreak):
//   hivemind run --fetch captures/difficulty-ramp -- bun scripts/difficulty-ramp.ts
//   bun scripts/difficulty-ramp.ts --seeds=24 --nights=5 --presets=Novice,Expert --out=captures/difficulty-ramp
//   bun scripts/difficulty-ramp.ts --today                       # the pre-D-40 ramp (night ramp off)
//   bun scripts/difficulty-ramp.ts --set=nightPopulationStep=6,nightChaserCeiling=5   # try session tuning values
// Charts need `uv` (matplotlib through `uv run --with matplotlib`); pass --no-charts to skip them.
import { mkdirSync, writeFileSync } from "node:fs"
import { availableParallelism } from "node:os"
import { join, resolve } from "node:path"
import type { BotRunConfig } from "../shared/bot-runner"
import type { SessionTuning } from "../shared/sim-types"
import {
  RAMP_PHASE_LABELS,
  rampHourCurves,
  secondsToDawn,
  summarizeRamp,
  type RampPresetSummary,
  type RampRun,
} from "../shared/difficulty-ramp"
import { runRampBatch } from "./difficulty-ramp-pool"
import { BOT_SKILL_PRESET_ORDER, type BotSkillPresetId } from "../shared/survivor-bot"

async function main() {
  const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1]
  const seedArg = arg("seeds") ?? "24"
  const seeds = seedArg.includes(",")
    ? seedArg.split(",").map(Number)
    : Array.from({ length: Number(seedArg) }, (_, i) => 101 + i * 6)
  const presets = (arg("presets")?.split(",") ?? BOT_SKILL_PRESET_ORDER) as BotSkillPresetId[]
  const nights = Number(arg("nights") ?? 5)
  const out = resolve(arg("out") ?? "captures/difficulty-ramp")
  const workers = Number(arg("workers") ?? Math.max(1, Math.min(10, availableParallelism() - 2)))
  const set: Record<string, number> = {}
  for (const pair of arg("set")?.split(",") ?? []) {
    const [k, v] = pair.split("=")
    if (k && v !== undefined && Number.isFinite(Number(v))) set[k] = Number(v)
  }
  if (process.argv.includes("--today")) set.nightRampMode = 0
  const sessionTuning = Object.keys(set).length ? (set as SessionTuning) : undefined
  const phases = nights * 2
  const hours = 1 + nights * 24 - 12

  const jobs: BotRunConfig[] = presets.flatMap((preset) =>
    seeds.map((seed) => ({ seed, preset, maxDurationSeconds: secondsToDawn(nights), timeScale: 240, tickDt: 1 / 15, sessionTuning })),
  )
  const t0 = performance.now()
  const runs = await runRampBatch(jobs, workers)
  const seconds = (performance.now() - t0) / 1000
  runs.sort((a, b) => presets.indexOf(a.preset) - presets.indexOf(b.preset) || a.seed - b.seed)

  const summary = summarizeRamp(runs, phases)
  const curves = Object.fromEntries(presets.map((p) => [p, rampHourCurves(runs, p, hours)]))
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, "summary.json"), JSON.stringify({ seeds, presets, nights, set, summary, curves }, null, 1))
  writeFileSync(join(out, "runs.json"), JSON.stringify(runs))
  writeFileSync(join(out, "report.md"), report(summary.byPreset, presets, phases, seeds.length, nights, runs, set))
  console.log(`difficulty-ramp: ${runs.length} runs in ${seconds.toFixed(1)} s on ${workers} workers → ${out}`)
  for (const preset of presets) {
    const s = summary.byPreset[preset]!
    console.log(
      `${preset.padEnd(8)} median nights ${s.medianNights.toFixed(2)}, alive at each dawn ${s.phases
        .filter((p) => p.night)
        .map((p) => `${Math.round(p.aliveAtEnd * 100)}%`)
        .join(" ")}`,
    )
  }

  if (!process.argv.includes("--no-charts")) {
    const script = join(import.meta.dir, "difficulty-ramp-charts.py")
    const res = Bun.spawnSync(["uv", "run", "-q", "--with", "matplotlib", "python", script, out], {
      stdout: "inherit",
      stderr: "inherit",
    })
    if (res.exitCode !== 0) console.warn("difficulty-ramp: charts skipped (needs uv and matplotlib)")
  }
}

const pct = (v: number) => `${Math.round(v * 100)}%`

function report(
  byPreset: Partial<Record<BotSkillPresetId, RampPresetSummary>>,
  presets: readonly BotSkillPresetId[],
  phases: number,
  seedCount: number,
  nights: number,
  runs: readonly RampRun[],
  set: Record<string, number>,
): string {
  const labels = RAMP_PHASE_LABELS.slice(0, phases)
  const lines: string[] = []
  lines.push(`# Outbreak difficulty ramp`, "")
  lines.push(`${presets.length} presets × ${seedCount} seeds, solo, ${nights} nights (to dawn ${nights}).`, "")
  const tuned = Object.entries(set).map(([k, v]) => `${k}=${v}`).join(", ")
  lines.push(`Session tuning: ${tuned || "shipped defaults"}.`, "")
  lines.push(`## Survival`, "")
  lines.push(`Fraction of runs alive at the end of each phase.`, "")
  lines.push(`| Preset | Median nights | ${labels.join(" | ")} |`)
  lines.push(`| --- | --: | ${labels.map(() => "--:").join(" | ")} |`)
  for (const p of presets) {
    const s = byPreset[p]!
    lines.push(`| ${p} | ${s.medianNights.toFixed(2)} | ${s.phases.map((x) => pct(x.aliveAtEnd)).join(" | ")} |`)
  }
  lines.push("", `## Death rate per phase`, "", `Deaths in the phase over runs that entered it.`, "")
  lines.push(`| Preset | ${labels.join(" | ")} | Causes |`)
  lines.push(`| --- | ${labels.map(() => "--:").join(" | ")} | --- |`)
  for (const p of presets) {
    const s = byPreset[p]!
    const causes = Object.entries(s.causes)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${v}`)
      .join(", ")
    lines.push(`| ${p} | ${s.phases.map((x) => (x.entered ? pct(x.deathRate) : "–")).join(" | ")} | ${causes} |`)
  }
  const table = (title: string, note: string, f: (x: RampPresetSummary["phases"][number]) => string) => {
    lines.push("", `## ${title}`, "", note, "")
    lines.push(`| Preset | ${labels.join(" | ")} |`)
    lines.push(`| --- | ${labels.map(() => "--:").join(" | ")} |`)
    for (const p of presets) {
      const s = byPreset[p]!
      lines.push(`| ${p} | ${s.phases.map((x) => (x.entered ? f(x) : "–")).join(" | ")} |`)
    }
  }
  table("Living zombies", "Mean living director population while the survivor is alive.", (x) => x.living.toFixed(1))
  table("Aware zombies", "Mean zombies investigating, alerted, chasing, bashing or searching.", (x) => x.aware.toFixed(2))
  table("Active chasers", "Mean director-counted chasers.", (x) => x.chasers.toFixed(2))
  table("Special zombies", "Mean living specials (runner, brute, screamer, bloater, riot cop, lurker).", (x) => x.specials.toFixed(2))
  table("Hits per minute", "Separate damage events on the survivor per real minute.", (x) => x.hitsPerMin.toFixed(2))
  table("Damage per game hour", "", (x) => x.damagePerHour.toFixed(1))
  table("Kills per game hour", "", (x) => x.killsPerHour.toFixed(2))
  table("Indoors / hidden", "Fraction of time inside a building / hidden in a closet.", (x) => `${pct(x.indoors)} / ${pct(x.hidden)}`)
  table("Ammo at phase end", "Rounds carried (mag + reserve) by survivors alive at the end.", (x) => x.ammo.toFixed(1))
  table("Ammo found / spent", "Per run that entered the phase.", (x) => `${x.ammoFound.toFixed(1)} / ${x.ammoSpent.toFixed(1)}`)
  table("Meds at phase end", "Medkits plus bandages carried.", (x) => x.meds.toFixed(2))
  table("Meds found / used", "", (x) => `${x.medsFound.toFixed(2)} / ${x.medsUsed.toFixed(2)}`)
  table("Flashlight battery at phase end", "Charge 0–1, plus spare batteries carried.", (x) => `${x.battery.toFixed(2)} + ${x.spareBatteries.toFixed(1)}`)
  lines.push("", `## Deaths`, "")
  for (const p of presets) {
    const deaths = runs.filter((r) => r.preset === p && r.deathHours !== null).map((r) => r.deathHours!.toFixed(1))
    lines.push(`- ${p}: died at game hour ${deaths.join(", ") || "none"}`)
  }
  lines.push("", "Food does not exist in Outbreak yet, so it has no curve.", "")
  return lines.join("\n")
}

await main()
