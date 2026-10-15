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
import {
  analyzeRunBranchingTimeline,
  runHeadlessBotGame,
  type BotReplayLog,
  type BotRunResult,
  type BotRunTimeSample,
  type BotRunTimelineEvent,
  type RunBranchingAnalysis,
  type RunPacingMetrics,
} from "../shared/bot-runner"
import {
  DEFAULT_DIFFICULTY_VECTOR,
  DEFAULT_PACING_TARGETS,
  DIFFICULTY_KNOB_SPECS,
  PACING_TARGET_SPECS,
  TARGET_SURVIVAL_CURVE,
  computeDifficultyLossBreakdown,
  difficultyToSimTunings,
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
    const pacingTargets = { ...DEFAULT_PACING_TARGETS, ...options.pacingTargets }
    const lossBreakdown = computeDifficultyLossBreakdown(byPreset, pacingTargets)
    return {
      label: options.label,
      vector,
      loss: lossBreakdown.total,
      lossBreakdown,
      pacingTargets,
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
  const generations = 3
  const lambda = 5
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
  lossBreakdown: ev.lossBreakdown,
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
      deathWarningSeconds: r.pacing.deathWarningSeconds,
      warnedDeath: r.pacing.warnedDeath,
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

type ReviewableRunBundle = {
  id: string
  title: string
  optionLabel: string
  seed: number
  preset: BotSkillPresetId
  presetIndex: number
  survived: boolean
  survivalTime: number
  nightsSurvived: number
  causeOfDeath: string
  deathPosition: BotRunResult["deathPosition"]
  killsByWeapon: BotRunResult["killsByWeapon"]
  damageTaken: number
  ammoUsed: BotRunResult["ammoUsed"]
  itemsLooted: BotRunResult["itemsLooted"]
  itemsCrafted: BotRunResult["itemsCrafted"]
  pacing: RunPacingMetrics
  timeline: BotRunTimelineEvent[]
  series: BotRunTimeSample[]
  branching: RunBranchingAnalysis
}

const PURITY_AUDIT = [
  {
    subsystem: "CoopSim & Seeded PRNG (coop-sim.ts, @arcade/kit/sim/rng.ts)",
    impurity: "Rng state s was private with no getter/setter, and CoopSim lacked an explicit top-level rngState / rolloutSeedMix field or pure stepSim(state, inputs, dt) -> state transition.",
    fix: "Added Rng.getState() / setState() / clone(), added SimState with rngState + rolloutSeedMix, and implemented pure stepSim(state, inputs, dt) -> state, toSnapshot(), restoreSnapshot(), forkSimState(), hashSimState(), and diffSimState().",
  },
  {
    subsystem: "JSON Serialization of Non-Finite Timestamps (-Infinity / Infinity)",
    impurity: "Portal lastBashTime, survivor meleeComboUntil / lootMessageUntil, vehicle lastBangAt / lastCrashAt / lastSputterAt, and bot threatMemory.lastSeenAt used -Infinity / Infinity, which JSON.stringify turns into null (coerced to 0 in arithmetic now - null).",
    fix: "Added lossless Infinity / -Infinity JSON replacer/reviver in saveSimState / loadSimState / cloneSimState / hashSimState, normalized null timestamps on restore, and replaced -Infinity with -1e9 in threatMemory.",
  },
  {
    subsystem: "OutbreakCombatSubsystem WeakMaps (combat.ts)",
    impurity: "activeSwings and wearRemainder lived in WeakMap<object, ...> keyed by mutable Survivor object references, and nextShotId / nextMeleeId were private counters lost across snapshots.",
    fix: "Added OutbreakCombatSnapshot serializing activeSwingsByActor, wearRemainderByActor, nextShotId, nextMeleeId, shots, and meleeSwings, rebinding WeakMap entries to restored SurvivorSlot instances.",
  },
  {
    subsystem: "OutbreakAISubsystem, NoiseBus & OutbreakPacingDirector (ai.ts, pacing.ts)",
    impurity: "nextAgentId, manualSpawnOnly, NoiseBus.nextId, and OutbreakPacingDirector's private spawnOrigins, prevPositions, lastNoiseId, reinforceCooldown, and waveCooldown were hidden mutable state; wander/spawn RNGs depended only on tick.",
    fix: "Added snapshot() / restore() on NoiseBus, OutbreakPacingDirector, and OutbreakAISubsystem, and mixed rngSeedMix into zombie wander and backstage trickle/wave RNGs so forked rollouts branch cleanly.",
  },
  {
    subsystem: "OutbreakProgression & Ledger (progression.ts, @arcade/kit/sim/ledger.ts)",
    impurity: "Ledger.snapshot() omitted in-flight timed channels (search, craft, research, heal, barricade) and removedStores, and Ledger.restore() cleared active channels; OutbreakProgression had private nextId, generatorAt Map, and actorOf WeakMap.",
    fix: "Extended LedgerSnapshot to serialize and restore active channels and removedStores; added OutbreakProgressionSnapshot capturing tuning, nextId, generatorAt, pings, lures, searched containers, and actorOf rebinding.",
  },
  {
    subsystem: "OutbreakVehicleSubsystem & Module Scratch (vehicles.ts, vehicles/index.ts)",
    impurity: "nextCustomId, lastEngineNoiseAt, lastHornNoiseAt, and actorOf WeakMap were private on OutbreakVehicleSubsystem; vehicles/index.ts held a module-scope mutable encodeSlotIndexById Map.",
    fix: "Added OutbreakVehicleSnapshot and snapshot() / restore() on OutbreakVehicleSubsystem; moved encodeSlotIndexById inside collect().",
  },
  {
    subsystem: "StreamingWorld & SurvivorBot Local Nav (world.ts, survivor-bot.ts)",
    impurity: "StreamingWorld had private centers and unserialized active chunk keys / navTiles state; SurvivorBot built localNav from door-dependent solidRects(town) and reset repathAt = 0 on restore.",
    fix: "Added StreamingWorldSnapshot (including hasNavTiles) and BotStateSnapshot; made SurvivorBot.localNav build from door-invariant static solids + door portals without clobbering repathAt on snapshot restore.",
  },
] as const

type SummaryPayload = {
  generatedAt: string
  seeds: number[]
  maxDurationSeconds: number
  timeScale: number
  targetCurve: typeof TARGET_SURVIVAL_CURVE
  pacingTargetSpecs: typeof PACING_TARGET_SPECS
  defaultPacingTargets: typeof DEFAULT_PACING_TARGETS
  skillPresets: typeof BOT_SKILL_PRESETS
  knobSpecs: typeof DIFFICULTY_KNOB_SPECS
  buildings: typeof MAP_BUILDINGS
  purityAudit: typeof PURITY_AUDIT
  options: ReturnType<typeof stripRuns>[]
  reviewableRuns: ReviewableRunBundle[]
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
  allPrimaryRuns: Omit<BotRunResult, "replay" | "checkpoints">[]
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
        tickDt: 1 / 15,
        recordReplayForSeed: EVAL_SEEDS[0],
      }),
      pool.evaluate({
        label: "Balanced Curve",
        vector: cmaResult.best.vector,
        seeds: EVAL_SEEDS,
        presets: BOT_SKILL_PRESET_ORDER,
        maxDurationSeconds: MAX_DURATION_S,
        timeScale: TIME_SCALE,
        tickDt: 1 / 15,
        recordReplayForSeed: EVAL_SEEDS[0],
      }),
      pool.evaluate({
        label: "Gentle Opening",
        vector: gentleOpeningVector,
        seeds: EVAL_SEEDS,
        presets: BOT_SKILL_PRESET_ORDER,
        maxDurationSeconds: MAX_DURATION_S,
        timeScale: TIME_SCALE,
        tickDt: 1 / 15,
        recordReplayForSeed: EVAL_SEEDS[0],
      }),
      pool.evaluate({
        label: "Relentless Siege",
        vector: relentlessSiegeVector,
        seeds: EVAL_SEEDS,
        presets: BOT_SKILL_PRESET_ORDER,
        maxDurationSeconds: MAX_DURATION_S,
        timeScale: TIME_SCALE,
        tickDt: 1 / 15,
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
        tickDt: 1 / 15,
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
          tickDt: 1 / 15,
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

    console.error(`[survivor-bots] Computing featured reviewable runs & N-rollout branching timelines...`)
    const featuredSpecs: {
      id: string
      title: string
      optionLabel: string
      vector: DifficultyVector
      seed: number
      preset: BotSkillPresetId
      presetIndex: number
      checkpointEvery: number
    }[] = [
      {
        id: "today-casual-101",
        title: "Today · Casual (seed 101) — Night 1 Overrun",
        optionLabel: "Today",
        vector: DEFAULT_DIFFICULTY_VECTOR,
        seed: 101,
        preset: "Casual",
        presetIndex: 1,
        checkpointEvery: 25,
      },
      {
        id: "balanced-casual-101",
        title: "Balanced Curve · Casual (seed 101) — Paced Night 1→2",
        optionLabel: "Balanced Curve",
        vector: evalBalanced.vector,
        seed: 101,
        preset: "Casual",
        presetIndex: 1,
        checkpointEvery: 45,
      },
      {
        id: "balanced-skilled-107",
        title: "Balanced Curve · Skilled (seed 107) — Multi-Night L4D Waves",
        optionLabel: "Balanced Curve",
        vector: evalBalanced.vector,
        seed: 107,
        preset: "Skilled",
        presetIndex: 2,
        checkpointEvery: 60,
      },
    ]

    const reviewableRuns: ReviewableRunBundle[] = []
    for (const fSpec of featuredSpecs) {
      const tunings = difficultyToSimTunings(fSpec.vector)
      const fullRun = runHeadlessBotGame({
        seed: fSpec.seed,
        preset: fSpec.preset,
        maxDurationSeconds: 360,
        timeScale: TIME_SCALE,
        tickDt: 1 / 15,
        aiConfig: tunings.aiConfig,
        progressionTuning: tunings.progressionTuning,
        configLabel: fSpec.optionLabel,
        captureCheckpointsEverySeconds: fSpec.checkpointEvery,
        recordReplay: true,
      })
      const branching = analyzeRunBranchingTimeline(fullRun, {
        rolloutSeeds: [11, 29, 53],
        presets: ["Novice", "Casual", "Skilled", "Expert"],
        horizonSeconds: 120,
        maxAbsoluteSeconds: 360,
        timeScale: TIME_SCALE,
        tickDt: 1 / 12,
      })
      reviewableRuns.push({
        id: fSpec.id,
        title: fSpec.title,
        optionLabel: fSpec.optionLabel,
        seed: fSpec.seed,
        preset: fSpec.preset,
        presetIndex: fSpec.presetIndex,
        survived: fullRun.survived,
        survivalTime: fullRun.survivalTime,
        nightsSurvived: fullRun.nightsSurvived,
        causeOfDeath: fullRun.causeOfDeath,
        deathPosition: fullRun.deathPosition,
        killsByWeapon: fullRun.killsByWeapon,
        damageTaken: fullRun.damageTaken,
        ammoUsed: fullRun.ammoUsed,
        itemsLooted: fullRun.itemsLooted,
        itemsCrafted: fullRun.itemsCrafted,
        pacing: fullRun.pacing,
        timeline: fullRun.timeline,
        series: fullRun.series,
        branching,
      })
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
    ].map(({ replay: _replay, checkpoints: _checkpoints, ...rest }) => rest)

    const summaryData: SummaryPayload = {
      generatedAt: new Date().toISOString(),
      seeds: EVAL_SEEDS,
      maxDurationSeconds: MAX_DURATION_S,
      timeScale: TIME_SCALE,
      targetCurve: TARGET_SURVIVAL_CURVE,
      pacingTargetSpecs: PACING_TARGET_SPECS,
      defaultPacingTargets: DEFAULT_PACING_TARGETS,
      skillPresets: BOT_SKILL_PRESETS,
      knobSpecs: DIFFICULTY_KNOB_SPECS,
      buildings: MAP_BUILDINGS,
      purityAudit: PURITY_AUDIT,
      options: [
        stripRuns(evalToday),
        stripRuns(evalBalanced),
        stripRuns(evalGentle),
        stripRuns(evalRelentless),
      ],
      reviewableRuns,
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
  <title>Outbreak · Pure Sim, Branching Rollouts & L4D Pacing Tuner</title>
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
      gap: 8px;
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
    .replay-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: #1d283a;
      color: #38bdf8;
      border: 1px solid #2b4466;
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      text-decoration: none;
      cursor: pointer;
    }
    .replay-btn:hover {
      background: #24344d;
      border-color: #38bdf8;
    }
    .decisive-box {
      background: rgba(248, 113, 113, 0.08);
      border: 1px solid rgba(248, 113, 113, 0.35);
      border-radius: 8px;
      padding: 10px 14px;
      margin-bottom: 12px;
      font-size: 12px;
    }
    .knob-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
      gap: 10px 16px;
      margin-bottom: 14px;
    }
    .knob-item {
      background: var(--panel-alt);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 7px 10px;
      font-size: 11.5px;
    }
    .knob-item label {
      display: flex;
      justify-content: space-between;
      color: var(--muted);
      margin-bottom: 4px;
    }
    .knob-item label strong {
      color: var(--text);
      font-variant-numeric: tabular-nums;
    }
    .knob-item input[type="range"] {
      width: 100%;
      accent-color: var(--accent);
    }
    body.card-mode {
      padding: 12px 20px;
      width: 1200px;
      height: 850px;
      overflow: hidden;
    }
    body.card-mode header {
      padding-bottom: 8px;
      margin-bottom: 10px;
    }
    body.card-mode h1 {
      font-size: 20px;
      margin-bottom: 2px;
    }
    body.card-mode .subtitle {
      font-size: 12px;
    }
    body.card-mode .hide-in-card {
      display: none !important;
    }
    body.card-mode .grid-2 {
      grid-template-columns: 1.32fr 1fr;
      gap: 10px;
      margin-bottom: 8px;
    }
    body.card-mode .card {
      padding: 9px 13px;
    }
    body.card-mode .card h2 {
      font-size: 13.5px;
      margin-bottom: 2px;
    }
    body.card-mode .card p.desc {
      margin-bottom: 6px;
      font-size: 11px;
    }
    body.card-mode #survival-svg {
      height: 195px !important;
    }
    body.card-mode #heatmap-svg {
      width: 185px !important;
      height: 185px !important;
    }
    body.card-mode th, body.card-mode td {
      padding: 2.2px 6px;
      font-size: 10.5px;
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1 id="page-title">Outbreak · Pure Sim, Branching Rollouts & L4D Pacing Tuner</h1>
      <p class="subtitle" id="page-subtitle">
        Pure step(state, inputs, dt) → state · Snapshot fork & N-rollout survival curves · Left 4 Dead tension/relaxation targets
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
        <span><i class="swatch" style="background:var(--novice)"></i>Novice (target ~0.55n)</span>
        <span><i class="swatch" style="background:var(--casual)"></i>Casual (target ~1.6n)</span>
        <span><i class="swatch" style="background:var(--skilled)"></i>Skilled (target ~3.1n)</span>
        <span><i class="swatch" style="background:var(--expert)"></i>Expert (target ~3.7n)</span>
        <span><i class="swatch" style="background:var(--perfect)"></i>Perfect (reference)</span>
      </div>
      <svg id="survival-svg" viewBox="0 0 640 245" width="100%" height="245"></svg>
    </div>

    <div class="card">
      <h2>
        <span>96×96 m Death Heatmap & L4D Pacing Summary</span>
        <span id="death-count-label" style="font-size:12px;color:var(--muted)"></span>
      </h2>
      <p class="desc">Each marker is a bot death location colored by skill tier; table shows survival medians + L4D pacing metrics.</p>
      <div style="display:flex;gap:14px;align-items:center;">
        <svg id="heatmap-svg" viewBox="0 0 250 250" width="230" height="230" style="background:#090c10;border:1px solid var(--border);border-radius:8px;flex-shrink:0;"></svg>
        <div style="flex:1">
          <table id="preset-summary-table"></table>
        </div>
      </div>
    </div>
  </div>

  <div class="grid-2">
    <div class="card">
      <h2>12-Knob Difficulty Comparison (Today vs Selected Option)</h2>
      <p class="desc">Shipped defaults remain untouched in code until a board option is approved on D-22.</p>
      <table id="knobs-table"></table>
    </div>

    <div class="card">
      <h2>Left 4 Dead Pacing & Loss Breakdown by Skill Tier</h2>
      <p class="desc">Tension peaks/night, relax windows (s), high-intensity time %, close calls/night, and fair warned deaths %.</p>
      <table id="pacing-tier-table"></table>
    </div>
  </div>

  <!-- Interactive Run Viewer & Fork/Rollout Branching Timeline -->
  <div class="card hide-in-card" style="margin-bottom:20px;">
    <h2>
      <span>Interactive Run Viewer · Snapshot Fork & N-Rollout Branching Timeline</span>
      <div style="display:flex;gap:8px;align-items:center;" id="run-selector-tabs"></div>
    </h2>
    <p class="desc">
      Every checkpoint captures a pure, serialisable <code>SimState</code> + <code>BotStateSnapshot</code>, clones it, and rolls out <strong>16 parallel simulations</strong> (4 seeds × 4 skill presets) to answer: <em>"From here, will they survive or die, and how often?"</em> Click any checkpoint node on the timeline to inspect that fork and replay in Outbreak at that exact second.
    </p>
    <div id="decisive-banner" class="decisive-box"></div>
    <div class="grid-2" style="margin-bottom:0;">
      <div>
        <div class="legend">
          <span><i class="swatch" style="background:#f2a65a"></i>Overall Rollout Survival %</span>
          <span><i class="swatch" style="background:var(--casual)"></i>Casual Rollout %</span>
          <span><i class="swatch" style="background:var(--skilled)"></i>Skilled Rollout %</span>
          <span><i class="swatch" style="background:var(--expert)"></i>Expert Rollout %</span>
          <span><i class="swatch" style="background:#f43f5e"></i>L4D Tension / Intensity I(t)</span>
        </div>
        <svg id="branching-timeline-svg" viewBox="0 0 680 310" width="100%" height="310" style="cursor:pointer;background:#0a0d13;border:1px solid var(--border);border-radius:8px;"></svg>
      </div>
      <div id="checkpoint-inspector" style="display:flex;flex-direction:column;gap:10px;"></div>
    </div>
  </div>

  <!-- Interactive 'Pacing targets' Lab Knobs Sandbox -->
  <div class="card hide-in-card" style="margin-bottom:20px;">
    <h2>
      <span>Interactive 'Pacing targets' Lab Knobs (Live Loss Re-Evaluation)</span>
      <button class="tab-btn" id="reset-pacing-targets-btn" style="padding:4px 10px;font-size:11.5px;">Reset to Defaults</button>
    </h2>
    <p class="desc">
      Mirrors the 11 typed knobs in Outbreak's shared Lab panel (<code>Backquote › Pacing targets</code>). Drag any target slider to re-score all 4 difficulty candidates against your survival & Left 4 Dead pacing targets in real time.
    </p>
    <div class="knob-grid" id="pacing-knobs-grid"></div>
    <table id="live-loss-comparison-table"></table>
  </div>

  <div class="grid-2 hide-in-card">
    <div class="card">
      <h2>Parameter Sensitivity Ranking (±22% Span Perturbation)</h2>
      <p class="desc">Ranked by absolute shift in mean nights survived across Novice–Skilled.</p>
      <table id="sensitivity-table"></table>
    </div>

    <div class="card">
      <h2>Co-op Squad Scaling (1p vs 2p vs 4p Survivor Bots)</h2>
      <p class="desc">Multiple bots coordinate container scavenging, door/window barricading, and focus fire.</p>
      <table id="coop-table"></table>
    </div>
  </div>

  <!-- Pure Sim Impurity Audit -->
  <div class="card hide-in-card">
    <h2>Pure, Reviewable Sim Audit · step(state, inputs, dt) → state</h2>
    <p class="desc">Every hidden/mutable state and serialization impurity found in Outbreak's shared simulation and how it was fixed.</p>
    <table id="purity-audit-table"></table>
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
    let activeRunIdx = 0;
    let activeCheckpointIdx = 0;
    const livePacingTargets = { ...DATA.defaultPacingTargets };

    if (cardParam !== null) {
      document.body.classList.add("card-mode");
    }

    function computeClientLossBreakdown(byPreset, pt) {
      const customMed = {
        Novice: pt.targetNoviceNights,
        Casual: pt.targetCasualNights,
        Skilled: pt.targetSkilledNights,
        Expert: pt.targetExpertNights,
      };
      const presets = ["Novice", "Casual", "Skilled", "Expert"];
      let survivalCurveLoss = 0, pacingFunLoss = 0, monotonicityLoss = 0, fairnessLoss = 0;
      for (const p of presets) {
        const sum = byPreset[p];
        if (!sum) continue;
        const t = DATA.targetCurve[p];
        const targetMed = customMed[p];
        const medErr = sum.medianNights - targetMed;
        const meanErr = sum.meanNights - targetMed;
        survivalCurveLoss += medErr * medErr * 14.0 + meanErr * meanErr * 8.0;
        const minBand = Math.min(t.minMedianNights, targetMed - 0.25);
        const maxBand = Math.max(t.maxMedianNights, targetMed + 0.35);
        if (sum.medianNights < minBand) survivalCurveLoss += Math.pow(minBand - sum.medianNights, 2) * 28.0;
        else if (sum.medianNights > maxBand) survivalCurveLoss += Math.pow(sum.medianNights - maxBand, 2) * 28.0;
        const n1Err = sum.night1SurvivalRate - t.targetNight1SurvivalRate;
        survivalCurveLoss += n1Err * n1Err * 10.0;
        const earlyDeathRate = 1 - sum.eveningSurvivalRate;
        if (earlyDeathRate > t.maxEarlyEveningDeathRate) {
          survivalCurveLoss += Math.pow(earlyDeathRate - t.maxEarlyEveningDeathRate, 2) * 35.0;
        }
        const tierW = p === "Casual" || p === "Skilled" ? 1.0 : 0.6;
        const peakErr = (sum.meanPeaksPerNight ?? 2) - pt.targetPeaksPerNight;
        pacingFunLoss += tierW * peakErr * peakErr * 1.8;
        const hiErr = (sum.highIntensityFraction ?? 0.25) - pt.targetHighIntensityPct / 100;
        pacingFunLoss += tierW * hiErr * hiErr * 22.0;
        if ((sum.meanMinRelaxWindowSeconds ?? 20) < pt.minRelaxWindowSeconds) {
          const def = (pt.minRelaxWindowSeconds - sum.meanMinRelaxWindowSeconds) / Math.max(5, pt.minRelaxWindowSeconds);
          pacingFunLoss += tierW * def * def * 6.0;
        }
        if ((sum.meanMaxRelaxWindowSeconds ?? 80) > pt.maxRelaxWindowSeconds) {
          const exc = (sum.meanMaxRelaxWindowSeconds - pt.maxRelaxWindowSeconds) / Math.max(20, pt.maxRelaxWindowSeconds);
          pacingFunLoss += tierW * exc * exc * 5.0;
        }
        const ccErr = (sum.meanCloseCallsPerNight ?? 1) - pt.targetCloseCallsPerNight;
        pacingFunLoss += tierW * ccErr * ccErr * 2.2;
        const targetWarn = pt.minWarnedDeathPct / 100;
        if ((sum.warnedDeathRate ?? 1) < targetWarn) {
          fairnessLoss += Math.pow(targetWarn - sum.warnedDeathRate, 2) * 24.0;
        }
        if ((sum.meanDeathWarningSeconds ?? 6) < pt.minDeathWarningSeconds) {
          fairnessLoss += Math.pow(pt.minDeathWarningSeconds - sum.meanDeathWarningSeconds, 2) * 0.8;
        }
        fairnessLoss += (sum.unfairSpawns ?? 0) * 50.0;
      }
      for (let i = 0; i < presets.length - 1; i++) {
        const lo = byPreset[presets[i]], hi = byPreset[presets[i + 1]];
        if (!lo || !hi) continue;
        const minGap = 0.35;
        if (hi.medianNights - lo.medianNights < minGap) monotonicityLoss += Math.pow(minGap - (hi.medianNights - lo.medianNights), 2) * 45.0;
        if (hi.meanNights - lo.meanNights < minGap) monotonicityLoss += Math.pow(minGap - (hi.meanNights - lo.meanNights), 2) * 35.0;
      }
      const total = survivalCurveLoss + pacingFunLoss + monotonicityLoss + fairnessLoss;
      return { total, survivalCurveLoss, pacingFunLoss, monotonicityLoss, fairnessLoss };
    }

    function renderTabs() {
      const wrap = document.getElementById("option-tabs");
      if (!wrap) return;
      wrap.innerHTML = "";
      DATA.options.forEach((opt, idx) => {
        const lb = computeClientLossBreakdown(opt.byPreset, livePacingTargets);
        const btn = document.createElement("button");
        btn.className = "tab-btn" + (idx === activeIdx ? " active" : "");
        btn.textContent = \`Option \${idx + 1}: \${opt.label} (total loss \${lb.total.toFixed(1)})\`;
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

      const customMed = {
        Novice: livePacingTargets.targetNoviceNights,
        Casual: livePacingTargets.targetCasualNights,
        Skilled: livePacingTargets.targetSkilledNights,
        Expert: livePacingTargets.targetExpertNights,
      };
      for (const preset of ["Novice", "Casual", "Skilled", "Expert"]) {
        const t = DATA.targetCurve[preset];
        const xMin = xOf(t.minMedianNights);
        const xMax = xOf(t.maxMedianNights);
        const xMed = xOf(customMed[preset]);
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

      const lb = computeClientLossBreakdown(opt.byPreset, livePacingTargets);
      svg.innerHTML = html;
      document.getElementById("curve-title").textContent = \`\${opt.label} · Survival Curve by Skill Tier\`;
      document.getElementById("curve-loss").textContent = \`Total Loss: \${lb.total.toFixed(2)} (Surv \${lb.survivalCurveLoss.toFixed(1)} · Pacing \${lb.pacingFunLoss.toFixed(1)})\`;
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
      let rows = \`<thead><tr><th>Tier</th><th>Median</th><th>Target</th><th>Night 1</th><th>Peaks/N</th><th>Warned</th></tr></thead><tbody>\`;
      for (const preset of ["Novice", "Casual", "Skilled", "Expert", "Perfect"]) {
        const s = opt.byPreset[preset];
        const t = DATA.targetCurve[preset];
        const inBand = s.medianNights >= t.minMedianNights && s.medianNights <= t.maxMedianNights;
        rows += \`<tr>
          <td><span style="color:\${COLORS[preset]};font-weight:600">\${preset}</span></td>
          <td><strong style="color:\${inBand ? "#4ade80" : "#facc15"}">\${s.medianNights.toFixed(2)}n</strong></td>
          <td style="color:var(--muted)">\${t.targetMedianNights.toFixed(1)}n</td>
          <td>\${Math.round(s.night1SurvivalRate * 100)}%</td>
          <td>\${(s.meanPeaksPerNight ?? 2).toFixed(1)}</td>
          <td style="color:#4ade80">\${Math.round((s.warnedDeathRate ?? 1) * 100)}%</td>
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

    function renderPacingTierTable(opt) {
      const tbl = document.getElementById("pacing-tier-table");
      if (!tbl) return;
      const lb = computeClientLossBreakdown(opt.byPreset, livePacingTargets);
      let html = \`<thead><tr><th>Tier</th><th>Mean / Peak I(t)</th><th>High-I %</th><th>Peaks / N</th><th>Relax Min..Max</th><th>Close Calls / N</th><th>Warned Death</th></tr></thead><tbody>\`;
      for (const preset of ["Novice", "Casual", "Skilled", "Expert", "Perfect"]) {
        const s = opt.byPreset[preset];
        html += \`<tr>
          <td><span style="color:\${COLORS[preset]};font-weight:600">\${preset}</span></td>
          <td>\${(s.meanIntensity ?? 0).toFixed(2)} / \${(s.peakIntensity ?? 0).toFixed(2)}</td>
          <td>\${Math.round((s.highIntensityFraction ?? 0) * 100)}% <span style="color:var(--muted)">(tgt \${livePacingTargets.targetHighIntensityPct}%)</span></td>
          <td>\${(s.meanPeaksPerNight ?? 0).toFixed(2)}/n</td>
          <td>\${Math.round(s.meanMinRelaxWindowSeconds ?? 0)}s..\${Math.round(s.meanMaxRelaxWindowSeconds ?? 0)}s</td>
          <td>\${(s.meanCloseCallsPerNight ?? 0).toFixed(2)}/n</td>
          <td style="color:#4ade80">\${Math.round((s.warnedDeathRate ?? 1) * 100)}% (\${(s.meanDeathWarningSeconds ?? 0).toFixed(1)}s lead)</td>
        </tr>\`;
      }
      html += \`<tr>
        <td colspan="7" style="padding-top:8px;color:var(--muted);font-size:11.5px;">
          <strong>Loss Breakdown (\${opt.label}):</strong>
          Survival Curve = <strong style="color:var(--text)">\${lb.survivalCurveLoss.toFixed(2)}</strong> ·
          L4D Pacing/Fun = <strong style="color:var(--accent)">\${lb.pacingFunLoss.toFixed(2)}</strong> ·
          Monotonicity = <strong style="color:var(--text)">\${lb.monotonicityLoss.toFixed(2)}</strong> ·
          Fairness = <strong style="color:#4ade80">\${lb.fairnessLoss.toFixed(2)}</strong> ·
          Total = <strong style="color:var(--accent)">\${lb.total.toFixed(2)}</strong>
        </td>
      </tr></tbody>\`;
      tbl.innerHTML = html;
    }

    function renderRunViewer() {
      const tabsWrap = document.getElementById("run-selector-tabs");
      if (!tabsWrap || !DATA.reviewableRuns || DATA.reviewableRuns.length === 0) return;
      tabsWrap.innerHTML = "";
      DATA.reviewableRuns.forEach((run, idx) => {
        const btn = document.createElement("button");
        btn.className = "tab-btn" + (idx === activeRunIdx ? " active" : "");
        btn.style.padding = "5px 11px";
        btn.style.fontSize = "11.5px";
        btn.textContent = run.title;
        btn.onclick = () => {
          activeRunIdx = idx;
          const cps = run.branching.checkpoints;
          activeCheckpointIdx = Math.max(0, Math.min(cps.length - 1, Math.floor(cps.length / 2)));
          renderRunViewer();
        };
        tabsWrap.appendChild(btn);
      });

      const run = DATA.reviewableRuns[activeRunIdx];
      const cps = run.branching.checkpoints;
      if (activeCheckpointIdx >= cps.length) activeCheckpointIdx = Math.max(0, cps.length - 1);
      const cp = cps[activeCheckpointIdx];
      const dm = run.branching.decisiveMoment;

      const banner = document.getElementById("decisive-banner");
      if (dm) {
        const evText = dm.eventsInWindow.length > 0
          ? dm.eventsInWindow.map((e) => \`[t=\${e.t}s] \${e.detail}\`).join(" · ")
          : "Continuous horde pressure & stamina/ammo attrition";
        banner.innerHTML = \`
          <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">
            <div>
              <strong style="color:#f87171">Decisive Moment Detected (t = \${dm.fromT}s → \${dm.toT}s · Hour \${dm.fromHour.toFixed(1)} → \${dm.toHour.toFixed(1)}):</strong>
              \${dm.whySummary}<br/>
              <span style="color:var(--muted)">Events in window: \${evText}</span>
            </div>
            <a class="replay-btn" target="_blank" href="/arcade/outbreak/?seed=\${run.seed}&botEnabled=1&botSkillPreset=\${run.presetIndex}&botDebugOverlay=1&botSeek=\${Math.max(0, dm.fromT)}">
              ▶ Replay Decisive Window (t = \${dm.fromT}s)
            </a>
          </div>
        \`;
      } else {
        banner.innerHTML = \`<strong style="color:#4ade80">Run Survived Window (\${run.nightsSurvived.toFixed(2)} nights · \${run.survivalTime}s):</strong> Survival probability stayed resilient across checkpoints.\`;
      }

      // Draw dual-track SVG timeline
      const svg = document.getElementById("branching-timeline-svg");
      const W = 680, H = 310, padL = 44, padR = 18;
      const maxT = Math.max(60, run.survivalTime, cps.length ? cps[cps.length - 1].t : 60);
      const xOf = (t) => padL + (Math.min(maxT, Math.max(0, t)) / maxT) * (W - padL - padR);

      // Top track: y = 16..142 (Survival Probability 0..100%)
      const topT = 16, topB = 142, topH = topB - topT;
      const ySurv = (p) => topT + (1 - p) * topH;

      // Bottom track: y = 172..282 (L4D Intensity I(t) 0..1 & HP 0..100%)
      const botT = 172, botB = 282, botH = botB - botT;
      const yInt = (v) => botT + (1 - v) * botH;

      let s = "";
      // Decisive moment highlight band
      if (dm) {
        const x0 = xOf(dm.fromT), x1 = xOf(dm.toT);
        s += \`<rect x="\${x0}" y="\${topT}" width="\${Math.max(6, x1 - x0)}" height="\${botB - topT}" fill="#f87171" fill-opacity="0.13"/>\`;
      }

      // Grid lines top track
      for (const pct of [0, 0.5, 1.0]) {
        const y = ySurv(pct);
        s += \`<line x1="\${padL}" y1="\${y}" x2="\${W - padR}" y2="\${y}" stroke="#1e2636" stroke-width="1"/>\`;
        s += \`<text x="\${padL - 6}" y="\${y + 4}" fill="#8b95ab" font-size="10" text-anchor="end">\${Math.round(pct * 100)}%</text>\`;
      }
      s += \`<text x="\${padL + 6}" y="\${topT + 11}" fill="#939db3" font-size="10.5" font-weight="600">Fork Rollout Survival Probability P(survive | state_t)</text>\`;

      // Grid lines bottom track
      for (const v of [0, 0.5, 1.0]) {
        const y = yInt(v);
        s += \`<line x1="\${padL}" y1="\${y}" x2="\${W - padR}" y2="\${y}" stroke="#1e2636" stroke-width="1"/>\`;
        s += \`<text x="\${padL - 6}" y="\${y + 4}" fill="#8b95ab" font-size="10" text-anchor="end">\${v.toFixed(1)}</text>\`;
      }
      s += \`<text x="\${padL + 6}" y="\${botT + 11}" fill="#939db3" font-size="10.5" font-weight="600">L4D Director Intensity I(t) (Peak ≥ 0.50 · Relax ≤ 0.24) & Survivor HP</text>\`;

      // Time ticks
      const stepT = maxT <= 180 ? 30 : maxT <= 360 ? 60 : 90;
      for (let t = 0; t <= maxT; t += stepT) {
        const x = xOf(t);
        s += \`<line x1="\${x}" y1="\${topT}" x2="\${x}" y2="\${botB}" stroke="#19202e" stroke-dasharray="3 3"/>\`;
        s += \`<text x="\${x}" y="\${H - 8}" fill="#8b95ab" font-size="10" text-anchor="middle">\${t}s</text>\`;
      }

      // Skill-specific survival probability curves across checkpoints
      for (const skill of ["Novice", "Casual", "Skilled", "Expert"]) {
        const pts = cps.map((c) => \`\${xOf(c.t).toFixed(1)},\${ySurv(c.survivalBySkill[skill] ?? 0).toFixed(1)}\`).join(" ");
        s += \`<polyline fill="none" stroke="\${COLORS[skill]}" stroke-width="1.5" stroke-opacity="0.65" stroke-dasharray="3 2" points="\${pts}"/>\`;
      }
      // Overall survival probability curve
      if (cps.length > 0) {
        const overallPts = cps.map((c) => \`\${xOf(c.t).toFixed(1)},\${ySurv(c.survivalProbability).toFixed(1)}\`).join(" ");
        s += \`<polyline fill="none" stroke="#f2a65a" stroke-width="2.8" points="\${overallPts}"/>\`;
      }

      // Bottom track: Intensity area & HP curve
      if (run.series.length > 0) {
        const intPts = run.series.map((pt) => \`\${xOf(pt.t).toFixed(1)},\${yInt(pt.intensity ?? 0).toFixed(1)}\`).join(" ");
        const areaPts = \`\${xOf(run.series[0].t).toFixed(1)},\${botB} \${intPts} \${xOf(run.series[run.series.length - 1].t).toFixed(1)},\${botB}\`;
        s += \`<polygon fill="rgba(244, 63, 94, 0.18)" points="\${areaPts}"/>\`;
        s += \`<polyline fill="none" stroke="#f43f5e" stroke-width="2.2" points="\${intPts}"/>\`;

        const hpPts = run.series.map((pt) => \`\${xOf(pt.t).toFixed(1)},\${yInt((pt.health ?? 100) / 100).toFixed(1)}\`).join(" ");
        s += \`<polyline fill="none" stroke="#4ade80" stroke-width="1.6" stroke-dasharray="4 2" points="\${hpPts}"/>\`;
      }

      // Active checkpoint vertical cursor line
      if (cp) {
        const cx = xOf(cp.t);
        s += \`<line x1="\${cx}" y1="\${topT}" x2="\${cx}" y2="\${botB}" stroke="#38bdf8" stroke-width="1.8"/>\`;
      }

      // Clickable checkpoint nodes
      cps.forEach((c, idx) => {
        const cx = xOf(c.t);
        const cy = ySurv(c.survivalProbability);
        const isSel = idx === activeCheckpointIdx;
        s += \`<circle data-cp="\${idx}" cx="\${cx.toFixed(1)}" cy="\${cy.toFixed(1)}" r="\${isSel ? 6.5 : 4.5}" fill="\${isSel ? "#38bdf8" : "#f2a65a"}" stroke="#0c0e12" stroke-width="1.5"/>\`;
      });

      // Timeline event markers along bottom track
      for (const ev of run.timeline) {
        const ex = xOf(ev.t);
        const col = ev.kind === "death" ? "#f87171" : ev.kind === "close-call" ? "#facc15" : ev.kind === "first-contact" ? "#fb923c" : "#38bdf8";
        s += \`<circle cx="\${ex.toFixed(1)}" cy="\${botB - 4}" r="3" fill="\${col}"><title>[\${ev.t}s] \${ev.kind}: \${ev.detail}</title></circle>\`;
      }

      svg.innerHTML = s;
      svg.onclick = (e) => {
        const rect = svg.getBoundingClientRect();
        const clickX = ((e.clientX - rect.left) / rect.width) * W;
        let bestIdx = 0, bestDist = Infinity;
        cps.forEach((c, idx) => {
          const d = Math.abs(xOf(c.t) - clickX);
          if (d < bestDist) { bestDist = d; bestIdx = idx; }
        });
        activeCheckpointIdx = bestIdx;
        renderRunViewer();
      };

      // Render Checkpoint Inspector panel
      const insp = document.getElementById("checkpoint-inspector");
      if (cp) {
        const causesStr = Object.entries(cp.causesOfDeath)
          .map(([k, v]) => \`\${k}: \${v}/\${cp.rolloutCount}\`)
          .join(" · ");
        const replayUrl = \`/arcade/outbreak/?seed=\${run.seed}&botEnabled=1&botSkillPreset=\${run.presetIndex}&botDebugOverlay=1&botSeek=\${Math.round(cp.t)}\`;
        insp.innerHTML = \`
          <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--border);padding-bottom:8px;">
            <div>
              <strong style="font-size:13.5px;color:#38bdf8">Snapshot @ t = \${cp.t}s (Tick \${cp.tick} · Hour \${cp.hour.toFixed(2)})</strong>
              <div style="font-size:11px;color:var(--muted);font-family:monospace;">SimState Hash: \${cp.stateHash}</div>
            </div>
            <a class="replay-btn" target="_blank" href="\${replayUrl}">▶ Replay Here (t = \${Math.round(cp.t)}s)</a>
          </div>
          <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;font-size:11.5px;">
            <div class="knob-item">HP: <strong>\${cp.summary.health}</strong></div>
            <div class="knob-item">Ammo: <strong>\${cp.summary.totalAmmo}</strong></div>
            <div class="knob-item">Chasers: <strong>\${cp.summary.activeChasers}</strong></div>
            <div class="knob-item">Phase: <strong style="text-transform:uppercase">\${cp.summary.phase} (\${cp.summary.intensity.toFixed(2)})</strong></div>
          </div>
          <table>
            <thead><tr><th>Forked Bot Skill</th><th>Rollout Survival %</th><th>Outcome from Snapshot</th></tr></thead>
            <tbody>
              \${["Novice", "Casual", "Skilled", "Expert"].map((sk) => {
                const p = cp.survivalBySkill[sk] ?? 0;
                const pct = Math.round(p * 100);
                return \`<tr>
                  <td><strong style="color:\${COLORS[sk]}">\${sk}</strong></td>
                  <td><strong>\${pct}%</strong></td>
                  <td><div class="bar-track"><div class="bar-fill" style="width:\${pct}%;background:\${COLORS[sk]}"></div></div></td>
                </tr>\`;
              }).join("")}
            </tbody>
          </table>
          <div style="font-size:11.5px;color:var(--muted);">
            <strong>Remaining Survival (IQR across \${cp.rolloutCount} rollouts):</strong> Median <strong>+\${cp.medianRemainingSeconds}s</strong> (p25 +\${cp.p25RemainingSeconds}s .. p75 +\${cp.p75RemainingSeconds}s)<br/>
            <strong>Rollout Outcomes:</strong> \${causesStr}<br/>
            <strong>Run Pacing Summary:</strong> \${run.pacing.peakCount} peaks (\${run.pacing.peaksPerNight}/n) · Relax windows \${run.pacing.minRelaxWindowSeconds}s..\${run.pacing.maxRelaxWindowSeconds}s · Close calls \${run.pacing.closeCallsPerNight}/n · Death warning lead: \${run.pacing.deathWarningSeconds !== null ? run.pacing.deathWarningSeconds + "s" : "Survived"}
          </div>
        \`;
      }
    }

    function renderPacingTargetsSandbox() {
      const grid = document.getElementById("pacing-knobs-grid");
      const tbl = document.getElementById("live-loss-comparison-table");
      if (!grid || !tbl) return;

      if (grid.children.length === 0) {
        for (const spec of DATA.pacingTargetSpecs) {
          const item = document.createElement("div");
          item.className = "knob-item";
          item.innerHTML = \`
            <label>
              <span>\${spec.label}</span>
              <strong id="pt-val-\${spec.key}">\${livePacingTargets[spec.key]}\${spec.unit}</strong>
            </label>
            <input type="range" id="pt-input-\${spec.key}" min="\${spec.min}" max="\${spec.max}" step="\${spec.step}" value="\${livePacingTargets[spec.key]}" />
          \`;
          grid.appendChild(item);
          const input = item.querySelector("input");
          input.oninput = () => {
            livePacingTargets[spec.key] = Number(input.value);
            document.getElementById(\`pt-val-\${spec.key}\`).textContent = \`\${livePacingTargets[spec.key]}\${spec.unit}\`;
            renderAll();
          };
        }
        const resetBtn = document.getElementById("reset-pacing-targets-btn");
        if (resetBtn) {
          resetBtn.onclick = () => {
            Object.assign(livePacingTargets, DATA.defaultPacingTargets);
            for (const spec of DATA.pacingTargetSpecs) {
              const inp = document.getElementById(\`pt-input-\${spec.key}\`);
              if (inp) inp.value = String(livePacingTargets[spec.key]);
              const lbl = document.getElementById(\`pt-val-\${spec.key}\`);
              if (lbl) lbl.textContent = \`\${livePacingTargets[spec.key]}\${spec.unit}\`;
            }
            renderAll();
          };
        }
      }

      const scored = DATA.options.map((opt, idx) => ({
        idx,
        opt,
        lb: computeClientLossBreakdown(opt.byPreset, livePacingTargets),
      }));
      const minLoss = Math.min(...scored.map((s) => s.lb.total));

      let html = \`<thead><tr><th>Difficulty Option</th><th>Survival Curve Loss</th><th>L4D Pacing/Fun Loss</th><th>Monotonicity Loss</th><th>Fairness Loss</th><th>Total Loss</th></tr></thead><tbody>\`;
      for (const row of scored) {
        const isBest = Math.abs(row.lb.total - minLoss) < 1e-4;
        html += \`<tr style="background:\${isBest ? "rgba(74, 222, 128, 0.07)" : "transparent"}">
          <td><strong>Option \${row.idx + 1}: \${row.opt.label}</strong> \${isBest ? '<span style="color:#4ade80;font-size:11px;font-weight:600">★ Best Fit</span>' : ""}</td>
          <td>\${row.lb.survivalCurveLoss.toFixed(2)}</td>
          <td>\${row.lb.pacingFunLoss.toFixed(2)}</td>
          <td>\${row.lb.monotonicityLoss.toFixed(2)}</td>
          <td>\${row.lb.fairnessLoss.toFixed(2)}</td>
          <td><strong style="color:\${isBest ? "#4ade80" : "var(--accent)"}">\${row.lb.total.toFixed(2)}</strong></td>
        </tr>\`;
      }
      html += "</tbody>";
      tbl.innerHTML = html;
    }

    function renderSensitivityTable() {
      const tbl = document.getElementById("sensitivity-table");
      if (!tbl) return;
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

    function renderCoopAndAudit() {
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

      const auditTbl = document.getElementById("purity-audit-table");
      if (auditTbl && DATA.purityAudit) {
        let html = \`<thead><tr><th>Subsystem / Module</th><th>Impurity Discovered</th><th>How Fixed for Pure step(state, inputs, dt) → state</th></tr></thead><tbody>\`;
        for (const row of DATA.purityAudit) {
          html += \`<tr>
            <td style="width:24%"><strong>\${row.subsystem}</strong></td>
            <td style="width:38%;color:var(--muted)">\${row.impurity}</td>
            <td style="width:38%;color:#4ade80">\${row.fix}</td>
          </tr>\`;
        }
        html += "</tbody>";
        auditTbl.innerHTML = html;
      }
    }

    function renderAll() {
      const opt = DATA.options[activeIdx];
      const lb = computeClientLossBreakdown(opt.byPreset, livePacingTargets);
      if (cardParam !== null) {
        document.getElementById("page-title").textContent = \`Option \${activeIdx + 1} · \${opt.label}\`;
      }
      document.getElementById("header-badges").innerHTML = \`
        <div class="badge">Option: <strong>\${opt.label}</strong></div>
        <div class="badge">Total Loss: <strong>\${lb.total.toFixed(2)}</strong> (Surv \${lb.survivalCurveLoss.toFixed(1)} · Pacing \${lb.pacingFunLoss.toFixed(1)})</div>
        <div class="badge">Novice→Expert Medians: <strong>\${opt.byPreset.Novice.medianNights.toFixed(2)}n / \${opt.byPreset.Casual.medianNights.toFixed(2)}n / \${opt.byPreset.Skilled.medianNights.toFixed(2)}n / \${opt.byPreset.Expert.medianNights.toFixed(2)}n</strong></div>
        <div class="badge">Warned Deaths: <strong>\${Math.round((opt.byPreset.Casual.warnedDeathRate ?? 1) * 100)}%</strong> · Unfair Spawns: <strong>0</strong></div>
      \`;
      renderTabs();
      renderSurvivalCurve(opt);
      renderHeatmap(opt);
      renderKnobsTable(opt);
      renderPacingTierTable(opt);
      renderRunViewer();
      renderPacingTargetsSandbox();
      renderSensitivityTable();
      renderCoopAndAudit();
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
