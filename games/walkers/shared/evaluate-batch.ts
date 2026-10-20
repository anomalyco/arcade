// Evaluates a batch of policies, one episode each (run inside eval-worker.ts, or inline).

import type { CreatureId } from "./creatures"
import { evaluate, policyShape, type RewardSettings } from "./episode"
import type { TaskId } from "./tasks"

export type EvalRequest = {
  id: number
  creature: CreatureId
  task: TaskId
  hidden: number
  reward: RewardSettings
  /** count rows of params, back to back. */
  params: Float64Array
  count: number
}

export type EvalResponse = {
  id: number
  fitness: Float64Array
  distance: Float64Array
  /** Control steps each episode ran. */
  steps: Float64Array
  /** 1 fell, 2 finished, 0 ran out of time. */
  outcome: Uint8Array
}

export function evaluateBatch(req: EvalRequest): EvalResponse {
  const shape = policyShape(req.creature, req.hidden)
  const n = req.params.length / req.count
  const fitness = new Float64Array(req.count)
  const distance = new Float64Array(req.count)
  const steps = new Float64Array(req.count)
  const outcome = new Uint8Array(req.count)
  for (let i = 0; i < req.count; i++) {
    const r = evaluate(req.creature, req.task, shape, req.params.subarray(i * n, (i + 1) * n), req.reward)
    fitness[i] = r.fitness
    distance[i] = r.distance
    steps[i] = Math.round(r.time * 60)
    outcome[i] = r.fell ? 1 : r.finished ? 2 : 0
  }
  return { id: req.id, fitness, distance, steps, outcome }
}
