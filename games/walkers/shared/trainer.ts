// Training loop shared by the page and the headless Bun trainer: ES asks for a generation, a pool of workers scores
// it, ES takes a step, and the trainer keeps the history and the best policy ever seen. Saved policies are plain JSON.

import { mulberry32 } from "@arcade/kit/sim/rng"
import type { CreatureId } from "./creatures"
import { DEFAULT_REWARD, policyShape, type RewardSettings } from "./episode"
import { DEFAULT_ES, Es, type EsSettings } from "./es"
import { evaluateBatch, type EvalRequest, type EvalResponse } from "./evaluate-batch"
import { initParams, paramCount } from "./policy"
import type { TaskId } from "./tasks"

export type BatchJob = Omit<EvalRequest, "id" | "params" | "count">
export type Evaluator = (job: BatchJob, params: Float64Array, rows: number) => Promise<EvalResponse>

export const inlineEvaluator: Evaluator = async (job, params, rows) => evaluateBatch({ ...job, id: 0, params, count: rows })

/** Spreads a batch over Web Workers (or Bun Workers) in small chunks, so long and short episodes balance out. */
export class WorkerPool {
  private workers: Worker[] = []
  private nextId = 1

  constructor(private spawn: () => Worker, size: number) {
    this.resize(size)
  }

  get size(): number {
    return this.workers.length
  }

  resize(size: number): void {
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
    const out: EvalResponse = { id: 0, fitness: new Float64Array(rows), distance: new Float64Array(rows), steps: new Float64Array(rows), outcome: new Uint8Array(rows) }
    let next = 0
    let pending = 0
    return new Promise((resolve, reject) => {
      const feed = (w: Worker) => {
        if (next >= rows) {
          if (pending === 0) resolve(out)
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
          pending--
          feed(w)
        }
        w.onerror = (e) => reject(e instanceof ErrorEvent ? new Error(e.message) : new Error("worker failed"))
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
  /** Control steps simulated this generation, and in total. */
  steps: number
  totalSteps: number
  ms: number
}

export type SavedPolicy = {
  format: "walkers-policy"
  version: 1
  creature: CreatureId
  task: TaskId
  hidden: number
  fitness: number
  distance: number
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
  task: TaskId
  hidden: number
  es?: EsSettings
  reward?: RewardSettings
  seed?: number
  /** Start from these parameters (a loaded policy) instead of random. */
  init?: Float64Array
}

export class Trainer {
  readonly es: Es
  readonly creature: CreatureId
  readonly task: TaskId
  readonly hidden: number
  reward: RewardSettings
  readonly history: GenerationStats[] = []
  best: SavedPolicy | null = null
  /** The latest generation's parameters and results, for playback. */
  last: { params: Float64Array; rows: number; results: EvalResponse; gen: number; reward: RewardSettings } | null = null
  totalSteps = 0

  constructor(options: TrainerOptions, private evaluator: Evaluator) {
    this.creature = options.creature
    this.task = options.task
    this.hidden = options.hidden
    this.reward = options.reward ?? DEFAULT_REWARD
    const shape = policyShape(options.creature, options.hidden)
    const seed = options.seed ?? 1
    const init = options.init && options.init.length === paramCount(shape) ? options.init : initParams(shape, mulberry32(seed ^ 0x9e3779b9))
    this.es = new Es(init, options.es ?? DEFAULT_ES, seed)
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
    const job: BatchJob = { creature: this.creature, task: this.task, hidden: this.hidden, reward }
    const results = await this.evaluator(job, params.slice(), rows)
    let best = 0
    let mean = 0
    let finished = 0
    let fell = 0
    let steps = 0
    for (let i = 0; i < rows; i++) {
      if (results.fitness[i]! > results.fitness[best]!) best = i
      if (i > 0) mean += results.fitness[i]!
      if (results.outcome[i] === 2) finished++
      if (results.outcome[i] === 1) fell++
      steps += results.steps[i]!
    }
    mean /= Math.max(1, rows - 1)
    const gen = this.es.generation
    if (!this.best || results.fitness[best]! > this.best.fitness) {
      this.best = {
        format: "walkers-policy",
        version: 1,
        creature: this.creature,
        task: this.task,
        hidden: this.hidden,
        fitness: results.fitness[best]!,
        distance: results.distance[best]!,
        generation: gen,
        steps: this.totalSteps + steps,
        params: Array.from(params.subarray(best * n, (best + 1) * n)),
        reward,
      }
    }
    this.es.tell(results.fitness)
    this.totalSteps += steps
    this.last = { params, rows, results, gen, reward }
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
      steps,
      totalSteps: this.totalSteps,
      ms: performance.now() - t0,
    }
    this.history.push(stats)
    return stats
  }
}

/** Validates a parsed JSON policy (localStorage, a download, or a shipped pretrained file). */
export function parsePolicy(value: unknown): SavedPolicy | null {
  const v = value as Partial<SavedPolicy> | null
  if (!v || v.format !== "walkers-policy" || v.version !== 1) return null
  if (typeof v.creature !== "string" || typeof v.task !== "string" || typeof v.hidden !== "number" || !Array.isArray(v.params)) return null
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
