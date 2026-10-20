import type { Town } from "../../shared/map"
import { supportHeight } from "../../shared/terrain"
import { putSprite } from "./light-probe"
import { detailRng, isHome, outdoorFree, streetLine } from "./placement"
import type { OutbreakDetailSettings } from "./settings"

/**
 * A lawn sprinkler on a timer nobody turned off: at first light it comes on in one front yard and ticks its jet back
 * and forth across the grass, then shuts off. The pressure falls a little each day until it no longer comes on. The
 * yard is seeded from the town; the jet is a pure function of the clock, so co-op clients see it sweep together.
 */

export type Sprinkler = { key: string; x: number; z: number; y: number; facing: number; seed: number }

/** When the timer runs (hours) and how far the jet throws on the first morning (m). */
export const SPRINKLER_ON = 6.6
export const SPRINKLER_OFF = 7.3
export const SPRINKLER_REACH = 4.2
/** Droplets drawn along the jet. */
const DROPS = 16

/** Sprinklers on the front lawns of a few homes (about one in twelve). */
export function placeSprinklers(town: Town, s: Pick<OutbreakDetailSettings, "lifeTouches" | "lfSprinkler" | "dtSeed">): Sprinkler[] {
  const out: Sprinkler[] = []
  if (!s.lifeTouches || !s.lfSprinkler) return out
  for (const b of town.buildings) {
    if (!isHome(b)) continue
    const r = detailRng(town, s.dtSeed, `sprinkler:${b.id}`)
    if (r.next() >= 0.085) continue
    const street = streetLine(b)
    for (let t = 0; t < 8; t++) {
      const x = b.rect[0] + 1 + r.next() * Math.max(0.5, b.rect[2] - b.rect[0] - 2)
      const z = b.rect[3] + 1.6 + r.next() * Math.max(0.3, street - b.rect[3] - 2.6)
      if (!outdoorFree(town, x, z, 0.6, [])) continue
      out.push({ key: `sprinkler:${b.id}`, x, z, y: supportHeight(town, x, z), facing: Math.PI / 2 + (r.next() - 0.5) * 0.6, seed: r.next() })
      break
    }
  }
  return out
}

/** Reach (m) of the jet on the morning after `night` (full the first day, gone by the fifth); `decay` off keeps it full. */
export function sprinklerReach(night: number, decay: boolean): number {
  const n = decay ? Math.max(1, night) : 1
  return SPRINKLER_REACH * ([1, 0.8, 0.55, 0.3][n - 1] ?? 0)
}

/**
 * The jet's angle across its arc at `time`: an impact head ticks forward in small steps over about nine seconds,
 * then snaps back in one and a half.
 */
export function jetAngle(time: number, facing: number, seed: number): number {
  const period = 10.5
  const u = (((time + seed * period) % period) + period) % period
  const half = Math.PI * 0.45
  if (u < 9) {
    const steps = 36
    return facing - half + (Math.floor((u / 9) * steps) / steps) * half * 2
  }
  return facing + half - ((u - 9) / 1.5) * half * 2
}

/**
 * Alpha sprites for the jets running at `hour` in `view`: drops along an arc from the head, each one where the jet
 * pointed when it left, so the stream bends as the head ticks round. `light(x, z)` is daylight or a torch (0..1).
 */
export function writeSprinklers(list: readonly Sprinkler[], time: number, hour: number, reach: number, light: (x: number, z: number) => number, view: readonly [number, number, number, number], sprites: Float32Array, n: number): number {
  if (reach <= 0 || hour < SPRINKLER_ON || hour >= SPRINKLER_OFF) return n
  // It hisses up to pressure over a few seconds' worth of the clock and dies away at the end.
  const ramp = Math.min(1, (hour - SPRINKLER_ON) / 0.02, (SPRINKLER_OFF - hour) / 0.02)
  const [x0, z0, x1, z1] = view
  for (const s of list) {
    if (s.x < x0 - reach || s.x > x1 + reach || s.z < z0 - reach || s.z > z1 + reach) continue
    const lit = light(s.x, s.z)
    if (lit <= 0.03) continue
    const r = reach * ramp
    for (let i = 0; i < DROPS; i++) {
      const u = (i + 0.5) / DROPS
      const a = jetAngle(time - u * 0.55, s.facing, s.seed)
      const jitter = Math.sin(i * 7.31 + time * 9) * 0.04
      const d = u * r
      const x = s.x + Math.cos(a + jitter) * d
      const z = s.z + Math.sin(a + jitter) * d
      const y = s.y + 0.12 + 4 * 0.75 * u * (1 - u) * (r / SPRINKLER_REACH)
      const k = 0.62 * lit
      n = putSprite(sprites, n, x, y, z, 0.05 + u * 0.07, k, k * 1.02, k * 1.03, (0.4 - 0.2 * u) * lit)
    }
  }
  return n
}
