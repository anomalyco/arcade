import type { PlaneControls } from "../../shared/plane"

/**
 * Flight controls, Battlefield-style keyboard and mouse:
 * - W / S: throttle up / down (S also airbrakes); released, the throttle springs back to cruise.
 * - Q / E: rudder (yaw), by physical key only (the q/e characters sit on movement and free-look keys on Dvorak).
 * - A / D: roll (added to the mouse stick, like ←/→). Shift: afterburner.
 * - Mouse: a virtual stick (pitch on Y, roll on X) under Pointer Lock. Moving the mouse deflects it, it springs back to
 *   centre when the mouse stops, so a flick is a quick rate and a steady push holds a turn. Pull back (toward you) for
 *   nose up, like BF's default; `?invert` swaps it.
 * - Arrows: ↑ nose down, ↓ nose up, ←/→ roll (BF4's keyboard pitch/roll). Space fires (src/weapons/input.ts).
 * - Hold right or middle mouse, or X: free look (camera only). C: chase / cockpit camera. A flight only ends by landing
 *   on the carrier, a crash or being shot down: there is no key to quit it.
 *
 * Keys match by physical position (`e.code`) and by character (`e.key`), so any layout works; the character a key
 * produced on press is the one released (Shift changes it while held). Everything releases on Cmd-up and on blur.
 * None of C, R, X, F is a movement key on QWERTY, AZERTY or Dvorak.
 */
export class FlightInput {
  /** Mouse stick sensitivity (stick units per CSS pixel) and its spring back to centre (s). */
  static sensitivity = 0.012
  static spring = 0.11

  enabled = true
  invert = false
  /** Take Pointer Lock on a click itself (the harness). In the game src/input.ts owns the lock on the same canvas. */
  grab = true
  private keys = new Set<string>()
  private downs = new Set<string>()
  private stickX = 0
  private stickY = 0
  private lookDX = 0
  private lookDY = 0
  private buttons = 0
  private locked = false
  /** Test hook: when set, overrides the stick (pitch, roll in -1..1). */
  override: { pitch: number; roll: number; yaw?: number } | null = null

  constructor(private canvas: HTMLCanvasElement) {
    canvas.tabIndex = -1
    addEventListener("keydown", (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) e.preventDefault()
      if (this.keys.has(e.code)) return
      this.keys.add(e.code)
      this.downs.add(e.code)
    })
    addEventListener("keyup", (e) => {
      this.keys.delete(e.code)
      if (e.code === "MetaLeft" || e.code === "MetaRight") this.release()
    })
    addEventListener("blur", () => this.release())
    canvas.addEventListener("mousedown", (e) => {
      e.preventDefault()
      canvas.focus({ preventScroll: true })
      this.buttons = e.buttons
      if (this.grab && this.enabled && !this.locked && e.button === 0) void this.lock()
    })
    addEventListener("mouseup", (e) => {
      this.buttons = e.buttons
    })
    addEventListener("mousemove", (e) => {
      // Without Pointer Lock (denied, or headless) a held left button still flies.
      if (!this.locked && !(e.buttons & 1) && !(e.buttons & 6)) return
      if (this.freeLook) {
        this.lookDX += e.movementX
        this.lookDY += e.movementY
      } else if (this.enabled) {
        const s = FlightInput.sensitivity
        this.stickX = clamp(this.stickX + e.movementX * s, -1, 1)
        this.stickY = clamp(this.stickY + e.movementY * s * (this.invert ? -1 : 1), -1, 1)
      }
    })
    canvas.addEventListener("contextmenu", (e) => e.preventDefault())
    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement === canvas
      if (!this.locked) this.stickX = this.stickY = 0
    })
  }

  private async lock(): Promise<void> {
    try {
      await this.canvas.requestPointerLock({ unadjustedMovement: true } as never)
    } catch {
      try {
        await this.canvas.requestPointerLock()
      } catch {
        // Pointer Lock unavailable: left-drag flies instead.
      }
    }
  }

  /** Springs the stick to centre now (a new sortie starts level, whatever the mouse did aboard). */
  centre(): void {
    this.stickX = this.stickY = 0
  }

  unlock(): void {
    if (document.pointerLockElement === this.canvas) document.exitPointerLock()
  }

  get pointerLocked(): boolean {
    return this.locked
  }

  release(): void {
    this.keys.clear()
    this.downs.clear()
    this.buttons = 0
    this.stickX = this.stickY = 0
  }

  private any(...k: string[]): boolean {
    for (const x of k) if (this.keys.has(x)) return true
    return false
  }

  pressed(...k: string[]): boolean {
    for (const x of k) if (this.downs.has(x)) return true
    return false
  }

  get freeLook(): boolean {
    return (this.buttons & 6) !== 0 || this.any("KeyX")
  }

  /** Mouse movement for the free-look camera since the last frame (CSS px). */
  get look(): { dx: number; dy: number } {
    return { dx: this.lookDX, dy: this.lookDY }
  }

  get cameraToggle(): boolean {
    return this.pressed("KeyC")
  }

  /** F: land, while the HUD offers it (otherwise F is flares, src/weapons/input.ts). */
  get land(): boolean {
    return this.pressed("KeyF")
  }

  /** Launch from the deck in the offline harness (flight.html): Enter. The game launches from SHIP OPERATIONS. */
  get launch(): boolean {
    return this.pressed("Enter", "NumpadEnter")
  }

  /** Fills `out` with this frame's controls and springs the mouse stick back toward centre. */
  controls(dt: number, out: PlaneControls): PlaneControls {
    const up = this.any("KeyW")
    const down = this.any("KeyS")
    out.throttle = up && !down ? 1 : down && !up ? -1 : 0
    out.boost = this.any("ShiftLeft", "ShiftRight")
    out.yaw = (this.any("KeyE") ? 1 : 0) - (this.any("KeyQ") ? 1 : 0)
    const keyPitch = (this.any("ArrowDown") ? 1 : 0) - (this.any("ArrowUp") ? 1 : 0)
    const keyRoll = (this.any("ArrowRight", "KeyD") ? 1 : 0) - (this.any("ArrowLeft", "KeyA") ? 1 : 0)
    out.pitch = clamp(this.stickY + keyPitch, -1, 1)
    out.roll = clamp(this.stickX + keyRoll, -1, 1)
    if (this.override) {
      out.pitch = this.override.pitch
      out.roll = this.override.roll
      if (this.override.yaw !== undefined) out.yaw = this.override.yaw
    }
    const k = Math.exp(-dt / FlightInput.spring)
    this.stickX *= k
    this.stickY *= k
    return out
  }

  endFrame(): void {
    this.downs.clear()
    this.lookDX = this.lookDY = 0
  }
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
