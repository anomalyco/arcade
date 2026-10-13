/** Optional WGSL adapter for renderers using Kit's 12-float vehicle sprites.
 * No bindings: the host supplies camera/position/colour, and reserves its own kind range. */
export const vehicleSprites = /* wgsl */ `
fn vehicleSpritePosition(c: vec2f, pos: vec4f, misc: vec4f, eye: vec3f) -> vec3f {
  let k = i32(misc.x); let size = pos.w;
  let cr = cos(misc.y); let sr = sin(misc.y);
  if (k == 14 || k == 17 || k == 18) {
    let lc = vec2f(c.x * size, (c.y * 0.5 + 0.5) * size * misc.z);
    return pos.xyz + vec3f(lc.x * cr + lc.y * sr, 0.0, -lc.x * sr + lc.y * cr);
  }
  if (k == 15) { return pos.xyz + vec3f(c.x * size * cr, c.y * size * misc.z, -c.x * size * sr); }
  if (k == 3 || k == 4 || k == 13 || k == 19) {
    let lc = vec2f(c.x * size, c.y * size * max(misc.z, 0.01));
    return pos.xyz + vec3f(lc.x * cr + lc.y * sr, 0.0, -lc.x * sr + lc.y * cr);
  }
  let toCam = normalize(eye - pos.xyz);
  let right = normalize(cross(vec3f(0.0, 1.0, 0.0), toCam)); let up = cross(toCam, right);
  let corner = vec2f(c.x, c.y * select(1.0, misc.z, k == 16));
  return pos.xyz + (right * corner.x + up * corner.y) * size + toCam * size * select(0.5, 0.0, k == 10);
}
fn vehicleSpriteColor(uv: vec2f, color: vec4f, misc: vec4f, height: f32) -> vec4f {
  let k = i32(misc.x); let r = length(uv); let t = uv.y * 0.5 + 0.5;
  var a = 0.0; var rgb = color.rgb;
  if (k == 0 || k == 6) { a = pow(max(0.0, 1.0 - r), 2.2); }
  if (k == 3) { a = pow(max(0.0, 1.0 - r), 1.6); }
  if (k == 4) { a = (1.0 - smoothstep(0.4, 1.0, abs(uv.x))) * (1.0 - smoothstep(0.7, 1.0, abs(uv.y))); }
  if (k == 10) {
    let angle = (misc.w - 0.5) * 1.6;
    let q = vec2f(uv.x * cos(angle) - uv.y * sin(angle), uv.x * sin(angle) + uv.y * cos(angle));
    let l0 = (q * vec2f(1.05, 1.18) + vec2f(0.2, 0.02)) / 0.69;
    let l1 = (q + vec2f(-0.32, -0.1)) / 0.51; let l2 = (q + vec2f(0.04, -0.38)) / 0.47;
    let d0 = length(l0); let d1 = length(l1); let d2 = length(l2);
    let sphere = select(select(l0, l1, d1 < d0), l2, d2 < min(d0, d1));
    let normal = vec3f(sphere, sqrt(max(0.0, 1.0 - dot(sphere, sphere))));
    let light = max(0.0, dot(normal, normalize(vec3f(-0.45, 0.7, 0.55))));
    a = (1.0 - smoothstep(-0.15, 0.10, min(d0, min(d1, d2)) - 1.0)) * smoothstep(-0.12, 0.3, height);
    rgb *= mix(vec3f(0.16, 0.22, 0.36), vec3f(1.3, 1.25, 1.16), light);
  }
  if (k == 13) {
    let width = (1.0 - t) * (0.65 + 0.14 * sin(t * 15.0 + misc.w * 17.0));
    a = (1.0 - smoothstep(width * 0.55, width, abs(uv.x))) * (1.0 - t);
    rgb = mix(vec3f(1.0, 0.85, 0.52), rgb, smoothstep(0.05, 0.55, t));
  }
  if (k == 14) { a = pow(max(0.0, 1.0 - abs(uv.x) / mix(0.16, 1.0, t)), 1.3) * pow(1.0 - t, 0.8) * smoothstep(0.0, 0.025, t); }
  if (k == 18) {
    let side = 1.0 - smoothstep(0.0, 1.0, abs(uv.x) / mix(misc.w, 1.0, t));
    a = side * side * (1.0 - smoothstep(0.12, 1.0, t)) * smoothstep(0.0, 0.018, t);
  }
  if (k == 19) { a = exp(-3.0 * r * r) * (1.0 - smoothstep(0.45, 1.0, r)); }
  if (k == 17) { a = pow(max(0.0, 1.0 - abs(uv.x)), 1.6) * pow(1.0 - t, 1.4) * smoothstep(0.0, 0.035, t); }
  if (k == 15) { a = (1.0 - smoothstep(0.55, 1.0, abs(uv.x))) * (1.0 - smoothstep(0.3, 1.0, abs(uv.y))); }
  if (k == 16) { a = pow(max(0.0, 1.0 - abs(uv.x)), 2.0) * pow(max(0.0, 1.0 - abs(uv.y)), 2.0); }
  return vec4f(rgb * a * color.a, a * color.a);
}
`
