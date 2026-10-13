import { mulberry32 } from "../../../shared/sim/rng"

export type SpriteWriter = (list: "a" | "d", x: number, y: number, z: number, size: number, r: number, g: number, b: number, a: number, kind: number, rot?: number, stretch?: number, extra?: number) => void
type Particle = { x: number; y: number; z: number; vx: number; vy: number; vz: number; age: number; life: number; size: number; kind: number; seed: number }
export const PARTICLE_CAP = 2400
/** Fixed pool and swap-remove: no per-frame particle allocation or GPU readback. */
export class PropParticles {
  private pool: Particle[] = Array.from({ length: PARTICLE_CAP }, () => ({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, age: 0, life: 0, size: 0, kind: 0, seed: 0 }))
  count = 0
  private rng = mulberry32(9127)
  reset() { this.count = 0; this.rng = mulberry32(9127) }
  emit(kind: number, x: number, y: number, z: number, count: number, strength = 1, vx = 0, vz = 0) {
    for (let i = 0; i < count && this.count < PARTICLE_CAP; i++) {
      const p = this.pool[this.count++]!, rand = this.rng, angle = rand() * Math.PI * 2, speed = (1 + rand() * 5) * strength
      p.x = x; p.y = y; p.z = z; p.age = 0; p.kind = kind; p.seed = rand()
      p.vx = Math.cos(angle) * speed + vx * .35; p.vz = Math.sin(angle) * speed + vz * .35
      p.vy = (2 + rand() * 7) * strength
      p.life = kind === 1 ? 2 + rand() * 2 : kind === 10 ? 3 + rand() * 3 : kind === 11 ? 1.6 : kind === 12 ? .22 + rand() * .3 : .35 + rand() * .65
      p.size = kind === 1 ? .8 + rand() * .8 : kind === 10 ? .1 + rand() * .13 : kind === 11 ? .06 + rand() * .07 : .1 + rand() * .22
      if (kind === 1) { p.vy = 2 + rand() * 2; p.vx *= .3; p.vz *= .3 }
      if (kind === 11) { p.vx *= .24; p.vz *= .24; p.vy = 8 + rand() * 5 }
      if (kind === 12) p.size = .45 + rand() * .8
    }
  }
  update(dt: number, ground: (x: number, z: number) => number) {
    dt = Math.max(0, Math.min(dt, .05))
    for (let i = 0; i < this.count;) {
      const p = this.pool[i]!
      p.age += dt
      if (p.age >= p.life) { this.pool[i] = this.pool[--this.count]!; this.pool[this.count] = p; continue }
      const drag = Math.exp(-dt * (p.kind === 10 ? 2.2 : p.kind === 1 ? .6 : .45))
      p.vx *= drag; p.vz *= drag
      if (p.kind !== 1 && p.kind !== 12) p.vy -= (p.kind === 10 ? 3 : 18) * dt
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt
      if (p.kind === 10) { p.x += Math.sin(p.age * 8 + p.seed * 40) * dt * .7; p.z += Math.cos(p.age * 7 + p.seed * 10) * dt * .5 }
      const floor = ground(p.x, p.z) + .035
      if (p.y < floor) {
        p.y = floor
        if (p.kind === 11) p.age = p.life
        else { p.vy = Math.abs(p.vy) * .25; p.vx *= .65; p.vz *= .65 }
      }
      i++
    }
  }
  draw(sprite: SpriteWriter) {
    for (let i = 0; i < this.count; i++) {
      const p = this.pool[i]!, t = p.age / p.life, fade = Math.min(1, (1 - t) * 3)
      if (p.kind === 1) sprite("a", p.x, p.y, p.z, p.size * (1 + t * 2.6), .48, .45, .4, fade * .8, 1, 0, 1, p.seed)
      else if (p.kind === 10) sprite("a", p.x, p.y, p.z, p.size, .78, .76, .64, fade, 10, p.age * 3 + p.seed * 6, .5 + .45 * Math.sin(p.age * 10 + p.seed * 20), p.seed)
      else if (p.kind === 11) sprite("a", p.x, p.y, p.z, p.size, .42, .73, .88, fade * .78, 11, 0, 1.7)
      else if (p.kind === 12) sprite("d", p.x, p.y, p.z, p.size * (1 + t * 1.8), 1, .16 + (1 - t) * .3, .015, (1 - t) ** 2 * 1.3, 12)
      else sprite("d", p.x, p.y, p.z, p.size, 1, .55, .12, fade * 2, 6)
    }
  }
}
