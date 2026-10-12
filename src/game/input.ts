/**
 * Keyboard and mouse. WASD or arrows move, the mouse aims, hold left click to fire, R reloads, 1/2/3 pick a gun
 * for your next life, Tab shows the scores.
 */
export class Input {
  private keys = new Set<string>()
  private reloadPressed = false
  mouse = { x: innerWidth / 2, y: innerHeight / 2 }
  firing = false
  enabled = false
  onKey: ((code: string) => void) | null = null

  constructor(canvas: HTMLElement) {
    addEventListener("keydown", (e) => {
      if (e.target instanceof HTMLInputElement) return
      if (e.code === "Tab") e.preventDefault()
      if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) e.preventDefault()
      if (!e.repeat) this.onKey?.(e.code)
      this.keys.add(e.code)
      if (e.code === "KeyR") this.reloadPressed = true
    })
    addEventListener("keyup", (e) => this.keys.delete(e.code))
    addEventListener("blur", () => {
      this.keys.clear()
      this.firing = false
    })
    addEventListener("mousemove", (e) => {
      this.mouse.x = e.clientX
      this.mouse.y = e.clientY
    })
    canvas.addEventListener("mousedown", (e) => {
      if (e.button === 0) this.firing = true
    })
    addEventListener("mouseup", (e) => {
      if (e.button === 0) this.firing = false
    })
    canvas.addEventListener("contextmenu", (e) => e.preventDefault())
  }

  held(code: string): boolean {
    return this.keys.has(code)
  }

  move(): { mx: number; my: number } {
    if (!this.enabled) return { mx: 0, my: 0 }
    let mx = 0
    let my = 0
    if (this.held("KeyW") || this.held("ArrowUp")) my -= 1
    if (this.held("KeyS") || this.held("ArrowDown")) my += 1
    if (this.held("KeyA") || this.held("ArrowLeft")) mx -= 1
    if (this.held("KeyD") || this.held("ArrowRight")) mx += 1
    return { mx, my }
  }

  takeReload(): boolean {
    const r = this.reloadPressed
    this.reloadPressed = false
    return r && this.enabled
  }
}
