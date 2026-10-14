/**
 * Turret controls, first person:
 * - Mouse under Pointer Lock: aim (the game's src/input.ts owns the lock aboard; the harness takes it itself with
 *   `grab`). Without the lock (denied, headless) dragging aims.
 * - Left mouse (under the lock) or Space: fire (hold: the CIWS and the gun keep firing; a SAM leaves per press).
 * - Right mouse held: the sight's zoom.
 * Keys match by physical position (`e.code`) and by character (`e.key`); everything releases on Cmd-up and on blur.
 * Space and the mouse are movement keys on no layout. Leaving the turret is SHIP OPERATIONS (E), not a key here.
 */
export class TurretInput {
  /** Off: nothing is read (not manning a turret, menus, debug panel). */
  enabled = false
  /** Take Pointer Lock on a click itself (the harness). */
  grab = false
  private keys = new Set<string>()
  private dx = 0
  private dy = 0
  private left = false
  private right = false
  /** Test hooks: when set, override the trigger and the zoom. */
  trigger: boolean | null = null
  zoom: boolean | null = null

  constructor(private canvas: HTMLCanvasElement) {
    addEventListener("keydown", (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.code === "Space" && this.enabled) e.preventDefault()
      if (this.keys.has(e.code)) return
      this.keys.add(e.code)
    })
    addEventListener("keyup", (e) => {
      this.keys.delete(e.code)
      if (e.code === "MetaLeft" || e.code === "MetaRight") this.release()
    })
    addEventListener("blur", () => this.release())
    canvas.addEventListener("mousedown", (e) => {
      const locked = document.pointerLockElement === canvas
      if (e.button === 0 && !locked && this.grab && this.enabled) {
        const c = canvas as HTMLCanvasElement & { requestPointerLock(o?: { unadjustedMovement?: boolean }): Promise<void> | void }
        try {
          void Promise.resolve(c.requestPointerLock()).catch(() => {})
        } catch {
          // No Pointer Lock: dragging aims.
        }
      }
      if (e.button === 0 && locked) this.left = true
      if (e.button === 2) this.right = true
    })
    addEventListener("mouseup", (e) => {
      if (e.button === 0) this.left = false
      if (e.button === 2) this.right = false
    })
    document.addEventListener("pointerlockchange", () => {
      if (document.pointerLockElement !== canvas) this.left = false
    })
    addEventListener("mousemove", (e) => {
      const locked = document.pointerLockElement === canvas
      if (!locked && !(e.buttons & 1)) return
      this.dx += e.movementX
      this.dy += e.movementY
    })
  }

  release(): void {
    this.keys.clear()
    this.left = false
    this.right = false
  }

  /** Mouse movement since the last `endFrame` (CSS px). */
  get lookX(): number {
    return this.enabled ? this.dx : 0
  }

  get lookY(): number {
    return this.enabled ? this.dy : 0
  }

  get fire(): boolean {
    if (!this.enabled) return false
    if (this.trigger !== null) return this.trigger
    return this.left || this.keys.has("Space")
  }

  get scope(): boolean {
    if (!this.enabled) return false
    if (this.zoom !== null) return this.zoom
    return this.right
  }

  endFrame(): void {
    this.dx = this.dy = 0
  }
}
