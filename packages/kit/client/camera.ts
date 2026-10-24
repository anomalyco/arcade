import { mat4, vec4 } from "wgpu-matrix"
import type { LabControl } from "../lab-panel"
import { hash2 } from "../sim/rng"

export const cameraShakeDefaults = () => ({
  shakeScale: 1,
  kickScale: 1,
  damageFlashScale: 1,
  shakeDecay: 2.8,
  shakeFrequency: 26,
  maxShakeOffset: 0.28,
  maxShakeRoll: 0.032,
  maxKickOffset: 0.6,
  reduceMotion: 0,
})

export type CameraShakeSettings = ReturnType<typeof cameraShakeDefaults>

export const cameraShakeControls: readonly LabControl[] = [
  { key: "shakeScale", label: "Camera shake", group: "Camera", min: 0, max: 2, step: 0.05, unit: "×" },
  { key: "kickScale", label: "Directional kick", group: "Camera", min: 0, max: 2, step: 0.05, unit: "×" },
  { key: "damageFlashScale", label: "Damage flash", group: "Camera", min: 0, max: 2, step: 0.05, unit: "×" },
  { key: "shakeDecay", label: "Trauma decay", group: "Camera", min: 0.5, max: 8, step: 0.1, unit: "/s" },
  { key: "shakeFrequency", label: "Shake frequency", group: "Camera", min: 6, max: 50, step: 1, unit: "Hz" },
  { key: "maxShakeOffset", label: "Max shake offset", group: "Camera", min: 0, max: 0.8, step: 0.02, unit: "m" },
  { key: "maxShakeRoll", label: "Max shake roll", group: "Camera", min: 0, max: 0.08, step: 0.002, unit: "rad" },
  {
    key: "reduceMotion",
    label: "Reduce motion",
    group: "Camera",
    options: [
      { label: "Off", value: 0 },
      { label: "On", value: 1 },
    ],
  },
]

/** Continuous 1D gradient noise in `[-1, 1]` with quintic C² fade (`6f⁵ - 15f⁴ + 10f³`). */
export function smoothNoise1D(t: number, seed: number): number {
  const i = Math.floor(t)
  const f = t - i
  const u = f * f * f * (f * (f * 6 - 15) + 10)
  const v0 = hash2(i, seed) * 2 - 1
  const v1 = hash2(i + 1, seed) * 2 - 1
  const g0 = (hash2(i + 7919, seed) * 2 - 1) * f
  const g1 = (hash2(i + 7920, seed) * 2 - 1) * (f - 1)
  const val = v0 + (v1 - v0) * u + (g0 + (g1 - g0) * u) * 0.45
  return Math.max(-1, Math.min(1, val))
}

/** Quadratic distance falloff `(1 - dist / radius)²` in `[0, 1]`, `0` beyond `radius`. */
export function attenuateShake(dist: number, radius: number): number {
  if (radius <= 0 || dist >= radius) return 0
  if (dist <= 0) return 1
  const u = 1 - dist / radius
  return u * u
}

/** Converts a plan-space angle (`0` = +X, `pi/2` = +Z) and magnitude into a `(dx, dz)` kick vector. */
export function kickVector(dir: number, amount: number): [number, number] {
  return [Math.cos(dir) * amount, Math.sin(dir) * amount]
}

/** Queries the OS/browser `prefers-reduced-motion: reduce` media query when available. */
export function prefersReducedMotion(): boolean {
  try {
    if (typeof globalThis.matchMedia === "function") {
      return Boolean(globalThis.matchMedia("(prefers-reduced-motion: reduce)")?.matches)
    }
  } catch {}
  return false
}

/**
 * Two incommensurate sines weighted 0.6/0.4, in `[-1, 1]`: a cheap shake wave that never loops visibly. Without a
 * second frequency it is the plain sine `sin(t·f1 + p1)`.
 */
export function shakeWave(t: number, f1: number, p1 = 0, f2?: number, p2 = 0): number {
  if (f2 === undefined) return Math.sin(t * f1 + p1)
  return Math.sin(t * f1 + p1) * 0.6 + Math.sin(t * f2 + p2) * 0.4
}

/**
 * Trauma² shake for any camera rig (chase, orbit, first person), the rig-independent part of `Camera`'s shake. Hosts
 * `add` or `raise` trauma in `[0, 1]` and decay it (`decay` exponential, `drain` linear); the rig `tick`s the clock,
 * reads `intensity()` (trauma² × `shakeScale`, 0 under reduced motion) and offsets its own eye and aim by
 * `intensity × shakeWave(time, …) × its own metres/radians`. Presentation only.
 */
export class TraumaShake {
  trauma = 0
  /** Shake clock in seconds, advanced by `tick`. */
  time = 0

  constructor(readonly settings: Pick<CameraShakeSettings, "shakeScale" | "reduceMotion"> = cameraShakeDefaults()) {}

  get reduced(): boolean {
    return Boolean(this.settings.reduceMotion) || prefersReducedMotion()
  }

  /** Adds `amount`, never past `cap` (a light, repeated source caps low). */
  add(amount: number, cap = 1): void {
    this.trauma = Math.min(cap, this.trauma + amount)
  }

  /** At least `amount` (clamped to 1). */
  raise(amount: number): void {
    this.trauma = Math.max(this.trauma, Math.min(1, amount))
  }

  /** Exponential decay at `rate` per second, never below `floor` (a sustained source such as a buffet). */
  decay(dt: number, rate: number, floor = 0): void {
    this.trauma = Math.max(this.trauma * Math.exp(-dt * rate), floor)
  }

  /** Linear decay of `rate` per second. */
  drain(dt: number, rate: number): void {
    this.trauma = Math.max(0, this.trauma - rate * dt)
  }

  tick(dt: number): void {
    this.time += dt
  }

  /** trauma² × `shakeScale` of the larger of the held trauma and `extra` (a per-frame source), 0 under reduced motion. */
  intensity(extra = 0): number {
    if (this.reduced) return 0
    const t = Math.min(1, Math.max(this.trauma, extra))
    return t * t * Math.max(0, this.settings.shakeScale)
  }

  reset(): void {
    this.trauma = 0
  }
}

/** Trivial presentation-only hit-stop timer. Scales visual `dt` without altering simulation ticks. */
export class HitStop {
  remaining = 0
  scale = 0.08

  trigger(duration: number, timeScale = 0.08, enabled = true): void {
    if (!enabled || duration <= 0) return
    if (duration >= this.remaining) {
      this.remaining = Math.min(0.12, duration)
      this.scale = Math.max(0, Math.min(1, timeScale))
    }
  }

  step(dt: number, enabled = true): number {
    if (!enabled || this.remaining <= 0 || dt <= 0) {
      this.remaining = 0
      return dt
    }
    if (dt <= this.remaining) {
      this.remaining -= dt
      return dt * this.scale
    }
    const frozen = this.remaining
    const rest = dt - frozen
    this.remaining = 0
    return frozen * this.scale + rest
  }

  reset(): void {
    this.remaining = 0
  }
}

/**
 * Fixed, mostly top-down camera. North (plan -y, world -z) is always up the screen and it never rotates, so WASD is
 * always map-relative. The plan (x, y) maps to world (x, z) with y up.
 */
export class Camera {
  pitch = 1.1
  /** Vertical field of view (rad) and near plane (m); a low chase view wants a wider lens and a nearer plane. */
  fov = 0.52
  near = 2
  x = 0
  z = 0
  dist = 24
  traumaSquared = true
  zoomOffset = 0
  /** Orbit around the target (radians): 0 looks north from the south, the top-down default every game uses. */
  yaw = 0
  /** Height of the look-at point above the ground; raise it for a chase or over-the-shoulder view. */
  lookHeight = 0
  readonly shakeSettings: CameraShakeSettings
  private lx = 0
  private lz = 0
  private shake = 0
  private impactShake = 0
  private flash = 0
  /** Recoil push: a spring offset on the ground plane. */
  private kx = 0
  private kz = 0
  private kvx = 0
  private kvz = 0
  /** Recoil punch: a zoom-out and a roll, both springing back. */
  private zoom = 0
  private zv = 0
  private rollA = 0
  private rv = 0
  private t = 0
  private lastOffset = { x: 0, z: 0, zoom: 0, roll: 0 }
  eye: [number, number, number] = [0, 0, 0]
  viewProj = mat4.identity()

  constructor(shakeSettings: CameraShakeSettings = cameraShakeDefaults()) {
    this.shakeSettings = shakeSettings
  }

  isReducedMotion(): boolean {
    return Boolean(this.shakeSettings.reduceMotion) || prefersReducedMotion()
  }

  get trauma(): number {
    return this.shake
  }

  get offset(): { readonly x: number; readonly z: number; readonly zoom: number; readonly roll: number } {
    return this.lastOffset
  }

  /** Post-process damage vignette flash intensity in `[0, 1]`, ready for `grade[2]`. */
  get damageFlash(): number {
    return Math.max(0, Math.min(1, this.flash * Math.max(0, this.shakeSettings.damageFlashScale)))
  }

  snap(x: number, z: number): void {
    this.x = x
    this.z = z
  }

  resetShake(): void {
    this.shake = 0
    this.impactShake = 0
    this.flash = 0
    this.kx = 0
    this.kz = 0
    this.kvx = 0
    this.kvz = 0
    this.zoom = 0
    this.zv = 0
    this.rollA = 0
    this.rv = 0
    this.lastOffset.x = 0
    this.lastOffset.z = 0
    this.lastOffset.zoom = 0
    this.lastOffset.roll = 0
  }

  /**
   * Adds trauma in `[0, 1]` and optionally shoves the camera along `dir` (radians).
   */
  add(trauma: number, dir?: number, kick?: number): void {
    if (this.isReducedMotion()) return
    const scale = Math.max(0, this.shakeSettings.shakeScale)
    if (trauma > 0 && scale > 0) {
      this.shake = Math.min(1, this.shake + trauma * Math.min(1.5, scale))
    }
    if (dir !== undefined) {
      const kAmt = kick ?? Math.max(0, trauma) * 2.2
      if (kAmt !== 0) this.kickAngle(dir, kAmt)
    }
  }

  bump(amount: number): void {
    this.add(amount)
  }

  /** Adds a decaying crimson edge-vignette flash in `[0, 1]` for the post shader's `G.z`. */
  addFlash(amount: number): void {
    if (amount <= 0 || this.shakeSettings.damageFlashScale <= 0) return
    this.flash = Math.min(1, this.flash + amount)
  }

  /** Shoves the view on a vehicle collision, springing back. */
  impact(speed: number): void {
    if (speed < 4 || this.isReducedMotion()) return
    const k = Math.min(1, (speed - 3) / 12)
    this.impactShake = Math.min(1, this.impactShake + k * Math.max(0, this.shakeSettings.shakeScale))
    this.punch(0.85 * k, 0.008 * k)
  }

  /** Shoves the view along `(dx, dz)`, springing back. */
  kick(dx: number, dz: number, amount: number): void {
    if (this.isReducedMotion()) return
    const s = Math.max(0, this.shakeSettings.kickScale) * Math.max(0, this.shakeSettings.shakeScale)
    this.kvx += dx * amount * s
    this.kvz += dz * amount * s
  }

  /** Shoves the view along angle `dir` (radians) on the ground plane, springing back. */
  kickAngle(dir: number, amount: number): void {
    this.kick(Math.cos(dir), Math.sin(dir), amount)
  }

  /** A gunshot or impact punch: pushes the view out by `amount` metres and rolls it by `rollBy` radians. */
  punch(amount: number, rollBy = 0): void {
    if (this.isReducedMotion()) return
    const s = Math.max(0, this.shakeSettings.kickScale) * Math.max(0, this.shakeSettings.shakeScale)
    this.zv += amount * 40 * s
    this.rv += rollBy * 40 * s
  }

  killPunch(): void {
    if (this.isReducedMotion()) return
    const s = Math.max(0, this.shakeSettings.kickScale) * Math.max(0, this.shakeSettings.shakeScale)
    this.zoom = -0.35 * s
    this.zv = 0
  }

  /** Follows a point, leaning slightly toward where you aim; pulled back a little in a vehicle (`ride`). */
  follow(x: number, z: number, aimX: number, aimZ: number, dt: number, wide: boolean, ride = false): void {
    this.t += dt
    const k = 1 - Math.exp(-dt * 3.5)
    this.lx += (aimX - this.lx) * k
    this.lz += (aimZ - this.lz) * k
    const f = 1 - Math.exp(-dt * 6)
    this.x += (x + this.lx - this.x) * f
    this.z += (z + this.lz - this.z) * f
    const want = (wide ? 42 : ride ? 31 : 24) + this.zoomOffset
    this.dist += (want - this.dist) * (1 - Math.exp(-dt * 2))
    this.flash *= Math.exp(-dt * 5.5)
    if (this.flash < 1e-3) this.flash = 0

    if (this.isReducedMotion()) {
      this.shake = 0
      this.impactShake = 0
      this.kx = 0
      this.kz = 0
      this.kvx = 0
      this.kvz = 0
      this.zoom = 0
      this.zv = 0
      this.rollA = 0
      this.rv = 0
      return
    }

    const decay = Math.max(0.2, this.shakeSettings.shakeDecay)
    this.shake = Math.max(0, this.shake - dt * decay * 0.45) * Math.exp(-dt * decay * 2.2)
    if (this.shake < 1e-4) this.shake = 0
    this.impactShake *= Math.exp(-dt * 9)
    if (this.impactShake < 1e-4) this.impactShake = 0

    // Critically damped spring back to centre; substepped so a long frame can't make it diverge.
    const kSpring = 220
    const damp = 2 * Math.sqrt(kSpring)
    const n = Math.max(1, Math.ceil(dt / (1 / 240)))
    const h = dt / n
    for (let i = 0; i < n; i++) {
      this.kvx += (-kSpring * this.kx - damp * this.kvx) * h
      this.kvz += (-kSpring * this.kz - damp * this.kvz) * h
      this.kx += this.kvx * h
      this.kz += this.kvz * h
      this.zv += (-400 * this.zoom - 26 * this.zv) * h
      this.zoom += this.zv * h
      this.rv += (-500 * this.rollA - 30 * this.rv) * h
      this.rollA += this.rv * h
    }
    // Never let a burst of kicks carry the view off: clamp the offsets.
    const maxKick = Math.max(0, this.shakeSettings.maxKickOffset)
    const kl = Math.hypot(this.kx, this.kz)
    if (kl > maxKick) {
      const ratio = maxKick > 0 ? maxKick / kl : 0
      this.kx *= ratio
      this.kz *= ratio
    }
    this.zoom = Math.max(-1, Math.min(2.5, this.zoom))
    this.rollA = Math.max(-0.05, Math.min(0.05, this.rollA))
  }

  update(aspect: number): Float32Array {
    const reduced = this.isReducedMotion()
    const scale = reduced ? 0 : Math.max(0, this.shakeSettings.shakeScale)
    const s =
      ((this.traumaSquared ? this.shake * this.shake : this.shake) + this.impactShake * this.impactShake) * scale
    const freq = Math.max(1, this.shakeSettings.shakeFrequency)
    const phase = this.t * freq
    const nx = smoothNoise1D(phase, 101) + 0.35 * smoothNoise1D(phase * 2.17, 211)
    const nz = smoothNoise1D(phase * 1.07, 307) + 0.35 * smoothNoise1D(phase * 2.31, 401)
    const nr = smoothNoise1D(phase * 0.89, 503)
    const maxOff = Math.max(0, this.shakeSettings.maxShakeOffset)
    const maxRoll = Math.max(0, this.shakeSettings.maxShakeRoll)
    const shakeX = Math.max(-maxOff, Math.min(maxOff, s * nx * maxOff))
    const shakeZ = Math.max(-maxOff, Math.min(maxOff, s * nz * maxOff))
    const shakeRoll = Math.max(-maxRoll, Math.min(maxRoll, s * nr * maxRoll))

    const jx = reduced ? 0 : shakeX + this.kx
    const jz = reduced ? 0 : shakeZ + this.kz
    const zoom = reduced ? 0 : this.zoom
    const roll = reduced ? 0 : this.rollA + shakeRoll

    this.lastOffset.x = jx
    this.lastOffset.z = jz
    this.lastOffset.zoom = zoom
    this.lastOffset.roll = roll

    const target = [this.x + jx, this.lookHeight, this.z + jz]
    const dist = this.dist + zoom
    const h = Math.cos(this.pitch) * dist
    const sy = Math.sin(this.yaw)
    const cy = Math.cos(this.yaw)
    this.eye = [target[0]! + sy * h, this.lookHeight + Math.sin(this.pitch) * dist, target[2]! + cy * h]
    const view = mat4.lookAt(this.eye, target, [Math.sin(roll) * cy, Math.cos(roll), -Math.sin(roll) * sy])
    const proj = mat4.perspective(this.fov, aspect, this.near, 400)
    this.viewProj = mat4.multiply(proj, view)
    return this.viewProj as Float32Array
  }

  /** Plan-space bounds of what the screen shows between the floor and the wall tops, from the last update. */
  groundRect(top = 2.8): [number, number, number, number] {
    const inv = mat4.inverse(this.viewProj)
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const nx of [-1, 1])
      for (const ny of [-1, 1]) {
        const a = vec4.transformMat4([nx, ny, 0, 1], inv)
        const b = vec4.transformMat4([nx, ny, 1, 1], inv)
        for (const h of [0, top]) {
          const ay = a[1]! / a[3]!
          const by = b[1]! / b[3]!
          const t = (h - ay) / (by - ay || 1e-6)
          const x = a[0]! / a[3]! + (b[0]! / b[3]! - a[0]! / a[3]!) * t
          const z = a[2]! / a[3]! + (b[2]! / b[3]! - a[2]! / a[3]!) * t
          x0 = Math.min(x0, x)
          x1 = Math.max(x1, x)
          y0 = Math.min(y0, z)
          y1 = Math.max(y1, z)
        }
      }
    return [x0, y0, x1, y1]
  }

  /** World point to CSS pixels. */
  project(x: number, y: number, z: number, w: number, h: number): { x: number; y: number; ok: boolean } {
    const p = vec4.transformMat4([x, y, z, 1], this.viewProj)
    if (p[3]! <= 0) return { x: 0, y: 0, ok: false }
    return { x: ((p[0]! / p[3]!) * 0.5 + 0.5) * w, y: (0.5 - (p[1]! / p[3]!) * 0.5) * h, ok: true }
  }

  /** CSS pixel to the floor plane at height `y`, as plan coordinates. */
  unproject(px: number, py: number, w: number, h: number, y = 0): { x: number; y: number } {
    const inv = mat4.inverse(this.viewProj)
    const nx = (px / w) * 2 - 1
    const ny = 1 - (py / h) * 2
    const a = vec4.transformMat4([nx, ny, 0, 1], inv)
    const b = vec4.transformMat4([nx, ny, 1, 1], inv)
    const ax = a[0]! / a[3]!
    const ay = a[1]! / a[3]!
    const az = a[2]! / a[3]!
    const bx = b[0]! / b[3]!
    const by = b[1]! / b[3]!
    const bz = b[2]! / b[3]!
    const t = (y - ay) / (by - ay || 1e-6)
    return { x: ax + (bx - ax) * t, y: az + (bz - az) * t }
  }
}
