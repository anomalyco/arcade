/**
 * Deterministic sea: a seeded sum of Gerstner (trochoidal) waves, a pure function of (seed, sea time).
 *
 * Every wave i moves along the unit plan direction d_i with phase θ_i = k_i (d_i · p) - ω_i t + φ_i, where p is the
 * REST position and ω_i = sqrt(g k_i) (deep water). The displaced surface point is
 *   p + Σ Q_i A_i d_i cos θ_i   horizontally,   Σ A_i sin θ_i   vertically.
 * Σ Q_i k_i A_i < 1 keeps the plan Jacobian positive definite, so the surface never loops over itself.
 *
 * Rest-position functions (mirror the GPU): seaDisplace, seaSlope, seaFoam.
 * Plan-position functions (solve for the rest position first, for buoyancy): seaHeight, seaNormal, seaRest.
 *
 * No DOM or Worker APIs: this runs in the Durable Object, the browser and ship physics.
 */

export type Wave = {
  dirX: number
  dirZ: number
  /** Wavenumber 2π/λ in rad/m. */
  k: number
  /** Angular frequency sqrt(g k) in rad/s. */
  omega: number
  /** Vertical amplitude A in metres (crest-to-trough 2A). */
  amp: number
  /** Gerstner steepness Q (horizontal amplitude is steep·amp). Above 1 is allowed: only Σ Q k A < 1 prevents loops. */
  steep: number
  /** Seeded initial phase φ in [0, 2π). */
  phase: number
}

export type Sea = {
  seed: number
  waves: Wave[]
  /** Unit plan direction the wind blows (and chop travels) toward. */
  wind: [number, number]
  /** Unit plan direction the primary swell travels toward. */
  swell: [number, number]
  /** Foam mapping: foam = smoothstep(lo, hi, (1 - det J) + height · y). */
  foam: [lo: number, hi: number, height: number]
}

export const SEA_GRAVITY = 9.81
export const SEA_MAX_WAVES = 16
/** Snap grid for the shader origin. Keep |p - origin| within a few km so f32 stays at millimetre precision. */
export const SEA_ORIGIN_GRID = 1024

/** Float offsets of the members of WGSL `struct SeaUniform` (see sea.wgsl.ts). */
export const SEA_UNIFORM_LAYOUT = {
  /** array<vec4f, 16>: dirX, dirZ, k, phase (rad in [0, 2π), at the origin and time passed to packSea). */
  waves: 0,
  /** array<vec4f, 16>: A, Q·A, Q·A·k, A·k. */
  shape: SEA_MAX_WAVES * 4,
  /** vec4f: origin x, origin z (world metres), wave count, 0. */
  origin: SEA_MAX_WAVES * 8,
  /** vec4f: foam lo, foam hi, foam height weight (1/m), 0. */
  foam: SEA_MAX_WAVES * 8 + 4,
} as const
/** 136 floats = 544 bytes. */
export const SEA_UNIFORM_FLOATS = SEA_MAX_WAVES * 8 + 8

const TAU = Math.PI * 2
const DEG = Math.PI / 180

function mulberry32(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function wave(angle: number, lambda: number, amp: number, steep: number, phase: number): Wave {
  const k = TAU / lambda
  return { dirX: Math.cos(angle), dirZ: Math.sin(angle), k, omega: Math.sqrt(SEA_GRAVITY * k), amp, steep, phase }
}

/** n wavelengths log-stratified over [lo, hi]: one random pick per band, so they spread out and are incommensurate. */
function bands(rnd: () => number, n: number, lo: number, hi: number): number[] {
  const out: number[] = []
  const a = Math.log(lo)
  const step = (Math.log(hi) - a) / n
  for (let i = 0; i < n; i++) out.push(Math.exp(a + step * (i + 0.15 + 0.7 * rnd())))
  return out
}

/** Upper bound for Σ Q k A. Below 1 the surface cannot loop; 0.85 leaves margin for sharp, low-poly crests. */
const MAX_STEEPNESS = 0.85
/** Σ Q k A of the primary swell (sharp, cusped Gerstner crests on the long swell). */
const PRIMARY_STEEPNESS: [lo: number, hi: number] = [0.6, 0.72]
/** Wavelength ratio of the two components of a swell pair: they beat into sets of big waves with lulls between. */
const PAIR_RATIO: [lo: number, hi: number] = [1.1, 1.16]

/**
 * A few big, long, rolling swells on a sunny day (never stormy): the 330 m carrier rides one or two crests at a time
 * and visibly rises, falls and pitches on them. Per seed:
 * - primary swell, 4 components in two close-wavelength pairs: 250-340 m and 165-225 m (each partner 10-16% longer,
 *   the partners 8-24° apart on either side of the swell direction), significant height 7.5-9 m. They beat into sets
 *   2-4 km long, so crest-to-trough runs ~6-8 m and reaches ~10-12 m on a set, and the crests are long but irregular.
 *   Crests are sharpened by giving the primary swell Gerstner Q > 1 (its Σ Q k A 0.6-0.72: trochoidal peaks and long
 *   flat troughs), while the whole sea stays below Σ Q k A = 0.85 so it never loops;
 * - one weak 90-130 m swell near the swell direction and one 140-240 m cross swell 40-80° off: shape, not clutter;
 * - chop: 5 faint components, 8-28 m, within ±60° of the wind (itself within ±35° of the swell), kA 0.005-0.013:
 *   texture up close only.
 */
export function makeSea(seed: number): Sea {
  const rnd = mulberry32(seed ^ 0x5ea5ea)
  const range = (lo: number, hi: number) => lo + (hi - lo) * rnd()
  const swellAngle = rnd() * TAU
  const windAngle = swellAngle + range(-35, 35) * DEG
  const energy = rnd()
  const waves: Wave[] = []

  // Primary swell: [λ, direction offset (deg), jitter (deg), weight]. Each pair's partners travel on either side of
  // the swell direction, so crests run long but end and shift where the partners cancel instead of endless stripes.
  const a = range(250, 340)
  const b = range(165, 225)
  const da = range(4, 12)
  const db = range(4, 10)
  const parts: [number, number, number, number][] = [
    [a, -da, 2, 1],
    [a * range(...PAIR_RATIO), da, 2, range(0.6, 0.75)],
    [b, db, 2, range(0.55, 0.7)],
    [b * range(...PAIR_RATIO), -db, 2, range(0.35, 0.5)],
  ]
  const primary = parts.length
  const hs = 7.5 + 1.5 * energy
  // Hs = 4 sqrt(Σ A² / 2) = 2√2 · sqrt(Σ A²)
  const norm = hs / (2 * Math.SQRT2 * Math.hypot(...parts.map((p) => p[3])))
  for (const [lambda, off, jit, weight] of parts) waves.push(wave(swellAngle + (off + range(-jit, jit)) * DEG, lambda, weight * norm, 1, rnd() * TAU))
  // Sharpen the primary crests: one shared Q so Σ Q k A over the primary swell hits the target.
  const target = PRIMARY_STEEPNESS[0] + (PRIMARY_STEEPNESS[1] - PRIMARY_STEEPNESS[0]) * energy
  const primaryKA = waves.reduce((sum, w) => sum + w.k * w.amp, 0)
  for (const w of waves) w.steep = target / primaryKA

  // Shape: a weak shorter swell along the primary, and a long cross swell.
  waves.push(wave(swellAngle + range(-20, 20) * DEG, range(90, 130), norm * range(0.12, 0.18), 1, rnd() * TAU))
  const side = rnd() < 0.5 ? -1 : 1
  waves.push(wave(swellAngle + side * range(40, 80) * DEG, range(140, 240), norm * range(0.22, 0.32), 1, rnd() * TAU))

  const chopScale = 0.7 + 0.5 * energy
  for (const lambda of bands(rnd, 5, 8, 28)) {
    const angle = windAngle + range(-60, 60) * DEG
    const k = TAU / lambda
    waves.push(wave(angle, lambda, (range(0.007, 0.011) * chopScale) / k, range(0.5, 0.7), rnd() * TAU))
  }

  // No two waves may share a wavelength (the pattern would tile): nudge near-duplicates apart.
  for (let i = 1; i < waves.length; i++)
    for (let j = 0; j < i; j++)
      if (Math.abs(waves[i]!.k / waves[j]!.k - 1) < 0.002) {
        const w = waves[i]!
        Object.assign(w, wave(Math.atan2(w.dirZ, w.dirX), ((TAU / w.k) * 1.004), w.amp, w.steep, w.phase))
      }

  const steepness = waves.reduce((sum, w) => sum + w.steep * w.k * w.amp, 0)
  if (steepness > MAX_STEEPNESS) for (const w of waves) w.steep *= MAX_STEEPNESS / steepness

  // Foam input f = (1 - det J) + h·y ≈ Σ (Q k A + h A) sin θ to first order, mean ≈ 0, so with σ² = Σ (QkA + hA)² / 2
  // foam starts at +1.3σ (≈10% of the surface) and saturates at +2.3σ. h ties foam to swell crests.
  const height = 0.35 / waves.slice(0, primary).reduce((sum, w) => sum + w.amp, 0)
  const sigma = Math.sqrt(waves.reduce((sum, w) => sum + (w.steep * w.k * w.amp + height * w.amp) ** 2, 0) / 2)

  return {
    seed,
    waves,
    wind: [Math.cos(windAngle), Math.sin(windAngle)],
    swell: [Math.cos(swellAngle), Math.sin(swellAngle)],
    foam: [1.3 * sigma, 2.3 * sigma, height],
  }
}

export const SEA_DETAIL_WAVES = 8

/**
 * Optional cosmetic detail band: 8 short Gerstner waves (λ 2-8 m, kA 0.008-0.015, Q 0.5) within ±70° of the wind.
 * They are a pure function of the seed like the main sea, so every client draws the same ripples, but they are 1-6 cm
 * high and only render near the camera, so physics ignores them. Seeded from `seed ^ 0xde7a11`; does not change
 * makeSea or any other function here.
 */
export function makeSeaDetail(sea: Sea): Wave[] {
  const rnd = mulberry32(sea.seed ^ 0xde7a11)
  const range = (lo: number, hi: number) => lo + (hi - lo) * rnd()
  const wind = Math.atan2(sea.wind[1], sea.wind[0])
  const out: Wave[] = []
  for (const lambda of bands(rnd, SEA_DETAIL_WAVES, 2, 8)) {
    const k = TAU / lambda
    out.push(wave(wind + range(-70, 70) * DEG, lambda, range(0.008, 0.015) / k, 0.5, rnd() * TAU))
  }
  return out
}

/**
 * Full evaluation at rest position (x, z):
 * [0] dx, [1] y, [2] dz, [3] ∂Dx/∂x, [4] ∂Dx/∂z (= ∂Dz/∂x), [5] ∂Dz/∂z, [6] ∂y/∂x, [7] ∂y/∂z.
 */
function evaluate(sea: Sea, x: number, z: number, t: number, s: Float64Array): Float64Array {
  s.fill(0)
  for (const w of sea.waves) {
    const th = w.k * (w.dirX * x + w.dirZ * z) - w.omega * t + w.phase
    const c = Math.cos(th)
    const sn = Math.sin(th)
    const qa = w.steep * w.amp
    s[0]! += qa * w.dirX * c
    s[1]! += w.amp * sn
    s[2]! += qa * w.dirZ * c
    const j = qa * w.k * sn
    s[3]! -= j * w.dirX * w.dirX
    s[4]! -= j * w.dirX * w.dirZ
    s[5]! -= j * w.dirZ * w.dirZ
    const g = w.amp * w.k * c
    s[6]! += g * w.dirX
    s[7]! += g * w.dirZ
  }
  return s
}

const scratch = new Float64Array(8)

/** Displaced surface offset [dx, y, dz] for the rest position (x, z) at sea time t. */
export function seaDisplace(sea: Sea, x: number, z: number, t: number, out = new Float64Array(3)): Float64Array {
  out.fill(0)
  for (const w of sea.waves) {
    const th = w.k * (w.dirX * x + w.dirZ * z) - w.omega * t + w.phase
    const c = Math.cos(th)
    const qa = w.steep * w.amp
    out[0]! += qa * w.dirX * c
    out[1]! += w.amp * Math.sin(th)
    out[2]! += qa * w.dirZ * c
  }
  return out
}

/** Height gradient, foam and Jacobian determinant at the point displaced from rest position s. */
function slopeOf(sea: Sea, s: Float64Array, out: Float64Array): Float64Array {
  const xx = 1 + s[3]!
  const xz = s[4]!
  const zz = 1 + s[5]!
  const det = xx * zz - xz * xz
  // (∂y/∂x, ∂y/∂z) = Jᵀ ∇h and J is symmetric, so ∇h = J⁻¹ (∂y/∂x, ∂y/∂z).
  out[0] = (zz * s[6]! - xz * s[7]!) / det
  out[1] = (xx * s[7]! - xz * s[6]!) / det
  out[2] = smoothstep(sea.foam[0], sea.foam[1], 1 - det + sea.foam[2] * s[1]!)
  out[3] = det
  return out
}

function smoothstep(lo: number, hi: number, x: number): number {
  const u = Math.min(1, Math.max(0, (x - lo) / (hi - lo)))
  return u * u * (3 - 2 * u)
}

/**
 * CPU mirror of WGSL `seaSlope` for rest position (x, z): [dh/dX, dh/dZ, foam 0..1, det J].
 * The gradient is that of the displaced surface at the point the rest position moves to. (WGSL returns w = 0.)
 */
export function seaSlope(sea: Sea, x: number, z: number, t: number, out = new Float64Array(4)): Float64Array {
  return slopeOf(sea, evaluate(sea, x, z, t, scratch), out)
}

/** Crest foam 0..1 for rest position (x, z), as the shader computes it. */
export function seaFoam(sea: Sea, x: number, z: number, t: number): number {
  return seaSlope(sea, x, z, t, slopeScratch)[2]!
}
const slopeScratch = new Float64Array(4)

/**
 * Rest position whose displaced plan position is (x, z). Newton's method on p + D(p) = (x, z) with the analytic
 * Jacobian, which is positive definite everywhere, converging to < 1 µm in 3-5 steps.
 */
export function seaRest(sea: Sea, x: number, z: number, t: number, out = new Float64Array(2)): Float64Array {
  let px = x
  let pz = z
  for (let i = 0; i < 8; i++) {
    const s = evaluate(sea, px, pz, t, scratch)
    const ex = px + s[0]! - x
    const ez = pz + s[2]! - z
    if (ex * ex + ez * ez < 1e-12) break
    const xx = 1 + s[3]!
    const xz = s[4]!
    const zz = 1 + s[5]!
    const det = xx * zz - xz * xz
    px -= (zz * ex - xz * ez) / det
    pz -= (xx * ez - xz * ex) / det
  }
  // seaHeight and seaNormal read the evaluation at the solution from `scratch`.
  evaluate(sea, px, pz, t, scratch)
  out[0] = px
  out[1] = pz
  return out
}
const restScratch = new Float64Array(2)

/** Surface height at plan point (x, z) and sea time t. For buoyancy. */
export function seaHeight(sea: Sea, x: number, z: number, t: number): number {
  seaRest(sea, x, z, t, restScratch)
  return scratch[1]!
}

/** Unit surface normal at plan point (x, z) and sea time t. */
export function seaNormal(sea: Sea, x: number, z: number, t: number, out = new Float64Array(3)): Float64Array {
  seaRest(sea, x, z, t, restScratch)
  slopeOf(sea, scratch, slopeScratch)
  const gx = slopeScratch[0]!
  const gz = slopeScratch[1]!
  const inv = 1 / Math.sqrt(gx * gx + 1 + gz * gz)
  out[0] = -gx * inv
  out[1] = inv
  out[2] = -gz * inv
  return out
}

/** Snap a world coordinate to the shader origin grid. Use for both axes of the camera position. */
export function snapSeaOrigin(v: number): number {
  return Math.round(v / SEA_ORIGIN_GRID) * SEA_ORIGIN_GRID
}

/**
 * Packs the waves and their phases at sea time t into the GPU uniform (SEA_UNIFORM_FLOATS floats, layout in
 * SEA_UNIFORM_LAYOUT). Each phase k (d · origin) - ω t + φ is computed in float64 and wrapped to [0, 2π), so the
 * shader never sees a large time or a large coordinate. originX/originZ must be multiples of SEA_ORIGIN_GRID near the
 * camera (snapSeaOrigin), and the shader must be given positions relative to that origin. Call every frame.
 */
export function packSea(sea: Sea, t: number, out: Float32Array, originX = 0, originZ = 0): void {
  out.fill(0, 0, SEA_UNIFORM_FLOATS)
  const n = Math.min(sea.waves.length, SEA_MAX_WAVES)
  for (let i = 0; i < n; i++) {
    const w = sea.waves[i]!
    const phase = w.k * (w.dirX * originX + w.dirZ * originZ) - w.omega * t + w.phase
    let o = SEA_UNIFORM_LAYOUT.waves + i * 4
    out[o] = w.dirX
    out[o + 1] = w.dirZ
    out[o + 2] = w.k
    out[o + 3] = phase - TAU * Math.floor(phase / TAU)
    o = SEA_UNIFORM_LAYOUT.shape + i * 4
    const qa = w.steep * w.amp
    out[o] = w.amp
    out[o + 1] = qa
    out[o + 2] = qa * w.k
    out[o + 3] = w.amp * w.k
  }
  out[SEA_UNIFORM_LAYOUT.origin] = originX
  out[SEA_UNIFORM_LAYOUT.origin + 1] = originZ
  out[SEA_UNIFORM_LAYOUT.origin + 2] = n
  out[SEA_UNIFORM_LAYOUT.foam] = sea.foam[0]
  out[SEA_UNIFORM_LAYOUT.foam + 1] = sea.foam[1]
  out[SEA_UNIFORM_LAYOUT.foam + 2] = sea.foam[2]
}
