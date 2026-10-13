import type { Vehicle } from "../../shared/config"
import type { CarView } from "../../shared/sim/world"
import type { Input } from "../../shared/sim/vehicle"
import { SmokeTrail, type SmokeSource } from "./smoke-trail"

/** Preset integration seam. Cold presets can set this without owning the smoke renderer or Lab. */
export const vehicleEffects = { coldExhaust: false }

type Wheel = SmokeSource & { heat: number }
export class EmissionState {
  readonly wheels: Wheel[] = Array.from({ length: 4 }, () => ({ smokeDistance: 0, smokeX: 0, smokeZ: 0, smokeActive: false, idle: 0, heat: 0 }))
  throttle = 0
  speed = 0
  gear = 0
  load = 0
  pop = 0
  cooldown = 0
  events = 0
  cold = 0
  intensity = 0
  emittingWheels = 0
}

const clamp = (x: number) => Math.max(0, Math.min(1, x))
/** Current specs have no drivetrain. Default to rear drive; a future spec can supply its real layout. */
export function drivenMask(spec: Vehicle & { drivetrain?: "rwd" | "fwd" | "awd" }) {
  return spec.drivetrain === "awd" ? 15 : spec.drivetrain === "fwd" ? 3 : 12
}

/** Presentation-only proxies: the simulation has lateral slip, but no wheel RPM, lock or gearbox telemetry. */
export function tyreSlip(c: CarView, input: Input | null, acceleration: number) {
  if (c.airborne || (c.y ?? 0) > 0.15) return 0
  const slide = clamp((c.drift - 1.2) / 6) * clamp((c.speed - 3) / 7)
  const burnout = !c.engineOff && input && input.throttle > 0.8 && input.brake > 0.5 && c.speed < 3 ? 1 : 0
  const launch = !c.engineOff && input && input.throttle > 0.8 && input.brake < 0.1 && acceleration > 6 && c.speed < 10 ? clamp((10 - c.speed) / 10) * 0.7 : 0
  // Handbrake is the only explicit wheel-lock control. Ordinary braking alone never emits.
  return Math.max(slide, burnout, launch)
}

/** Persistent wisps plus direct attached flames. Packs into the existing sprite batches, without particle objects. */
export class VehicleEmissions {
  constructor(readonly trail = new SmokeTrail()) {}
  private readonly wisps = new Float32Array(256 * 8)
  private readonly flames = new Float32Array(128 * 12)
  wispCount = 0
  flameCount = 0
  pops = 0
  time = 0
  alphaCount = 0
  addCount = 0

  reset() { this.trail.reset(); this.wispCount = this.flameCount = this.pops = this.time = 0 }
  update(dt: number) {
    this.time += dt
    this.trail.update(dt)
    this.flameCount = 0
    let n = 0
    for (let j = 0; j < this.wispCount; j++) {
      const i = j * 8, p = this.wisps, age = p[i + 3]! + dt
      if (age >= p[i + 7]!) continue
      const o = n++ * 8
      p[o] = p[i]! + p[i + 4]! * dt; p[o + 1] = p[i + 1]! + dt * 0.25
      p[o + 2] = p[i + 2]! + p[i + 5]! * dt; p[o + 3] = age
      p[o + 4] = p[i + 4]!; p[o + 5] = p[i + 5]!; p[o + 6] = p[i + 6]!; p[o + 7] = p[i + 7]!
    }
    this.wispCount = n
  }

  car(c: CarView, spec: Vehicle, s: EmissionState, input: Input | null, dt: number, height: number, smokeEnabled: boolean, popsEnabled: boolean) {
    const fx = Math.sin(c.h), fz = Math.cos(c.h), rx = fz, rz = -fx
    const throttle = c.engineOff ? 0 : input?.throttle ?? (c.boosting ? 1 : 0)
    const accel = dt > 0 ? (c.speed - s.speed) / dt : 0
    const slip = tyreSlip(c, input, accel), mask = drivenMask(spec)
    const burnout = !!input && input.throttle > 0.8 && input.brake > 0.5 && c.speed < 3
    const rubbingSpeed = Math.max(c.speed, burnout ? 18 : 0)
    s.intensity = 0; s.emittingWheels = 0
    for (let w = 0; w < 4; w++) {
      const wheel = s.wheels[w]!, rear = w >= 2
      const driven = (mask & (1 << w)) !== 0
      const locked = rear && !!input?.handbrake && c.speed > 5
      const grounded = !c.airborne && (c.y ?? 0) < 0.15
      const activeSlip = grounded && !((c.wheels ?? 0) & (1 << w)) ? Math.max(driven ? slip : 0, locked ? 0.8 : 0) : 0
      wheel.heat += ((activeSlip > 0.05 ? 1 : 0) - wheel.heat) * (1 - Math.exp(-dt * (activeSlip > 0.05 ? 2 : 1.3)))
      const strength = activeSlip * clamp(rubbingSpeed / 18) * (0.05 + 0.95 * wheel.heat)
      const side = spec.id === "bike" ? 0 : (w % 2 ? 1 : -1) * spec.width * 0.4
      const along = (rear ? -1 : 1) * spec.length * 0.32
      const enabled = smokeEnabled && !(spec.id === "bike" && w === 3)
      this.trail.follow(wheel, c.x + fx * along + rx * side, c.z + fz * along + rz * side, c.vx, c.vz, dt, enabled ? strength : 0)
      if (enabled && strength > 0.008) s.emittingWheels++
      s.intensity = Math.max(s.intensity, strength)
    }
    s.cooldown = Math.max(0, s.cooldown - dt); s.pop = Math.max(0, s.pop - dt)
    s.load += (clamp(throttle) - s.load) * (1 - Math.exp(-dt * 2))
    const gear = Math.floor(Math.max(0, c.speed - 4) / 12)
    const lift = s.throttle > 0.7 && throttle < 0.2 && c.speed > 12
    const shift = gear > s.gear && throttle > 0.8 && c.speed > 17
    if (dt > 0 && popsEnabled && !c.engineOff && s.cooldown === 0 && s.load > 0.45 && (lift || shift)) {
      s.events++
      if (s.events % 3 !== 0) { s.pop = 0.11; this.pops++ }
      s.cooldown = 1.8
    }
    s.gear = gear; s.speed = c.speed; s.throttle = throttle
    const boost = !c.engineOff && (input ? input.boost && c.boost > 0 && c.stun <= 0 : !!c.boosting) && throttle > 0.1
    const x = c.x - fx * (spec.length / 2 + 0.12), z = c.z - fz * (spec.length / 2 + 0.12), y = 0.42 + height + (c.y ?? 0)
    const flicker = 0.82 + 0.18 * Math.sin(this.time * 47 + c.id * 2.1)
    if (boost || s.pop > 0) for (let pipe = 0; pipe < (spec.id === "bike" ? 1 : 2); pipe++) {
      const side = spec.id === "bike" ? 0 : pipe ? 0.34 : -0.34
      const orange = s.pop > 0 && !boost, power = orange ? s.pop / 0.11 : clamp(throttle) * flicker
      const size = 0.15 + power * 0.035, length = 0.32 + power * 0.28
      this.pack(this.flames, this.flameCount++, x + rx * side - fx * length * 0.5, y, z + rz * side - fz * length * 0.5, size,
        orange ? 1 : 0.12, orange ? 0.3 : 0.4, orange ? 0.035 : 1, 1.8 * power, 13, Math.atan2(-fx, -fz), length / size, this.time)
      this.pack(this.flames, this.flameCount++, x + rx * side, y, z + rz * side, 0.3, orange ? 1 : 0.15, orange ? 0.25 : 0.35, orange ? 0.03 : 1, 0.35 * power, 0, 0, 1, 0)
      this.flameCount = Math.min(124, this.flameCount)
    }
    if (vehicleEffects.coldExhaust && !c.engineOff) {
      s.cold += dt * 24
      while (s.cold >= 1) {
        s.cold--
        if (this.wispCount === 256) break
        const i = this.wispCount++ * 8, p = this.wisps
        p[i] = x; p[i + 1] = y; p[i + 2] = z; p[i + 3] = 0
        p[i + 4] = c.vx * 0.08 - fx * 1.4 + 0.2; p[i + 5] = c.vz * 0.08 - fz * 1.4
        p[i + 6] = 0.2; p[i + 7] = Math.min(0.85, 1.6 / (c.speed * 0.92 + 1.4))
      }
    } else s.cold = 0
  }

  private pack(out: Float32Array, n: number, x: number, y: number, z: number, size: number, r: number, g: number, b: number, a: number, kind: number, rot: number, stretch: number, seed: number) {
    const i = n * 12
    out[i] = x; out[i + 1] = y; out[i + 2] = z; out[i + 3] = size
    out[i + 4] = r; out[i + 5] = g; out[i + 6] = b; out[i + 7] = a
    out[i + 8] = kind; out[i + 9] = rot; out[i + 10] = stretch; out[i + 11] = seed
  }
  emit(alpha: Float32Array, ai: number, add: Float32Array, di: number, max: number, visible: boolean) {
    if (visible) {
      for (let n = 0; n < this.wispCount && ai < max; n++) {
        const i = n * 8, p = this.wisps, t = p[i + 3]! / p[i + 7]!
        this.pack(alpha, ai++, p[i]!, p[i + 1]!, p[i + 2]!, 0.15 + t * 0.25, 0.7, 0.76, 0.82, p[i + 6]! * (1 - t), 10, 0, 1, n * 0.17)
      }
      for (let n = 0; n < this.flameCount && di < max; n++, di++) for (let j = 0; j < 12; j++) add[di * 12 + j] = this.flames[n * 12 + j]!
    }
    this.alphaCount = ai; this.addCount = di
  }
}
