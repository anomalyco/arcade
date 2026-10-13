import type { Camera } from "../render/camera"

const DEG = Math.PI / 180

/** Boat chase camera tuning. Metres, seconds, radians. */
export const BOAT_CAM = {
  /** Distance from the pivot (no zoom) and the pivot's height over the boat's origin. */
  dist: 34,
  pivotY: 2.5,
  /** The eye sits this much above the aim line, so the boat rides below the crosshair. */
  lift: 9 * DEG,
  /** Aim elevation limits and the resting aim (just over the horizon). */
  minAim: -24 * DEG,
  maxAim: 58 * DEG,
  restAim: -1 * DEG,
  /** Radians per CSS pixel of mouse movement (both axes, mouse down aims down). */
  sensitivity: 0.0032,
  /** After this long without mouse movement or fire, the aim drifts back over the bow. */
  idle: 4.5,
  returnLag: 1.1,
  /** The pivot follows this share of the hull's heave, over this lag (s): the horizon stays calm over chop. */
  heaveFollow: 0.75,
  heaveLag: 0.2,
  /** The eye never goes lower than this over the water under it. */
  minClear: 1.6,
  fov: 58 * DEG,
  /** Extra field of view at full boost. */
  boostFov: 7 * DEG,
  /** Shake at full trauma (m of eye jitter, scaled by trauma²). */
  shake: 0.9,
  /** Farthest aim point (m): beyond the gun's reach the crosshair point is this far along the view. */
  reach: 1300,
}

export type BoatCamTarget = { x: number; z: number; heave: number; heading: number; trauma: number; boost: number }

const wrap = (a: number) => a - Math.PI * 2 * Math.floor((a + Math.PI) / (Math.PI * 2))
const ease = (dt: number, lag: number) => 1 - Math.exp(-dt / lag)

/**
 * Battlefield-style vehicle camera for the boat: the mouse aims in the world (not relative to the hull), so the turret
 * holds its target through turns; the eye trails behind and above the aim line at a fixed distance and the crosshair
 * (screen centre) is where the gun goes. After a few seconds without aiming the view drifts back over the bow.
 */
export class BoatCam {
  /** World aim: compass yaw and elevation. */
  yaw = 0
  pitch = BOAT_CAM.restAim
  /** The aim point under the crosshair this frame (world). */
  readonly aim: [number, number, number] = [0, 0, 0]
  private fy = 0
  private idle = 0
  private time = 0
  private placed = false
  private eye = [0, 0, 0]
  private fwd = [0, 0, -1]
  private up = [0, 1, 0]

  reset(): void {
    this.placed = false
  }

  update(cam: Camera, t: BoatCamTarget, look: { dx: number; dy: number }, dt: number, aspect: number, water: (x: number, z: number) => number, busy = false): void {
    const C = BOAT_CAM
    this.time += dt
    const ty = t.heave * C.heaveFollow + C.pivotY
    if (!this.placed) {
      this.placed = true
      this.yaw = t.heading
      this.pitch = C.restAim
      this.fy = ty
    }
    if (look.dx || look.dy || busy) this.idle = 0
    else this.idle += dt
    this.yaw = wrap(this.yaw + look.dx * C.sensitivity)
    this.pitch = Math.max(C.minAim, Math.min(C.maxAim, this.pitch - look.dy * C.sensitivity))
    if (this.idle > C.idle) {
      const k = ease(dt, C.returnLag)
      this.yaw = wrap(this.yaw + wrap(t.heading - this.yaw) * k)
      this.pitch += (C.restAim - this.pitch) * k
    }
    this.fy += (ty - this.fy) * ease(dt, C.heaveLag)
    const s = t.trauma * t.trauma * C.shake
    const jx = s * (Math.sin(this.time * 23.1) * 0.6 + Math.sin(this.time * 37.7 + 1.3) * 0.4)
    const jy = s * (Math.sin(this.time * 29.3 + 0.7) * 0.6 + Math.sin(this.time * 41.9 + 2.1) * 0.4)
    // Aim direction (compass yaw: forward is (sin, −cos)), and the eye behind the pivot along the lifted line.
    const cp = Math.cos(this.pitch)
    const fx = Math.sin(this.yaw) * cp
    const fy = Math.sin(this.pitch)
    const fz = -Math.cos(this.yaw) * cp
    const ep = this.pitch - C.lift
    const ex = Math.sin(this.yaw) * Math.cos(ep)
    const ey = Math.sin(ep)
    const ez = -Math.cos(this.yaw) * Math.cos(ep)
    const eye = this.eye
    eye[0] = t.x - ex * C.dist + jx
    eye[1] = this.fy - ey * C.dist + jy
    eye[2] = t.z - ez * C.dist
    eye[1] = Math.max(eye[1], water(eye[0], eye[2]) + C.minClear)
    this.fwd[0] = fx
    this.fwd[1] = fy
    this.fwd[2] = fz
    cam.lookAlong(eye, this.fwd, this.up, C.fov + C.boostFov * t.boost, aspect)
    // The aim point: where the view ray meets the sea, else far along it.
    let d = C.reach
    if (fy < -1e-3) {
      d = Math.min(C.reach, (eye[1] - 0) / -fy)
      for (let i = 0; i < 3; i++) {
        const h = water(eye[0] + fx * d, eye[2] + fz * d)
        d = Math.max(5, Math.min(C.reach, (eye[1] - h) / -fy))
      }
    }
    this.aim[0] = eye[0] + fx * d
    this.aim[1] = eye[1] + fy * d
    this.aim[2] = eye[2] + fz * d
  }
}
