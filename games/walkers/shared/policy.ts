// A tiny MLP policy: observations → tanh hidden layer → tanh motor commands in [-1, 1]. Parameters are one flat
// Float64Array (W1 row-major, b1, W2, b2) so evolution strategies can treat a policy as a point in R^n.

import { tanh } from "./fmath"

export type PolicyShape = { inputs: number; hidden: number; outputs: number }

export const paramCount = ({ inputs, hidden, outputs }: PolicyShape): number => hidden * inputs + hidden + outputs * hidden + outputs

export class Policy {
  private h: Float64Array

  constructor(readonly shape: PolicyShape, public params: Float64Array) {
    if (params.length !== paramCount(shape)) throw new Error(`policy expects ${paramCount(shape)} params, got ${params.length}`)
    this.h = new Float64Array(shape.hidden)
  }

  act(obs: ArrayLike<number>, out: Float64Array): Float64Array {
    const { inputs, hidden, outputs } = this.shape
    const p = this.params
    const h = this.h
    let k = 0
    for (let i = 0; i < hidden; i++) {
      let sum = 0
      for (let j = 0; j < inputs; j++) sum += p[k++]! * obs[j]!
      h[i] = sum
    }
    for (let i = 0; i < hidden; i++) h[i] = tanh(h[i]! + p[k++]!)
    for (let i = 0; i < outputs; i++) {
      let sum = 0
      for (let j = 0; j < hidden; j++) sum += p[k++]! * h[j]!
      out[i] = sum
    }
    for (let i = 0; i < outputs; i++) out[i] = tanh(out[i]! + p[k++]!)
    return out
  }
}

/** Deterministic standard-normal-ish samples from uniforms (Irwin–Hall of four, rescaled): no log or cos, so every engine agrees. */
export function gaussian(rand: () => number): number {
  return (rand() + rand() + rand() + rand() - 2) * 1.7320508075688772
}

/** Scaled random initial weights (fan-in), small output layer so the first generation twitches rather than thrashes. */
export function initParams(shape: PolicyShape, rand: () => number): Float64Array {
  const p = new Float64Array(paramCount(shape))
  const { inputs, hidden, outputs } = shape
  let k = 0
  const s1 = 1 / Math.sqrt(inputs)
  for (let i = 0; i < hidden * inputs; i++) p[k++] = gaussian(rand) * s1
  k += hidden
  const s2 = 0.5 / Math.sqrt(hidden)
  for (let i = 0; i < outputs * hidden; i++) p[k++] = gaussian(rand) * s2
  return p
}
