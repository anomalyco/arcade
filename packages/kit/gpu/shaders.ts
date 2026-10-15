import { MAX_LIGHTS, MAX_OCCLUDERS, POLAR_RAYS } from "./limits"
import type { PostFinishOptions } from "./look-shaders"
import { motionGather, motionOutput } from "./motion"
import { vehicleSprites } from "@arcade/kit/vehicle/sprites"

/** Frame uniform layout, in floats. Keep in step with Game.build. */
export const FRAME_FLOATS = 16 + 4 * 8

export const common = /* wgsl */ `
const MAX_LIGHTS: u32 = ${MAX_LIGHTS}u;
const RAYS: u32 = ${POLAR_RAYS}u;
const TAU: f32 = 6.2831853;
const PI: f32 = 3.1415927;
/** Visual brightness of lights relative to the ambient. */
const GAIN: f32 = 5.0;
const FAR: f32 = 1e9;

struct Frame {
  viewProj: mat4x4f,
  cam: vec4f,        // eye position xyz, time
  screen: vec4f,     // width, height, light count, map light count
  eye: vec4f,        // local player plan x, plan y, cutaway on (0/1), cutaway radius (NDC)
  ambient: vec4f,    // sky rgb, moonlight strength
  focus: vec4f,      // local player clip x, y, world height of the cut, first monitor light
  monitorBounds: vec4f, // plan min x/y, max x/y enclosing every direct monitor pool
  map: vec4f,        // 1 / map width, 1 / map height, map width, map height
  effects: vec4f,    // multi-bounce AO strength, Look bitmask, office map, reserved
}

struct Light {
  pos: vec4f,    // plan x, height, plan y, radius
  color: vec4f,  // rgb, current power
  cone: vec4f,   // plan dir x, plan dir y, cos half-angle, has cone
  extra: vec4f,  // first occluder, occluder count, fixture size (shadow softness), map light id or -1
}

@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<storage, read> lights: array<Light>;
@group(0) @binding(2) var<storage, read> polar: array<vec4f>;

fn hash2(p: vec2f) -> f32 {
  let q = fract(p * vec2f(0.1031, 0.1030));
  let r = q + dot(q, q.yx + 33.33);
  return fract((r.x + r.y) * r.x);
}

fn noise2(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + vec2f(1.0, 0.0)), u.x), mix(hash2(i + vec2f(0.0, 1.0)), hash2(i + vec2f(1.0, 1.0)), u.x), u.y);
}

fn fbm(p: vec2f) -> f32 {
  return noise2(p) * 0.5 + noise2(p * 2.03 + 7.1) * 0.3 + noise2(p * 4.1 + 3.7) * 0.2;
}
`

/**
 * Polar shadow map. For each culled light and each of RAYS angles: the distance to the first occluder at least as tall
 * as the light (it shadows everything beyond), and the two nearest lower occluders as (enter, exit, height), whose
 * shadows end where the line from the light clears their top. People are round casters.
 */
export const polarShader = /* wgsl */ `
${common}
@group(0) @binding(3) var<storage, read> occluders: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> polarOut: array<vec4f>;

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
  let slot = idx / RAYS;
  if (slot >= u32(F.screen.z)) { return; }
  let ang = (f32(idx % RAYS) + 0.5) / f32(RAYS) * TAU;
  let dir = vec2f(cos(ang), sin(ang));
  let L = lights[slot];
  let o = L.pos.xz;
  let hl = L.pos.y;
  var full = L.pos.w + 0.5;
  var a = vec3f(FAR, FAR, 0.0);
  var b = vec3f(FAR, FAR, 0.0);
  let first = u32(L.extra.x);
  let n = min(u32(L.extra.y), ${MAX_OCCLUDERS}u - first);
  for (var i = 0u; i < n; i++) {
    let r = occluders[(first + i) * 2u];
    let m = occluders[(first + i) * 2u + 1u];
    var t0 = 0.0;
    var t1 = 1e6;
    var hit = false;
    var h = m.x;
    if (m.y > 0.5) {
      // Round caster (a person): its shadow is long but finite even under low lamps.
      let oc = o - r.xy;
      let bq = dot(oc, dir);
      let c = dot(oc, oc) - r.z * r.z;
      let disc = bq * bq - c;
      if (disc > 0.0) {
        let s = sqrt(disc);
        t0 = max(-bq - s, 0.0);
        t1 = -bq + s;
        hit = t1 > 0.0 && t0 < full;
      }
      h = min(h, hl - 0.25);
    } else {
      hit = slab(o.x, dir.x, r.x, r.z, &t0, &t1) && slab(o.y, dir.y, r.y, r.w, &t0, &t1) && t0 < full;
      t1 = max(t1, t0);
    }
    if (!hit) { continue; }
    if (h >= hl - 0.02) {
      full = min(full, t0);
    } else if (t0 < a.x) {
      if (b.x < FAR) { b = vec3f(min(b.x, a.x), max(b.y, a.y), max(b.z, a.z)); } else { b = a; }
      a = vec3f(t0, t1, h);
    } else if (t0 < b.x) {
      b = vec3f(t0, t1, h);
    } else {
      b = vec3f(min(b.x, t0), max(b.y, t1), max(b.z, h));
    }
  }
  polarOut[idx * 2u] = vec4f(full, a);
  polarOut[idx * 2u + 1u] = vec4f(b, 0.0);
}
`

/**
 * Materials (vertex attribute): 0 lit, 1 floor (aux = kind), 2 lamp (aux = map light id), 3 glow (aux = strength),
 * 4 wall (cut away near you), 5 tape, 6 glass, 7 city, 8 accent (takes the instance tint), 9 wall cap, 10 shiny,
 * 11 light haze (aux = map light id).
 */
export type SceneHooks = { declarations?: string; vertex?: string; surface?: string; directional?: string; ao?: string; bounce?: string; material?: string; postLightMaterial?: string; cutaway?: string; solidCutaway?: string; fragmentStart?: string; smoothShadows?: boolean; diagnostics?: string; ambient?: string; lightLeak?: string; lightMask?: string; shadowTaps?: 5 | 9; lightAttenuation?: string; lightAccumulate?: string; wallDirectScale?: string; mapUv?: string }
export const makeSceneShader = (hooks: SceneHooks = {}, looks = false, motion = false) => /* wgsl */ `
${common}
${motion ? motionOutput : ""}
${looks ? `// Office material changes stay off downtown roads, buildings and vehicle lighting.
fn look(bit: u32) -> bool { return F.effects.z > 0.5 && (u32(F.effects.y) & bit) != 0u; }` : ""}
@group(0) @binding(3) var<storage, read> lampPower: array<f32>;
@group(0) @binding(4) var floorTex: texture_2d<f32>;
@group(0) @binding(5) var floorSamp: sampler;
@group(0) @binding(6) var bounceTex: texture_2d<f32>;
@group(0) @binding(8) var moonTex: texture_2d<f32>;
${hooks.declarations ?? ""}

struct VIn {
  @location(0) pos: vec3f,
  @location(1) normal: vec4f,
  @location(2) color: vec4f,
  @location(3) matAux: vec2f,
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
  ${hooks.vertex ? "@location(4) aux: f32," : "@location(4) @interpolate(flat) aux: f32,"}
  @location(5) @interpolate(flat) extra: vec4f,
  ${motion ? "@location(6) previous: vec4f," : ""}
}

@vertex fn vsStatic(v: VIn) -> VOut {
  var o: VOut;
  o.world = v.pos;
  o.normal = v.normal.xyz;
  if (${hooks.material ? "v.matAux.x > 12.5 && v.matAux.x < 13.5" : "v.matAux.x > 12.5"}) {
    // Dust mote: drift slowly around its anchor, then expand the quad toward the camera.
    let ph = v.normal.z * 40.0;
    let t = F.cam.w;
    let drift = vec3f(sin(t * 0.21 + ph) + 0.4 * sin(t * 0.53 + ph * 1.7), 0.6 * sin(t * 0.17 + ph * 2.3), cos(t * 0.19 + ph * 0.7) + 0.4 * sin(t * 0.47 + ph)) * 0.22;
    let c = v.pos + drift;
    let toCam = normalize(F.cam.xyz - c);
    let right = normalize(cross(vec3f(0.0, 1.0, 0.0), toCam));
    let up = cross(toCam, right);
    let size = 0.012 + 0.012 * fract(ph * 3.7);
    o.world = c + (right * v.normal.x + up * v.normal.y) * size;
    // Corner in the normal slot for the fragment's round falloff; phase rides in z.
    o.normal = vec3f(v.normal.xy, ph);
  }
  ${hooks.vertex ?? ""}
  o.pos = F.viewProj * vec4f(o.world, 1.0);
  o.color = pow(v.color.rgb, vec3f(2.2));
  o.mat = v.matAux.x;
  o.aux = v.matAux.y;
  o.extra = vec4f(0.0, 0.0, 1.0, 0.0);
  ${motion ? "o.previous = M.previous * vec4f(o.world, 1.0);" : ""}
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

@vertex fn vsInst(v: VIn, inst: Inst${motion ? ", @location(8) oldPos: vec4f, @location(9) oldTint: vec4f, @location(10) oldExtra: vec4f" : ""}) -> VOut {
  var o: VOut;
  o.world = instWorld(v.pos, inst);
  o.pos = F.viewProj * vec4f(o.world, 1.0);
  o.normal = instNormal(v.normal.xyz, inst);
  let accent = v.matAux.x > 7.5 && v.matAux.x < 8.5;
  // Accent parts glow in the player's colour so everyone reads in the dark.
  o.color = select(pow(v.color.rgb, vec3f(2.2)), inst.tint.rgb, accent);
  o.mat = select(v.matAux.x, 3.0, accent);
  o.aux = select(v.matAux.y, 0.85, accent);
  // Robes use the same team tint as accents, but remain matte and receive actor lighting.
  if (v.matAux.x > 13.5 && v.matAux.x < 14.5) {
    o.color = inst.tint.rgb * pow(v.color.rgb, vec3f(2.2));
    o.mat = 12.0;
  }
  o.extra = inst.extra;
  ${motion ? "o.previous = M.previous * vec4f(instWorld(v.pos, Inst(oldPos, oldTint, oldExtra)), 1.0);" : ""}
  return o;
}

fn bayer4x4(frag: vec4f) -> f32 {
  let p = vec2u(frag.xy) % 4u;
  let m = array<f32, 16>(0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
  return (m[p.y * 4u + p.x] + 0.5) / 16.0;
}

fn cutawayBubble(world: vec3f, frag: vec4f, minHeight: f32, southOnly: bool, opacity: f32) -> bool {
  if (F.eye.z < 0.5 || world.y < minHeight || opacity <= 0.001) { return false; }
  if (southOnly && world.z < F.eye.y + 0.25) { return false; }
  let ndc = vec2f(frag.x / F.screen.x * 2.0 - 1.0, 1.0 - frag.y / F.screen.y * 2.0);
  let dv = (ndc - F.focus.xy) * vec2f(F.screen.x / F.screen.y, 1.0);
  let r = length(dv) / F.eye.w;
  if (r > 1.0) { return false; }
  return bayer4x4(frag) < smoothstep(1.0, 0.6, r) * opacity;
}

fn cutaway(world: vec3f, frag: vec4f) -> bool {
  return cutawayBubble(world, frag, F.focus.z, F.eye.z <= 1.001, 0.85);
}

/** Shadow of one lower occluder (enter t0, exit t1, height h) on a point at distance d and height y. */
fn partialShadow(t0: f32, t1: f32, h: f32, d: f32, y: f32, hl: f32, size: f32) -> f32 {
  if (t0 >= FAR || y >= h - 0.03 || d <= t0) { return 1.0; }
  // Lift the light a little for low casters so partitions and furniture throw short, readable shadows.
  let lift = hl + ${looks ? "select(0.6, 0.12, look(256u))" : "0.6"};
  let end = min(t1 * (lift - y) / max(lift - h, 0.05), t1 + 6.0);
  let e0 = 0.015 + size * 0.04;
  let e1 = 0.03 + size * 0.5 * (end - t1) / max(t1, 0.3);
  let s = smoothstep(t0 - e0, t0 + e0, d) * (1.0 - smoothstep(end - e1, end + e1, d));
  return 1.0 - s * 0.82;
}

fn tapVis(base: u32, fi: f32, d: f32, y: f32, hl: f32, size: f32) -> f32 {
  let i = u32(i32(round(fi)) + i32(RAYS) * 4) % RAYS;
  let p0 = polar[(base + i) * 2u];
  let full = p0.x;
  let ef = 0.03 + size * 0.45 * max(d - full, 0.0) / max(full, 0.3);
  if (d >= full + ef) { return 0.0; }
  var v = 1.0 - smoothstep(full - 0.02, full + ef, d);
  if (d <= p0.y - 0.04) { return v; }
  let p1 = polar[(base + i) * 2u + 1u];
  v *= partialShadow(p0.y, p0.z, p0.w, d, y, hl, size);
  v *= partialShadow(p1.x, p1.y, p1.z, d, y, hl, size);
  return v;
}

/** Soft visibility of plan point p at height y from a light slot. */
fn shadowAt(slot: u32, lp: vec2f, hl: f32, size: f32, p: vec2f, y: f32) -> f32 {
  let dv = p - lp;
  let d = length(dv);
  if (d < 0.05) { return 1.0; }
  var a = atan2(dv.y, dv.x);
  if (a < 0.0) { a += TAU; }
  let f = a / TAU * f32(RAYS) - 0.5;
  let base = slot * RAYS;
  let stepR = max(size * 0.22 / max(d, 0.4) * f32(RAYS) / TAU, 0.35);
  ${looks || hooks.smoothShadows ? `${hooks.smoothShadows && hooks.shadowTaps === 5 ? `{
    var sum = 0.0;
    let step = max(stepR * 1.35, 0.65);
    for (var k = -1; k <= 1; k++) {
      let ray = f + f32(k) * step;
      let lo = floor(ray);
      let a = tapVis(base, lo, d, y, hl, size);
      let b = tapVis(base, lo + 1.0, d, y, hl, size);
      let w = select(0.7557837, 1.0, k == 0);
      sum += mix(a, b, fract(ray)) * w;
    }
    return sum * 0.3981576;
  }` : `if ((u32(F.effects.y) & 512u) != 0u) {
    // Interpolate visibility, not blocker distance: interpolating distances leaks across silhouettes.
    // A denser angular kernel removes the five repeated hard silhouettes of the old sparse PCF.
    var sum = 0.0;
    var weights = 0.0;
    // World-anchored sub-stratum rotation breaks coherent PCF contours without time-varying noise.
    let phase = hash2(floor(p * 64.0)) - 0.5;
    let step = max(stepR * 0.5, 0.5);
    var prevLo = -1e9;
    var prevVis = 0.0;
    for (var k = -4; k <= 4; k++) {
      let ray = f + (f32(k) + phase) * step;
      let lo = floor(ray);
      let a = select(tapVis(base, lo, d, y, hl, size), prevVis, lo == prevLo);
      let b = tapVis(base, lo + 1.0, d, y, hl, size);
      prevLo = lo + 1.0;
      prevVis = b;
      let w = exp(-f32(k * k) * 0.16);
      sum += mix(a, b, fract(ray)) * w;
      weights += w;
    }
    return sum / weights;
  }`}` : ""}
  ${hooks.smoothShadows && hooks.shadowTaps === 5 ? "" : `var acc = 0.0;
  for (var k = -2; k <= 2; k++) {
    let w = select(select(0.15, 0.2, abs(k) == 1), 0.3, k == 0);
    acc += tapVis(base, f + f32(k) * stepR, d, y, hl, size) * w;
  }
  return acc;`}
}

struct Lit { diff: vec3f, spec: vec3f }

/**
 * Light reaching a surface from the culled lights: windowed inverse-square falloff from the fixture's 3D position,
 * a soft cone, the polar shadow map, wrapped diffuse and an optional glossy highlight. A little of each light's
 * colour leaks past shadows as bounce.
 */
fn lightSum(world: vec3f, n: vec3f, V: vec3f, shin: f32, wrap: f32) -> Lit {
  var out: Lit;
  out.diff = vec3f(0.0);
  out.spec = vec3f(0.0);
  var count = u32(F.screen.z);
  // Outside the union's conservative bounds, skip the entire shadowless monitor suffix.
  if (u32(F.focus.w) < count && (any(world.xz < F.monitorBounds.xy) || any(world.xz > F.monitorBounds.zw))) {
    count = u32(F.focus.w);
  }
  let plan = world.xz + n.xz * 0.04;
  let firstLight = select(0u, 1u, count > 0u && lights[0].color.w <= 0.001);
  for (var i = firstLight; i < count; i++) {
    // Most pixels are outside the small monitor pools. Reject using just the position/radius cache line.
    let pos = lights[i].pos;
    let lp = pos.xz;
    let r = pos.w;
    let dv = world.xz - lp;
    let dPlan2 = dot(dv, dv);
    if (dPlan2 >= r * r) { continue; }
    let L = lights[i];
    let power = L.color.w;
    ${hooks.lightMask ?? ""}
    if (power <= 0.001) { continue; }
    let dPlan = sqrt(dPlan2);
    let hl = L.pos.y;
    let l3 = vec3f(lp.x, hl, lp.y) - world;
    let d3 = max(length(l3), 0.05);
    let ldir = l3 / d3;
    let x = dPlan / r;
    var win = 1.0 - x * x;
    win *= win;
    // Surfaces right next to a fixture (wall tops, desks under a panel) never get hotter than the floor below it.
    ${hooks.lightAttenuation ?? `let dn = max(d3, max(hl, 1.25));
    var att = power * win * (0.1 + 2.6 / (1.0 + dn * dn * 0.3));`}
    // cone.w 2 marks a spotlight whose cone the game's lightAttenuation hook already shaped.
    if (L.cone.w > 0.5 && L.cone.w < 1.5 && dPlan > 0.001) {
      let c = dot(dv / dPlan, L.cone.xy);
      let t = clamp((c - L.cone.z) / 0.25, 0.0, 1.0);
      att *= t * t * (3.0 - 2.0 * t);
    }
    if (att <= 0.0005) { continue; }
    let ndl = dot(n, ldir);
    let diffuse = max((ndl + wrap) / (1.0 + wrap), 0.0);
    // Tops of furniture and partitions sit inside their own footprint: test the point nudged toward the light.
    var sp = plan;
    if (n.y > 0.5 && world.y > 0.15) { sp = world.xz - dv / max(dPlan, 1e-4) * min(0.12, dPlan); }
    var vis = 1.0;
    if (L.extra.y > 0.5) { vis = shadowAt(i, lp, hl, L.extra.z, sp, world.y); }
    out.diff += L.color.rgb * att * (diffuse * vis + ${hooks.lightLeak ?? "0.035"});
    ${hooks.lightAccumulate ?? ""}
    if (shin > 0.0) {
      let h = normalize(ldir + V);
      let s = pow(max(dot(n, h), 0.0), shin) * (shin + 2.0) * 0.004;
      out.spec += L.color.rgb * att * s * vis;
      if (n.y > 0.9) {
        // Mirror image of the fixture on a glossy floor: where the eye's reflection sees the lamp, stretched toward
        // the viewer like a polished, slightly wet surface.
        let e = F.cam.xyz;
        let k = hl / (hl + e.y);
        let pm = lp + (e.xz - lp) * k;
        let toEye = normalize(e.xz - pm + vec2f(1e-4));
        let q = world.xz - pm;
        let along = dot(q, toEye);
        let across = dot(q, vec2f(-toEye.y, toEye.x));
        let sz = 0.03 + L.extra.z * 0.3;
        let r2 = across * across / (sz * sz) + along * along / (sz * sz * 25.0);
        out.spec += L.color.rgb * power * exp(-r2) * shin * 0.0016 * vis;
      }
    }
  }
  return out;
}

/** Cheap unshadowed glow from nearby lights, for wall caps above the fixtures. */
fn spill(world: vec3f) -> vec3f {
  var acc = vec3f(0.0);
  let count = u32(F.screen.z);
  for (var i = 0u; i < count; i++) {
    let L = lights[i];
    let d = length(world.xz - L.pos.xz);
    let r = L.pos.w * 0.7;
    if (d >= r) { continue; }
    let x = 1.0 - d / r;
    acc += L.color.rgb * L.color.w * x * x;
  }
  return acc;
}

/** Baked floor data: r = ambient occlusion from walls and furniture, g = moonlight through the windows. */
fn floorData(p: vec2f) -> vec2f {
  let uv = ${hooks.mapUv ?? "p * F.map.xy"};
  return vec2f(textureSampleLevel(floorTex, floorSamp, uv, 0.0).r,
    textureSampleLevel(moonTex, floorSamp, uv, 0.0).r);
}

/** Baked indirect light at a plan point, nudged off walls along the normal. */
fn bounceAt(p: vec2f) -> vec3f {
  let uv = ${hooks.mapUv ?? "p * F.map.xy"};
  let b = textureSampleLevel(bounceTex, floorSamp, uv, 0.0);
  // Texels inside walls are black; renormalise by coverage so wall faces don't sample darkness.
  let c = b.rgb / max(b.a, 0.25);
  return c * c * 2.0;
}

fn ambientAt(n: vec3f) -> vec3f {
  let sky = F.ambient.rgb;
  return mix(sky * 0.35, sky, n.y * 0.5 + 0.5);
}

fn tileEdge(g: vec2f, w: f32) -> f32 {
  let e = min(min(g.x, 1.0 - g.x), min(g.y, 1.0 - g.y));
  return smoothstep(0.0, w, e);
}

/** Floor albedo and glossiness (shininess, strength) by kind. */
fn floorPattern(kind: i32, p: vec2f, base: vec3f, gloss: ptr<function, vec2f>) -> vec3f {
  var c = base;
  if (kind == 0) {
    // Carpet tiles, alternating pile direction, with fine loop texture.
    let cell = floor(p / 0.6);
    let g = fract(p / 0.6);
    let flip = (i32(cell.x) + i32(cell.y)) & 1;
    let q = select(p.x, p.y, flip == 1);
    let stripes = 0.5 + 0.5 * sin(q * 70.0 + noise2(p * 3.0) * 2.0);
    c *= 0.86 + ${looks ? "select(0.1, 0.16, look(32u))" : "0.1"} * stripes + ${looks ? "select(0.1, 0.18, look(32u))" : "0.1"} * (hash2(cell) - 0.5) + 0.1 * (noise2(p * 23.0) - 0.5);
    c *= mix(0.82, 1.0, tileEdge(g, 0.02));
    *gloss = vec2f(0.0, 0.0);
  } else if (kind == 1) {
    // Linoleum tiles: mottled, slightly different per tile, thin grout, glossy.
    let cell = floor(p / 0.8);
    let g = fract(p / 0.8);
    c *= 0.9 + ${looks ? "select(0.14, 0.3, look(32u))" : "0.14"} * (hash2(cell * 1.7) - 0.5);
    c *= 0.85 + 0.3 * fbm(p * 5.0);
    c *= 1.0 - 0.08 * smoothstep(0.55, 0.8, noise2(p * 0.7 + 4.0));
    c *= mix(0.62, 1.0, tileEdge(g, 0.012));
    *gloss = vec2f(70.0, 0.55);
    ${looks ? "if (look(128u)) { *gloss = vec2f(95.0, 0.85); }" : ""}
  } else if (kind == 2) {
    let row = floor(p.y / 0.2);
    let plank = floor((p.x + hash2(vec2f(row, 1.0)) * 2.0) / 1.4);
    c *= 0.78 + 0.32 * hash2(vec2f(row, plank));
    c *= 0.9 + 0.2 * noise2(vec2f(p.x * 1.5, p.y * 30.0) + plank);
    c *= 1.0 - 0.35 * (1.0 - smoothstep(0.0, 0.05, fract(p.y / 0.2)));
    c *= 1.0 - 0.35 * (1.0 - smoothstep(0.0, 0.01, abs(fract((p.x + hash2(vec2f(row, 1.0)) * 2.0) / 1.4) - 0.0)));
    *gloss = vec2f(30.0, 0.3);
  } else if (kind == 3) {
    c *= 0.8 + 0.3 * fbm(p * 0.9) + 0.08 * noise2(p * 11.0);
    c *= 1.0 - 0.25 * smoothstep(0.62, 0.75, fbm(p * 0.35 + 9.0));
    let crack = abs(noise2(p * 1.2) - 0.5);
    c *= 1.0 - 0.4 * (1.0 - smoothstep(0.0, 0.012, crack)) * step(0.5, noise2(p * 0.3));
    *gloss = vec2f(10.0, 0.08);
  } else if (kind == 4) {
    // Raised-floor panels with perforations.
    let g = fract(p / 0.6);
    let h = fract(p / 0.05);
    let hole = 1.0 - smoothstep(0.18, 0.28, length(h - 0.5));
    let inner = step(0.08, g.x) * step(g.x, 0.92) * step(0.08, g.y) * step(g.y, 0.92);
    c *= mix(1.0, 0.35, hole * inner);
    c *= mix(0.55, 1.05, tileEdge(g, 0.02));
    *gloss = vec2f(40.0, 0.35);
  } else if (kind == 5 || kind == 9) {
    // Asphalt after rain: fine aggregate, darker patches of repair, thin cracks, and puddles that mirror the lights.
    c *= 0.88 + 0.16 * noise2(p * 31.0) + 0.06 * (fbm(p * 0.6) - 0.5);
    let crack = abs(noise2(p * 0.9 + 5.0) - 0.5);
    c *= 1.0 - 0.3 * (1.0 - smoothstep(0.0, 0.01, crack)) * step(0.55, noise2(p * 0.25 + 2.0));
    // Puddles: crisp-edged, slightly darker, mirror-glossy.
    let wet = smoothstep(0.52, 0.56, fbm(p * 0.32 + vec2f(3.0, 7.0)) + 0.05 * noise2(p * 5.0));
    let puddle = select(1.0, 0.6, kind == 9) * wet;
    c *= 1.0 - 0.2 * puddle;
    // The whole road is damp: a soft sheen everywhere, mirror-sharp in the puddles.
    *gloss = mix(vec2f(45.0, 0.55), vec2f(160.0, 1.6), puddle);
  } else if (kind == 6) {
    // Sidewalk: square concrete slabs, each a slightly different tone, with dark joints. Damp.
    let g = fract(p / 1.2);
    let cell = floor(p / 1.2);
    c *= 0.88 + 0.16 * (hash2(cell * 2.3) - 0.5) + 0.12 * (fbm(p * 2.5) - 0.5);
    c *= mix(0.6, 1.0, tileEdge(g, 0.018));
    *gloss = vec2f(30.0, 0.32 + 0.3 * smoothstep(0.55, 0.7, fbm(p * 0.35 + 11.0)));
  } else if (kind == 7) {
    // Plaza: big stone tiles laid in a two-tone grid with a border every few tiles, polished.
    let g = fract(p / 1.5);
    let cell = floor(p / 1.5);
    let alt = f32((i32(cell.x) + i32(cell.y)) & 1);
    c *= mix(0.86, 1.06, alt) + 0.1 * (hash2(cell) - 0.5) + 0.08 * (fbm(p * 1.7) - 0.5);
    c *= mix(0.68, 1.0, tileEdge(g, 0.012));
    *gloss = vec2f(60.0, 0.55);
  } else if (kind == 10) {
    // Staggered, broad flagstones: one shader branch, no extra floor geometry.
    let row = floor(p.y / 0.85);
    let q = vec2f(p.x / 1.25 + (row % 2.0) * 0.5, p.y / 0.85);
    let cell = floor(q);
    c *= 0.8 + 0.28 * hash2(cell) + 0.1 * noise2(p * 18.0);
    c *= mix(0.32, 1.0, tileEdge(fract(q), 0.023));
    *gloss = vec2f(24.0, 0.15);
  } else if (kind == 8) {
    // Grass: dark blades, clumps and bare patches.
    c *= 0.78 + 0.35 * noise2(p * 9.0) + 0.2 * (fbm(p * 0.8) - 0.5);
    c = mix(c, c * vec3f(1.2, 1.0, 0.75), smoothstep(0.62, 0.8, fbm(p * 0.4 + 5.0)) * 0.6);
    c *= 0.9 + 0.2 * step(0.5, hash2(floor(p * 18.0)));
    *gloss = vec2f(0.0, 0.0);
  }
  return c;
}

/** The city far below the windows: a dark grid of streets and lit windows. */
fn city(p: vec2f) -> vec3f {
  ${looks ? `if (look(64u)) {
    // Analytically softened distant window footprints: defocus only the city material,
    // without a fullscreen depth target, blur taps, or bleeding onto the play floor.
    let block = floor(p / 14.0);
    let f = fract(p / 14.0);
    let edge = min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y));
    let roof = smoothstep(0.04, 0.075, edge);
    let height = hash2(block);
    var c = vec3f(0.003, 0.011, 0.022) * (0.55 + height * 0.9) * roof;
    c *= 0.65 + 0.35 * smoothstep(0.06, 0.3, f.x);
    c += vec3f(0.006, 0.011, 0.02) * (1.0 - roof);
    let verge = exp(-pow((edge - 0.042) * 180.0, 2.0));
    c += vec3f(0.025, 0.011, 0.003) * verge * (0.3 + 0.7 * noise2(p * 0.7));
    let cell = floor(p / 0.65);
    let q = abs(fract(p / 0.65) - 0.5);
    let light = hash2(cell + block * 7.0);
    let shape = (1.0 - smoothstep(0.12, 0.4, q.x)) * (1.0 - smoothstep(0.16, 0.43, q.y));
    let colour = mix(vec3f(1.0, 0.38, 0.09), vec3f(0.28, 0.62, 0.8), step(0.87, hash2(cell * 1.7)));
    c += colour * shape * step(0.91, light) * roof * (0.12 + 0.32 * hash2(cell * 2.3));
    return c;
  }` : ""}
  let blk = floor(p / 14.0);
  let f = fract(p / 14.0);
  let edge = min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y));
  let street = 1.0 - smoothstep(0.03, 0.07, edge);
  // Rooftops of different heights read as slightly different navy blocks; streets carry faint sodium light.
  var c = vec3f(0.006, 0.008, 0.016) * (0.6 + 0.8 * hash2(blk)) * (1.0 - street);
  c += vec3f(0.9, 0.5, 0.18) * street * 0.012;
  let w = floor(p / 0.3);
  let lit = step(0.975, hash2(w + blk * 7.0)) * (1.0 - street) * step(0.08, edge);
  c += mix(vec3f(1.0, 0.75, 0.4), vec3f(0.55, 0.75, 1.0), hash2(w * 1.7)) * lit * 0.05;
  // A red aircraft light on some roofs.
  let rc = fract(p / 14.0) - 0.5;
  c += vec3f(1.0, 0.1, 0.05) * step(0.8, hash2(blk + 3.0)) * (1.0 - smoothstep(0.0, 0.012, length(rc))) * (0.5 + 0.5 * sin(F.cam.w * 2.0 + hash2(blk) * 6.0));
  return c;
}

fn lampK(aux: f32) -> f32 {
  return lampPower[u32(aux)];
}

fn shadeScene(o: VOut) -> vec4f {
  let mat = i32(round(o.mat));
  ${hooks.postLightMaterial ? "" : `if (mat == 13) {
    let r = length(o.normal.xy);
    let k = lampK(o.aux);
    let tw = 0.55 + 0.45 * sin(F.cam.w * 1.3 + o.normal.z * 5.0);
    let a = (1.0 - smoothstep(0.2, 1.0, r)) * k * tw * 1.6;
    return vec4f(o.color * a, 0.0);
  }`}
  var n = normalize(o.normal);
  let V = normalize(F.cam.xyz - o.world);
  var col: vec3f;
  var alpha = 1.0;
  ${hooks.postLightMaterial ? "" : `if (mat == 7) {
    return vec4f(city(o.world.xz), 1.0);
  }
  if (mat == 11) {
    // Haze under a fixture: denser near the lamp and where you look through more of the cone.
    let k = lampK(o.aux);
    let thick = pow(abs(dot(n, V)), 1.6);
    let fall = smoothstep(-0.2, 2.6, o.world.y) * (1.0 - smoothstep(2.0, 2.7, o.world.y) * 0.5);
    let a = k * thick * fall * ${looks ? "select(0.11, 0.055, look(2u))" : "0.11"};
    return vec4f(o.color * a, 0.0);
  }`}
  if (mat == 2) {
    // Fixture tied to a map light: bright when on, near-dark while it stutters.
    let k = lampK(o.aux);
    col = o.color * (0.05 + 3.6 * k);
    ${looks ? `if (look(2u)) {
      // Warm the cool tube diffusers; red signs retain a red rather than magenta glow.
      if (o.color.b > o.color.r && o.color.r > 0.35) { col *= vec3f(1.35, 1.04, 0.65); }
      if (o.color.r > o.color.g * 4.0 && o.color.b > o.color.g * 2.0) { col *= vec3f(1.0, 0.65, 0.22); }
    }` : ""}
  ${hooks.postLightMaterial ? "" : `} else if (mat == 3) {
    // aux >= 10 blinks, with its phase in the fraction.
    var k = o.aux;
    if (k >= 10.0) {
      let ph = fract(k) * 37.0;
      k = 3.0 * step(0.35, fract(F.cam.w * (0.6 + fract(ph) * 1.8) + ph));
    }
    col = o.color * k;
  } else if (mat == 9) {
    // Wall caps: the night sky and a cool rim on the bevels keep the plan readable in the dark.
    let rim = 1.0 - n.y;
    let sp = spill(o.world);
    col = o.color * (vec3f(0.5, 0.55, 0.7) + mix(vec3f(dot(sp, vec3f(0.33))), sp, 0.5) * 0.25) + vec3f(0.02, 0.03, 0.06) * rim;
    ${looks ? "if (look(16u)) { col = col * vec3f(0.65, 0.9, 1.04) + vec3f(0.018, 0.07, 0.13) * rim; }" : ""}`}
  } else if (mat == 6) {
    col = vec3f(0.006, 0.01, 0.02) + spill(o.world) * 0.12 + vec3f(0.03, 0.05, 0.09) * pow(1.0 - abs(n.y), 3.0);
    alpha = 0.22;
  } else {
    var albedo = o.color;
    ${looks ? "if (mat == 4 && look(4u)) { albedo *= vec3f(1.3, 1.13, 0.87); }" : ""}
    var gloss = vec2f(0.0);
    ${hooks.material ?? ""}
    ${hooks.postLightMaterial ? "if (mat == 10) { gloss = vec2f(50.0, 0.5); }" : `if (mat == 1 || mat == 5) {
      if (mat == 1) { albedo = floorPattern(i32(round(o.aux)), o.world.xz, albedo, &gloss); }
      else { albedo *= 0.85 + 0.25 * noise2(o.world.xz * 8.0); gloss = vec2f(20.0, 0.2); }
    } else if (mat == 10) {
      gloss = vec2f(50.0, 0.5);
    }`}
    let floorish = n.y > 0.5 && o.world.y < 0.15;
    let wrap = select(0.35, 0.0, floorish);
    let lit = lightSum(o.world, n, V, gloss.x, wrap);
    ${hooks.postLightMaterial ?? ""}
    let fd = floorData(o.world.xz);
    var amb = ${hooks.ambient ?? "ambientAt(n)"};
    amb += ${hooks.bounce ?? "bounceAt(o.world.xz + n.xz * 0.3) * 0.32"};
    // Occlusion from the baked map, strongest at floor level, plus a vertical gradient down walls and furniture.
    let low = 1.0 - smoothstep(0.0, 0.9, o.world.y);
    let ao = mix(1.0, 1.0 - fd.r * 0.85, low);
    // Multi-bounce AO: coloured surfaces return some occluded ambient light instead of turning black.
    let a = 2.0404 * albedo - vec3f(0.3324);
    let b = -4.7951 * albedo + vec3f(0.6417);
    let c = 2.7552 * albedo + vec3f(0.6903);
    amb *= mix(vec3f(ao), max(vec3f(ao), ((ao * a + b) * ao + c) * ao), ${hooks.ao ?? "F.effects.x"});
    var direct = lit.diff * GAIN * mix(1.0, ao, 0.5);
    if (abs(n.y) < 0.5 && mat != 12) {
      let base = mix(0.55, 1.0, smoothstep(0.0, 0.8, o.world.y));
      amb *= base;
      // Walls face the fixtures square on; keep them a step below the floor pools so rooms don't blow out.
      direct *= ${hooks.wallDirectScale ?? "mix(0.22, 0.38, smoothstep(0.0, 1.5, o.world.y))"};
      ${looks ? "if (mat == 4 && look(4u)) { direct *= 1.4; }" : ""}
    }
    // Moonlight through the windows, on the floor and low surfaces.
    ${looks ? "var" : "let"} moon = ${hooks.directional ?? "vec3f(0.62, 0.78, 1.25) * fd.g * F.ambient.w * low * max(n.y, 0.2)"};
    ${looks ? "if (look(2u)) { moon *= 0.68; }" : ""}
    col = albedo * (amb + direct + moon) + lit.spec * GAIN * gloss.y * mix(vec3f(1.0), albedo * 3.0, 0.25);
    ${hooks.diagnostics ? `let contribution = i32(${hooks.diagnostics});
    if (contribution == 1) { return vec4f(albedo, 1.0); }
    if (contribution == 2) { return vec4f(albedo * direct, 1.0); }
    if (contribution == 3) { return vec4f(albedo * (amb + moon), 1.0); }
    if (contribution == 4) { return vec4f(lit.spec * GAIN * gloss.y * mix(vec3f(1.0), albedo * 3.0, 0.25), 1.0); }
    if (contribution == 6) { return vec4f(col, 1.0); }` : ""}
    ${looks ? `if (look(8u)) {
      var contact = fd.r * low;
      if (mat == 4) {
        let outside = floorData(o.world.xz + n.xz * 0.4).r;
        contact = max(contact * 0.65, outside * (0.25 + 0.75 * (1.0 - smoothstep(0.0, 1.5, o.world.y))));
      }
      col *= 1.0 - min(0.72, contact * 0.85);
    }` : ""}
    if (mat == 12) {
      // Soldiers: a cool rim and a little fill so they read against dark floors.
      let rim = pow(1.0 - max(dot(n, V), 0.0), 2.5);
      col += albedo * vec3f(0.05, 0.06, 0.09) + vec3f(0.07, 0.09, 0.15) * rim;
    }
    if (mat == 1) {
      // Gloss also catches a faint sheen of the moon and sky on hard floors.
      col += vec3f(0.01, 0.014, 0.03) * gloss.y * fd.g * 2.0 * F.ambient.w;
    }
  }
  col = mix(col, vec3f(2.5), o.extra.w);
  ${hooks.diagnostics ? `if (${hooks.diagnostics} > 0.5 && ${hooks.diagnostics} < 4.5) {
    return vec4f(select(vec3f(0.0), o.color, i32(${hooks.diagnostics}) == 1), alpha);
  }` : ""}
  ${hooks.surface ?? ""}
  let a = alpha * o.extra.z;
  return vec4f(select(col * a, col, mat == 22 && o.aux >= -1.5), a);
}

@fragment fn fs(o: VOut) -> ${motion ? "MotionOut" : "@location(0) vec4f"} {
  ${hooks.fragmentStart ?? ""}
  let mat = i32(round(o.mat));
  if ((mat == 4 || mat == 9 || mat == 2 || mat == 11) && cutaway(o.world, o.pos)) { discard; }
  ${hooks.cutaway ?? ""}
  return ${motion ? "motionOutput(shadeScene(o), o.pos, o.previous, o.world)" : "shadeScene(o)"};
}

@fragment fn fsSolid(o: VOut) -> ${motion ? "MotionOut" : "@location(0) vec4f"} {
  ${hooks.fragmentStart ?? ""}
  ${hooks.solidCutaway ?? hooks.cutaway ?? ""}
  return ${motion ? "motionOutput(shadeScene(o), o.pos, o.previous, o.world)" : "shadeScene(o)"};
}
`

/**
 * Sprites. kind: 0 glow (camera facing), 1 faceted smoke puff, 2 ground ring, 3 jagged ground ring, 4 ground line
 * (tracer, throw arc), 5 dashed ground ring, 6 ground disc, 7 marker "!", 8 ground wedge (claymore cone; extra = half-angle).
 */
export const sceneShader = (looks = true, motion = false) => makeSceneShader({}, looks, motion)

export const spriteShader = (motion = false) => /* wgsl */ `
${common}
${motion ? motionOutput : ""}

${vehicleSprites}
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
  ${motion ? "@location(4) previous: vec4f," : ""}
}

@vertex fn vs(@builtin(vertex_index) vi: u32, s: SIn${motion ? ", @location(3) previousCenter: vec4f" : ""}) -> SOut {
  var corners = array<vec2f, 6>(vec2f(-1, -1), vec2f(1, -1), vec2f(1, 1), vec2f(-1, -1), vec2f(1, 1), vec2f(-1, 1));
  let c = corners[vi];
  let kind = i32(s.misc.x);
  let size = s.posSize.w;
  var world: vec3f;
  if (kind >= 32) {
    world = vehicleSpritePosition(c, s.posSize, vec4f(s.misc.x - 32.0, s.misc.yzw), F.cam.xyz);
  } else if ((kind >= 2 && kind <= 6) || kind == 8) {
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
  ${motion ? `o.previous = M.previous * vec4f(world + previousCenter.xyz - s.posSize.xyz, 1.0);
  // Sweep only tracked transient emission. A gather alone cannot extend a thin flash/tracer silhouette.
  if (previousCenter.w > 0.5 && (kind == 0 || kind == 4)) {
    let center = F.viewProj * vec4f(s.posSize.xyz, 1.0);
    let oldCenter = M.previous * vec4f(previousCenter.xyz, 1.0);
    let uv = center.xy / center.w * vec2f(0.5, -0.5) + 0.5;
    let velocity = shutterVelocity(uv, oldCenter);
    let corner = (o.pos.xy / o.pos.w - center.xy / center.w) * vec2f(0.5, -0.5) * F.screen.xy;
    if (dot(corner, velocity) < 0.0) {
      o.pos = vec4f(o.pos.xy - velocity / F.screen.xy * vec2f(2.0, -2.0) * o.pos.w, o.pos.zw);
    }
  }` : ""}
  return o;
}

@fragment fn fs(o: SOut) -> ${motion ? "MotionOut" : "@location(0) vec4f"} {
  let r = length(o.uv);
  let kind = i32(o.misc.x);
  if (kind >= 32) {
    let color = vehicleSpriteColor(o.uv, o.color, vec4f(o.misc.x - 32.0, o.misc.yzw), o.world.y);
    return ${motion ? "motionOutput(color, o.pos, o.previous, o.world)" : "color"};
  }
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
  } else if (kind == 8) {
    // Wedge out along +x: bright edges, a faint scanning fill and a brighter far rim.
    let ang = abs(atan2(o.uv.y, o.uv.x));
    let half = o.misc.w;
    let inside = (1.0 - smoothstep(half - 0.015, half, ang)) * (1.0 - smoothstep(0.95, 1.0, r));
    let edge = smoothstep(half - 0.07, half - 0.015, ang);
    let scan = 0.5 + 0.5 * sin(r * 22.0 - F.cam.w * 7.0);
    a = inside * (0.1 + 0.08 * scan + 0.8 * edge + 0.35 * smoothstep(0.86, 0.96, r));
  }
  if (a <= 0.002) { discard; }
  ${motion ? "return motionOutput(vec4f(rgb * a * o.color.a, a * o.color.a), o.pos, o.previous, o.world);" : "return vec4f(rgb * a * o.color.a, a * o.color.a);"}
}
`

/** Fullscreen passes: bloom downsample and upsample, then the tone-mapped, graded composite. */
export const postShader = (looks = true, motion = false, finish?: PostFinishOptions) => /* wgsl */ `
${motion ? motionGather : ""}
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> P: vec4f;
@group(0) @binding(3) var bloomTex: texture_2d<f32>;
${looks || finish ? `struct Grade { frame: vec4f, look: vec4f }
@group(0) @binding(4) var<uniform> grade: Grade;` : "@group(0) @binding(4) var<uniform> G: vec4f;"}

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

/** 13-tap downsample (Jimenez 2014); the first level also applies a soft-knee threshold. */
@fragment fn down(o: VO) -> @location(0) vec4f {
  let t = P.xy;
  let uv = o.uv;
  let a = clean(textureSample(src, samp, uv + t * vec2f(-2.0, -2.0))).rgb;
  let b = clean(textureSample(src, samp, uv + t * vec2f(0.0, -2.0))).rgb;
  let c = clean(textureSample(src, samp, uv + t * vec2f(2.0, -2.0))).rgb;
  let d = clean(textureSample(src, samp, uv + t * vec2f(-2.0, 0.0))).rgb;
  let e = clean(textureSample(src, samp, uv)).rgb;
  let f = clean(textureSample(src, samp, uv + t * vec2f(2.0, 0.0))).rgb;
  let g = clean(textureSample(src, samp, uv + t * vec2f(-2.0, 2.0))).rgb;
  let h = clean(textureSample(src, samp, uv + t * vec2f(0.0, 2.0))).rgb;
  let i = clean(textureSample(src, samp, uv + t * vec2f(2.0, 2.0))).rgb;
  let j = clean(textureSample(src, samp, uv + t * vec2f(-1.0, -1.0))).rgb;
  let k = clean(textureSample(src, samp, uv + t * vec2f(1.0, -1.0))).rgb;
  let l = clean(textureSample(src, samp, uv + t * vec2f(-1.0, 1.0))).rgb;
  let m = clean(textureSample(src, samp, uv + t * vec2f(1.0, 1.0))).rgb;
  var col = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  if (P.z > 0.5) {
    let br = max(col.r, max(col.g, col.b));
    let knee = 0.5;
    let th = 0.9;
    var soft = clamp(br - th + knee, 0.0, 2.0 * knee);
    soft = soft * soft / (4.0 * knee + 1e-4);
    col *= max(soft, br - th) / max(br, 1e-4);
  }
  return vec4f(col, 1.0);
}

/** 3x3 tent upsample, added onto the next level up. */
@fragment fn up(o: VO) -> @location(0) vec4f {
  let t = P.xy;
  var c = textureSample(src, samp, o.uv).rgb * 4.0;
  c += (textureSample(src, samp, o.uv + vec2f(-t.x, 0.0)).rgb + textureSample(src, samp, o.uv + vec2f(t.x, 0.0)).rgb + textureSample(src, samp, o.uv + vec2f(0.0, -t.y)).rgb + textureSample(src, samp, o.uv + vec2f(0.0, t.y)).rgb) * 2.0;
  c += textureSample(src, samp, o.uv + vec2f(-t.x, -t.y)).rgb + textureSample(src, samp, o.uv + vec2f(t.x, -t.y)).rgb + textureSample(src, samp, o.uv + vec2f(-t.x, t.y)).rgb + textureSample(src, samp, o.uv + vec2f(t.x, t.y)).rgb;
  return vec4f(c / 16.0, 1.0);
}

fn aces(x: vec3f) -> vec3f {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
}

fn hash(p: vec2f) -> f32 {
  let q = fract(p * vec2f(0.1031, 0.1030));
  let r = q + dot(q, q.yx + 33.33);
  return fract((r.x + r.y) * r.x);
}

// G: time, desaturate, flash, exposure
@fragment fn composite(o: VO) -> @location(0) vec4f {
  ${looks ? "let G = grade.frame; let enhanced = grade.look.x > 0.5;" : finish ? "let G = grade.frame; let feel = grade.look;" : ""}
  let uv = o.uv;
  let fromC = uv - 0.5;
  // A touch of chromatic fringing toward the corners.
  let ca = fromC * dot(fromC, fromC) * ${finish ? `(${finish.chromatic.toFixed(4)} + fract(feel.x) * 0.024)` : looks ? "select(0.012, 0.0015, enhanced)" : "0.012"};
  var hdr = vec3f(
    clean(textureSample(src, samp, uv + ca)).r,
    clean(textureSample(src, samp, uv)).g,
    clean(textureSample(src, samp, uv - ca)).b,
  );
  ${finish ? `if (any(abs(feel.yzw) > vec3f(0.00018))) {
    let rFeel = length(fromC);
    let edgeW = smoothstep(0.06, 0.36, rFeel);
    let vFeel = feel.yz * (0.45 + 0.55 * edgeW) + fromC * (feel.w * 1.45 * edgeW);
    let s0 = clean(textureSampleLevel(src, samp, clamp(uv - vFeel * 0.85, vec2f(0.002), vec2f(0.998)), 0.0)).rgb;
    let s1 = clean(textureSampleLevel(src, samp, clamp(uv - vFeel * 0.38, vec2f(0.002), vec2f(0.998)), 0.0)).rgb;
    let s2 = clean(textureSampleLevel(src, samp, clamp(uv + vFeel * 0.38, vec2f(0.002), vec2f(0.998)), 0.0)).rgb;
    let s3 = clean(textureSampleLevel(src, samp, clamp(uv + vFeel * 0.85, vec2f(0.002), vec2f(0.998)), 0.0)).rgb;
    hdr = hdr * 0.32 + (s1 + s2) * 0.22 + (s0 + s3) * 0.12;
  }` : ""}
  ${motion ? "hdr += motionColour(uv) - clean(textureSampleLevel(src, samp, uv, 0.0)).rgb;" : ""}
  let bloom = textureSample(bloomTex, samp, uv).rgb;
  ${finish?.diagnostics ? `if (G.y > 0.5) {
    if (i32(G.y) == 5) { hdr = bloom * ${finish.bloom.toFixed(4)}; }
    return vec4f(pow(max(hdr, vec3f(0.0)), vec3f(1.0/2.2)), 1.0);
  }` : ""}
  hdr = hdr + bloom * ${finish ? (finish.halation ? `(${finish.bloom.toFixed(4)} + vec3f(1.08, 0.36, 0.12) * ${finish.halation.toFixed(4)})` : finish.bloom.toFixed(4)) : "0.32"};
  var c = aces(hdr * G.w);
  ${finish?.huePreserve ? `let exposed=max(hdr*G.w,vec3f(0.0));
  let peak=max(exposed.r,max(exposed.g,exposed.b));
  c=mix(c,exposed*(aces(vec3f(peak)).r/max(peak,0.0001)),${finish.huePreserve.toFixed(4)});` : ""}
  ${looks ? `if (enhanced) {
    // Partially hue-preserving shoulder keeps warm pools and cyan monitors saturated.
    let x = max(hdr * G.w, vec3f(0.0));
    let peak = max(max(x.r, x.g), x.b);
    c = mix(c, x * (aces(vec3f(peak)).r / max(peak, 0.0001)), 0.42);
  }` : ""}
  let l = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  // Grade: navy in the shadows, a little warmth in the highlights, saturation up.
  ${looks ? `if (enhanced) {
    c = mix(vec3f(l), c, 1.12 * (1.0 - G.y));
    c += vec3f(0.001, 0.004, 0.008) * (1.0 - smoothstep(0.0, 0.25, l));
    c *= mix(vec3f(0.72, 1.0, 1.04), vec3f(1.08, 1.01, 0.89), smoothstep(0.05, 0.65, l));
  } else {` : ""}
    c = mix(vec3f(l), c, ${finish?.saturation !== undefined ? `${finish.saturation.toFixed(4)} * ` : ""}(1.0 - G.y));
    c += ${finish?.shadowLiftColor ? `vec3f(${finish.shadowLiftColor.map(v => v.toFixed(4)).join(", ")})` : "vec3f(0.006, 0.011, 0.028)"} * ${finish?.shadowLift === undefined ? "" : `${finish.shadowLift.toFixed(4)} * `}(1.0 - smoothstep(0.0, 0.25, l));
    c *= mix(${finish?.shadowTint ? `vec3f(${finish.shadowTint.map(v => v.toFixed(4)).join(", ")})` : "vec3f(0.93, 0.97, 1.06)"}, ${finish?.highlightTint ? `vec3f(${finish.highlightTint.map(v => v.toFixed(4)).join(", ")})` : "vec3f(1.04, 1.0, 0.95)"}, smoothstep(0.2, 0.8, l));
  ${looks ? "}" : ""}
  let v = length(fromC * vec2f(1.0, 0.8));
  c *= mix(1.0, ${finish ? finish.vignette.toFixed(4) : "0.45"}, smoothstep(0.32, 0.85, v));
  c = mix(c, vec3f(0.55, 0.05, 0.06), G.z * smoothstep(0.25, 0.85, v));
  c = pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.2));
  let px = o.pos.xy;
  let grain = hash(px + fract(G.x * 13.7) * 1000.0) + hash(px * 1.37 + fract(G.x * 7.3) * 500.0) - 1.0;
  ${finish?.shadowLiftColor ? `let midMask = smoothstep(0.02, 0.20, l) * (1.0 - smoothstep(0.75, 1.0, l));
  c += grain * ${finish.grain.toFixed(4)} * (0.25 + 0.75 * midMask);
  let ign = fract(52.9829189 * fract(dot(floor(px), vec2f(0.06711056, 0.00583715))));
  c += (ign - 0.5) / 255.0 * step(0.001, l);` : `c += grain * ${finish ? finish.grain.toFixed(4) : looks ? "select(0.022, 0.009, enhanced)" : "0.022"} * (1.0 - l * 0.6);`}
  return vec4f(c, 1.0);
}
`

export const postCommonWgsl = /* wgsl */ `
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

fn aces(x: vec3f) -> vec3f {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
}

fn hash(p: vec2f) -> f32 {
  let q = fract(p * vec2f(0.1031, 0.1030));
  let r = q + dot(q, q.yx + 33.33);
  return fract((r.x + r.y) * r.x);
}
`

export { makeLookPostShader, makeLookSceneShader, type PostFinishOptions } from "./look-shaders"
