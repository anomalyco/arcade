// Web Worker (browser) and Bun Worker (headless trainer) entry: evaluates the batches the pool sends.

import { evaluateBatch, type EvalRequest } from "./evaluate-batch"

const scope = self as unknown as { onmessage: ((e: MessageEvent<EvalRequest>) => void) | null; postMessage(msg: unknown, transfer: Transferable[]): void }
scope.onmessage = (e) => {
  const res = evaluateBatch(e.data)
  scope.postMessage(res, [res.fitness.buffer, res.distance.buffer, res.steps.buffer, res.outcome.buffer])
}
