import { LookUniformsStruct, lookStructWgsl } from "@arcade/kit/gpu/look"

/** Point lights the scene shades with (fire bowls, arrowheads, blasts). */
export const MAX_LIGHTS = 32
/** Frame uniform: 7 vec4 + mat4 + lights, in floats. */
export const FRAME_FLOATS = 16 + 4 * 7 + MAX_LIGHTS * 8

/**
 * Material ids in the vertex `mat` field. Everything in the noir scene is near-black; colour comes from emissive fire
 * and the player marks, which also write the colour-retention mask in HDR alpha so the grade keeps them saturated.
 */
export const M = { stone: 0, foliage: 1, emissive: 2, actor: 3, accent: 4, cloth: 5, far: 6, metal: 8, wood: 9 } as const

const frame = /* wgsl */ `
struct Frame {
  vp: mat4x4f,
  eye: vec4f,
  screen: vec4f,
  sun: vec4f,
  fog: vec4f,
  look: vec4f,
  misc: vec4f,
  tint: vec4f,
  lights: array<vec4f, ${MAX_LIGHTS * 2}>,
}
@group(0) @binding(0) var<uniform> F: Frame;

fn hash21(p: vec2f) -> f32 {
  var q = fract(p * vec2f(123.34, 456.21));
  q += dot(q, q + 45.32);
  return fract(q.x * q.y);
}
fn vnoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2f(1.0, 0.0)), u.x), mix(hash21(i + vec2f(0.0, 1.0)), hash21(i + vec2f(1.0, 1.0)), u.x), u.y);
}
fn fbm(p: vec2f) -> f32 {
  var a = 0.0;
  var w = 0.5;
  var q = p;
  for (var i = 0; i < 4; i++) {
    a += vnoise(q) * w;
    q = q * 2.03 + vec2f(17.1, -9.7);
    w *= 0.5;
  }
  return a;
}

/** The bright core of the fog behind the tower window: what light shafts radiate from. */
fn sunGlow(uv: vec2f) -> f32 {
  let asp = F.screen.x * F.screen.w;
  let d = length((uv - F.sun.xy) * vec2f(asp, 1.0));
  return F.sun.w * (0.3 * exp(-d * d / (F.sun.z * F.sun.z)) + 0.06 * exp(-d / (F.sun.z * 2.5)));
}

/** The fog backdrop at a screen uv (0..1, y down): a pale core behind the tower, darker corners, drifting mist. */
fn sky(uv: vec2f) -> vec3f {
  let t = F.eye.w;
  let asp = F.screen.x * F.screen.w;
  let c = length((uv - vec2f(0.5, 0.42)) * vec2f(asp * 0.55, 1.0));
  var l = mix(0.1, 0.014, smoothstep(0.3, 1.15, c));
  l += sunGlow(uv);
  let m = fbm(vec2f(uv.x * asp * 2.1 + t * 0.011, uv.y * 2.6 - t * 0.004));
  let m2 = fbm(vec2f(uv.x * asp * 5.5 - t * 0.024, uv.y * 6.0 + 3.0));
  l *= 0.72 + 0.4 * m + 0.14 * m2;
  return vec3f(l) * F.tint.rgb * F.look.w;
}

/** Fog between the gameplay plane's camera and a point: by depth behind the plane, plus low ground mist. */
fn fogAmount(w: vec3f) -> f32 {
  let behind = max(0.0, -w.z);
  var a = 1.0 - exp(-behind * F.fog.x);
  let low = exp(-max(w.y + 2.0, 0.0) / F.fog.y) * F.fog.z;
  a = a + (1.0 - a) * clamp(low * clamp(behind * 0.12 + 0.12, 0.0, 1.0), 0.0, 0.85);
  return clamp(a, 0.0, 1.0);
}

fn screenUv(clip: vec4f) -> vec2f {
  return clip.xy * F.screen.zw;
}

fn pointLights(w: vec3f, n: vec3f, wrap: f32) -> vec3f {
  var acc = vec3f(0.0);
  let count = i32(F.look.y);
  for (var i = 0; i < count; i++) {
    let p = F.lights[i * 2];
    let c = F.lights[i * 2 + 1];
    let L = p.xyz - w;
    let d = length(L);
    if (d > p.w) { continue; }
    let att = pow(1.0 - d / p.w, 2.0);
    let ndl = (dot(n, L / max(d, 1e-3)) + wrap) / (1.0 + wrap);
    acc += c.rgb * c.w * att * max(ndl, 0.0);
  }
  return acc;
}

struct FOut { @location(0) color: vec4f, @location(1) shaft: vec4f }
`

export const sceneShader = /* wgsl */ `
${frame}
struct VIn { @location(0) pos: vec3f, @location(1) normal: vec4f, @location(2) color: vec4f, @location(3) matAux: vec2f }
struct Inst { @location(4) ps: vec4f, @location(5) ax: vec4f, @location(6) ay: vec4f, @location(7) az: vec4f, @location(8) tint: vec4f }
struct VOut {
  @builtin(position) clip: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) color: vec3f,
  @location(3) @interpolate(flat) mat: f32,
  @location(4) aux: f32,
  @location(5) @interpolate(flat) tint: vec4f,
  @location(6) @interpolate(flat) fx: vec3f,
}

@vertex fn vsStatic(v: VIn) -> VOut {
  var o: VOut;
  o.world = v.pos;
  o.clip = F.vp * vec4f(v.pos, 1.0);
  o.normal = v.normal.xyz;
  o.color = v.color.rgb;
  o.mat = v.matAux.x;
  o.aux = v.matAux.y;
  o.tint = vec4f(1.0);
  o.fx = vec3f(0.0, 0.0, 0.0);
  return o;
}

@vertex fn vsInst(v: VIn, i: Inst) -> VOut {
  var o: VOut;
  let local = v.pos * i.ps.w;
  let w = i.ps.xyz + i.ax.xyz * local.x + i.ay.xyz * local.y + i.az.xyz * local.z;
  o.world = w;
  o.clip = F.vp * vec4f(w, 1.0);
  o.normal = normalize(i.ax.xyz * v.normal.x + i.ay.xyz * v.normal.y + i.az.xyz * v.normal.z);
  o.color = v.color.rgb;
  o.mat = v.matAux.x;
  o.aux = v.matAux.y;
  o.tint = i.tint;
  o.fx = vec3f(i.ax.w, i.ay.w, i.az.w);
  return o;
}

fn faceUv(w: vec3f, n: vec3f) -> vec2f {
  if (abs(n.x) > 0.6) { return w.zy; }
  if (abs(n.y) > 0.6) { return w.xz; }
  return w.xy;
}

fn stoneTex(w: vec3f, n: vec3f) -> f32 {
  let uv = faceUv(w, n);
  let row = floor(uv.y * 2.0);
  let bx = uv.x * 1.3 + row * 0.53;
  let fb = fract(vec2f(bx, uv.y * 2.0));
  let fw = max(fwidth(bx), 1e-3);
  let mortar = smoothstep(0.0, 0.05 + fw, min(fb.x, 1.0 - fb.x)) * smoothstep(0.0, 0.08 + fw, min(fb.y, 1.0 - fb.y));
  let id = hash21(vec2f(floor(bx), row));
  let grain = fbm(uv * 5.0 + id * 7.0);
  let big = vnoise(w.xy * 0.35 + w.z * 0.2);
  return mix(0.82, 1.0, mortar) * (0.8 + 0.3 * id) * (0.6 + 0.7 * grain) * (0.65 + 0.6 * big);
}

@fragment fn fs(o: VOut, @builtin(front_facing) front: bool) -> FOut {
  let mat = i32(round(o.mat));
  var n = normalize(o.normal);
  if (!front) { n = -n; }
  let w = o.world;
  let uv = screenUv(o.clip);
  let skyC = sky(uv);
  let skyL = dot(skyC, vec3f(0.333));
  var col = vec3f(0.0);
  var keep = 0.0;
  let amb = F.fog.w;
  let flash = o.fx.z;
  // Light from the fog above and behind: tops and the far sides catch a little of it.
  let skyTop = max(n.y, 0.0) * 0.35 + max(-n.z, 0.0) * 0.2;
  // Derivatives must be taken in uniform control flow, so the stone pattern is computed for every fragment.
  let stone = stoneTex(w, n);
  if (mat == 0 || mat == 1 || mat == 9) {
    var base = o.color * o.tint.rgb;
    if (mat == 0) { base *= stone; }
    if (mat == 1) { base *= 0.7 + 0.6 * vnoise(faceUv(w, n) * 9.0); }
    let lit = pointLights(w, n, 0.25);
    col = base * (amb + skyTop * skyL * 1.4 + lit * 2.2);
    keep = clamp(dot(lit, vec3f(0.333)) * 0.35, 0.0, 0.5);
  } else if (mat == 6) {
    col = o.color * (0.6 + 0.4 * skyTop) * skyL * 0.1;
  } else if (mat == 2) {
    let flick = 0.82 + 0.18 * vnoise(vec2f(F.eye.w * 9.0 + w.x * 3.0, w.y * 2.0));
    col = o.color * o.tint.rgb * o.aux * flick + o.tint.rgb * o.fx.x;
    keep = 1.0;
  } else if (mat == 3) {
    let lit = pointLights(w, n, 0.6);
    col = vec3f(0.0035, 0.0035, 0.004) * o.color * (1.0 + skyTop * skyL * 6.0) + lit * 0.02 * o.color;
    keep = clamp(dot(lit, vec3f(0.333)) * 0.4, 0.0, 0.5);
  } else if (mat == 4) {
    col = o.tint.rgb * (o.aux + o.fx.x);
    keep = o.fx.y;
  } else if (mat == 5) {
    let lit = pointLights(w, n, 0.5);
    col = o.tint.rgb * o.color * (0.07 + skyTop * skyL * 0.6 + lit * 0.5 + o.fx.x);
    // Static and dynamic cloth (scarves) carry their colour retention in aux.
    keep = max(o.fx.y, o.aux);
  } else if (mat == 8) {
    let lit = pointLights(w, n, 0.1);
    let v = normalize(F.eye.xyz - w);
    col = o.color * o.tint.rgb * (amb + lit * 0.6) + lit * pow(max(dot(n, v), 0.0), 6.0) * 0.4 + o.tint.rgb * o.fx.x;
    keep = clamp(dot(lit, vec3f(0.333)) * 0.5 + o.fx.y, 0.0, 1.0);
  }
  col += vec3f(flash * 0.35);
  let f = select(fogAmount(w), max(fogAmount(w), 0.0) * 0.4, mat == 2 || mat == 4);
  let near = 1.0 - f;
  var out: FOut;
  out.color = vec4f(mix(col, skyC, f), keep * near);
  out.shaft = vec4f(vec3f(sunGlow(uv)) * F.tint.rgb * f * f, near * select(1.0, smoothstep(-3.0, -0.5, w.z), w.z < 0.0));
  return out;
}
`

export const backdropShader = /* wgsl */ `
${frame}
struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f }
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: VO;
  o.pos = vec4f(p * 2.0 - 1.0, 1.0, 1.0);
  o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}
@fragment fn fs(o: VO) -> FOut {
  let uv = screenUv(o.pos);
  let c = sky(uv);
  var out: FOut;
  out.color = vec4f(c, 0.0);
  out.shaft = vec4f(vec3f(sunGlow(uv)) * F.tint.rgb, 0.0);
  return out;
}
`

/**
 * Camera-facing quads: glows, rings, pips, streaks, embers and mist sheets. Instance: centre + size, rotation/kind,
 * colour, and extra (retention, softness, seed, shaft). One module serves the additive and premultiplied pipelines.
 */
export const quadShader = /* wgsl */ `
${frame}
struct QIn { @location(0) pos: vec4f, @location(1) shape: vec4f, @location(2) color: vec4f, @location(3) extra: vec4f }
struct QOut {
  @builtin(position) clip: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
  @location(2) @interpolate(flat) kind: f32,
  @location(3) @interpolate(flat) extra: vec4f,
  @location(4) world: vec3f,
}
@vertex fn vs(@builtin(vertex_index) vi: u32, q: QIn) -> QOut {
  let corners = array<vec2f, 6>(vec2f(-1, -1), vec2f(1, -1), vec2f(1, 1), vec2f(-1, -1), vec2f(1, 1), vec2f(-1, 1));
  let c = corners[vi];
  let cs = cos(q.shape.z);
  let sn = sin(q.shape.z);
  let lx = c.x * q.pos.w;
  let ly = c.y * q.shape.x;
  let w = q.pos.xyz + vec3f(lx * cs - ly * sn, lx * sn + ly * cs, 0.0);
  var o: QOut;
  o.clip = F.vp * vec4f(w, 1.0);
  o.uv = c;
  o.color = q.color;
  o.kind = q.shape.w;
  o.extra = q.extra;
  o.world = w;
  return o;
}
fn quadColor(o: QOut) -> vec4f {
  let k = i32(round(o.kind));
  let r = length(o.uv);
  var a = 0.0;
  var rgb = o.color.rgb;
  if (k == 0) {
    a = exp(-r * r * 4.0) * (1.0 - smoothstep(0.85, 1.0, r));
  } else if (k == 1) {
    a = exp(-pow((r - 0.8) / 0.09, 2.0));
  } else if (k == 2) {
    let d = abs(o.uv.x) + abs(o.uv.y);
    a = 1.0 - smoothstep(0.8, 1.0, d);
  } else if (k == 3) {
    let y = o.uv.y;
    let x = o.uv.x * 0.5 + 0.5;
    a = exp(-y * y * 5.0) * smoothstep(0.0, 0.25, x) * (1.0 - smoothstep(0.7, 1.0, x));
    a *= mix(0.25, 1.0, x);
  } else if (k == 4) {
    a = 1.0 - smoothstep(0.85, 1.0, r);
  } else if (k == 5) {
    let seed = o.extra.z;
    let p = o.world.xy * vec2f(0.16, 0.42) + vec2f(F.eye.w * 0.05 * (0.5 + fract(seed)), seed * 13.1);
    let n = fbm(p) * 0.75 + fbm(p * 2.7 + 5.0) * 0.35;
    let edge = (1.0 - smoothstep(0.55, 1.0, abs(o.uv.x))) * (1.0 - smoothstep(0.35, 1.0, abs(o.uv.y)));
    a = smoothstep(0.38, 0.85, n) * edge;
    rgb = sky(screenUv(o.clip)) * o.color.rgb;
  } else if (k == 6) {
    let ang = atan2(o.uv.y, o.uv.x);
    let spikes = 0.55 + 0.45 * abs(sin(ang * 5.0 + o.extra.z * 6.0));
    a = 1.0 - smoothstep(spikes * 0.9, spikes, r);
  } else if (k == 7) {
    // A bar (bowstrings, laser cores, trails): full along x with soft ends, soft across y.
    a = (1.0 - smoothstep(0.3, 1.0, abs(o.uv.y))) * (1.0 - smoothstep(0.92, 1.0, abs(o.uv.x)));
  }
  return vec4f(rgb, a * o.color.a);
}
/** Additive glows: colour retention rides in alpha (max-blended) so the grade keeps them saturated. */
@fragment fn fsAdd(o: QOut) -> FOut {
  let c = quadColor(o);
  if (c.a < 0.002) { discard; }
  var out: FOut;
  out.color = vec4f(c.rgb * c.a, c.a * o.extra.x);
  out.shaft = vec4f(0.0);
  return out;
}
/** Premultiplied sheets (mist, smoke): alpha is coverage, which also fades the retention underneath. */
@fragment fn fsAlpha(o: QOut) -> FOut {
  let c = quadColor(o);
  if (c.a < 0.002) { discard; }
  var out: FOut;
  out.color = vec4f(c.rgb * c.a, c.a);
  out.shaft = vec4f(0.0);
  return out;
}
`

export const shaftShader = /* wgsl */ `
${frame}
@group(1) @binding(0) var src: texture_2d<f32>;
@group(1) @binding(1) var samp: sampler;
struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f }
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: VO;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}
@fragment fn fs(o: VO) -> @location(0) vec4f {
  let N = 48;
  let sun = F.sun.xy;
  let delta = (o.uv - sun) * (0.92 / f32(N));
  let ign = fract(52.9829189 * fract(dot(o.pos.xy, vec2f(0.06711056, 0.00583715))));
  var p = o.uv - delta * ign;
  var acc = vec3f(0.0);
  var w = 1.0;
  for (var i = 0; i < N; i++) {
    let s = textureSampleLevel(src, samp, p, 0.0);
    acc += s.rgb * (1.0 - s.a) * w;
    w *= 0.955;
    p -= delta;
  }
  return vec4f(acc / f32(N), 1.0);
}
`

export const compositeShader = /* wgsl */ `
${lookStructWgsl}
${frame}
@group(1) @binding(0) var hdrTex: texture_2d<f32>;
@group(1) @binding(1) var bloomTex: texture_2d<f32>;
@group(1) @binding(2) var shaftTex: texture_2d<f32>;
@group(1) @binding(3) var srcTex: texture_2d<f32>;
@group(1) @binding(4) var samp: sampler;
@group(1) @binding(5) var<uniform> L: LookUniforms;
struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f }
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: VO;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}
fn clean(c: vec4f) -> vec4f {
  let bad = any(c != c) || any(abs(c) > vec4f(6e4));
  return select(min(c, vec4f(64.0)), vec4f(0.0), bad);
}
@fragment fn fs(o: VO) -> @location(0) vec4f {
  let uv = o.uv;
  let px = F.screen.zw;
  let h = clean(textureSampleLevel(hdrTex, samp, uv, 0.0));
  var hdr = h.rgb;
  let bloom = textureSampleLevel(bloomTex, samp, uv, 0.0).rgb;
  let shafts = textureSampleLevel(shaftTex, samp, uv, 0.0).rgb;
  // Rim: near silhouette pixels that border something farther (fog, far layers) pick up a thin halo of the fog.
  let c0 = textureSampleLevel(srcTex, samp, uv, 0.0);
  var rim = vec3f(0.0);
  if (c0.a > 0.2) {
    let r = 1.15 * F.screen.y / 720.0;
    var m: array<f32, 8>;
    for (var i = 0; i < 8; i++) {
      let ang = f32(i) * 0.7853982;
      m[i] = textureSampleLevel(srcTex, samp, uv + vec2f(cos(ang), sin(ang)) * px * r, 0.0).a;
    }
    // Only edges with body behind them light up: hair-thin strands (vines, strings) would otherwise glow whole.
    var edge = 0.0;
    for (var i = 0; i < 8; i++) {
      edge = max(edge, (c0.a - m[i]) * m[(i + 4) % 8]);
    }
    rim = sky(uv) * edge * F.misc.x * 1.6;
  }
  // God rays are light scattered in the fog between the eye and the surface: near silhouettes stay black.
  hdr += rim + shafts * F.misc.y * vec3f(1.0, 0.97, 0.92) * 0.55 * (1.0 - 0.9 * c0.a);
  let warm = clamp((hdr.r - hdr.b * 1.1) / max(hdr.r + 0.01, 1e-3), 0.0, 1.0) * smoothstep(0.05, 0.5, hdr.r);
  let keep = clamp(max(h.a, warm), 0.0, 1.0);
  var c = lookGradeColor(L, hdr, bloom, uv, o.pos.xy, F.eye.w, dot(shafts, vec3f(0.33)) * 2.0, 0.35, 0.6, 0.25, keep);
  let gray = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  c = mix(c, vec3f(gray), F.misc.w * (1.0 - keep));
  // Painted texture, fixed to the screen like paper: a broad mottle and a fine speckle that break up the flat fog,
  // and a faint lift of the same in the blacks so silhouettes read as matter, not holes.
  let sp = o.pos.xy * (720.0 / F.screen.y);
  let mottle = fbm(sp / 11.0) - 0.47;
  let speck = vnoise(sp / 1.7) - 0.5;
  let lum = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  let lit = smoothstep(0.015, 0.2, lum) * (1.0 - keep);
  c *= 1.0 + (mottle * 0.22 + speck * 0.06) * lit;
  c += vec3f(max(0.0, mottle + 0.12) * 0.004 * (1.0 - lit) * (1.0 - keep));
  let v = length((uv - 0.5) * vec2f(1.0, 0.8));
  // A deep frame of shadow: the corners fall to near black like the painted concept.
  c *= mix(1.0, 0.45, smoothstep(0.38, 0.85, v));
  c = mix(c, vec3f(0.5, 0.06, 0.04), F.misc.z * smoothstep(0.3, 0.9, v));
  return vec4f(pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.2)), 1.0);
}
`

export { LookUniformsStruct }
