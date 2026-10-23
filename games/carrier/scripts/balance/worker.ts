// A balance worker (Bun Worker, one per core): runs the matches it is handed, one at a time, and posts each result.

import { type MatchSpec, runMatch } from "./match"

declare const self: Worker

self.onmessage = (ev: MessageEvent<{ job: number; spec: MatchSpec }>) => {
  const { job, spec } = ev.data
  try {
    self.postMessage({ job, result: runMatch(spec) })
  } catch (e) {
    self.postMessage({ job, error: e instanceof Error ? (e.stack ?? e.message) : String(e) })
  }
}
