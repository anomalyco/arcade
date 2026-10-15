import type { SessionView } from "../../shared/session"

/**
 * Inside a closet the world is seen through its louvred doors: dark slats across the screen, eased in as the doors
 * pull to and out as they open. No words; E lets you out, and the prompt already says so.
 */
export class ClosetView {
  private readonly el: HTMLElement | null
  private shown = 0
  /** Whether the local survivor is hidden, for proofs. */
  hidden = false

  constructor(doc: Document | null = typeof document === "undefined" ? null : document) {
    if (!doc) {
      this.el = null
      return
    }
    let el = doc.getElementById("closet-slats")
    if (!el) {
      el = doc.createElement("div")
      el.id = "closet-slats"
      el.setAttribute("aria-hidden", "true")
      doc.body.appendChild(el)
    }
    this.el = el
  }

  update(view: SessionView, dt: number): void {
    this.hidden = Boolean(view.progression.verbs.hiddenIn(view.actorId))
    const goal = this.hidden ? 1 : 0
    const rate = this.hidden ? 5 : 7
    this.shown += (goal - this.shown) * Math.min(1, Math.max(0, dt) * rate)
    if (Math.abs(goal - this.shown) < 0.002) this.shown = goal
    if (this.el) this.el.style.opacity = this.shown.toFixed(3)
  }
}
