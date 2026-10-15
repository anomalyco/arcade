import { KeyStateTracker } from "@arcade/kit/client/controls"

/**
 * Weapon controls while flying, Battlefield-style (bound by physical `KeyboardEvent.code`):
 * - Space or left mouse (under Pointer Lock): fire the selected weapon (hold for the cannon).
 * - 1, 2, 3: select the aircraft's first, second, third weapon (only those it has). Mouse wheel or V: cycle them.
 * - F: flares, always (landing is R, src/flight/input.ts).
 */
export class WeaponInput {
  /** Off: nothing is read (not flying, menus, debug panel). */
  enabled = true
  private readonly tracker: KeyStateTracker
  private mouseFire = false
  private wheel = 0
  private wheelAt = 0
  /** Test hook: when set, overrides the trigger. */
  trigger: boolean | null = null

  constructor(private canvas: HTMLCanvasElement) {
    this.tracker = new KeyStateTracker({
      shouldPreventDefault: (code) => code === "Space",
      onRelease: () => (this.mouseFire = false),
    })
    canvas.addEventListener("mousedown", (e) => {
      // Left mouse fires only once the pointer is locked: the first click captures it (flight/input.ts).
      if (e.button === 0 && document.pointerLockElement === canvas) this.mouseFire = true
    })
    addEventListener("mouseup", (e) => {
      if (e.button === 0) this.mouseFire = false
    })
    document.addEventListener("pointerlockchange", () => {
      if (document.pointerLockElement !== canvas) this.mouseFire = false
    })
    addEventListener(
      "wheel",
      (e) => {
        if (!this.enabled || e.target !== canvas) return
        // One notch per step, however the device scales deltas; a trackpad's stream is rate-limited.
        const now = performance.now()
        if (now - this.wheelAt < 120 || Math.abs(e.deltaY) < 1) return
        this.wheelAt = now
        this.wheel += Math.sign(e.deltaY)
      },
      { passive: true },
    )
  }

  release(): void {
    this.tracker.release()
    this.mouseFire = false
  }

  /** Trigger held (Space or left mouse). */
  get fire(): boolean {
    if (!this.enabled) return false
    if (this.trigger !== null) return this.trigger
    return this.mouseFire || this.tracker.any("Space")
  }

  /** Slot picked this frame by a number key (0-based), or -1. */
  get select(): number {
    if (!this.enabled) return -1
    if (this.tracker.pressed("Digit1", "Numpad1")) return 0
    if (this.tracker.pressed("Digit2", "Numpad2")) return 1
    if (this.tracker.pressed("Digit3", "Numpad3")) return 2
    return -1
  }

  /** Cycle steps this frame: wheel notches (down = next) and V. */
  get cycle(): number {
    if (!this.enabled) return 0
    return this.wheel + (this.tracker.pressed("KeyV") ? 1 : 0)
  }

  /** Flares asked for this frame. */
  get flares(): boolean {
    return this.enabled && this.tracker.pressed("KeyF")
  }

  endFrame(): void {
    this.tracker.clearDowns()
    this.wheel = 0
  }
}
