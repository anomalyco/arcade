// The page's handle on the coordinator worker (shared/train-worker.ts): mirrors history and the best policy, and
// keeps the latest population the view asked for.

import type { CreatureId } from "../shared/creatures"
import type { RewardSettings } from "../shared/episode"
import type { EsSettings } from "../shared/es"
import type { TaskId } from "../shared/tasks"
import type { FromTrainer, LastGeneration, ToTrainer } from "../shared/train-worker"
import type { GenerationStats, SavedPolicy, TrainerOptions } from "../shared/trainer"

export class RemoteTrainer {
  private worker = new Worker(new URL("../shared/train-worker.ts", import.meta.url), { type: "module" })
  history: GenerationStats[] = []
  best: SavedPolicy | null = null
  last: LastGeneration | null = null
  /** Newest generation the worker has finished (last may be older until requested). */
  latestGen = -1
  totalSteps = 0
  population = 0
  paramSize = 0
  workers: number
  creature: CreatureId
  task: TaskId
  hidden: number
  onGeneration: (s: GenerationStats) => void = () => {}
  onError: (message: string) => void = () => {}
  private epoch = 0
  private lastPending = false

  constructor(options: TrainerOptions, workers: number) {
    this.creature = options.creature
    this.task = options.task
    this.hidden = options.hidden
    this.workers = workers
    this.worker.onmessage = (e: MessageEvent<FromTrainer & { epoch?: number }>) => this.receive(e.data)
    this.reset(options)
  }

  private send(m: ToTrainer): void {
    this.worker.postMessage(m)
  }

  private receive(m: FromTrainer): void {
    if (m.type === "ready") {
      this.population = m.population
      this.paramSize = m.paramSize
    } else if (m.type === "gen") {
      if (m.stats.gen !== this.history.length) return // from before a reset
      this.history.push(m.stats)
      this.latestGen = m.stats.gen
      this.totalSteps = m.stats.totalSteps
      this.population = m.population
      if (m.best) this.best = m.best
      this.onGeneration(m.stats)
    } else if (m.type === "last") {
      this.lastPending = false
      if (m.last.gen <= this.latestGen) this.last = m.last
    } else if (m.type === "error") this.onError(m.message)
  }

  /** Starts over with new options (and forgets everything from the old run). */
  reset(options: TrainerOptions): void {
    this.epoch++
    this.creature = options.creature
    this.task = options.task
    this.hidden = options.hidden
    this.history = []
    this.best = null
    this.last = null
    this.latestGen = -1
    this.totalSteps = 0
    this.lastPending = false
    this.send({ type: "init", options, workers: this.workers })
  }

  run(on: boolean): void {
    this.send({ type: "run", on })
  }

  setEs(es: EsSettings): void {
    this.send({ type: "es", es })
  }

  setReward(reward: RewardSettings): void {
    this.send({ type: "reward", reward })
  }

  setWorkers(n: number): void {
    this.workers = n
    this.send({ type: "workers", n })
  }

  hold(on: boolean): void {
    this.send({ type: "hold", on })
  }

  go(): void {
    this.send({ type: "go" })
  }

  /** Asks for the newest population if the view's copy is stale. */
  requestLast(): void {
    if (this.lastPending || this.latestGen < 0 || (this.last && this.last.gen === this.latestGen)) return
    this.lastPending = true
    this.send({ type: "last" })
  }
}
