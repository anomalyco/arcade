// Evaluates a batch of policies, one episode each (run inside eval-worker.ts, or inline).

import type { CreatureId } from "./creatures"
import { evaluate, policyShape, type RewardSettings } from "./episode"
import type { Env } from "./tasks"

export type EvalRequest = {
  id: number
  creature: CreatureId
  env: Env
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
  /** 0 ran out of time, 1 fell, 2 finished (escaped, in the heist), 3 caught by the alarm. */
  outcome: Uint8Array
  /** 1 when the episode ended holding the gem. */
  gem: Uint8Array
  /** Heist alarms set off. */
  alarms: Uint8Array
  /** Human runs charged for non-foot contact. */
  unrealistic?: Uint8Array
}

export const OUTCOME_CODE = { running: 0, timeout: 0, fell: 1, finished: 2, caught: 3 } as const

export function evaluateBatch(req: EvalRequest): EvalResponse {
  const shape = policyShape(req.creature, req.hidden)
  const n = req.params.length / req.count
  const fitness = new Float64Array(req.count)
  const distance = new Float64Array(req.count)
  const steps = new Float64Array(req.count)
  const outcome = new Uint8Array(req.count)
  const gem = new Uint8Array(req.count)
  const alarms = new Uint8Array(req.count)
  const unrealistic = new Uint8Array(req.count)
  for (let i = 0; i < req.count; i++) {
    const r = evaluate(req.creature, req.env, shape, req.params.subarray(i * n, (i + 1) * n), req.reward)
    fitness[i] = r.fitness
    distance[i] = r.distance
    steps[i] = Math.round(r.time * 60)
    outcome[i] = OUTCOME_CODE[r.outcome]
    gem[i] = r.gem ? 1 : 0
    alarms[i] = r.alarms
    unrealistic[i] = (r.gait?.illegalContactSeconds ?? 0) > 0 ? 1 : 0
  }
  return { id: req.id, fitness, distance, steps, outcome, gem, alarms, unrealistic }
}
