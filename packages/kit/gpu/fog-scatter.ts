/**
 * Analytic height fog with per-lamp single scattering, ported from Aiden's Ashwood (`afterhours/src/render/
 * atmosphere.ts` and `post.ts` `airlight`). One medium drives everything so it all agrees:
 *
 * - **Medium:** extinction σ(y) = density · e^(−falloff · (y − base)), integrated in closed form along any segment
 *   (`fogOpticalDepth`), on the CPU and in WGSL.
 * - **Sky and skylight (scene pass):** `fogSky(dir)` fogs fully at the horizon, so ground and sky meet without a
 *   seam; `fogAmbient(n)` is that sky over a dark ground, cosine-convolved on the CPU into three coefficients (no
 *   env-map bake), and `fogEnv(r)` is the same sky for wet-surface reflections.
 * - **Lamp light in the fog (volume pass, `fogScatterVolume`):** for each of up to 16 lamps picked per frame
 *   (`FogScatter`), the ray's single scattering is integrated with four equiangular samples (the 1/d² cancels
 *   against the pdf). A spot cone with a small side leak draws the halo, a windowed range and a short visible beam
 *   bound it, Henyey–Greenstein forward scattering brightens it towards the lamp, and σ at the lamp × T(eye → lamp)
 *   scale it. On wet ground the same integral runs along the reflected ray with a jittered normal (long streaks),
 *   plus a narrow glint lobe per lamp.
 *
 * The volume pass returns alpha 0, so it never changes HDR alpha (Outbreak's shroud still dims it), and it runs after
 * the temporal resolve with its own half-resolution history (`Renderer` volume slots with `history: true`).
 */
import type { LabControl } from "../lab-navigation"
import { volumeFrameWgsl, type VolumeLightShader } from "./volume-pass"
import { common } from "./shaders"
import { sceneSurfaceWgsl } from "./reflections/surface"
import { WET_ASPHALT, wetMaterialWgsl, wetSurfaceWgsl, type WetMaterial } from "./reflections/wet"

export type Vec3 = readonly [number, number, number]

/** Lamps the scattering pass evaluates per pixel. */
export const MAX_FOG_LAMPS = 16
/** Floats per lamp in the scatter lamp buffer (five vec4f). */
export const FOG_LAMP_FLOATS = 20
/** Texels per side of the top-down lamp-glow map stored after the lamps in the scatter lamp buffer. */
export const FOG_GLOW_SIZE = 32
/** Floats of the glow map (one vec4f per texel, rgb used). */
export const FOG_GLOW_FLOATS = FOG_GLOW_SIZE * FOG_GLOW_SIZE * 4
/** Float offset of the glow map in the scatter lamp buffer (binding 19). */
export const FOG_GLOW_OFFSET = MAX_FOG_LAMPS * FOG_LAMP_FLOATS
/** Floats in the scatter lamp buffer: the lamps, then the glow map. */
export const FOG_LAMP_BUFFER_FLOATS = FOG_GLOW_OFFSET + FOG_GLOW_FLOATS
/** Floats in the `FogParams` uniform (binding 18). */
export const FOG_UNIFORM_FLOATS = 64
/** Scene and volume bind-group slots the renderer gives the fog. */
export const FOG_UNIFORM_BINDING = 18
export const FOG_LAMP_BINDING = 19
/** Distance a sky pixel's ray is integrated to. */
export const FOG_SKY_DISTANCE = 3000

/** Sodium head cone (Ashwood `world/compound/lamps.ts`): outer half-angle 1.1 rad, inner at 0.45 of it. */
export const SODIUM_CONE = { angle: 1.1, inner: 0.45 } as const
/** cos outer / cos inner of a spot cone, the same numbers the surface pool must use. */
export function fogCone(angle: number, innerFraction: number): { cosOuter: number; cosInner: number } {
  return { cosOuter: Math.cos(angle), cosInner: Math.cos(angle * innerFraction) }
}

export type FogMode = "today" | "scatter"

export type FogSettings = {
  /** "today" leaves a game's existing look; "scatter" turns this fog on. */
  mode: FogMode
  /** Extinction at the base height (1/m). */
  density: number
  /** Height falloff (1/m). */
  falloff: number
  /** Height the density is measured at (m). */
  base: number
  hue: number
  saturation: number
  /** Linear luminance of fully fogged distance. */
  brightness: number
  /** Sky above the fog bank, as a share of the fog colour. */
  skyDark: number
  /** Light pollution glow near the horizon, as a share of the fog colour. */
  horizonGlow: number
  /** Dark ground under the skylight, as a share of the fog colour. */
  ground: number
  /** Fog-sky skylight (ambient and reflections). */
  skylight: number
  /** Lamp light scattered in the fog. */
  strength: number
  /** Share of a lamp's light that leaks sideways out of its cone (draws the small round halo). */
  leak: number
  /** Visible cone length (m): extra falloff so the beam dies well above the ground. */
  coneLength: number
  /** Henyey–Greenstein forward scattering. */
  phaseG: number
  samples: number
  lamps: number
  /** Temporal response: the share of each new frame (1 = no history). */
  history: number
  halfRes: boolean
  /** Lamp glow in the fog reflected on wet ground. */
  reflection: number
  /** Narrow lamp glints on wet ground. */
  glint: number
  /** Vertical streaking of wet reflections. */
  streak: number
  /** Drifting low fog bank (noise-modulated height layer marched in the volume pass); "today" leaves it out. */
  bank: "today" | "drift"
  /** Bank extinction at its densest (1/m). */
  bankDensity: number
  /** Bank top above the fog base (m). */
  bankHeight: number
  /** Size of the bank's billows (m). */
  bankScale: number
  /** Share of the noise cut away, opening gaps between billows (0..1). */
  bankThreshold: number
  /** How far the bank's top rises and falls with the noise (share of its height). */
  bankUndulation: number
  /** Wind speed (m/s) and heading (degrees, 0 = +x). */
  bankWind: number
  bankWindHeading: number
  /** March steps through the bank. */
  bankSteps: number
  /** Distance the bank reaches before the height fog takes over (m). */
  bankDistance: number
  /** Bank colour as a share of the fog colour. */
  bankBrightness: number
  /** Lamp glow map tint in the bank. */
  bankGlow: number
  /** Extra lamp light scattered where the bank thickens the air (share of the physical ratio). */
  bankLamp: number
  /** Fog-depth blur: blur what the fog hides, so far trees and buildings read as soft masses. */
  blur: "today" | "depth"
  /** Blur mixed in where the fog is opaque (0..1). */
  blurStrength: number
  /** Optical depth multiplier for the blur (blur starts before the fog is opaque). */
  blurReach: number
  /** Lit cloud deck: a low cloud layer glowing from the lamps below. */
  clouds: "today" | "lit"
  /** Cloud base height above the fog base (m). */
  cloudHeight: number
  /** Share of the sky the deck covers (0..1). */
  cloudCover: number
  /** Size of cloud masses (m). */
  cloudScale: number
  /** Cloud opacity (0..1). */
  cloudOpacity: number
  /** Cloud body brightness as a share of the fog colour (low = shadier sky). */
  cloudDark: number
  /** Lamp glow on the cloud underside. */
  cloudGlow: number
  /** Cloud drift speed (m/s), along the bank's wind heading. */
  cloudWind: number
  /** Horizontal spread of each lamp's glow in the glow map (m). */
  glowSpread: number
}

/** Aiden's Lab defaults (`atmosphere.ts`, `post.ts`). */
export const FOG_DEFAULTS: FogSettings = {
  mode: "scatter",
  density: 0.01,
  falloff: 0.05,
  base: 0,
  hue: 181,
  saturation: 0.75,
  brightness: 0.034,
  skyDark: 0.45,
  horizonGlow: 0.35,
  ground: 0.12,
  skylight: 1,
  strength: 0.12,
  leak: 0.03,
  coneLength: 4.5,
  phaseG: 0.6,
  samples: 4,
  lamps: 16,
  history: 0.1,
  halfRes: true,
  reflection: 4,
  glint: 2,
  streak: 2.2,
  bank: "today",
  bankDensity: 0.04,
  bankHeight: 4,
  bankScale: 9,
  bankThreshold: 0.3,
  bankUndulation: 0.6,
  bankWind: 0.7,
  bankWindHeading: 200,
  bankSteps: 6,
  bankDistance: 140,
  bankBrightness: 0.7,
  bankGlow: 1,
  bankLamp: 0.5,
  blur: "today",
  blurStrength: 0.7,
  blurReach: 1,
  clouds: "today",
  cloudHeight: 35,
  cloudCover: 0.55,
  cloudScale: 170,
  cloudOpacity: 0.9,
  cloudDark: 0.15,
  cloudGlow: 0.6,
  cloudWind: 2.5,
  glowSpread: 18,
}

export const createFogSettings = (overrides: Partial<FogSettings> = {}): FogSettings => ({ ...FOG_DEFAULTS, ...overrides })

/** Typed Lab rows for every fog parameter; "Fog" first so Today is one setting away. */
export function fogControls(group = "Fog", prefix = ""): LabControl[] {
  const key = (k: keyof FogSettings) => prefix + k
  const field = (k: keyof FogSettings) => (prefix ? { field: k } : {})
  const range = (k: keyof FogSettings, label: string, min: number, max: number, step: number, unit?: string, subsection?: string): LabControl => ({
    key: key(k), ...field(k), label, group, min, max, step, ...(unit ? { unit } : {}), ...(subsection ? { subsection } : {}),
  })
  return [
    { key: key("mode"), ...field("mode"), label: "Fog", group, type: "select", options: [{ value: "today", label: "Today" }, { value: "scatter", label: "Lamp scattering" }] },
    range("density", "Density", 0, 0.06, 0.0005, "1/m", "Medium"),
    range("falloff", "Height falloff", 0, 0.2, 0.002, "1/m", "Medium"),
    range("hue", "Colour hue", 120, 220, 1, "°", "Medium"),
    range("saturation", "Colour saturation", 0, 1, 0.01, undefined, "Medium"),
    range("brightness", "Colour brightness", 0, 0.2, 0.001, undefined, "Medium"),
    range("skyDark", "Sky above fog", 0, 1, 0.01, undefined, "Sky"),
    range("horizonGlow", "Horizon glow", 0, 2, 0.01, undefined, "Sky"),
    range("ground", "Ground bounce", 0, 1, 0.01, undefined, "Sky"),
    range("skylight", "Fog skylight", 0, 3, 0.01, "×", "Sky"),
    range("strength", "Scatter strength", 0, 2, 0.01, "×", "Scattering"),
    range("leak", "Cone leak (halo)", 0, 0.5, 0.005, undefined, "Scattering"),
    range("coneLength", "Visible cone length", 1, 40, 0.5, "m", "Scattering"),
    range("phaseG", "Phase g (forward)", 0, 0.9, 0.01, undefined, "Scattering"),
    { key: key("samples"), ...field("samples"), label: "Samples per lamp", group, subsection: "Scattering", type: "select", options: [2, 3, 4, 6, 8].map((v) => ({ value: v, label: String(v) })) },
    range("lamps", "Lamps evaluated", 0, MAX_FOG_LAMPS, 1, undefined, "Scattering"),
    range("reflection", "Glow on wet ground", 0, 8, 0.05, "×", "Wet ground"),
    range("glint", "Lamp glints", 0, 4, 0.05, "×", "Wet ground"),
    range("streak", "Vertical streaking", 0, 4, 0.05, "×", "Wet ground"),
    range("history", "History weight (new frame)", 0.02, 1, 0.01, undefined, "Stability"),
    { key: key("halfRes"), ...field("halfRes"), label: "Half resolution", group, subsection: "Stability", type: "toggle" },
  ]
}

/**
 * Typed Lab rows for the atmosphere layered on the fog: drifting fog bank, fog-depth blur and lit cloud deck. Each
 * starts with its Today / on select, so Today is one setting away. They need the fog on ("Lamp scattering").
 */
export function atmosphereControls(group = "Atmosphere", prefix = ""): LabControl[] {
  const key = (k: keyof FogSettings) => prefix + k
  const field = (k: keyof FogSettings) => (prefix ? { field: k } : {})
  const range = (k: keyof FogSettings, label: string, min: number, max: number, step: number, unit: string | undefined, subsection: string): LabControl => ({
    key: key(k), ...field(k), label, group, min, max, step, ...(unit ? { unit } : {}), subsection,
  })
  const select = (k: keyof FogSettings, label: string, subsection: string, options: { value: string | number; label: string }[]): LabControl => ({
    key: key(k), ...field(k), label, group, subsection, type: "select", options,
  })
  return [
    select("bank", "Fog bank", "Fog bank", [{ value: "today", label: "Today" }, { value: "drift", label: "Drifting" }]),
    range("bankDensity", "Bank density", 0, 0.3, 0.002, "1/m", "Fog bank"),
    range("bankHeight", "Bank height", 0.5, 20, 0.1, "m", "Fog bank"),
    range("bankScale", "Billow size", 1, 60, 0.5, "m", "Fog bank"),
    range("bankThreshold", "Gaps", 0, 0.9, 0.01, undefined, "Fog bank"),
    range("bankUndulation", "Top undulation", 0, 1.5, 0.01, undefined, "Fog bank"),
    range("bankWind", "Wind", 0, 6, 0.05, "m/s", "Fog bank"),
    range("bankWindHeading", "Wind heading", 0, 360, 1, "°", "Fog bank"),
    select("bankSteps", "March steps", "Fog bank", [3, 4, 6, 8, 12].map((v) => ({ value: v, label: String(v) }))),
    range("bankDistance", "Reach", 20, 400, 5, "m", "Fog bank"),
    range("bankBrightness", "Bank brightness", 0, 2, 0.01, "× fog", "Fog bank"),
    range("bankGlow", "Lamp glow in bank", 0, 4, 0.05, "×", "Fog bank"),
    range("bankLamp", "Lamp beams in bank", 0, 1, 0.01, "×", "Fog bank"),
    select("blur", "Fog blur", "Fog blur", [{ value: "today", label: "Today" }, { value: "depth", label: "Depth blur" }]),
    range("blurStrength", "Blur strength", 0, 1, 0.01, undefined, "Fog blur"),
    range("blurReach", "Blur reach", 0.2, 6, 0.05, "× depth", "Fog blur"),
    select("clouds", "Cloud deck", "Cloud deck", [{ value: "today", label: "Today" }, { value: "lit", label: "Lit from below" }]),
    range("cloudHeight", "Cloud base", 20, 400, 1, "m", "Cloud deck"),
    range("cloudCover", "Cover", 0, 1, 0.01, undefined, "Cloud deck"),
    range("cloudScale", "Cloud size", 20, 800, 5, "m", "Cloud deck"),
    range("cloudOpacity", "Opacity", 0, 1, 0.01, undefined, "Cloud deck"),
    range("cloudDark", "Cloud body", 0, 1.5, 0.01, "× fog", "Cloud deck"),
    range("cloudGlow", "Lamp underglow", 0, 6, 0.05, "×", "Cloud deck"),
    range("cloudWind", "Drift", 0, 20, 0.1, "m/s", "Cloud deck"),
    range("glowSpread", "Glow spread", 4, 80, 1, "m", "Cloud deck"),
  ]
}

// ---------------------------------------------------------------- the medium (CPU mirror of the WGSL)

export type FogMedium = { density: number; falloff: number; base: number }

/** Optical depth of the fog between two points: closed form, Taylor limit for level rays (no horizon seam). */
export function fogOpticalDepth(a: Vec3, b: Vec3, m: FogMedium): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2]
  const len = Math.hypot(dx, dy, dz)
  if (len < 1e-6) return 0
  const x = Math.max(-60, Math.min(60, m.falloff * dy))
  const f = Math.abs(x) > 1e-3 ? (1 - Math.exp(-x)) / x : 1 - x / 2
  return m.density * Math.exp(-m.falloff * Math.min(a[1] - m.base, 200)) * len * f
}

export const fogTransmittance = (a: Vec3, b: Vec3, m: FogMedium): number => Math.exp(-fogOpticalDepth(a, b, m))
export const fogSigma = (p: Vec3, m: FogMedium): number => m.density * Math.exp(-m.falloff * Math.min(p[1] - m.base, 200))

/** HSL tint (linear, as three's `setHSL` in a linear working space) scaled to a linear luminance. */
export function fogColor(hue: number, saturation: number, brightness: number): [number, number, number] {
  const h = (((hue % 360) + 360) % 360) / 60
  const c = saturation
  const x = c * (1 - Math.abs((h % 2) - 1))
  const [r, g, b] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x]
  const m = 0.5 - c / 2
  const rgb: [number, number, number] = [r + m, g + m, b + m]
  const lum = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
  const k = brightness / Math.max(lum, 1e-4)
  return [rgb[0] * k, rgb[1] * k, rgb[2] * k]
}

type SkyInputs = FogMedium & { color: Vec3; skyDark: number; horizonGlow: number; ground: number }
const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}

/** Sky radiance seen from `eye` along unit `dir`: the dark overcast through the fog bank, fully fogged at the horizon. */
export function fogSkyRadiance(eye: Vec3, dir: Vec3, s: SkyInputs): [number, number, number] {
  const far: Vec3 = [eye[0] + dir[0] * 4000, eye[1] + dir[1] * 4000, eye[2] + dir[2] * 4000]
  const t = fogTransmittance(eye, far, s)
  const up = Math.max(dir[1], 0)
  const dark = s.skyDark * (1 + (0.55 - 1) * smooth(0, 0.8, up))
  const glow = s.horizonGlow * Math.exp(-5 * up)
  const k = 1 + (dark + glow - 1) * t
  return [s.color[0] * k, s.color[1] * k, s.color[2] * k]
}

/** Skylight environment: the sky as seen from 1.7 m over a dark ground (`ground` × fog colour). */
export function fogEnvRadiance(dir: Vec3, s: SkyInputs): [number, number, number] {
  const sky = fogSkyRadiance([0, s.base + 1.7, 0], dir, s)
  const w = smooth(-0.12, 0.02, dir[1])
  return [0, 1, 2].map((i) => s.color[i]! * s.ground * (1 - w) + sky[i]! * w) as [number, number, number]
}

/** Cosine-weighted mean radiance of the skylight environment around a normal with this `ny` (numeric quadrature). */
export function fogAmbientNumeric(ny: number, s: SkyInputs, steps = 96): [number, number, number] {
  const nx = Math.sqrt(Math.max(0, 1 - ny * ny))
  const out: [number, number, number] = [0, 0, 0]
  let wsum = 0
  for (let i = 0; i < steps; i++) {
    const th = ((i + 0.5) / steps) * Math.PI
    const st = Math.sin(th), ct = Math.cos(th)
    for (let j = 0; j < steps * 2; j++) {
      const ph = ((j + 0.5) / (steps * 2)) * 2 * Math.PI
      const d: Vec3 = [st * Math.cos(ph), ct, st * Math.sin(ph)]
      const c = d[0] * nx + d[1] * ny
      if (c <= 0) continue
      const w = c * st
      const l = fogEnvRadiance(d, s)
      out[0] += l[0] * w; out[1] += l[1] * w; out[2] += l[2] * w
      wsum += w
    }
  }
  return [out[0] / wsum, out[1] / wsum, out[2] / wsum]
}

/** Quadratic in `n.y` through the numeric irradiance at n.y = −1, 0, 1: ambient = c0 + c1·ny + c2·ny². */
export function fogAmbientCoefficients(s: SkyInputs): [Vec3, Vec3, Vec3] {
  const lo = fogAmbientNumeric(-1, s, 48), mid = fogAmbientNumeric(0, s, 48), hi = fogAmbientNumeric(1, s, 48)
  const c0 = mid
  const c1 = [0, 1, 2].map((i) => (hi[i]! - lo[i]!) / 2) as unknown as Vec3
  const c2 = [0, 1, 2].map((i) => (hi[i]! + lo[i]!) / 2 - mid[i]!) as unknown as Vec3
  return [c0, c1, c2]
}

// ---------------------------------------------------------------- lamp scattering (CPU mirror for tests)

export type ScatterLampShape = {
  pos: Vec3
  range: number
  axis: Vec3
  cosOuter: number
  cosInner: number
  near: number
}
export type ScatterShape = { leak: number; coneLength: number; phaseG: number }

/** Integrand of the airlight without the 1/d²: cone × range window × visible beam × phase / 4π. */
export function airlightIntegrand(lx: Vec3, rd: Vec3, lamp: ScatterLampShape, p: ScatterShape): number {
  const ld = Math.max(Math.hypot(lx[0], lx[1], lx[2]), 1e-3)
  const ln: Vec3 = [lx[0] / ld, lx[1] / ld, lx[2] / ld]
  const cone = smooth(lamp.cosOuter, lamp.cosInner, ln[0] * lamp.axis[0] + ln[1] * lamp.axis[1] + ln[2] * lamp.axis[2]) * (1 - p.leak) + p.leak
  const r4 = Math.pow(ld / lamp.range, 4)
  const win = Math.pow(Math.max(0, Math.min(1, 1 - r4)), 2) * smooth(0, lamp.near, ld) * Math.exp(-ld / p.coneLength)
  const cosT = -(ln[0] * rd[0] + ln[1] * rd[1] + ln[2] * rd[2])
  const g = p.phaseG, g2 = g * g
  const hg = (1 - g2) / Math.pow(Math.max(1 + g2 - 2 * g * cosT, 1e-4), 1.5)
  return cone * win * (1 + (hg - 1) * 0.85) / (4 * Math.PI)
}

/** The shader's estimator: `samples` equiangular samples at offset `jitter` (0..1). */
export function airlightEquiangular(ro: Vec3, rd: Vec3, dist: number, lamp: ScatterLampShape, p: ScatterShape, samples: number, jitter: number): number {
  const toL: Vec3 = [lamp.pos[0] - ro[0], lamp.pos[1] - ro[1], lamp.pos[2] - ro[2]]
  const s0 = toL[0] * rd[0] + toL[1] * rd[1] + toL[2] * rd[2]
  const h = Math.max(Math.sqrt(Math.max(toL[0] ** 2 + toL[1] ** 2 + toL[2] ** 2 - s0 * s0, 0)), 0.03)
  const a = Math.max(s0 - lamp.range, 0)
  const b = Math.min(s0 + lamp.range, dist)
  if (b <= a) return 0
  const ta = Math.atan((a - s0) / h), tb = Math.atan((b - s0) / h)
  let sum = 0
  for (let j = 0; j < samples; j++) {
    const t = ta + (tb - ta) * ((jitter + j) / samples)
    const s = s0 + h * Math.tan(t)
    sum += airlightIntegrand([rd[0] * s - toL[0], rd[1] * s - toL[1], rd[2] * s - toL[2]], rd, lamp, p)
  }
  return (sum * (tb - ta)) / (h * samples)
}

/** Brute-force reference: midpoint rule of integrand / d² over the ray. */
export function airlightReference(ro: Vec3, rd: Vec3, dist: number, lamp: ScatterLampShape, p: ScatterShape, steps = 200000): number {
  const toL: Vec3 = [lamp.pos[0] - ro[0], lamp.pos[1] - ro[1], lamp.pos[2] - ro[2]]
  const s0 = toL[0] * rd[0] + toL[1] * rd[1] + toL[2] * rd[2]
  const a = Math.max(s0 - lamp.range, 0), b = Math.min(s0 + lamp.range, dist)
  if (b <= a) return 0
  const ds = (b - a) / steps
  let sum = 0
  for (let i = 0; i < steps; i++) {
    const s = a + (i + 0.5) * ds
    const lx: Vec3 = [rd[0] * s - toL[0], rd[1] * s - toL[1], rd[2] * s - toL[2]]
    const d2 = Math.max(lx[0] ** 2 + lx[1] ** 2 + lx[2] ** 2, 1e-12)
    sum += (airlightIntegrand(lx, rd, lamp, p) / d2) * ds
  }
  return sum
}

/** Weights of the 4-tap depth-aware upsample (the composite shader's), normalised. */
export function upsampleWeights(fx: number, fy: number, tapDist: readonly [number, number, number, number], centre: number): [number, number, number, number] {
  const bil = [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy]
  const w = bil.map((b, i) => b * Math.exp(-Math.abs(tapDist[i]! - centre) / (0.1 * centre + 0.05)) + 1e-4)
  const sum = w[0]! + w[1]! + w[2]! + w[3]!
  return w.map((v) => v / sum) as [number, number, number, number]
}

// ---------------------------------------------------------------- atmosphere (CPU mirrors of the WGSL)

type BankShape = Pick<FogSettings, "bankDensity" | "bankHeight" | "bankThreshold" | "bankDistance"> & { base: number }

/** Segment [t0, t1] of a ray (from height `eyeY`, unit dir y `dirY`, surface at `dist`) inside the bank slab. */
export function fogBankInterval(eyeY: number, dirY: number, dist: number, b: BankShape): [number, number] {
  const top = b.base + b.bankHeight
  const dy = Math.abs(dirY) < 1e-5 ? (dirY < 0 ? -1e-5 : 1e-5) : dirY
  const ta = (b.base - eyeY) / dy, tb = (top - eyeY) / dy
  const t0 = Math.max(Math.min(ta, tb), 0)
  const t1 = Math.min(Math.max(ta, tb), dist, b.bankDistance)
  return t1 > t0 ? [t0, t1] : [0, 0]
}

/** Noise-free bank extinction at height y: density · E[max(n − gaps, 0)] / (1 − gaps) · (1 − h)^1.2. */
export function fogBankMeanSigma(y: number, b: BankShape): number {
  const h = (y - b.base) / Math.max(b.bankHeight, 1e-3)
  if (h >= 1 || h < 0) return h < 0 ? b.bankDensity * 0.5 * (1 - b.bankThreshold) : 0
  return b.bankDensity * 0.5 * (1 - b.bankThreshold) * Math.pow(1 - h, 1.2)
}

/** Fog-depth blur weight for a surface at `p`: 1 − exp(−reach · (height fog + mean bank optical depth)). */
export function fogBlurAmount(eye: Vec3, p: Vec3, m: FogMedium, reach: number, bank?: BankShape): number {
  let tau = fogOpticalDepth(eye, p, m)
  if (bank) {
    const d: Vec3 = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]]
    const len = Math.hypot(d[0], d[1], d[2])
    if (len > 1e-6) {
      const [t0, t1] = fogBankInterval(eye[1], d[1] / len, len, bank)
      tau += fogBankMeanSigma(eye[1] + (d[1] / len) * (t0 + t1) * 0.5, bank) * (t1 - t0)
    }
  }
  return 1 - Math.exp(-reach * tau)
}

export type GlowRect = readonly [x0: number, z0: number, x1: number, z1: number]

/** Glow map texel scale: ground albedo 0.1 over π, so a texel reads as roughly the radiance of the lit ground. */
export const FOG_GLOW_SCALE = 0.1 / Math.PI

/** Rectangle the glow map covers: the lamps' footprint padded by three spreads and 20 m (null without lamps). */
export function fogGlowRect(lamps: readonly FogLamp[], spread: number): GlowRect | null {
  if (!lamps.length) return null
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity
  for (const l of lamps) {
    x0 = Math.min(x0, l.x); x1 = Math.max(x1, l.x)
    z0 = Math.min(z0, l.z); z1 = Math.max(z1, l.z)
  }
  const pad = spread * 3 + 20
  return [x0 - pad, z0 - pad, x1 + pad, z1 + pad]
}

/**
 * Bakes the top-down lamp glow (`FOG_GLOW_SIZE`² texels, rgb in each vec4): per texel centre, Σ colour · intensity ·
 * visibility / (horizontal d² + height² + spread²) · `FOG_GLOW_SCALE`. One map lights the cloud underside and tints
 * the fog bank, so every lamp costs one bilinear lookup (Neon Zenith's street-light map, MIT).
 */
export function bakeLampGlow(out: Float32Array, lamps: readonly FogLamp[], rect: GlowRect, spread: number, base = 0): void {
  const n = FOG_GLOW_SIZE
  const s2 = spread * spread
  for (let j = 0; j < n; j++) {
    const z = rect[1] + ((j + 0.5) / n) * (rect[3] - rect[1])
    for (let i = 0; i < n; i++) {
      const x = rect[0] + ((i + 0.5) / n) * (rect[2] - rect[0])
      let r = 0, g = 0, b = 0
      for (const l of lamps) {
        const h = Math.max(l.y - base, 0)
        const k = (l.intensity * (l.visibility ?? 1) * FOG_GLOW_SCALE) / ((x - l.x) ** 2 + (z - l.z) ** 2 + h * h + s2)
        r += l.color[0] * k; g += l.color[1] * k; b += l.color[2] * k
      }
      out.set([r, g, b, 0], (j * n + i) * 4)
    }
  }
}

// ---------------------------------------------------------------- lamp picker and per-frame packing

export type FogLamp = {
  x: number
  /** Height (world y). */
  y: number
  z: number
  range: number
  /** Linear colour. */
  color: Vec3
  /** On-axis intensity: the numerator over d² of the game's own surface lighting for this lamp. */
  intensity: number
  /** Unit axis, default straight down. */
  axis?: Vec3
  /** Spot cone; omit both for an omni lamp. Use the same numbers as the surface pool (`fogCone`). */
  cosOuter?: number
  cosInner?: number
  /** Fixture size (m): light emerges into the fog past half of it. */
  size?: number
  /** Nominal on-ness 0..1 (not flicker, so the budget doesn't reshuffle). */
  visibility?: number
  /** Stable identity for selection hysteresis (defaults to the index). */
  id?: number
}

const tmpScore: { i: number; s: number; x: number; z: number }[] = []

/**
 * Picks the lamps whose light in the fog matters most to this view: frustum vs range sphere, ranked by
 * intensity·visibility·σ(lamp)·T(eye → lamp) / max(distance − range, 1), with 1.5× hysteresis for lamps already chosen
 * and a deterministic tiebreak on position. Returns the chosen input indices in rank order.
 */
export class FogLampPicker {
  private previous = new Set<number>()
  readonly chosen: number[] = []

  pick(lamps: readonly FogLamp[], eye: Vec3, viewProj: ArrayLike<number>, medium: FogMedium, budget: number): number[] {
    const planes = frustumPlanes(viewProj)
    tmpScore.length = 0
    for (let i = 0; i < lamps.length; i++) {
      const l = lamps[i]!
      const vis = l.visibility ?? 1
      if (vis <= 0.001 || l.intensity <= 0) continue
      if (!sphereInFrustum(planes, l.x, l.y, l.z, l.range)) continue
      const p: Vec3 = [l.x, l.y, l.z]
      const sigma = fogSigma(p, medium)
      if (sigma <= 0) continue
      const dist = Math.hypot(l.x - eye[0], l.y - eye[1], l.z - eye[2])
      const t = fogTransmittance(eye, p, medium)
      const id = l.id ?? i
      const s = ((l.intensity * vis * sigma * t) / Math.max(dist - l.range, 1)) * (this.previous.has(id) ? 1.5 : 1)
      tmpScore.push({ i, s, x: l.x, z: l.z })
    }
    tmpScore.sort((a, b) => b.s - a.s || a.x - b.x || a.z - b.z)
    const n = Math.max(0, Math.min(MAX_FOG_LAMPS, Math.round(budget), tmpScore.length))
    this.chosen.length = 0
    this.previous.clear()
    for (let k = 0; k < n; k++) {
      const i = tmpScore[k]!.i
      this.chosen.push(i)
      this.previous.add(lamps[i]!.id ?? i)
    }
    return this.chosen
  }

  reset(): void {
    this.previous.clear()
    this.chosen.length = 0
  }
}

/** Clip planes (a, b, c, d) of a column-major WebGPU viewProj (clip z in 0..1). */
export function frustumPlanes(m: ArrayLike<number>): number[][] {
  const row = (r: number) => [m[r]!, m[4 + r]!, m[8 + r]!, m[12 + r]!]
  const r0 = row(0), r1 = row(1), r2 = row(2), r3 = row(3)
  const add = (a: number[], b: number[], s: number) => a.map((v, i) => v + s * b[i]!)
  return [add(r3, r0, 1), add(r3, r0, -1), add(r3, r1, 1), add(r3, r1, -1), r2, add(r3, r2, -1)]
}

export function sphereInFrustum(planes: number[][], x: number, y: number, z: number, r: number): boolean {
  for (const p of planes) {
    const n = Math.hypot(p[0]!, p[1]!, p[2]!)
    if (p[0]! * x + p[1]! * y + p[2]! * z + p[3]! < -r * n) return false
  }
  return true
}

/** What the renderer uploads for the fog each frame (`FrameInput.fog`). */
export type FogFrame = {
  readonly uniforms: Float32Array<ArrayBuffer>
  readonly lamps: Float32Array<ArrayBuffer>
  lampCount: number
  /** Top-down lamp glow (`FOG_GLOW_FLOATS`), uploaded after the lamps when `glowVersion` changes. */
  readonly glow?: Float32Array<ArrayBuffer>
  glowVersion?: number
}

export type FogUpdate = {
  eye: Vec3
  viewProj: ArrayLike<number>
  lamps: readonly FogLamp[]
  /** Seconds, for the bank and cloud drift (default 0: frozen). */
  time?: number
}

/** Fog-depth blur input for `FrameInput.fogBlur` (`@arcade/kit/gpu/fog-blur`). */
export type FogBlurInput = { strength: number; reach: number }

/**
 * CPU side of the fog: picks lamps and packs `FogParams` and the scatter lamp list for `FrameInput.fog`. The skylight
 * coefficients are recomputed only when a sky input changes.
 */
export class FogScatter {
  readonly settings: FogSettings
  readonly picker = new FogLampPicker()
  readonly frame: FogFrame = {
    uniforms: new Float32Array(FOG_UNIFORM_FLOATS),
    lamps: new Float32Array(MAX_FOG_LAMPS * FOG_LAMP_FLOATS),
    lampCount: 0,
    glow: new Float32Array(FOG_GLOW_FLOATS),
    glowVersion: 0,
  }
  private skyKey = ""
  private ambient: [Vec3, Vec3, Vec3] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  private glowKey = NaN
  private glowRect: GlowRect | null = null

  constructor(settings: FogSettings = createFogSettings()) {
    this.settings = settings
  }

  get enabled(): boolean {
    return this.settings.mode === "scatter"
  }

  /** Volume-pass entry for `FrameInput.volume` (null when the fog is off). */
  volumeInput(): { downscale: number; history: number } | null {
    return this.enabled ? { downscale: this.settings.halfRes ? 2 : 1, history: this.settings.history } : null
  }

  /** Fog-depth blur entry for `FrameInput.fogBlur` (null at Today or with the fog off). */
  blurInput(): FogBlurInput | null {
    const s = this.settings
    return this.enabled && s.blur === "depth" && s.blurStrength > 0 ? { strength: s.blurStrength, reach: s.blurReach } : null
  }

  /** Bakes the glow map when the lamps or the spread change; returns whether the map is in use. */
  private updateGlow(lamps: readonly FogLamp[], base: number): boolean {
    const s = this.settings
    if (!(s.bank === "drift" && s.bankGlow > 0) && !(s.clouds === "lit" && s.cloudGlow > 0)) return false
    let key = s.glowSpread * 7.13 + base * 3.1 + lamps.length
    for (let i = 0; i < lamps.length; i++) {
      const l = lamps[i]!
      key = (key * 31 + l.x * 1.7 + l.y * 2.3 + l.z * 2.9 + l.intensity * (l.visibility ?? 1) + l.color[0] * 5 + l.color[1] * 7 + l.color[2] * 11) % 1e9
    }
    if (key !== this.glowKey) {
      this.glowKey = key
      this.glowRect = fogGlowRect(lamps, s.glowSpread)
      if (this.glowRect) bakeLampGlow(this.frame.glow!, lamps, this.glowRect, s.glowSpread, base)
      this.frame.glowVersion = (this.frame.glowVersion ?? 0) + 1
    }
    return !!this.glowRect
  }

  update(input: FogUpdate): FogFrame {
    const s = this.settings
    const medium: FogMedium = { density: s.density, falloff: s.falloff, base: s.base }
    const color = fogColor(s.hue, s.saturation, s.brightness)
    const key = [s.density, s.falloff, s.base, s.hue, s.saturation, s.brightness, s.skyDark, s.horizonGlow, s.ground].join("/")
    if (key !== this.skyKey) {
      this.skyKey = key
      this.ambient = fogAmbientCoefficients({ ...medium, color, skyDark: s.skyDark, horizonGlow: s.horizonGlow, ground: s.ground })
    }
    const u = this.frame.uniforms
    const on = this.enabled ? 1 : 0
    u.set([s.density, s.falloff, s.base, on], 0)
    u.set([color[0], color[1], color[2], s.skylight], 4)
    u.set([s.skyDark, s.horizonGlow, s.ground, 1.7], 8)
    for (let k = 0; k < 3; k++) u.set([this.ambient[k]![0] * s.skylight, this.ambient[k]![1] * s.skylight, this.ambient[k]![2] * s.skylight, 0], 12 + k * 4)
    const lamps = on ? this.picker.pick(input.lamps, input.eye, input.viewProj, medium, s.lamps) : (this.picker.reset(), this.picker.chosen)
    u.set([s.leak, s.coneLength, s.phaseG, lamps.length], 24)
    u.set([Math.max(1, Math.round(s.samples)), s.reflection, s.glint, s.streak], 28)
    const bank = on && s.bank === "drift" && s.bankDensity > 0
    const clouds = on && s.clouds === "lit" && s.cloudOpacity > 0
    const glow = on && this.updateGlow(input.lamps, s.base)
    const heading = (s.bankWindHeading * Math.PI) / 180
    u.set([bank ? s.bankDensity : 0, Math.max(s.bankHeight, 0.05), 1 / Math.max(s.bankScale, 0.1), bank ? Math.max(1, Math.round(s.bankSteps)) : 0], 32)
    u.set([Math.min(s.bankThreshold, 0.95), s.bankDistance, s.bankBrightness, s.bankGlow], 36)
    u.set([Math.cos(heading) * s.bankWind, Math.sin(heading) * s.bankWind, (input.time ?? 0) % 100000, s.cloudWind], 40)
    u.set([s.cloudHeight, s.cloudCover, 1 / Math.max(s.cloudScale, 1), clouds ? s.cloudOpacity : 0], 44)
    u.set([s.cloudDark, s.cloudGlow, Math.cos(heading), Math.sin(heading)], 48)
    const r = this.glowRect
    u.set(glow && r ? [r[0], r[1], 1 / (r[2] - r[0]), 1 / (r[3] - r[1])] : [0, 0, 0, 0], 52)
    u.set([s.bankLamp, s.bankUndulation, 0, 0], 56)
    const L = this.frame.lamps
    for (let k = 0; k < lamps.length; k++) {
      const l = input.lamps[lamps[k]!]!
      const p: Vec3 = [l.x, l.y, l.z]
      const sigma = fogSigma(p, medium)
      const t = fogTransmittance(input.eye, p, medium)
      const vis = l.visibility ?? 1
      const k0 = l.intensity * vis * sigma * t * s.strength
      const raw = l.intensity * vis
      const axis = l.axis ?? [0, -1, 0]
      const o = k * FOG_LAMP_FLOATS
      L.set([l.x, l.y, l.z, l.range], o)
      L.set([l.color[0] * k0, l.color[1] * k0, l.color[2] * k0, l.cosOuter ?? -2], o + 4)
      L.set([axis[0], axis[1], axis[2], l.cosInner ?? -1], o + 8)
      L.set([(l.size ?? 0.2) * 0.5, 0, 0, 0], o + 12)
      L.set([l.color[0] * raw, l.color[1] * raw, l.color[2] * raw, sigma], o + 16)
    }
    this.frame.lampCount = lamps.length
    return this.frame
  }
}

/** Sprite kind of the slim lamp glow (`spriteShader`): core, glare and a short skirt, alpha untouched. */
export const LAMP_GLOW_SPRITE = 9

/**
 * Writes one additive lamp-glow sprite (12 floats, the renderer's `SPRITE_FLOATS`) at `offset`: `radius` is the quad's
 * half-size in metres (the core is 5 % of it), `color` the emitter's linear radiance, faded by the fog between the eye
 * and the lamp. Returns the next offset.
 */
export function packLampGlow(out: Float32Array, offset: number, lamp: { x: number; y: number; z: number }, radius: number, color: Vec3, eye: Vec3, medium: FogMedium): number {
  const t = fogTransmittance(eye, [lamp.x, lamp.y, lamp.z], medium)
  out.set([lamp.x, lamp.y, lamp.z, radius, color[0] * t, color[1] * t, color[2] * t, 1, LAMP_GLOW_SPRITE, 0, 0, 0], offset)
  return offset + 12
}

// ---------------------------------------------------------------- WGSL

/** `FogParams` (binding 18 in the scene and volume groups) and the medium, sky and skylight functions. */
export const fogParamsWgsl = /* wgsl */ `
struct FogParams {
  medium: vec4f,   // density (1/m), falloff (1/m), base height, on
  color: vec4f,    // fog radiance rgb, skylight
  sky: vec4f,      // sky above fog, horizon glow, ground, skylight eye height
  amb0: vec4f,     // skylight irradiance: c0 + c1·n.y + c2·n.y²
  amb1: vec4f,
  amb2: vec4f,
  scatter: vec4f,  // cone leak, visible cone length, phase g, lamp count
  reflect: vec4f,  // samples, reflection, glint, streak
  bank: vec4f,     // bank density (0 = off), height, 1/billow size, steps
  bank2: vec4f,    // gaps, reach, brightness (× fog), lamp glow tint
  wind: vec4f,     // wind x, z (m/s), time (s), cloud drift (m/s)
  cloud: vec4f,    // cloud base, cover, 1/size, opacity (0 = off)
  cloud2: vec4f,   // cloud body (× fog), lamp underglow, wind heading cos, sin
  glowRect: vec4f, // glow map x0, z0, 1/width, 1/depth (0 = no map)
  bank3: vec4f,    // lamp beams in bank, top undulation
  pad0: vec4f,
}
@group(0) @binding(${FOG_UNIFORM_BINDING}) var<uniform> FOG: FogParams;

/** Optical depth between two points (closed form; Taylor limit for level rays, so no horizon seam). */
fn fogOpticalDepth(a: vec3f, b: vec3f) -> f32 {
  let d = b - a;
  let len = length(d);
  let x = clamp(FOG.medium.y * d.y, -60.0, 60.0);
  var f = 1.0 - x * 0.5;
  if (abs(x) > 1e-3) { f = (1.0 - exp(-x)) / x; }
  return FOG.medium.x * exp(-FOG.medium.y * min(a.y - FOG.medium.z, 200.0)) * len * f;
}
fn fogTransmittance(a: vec3f, b: vec3f) -> f32 { return exp(-fogOpticalDepth(a, b)); }
fn fogSigma(p: vec3f) -> f32 { return FOG.medium.x * exp(-FOG.medium.y * min(p.y - FOG.medium.z, 200.0)); }
fn fogColor() -> vec3f { return FOG.color.rgb; }
/** Surface colour seen through the fog from the eye. */
fn fogApply(col: vec3f, eye: vec3f, p: vec3f) -> vec3f { return mix(fogColor(), col, fogTransmittance(eye, p)); }
/** Sky radiance along unit dir from eye: the overcast through the fog bank, fully fogged at the horizon. */
fn fogSky(eye: vec3f, dir: vec3f) -> vec3f {
  let t = fogTransmittance(eye, eye + dir * 4000.0);
  let up = max(dir.y, 0.0);
  let dark = FOG.sky.x * mix(1.0, 0.55, smoothstep(0.0, 0.8, up));
  let glow = FOG.sky.y * exp(-up * 5.0);
  return fogColor() * mix(1.0, dark + glow, t);
}
/** Skylight environment for reflections: the sky from eye height over a dark ground. */
fn fogEnv(dir: vec3f) -> vec3f {
  let sky = fogSky(vec3f(0.0, FOG.medium.z + FOG.sky.w, 0.0), dir);
  return mix(fogColor() * FOG.sky.z, sky, smoothstep(-0.12, 0.02, dir.y)) * FOG.color.w;
}
/** Cosine-weighted skylight radiance for a unit normal (diffuse ambient: albedo × this). */
fn fogAmbient(n: vec3f) -> vec3f { return max(FOG.amb0.rgb + FOG.amb1.rgb * n.y + FOG.amb2.rgb * n.y * n.y, vec3f(0.0)); }
`

/** Shared spot shape: the surface pool and the air cone use this, so they line up. */
export const fogConeWgsl = /* wgsl */ `
fn fogLampCone(cosT: f32, cosOuter: f32, cosInner: f32) -> f32 { return smoothstep(cosOuter, cosInner, cosT); }
`

/** Scene-shader declarations (`SceneHooks.declarations`): `fogApply`, `fogSky`, `fogAmbient`, `fogEnv`. */
export const fogSceneWgsl = fogParamsWgsl + fogConeWgsl

/**
 * Volume-pass atmosphere (needs `fogParamsWgsl` and `fogLampData`): the drifting fog bank, the lit cloud deck and the
 * lamp-glow map lookup. The bank is a ray–slab march through a noise-modulated layer with two counter-drifting,
 * domain-warped octaves and a height falloff whose top rises and falls with the noise (three.js
 * `webgpu_postprocessing_fog`, MIT), Beer–Lambert accumulated; Tidewater's AirHaze (MIT) layers it over the
 * analytic height fog the same way. The deck is a plane with footprint-filtered octaves and an analytic edge width
 * from the pixel's footprint (web-ocean, MIT), lit from below by the glow map (Neon Zenith, MIT).
 */
export const fogAtmosphereWgsl = /* wgsl */ `
fn fogHash3(p: vec3i) -> f32 {
  var h = (bitcast<u32>(p.x) * 0x8da6b343u) ^ (bitcast<u32>(p.y) * 0xd8163841u) ^ (bitcast<u32>(p.z) * 0xcb1ab31fu);
  h = (h ^ (h >> 16u)) * 0x7feb352du;
  h = (h ^ (h >> 15u)) * 0x846ca68bu;
  h = h ^ (h >> 16u);
  return f32(h >> 8u) * (1.0 / 16777216.0);
}
fn fogNoise3(p: vec3f) -> f32 {
  let i = vec3i(floor(p));
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = mix(fogHash3(i), fogHash3(i + vec3i(1, 0, 0)), u.x);
  let b = mix(fogHash3(i + vec3i(0, 1, 0)), fogHash3(i + vec3i(1, 1, 0)), u.x);
  let c = mix(fogHash3(i + vec3i(0, 0, 1)), fogHash3(i + vec3i(1, 0, 1)), u.x);
  let e = mix(fogHash3(i + vec3i(0, 1, 1)), fogHash3(i + vec3i(1, 1, 1)), u.x);
  return mix(mix(a, b, u.y), mix(c, e, u.y), u.z);
}
fn fogNoise2(p: vec2f) -> f32 {
  let i = vec2i(floor(p));
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = mix(fogHash3(vec3i(i, 7)), fogHash3(vec3i(i + vec2i(1, 0), 7)), u.x);
  let b = mix(fogHash3(vec3i(i + vec2i(0, 1), 7)), fogHash3(vec3i(i + vec2i(1, 1), 7)), u.x);
  return mix(a, b, u.y);
}

fn fogGlowAt(i: vec2i) -> vec3f {
  let c = clamp(i, vec2i(0), vec2i(${FOG_GLOW_SIZE - 1}));
  return fogLampData[${FOG_GLOW_OFFSET / 4}u + u32(c.y * ${FOG_GLOW_SIZE} + c.x)].rgb;
}
/** Top-down lamp glow at a ground position (bilinear; fades out at the map's edge). */
fn fogGlow(xz: vec2f) -> vec3f {
  if (FOG.glowRect.z <= 0.0) { return vec3f(0.0); }
  let n = (xz - FOG.glowRect.xy) * FOG.glowRect.zw;
  let uv = n * ${FOG_GLOW_SIZE}.0 - 0.5;
  let i = vec2i(floor(uv));
  let f = fract(uv);
  let g = mix(mix(fogGlowAt(i), fogGlowAt(i + vec2i(1, 0)), f.x), mix(fogGlowAt(i + vec2i(0, 1)), fogGlowAt(i + vec2i(1, 1)), f.x), f.y);
  let r = abs(n * 2.0 - 1.0);
  return g * (1.0 - smoothstep(0.85, 1.0, max(r.x, r.y)));
}

/** Noise-free bank extinction at height y (the CPU's fogBankMeanSigma). */
fn fogBankMeanSigma(y: f32) -> f32 {
  let h = (y - FOG.medium.z) / FOG.bank.y;
  let k = FOG.bank.x * 0.5 * (1.0 - FOG.bank2.x);
  if (h < 0.0) { return k; }
  return k * pow(max(1.0 - h, 0.0), 1.2);
}
/** Bank extinction at p: billows drifting with the wind, wisps counter-drifting through them, a rolling top. */
fn fogBankSigma(p: vec3f) -> f32 {
  let h = (p.y - FOG.medium.z) / FOG.bank.y;
  let t = FOG.wind.z;
  let q = p * FOG.bank.z;
  let w = vec3f(FOG.wind.x, 0.0, FOG.wind.y) * (t * FOG.bank.z);
  let n1 = fogNoise3(q - w + vec3f(0.0, t * 0.015, 0.0));
  let n2 = fogNoise3(q * 2.3 + vec3f(1.7, 0.9, 2.5) + w * 0.5 + n1 * 0.6);
  let n = clamp(((n1 * 0.68 + n2 * 0.32) - 0.5) * 1.9 + 0.5, 0.0, 1.0);
  let top = 1.0 - clamp(h - (n - 0.5) * FOG.bank3.y, 0.0, 1.0);
  let gaps = FOG.bank2.x;
  return FOG.bank.x * max(n - gaps, 0.0) / (1.0 - gaps) * pow(top, 1.2);
}
/** The bank along eye + rd · [0, dist]: rgb in-scatter, a transmittance. */
fn fogBank(eye: vec3f, rd: vec3f, dist: f32, jitter: f32) -> vec4f {
  let base = FOG.medium.z;
  let top = base + FOG.bank.y * (1.0 + 0.5 * FOG.bank3.y);
  let dy = select(min(rd.y, -1e-5), max(rd.y, 1e-5), rd.y >= 0.0);
  let ta = (base - 1.0 - eye.y) / dy;
  let tb = (top - eye.y) / dy;
  let reach = FOG.bank2.y;
  let t0 = max(min(ta, tb), 0.0);
  let t1 = min(min(max(ta, tb), dist), reach);
  if (t1 <= t0) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  let n = u32(FOG.bank.w);
  let dt = (t1 - t0) / f32(n);
  var T = 1.0;
  var centre = vec3f(0.0);
  var weight = 0.0;
  for (var i = 0u; i < n; i++) {
    let s = t0 + (f32(i) + jitter) * dt;
    let p = eye + rd * s;
    let sig = fogBankSigma(p) * (1.0 - smoothstep(reach * 0.6, reach, s));
    let a = exp(-sig * dt);
    let wgt = T * (1.0 - a);
    centre += p * wgt;
    weight += wgt;
    T *= a;
  }
  if (weight < 1e-5) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  // Sky-lit fog colour plus the lamp glow where the bank scatters most, faded by the height fog in front of it.
  let mid = centre / weight;
  let col = fogColor() * FOG.bank2.z + fogGlow(mid.xz) * FOG.bank2.w * fogTransmittance(eye, mid);
  return vec4f(col * (1.0 - T), T);
}

/** The cloud deck along rd (before a surface at dist): rgb its colour × opacity, a 1 − opacity. */
fn fogCloud(eye: vec3f, rd: vec3f, dist: f32, pixelAngle: f32) -> vec4f {
  let rise = FOG.medium.z + FOG.cloud.x - eye.y;
  if (rd.y < 0.01 || rise <= 0.0) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  let t = rise / rd.y;
  if (t >= dist) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  let hit = eye + rd * t;
  let drift = FOG.cloud2.zw * (FOG.wind.w * FOG.wind.z);
  let q = (hit.xz - drift) * FOG.cloud.z;
  // A pixel's footprint on the deck in noise units: it widens with distance and by 1/sin(elevation).
  let foot = t * pixelAngle / rd.y * FOG.cloud.z;
  var n = 0.0;
  var amp = 0.5;
  var f = 1.0;
  var norm = 0.0;
  for (var k = 0; k < 4; k++) {
    // Octaves finer than a couple of footprints fade to their mean, so the far deck doesn't shimmer.
    let keep = 1.0 - smoothstep(0.25, 0.5, foot * f);
    n += amp * mix(0.5, fogNoise2(q * f + vec2f(f32(k) * 17.3, f32(k) * 5.1)), keep);
    norm += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  n = clamp((n / norm - 0.5) * 2.2 + 0.5, 0.0, 1.0);
  // Analytic edge AA: the edge band is how far the noise moves across one pixel.
  let c = 1.0 - FOG.cloud.y;
  let w = max(foot * 2.2, 0.03);
  let a = smoothstep(c - w, c + w, n) * FOG.cloud.w * (1.0 - smoothstep(0.8, 1.0, t / dist));
  let tc = fogTransmittance(eye, hit);
  let body = fogColor() * FOG.cloud2.x + fogGlow(hit.xz) * FOG.cloud2.y * (0.6 + 0.4 * smoothstep(c, 1.0, n));
  return vec4f(a * (body * tc + fogColor() * (1.0 - tc)), 1.0 - a);
}
`

export type FogScatterHooks = {
  /** Extra WGSL declarations (e.g. the game's custom uniform struct at binding 13). */
  declarations?: string
  /** WGSL f32 expression of `p: vec3f, n: vec3f, footprint: f32`: wetness (0..1). Footprint is metres/pixel. Default dry. */
  wet?: string
  /** WGSL f32 expression of `p, n`: surface roughness for the wet reflection (default 0.5). */
  roughness?: string
  /** WGSL vec3f expression of `p`: the surface normal; default rebuilt from depth. */
  normal?: string
  /** Deterministic quadrature over the reflection lobe (1 keeps the stochastic path). */
  reflectionSamples?: number
  /** Maximum HDR channel per reflected-airlight sample, before Fresnel and wetness. */
  reflectionCap?: string
  /**
   * Wet reflections follow the scene's own surfaces: roughness from the HDR-alpha tag
   * (`@arcade/kit/gpu/reflections/surface`), wetness Ashwood's gloss weight smoothstep(cutoff, 0.2·cutoff, rough) ×
   * dielectric. Replaces `wet` and `roughness`.
   */
  surface?: boolean
  /** WGSL f32: roughness above which nothing reflects (surface mode, default 0.85). */
  cutoff?: string
  /** WGSL f32: reflectance of wet dielectrics (surface mode, default 0.5). */
  dielectric?: string
  /** WGSL vec4f of `packWet` settings: tilts the mirror normal by the wet film's ripple (flat in puddles). */
  wetSettings?: string
  /** Material whose puddles the ripple follows (default asphalt). */
  wetMaterial?: WetMaterial
  /**
   * Compile the atmosphere (fog bank, cloud deck, glow map; `fogAtmosphereWgsl`) into the shader. Off by default so
   * games without it, and software-GPU smoke runs, compile exactly the plain fog.
   */
  atmosphere?: boolean
}

/**
 * The fog volume shader for `Renderer` `shaders.volume` (with depth and its own history). Reads `FogParams` (18), the
 * scatter lamps (19), the scene depth (3) and the unjittered `VolumeFrame` (4); writes rgb in-scatter, alpha 0.
 */
export function fogScatterVolume(hooks: FogScatterHooks = {}): VolumeLightShader {
  const reflectionSamples = Math.max(1, Math.min(8, Math.round(hooks.reflectionSamples ?? 1)))
  const atmo = !!hooks.atmosphere
  return {
    depth: true,
    history: true,
    ...(hooks.surface ? { color: true } : {}),
    transmittance: true,
    code: /* wgsl */ `
${common}
${volumeFrameWgsl}
${fogParamsWgsl}
${fogConeWgsl}
${hooks.surface ? sceneSurfaceWgsl : ""}
${hooks.wetSettings ? wetSurfaceWgsl : ""}
struct FogLamp { a: vec4f, b: vec4f, c: vec4f, d: vec4f, e: vec4f }
// Five vec4f per lamp for ${MAX_FOG_LAMPS} lamps, then the ${FOG_GLOW_SIZE}² lamp-glow map.
@group(0) @binding(${FOG_LAMP_BINDING}) var<storage, read> fogLampData: array<vec4f>;
fn fogLamp(i: u32) -> FogLamp {
  let o = i * 5u;
  return FogLamp(fogLampData[o], fogLampData[o + 1u], fogLampData[o + 2u], fogLampData[o + 3u], fogLampData[o + 4u]);
}
${atmo ? fogAtmosphereWgsl : ""}
${hooks.declarations ?? ""}
fn fogWet(p: vec3f, n: vec3f, footprint: f32) -> f32 { return ${hooks.wet ?? "0.0"}; }
fn fogRoughness(p: vec3f, n: vec3f) -> f32 { return ${hooks.roughness ?? "0.5"}; }
${hooks.normal ? `fn fogNormal(p: vec3f) -> vec3f { return ${hooks.normal}; }` : ""}

struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f }
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: VO;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}

fn fogIgn(p: vec2f) -> f32 { return fract(52.9829189 * fract(dot(p, vec2f(0.06711056, 0.00583715)))); }

/** Single-scattered lamp light along ro + rd·[0, dist], equiangular-sampled per lamp. */
fn airlight(ro: vec3f, rd: vec3f, dist: f32, n: u32, jitter: f32) -> vec3f {
  var acc = vec3f(0.0);
  let g = FOG.scatter.z;
  let g2 = g * g;
  let leak = FOG.scatter.x;
  let count = u32(FOG.scatter.w);
${atmo ? `  // Where the bank thickens the air, the beams scatter more: σ(lamp) + mean bank σ over σ(lamp).
  let bankLamp = select(0.0, FOG.bank3.x, FOG.bank.w > 0.5);
` : ""}  for (var i = 0u; i < count; i++) {
    let L = fogLamp(i);
    let toL = L.a.xyz - ro;
    let s0 = dot(toL, rd);
    let h = max(sqrt(max(dot(toL, toL) - s0 * s0, 0.0)), 0.03);
    let a = max(s0 - L.a.w, 0.0);
    let b = min(s0 + L.a.w, dist);
    if (b <= a) { continue; }
    let ta = atan((a - s0) / h);
    let tb = atan((b - s0) / h);
    var sum = 0.0;
    for (var j = 0u; j < n; j++) {
      let t = mix(ta, tb, (jitter + f32(j)) / f32(n));
      let lx = rd * (s0 + h * tan(t)) - toL;
      let ld = max(length(lx), 1e-3);
      let ln = lx / ld;
      // The refractor leaks a little light sideways: that leak draws the small round halo round each head.
      let cone = fogLampCone(dot(ln, L.c.xyz), L.b.w, L.c.w) * (1.0 - leak) + leak;
      let r4 = ld / L.a.w;
      let win = pow(clamp(1.0 - r4 * r4 * r4 * r4, 0.0, 1.0), 2.0) * smoothstep(0.0, L.d.x, ld) * exp(-ld / FOG.scatter.y);
      let cosT = -dot(ln, rd);
      let hg = (1.0 - g2) / pow(max(1.0 + g2 - 2.0 * g * cosT, 1e-4), 1.5);
      var thick = 1.0;
${atmo ? "      if (bankLamp > 0.0) { thick += bankLamp * fogBankMeanSigma(ro.y + rd.y * (s0 + h * tan(t))) / max(L.e.w, 1e-5); }" : ""}
      sum += cone * win * mix(1.0, hg, 0.85) * thick;
    }
    acc += L.b.rgb * sum * (tb - ta) / (h * f32(n) * 12.566371);
  }
  return acc;
}

@fragment fn fs(o: VO) -> @location(0) vec4f {
  // Alpha is the transmittance the scene behind keeps (the slot composites scene · a + rgb): 1 leaves it as it was.
  if (FOG.medium.w < 0.5 || (FOG.scatter.w < 0.5${atmo ? " && FOG.bank.w < 0.5 && FOG.cloud.w <= 0.0" : ""})) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  let eye = V.eye.xyz;
  let d = volumeDepth(o.uv);
  let sky = volumeIsSky(d);
  let w0 = volumeUnproject(o.uv, d);
  let footprint = max(length(dpdx(w0)),length(dpdy(w0)));
  let rd = normalize(w0 - eye);
  let dist = select(length(w0 - eye), ${FOG_SKY_DISTANCE.toFixed(1)}, sky);
  let px = floor(o.pos.xy);
  // Interleaved gradient noise slid by 5.588238 px a frame (Jimenez): each pixel gets a well spread sequence and
  // neighbours stay decorrelated, so the history converges to noise-free rather than to the noise's diagonal pattern.
  let jitter = fogIgn(px + V.eye.w * 5.588238);
  let samples = u32(max(FOG.reflect.x, 1.0));
  var acc = airlight(eye, rd, dist, samples, jitter);
  // Clouds behind the bank, then the bank in front of everything: rgb in-scatter, a the transmittance.
  var trans = 1.0;
${atmo ? `  if (FOG.cloud.w > 0.0 && rd.y > 0.01) {
    let texel = 1.0 / V.size.xy;
    let pixelAngle = length(normalize(volumeUnproject(o.uv + vec2f(texel.x, 0.0), d) - eye) - rd);
    let cl = fogCloud(eye, rd, dist, pixelAngle);
    acc += cl.rgb;
    trans *= cl.a;
  }
  if (FOG.bank.w > 0.5) {
    let bank = fogBank(eye, rd, dist, fogIgn(px + vec2f(13.0, 71.0) + V.eye.w * 5.588238));
    // Beams start both in front of and behind the bank: they keep the square root of its transmittance.
    acc = acc * sqrt(bank.a) + bank.rgb;
    trans *= bank.a;
  }
` : ""}
  if (!sky && (FOG.reflect.y > 0.0 || FOG.reflect.z > 0.0) && FOG.scatter.w > 0.5) {
    let world = eye + rd * dist;
    ${hooks.normal ? `var nW = normalize(fogNormal(world));` : `var nW = volumeNormalAtTexel(volumeTexel(o.uv), eye);`}
    if (dot(nW, rd) > 0.0) { nW = -nW; }
    ${hooks.surface ? `let rough = sceneRoughness(o.uv);
    let wet = smoothstep(${hooks.cutoff ?? "0.85"}, ${hooks.cutoff ?? "0.85"} * 0.2, rough) * (${hooks.dielectric ?? "0.5"}) * smoothstep(0.55, 0.85, nW.y);` : `let rough = clamp(fogRoughness(world, nW), 0.0, 1.0);
    let wet = clamp(fogWet(world, nW, footprint), 0.0, 1.0) * smoothstep(0.55, 0.85, nW.y);`}
    ${hooks.wetSettings ? `{
      let film = wetSurface(world, nW.y, rough, 1.0, footprint, ${hooks.wetSettings}, ${wetMaterialWgsl(hooks.wetMaterial ?? WET_ASPHALT)});
      let tilt = wetRipple(world, ${hooks.wetSettings}, film.flat);
      nW = normalize(nW + vec3f(tilt.x, 0.0, tilt.y));
    }` : ""}
    if (wet > 0.002) {
      // Rough wet ground smears the reflection vertically: tilt the mirror normal by a per-pixel random amount
      // along the view's vertical plane (the history and TAA integrate it into long streaks).
      let n2 = fogIgn(px + vec2f(37.0, 11.0) + V.eye.w * 5.588238);
      let tilt = (n2 - 0.5) * rough * rough * FOG.reflect.w;
      let side = normalize(cross(rd, vec3f(0.0, 1.0, 0.0)) + vec3f(1e-5, 0.0, 0.0));
      let fwd = normalize(cross(vec3f(0.0, 1.0, 0.0), side));
      let nT = normalize(nW + fwd * tilt);
      let rr = normalize(reflect(rd, nT));
      let cosV = clamp(-dot(rd, nW), 0.0, 1.0);
      let fres = 0.04 + 0.96 * pow(1.0 - cosV, 5.0);
      let T = fogTransmittance(eye, world);
      ${reflectionSamples > 1 ? `
      // A moving view rejects volume history. Integrate several lobe strata in the current frame rather than exposing
      // one random bright ray; the strata are jittered per pixel and frame (n2), so their separate images of a lamp
      // merge into one streak instead of ending in a bright dot at the outermost stratum.
      var refl = vec3f(0.0);
      // Keep the loop bound uniform-driven: software Vulkan compilers can otherwise inline/unroll the entire
      // nested airlight integrator once per lobe tap. The ray budget also bounds quadrature at low quality.
      let taps=min(${reflectionSamples}u,samples);
      for(var tap=0u;tap<taps;tap++) {
        let u=(f32(tap)+n2)/f32(taps);
        let rn=normalize(nW+fwd*(u-0.5)*rough*rough*FOG.reflect.w);
        let sample=airlight(world+nW*0.02,normalize(reflect(rd,rn)),250.0,max(2u,samples/4u),jitter);
        refl+=sample*min(1.0,(${hooks.reflectionCap ?? "4.0"})/max(max(sample.r,max(sample.g,sample.b)),1e-5));
      }
      refl/=f32(taps);` : `let refl = airlight(world + nW * 0.02, rr, 250.0, max(2u, samples / 2u), jitter);`}
      acc += refl * fres * wet * T * trans * FOG.reflect.y;
      // Emitter glints: a lobe around the un-jittered mirror direction per lamp, tight across and long along the
      // view's vertical plane, both widening with roughness; only seen from inside the lamp's cone.
      let rm = normalize(reflect(rd, nW));
      let across = rough * 0.02 + 0.004;
      let along = (rough * rough * 0.6 + 0.02) * FOG.reflect.w * 0.5;
      let vert = normalize(cross(side, rm));
      var gl = vec3f(0.0);
      let count = u32(FOG.scatter.w);
      for (var i = 0u; i < count; i++) {
        let L = fogLamp(i);
        let toL = L.a.xyz - world;
        let dl = max(length(toL), 0.5);
        let ld = toL / dl;
        let dx = dot(ld - rm, side);
        let dy = abs(dot(ld - rm, vert)) + abs(ld.y - rm.y);
        let lobe = exp(-(dx * dx / (across * across) + dy * dy / (along * along)));
        let aim = fogLampCone(dot(-ld, L.c.xyz), L.b.w - 0.1, L.c.w);
        gl += L.e.rgb * lobe * (aim * 0.9 + 0.1) / (dl * dl + 4.0) * exp(-dl * L.e.w);
      }
      acc += gl * fres * wet * T * trans * FOG.reflect.z;
    }
  }
  return vec4f(acc, trans);
}
`,
  }
}
