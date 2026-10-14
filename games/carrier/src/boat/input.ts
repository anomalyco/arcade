import { BOAT, type BoatControls } from "../../shared/boat"
import type { Input } from "../input"

/**
 * The boat's controls, Battlefield-style (one seat drives and shoots), read through the game's `Input` (keys by
 * physical position and by character, so any layout works; its Pointer Lock gives the mouse look):
 * - W / ↑ held: full ahead; S / ↓ held: astern (brakes first); neither: the engines idle and the hull coasts.
 * - A / D or ← / →: steer the waterjets. Shift: boost (a short burst that recharges).
 * - Mouse: aim (the chase camera turns; the turret follows within its arcs). Space or left mouse: fire.
 * E stays SHIP OPERATIONS (read-only while out in the boat); there is no key to quit the boat.
 */
export class BoatInput {
  enabled = true
  /** Test hooks: when set, override the helm and the trigger. */
  override: Partial<BoatControls> | null = null
  trigger: boolean | null = null
  private mouseFire = false

  constructor(
    private input: Input,
    private canvas: HTMLCanvasElement,
  ) {
    canvas.addEventListener("mousedown", (e) => {
      if (e.button === 0 && document.pointerLockElement === canvas) this.mouseFire = true
    })
    addEventListener("mouseup", (e) => {
      if (e.button === 0) this.mouseFire = false
    })
    document.addEventListener("pointerlockchange", () => {
      if (document.pointerLockElement !== canvas) this.mouseFire = false
    })
    addEventListener("blur", () => (this.mouseFire = false))
  }

  /** The helm this frame. */
  controls(out: BoatControls): BoatControls {
    const on = this.enabled
    const ahead = on ? this.input.ahead : 0
    out.throttle = this.override?.throttle ?? (ahead > 0 ? 1 : ahead < 0 ? -BOAT.astern : 0)
    out.steer = this.override?.steer ?? (on ? this.input.right : 0)
    out.boost = this.override?.boost ?? (on && this.input.fast)
    return out
  }

  /** Trigger held: Space or left mouse under Pointer Lock. */
  get fire(): boolean {
    if (this.trigger !== null) return this.trigger
    if (!this.enabled) return false
    return this.mouseFire || this.input.held("Space")
  }

  /** Mouse look this frame (CSS px). */
  get look(): { dx: number; dy: number } {
    return this.enabled ? { dx: this.input.dragX, dy: this.input.dragY } : { dx: 0, dy: 0 }
  }
}
