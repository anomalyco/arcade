import { stageTraining, TRAINING_HOUSE, type TrainingState } from "../../shared/onboarding/training"
import type { LocalSession } from "../../shared/session"

/** Turns a freshly made offline session into the training room (`shared/onboarding/training.ts`). */
export function stageTrainingSession(session: LocalSession): LocalSession {
  const state = session.sim.getFeatureState<TrainingState>("onboarding")
  if (state) stageTraining(session.sim, state)
  session.rebuildCollision()
  return session
}

export function isTrainingSession(session: unknown): session is LocalSession {
  const sim = (session as Partial<LocalSession> | null)?.sim
  return Boolean(sim?.getFeatureState<TrainingState>("onboarding")?.active)
}

/** Boards nailed up in the training house, by opening, to carry into the run that follows. */
export function boardsUp(session: LocalSession): Record<string, number> {
  const out: Record<string, number> = {}
  const { town, ai } = session.sim
  for (const o of [...town.doors, ...town.windows]) {
    if (!o.id.startsWith(`${TRAINING_HOUSE}-`)) continue
    const n = ai.getBarricadePlanks(o.id)
    if (n > 0) out[o.id] = n
  }
  return out
}

/** The run starts later that day in the same house: the boards you put up are still there. */
export function carryBoards(session: LocalSession, boards: Record<string, number>): void {
  for (const [id, n] of Object.entries(boards)) for (let i = session.sim.ai.getBarricadePlanks(id); i < n; i++) session.sim.ai.addBarricadePlank(id)
  if (Object.keys(boards).length) session.rebuildCollision()
}
