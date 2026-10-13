import type { VehicleSpec as Vehicle, VehicleView as CarView, Controls as Input, GroundHeight } from "./types"

export const chassisSettings = (enabled = true) => ({ suspension: enabled, wheelContact: enabled, visibleWheels: enabled, vehicleFeel: enabled })
export type ChassisSettings = ReturnType<typeof chassisSettings>
export type Spring = { x: number; v: number }
export type AxlePoint = { x: number; y: number; z: number }
export type WheelRotation = { yaw: number; roll: number; pitch: number }
const clamp = (x: number, max: number) => Math.max(-max, Math.min(max, x))

/** Compose spin BEFORE steering/bank. The existing instance shader applies Z, X, Y;
 * convert the wheel's local X, Y then body's Z, X, Y into that Euler order.
 * Otherwise a banked bike's wheel axle wobbles once per revolution. */
export function wheelRotation(out: WheelRotation, yaw: number, bank: number, pitch: number, steer: number, spin: number) {
  const cb = Math.cos(bank), sb = Math.sin(bank), cp = Math.cos(pitch), sp = Math.sin(pitch)
  const ct = Math.cos(steer), st = Math.sin(steer), cw = Math.cos(spin), sw = Math.sin(spin)
  const cy = Math.cos(yaw), sy = Math.sin(yaw)
  const m10 = cp * sb * ct + sp * st
  const m11 = cp * (sb * st * sw + cb * cw) - sp * ct * sw
  const zX = cb * st * cw + sb * sw
  const zY = cp * (sb * st * cw - cb * sw) - sp * ct * cw
  const zZ = sp * (sb * st * cw - cb * sw) + cp * ct * cw
  out.pitch = Math.asin(clamp(-zY, 1))
  out.roll = Math.atan2(m10, m11)
  out.yaw = Math.atan2(cy * zX + sy * zZ, -sy * zX + cy * zZ)
}

/** Exact underdamped solution for a constant target. No unstable large-dt Euler step. */
export function springStep(s: Spring, target: number, dt: number, omega = 14, damping = 0.52) {
  if (!(dt > 0) || !Number.isFinite(dt)) return
  const a = damping * omega, w = omega * Math.sqrt(1 - damping * damping)
  const d = s.x - target, b = (s.v + a * d) / w
  const e = Math.exp(-a * dt), c = Math.cos(w * dt), n = Math.sin(w * dt)
  s.x = target + e * (d * c + b * n)
  s.v = e * ((b * w - a * d) * c - (d * w + a * b) * n)
}

export class Chassis<Terrain = GroundHeight> {
  readonly roll: Spring = { x: 0, v: 0 }
  readonly pitch: Spring = { x: 0, v: 0 }
  readonly lift: Spring = { x: 0, v: 0 }
  private readonly leanRoll: Spring = { x: 0, v: 0 }
  private readonly leanPitch: Spring = { x: 0, v: 0 }
  private readonly surfaceRoll: Spring = { x: 0, v: 0 }
  private readonly surfacePitch: Spring = { x: 0, v: 0 }
  readonly contacts: ({ x: number; y: number; z: number; spin: number } & WheelRotation)[]
  steer = 0
  private vx: number
  private vz: number
  private heading: number
  private yaw = 0
  private ax = 0
  private az = 0
  private landings: number
  private impact = 0
  private px: number
  private pz: number
  constructor(c: CarView, readonly axles: readonly AxlePoint[], private readonly ground: (terrain: Terrain, x: number, z: number) => number) {
    this.vx = c.vx; this.vz = c.vz; this.heading = c.h
    this.px = c.x; this.pz = c.z
    this.landings = c.landings ?? 0
    this.contacts = axles.map(() => ({ x: 0, y: 0, z: 0, spin: 0, yaw: 0, roll: 0, pitch: 0 }))
  }

  update(c: CarView, spec: Vehicle, city: Terrain, dt: number, settings: ChassisSettings, input: Input | null) {
    if (!Number.isFinite(dt) || dt < 0) return
    const teleport = Math.hypot(c.x - this.px, c.z - this.pz) > 12 || dt > 0.5
    this.px = c.x; this.pz = c.z
    if (teleport) {
      this.vx = c.vx; this.vz = c.vz; this.heading = c.h
      this.ax = this.az = this.yaw = 0
      for (const s of [this.roll, this.pitch, this.lift, this.leanRoll, this.leanPitch, this.surfaceRoll, this.surfacePitch]) { s.x = 0; s.v = 0 }
    }
    // Differentiate low-passed velocity, then filter acceleration again. Duplicate snapshots
    // decay smoothly rather than alternating between a zero target and an enormous impulse.
    const k = 1 - Math.exp(-dt / 0.085), ak = 1 - Math.exp(-dt / 0.065)
    const dx = (c.vx - this.vx) * k, dz = (c.vz - this.vz) * k
    this.vx += dx; this.vz += dz
    if (dt > 0 && !teleport) {
      this.ax += (clamp(dx / dt, 65) - this.ax) * ak
      this.az += (clamp(dz / dt, 65) - this.az) * ak
      const dh = Math.atan2(Math.sin(c.h - this.heading), Math.cos(c.h - this.heading))
      this.yaw += (clamp(dh / dt, 5) - this.yaw) * k
    }
    this.heading = c.h
    const sn = Math.sin(c.h), cs = Math.cos(c.h)
    const forward = c.vx * sn + c.vz * cs, lateral = c.vx * cs - c.vz * sn
    const longAccel = this.ax * sn + this.az * cs, sideAccel = this.ax * cs - this.az * sn
    const weight = settings.vehicleFeel ? Math.max(0.75, Math.min(1.75, spec.mass / 1.1)) : 1
    const omega = settings.vehicleFeel ? Math.max(12, Math.min(16, 15.5 - (spec.mass - 0.8) * 3)) : 14
    const bike = settings.vehicleFeel && spec.id === "bike"
    const bodyRoll = bike ? -clamp(sideAccel * 0.027, 0.42) : clamp(sideAccel * 0.007 * weight, 0.18 * weight)
    const bodyPitch = -clamp(longAccel * 0.006 * weight, 0.13 * weight)
    let mean = 0, left = 0, right = 0, front = 0, back = 0, nx = 0, nz = 0, sx = 0, sz = 0
    const flat = this.ground(city, c.x, c.z)
    for (let i = 0; i < this.axles.length; i++) {
      const p = this.axles[i], out = this.contacts[i]
      out.x = c.x + p.x * cs + p.z * sn; out.z = c.z - p.x * sn + p.z * cs
      const ground = settings.wheelContact ? this.ground(city, out.x, out.z) : flat
      // Airborne wheels follow the chassis altitude, never stretch down to the street.
      out.y = (c.airborne ? (c.y ?? 0) : ground) + p.y
      mean += ground
      if (p.x < 0) { left += ground; nx++; sx += -p.x } else { right += ground; sx += p.x }
      if (p.z > 0) { front += ground; nz++ } else back += ground
      sz += Math.abs(p.z)
      const rear = p.z < 0
      const lock = (input?.handbrake && rear) || ((input ? input.brake > 0.8 : c.braking) && c.speed > 5)
      const burnout = !c.airborne && rear && !lock && ((input?.throttle ?? (c.boosting || longAccel > 3 ? 1 : 0)) > 0.9) && (c.speed < 9 || c.drift > 4 || c.boosting)
      const speed = lock ? 0 : burnout ? Math.max(18, Math.abs(forward) * 1.65) : forward
      out.spin = (out.spin + speed * Math.min(dt, 0.1) / p.y) % (Math.PI * 2)
    }
    const n = this.axles.length
    mean /= n
    const groundRoll = nx && nx < n ? Math.atan2(right / (n - nx) - left / nx, sx / (n / 2)) : 0
    const groundPitch = nz && nz < n ? -Math.atan2(front / nz - back / (n - nz), sz / (n / 2)) : 0
    const contact = settings.wheelContact && !c.airborne
    // c.y already contains centre-ramp height. Only add the four-contact correction.
    const liftTarget = contact ? mean - (c.y ?? 0) : 0
    if (settings.suspension && !teleport) {
      if ((c.landings ?? 0) > this.landings) {
        this.lift.v -= Math.min(2.8, (c.landing ?? 0) * 0.22)
        this.leanPitch.v += Math.min(0.65, (c.landing ?? 0) * 0.035)
      }
      if (c.impact > 5 && this.impact <= 5) {
        this.leanPitch.v += clamp(-forward * 0.045, 0.8)
        this.leanRoll.v += clamp(-lateral * 0.07, 0.7)
      }
    }
    this.landings = c.landings ?? 0; this.impact = c.impact
    const roll = settings.suspension || settings.vehicleFeel ? bodyRoll : 0
    const pitch = settings.suspension || settings.vehicleFeel ? bodyPitch : 0
    if (settings.suspension) {
      springStep(this.leanRoll, roll, dt, omega)
      springStep(this.leanPitch, pitch, dt, omega)
    } else {
      const k = 1 - Math.exp(-dt * 8)
      this.leanRoll.x += (roll - this.leanRoll.x) * k
      this.leanPitch.x += (pitch - this.leanPitch.x) * k
      this.leanRoll.v = this.leanPitch.v = 0
    }
    springStep(this.surfaceRoll, contact ? groundRoll : 0, dt, omega)
    springStep(this.surfacePitch, contact ? groundPitch : 0, dt, omega)
    this.roll.x = this.leanRoll.x + this.surfaceRoll.x
    this.pitch.x = this.leanPitch.x + this.surfacePitch.x
    this.roll.v = this.leanRoll.v + this.surfaceRoll.v
    this.pitch.v = this.leanPitch.v + this.surfacePitch.v
    springStep(this.lift, liftTarget, dt, omega)
    // Local controls make deliberate countersteer immediate; remote cars infer it from slip + yaw.
    const steer = input ? input.steer * 0.48 : clamp(Math.atan2(this.yaw * spec.length * 0.64, Math.max(3, Math.abs(forward))) - Math.atan2(lateral, Math.max(3, Math.abs(forward))) * 0.7, 0.55)
    this.steer += (steer - this.steer) * (1 - Math.exp(-dt * 16))
  }
}
