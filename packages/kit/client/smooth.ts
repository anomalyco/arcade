/** How fast a prediction correction is blended out of the drawn position, per second. */
const CORRECTION_RATE = 10

type Point = { x: number; y: number }

/**
 * Where to draw the predicted body. Prediction steps it once per fixed tick (30 Hz), so drawing it directly at 60 Hz
 * and up moves it on alternate frames only: against the smoothly following camera it flips between two spots on
 * screen, which reads as a vibrating double image (worst when sprinting, the step is longest). Instead draw it between
 * the last two ticks, and when a server snapshot corrects the prediction, keep it where it was on screen and blend the
 * correction out over a few frames rather than jumping.
 */
export class Smoothed {
  x = 0
  y = 0
  private px = 0
  private py = 0
  private ox = 0
  private oy = 0

  /** A fresh body (spawn, death, a correction too big to blend): draw it exactly there. */
  reset(b: Point): void {
    this.px = this.x = b.x
    this.py = this.y = b.y
    this.ox = 0
    this.oy = 0
  }

  /** Call just before a tick steps the body. */
  tick(b: Point): void {
    this.px = b.x
    this.py = b.y
  }

  /** The body was moved by (dx, dy) to agree with the server. */
  correct(dx: number, dy: number): void {
    this.px += dx
    this.py += dy
    this.ox -= dx
    this.oy -= dy
  }

  /** `alpha` is how far into the next tick this frame is, 0..1. */
  update(b: Point, alpha: number, dt: number): void {
    const k = Math.exp(-dt * CORRECTION_RATE)
    this.ox *= k
    this.oy *= k
    this.x = this.px + (b.x - this.px) * alpha + this.ox
    this.y = this.py + (b.y - this.py) * alpha + this.oy
  }
}
