import { mat4 } from "wgpu-matrix"
import { type CameraShakeSettings, cameraShakeDefaults, prefersReducedMotion, smoothNoise1D } from "./camera"

/**
 * Side-view camera for 2.5D games: gameplay lives on the z = 0 plane (x right, y up) and the camera looks down -z
 * through a narrow perspective, so layers behind the plane parallax naturally. `frame()` fits a rectangle of the
 * plane to the viewport ("contain"); trauma-squared shake, directional kicks and a zoom punch sit on top, shared
 * with the top-down `Camera`'s settings and reduced-motion rule.
 */
export class SideCamera {
  /** Vertical field of view (radians). Small values read almost orthographic. */
  fov = 0.36
  near = 1
  far = 400
  /** The plane point at the screen centre, and the plane height that fills the screen. */
  cx = 0
  cy = 0
  span = 18
  readonly shakeSettings: CameraShakeSettings
  eye: [number, number, number] = [0, 0, 0]
  viewProj = mat4.identity()
  view = mat4.identity()
  private shake = 0
  private kx = 0
  private ky = 0
  private kvx = 0
  private kvy = 0
  private punch = 0
  private pv = 0
  private t = 0
  roll = 0

  constructor(settings: CameraShakeSettings = cameraShakeDefaults()) {
    this.shakeSettings = settings
  }

  get distance(): number {
    return this.span / 2 / Math.tan(this.fov / 2)
  }

  get trauma(): number {
    return this.shake
  }

  get reduced(): boolean {
    return Boolean(this.shakeSettings.reduceMotion) || prefersReducedMotion()
  }

  /** Fit a plane rectangle (x0, y0)–(x1, y1) inside a viewport of `aspect` (w / h), with `margin` plane units. */
  frame(x0: number, y0: number, x1: number, y1: number, aspect: number, margin = 0): void {
    this.cx = (x0 + x1) / 2
    this.cy = (y0 + y1) / 2
    const w = x1 - x0 + margin * 2, h = y1 - y0 + margin * 2
    this.span = Math.max(h, w / Math.max(0.1, aspect))
  }

  /** Adds trauma (0..1), with an optional kick along (dx, dy) in plane units. */
  add(trauma: number, dx = 0, dy = 0): void {
    if (this.reduced) return
    const s = Math.max(0, this.shakeSettings.shakeScale)
    this.shake = Math.min(1, this.shake + trauma * Math.min(1.5, s))
    const k = Math.max(0, this.shakeSettings.kickScale)
    this.kvx += dx * k * 14
    this.kvy += dy * k * 14
  }

  /** A quick zoom-in that springs back (positive is closer). */
  zoomPunch(amount: number): void {
    if (this.reduced) return
    this.pv += amount * 30
  }

  resetShake(): void {
    this.shake = this.kx = this.ky = this.kvx = this.kvy = this.punch = this.pv = 0
  }

  /** Steps shake and springs, then builds `viewProj` for a viewport of `aspect`. */
  update(dt: number, aspect: number): Float32Array {
    const st = this.shakeSettings
    this.t += dt
    this.shake = Math.max(0, this.shake - dt * st.shakeDecay * 0.5)
    const spring = (x: number, v: number, k: number, z: number): [number, number] => {
      const n = Math.max(1, Math.ceil(dt / (1 / 240)))
      const h = dt / n
      for (let i = 0; i < n; i++) {
        v += (-x * k - v * 2 * Math.sqrt(k) * z) * h
        x += v * h
      }
      return [x, v]
    }
    ;[this.kx, this.kvx] = spring(this.kx, this.kvx, 260, 0.55)
    ;[this.ky, this.kvy] = spring(this.ky, this.kvy, 260, 0.55)
    ;[this.punch, this.pv] = spring(this.punch, this.pv, 220, 0.6)
    const max = st.maxKickOffset
    this.kx = Math.max(-max, Math.min(max, this.kx))
    this.ky = Math.max(-max, Math.min(max, this.ky))
    const tr = this.shake * this.shake
    const f = st.shakeFrequency
    const sx = smoothNoise1D(this.t * f, 11) * st.maxShakeOffset * tr * 2.2
    const sy = smoothNoise1D(this.t * f, 23) * st.maxShakeOffset * tr * 2.2
    const roll = smoothNoise1D(this.t * f, 37) * st.maxShakeRoll * tr + this.roll
    const px = this.cx + sx + this.kx, py = this.cy + sy + this.ky
    const d = this.distance * (1 - Math.max(-0.2, Math.min(0.2, this.punch)))
    this.eye = [px, py, d]
    const up: [number, number, number] = [Math.sin(roll), Math.cos(roll), 0]
    this.view = mat4.lookAt(this.eye, [px, py, 0], up)
    const proj = mat4.perspective(this.fov, aspect, this.near, this.far)
    this.viewProj = mat4.multiply(proj, this.view)
    return this.viewProj as Float32Array
  }

  /** Projects a world point to CSS pixels in a viewport of w × h; z is the clip depth. */
  project(x: number, y: number, z: number, w: number, h: number): { x: number; y: number; z: number } {
    const m = this.viewProj
    const cx = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!
    const cy = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!
    const cz = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!
    const cw = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!
    return { x: (cx / cw * 0.5 + 0.5) * w, y: (0.5 - cy / cw * 0.5) * h, z: cz / cw }
  }
}
