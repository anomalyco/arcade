import type { InteractAction } from "../../shared/interact"
import { promptGlyph } from "../hud/prompt-glyphs"

/**
 * Which action a prompt row stands for, for counting uses: the target's kind and the glyph (or label) the action
 * draws, so opening and closing a door are learned separately, and every ground drop counts as one action.
 */
export function actionKey(kind: string, action: Pick<InteractAction, "id" | "label">): string {
  const glyph = promptGlyph(kind, action as InteractAction).glyph
  return `a:${kind}:${glyph ?? action.label}`
}

/**
 * The word beside an action's glyph while it is still being learned: its label, except that a drop names what it
 * holds ("9mm Ammo") rather than "Pick up 9mm Ammo". Null once the action has been done `uses` times.
 */
export function teachingWord(kind: string, action: Pick<InteractAction, "id" | "label">, done: number, uses: number): string | null {
  if (uses <= 0 || done >= uses) return null
  const label = action.label
  if (action.id === "take" && label.startsWith("Pick up ") && label !== "Pick up all") return label.slice(8)
  return label
}
