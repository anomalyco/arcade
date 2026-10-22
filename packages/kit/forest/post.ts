import { postShader } from "../gpu/shaders"
import { customPostGradeWgsl } from "../gpu/post-uniform"

/**
 * The forest's camera: what a real low-light camera does to a night forest, each a Lab setting.
 *
 * - Lens: lateral chromatic aberration growing to the corners (px), cos⁴-style vignette, bloom and a red halation
 *   halo round hot sources, and veiling glare (a little of every bright source's light lifted over the frame).
 * - Exposure: the host's auto-exposure value (lags the scene: 0.2–0.6 s to stop down, 1–3 s to open up).
 * - Sensor: noise in linear light before the curve, read noise plus shot noise (∝ √signal), scaled by the exposure
 *   gain, so a dark frame the camera has opened up on is the noisy one; a little of it in colour.
 * - Curve: a hue-preserving filmic shoulder, then sRGB.
 *
 * Uniforms: frame (time, noise /255, vignette, exposure), look.yzw (aberration px, halation, bloom), custom
 * (colour noise, glare level, gain, unused).
 */
export const forestPost = postShader(false, false, { chromatic: 0, bloom: 0.22, grain: 0, vignette: 0.35, composite: /* wgsl */ `
  let uv = o.uv;
  let fromC = uv - 0.5;
  let size = vec2f(textureDimensions(src));
  let r2 = dot(fromC, fromC);
  let ca = fromC * r2 * 4.0 * grade.look.y / size.x;
  var hdr = vec3f(
    clean(textureSample(src, samp, uv + ca)).r,
    clean(textureSample(src, samp, uv)).g,
    clean(textureSample(src, samp, uv - ca)).b,
  );
  let bloom = textureSample(bloomTex, samp, uv).rgb;
  hdr += bloom * (grade.look.w + vec3f(1.0, 0.3, 0.1) * grade.look.z);
  hdr += vec3f(1.0, 0.97, 0.94) * grade.custom.y;
  var x = max(hdr * grade.frame.w, vec3f(0.0));
  // Sensor: read noise and shot noise in linear light, larger when the camera has opened up (gain).
  let px = o.pos.xy;
  let t = fract(grade.frame.x * 7.31);
  let n1 = hash(px + t * 917.0) + hash(px * 1.31 + t * 431.0) - 1.0;
  let n2 = hash(px * 0.93 + t * 211.0 + 17.0) + hash(px * 1.7 + t * 613.0 + 5.0) - 1.0;
  let n3 = hash(px * 1.11 + t * 347.0 + 41.0) + hash(px * 0.77 + t * 151.0 + 9.0) - 1.0;
  let l = dot(x, vec3f(0.2126, 0.7152, 0.0722));
  let sigma = grade.frame.y / 255.0 * grade.custom.z * (0.35 + 1.6 * sqrt(max(l, 0.0)));
  let chroma = grade.custom.x;
  x = max(x + sigma * (vec3f(n1) * (1.0 - chroma) + vec3f(n1 + n2, n1 - n3 * 0.5, n1 + n3) * chroma * 0.6), vec3f(0.0));
  // Filmic shoulder that keeps hue in the highlights (the beam's hot spot stays white-yellow, not pink).
  let peak = max(max(x.r, x.g), max(x.b, 1e-5));
  let mapped = peak * (1.0 + peak / 9.0) / (1.0 + peak);
  var c = x * (mapped / peak);
  c = mix(c, vec3f(mapped), smoothstep(1.5, 12.0, peak) * 0.7);
  // Vignette: natural falloff plus the lens's own.
  let v = length(fromC * vec2f(size.x / size.y, 1.0)) / length(vec2f(size.x / size.y, 1.0) * 0.5);
  c *= mix(1.0, pow(max(1.0 - 0.32 * v * v, 0.0), 2.0), grade.frame.z * 2.0);
  c = clamp(c, vec3f(0.0), vec3f(1.0));
  c = select(c * 12.92, 1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055, c > vec3f(0.0031308));
  // Dither to 8 bits so the dark gradients never band.
  let ign = fract(52.9829189 * fract(dot(floor(px), vec2f(0.06711056, 0.00583715))));
  c += (ign - 0.5) / 255.0;
  return vec4f(c, 1.0);
` })
  .replace("@group(0) @binding(4) var<uniform> G: vec4f;", customPostGradeWgsl)
