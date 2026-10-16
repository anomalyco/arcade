/**
 * The simple survivor's surface (vertices with `aux == HERO_AUX`, see `hero.ts`): the lit colour with its range
 * compressed toward one flat tone, grey light on the figure's own tone as colour is taken away, and a tight grazing
 * rim on the silhouette edge. `OL.hero` is rim strength, rim exponent, flatten and colour kept.
 *
 * Soft Bean (vertices with `aux == BEAN_AUX`): its light already wraps past the terminator (the light loop's
 * diffuseTerm reads `outbreakWrap`), so lamps and the beam roll softly round it. On top, a sheen brightens the lit
 * colour toward the silhouette like matte vinyl or clay, and a faint rim in its own colour keeps the outline in the
 * dark. `OL.bean` is wrap, sheen, sheen exponent and own colour.
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

fn outbreakBeanSurface(col: vec3f, albedo: vec3f, n: vec3f, V: vec3f, warm: f32, losScale: f32) -> vec3f {
  let fres = pow(1.0 - max(dot(n, V), 0.0), max(OL.bean.z, 1.0));
  let sheen = col * fres * OL.bean.y * 1.4;
  let rimCol = mix(vec3f(0.20, 0.24, 0.30), vec3f(0.26, 0.22, 0.17), warm) * max(F.ambient.w, 0.6) * (0.5 + 0.5 * losScale);
  return col + sheen + albedo * rimCol * fres * 0.6;
}
`

/** Marks Soft Bean's fragments for the light loop: its wrap + 1, or 0 for every other surface. */
export const outbreakBeanFragmentStartWgsl = /* wgsl */ `outbreakWrap = select(0.0, 1.0 + clamp(OL.bean.x, 0.0, 1.0), o.mat > 11.5 && o.mat < 12.5 && o.aux > 5.5 && o.aux < 6.5);`
