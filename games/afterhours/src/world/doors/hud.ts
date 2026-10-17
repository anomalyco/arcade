import { keyPromptHtml } from "@arcade/kit/client/key-cap"
import { onKeyLayoutChange } from "@arcade/kit/client/controls"

// The door prompt: one small key-cap row just under the screen centre (`E Open`, `E Close`, `E Locked`), fading in
// and out. Rebuilt only when the verb changes or the key-label setting does.

export type DoorVerb = "Open" | "Close" | "Locked" | null

export class DoorPrompt {
  private el: HTMLDivElement
  private verb: DoorVerb = null

  constructor() {
    this.el = document.createElement("div")
    this.el.className = "door-prompt"
    Object.assign(this.el.style, {
      position: "fixed",
      left: "50%",
      top: "58%",
      transform: "translate(-50%, 0)",
      pointerEvents: "none",
      opacity: "0",
      transition: "opacity 0.18s ease",
      font: "12px/1 ui-monospace, Menlo, monospace",
      letterSpacing: "0.12em",
      textTransform: "uppercase",
      color: "rgba(226, 234, 228, 0.82)",
      textShadow: "0 1px 3px rgba(0, 0, 0, 0.8)",
      zIndex: "3",
    } satisfies Partial<CSSStyleDeclaration>)
    this.el.style.setProperty("--akc-size", "22px")
    document.body.append(this.el)
    onKeyLayoutChange(() => this.render())
  }

  set(verb: DoorVerb) {
    if (verb === this.verb) return
    this.verb = verb
    if (verb) this.render()
    else this.el.style.opacity = "0"
  }

  /** Brief red tint when a locked door is tried. */
  flash() {
    this.el.style.color = "rgba(240, 168, 140, 0.95)"
    setTimeout(() => (this.el.style.color = "rgba(226, 234, 228, 0.82)"), 450)
  }

  private render() {
    if (!this.verb) return
    this.el.innerHTML = keyPromptHtml("KeyE", this.verb)
    this.el.style.opacity = this.verb === "Locked" ? "0.75" : "1"
  }
}
