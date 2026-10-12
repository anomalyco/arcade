import { THROW_RANGE } from "../../shared/config"
import { NO_INTENT, type Intent } from "../../shared/sim/world"

/**
 * Keyboard and mouse → one Intent per simulation tick. Presses are latched between ticks so a quick tap is never lost.
 * WASD/arrows move; hold Shift to run, C to sneak; LMB fires (wind-up); R reloads; Q and E use gadgets (aimed at the
 * cursor); F opens or closes a door. Space also runs.
 */
export class Controls {
  private keys = new Set<string>()
  private latched = { fire: false, reload: false, use: false, gadget: -1 as -1 | 0 | 1 }
  mouse = { x: 0, y: 0, inside: false }
  /** Cursor position in world metres, set by the camera each frame. */
  cursor = { x: 0, y: 0 }
  /** Local player's position, used for aim. */
  origin = { x: 0, y: 0 }
  enabled = true
  onKey?: (code: string) => void

  constructor(target: HTMLElement) {
    addEventListener("keydown", (e) => {
      if (isTyping(e.target)) return
      if (!this.enabled) return
      if (!e.repeat) this.keys.add(e.code)
      if (e.repeat) return
      switch (e.code) {
        case "KeyR":
          this.latched.reload = true
          break
        case "KeyF":
          this.latched.use = true
          break
        case "KeyQ":
          this.latched.gadget = 0
          break
        case "KeyE":
          this.latched.gadget = 1
          break
      }
      this.onKey?.(e.code)
      if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) e.preventDefault()
    })
    addEventListener("keyup", (e) => this.keys.delete(e.code))
    addEventListener("blur", () => this.keys.clear())
    target.addEventListener("mousemove", (e) => {
      this.mouse.x = e.clientX
      this.mouse.y = e.clientY
      this.mouse.inside = true
    })
    target.addEventListener("mouseleave", () => (this.mouse.inside = false))
    target.addEventListener("mousedown", (e) => {
      if (e.button === 0 && this.enabled) this.latched.fire = true
    })
    target.addEventListener("contextmenu", (e) => e.preventDefault())
  }

  private down(...codes: string[]): boolean {
    return codes.some((c) => this.keys.has(c))
  }

  /** Samples the held keys and latched presses into an intent for this tick. */
  sample(me: { x: number; y: number }): Intent {
    if (!this.enabled) return { ...NO_INTENT }
    let mx = 0
    let my = 0
    if (this.down("KeyW", "ArrowUp")) my -= 1
    if (this.down("KeyS", "ArrowDown")) my += 1
    if (this.down("KeyA", "ArrowLeft")) mx -= 1
    if (this.down("KeyD", "ArrowRight")) mx += 1
    const stance = this.down("ShiftLeft", "ShiftRight", "Space") ? "run" : this.down("KeyC") ? "sneak" : "walk"
    const aim = Math.atan2(this.cursor.y - me.y, this.cursor.x - me.x)
    const i: Intent = {
      mx,
      my,
      stance,
      aim,
      fire: this.latched.fire,
      reload: this.latched.reload,
      gadget: this.latched.gadget,
      tx: me.x + Math.cos(aim) * Math.min(THROW_RANGE, Math.hypot(this.cursor.x - me.x, this.cursor.y - me.y)),
      ty: me.y + Math.sin(aim) * Math.min(THROW_RANGE, Math.hypot(this.cursor.x - me.x, this.cursor.y - me.y)),
      use: this.latched.use,
    }
    this.latched = { fire: false, reload: false, use: false, gadget: -1 }
    return i
  }

  held(code: string): boolean {
    return this.keys.has(code)
  }
}

function isTyping(t: EventTarget | null): boolean {
  return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement
}
