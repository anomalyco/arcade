import { installHudType } from "../world/doors/hud"
import { hooks } from "../audio/hooks"

// The current objective: one typewriter line at the top of the screen, in warm amber on a soft dark backing, so it
// stands apart from the off-white prompts (centre) and subtitles (bottom). A NEW objective types in under a brighter
// glow with a quiet tick, holds at full brightness for ~8 s, then settles to a dimmer persistent line that still reads.
// `pulseObjective()` (the map calls it when raised) brings it back up for a moment; `completeObjective()` strikes it
// through and fades it out.
//
//   setObjective("Find the radio room — 3-08")
//   completeObjective()

/** Full brightness (new / pulsed), the brief entrance flare, and the persistent line. */
const INK = { full: "rgba(240, 196, 112, 1)", flare: "rgba(255, 226, 160, 1)", rest: "rgba(226, 184, 108, 0.78)" }
const GLOW = { full: "0 0 3px rgba(0,0,0,1), 0 1px 2px rgba(0,0,0,1), 0 0 14px rgba(240,170,70,0.35)", flare: "0 0 3px rgba(0,0,0,1), 0 0 18px rgba(255,200,110,0.75)", rest: "0 0 3px rgba(0,0,0,1), 0 1px 2px rgba(0,0,0,1)" }
const BACK = { full: "rgba(4, 6, 5, 0.6)", rest: "rgba(4, 6, 5, 0.42)" }
const HOLD_MS = 8000
const PULSE_MS = 3000
/** Per-character type-in interval (ms), capped so long lines still arrive in ~1 s. */
const TYPE_MS = 28

let el: HTMLDivElement | null = null
let tag: HTMLSpanElement | null = null
let label: HTMLSpanElement | null = null
let current: string | null = null
let dimTimer = 0
let clearTimer = 0
let typeTimer = 0

function ensure() {
  if (el || typeof document === "undefined") return el
  installHudType()
  el = document.createElement("div")
  el.className = "objective"
  Object.assign(el.style, {
    position: "fixed",
    left: "50%",
    top: "20px",
    transform: "translate(-50%, 0)",
    pointerEvents: "none",
    opacity: "0",
    transition: "opacity 0.6s ease, color 1.4s ease, text-shadow 1.4s ease, background-color 1.4s ease, box-shadow 1.4s ease",
    font: '21px/1.35 "Ashwood Type", "American Typewriter", "Courier New", monospace',
    letterSpacing: "0.12em",
    textTransform: "uppercase",
    color: INK.full,
    textShadow: GLOW.full,
    background: BACK.full,
    boxShadow: "0 0 22px 8px rgba(4, 6, 5, 0.4)",
    padding: "6px 18px 7px",
    borderRadius: "3px",
    whiteSpace: "nowrap",
    maxWidth: "92vw",
    zIndex: "6",
  } satisfies Partial<CSSStyleDeclaration>)
  tag = document.createElement("span")
  Object.assign(tag.style, { fontSize: "13px", letterSpacing: "0.22em", marginRight: "0.9em", opacity: "0.7", verticalAlign: "2px" })
  tag.textContent = "Objective"
  label = document.createElement("span")
  el.append(tag, label)
  document.body.appendChild(el)
  return el
}

function look(state: keyof typeof GLOW) {
  if (!el) return
  el.style.color = INK[state]
  el.style.textShadow = GLOW[state]
  el.style.background = state === "rest" ? BACK.rest : BACK.full
  el.style.boxShadow = state === "rest" ? "0 0 16px 6px rgba(4, 6, 5, 0.28)" : "0 0 22px 8px rgba(4, 6, 5, 0.4)"
}

function brighten(ms: number) {
  if (!el || current === null) return
  clearTimeout(dimTimer)
  el.style.opacity = "1"
  look("full")
  dimTimer = window.setTimeout(() => current !== null && look("rest"), ms)
}

/** A quiet typewriter/paper tick for a new objective (silent until the game audio exists). */
function tick() {
  hooks.sfx?.play("ui-notify", { bus: "ui", gain: 0.45 })
}

/** Shows a new objective: types in under a brief flare with a tick, holds ~8 s, then dims to a persistent line. */
export function setObjective(text: string) {
  if (!ensure() || !el || !label) return
  clearTimeout(clearTimer)
  clearTimeout(typeTimer)
  const show = () => {
    current = text
    label!.style.textDecoration = "none"
    label!.textContent = ""
    el!.style.opacity = "1"
    look("flare")
    clearTimeout(dimTimer)
    tick()
    const step = Math.min(TYPE_MS, 1000 / Math.max(1, text.length))
    let n = 0
    const type = () => {
      if (current !== text) return
      n = Math.min(text.length, n + 1)
      // The untyped rest is laid out but invisible, so the line types in place instead of re-centring.
      const rest = document.createElement("span")
      rest.style.visibility = "hidden"
      rest.textContent = text.slice(n)
      label!.textContent = text.slice(0, n)
      label!.appendChild(rest)
      if (n < text.length) typeTimer = window.setTimeout(type, step)
      else typeTimer = window.setTimeout(() => current === text && brighten(HOLD_MS), 450)
    }
    type()
  }
  // Replacing a visible objective: let the old one go first.
  if (current !== null && el.style.opacity !== "0") {
    el.style.opacity = "0"
    clearTimer = window.setTimeout(show, 700)
  } else show()
}

/** Strikes the current objective through and fades it out. */
export function completeObjective() {
  if (!el || !label || current === null) return
  clearTimeout(dimTimer)
  clearTimeout(clearTimer)
  clearTimeout(typeTimer)
  label.textContent = current
  look("full")
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
  clearTimeout(typeTimer)
  current = null
  if (el) el.style.opacity = "0"
}

export const objectiveText = () => current
