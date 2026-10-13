import { mat4d } from "wgpu-matrix"

const DEG = Math.PI / 180
export const NEAR = 1
export const FAR = 40_000
export const MIN_PITCH = 8 * DEG
export const MAX_PITCH = 85 * DEG
export const MIN_DIST = 60
export const MAX_DIST = 4000
/** Vertical field of view. */
export const FOV = 50 * DEG
/** Default view, like concept shot-5: looking north over the swell with the horizon and sky in the top fifth. */
export const DEFAULT_VIEW = { x: 0, z: 0, yaw: 0, pitch: 24 * DEG, dist: 650 }
/**
 * The focus sits this far below the screen centre (NDC y = -0.3, about two thirds down), so the horizon stays in view
 * at shallow pitches and a ship at the focus later sits in the lower middle like the concepts.
 */
const LIFT = Math.atan(0.3 * Math.tan(FOV / 2))

/** Slab of heights that static geometry can occupy, for culling: seabed to the highest peaks. */
export const STATIC_Y0 = -80
export const STATIC_Y1 = 600

/** Reads `?cam=x,z,yaw,pitch,dist` (yaw and pitch in degrees; yaw 0 looks north, 90 east). */
export function parseCam(s: string | null): { x: number; z: number; yaw: number; pitch: number; dist: number } | null {
  if (!s) return null
  const v = s.split(",").map(Number)
  if (v.length < 2 || v.some((n) => !Number.isFinite(n))) return null
  return {
    x: v[0]!,
    z: v[1]!,
    yaw: v[2] === undefined ? DEFAULT_VIEW.yaw : v[2] * DEG,
    pitch: v[3] === undefined ? DEFAULT_VIEW.pitch : v[3] * DEG,
    dist: v[4] ?? DEFAULT_VIEW.dist,
  }
}

const inv = new Float64Array(16)
const corners = new Float64Array(24)
/**
 * Plan bounds [x0, z0, x1, z1] of the part of the view frustum between heights y0 and y1: the frustum's corners
 * and edges clipped to the slab. Works for any pitch, including views that see the sky. Allocation free.
 */
export function frustumGroundRect(viewProj: Float32Array | Float64Array, y0: number, y1: number, out: [number, number, number, number]): [number, number, number, number] {
  mat4d.inverse(viewProj, inv)
  for (let i = 0; i < 8; i++) {
    const nx = i & 1 ? 1 : -1
    const ny = i & 2 ? 1 : -1
    const nz = i & 4 ? 1 : 0
    const w = inv[3]! * nx + inv[7]! * ny + inv[11]! * nz + inv[15]!
    corners[i * 3] = (inv[0]! * nx + inv[4]! * ny + inv[8]! * nz + inv[12]!) / w
    corners[i * 3 + 1] = (inv[1]! * nx + inv[5]! * ny + inv[9]! * nz + inv[13]!) / w
    corners[i * 3 + 2] = (inv[2]! * nx + inv[6]! * ny + inv[10]! * nz + inv[14]!) / w
  }
  let x0 = Infinity
  let z0 = Infinity
  let x1 = -Infinity
  let z1 = -Infinity
  for (let a = 0; a < 8; a++)
    for (let bit = 1; bit < 8; bit <<= 1) {
      if (a & bit) continue
      const b = a | bit
      const ay = corners[a * 3 + 1]!
      const by = corners[b * 3 + 1]!
      let t0 = 0
      let t1 = 1
      if (ay === by) {
        if (ay < y0 || ay > y1) continue
      } else {
        const ta = (y0 - ay) / (by - ay)
        const tb = (y1 - ay) / (by - ay)
        t0 = Math.max(0, Math.min(ta, tb))
        t1 = Math.min(1, Math.max(ta, tb))
        if (t0 > t1) continue
      }
      const ax = corners[a * 3]!
      const az = corners[a * 3 + 2]!
      const dx = corners[b * 3]! - ax
      const dz = corners[b * 3 + 2]! - az
      for (let k = 0; k < 2; k++) {
        const t = k ? t1 : t0
        const x = ax + dx * t
        const z = az + dz * t
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (z < z0) z0 = z
        if (z > z1) z1 = z
      }
    }
  out[0] = x0
  out[1] = z0
  out[2] = x1
  out[3] = z1
  return out
}

/**
 * Orbit camera around a focus point on the sea. Yaw 0 looks north (-z), pitch is the eye's elevation seen from the
 * focus. Perspective with reversed Z (near → depth 1, far → depth 0).
 */
export class Camera {
  x = DEFAULT_VIEW.x
  z = DEFAULT_VIEW.z
  yaw = DEFAULT_VIEW.yaw
  pitch = DEFAULT_VIEW.pitch
  dist = DEFAULT_VIEW.dist
  /** Height of the focus point (the chase camera follows the ship's heave). */
  y = 0
  /** Where the wheel is taking `dist`; dist eases toward it. */
  targetDist = DEFAULT_VIEW.dist
  readonly eye: [number, number, number] = [0, 0, 0]
  readonly forward: [number, number, number] = [0, 0, -1]
  readonly viewProj = new Float32Array(16)
  /** Up vector and vertical field of view of the last view built: world up and FOV except in `lookAlong`. */
  readonly upDir: [number, number, number] = [0, 1, 0]
  fov = FOV
  private view = new Float64Array(16)
  private proj = new Float64Array(16)
  private vp = new Float64Array(16)
  private target = new Float64Array(3)
  private up = new Float64Array([0, 1, 0])
  private rect: [number, number, number, number] = [0, 0, 0, 0]

  set(v: { x: number; z: number; yaw: number; pitch: number; dist: number }): void {
    this.x = v.x
    this.z = v.z
    this.yaw = v.yaw
    this.pitch = Math.max(MIN_PITCH, Math.min(MAX_PITCH, v.pitch))
    this.dist = this.targetDist = Math.max(MIN_DIST, Math.min(MAX_DIST, v.dist))
  }

  /** Mouse drag in CSS pixels. */
  orbit(dx: number, dy: number): void {
    this.yaw -= dx * 0.005
    this.pitch = Math.max(MIN_PITCH, Math.min(MAX_PITCH, this.pitch + dy * 0.004))
  }

  /** Wheel delta (pixels): zooms multiplicatively. */
  zoom(delta: number): void {
    this.targetDist = Math.max(MIN_DIST, Math.min(MAX_DIST, this.targetDist * Math.exp(delta * 0.0012)))
  }

  /** Pans the focus by (right, forward) in [-1, 1] relative to yaw, at a speed that scales with distance. */
  update(dt: number, right: number, ahead: number, fast: boolean, aspect: number): void {
    const len = Math.hypot(right, ahead)
    if (len > 0) {
      const speed = (this.dist * 0.9 * (fast ? 3 : 1) * dt) / Math.max(1, len)
      const s = Math.sin(this.yaw)
      const c = Math.cos(this.yaw)
      this.x += (s * ahead + c * right) * speed
      this.z += (-c * ahead + s * right) * speed
    }
    this.dist += (this.targetDist - this.dist) * (1 - Math.exp(-dt * 8))
    this.compute(aspect)
  }

  /** Rebuilds the eye, forward and viewProj from the current state. */
  compute(aspect: number): void {
    const s = Math.sin(this.yaw)
    const c = Math.cos(this.yaw)
    const cp = Math.cos(this.pitch)
    this.eye[0] = this.x - s * cp * this.dist
    this.eye[1] = this.y + Math.sin(this.pitch) * this.dist
    this.eye[2] = this.z + c * cp * this.dist
    const look = this.pitch - LIFT
    this.forward[0] = s * Math.cos(look)
    this.forward[1] = -Math.sin(look)
    this.forward[2] = -c * Math.cos(look)
    this.level()
    this.build(aspect)
  }

  /**
   * Any view: eye, forward and up vectors (unit), and a vertical field of view (the flight cameras roll and zoom). The
   * orbit focus moves to the eye, so the free orbit starts around here.
   */
  lookAlong(eye: ArrayLike<number>, forward: ArrayLike<number>, up: ArrayLike<number>, fov: number, aspect: number): void {
    for (let i = 0; i < 3; i++) {
      this.eye[i] = eye[i]!
      this.forward[i] = forward[i]!
      this.upDir[i] = up[i]!
      this.up[i] = up[i]!
    }
    this.x = eye[0]!
    this.y = eye[1]!
    this.z = eye[2]!
    this.yaw = Math.atan2(forward[0]!, -forward[2]!)
    this.fov = fov
    this.build(aspect)
  }

  private level(): void {
    this.upDir[0] = this.upDir[2] = 0
    this.upDir[1] = 1
    this.up[0] = this.up[2] = 0
    this.up[1] = 1
    this.fov = FOV
  }

  private build(aspect: number): void {
    this.target[0] = this.eye[0] + this.forward[0]
    this.target[1] = this.eye[1] + this.forward[1]
    this.target[2] = this.eye[2] + this.forward[2]
    mat4d.lookAt(this.eye, this.target, this.up, this.view)
    mat4d.perspectiveReverseZ(this.fov, aspect, NEAR, FAR, this.proj)
    mat4d.multiply(this.proj, this.view, this.vp)
    this.viewProj.set(this.vp)
  }

  /** Plan bounds of the view between the seabed and the peaks, from the last update. Reuses one array. */
  groundRect(y0 = STATIC_Y0, y1 = STATIC_Y1): [number, number, number, number] {
    return frustumGroundRect(this.vp, y0, y1, this.rect)
  }

  /** World point to CSS pixels in a w x h viewport. */
  project(x: number, y: number, z: number, w: number, h: number): { x: number; y: number; ok: boolean } {
    const m = this.vp
    const cw = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!
    if (cw <= 0) return { x: 0, y: 0, ok: false }
    const cx = (m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) / cw
    const cy = (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) / cw
    return { x: (cx * 0.5 + 0.5) * w, y: (0.5 - cy * 0.5) * h, ok: true }
  }
}
