/** World X/Z wall rectangles. Heights are analytic: these walls seal the full shallow smoke layer. */
export type Wall = readonly [number, number, number, number]
export const GRID = 48
export const VOLUMES = 4
const CELLS = GRID * GRID

/** Four independent bounded flood fields, 24m wide, at 0.5m resolution. Allocation only at construction.
 * Arrival distance takes four-connected paths around walls, never radial distance through them.
 * This is an expanding shallow gas approximation, not an incompressible fluid simulation.
 */
export class SmokeVolumes {
  readonly density = new Uint8Array(CELLS * VOLUMES)
  readonly bounds = new Float32Array(VOLUMES * 8)
  private readonly arrival = new Float32Array(CELLS * VOLUMES)
  private readonly holes = new Float32Array(CELLS * VOLUMES)
  private readonly queue = new Int32Array(CELLS)
  private readonly age = new Float32Array(VOLUMES)
  private readonly life = new Float32Array(VOLUMES)
  private readonly radius = new Float32Array(VOLUMES)
  private readonly power = new Float32Array(VOLUMES)
  private walls: readonly Wall[] = []
  count = 0
  time = 0
  sustain(x: number, z: number) {
    for (let s = 0; s < VOLUMES; s++) if (this.life[s] && Math.hypot(x-this.bounds[s*8+4],z-this.bounds[s*8+5]) < 2) {
      this.age[s] = Math.min(this.age[s], this.life[s]-3.1); return
    }
    this.spawn(x,z,2.2,5,0.65,0.8)
  }
  reset(walls: readonly Wall[] = this.walls) { this.walls = walls; this.life.fill(0); this.bounds.fill(0); this.density.fill(0); this.count = 0; this.time = 0 }
  spawn(x: number, z: number, radius = 5, life = 9, power = 1, soot = 0) {
    let slot = -1
    for (let s = 0; s < VOLUMES; s++) if (!this.life[s]) { slot = s; break }
    if (slot < 0) return false // Never evict a visible cloud to make room.
    const b = slot * 8, start = slot * CELLS
    this.bounds[b] = Math.floor(x * 2) / 2 - 12; this.bounds[b + 1] = Math.floor(z * 2) / 2 - 12
    this.bounds[b + 2] = 24; this.bounds[b + 3] = 3.8
    this.bounds[b + 4] = x; this.bounds[b + 5] = z
    this.bounds[b + 6] = Math.max(0,Math.min(1,soot))
    this.age[slot] = 0; this.life[slot] = Math.max(0.1, life); this.radius[slot] = Math.min(10, radius); this.power[slot] = power
    this.arrival.fill(-1, start, start + CELLS); this.holes.fill(0, start, start + CELLS)
    // Conservative rasterization includes thin walls between cell centres.
    for (const w of this.walls) {
      const x0 = Math.max(0, Math.floor((w[0] - this.bounds[b]) * 2)), x1 = Math.min(GRID - 1, Math.floor((w[2] - this.bounds[b]) * 2))
      const z0 = Math.max(0, Math.floor((w[1] - this.bounds[b + 1]) * 2)), z1 = Math.min(GRID - 1, Math.floor((w[3] - this.bounds[b + 1]) * 2))
      for (let iz = z0; iz <= z1; iz++) for (let ix = x0; ix <= x1; ix++) this.arrival[start + iz * GRID + ix] = -2
    }
    const root = 24 * GRID + 24
    if (this.arrival[start + root] === -2) { this.life[slot] = 0; return false }
    this.queue[0] = root; this.arrival[start + root] = 0
    let head = 0, tail = 1
    while (head < tail) {
      const i = this.queue[head++], distance = this.arrival[start + i] + 0.5
      if (distance > this.radius[slot] * 1.45) continue
      for (let d = 0; d < 4; d++) {
        const n = i + (d === 0 ? -1 : d === 1 ? 1 : d === 2 ? -GRID : GRID)
        if (n < 0 || n >= CELLS || (d < 2 && Math.floor(n / GRID) !== Math.floor(i / GRID)) || this.arrival[start + n] !== -1) continue
        this.arrival[start + n] = distance; this.queue[tail++] = n
      }
    }
    for (let k = 0; k < tail; k++) {
      const i = this.queue[k]!, dx = (i % GRID - 24) * 0.5, dz = (Math.floor(i / GRID) - 24) * 0.5
      this.arrival[start + i] += Math.hypot(dx, dz) - (Math.abs(dx) + Math.abs(dz))
    }
    this.count++
    return true
  }
  /** Temporary cylinder carve for shots/explosions, refilling in about 0.7s. */
  carve(ax: number, az: number, bx: number, bz: number, radius = 0.35) {
    const dx = bx - ax, dz = bz - az, length2 = dx * dx + dz * dz
    for (let s = 0; s < VOLUMES; s++) {
      if (!this.life[s]) continue
      for (let i = 0; i < CELLS; i++) {
        const x = this.bounds[s * 8] + (i % GRID + 0.5) * 0.5, z = this.bounds[s * 8 + 1] + (Math.floor(i / GRID) + 0.5) * 0.5
        const t = length2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / length2)) : 0
        if ((x - ax - dx * t) ** 2 + (z - az - dz * t) ** 2 < radius * radius) this.holes[s * CELLS + i] = 1
      }
    }
  }
  update(dt: number) {
    dt = Math.max(0, Math.min(dt, 0.1)); this.time += dt; this.count = 0
    for (let s = 0; s < VOLUMES; s++) {
      const start = s * CELLS
      if (!this.life[s]) continue
      this.age[s] += dt
      if (this.age[s] >= this.life[s]) { this.life[s] = 0; this.bounds[s*8+7] = 0; this.density.fill(0, start, start + CELLS); continue }
      this.count++
      const age = this.age[s], reach = Math.min(this.radius[s] * 1.45, age * 3.8 + 0.6)
      const fade = Math.min(1, age * 5) * Math.min(1, (this.life[s] - age) / 3)
      this.bounds[s * 8 + 7] = fade
      for (let i = 0; i < CELLS; i++) {
        const at = start + i, distance = this.arrival[at]
        this.holes[at] = Math.max(0, this.holes[at] - dt * 1.5)
        const edge = Math.max(0, Math.min(1, (reach - distance) / 1.4))
        this.density[at] = distance < 0 ? 0 : Math.min(255, 255 * fade * edge * this.power[s] * (1 - this.holes[at]))
      }
    }
  }
}
