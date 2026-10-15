import { type Rect, pushOut } from "./geom"

export type Body = { x: number; y: number; vx: number; vy: number }

/**
 * One tick of top-down movement toward (mx, my) at up to `speed`: velocity eases toward the target at `accel` per
 * second, then the body moves in substeps short enough not to skip through a thin partition, pushed out of `solids`
 * as a circle of `radius`. Shared by the server and client prediction.
 */
export function stepBody(b: Body, mx: number, my: number, speed: number, solids: readonly Rect[], dt: number, radius: number, accel: number): void {
  const len = Math.hypot(mx, my)
  if (len > 1) {
    mx /= len
    my /= len
  }
  const k = Math.min(1, dt * accel)
  b.vx += (mx * speed - b.vx) * k
  b.vy += (my * speed - b.vy) * k
  const steps = Math.max(1, Math.ceil((Math.hypot(b.vx, b.vy) * dt) / 0.12))
  for (let i = 0; i < steps; i++) {
    b.x += (b.vx * dt) / steps
    b.y += (b.vy * dt) / steps
    pushOut(b, radius, solids)
  }
}
