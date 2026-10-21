/**
 * Wet ground as a material term, ported from Aiden's Ashwood `render/materials.ts` `wet()`. One world-space function
 * decides, per pixel of an upward-facing surface, how much water film and standing water it holds:
 *
 * - **Puddles:** two octaves of histogram-equalised value noise (41 m and 13 m tiles, scaled by `puddleScale`) plus the
 *   surface's cavities (1 − ambient occlusion from its texture, so water collects in the cracks first and puddles have
 *   ragged, grainy edges) above a waterline set by `puddles` × the material's own coverage. Standing water is a near-mirror (roughness 0.035), has a flat normal and darkens the
 *   albedo to 0.55.
 * - **Film:** everywhere else the surface is darker by the material's porosity and as glossy as its film roughness,
 *   with streaky drying (a 9 m noise), a damp rim round each puddle and 1–3 m sheen patches a little glossier still
 *   (broad smeared highlights rather than pixel-sized mirror spots that sparkle under a small bright lamp).
 * - **Normal:** the film fills part of the micro relief (30 % near, 80 % once a texel is under a pixel, so it cannot
 *   alias); standing water is flat.
 *
 * Because it is a pure function of world position, the scene pass (material hook) and the post passes (screen-space
 * reflections, wet fog reflections) evaluate the same puddles without a G-buffer. The game passes the global
 * settings as a `vec4f` (`wetUniform`) from its own uniform and each material its constants (`WetMaterial`).
 */
import type { LabControl } from "../../lab-navigation"

export type WetSettings = {
  /** 0 dry … 1 soaked. */
  wetness: number
  /** Standing-water coverage, 0 … 0.9. */
  puddles: number
  /** Puddle size multiplier. */
  puddleScale: number
  /** Ripple of the film's normal in post-pass reflections (puddles stay flat). */
  ripple: number
}

/** Ashwood's defaults (`materials.wetness`, `materials.puddles`, `materials.puddleScale`). */
export const WET_DEFAULTS: WetSettings = { wetness: 1, puddles: 0.32, puddleScale: 1, ripple: 0.5 }

/** Per-material constants: albedo darkening under the film, film roughness, puddle coverage multiplier. */
export type WetMaterial = { porosity: number; film: number; puddles: number }

/** Ashwood's asphalt (`asphalt_lot`): porosity 0.6, film 0.15, puddles 1.15. */
export const WET_ASPHALT: WetMaterial = { porosity: 0.6, film: 0.15, puddles: 1.15 }
export const WET_CONCRETE: WetMaterial = { porosity: 0.4, film: 0.3, puddles: 0.7 }
export const WET_GRAVEL: WetMaterial = { porosity: 0.45, film: 0.38, puddles: 0.55 }

/** The settings as the WGSL `vec4f` the functions take: wetness, puddles, puddle scale, ripple. */
export const packWet = (s: WetSettings): [number, number, number, number] => [s.wetness, s.puddles, s.puddleScale, s.ripple]

/** WGSL `vec4f` literal of a material's constants. */
export const wetMaterialWgsl = (m: WetMaterial): string => `vec4f(${m.porosity.toFixed(4)}, ${m.film.toFixed(4)}, ${m.puddles.toFixed(4)}, 0.0)`

export function wetControls(group = "Wet ground", prefix = ""): LabControl[] {
  const row = (k: keyof WetSettings, label: string, min: number, max: number, step: number, unit?: string): LabControl => ({
    key: prefix + k, ...(prefix ? { field: k } : {}), label, group, min, max, step, ...(unit ? { unit } : {}),
  })
  return [
    row("wetness", "Wetness", 0, 1, 0.01),
    row("puddles", "Puddle coverage", 0, 0.9, 0.01),
    row("puddleScale", "Puddle size", 0.3, 3, 0.05, "×"),
    row("ripple", "Film ripple in reflections", 0, 2, 0.05, "×"),
  ]
}

// ---------------------------------------------------------------- CPU mirror (tests)

const u32 = (x: number) => x >>> 0
/** PCG-style integer hash of a lattice point and a seed, to 0..1 (the WGSL `wetHash`). */
export function wetHash(x: number, y: number, seed: number): number {
  let h = u32(Math.imul(u32(x | 0), 0x8da6b343) ^ Math.imul(u32(y | 0), 0xd8163841) ^ Math.imul(u32(seed), 0xcb1ab31f))
  h = u32(Math.imul(h ^ (h >>> 16), 0x7feb352d))
  h = u32(Math.imul(h ^ (h >>> 15), 0x846ca68b))
  h = u32(h ^ (h >>> 16))
  return h / 4294967296
}

const fade = (t: number) => t * t * (3 - 2 * t)
function valueNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y)
  const fx = fade(x - ix), fy = fade(y - iy)
  const a = wetHash(ix, iy, seed), b = wetHash(ix + 1, iy, seed), c = wetHash(ix, iy + 1, seed), d = wetHash(ix + 1, iy + 1, seed)
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy
}

/** Spread of the raw 3-octave value-noise fbm around 0.5, fitted once (`wet.test.ts` checks the result is uniform). */
export const WET_NOISE_SIGMA = 0.14

/** Histogram-equalised fbm: roughly uniform on 0..1, so thresholds are coverage fractions (the WGSL `wetNoise`). */
export function wetNoise(x: number, y: number, seed: number): number {
  const raw = (valueNoise(x, y, seed) * 0.5714 + valueNoise(x * 2.03 + 17.1, y * 2.03 + 5.3, seed + 1) * 0.2857 + valueNoise(x * 4.07 + 3.7, y * 4.07 + 29.9, seed + 2) * 0.1429)
  return 0.5 + 0.5 * erf((raw - 0.5) / (WET_NOISE_SIGMA * Math.SQRT2))
}

/** Abramowitz–Stegun 7.1.26-style tanh fit of erf (the WGSL uses the same). */
export function erf(x: number): number {
  return Math.tanh(1.1283791671 * x * (1 + 0.0886226925 * x * x))
}

export type WetResult = { albedo: number; roughness: number; flat: number; puddle: number; film: number }

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}

/** CPU mirror of `wetSurface`. */
export function wetSurface(x: number, z: number, ny: number, rough: number, ao: number, footprint: number, s: WetSettings, m: WetMaterial): WetResult {
  const w = s.wetness
  const qx = x / s.puddleScale, qz = z / s.puddleScale
  const up = smooth(0.82, 0.97, ny)
  const h = wetNoise(qx / 41, qz / 41, 41) * 0.62 + wetNoise(qx / 13, qz / 13, 13) * 0.38 + (1 - ao) * 0.35
  const line = 1.12 - s.puddles * m.puddles * 0.82
  const aa = Math.max(0.035, footprint * 0.16 / s.puddleScale)
  const puddle = smooth(line, line + aa, h) * up * smooth(0.15, 0.6, w)
  const edge = smooth(line - 0.09, line, h) * up
  const dry = wetNoise(qx / 9, qz / 9, 9)
  const film = Math.max(w * (0.8 + 0.2 * dry), edge * w)
  const filmRough = m.film + 0.1 * dry
  const albedo = (1 - m.porosity * film) * (1 - 0.45 * puddle)
  const sheen = smooth(0.35, 0.85, wetNoise(x / 6, z / 6, 6)) * film
  let r = rough + (Math.min(rough, filmRough) - rough) * film
  r = r * (1 - 0.25 * sheen)
  r = r + (0.035 - r) * puddle
  const far = smooth(0.004, 0.03, footprint)
  const flatFilm = film * (0.3 + 0.5 * far)
  return { albedo, roughness: r, flat: 1 - (1 - flatFilm) * (1 - puddle), puddle, film }
}

// ---------------------------------------------------------------- WGSL

/**
 * `wetSurface(p, ny, rough, ao, footprint, W, M) -> WetSurface` and `wetRipple(p, W, flat) -> vec2f`. W is the
 * settings vec4 (`packWet`), M the material's (`wetMaterialWgsl`); ao the surface's ambient occlusion (1 where there is
 * no texture, as in post passes); footprint is metres per pixel (compute it at
 * fragment entry, where derivatives are allowed). Apply as `albedo *= s.albedo; pbrRough = s.roughness;
 * n = normalize(mix(n, geometricNormal, s.flat))`.
 */
export const wetSurfaceWgsl = /* wgsl */ `
struct WetSurface { albedo: f32, roughness: f32, flat: f32, puddle: f32, film: f32 }
fn wetHash(p: vec2i, seed: u32) -> f32 {
  var h = (bitcast<u32>(p.x) * 0x8da6b343u) ^ (bitcast<u32>(p.y) * 0xd8163841u) ^ (seed * 0xcb1ab31fu);
  h = (h ^ (h >> 16u)) * 0x7feb352du;
  h = (h ^ (h >> 15u)) * 0x846ca68bu;
  h = h ^ (h >> 16u);
  return f32(h) / 4294967296.0;
}
fn wetValueNoise(p: vec2f, seed: u32) -> f32 {
  let i = vec2i(floor(p));
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = wetHash(i, seed);
  let b = wetHash(i + vec2i(1, 0), seed);
  let c = wetHash(i + vec2i(0, 1), seed);
  let d = wetHash(i + vec2i(1, 1), seed);
  return a + (b - a) * u.x + (c - a) * u.y + (a - b - c + d) * u.x * u.y;
}
fn wetErf(x: f32) -> f32 { return tanh(clamp(1.1283791671 * x * (1.0 + 0.0886226925 * x * x), -15.0, 15.0)); }
/** Histogram-equalised value-noise fbm, roughly uniform on 0..1. */
fn wetNoise(p: vec2f, seed: u32) -> f32 {
  let raw = wetValueNoise(p, seed) * 0.5714 + wetValueNoise(p * 2.03 + vec2f(17.1, 5.3), seed + 1u) * 0.2857
    + wetValueNoise(p * 4.07 + vec2f(3.7, 29.9), seed + 2u) * 0.1429;
  return 0.5 + 0.5 * wetErf((raw - 0.5) / (${WET_NOISE_SIGMA} * 1.41421356));
}
fn wetSurface(p: vec3f, ny: f32, rough: f32, ao: f32, footprint: f32, W: vec4f, M: vec4f) -> WetSurface {
  let w = W.x;
  let q = p.xz / max(W.z, 0.01);
  let up = smoothstep(0.82, 0.97, ny);
  let h = wetNoise(q / 41.0, 41u) * 0.62 + wetNoise(q / 13.0, 13u) * 0.38 + (1.0 - ao) * 0.35;
  let line = 1.12 - W.y * M.z * 0.82;
  let aa = max(0.035, footprint * 0.16 / max(W.z, 0.01));
  let puddle = smoothstep(line, line + aa, h) * up * smoothstep(0.15, 0.6, w);
  let edge = smoothstep(line - 0.09, line, h) * up;
  let dry = wetNoise(q / 9.0, 9u);
  let film = max(w * mix(0.8, 1.0, dry), edge * w);
  let filmRough = M.y + 0.1 * dry;
  var s: WetSurface;
  s.albedo = (1.0 - M.x * film) * (1.0 - 0.45 * puddle);
  let sheen = smoothstep(0.35, 0.85, wetNoise(p.xz / 6.0, 6u)) * film;
  var r = mix(rough, min(rough, filmRough), film);
  r = r * (1.0 - 0.25 * sheen);
  s.roughness = mix(r, 0.035, puddle);
  let far = smoothstep(0.004, 0.03, footprint);
  s.flat = 1.0 - (1.0 - film * mix(0.3, 0.8, far)) * (1.0 - puddle);
  s.puddle = puddle;
  s.film = film;
  return s;
}
/** Tilt of the film's normal (xz) for post-pass reflections: 0.4 m relief scaled by ripple, none where flat. */
fn wetRipple(p: vec3f, W: vec4f, flat: f32) -> vec2f {
  let e = 0.08;
  let q = p.xz / 0.4;
  let c = wetValueNoise(q, 77u);
  let g = vec2f(wetValueNoise(q + vec2f(e, 0.0), 77u) - c, wetValueNoise(q + vec2f(0.0, e), 77u) - c) / e;
  return g * 0.06 * W.w * (1.0 - flat);
}
`
