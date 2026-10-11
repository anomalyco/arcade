/** Cheap 2D value noise + helpers shared by the world shaders. */
export const NOISE_GLSL = /* glsl */ `
float wHash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * .1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
float wNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(wHash(i), wHash(i + vec2(1, 0)), f.x), mix(wHash(i + vec2(0, 1)), wHash(i + vec2(1, 1)), f.x), f.y);
}
`

/** Soft two-step "toon" diffuse used by terrain, water and runway shaders. */
export const TOON_GLSL = /* glsl */ `
float toonDiffuse(float ndl) {
  return 0.16 + smoothstep(-0.05, 0.12, ndl) * 0.46 + smoothstep(0.32, 0.55, ndl) * 0.38;
}
`
