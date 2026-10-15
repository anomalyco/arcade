import { LIGHT_FLOATS, MAX_MAP_LIGHTS } from "@arcade/kit/limits"

/**
 * One sconce pair (a single light), as `emitInteriorDecor` records it: centre between the bulbs x, z, height; wall
 * normal into the room (x, z); back-cut distance behind the bulbs; room extent left and right of the centre along the
 * wall; half the bulb spacing; then the building rect (x0, z0, x1, z1).
 */
export const SCONCE_FLOATS = 13

/** The `lampPower` slot every sconce bulb reads, so bulbs and their lights switch together. */
export const SCONCE_LAMP_SLOT = MAX_MAP_LIGHTS - 1

/** Marks a sconce in the light's `cone.w` (inside the kit's 0.5–1.5 spotlight range, so its cone edge applies). */
export const SCONCE_CONE_W = 1.25

export type SconceLightSettings = {
  /** -1 follows the quality tier; otherwise the most sconce pairs lit per frame (each pair is one light). */
  sconceLights: number
  sconcePower: number
  sconceRadius: number
}

export const DEFAULT_SCONCE_LIGHT_SETTINGS: SconceLightSettings = { sconceLights: -1, sconcePower: 1, sconceRadius: 3.2 }

/**
 * Chooses the sconce lights for a frame: only in the building whose roof is open (the survivor or peek point is
 * inside it), nearest that point first, up to `max`. Each becomes an unshadowed light marked by `SCONCE_CONE_W`:
 * warm, cut just behind its wall and clipped to its room along the wall (Outbreak's `lightMask`), and scaled by the
 * room-lamp level so it goes dark with them.
 *
 * Slot layout: cone = (normal.x, normal.z, -(right + 1.25), SCONCE_CONE_W), the kit's own cone falloff then a no-op;
 * extra = (back cut, -(left + 1), softness, half bulb spacing). `extra.y <= 0` keeps it unshadowed and `extra.w >= 0`
 * keeps the look's flashlight detection from mistaking it for a beam. `power` covers both bulbs.
 */
export class SconceLights {
  private sources: readonly Float32Array[] = []
  private readonly keys: number[] = []
  private readonly dists: number[] = []
  /** Sconce lights written last frame (for telemetry and proofs). */
  lastCount = 0

  setSources(sources: readonly Float32Array[]): void {
    this.sources = sources
  }

  /** Every sconce in the current sources (proofs and the Lab). */
  list(): { x: number; z: number; y: number; nx: number; nz: number; rect: [number, number, number, number] }[] {
    const out = []
    for (const src of this.sources) {
      for (let o = 0; o + SCONCE_FLOATS <= src.length; o += SCONCE_FLOATS) {
        out.push({ x: src[o]!, z: src[o + 1]!, y: src[o + 2]!, nx: src[o + 3]!, nz: src[o + 4]!, rect: [src[o + 9]!, src[o + 10]!, src[o + 11]!, src[o + 12]!] as [number, number, number, number] })
      }
    }
    return out
  }

  /** The fixture brightness for `SCONCE_LAMP_SLOT` at a room-lamp `level`. */
  static bulb(level: number, s: SconceLightSettings): number {
    return level * 0.45 * Math.min(1, s.sconcePower)
  }

  /** Writes up to `max` lights from `firstSlot` (below `maxSlot`); `level` is day × lighting × room power. Returns the next slot. */
  write(lights: Float32Array, firstSlot: number, maxSlot: number, max: number, cutX: number, cutY: number, level: number, warmth: number, s: SconceLightSettings): number {
    const keys = this.keys, dists = this.dists
    keys.length = 0
    dists.length = 0
    const power = s.sconcePower * 0.84 * level
    if (max <= 0 || power <= 0.002) return (this.lastCount = 0, firstSlot)
    for (let si = 0; si < this.sources.length; si++) {
      const src = this.sources[si]!
      for (let o = 0; o + SCONCE_FLOATS <= src.length; o += SCONCE_FLOATS) {
        if (cutX < src[o + 9]! - 0.1 || cutX > src[o + 11]! + 0.1 || cutY < src[o + 10]! - 0.1 || cutY > src[o + 12]! + 0.1) continue
        const d = (src[o]! - cutX) ** 2 + (src[o + 1]! - cutY) ** 2
        let k = keys.length
        keys.push(0)
        dists.push(0)
        while (k > 0 && dists[k - 1]! > d) {
          keys[k] = keys[k - 1]!
          dists[k] = dists[k - 1]!
          k--
        }
        keys[k] = si * SOURCE_STRIDE + o
        dists[k] = d
      }
    }
    const w = Math.max(0, Math.min(1, warmth))
    let slot = firstSlot
    for (let k = 0; k < keys.length && k < max && slot < maxSlot; k++) {
      const src = this.sources[Math.floor(keys[k]! / SOURCE_STRIDE)]!
      const o = keys[k]! % SOURCE_STRIDE
      lights.set(
        [
          src[o]!, src[o + 2]!, src[o + 1]!, s.sconceRadius,
          1.0, 0.5 - 0.06 * w, 0.15 - 0.05 * w, power,
          src[o + 3]!, src[o + 4]!, -(src[o + 7]! + 1.25), SCONCE_CONE_W,
          src[o + 5]!, -(src[o + 6]! + 1), 0.08, src[o + 8]!,
        ],
        slot++ * LIGHT_FLOATS,
      )
    }
    this.lastCount = slot - firstSlot
    return slot
  }
}

const SOURCE_STRIDE = 1 << 20
