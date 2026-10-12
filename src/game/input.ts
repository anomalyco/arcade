/**
 * Keyboard and mouse. WASD or arrows move on screen axes, the mouse aims, hold right click to look further ahead, hold left click to fire, hold Shift to sprint, R reloads, G or middle click
 * throws or plants your equipment, 1/2/3 pick a gun and 4/5 frag or claymore for your next life, Tab shows the scores.
 */
export class Input {
  private keys = new Set<string>()
  private reloadPressed = false
  private equipPressed = false
  mouse = { x: innerWidth / 2, y: innerHeight / 2 }
  firing = false
  /** Right mouse held: push the camera further toward the cursor. */
  looking = false
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
      if (e.code === "KeyG" && !e.repeat) this.equipPressed = true
    })
    addEventListener("keyup", (e) => this.keys.delete(e.code))
    addEventListener("blur", () => {
      this.keys.clear()
      this.firing = false
      this.looking = false
    })
    addEventListener("mousemove", (e) => {
      this.mouse.x = e.clientX
      this.mouse.y = e.clientY
    })
    canvas.addEventListener("mousedown", (e) => {
      if (e.button === 0) this.firing = true
      if (e.button === 2) this.looking = true
      if (e.button === 1) {
        e.preventDefault()
        this.equipPressed = true
      }
    })
    addEventListener("mouseup", (e) => {
      if (e.button === 0) this.firing = false
      if (e.button === 2) this.looking = false
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

  get sprinting(): boolean {
    return this.enabled && (this.held("ShiftLeft") || this.held("ShiftRight"))
  }

  takeEquip(): boolean {
    const r = this.equipPressed
    this.equipPressed = false
    return r && this.enabled
  }

  takeReload(): boolean {
    const r = this.reloadPressed
    this.reloadPressed = false
    return r && this.enabled
  }
}
