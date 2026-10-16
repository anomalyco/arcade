import { LIGHT_FLOATS } from "@arcade/kit/limits"
import type { Rect } from "@arcade/kit/sim/geom"
import type { Town } from "../shared/map"
import type { TableLamp } from "./lightbake"

/** `cone.w` marking a live table lamp; `cone.xyz` and `extra.x` carry its clip rect (shaders.ts `lightMask`). */
export const TABLE_LAMP_CONE_W = -3
/** Reach of a live table lamp (m); its baked pool (`tableLampPool`) covers the doorway spill beyond the clip. */
export const TABLE_LAMP_RADIUS = 2.6

/**
 * The rect a table lamp lights: from the lamp to the nearest wall or window barrier in each axis direction, capped at
 * its reach. Unshadowed lights pass through walls, so the shader cuts the lamp to this rect; open-plan rooms with no
 * wall between them share it, and doorways stop at the wall line (the baked pool spills through them).
 */
export function tableLampClip(l: TableLamp, walls: readonly Rect[], reach = TABLE_LAMP_RADIUS): Rect {
  let x0 = l.x - reach, x1 = l.x + reach, z0 = l.z - reach, z1 = l.z + reach
  for (const [a, b, c, d] of walls) {
    if (l.z > b && l.z < d) {
      if (c <= l.x) x0 = Math.max(x0, c)
      else if (a >= l.x) x1 = Math.min(x1, a)
    }
    if (l.x > a && l.x < c) {
      if (d <= l.z) z0 = Math.max(z0, d)
      else if (b >= l.z) z1 = Math.min(z1, b)
    }
  }
  return [x0, z0, x1, z1]
}

/**
 * Live table lamps from the furniture library (`propLamps`): small warm unshadowed lights cut to their room by
 * `tableLampClip`, the nearest few to the cutaway point while the camera is inside a house, with the room lamps'
 * hour and power. Cheaper than a shadow slot and never lights through a wall.
 */
export class TableLampLights {
  private lamps: readonly TableLamp[] = []
  private clips: Rect[] = []
  private readonly order: number[] = []
  lastCount = 0

  private town: Town | null = null

  /** Sets the lamps and their clips; cheap when the same lamps come back for the same town. */
  setSources(lamps: readonly TableLamp[], town: Town): void {
    const same = town === this.town && lamps.length === this.lamps.length && lamps.every((l, i) => {
      const o = this.lamps[i]!
      return l.x === o.x && l.z === o.z && l.h === o.h
    })
    if (same) return
    this.town = town
    this.lamps = lamps
    const walls = town.barriers.filter(b => b.kind !== "fence").map(b => b.rect)
    this.clips = lamps.map(l => tableLampClip(l, walls))
  }

  /** Writes up to `max` lights from `firstSlot` (below `maxSlot`); `level` is day × lighting × room power. Returns the next slot. */
  write(lights: Float32Array, firstSlot: number, maxSlot: number, max: number, cutX: number, cutY: number, level: number, warmth: number, power: number): number {
    const p = level * power
    const order = this.order
    order.length = 0
    if (max <= 0 || p <= 0.002) return (this.lastCount = 0, firstSlot)
    for (let i = 0; i < this.lamps.length; i++) {
      const l = this.lamps[i]!
      if (Math.abs(l.x - cutX) > 9 || Math.abs(l.z - cutY) > 9) continue
      order.push(i)
    }
    const d = (i: number) => (this.lamps[i]!.x - cutX) ** 2 + (this.lamps[i]!.z - cutY) ** 2
    order.sort((a, b) => d(a) - d(b))
    const w = Math.max(0, Math.min(1, warmth))
    let slot = firstSlot
    for (let k = 0; k < order.length && k < max && slot < maxSlot; k++) {
      const l = this.lamps[order[k]!]!
      const c = this.clips[order[k]!]!
      lights.set(
        [
          l.x, l.h, l.z, TABLE_LAMP_RADIUS,
          1.0, 0.47 - 0.06 * w, 0.13 - 0.05 * w, p,
          c[0], c[1], c[2], TABLE_LAMP_CONE_W,
          c[3], -1, 0.08, 0,
        ],
        slot++ * LIGHT_FLOATS,
      )
    }
    this.lastCount = slot - firstSlot
    return slot
  }
}
