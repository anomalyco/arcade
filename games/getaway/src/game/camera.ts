import { CAMERA_YAW } from "../../shared/config"
import { mat4, vec4 } from "wgpu-matrix"

/**
 * Fixed-angle chase camera. It follows the car's position (with look-ahead along its velocity) but never
 * rotates with it, so the city keeps the same diorama orientation through every turn.
 */
export class Camera {
  readonly yaw = CAMERA_YAW
  readonly pitch = 0.93
  fov = 0.6
  fx = 0
  fz = 0
  dist = 76
  private lx = 0
  private lz = 0
  private shake = 0
  private landing = 0
  private t = 0
  private visualRush = 0
  private visualShake = 0
  private visualLanding = 0
  eye: [number, number, number] = [0, 0, 0]
  viewProj = mat4.identity()

  snap(x: number, z: number) {
    this.fx = x
    this.fz = z
    this.lx = 0
    this.lz = 0
  }

  bump(amount: number) {
    this.shake = Math.min(1.2, this.shake + amount)
  }

  land(amount: number) { this.landing = Math.max(this.landing, amount) }

  /** Local presentation layered on the synchronized camera, never sent to the other pane. */
  present(dt: number, boosting: boolean, shake: number, landing: number) {
    this.visualRush += ((boosting ? 1 : 0) - this.visualRush) * (1 - Math.exp(-dt * 9))
    this.visualShake = Math.max(this.visualShake * Math.exp(-dt * 6), shake)
    this.visualLanding = Math.max(this.visualLanding * Math.exp(-dt * 14), landing)
  }

  update(x: number, z: number, vx: number, vz: number, dt: number, zoom = 0, boosting = false) {
    this.t += dt
    const k = 1 - Math.exp(-dt * 2.2)
    this.lx += (vx * 0.35 - this.lx) * k
    this.lz += (vz * 0.35 - this.lz) * k
    const f = 1 - Math.exp(-dt * 7)
    this.fx += (x + this.lx - this.fx) * f
    this.fz += (z + this.lz - this.fz) * f
    const speed = Math.hypot(vx, vz)
    const rush = boosting
    this.fov += ((rush ? 0.65 : 0.6) - this.fov) * (1 - Math.exp(-dt * 9))
    const want = 72 + Math.min(speed, 45) * 0.4 + zoom - (rush ? 2.5 : 0)
    this.dist += (want - this.dist) * (1 - Math.exp(-dt * 1.5))
    this.shake *= Math.exp(-dt * 6)
    this.landing *= Math.exp(-dt * 14)
  }

  /** Horizontal unit vectors for the screen's right and up directions on the ground plane. */
  axes() {
    const fwd: [number, number] = [Math.sin(this.yaw), Math.cos(this.yaw)]
    const right: [number, number] = [-fwd[1], fwd[0]]
    return { fwd, right }
  }

  matrices(aspect: number) {
    const trauma = Math.max(this.shake, this.visualShake)
    const s = trauma * trauma
    const jx = s * Math.sin(this.t * 61) * 0.5
    const jz = s * Math.cos(this.t * 53) * 0.5
    const target = [this.fx + jx, 0.5 - Math.max(this.landing, this.visualLanding) * 0.9, this.fz + jz]
    const rush = this.visualRush
    const dist = this.dist - rush * 2.5
    const h = Math.cos(this.pitch) * dist
    this.eye = [target[0]! - Math.sin(this.yaw) * h, Math.sin(this.pitch) * dist, target[2]! - Math.cos(this.yaw) * h]
    const view = mat4.lookAt(this.eye, target, [0, 1, 0])
    const proj = mat4.perspective(this.fov + rush * 0.05, aspect, 5, 900)
    this.viewProj = mat4.multiply(proj, view)
    return this.viewProj
  }

  project(x: number, y: number, z: number, w: number, h: number): [number, number, boolean] {
    const p = vec4.transformMat4([x, y, z, 1], this.viewProj)
    if (p[3]! <= 0) return [0, 0, false]
    return [((p[0]! / p[3]!) * 0.5 + 0.5) * w, (0.5 - (p[1]! / p[3]!) * 0.5) * h, true]
  }
}
