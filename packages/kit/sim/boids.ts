import { mulberry32 } from "./rng"

/**
 * A small flock that follows a moving anchor (Reynolds boids: cohesion toward the anchor, separation from neighbours,
 * alignment with the anchor's velocity, plus a little wander), in 3D with y up. Presentation only: the authoritative
 * swarm is one entity (`sim/abilities` swarm); clients flock its members around it. Deterministic per seed.
 */
export class Flock {
  readonly x: Float32Array
  readonly y: Float32Array
  readonly z: Float32Array
  readonly vx: Float32Array
  readonly vy: Float32Array
  readonly vz: Float32Array
  private readonly phase: Float32Array
  private t = 0

  constructor(readonly size: number, seed: number, ax: number, ay: number, az: number, spread = 0.6) {
    const r = mulberry32(seed)
    this.x = new Float32Array(size)
    this.y = new Float32Array(size)
    this.z = new Float32Array(size)
    this.vx = new Float32Array(size)
    this.vy = new Float32Array(size)
    this.vz = new Float32Array(size)
    this.phase = new Float32Array(size)
    for (let i = 0; i < size; i++) {
      this.x[i] = ax + (r() - 0.5) * spread
      this.y[i] = ay + (r() - 0.5) * spread * 0.5
      this.z[i] = az + (r() - 0.5) * spread
      this.phase[i] = r() * Math.PI * 2
    }
  }

  /**
   * Steps `active` members toward the anchor (ax, ay, az) moving at (avx, avz). `radius` is how loose the cloud is;
   * `scatter` (0..1) weakens cohesion and adds outward speed, for a swarm breaking up.
   */
  step(dt: number, active: number, ax: number, ay: number, az: number, avx: number, avz: number, radius: number, scatter = 0): void {
    this.t += dt
    const n = Math.min(active, this.size)
    const cohesion = 9 * (1 - scatter * 0.9)
    for (let i = 0; i < n; i++) {
      const ph = this.phase[i]!
      // Each member orbits its own wandering point on the anchor's sphere.
      const ox = Math.sin(this.t * 3.1 + ph) * radius
      const oy = Math.sin(this.t * 4.7 + ph * 1.7) * radius * 0.35
      const oz = Math.cos(this.t * 2.6 + ph * 0.6) * radius
      let fx = (ax + ox - this.x[i]!) * cohesion + (avx - this.vx[i]!) * 2
      let fy = (ay + oy - this.y[i]!) * cohesion
      let fz = (az + oz - this.z[i]!) * cohesion + (avz - this.vz[i]!) * 2
      for (let j = 0; j < n; j++) {
        if (j === i) continue
        const dx = this.x[i]! - this.x[j]!, dy = this.y[i]! - this.y[j]!, dz = this.z[i]! - this.z[j]!
        const d2 = dx * dx + dy * dy + dz * dz
        if (d2 > 0.04 || d2 < 1e-6) continue
        const k = 2 / d2
        fx += dx * k
        fy += dy * k
        fz += dz * k
      }
      if (scatter > 0) {
        fx += (this.x[i]! - ax) * scatter * 12
        fz += (this.z[i]! - az) * scatter * 12
        fy += scatter * 4
      }
      this.vx[i] = this.vx[i]! + fx * dt
      this.vy[i] = this.vy[i]! + fy * dt
      this.vz[i] = this.vz[i]! + fz * dt
      const sp = Math.hypot(this.vx[i]!, this.vy[i]!, this.vz[i]!)
      const max = 12
      if (sp > max) {
        this.vx[i] = (this.vx[i]! / sp) * max
        this.vy[i] = (this.vy[i]! / sp) * max
        this.vz[i] = (this.vz[i]! / sp) * max
      }
      this.x[i] = this.x[i]! + this.vx[i]! * dt
      this.y[i] = Math.max(0.15, this.y[i]! + this.vy[i]! * dt)
      this.z[i] = this.z[i]! + this.vz[i]! * dt
    }
  }
}
