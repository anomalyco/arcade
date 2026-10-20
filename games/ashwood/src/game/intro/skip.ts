import { isEditableEventTarget, keyLabel } from "@arcade/kit/client/controls"

// Cutscene input: hold Space (or Esc, where Esc isn't the pause key) for a second to skip, and mouse look while seated.
// A small ring in the bottom-right corner fades in on any key press, fills while the key is held and drains when it's
// let go.
//
// The play shell (src/game/shell/play.ts) swallows every key and mouse event at window capture while the player isn't
// in control, which includes the whole intro. These listeners are registered when this module is first imported,
// which is before the shell is created, so they run ahead of its gate and only act while a cutscene is active.

const HOLD_S = 1
const R = 13
const C = 2 * Math.PI * R

type Active = { held: Set<string>; keys: Set<string>; look: { x: number; y: number }; shown: () => void }
let active: Active | null = null

addEventListener(
  "keydown",
  (e: KeyboardEvent) => {
    if (!active || isEditableEventTarget(e.target)) return
    active.shown()
    if (active.keys.has(e.code)) {
      e.preventDefault()
      active.held.add(e.code)
    }
  },
  { capture: true },
)
addEventListener("keyup", (e: KeyboardEvent) => active?.held.delete(e.code), { capture: true })
addEventListener("blur", () => active?.held.clear())
addEventListener(
  "mousemove",
  (e: MouseEvent) => {
    if (!active || !document.pointerLockElement) return
    active.look.x += e.movementX
    active.look.y += e.movementY
  },
  { capture: true },
)

/** `keys`: physical codes that skip when held (Space; add Escape where Esc doesn't pause). */
export function createSkip(onSkip: () => void, keys: readonly string[] = ["Space", "Escape"]) {
  const el = document.createElement("div")
  el.style.cssText =
    "position:fixed;right:28px;bottom:26px;z-index:7;display:flex;align-items:center;gap:10px;pointer-events:none;" +
    "font:11px/1 ui-monospace,Menlo,monospace;letter-spacing:0.22em;text-transform:uppercase;color:rgba(214,228,220,0.62);" +
    "opacity:0;transition:opacity 0.5s ease"
  el.innerHTML =
    `<span class="skip-label"></span>` +
    `<svg width="34" height="34" viewBox="0 0 34 34" style="transform:rotate(-90deg)">` +
    `<circle cx="17" cy="17" r="${R}" fill="none" stroke="rgba(214,228,220,0.18)" stroke-width="2"/>` +
    `<circle class="skip-arc" cx="17" cy="17" r="${R}" fill="none" stroke="rgba(232,162,84,0.85)" stroke-width="2" ` +
    `stroke-dasharray="${C}" stroke-dashoffset="${C}" stroke-linecap="round"/></svg>`
  document.body.append(el)
  const arc = el.querySelector<SVGCircleElement>(".skip-arc")!
  el.querySelector<HTMLSpanElement>(".skip-label")!.textContent = `Hold ${keyLabel("Space")} to skip`

  let fill = 0
  let shownUntil = 0
  let done = false
  const me: Active = { held: new Set(), keys: new Set(keys), look: { x: 0, y: 0 }, shown: () => (shownUntil = performance.now() + 3500) }
  active = me

  return {
    /** Mouse movement (px) since the last call. */
    takeLook() {
      const l = { x: me.look.x, y: me.look.y }
      me.look.x = me.look.y = 0
      return l
    },
    /** Per frame (real seconds). */
    update(dt: number) {
      if (done) return
      fill = me.held.size ? Math.min(1, fill + dt / HOLD_S) : Math.max(0, fill - dt * 2.5)
      if (me.held.size) shownUntil = performance.now() + 2500
      el.style.opacity = performance.now() < shownUntil || fill > 0 ? "1" : "0"
      arc.style.strokeDashoffset = String(C * (1 - fill))
      if (fill >= 1) {
        done = true
        onSkip()
      }
    },
    dispose() {
      done = true
      if (active === me) active = null
      el.style.opacity = "0"
      setTimeout(() => el.remove(), 600)
    },
  }
}
