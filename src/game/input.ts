import type { Input } from "../../shared/sim/vehicle"

/** Keyboard and gamepad driving controls. Steering is relative to the car, so A always turns the car to its left. */
export class Controls {
  private keys = new Set<string>()
  private steer = 0

  constructor() {
    addEventListener("keydown", (e) => {
      if (e.target instanceof HTMLInputElement || e.code === "Escape") return
      this.keys.add(e.code)
      if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) e.preventDefault()
    })
    addEventListener("keyup", (e) => this.keys.delete(e.code))
    addEventListener("blur", () => this.keys.clear())
  }

  pressed(code: string) {
    return this.keys.has(code)
  }

  read(dt: number): Input {
    const k = this.keys
    const up = k.has("KeyW") || k.has("ArrowUp")
    const down = k.has("KeyS") || k.has("ArrowDown")
    const left = k.has("KeyA") || k.has("ArrowLeft")
    const right = k.has("KeyD") || k.has("ArrowRight")
    let throttle = up ? 1 : 0
    let brake = 0
    if (down) {
      throttle = up ? throttle : -1
      brake = up ? 1 : 0
    }
    let target = (left ? 1 : 0) - (right ? 1 : 0)
    let handbrake = k.has("Space")
    let boost = k.has("ShiftLeft") || k.has("ShiftRight")
    const pad = navigator.getGamepads?.().find((p) => p && p.connected)
    if (pad) {
      const ax = pad.axes[0] ?? 0
      if (Math.abs(ax) > 0.15) target = -ax
      const rt = pad.buttons[7]?.value ?? 0
      const lt = pad.buttons[6]?.value ?? 0
      if (rt > 0.05) throttle = rt
      if (lt > 0.05) throttle = rt > 0.05 ? throttle : -lt
      if (pad.buttons[0]?.pressed || pad.buttons[5]?.pressed) handbrake = true
      if (pad.buttons[1]?.pressed || pad.buttons[2]?.pressed) boost = true
    }
    // Keyboard steering ramps in so taps make small corrections and holds make full turns.
    const rate = target === 0 ? 10 : Math.sign(target) !== Math.sign(this.steer) ? 12 : 6
    this.steer += Math.max(-rate * dt, Math.min(rate * dt, target - this.steer))
    if (pad && Math.abs(pad.axes[0] ?? 0) > 0.15) this.steer = target
    let gadget: 0 | 1 | null = k.has("KeyQ") ? 0 : k.has("KeyE") ? 1 : null
    if (pad?.buttons[4]?.pressed) gadget = 0
    if (pad?.buttons[3]?.pressed) gadget = 1
    return { throttle, brake, steer: this.steer, handbrake, boost, gadget }
  }
}
