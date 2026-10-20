import { SPRITE_FLOATS } from "@arcade/kit/gpu/renderer"
import type { GasCloud } from "../../shared/specials/net-types"

/** A burst Bloater's authoritative cloud: where, when, how big and for how long. */
export type GasPuff = { id: number; x: number; y: number; born: number; radius: number; life: number }

/**
 * The Bloater's gas, drawn from the room's persistent clouds as a sickly ground stain and slow drifting puffs. The sim
 * owns the damage (`shared/specials/specials.ts`).
 */
export class GasClouds {
  readonly clouds: GasPuff[] = []

  reset(): void {
    this.clouds.length = 0
  }

  /** Both offline and co-op draw the hazard itself, even if nobody saw the Bloater die. */
  sync(clouds: readonly GasCloud[], time: number): void {
    this.clouds.length = 0
    for (const c of clouds) {
      if (c.until > time) this.clouds.push({ id: c.id, x: c.x, y: c.y, born: c.born, radius: c.radius, life: c.until - c.born })
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
