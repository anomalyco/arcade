// Runs difficulty-ramp bot games on Bun workers. This module is also the worker: imported on the main thread it only
// exports `runRampBatch`; loaded as a worker it plays the games it is sent.
import type { BotRunConfig } from "../shared/bot-runner"
import { runRampProbe, type RampRun } from "../shared/difficulty-ramp"

declare const self: Worker

/** Plays every job on up to `size` workers; results come back in job order. */
export function runRampBatch(jobs: readonly BotRunConfig[], size: number): Promise<RampRun[]> {
  return new Promise((done) => {
    const results = new Array<RampRun>(jobs.length)
    let next = 0
    let finished = 0
    if (jobs.length === 0) return done([])
    const pool = Array.from({ length: Math.max(1, Math.min(size, jobs.length)) }, () => new Worker(import.meta.url))
    const feed = (w: Worker) => {
      if (next >= jobs.length) return w.terminate()
      w.postMessage({ id: next, config: jobs[next++] })
    }
    for (const w of pool) {
      w.onmessage = (ev: MessageEvent<{ id: number; run: RampRun }>) => {
        results[ev.data.id] = ev.data.run
        if (++finished === jobs.length) done(results)
        feed(w)
      }
      feed(w)
    }
  })
}

if (!Bun.isMainThread) {
  self.onmessage = (event: MessageEvent<{ id: number; config: BotRunConfig }>) => {
    self.postMessage({ id: event.data.id, run: runRampProbe(event.data.config) })
  }
}
