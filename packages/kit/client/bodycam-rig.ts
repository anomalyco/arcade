import type { FirstPerson } from "./first-person"

export type BodycamRigSettings = {
  /** Lens diagonal field of view, degrees. */
  lens: number
  /** Metres below the eyes (chest mount). */
  mount: number
  sway: number
  lag: number
  bob: number
}

/** Vertical field of view of the rectilinear render whose diagonal spans `lens` degrees; the fisheye pass keeps the corners. */
export function bodycamRenderFov(lens: number, aspect: number): number {
  const half = Math.min(84, Math.max(20, lens / 2)) * Math.PI / 180
  return Math.min(150, 2 * Math.atan(Math.tan(half) / Math.hypot(aspect, 1)) * 180 / Math.PI)
}

/**
 * A chest-mounted body camera on a `FirstPerson`: the view hangs below the eyes, trails the player's turns on a heavy
 * torso (an underdamped spring, so it swings past and settles), dips at every footfall, twists with the stride and
 * leans into turns. Writes `camera.mount` only, so aim and movement stay the player's.
 */
export class BodycamRig {
  private yaw = 0
  private yawV = 0
  private pitch = 0
  private pitchV = 0
  private phase = 0
  private speed = 0
  private time = 0
  private engaged = false

  /** `strength` 0 leaves the camera untouched; inactive resets the rig so it starts level next time. */
  step(camera: FirstPerson, dt: number, aspect: number, s: BodycamRigSettings, strength: number, active: boolean) {
    const m = camera.mount
    if (!active) {
      if (this.engaged) Object.assign(m, { yaw: 0, pitch: 0, roll: 0, height: 0, fov: 0 })
      this.engaged = false
      return
    }
    const k = Math.max(0, Math.min(1, strength))
    if (!this.engaged) {
      this.yaw = camera.yaw
      this.pitch = camera.pitch
      this.yawV = this.pitchV = 0
      this.engaged = true
    }
    dt = Math.min(dt, 0.1)
    this.time += dt
    // Torso lag: stiff with no lag, slow and loose at full lag.
    const omega = 32 - 24 * s.lag, zeta = 0.85 - 0.3 * s.lag
    for (let left = dt; left > 1e-6; left -= 1 / 120) {
      const h = Math.min(left, 1 / 120)
      this.yawV += (omega * omega * (camera.yaw - this.yaw) - 2 * zeta * omega * this.yawV) * h
      this.yaw += this.yawV * h
      this.pitchV += (omega * omega * (camera.pitch - this.pitch) - 2 * zeta * omega * this.pitchV) * h
      this.pitch += this.pitchV * h
    }
    // Footsteps: one strike every half cycle, about 1.9 steps a second at a walk.
    const moving = Math.hypot(camera.body.vx, camera.body.vy)
    this.speed += (moving - this.speed) * (1 - Math.exp(-dt / 0.12))
    const walk = Math.min(1, Math.max(0, (this.speed - 0.15) / 1.2))
    this.phase += (this.speed / 0.72) * Math.PI * dt
    const stride = Math.sin(this.phase)
    const strike = (1 - Math.abs(stride)) ** 6
    const turn = Math.max(-1, Math.min(1, this.yawV / 4))
    const breath = Math.sin(this.time * 1.7)
    m.yaw = k * (Math.max(-0.4, Math.min(0.4, this.yaw - camera.yaw)) + s.sway * (0.03 * walk * stride + 0.003 * Math.sin(this.time * 0.63 + 1)))
    m.pitch = k * (Math.max(-0.3, Math.min(0.3, this.pitch - camera.pitch)) - s.bob * 0.018 * walk * strike + s.sway * 0.004 * breath)
    m.roll = k * s.sway * (0.022 * walk * stride - 0.05 * turn)
    m.height = -k * s.mount + k * s.bob * walk * 0.022 * (Math.abs(stride) - 0.6)
    m.fov = k * (bodycamRenderFov(s.lens, aspect) - camera.fov)
  }
}
