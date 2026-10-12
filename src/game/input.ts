import type { Stance } from "../../shared/config"

/**
 * Keyboard and mouse. Held keys are sampled every tick; presses are latched until the next tick reads them so a quick
 * tap is never lost. WASD or arrows move, Shift runs, C (or Ctrl) sneaks, the mouse aims, left click fires, R reloads,
 * Q and E throw gadgets at the cursor, F uses doors and breakers, Tab shows the scoreboard.
 */
export class Input {
  private keys = new Set<string>()
  private presses = { fire: false, reload: false, use: false, gadget: -1 as -1 | 0 | 1 }
  mouse = { x: 0, y: 0 }
  enabled = false
  onKey: ((code: string) => void) | null = null

  constructor(canvas: HTMLElement) {
    addEventListener("keydown", (e) => {
      if (e.target instanceof HTMLInputElement) return
      this.onKey?.(e.code)
      if (e.code === "Tab") e.preventDefault()
      if (!this.enabled) return
      if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) e.preventDefault()
      if (e.repeat) return
      this.keys.add(e.code)
      if (e.code === "KeyR") this.presses.reload = true
      if (e.code === "KeyF") this.presses.use = true
      if (e.code === "KeyQ") this.presses.gadget = 0
      if (e.code === "KeyE") this.presses.gadget = 1
    })
    addEventListener("keyup", (e) => this.keys.delete(e.code))
    addEventListener("blur", () => this.keys.clear())
    addEventListener("mousemove", (e) => {
      this.mouse.x = e.clientX
      this.mouse.y = e.clientY
    })
    canvas.addEventListener("mousedown", (e) => {
      if (e.button === 0 && this.enabled) this.presses.fire = true
    })
    canvas.addEventListener("contextmenu", (e) => e.preventDefault())
  }

  held(code: string): boolean {
    return this.keys.has(code)
  }

  move(): { mx: number; my: number; stance: Stance } {
    if (!this.enabled) return { mx: 0, my: 0, stance: "walk" }
    let mx = 0
    let my = 0
    if (this.held("KeyW") || this.held("ArrowUp")) my -= 1
    if (this.held("KeyS") || this.held("ArrowDown")) my += 1
    if (this.held("KeyA") || this.held("ArrowLeft")) mx -= 1
    if (this.held("KeyD") || this.held("ArrowRight")) mx += 1
    const stance: Stance = this.held("ShiftLeft") || this.held("ShiftRight") ? "run" : this.held("KeyC") || this.held("ControlLeft") ? "sneak" : "walk"
    return { mx, my, stance }
  }

  /** Presses since the last call. */
  take(): { fire: boolean; reload: boolean; use: boolean; gadget: -1 | 0 | 1 } {
    const p = this.presses
    this.presses = { fire: false, reload: false, use: false, gadget: -1 }
    return this.enabled ? p : { fire: false, reload: false, use: false, gadget: -1 }
  }
}
