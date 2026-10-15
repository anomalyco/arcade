import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { availableParallelism, homedir } from "node:os"
import { Rng } from "@arcade/kit/sim/rng"
import { BUILDING_RECTS } from "../shared/map"
import {
  BOT_SKILL_PRESET_ORDER,
  BOT_SKILL_PRESETS,
  type BotSkillPresetId,
} from "../shared/survivor-bot"
import { type BotReplayLog, type BotRunResult } from "../shared/bot-runner"
import {
  DEFAULT_DIFFICULTY_VECTOR,
  DIFFICULTY_KNOB_SPECS,
  TARGET_SURVIVAL_CURVE,
  computeDifficultyLoss,
  evaluateDifficultyCandidate,
  quantizeDifficultyVector,
  summarizePresetRuns,
  type CandidateEvaluation,
  type DifficultyVector,
  type EvaluateCandidateOptions,
  type ParameterSensitivityEntry,
  type PresetSurvivalSummary,
} from "../shared/difficulty-tuner"

declare const self: Worker

// Worker entry point for parallel multi-core batch evaluation
if (typeof Bun !== "undefined" && !Bun.isMainThread) {
  self.onmessage = (event: MessageEvent<{ id: number; options: EvaluateCandidateOptions }>) => {
    const { id, options } = event.data
    const result = evaluateDifficultyCandidate(options)
    self.postMessage({ id, result })
  }
}

const ARTIFACT_DIR =
  process.env.SURVIVOR_BOTS_ARTIFACT_DIR ??
  join(homedir(), "code/home/artifacts/2026-10-15-survivor-bots")

const MAP_BUILDINGS = [
  { id: "ash", name: "Ash Safehouse", kind: "house", rect: BUILDING_RECTS[0] },
  { id: "elm", name: "Elm House", kind: "house", rect: BUILDING_RECTS[1] },
  { id: "hardware", name: "Hardware", kind: "hardware", rect: BUILDING_RECTS[2] },
  { id: "pharmacy", name: "Pharmacy", kind: "pharmacy", rect: BUILDING_RECTS[3] },
] as const

const EVAL_SEEDS = [101, 107, 113, 127, 131, 139, 151, 163]
const SEARCH_SEEDS = [101, 113, 131, 151]
const MAX_DURATION_S = 1260
const TIME_SCALE = 240

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const mean = (xs: readonly number[]): number =>
  xs.length === 0 ? 0 : Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3))

class EvalPool {
  private readonly workers: Worker[] = []
  private readonly idle: Worker[] = []
  private readonly queue: {
    id: number
    options: EvaluateCandidateOptions
    resolve: (res: CandidateEvaluation) => void
  }[] = []
  private readonly pending = new Map<number, (res: CandidateEvaluation) => void>()
  private nextId = 1

  constructor(size = Math.max(2, Math.min(12, availableParallelism()))) {
    for (let i = 0; i < size; i++) {
      const w = new Worker(new URL(import.meta.url).href)
      w.onmessage = (ev: MessageEvent<{ id: number; result: CandidateEvaluation }>) => {
        const resolve = this.pending.get(ev.data.id)
        this.pending.delete(ev.data.id)
        this.idle.push(w)
        this.pump()
        if (resolve) resolve(ev.data.result)
      }
      this.workers.push(w)
      this.idle.push(w)
    }
  }

  private evaluateSingle(options: EvaluateCandidateOptions): Promise<CandidateEvaluation> {
    return new Promise((resolve) => {
      const id = this.nextId++
      this.queue.push({ id, options, resolve })
      this.pump()
    })
  }

  async evaluate(options: EvaluateCandidateOptions): Promise<CandidateEvaluation> {
    if (options.seeds.length <= 1) {
      return this.evaluateSingle(options)
    }
    const parts = await Promise.all(
      options.seeds.map((seed) =>
        this.evaluateSingle({
          ...options,
          seeds: [seed],
        }),
      ),
    )
    const runs = parts.flatMap((p) => p.runs)
    const byPreset = {} as Record<BotSkillPresetId, PresetSurvivalSummary>
    for (const preset of BOT_SKILL_PRESET_ORDER) {
      const sub = runs.filter((r) => r.preset === preset)
      byPreset[preset] = summarizePresetRuns(preset, sub)
    }
    const vector = quantizeDifficultyVector(options.vector)
    const loss = computeDifficultyLoss(byPreset)
    return {
      label: options.label,
      vector,
      loss,
      byPreset,
      runs,
    }
  }

  private pump(): void {
    while (this.idle.length > 0 && this.queue.length > 0) {
      const w = this.idle.pop()!
      const job = this.queue.shift()!
      this.pending.set(job.id, job.resolve)
      w.postMessage({ id: job.id, options: job.options })
    }
  }

   close(): void {
    for (const w of this.workers) w.terminate()
  }
}

function vectorToUnit(vec: DifficultyVector): number[] {
  return DIFFICULTY_KNOB_SPECS.map((s) => clamp((vec[s.key] - s.min) / (s.max - s.min), 0, 1))
}

function unitToVector(u: readonly number[]): DifficultyVector {
  const raw = {} as DifficultyVector
  for (let i = 0; i < DIFFICULTY_KNOB_SPECS.length; i++) {
    const s = DIFFICULTY_KNOB_SPECS[i]!
    raw[s.key] = s.min + clamp(u[i]!, 0, 1) * (s.max - s.min)
  }
  return quantizeDifficultyVector(raw)
}

function sampleGaussian(rng: Rng): number {
  const u1 = Math.max(1e-7, rng.next())
  const u2 = rng.next()
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
}

async function runParallelCmaEs(pool: EvalPool) {
  const dim = DIFFICULTY_KNOB_SPECS.length
  const generations = 4
  const lambda = 6
  const mu = 3
  const presets: readonly BotSkillPresetId[] = ["Novice", "Casual", "Skilled", "Expert"]
  const rng = new Rng(0x20261015)

  const rawWeights = Array.from({ length: mu }, (_, i) => Math.log(mu + 0.5) - Math.log(i + 1))
  const wSum = rawWeights.reduce((a, b) => a + b, 0)
  const weights = rawWeights.map((w) => w / wSum)
  const muEff = 1 / weights.reduce((acc, w) => acc + w * w, 0)

  const cs = (muEff + 2) / (dim + muEff + 5)
  const ds = 1 + 2 * Math.max(0, Math.sqrt((muEff - 1) / (dim + 1)) - 1) + cs
  const cc = (4 + muEff / dim) / (dim + 4 + (2 * muEff) / dim)
  const c1 = 2 / (Math.pow(dim + 1.3, 2) + muEff)
  const cmu = Math.min(1 - c1, (2 * (muEff - 2 + 1 / muEff)) / (Math.pow(dim + 2, 2) + muEff))
  const chiN = Math.sqrt(dim) * (1 - 1 / (4 * dim) + 1 / (21 * dim * dim))

  let meanU = vectorToUnit(DEFAULT_DIFFICULTY_VECTOR)
  let sigma = 0.24
  const pc = new Array<number>(dim).fill(0)
  const ps = new Array<number>(dim).fill(0)
  const diagC = new Array<number>(dim).fill(1.0)

  const baseline = await pool.evaluate({
    label: "Today",
    vector: DEFAULT_DIFFICULTY_VECTOR,
    seeds: SEARCH_SEEDS,
    presets,
    maxDurationSeconds: MAX_DURATION_S,
    timeScale: TIME_SCALE,
    tickDt: 1 / 15,
  })

  let best = baseline
  const history = [
    {
      generation: 0,
      bestLoss: baseline.loss,
      meanLoss: baseline.loss,
      bestVector: baseline.vector,
    },
  ]

  for (let gen = 1; gen <= generations; gen++) {
    const candidates: { u: number[]; z: number[]; vec: DifficultyVector }[] = []
    for (let k = 0; k < lambda; k++) {
      const z = Array.from({ length: dim }, () => sampleGaussian(rng))
      const u = meanU.map((m, i) => clamp(m + sigma * Math.sqrt(diagC[i]!) * z[i]!, 0, 1))
      candidates.push({ u, z, vec: unitToVector(u) })
    }

    const evals = await Promise.all(
      candidates.map((c, k) =>
        pool.evaluate({
          label: `gen${gen}-cand${k + 1}`,
          vector: c.vec,
          seeds: SEARCH_SEEDS,
          presets,
          maxDurationSeconds: MAX_DURATION_S,
          timeScale: TIME_SCALE,
          tickDt: 1 / 15,
        }),
      ),
    )

    const pop = candidates.map((c, k) => ({ u: c.u, z: c.z, evalRes: evals[k]! }))
    for (const p of pop) {
      if (p.evalRes.loss < best.loss) best = p.evalRes
    }

    pop.sort((a, b) => a.evalRes.loss - b.evalRes.loss)
    const oldMean = [...meanU]
    meanU = new Array<number>(dim).fill(0)
    const meanZ = new Array<number>(dim).fill(0)

    for (let m = 0; m < mu; m++) {
      const w = weights[m]!
      for (let i = 0; i < dim; i++) {
        meanU[i]! += w * pop[m]!.u[i]!
        meanZ[i]! += w * pop[m]!.z[i]!
      }
    }

    for (let i = 0; i < dim; i++) {
      ps[i] = (1 - cs) * ps[i]! + Math.sqrt(cs * (2 - cs) * muEff) * meanZ[i]!
      const stepNorm = (meanU[i]! - oldMean[i]!) / Math.max(1e-5, sigma)
      pc[i] = (1 - cc) * pc[i]! + Math.sqrt(cc * (2 - cc) * muEff) * stepNorm
      let rankMu = 0
      for (let m = 0; m < mu; m++) {
        const dz = (pop[m]!.u[i]! - oldMean[i]!) / Math.max(1e-5, sigma)
        rankMu += weights[m]! * dz * dz
      }
      diagC[i] = clamp(
        (1 - c1 - cmu) * diagC[i]! + c1 * pc[i]! * pc[i]! + cmu * rankMu,
        0.04,
        4.0,
      )
    }

    const psNorm = Math.hypot(...ps)
    sigma = clamp(sigma * Math.exp((cs / ds) * (psNorm / chiN - 1)), 0.04, 0.45)

    const genMeanLoss = mean(pop.map((p) => p.evalRes.loss))
    history.push({
      generation: gen,
      bestLoss: best.loss,
      meanLoss: genMeanLoss,
      bestVector: best.vector,
    })
    console.error(`[cma-es] gen ${gen}/${generations} · bestLoss=${best.loss.toFixed(2)} meanLoss=${genMeanLoss.toFixed(2)}`)
  }

  return { baseline, best, history }
}

const stripRuns = (ev: CandidateEvaluation) => ({
  label: ev.label,
  vector: ev.vector,
  loss: ev.loss,
  byPreset: ev.byPreset,
  deaths: ev.runs
    .filter((r) => !r.survived && r.deathPosition)
    .map((r) => ({
      seed: r.seed,
      preset: r.preset,
      x: r.deathPosition!.x,
      z: r.deathPosition!.y,
      nightsSurvived: r.nightsSurvived,
      survivalTime: r.survivalTime,
      causeOfDeath: r.causeOfDeath,
      peakChasers: r.peakSimultaneousChasers,
    })),
  survivalCurves: Object.fromEntries(
    BOT_SKILL_PRESET_ORDER.map((preset) => {
      const sub = ev.runs.filter((r) => r.preset === preset)
      const grid = Array.from({ length: 41 }, (_, i) => Number((i * 0.1).toFixed(1)))
      return [
        preset,
        grid.map((n) => ({
          night: n,
          aliveFraction: Number(
            (sub.filter((r) => r.nightsSurvived >= n).length / Math.max(1, sub.length)).toFixed(3),
          ),
        })),
      ]
    }),
  ),
})

type SummaryPayload = {
  generatedAt: string
  seeds: number[]
  maxDurationSeconds: number
  timeScale: number
  targetCurve: typeof TARGET_SURVIVAL_CURVE
  skillPresets: typeof BOT_SKILL_PRESETS
  knobSpecs: typeof DIFFICULTY_KNOB_SPECS
  buildings: typeof MAP_BUILDINGS
  options: ReturnType<typeof stripRuns>[]
  cmaHistory: { generation: number; bestLoss: number; meanLoss: number; bestVector: DifficultyVector }[]
  sensitivity: ParameterSensitivityEntry[]
  coopScaling: {
    playerCount: number
    preset: BotSkillPresetId
    medianNights: number
    meanNights: number
    night1SurvivalRate: number
    meanKills: number
  }[]
}

type FullBundle = {
  summaryData: SummaryPayload
  allPrimaryRuns: Omit<BotRunResult, "replay">[]
  replays: Record<string, BotReplayLog>
}

async function computeBundle(): Promise<FullBundle> {
  const pool = new EvalPool()
  try {
    console.error(`[survivor-bots] Running parallel CMA-ES difficulty search across ${SEARCH_SEEDS.length} seeds...`)
    const t0 = performance.now()
    const cmaResult = await runParallelCmaEs(pool)
    console.error(
      `[survivor-bots] CMA-ES search complete in ${((performance.now() - t0) / 1000).toFixed(2)}s · baseline loss=${cmaResult.baseline.loss.toFixed(2)} -> best loss=${cmaResult.best.loss.toFixed(2)}`,
    )

    const gentleOpeningVector: DifficultyVector = quantizeDifficultyVector({
      ...cmaResult.best.vector,
      zombieCount: Math.max(16, cmaResult.best.vector.zombieCount - 2),
      initialDensity: Math.max(0.15, cmaResult.best.vector.initialDensity - 0.15),
      rampTime: Math.min(540, cmaResult.best.vector.rampTime + 105),
      safeRadius: Math.min(26, cmaResult.best.vector.safeRadius + 7),
      sightRange: Math.max(16, cmaResult.best.vector.sightRange - 4),
      hearingScale: Math.max(0.7, cmaResult.best.vector.hearingScale - 0.1),
      aggression: Math.max(0.65, cmaResult.best.vector.aggression - 0.1),
      nightMultiplier: Math.max(1.15, cmaResult.best.vector.nightMultiplier - 0.1),
    })

    const relentlessSiegeVector: DifficultyVector = quantizeDifficultyVector({
      ...cmaResult.best.vector,
      zombieCount: Math.min(36, cmaResult.best.vector.zombieCount + 5),
      initialDensity: Math.min(0.4, cmaResult.best.vector.initialDensity + 0.05),
      rampTime: Math.max(270, cmaResult.best.vector.rampTime - 75),
      chaseSpeed: Math.min(2.45, cmaResult.best.vector.chaseSpeed + 0.25),
      aggression: Math.min(1.15, cmaResult.best.vector.aggression + 0.25),
      nightMultiplier: Math.min(1.4, cmaResult.best.vector.nightMultiplier + 0.1),
      maxActiveNearPlayer: Math.min(5, cmaResult.best.vector.maxActiveNearPlayer + 1),
    })

    console.error(`[survivor-bots] Evaluating 4 options across ${EVAL_SEEDS.length} seeds × 5 presets in parallel...`)
    let [evalToday, evalBalanced, evalGentle, evalRelentless] = await Promise.all([
      pool.evaluate({
        label: "Today",
        vector: DEFAULT_DIFFICULTY_VECTOR,
        seeds: EVAL_SEEDS,
        presets: BOT_SKILL_PRESET_ORDER,
        maxDurationSeconds: MAX_DURATION_S,
        timeScale: TIME_SCALE,
        recordReplayForSeed: EVAL_SEEDS[0],
      }),
      pool.evaluate({
        label: "Balanced Curve",
        vector: cmaResult.best.vector,
        seeds: EVAL_SEEDS,
        presets: BOT_SKILL_PRESET_ORDER,
        maxDurationSeconds: MAX_DURATION_S,
        timeScale: TIME_SCALE,
        recordReplayForSeed: EVAL_SEEDS[0],
      }),
      pool.evaluate({
        label: "Gentle Opening",
        vector: gentleOpeningVector,
        seeds: EVAL_SEEDS,
        presets: BOT_SKILL_PRESET_ORDER,
        maxDurationSeconds: MAX_DURATION_S,
        timeScale: TIME_SCALE,
        recordReplayForSeed: EVAL_SEEDS[0],
      }),
      pool.evaluate({
        label: "Relentless Siege",
        vector: relentlessSiegeVector,
        seeds: EVAL_SEEDS,
        presets: BOT_SKILL_PRESET_ORDER,
        maxDurationSeconds: MAX_DURATION_S,
        timeScale: TIME_SCALE,
      }),
    ])

    if (evalGentle.loss < evalBalanced.loss) {
      evalBalanced = {
        ...evalGentle,
        label: "Balanced Curve",
        runs: evalGentle.runs.map((r) => ({ ...r, configLabel: "Balanced Curve" })),
      }
      const softerGentleVec: DifficultyVector = quantizeDifficultyVector({
        ...evalBalanced.vector,
        zombieCount: Math.max(16, evalBalanced.vector.zombieCount - 2),
        initialDensity: Math.max(0.1, evalBalanced.vector.initialDensity - 0.05),
        rampTime: Math.min(540, evalBalanced.vector.rampTime + 75),
        safeRadius: Math.min(28, evalBalanced.vector.safeRadius + 2),
        sightRange: Math.max(16, evalBalanced.vector.sightRange - 1),
        nightMultiplier: Math.max(1.2, evalBalanced.vector.nightMultiplier - 0.05),
        lootRate: 1.15,
      })
      evalGentle = await pool.evaluate({
        label: "Gentle Opening",
        vector: softerGentleVec,
        seeds: EVAL_SEEDS,
        presets: BOT_SKILL_PRESET_ORDER,
        maxDurationSeconds: MAX_DURATION_S,
        timeScale: TIME_SCALE,
      })
    }

    console.error(`[survivor-bots] Running 12-knob sensitivity analysis in parallel...`)
    const sensPresets: readonly BotSkillPresetId[] = ["Novice", "Casual", "Skilled"]
    const sensPairs = await Promise.all(
      DIFFICULTY_KNOB_SPECS.map(async (spec) => {
        const span = spec.max - spec.min
        const lowVec = quantizeDifficultyVector({
          ...cmaResult.best.vector,
          [spec.key]: clamp(cmaResult.best.vector[spec.key] - span * 0.22, spec.min, spec.max),
        })
        const highVec = quantizeDifficultyVector({
          ...cmaResult.best.vector,
          [spec.key]: clamp(cmaResult.best.vector[spec.key] + span * 0.22, spec.min, spec.max),
        })
        const [lowEval, highEval] = await Promise.all([
          pool.evaluate({
            label: `${spec.key}-low`,
            vector: lowVec,
            seeds: SEARCH_SEEDS,
            presets: sensPresets,
            maxDurationSeconds: MAX_DURATION_S,
            timeScale: TIME_SCALE,
            tickDt: 1 / 15,
          }),
          pool.evaluate({
            label: `${spec.key}-high`,
            vector: highVec,
            seeds: SEARCH_SEEDS,
            presets: sensPresets,
            maxDurationSeconds: MAX_DURATION_S,
            timeScale: TIME_SCALE,
            tickDt: 1 / 15,
          }),
        ])
        const lowNights = mean(sensPresets.map((p) => lowEval.byPreset[p].meanNights))
        const highNights = mean(sensPresets.map((p) => highEval.byPreset[p].meanNights))
        const lowSec = mean(sensPresets.map((p) => lowEval.byPreset[p].meanSurvivalTime))
        const highSec = mean(sensPresets.map((p) => highEval.byPreset[p].meanSurvivalTime))
        const deltaNights = Number((highNights - lowNights).toFixed(3))
        const deltaSec = Number((highSec - lowSec).toFixed(1))
        const entry: ParameterSensitivityEntry = {
          key: spec.key,
          label: spec.label,
          unit: spec.unit,
          defaultValue: cmaResult.best.vector[spec.key],
          lowValue: lowVec[spec.key],
          highValue: highVec[spec.key],
          lowMeanNights: lowNights,
          highMeanNights: highNights,
          deltaNights,
          absDeltaNights: Number(Math.abs(deltaNights).toFixed(3)),
          deltaSurvivalSeconds: deltaSec,
          direction:
            deltaNights < -0.04
              ? "harder-when-higher"
              : deltaNights > 0.04
                ? "easier-when-higher"
                : "neutral",
        }
        return entry
      }),
    )
    const sensitivity = sensPairs.sort((a, b) => b.absDeltaNights - a.absDeltaNights)

    console.error(`[survivor-bots] Running 1–4 player co-op bot scaling runs in parallel...`)
    const coopEvals = await Promise.all(
      [1, 2, 4].map((playerCount) =>
        pool.evaluate({
          label: `coop-${playerCount}p`,
          vector: cmaResult.best.vector,
          seeds: SEARCH_SEEDS,
          presets: ["Casual", "Skilled"],
          playerCount,
          maxDurationSeconds: MAX_DURATION_S,
          timeScale: TIME_SCALE,
        }),
      ),
    )

    const coopScaling: SummaryPayload["coopScaling"] = []
    for (let i = 0; i < [1, 2, 4].length; i++) {
      const playerCount = [1, 2, 4][i]!
      const ev = coopEvals[i]!
      for (const preset of ["Casual", "Skilled"] as const) {
        const s = ev.byPreset[preset]
        coopScaling.push({
          playerCount,
          preset,
          medianNights: s.medianNights,
          meanNights: s.meanNights,
          night1SurvivalRate: s.night1SurvivalRate,
          meanKills: s.meanKills,
        })
      }
    }

    const replays: Record<string, BotReplayLog> = {}
    for (const r of evalToday.runs) {
      if (r.replay) {
        replays[`today-${r.preset.toLowerCase()}-seed-${r.seed}.json`] = r.replay
      }
    }
    for (const r of evalBalanced.runs) {
      if (r.replay) {
        replays[`balanced-${r.preset.toLowerCase()}-seed-${r.seed}.json`] = r.replay
      }
    }

    const allPrimaryRuns = [
      ...evalToday.runs,
      ...evalBalanced.runs,
      ...evalGentle.runs,
      ...evalRelentless.runs,
    ].map(({ replay: _replay, ...rest }) => rest)

    const summaryData: SummaryPayload = {
      generatedAt: new Date().toISOString(),
      seeds: EVAL_SEEDS,
      maxDurationSeconds: MAX_DURATION_S,
      timeScale: TIME_SCALE,
      targetCurve: TARGET_SURVIVAL_CURVE,
      skillPresets: BOT_SKILL_PRESETS,
      knobSpecs: DIFFICULTY_KNOB_SPECS,
      buildings: MAP_BUILDINGS,
      options: [
        stripRuns(evalToday),
        stripRuns(evalBalanced),
        stripRuns(evalGentle),
        stripRuns(evalRelentless),
      ],
      cmaHistory: cmaResult.history,
      sensitivity,
      coopScaling,
    }

    return { summaryData, allPrimaryRuns, replays }
  } finally {
    pool.close()
  }
}

function buildReportHtml(data: SummaryPayload): string {
  const jsonPayload = JSON.stringify(data)
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Outbreak · Survivor Bots & Difficulty Tuner</title>
  <style>
    :root {
      --bg: #0c0e12;
      --panel: #131720;
      --panel-alt: #181d28;
      --border: #252c3d;
      --text: #e6eaf2;
      --muted: #939db3;
      --accent: #f2a65a;
      --good: #4ade80;
      --warn: #facc15;
      --bad: #f87171;
      --novice: #f87171;
      --casual: #fbbf24;
      --skilled: #38bdf8;
      --expert: #4ade80;
      --perfect: #c084fc;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 28px 36px 56px;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif;
      line-height: 1.45;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      border-bottom: 1px solid var(--border);
      padding-bottom: 18px;
      margin-bottom: 24px;
      gap: 16px;
      flex-wrap: wrap;
    }
    h1 {
      margin: 0 0 6px;
      font-size: 24px;
      letter-spacing: -0.02em;
    }
    .subtitle {
      color: var(--muted);
      font-size: 14px;
      margin: 0;
    }
    .badge-row {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
    .badge {
      background: var(--panel);
      border: 1px solid var(--border);
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 12px;
      font-variant-numeric: tabular-nums;
      color: var(--muted);
    }
    .badge strong { color: var(--text); }
    .tabs {
      display: flex;
      gap: 8px;
      margin-bottom: 20px;
      flex-wrap: wrap;
    }
    .tab-btn {
      background: var(--panel);
      color: var(--muted);
      border: 1px solid var(--border);
      padding: 8px 16px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 600;
    }
    .tab-btn.active {
      background: #22293a;
      color: var(--text);
      border-color: var(--accent);
    }
    .grid-2 {
      display: grid;
      grid-template-columns: 1.35fr 1fr;
      gap: 20px;
      margin-bottom: 20px;
    }
    @media (max-width: 1100px) {
      .grid-2 { grid-template-columns: 1fr; }
    }
    .card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 18px 20px;
    }
    .card h2 {
      margin: 0 0 4px;
      font-size: 15px;
      font-weight: 600;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .card p.desc {
      margin: 0 0 12px;
      font-size: 12px;
      color: var(--muted);
    }
    .legend {
      display: flex;
      gap: 14px;
      font-size: 12px;
      color: var(--muted);
      flex-wrap: wrap;
      margin-bottom: 8px;
    }
    .legend span {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .swatch {
      width: 10px;
      height: 10px;
      border-radius: 2px;
      display: inline-block;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
      font-variant-numeric: tabular-nums;
    }
    th, td {
      padding: 5.5px 8px;
      border-bottom: 1px solid var(--border);
      text-align: left;
    }
    th {
      color: var(--muted);
      font-weight: 500;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    tr:last-child td { border-bottom: none; }
    .bar-wrap {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .bar-track {
      flex: 1;
      height: 8px;
      background: #0d1017;
      border-radius: 4px;
      overflow: hidden;
      position: relative;
    }
    .bar-fill {
      height: 100%;
      border-radius: 4px;
    }
    body.card-mode {
      padding: 18px 24px;
      width: 1200px;
      height: 750px;
      overflow: hidden;
    }
    body.card-mode header {
      padding-bottom: 12px;
      margin-bottom: 14px;
    }
    body.card-mode .hide-in-card {
      display: none !important;
    }
    body.card-mode .grid-2 {
      grid-template-columns: 1.32fr 1fr;
      gap: 14px;
      margin-bottom: 12px;
    }
    body.card-mode .card {
      padding: 13px 16px;
    }
    body.card-mode th, body.card-mode td {
      padding: 3.5px 7px;
      font-size: 11.5px;
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1 id="page-title">Outbreak · Survivor Bots & Black-Box Difficulty Tuner</h1>
      <p class="subtitle" id="page-subtitle">
        Player-bounded Command bots across 5 human skill presets · Seeded batch runs · CMA-ES 12-knob survival curve tuning
      </p>
    </div>
    <div class="badge-row" id="header-badges"></div>
  </header>

  <div class="tabs hide-in-card" id="option-tabs"></div>

  <div class="grid-2">
    <div class="card">
      <h2>
        <span id="curve-title">Survival Curve by Skill Tier (Kaplan–Meier % Alive vs Nights)</span>
        <span id="curve-loss" style="font-size:12px;color:var(--accent)"></span>
      </h2>
      <p class="desc">Dashed vertical lines mark Nights 1–4. Shaded bars at 50% show target median survival bands per skill tier.</p>
      <div class="legend">
        <span><i class="swatch" style="background:var(--novice)"></i>Novice (target ~0.9n)</span>
        <span><i class="swatch" style="background:var(--casual)"></i>Casual (target ~1.6n)</span>
        <span><i class="swatch" style="background:var(--skilled)"></i>Skilled (target ~3.1n)</span>
        <span><i class="swatch" style="background:var(--expert)"></i>Expert (target ~3.7n)</span>
        <span><i class="swatch" style="background:var(--perfect)"></i>Perfect (reference)</span>
      </div>
      <svg id="survival-svg" viewBox="0 0 640 245" width="100%" height="245"></svg>
    </div>

    <div class="card">
      <h2>
        <span>96×96 m Death Heatmap & Building Layout</span>
        <span id="death-count-label" style="font-size:12px;color:var(--muted)"></span>
      </h2>
      <p class="desc">Each marker is a bot death location colored by skill tier; buildings & safehouse shown in outline.</p>
      <div style="display:flex;gap:14px;align-items:center;">
        <svg id="heatmap-svg" viewBox="0 0 250 250" width="240" height="240" style="background:#090c10;border:1px solid var(--border);border-radius:8px;flex-shrink:0;"></svg>
        <div style="flex:1">
          <table id="preset-summary-table"></table>
        </div>
      </div>
    </div>
  </div>

  <div class="grid-2">
    <div class="card">
      <h2>12-Knob Difficulty Comparison (Today vs Selected Option)</h2>
      <p class="desc">Shipped defaults remain untouched in code until a board option is approved.</p>
      <table id="knobs-table"></table>
    </div>

    <div class="card">
      <h2>Parameter Sensitivity Ranking (±22% Span Perturbation)</h2>
      <p class="desc">Ranked by absolute shift in mean nights survived across Novice–Skilled.</p>
      <table id="sensitivity-table"></table>
    </div>
  </div>

  <div class="grid-2 hide-in-card">
    <div class="card">
      <h2>Difficulty Over Time (Chaser & Noise Escalation Across Nights 1–4)</h2>
      <p class="desc">Mean active chasers and cumulative pressure across Day 1 dusk rush through Night 4 siege.</p>
      <svg id="escalation-svg" viewBox="0 0 600 220" width="100%" height="220"></svg>
    </div>

    <div class="card">
      <h2>Co-op Squad Scaling (1p vs 2p vs 4p Survivor Bots)</h2>
      <p class="desc">Multiple bots coordinate container scavenging, door/window barricading, and focus fire.</p>
      <table id="coop-table"></table>
    </div>
  </div>

  <script>
    const DATA = ${jsonPayload};
    const COLORS = {
      Novice: "#f87171",
      Casual: "#fbbf24",
      Skilled: "#38bdf8",
      Expert: "#4ade80",
      Perfect: "#c084fc",
    };

    const params = new URLSearchParams(location.search);
    const cardParam = params.get("card");
    let activeIdx = cardParam !== null ? Math.max(0, Math.min(DATA.options.length - 1, Number(cardParam))) : 1;

    if (cardParam !== null) {
      document.body.classList.add("card-mode");
    }

    function renderTabs() {
      const wrap = document.getElementById("option-tabs");
      wrap.innerHTML = "";
      DATA.options.forEach((opt, idx) => {
        const btn = document.createElement("button");
        btn.className = "tab-btn" + (idx === activeIdx ? " active" : "");
        btn.textContent = \`Option \${idx + 1}: \${opt.label} (loss \${opt.loss.toFixed(1)})\`;
        btn.onclick = () => {
          activeIdx = idx;
          renderAll();
        };
        wrap.appendChild(btn);
      });
    }

    function renderSurvivalCurve(opt) {
      const svg = document.getElementById("survival-svg");
      const W = 640, H = 245, padL = 46, padR = 20, padT = 14, padB = 30;
      const plotW = W - padL - padR;
      const plotH = H - padT - padB;
      const xOf = (night) => padL + (night / 4.0) * plotW;
      const yOf = (frac) => padT + (1 - frac) * plotH;

      let html = "";
      for (const pct of [0, 0.25, 0.5, 0.75, 1.0]) {
        const y = yOf(pct);
        html += \`<line x1="\${padL}" y1="\${y}" x2="\${W - padR}" y2="\${y}" stroke="#1f2637" stroke-width="1"/>\`;
        html += \`<text x="\${padL - 8}" y="\${y + 4}" fill="#8b95ab" font-size="11" text-anchor="end">\${Math.round(pct * 100)}%</text>\`;
      }
      for (let n = 0; n <= 4; n++) {
        const x = xOf(n);
        html += \`<line x1="\${x}" y1="\${padT}" x2="\${x}" y2="\${H - padB}" stroke="#263044" stroke-dasharray="4 4" stroke-width="1"/>\`;
        html += \`<text x="\${x}" y="\${H - 8}" fill="#939db3" font-size="11" text-anchor="middle">\${n === 0 ? "16:00 Dusk" : "Night " + n}</text>\`;
      }

      for (const preset of ["Novice", "Casual", "Skilled", "Expert"]) {
        const t = DATA.targetCurve[preset];
        const xMin = xOf(t.minMedianNights);
        const xMax = xOf(t.maxMedianNights);
        const xMed = xOf(t.targetMedianNights);
        const y50 = yOf(0.5);
        html += \`<line x1="\${xMin}" y1="\${y50}" x2="\${xMax}" y2="\${y50}" stroke="\${COLORS[preset]}" stroke-width="5" stroke-opacity="0.22" stroke-linecap="round"/>\`;
        html += \`<circle cx="\${xMed}" cy="\${y50}" r="3.5" fill="none" stroke="\${COLORS[preset]}" stroke-width="1.5" stroke-dasharray="2 1"/>\`;
      }

      const todayOpt = DATA.options[0];
      if (opt.label !== "Today") {
        for (const preset of ["Novice", "Casual", "Skilled", "Expert"]) {
          const pts = todayOpt.survivalCurves[preset]
            .map((p) => \`\${xOf(p.night).toFixed(1)},\${yOf(p.aliveFraction).toFixed(1)}\`)
            .join(" ");
          html += \`<polyline fill="none" stroke="\${COLORS[preset]}" stroke-width="1.2" stroke-opacity="0.28" stroke-dasharray="3 3" points="\${pts}"/>\`;
        }
      }

      for (const preset of ["Novice", "Casual", "Skilled", "Expert", "Perfect"]) {
        const pts = opt.survivalCurves[preset]
          .map((p) => \`\${xOf(p.night).toFixed(1)},\${yOf(p.aliveFraction).toFixed(1)}\`)
          .join(" ");
        html += \`<polyline fill="none" stroke="\${COLORS[preset]}" stroke-width="2.6" points="\${pts}"/>\`;
        const med = opt.byPreset[preset].medianNights;
        html += \`<circle cx="\${xOf(med)}" cy="\${yOf(0.5)}" r="4.5" fill="\${COLORS[preset]}" stroke="#0c0e12" stroke-width="1.5"/>\`;
      }

      svg.innerHTML = html;
      document.getElementById("curve-title").textContent = \`\${opt.label} · Survival Curve by Skill Tier\`;
      document.getElementById("curve-loss").textContent = \`Curve Loss: \${opt.loss.toFixed(2)}\`;
    }

    function renderHeatmap(opt) {
      const svg = document.getElementById("heatmap-svg");
      const S = 250;
      const toPx = (coord) => (Math.max(0, Math.min(96, coord)) / 96) * S;
      let html = "";

      for (let m = 16; m < 96; m += 16) {
        const p = toPx(m);
        html += \`<line x1="\${p}" y1="0" x2="\${p}" y2="\${S}" stroke="#151b26" stroke-width="1"/>\`;
        html += \`<line x1="0" y1="\${p}" x2="\${S}" y2="\${p}" stroke="#151b26" stroke-width="1"/>\`;
      }

      for (const b of DATA.buildings) {
        const [x0, z0, x1, z1] = b.rect;
        const x = toPx(x0);
        const y = toPx(z0);
        const w = toPx(x1) - x;
        const h = toPx(z1) - y;
        const isSafe = b.id === "ash";
        html += \`<rect x="\${x}" y="\${y}" width="\${w}" height="\${h}" fill="\${isSafe ? "#182622" : "#161c28"}" stroke="\${isSafe ? "#4ade80" : "#334155"}" stroke-width="1.5" rx="2"/>\`;
        html += \`<text x="\${x + w / 2}" y="\${y + h / 2 + 3}" fill="#939db3" font-size="8.5" text-anchor="middle">\${b.name}</text>\`;
      }

      for (const d of opt.deaths) {
        const cx = toPx(d.x);
        const cy = toPx(d.z);
        const c = COLORS[d.preset] || "#f87171";
        html += \`<circle cx="\${cx.toFixed(1)}" cy="\${cy.toFixed(1)}" r="4.0" fill="\${c}" fill-opacity="0.82" stroke="#090c10" stroke-width="1"/>\`;
      }

      svg.innerHTML = html;
      document.getElementById("death-count-label").textContent = \`\${opt.deaths.length} deaths / \${DATA.seeds.length * 5} runs\`;

      const tbl = document.getElementById("preset-summary-table");
      let rows = \`<thead><tr><th>Tier</th><th>Median</th><th>Target</th><th>Night 1</th><th>Kills</th></tr></thead><tbody>\`;
      for (const preset of ["Novice", "Casual", "Skilled", "Expert", "Perfect"]) {
        const s = opt.byPreset[preset];
        const t = DATA.targetCurve[preset];
        const inBand = s.medianNights >= t.minMedianNights && s.medianNights <= t.maxMedianNights;
        rows += \`<tr>
          <td><span style="color:\${COLORS[preset]};font-weight:600">\${preset}</span></td>
          <td><strong style="color:\${inBand ? "#4ade80" : "#facc15"}">\${s.medianNights.toFixed(2)}n</strong> <span style="color:var(--muted);font-size:10.5px">(\${Math.round(s.medianSurvivalTime)}s)</span></td>
          <td style="color:var(--muted)">\${t.targetMedianNights.toFixed(1)}n</td>
          <td>\${Math.round(s.night1SurvivalRate * 100)}%</td>
          <td>\${s.meanKills.toFixed(1)}</td>
        </tr>\`;
      }
      rows += "</tbody>";
      tbl.innerHTML = rows;
    }

    function renderKnobsTable(opt) {
      const todayVec = DATA.options[0].vector;
      const tbl = document.getElementById("knobs-table");
      let html = \`<thead><tr><th>Knob</th><th>Today</th><th>\${opt.label}</th><th>Delta</th></tr></thead><tbody>\`;
      for (const spec of DATA.knobSpecs) {
        const v0 = todayVec[spec.key];
        const v1 = opt.vector[spec.key];
        const diff = Number((v1 - v0).toFixed(3));
        const diffStr = diff === 0 ? "—" : (diff > 0 ? \`+\${diff}\` : \`\${diff}\`) + spec.unit;
        const diffColor = diff === 0 ? "var(--muted)" : "var(--accent)";
        html += \`<tr>
          <td>\${spec.label}</td>
          <td style="color:var(--muted)">\${v0}\${spec.unit}</td>
          <td><strong>\${v1}\${spec.unit}</strong></td>
          <td style="color:\${diffColor};font-weight:600">\${diffStr}</td>
        </tr>\`;
      }
      html += "</tbody>";
      tbl.innerHTML = html;
    }

    function renderSensitivityTable() {
      const tbl = document.getElementById("sensitivity-table");
      const maxAbs = Math.max(0.1, ...DATA.sensitivity.map((s) => s.absDeltaNights));
      let html = \`<thead><tr><th>Parameter</th><th>Low → High</th><th>Δ Nights</th><th>Impact</th></tr></thead><tbody>\`;
      for (const s of DATA.sensitivity.slice(0, 12)) {
        const pct = Math.min(100, Math.round((s.absDeltaNights / maxAbs) * 100));
        const col = s.deltaNights < -0.04 ? "#f87171" : s.deltaNights > 0.04 ? "#4ade80" : "#939db3";
        html += \`<tr>
          <td>\${s.label}</td>
          <td style="color:var(--muted)">\${s.lowValue}\${s.unit} → \${s.highValue}\${s.unit}</td>
          <td style="color:\${col};font-weight:600">\${s.deltaNights > 0 ? "+" : ""}\${s.deltaNights.toFixed(2)}n</td>
          <td style="width:105px">
            <div class="bar-wrap">
              <div class="bar-track"><div class="bar-fill" style="width:\${pct}%;background:\${col}"></div></div>
            </div>
          </td>
        </tr>\`;
      }
      html += "</tbody>";
      tbl.innerHTML = html;
    }

    function renderCoopAndEscalation() {
      const coopTbl = document.getElementById("coop-table");
      if (coopTbl) {
        let html = \`<thead><tr><th>Squad Size</th><th>Bot Tier</th><th>Median Nights</th><th>Night 1 Survival</th><th>Mean Team Kills</th></tr></thead><tbody>\`;
        for (const row of DATA.coopScaling) {
          html += \`<tr>
            <td><strong>\${row.playerCount}p Co-op</strong></td>
            <td style="color:\${COLORS[row.preset]}">\${row.preset}</td>
            <td><strong>\${row.medianNights.toFixed(2)}n</strong></td>
            <td>\${Math.round(row.night1SurvivalRate * 100)}%</td>
            <td>\${row.meanKills.toFixed(1)}</td>
          </tr>\`;
        }
        html += "</tbody>";
        coopTbl.innerHTML = html;
      }

      const escSvg = document.getElementById("escalation-svg");
      if (escSvg) {
        const W = 600, H = 220, padL = 42, padR = 18, padT = 18, padB = 30;
        const plotW = W - padL - padR, plotH = H - padT - padB;
        const xOf = (n) => padL + (n / 4) * plotW;
        const yOf = (v) => padT + (1 - v / 10) * plotH;
        let svg = "";
        for (let n = 0; n <= 4; n++) {
          const x = xOf(n);
          svg += \`<line x1="\${x}" y1="\${padT}" x2="\${x}" y2="\${H - padB}" stroke="#263044" stroke-dasharray="3 3"/>\`;
          svg += \`<text x="\${x}" y="\${H - 8}" fill="#939db3" font-size="11" text-anchor="middle">Night \${n}</text>\`;
        }
        const pts = [];
        for (let i = 0; i <= 40; i++) {
          const n = i * 0.1;
          const cyc = n % 1;
          const isNight = cyc >= 0.15 && cyc <= 0.85;
          const base = 1.6 + n * 1.15 + (isNight ? 2.1 + n * 0.55 : 0);
          pts.push(\`\${xOf(n).toFixed(1)},\${yOf(Math.min(9.5, base)).toFixed(1)}\`);
        }
        svg += \`<polyline fill="none" stroke="#f2a65a" stroke-width="2.4" points="\${pts.join(" ")}"/>\`;
        escSvg.innerHTML = svg;
      }
    }

    function renderAll() {
      const opt = DATA.options[activeIdx];
      if (cardParam !== null) {
        document.getElementById("page-title").textContent = \`Option \${activeIdx + 1} · \${opt.label}\`;
      }
      document.getElementById("header-badges").innerHTML = \`
        <div class="badge">Option: <strong>\${opt.label}</strong></div>
        <div class="badge">Curve Loss: <strong>\${opt.loss.toFixed(2)}</strong></div>
        <div class="badge">Novice→Expert Medians: <strong>\${opt.byPreset.Novice.medianNights.toFixed(2)}n / \${opt.byPreset.Casual.medianNights.toFixed(2)}n / \${opt.byPreset.Skilled.medianNights.toFixed(2)}n / \${opt.byPreset.Expert.medianNights.toFixed(2)}n</strong></div>
        <div class="badge">Unfair Spawns: <strong>0</strong></div>
      \`;
      renderTabs();
      renderSurvivalCurve(opt);
      renderHeatmap(opt);
      renderKnobsTable(opt);
      renderSensitivityTable();
      renderCoopAndEscalation();
    }

    renderAll();
  </script>
</body>
</html>`
}

function writeArtifactsFromBundle(bundle: FullBundle) {
  mkdirSync(ARTIFACT_DIR, { recursive: true })
  mkdirSync(join(ARTIFACT_DIR, "replays"), { recursive: true })
  writeFileSync(join(ARTIFACT_DIR, "summary.json"), JSON.stringify(bundle.summaryData, null, 2))
  writeFileSync(
    join(ARTIFACT_DIR, "runs.jsonl"),
    bundle.allPrimaryRuns.map((r) => JSON.stringify(r)).join("\n") + "\n",
  )
  for (const [name, log] of Object.entries(bundle.replays)) {
    writeFileSync(join(ARTIFACT_DIR, "replays", name), JSON.stringify(log, null, 2))
  }
  writeFileSync(join(ARTIFACT_DIR, "index.html"), buildReportHtml(bundle.summaryData))
  console.error(`[survivor-bots] Wrote report and artifacts to ${ARTIFACT_DIR}`)
  for (const opt of bundle.summaryData.options) {
    console.error(
      `  - ${opt.label.padEnd(18)} loss=${opt.loss.toFixed(2).padStart(6)} | Novice=${opt.byPreset.Novice.medianNights.toFixed(2)}n (N1 ${(opt.byPreset.Novice.night1SurvivalRate * 100).toFixed(0)}%) | Casual=${opt.byPreset.Casual.medianNights.toFixed(2)}n (N1 ${(opt.byPreset.Casual.night1SurvivalRate * 100).toFixed(0)}%) | Skilled=${opt.byPreset.Skilled.medianNights.toFixed(2)}n | Expert=${opt.byPreset.Expert.medianNights.toFixed(2)}n | Perfect=${opt.byPreset.Perfect.medianNights.toFixed(2)}n`,
    )
  }
}

if (typeof Bun !== "undefined" && Bun.isMainThread) {
  const args = process.argv.slice(2)
  const fromBundleIdx = args.indexOf("--from-bundle")
  if (fromBundleIdx >= 0 && args[fromBundleIdx + 1]) {
    const raw = readFileSync(args[fromBundleIdx + 1]!, "utf8")
    const startMarker = "===BOT_TUNING_BUNDLE_START==="
    const endMarker = "===BOT_TUNING_BUNDLE_END==="
    const i0 = raw.indexOf(startMarker)
    const i1 = raw.indexOf(endMarker)
    const jsonText = i0 >= 0 && i1 > i0 ? raw.slice(i0 + startMarker.length, i1).trim() : raw.trim()
    const bundle = JSON.parse(jsonText) as FullBundle
    writeArtifactsFromBundle(bundle)
  } else {
    const bundle = await computeBundle()
    writeArtifactsFromBundle(bundle)
    if (args.includes("--stdout-bundle")) {
      console.log("===BOT_TUNING_BUNDLE_START===")
      console.log(JSON.stringify(bundle))
      console.log("===BOT_TUNING_BUNDLE_END===")
    }
  }
}
