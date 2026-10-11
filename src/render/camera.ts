import { MathUtils, Matrix4, PerspectiveCamera, Quaternion, Vector3 } from "three"
import type { Quat, Vec3, VehicleKind } from "../sim/types"

export type CameraMode = "menu" | "orbit" | "chase" | "cockpit" | "gunner" | "death"

/** Body-space (nose = -Z) eye offsets. */
const COCKPIT: Record<VehicleKind, Vec3> = {
  fighter: [0, 1.6, -5.2],
  apache: [0, 2.5, -1.2],
  warthog: [0, 1.7, -4.4],
  blackbird: [0, 1.6, -9],
}
/** Gunner camera: targeting pod / chin turret position. */
const GUNNER: Record<VehicleKind, Vec3> = {
  fighter: [0, -1.4, -3],
  apache: [0, -1.3, -4.2],
  warthog: [0, -1.5, -2],
  blackbird: [0, -1.2, -6],
}
const CHASE: Record<VehicleKind, { dist: number; height: number }> = {
  fighter: { dist: 26, height: 6 },
  apache: { dist: 24, height: 7 },
  warthog: { dist: 28, height: 7 },
  blackbird: { dist: 40, height: 9 },
}

const UP = new Vector3(0, 1, 0)
const _m = new Matrix4()
const _v = new Vector3()
const _v2 = new Vector3()
const _q = new Quaternion()
const _q2 = new Quaternion()
const _qy = new Quaternion()
const _qp = new Quaternion()
const _x = new Vector3()
const _up = new Vector3()

/**
 * One camera rig for every mode. Each mode computes a desired pose; switching modes
 * blends from the previous pose so cuts never pop.
 */
export class CameraRig {
  mode: CameraMode = "menu"
  /** Chase distance multiplier (wheel). At the minimum the chase view becomes cockpit. */
  zoom = 1
  /** Gunner optical zoom factor (1 = 60° fov). */
  gunZoom = 1
  baseFov = 62
  private blend = 1
  private fromPos = new Vector3()
  private fromQuat = new Quaternion()
  private pos = new Vector3()
  private quat = new Quaternion()
  private fov = 62
  private time = 0
  private shakeAmt = 0
  private orbitAngle = 0
  private followQ = new Quaternion()
  private followInit = false

  constructor(readonly camera: PerspectiveCamera) {
    this.pos.copy(camera.position)
    this.quat.copy(camera.quaternion)
  }

  setMode(mode: CameraMode): void {
    if (mode === this.mode) return
    this.mode = mode
    this.fromPos.copy(this.camera.position)
    this.fromQuat.copy(this.camera.quaternion)
    this.blend = 0
  }

  shake(amount: number): void {
    this.shakeAmt = Math.min(2, this.shakeAmt + amount)
  }

  /** Slow cinematic orbit (menu backdrop / spawn screen). */
  orbit(dt: number, center: Vec3, radius: number, height: number, speed: number): void {
    this.orbitAngle += dt * speed
    const a = this.orbitAngle
    this.pos.set(center[0] + Math.cos(a) * radius, center[1] + height, center[2] + Math.sin(a) * radius)
    _v.set(center[0], center[1] + height * 0.15, center[2])
    this.lookAt(this.pos, _v, UP)
    this.fov = this.baseFov
  }

  /** Mouse-aim chase cam: sits behind the aircraft along the aim (or free-look) direction. */
  chase(dt: number, kind: VehicleKind, position: Vec3, velocity: Vec3, look: Vector3, groundAt: (x: number, z: number) => number): void {
    const c = CHASE[kind]
    const speed = Math.hypot(velocity[0], velocity[1], velocity[2])
    const dist = c.dist * this.zoom * (1 + Math.min(speed, 260) / 900)
    const height = c.height * this.zoom
    this.pos.set(position[0], position[1], position[2]).addScaledVector(look, -dist).addScaledVector(UP, height)
    const floor = groundAt(this.pos.x, this.pos.z) + 3
    if (this.pos.y < floor) this.pos.y = floor
    _v.set(position[0], position[1], position[2]).addScaledVector(look, 400).addScaledVector(UP, height * 0.6)
    this.lookAt(this.pos, _v, UP)
    this.fov = this.baseFov + Math.min(14, Math.max(0, speed - 80) * 0.06)
  }

  /**
   * Direct-control chase cam: follows the airframe's own attitude (with a little lag) so loops,
   * rolls and inverted flight read naturally. lookYaw/lookPitch = free-look offsets.
   */
  chaseBody(dt: number, kind: VehicleKind, position: Vec3, velocity: Vec3, orientation: Quat, lookYaw: number, lookPitch: number,
    groundAt: (x: number, z: number) => number): void {
    const c = CHASE[kind]
    _q.set(orientation[0], orientation[1], orientation[2], orientation[3])
    if (!this.followInit) { this.followQ.copy(_q); this.followInit = true }
    this.followQ.slerp(_q, 1 - Math.exp(-dt * 6))
    _q2.copy(this.followQ)
    if (lookYaw || lookPitch) {
      _q2.multiply(_qy.setFromAxisAngle(UP, lookYaw)).multiply(_qp.setFromAxisAngle(_x.set(1, 0, 0), lookPitch))
    }
    const speed = Math.hypot(velocity[0], velocity[1], velocity[2])
    const dist = c.dist * this.zoom * (1 + Math.min(speed, 260) / 900)
    const height = c.height * this.zoom
    _v.set(position[0], position[1], position[2])
    this.pos.set(0, height, dist).applyQuaternion(_q2).add(_v)
    const floor = groundAt(this.pos.x, this.pos.z) + 3
    if (this.pos.y < floor) this.pos.y = floor
    _v2.set(0, height * 0.55, -80).applyQuaternion(_q2).add(_v)
    _up.set(0, 1, 0).applyQuaternion(_q2)
    this.lookAt(this.pos, _v2, _up)
    this.fov = this.baseFov + Math.min(14, Math.max(0, speed - 80) * 0.06)
  }

  /** Cockpit view locked to the airframe (direct controls), with free-look offsets. */
  cockpitBody(dt: number, kind: VehicleKind, position: Vec3, orientation: Quat, lookYaw: number, lookPitch: number): void {
    _q.set(orientation[0], orientation[1], orientation[2], orientation[3])
    const o = COCKPIT[kind]
    this.pos.set(o[0], o[1], o[2]).applyQuaternion(_q).add(_v.set(position[0], position[1], position[2]))
    _q2.copy(_q).multiply(_qy.setFromAxisAngle(UP, lookYaw)).multiply(_qp.setFromAxisAngle(_x.set(1, 0, 0), lookPitch))
    this.quat.copy(_q2)
    this.fov = this.baseFov + 6
  }

  resetFollow(): void {
    this.followInit = false
  }

  cockpit(dt: number, kind: VehicleKind, position: Vec3, orientation: Quat, look: Vector3): void {
    _q.set(orientation[0], orientation[1], orientation[2], orientation[3])
    const o = COCKPIT[kind]
    this.pos.set(o[0], o[1], o[2]).applyQuaternion(_q).add(_v.set(position[0], position[1], position[2]))
    // Horizon-relative up blended with the airframe's up so banking reads without making aim feel loose.
    _v2.set(0, 1, 0).applyQuaternion(_q).lerp(UP, 0.35).normalize()
    _v.copy(this.pos).add(look)
    this.lookAt(this.pos, _v, _v2)
    this.fov = this.baseFov + 6
  }

  /** Gunner optics. `anchor` = world position of the turret / targeting pod when the model provides one. */
  gunner(dt: number, kind: VehicleKind, position: Vec3, orientation: Quat, look: Vector3, anchor: Vector3 | null = null): void {
    _q.set(orientation[0], orientation[1], orientation[2], orientation[3])
    if (anchor) {
      // Sit just ahead of the optic along the line of sight so the pod itself never blocks the view.
      _v2.set(0, -0.6, 0).applyQuaternion(_q)
      this.pos.copy(anchor).addScaledVector(look, 2.5).add(_v2)
    } else {
      const o = GUNNER[kind]
      this.pos.set(o[0], o[1], o[2]).applyQuaternion(_q).add(_v.set(position[0], position[1], position[2]))
    }
    _v.copy(this.pos).add(look)
    this.lookAt(this.pos, _v, UP)
    this.fov = 60 / this.gunZoom
  }

  death(dt: number, center: Vec3, t: number, groundAt?: (x: number, z: number) => number): void {
    const r = 110 + t * 25
    const a = t * 0.35 + 0.6
    this.pos.set(center[0] + Math.cos(a) * r, center[1] + 45 + t * 14, center[2] + Math.sin(a) * r)
    if (groundAt) this.pos.y = Math.max(this.pos.y, groundAt(this.pos.x, this.pos.z) + 25, groundAt(center[0], center[2]) + 30)
    _v.set(center[0], center[1], center[2])
    this.lookAt(this.pos, _v, UP)
    this.fov = this.baseFov
  }

  /** Apply blend, shake and fov to the real camera. Call once per frame after a mode function. */
  apply(dt: number): void {
    this.time += dt
    const cam = this.camera
    if (this.blend < 1) {
      this.blend = Math.min(1, this.blend + dt / 0.7)
      const e = this.blend * this.blend * (3 - 2 * this.blend)
      cam.position.lerpVectors(this.fromPos, this.pos, e)
      cam.quaternion.slerpQuaternions(this.fromQuat, this.quat, e)
    } else {
      cam.position.copy(this.pos)
      cam.quaternion.copy(this.quat)
    }
    if (this.shakeAmt > 0.001) {
      const s = this.shakeAmt
      const t = this.time * 40
      _q2.setFromAxisAngle(_v.set(Math.sin(t * 1.3), Math.cos(t * 1.7), Math.sin(t * 0.7)).normalize(), s * 0.012)
      cam.quaternion.multiply(_q2)
      this.shakeAmt *= Math.exp(-dt * 5)
    }
    const fov = MathUtils.lerp(cam.fov, this.fov, 1 - Math.exp(-dt * 8))
    if (Math.abs(fov - cam.fov) > 0.01) {
      cam.fov = fov
      cam.updateProjectionMatrix()
    }
  }

  private lookAt(eye: Vector3, target: Vector3, up: Vector3): void {
    _m.lookAt(eye, target, up)
    this.quat.setFromRotationMatrix(_m)
  }
}
