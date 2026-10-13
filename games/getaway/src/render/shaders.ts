export const MAX_LIGHTS = 128

/** Shared frame uniforms, lights and lighting model for every lit pipeline. */
const common = /* wgsl */ `
struct Frame {
  viewProj: mat4x4f,
  lightViewProj: mat4x4f,
  cam: vec4f,          // xyz camera position, w time
  focus: vec4f,        // xyz focus car position, w cutaway radius (NDC)
  screen: vec4f,       // width, height, light count, siren time
  moonDir: vec4f,      // xyz toward the moon, w intensity
  spotPos: vec4f,      // helicopter spotlight origin, w on/off
  spotDir: vec4f,      // xyz direction, w cos(cone)
  fog: vec4f,          // rgb fog color, w density
  focusClip: vec4f,    // focus position in NDC (xy), depth (z)
}

struct Light {
  pos: vec4f,    // xyz, radius
  color: vec4f,  // rgb, intensity
  dir: vec4f,    // xyz spot direction, w cos(cone) or -2 for point
}

@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<storage, read> lights: array<Light>;
@group(0) @binding(2) var shadowMap: texture_depth_2d;
@group(0) @binding(3) var shadowSampler: sampler_comparison;
@group(0) @binding(4) var atlasTex: texture_2d<f32>;
@group(0) @binding(5) var atlasSampler: sampler;

fn hash2(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}

fn shadow(world: vec3f, n: vec3f, ndl: f32) -> f32 {
  if (ndl <= 0.0) { return 0.0; }
  let lp = F.lightViewProj * vec4f(world + n * 0.15, 1.0);
  let uv = lp.xy * vec2f(0.5, -0.5) + 0.5;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 || lp.z > 1.0) { return 1.0; }
  let texel = 1.0 / 2048.0;
  var s = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      s += textureSampleCompareLevel(shadowMap, shadowSampler, uv + vec2f(f32(x), f32(y)) * texel, lp.z - 0.0015);
    }
  }
  return s / 9.0;
}

/** Unified diffuse + Blinn-Phong specular shading in a single light loop. */
fn shade(albedo: vec3f, world: vec3f, n: vec3f, specStrength: f32, diffScale: f32) -> vec3f {
  // Blue-hour night: a cool sky fill so the whole diorama reads, a dim warm bounce from the street.
  let sky = vec3f(0.12, 0.16, 0.34);
  let ground = vec3f(0.05, 0.045, 0.06);
  var diff = albedo * mix(ground, sky, n.y * 0.5 + 0.5) * 0.72;
  let L = normalize(F.moonDir.xyz);
  let ndl = max(dot(n, L), 0.0);
  let sh = shadow(world, n, ndl);
  diff += albedo * vec3f(0.45, 0.55, 0.9) * (F.moonDir.w * ndl * sh);

  let hasSpec = specStrength > 0.0;
  let v = select(vec3f(0.0, 1.0, 0.0), normalize(F.cam.xyz - world), hasSpec);
  var spec = vec3f(0.0);
  if (hasSpec) {
    let hm = normalize(L + v);
    spec += vec3f(0.3, 0.38, 0.6) * pow(max(dot(n, hm), 0.0), 60.0) * 0.4;
  }

  let count = u32(F.screen.z);
  for (var i = 0u; i < count; i++) {
    let li = lights[i];
    let d = li.pos.xyz - world;
    let d2 = dot(d, d);
    let r = li.pos.w;
    let maxR = select(r, r * 1.4, hasSpec);
    if (d2 >= maxR * maxR) { continue; }
    let invDist = inverseSqrt(max(d2, 1e-6));
    let dist = d2 * invDist;
    let l = d * invDist;
    let isSpot = li.dir.w > -1.5;
    let cd = select(1.0, dot(-l, li.dir.xyz), isSpot);
    if (dist < r) {
      let x = dist / r;
      let t = 1.0 - x * x;
      // Smooth windowed inverse-square: bright core, clean edge, so lamp pools read as crisp circles.
      var att = (t * t) / (1.0 + 6.0 * x * x);
      if (isSpot) {
        att *= smoothstep(li.dir.w, li.dir.w + 0.12, cd);
      }
      let dTerm = max(dot(n, l), 0.0) * 0.85 + 0.15;
      diff += albedo * li.color.rgb * (li.color.w * att * dTerm);
    }
    if (hasSpec) {
      var sAtt = 1.0 - dist / maxR;
      sAtt = sAtt * sAtt;
      if (isSpot) {
        sAtt *= smoothstep(li.dir.w - 0.1, li.dir.w + 0.12, cd);
      }
      let h = normalize(l + v);
      spec += li.color.rgb * (li.color.w * sAtt * pow(max(dot(n, h), 0.0), 24.0) * 0.35);
    }
  }

  if (F.spotPos.w > 0.5) {
    let d = world - F.spotPos.xyz;
    let dist = length(d);
    let cd = dot(d / dist, normalize(F.spotDir.xyz));
    let cone = smoothstep(F.spotDir.w, F.spotDir.w + 0.0025, cd);
    let ndl2 = max(dot(n, -d / dist), 0.0) * 0.8 + 0.2;
    diff += albedo * vec3f(0.92, 0.96, 1.0) * (3.2 * cone * ndl2);
  }
  return diff * diffScale + spec * specStrength;
}

/** Cheap ambient occlusion for walls: darker toward the street, a touch darker in corners near the ground. */
fn wallShade(world: vec3f, n: vec3f) -> f32 {
  if (abs(n.y) > 0.5) { return 1.0; }
  return mix(0.38, 1.0, smoothstep(0.0, 14.0, world.y));
}

fn applyFog(c: vec3f, world: vec3f) -> vec3f {
  let dist = length(world - F.cam.xyz);
  let f = 1.0 - exp(-max(dist - 120.0, 0.0) * F.fog.w);
  return mix(c, F.fog.rgb, clamp(f, 0.0, 0.85));
}

/** Procedural windows on building facades: a grid of glass panes, some lit warm. */
fn facade(base: vec3f, world: vec3f, n: vec3f) -> vec4f {
  if (abs(n.y) > 0.5) { return vec4f(base, 0.0); }
  let t = normalize(vec3f(-n.z, 0.0, n.x));
  let u = dot(world, t);
  let v = world.y;
  let cell = vec2f(u / 3.4, (v - 1.2) / 3.6);
  let id = floor(cell);
  let f = fract(cell);
  if (v < 1.4) { return vec4f(base, 0.0); }
  let pane = step(0.22, f.x) * step(f.x, 0.78) * step(0.25, f.y) * step(f.y, 0.8);
  if (pane < 0.5) { return vec4f(base, 0.0); }
  let h = hash2(id + floor(world.xz / 97.0) * 13.0 + n.xz * 7.0);
  let ground = select(0.0, 1.0, v < 4.8);
  let lit = step(0.72 - ground * 0.2, h);
  let warm = mix(vec3f(1.0, 0.55, 0.18), vec3f(1.0, 0.75, 0.4), hash2(id * 3.1));
  let glass = vec3f(0.012, 0.016, 0.03);
  return vec4f(select(glass, warm * (0.9 + 0.5 * hash2(id * 1.7) + ground * 0.5), lit > 0.5), lit);
}
`

export const litShader = /* wgsl */ `
${common}

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) color: vec3f,
  @location(3) @interpolate(flat) mat: f32,
  @location(4) @interpolate(flat) extra: vec4f,
  @location(5) @interpolate(flat) cut: f32,
  @location(6) uv: vec2f,
}

struct VIn {
  @location(0) pos: vec3f,
  @location(1) normal: vec3f,
  @location(2) color: vec3f,
  @location(3) mat: f32,
  @location(7) uv: vec2f,
}

@vertex fn vsStatic(v: VIn) -> VOut {
  var o: VOut;
  o.world = v.pos;
  o.pos = F.viewProj * vec4f(v.pos, 1.0);
  o.normal = v.normal;
  o.color = pow(v.color, vec3f(2.2));
  if (v.mat == 9.0) {
    // Constant per pane, evaluated at vertices rather than once per lit pixel.
    let room = v.uv.x;
    let tint = select(vec3f(1.0, 0.83 + room * 0.3, 0.76 + room * 0.6), vec3f(0.4, 1.3, 3.0), room > 0.92);
    o.color *= tint;
  }
  o.mat = v.mat;
  o.extra = vec4f(0.0);
  o.cut = 1.0;
  o.uv = v.uv;
  return o;
}

struct Inst {
  @location(4) posYaw: vec4f,   // x, y, z, yaw
  @location(5) params: vec4f,   // roll, pitch, siren phase (<0 off), brake (1) or engine off (-1)
  @location(6) tint: vec4f,     // rgb silhouette tint, a scale
}

fn instWorld(p: vec3f, inst: Inst) -> vec3f {
  var q = p * inst.tint.w;
  let roll = inst.params.x;
  let pitch = inst.params.y;
  // Body lean: roll around the forward axis, pitch around the side axis.
  let cr = cos(roll); let sr = sin(roll);
  q = vec3f(q.x * cr - q.y * sr, q.x * sr + q.y * cr, q.z);
  let cp = cos(pitch); let sp = sin(pitch);
  q = vec3f(q.x, q.y * cp - q.z * sp, q.y * sp + q.z * cp);
  let c = cos(inst.posYaw.w); let s = sin(inst.posYaw.w);
  return vec3f(q.x * c + q.z * s, q.y, -q.x * s + q.z * c) + inst.posYaw.xyz;
}

fn instNormal(n: vec3f, inst: Inst) -> vec3f {
  var q = n;
  let roll = inst.params.x;
  let pitch = inst.params.y;
  let cr = cos(roll); let sr = sin(roll);
  q = vec3f(q.x * cr - q.y * sr, q.x * sr + q.y * cr, q.z);
  let cp = cos(pitch); let sp = sin(pitch);
  q = vec3f(q.x, q.y * cp - q.z * sp, q.y * sp + q.z * cp);
  let c = cos(inst.posYaw.w); let s = sin(inst.posYaw.w);
  return vec3f(q.x * c + q.z * s, q.y, -q.x * s + q.z * c);
}

@vertex fn vsInst(v: VIn, inst: Inst) -> VOut {
  var o: VOut;
  o.world = instWorld(v.pos, inst);
  o.pos = F.viewProj * vec4f(o.world, 1.0);
  o.normal = instNormal(v.normal, inst);
  o.color = pow(v.color, vec3f(2.2));
  o.mat = v.mat;
  o.extra = inst.params;
  o.cut = 0.0;
  o.uv = v.uv;
  return o;
}

fn cutaway(world: vec3f, fragPos: vec4f, cut: f32) -> bool {
  if (cut < 0.5 || F.focus.w <= 0.0 || world.y < 1.2) { return false; }
  let ndc = vec2f(fragPos.x / F.screen.x * 2.0 - 1.0, 1.0 - fragPos.y / F.screen.y * 2.0);
  let aspect = F.screen.x / F.screen.y;
  let dv = (ndc - F.focusClip.xy) * vec2f(aspect, 1.0);
  let r = length(dv) / F.focus.w;
  if (r > 1.0) { return false; }
  // Only geometry nearer to the camera than the car gets cut.
  if (distance(world, F.cam.xyz) > distance(F.focus.xyz, F.cam.xyz) - 3.0) { return false; }
  let fade = smoothstep(1.0, 0.7, r);
  let p = vec2u(fragPos.xy) % 4u;
  let m = array<f32, 16>(0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
  let bayer = (m[p.y * 4u + p.x] + 0.5) / 16.0;
  return bayer < fade * 0.9;
}

@fragment fn fs(o: VOut) -> @location(0) vec4f {
  let duvDx = dpdx(o.uv);
  let duvDy = dpdy(o.uv);
  let n = normalize(o.normal);
  let mat = i32(round(o.mat));
  let cutHere = cutaway(o.world, o.pos, o.cut);
  var col: vec3f;
  if (mat == 2 || mat == 9) {
    // Lamps. params.w: 1 braking, -1 engine off (headlamps dark, taillights dim).
    let tail = o.color.r > 0.9 && o.color.g < 0.2;
    let off = o.extra.w < -0.5;
    col = o.color * select(select(2.2, 0.15, off), select(select(2.5, 0.25, off), 9.0, o.extra.w > 0.5), tail);
  } else if (mat == 8) {
    let tex = textureSampleGrad(atlasTex, atlasSampler, o.uv, duvDx, duvDy);
    if (tex.a < 0.5) { discard; }
    col = o.color * tex.rgb * 3.0;
  } else if (mat == 7) {
    var tex = vec4f(1.0);
    if (o.uv.x > 0.002 || o.uv.y > 0.002) {
      tex = textureSampleGrad(atlasTex, atlasSampler, o.uv, duvDx, duvDy);
    }
    if (tex.a < 0.5 || cutHere) { discard; }
    col = shade(o.color * tex.rgb, o.world, n, 0.25, 1.0);
  } else if (mat == 5) {
    // Siren lamp: alternating red and blue strobes; dim when off.
    let phase = o.extra.z;
    let red = o.color.r > o.color.b;
    var on = 0.08;
    if (phase >= 0.0) {
      let t = fract(phase);
      let a = select(step(0.5, t), step(t, 0.5), red);
      let strobe = step(0.5, fract(t * 4.0));
      on = a * (0.5 + 0.5 * strobe);
    }
    col = o.color * (0.25 + on * 9.0);
  } else if (mat == 6) {
    // Glass: near-black, picking up highlights from nearby lights and moonlight sheen.
    col = shade(o.color, o.world, n, 0.9, 0.25) + vec3f(0.006, 0.009, 0.016);
  } else if (mat == 3) {
    let ripple = sin(o.world.x * 0.35 + F.cam.w * 1.3) * sin(o.world.z * 0.5 - F.cam.w * 0.9);
    col = shade(o.color, o.world, vec3f(0.0, 1.0, 0.0), 1.5, 1.0) + vec3f(0.04, 0.07, 0.1) * (ripple * 0.5 + 0.5);
  } else if (mat == 1) {
    if (cutHere) { discard; }
    let f = facade(o.color, o.world, n);
    col = shade(f.rgb * (1.0 - f.a), o.world, n, 0.0, wallShade(o.world, n)) + f.rgb * f.a;
  } else {
    if (mat == 0 && cutHere) { discard; }
    let isRoad = n.y > 0.9 && o.world.y < 0.3;
    // Approved matte Look ground; the old 0.55 sheen was overridden by this value.
    let specStr = select(0.0, 0.035, isRoad);
    col = shade(o.color, o.world, n, specStr, wallShade(o.world, n));
  }
  if (o.cut > 0.5 && mat != 2 && mat != 8 && mat != 9 && o.world.y > 4.5) {
    col += o.color * vec3f(0.015, 0.025, 0.06) * max(n.y, 0.0);
  }
  if (o.world.y < 0.03 && n.y > 0.9 && all(o.world.xz > vec2f(0.0)) && all(o.world.xz < vec2f(532.0))) {
    // Analytic curb foot, in the same 76 m grid as the street mesh.
    let cell = abs(fract(o.world.xz / 76.0 + 0.5) - 0.5) * 76.0;
    let edge = min(cell.x, cell.y);
    col *= 1.0 - 0.32 * smoothstep(7.2, 8.0, edge) * (1.0 - smoothstep(8.0, 8.35, edge));
  }
  return vec4f(applyFog(col, o.world), 1.0);
}

/** Occluded cars: drawn with depth test "greater" as a flat team-colored silhouette. */
@vertex fn vsGhost(v: VIn, inst: Inst) -> VOut {
  var o: VOut;
  o.world = instWorld(v.pos, inst);
  o.pos = F.viewProj * vec4f(o.world, 1.0);
  o.normal = instNormal(v.normal, inst);
  o.color = inst.tint.rgb;
  o.mat = 0.0;
  o.extra = inst.params;
  o.cut = 0.0;
  o.uv = v.uv;
  return o;
}

@fragment fn fsGhost(o: VOut) -> @location(0) vec4f {
  let n = normalize(o.normal);
  let rim = 0.55 + 0.45 * (1.0 - abs(n.y));
  return vec4f(o.color * 1.6 * rim, 0.62);
}
`

export const shadowShader = /* wgsl */ `
struct Frame {
  viewProj: mat4x4f,
  lightViewProj: mat4x4f,
}
@group(0) @binding(0) var<uniform> F: Frame;

struct Inst {
  @location(4) posYaw: vec4f,
  @location(5) params: vec4f,
  @location(6) tint: vec4f,
}

@vertex fn vsStatic(@location(0) pos: vec3f) -> @builtin(position) vec4f {
  return F.lightViewProj * vec4f(pos, 1.0);
}

@vertex fn vsInst(@location(0) pos: vec3f, inst: Inst) -> @builtin(position) vec4f {
  var q = pos * inst.tint.w;
  let roll = inst.params.x;
  let pitch = inst.params.y;
  let cr = cos(roll); let sr = sin(roll);
  q = vec3f(q.x * cr - q.y * sr, q.x * sr + q.y * cr, q.z);
  let cp = cos(pitch); let sp = sin(pitch);
  q = vec3f(q.x, q.y * cp - q.z * sp, q.y * sp + q.z * cp);
  let c = cos(inst.posYaw.w); let s = sin(inst.posYaw.w);
  let w = vec3f(q.x * c + q.z * s, q.y, -q.x * s + q.z * c) + inst.posYaw.xyz;
  return F.lightViewProj * vec4f(w, 1.0);
}
`

/**
 * Sprites: camera-facing glows and smoke, ground-aligned decals (rings, skid marks, light pools) and the
 * helicopter beam. kind: 0 glow, 1 smoke, 2 ring, 3 disc, 4 skid, 5 beam, 6 spark,
 * 7 airborne shadow, 8 rectangular spill/grounding, 9 wheel-weighted contact shadow.
 */
export const spriteShader = /* wgsl */ `
${common}

struct SIn {
  @location(0) posSize: vec4f,  // xyz, size
  @location(1) color: vec4f,    // rgba (premultiplied-ish intensity)
  @location(2) misc: vec4f,     // kind, rotation, stretch, extra
}

struct SOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
  @location(2) @interpolate(flat) kind: f32,
  @location(3) @interpolate(flat) extra: f32,
}

@vertex fn vs(@builtin(vertex_index) vi: u32, s: SIn) -> SOut {
  var corners = array<vec2f, 6>(vec2f(-1, -1), vec2f(1, -1), vec2f(1, 1), vec2f(-1, -1), vec2f(1, 1), vec2f(-1, 1));
  let c = corners[vi];
  let kind = s.misc.x;
  var world: vec3f;
  let size = s.posSize.w;
  if (kind == 2.0 || kind == 3.0 || kind == 4.0 || kind >= 7.0) {
    let r = s.misc.y;
    let cr = cos(r); let sr = sin(r);
    let lc = vec2f(c.x * size, c.y * size * max(s.misc.z, 0.01));
    world = s.posSize.xyz + vec3f(lc.x * cr + lc.y * sr, 0.0, -lc.x * sr + lc.y * cr);
  } else if (kind == 5.0) {
    // Beam: a camera-facing quad stretched from the origin (pos) to the ground target (misc.yzw is target).
    let a = s.posSize.xyz;
    let b = s.misc.yzw;
    let axis = b - a;
    let toCam = normalize(F.cam.xyz - (a + b) * 0.5);
    let side = normalize(cross(axis, toCam));
    let t = c.y * 0.5 + 0.5;
    let w = mix(0.3, size, t);
    world = mix(a, b, t) + side * c.x * w;
  } else {
    let toCam = normalize(F.cam.xyz - s.posSize.xyz);
    let right = normalize(cross(vec3f(0.0, 1.0, 0.0), toCam));
    let up = cross(toCam, right);
    world = s.posSize.xyz + (right * c.x + up * c.y) * size;
    // Nudge glows toward the camera so they are not swallowed by their own lamp geometry.
    world += toCam * size * 0.5;
  }
  var o: SOut;
  o.pos = F.viewProj * vec4f(world, 1.0);
  o.uv = c;
  o.color = s.color;
  if (kind == 1.0) {
    // Per-vertex smoke lighting: soft volume, no moon shadow-map sampling or casting.
    var illumination = vec3f(0.24, 0.29, 0.42);
    for (var i = 0u; i < min(u32(F.screen.z), 48u); i++) {
      let li = lights[i];
      let delta = s.posSize.xyz - li.pos.xyz;
      let d2 = dot(delta, delta);
      if (d2 >= li.pos.w * li.pos.w) { continue; }
      let distance = sqrt(max(d2, 0.001));
      var attenuation = pow(1.0 - distance / li.pos.w, 2.0);
      if (li.dir.w > -1.0) { attenuation *= smoothstep(li.dir.w, min(1.0, li.dir.w + 0.08), dot(delta / distance, normalize(li.dir.xyz))); }
      illumination += li.color.rgb * li.color.w * attenuation * 0.3;
    }
    o.color = vec4f(s.color.rgb * min(illumination, vec3f(2.0)), s.color.a);
  }
  o.kind = kind;
  o.extra = s.misc.w;
  return o;
}

@fragment fn fs(o: SOut) -> @location(0) vec4f {
  let r = length(o.uv);
  var a = 0.0;
  let k = o.kind;
  if (k == 0.0 || k == 6.0) {
    a = pow(max(0.0, 1.0 - r), 2.2);
  } else if (k == 1.0) {
    let billow = 0.88 + 0.12 * sin(o.uv.x * 5.0 + o.extra * 17.0) * sin(o.uv.y * 4.0 - o.extra * 11.0);
    a = pow(max(0.0, 1.0 - r * r), 2.0) * billow;
  } else if (k == 2.0) {
    a = smoothstep(0.08, 0.0, abs(r - 0.88)) + 0.12 * smoothstep(0.9, 0.0, r);
  } else if (k == 3.0) {
    a = pow(max(0.0, 1.0 - r), 1.6);
  } else if (k == 4.0) {
    a = smoothstep(1.0, 0.4, abs(o.uv.x)) * smoothstep(1.0, 0.7, abs(o.uv.y));
  } else if (k == 5.0) {
    let edge = 1.0 - abs(o.uv.x);
    a = pow(edge, 1.5) * (0.35 + 0.65 * (o.uv.y * 0.5 + 0.5));
  } else if (k == 7.0) {
    let q = abs(o.uv) - vec2f(0.58, 0.68);
    let d = length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - 0.18;
    let softness = min(0.35, o.extra * 0.05);
    a = 1.0 - smoothstep(-0.22 - softness, 0.14 + softness, d);
  } else if (k == 8.0) {
    // Short rectangular shop spill / grounding strip, feathered on both axes.
    a = (1.0 - smoothstep(0.55, 1.0, abs(o.uv.x))) * pow(max(0.0, 1.0 - o.uv.y * o.uv.y), 2.0);
  } else if (k == 9.0) {
    // Wider than the body; four stronger contact patches at the wheel tracks.
    let q = abs(o.uv);
    let lift = clamp(o.extra / 5.0, 0.0, 1.0);
    let body = (1.0 - smoothstep(mix(0.58, 0.12, lift), 1.0, q.x)) * (1.0 - smoothstep(mix(0.68, 0.18, lift), 1.0, q.y));
    let wheel = 1.0 - smoothstep(0.04, 0.27, length((q - vec2f(0.57, 0.53)) * vec2f(1.0, 1.3)));
    a = min(1.0, body * 0.88 + wheel * 0.55 * (1.0 - lift));
  }
  if (a <= 0.002) { discard; }
  return vec4f(o.color.rgb * a * o.color.a, a * o.color.a);
}
`

/** Fullscreen passes: bright-pass downsample, blur and final tone-mapped composite. */
export const postShader = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> P: vec4f; // texel size xy, mode/strength z, w extra
@group(0) @binding(3) var bloomTex: texture_2d<f32>;

struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f }

@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: VO;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}

fn clean(c: vec4f) -> vec4f {
  // NaN or Inf from any pass would smear across the whole bloom chain; drop them here.
  let bad = any(c != c) || any(abs(c) > vec4f(6e4));
  return select(min(c, vec4f(64.0)), vec4f(0.0), bad);
}

@fragment fn down(o: VO) -> @location(0) vec4f {
  let t = P.xy;
  var c = clean(textureSample(src, samp, o.uv)) * 0.5;
  c += clean(textureSample(src, samp, o.uv + vec2f(-t.x, -t.y))) * 0.125;
  c += clean(textureSample(src, samp, o.uv + vec2f(t.x, -t.y))) * 0.125;
  c += clean(textureSample(src, samp, o.uv + vec2f(-t.x, t.y))) * 0.125;
  c += clean(textureSample(src, samp, o.uv + vec2f(t.x, t.y))) * 0.125;
  if (P.z > 0.5) {
    // First level: keep only what is brighter than the threshold.
    let l = max(c.r, max(c.g, c.b));
    c = c * max(l - 1.0, 0.0) / max(l, 0.0001);
  }
  return vec4f(c.rgb, 1.0);
}

@fragment fn up(o: VO) -> @location(0) vec4f {
  let t = P.xy;
  var c = textureSample(src, samp, o.uv + vec2f(-t.x, 0.0)) * 0.25;
  c += textureSample(src, samp, o.uv + vec2f(t.x, 0.0)) * 0.25;
  c += textureSample(src, samp, o.uv + vec2f(0.0, -t.y)) * 0.25;
  c += textureSample(src, samp, o.uv + vec2f(0.0, t.y)) * 0.25;
  return vec4f(c.rgb, 1.0);
}

fn aces(x: vec3f) -> vec3f {
  let a = 2.51; let b = 0.03; let c = 2.43; let d = 0.59; let e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3f(0.0), vec3f(1.0));
}

@fragment fn composite(o: VO) -> @location(0) vec4f {
  let raw = textureSample(src, samp, o.uv);
  let bloom = textureSample(bloomTex, samp, o.uv).rgb;
  if (any(raw != raw)) { return vec4f(1.0, 0.0, 1.0, 1.0); }
  let hdr = raw.rgb;
  var c = hdr + bloom * P.z;
  // Luminance-preserving shoulder keeps saturated emergency lights coloured.
  let peak = max(c.r, max(c.g, c.b));
  let hue = c / max(peak, 0.0001);
  c = mix(aces(c * 1.12), hue * aces(vec3f(peak * 1.12)), 0.38);
  // Grade: richer saturation, navy shadows, warm highlights.
  let l = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  c = mix(vec3f(l), c, 1.22);
  c = c * mix(vec3f(0.86, 0.94, 1.18), vec3f(1.06, 1.0, 0.92), smoothstep(0.05, 0.6, l));
  c += vec3f(0.0015, 0.003, 0.007) * (1.0 - smoothstep(0.0, 0.25, l));
  let v = length((o.uv - 0.5) * vec2f(1.0, 0.8));
  c *= mix(1.0, 0.78, smoothstep(0.38, 0.82, v));
  c = max(c, vec3f(0.0));
  // Damage / bust flash tint.
  c = mix(c, vec3f(0.9, 0.1, 0.12), P.w * smoothstep(0.3, 0.8, v));
  return vec4f(pow(c, vec3f(1.0 / 2.2)), 1.0);
}
`

/** Volumetric light cones (helicopter spotlight, extraction column): additive, brightest along the core. */
export const beamShader = /* wgsl */ `
${common}

struct BIn {
  @location(0) pos: vec3f,
  @location(1) normal: vec3f,
  @location(2) color: vec3f,
  @location(3) mat: f32,
  @location(7) uv: vec2f,
}

struct BOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) color: vec3f,
  @location(3) uv: vec2f,
}

@vertex fn vs(v: BIn) -> BOut {
  var o: BOut;
  o.world = v.pos;
  o.pos = F.viewProj * vec4f(v.pos, 1.0);
  o.normal = v.normal;
  o.color = v.color;
  o.uv = v.uv;
  return o;
}

@fragment fn fs(o: BOut) -> @location(0) vec4f {
  let v = normalize(F.cam.xyz - o.world);
  let facing = abs(dot(normalize(o.normal), v));
  // uv.x: 0 at the source, 1 at the far end. uv.y: overall strength.
  let along = o.uv.x;
  let core = pow(facing, 3.5);
  let fade = mix(0.9, 0.25, along) * smoothstep(0.0, 4.0, o.world.y);
  let i = core * fade * o.uv.y;
  return vec4f(o.color * i, i);
}
`
