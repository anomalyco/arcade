import { FirstPerson } from "@arcade/kit/client/first-person"
import { Walk } from "@arcade/kit/client/walk"
import type { WalkCameraSettings } from "@arcade/kit/client/walk-camera"
import type { CameraFeel } from "./camera-feel"

/**
 * The shared pointer-locked first-person camera with the shared walk gait (head motion, footsteps), drawn wherever the
 * session says you are: the shared `movePlayer` walks you (solo, the room, and the room's prediction alike), so the
 * camera only looks and sways. Movement keys are read by the game, not the camera.
 */
export class WoodsCamera extends FirstPerson {
  walk = new Walk()
  private last: { x: number; z: number } | null = null
  private wasAirborne = false
  private dip = { x: 0, v: 0 }
  /** Camera feel (bob, jolts, leans, FOV push, turning inertia, shake), added to `mount` after the rig each frame. */
  feel: CameraFeel | null = null
  /** Per frame, for the feel: walking speed (m/s) and how much extra head bob the camera look wants. */
  feelInput = { walkSpeed: 1.9, bobScale: 1 }
  /** A camera look's zoom: × the field of view (1 wide open). */
  lensScale = 1
  private applied = { yaw: 0, pitch: 0, roll: 0, fov: 0 }

  constructor(canvas: HTMLCanvasElement, private readonly isBlocked: () => boolean, private readonly settings: WalkCameraSettings, private readonly active: () => boolean) {
    super(canvas, isBlocked)
  }

  resetWalk() {
    this.walk = new Walk()
    this.last = null
    this.wasAirborne = false
    this.dip.x = this.dip.v = 0
    this.feel?.reset()
  }

  /** The view from (x, z) with the eye at `height`, swaying with the distance walked since last frame. */
  place(x: number, z: number, height: number, dt: number, aspect: number, rise = 0) {
    if (this.isBlocked() && document.pointerLockElement) document.exitPointerLock()
    const dx = this.last ? x - this.last.x : 0, dz = this.last ? z - this.last.z : 0
    this.last = { x, z }
    const s = this.settings
    const airborne = rise > 0, landed = this.wasAirborne && !airborne
    this.wasAirborne = airborne
    this.walk.update({ dx, dz, yaw: this.yaw, dt, active: this.active(), amount: s.cameraMotion, reduced: s.reduceMotion, stride: s.stepLength, settling: s.walkSettle, airborne: airborne || landed })
    // Night Shift's soft two-foot landing and critically damped 35 mm knee dip.
    const w0 = 2 * Math.PI / 0.3, step = Math.min(dt, 0.05), e = Math.exp(-w0 * step)
    if (landed && this.active()) {
      this.walk.land(1)
      this.dip.v -= (s.reduceMotion ? 0 : s.cameraMotion) * (s.landDip ?? 0.035) * Math.E * w0
    }
    const c = this.dip.v + w0 * this.dip.x
    this.dip.x = (this.dip.x + c * step) * e
    this.dip.v = (this.dip.v - w0 * c * step) * e
    this.body.x = x
    this.body.y = z
    this.body.vx = dt > 0 ? dx / dt : 0
    this.body.vy = dt > 0 ? dz / dt : 0
    this.height = height
    // Last frame's feel comes back out first, so the rig (or nothing) owns `mount` again.
    const m = this.mount, a = this.applied
    m.yaw -= a.yaw; m.pitch -= a.pitch; m.roll -= a.roll; m.fov -= a.fov
    // A body-worn camera's mount (camera looks): the view hangs and sways, the aim stays yours.
    this.rig?.(this, dt, aspect)
    a.yaw = a.pitch = a.roll = a.fov = 0
    let lift = 0
    if (this.feel) {
      const f = this.feel
      f.frame({ dt, walk: this.walk, vx: this.body.vx, vz: this.body.vy, yaw: this.yaw, rise, walkSpeed: this.feelInput.walkSpeed, reduced: s.reduceMotion, bobScale: this.feelInput.bobScale })
      a.yaw = f.out.yaw; a.pitch = f.out.pitch; a.roll = f.out.roll; a.fov = f.out.fov
      m.yaw += a.yaw; m.pitch += a.pitch; m.roll += a.roll; m.fov += a.fov
      lift = f.out.height
    }
    // A camcorder's zoom narrows whatever field of view the rig and feel left.
    const zoom = (this.fov + m.fov) * (this.lensScale - 1)
    a.fov += zoom
    m.fov += zoom
    const w = this.walk, sy = Math.sin(this.yaw), cy = Math.cos(this.yaw)
    this.eye[0] = x + w.lateral * cy
    this.eye[1] = height + rise + this.mount.height + w.vertical + lift + (s.reduceMotion ? 0 : this.dip.x)
    this.eye[2] = z - w.lateral * sy
    this.direction[0] = -sy * Math.cos(this.pitch)
    this.direction[1] = Math.sin(this.pitch)
    this.direction[2] = -cy * Math.cos(this.pitch)
    return this.compose(aspect, w.roll)
  }
}
