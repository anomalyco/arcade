import { drivenMask, type WheelContact } from "./emissions"
import type { Controls, GroundHeight, VehicleSpec, VehicleView } from "./types"

/** How a rigid-body car's motion turns into tyre slip when the simulation has no per-wheel telemetry. */
export type SlipSettings = {
  /** Sideways slide speed at a tyre (m/s) before it starts to mark. */
  slideThreshold: number
  /** Slide speed above the threshold that counts as full slip (m/s). */
  slideRange: number
  /** Slip of wheels locked by a hard stop; 0 behaves like ABS and never marks. */
  brakeLock: number
  /** Forward speed above which a hard stop locks the wheels (m/s). */
  brakeLockSpeed: number
  /** Slip of the rear wheels locked by the handbrake. */
  handbrake: number
  /** Slip of the driven wheels in a burnout (full throttle against the brake near a standstill). */
  burnout: number
}
export const SLIP_DEFAULTS: SlipSettings = { slideThreshold: 1.6, slideRange: 4, brakeLock: 0.55, brakeLockSpeed: 7, handbrake: 0.85, burnout: 1 }

const clamp = (x: number) => Math.max(0, Math.min(1, x))

/** Wheels front-left, front-right, rear-left, rear-right; local X right, Z forward (metres). */
export function wheelOffsets(spec: VehicleSpec, w: number) {
  const rear = w >= 2
  return {
    x: spec.wheels?.[w]?.x ?? (spec.id === "bike" ? 0 : (w % 2 ? 1 : -1) * spec.width * 0.4),
    z: spec.wheels?.[w]?.z ?? (rear ? -1 : 1) * spec.length * 0.32,
  }
}

/**
 * Per-wheel contacts from body velocity and yaw rate: each tyre's own velocity (v + ω × r) split along and across
 * its rolling direction (fronts turned by `steerAngle`, radians toward +yaw), plus handbrake, brake-lock and burnout
 * rules. View conventions: heading 0 faces +Z, forward (sin h, cos h), `yawRate` = dh/dt. Writes `out` in place.
 */
export function kinematicContacts(
  out: WheelContact[], c: VehicleView, spec: VehicleSpec, yawRate: number, steerAngle: number, input: Controls,
  ground: GroundHeight, surface: (x: number, z: number) => number, settings: SlipSettings = SLIP_DEFAULTS,
): WheelContact[] {
  const fx = Math.sin(c.h), fz = Math.cos(c.h), rx = fz, rz = -fx
  const mask = drivenMask(spec)
  const burnout = !c.engineOff && input.throttle > 0.8 && (input.brake > 0.5 || input.handbrake) && c.speed < 3
  const cs = Math.cos(steerAngle), sn = Math.sin(steerAngle)
  for (let w = 0; w < 4; w++) {
    const o = wheelOffsets(spec, w), front = w < 2
    const x = c.x + fx * o.z + rx * o.x, z = c.z + fz * o.z + rz * o.x
    const vx = c.vx + yawRate * (o.z * rx - o.x * fx), vz = c.vz + yawRate * (o.z * rz - o.x * fz)
    const wfx = front ? fx * cs + rx * sn : fx, wfz = front ? fz * cs + rz * sn : fz
    const along = vx * wfx + vz * wfz, across = vx * wfz - vz * wfx
    const speed = Math.abs(along), side = Math.abs(across)
    let slip = clamp((side - settings.slideThreshold) / Math.max(0.01, settings.slideRange)), slipSpeed = side
    if (!front && input.handbrake && speed > 2) { slip = Math.max(slip, settings.handbrake * clamp(speed / 5)); slipSpeed = Math.max(slipSpeed, speed) }
    if (!input.handbrake && input.brake > 0.9 && speed > settings.brakeLockSpeed && settings.brakeLock > 0) {
      slip = Math.max(slip, settings.brakeLock * clamp((speed - settings.brakeLockSpeed) / 6)); slipSpeed = Math.max(slipSpeed, speed)
    }
    if (burnout && (mask & (1 << w))) { slip = Math.max(slip, settings.burnout); slipSpeed = Math.max(slipSpeed, 18) }
    if (c.airborne || ((c.wheels ?? 0) & (1 << w))) slip = 0
    const contact = out[w] ??= { x: 0, y: 0, z: 0, slip: 0, slipSpeed: 0, surface: 0 }
    contact.x = x; contact.z = z; contact.y = ground(x, z)
    contact.slip = slip; contact.slipSpeed = slipSpeed
    contact.surface = slip > 0 ? surface(x, z) : 0
  }
  out.length = 4
  return out
}
