import { isEditableEventTarget } from "@arcade/kit/client/controls"

// Driving input. The play shell gates every key and mouse event at window capture while the player isn't on foot
// (flow.playerActive false, which is the case while driving), so these listeners are registered when this module is
// first imported (statically, by the shell, before it creates its gate) and run ahead of it. They only act while
// `drive.active`; `onPress` handlers (E on foot by the truck, E in the cab) see presses even when the shell would
// swallow them, and may claim them.

const held = new Set<string>()
const look = { x: 0, y: 0 }
const presses: ((code: string, e: KeyboardEvent) => boolean) [] = []

export const drive = {
  /** Driving keys are read and the mouse turns the head. */
  active: false,
  held,
  /** Mouse movement (px) since the last call, while active and pointer-locked. */
  takeLook() {
    const l = { x: look.x, y: look.y }
    look.x = look.y = 0
    return l
  },
  /** Axis −1..1 from two physical keys. */
  axis(neg: string[], pos: string[]) {
    return (pos.some((k) => held.has(k)) ? 1 : 0) - (neg.some((k) => held.has(k)) ? 1 : 0)
  },
  /** A press handler: return true to claim the event (it stops there). Returns a remover. */
  onPress(fn: (code: string, e: KeyboardEvent) => boolean) {
    presses.push(fn)
    return () => {
      const i = presses.indexOf(fn)
      if (i >= 0) presses.splice(i, 1)
    }
  },
}

addEventListener(
  "keydown",
  (e: KeyboardEvent) => {
    if (isEditableEventTarget(e.target)) return
    if (!e.repeat) for (const fn of [...presses]) if (fn(e.code, e)) {
      e.preventDefault()
      e.stopImmediatePropagation()
      return
    }
    if (!drive.active) return
    held.add(e.code)
    // Driving keys never reach the on-foot controller (Space would jump, C crouch); Esc still pauses.
    if (e.code !== "Escape" && e.code !== "Backquote") {
      if (e.code === "Space") e.preventDefault()
      e.stopImmediatePropagation()
    }
  },
  { capture: true },
)
addEventListener("keyup", (e: KeyboardEvent) => held.delete(e.code), { capture: true })
addEventListener("blur", () => held.clear())
addEventListener(
  "mousemove",
  (e: MouseEvent) => {
    if (!drive.active || !document.pointerLockElement) return
    look.x += e.movementX
    look.y += e.movementY
  },
  { capture: true },
)
