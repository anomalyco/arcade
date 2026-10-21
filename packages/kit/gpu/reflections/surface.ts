/**
 * Reflective-surface tag in the HDR alpha. The kit has no G-buffer, so a scene that wants screen-space reflections
 * (`./ssr`) or surface-driven wet fog reflections (`fogScatterVolume({ surface: true })`) writes each physical
 * surface's perceptual roughness into the alpha of its opaque fragments: alpha = 1 + (1 − roughness). Everything
 * else keeps alpha 1 (roughness 1, never reflects). Post passes read it from this frame's scene colour before the
 * temporal resolve (`VolumeLightShader.color`); MSAA averages it across an edge, which reads as a rougher edge.
 *
 * Outbreak packs its shroud (1 + 4 × unseen) into the same channel, so a game uses one or the other.
 */
import { VOLUME_COLOR_BINDING } from "../volume-pass"

/** Encoded alpha for an opaque surface of this perceptual roughness (CPU mirror of the WGSL). */
export const encodeSurfaceAlpha = (roughness: number): number => 2 - Math.min(1, Math.max(0, roughness))
/** Roughness decoded from an HDR alpha; 1 (no reflection) for untagged alpha ≤ 1. */
export const decodeSurfaceRoughness = (alpha: number): number => (alpha > 1 ? Math.min(1, Math.max(0, 2 - alpha)) : 1)

/**
 * `SceneHooks.fragmentReturn` that tags every physical (PBR) opaque surface with its `pbrRough`. Pass a WGSL f32
 * expression to tag something else (e.g. `"select(1.0, pbrRough, mat == 20)"` for one material).
 */
export function reflectiveSurfaceReturn(roughness = "select(1.0, pbrRough, pbrRough >= 0.0)"): string {
  return /* wgsl */ `{
    let reflectRough = clamp(${roughness}, 0.0, 1.0);
    return vec4f(select(col * a, col, mat == 22 && o.aux >= -1.5), select(a, a + 1.0 - reflectRough, a >= 0.999));
  }`
}

/** Post-pass side (needs `VolumeLightShader.color` and `volumeFrameWgsl`): scene colour and decoded roughness. */
export const sceneSurfaceWgsl = /* wgsl */ `
@group(0) @binding(${VOLUME_COLOR_BINDING}) var sceneColor: texture_2d<f32>;
fn scenePixel(uv: vec2f) -> vec2i {
  let s = vec2i(textureDimensions(sceneColor));
  return clamp(vec2i(uv * vec2f(s)), vec2i(0), s - 1);
}
fn sceneColorAt(uv: vec2f) -> vec3f { return textureLoad(sceneColor, scenePixel(uv), 0).rgb; }
/** Perceptual roughness of the surface at uv; 1 where nothing tagged it. */
fn sceneRoughness(uv: vec2f) -> f32 {
  let a = textureLoad(sceneColor, scenePixel(uv), 0).a;
  return select(1.0, clamp(2.0 - a, 0.0, 1.0), a > 1.0);
}
/** Ashwood's reflection weight: glossy surfaces only (rough ones fade out by cutoff), dielectrics at \`dielectric\`. */
fn reflectionGloss(rough: f32, cutoff: f32, dielectric: f32) -> f32 {
  return smoothstep(cutoff, cutoff * 0.25, rough) * dielectric;
}
`
