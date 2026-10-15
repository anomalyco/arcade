// Digest of a survivor-bots batch: the shipped difficulty across seeds × skill presets, plus forked rollouts along
// one run's checkpoints. Two trees that simulate identically print identical digests, so run it before and after a
// sim change to prove bots are unaffected.
//
// Usage: hivemind run --kind browser -- bun scripts/bot-batch-digest.ts [--seeds=101,107,113,127] [--seconds=1260]
import { createHash } from "node:crypto"
import { analyzeRunBranchingTimeline, runHeadlessBotGame } from "../shared/bot-runner"
import { DEFAULT_DIFFICULTY_VECTOR, evaluateDifficultyCandidate } from "../shared/difficulty-tuner"

const arg = (name: string, fallback: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback

const seeds = arg("seeds", "101,107,113,127").split(",").map(Number)
const seconds = Number(arg("seconds", "1260"))
const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16)

const t0 = performance.now()
const batch = evaluateDifficultyCandidate({
  label: "shipped",
  vector: DEFAULT_DIFFICULTY_VECTOR,
  seeds,
  maxDurationSeconds: seconds,
  timeScale: 240,
  tickDt: 1 / 15,
})
const batchMs = performance.now() - t0
for (const r of batch.runs) {
  console.log(
    `${r.preset.padEnd(8)} seed ${r.seed}: ${r.survived ? "survived" : `died (${r.causeOfDeath})`} ${r.survivalTime.toFixed(1)}s nights ${r.nightsSurvived} kills ${r.killsByWeapon.total} ${digest(r)}`,
  )
}

const t1 = performance.now()
const run = runHeadlessBotGame({
  seed: seeds[0]!,
  preset: "Casual",
  maxDurationSeconds: 360,
  timeScale: 240,
  captureCheckpointsEverySeconds: 60,
})
const branching = analyzeRunBranchingTimeline(run, { horizonSeconds: 120 })
const forkMs = performance.now() - t1

console.log(`batch: ${batch.runs.length} runs, loss ${batch.loss.toFixed(4)}, digest ${digest(batch.runs)} (${(batchMs / 1000).toFixed(1)} s)`)
console.log(`forks: ${run.checkpoints?.length ?? 0} checkpoints, digest ${digest(branching)} (${(forkMs / 1000).toFixed(1)} s)`)
