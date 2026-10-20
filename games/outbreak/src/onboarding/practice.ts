import type { LoadoutId } from "../../shared/loadout"
import type { LocalSession, SessionView } from "../../shared/session"
import { TrainingGuide, type BeatHint } from "./beats"
import { stagePracticeSession, swapPracticeKit } from "./session"

/** The lobby's practice space: a local session in the training room's house, with the kit the lobby has picked. */
export type Practice = { session: LocalSession; guide: TrainingGuide; loadout: LoadoutId; age: number }

/** Seconds before the first hint, so the lobby lands before anything points. */
const FIRST_HINT = 0.8

export function startPractice(session: LocalSession, loadout: LoadoutId): Practice {
  return { session: stagePracticeSession(session, loadout), guide: new TrainingGuide(), loadout, age: 0 }
}

/** In reach, the world prompt already says it: a hint only leads you to the thing. */
export function quietHint(hint: BeatHint | null, prompt: SessionView["prompt"]): BeatHint | null {
  if (hint && prompt && (prompt.id === hint.target || prompt.kind === hint.targetKind)) return null
  return hint
}

/**
 * One frame of the practice space: the lobby's kit swapped in if it changed, the guide stepped, and the hint for the
 * first thing not yet tried. Hints only suggest: nothing waits on them and Ready is always one key away.
 */
export function stepPractice(pr: Practice, loadout: LoadoutId | undefined, dt: number, caseOpened: boolean): BeatHint | null {
  if (loadout && loadout !== pr.loadout) {
    pr.loadout = loadout
    swapPracticeKit(pr.session, loadout)
  }
  if (caseOpened) pr.guide.noteCase()
  pr.age += dt
  const { sim, view } = pr.session
  const beat = pr.guide.step(sim, view.actorId, dt)
  return pr.age > FIRST_HINT ? quietHint(pr.guide.hint(sim, view.actorId, beat), view.prompt) : null
}
