import { DT, SAMPLE_EVERY, SELF_GRACE, clampAngle, clampPower, hypot, integrate, launchVelocity, muzzle, windAccel } from "./ballistics"
import type { Unit } from "./protocol"
import { UNIT_R, WORLD_H, WORLD_W, isSolid, type Mask } from "./terrain"
import type { WeaponId } from "./weapons"

const MAX_STEPS = Math.round(14 / DT)

export interface Trace {
  pts: number[]
  x: number
  y: number
  // unit id hit, -1 for terrain, -2 when the shot left the map
  hit: number
  steps: number
  apexY: number
}

type Shooter = Pick<Unit, "id" | "x" | "y" | "cls">

// Flies one projectile with exactly the volley's integration (no splits, wells or crates).
export function traceShot(mask: Mask, unit: Shooter, angle: number, power: number, wind: number, units: Unit[] | undefined, maxPoints = Infinity): Trace {
  const a = clampAngle(angle)
  const m = muzzle(unit, a)
  const v = launchVelocity(a, clampPower(power), unit.cls)
  const b = { x: m.x, y: m.y, vx: v.vx, vy: v.vy }
  const w = windAccel(wind, unit.cls)
  const pts = [b.x, b.y]
  let apexY = b.y
  for (let step = 1; step <= MAX_STEPS; step++) {
    integrate(b, w)
    if (b.y < apexY) apexY = b.y
    if (step % SAMPLE_EVERY === 0) {
      pts.push(b.x, b.y)
      if (pts.length / 2 >= maxPoints) return { pts, x: b.x, y: b.y, hit: -1, steps: step, apexY }
    }
    if (b.x < -250 || b.x > WORLD_W + 250 || b.y > WORLD_H + 60) return { pts, x: b.x, y: b.y, hit: -2, steps: step, apexY }
    if (units) {
      const age = step * DT
      for (const u of units) {
        if (!u.alive) continue
        if (u.id === unit.id && age < SELF_GRACE) continue
        if (hypot(b.x - u.x, b.y - u.y) < UNIT_R + 3) {
          pts.push(b.x, b.y)
          return { pts, x: b.x, y: b.y, hit: u.id, steps: step, apexY }
        }
      }
    }
    if (isSolid(mask, b.x, b.y)) {
      pts.push(b.x, b.y)
      return { pts, x: b.x, y: b.y, hit: -1, steps: step, apexY }
    }
  }
  return { pts, x: b.x, y: b.y, hit: -2, steps: MAX_STEPS, apexY }
}

// world points [x,y,...] for aim previews and ghost arcs
export function predictPath(mask: Mask, unit: Shooter, angle: number, power: number, wind: number, weapon: WeaponId, maxPoints: number, units?: Unit[]): number[] {
  if (weapon === "shield") return []
  return traceShot(mask, unit, angle, power, wind, units, maxPoints).pts
}

// suggested preview length in points for a unit (base + per preview level)
export function previewLength(unit: Pick<Unit, "preview">): number {
  return 18 + 14 * Math.min(4, unit.preview ?? 0)
}

// truncated length for other players' ghost arcs
export const GHOST_POINTS = 8
