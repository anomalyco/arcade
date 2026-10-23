import { type Rect, pushOut } from "./geom"

export type Body = { x: number; y: number; vx: number; vy: number; collisionId?: number }
export type CircleSolid = { x: number; y: number; radius: number; collisionId?: number }

/**
 * One tick of top-down movement toward (mx, my) at up to `speed`: velocity eases toward the target at `accel` per
 * second, then the body moves in substeps short enough not to skip through a thin partition, pushed out of `solids`
 * as a circle of `radius`. Shared by the server and client prediction.
 */
export function stepBody(b: Body, mx: number, my: number, speed: number, solids: readonly Rect[], dt: number, radius: number, accel: number, circles: readonly CircleSolid[] = []): void {
  const len = Math.hypot(mx, my)
  if (len > 1) {
    mx /= len
    my /= len
  }
  const tx = mx * speed
  const ty = my * speed
  // Counter-steering and stopping bite harder than coasting so direction changes feel crisp.
  const dot = b.vx * tx + b.vy * ty
  const boost = len < 0.05 ? 1.2 : dot < 0 ? 1.45 : 1
  const k = Math.min(1, dt * accel * boost)
  b.vx += (tx - b.vx) * k
  b.vy += (ty - b.vy) * k
  const steps = Math.max(1, Math.ceil((Math.hypot(b.vx, b.vy) * dt) / 0.12))
  for (let i = 0; i < steps; i++) {
    const x = b.x, y = b.y
    b.x += (b.vx * dt) / steps
    b.y += (b.vy * dt) / steps
    pushOut(b, radius, solids)
    // Other bodies are solid obstacles, never impulse recipients. Only this walker stops/slides.
    for (let pass = 0; circles.length && pass < 3; pass++) {
      for (const c of circles) {
        let dx = b.x - c.x, dy = b.y - c.y
        const r = radius + c.radius, d2 = dx * dx + dy * dy
        if (d2 >= r * r) continue
        if (d2 < 1e-12) {
          dx = x - c.x; dy = y - c.y
          if (dx * dx + dy * dy < 1e-12) {
            // A stable, opposite direction for each walker breaks coincident spawns, even beside a wall.
            const a = b.collisionId ?? 0, other = c.collisionId ?? 1, sign = a < other ? -1 : 1
            const hash = Math.imul(Math.min(a, other) + 1, 73856093) ^ Math.imul(Math.max(a, other) + 1, 19349663)
            dx = sign * (1 + (hash & 1023)); dy = sign * (((hash >>> 10) & 2047) - 1023)
          }
        }
        const d = Math.sqrt(dx * dx + dy * dy), nx = dx / d, ny = dy / d
        b.x = c.x + nx * r; b.y = c.y + ny * r
        const inward = b.vx * nx + b.vy * ny
        if (inward < 0) { b.vx -= inward * nx; b.vy -= inward * ny }
      }
      pushOut(b, radius, solids)
    }
    // A body against a wall cannot be pushed through it by another walker.
    if (circles.some((c) => (b.x - c.x) ** 2 + (b.y - c.y) ** 2 < (radius + c.radius) ** 2 - 1e-9)) {
      b.x = x; b.y = y; b.vx = b.vy = 0
    }
  }
}
