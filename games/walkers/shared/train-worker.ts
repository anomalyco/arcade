// Coordinator worker: owns the Trainer and a pool of nested evaluation workers, so training never waits on the page's
// main thread (each generation is several worker round trips; on a busy main thread those added up to ~0.5 s).
// The page gets small stats every generation and pulls the latest population only when it wants to show one.

import type { RewardSettings } from "./episode"
import type { EsSettings } from "./es"
import { Trainer, WorkerPool, type GenerationStats, type SavedPolicy, type TrainerOptions } from "./trainer"

export type ToTrainer =
  | { type: "init"; options: TrainerOptions; workers: number }
  | { type: "run"; on: boolean }
  | { type: "es"; es: EsSettings }
  | { type: "reward"; reward: RewardSettings }
  | { type: "workers"; n: number }
  /** Send the latest population (for the view). */
  | { type: "last" }
  /** Watch every generation: hold after each one until the page says go. */
  | { type: "hold"; on: boolean }
  | { type: "go" }

export type LastGeneration = NonNullable<Trainer["last"]>

export type FromTrainer =
  | { type: "ready"; population: number; paramSize: number }
  | { type: "gen"; stats: GenerationStats; best: SavedPolicy | null; population: number }
  | { type: "last"; last: LastGeneration }
  | { type: "error"; message: string }

const scope = self as unknown as { onmessage: ((e: MessageEvent<ToTrainer>) => void) | null; postMessage(msg: FromTrainer, transfer?: Transferable[]): void }
const pool = new WorkerPool(() => new Worker(new URL("./eval-worker.ts", import.meta.url), { type: "module" }), 0)
let trainer: Trainer | null = null
let running = false
let looping = false
let hold = false
let release: (() => void) | null = null
let epoch = 0

async function loop(): Promise<void> {
  if (looping) return
  looping = true
  try {
    while (running && trainer) {
      const t = trainer
      const at = epoch
      const bestBefore = t.best
      const stats = await t.generation()
      if (at !== epoch) continue
      scope.postMessage({ type: "gen", stats, best: t.best !== bestBefore ? t.best : null, population: t.es.population })
      if (hold) {
        sendLast()
        await new Promise<void>((resolve) => (release = resolve))
      }
    }
  } catch (error) {
    running = false
    scope.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) })
  } finally {
    looping = false
  }
}

function sendLast(): void {
  const last = trainer?.last
  if (!last) return
  const params = last.params.slice()
  scope.postMessage({ type: "last", last: { ...last, params } }, [params.buffer])
}

scope.onmessage = (e) => {
  const m = e.data
  if (m.type === "init") {
    epoch++
    pool.resize(m.workers)
    trainer = new Trainer(m.options, pool.evaluate)
    release?.()
    release = null
    scope.postMessage({ type: "ready", population: trainer.es.population, paramSize: trainer.paramSize })
    if (running) void loop()
  } else if (m.type === "run") {
    running = m.on
    if (running) void loop()
  } else if (m.type === "es" && trainer) trainer.es.settings = m.es
  else if (m.type === "reward" && trainer) trainer.reward = m.reward
  else if (m.type === "workers") pool.resize(m.n)
  else if (m.type === "last") sendLast()
  else if (m.type === "hold") {
    hold = m.on
    if (!hold) {
      release?.()
      release = null
    }
  } else if (m.type === "go") {
    release?.()
    release = null
  }
}
