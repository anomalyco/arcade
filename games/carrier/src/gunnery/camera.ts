import { mat4d } from "wgpu-matrix"
import type { Vec3 } from "../../shared/plane"
import { TraumaShake, shakeWave } from "@arcade/kit/client/camera"
import { FAR, NEAR, SHAKE } from "../render/camera"

const DEG = Math.PI / 180

/** Turret sight tuning. Radians, seconds. */
export const TURRET_CAM = {
  fov: 58 * DEG,
  /** Right mouse: the sight's zoom per weapon. */
  scope: { ciws: 30 * DEG, sam: 24 * DEG, gun: 16 * DEG } as Record<string, number>,
  /** Zoom ease (s). */
  zoomLag: 0.09,
  /** Mouse: radians per CSS pixel at the base FOV (scaled with the zoom). */
  sensitivity: 0.0021,
  /** Shake at full trauma (scaled by trauma²): metres of jitter and radians of wobble; trauma decay per second. */
  shake: 0.12,
  shakeAngle: 0.9 * DEG,
  decay: 2.4,
}

/**
 * The gunner's eye: placed at the weapon's sight on the ship's live pose (heave, pitch and roll come through, so the
 * sea is felt), looking along the gunner's aim, with the ship's up (the horizon rolls with the deck). Shakes with
 * trauma². Output like the flight camera: eye, forward, up, fov and viewProj (reversed Z).
 */
export class TurretCam {
  readonly eye: Vec3 = [0, 0, 0]
  readonly forward: Vec3 = [0, 0, -1]
  readonly up: Vec3 = [0, 1, 0]
  fov = TURRET_CAM.fov
  /** Recoil shake (the host adds; it drains linearly in `place`). */
  readonly shake = new TraumaShake(SHAKE)
  readonly viewProj = new Float32Array(16)
  readonly viewProj64 = new Float64Array(16)
  private view = new Float64Array(16)
  private proj = new Float64Array(16)
  private target = new Float64Array(3)
  private upv = new Float64Array(3)
  private eyev = new Float64Array(3)

  /** Places the camera: sight (world), aim (unit, world), the ship's up (world), zoom 0..1 toward `scopeFov`. */
  place(dt: number, eye: Vec3, aim: Vec3, up: Vec3, zoomFov: number, aspect: number): void {
    this.shake.tick(dt)
    this.fov += (zoomFov - this.fov) * (1 - Math.exp(-dt / TURRET_CAM.zoomLag))
    this.shake.drain(dt, TURRET_CAM.decay)
    const s = this.shake.intensity()
    const n = (k: number) => shakeWave(this.shake.time, 31 + k * 7.3, k * 1.7, 53 + k * 3.1, k)
    for (let i = 0; i < 3; i++) this.eye[i] = eye[i]! + n(i) * TURRET_CAM.shake * s
    const wob = TURRET_CAM.shakeAngle * s
    this.forward[0] = aim[0] + n(4) * wob
    this.forward[1] = aim[1] + n(5) * wob
    this.forward[2] = aim[2] + n(6) * wob
    const l = Math.hypot(this.forward[0], this.forward[1], this.forward[2]) || 1
    for (let i = 0; i < 3; i++) this.forward[i] = this.forward[i]! / l
    this.up[0] = up[0]
    this.up[1] = up[1]
    this.up[2] = up[2]
    this.compute(aspect)
  }

  compute(aspect: number): void {
    this.eyev.set(this.eye)
    this.target[0] = this.eye[0] + this.forward[0]
    this.target[1] = this.eye[1] + this.forward[1]
    this.target[2] = this.eye[2] + this.forward[2]
    this.upv.set(this.up)
    mat4d.lookAt(this.eyev, this.target, this.upv, this.view)
    mat4d.perspectiveReverseZ(this.fov, aspect, NEAR, FAR, this.proj)
    mat4d.multiply(this.proj, this.view, this.viewProj64)
    this.viewProj.set(this.viewProj64)
  }

  /** World point to CSS pixels in a w × h viewport (null behind the camera). */
  project(x: number, y: number, z: number, w: number, h: number): { x: number; y: number } | null {
    const m = this.viewProj64
    const cw = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!
    if (cw <= 0) return null
    const cx = (m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) / cw
    const cy = (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) / cw
    return { x: (cx * 0.5 + 0.5) * w, y: (0.5 - cy * 0.5) * h }
  }
}
