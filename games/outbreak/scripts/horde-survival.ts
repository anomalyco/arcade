// Survival-curve A/B for crowd navigation: the survivor bots play the default game with per-agent A* (`--flow=0`
// side) and with shared flow fields, same seeds and difficulty, one Bun worker per run.
//
// Usage (via the fleet): hivemind run --kind browser -- bun scripts/horde-survival.ts [--seeds=8] [--seconds=1260]
import { availableParallelism } from "node:os"
import { runHeadlessBotGame, type BotRunResult } from "../shared/bot-runner"
import { DEFAULT_DIFFICULTY_VECTOR, difficultyToSimTunings } from "../shared/difficulty-tuner"
import { BOT_SKILL_PRESET_ORDER, type BotSkillPresetId } from "../shared/survivor-bot"

type Job = { seed: number; preset: BotSkillPresetId; flowFields: boolean; seconds: number }
type Row = { job: Job; nights: number; seconds: number; died: boolean; kills: number; peakChasers: number }

declare const self: Worker

function runJob(job: Job): Row {
  const { aiConfig, progressionTuning } = difficultyToSimTunings(DEFAULT_DIFFICULTY_VECTOR)
  const res: BotRunResult = runHeadlessBotGame({
    seed: job.seed,
    preset: job.preset,
    maxDurationSeconds: job.seconds,
    aiConfig: { ...aiConfig, flowFields: job.flowFields ? 1 : 0 },
    progressionTuning,
    configLabel: job.flowFields ? "flow" : "astar",
  })
  return {
    job,
    nights: res.nightsSurvived,
    seconds: res.survivalTime,
    died: !res.survived,
    kills: res.killsByWeapon.total,
    peakChasers: res.peakSimultaneousChasers,
  }
}

if (typeof Bun !== "undefined" && !Bun.isMainThread) {
  self.onmessage = (e: MessageEvent<Job>) => self.postMessage(runJob(e.data))
} else {
  const arg = (name: string, fallback: string) =>
    process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback
  const seeds = Number(arg("seeds", "8"))
  const seconds = Number(arg("seconds", "1260"))
  const jobs: Job[] = []
  for (const flowFields of [false, true]) {
    for (const preset of BOT_SKILL_PRESET_ORDER) {
      for (let s = 0; s < seeds; s++) jobs.push({ seed: 1000 + s * 7919, preset, flowFields, seconds })
    }
  }
  const rows: Row[] = []
  const workers = Math.max(1, Math.min(jobs.length, availableParallelism() - 1))
  let next = 0
  await Promise.all(
    Array.from({ length: workers }, async () => {
      const w = new Worker(import.meta.url)
      while (next < jobs.length) {
        const job = jobs[next++]!
        rows.push(
          await new Promise<Row>((resolve) => {
            w.onmessage = (e: MessageEvent<Row>) => resolve(e.data)
            w.postMessage(job)
          }),
        )
      }
      w.terminate()
    }),
  )
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)
  const summary = BOT_SKILL_PRESET_ORDER.map((preset) => {
    const side = (flow: boolean) => rows.filter((r) => r.job.preset === preset && r.job.flowFields === flow)
    const a = side(false)
    const f = side(true)
    return {
      preset,
      astar: { nights: +mean(a.map((r) => r.nights)).toFixed(3), seconds: +mean(a.map((r) => r.seconds)).toFixed(1), deaths: a.filter((r) => r.died).length, kills: +mean(a.map((r) => r.kills)).toFixed(1) },
      flow: { nights: +mean(f.map((r) => r.nights)).toFixed(3), seconds: +mean(f.map((r) => r.seconds)).toFixed(1), deaths: f.filter((r) => r.died).length, kills: +mean(f.map((r) => r.kills)).toFixed(1) },
    }
  })
  console.log(JSON.stringify({ seeds, seconds, summary }, null, 2))
}
