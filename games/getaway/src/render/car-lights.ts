import type { Vehicle } from "../../shared/config"

/** 0 is the original reference; 4 is the tunable default. */
export type LightStyle = 0 | 1 | 2 | 3 | 4
/** Automation override. Players choose styles in the Lab. */
export function lightStyle(params: URLSearchParams): LightStyle {
  const n = Number(params.get("lights") ?? 4)
  return n === 0 || n === 1 || n === 2 || n === 3 ? n : 4
}

/** Shared by the emissive lens, spotlight, beam, road pool and flare. */
export const HEADLIGHT: [number, number, number] = [1, 0.93, 0.78]
export const LIGHT_DEFAULTS = {
  beamLength: 12,
  beamWidth: 0.28,
  beamSpread: 2.4,
  beamIntensity: 0.13,
  poolSize: 3.2,
  poolIntensity: 0.1,
  poolAhead: 5,
  glowSize: 0.32,
  glowIntensity: 0.85,
  flareStrength: 0.09,
  tailGlow: 0.75,
  brakeIntensity: 1.9,
}
export type LightSettings = typeof LIGHT_DEFAULTS & { style: LightStyle }

/** Lens centres match the front/rear fascia geometry (local +z is forward). */
export function lampMounts(v: Vehicle) {
  const half = v.width / 2
  switch (v.id) {
    case "muscle": return { frontX: half - 0.32, frontY: 0.5, rearX: half - 0.33, rearY: 0.66 }
    case "cruiser": return { frontX: half - 0.37, frontY: 0.56, rearX: half - 0.35, rearY: 0.65 }
    case "interceptor": return { frontX: half - 0.38, frontY: 0.5, rearX: half - 0.37, rearY: 0.64 }
    case "compact": return { frontX: half - 0.31, frontY: 0.52, rearX: half - 0.23, rearY: 0.8 }
    case "van": return { frontX: half - 0.32, frontY: 0.58, rearX: half - 0.13, rearY: 1 }
    case "swat": return { frontX: half - 0.31, frontY: 0.8, rearX: half - 0.16, rearY: 1 }
    default: return { frontX: 0, frontY: 0.9, rearX: 0, rearY: 0.9 }
  }
}
