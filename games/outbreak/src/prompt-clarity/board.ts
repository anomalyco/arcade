import type { InteractAction, InteractTarget } from "../../shared/interact"
import type { SessionView } from "../../shared/session"

/** Boards a door or window holds at most (`OutbreakAISubsystem.addBarricadePlank`). */
export const MAX_PLANKS = 3

/** B at a door or window: boarding up is its own key, drawn in the prompt like an E action. */
export const BOARD_UP: InteractAction = { id: "barricade", label: "Board up" }

/** What B does at the targeted opening, and what is already nailed up there. */
export type BoardPrompt = {
  /** Boards across it now, 0–3. */
  planks: number
  /** B would nail another board (planks in the belt, room left) or re-nail a damaged one (crowbar in hand). */
  canBoard: boolean
}

/**
 * B boards the opening the prompt points at (`OutbreakProgression.barricadeTarget` prefers it), so the prompt can say
 * so. Null for anything but a door or window, or a view without barricade state.
 */
export function boardPrompt(view: Pick<SessionView, "actorId" | "progression" | "barricadePlanks">, target: InteractTarget | undefined): BoardPrompt | null {
  if (!target || (target.kind !== "door" && target.kind !== "window") || !view.barricadePlanks) return null
  const planks = view.barricadePlanks(target.id)
  const ledger = view.progression.ledger
  const hasPlank = ledger.count(view.actorId, "plank") > 0
  const crowbar = view.progression.selected(view.actorId)?.item === "crowbar"
  return { planks, canBoard: (planks < MAX_PLANKS && hasPlank) || (planks > 0 && crowbar) }
}

/** E on a boarded door is refused ("Blocked by barricade"); a boarded window can still be peeked through. */
export function blockedByBoards(target: InteractTarget, board: BoardPrompt | null): boolean {
  return Boolean(board && board.planks > 0 && target.primary.id !== "peek")
}
