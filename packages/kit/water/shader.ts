/** Original WGSL. References: Finch, GPU Gems ch.1 (band splitting); GGX/Smith microfacet optics.
 * No Water Pro or Tidewater source is included. Inputs use world metres, seconds and linear radiance.
 */
export const WATER_WGSL = /* wgsl */ `
// Returns slope xz and unresolved slope variance. Filter continuously before Nyquist.
fn waterDetail(p: vec2f, t: f32, footprint: f32, scale: f32, strength: f32) -> vec3f {
  var slope = vec2f(0.0);
  var variance = 0.0;
  for (var i = 0u; i < 12u; i++) {
    let fi = f32(i);
    let angle = fi * 2.39996323 + 0.37;
    let dir = vec2f(cos(angle), sin(angle));
    let wavelength = max(scale, 0.1) * 2.4 * pow(0.79, fi);
    let k = 6.2831853 / wavelength;
    let weight = 1.0 - smoothstep(0.12, 0.45, footprint / wavelength);
    let amplitude = strength * 0.7 * pow(0.85, fi);
    // Whole cycles per hour preserve Carrier's 3600 s phase wrap.
    let omega = round(sqrt(9.81 * k) * 3600.0 / 6.2831853) * (6.2831853 / 3600.0);
    let phase = k * dot(dir, p) - omega * t + fi * 7.13;
    slope += dir * cos(phase) * amplitude * weight;
    variance += 0.5 * amplitude * amplitude * (1.0 - weight * weight);
  }
  return vec3f(slope, variance);
}

fn waterFresnel(noV: f32) -> f32 {
  return 0.02037 + 0.97963 * pow(1.0 - clamp(noV, 0.0, 1.0), 5.0);
}

// BRDF times NoL. Roughness includes filtered-away slope variance, avoiding sharp distant fireflies.
fn waterSpecular(n: vec3f, v: vec3f, l: vec3f, roughness: f32, variance: f32, angularRadius: f32) -> f32 {
  let noV = max(dot(n, v), 0.001);
  let noL = max(dot(n, l), 0.0);
  let halfSum = l + v;
  let h = halfSum / max(length(halfSum), 0.001);
  let noH = max(dot(n, h), 0.0);
  let alpha2 = clamp(pow(roughness, 4.0) + variance, 0.0001, 1.0);
  let d = noH * noH * (alpha2 - 1.0) + 1.0;
  // The caller supplies the representative point on a finite light disc. Keep its energy
  // when that point broadens the lobe; otherwise a wide stylised sun paints a white stripe.
  let widenedAlpha = min(sqrt(alpha2) + tan(angularRadius) / 3.0, 1.0);
  let distribution = alpha2 / (3.14159265 * d * d) * alpha2 / (widenedAlpha * widenedAlpha);
  let gv = noL * sqrt(noV * noV * (1.0 - alpha2) + alpha2);
  let gl = noV * sqrt(noL * noL * (1.0 - alpha2) + alpha2);
  let visibility = 0.5 / max(gv + gl, 0.0001);
  return distribution * visibility * waterFresnel(dot(v, h)) * noL;
}

fn waterTransmission(absorption: vec3f, depth: f32, viewCos: f32) -> vec3f {
  let refractedCos = sqrt(max(1.0 - (1.0 - viewCos * viewCos) / (1.333 * 1.333), 0.0));
  return exp(-max(absorption, vec3f(0.0)) * max(depth, 0.0) / max(refractedCos, 0.1));
}
`
