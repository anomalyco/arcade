import { MAX_LIGHTS, MAX_WALLS, POLAR_RAYS, VIEW_RANGE } from "../../shared/config"

/** Shared between the compute pass and the scene pass. Keep in step with `FRAME_BYTES` in renderer.ts. */
const COMMON = /* wgsl */ `
const MAX_LIGHTS: u32 = ${MAX_LIGHTS}u;
const RAYS: u32 = ${POLAR_RAYS}u;
const MAX_WALLS: u32 = ${MAX_WALLS}u;
const VIEW_RANGE: f32 = ${VIEW_RANGE.toFixed(1)};
const PI: f32 = 3.14159265;

struct Frame {
  cam: vec2f,
  scale: vec2f,
  res: vec2f,
  eye: vec2f,
  eyeOn: f32,
  time: f32,
  nLights: f32,
  nWalls: f32,
  amb: f32,
  pad0: f32,
  pad1: f32,
  pad2: f32,
}

struct LightU {
  p: vec4f,
  c: vec4f,
}
`

/** Polar shadow pass: for each light (and the local eye), nearest occluder distance along RAYS directions. */
export const polarShader = /* wgsl */ `
${COMMON}
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<storage, read> lights: array<LightU>;
@group(0) @binding(2) var<storage, read> walls: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> polar: array<f32>;

fn slab(o: f32, d: f32, lo: f32, hi: f32, t0: ptr<function, f32>, t1: ptr<function, f32>) -> bool {
  if (abs(d) < 1e-9) {
    return o >= lo && o <= hi;
  }
  let inv = 1.0 / d;
  var a = (lo - o) * inv;
  var b = (hi - o) * inv;
  if (a > b) {
    let s = a;
    a = b;
    b = s;
  }
  *t0 = max(*t0, a);
  *t1 = min(*t1, b);
  return *t0 <= *t1;
}

fn rayRect(o: vec2f, d: vec2f, r: vec4f, maxT: f32) -> f32 {
  var t0 = 0.0;
  var t1 = maxT;
  if (!slab(o.x, d.x, r.x, r.z, &t0, &t1)) { return 1e30; }
  if (!slab(o.y, d.y, r.y, r.w, &t0, &t1)) { return 1e30; }
  return t0;
}

@compute @workgroup_size(64)
fn polarMain(@builtin(global_invocation_id) gid: vec3u) {
  let idx = gid.x;
  if (idx >= (MAX_LIGHTS + 1u) * RAYS) { return; }
  let slot = idx / RAYS;
  let ray = idx % RAYS;
  let ang = f32(ray) / f32(RAYS) * 2.0 * PI;
  let d = vec2f(cos(ang), sin(ang));
  var o = F.eye;
  var maxT = VIEW_RANGE;
  if (slot < MAX_LIGHTS) {
    let L = lights[slot];
    o = L.p.xy;
    maxT = L.p.z;
  }
  var t = maxT;
  let n = u32(F.nWalls);
  for (var i = 0u; i < n; i++) {
    let h = rayRect(o, d, walls[i], t);
    if (h < t) {
      t = h;
    }
  }
  polar[idx] = t;
}
`

/** Scene shaders: a lit floor, instanced quads (walls, actors, glows, tracers, rings) and a composite. */
export const sceneShader = /* wgsl */ `
${COMMON}
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<storage, read> lights: array<LightU>;
@group(0) @binding(2) var<storage, read> polar: array<f32>;

fn visAt(slot: u32, dv: vec2f, d: f32, bias: f32) -> f32 {
  var f = atan2(dv.y, dv.x) / (2.0 * PI) * f32(RAYS);
  if (f < 0.0) {
    f += f32(RAYS);
  }
  let i0 = u32(floor(f)) % RAYS;
  let i1 = (i0 + 1u) % RAYS;
  let t = fract(f);
  let base = slot * RAYS;
  let occ = mix(polar[base + i0], polar[base + i1], t) + bias;
  return 1.0 - smoothstep(occ - 0.05, occ + 0.05, d);
}

/** Light arriving at p from every lamp and flare, through the same occluders the server uses. */
fn lightSum(p: vec2f, bias: f32) -> vec3f {
  var acc = vec3f(0.0);
  let n = u32(F.nLights);
  for (var i = 0u; i < n; i++) {
    let L = lights[i];
    let power = L.p.w;
    let R = L.p.z;
    let dv = p - L.p.xy;
    let d = length(dv);
    if (power <= 0.0 || d >= R) { continue; }
    let k = 1.0 - d / R;
    acc += L.c.rgb * (k * k * power) * visAt(i, dv, d, bias);
  }
  return acc;
}

/** Local player's line of sight. Outside it, the scene stays black apart from a whisper of layout. */
fn eyeVis(p: vec2f, bias: f32) -> f32 {
  if (F.eyeOn < 0.5) { return 1.0; }
  let dv = p - F.eye;
  let d = length(dv);
  if (d > VIEW_RANGE + 1.0) { return 0.0; }
  return visAt(MAX_LIGHTS, dv, d, bias);
}

fn hash(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}

fn noise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2f(1.0, 0.0)), u.x), mix(hash(i + vec2f(0.0, 1.0)), hash(i + vec2f(1.0, 1.0)), u.x), u.y);
}

fn screenToWorld(px: vec2f) -> vec2f {
  let ndc = vec2f(px.x / F.res.x * 2.0 - 1.0, 1.0 - px.y / F.res.y * 2.0);
  return F.cam + ndc / F.scale;
}

struct FloorOut {
  @builtin(position) pos: vec4f,
}

@vertex fn floorVs(@builtin(vertex_index) vi: u32) -> FloorOut {
  let xy = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  var o: FloorOut;
  o.pos = vec4f(xy * 2.0 - 1.0, 0.0, 1.0);
  return o;
}

@fragment fn floorFs(@builtin(position) px: vec4f) -> @location(0) vec4f {
  let p = screenToWorld(px.xy);
  let ev = eyeVis(p, 0.0);
  let light = lightSum(p, 0.0);
  let tone = 0.10 + 0.07 * noise(p * 1.6) + 0.03 * noise(p * 9.0);
  let fx = fract(p.x / 3.0);
  let fy = fract(p.y / 3.0);
  let seam = 1.0 - smoothstep(0.0, 0.012, min(min(fx, 1.0 - fx), min(fy, 1.0 - fy)));
  let albedo = tone * (1.0 - 0.25 * seam);
  let col = albedo * (light + vec3f(F.amb)) * ev;
  return vec4f(col, 1.0);
}

struct Inst {
  @location(0) a: vec4f,
  @location(1) b: vec4f,
  @location(2) col: vec4f,
  @location(3) prm: vec4f,
}

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) local: vec2f,
  @location(1) world: vec2f,
  @location(2) @interpolate(flat) hs: vec2f,
  @location(3) @interpolate(flat) mode: f32,
  @location(4) @interpolate(flat) lit: f32,
  @location(5) @interpolate(flat) col: vec4f,
  @location(6) @interpolate(flat) prm: vec4f,
}

const CORNERS = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));

@vertex fn instVs(@builtin(vertex_index) vi: u32, i: Inst) -> VOut {
  let c = CORNERS[vi];
  let hx = i.a.z;
  let hy = i.a.w;
  let local = c * vec2f(hx, hy);
  let ca = cos(i.b.x);
  let sa = sin(i.b.x);
  let world = i.a.xy + vec2f(local.x * ca - local.y * sa, local.x * sa + local.y * ca);
  var o: VOut;
  o.pos = vec4f((world - F.cam) * F.scale, 0.0, 1.0);
  o.local = local;
  o.world = world;
  o.hs = vec2f(hx, hy);
  o.mode = i.b.y;
  o.lit = i.b.z;
  o.col = i.col;
  o.prm = i.prm;
  return o;
}

@fragment fn instFs(v: VOut) -> @location(0) vec4f {
  let m = u32(v.mode + 0.5);
  if (m == 0u) {
    // Walls and doors: a crisp bright rim on the top edge, lit by the same light as the floor.
    let edge = min(v.hs.x - abs(v.local.x), v.hs.y - abs(v.local.y));
    let rim = 1.0 - smoothstep(0.0, 0.14, edge);
    let top = v.col.rgb * (0.7 + 0.5 * rim) + vec3f(0.05 * rim);
    let ev = eyeVis(v.world, 1.2);
    let l = lightSum(v.world, 1.2) + vec3f(F.amb);
    return vec4f(top * l * ev, v.col.a);
  }
  if (m == 1u) {
    // Actors: a dark body lit by light, plus a faint ambient so revealed players read in the dark.
    let r = length(v.local) / v.hs.x;
    let a = 1.0 - smoothstep(0.9, 1.0, r);
    let l = lightSum(v.world, 0.0);
    let rim = smoothstep(0.78, 0.92, r) * (1.0 - smoothstep(0.92, 1.0, r));
    let body = v.col.rgb * (0.35 + l) + v.prm.rgb * rim * 0.9;
    return vec4f(body * a, a * v.col.a);
  }
  if (m == 2u) {
    // Ripple: a crisp expanding ring, optionally jagged.
    let r = length(v.local);
    let ang = atan2(v.local.y, v.local.x);
    let rr = v.prm.x + v.prm.w * sin(ang * 7.0 + v.prm.y) + v.prm.w * 0.5 * sin(ang * 13.0 + v.prm.z);
    let d = abs(r - rr);
    let a = (1.0 - smoothstep(0.02, 0.09, d)) * v.prm.z * v.col.a;
    return vec4f(v.col.rgb * a, a);
  }
  if (m == 3u) {
    // Glow: radial falloff, additive.
    let r = length(v.local) / v.hs.x;
    let a = pow(max(0.0, 1.0 - r), 2.2) * v.prm.x * v.col.a;
    return vec4f(v.col.rgb * a, a);
  }
  if (m == 4u) {
    // Tracer: a thin bright line with a fade.
    let across = 1.0 - smoothstep(0.0, v.hs.y, abs(v.local.y));
    let along = 1.0 - smoothstep(v.hs.x * 0.9, v.hs.x, abs(v.local.x));
    let a = across * along * v.prm.x * v.col.a;
    return vec4f(v.col.rgb * a, a);
  }
  // Dot: a small disc (bulbs, bolts, mines), optionally lit.
  let r = length(v.local) / v.hs.x;
  let a = (1.0 - smoothstep(0.7, 1.0, r)) * v.col.a;
  let l = select(vec3f(1.0), lightSum(v.world, 0.0) + vec3f(0.2), v.lit > 0.5);
  return vec4f(v.col.rgb * l * a, a);
}

struct CompOut {
  @builtin(position) pos: vec4f,
}

@vertex fn compVs(@builtin(vertex_index) vi: u32) -> CompOut {
  let xy = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  var o: CompOut;
  o.pos = vec4f(xy * 2.0 - 1.0, 0.0, 1.0);
  return o;
}

@group(1) @binding(0) var scene: texture_2d<f32>;

@fragment fn compFs(@builtin(position) px: vec4f) -> @location(0) vec4f {
  var c = textureLoad(scene, vec2i(px.xy), 0).rgb;
  let uv = px.xy / F.res;
  let d = (uv - vec2f(0.5)) * vec2f(1.15, 1.0);
  let vig = 1.0 - 0.7 * smoothstep(0.25, 0.95, length(d));
  let g = (hash(px.xy + vec2f(F.time * 61.7, F.time * 13.1)) - 0.5) * 0.045;
  c = c * vig * vec3f(0.97, 0.99, 1.04) + vec3f(g);
  c = 1.0 - exp(-c * 1.25);
  return vec4f(max(c, vec3f(0.0)), 1.0);
}
`
