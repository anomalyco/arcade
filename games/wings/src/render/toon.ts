// "STORMFRONT" aircraft materials (WebGPU node materials): semi-realistic matte military paint with
// subtle per-panel variation and rain streaks (TSL noise), a wet clearcoat sheen, reflections of a
// storm-sky environment, clearcoated glass, and HDR emissives (afterburners, nav lights) for bloom.
import {
  Color,
  DataTexture,
  EquirectangularReflectionMapping,
  LinearFilter,
  MeshBasicNodeMaterial,
  MeshPhysicalNodeMaterial,
  RGBAFormat,
  SRGBColorSpace,
  UnsignedByteType,
  type ColorRepresentation,
  type Texture,
} from "three/webgpu"
import { dot, float, floor, fract, fwidth, materialColor, min, mix, mx_noise_float, positionLocal, sin, smoothstep, vec3 } from "three/tsl"

// ---------------------------------------------------------------------------------------------------------
// Paint remap (display/sRGB HSL space)

export type PaintKind = "hull" | "metal"

const _hsl = { h: 0, s: 0, l: 0 }

/**
 * Deterministic remap of an authored GLB color into muted military paint: desaturated olive/slate hulls,
 * neutral grays, near-blacks lifted to gunmetal.
 */
export function paintColor(src: Color, kind: PaintKind = "hull"): Color {
  const out = new Color()
  src.getHSL(_hsl, SRGBColorSpace)
  let { h, s, l } = _hsl
  if (l < 0.18) {
    h = 0.58
    s = 0.05
    l = 0.22 + l * 0.4
  } else if (s < 0.12) {
    h = 0.12
    s = Math.min(s, 0.04)
    l = Math.min(0.72, l)
  } else {
    s = Math.min(0.3, s * 0.5)
    l = Math.min(0.66, l)
  }
  if (kind === "metal") {
    s = Math.min(s, 0.05)
    l = Math.min(l, 0.45)
  }
  return out.setHSL(h, s, l, SRGBColorSpace)
}

// ---------------------------------------------------------------------------------------------------------
// Storm environment (reflections)

let envTex: Texture | null = null
let envOverride: Texture | null = null
const envUsers = new Set<MeshPhysicalNodeMaterial>()

/**
 * Small procedural equirect of a dark storm sky (dark slate clouds, brighter break band at the horizon,
 * dark sea below). PMREM-filtered automatically by the node renderer. Cheap stand-in until the world
 * provides its own sky environment via `setAircraftEnvironment`.
 */
export function stormEnvironment(): Texture {
  if (envTex) return envTex
  const w = 128
  const h = 64
  const data = new Uint8Array(w * h * 4)
  const zenith = new Color("#1e2a28")
  const cloud = new Color("#3a4744")
  const breakBand = new Color("#8a9690")
  const sea = new Color("#1f2b2a")
  const seaFar = new Color("#2e3b38")
  const c = new Color()
  for (let y = 0; y < h; y++) {
    // v = 0 top (zenith) … 1 bottom (nadir); elevation in [-1, 1].
    const elev = 1 - ((y + 0.5) / h) * 2
    for (let x = 0; x < w; x++) {
      const az = (x / w) * Math.PI * 2
      if (elev >= 0) {
        const t = Math.pow(elev, 0.6)
        c.copy(breakBand).lerp(cloud, Math.min(1, elev * 6)).lerp(zenith, t)
        // Brighter cloud breaks scattered around the horizon.
        const breaks = Math.max(0, Math.sin(az * 3 + 1.3) * Math.sin(az * 5 + 0.4)) * Math.max(0, 1 - elev * 3)
        c.lerp(breakBand, breaks * 0.5)
      } else {
        c.copy(seaFar).lerp(sea, Math.min(1, -elev * 4))
      }
      const i = (y * w + x) * 4
      data[i] = Math.round(c.r * 255)
      data[i + 1] = Math.round(c.g * 255)
      data[i + 2] = Math.round(c.b * 255)
      data[i + 3] = 255
    }
  }
  const tex = new DataTexture(data, w, h, RGBAFormat, UnsignedByteType)
  tex.mapping = EquirectangularReflectionMapping
  tex.colorSpace = SRGBColorSpace
  tex.magFilter = LinearFilter
  tex.minFilter = LinearFilter
  tex.needsUpdate = true
  envTex = tex
  return tex
}

/** Let the world/scene supply its own sky environment (e.g. a render of the storm sky); null = built-in. */
export function setAircraftEnvironment(tex: Texture | null): void {
  envOverride = tex
  for (const m of envUsers) {
    m.envMap = tex ?? stormEnvironment()
    m.needsUpdate = true
  }
}

function currentEnv(): Texture {
  return envOverride ?? stormEnvironment()
}

// ---------------------------------------------------------------------------------------------------------
// Materials

export interface PaintOptions {
  color: ColorRepresentation
  roughness?: number
  metalness?: number
  /** Wet clearcoat strength (0..1). */
  wet?: number
  envIntensity?: number
  vertexColors?: boolean
  /** Per-panel tone variation + rain streaks (TSL noise). */
  weathering?: boolean
}

/** Panel/streak variation multiplier for paint (≈0.86–1.06), from local position (sticks to the airframe). */
function weatherNode() {
  const p = positionLocal
  // Panels: a hashed tone per ~1.4 m cell gives a subtle patchwork, like repainted panels.
  const q = p.mul(0.7)
  const cell = floor(q)
  const panel = fract(sin(dot(cell, vec3(12.9898, 78.233, 37.719))).mul(43758.5453))
  // Panel lines: thin darker seams where the cell planes cut the surface (anti-aliased via fwidth).
  const f = fract(q)
  const d = min(min(f, f.oneMinus()).x, min(min(f, f.oneMinus()).y, min(f, f.oneMinus()).z))
  const seam = float(1).sub(smoothstep(float(0), fwidth(d).mul(1.5).add(0.006), d))
  // Streaky grime/rain: noise stretched along the fuselage axis (Z).
  const streak = mx_noise_float(p.mul(vec3(2.2, 2.2, 0.35))).mul(0.5).add(0.5)
  const fine = mx_noise_float(p.mul(9.0)).mul(0.5).add(0.5)
  return float(0.92).add(panel.mul(0.1)).sub(streak.mul(0.07)).add(fine.mul(0.03)).sub(seam.mul(0.14))
}

/** Matte military paint, smooth-shaded, with a wet clearcoat and storm-sky reflections. */
export function createPaintMaterial(opts: PaintOptions): MeshPhysicalNodeMaterial {
  const mat = new MeshPhysicalNodeMaterial({
    color: new Color(opts.color),
    roughness: opts.roughness ?? 0.66,
    metalness: opts.metalness ?? 0.05,
    clearcoat: opts.wet ?? 0.55,
    clearcoatRoughness: 0.28,
    vertexColors: opts.vertexColors ?? false,
  })
  mat.envMap = currentEnv()
  mat.envMapIntensity = opts.envIntensity ?? 0.9
  envUsers.add(mat)
  if (opts.weathering !== false) {
    const w = weatherNode()
    // Wet paint reads slightly darker; weathering varies tone and roughness together.
    mat.colorNode = materialColor.mul(w).mul(0.95)
    mat.roughnessNode = float(mat.roughness).mul(mix(float(1.08), float(0.9), smoothstep(0.88, 1.0, w)))
  }
  return mat
}

/** Glossy dark glass with a clearcoat; reflects the storm sky. */
export function createGlassMaterial(): MeshPhysicalNodeMaterial {
  const mat = new MeshPhysicalNodeMaterial({
    color: new Color("#141b22"),
    roughness: 0.06,
    metalness: 0.0,
    clearcoat: 1,
    clearcoatRoughness: 0.05,
    transparent: true,
    opacity: 0.62,
    depthWrite: false,
  })
  mat.envMap = currentEnv()
  mat.envMapIntensity = 1.6
  envUsers.add(mat)
  return mat
}

/**
 * Unlit emissive material for afterburners and lights. Colors are HDR (multiply `.color` above 1 for
 * bloom); `userData.baseColor` keeps the unscaled color for per-frame intensity changes.
 */
export function createGlowMaterial(color: ColorRepresentation, intensity = 1): MeshBasicNodeMaterial {
  const mat = new MeshBasicNodeMaterial({ color: new Color(color).multiplyScalar(intensity) })
  mat.userData.baseColor = new Color(color)
  return mat
}
