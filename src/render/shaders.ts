import { MAX_LIGHTS, MAX_OCCLUDERS, POLAR_RAYS } from "../../shared/config"

/** Frame uniform layout, in floats. Keep in step with Renderer.frame. */
export const FRAME_FLOATS = 16 + 4 * 6

const common = /* wgsl */ `
const MAX_LIGHTS: u32 = ${MAX_LIGHTS}u;
const RAYS: u32 = ${POLAR_RAYS}u;
const TAU: f32 = 6.2831853;
/** Visual brightness of map lights relative to the ambient. The rules use the raw intensity. */
const GAIN: f32 = 6.0;

struct Frame {
  viewProj: mat4x4f,
  cam: vec4f,        // eye position xyz, time
  screen: vec4f,     // width, height, light count, occluder count
  eye: vec4f,        // local player plan x, plan y, cutaway on (0/1), cutaway radius (NDC)
  ambient: vec4f,    // sky rgb, flash
  focus: vec4f,      // local player clip x, y, world height of the cut, 0
  grade: vec4f,      // desaturate (dead), exposure, grain, vignette
}

struct Light {
  pos: vec4f,    // plan x, height, plan y, radius
  color: vec4f,  // rgb, current power
  cone: vec4f,   // plan dir x, plan dir y, cos half-angle, has cone
  extra: vec4f,  // base power, 0, 0, 0
}

@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<storage, read> lights: array<Light>;
@group(0) @binding(2) var<storage, read> polar: array<f32>;

fn hash2(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}

fn noise2(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + vec2f(1.0, 0.0)), u.x), mix(hash2(i + vec2f(0.0, 1.0)), hash2(i + vec2f(1.0, 1.0)), u.x), u.y);
}

/** Whether p is in view of origin through the 2D occluders, from the polar shadow map slot. Same rule as the server. */
fn polarVis(slot: u32, origin: vec2f, p: vec2f) -> f32 {
  let dv = p - origin;
  let d = length(dv);
  if (d < 0.05) { return 1.0; }
  var a = atan2(dv.y, dv.x);
  if (a < 0.0) { a += TAU; }
  let f = a / TAU * f32(RAYS);
  let i0 = u32(floor(f)) % RAYS;
  let i1 = (i0 + 1u) % RAYS;
  let base = slot * RAYS;
  let occ = mix(polar[base + i0], polar[base + i1], fract(f));
  return 1.0 - smoothstep(occ - 0.03, occ + 0.03, d);
}

/**
 * Light reaching a surface. The floor gets exactly the rule's intensity (power, falloff, cone, 2D occlusion) so what
 * looks lit is what makes you visible. Walls and props add a little 3D form from the light's height.
 */
fn lightSum(world: vec3f, n: vec3f, honest: bool) -> vec3f {
  var acc = vec3f(0.0);
  let count = u32(F.screen.z);
  var plan = world.xz + n.xz * 0.05;
  for (var i = 0u; i < count; i++) {
    let L = lights[i];
    let power = L.color.w;
    if (power <= 0.001) { continue; }
    let lp = L.pos.xz;
    let dv = world.xz - lp;
    let d = length(dv);
    if (d >= L.pos.w) { continue; }
    var k = 1.0 - d / L.pos.w;
    var att = k * k * power;
    if (L.cone.w > 0.5 && d > 0.001) {
      let c = dot(dv / d, L.cone.xy);
      let t = clamp((c - L.cone.z) / 0.08, 0.0, 1.0);
      att *= t * t * (3.0 - 2.0 * t);
    }
    var sp = plan;
    // Tops of partitions and furniture: test a point nudged toward the light so lit tops read as lit.
    if (n.y > 0.5 && world.y > 0.05) { sp = world.xz - normalize(dv + vec2f(1e-4)) * min(0.45, d); }
    att *= polarVis(i, lp, sp);
    if (!honest) {
      let l = normalize(vec3f(lp.x, L.pos.y, lp.y) - world);
      att *= 0.45 + 0.75 * max(dot(n, l), 0.0);
    }
    acc += L.color.rgb * att;
  }
  return acc;
}

fn ambientAt(n: vec3f) -> vec3f {
  let sky = F.ambient.rgb;
  return mix(sky * 0.45, sky, n.y * 0.5 + 0.5);
}

`

/** Polar shadow map: for each light, the distance to the first occluder along each of RAYS angles. */
export const polarShader = /* wgsl */ `
${common}
@group(0) @binding(3) var<storage, read> occluders: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> polarOut: array<f32>;

fn slab(o: f32, d: f32, lo: f32, hi: f32, t0: ptr<function, f32>, t1: ptr<function, f32>) -> bool {
  if (abs(d) < 1e-9) { return o >= lo && o <= hi; }
  var a = (lo - o) / d;
  var b = (hi - o) / d;
  if (a > b) { let s = a; a = b; b = s; }
  *t0 = max(*t0, a);
  *t1 = min(*t1, b);
  return *t0 <= *t1;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let idx = gid.x;
  if (idx >= MAX_LIGHTS * RAYS) { return; }
  let slot = idx / RAYS;
  let ang = (f32(idx % RAYS) + 0.5) / f32(RAYS) * TAU;
  let dir = vec2f(cos(ang), sin(ang));
  if (slot >= u32(F.screen.z)) { polarOut[idx] = 0.0; return; }
  let o = lights[slot].pos.xz;
  let maxT = lights[slot].pos.w + 0.5;
  var t = maxT;
  let n = min(u32(F.screen.w), ${MAX_OCCLUDERS}u);
  for (var i = 0u; i < n; i++) {
    let r = occluders[i];
    var t0 = 0.0;
    var t1 = t;
    if (slab(o.x, dir.x, r.x, r.z, &t0, &t1) && slab(o.y, dir.y, r.y, r.w, &t0, &t1)) { t = min(t, t0); }
  }
  polarOut[idx] = t;
}
`

/**
 * Materials (vertex attribute): 0 lit, 1 floor (aux = kind), 2 lamp (aux = light id), 3 glow (aux = strength),
 * 4 wall (cut away near you), 5 tape, 6 glass, 7 city, 8 accent (takes the instance tint).
 */
export const sceneShader = /* wgsl */ `
${common}

struct VIn {
  @location(0) pos: vec3f,
  @location(1) normal: vec3f,
  @location(2) color: vec3f,
  @location(3) mat: f32,
  @location(4) aux: f32,
}

struct Inst {
  @location(5) posYaw: vec4f,  // x, y, z, yaw
  @location(6) tint: vec4f,    // rgb accent, scale
  @location(7) extra: vec4f,   // pitch, roll, alpha, hit flash
}

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) color: vec3f,
  @location(3) @interpolate(flat) mat: f32,
  @location(4) @interpolate(flat) aux: f32,
  @location(5) @interpolate(flat) extra: vec4f,
}

@vertex fn vsStatic(v: VIn) -> VOut {
  var o: VOut;
  o.world = v.pos;
  o.pos = F.viewProj * vec4f(v.pos, 1.0);
  o.normal = v.normal;
  o.color = pow(v.color, vec3f(2.2));
  o.mat = v.mat;
  o.aux = v.aux;
  o.extra = vec4f(0.0, 0.0, 1.0, 0.0);
  return o;
}


/** Part transform: pitch about the model's z axis (positive lifts +x), roll about its x axis, then yaw, then move. */
fn partRotate(p: vec3f, inst: Inst) -> vec3f {
  let cp = cos(inst.extra.x);
  let sp = sin(inst.extra.x);
  var q = vec3f(p.x * cp - p.y * sp, p.x * sp + p.y * cp, p.z);
  let cr = cos(inst.extra.y);
  let sr = sin(inst.extra.y);
  q = vec3f(q.x, q.y * cr - q.z * sr, q.y * sr + q.z * cr);
  let c = cos(inst.posYaw.w);
  let s = sin(inst.posYaw.w);
  return vec3f(q.x * c - q.z * s, q.y, q.x * s + q.z * c);
}

fn instWorld(p: vec3f, inst: Inst) -> vec3f {
  return partRotate(p * inst.tint.w, inst) + inst.posYaw.xyz;
}

fn instNormal(n: vec3f, inst: Inst) -> vec3f {
  return partRotate(n, inst);
}

@vertex fn vsInst(v: VIn, inst: Inst) -> VOut {
  var o: VOut;
  o.world = instWorld(v.pos, inst);
  o.pos = F.viewProj * vec4f(o.world, 1.0);
  o.normal = instNormal(v.normal, inst);
  // Accent parts glow in the player's colour so everyone reads in the dark.
  o.color = select(pow(v.color, vec3f(2.2)), inst.tint.rgb, v.mat > 7.5);
  o.mat = select(v.mat, 3.0, v.mat > 7.5);
  o.aux = select(v.aux, 0.85, v.mat > 7.5);
  o.extra = inst.extra;
  return o;
}

fn cutaway(world: vec3f, frag: vec4f) -> bool {
  if (F.eye.z < 0.5 || world.y < F.focus.z) { return false; }
  // Only what stands between the camera and you: south of you on the plan.
  if (world.z < F.eye.y + 0.25) { return false; }
  let ndc = vec2f(frag.x / F.screen.x * 2.0 - 1.0, 1.0 - frag.y / F.screen.y * 2.0);
  let dv = (ndc - F.focus.xy) * vec2f(F.screen.x / F.screen.y, 1.0);
  let r = length(dv) / F.eye.w;
  if (r > 1.0) { return false; }
  let p = vec2u(frag.xy) % 4u;
  let m = array<f32, 16>(0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
  return (m[p.y * 4u + p.x] + 0.5) / 16.0 < smoothstep(1.0, 0.6, r) * 0.85;
}

fn floorPattern(kind: i32, p: vec2f, base: vec3f) -> vec3f {
  var c = base;
  if (kind == 0) {
    // Carpet tiles, alternating pile direction.
    let cell = floor(p / 0.6);
    let checker = (i32(cell.x) + i32(cell.y)) & 1;
    c *= 0.92 + 0.08 * f32(checker) + 0.06 * (noise2(p * 7.0) - 0.5);
  } else if (kind == 1) {
    let g = fract(p / 0.6);
    let grout = 1.0 - (1.0 - smoothstep(0.0, 0.03, g.x) * smoothstep(1.0, 0.97, g.x)) * 0.35 - (1.0 - smoothstep(0.0, 0.03, g.y) * smoothstep(1.0, 0.97, g.y)) * 0.35;
    c *= max(grout, 0.55);
  } else if (kind == 2) {
    let row = floor(p.y / 0.22);
    let plank = floor((p.x + hash2(vec2f(row, 1.0)) * 2.0) / 1.6);
    c *= 0.82 + 0.25 * hash2(vec2f(row, plank));
    c *= 1.0 - 0.3 * (1.0 - smoothstep(0.0, 0.04, fract(p.y / 0.22)));
  } else if (kind == 3) {
    c *= 0.88 + 0.2 * noise2(p * 1.3) + 0.06 * noise2(p * 9.0);
  } else if (kind == 4) {
    let g = fract(p / 0.25);
    let bar = smoothstep(0.08, 0.14, g.x) * smoothstep(0.92, 0.86, g.x) * smoothstep(0.08, 0.14, g.y) * smoothstep(0.92, 0.86, g.y);
    c *= mix(1.35, 0.35, bar);
  }
  return c;
}

/** The city far below the windows: a dark grid of streets and lit windows. */
fn city(p: vec2f) -> vec3f {
  let blk = floor(p / 9.0);
  let f = fract(p / 9.0);
  let street = 1.0 - smoothstep(0.02, 0.08, min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)));
  var c = vec3f(0.004, 0.006, 0.014) + vec3f(0.5, 0.32, 0.12) * street * 0.05;
  let w = floor(p / 0.45);
  let lit = step(0.93, hash2(w + blk * 7.0)) * (1.0 - street);
  c += mix(vec3f(1.0, 0.7, 0.35), vec3f(0.5, 0.7, 1.0), hash2(w * 1.7)) * lit * 0.12;
  return c;
}

@fragment fn fs(o: VOut) -> @location(0) vec4f {
  let n = normalize(o.normal);
  let mat = i32(round(o.mat));
  var col: vec3f;
  var alpha = 1.0;
  if (mat == 7) {
    return vec4f(city(o.world.xz), 1.0);
  }
  if (mat == 4 && cutaway(o.world, o.pos)) { discard; }
  if (mat == 2) {
    // Fixture tied to a map light: bright when its light is on, near-dark when broken or switched off.
    let L = lights[u32(o.aux)];
    let k = L.color.w / max(L.extra.x, 0.001);
    col = o.color * (0.04 + 3.2 * k);
  } else if (mat == 3) {
    col = o.color * o.aux;
  } else if (mat == 5) {
    let lit = lightSum(o.world, n, true);
    col = o.color * (ambientAt(n) * 1.6 + lit * GAIN);
  } else if (mat == 6) {
    let lit = lightSum(o.world, vec3f(0.0, 1.0, 0.0), false);
    col = vec3f(0.02, 0.035, 0.06) + lit * 0.5 + vec3f(0.05, 0.08, 0.12) * pow(1.0 - abs(n.y), 3.0);
    alpha = 0.42;
  } else {
    var albedo = o.color;
    let honest = mat == 1;
    if (mat == 1) { albedo = floorPattern(i32(o.aux), o.world.xz, albedo); }
    let lit = lightSum(o.world, n, honest);
    col = albedo * (ambientAt(n) + lit * GAIN);
    // Soft occlusion where walls and furniture meet the floor.
    if (abs(n.y) < 0.5) { col *= mix(0.6, 1.0, smoothstep(0.0, 1.2, o.world.y)); }
  }
  col = mix(col, vec3f(2.5), o.extra.w);
  let a = alpha * o.extra.z;
  return vec4f(col * a, a);
}
`

/**
 * Sprites. kind: 0 glow (camera facing), 1 faceted smoke puff, 2 ground ring, 3 jagged ground ring, 4 ground line
 * (tracer, throw arc), 5 dashed ground ring, 6 ground disc, 7 marker "!".
 */
export const spriteShader = /* wgsl */ `
${common}

struct SIn {
  @location(0) posSize: vec4f,
  @location(1) color: vec4f,
  @location(2) misc: vec4f,   // kind, rotation, stretch (or ring width), extra
}

struct SOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
  @location(2) @interpolate(flat) misc: vec4f,
  @location(3) world: vec3f,
}

@vertex fn vs(@builtin(vertex_index) vi: u32, s: SIn) -> SOut {
  var corners = array<vec2f, 6>(vec2f(-1, -1), vec2f(1, -1), vec2f(1, 1), vec2f(-1, -1), vec2f(1, 1), vec2f(-1, 1));
  let c = corners[vi];
  let kind = i32(s.misc.x);
  let size = s.posSize.w;
  var world: vec3f;
  if (kind >= 2 && kind <= 6) {
    let r = s.misc.y;
    let lc = vec2f(c.x * size, c.y * size * select(1.0, max(s.misc.z, 0.001), kind == 4));
    world = s.posSize.xyz + vec3f(lc.x * cos(r) - lc.y * sin(r), 0.0, lc.x * sin(r) + lc.y * cos(r));
  } else {
    let toCam = normalize(F.cam.xyz - s.posSize.xyz);
    let right = normalize(cross(vec3f(0.0, 1.0, 0.0), toCam));
    let up = cross(toCam, right);
    world = s.posSize.xyz + (right * c.x + up * c.y) * size + toCam * size * 0.5;
  }
  var o: SOut;
  o.pos = F.viewProj * vec4f(world, 1.0);
  o.uv = c;
  o.color = s.color;
  o.misc = s.misc;
  o.world = world;
  return o;
}

@fragment fn fs(o: SOut) -> @location(0) vec4f {
  let r = length(o.uv);
  let kind = i32(o.misc.x);
  var a = 0.0;
  var rgb = o.color.rgb;
  if (kind == 0) {
    a = pow(max(0.0, 1.0 - r), 2.4);
  } else if (kind == 1) {
    // Faceted puff: a hexagon split into six flat-shaded wedges, lit from the flare below.
    let ang = atan2(o.uv.y, o.uv.x) + o.misc.w;
    let sector = floor((ang + 3.14159) / 1.0472);
    let hexR = 0.866 / cos(((ang + 3.14159) - (sector + 0.5) * 1.0472));
    if (r > hexR) { discard; }
    rgb *= 0.65 + 0.35 * hash2(vec2f(sector, o.misc.w * 13.0));
    a = 1.0;
  } else if (kind == 2 || kind == 3 || kind == 5) {
    var rr = r;
    if (kind == 3) {
      let ang = atan2(o.uv.y, o.uv.x);
      rr = r + 0.05 * abs(fract(ang * 2.5 + o.misc.w) - 0.5) * 2.0;
    }
    let w = o.misc.z;
    a = 1.0 - smoothstep(w * 0.5, w * 0.5 + 0.012, abs(rr - (1.0 - w)));
    if (kind == 5) {
      let ang = atan2(o.uv.y, o.uv.x);
      a *= step(0.5, fract(ang * 9.0 / 3.14159));
    }
  } else if (kind == 4) {
    a = (1.0 - smoothstep(0.6, 1.0, abs(o.uv.y))) * (1.0 - smoothstep(0.92, 1.0, abs(o.uv.x)));
    if (o.misc.w > 0.5) { a *= step(0.45, fract(o.uv.x * o.misc.w)); }
  } else if (kind == 6) {
    a = 1.0 - smoothstep(0.85, 1.0, r);
  } else if (kind == 7) {
    let bar = step(abs(o.uv.x), 0.16) * step(-0.2, o.uv.y) * step(o.uv.y, 0.95);
    let pt = step(length(o.uv - vec2f(0.0, -0.6)), 0.2);
    a = max(bar, pt);
  }
  if (a <= 0.002) { discard; }
  return vec4f(rgb * a * o.color.a, a * o.color.a);
}
`

/** Fullscreen passes: bloom downsample and upsample, then the tone-mapped, graded composite. */
export const postShader = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> P: vec4f;
@group(0) @binding(3) var bloomTex: texture_2d<f32>;
@group(0) @binding(4) var<uniform> G: vec4f;

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

@fragment fn down(o: VO) -> @location(0) vec4f {
  let t = P.xy;
  var c = clean(textureSample(src, samp, o.uv)) * 0.5;
  c += clean(textureSample(src, samp, o.uv + vec2f(-t.x, -t.y))) * 0.125;
  c += clean(textureSample(src, samp, o.uv + vec2f(t.x, -t.y))) * 0.125;
  c += clean(textureSample(src, samp, o.uv + vec2f(-t.x, t.y))) * 0.125;
  c += clean(textureSample(src, samp, o.uv + vec2f(t.x, t.y))) * 0.125;
  if (P.z > 0.5) {
    let l = max(c.r, max(c.g, c.b));
    c = c * max(l - 0.8, 0.0) / max(l, 0.0001);
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
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
}

fn hash(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(12.9898, 78.233))) * 43758.5453);
}

// G: time, desaturate, flash, exposure
@fragment fn composite(o: VO) -> @location(0) vec4f {
  let hdr = clean(textureSample(src, samp, o.uv)).rgb;
  let bloom = textureSample(bloomTex, samp, o.uv).rgb;
  var c = aces((hdr + bloom * 0.55) * G.w);
  let l = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  c = mix(vec3f(l), c, 1.12 - G.y);
  c += vec3f(0.004, 0.007, 0.018) * (1.0 - smoothstep(0.0, 0.2, l));
  let v = length((o.uv - 0.5) * vec2f(1.0, 0.85));
  c *= mix(1.0, 0.55, smoothstep(0.4, 0.85, v));
  c = mix(c, vec3f(0.55, 0.05, 0.06), G.z * smoothstep(0.25, 0.85, v));
  c = pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.2));
  c += (hash(o.uv * 1000.0 + vec2f(G.x * 37.0, G.x * 91.0)) - 0.5) * 0.035;
  return vec4f(c, 1.0);
}
`
