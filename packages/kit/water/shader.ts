/** Original WGSL. References: Finch, GPU Gems ch.1 (band splitting); GGX/Smith microfacet optics.
 * No Water Pro or Tidewater source is included. Inputs use world metres, seconds and linear radiance.
 */
export const WATER_WGSL = /* wgsl */ `
fn waterHash(p: vec2i) -> f32 {
  var h = (bitcast<u32>(p.x) * 1597334677u) ^ (bitcast<u32>(p.y) * 3812015801u);
  h = (h ^ (h >> 16u)) * 2246822519u;
  return f32(h ^ (h >> 13u)) / 4294967295.0;
}

// Quintic noise with analytic gradient: height, d/dx, d/dy. No repeated wave train.
fn waterNoise(p: vec2f) -> vec3f {
  let cell = vec2i(floor(p));
  let f = fract(p);
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  let du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  let a = waterHash(cell);
  let b = waterHash(cell + vec2i(1, 0));
  let c = waterHash(cell + vec2i(0, 1));
  let d = waterHash(cell + vec2i(1, 1));
  let crossTerm = a - b - c + d;
  return vec3f(a + (b-a)*u.x + (c-a)*u.y + crossTerm*u.x*u.y,
    du * (vec2f(b-a, c-a) + crossTerm * u.yx));
}

// Returns slope xz and unresolved variance, from independent scales of irregular chop.
// The drift follows a closed hour-long orbit, preserving Carrier's clock wrap.
fn waterDetail(p: vec2f, t: f32, footprint: f32, scale: f32, strength: f32) -> vec3f {
  var slope = vec2f(0.0);
  var variance = 0.0;
  let orbit = 6.2831853 * t / 3600.0;
  let drift = vec2f(sin(orbit), 1.0 - cos(orbit)) * (3600.0 / 6.2831853);
  let warp = vec2f(waterNoise(p / 37.0 + drift * 0.013).x,
    waterNoise(p / 53.0 + vec2f(17.2, 91.7) - drift * 0.009).x) - 0.5;
  for (var i = 0u; i < 7u; i++) {
    let fi = f32(i);
    let angle = fi * 2.183 + 0.37;
    let dir = vec2f(cos(angle), sin(angle));
    let side = vec2f(-dir.y, dir.x);
    let wavelength = max(scale, 0.1) * 55.0 * pow(0.37, fi);
    let weight = 1.0 - smoothstep(0.15, 0.65, footprint / wavelength);
    let amplitude = strength * (0.65 + 0.35 * sin(fi * 0.7)) * pow(0.86, fi);
    let pos = p / wavelength + warp * 1.7;
    let local = vec2f(dot(pos, dir), dot(pos, side) * 0.63) + drift * (0.16 / sqrt(wavelength)) + fi * 19.13;
    let g = waterNoise(local).yz;
    slope += (dir * g.x + side * g.y * 0.63) * amplitude * weight;
    variance += 0.35 * amplitude * amplitude * (1.0 - weight * weight);
  }
  return vec3f(slope, variance);
}

// Surface coverage, not geometry. Long broken filaments with fine bubble holes.
fn waterFoam(p: vec2f, coverage: f32, footprint: f32, age: f32) -> vec2f {
  let large = waterNoise(p * vec2f(0.14, 0.43)).x;
  let small = waterNoise(p * vec2f(0.8, 1.7) + large * 2.1).x;
  let fine = waterNoise(p * 5.3).x;
  let resolved = 1.0 - smoothstep(0.08, 0.7, footprint);
  let holes = mix(0.5, fine, resolved);
  let field = 0.48 * large + 0.37 * small + 0.15 * holes;
  let edge = 0.045 + min(footprint * 0.04, 0.16);
  let threshold = 0.77 - coverage * 0.30;
  let mask = smoothstep(threshold - edge, threshold + edge, field) * smoothstep(0.02, 0.4, coverage);
  return vec2f(mask, 0.88 + 0.12 * holes);
}

// Sparse microfacet images with continuous scale blending and smooth angular visibility.
// Cells are world-anchored; only the actual moving water normal changes their alignment.
fn waterGlints(p: vec2f, n: vec3f, v: vec3f, l: vec3f, footprint: f32) -> f32 {
  let level = max(0.0, log2(max(footprint * 1.6, 0.16) / 0.16));
  let base = floor(level);
  var glints = 0.0;
  for (var i = 0u; i < 2u; i++) {
    let cellSize = 0.16 * exp2(base + f32(i));
    let point = p / cellSize;
    let cell = vec2i(floor(point));
    let h = vec3f(waterHash(cell), waterHash(cell + vec2i(527, 83)), waterHash(cell + vec2i(71, 357)));
    let micro = normalize(n + vec3f((h.x - 0.5) * 0.38, 0.0, (h.y - 0.5) * 0.38));
    let angular = smoothstep(0.9978, 0.99965, dot(reflect(-v, micro), l));
    let local = fract(point) - (0.25 + h.xy * 0.5);
    let shape = exp(-dot(local,local) / 0.025);
    let blend = select(1.0 - fract(level), fract(level), i == 1u);
    glints += angular * shape * blend;
  }
  return glints * (1.0 - smoothstep(4.0, 18.0, footprint));
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
