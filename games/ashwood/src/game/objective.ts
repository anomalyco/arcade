import { installHudType } from "../world/doors/hud"
import { hooks } from "../audio/hooks"

// The current objective, as picked in the HUD lab: a NEW objective types in as a centred title (no box), holds a few
// seconds and fades; it then lives in the top-left corner as a quiet small-caps line under a dim "OBJECTIVE" label.
// `pulseObjective()` (the map calls it when raised) brightens the corner line for a moment; `completeObjective()`
// strikes the corner line through and fades it, and the next objective arrives centred again.
//
//   setObjective("Find the radio room: 3-08")
//   completeObjective()

const TYPE = '"Ashwood Type", "American Typewriter", "Courier New", monospace'
/** The centred arrival (hud-lab "Transient title"). */
const TITLE = { color: "rgba(232, 224, 204, 0.92)", shadow: "0 0 10px rgba(0, 0, 0, 0.95), 0 0 2px #000" }
/** The corner line (hud-lab "Small caps"): full when new or pulsed, dimmer at rest. */
const CORNER = { full: "rgba(214, 204, 182, 0.86)", rest: "rgba(214, 204, 182, 0.62)", shadow: "0 0 6px rgba(0, 0, 0, 0.95), 0 0 2px #000" }
/** Per-character type-in interval (ms), capped so long lines still arrive in ~1.4 s. */
const TYPE_MS = 45
/** Seconds the centred title holds once typed, and its fade. */
const HOLD_S = 3.5
const FADE_S = 1.8
/** Seconds the corner line stays bright after settling or a pulse. */
const BRIGHT_S = 3
/** Seconds a struck-through line stays before it fades. */
const STRIKE_S = 1.6

let title: HTMLDivElement | null = null
let corner: HTMLDivElement | null = null
let line: HTMLSpanElement | null = null
let current: string | null = null
const timers = new Set<number>()
const later = (s: number, f: () => void) => {
  const id = window.setTimeout(() => {
    timers.delete(id)
    f()
  }, s * 1000)
  timers.add(id)
}
const cancel = () => {
  for (const id of timers) clearTimeout(id)
  timers.clear()
}

function ensure() {
  if (title || typeof document === "undefined") return title
  installHudType()
  // Both carry the `objective` class: the encounters' scare/ending styles hide `.objective`.
  title = document.createElement("div")
  title.className = "objective objective-title"
  Object.assign(title.style, {
    position: "fixed",
    left: "50%",
    top: "34%",
    transform: "translate(-50%, 0)",
    pointerEvents: "none",
    opacity: "0",
    transition: `opacity ${FADE_S}s ease`,
    font: `26px/1.3 ${TYPE}`,
    letterSpacing: "0.08em",
    color: TITLE.color,
    textShadow: TITLE.shadow,
    whiteSpace: "nowrap",
    zIndex: "6",
  } satisfies Partial<CSSStyleDeclaration>)
  corner = document.createElement("div")
  corner.className = "objective objective-corner"
  Object.assign(corner.style, {
    position: "fixed",
    left: "46px",
    top: "40px",
    pointerEvents: "none",
    opacity: "0",
    transition: "opacity 1.2s ease, color 1.4s ease",
    font: `15px/1.5 ${TYPE}`,
    letterSpacing: "0.14em",
    fontVariant: "small-caps",
    color: CORNER.rest,
    textShadow: CORNER.shadow,
    whiteSpace: "nowrap",
    maxWidth: "70vw",
    zIndex: "6",
  } satisfies Partial<CSSStyleDeclaration>)
  const tag = document.createElement("small")
  Object.assign(tag.style, { display: "block", fontSize: "10px", letterSpacing: "0.3em", textTransform: "uppercase", opacity: "0.5" })
  tag.textContent = "Objective"
  line = document.createElement("span")
  line.style.transition = "text-decoration-color 0.4s ease"
  corner.append(tag, line)
  document.body.append(title, corner)
  return title
}

function brighten(seconds: number) {
  if (!corner || current === null) return
  corner.style.opacity = "1"
  corner.style.color = CORNER.full
  const text = current
  later(seconds, () => current === text && corner && (corner.style.color = CORNER.rest))
}

/** A quiet typewriter/paper tick for a new objective (silent until the game audio exists). */
function tick() {
  hooks.sfx?.play("ui-notify", { bus: "ui", gain: 0.45 })
}

/** Types `text` into the centred title in place (the untyped rest is laid out but hidden, so it doesn't re-centre). */
function typeTitle(text: string, done: () => void) {
  const step = Math.min(TYPE_MS, 1400 / Math.max(1, text.length)) / 1000
  let n = 0
  const rest = document.createElement("span")
  rest.style.visibility = "hidden"
  const type = () => {
    if (current !== text || !title) return
    n = Math.min(text.length, n + 1)
    title.textContent = text.slice(0, n)
    rest.textContent = text.slice(n)
    title.append(rest)
    if (n < text.length) later(step, type)
    else done()
  }
  type()
}

/** Shows a new objective: centred, typed in, held, faded; then the quiet corner line. */
export function setObjective(text: string) {
  if (!ensure() || !title || !corner || !line) return
  cancel()
  current = text
  // The corner gives way while the new one arrives.
  corner.style.opacity = "0"
  title.style.transition = "none"
  title.style.opacity = "1"
  void title.offsetWidth
  title.style.transition = `opacity ${FADE_S}s ease`
  tick()
  typeTitle(text, () =>
    later(HOLD_S, () => {
      if (current !== text || !title || !line) return
      title.style.opacity = "0"
      line.style.textDecoration = "none"
      line.textContent = text
      later(FADE_S * 0.6, () => current === text && brighten(BRIGHT_S))
    }),
  )
}

/** Strikes the corner line through and fades it out. */
export function completeObjective() {
  if (!corner || !line || current === null) return
  cancel()
  if (title) title.style.opacity = "0"
  line.textContent = current
  line.style.textDecoration = "line-through"
  corner.style.opacity = "1"
  corner.style.color = CORNER.full
  current = null
  later(STRIKE_S, () => corner && (corner.style.opacity = "0"))
}

/** Brings the corner line up briefly (raising the map). */
export function pulseObjective() {
  if (title && Number(title.style.opacity) > 0) return
  brighten(BRIGHT_S)
}

/** Removes everything at once (quitting to the title). */
export function clearObjective() {
  cancel()
  current = null
  if (title) title.style.opacity = "0"
  if (corner) corner.style.opacity = "0"
}

export const objectiveText = () => current
