// Small shared helpers for world shaders. The BRIGHT STYLIZED look uses plain THREE.Fog; the old
// golden directional haze and ink are gone, but these exports stay so existing imports compile.
import { Color, type Material } from "three"

/** sRGB-encoded colour for uniforms that are mixed after colorspace conversion. */
export function srgbColor(hex: string): Color {
  return new Color(hex).convertLinearToSRGB()
}

/** No-op (the haze is now the standard scene fog). Returns the material unchanged. */
export function applyGoldenHaze<T extends Material>(material: T): T {
  return material
}
