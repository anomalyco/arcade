import { installHudType } from "../world/doors/hud"

// The current objective: one quiet typewriter line at the top of the screen, in the prompts' face and ink. A new
// objective fades in bright, holds, then dims to a faint persistent line; `pulseObjective()` (the map calls it when
// raised) brings it back up for a moment; `completeObjective()` strikes it through and fades it out.
//
//   setObjective("Find the radio room — 3-08")
//   completeObjective()

const BRIGHT = "rgba(214, 204, 182, 0.82)"
const QUIET = "rgba(206, 196, 174, 0.36)"
const HOLD_MS = 5200
const PULSE_MS = 2600

let el: HTMLDivElement | null = null
let label: HTMLSpanElement | null = null
let current: string | null = null
let dimTimer = 0
let clearTimer = 0

function ensure() {
  if (el || typeof document === "undefined") return el
  installHudType()
  el = document.createElement("div")
  el.className = "objective"
  Object.assign(el.style, {
    position: "fixed",
    left: "50%",
    top: "22px",
    transform: "translate(-50%, 0)",
    pointerEvents: "none",
    opacity: "0",
    transition: "opacity 1.1s ease, color 1.6s ease, letter-spacing 1.6s ease",
    font: '12px/1.4 "Afterhours Type", "American Typewriter", "Courier New", monospace',
    letterSpacing: "0.16em",
    textTransform: "uppercase",
    color: BRIGHT,
    textShadow: "0 0 5px rgba(0, 0, 0, 0.9)",
    whiteSpace: "nowrap",
    zIndex: "5",
  } satisfies Partial<CSSStyleDeclaration>)
  label = document.createElement("span")
  label.style.transition = "text-decoration-color 0.6s ease"
  el.appendChild(label)
  document.body.appendChild(el)
  return el
}

function brighten(ms: number) {
  if (!el || current === null) return
  clearTimeout(dimTimer)
  el.style.opacity = "1"
  el.style.color = BRIGHT
  dimTimer = window.setTimeout(() => {
    if (el && current !== null) el.style.color = QUIET
  }, ms)
}

/** Shows a new objective (fades in, holds, then dims to a quiet line that stays). */
export function setObjective(text: string) {
  if (!ensure() || !el || !label) return
  clearTimeout(clearTimer)
  const show = () => {
    current = text
    label!.textContent = text
    label!.style.textDecoration = "none"
    brighten(HOLD_MS)
  }
  // Replacing a visible objective: let the old one go first.
  if (current !== null && el.style.opacity !== "0") {
    el.style.opacity = "0"
    clearTimer = window.setTimeout(show, 900)
  } else show()
}

/** Strikes the current objective through and fades it out. */
export function completeObjective() {
  if (!el || !label || current === null) return
  clearTimeout(dimTimer)
  clearTimeout(clearTimer)
  el.style.color = BRIGHT
  label.style.textDecoration = "line-through"
  current = null
  clearTimer = window.setTimeout(() => el && (el.style.opacity = "0"), 1600)
}

/** Brings the current objective back up briefly (raising the map). */
export function pulseObjective() {
  brighten(PULSE_MS)
}

/** Removes the line at once (quitting to the title). */
export function clearObjective() {
  clearTimeout(dimTimer)
  clearTimeout(clearTimer)
  current = null
  if (el) el.style.opacity = "0"
}

export const objectiveText = () => current
