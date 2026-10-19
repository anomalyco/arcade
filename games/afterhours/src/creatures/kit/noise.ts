// Deterministic 3D gradient noise for geometric skin detail (folds, veins, ridges). Range roughly -1..1.

const perm = new Uint8Array(512)
const grad = new Float32Array(256 * 3)
{
  let s = 1337
  const r = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296)
  const p = Array.from({ length: 256 }, (_, i) => i)
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(r() * (i + 1))
    ;[p[i], p[j]] = [p[j]!, p[i]!]
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255]!
  for (let i = 0; i < 256; i++) {
    const z = r() * 2 - 1
    const a = r() * Math.PI * 2
    const q = Math.sqrt(1 - z * z)
    grad[i * 3] = q * Math.cos(a)
    grad[i * 3 + 1] = q * Math.sin(a)
    grad[i * 3 + 2] = z
  }
}

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10)

function g(h: number, x: number, y: number, z: number) {
  const i = perm[h]! * 3
  return grad[i]! * x + grad[i + 1]! * y + grad[i + 2]! * z
}

export function noise3(x: number, y: number, z: number): number {
  const X = Math.floor(x)
  const Y = Math.floor(y)
  const Z = Math.floor(z)
  const fx = x - X
  const fy = y - Y
  const fz = z - Z
  const xi = X & 255
  const yi = Y & 255
  const zi = Z & 255
  const u = fade(fx)
  const v = fade(fy)
  const w = fade(fz)
  const a = perm[xi]! + yi
  const aa = perm[a]! + zi
  const ab = perm[a + 1]! + zi
  const b = perm[xi + 1]! + yi
  const ba = perm[b]! + zi
  const bb = perm[b + 1]! + zi
  const x1 = g(aa, fx, fy, fz) + u * (g(ba, fx - 1, fy, fz) - g(aa, fx, fy, fz))
  const x2 = g(ab, fx, fy - 1, fz) + u * (g(bb, fx - 1, fy - 1, fz) - g(ab, fx, fy - 1, fz))
  const x3 = g(aa + 1, fx, fy, fz - 1) + u * (g(ba + 1, fx - 1, fy, fz - 1) - g(aa + 1, fx, fy, fz - 1))
  const x4 = g(ab + 1, fx, fy - 1, fz - 1) + u * (g(bb + 1, fx - 1, fy - 1, fz - 1) - g(ab + 1, fx, fy - 1, fz - 1))
  const y1 = x1 + v * (x2 - x1)
  const y2 = x3 + v * (x4 - x3)
  return (y1 + w * (y2 - y1)) * 1.6
}

export function fbm3(x: number, y: number, z: number, octaves = 4, lac = 2.03, gain = 0.5): number {
  let s = 0
  let a = 1
  let n = 0
  for (let i = 0; i < octaves; i++) {
    s += noise3(x, y, z) * a
    n += a
    a *= gain
    x = x * lac + 17.1
    y = y * lac + 3.7
    z = z * lac + 9.3
  }
  return s / n
}

/** Thin raised ridges (0..1) along the zero set of the noise: veins, tendons, cracks. */
export function ridge3(x: number, y: number, z: number, sharp = 8): number {
  const n = 1 - Math.abs(noise3(x, y, z))
  return Math.pow(Math.max(0, n), sharp)
}

/** Deterministic 0..1 sequence. */
export function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
