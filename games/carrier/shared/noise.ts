/**
 * Deterministic 2D gradient noise and fbm. Integer hashing plus plain float maths, so the browser and the Durable
 * Object agree. Allocation-free; meant to be sampled millions of times.
 */

const GX = new Float64Array(16)
const GZ = new Float64Array(16)
for (let i = 0; i < 16; i++) {
  const a = ((i + 0.5) / 16) * Math.PI * 2
  GX[i] = Math.cos(a)
  GZ[i] = Math.sin(a)
}

function grad(ix: number, iz: number, seed: number, dx: number, dz: number): number {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iz, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h ^= h >>> 13
  const g = h & 15
  return GX[g]! * dx + GZ[g]! * dz
}

/** Gradient noise in roughly [-1, 1], one feature per unit. */
export function noise2(seed: number, x: number, z: number): number {
  const fx = Math.floor(x)
  const fz = Math.floor(z)
  const dx = x - fx
  const dz = z - fz
  const ix = fx | 0
  const iz = fz | 0
  const ux = dx * dx * dx * (dx * (dx * 6 - 15) + 10)
  const uz = dz * dz * dz * (dz * (dz * 6 - 15) + 10)
  const a = grad(ix, iz, seed, dx, dz)
  const b = grad(ix + 1, iz, seed, dx - 1, dz)
  const c = grad(ix, iz + 1, seed, dx, dz - 1)
  const d = grad(ix + 1, iz + 1, seed, dx - 1, dz - 1)
  const ab = a + (b - a) * ux
  const cd = c + (d - c) * ux
  return (ab + (cd - ab) * uz) * 1.41
}

/** Fractal sum of `octaves` noise layers (lacunarity 2, gain 0.5), normalised to roughly [-1, 1]. */
export function fbm(seed: number, x: number, z: number, octaves: number): number {
  let sum = 0
  let amp = 1
  let norm = 0
  for (let o = 0; o < octaves; o++) {
    sum += noise2(seed + o * 1013, x, z) * amp
    norm += amp
    amp *= 0.5
    // Rotate a little between octaves so lattice artefacts do not line up.
    const nx = x * 1.6 - z * 1.2
    z = x * 1.2 + z * 1.6
    x = nx
  }
  return sum / norm
}

/** Ridged fbm in [0, 1]: sharp crests where the noise crosses zero. */
export function ridged(seed: number, x: number, z: number, octaves: number): number {
  let sum = 0
  let amp = 1
  let norm = 0
  for (let o = 0; o < octaves; o++) {
    const n = 1 - Math.abs(noise2(seed + o * 1013, x, z))
    sum += n * n * amp
    norm += amp
    amp *= 0.5
    const nx = x * 1.6 - z * 1.2
    z = x * 1.2 + z * 1.6
    x = nx
  }
  return sum / norm
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}
