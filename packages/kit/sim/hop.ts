/** Night Shift's floor-plan hop, shared with authoritative rooms and prediction. */
export type Hop = { y: number; v: number; airborne: boolean }
export const HOP_GRAVITY = 9.81

export function startHop(air: Hop, height = 0.3): boolean {
  if (air.airborne || height <= 0) return false
  air.airborne = true
  air.v = Math.sqrt(2 * HOP_GRAVITY * height)
  return true
}

/** Exact constant-gravity step. Returns landing impact (0..1), or −1 without a landing. */
export function stepHop(air: Hop, dt: number, height = 0.3): number {
  if (!air.airborne) return -1
  air.y += air.v * dt - 0.5 * HOP_GRAVITY * dt * dt
  air.v -= HOP_GRAVITY * dt
  if (air.y > 0) return -1
  const impact = Math.min(1, -air.v / Math.sqrt(2 * HOP_GRAVITY * Math.max(0.05, height)))
  air.y = air.v = 0
  air.airborne = false
  return impact
}
