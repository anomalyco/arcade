import { tyreSettings as settings } from "../lab/tyre-settings"
/** Fixed storage for the connected-smoke study. No particle objects or scratch arrays per frame. */
export const SMOKE_CAPACITY = 768
export const SMOKE_STRIDE = 8
export const FIELD_SIZE = 128
export type SmokeSource = { smokeDistance: number; smokeX: number; smokeZ: number; smokeActive: boolean; idle: number }
export class SmokeTrail {
  readonly particles = new Float32Array(SMOKE_CAPACITY * SMOKE_STRIDE)
  readonly instances = new Float32Array(SMOKE_CAPACITY * SMOKE_STRIDE)
  readonly field = new Uint8Array(FIELD_SIZE * FIELD_SIZE * 4)
  private readonly sums = new Float32Array(FIELD_SIZE * FIELD_SIZE * 4)
  readonly bounds = new Float32Array(8)
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
        const spacing = Math.max(.01,settings.spacing)
        for (let at = spacing - source.smokeDistance; at <= distance; at += spacing) {
          const t = at / distance, px = source.smokeX + dx * t, pz = source.smokeZ + dz * t
          this.spawn(px, 0.3, pz, vx, vz, (1 - t) * dt, strength)
        }
        source.smokeDistance = (source.smokeDistance + distance) % spacing
        // A stationary burnout still emits. Only top up the distance-based rate, never double it.
        source.idle += Math.max(0, dt * settings.idleRate - distance / spacing)
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
    this.particles[i + 4] = vx * settings.inheritVelocity
    this.particles[i + 5] = vz * settings.inheritVelocity
    this.particles[i + 6] = strength
    this.particles[i + 7] = settings.life + seed * settings.lifeSpread
  }

  update(dt: number) {
    this.time += dt
    let count = 0
    const p = this.particles
    const drag = Math.exp(-dt * settings.drag)
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
      p[o] = x + (p[i + 4]! + this.windX + curlX * settings.curl) * dt
      p[o + 1] = p[i + 1]! + dt * (settings.lift + 0.06 * Math.sin(a + b))
      p[o + 2] = z + (p[i + 5]! + this.windZ + curlZ * settings.curl) * dt
      p[o + 3] = age
      p[o + 4] = p[i + 4]! * drag
      p[o + 5] = p[i + 5]! * drag
      p[o + 6] = p[i + 6]!
      p[o + 7] = p[i + 7]!
    }
    this.count = count
  }

  /** Oldest first, which is back-to-front for the usual trailing chase view. */
  prepare(style: number) {
    this.drawn = this.count
    const p = this.particles, out = this.instances
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity
    for (let n = 0; n < this.count; n++) {
      const i = n * SMOKE_STRIDE, age = p[i + 3]!, t = age / p[i + 7]!
      const radius = settings.radius + age * settings.growth
      const density = p[i + 6]! * Math.pow(1 - t, 1.1) / (1 + age * 0.45)
      out[i] = p[i]!; out[i + 1] = p[i + 1]!; out[i + 2] = p[i + 2]!; out[i + 3] = radius
      out[i + 4] = density; out[i + 5] = age; out[i + 6] = p[i + 6]!; out[i + 7] = style
      minX = Math.min(minX, p[i]! - radius * 1.5); maxX = Math.max(maxX, p[i]! + radius * 1.5)
      minZ = Math.min(minZ, p[i + 2]! - radius * 1.5); maxZ = Math.max(maxZ, p[i + 2]! + radius * 1.5)
    }
    if (!this.count) return
    // The fourth channel is a conservative footprint for the fixed top-down camera's ray slant.
    // It rejects empty pixels before twelve field/noise samples and the practical-light loop.
    if (style === 8) { minX -= 4; minZ -= 4; maxX += 4; maxZ += 4 }
    this.bounds[0] = minX; this.bounds[1] = minZ
    this.bounds[2] = Math.max(1, maxX - minX); this.bounds[3] = Math.max(1, maxZ - minZ)
    this.bounds[4] = this.time
    if (style !== 8) return
    // Splat smooth density into a shallow field. Vertical radius/height remain independent so the
    // fragment shader integrates an actual 3D cloud, not a blurred ground decal.
    this.sums.fill(0)
    const sx = FIELD_SIZE / this.bounds[2]!, sz = FIELD_SIZE / this.bounds[3]!
    for (let n = 0; n < this.count; n++) {
      const i = n * SMOKE_STRIDE, r = out[i + 3]!, density = out[i + 4]!
      const cx = (out[i]! - minX) * sx, cz = (out[i + 2]! - minZ) * sz
      const loX = Math.max(0, Math.floor(cx - (r + 4) * sx)), hiX = Math.min(FIELD_SIZE - 1, Math.ceil(cx + (r + 4) * sx))
      const loZ = Math.max(0, Math.floor(cz - (r + 4) * sz)), hiZ = Math.min(FIELD_SIZE - 1, Math.ceil(cz + (r + 4) * sz))
      for (let z = loZ; z <= hiZ; z++) for (let x = loX; x <= hiX; x++) {
        const o = (z * FIELD_SIZE + x) * 4
        this.sums[o + 3] = 1
        const dx = (x + 0.5 - cx) / (sx * r), dz = (z + 0.5 - cz) / (sz * r)
        const q = dx * dx + dz * dz
        if (q >= 1) continue
        const w = (1 - q) * (1 - q) * density
        this.sums[o] += w
        this.sums[o + 1] += w * out[i + 1]!
        this.sums[o + 2] += w * r
      }
    }
    for (let i = 0; i < this.field.length; i += 4) {
      const weight = this.sums[i]!
      this.field[i] = Math.min(255, weight * 48)
      this.field[i + 1] = weight ? this.sums[i + 1]! / weight * 255 / 4 : 0
      this.field[i + 2] = weight ? this.sums[i + 2]! / weight * 255 / 4 : 0
      this.field[i + 3] = this.sums[i + 3]! * 255
    }
  }
}
