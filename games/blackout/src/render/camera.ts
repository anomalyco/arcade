import { mat4, vec4 } from "wgpu-matrix"

/**
 * Fixed, mostly top-down camera. North (plan -y, world -z) is always up the screen and it never rotates, so WASD is
 * always map-relative. The plan (x, y) maps to world (x, z) with y up.
 */
export class Camera {
  readonly pitch = 1.1
  readonly fov = 0.52
  x = 0
  z = 0
  dist = 24
  private lx = 0
  private lz = 0
  private shake = 0
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
  eye: [number, number, number] = [0, 0, 0]
  viewProj = mat4.identity()

  snap(x: number, z: number): void {
    this.x = x
    this.z = z
  }

  bump(amount: number): void {
    this.shake = Math.min(1, this.shake + amount)
  }

  /** Shoves the view along (dx, dz), springing back. */
  kick(dx: number, dz: number, amount: number): void {
    this.kvx += dx * amount
    this.kvz += dz * amount
  }

  /** A gunshot's punch: pushes the view out by `amount` metres and rolls it by `rollBy` radians. */
  punch(amount: number, rollBy: number): void {
    this.zv += amount * 40
    this.rv += rollBy * 40
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
    const want = wide ? 42 : ride ? 31 : 24
    this.dist += (want - this.dist) * (1 - Math.exp(-dt * 2))
    this.shake *= Math.exp(-dt * 9)
    // Critically damped spring back to centre; substepped so a long frame can't make it diverge.
    const kSpring = 220
    const damp = 2 * Math.sqrt(kSpring)
    const n = Math.ceil(dt / (1 / 240))
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
    const kl = Math.hypot(this.kx, this.kz)
    if (kl > 0.6) {
      this.kx *= 0.6 / kl
      this.kz *= 0.6 / kl
    }
    this.zoom = Math.max(-1, Math.min(2.5, this.zoom))
    this.rollA = Math.max(-0.05, Math.min(0.05, this.rollA))
  }

  update(aspect: number): Float32Array {
    const s = this.shake
    const jx = s * (Math.sin(this.t * 71) + Math.sin(this.t * 43) * 0.5) * 0.12 + this.kx
    const jz = s * (Math.cos(this.t * 59) + Math.cos(this.t * 37) * 0.5) * 0.12 + this.kz
    const target = [this.x + jx, 0, this.z + jz]
    const dist = this.dist + this.zoom
    const h = Math.cos(this.pitch) * dist
    this.eye = [target[0]!, Math.sin(this.pitch) * dist, target[2]! + h]
    const view = mat4.lookAt(this.eye, target, [Math.sin(this.rollA), Math.cos(this.rollA), 0])
    const proj = mat4.perspective(this.fov, aspect, 2, 400)
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
