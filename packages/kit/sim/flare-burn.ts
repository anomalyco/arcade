/**
 * A road flare's burn as pure functions of (seed, age): the sputter and the phases (strike, flare-up, burn, gutter,
 * embers). No DOM or GPU, so a game's shared sim can read how bright a flare is (a creature's backdrop, a spider that
 * flees light) and every client agrees with the picture `fx/flare` draws.
 */

/** Integer hash to [0, 1). */
export function flareHash(a: number, b: number): number {
  let h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b | 0) + 0x632be5ab, 0xc2b2ae35)
  h ^= h >>> 15
  h = Math.imul(h, 0x2c1b3c6d)
  h ^= h >>> 12
  h = Math.imul(h, 0x297a2d39)
  h ^= h >>> 15
  return (h >>> 0) / 4294967296
}

/** Smooth value noise in [-1, 1]. */
function noise1(t: number, seed: number): number {
  const i = Math.floor(t)
  const f = t - i
  const u = f * f * (3 - 2 * f)
  return (flareHash(i, seed) * 2 - 1) * (1 - u) + (flareHash(i + 1, seed) * 2 - 1) * u
}

/**
 * The flare's sputter at `age` seconds: ~1 on average, a fast 8–25 Hz flutter, a slow breath, and every so often a
 * pop where the flame chokes on slag for a few hundredths of a second and catches again. `amount` scales the depth.
 */
export function flareFlicker(seed: number, age: number, amount = 1): number {
  if (amount <= 0) return 1
  const fast = noise1(age * 23, seed) * 0.6 + noise1(age * 9.3, seed + 1) * 0.4
  const slow = noise1(age * 0.8, seed + 2)
  // Pops: a 70 ms cell fires with 9% chance; the dip snaps in and recovers over ~45 ms.
  const cell = Math.floor(age / 0.07)
  let pop = 0
  if (flareHash(cell, seed + 3) < 0.09 * Math.min(2, amount)) {
    const into = age - cell * 0.07
    const depth = 0.22 + 0.25 * flareHash(cell, seed + 4)
    pop = depth * Math.exp(-into / 0.045)
  }
  const level = 1 + amount * (0.11 * fast + 0.05 * slow) - Math.min(1, amount) * pop
  return Math.max(0.3, level)
}

export type FlarePhase = "unlit" | "strike" | "burn" | "gutter" | "embers" | "out"

/** What the burn looks like at `age` (s since the cap was struck). */
export type FlareEnvelope = {
  phase: FlarePhase
  /** Light and flame output before the flicker (strike flare-up peaks near 2). */
  level: number
  /** 0 burning red, 1 guttering orange slag. */
  heat: number
  /** Extra sputter while guttering (× flicker). */
  sputter: number
  /** Smoke output (×). */
  smoke: number
}

export const FLARE_STRIKE = 0.18
const FLARE_FLAREUP = 1.1
const GUTTER = 10
const EMBERS = 14

export function flareEnvelope(age: number, burn: number): FlareEnvelope {
  if (age < 0) return { phase: "unlit", level: 0, heat: 0, sputter: 1, smoke: 0 }
  if (age < FLARE_STRIKE) {
    // The striker catches: a spitting ramp to the flare-up.
    const k = age / FLARE_STRIKE
    return { phase: "strike", level: 2.1 * k * k, heat: 0.25, sputter: 1.8, smoke: 0.6 * k }
  }
  const gutterAt = Math.max(FLARE_FLAREUP + 1, burn - GUTTER)
  if (age < gutterAt) {
    const k = Math.min(1, (age - FLARE_STRIKE) / (FLARE_FLAREUP - FLARE_STRIKE))
    const level = 1 + 1.1 * (1 - k) * (1 - k)
    return { phase: "burn", level, heat: 0, sputter: 1, smoke: 1 + 0.6 * (1 - k) }
  }
  if (age < burn) {
    const k = (age - gutterAt) / Math.max(0.01, burn - gutterAt)
    return { phase: "gutter", level: 1 - 0.75 * k * k, heat: k, sputter: 1 + 1.4 * k, smoke: 1 - 0.4 * k }
  }
  if (age < burn + EMBERS) {
    const k = (age - burn) / EMBERS
    return { phase: "embers", level: 0.06 * (1 - k) * (1 - k), heat: 1, sputter: 2, smoke: 0.35 * (1 - k) }
  }
  return { phase: "out", level: 0, heat: 1, sputter: 0, smoke: 0 }
}
