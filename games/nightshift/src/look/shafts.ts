import { volumeFrameWgsl, volumeParamsWgsl, VOLUME_PARAM_FLOATS, type VolumeInput, type VolumeLightShader } from "@arcade/kit/gpu/volume-pass"
import { officeUniform } from "../office-uniform"
import { blindCookieWgsl } from "../blind-cookie"

/**
 * Dusty shafts: the two streetlight beams through the blinds, marched at low resolution with the same slat cookie the
 * floor and the motes use, so the air shows sheets of light rather than a solid cone. Unshadowed: the march stops at
 * the scene depth, and the beams fall steeply onto open carpet, so partitions rarely sit inside them.
 */
export const shaftVolume: VolumeLightShader = {
  depth: true,
  history: true,
  code: /* wgsl */ `
${volumeFrameWgsl}
${volumeParamsWgsl}
${officeUniform}
${blindCookieWgsl}
struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f }
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: VO;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}
fn shaftHash(p: vec3f) -> f32 { return fract(sin(dot(p, vec3f(127.1, 311.7, 74.7))) * 43758.5453); }
fn shaftNoise(p: vec3f) -> f32 {
  let i = floor(p); let f = fract(p); let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(shaftHash(i), shaftHash(i + vec3f(1, 0, 0)), u.x), mix(shaftHash(i + vec3f(0, 1, 0)), shaftHash(i + vec3f(1, 1, 0)), u.x), u.y),
    mix(mix(shaftHash(i + vec3f(0, 0, 1)), shaftHash(i + vec3f(1, 0, 1)), u.x), mix(shaftHash(i + vec3f(0, 1, 1)), shaftHash(i + vec3f(1, 1, 1)), u.x), u.y), u.z);
}
@fragment fn fs(o: VO) -> @location(0) vec4f {
  let steps = i32(volumeParams[0].x);
  let strength = volumeParams[0].y;
  if (steps <= 0 || strength <= 0.0) { return vec4f(0.0); }
  let d = volumeDepth(o.uv);
  let eye = V.eye.xyz;
  let end = select(volumeUnproject(o.uv, d), eye + normalize(volumeUnproject(o.uv, d) - eye) * 20.0, volumeIsSky(d));
  let ray = end - eye;
  let len = min(length(ray), 10.0);
  let dir = ray / max(length(ray), 1e-4);
  let jitter = fract(52.9829189 * fract(dot(o.pos.xy + V.eye.w * vec2f(5.588, 2.31), vec2f(0.06711056, 0.00583715))));
  var acc = vec3f(0.0);
  let dt = len / f32(steps);
  for (var k = 0; k < steps; k++) {
    let p = eye + dir * ((f32(k) + jitter) * dt);
    for (var j = 0; j < 2; j++) {
      let lamp = volumeParams[1 + j * 2];
      let axisCos = volumeParams[2 + j * 2];
      let dl = p - lamp.xyz;
      let dist = max(length(dl), 0.1);
      let cone = smoothstep(axisCos.w, axisCos.w + 0.2, dot(dl / dist, axisCos.xyz));
      if (cone <= 0.0) { continue; }
      let cookie = blindCookieAt(p, lamp.xyz, 0.004);
      // Forward scattering towards the window, and dust that drifts in slow clumps.
      let phase = 0.5 + 0.9 * pow(max(dot(-dir, dl / dist), 0.0), 3.0);
      let dust = 0.55 + 0.9 * shaftNoise(p * 2.3 + vec3f(0.0, V.eye.w * 0.002, 0.0));
      acc += cone * cookie * phase * dust * lamp.w / (dist * dist);
    }
  }
  return vec4f(vec3f(1.0, 0.43, 0.14) * acc * dt * strength * 0.0015, 0.0);
}
`,
}

/** The two streetlights through the blinds: position, power, axis and outer cosine (main.ts lamps 1 and 2). */
export type ShaftLamp = { pos: readonly [number, number, number]; power: number; axis: readonly [number, number, number]; cosOuter: number }
export function shaftInput(out: Float32Array, lamps: readonly ShaftLamp[], steps: number, strength: number, downscale: number): VolumeInput {
  out.fill(0)
  out[0] = steps
  out[1] = strength
  lamps.slice(0, 2).forEach((l, j) => {
    const len = Math.hypot(...l.axis)
    out.set([...l.pos, l.power], 4 + j * 8)
    out.set([l.axis[0] / len, l.axis[1] / len, l.axis[2] / len, l.cosOuter], 8 + j * 8)
  })
  return { downscale, history: 0.12, moving: 0.35, params: out }
}
export const SHAFT_PARAM_FLOATS = VOLUME_PARAM_FLOATS
