import { TraumaShake, shakeWave } from "@arcade/kit/client/camera"
import { SHAKE, type Camera } from "../render/camera"

const DEG = Math.PI / 180

/** Chase camera tuning. Distances in metres, times in seconds. */
export const CHASE = {
  /** Fixed distance from the focus: the player orbits but can't zoom. */
  dist: 520,
  /** Eye elevation seen from the focus. */
  pitch: 17 * DEG,
  minPitch: 6 * DEG,
  maxPitch: 80 * DEG,
  /** The orbit pivot: the ship's centre (mid-length, on the centreline) at this height above the waterline. */
  pivotY: 22,
  /** Lag of the heading follow, and of the pivot's height (the plan position is followed exactly). */
  yawLag: 0.9,
  heaveLag: 0.4,
  /** Share of the ship's heave the camera rides with (the horizon stays level: no roll, no pitch follow). */
  heaveFollow: 0.5,
  /** After this long without mouse movement, an orbit offset springs back behind the ship over `returnLag`. */
  idle: 4.5,
  returnLag: 1.2,
  /** Orbit radians per CSS pixel of mouse movement, both axes (mouse down raises the eye: looks down; no invert). */
  sensitivity: 0.0045,
  /** Shake from grounding and bow slams: metres of focus jitter at full trauma (scaled by trauma²). */
  shake: 9,
}

const wrap = (a: number) => a - Math.PI * 2 * Math.floor((a + Math.PI) / (Math.PI * 2))
const ease = (dt: number, lag: number) => 1 - Math.exp(-dt / lag)

export type ChaseTarget = { x: number; z: number; heave: number; heading: number; speed: number; topSpeed: number; trauma: number }

/**
 * Third-person camera behind and above the ship. Orbits the ship's centre, follows the heading with a little lag (so
 * turns read), keeps the horizon level and stays at a fixed distance. The mouse orbits around the ship (Pointer Lock:
 * plain movement; without it, a drag; no zoom); the orbit springs back behind after a few seconds without movement.
 */
export class ChaseCam {
  private yaw = 0
  private yawOff = 0
  private pitch = CHASE.pitch
  private dist = CHASE.dist
  private fy = 0
  private idle = 0
  private placed = false
  /** Its clock and the shared shake settings; the trauma itself comes from the ship every frame (`ChaseTarget`). */
  private readonly shake = new TraumaShake(SHAKE)

  /** Snaps behind the target on the next update. */
  reset(): void {
    this.placed = false
  }

  update(cam: Camera, t: ChaseTarget, dt: number, aspect: number, drag: { dx: number; dy: number; wheel: number; dragging: boolean }): void {
    this.shake.tick(dt)
    const ty = CHASE.pivotY + t.heave * CHASE.heaveFollow
    if (!this.placed) {
      this.placed = true
      this.yaw = t.heading
      this.yawOff = 0
      this.pitch = CHASE.pitch
      this.fy = ty
    }
    if (drag.dx || drag.dy) this.idle = 0
    else this.idle += dt
    this.yawOff = wrap(this.yawOff - drag.dx * CHASE.sensitivity)
    this.pitch = Math.max(CHASE.minPitch, Math.min(CHASE.maxPitch, this.pitch + drag.dy * CHASE.sensitivity))
    if (this.idle > CHASE.idle) {
      const k = ease(dt, CHASE.returnLag)
      this.yawOff -= this.yawOff * k
      this.pitch += (CHASE.pitch - this.pitch) * k
    }
    this.yaw = wrap(this.yaw + wrap(t.heading - this.yaw) * ease(dt, CHASE.yawLag))
    this.fy += (ty - this.fy) * ease(dt, CHASE.heaveLag)

    // Trauma² shake: two incommensurate sines per axis, so it never loops visibly.
    const s = this.shake.intensity(t.trauma) * CHASE.shake
    const n = this.shake.time
    const jx = s * shakeWave(n, 23.1, 0, 37.7, 1.3)
    const jy = s * shakeWave(n, 29.3, 0.7, 41.9, 2.1)

    cam.x = t.x + jx
    cam.z = t.z
    cam.y = this.fy + jy
    cam.yaw = this.yaw + this.yawOff
    cam.pitch = this.pitch
    cam.dist = cam.targetDist = this.dist
    cam.compute(aspect)
  }
}
