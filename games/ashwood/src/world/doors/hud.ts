import { keyPromptHtml } from "@arcade/kit/client/key-cap"
import { onKeyLayoutChange } from "@arcade/kit/client/controls"

// The interaction prompt: a quiet line just under the screen centre (`E Open`, `E Close`, `E Locked`) in the
// documents' typewriter face, warm off-white at low contrast, with the kit's minimal key glyph (a thin outline, no
// glossy cap; the QWERTY label of physical KeyE). Fades in and out. The lift's prompts take the same look (class
// `door-prompt akc-minimal`, inline style copied from this one), and so does the help bar (src/style.css).

export type DoorVerb = "Open" | "Close" | "Locked" | null

/** The HUD's typewriter face (public/fonts/SpecialElite-hud.woff2), registered once as "Ashwood Type". */
export function installHudType() {
  if (typeof document === "undefined" || (globalThis as { __ahType?: boolean }).__ahType) return
  ;(globalThis as { __ahType?: boolean }).__ahType = true
  const face = new FontFace("Ashwood Type", `url(${new URL("fonts/SpecialElite-hud.woff2", document.baseURI).href})`, { display: "swap" })
  face
    .load()
    .then((f) => document.fonts.add(f))
    .catch(() => {})
}

const INK = "rgba(206, 196, 174, 0.66)"
const INK_LOCKED = "rgba(186, 128, 108, 0.7)"

export class DoorPrompt {
  private el: HTMLDivElement
  private verb: DoorVerb = null

  constructor() {
    installHudType()
    this.el = document.createElement("div")
    this.el.className = "door-prompt akc-minimal"
    Object.assign(this.el.style, {
      position: "fixed",
      left: "50%",
      top: "58%",
      transform: "translate(-50%, 0)",
      pointerEvents: "none",
      opacity: "0",
      transition: "opacity 0.35s ease, color 0.3s ease",
      font: '12px/1 "Ashwood Type", "American Typewriter", "Courier New", monospace',
      letterSpacing: "0.16em",
      textTransform: "uppercase",
      color: INK,
      textShadow: "0 0 5px rgba(0, 0, 0, 0.75)",
      zIndex: "3",
    } satisfies Partial<CSSStyleDeclaration>)
    this.el.style.setProperty("--akc-size", "17px")
    document.body.append(this.el)
    onKeyLayoutChange(() => this.render())
  }

  set(verb: DoorVerb) {
    if (verb === this.verb) return
    this.verb = verb
    if (verb) this.render()
    else this.el.style.opacity = "0"
  }

  /** A dull red for a moment when a locked door is tried. */
  flash() {
    this.el.style.color = INK_LOCKED
    setTimeout(() => (this.el.style.color = INK), 600)
  }

  private render() {
    if (!this.verb) return
    this.el.innerHTML = keyPromptHtml("KeyE", this.verb, { minimal: true })
    this.el.style.opacity = this.verb === "Locked" ? "0.6" : "0.9"
  }
}
