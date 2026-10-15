/**
 * Key-cap prompt glyphs shared by every game's HUD. Labels come from `keyLabel` (QWERTY names by default), so a cap
 * for physical `KeyE` reads "E" on every layout unless the player opted into their own layout's labels.
 *
 *   keyCapHtml("KeyE")                                  // tap cap
 *   keyCapHtml("KeyE", { hold: true, progress: 0.4 })   // hold cap: ring fills with the game's hold timer
 *   keyCapHtml("Mouse0")                                // left mouse button icon
 *   keyPromptHtml("KeyE", "Open", { hold: true })       // cap + verb, the usual prompt row
 *
 * Styles install themselves on first use. Theme with `--akc-face`, `--akc-ink`, `--akc-edge`, `--akc-ring` and
 * `--akc-track` on any ancestor.
 */
import { keyLabel } from "./controls"

export type KeyCapOptions = {
  /** Hold variant: a ring around the cap that fills while the key is held. */
  hold?: boolean
  /** Hold progress 0..1 from the game's hold timer. Any value above 0 also draws the cap pressed. */
  progress?: number
  /** Draws the cap pressed (key physically down) without changing progress. */
  down?: boolean
  /** Overrides the label; defaults to `keyLabel(code)`. */
  label?: string
  /** Extra class names for the outer element. */
  className?: string
}

const WIDE: Readonly<Record<string, string>> = {
  Space: "space",
  ShiftLeft: "wide",
  ShiftRight: "wide",
  ControlLeft: "wide",
  ControlRight: "wide",
  AltLeft: "wide",
  AltRight: "wide",
  MetaLeft: "wide",
  MetaRight: "wide",
  Tab: "wide",
  Enter: "wide",
  NumpadEnter: "wide",
  Escape: "wide",
  Backspace: "wide",
  CapsLock: "wide",
}

const MOUSE: Readonly<Record<string, "left" | "middle" | "right" | "wheel">> = {
  Mouse0: "left",
  Mouse1: "middle",
  Mouse2: "right",
  Wheel: "wheel",
}

const MOUSE_NAMES = { left: "Left mouse button", middle: "Middle mouse button", right: "Right mouse button", wheel: "Mouse wheel" }

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

function mouseSvg(button: "left" | "middle" | "right" | "wheel"): string {
  const left = button === "left" ? `<path class="akc-hot" d="M2 7.2V5.6A4 4 0 0 1 6 1.6V7.2Z"/>` : ""
  const right = button === "right" ? `<path class="akc-hot" d="M6 1.6A4 4 0 0 1 10 5.6V7.2H6Z"/>` : ""
  const wheel = button === "middle" || button === "wheel"
    ? `<rect class="akc-hot" x="5" y="3" width="2" height="3.2" rx="1"/>`
    : `<line x1="6" y1="1.6" x2="6" y2="7.2"/>`
  return `<svg class="akc-mouse" viewBox="0 0 12 16" aria-hidden="true">${left}${right}<rect x="2" y="1.6" width="8" height="12.8" rx="4"/><line x1="2" y1="7.2" x2="10" y2="7.2"/>${wheel}</svg>`
}

/** HTML for one key cap. Safe to rebuild every frame; markup is small and static apart from `--akc-p`. */
export function keyCapHtml(code: string, options: KeyCapOptions = {}): string {
  installKeyCapStyles()
  const mouse = MOUSE[code]
  const label = options.label ?? keyLabel(code)
  const progress = Math.max(0, Math.min(1, options.progress ?? 0))
  const down = options.down || progress > 0
  const name = mouse ? MOUSE_NAMES[mouse] : label
  const shape = mouse ? "mouse" : WIDE[code] ?? (label.length > 1 ? "wide" : "")
  const capClass = `akc-cap${shape ? ` akc-${shape}` : ""}`
  const face = mouse ? mouseSvg(mouse) : `<span class="akc-t">${esc(label)}</span>`
  const extra = options.className ? ` ${options.className}` : ""
  const downAttr = down ? ` data-down="true"` : ""
  if (!options.hold) {
    return `<kbd class="akc${extra}" aria-label="${esc(name)}"${downAttr}><span class="${capClass}">${face}</span></kbd>`
  }
  return `<kbd class="akc akc-hold${extra}" aria-label="Hold ${esc(name)}" style="--akc-p:${progress.toFixed(3)}"${downAttr}><span class="akc-ring" aria-hidden="true"></span><span class="${capClass}">${face}</span></kbd>`
}

/** HTML for a key cap followed by its action verb, the usual on-screen prompt row. */
export function keyPromptHtml(code: string, action: string, options: KeyCapOptions = {}): string {
  return `<span class="akp">${keyCapHtml(code, options)}<span class="akp-label">${esc(action)}</span></span>`
}

export const KEY_CAP_CSS = `
.akc {
  display: inline-grid;
  place-items: center;
  vertical-align: middle;
  font: inherit;
  line-height: 1;
  margin: 0;
  padding: 0;
  background: none;
  border: 0;
  color: inherit;
  flex: none;
}
.akc-cap {
  box-sizing: border-box;
  display: inline-grid;
  place-items: center;
  min-width: var(--akc-size, 1.7em);
  height: var(--akc-size, 1.7em);
  padding: 0 0.45em;
  border-radius: 0.34em;
  background: var(--akc-face, linear-gradient(#f6f4ec, #dedad0));
  color: var(--akc-ink, #121417);
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  font-weight: 750;
  letter-spacing: 0;
  text-transform: none;
  white-space: nowrap;
  box-shadow: 0 0.14em 0 var(--akc-edge, #7d7a71), 0 0 0 1px rgba(0, 0, 0, 0.6), 0 0.2em 0.55em rgba(0, 0, 0, 0.55);
  transform: translateY(-1px);
  transition: transform 70ms ease-out, box-shadow 70ms ease-out;
}
.akc[data-down="true"] .akc-cap {
  transform: translateY(1px);
  box-shadow: 0 0.02em 0 var(--akc-edge, #7d7a71), 0 0 0 1px rgba(0, 0, 0, 0.6), 0 0.1em 0.3em rgba(0, 0, 0, 0.5);
}
.akc-t { font-size: 0.86em; font-size: round(nearest, 0.86em, 1px); line-height: 1; }
.akc-wide { min-width: 2.9em; padding: 0 0.55em; }
.akc-space { min-width: 4.4em; }
.akc-wide .akc-t, .akc-space .akc-t { font-size: 0.7em; font-size: round(nearest, 0.7em, 1px); letter-spacing: 0.02em; }
.akc-mouse { width: 0.9em; height: 1.2em; fill: none; stroke: currentColor; stroke-width: 1.3; stroke-linecap: round; }
.akc-mouse .akc-hot { fill: currentColor; stroke: none; }
.akc-cap.akc-mouse { padding: 0; min-width: var(--akc-size, 1.7em); }
.akc-hold {
  position: relative;
  padding: 0.26em;
}
.akc-hold .akc-cap { border-radius: 999px; padding-inline: 0.5em; }
.akc-hold::before,
.akc-ring {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: 999px;
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0);
  pointer-events: none;
}
.akc-hold::before {
  inset: -1px;
  padding: calc(0.18em + 2px);
  background: rgba(0, 0, 0, 0.55);
}
.akc-ring {
  padding: 0.18em;
  background: conic-gradient(var(--akc-ring, #ffffff) calc(var(--akc-p, 0) * 1turn), var(--akc-track, rgba(255, 255, 255, 0.34)) 0);
}
.akc-hold[data-down="true"] .akc-ring {
  filter: drop-shadow(0 0 0.25em rgba(255, 255, 255, 0.55));
}
.akp { display: inline-flex; align-items: center; gap: 0.45em; white-space: nowrap; }
@media (prefers-reduced-motion: reduce) {
  .akc-cap, .akc[data-down="true"] .akc-cap { transition: none; transform: none; }
  .akc-hold[data-down="true"] .akc-ring { filter: none; }
}
`

let installed = false

/** Adds the key-cap stylesheet to the document once. Called automatically by `keyCapHtml`. */
export function installKeyCapStyles(doc: Document | undefined = globalThis.document): void {
  if (installed || !doc?.head) return
  installed = true
  if (doc.getElementById("arcade-key-cap")) return
  const style = doc.createElement("style")
  style.id = "arcade-key-cap"
  style.textContent = KEY_CAP_CSS
  doc.head.prepend(style)
}
