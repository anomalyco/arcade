import { ACCEL, PLAYER_RADIUS } from "../config"
import { type Rect, pushOut } from "../geom"

export type Body = { x: number; y: number; vx: number; vy: number }

/** One tick of movement toward (mx, my) at up to `speed`, shared by the server and client prediction. */
export function stepBody(b: Body, mx: number, my: number, speed: number, solids: readonly Rect[], dt: number): void {
  const len = Math.hypot(mx, my)
  if (len > 1) {
    mx /= len
    my /= len
  }
  const k = Math.min(1, dt * ACCEL)
  b.vx += (mx * speed - b.vx) * k
  b.vy += (my * speed - b.vy) * k
  // Substep so a fast body can't skip through a thin partition.
  const steps = Math.max(1, Math.ceil((Math.hypot(b.vx, b.vy) * dt) / 0.12))
  for (let i = 0; i < steps; i++) {
    b.x += (b.vx * dt) / steps
    b.y += (b.vy * dt) / steps
    pushOut(b, PLAYER_RADIUS, solids)
  }
}
