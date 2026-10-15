/**
 * Shared WGSL surface wetness, puddle mask, raindrop ripple normal perturbation,
 * snow/frost accumulation, and wet light-reflection sheen helpers.
 *
 * Games and Lab shaders include `weatherSurfaceDeclarationsWgsl` and call
 * `applyWeatherGroundWetness` or `evalWeatherWetLightPool` with their per-frame
 * `wetness`, `puddleCoverage`, `rippleIntensity`, `snowAmount`, and `flash`.
 */
export const weatherSurfaceDeclarationsWgsl = /* wgsl */ `
fn weatherHash2(p: vec2f) -> f32 {
  let q = fract(p * vec2f(0.1031, 0.1030));
  let r = q + dot(q, q.yx + 33.33);
  return fract((r.x + r.y) * r.x);
}

fn weatherNoise2(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(weatherHash2(i), weatherHash2(i + vec2f(1.0, 0.0)), u.x),
    mix(weatherHash2(i + vec2f(0.0, 1.0)), weatherHash2(i + vec2f(1.0, 1.0)), u.x),
    u.y
  );
}

/**
 * Multi-scale organic puddle mask [0..1] for horizontal ground surfaces.
 * Puddles form in low-frequency depressions first and expand as puddleCoverage rises.
 */
fn evalWeatherPuddleMask(xz: vec2f, puddleCoverage: f32) -> f32 {
  if (puddleCoverage <= 0.001) { return 0.0; }
  let nLow = weatherNoise2(xz * 0.28 + vec2f(3.1, 7.4));
  let nMid = weatherNoise2(xz * 0.72 + vec2f(11.3, 2.9));
  let nHi  = weatherNoise2(xz * 2.15 + vec2f(5.7, 9.2));
  let field = nLow * 0.58 + nMid * 0.30 + nHi * 0.12;
  let threshold = clamp(0.68 - puddleCoverage * 0.30, 0.20, 0.78);
  return smoothstep(threshold - 0.08, threshold + 0.08, field) * clamp(puddleCoverage, 0.0, 1.35);
}

/**
 * Two-layer staggered concentric raindrop ripple normal perturbation (dx, dz) for puddles.
 * Band-limited by world-space pixel footprint so distant puddles never alias.
 */
fn evalWeatherPuddleRipple(xz: vec2f, time: f32, rippleStrength: f32, footprint: f32) -> vec2f {
  let fade = (1.0 - smoothstep(0.04, 0.18, footprint)) * clamp(rippleStrength, 0.0, 1.5);
  if (fade <= 0.002) { return vec2f(0.0); }
  var grad = vec2f(0.0);
  for (var layer = 0; layer < 2; layer++) {
    let scale = select(2.8, 3.9, layer == 1);
    let q = xz * scale + select(vec2f(0.0), vec2f(13.7, 9.3), layer == 1);
    let cell = floor(q);
    let uv = fract(q) - 0.5;
    let h0 = weatherHash2(cell + f32(layer) * 19.0);
    let phase = time * 2.15 + h0 * 6.2831853;
    let cycle = floor(phase / 6.2831853);
    let age = fract(phase / 6.2831853);
    let hPos = vec2f(
      weatherHash2(cell + vec2f(cycle * 1.7, 3.1)),
      weatherHash2(cell + vec2f(5.3, cycle * 2.3))
    ) - 0.5;
    let dVec = uv - hPos * 0.42;
    let r = length(dVec);
    let ringR = 0.05 + age * 0.38;
    let band = abs(r - ringR);
    let wave = cos((r - ringR) * 58.0) * exp(-band * 28.0) * (1.0 - age) * (1.0 - age);
    let dir = dVec / max(r, 1e-4);
    grad += dir * wave;
  }
  return grad * (0.095 * fade);
}

/**
 * Stretched wet-floor / puddle reflection streak of a practical light or flashlight cone.
 * Anchors on the light's ground pool rather than the geometric mirror point (which in steep
 * top-down cameras lands behind the road), and stretches asymmetrically toward the camera eye.
 */
fn evalWeatherWetMirrorStreak(
  world: vec3f,
  normalXZ: vec2f,
  eye: vec3f,
  lightPos: vec3f,
  lightColor: vec3f,
  lightPower: f32,
  roughWidth: f32,
  vis: f32
) -> vec3f {
  let hl = max(0.25, lightPos.y - world.y);
  let he = max(0.35, eye.y - world.y);
  let k = hl / (hl + he);
  let toEye = normalize(eye.xz - lightPos.xz + vec2f(1e-4));
  let pm = lightPos.xz + (eye.xz - lightPos.xz) * (0.18 * k) + normalXZ * (1.35 * hl);
  let q = world.xz - pm;
  let along = dot(q, toEye);
  let across = dot(q, vec2f(-toEye.y, toEye.x));
  let wAcross = max(0.18, roughWidth);
  let wAlong = select(max(0.55, roughWidth * 2.4), max(1.10, roughWidth * 6.4), along >= 0.0);
  let r2 = (across * across) / (wAcross * wAcross) + (along * along) / (wAlong * wAlong);
  if (r2 > 9.0) { return vec3f(0.0); }
  return lightColor * (lightPower * exp(-r2) * vis);
}
`
