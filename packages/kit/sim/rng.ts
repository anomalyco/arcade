/** Small seeded PRNG (mulberry32). Deterministic on both ends. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export class Rng {
  private s: number

  constructor(seed: number) {
    this.s = seed >>> 0
  }

  getState(): number {
    return this.s >>> 0
  }

  setState(state: number): void {
    this.s = state >>> 0
  }

  clone(): Rng {
    const out = new Rng(0)
    out.s = this.s
    return out
  }

  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0
    let t = this.s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next()
  }

  int(n: number): number {
    return Math.floor(this.next() * n)
  }

  pick<T>(xs: readonly T[]): T {
    return xs[this.int(xs.length)]!
  }

  /** A fresh u32 seed for a sub-generator. */
  seed(): number {
    return Math.floor(this.next() * 4294967296) >>> 0
  }
}

export function seedOf(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return h >>> 0
}

/** Stateless integer hash of two ints to [0, 1). Integer-only, so every JS engine agrees. */
export function hash2(a: number, b: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/** Stateless integer hash of three ints (two coordinates and a seed) to [0, 1). */
export function hash3(a: number, b: number, seed: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}
