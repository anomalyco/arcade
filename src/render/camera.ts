import { MathUtils, Matrix4, PerspectiveCamera, Quaternion, Vector3 } from "three"
import type { Quat, Vec3, VehicleKind } from "../sim/types"
import { groundHeight } from "../sim/geography"
import { VEHICLES } from "../sim/vehicles"

export type CameraMode = "menu" | "orbit" | "chase" | "cockpit" | "gunner" | "death"

/** Body-space (nose = -Z) eye offsets. */
const COCKPIT: Record<VehicleKind, Vec3> = {
  fighter: [0, 1.6, -5.2],
  apache: [0, 2.5, -1.2],
  warthog: [0, 1.7, -4.4],
  blackbird: [0, 1.6, -9],
  bomber: [0, 2.2, -9],
}
/** Gunner camera: targeting pod / chin turret position. */
const GUNNER: Record<VehicleKind, Vec3> = {
  fighter: [0, -1.4, -3],
  apache: [0, -1.3, -4.2],
  warthog: [0, -1.5, -2],
  blackbird: [0, -2.4, -15],
  bomber: [0, -3, -4],
}
/**
 * Gunner eye placement relative to the optic: metres along the line of sight (clears the own nose/belly)
 * and metres straight down (below the fuselage), so the own airframe never fills the frame.
 */
const GUNNER_LEAD: Record<VehicleKind, number> = { fighter: 9, apache: 2.5, warthog: 8, blackbird: 4, bomber: 3 }
const GUNNER_DROP: Record<VehicleKind, number> = { fighter: 1.5, apache: 0.6, warthog: 1.5, blackbird: 1.5, bomber: 2 }
/** Bomb-sight optical zoom range. */
export const BOMBSIGHT_MIN_ZOOM = 2
export const BOMBSIGHT_MAX_ZOOM = 8
/** Minimum eye height above the ground/water surface (m). */
const GROUND_CLEARANCE = 1.5
const CHASE: Record<VehicleKind, { dist: number; height: number }> = {
  fighter: { dist: 26, height: 6 },
  apache: { dist: 24, height: 7 },
  warthog: { dist: 28, height: 7 },
  blackbird: { dist: 40, height: 9 },
  bomber: { dist: 60, height: 13 },
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

/** Extra FOV (deg) when flying above cruise (boosting), ramping in over the first 40% of the boost band. */
const BOOST_FOV = 6
function boostFov(kind: VehicleKind, speed: number): number {
  const v = VEHICLES[kind]
  if (v.flight !== "jet") return 0
  return BOOST_FOV * MathUtils.smoothstep(speed, v.cruise * 1.02, v.cruise + (v.boost - v.cruise) * 0.4)
}

/** Mouse-aim chase: look-direction smoothing time constant (s). */
const CHASE_LOOK_LAG = 0.06

const HELI_PITCH_FOLLOW = 0.7
const HELI_ROLL_FOLLOW = 0.3

/**
 * Helicopter chase attitude: full yaw, most of the pitch, only part of the roll so the horizon stays
 * readable. Roll follow ramps to 1 when the heli goes past ~90° bank so flips stay continuous.
 */
function horizonFollow(q: Quaternion, out: Quaternion): Quaternion {
  const f = _hf.set(0, 0, -1).applyQuaternion(q)
  const r = _hr.set(1, 0, 0).applyQuaternion(q)
  const u = _hu.set(0, 1, 0).applyQuaternion(q)
  const yaw = Math.atan2(-f.x, -f.z)
  const pitch = Math.asin(MathUtils.clamp(f.y, -1, 1))
  const bank = Math.atan2(-r.y, u.y)
  const t = MathUtils.smoothstep(Math.abs(bank), Math.PI / 3, Math.PI * 0.85)
  const rollK = HELI_ROLL_FOLLOW + (1 - HELI_ROLL_FOLLOW) * t
  const pitchK = HELI_PITCH_FOLLOW + (1 - HELI_PITCH_FOLLOW) * t
  _hq.setFromAxisAngle(UP, yaw)
  out.copy(_hq).multiply(_hq2.setFromAxisAngle(_hr.set(1, 0, 0), pitch * pitchK)).multiply(_hq2.setFromAxisAngle(_hu.set(0, 0, 1), -bank * rollK))
  return out
}
const _hf = new Vector3()
const _hr = new Vector3()
const _hu = new Vector3()
const _hq = new Quaternion()
const _hq2 = new Quaternion()

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
  private chaseLook = new Vector3(0, 0, -1)
  private chaseLookInit = false

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
    // The view swings with the aim (slight lag smooths mouse steps); position stays rigidly tied to the
    // aircraft so the airframe never surges relative to the camera.
    if (!this.chaseLookInit || this.chaseLook.dot(look) < 0.2) { this.chaseLook.copy(look); this.chaseLookInit = true }
    else this.chaseLook.lerp(look, 1 - Math.exp(-dt / CHASE_LOOK_LAG)).normalize()
    const lk = this.chaseLook
    this.pos.set(position[0], position[1], position[2]).addScaledVector(lk, -dist).addScaledVector(UP, height)
    const floor = groundAt(this.pos.x, this.pos.z) + 3
    if (this.pos.y < floor) this.pos.y = floor
    _v.set(position[0], position[1], position[2]).addScaledVector(lk, 400).addScaledVector(UP, height * 0.6)
    this.lookAt(this.pos, _v, UP)
    this.fov = this.baseFov + Math.min(14, Math.max(0, speed - 80) * 0.06) + boostFov(kind, speed)
  }

  /**
   * Direct-control chase cam. Jets: follows the airframe's full attitude (roll included) with light
   * smoothing so loops, rolls and inverted flight read naturally. Helicopter: follows yaw and most of
   * the pitch but only part of the roll, keeping the horizon readable. lookYaw/lookPitch = free-look.
   */
  chaseBody(dt: number, kind: VehicleKind, position: Vec3, velocity: Vec3, orientation: Quat, lookYaw: number, lookPitch: number,
    groundAt: (x: number, z: number) => number): void {
    const c = CHASE[kind]
    _q.set(orientation[0], orientation[1], orientation[2], orientation[3])
    const heli = kind === "apache"
    if (heli) horizonFollow(_q, _q)
    if (!this.followInit) { this.followQ.copy(_q); this.followInit = true }
    // Frame-rate independent smoothing; jets follow a touch quicker (roll included), helis softer.
    this.followQ.slerp(_q, 1 - Math.exp(-dt * (heli ? 5 : 7)))
    _q2.copy(this.followQ)
    if (lookYaw || lookPitch) {
      _q2.multiply(_qy.setFromAxisAngle(UP, lookYaw)).multiply(_qp.setFromAxisAngle(_x.set(1, 0, 0), lookPitch))
    }
    const speed = Math.hypot(velocity[0], velocity[1], velocity[2])
    const dist = c.dist * this.zoom * (1 + Math.min(speed, 260) / 900)
    const height = c.height * this.zoom
    // Position is locked to the (tick-interpolated) aircraft: any positional lag here makes the airframe
    // surge back and forth relative to the camera at speed. Sense of speed comes from FOV only.
    _v.set(position[0], position[1], position[2])
    this.pos.set(0, height, dist).applyQuaternion(_q2).add(_v)
    const floor = groundAt(this.pos.x, this.pos.z) + 3
    if (this.pos.y < floor) this.pos.y = floor
    _v2.set(0, height * 0.55, -80).applyQuaternion(_q2).add(_v)
    _up.set(0, 1, 0).applyQuaternion(_q2)
    this.lookAt(this.pos, _v2, _up)
    this.fov = this.baseFov + Math.min(14, Math.max(0, speed - 80) * 0.06) + boostFov(kind, speed)
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
    this.chaseLookInit = false
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

  /**
   * Bombardier bomb sight: from the bomb bay, looking along `look` (toward the chosen ground point),
   * stabilized — the image never rolls with the aircraft; screen-up is the aircraft's heading.
   */
  bombsight(dt: number, kind: VehicleKind, position: Vec3, orientation: Quat, look: Vector3, zoom: number): void {
    _q.set(orientation[0], orientation[1], orientation[2], orientation[3])
    const o = GUNNER[kind]
    this.pos.set(o[0], o[1], o[2]).applyQuaternion(_q).add(_v.set(position[0], position[1], position[2]))
    this.pos.y -= GUNNER_DROP[kind]
    // Heading-only "up" (forward on the ground) keeps the sight level whatever the bank.
    _v2.set(0, 0, -1).applyQuaternion(_q)
    _v2.y = 0
    if (_v2.lengthSq() < 1e-6) _v2.set(0, 0, -1)
    _v2.normalize()
    _v.copy(this.pos).add(look)
    this.lookAt(this.pos, _v, _v2)
    this.fov = 60 / Math.max(BOMBSIGHT_MIN_ZOOM, Math.min(BOMBSIGHT_MAX_ZOOM, zoom))
  }

  /** Gunner optics. `anchor` = world position of the turret / targeting pod when the model provides one. */
  gunner(dt: number, kind: VehicleKind, position: Vec3, orientation: Quat, look: Vector3, anchor: Vector3 | null = null): void {
    _q.set(orientation[0], orientation[1], orientation[2], orientation[3])
    if (anchor) this.pos.copy(anchor)
    else {
      const o = GUNNER[kind]
      this.pos.set(o[0], o[1], o[2]).applyQuaternion(_q).add(_v.set(position[0], position[1], position[2]))
    }
    // Ahead along the line of sight and below the airframe so the own nose/belly never fills the frame,
    // and never below the ground (helipad look-down).
    this.pos.addScaledVector(look, GUNNER_LEAD[kind])
    this.pos.y -= GUNNER_DROP[kind]
    const floor = groundHeight(this.pos.x, this.pos.z) + GROUND_CLEARANCE
    if (this.pos.y < floor) this.pos.y = floor
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
