import { keyCapHtml } from "@arcade/kit/client/key-cap"

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** What the interactions hint shows this frame: the cap, its verb, and a hold ring's progress. */
export type InteractionHint = { code: string; verb: string; hold: boolean; progress: number; note?: string }

/**
 * The world interactions' one line of teaching (AR-96), low over the survivor while an interaction is in reach or in
 * hand: `◯LMB Throw` with the ring filling as the throw winds up, `E Drag`, and so on. DOM over the canvas, rebuilt
 * only when its markup changes. The onboarding pass owns the training room; this is the in-world reminder.
 */
export class InteractionsHint {
  private readonly el: HTMLDivElement
  private html = ""
  readonly shown = { verb: "" }

  constructor(doc: Document = document) {
    this.el = doc.createElement("div")
    this.el.className = "ob-interact-hint"
    Object.assign(this.el.style, {
      position: "fixed",
      left: "50%",
      bottom: "21%",
      transform: "translateX(-50%)",
      display: "none",
      gap: "8px",
      alignItems: "center",
      padding: "5px 10px 5px 6px",
      borderRadius: "999px",
      background: "rgba(10, 10, 12, 0.55)",
      color: "#ece6d8",
      font: "600 13px/1 system-ui, sans-serif",
      letterSpacing: "0.02em",
      pointerEvents: "none",
      zIndex: "30",
      whiteSpace: "nowrap",
    } satisfies Partial<CSSStyleDeclaration>)
    doc.body.appendChild(this.el)
  }

  show(hints: readonly InteractionHint[]): void {
    const html = hints
      .map((h) => `<span style="display:inline-flex;gap:6px;align-items:center">${keyCapHtml(h.code, { hold: h.hold, progress: h.progress })}<span>${esc(h.verb)}</span>${h.note ? `<span style="opacity:.6;font-weight:500">${esc(h.note)}</span>` : ""}</span>`)
      .join('<span style="opacity:.35">·</span>')
    this.shown.verb = hints.map((h) => h.verb).join(" · ")
    if (html === this.html) return
    this.html = html
    this.el.innerHTML = html
    this.el.style.display = html ? "inline-flex" : "none"
  }
}
