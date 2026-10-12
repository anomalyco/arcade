import { ACCEL, type Stance, SPEED, PLAYER_RADIUS } from "../config"
import { type Rect, pushOutCircle } from "../geom"

export type Body = { x: number; y: number; vx: number; vy: number }

/** One tick of movement, shared by the server simulation and client prediction. */
export function stepBody(b: Body, mx: number, my: number, stance: Stance, walls: readonly Rect[], dt: number): void {
  let len = Math.hypot(mx, my)
  if (len > 1) {
    mx /= len
    my /= len
    len = 1
  }
  const speed = SPEED[stance]
  const k = Math.min(1, dt * ACCEL)
  b.vx += (mx * speed * len - b.vx) * k
  b.vy += (my * speed * len - b.vy) * k
  b.x += b.vx * dt
  b.y += b.vy * dt
  pushOutCircle(b, PLAYER_RADIUS, walls)
}
