// Runs difficulty-ramp bot games on Bun workers. This module is also the worker: imported on the main thread it only
// exports `runRampBatch` and `runCoopBatch`; loaded as a worker it plays the games it is sent.
import type { BotRunConfig } from "../shared/bot-runner"
import { runCoopProbe, type CoopRun } from "../shared/coop-ramp"
import { runRampProbe, type RampRun } from "../shared/difficulty-ramp"

declare const self: Worker

type Probe = "ramp" | "coop"

function runBatch<T>(probe: Probe, jobs: readonly BotRunConfig[], size: number): Promise<T[]> {
  return new Promise((done) => {
    const results = new Array<T>(jobs.length)
    let next = 0
    let finished = 0
    if (jobs.length === 0) return done([])
    const pool = Array.from({ length: Math.max(1, Math.min(size, jobs.length)) }, () => new Worker(import.meta.url))
    const feed = (w: Worker) => {
      if (next >= jobs.length) return w.terminate()
      w.postMessage({ id: next, probe, config: jobs[next++] })
    }
    for (const w of pool) {
      w.onmessage = (ev: MessageEvent<{ id: number; run: T }>) => {
        results[ev.data.id] = ev.data.run
        if (++finished === jobs.length) done(results)
        feed(w)
      }
      feed(w)
    }
  })
}

/** Plays every job on up to `size` workers; results come back in job order. */
export const runRampBatch = (jobs: readonly BotRunConfig[], size: number) => runBatch<RampRun>("ramp", jobs, size)

/** Co-op probe runs (`shared/coop-ramp.ts`) on up to `size` workers, in job order. */
export const runCoopBatch = (jobs: readonly BotRunConfig[], size: number) => runBatch<CoopRun>("coop", jobs, size)

if (!Bun.isMainThread) {
  self.onmessage = (event: MessageEvent<{ id: number; probe: Probe; config: BotRunConfig }>) => {
    const { id, probe, config } = event.data
    self.postMessage({ id, run: probe === "coop" ? runCoopProbe(config) : runRampProbe(config) })
  }
}
