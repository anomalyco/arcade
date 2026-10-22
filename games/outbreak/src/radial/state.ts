import type { InteractAction, InteractTarget } from "../../shared/interact"
import { netSendsAction } from "../../shared/net-protocol"
import type { Command, SessionView } from "../../shared/session"
import { blockedByBoards, BOARD_UP, boardPrompt } from "../prompt-clarity/board"

/** One wedge: the action it names and the command fields that take it. */
export type RadialOption = {
  action: InteractAction
  /** Where it comes from, for the prompt's key: tap E, the hold, Shift+E or B. */
  slot: "primary" | "secondary" | "alt" | "board"
  /** The target's kind, for the action's glyph. */
  kind: string
  send: Partial<Command>
}

/** Below this many CSS pixels from the centre nothing is picked (releasing there cancels). */
export const RADIAL_DEAD_ZONE = 16

/**
 * What the radial offers on `target`: E's tap, its hold, Shift+E's alternative and B's board-up, as the world prompt
 * shows them. Fewer than two means no menu: E acts at once, as Today. A primary that is itself a hold (hotwire, cut a
 * chain) keeps Today's hold, so the radial never opens there.
 */
export function radialOptions(
  view: Pick<SessionView, "actorId" | "progression" | "barricadePlanks">,
  target: InteractTarget | undefined,
): RadialOption[] {
  if (!target || target.primary.hold) return []
  const board = boardPrompt(view, target)
  const out: RadialOption[] = []
  const add = (slot: RadialOption["slot"], action: InteractAction | undefined) => {
    if (!action || out.some((o) => o.action.id === action.id && o.action.label === action.label)) return
    if (slot !== "primary" && !netSendsAction(action.id)) return
    const send: Partial<Command> =
      slot === "primary" ? { interact: true, ...(netSendsAction(action.id) ? { interactAction: action.id } : {}) } : { interact: true, interactAction: action.id }
    out.push({ action, slot, kind: target.kind, send })
  }
  if (!blockedByBoards(target, board)) add("primary", target.primary)
  add("secondary", target.secondary)
  add("alt", target.alt)
  if (board?.canBoard) add("board", BOARD_UP)
  return out.length >= 2 ? out : []
}

/** The wedge under a cursor `dx, dy` px from the centre: wedge 0 is straight up, the rest follow clockwise. */
export function pickWedge(dx: number, dy: number, count: number, deadZone = RADIAL_DEAD_ZONE): number {
  if (count <= 0 || Math.hypot(dx, dy) < deadZone) return -1
  const step = (Math.PI * 2) / count
  const fromUp = Math.atan2(dx, -dy)
  return ((Math.round(fromUp / step) % count) + count) % count
}

/** Where wedge `i` of `count` sits, as a unit offset from the centre (screen y down). */
export function wedgeOffset(i: number, count: number): { x: number; y: number } {
  const a = (i / count) * Math.PI * 2
  return { x: Math.sin(a), y: -Math.cos(a) }
}

type Point = { x: number; y: number }

/**
 * The radial E menu (playtest Oct 21, 1:45:21: "It should be that radial thing where you press E and then it gives
 * you the radial thing to pick what action you want to do and you can just click it"). On a target with one action
 * E acts at once. With more, a quick tap still takes E's own action on release; holding past `delay` opens a ring at
 * the cursor. Point at a wedge and let go of E, click it, or press its number; let go in the middle or press Esc to
 * cancel. While it is open the aim holds still (the cursor picks, it doesn't turn you) and nothing fires.
 */
export class RadialInteract {
  phase: "idle" | "pending" | "open" | "spent" = "idle"
  options: RadialOption[] = []
  targetId = ""
  /** Screen centre (CSS px) and the aim frozen at the press. */
  centre: Point = { x: 0, y: 0 }
  aim = 0
  hover = -1
  private pressedAt = 0
  private delay = 0.2
  /** Called on every reset, so the drawn ring hides even when frames stop (the pause menu). */
  onReset?: () => void

  /** E went down. Returns true when the press is the radial's (the caller drops the tap). */
  press(now: number, options: RadialOption[], targetId: string, cursor: Point, aim: number): boolean {
    if (options.length < 2 || this.phase !== "idle") return false
    this.phase = "pending"
    this.options = options
    this.targetId = targetId
    this.centre = { ...cursor }
    this.aim = aim
    this.hover = -1
    this.pressedAt = now
    return true
  }

  /**
   * Once a frame with E's state, the cursor and the current target. Returns the command to send when a choice is made
   * (a quick tap's primary, or the wedge under the cursor on release), else null.
   */
  frame(now: number, held: boolean, cursor: Point, targetId: string | undefined, delay: number): Partial<Command> | null {
    this.delay = delay
    if (this.phase === "spent") {
      if (!held) this.reset()
      return null
    }
    if (this.phase === "idle") return null
    if (targetId !== this.targetId) {
      this.phase = held ? "spent" : "idle"
      if (!held) this.reset()
      return null
    }
    if (this.phase === "pending") {
      if (!held) {
        // A tap is E's own action; on a boarded door that is Today's refusal ("Blocked by barricade").
        const send = this.options[0]!.slot === "primary" ? this.options[0]!.send : { interact: true }
        this.reset()
        return send
      }
      if (now - this.pressedAt >= delay * 1000) this.phase = "open"
      else return null
    }
    this.hover = pickWedge(cursor.x - this.centre.x, cursor.y - this.centre.y, this.options.length)
    if (!held) {
      const send = this.hover >= 0 ? this.options[this.hover]!.send : null
      this.reset()
      return send
    }
    return null
  }

  /** A click or number key while open: takes that wedge (the cursor's for a click). E must then be let go. */
  choose(index: number): Partial<Command> | null {
    if (this.phase !== "open" || index < 0 || index >= this.options.length) return null
    const send = this.options[index]!.send
    this.phase = "spent"
    this.hover = -1
    return send
  }

  /** How far a held E is towards opening the radial (0..1), for the world prompt's hold ring; 0 unless pending. */
  openProgress(now: number): number {
    return this.phase === "pending" ? Math.min(1, (now - this.pressedAt) / Math.max(1, this.delay * 1000)) : 0
  }

  cancel(): void {
    if (this.phase === "pending" || this.phase === "open") this.phase = "spent"
  }

  /** Whether E's hold, the aim and the trigger are the radial's this frame. */
  get busy(): boolean {
    return this.phase !== "idle"
  }

  get isOpen(): boolean {
    return this.phase === "open"
  }

  reset(): void {
    this.phase = "idle"
    this.options = []
    this.targetId = ""
    this.hover = -1
    this.onReset?.()
  }
}

/** The one radial the input drives and the HUD draws. */
export const radialInteract = new RadialInteract()
