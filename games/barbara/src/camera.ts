import { FirstPerson } from "@arcade/kit/client/first-person"
import { Walk } from "@arcade/kit/client/walk"
import type { WalkCameraSettings } from "@arcade/kit/client/walk-camera"

/**
 * The shared pointer-locked first-person camera with the shared walk gait (head motion, footsteps), drawn wherever the
 * session says you are: the shared `movePlayer` walks you (solo, the room, and the room's prediction alike), so the
 * camera only looks and sways. Movement keys are read by the game, not the camera.
 */
export class WoodsCamera extends FirstPerson {
  walk = new Walk()
  private last: { x: number; z: number } | null = null

  constructor(canvas: HTMLCanvasElement, private readonly isBlocked: () => boolean, private readonly settings: WalkCameraSettings, private readonly active: () => boolean) {
    super(canvas, isBlocked)
  }

  resetWalk() {
    this.walk = new Walk()
    this.last = null
  }

  /** The view from (x, z) with the eye at `height`, swaying with the distance walked since last frame. */
  place(x: number, z: number, height: number, dt: number, aspect: number) {
    if (this.isBlocked() && document.pointerLockElement) document.exitPointerLock()
    const dx = this.last ? x - this.last.x : 0, dz = this.last ? z - this.last.z : 0
    this.last = { x, z }
    const s = this.settings
    this.walk.update({ dx, dz, yaw: this.yaw, dt, active: this.active(), amount: s.cameraMotion, reduced: s.reduceMotion, stride: s.stepLength, settling: s.walkSettle })
    this.body.x = x
    this.body.y = z
    this.body.vx = dt > 0 ? dx / dt : 0
    this.body.vy = dt > 0 ? dz / dt : 0
    this.height = height
    // A body-worn camera's mount (camera looks): the view hangs and sways, the aim stays yours.
    this.rig?.(this, dt, aspect)
    const w = this.walk, sy = Math.sin(this.yaw), cy = Math.cos(this.yaw)
    this.eye[0] = x + w.lateral * cy
    this.eye[1] = height + this.mount.height + w.vertical
    this.eye[2] = z - w.lateral * sy
    this.direction[0] = -sy * Math.cos(this.pitch)
    this.direction[1] = Math.sin(this.pitch)
    this.direction[2] = -cy * Math.cos(this.pitch)
    return this.compose(aspect, w.roll)
  }
}
