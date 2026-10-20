import { putSprite } from "./light-probe"

/**
 * Breath in the cold night air: every few seconds (sooner when running) a survivor out of doors breathes out a small
 * puff in front of the face that drifts forward, rises, spreads and thins. It is only seen where a light catches it,
 * so in practice it shows in the survivor's own torch beam, a teammate's or under a lamp. Each client's own puffs, from
 * replicated positions and aims.
 */

/** Puffs alive at once across every survivor. */
export const BREATH_PUFFS = 32
/** Seconds a puff lives. */
export const BREATH_LIFE = 1.7

type Puff = { x: number; y: number; z: number; vx: number; vz: number; age: number; live: boolean }
type Breather = { next: number; lx: number; ly: number; seen: boolean }

export type BreathSurvivor = { id: string; x: number; y: number; aim: number; inside: boolean; driving: boolean; ground: number }

export class Breath {
  private readonly puffs: Puff[] = Array.from({ length: BREATH_PUFFS }, () => ({ x: 0, y: 0, z: 0, vx: 0, vz: 0, age: 0, live: false }))
  private readonly breathers = new Map<string, Breather>()
  private cursor = 0
  private seed = 0x1234567
  /** Readout: puffs alive last frame, and breaths taken so far. */
  alive = 0
  breaths = 0

  private rand(): number {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0
    return this.seed / 4294967296
  }

  reset(): void {
    for (const p of this.puffs) p.live = false
    this.breathers.clear()
  }

  /** Advances the puffs and lets each survivor breathe out when it is due. `cold` 0..1 scales how often and how much. */
  step(dt: number, time: number, cold: number, survivors: readonly BreathSurvivor[]): void {
    for (const p of this.puffs) {
      if (!p.live) continue
      p.age += dt
      if (p.age > BREATH_LIFE) {
        p.live = false
        continue
      }
      const drag = Math.exp(-dt * 1.6)
      p.vx *= drag
      p.vz *= drag
      p.x += p.vx * dt
      p.z += p.vz * dt
      p.y += 0.1 * dt
    }
    for (const b of this.breathers.values()) b.seen = false
    for (const s of survivors) {
      let b = this.breathers.get(s.id)
      if (!b) {
        b = { next: time + this.rand() * 3, lx: s.x, ly: s.y, seen: true }
        this.breathers.set(s.id, b)
      }
      b.seen = true
      const speed = dt > 0 ? Math.hypot(s.x - b.lx, s.y - b.ly) / dt : 0
      b.lx = s.x
      b.ly = s.y
      if (time < b.next) continue
      // Resting about every 3.4 s; running hard, half that.
      const effort = Math.min(1, speed / 5)
      b.next = time + (3.4 - 1.7 * effort) * (0.85 + this.rand() * 0.3)
      if (cold <= 0.05 || s.inside || s.driving) continue
      const p = this.puffs[this.cursor]!
      this.cursor = (this.cursor + 1) % BREATH_PUFFS
      const ca = Math.cos(s.aim)
      const sa = Math.sin(s.aim)
      p.x = s.x + ca * 0.24
      p.z = s.y + sa * 0.24
      p.y = s.ground + 1.56
      const out = 0.45 + 0.35 * effort
      p.vx = ca * out + (this.rand() - 0.5) * 0.12
      p.vz = sa * out + (this.rand() - 0.5) * 0.12
      p.age = 0
      p.live = true
      this.breaths++
    }
    if (this.breathers.size > 8) for (const [id, b] of this.breathers) if (!b.seen) this.breathers.delete(id)
  }

  /** Alpha sprites for the live puffs, lit and tinted by the torches (`probe`); returns the new count. */
  write(probe: { at(x: number, y: number, z: number): number; near(x: number, z: number, radius: number): number; readonly colour: readonly number[] }, sprites: Float32Array, n: number, strength: number): number {
    this.alive = 0
    for (const p of this.puffs) {
      if (!p.live) continue
      this.alive++
      const u = p.age / BREATH_LIFE
      // In the beam, or just over the lens, where its spill catches the breath before it drifts into the cone.
      const lit = Math.min(1, Math.max(probe.at(p.x, p.y, p.z), 0.7 * probe.near(p.x, p.z, 1.1)))
      if (lit <= 0.03) continue
      // Quick to form, slow to thin out.
      const a = Math.min(1, u * 8) * (1 - u) ** 1.6 * 0.15 * lit * strength
      const size = 0.08 + 0.26 * Math.sqrt(u)
      const k = 0.55 * lit
      const tint = probe.colour
      n = putSprite(sprites, n, p.x, p.y, p.z, size, tint[0]! * k, tint[1]! * k, tint[2]! * k, Math.min(0.5, a))
    }
    return n
  }
}
