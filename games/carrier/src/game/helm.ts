import { SHIP } from "../../shared/ship"
import type { Input } from "../input"

/** Throttle detent step, the delay before a held key starts repeating, and the repeat interval. */
const DETENT = 0.1
const HOLD_DELAY = 0.35
const HOLD_REPEAT = 0.12

const UP = ["KeyW", "ArrowUp"]
const DOWN = ["KeyS", "ArrowDown"]
const DIGITS = Array.from({ length: 10 }, (_, i) => [`Digit${i}`, `Numpad${i}`])
const FULL = ["Equal", "NumpadAdd"]

/**
 * The bridge controls. W/S or ↑/↓ step the throttle order in 10% detents (hold to keep stepping); S below 0% goes
 * astern, down to −SHIP.astern. 1-9 set 10-90%, 0 stops the engines, = (or numpad +) is full ahead. A/D or ←/→ put the rudder over while held; released, it returns to
 * centre. Keys match by physical position and by character, like `Input`, so any layout works. Digits and = match by
 * physical key only, which is a movement key on no layout.
 */
export class Helm {
  /** Throttle order −SHIP.astern..1 (negative is astern). */
  order = 0
  /** Rudder order −1..1. */
  rudder = 0
  private upHeld = 0
  private downHeld = 0

  update(input: Input, dt: number): void {
    const ahead = input.ahead
    this.upHeld = this.repeat(input.pressed(...UP), ahead > 0, this.upHeld, dt, 1)
    this.downHeld = this.repeat(input.pressed(...DOWN), ahead < 0, this.downHeld, dt, -1)
    for (let i = 0; i < 10; i++) if (input.pressed(...DIGITS[i]!)) this.order = i * DETENT
    if (input.pressed(...FULL)) this.order = 1
    this.rudder = input.right
  }

  /** Steps the order once on a press, then again every HOLD_REPEAT once held past HOLD_DELAY. Returns the hold time. */
  private repeat(pressed: boolean, held: boolean, time: number, dt: number, dir: 1 | -1): number {
    if (pressed) {
      this.step(dir)
      return 0
    }
    if (!held) return 0
    const next = time + dt
    const before = Math.floor((time - HOLD_DELAY) / HOLD_REPEAT)
    const after = Math.floor((next - HOLD_DELAY) / HOLD_REPEAT)
    if (next >= HOLD_DELAY && after > before) this.step(dir)
    return next
  }

  private step(dir: 1 | -1): void {
    this.order = Math.max(-SHIP.astern, Math.min(1, Math.round(this.order / DETENT + dir) * DETENT))
  }
}
