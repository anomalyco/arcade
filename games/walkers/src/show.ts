// What the view plays: a handful of episodes stepped together on the main thread. A generation show replays the latest
// generation (its best solid, a sample of the rest as ghosts); a replay show loops the best policy found. The sim is
// deterministic, so these are exactly the runs the workers scored.

import { Episode, policyShape, type RewardSettings } from "../shared/episode"
import { Policy } from "../shared/policy"
import type { CreatureId } from "../shared/creatures"
import type { LastGeneration } from "../shared/train-worker"
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

  get done(): boolean {
    return this.runners.every((r) => r.ep.done)
  }

  /** Steps every unfinished runner by `steps` control steps. */
  advance(steps: number): void {
    for (let s = 0; s < steps; s++) {
      let any = false
      for (const r of this.runners) {
        if (r.ep.done) continue
        r.ep.step()
        any = true
      }
      if (!any) break
    }
  }
}

export function policyRunner(saved: SavedPolicy, role: Role, label: string, fallback: RewardSettings): Runner {
  const reward = saved.reward ?? fallback
  const shape = policyShape(saved.creature, saved.hidden)
  const ep = new Episode(saved.creature, saved.task, new Policy(shape, Float64Array.from(saved.params)), reward)
  return { ep, role, label, expected: saved.fitness }
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
    ep: new Episode(trainer.creature, last.task, new Policy(shape, params.slice(i * n, (i + 1) * n)), last.reward),
    role: rank === 0 ? "best" : "ghost",
    label: rank === 0 ? `best of gen ${gen}` : "",
    expected: results.fitness[i]!,
  }))
  return new Show("generation", [...extra, ...runners.reverse()], gen)
}
