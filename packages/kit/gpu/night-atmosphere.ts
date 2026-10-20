/** Shared outdoor height-fog, light-pollution sky and finite lamp scattering, in linear HDR.
 * `common` (gpu/shaders) supplies noise2/fbm. No game coordinates are embedded here. */
export const nightAtmosphere = /* wgsl */ `
fn nightSky(ray: vec3f, strength: f32) -> vec3f {
  let horizon = exp(-max(ray.y, 0.0) * 6.0);
  let cloud = fbm(ray.xz * 5.0 / max(0.2, ray.y + 0.45));
  return mix(vec3f(0.0015, 0.003, 0.006), vec3f(0.019, 0.024, 0.028), horizon) * (0.7 + cloud * 0.45) * strength;
}
fn heightFog(eye: vec3f, point: vec3f, density: f32, falloff: f32) -> f32 {
  let delta = point - eye;
  let t = clamp(delta.y * falloff, -30.0, 30.0);
  // Taylor limit at horizontal rays; avoids the zero-over-zero horizon seam.
  var integral = 1.0 - t * 0.5;
  if (abs(t) > 0.001) { integral = (1.0 - exp(-t)) / t; }
  return 1.0 - exp(-density * length(delta) * exp(-max(eye.y, 0.0) * falloff) * integral);
}
fn lampScatter(eye: vec3f, point: vec3f, lamp: vec3f, radius: f32) -> f32 {
  let delta = point - eye;
  let distance = length(delta);
  let ray = delta / max(distance, 0.001);
  let along = clamp(dot(lamp - eye, ray), 0.0, distance);
  let separation = length(eye + ray * along - lamp);
  return exp(-separation * separation / (radius * radius)) * (1.0 - exp(-distance * 0.05));
}
`
