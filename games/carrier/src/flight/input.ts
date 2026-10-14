import { KeyStateTracker, requestCanvasPointerLock } from "@arcade/kit/client/controls"
import type { PlaneControls } from "../../shared/plane"

/**
 * Flight controls, Battlefield-style keyboard and mouse (bound by physical `KeyboardEvent.code`):
 * - W / S: throttle up / down (S also airbrakes); released, the throttle springs back to cruise.
 * - Q / E: rudder (yaw).
 * - A / D: roll (added to the mouse stick, like ←/→). Shift: afterburner.
 * - Mouse: a virtual stick (pitch on Y, roll on X) under Pointer Lock. Moving the mouse deflects it, it springs back to
 *   centre when the mouse stops, so a flick is a quick rate and a steady push holds a turn. Pull back (toward you) for
 *   nose up, like BF's default; `?invert` swaps it.
 * - Arrows: ↑ nose down, ↓ nose up, ←/→ roll (BF4's keyboard pitch/roll). Space fires (src/weapons/input.ts).
 * - Hold right or middle mouse, or X: free look (camera only). C: chase / cockpit camera. A flight only ends by landing
 *   on the carrier, a crash or being shot down: there is no key to quit it.
 */
export class FlightInput {
  /** Mouse stick sensitivity (stick units per CSS pixel) and its spring back to centre (s). */
  static sensitivity = 0.012
  static spring = 0.11

  enabled = true
  invert = false
  /** Take Pointer Lock on a click itself (the harness). In the game src/input.ts owns the lock on the same canvas. */
  grab = true
  private readonly tracker: KeyStateTracker
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
    this.tracker = new KeyStateTracker({
      onRelease: () => {
        this.buttons = 0
        this.stickX = this.stickY = 0
      },
    })
    canvas.addEventListener("mousedown", (e) => {
      e.preventDefault()
      canvas.focus({ preventScroll: true })
      this.buttons = e.buttons
      if (this.grab && this.enabled && !this.locked && e.button === 0) requestCanvasPointerLock(this.canvas)
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
    this.tracker.release()
    this.buttons = 0
    this.stickX = this.stickY = 0
  }

  pressed(...k: string[]): boolean {
    return this.tracker.pressed(...k)
  }

  get freeLook(): boolean {
    return (this.buttons & 6) !== 0 || this.tracker.any("KeyX")
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
    const up = this.tracker.any("KeyW")
    const down = this.tracker.any("KeyS")
    out.throttle = up && !down ? 1 : down && !up ? -1 : 0
    out.boost = this.tracker.any("ShiftLeft", "ShiftRight")
    out.yaw = (this.tracker.any("KeyE") ? 1 : 0) - (this.tracker.any("KeyQ") ? 1 : 0)
    const keyPitch = (this.tracker.any("ArrowDown") ? 1 : 0) - (this.tracker.any("ArrowUp") ? 1 : 0)
    const keyRoll = (this.tracker.any("ArrowRight", "KeyD") ? 1 : 0) - (this.tracker.any("ArrowLeft", "KeyA") ? 1 : 0)
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
    this.tracker.clearDowns()
    this.lookDX = this.lookDY = 0
  }
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
