/** Fixed storage for wheel smoke. No particle objects or scratch arrays per frame. */
export const SMOKE_CAPACITY = 768
export const SMOKE_STRIDE = 8
export type SmokeSource = { smokeDistance: number; smokeX: number; smokeZ: number; smokeActive: boolean; idle: number }
export class SmokeTrail {
  readonly particles = new Float32Array(SMOKE_CAPACITY * SMOKE_STRIDE)
  readonly instances = new Float32Array(SMOKE_CAPACITY * SMOKE_STRIDE)
  count = 0
  drawn = 0
  time = 0
  private sequence = 0
  private windX = 0.35
  private windZ = -0.16

  reset() { this.count = this.drawn = this.time = this.sequence = 0 }

  seedWind(seed: number) {
    const angle = ((Math.imul(seed, 16807) >>> 0) % 997) / 997 * Math.PI * 2
    this.windX = Math.cos(angle) * 0.45; this.windZ = Math.sin(angle) * 0.45
  }

  follow(source: SmokeSource, x: number, z: number, vx: number, vz: number, dt: number, strength: number) {
    const dx = x - source.smokeX, dz = z - source.smokeZ, distance = Math.hypot(dx, dz)
    const active = strength > 0.008
    if (active) {
      if (source.smokeActive && distance < 8) {
        const spacing = 0.36
        for (let at = spacing - source.smokeDistance; at <= distance; at += spacing) {
          const t = at / distance, px = source.smokeX + dx * t, pz = source.smokeZ + dz * t
          this.spawn(px, 0.3, pz, vx, vz, (1 - t) * dt, strength)
        }
        source.smokeDistance = (source.smokeDistance + distance) % spacing
        // A stationary burnout still emits. Only top up the distance-based rate, never double it.
        source.idle += Math.max(0, dt * 14 - distance / spacing)
        while (source.idle >= 1) { source.idle--; this.spawn(x, 0.3, z, vx, vz, 0, strength) }
      } else { source.smokeDistance = source.idle = 0; this.spawn(x, 0.3, z, vx, vz, 0, strength) }
    } else source.smokeDistance = source.idle = 0
    source.smokeX = x; source.smokeZ = z; source.smokeActive = active
  }

  spawn(x: number, y: number, z: number, vx: number, vz: number, age = 0, strength = 1) {
    if (this.count === SMOKE_CAPACITY) return
    const i = this.count++ * SMOKE_STRIDE
    const seed = (Math.imul(++this.sequence, 16807) >>> 0) % 997 / 997
    this.particles[i] = x
    this.particles[i + 1] = y
    this.particles[i + 2] = z
    this.particles[i + 3] = age
    this.particles[i + 4] = vx * 0.008
    this.particles[i + 5] = vz * 0.008
    this.particles[i + 6] = strength
    this.particles[i + 7] = 4.5 + seed * 0.8
  }

  update(dt: number) {
    this.time += dt
    let count = 0
    const p = this.particles
    const drag = Math.exp(-dt * 2.6)
    for (let n = 0; n < this.count; n++) {
      const i = n * SMOKE_STRIDE
      const age = p[i + 3]! + dt
      if (age >= p[i + 7]!) continue
      const x = p[i]!, z = p[i + 2]!
      // Curl of a two-frequency analytic stream function: (dψ/dz, -dψ/dx).
      // Adjacent samples share the field instead of separating under random per-particle kicks.
      const a = x * 0.7 + this.time * 0.45, b = z * 0.7 - this.time * 0.3
      const c = x * 1.31 - this.time * 0.32, d = z * 1.31 + this.time * 0.27
      const curlX = Math.sin(a) * Math.cos(b) * 0.6 + Math.sin(c) * Math.cos(d) * 0.18
      const curlZ = -Math.cos(a) * Math.sin(b) * 0.6 - Math.cos(c) * Math.sin(d) * 0.18
      const o = count++ * SMOKE_STRIDE
      p[o] = x + (p[i + 4]! + this.windX + curlX * 0.6) * dt
      p[o + 1] = p[i + 1]! + dt * (0.23 + 0.06 * Math.sin(a + b))
      p[o + 2] = z + (p[i + 5]! + this.windZ + curlZ * 0.6) * dt
      p[o + 3] = age
      p[o + 4] = p[i + 4]! * drag
      p[o + 5] = p[i + 5]! * drag
      p[o + 6] = p[i + 6]!
      p[o + 7] = p[i + 7]!
    }
    this.count = count
  }

  /** Oldest first, which is back-to-front for the usual trailing chase view. */
  prepare() {
    this.drawn = this.count
    const p = this.particles, out = this.instances
    for (let n = 0; n < this.count; n++) {
      const i = n * SMOKE_STRIDE, age = p[i + 3]!, t = age / p[i + 7]!
      const radius = 0.55 + age * 0.43
      const density = p[i + 6]! * Math.pow(1 - t, 1.1) / (1 + age * 0.45)
      out[i] = p[i]!; out[i + 1] = p[i + 1]!; out[i + 2] = p[i + 2]!; out[i + 3] = radius
      out[i + 4] = density
    }
  }
}
