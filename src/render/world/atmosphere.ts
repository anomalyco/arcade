// Storm atmosphere shared by all world node materials (TSL): noise helpers, the storm-sky colour
// function (used by the sky dome, the ocean's reflections and the fog colour, so they always meet
// seamlessly), height fog, and the shared lightning uniforms.
import { Color, DataTexture, LinearFilter, RedFormat, RepeatWrapping, UnsignedByteType, Vector2, Vector3, type Material } from "three"
import {
  Fn, If, abs, cameraPosition, select, clamp, dot, exp, float, floor, fog, fract, max, mix, normalize, positionWorld, pow, sin, smoothstep,
  texture, time, uniform, vec2, vec3,
} from "three/tsl"
import {
  BREAK_DIRECTION, CLOUD_DARK, CLOUD_LIGHT, FOG_BREAK_COLOR, FOG_COLOR, FOG_DENSITY_BASE, FOG_DENSITY_SEA, FOG_HEIGHT_FALLOFF,
  LIGHTNING_COLOR, SKY_ZENITH,
} from "./palette"

/** Linear working-space colour from an sRGB hex. */
export function linear(hex: string): Color {
  return new Color(hex)
}

/** Kept for compatibility: sRGB-encoded colour. */
export function srgbColor(hex: string): Color {
  return new Color(hex).convertLinearToSRGB()
}

/** No-op (node materials get the storm fog through scene.fogNode). */
export function applyGoldenHaze<T extends Material>(material: T): T {
  return material
}

/** TSL node graphs are built dynamically; their static types add little here. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type N = any

// ---------------------------------------------------------------------------------------------
// Shared uniforms

export const STORM = {
  /** Lightning flash intensity 0..1 (set every frame). */
  flash: uniform(0),
  /** World-space unit direction from the camera toward the current strike. */
  flashDir: uniform(new Vector3(0, 0.3, -1)),
  /** Horizontal wind (m/s) driving clouds, rain and foam streaks. */
  wind: uniform(new Vector2(9, 4)),
  /** Height-fog parameters (per quality / altitude tuning). */
  fogBase: uniform(FOG_DENSITY_BASE),
  fogSea: uniform(FOG_DENSITY_SEA),
  fogFalloff: uniform(1 / FOG_HEIGHT_FALLOFF),
  fogColor: uniform(linear(FOG_COLOR)),
  fogBreak: uniform(linear(FOG_BREAK_COLOR)),
  breakDir: uniform(new Vector2(...BREAK_DIRECTION).normalize()),
  cloudDark: uniform(linear(CLOUD_DARK)),
  cloudLight: uniform(linear(CLOUD_LIGHT)),
  zenith: uniform(linear(SKY_ZENITH)),
  lightning: uniform(linear(LIGHTNING_COLOR)),
}

// ---------------------------------------------------------------------------------------------
// Noise (cheap value noise; inputs should stay within a few thousand units)

/** Sin-free hash (stable for large coordinates on GPUs). */
export const hash21 = Fn(([p]: [N]) => {
  const p3: N = fract(vec3(p.x, p.y, p.x).mul(0.1031)).toVar()
  p3.addAssign(dot(p3, vec3(p3.y, p3.z, p3.x).add(33.33)))
  return fract(p3.x.add(p3.y).mul(p3.z))
})

/** Hash lattice for value noise (tiles every NOISE_SIZE cells; seeded, stable across runs). */
const NOISE_SIZE = 256
const noiseTexture = (() => {
  const data = new Uint8Array(NOISE_SIZE * NOISE_SIZE)
  let s = 0x9e3779b9
  for (let i = 0; i < data.length; i++) {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5
    data[i] = (s >>> 0) & 255
  }
  const t = new DataTexture(data, NOISE_SIZE, NOISE_SIZE, RedFormat, UnsignedByteType)
  t.wrapS = t.wrapT = RepeatWrapping
  t.magFilter = t.minFilter = LinearFilter
  t.generateMipmaps = false
  t.needsUpdate = true
  return t
})()

/**
 * Smooth value noise. Perf: one bilinear fetch from a hash lattice texture at the Hermite-remapped
 * coordinate equals the 4-hash + smoothstep-lerp version (was ~4× the ALU in every storm shader).
 * Uses an explicit LOD so it is legal inside dynamic branches.
 */
export const vnoise = Fn(([p]: [N]) => {
  const i: N = floor(p)
  const f: N = fract(p)
  const u: N = f.mul(f).mul(f.mul(-2).add(3))
  return texture(noiseTexture, i.add(u).add(0.5).div(NOISE_SIZE)).level(float(0)).r
})

/** fBm with `octaves` (compile-time) octaves, result ~0..1. */
export function fbm(p: N, octaves: number): N {
  let sum: N = float(0)
  let amp = 0.5, norm = 0
  let q: N = p
  for (let o = 0; o < octaves; o++) {
    sum = sum.add(vnoise(q).mul(amp))
    norm += amp
    // Rotate + scale each octave to hide the lattice.
    q = vec2(q.x.mul(1.6).sub(q.y.mul(1.2)), q.x.mul(1.2).add(q.y.mul(1.6))).add(vec2(17.3, -9.1))
    amp *= 0.5
  }
  return sum.div(norm)
}

// ---------------------------------------------------------------------------------------------
// Sky / fog colour

/** Horizon mist colour seen along direction `d` (brighter toward the cloud break, lit by lightning). */
export const horizonColor = Fn(([d]: [N]) => {
  const h = normalize(vec2(d.x, d.z).add(vec2(1e-5, 0)))
  const br = max(dot(h, STORM.breakDir), 0)
  const c = mix(STORM.fogColor, STORM.fogBreak, pow(br, 3).mul(0.85))
  const fl = max(dot(d, STORM.flashDir), 0)
  return c.add(STORM.lightning.mul(STORM.flash).mul(fl.mul(fl).mul(0.06).add(0.01)))
})

/**
 * Storm sky along direction `d` (unit): layered moving clouds above a misty horizon, brighter
 * breaks low toward BREAK_DIRECTION, local lightning illumination. `octaves` sets the detail.
 */
export function stormSky(d: N, octaves = 5): N {
  // Perf: below the horizon the result is the horizon mist alone, so the cloud noise runs in a branch
  // (looking down from altitude, or the sky dome behind the sea, costs almost nothing).
  return Fn(() => {
    const out: N = horizonColor(d).toVar()
    If(d.y.greaterThan(0), () => {
      const y = d.y
      const yc = max(y, 0.0).add(0.1)
      const proj = vec2(d.x, d.z).div(yc)
      const drift = STORM.wind.mul(time).mul(0.0022)
      const p = proj.mul(1.15).add(drift)
      const n1 = fbm(p, octaves)
      const n2 = fbm(p.mul(2.7).add(drift.mul(1.7)).add(vec2(5.2, 1.3)), Math.max(2, octaves - 2))
      const cover = smoothstep(0.32, 0.72, n1.mul(0.75).add(n2.mul(0.25)))
      // Lit tops of the billows vs dark bellies.
      const lit = smoothstep(0.45, 0.85, n2).mul(0.6).add(cover.oneMinus().mul(0.4))
      let clouds: N = mix(STORM.cloudDark, STORM.cloudLight, lit)
      // Breaks: thin cover near the horizon toward the break lets brighter mist through.
      const h = normalize(vec2(d.x, d.z).add(vec2(1e-5, 0)))
      const br = pow(max(dot(h, STORM.breakDir), 0), 2)
      const low = smoothstep(0.45, 0.04, y)
      const gap = smoothstep(0.55, 0.15, cover).mul(br).mul(low)
      clouds = mix(clouds, STORM.fogBreak.mul(1.35), gap.mul(0.8))
      // Zenith darkens.
      clouds = mix(clouds, STORM.zenith, smoothstep(0.25, 0.95, y).mul(0.55))
      // Lightning lights the cloud deck around the strike, denser cloud glows more.
      const fl = max(dot(d, STORM.flashDir), 0)
      const glow = pow(fl, 6).mul(0.9).add(fl.mul(0.12)).add(0.02)
      // Punch on cloud bellies, mostly above the horizon band.
      clouds = clouds.add(STORM.lightning.mul(STORM.flash).mul(glow).mul(cover.mul(0.8).add(0.2)).mul(smoothstep(0.03, 0.25, y)))
      // Melt into the horizon mist.
      out.assign(mix(out, clouds, smoothstep(0.0, 0.22, y)))
    })
    return out
  })()
}

// ---------------------------------------------------------------------------------------------
// Fog

/** Exponential height fog factor between the camera and the fragment's world position. */
export const fogFactor = Fn(() => {
  const toP = positionWorld.sub(cameraPosition)
  const dist = toP.length()
  const dy = toP.y.div(max(dist, 1e-3))
  const a = STORM.fogFalloff
  const k = dy.mul(dist).mul(a)
  // ∫ exp(-a h) along the ray, stable for horizontal rays.
  const seaTerm = select(abs(k).lessThan(1e-3), dist, exp(k.negate()).oneMinus().div(dy.mul(a)))
  const camH = max(cameraPosition.y, 0)
  const optical = STORM.fogBase.mul(dist).add(STORM.fogSea.mul(exp(camH.mul(a).negate())).mul(seaTerm))
  return clamp(exp(optical.negate()).oneMinus(), 0, 1)
})

/** The scene fog node: storm height fog tinted by the horizon colour along the view ray. */
export function stormFogNode() {
  const dir = normalize(positionWorld.sub(cameraPosition))
  return fog(horizonColor(vec3(dir.x, max(dir.y, 0), dir.z)), fogFactor())
}
