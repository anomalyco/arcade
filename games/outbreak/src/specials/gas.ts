import { SPRITE_FLOATS } from "@arcade/kit/gpu/renderer"
import { SPECIAL_BLOATER, specialKindOf } from "../../shared/specials/kinds"

/** A burst Bloater's cloud as this peer saw it: where, when, how big and for how long. */
export type GasPuff = { id: number; x: number; y: number; born: number; radius: number; life: number }

/**
 * The Bloater's gas, presentation only: a cloud appears where a Bloater dies (seen as a state change, like the sound
 * director's, so co-op peers draw it from snapshots), drawn as a sickly ground stain and slow drifting puffs. The sim
 * owns the damage (`shared/specials/specials.ts`).
 */
export class GasClouds {
  readonly clouds: GasPuff[] = []
  private readonly states = new Map<number, string>()
  private started = false

  reset(): void {
    this.clouds.length = 0
    this.states.clear()
    this.started = false
  }

  observe(zombies: readonly { id: number; seed: number; x: number; y: number; state: string }[], time: number, radius: number, life: number): void {
    const seen = new Set<number>()
    for (const z of zombies) {
      if (specialKindOf(z.seed) !== SPECIAL_BLOATER) continue
      seen.add(z.id)
      const prev = this.states.get(z.id)
      this.states.set(z.id, z.state)
      if (this.started && prev !== undefined && prev !== "dead" && z.state === "dead") {
        this.clouds.push({ id: z.id, x: z.x, y: z.y, born: time, radius, life })
      }
    }
    for (const id of this.states.keys()) if (!seen.has(id)) this.states.delete(id)
    this.started = true
    for (let i = this.clouds.length - 1; i >= 0; i--) {
      const c = this.clouds[i]!
      if (time - c.born > c.life || time < c.born) this.clouds.splice(i, 1)
    }
  }

  /** Writes the clouds into the additive sprite list from `count`; returns the new count. */
  draw(sprites: Float32Array, count: number, time: number, ground: (x: number, y: number) => number): number {
    const max = Math.floor(sprites.length / SPRITE_FLOATS)
    const put = (x: number, y: number, z: number, size: number, r: number, g: number, b: number, a: number, kind: number, rot: number) => {
      if (count >= max) return
      const o = count++ * SPRITE_FLOATS
      sprites[o] = x
      sprites[o + 1] = y
      sprites[o + 2] = z
      sprites[o + 3] = size
      sprites[o + 4] = r
      sprites[o + 5] = g
      sprites[o + 6] = b
      sprites[o + 7] = a
      sprites[o + 8] = kind
      sprites[o + 9] = rot
      sprites[o + 10] = 0
      sprites[o + 11] = 0
    }
    for (const c of this.clouds) {
      const age = time - c.born
      const u = age / Math.max(0.1, c.life)
      const fade = Math.min(1, age / 0.35) * Math.min(1, (1 - u) / 0.3)
      if (fade <= 0.01) continue
      const gy = ground(c.x, c.y)
      const swell = 0.75 + 0.25 * Math.min(1, age / 1.2)
      put(c.x, gy + 0.04, c.y, c.radius * swell, 0.2, 0.26, 0.04, 0.5 * fade, 6, 0)
      for (let k = 0; k < 7; k++) {
        const ang = k * 2.39996 + age * (0.12 + 0.03 * k)
        const d = c.radius * swell * (0.25 + 0.5 * ((k * 0.37) % 1))
        const lift = 0.35 + 0.25 * Math.sin(age * 0.8 + k)
        put(c.x + Math.cos(ang) * d, gy + lift, c.y + Math.sin(ang) * d, c.radius * 0.5, 0.3, 0.38, 0.06, 0.22 * fade, 0, 0)
      }
    }
    return count
  }
}
