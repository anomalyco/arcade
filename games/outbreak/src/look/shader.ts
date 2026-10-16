/**
 * The simple survivor's surface (vertices with `aux == HERO_AUX`, see `hero.ts`): the lit colour with its range
 * compressed toward one flat tone, grey light on the figure's own tone as colour is taken away, and a tight grazing
 * rim on the silhouette edge. `OL.hero` is rim strength, rim exponent, flatten and colour kept.
 */
export const outbreakHeroWgsl = /* wgsl */ `
fn outbreakHeroSurface(col: vec3f, albedo: vec3f, n: vec3f, V: vec3f, warm: f32, losScale: f32) -> vec3f {
  let luma = vec3f(0.2126, 0.7152, 0.0722);
  let aLum = max(dot(albedo, luma), 1e-4);
  let light = max(dot(col, luma), 0.0) / aLum;
  let flatLight = mix(light, 0.55 * pow(light, 0.35), clamp(OL.hero.z, 0.0, 1.0));
  var c = col * (flatLight / max(light, 1e-4));
  c = mix(albedo * (dot(c, luma) / aLum), c, clamp(OL.hero.w, 0.0, 1.0));
  let rim = pow(1.0 - max(dot(n, V), 0.0), max(OL.hero.y, 1.0)) * OL.hero.x;
  let rimCol = mix(vec3f(0.20, 0.24, 0.30), vec3f(0.26, 0.22, 0.17), warm) * max(F.ambient.w, 0.6) * (0.5 + 0.5 * losScale);
  return c + rimCol * rim;
}
`
