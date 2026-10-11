import { classOf, passiveOf } from "./classes"
import type { ClassId, Unit } from "./protocol"

export const DT = 1 / 120
export const GRAVITY = 260
export const WIND_ACCEL = 2.4
export const SAMPLE_EVERY = 6
// owner cannot be hit by its own projectile during this window after launch
export const SELF_GRACE = 0.25

export interface Body {
  x: number
  y: number
  vx: number
  vy: number
}

export function launchSpeed(power: number, cls?: ClassId): number {
  return (150 + power * 3.6) * classOf(cls).power
}

export function launchVelocity(angle: number, power: number, cls?: ClassId): { vx: number; vy: number } {
  const s = launchSpeed(power, cls)
  return { vx: Math.cos(angle) * s, vy: -Math.sin(angle) * s }
}

export function muzzle(unit: Pick<Unit, "x" | "y">, angle: number): { x: number; y: number } {
  return { x: unit.x + Math.cos(angle) * 16, y: unit.y - Math.sin(angle) * 16 - 2 }
}

export function clampAngle(angle: number): number {
  if (!Number.isFinite(angle)) return Math.PI / 4
  return Math.min(Math.PI - 0.05, Math.max(0.05, angle))
}

export function clampPower(power: number): number {
  if (!Number.isFinite(power)) return 50
  return Math.min(100, Math.max(0, power))
}

export function windAccel(wind: number, cls?: ClassId): number {
  return wind * WIND_ACCEL * passiveOf(cls).wind
}

// one fixed integration step; the volley and the aim preview both use exactly this
export function integrate(b: Body, wind: number, ax = 0, ay = 0): void {
  b.vy += (GRAVITY + ay) * DT
  b.vx += (wind + ax) * DT
  b.x += b.vx * DT
  b.y += b.vy * DT
}

export function ms(step: number): number {
  return Math.round(step * DT * 1000)
}

// correctly rounded on every engine (unlike Math.hypot), so client and server agree bit for bit
export function hypot(x: number, y: number): number {
  return Math.sqrt(x * x + y * y)
}
