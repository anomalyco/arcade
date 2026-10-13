/**
 * Day-night shader helpers, part of ATMOSPHERE_WGSL (needs `F: Frame` in scope). Every helper returns the sunny look
 * exactly in daylight.
 *
 * The Frame's `extra` carries the day-night state: x = night 0..1, y = warm twilight 0..1, z = practical lights 0..1,
 * w = how much the moon is the key light 0..1 (all 0 in daylight, so every pass draws its sunny look exactly).
 */
export const DAYNIGHT_WGSL = /* wgsl */ `
/**
 * Cloud body light away from the sun: at day the fixed bright lavender-white of the sunny cumulus (shadow), at dusk and
 * at night the sky's own colours (undersides take the horizon, tops the zenith), so clouds glow pink-orange under a
 * sunset and turn dim slate-blue under the moon. Weather in daylight never changes it.
 */
fn cloudAmbient(shadow: vec3f, top: f32) -> vec3f {
  let sky = mix(F.horizon.rgb * 0.95, F.zenith.rgb * 1.5 + F.horizon.rgb * 0.25, top);
  let gain = mix(1.0, 0.9, F.extra.x);
  return mix(shadow, sky * gain, saturate(F.extra.x + F.extra.y));
}

/**
 * Sky ambient for a surface normal (the lit, ship, plane and weapon shaders): the day's hemisphere mix, leaning toward
 * the zenith in the warm twilight so silhouettes go violet-blue against an orange horizon instead of orange.
 */
fn ambientSky(n: vec3f) -> vec3f {
  let d = F.extra.y;
  return mix(F.horizon.rgb, F.zenith.rgb * (1.0 + 1.2 * d), saturate(max(n.y, 0.0) * 0.6 + 0.45 * d));
}
fn ambientBounce() -> vec3f { return F.horizon.rgb * vec3f(0.22, 0.32, 0.4) * (1.0 - 0.5 * F.extra.y); }
/** Share of the silhouette rim kept when the key light is weak (the sun below the horizon keeps only a hint). */
fn rimLight() -> f32 { return min(1.0, F.sunDir.w * 0.7 + 0.25); }

/** Soft cyan glow of breaking reef surf at night (fades in with the dark; nothing at dusk or by day). */
fn nightSurf(surf: f32) -> vec3f {
  let k = smoothstep(0.25, 0.9, F.extra.x);
  return vec3f(0.05, 0.62, 0.7) * (0.55 * k * saturate(surf * 1.6));
}
`
