// OpenAI-style evolution strategies (Salimans et al. 2017): sample antithetic Gaussian perturbations of the policy
// parameters, score each perturbed policy with one episode, and move the mean along the rank-weighted sum of the
// perturbations with Adam. No gradients, no value function, and every episode is independent, so it spreads across
// workers trivially. Deterministic for a seed.

import { mulberry32 } from "@arcade/kit/sim/rng"
import { gaussian } from "./policy"

export type EsSettings = {
  /** Antithetic pairs per generation (population = 2·pairs + the mean). */
  pairs: number
  /** Perturbation size. */
  sigma: number
  /** Adam step size. */
  lr: number
  /** L2 pull toward zero per step. */
  weightDecay: number
}

export const DEFAULT_ES: EsSettings = { pairs: 32, sigma: 0.06, lr: 0.03, weightDecay: 0.005 }

export class Es {
  readonly theta: Float64Array
  private m: Float64Array
  private v: Float64Array
  private b1t = 1
  private b2t = 1
  private eps: Float64Array = new Float64Array(0)
  private rand: () => number
  generation = 0

  constructor(initial: Float64Array, public settings: EsSettings, seed: number) {
    this.theta = Float64Array.from(initial)
    this.m = new Float64Array(initial.length)
    this.v = new Float64Array(initial.length)
    this.rand = mulberry32(seed)
  }

  get size(): number {
    return this.theta.length
  }

  /** Population size for the current settings: the mean first, then +ε₀, −ε₀, +ε₁, −ε₁, … */
  get population(): number {
    return 1 + 2 * this.settings.pairs
  }

  /** The next generation's parameters, one row per individual. */
  ask(): Float64Array {
    const n = this.size
    const { pairs, sigma } = this.settings
    this.eps = new Float64Array(pairs * n)
    for (let i = 0; i < this.eps.length; i++) this.eps[i] = gaussian(this.rand)
    const out = new Float64Array((1 + 2 * pairs) * n)
    out.set(this.theta, 0)
    for (let k = 0; k < pairs; k++) {
      const plus = (1 + 2 * k) * n, minus = plus + n, e = k * n
      for (let i = 0; i < n; i++) {
        const d = sigma * this.eps[e + i]!
        out[plus + i] = this.theta[i]! + d
        out[minus + i] = this.theta[i]! - d
      }
    }
    return out
  }

  /** Updates the mean from the fitness of every row ask() returned (row 0, the mean, is not used for the step). */
  tell(fitness: ArrayLike<number>): void {
    const n = this.size
    const { pairs, sigma, lr, weightDecay } = this.settings
    const count = 2 * pairs
    // Centered ranks in [-0.5, 0.5]: robust to the scale and outliers of raw fitness.
    const order = Array.from({ length: count }, (_, i) => i)
    order.sort((a, b) => fitness[1 + a]! - fitness[1 + b]! || a - b)
    const rank = new Float64Array(count)
    for (let r = 0; r < count; r++) rank[order[r]!] = count > 1 ? r / (count - 1) - 0.5 : 0
    const g = new Float64Array(n)
    for (let k = 0; k < pairs; k++) {
      const w = rank[2 * k]! - rank[2 * k + 1]!
      if (w === 0) continue
      const e = k * n
      for (let i = 0; i < n; i++) g[i]! += w * this.eps[e + i]!
    }
    const scale = 1 / (count * sigma)
    const b1 = 0.9, b2 = 0.999
    this.b1t *= b1
    this.b2t *= b2
    const c1 = 1 - this.b1t, c2 = 1 - this.b2t
    for (let i = 0; i < n; i++) {
      const gi = g[i]! * scale - weightDecay * this.theta[i]!
      this.m[i] = b1 * this.m[i]! + (1 - b1) * gi
      this.v[i] = b2 * this.v[i]! + (1 - b2) * gi * gi
      this.theta[i]! += (lr * (this.m[i]! / c1)) / (Math.sqrt(this.v[i]! / c2) + 1e-8)
    }
    this.generation++
  }
}
