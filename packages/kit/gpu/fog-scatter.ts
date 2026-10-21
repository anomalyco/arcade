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

export type Vec3 = readonly [number, number, number]

/** Lamps the scattering pass evaluates per pixel. */
export const MAX_FOG_LAMPS = 16
/** Floats per lamp in the scatter lamp buffer (five vec4f). */
export const FOG_LAMP_FLOATS = 20
/** Floats in the `FogParams` uniform (binding 18). */
export const FOG_UNIFORM_FLOATS = 48
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
}

export type FogUpdate = {
  eye: Vec3
  viewProj: ArrayLike<number>
  lamps: readonly FogLamp[]
}

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
  }
  private skyKey = ""
  private ambient: [Vec3, Vec3, Vec3] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]

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
  pad0: vec4f,
  pad1: vec4f,
  pad2: vec4f,
  pad3: vec4f,
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
}

/**
 * The fog volume shader for `Renderer` `shaders.volume` (with depth and its own history). Reads `FogParams` (18), the
 * scatter lamps (19), the scene depth (3) and the unjittered `VolumeFrame` (4); writes rgb in-scatter, alpha 0.
 */
export function fogScatterVolume(hooks: FogScatterHooks = {}): VolumeLightShader {
  const reflectionSamples = Math.max(1, Math.min(8, Math.round(hooks.reflectionSamples ?? 1)))
  return {
    depth: true,
    history: true,
    code: /* wgsl */ `
${common}
${volumeFrameWgsl}
${fogParamsWgsl}
${fogConeWgsl}
struct FogLamp { a: vec4f, b: vec4f, c: vec4f, d: vec4f, e: vec4f }
@group(0) @binding(${FOG_LAMP_BINDING}) var<storage, read> fogLamps: array<FogLamp>;
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
  for (var i = 0u; i < count; i++) {
    let L = fogLamps[i];
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
      sum += cone * win * mix(1.0, hg, 0.85);
    }
    acc += L.b.rgb * sum * (tb - ta) / (h * f32(n) * 12.566371);
  }
  return acc;
}

@fragment fn fs(o: VO) -> @location(0) vec4f {
  if (FOG.medium.w < 0.5 || FOG.scatter.w < 0.5) { return vec4f(0.0); }
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
  if (!sky && (FOG.reflect.y > 0.0 || FOG.reflect.z > 0.0)) {
    let world = eye + rd * dist;
    ${hooks.normal ? `var nW = normalize(fogNormal(world));` : `let texel = 1.0 / V.size.zw;
    let wx = volumeUnproject(o.uv + vec2f(texel.x, 0.0), volumeDepthAt(o.uv + vec2f(texel.x, 0.0)));
    let wy = volumeUnproject(o.uv + vec2f(0.0, texel.y), volumeDepthAt(o.uv + vec2f(0.0, texel.y)));
    var nW = normalize(cross(wy - world, wx - world));`}
    if (dot(nW, rd) > 0.0) { nW = -nW; }
    let rough = clamp(fogRoughness(world, nW), 0.0, 1.0);
    let wet = clamp(fogWet(world, nW, footprint), 0.0, 1.0) * smoothstep(0.55, 0.85, nW.y);
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
      // A moving view rejects volume history. Integrate several fixed lobe strata in the current frame rather than
      // exposing one random bright ray; no reactive-mask bypass can stabilize an undersampled reflection.
      var refl = vec3f(0.0);
      for(var tap=0u;tap<${reflectionSamples}u;tap++) {
        let u=(f32(tap)+0.5)/${reflectionSamples}.0;
        let rn=normalize(nW+fwd*(u-0.5)*rough*rough*FOG.reflect.w);
        let sample=airlight(world+nW*0.02,normalize(reflect(rd,rn)),250.0,max(2u,samples/4u),0.5);
        refl+=sample*min(1.0,(${hooks.reflectionCap ?? "4.0"})/max(max(sample.r,max(sample.g,sample.b)),1e-5));
      }
      refl/=${reflectionSamples}.0;` : `let refl = airlight(world + nW * 0.02, rr, 250.0, max(2u, samples / 2u), jitter);`}
      acc += refl * fres * wet * T * FOG.reflect.y;
      // Emitter glints: a lobe around the un-jittered mirror direction per lamp, tight across and long along the
      // view's vertical plane, both widening with roughness; only seen from inside the lamp's cone.
      let rm = normalize(reflect(rd, nW));
      let across = rough * 0.02 + 0.004;
      let along = (rough * rough * 0.6 + 0.02) * FOG.reflect.w * 0.5;
      let vert = normalize(cross(side, rm));
      var gl = vec3f(0.0);
      let count = u32(FOG.scatter.w);
      for (var i = 0u; i < count; i++) {
        let L = fogLamps[i];
        let toL = L.a.xyz - world;
        let dl = max(length(toL), 0.5);
        let ld = toL / dl;
        let dx = dot(ld - rm, side);
        let dy = abs(dot(ld - rm, vert)) + abs(ld.y - rm.y);
        let lobe = exp(-(dx * dx / (across * across) + dy * dy / (along * along)));
        let aim = fogLampCone(dot(-ld, L.c.xyz), L.b.w - 0.1, L.c.w);
        gl += L.e.rgb * lobe * (aim * 0.9 + 0.1) / (dl * dl + 4.0) * exp(-dl * L.e.w);
      }
      acc += gl * fres * wet * T * FOG.reflect.z;
    }
  }
  return vec4f(acc, 0.0);
}
`,
  }
}
