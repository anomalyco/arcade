import { Spring, springMotion } from "../core/spring.js"

/**
 * Reset's ↺ turns once, the way its arrow points (counter-clockwise), each time it resets: Kit's
 * "smooth" spring (.45 s, bounce 0), so it sets off at once and settles softly. A press mid-turn
 * adds a turn to where it's headed, keeping its speed. With reduced motion it blinks instead.
 */
const TURN = springMotion({ duration: 0.45, bounce: 0 })
/** The reduced-motion blink: the glyph dips to 45% and back over this long (ms). */
const BLINK_MS = 180

interface SpinState {
  readonly spring: Spring
  blinkAt: number
  frame: number
  last: number
  rest?: () => void
}
const spins = new WeakMap<Element, SpinState>()

const reducedMotion = (el: Element) =>
  el.ownerDocument.defaultView?.matchMedia("(prefers-reduced-motion: reduce)").matches ?? false

/** The blink's opacity `ms` after it started (1 when there's none). */
const blinkAt = (ms: number) =>
  ms >= BLINK_MS ? 1 : 1 - 0.55 * Math.sin((Math.PI * ms) / BLINK_MS)

/**
 * One more turn for the ↺ in `button` (its first `.knobs-icon`), from wherever it is now; `rest`
 * runs once it has stopped.
 */
export function spin(button: HTMLElement, wake?: () => void, rest?: () => void) {
  const icon = button.querySelector<SVGElement>(".knobs-icon")
  const win = button.ownerDocument.defaultView
  if (!icon || !win) return
  let s = spins.get(button)
  if (!s) {
    s = { spring: new Spring(0, TURN.omega, TURN.zeta, 0.05), blinkAt: -1, frame: 0, last: 0 }
    spins.set(button, s)
  }
  const state = s
  state.rest = rest
  const now = win.performance.now()
  if (reducedMotion(button)) state.blinkAt = now
  else state.spring.set(state.spring.target - 360)
  wake?.()
  if (state.frame) return
  state.last = now
  const tick = (t: number) => {
    state.spring.step(Math.max(0, (t - state.last) / 1000))
    state.last = t
    const blinking = state.blinkAt >= 0 && t - state.blinkAt < BLINK_MS
    if (!blinking) state.blinkAt = -1
    // At rest a whole number of turns is no turn at all: crisp again, ready for the next.
    if (state.spring.resting) state.spring.snap(0)
    icon.style.rotate = state.spring.x ? `${state.spring.x}deg` : ""
    icon.style.opacity = blinking ? String(blinkAt(t - state.blinkAt)) : ""
    wake?.()
    state.frame = state.spring.resting && !blinking ? 0 : win.requestAnimationFrame(tick)
    if (!state.frame) state.rest?.()
  }
  state.frame = win.requestAnimationFrame(tick)
}

/** Whether `button`'s ↺ is turning (or blinking). */
export const spinning = (button: Element) => (spins.get(button)?.frame ?? 0) !== 0

/** Where `button`'s ↺ is now, for the GPU renderer: its turn (radians, clockwise) and opacity. */
export function spinOf(button: Element, now: number) {
  const s = spins.get(button)
  if (!s) return { angle: 0, alpha: 1, moving: false }
  const blinking = s.blinkAt >= 0 && now - s.blinkAt < BLINK_MS
  return {
    angle: (s.spring.x * Math.PI) / 180,
    alpha: blinking ? blinkAt(now - s.blinkAt) : 1,
    moving: s.frame !== 0,
  }
}
