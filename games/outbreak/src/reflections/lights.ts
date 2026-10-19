import { LIGHT_FLOATS } from "@arcade/kit/limits"
import { inBuildingFootprint, type Building } from "../../shared/map"

/** Lights the wet ground can mirror in one frame. */
export const REFLECTION_LIGHTS = 8
/** Floats per light in `OL.reflLights`: image centre x, z, the light's plan distance from the eye, size; colour, 0. */
export const REFLECTION_LIGHT_FLOATS = 8

/**
 * Picks the outdoor lights whose mirror images land in view (`rect` is the camera's ground rect) for
 * `outbreakWetGlints` and works out each image on the CPU, so the shader's loop reads two uniforms per light and never
 * the light buffer: streetlamps, porch and window lights, fire, police lights and headlights, nearest the view's centre
 * first. Skips slot 0 (sight), the flashlight (its hotspot is mirrored on its own), table lamps, sconces and any light
 * inside a house other than a window's. The image sits where the eye sees the light in flat water at the ground under
 * it (`groundY`): a share `k = h / (h + eye height)` of the way from the light to the eye; a cone light only shows where
 * it points at that spot, and low sources (fire, headlights) get a broader image. A light with size 0 ends the list. Returns the light slots taken.
 */
export function packReflectionLights(
  lights: Float32Array,
  count: number,
  buildings: readonly Building[],
  rect: readonly [number, number, number, number],
  eye: readonly [number, number, number],
  groundY: (x: number, z: number) => number,
  out: Float32Array,
  offset: number,
): number[] {
  const cx = (rect[0] + rect[2]) / 2
  const cz = (rect[1] + rect[3]) / 2
  const picked: { slot: number; d: number; px: number; pz: number; size: number; dist: number; r: number; g: number; b: number }[] = []
  for (let i = 1; i < count; i++) {
    const o = i * LIGHT_FLOATS
    const power = lights[o + 7]!
    if (power <= 0.01) continue
    const type = lights[o + 11]!
    if (type < -2.5 || type > 1.125) continue
    const x = lights[o]!
    const z = lights[o + 2]!
    const window = type > 0.5
    if (!window && buildings.some((bd) => x > bd.rect[0] + 0.3 && x < bd.rect[2] - 0.3 && z > bd.rect[1] + 0.3 && z < bd.rect[3] - 0.3 && inBuildingFootprint(bd, x, z))) continue
    const gy = groundY(x, z)
    const hl = Math.max(lights[o + 1]! - gy, 0.05)
    const k = hl / (hl + Math.max(eye[1] - gy, 1))
    const px = x + (eye[0] - x) * k
    const pz = z + (eye[2] - z) * k
    // Low, broad sources (fire, headlights) mirror as a glossy smear rather than a point.
    const size = Math.min(0.95, Math.max(0.05 + lights[o + 14]! * 0.22, hl < 1.6 ? 0.2 : 0))
    const reach = size * 7.5 * 2.5
    if (px < rect[0] - reach || px > rect[2] + reach || pz < rect[1] - reach || pz > rect[3] + reach) continue
    let cone = 1
    if (type > 0.5) {
      const dx = px - x
      const dz = pz - z
      const l = Math.hypot(dx, dz)
      cone = l < 1e-3 ? 1 : Math.min(1, Math.max(0, ((dx * lights[o + 8]! + dz * lights[o + 9]!) / l - lights[o + 10]!) / 0.25))
      if (cone <= 0) continue
    }
    const s = power * cone
    picked.push({ slot: i, d: (px - cx) ** 2 + (pz - cz) ** 2, px, pz, size, dist: Math.hypot(x - eye[0], z - eye[2]), r: lights[o + 4]! * s, g: lights[o + 5]! * s, b: lights[o + 6]! * s })
  }
  picked.sort((a, b) => a.d - b.d)
  const taken = picked.slice(0, REFLECTION_LIGHTS)
  for (let k = 0; k < REFLECTION_LIGHTS; k++) {
    const o = offset + k * REFLECTION_LIGHT_FLOATS
    const p = taken[k]
    out[o] = p?.px ?? 0
    out[o + 1] = p?.pz ?? 0
    out[o + 2] = p?.dist ?? 0
    out[o + 3] = p?.size ?? 0
    out[o + 4] = p?.r ?? 0
    out[o + 5] = p?.g ?? 0
    out[o + 6] = p?.b ?? 0
    out[o + 7] = 0
  }
  return taken.map((p) => p.slot)
}
