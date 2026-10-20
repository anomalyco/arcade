// What the view plays: a handful of episodes stepped together on the main thread. A generation show replays the latest
// generation (its best solid, a sample of the rest as ghosts); a replay show loops the best policy found. The sim is
// deterministic, so these are exactly the runs the workers scored.

import { Episode, policyShape, type RewardSettings } from "../shared/episode"
import { Policy } from "../shared/policy"
import type { CreatureId } from "../shared/creatures"
import type { LastGeneration } from "../shared/train-worker"
import { envKey, type Env } from "../shared/tasks"
import type { SavedPolicy } from "../shared/trainer"

export type Role = "best" | "ghost" | "pretrained" | "saved"

export type Runner = {
  ep: Episode
  role: Role
  label: string
  /** Fitness the trainer recorded for this run (replays must match it). */
  expected: number | null
}

export class Show {
  /** Seconds since every runner finished (the show holds its last frame briefly). */
  idle = 0

  constructor(readonly kind: "generation" | "replay", readonly runners: Runner[], readonly gen: number) {}

  get lead(): Runner | undefined {
    return this.runners.find((r) => r.role === "best" || r.role === "saved") ?? this.runners[0]
  }

  /**
   * A replay ends when every runner has. A generation ends once its own runners have all finished, fallen or stalled
   * (no 5 cm of progress for 2 s: early generations kneel for the whole episode), so the next one comes up quickly. The
   * gold pre-trained runner never holds a generation up.
   */
  get done(): boolean {
    if (this.kind === "replay") return this.runners.every((r) => r.ep.done)
    return this.runners.every((r) => r.role === "pretrained" || r.ep.done || this.stalled(r))
  }

  private progress = new Map<Runner, { x: number; t: number }>()

  private stalled(r: Runner): boolean {
    const p = this.progress.get(r)
    return p !== undefined && r.ep.time - p.t > 2
  }

  /** Steps every unfinished runner by `steps` control steps, stopping early (and returning true) once `stop` says so. */
  advance(steps: number, stop?: () => boolean): boolean {
    for (let s = 0; s < steps; s++) {
      if (stop?.()) return true
      let any = false
      for (const r of this.runners) {
        if (r.ep.done) continue
        r.ep.step()
        any = true
        const p = this.progress.get(r)
        if (!p) this.progress.set(r, { x: r.ep.distance, t: r.ep.time })
        else if (r.ep.distance > p.x + 0.05) { p.x = r.ep.distance; p.t = r.ep.time }
      }
      if (!any) break
    }
    return false
  }
}

/** A saved policy's run; in another env (say a pre-trained thief in a lower curriculum stage) there is no score to match. */
export function policyRunner(saved: SavedPolicy, role: Role, label: string, fallback: RewardSettings, env: Env = saved.env): Runner {
  const reward = saved.reward ?? fallback
  const shape = policyShape(saved.creature, saved.hidden)
  const ep = new Episode(saved.creature, env, new Policy(shape, Float64Array.from(saved.params)), reward)
  return { ep, role, label, expected: envKey(env) === envKey(saved.env) ? saved.fitness : null }
}

/** The latest generation: its best individual solid plus up to `ghosts` others (the top half first, then a spread). */
export function generationShow(trainer: { last: LastGeneration | null; creature: CreatureId; hidden: number }, ghosts: number, extra: Runner[]): Show | null {
  const last = trainer.last
  if (!last) return null
  const { params, rows, results, gen } = last
  const n = params.length / rows
  const order = Array.from({ length: rows }, (_, i) => i).sort((a, b) => results.fitness[b]! - results.fitness[a]! || a - b)
  const shape = policyShape(trainer.creature, trainer.hidden)
  const pick = order.slice(0, 1 + Math.min(ghosts, rows - 1))
  const runners: Runner[] = pick.map((i, rank) => ({
    ep: new Episode(trainer.creature, last.env, new Policy(shape, params.slice(i * n, (i + 1) * n)), last.reward),
    role: rank === 0 ? "best" : "ghost",
    label: rank === 0 ? `best of gen ${gen}` : "",
    expected: results.fitness[i]!,
  }))
  return new Show("generation", [...extra, ...runners.reverse()], gen)
}
