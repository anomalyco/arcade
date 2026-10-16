// Small deterministic random helpers for procedural generation.

/** Mulberry32: fast seeded PRNG returning [0, 1). */
export function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export type Rng = ReturnType<typeof rng>

/** Hash of integer cell coordinates and a salt, in [0, 1). */
export function hash3(x: number, z: number, salt: number) {
  let h = Math.imul(x | 0, 0x8da6b343) ^ Math.imul(z | 0, 0xd8163841) ^ Math.imul(salt | 0, 0xcb1ab31f)
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d)
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t
export const range = (r: Rng, a: number, b: number) => a + (b - a) * r()
