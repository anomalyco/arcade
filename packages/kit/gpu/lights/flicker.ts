import type { LabControl } from "../../lab-panel"

/**
 * Lamp flicker and failure as pure functions of (kind, seed, time): no state, so every client in a co-op game, a
 * scrubbed replay and a paired capture see the same lamp do the same thing at the same moment, and frame rate never
 * changes it. Behaviours follow Aiden's Ashwood rig (`render/lighting.ts` `flickerLevel`), made stateless:
 *
 * - fluorescent: a faint ballast hum, long steady stretches, then a stutter burst or a drop-out with the starter's
 *   blink-blink-ignite;
 * - sodium (dying high-pressure sodium): burns, sags and goes out, sits dark, restrikes dim and pinkish and warms back
 *   to orange over several seconds (`warmth` 0 → 1);
 * - incandescent: a gentle brown-out wander;
 * - beacon: a filament pulse;
 * - steady: always 1.
 *
 * `amount` 0 is a steady lamp; 1 is Ashwood's default; 2 fails twice as often.
 */
export type FlickerKind = "steady" | "fluorescent" | "sodium" | "incandescent" | "beacon"

export type FlickerSample = {
  /** Output multiplier, 0..~1.05. */
  level: number
  /** Sodium arc temperature, 0 cold (pinkish, restriking) to 1 warm. Other kinds stay 1. */
  warmth: number
}

/** Integer hash to [0, 1). */
export function hash01(a: number, b = 0): number {
  let h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b | 0) + 0x632be5ab, 0xc2b2ae35)
  h ^= h >>> 15
  h = Math.imul(h, 0x2c1b3c6d)
  h ^= h >>> 12
  h = Math.imul(h, 0x297a2d39)
  h ^= h >>> 15
  return (h >>> 0) / 4294967296
}

/** Smooth 1D value noise in [-1, 1]. */
function noise1(t: number, seed: number): number {
  const i = Math.floor(t)
  const f = t - i
  const u = f * f * (3 - 2 * f)
  return (hash01(i, seed) * 2 - 1) * (1 - u) + (hash01(i + 1, seed) * 2 - 1) * u
}

const smooth = (k: number) => k * k * (3 - 2 * k)

/** Durations of one dying-sodium cycle for this lamp (seconds), before dividing the burn by `amount`. */
export function sodiumCycle(seed: number): { burn: number; sag: number; off: number; restrike: number } {
  const h = hash01(seed, 101)
  return { burn: 12 + h * 40, sag: 2.5 + h * 2, off: 5 + hash01(seed, 102) * 9, restrike: 7 + hash01(seed, 103) * 5 }
}

function sodium(seed: number, time: number, amount: number): FlickerSample {
  const c = sodiumCycle(seed)
  const burn = c.burn / amount
  const period = burn + c.sag + c.off + c.restrike
  const shifted = time + hash01(seed, 104) * period
  const k = Math.floor(shifted / period)
  // Not every cycle fails: a healthier lamp (lower amount) skips more of them.
  if (hash01(seed, k + 7) > Math.min(1, 0.35 + 0.45 * amount)) return { level: 1 + 0.015 * noise1(time * 0.7, seed), warmth: 1 }
  let t = shifted - k * period
  if (t < burn) return { level: 1 + 0.015 * noise1(time * 0.7, seed), warmth: 1 }
  t -= burn
  if (t < c.sag) {
    const p = t / c.sag
    return { level: Math.max(0.02, 1 - p * p * 0.98) * (1 + 0.04 * noise1(time * 9, seed)), warmth: 1 - 0.25 * p }
  }
  t -= c.sag
  if (t < c.off) return { level: 0.012, warmth: 0 }
  t -= c.off
  const p = t / c.restrike
  // The arc strikes with a blink, then climbs slowly as the lamp warms.
  const level = p < 0.03 ? (Math.floor(time * 20) % 2 ? 0.25 : 0.05) : 0.08 + 0.92 * smooth(p)
  return { level, warmth: p }
}

function fluorescent(seed: number, time: number, amount: number): FlickerSample {
  const hum = 1 - Math.min(1, amount) * (0.012 + 0.012 * noise1(time * 6, seed))
  // Time is cut into windows; each window holds at most one event at a hashed offset.
  const window = (3 + hash01(seed, 201) * 8) / amount
  const shifted = time + hash01(seed, 202) * window
  const k = Math.floor(shifted / window)
  const pick = hash01(seed, k * 2 + 1)
  if (pick > Math.min(0.85, 0.25 + 0.35 * amount)) return { level: hum, warmth: 1 }
  const local = shifted - k * window
  const dropout = hash01(seed, k * 2 + 2) < 0.35 * Math.min(1, amount) + 0.1
  if (dropout) {
    const dark = 0.3 + pick * 1.4
    const blinks = 2 + Math.floor(hash01(seed, k * 3 + 5) * 3)
    const total = dark + blinks * 0.32 + 0.12
    const start = hash01(seed, k * 3 + 6) * Math.max(0, window - total)
    const t = local - start
    if (t < 0 || t >= total) return { level: hum, warmth: 1 }
    if (t < dark) return { level: 0.01, warmth: 1 }
    const b = t - dark
    if (b < blinks * 0.32) return { level: (b % 0.32) / 0.32 < 0.18 ? 0.45 : 0.015, warmth: 1 }
    return { level: (0.5 + 0.5 * Math.min(1, (b - blinks * 0.32) / 0.12)) * hum, warmth: 1 }
  }
  const length = 0.15 + pick * 0.9 * Math.min(1, amount)
  const start = hash01(seed, k * 3 + 7) * Math.max(0, window - length)
  const t = local - start
  if (t < 0 || t >= length) return { level: hum, warmth: 1 }
  // Stutter: the tube toggles every 30–120 ms; each toggle's level is hashed from its index.
  const slot = Math.floor(t / 0.06)
  const on = hash01(seed * 31 + k, slot) > 0.45
  const level = on ? 0.65 + 0.35 * hash01(seed + 17, slot) : 0.02 + 0.08 * Math.max(0, 1 - amount)
  return { level: level * hum, warmth: 1 }
}

/** Output and warmth of a lamp at `time` (seconds). Pure; any frame rate gives the same answer. */
export function lampFlicker(kind: FlickerKind, seed: number, time: number, amount = 1): FlickerSample {
  if (kind === "beacon") {
    const k = Math.max(0, Math.min(1, amount))
    if (k <= 0) return { level: 1, warmth: 1 }
    const ph = (((time * 0.9 + hash01(seed, 301)) % 1) + 1) % 1
    const pulse = ph < 0.5 ? 1 - Math.exp(-ph * 30) : Math.exp(-(ph - 0.5) * 14)
    return { level: 1 - k * (1 - pulse), warmth: 1 }
  }
  if (kind === "steady" || amount <= 0) return { level: 1, warmth: 1 }
  if (kind === "incandescent") {
    const a = Math.min(1, amount)
    return { level: 1 - a * 0.12 * Math.max(0, noise1(time * 1.3, seed) * 0.6 + noise1(time * 7, seed + 3) * 0.4), warmth: 1 }
  }
  return kind === "sodium" ? sodium(seed, time, amount) : fluorescent(seed, time, amount)
}

/** Sodium colour at an arc warmth: cold sodium burns dim pinkish-red before it warms to orange (in place). */
export function coldSodiumTint(rgb: [number, number, number], warmth: number): [number, number, number] {
  if (warmth >= 1) return rgb
  const k = 1 - Math.max(0, warmth)
  rgb[1] *= 1 - 0.55 * k
  rgb[2] *= 1 - 0.1 * k
  return rgb
}

/** Lab row for the shared flicker amount. */
export function flickerControl(group = "Lighting", key = "flicker"): LabControl {
  return { key, label: "Lamp flicker and failure", group, min: 0, max: 2, step: 0.05, unit: "×" }
}
