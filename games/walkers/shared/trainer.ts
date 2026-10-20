// Training loop shared by the page and the headless Bun trainer: ES asks for a generation, a pool of workers scores
// it, ES takes a step, and the trainer keeps the history and the best policy ever seen. Saved policies are plain JSON.

import { mulberry32 } from "@arcade/kit/sim/rng"
import type { CreatureId } from "./creatures"
import { CONTROL_DT, DEFAULT_REWARD, policyShape, type RewardSettings } from "./episode"

const OUTCOMES = ["timeout", "fell", "finished", "caught"] as const
import { DEFAULT_ES, Es, type EsSettings } from "./es"
import { evaluateBatch, type EvalRequest, type EvalResponse } from "./evaluate-batch"
import { initParams, paramCount } from "./policy"
import { HEIST_MAX_STAGE } from "./level"
import { SIM_VERSION } from "./physics"
import { TASK_IDS, type Env, type TaskId } from "./tasks"

export type BatchJob = Omit<EvalRequest, "id" | "params" | "count">
export type Evaluator = (job: BatchJob, params: Float64Array, rows: number) => Promise<EvalResponse>

export const inlineEvaluator: Evaluator = async (job, params, rows) => evaluateBatch({ ...job, id: 0, params, count: rows })

/** Spreads a batch over Web Workers (or Bun Workers) in small chunks, so long and short episodes balance out. */
export class WorkerPool {
  private workers: Worker[] = []
  private nextId = 1
  private busy = false
  private wanted = -1

  constructor(private spawn: () => Worker, size: number) {
    this.resize(size)
  }

  get size(): number {
    return this.workers.length
  }

  /** Takes effect once the batch in flight (if any) is done, so no chunk is lost to a terminated worker. */
  resize(size: number): void {
    if (this.busy) {
      this.wanted = size
      return
    }
    while (this.workers.length > size) this.workers.pop()!.terminate()
    while (this.workers.length < size) this.workers.push(this.spawn())
  }

  terminate(): void {
    this.resize(0)
  }

  readonly evaluate: Evaluator = (job, params, rows) => {
    if (!this.workers.length) return inlineEvaluator(job, params, rows)
    const n = params.length / rows
    const chunk = Math.max(1, Math.ceil(rows / (this.workers.length * 3)))
    const out: EvalResponse = { id: 0, fitness: new Float64Array(rows), distance: new Float64Array(rows), steps: new Float64Array(rows), outcome: new Uint8Array(rows), gem: new Uint8Array(rows), alarms: new Uint8Array(rows) }
    let next = 0
    let pending = 0
    this.busy = true
    const settle = () => {
      this.busy = false
      if (this.wanted >= 0) {
        const n = this.wanted
        this.wanted = -1
        this.resize(n)
      }
    }
    return new Promise<EvalResponse>((resolve, reject) => {
      const feed = (w: Worker) => {
        if (next >= rows) {
          if (pending === 0) {
            settle()
            resolve(out)
          }
          return
        }
        const start = next
        const count = Math.min(chunk, rows - start)
        next += count
        pending++
        const id = this.nextId++
        w.onmessage = (e: MessageEvent<EvalResponse>) => {
          const r = e.data
          if (r.id !== id) return
          out.fitness.set(r.fitness, start)
          out.distance.set(r.distance, start)
          out.steps.set(r.steps, start)
          out.outcome.set(r.outcome, start)
          out.gem.set(r.gem, start)
          out.alarms.set(r.alarms, start)
          pending--
          feed(w)
        }
        w.onerror = (e) => {
          settle()
          reject(e instanceof ErrorEvent ? new Error(e.message) : new Error("worker failed"))
        }
        const slice = params.slice(start * n, (start + count) * n)
        const req: EvalRequest = { ...job, id, params: slice, count }
        w.postMessage(req, [slice.buffer])
      }
      for (const w of this.workers) feed(w)
    })
  }
}

export type GenerationStats = {
  gen: number
  /** Best and mean fitness of the perturbed population, and the mean policy's own fitness. */
  best: number
  mean: number
  center: number
  bestEver: number
  bestDistance: number
  centerDistance: number
  finished: number
  fell: number
  /** Heist: runs caught (third alarm), runs that ended holding the gem, clean escapes (no alarm), alarms in total. */
  caught: number
  gems: number
  clean: number
  alarms: number
  /** Heist curriculum stage this generation ran at. */
  stage: number
  /** Control steps simulated this generation, and in total. */
  steps: number
  totalSteps: number
  ms: number
}

export type SavedPolicy = {
  format: "walkers-policy"
  version: 2
  /** physics.ts SIM_VERSION it was trained on; other versions don't replay the same. */
  sim: number
  creature: CreatureId
  env: Env
  hidden: number
  fitness: number
  distance: number
  /** Seconds the run lasted, whether it escaped (finished) or got caught, and the alarms it set off. */
  time?: number
  alarms?: number
  outcome?: "timeout" | "fell" | "finished" | "caught"
  generation: number
  /** Control steps simulated to find it. */
  steps: number
  params: number[]
  /** Reward settings it was scored with (replays use them so the score matches). */
  reward?: RewardSettings
  /** Wall-clock seconds the headless trainer took (pretrained files). */
  trainedSeconds?: number
}

export type TrainerOptions = {
  creature: CreatureId
  env: Env
  hidden: number
  /** Heist: raise the stage automatically as the population starts escaping. */
  curriculum?: boolean
  es?: EsSettings
  reward?: RewardSettings
  seed?: number
  /** Start from these parameters (a loaded policy) instead of random. */
  init?: Float64Array
}

export class Trainer {
  readonly es: Es
  readonly creature: CreatureId
  readonly hidden: number
  env: Env
  curriculum: boolean
  reward: RewardSettings
  private streak = 0
  readonly history: GenerationStats[] = []
  best: SavedPolicy | null = null
  /** The latest generation's parameters and results, for playback. */
  last: { params: Float64Array; rows: number; results: EvalResponse; gen: number; reward: RewardSettings; env: Env } | null = null
  totalSteps = 0

  constructor(options: TrainerOptions, private evaluator: Evaluator) {
    this.creature = options.creature
    this.env = { ...options.env }
    this.curriculum = options.curriculum ?? true
    this.hidden = options.hidden
    this.reward = options.reward ?? DEFAULT_REWARD
    const shape = policyShape(options.creature, options.hidden)
    const seed = options.seed ?? 1
    const init = options.init && options.init.length === paramCount(shape) ? options.init : initParams(shape, mulberry32(seed ^ 0x9e3779b9))
    this.es = new Es(init, options.es ?? DEFAULT_ES, seed)
  }

  get task(): TaskId {
    return this.env.task
  }

  get paramSize(): number {
    return this.es.size
  }

  async generation(): Promise<GenerationStats> {
    const t0 = performance.now()
    const params = this.es.ask()
    const rows = this.es.population
    const n = this.es.size
    const reward = { ...this.reward }
    const env = { ...this.env }
    const job: BatchJob = { creature: this.creature, env, hidden: this.hidden, reward }
    const results = await this.evaluator(job, params.slice(), rows)
    let best = 0
    let mean = 0
    let finished = 0
    let fell = 0
    let caught = 0
    let gems = 0
    let clean = 0
    let alarms = 0
    let steps = 0
    for (let i = 0; i < rows; i++) {
      if (results.fitness[i]! > results.fitness[best]!) best = i
      if (i > 0) mean += results.fitness[i]!
      if (results.outcome[i] === 2) finished++
      if (results.outcome[i] === 1) fell++
      if (results.outcome[i] === 3) caught++
      if (results.gem[i]) gems++
      if (results.outcome[i] === 2 && results.alarms[i] === 0) clean++
      alarms += results.alarms[i]!
      steps += results.steps[i]!
    }
    mean /= Math.max(1, rows - 1)
    const gen = this.es.generation
    // A later curriculum stage beats any score at an earlier one.
    const bestStage = this.best?.env.stage ?? -1
    if (!this.best || env.stage > bestStage || (env.stage === bestStage && results.fitness[best]! > this.best.fitness)) {
      this.best = {
        format: "walkers-policy",
        version: 2,
        sim: SIM_VERSION,
        creature: this.creature,
        env,
        hidden: this.hidden,
        fitness: results.fitness[best]!,
        distance: results.distance[best]!,
        time: results.steps[best]! * CONTROL_DT,
        outcome: OUTCOMES[results.outcome[best]!] ?? "timeout",
        alarms: results.alarms[best]!,
        generation: gen,
        steps: this.totalSteps + steps,
        params: Array.from(params.subarray(best * n, (best + 1) * n)),
        reward,
      }
    }
    this.es.tell(results.fitness)
    this.totalSteps += steps
    this.last = { params, rows, results, gen, reward, env }
    let bestPerturbed = -Infinity
    for (let i = 1; i < rows; i++) bestPerturbed = Math.max(bestPerturbed, results.fitness[i]!)
    const stats: GenerationStats = {
      gen,
      best: Math.max(bestPerturbed, results.fitness[0]!),
      mean,
      center: results.fitness[0]!,
      bestEver: this.best.fitness,
      bestDistance: results.distance[best]!,
      centerDistance: results.distance[0]!,
      finished,
      fell,
      caught,
      gems,
      clean,
      alarms,
      stage: env.stage,
      steps,
      totalSteps: this.totalSteps,
      ms: performance.now() - t0,
    }
    this.history.push(stats)
    this.advanceCurriculum(clean, rows, results.outcome[0] === 2 && results.alarms[0] === 0)
    return stats
  }

  /**
   * Heist curriculum: two generations in a row where the mean policy escapes with no alarm, or a sixth of the
   * population does, moves up a stage. (The noisy population alone rarely all comes through clean.)
   */
  private advanceCurriculum(clean: number, rows: number, centerClean: boolean): void {
    if (this.env.task !== "heist" || !this.curriculum || this.env.stage >= HEIST_MAX_STAGE) return
    this.streak = centerClean || clean >= Math.ceil(rows / 6) ? this.streak + 1 : 0
    if (this.streak >= 2) {
      this.env = { ...this.env, stage: this.env.stage + 1 }
      this.streak = 0
    }
  }
}

/** Validates a parsed JSON policy (localStorage, a download, or a shipped pretrained file). */
export function parsePolicy(value: unknown): SavedPolicy | null {
  const v = value as Partial<SavedPolicy> | null
  if (!v || v.format !== "walkers-policy" || v.version !== 2 || v.sim !== SIM_VERSION) return null
  const e = v.env as Partial<Env> | undefined
  if (!e || !TASK_IDS.includes(e.task as TaskId) || ![e.seed, e.stage, e.laserSpeed].every((x) => typeof x === "number" && Number.isFinite(x))) return null
  if (e.extra === undefined) e.extra = 0
  if (typeof v.creature !== "string" || typeof v.hidden !== "number" || !Array.isArray(v.params)) return null
  let shape
  try {
    shape = policyShape(v.creature as CreatureId, v.hidden)
  } catch {
    return null
  }
  if (v.params.length !== paramCount(shape) || !v.params.every((x) => typeof x === "number" && Number.isFinite(x))) return null
  if (v.reward !== undefined) {
    const r = v.reward as Record<string, unknown> | null
    if (!r || typeof r !== "object" || !Object.keys(DEFAULT_REWARD).every((k) => typeof r[k] === "number" && Number.isFinite(r[k]))) return null
  }
  return v as SavedPolicy
}
