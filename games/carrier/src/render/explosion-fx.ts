import { ATMOSPHERE_WGSL } from "./atmosphere"
import { FRAME, FRAME_BINDING_WGSL } from "./frame"
import { MESH_LAYOUT } from "./lit"
import { FLOATS_PER_VERT, Mesh, type Rgb, packVerts } from "./mesh"
import { HASH_WGSL } from "./ocean-hash"
import { WAKE_FORMAT, WAKE_SIZE, wakeTarget, type WakeTarget } from "./ocean-wake"
import { ACCENT } from "./plane-glb"
import type { Renderer, ScenePass } from "./renderer"
import { Particles } from "@arcade/kit/fx/particles"
import { blackbodyFireWgsl, ParticleRenderer } from "@arcade/kit/fx/particle-renderer"

// Explosion rendering (src/render/explosions.ts choreographs it). Four primitives, all from fixed pools, nothing
// allocated per frame:
// - Puffs: faceted, jittered icospheres (the clouds' look, clouds.ts) for fireballs, smoke, spray and dust. Opaque with
//   alpha-to-coverage like the clouds, so a thick cloud of them costs no blended overdraw and sorts itself; they fade by
//   coverage. A fireball is a puff that is hot: it glows white-yellow → orange → red as it cools, then is soot.
// - Pieces: the jet's own chunks (jet-chunks.ts) and small shards, flat-lit like the jets, charred, with embers.
// - Sprites (additive, "alpha" slot): the flash, fire glows, sparks streaking along their velocity.
// - Discs ("alpha" slot): flat polygons on a surface: scorch marks (darkening) and the fireball's light pool (additive).
// Plus foam rings drawn into the ocean's wake field (ocean-wake.ts), so a splash's foam breaks up with the water.

const PUFF_POOL = 2400
const PUFF_FLOATS = 16
const SPARK_POOL = 1200
const SPRITE_FLOATS = 12
const MAX_SPRITES = 2400
const STREAK_POOL = 3072
const SEG_FLOATS = 16
/** Trail smoke: drag (1/s), how fast the wind takes it (1/s) and its initial lift (m/s). */
const STREAK_DRAG = 1.2
const STREAK_WIND = 0.35
const STREAK_LIFT = 1
const MAX_PIECES = 640
const PIECE_FLOATS = 24
const MAX_DISCS = 96
const DISC_FLOATS = 12
const FOAM_FLOATS = 5
const MAX_FOAM_VERTS = 24 * 6 * 3 * 16

const PUFF_WGSL = /* wgsl */ `
${FRAME_BINDING_WGSL}
${ATMOSPHERE_WGSL}
${HASH_WGSL}
// p: centre, radius; a: seed, spin angle, height stretch, coverage; c: albedo, emission; h: heat 0..1, fire light from
// below, sunlit share, unused.
struct Puff { p: vec4f, a: vec4f, c: vec4f, h: vec4f }
@group(1) @binding(0) var<storage, read> puffs: array<Puff>;

struct VO {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) @interpolate(flat) c: vec4f,
  @location(2) @interpolate(flat) h: vec4f,
  @location(3) @interpolate(flat) cover: f32,
  @location(4) @interpolate(flat) centre: vec3f,
  @location(5) @interpolate(flat) seed: u32,
}

fn rotate(v: vec3f, axis: vec3f, a: f32) -> vec3f {
  let c = cos(a);
  let s = sin(a);
  return v * c + cross(axis, v) * s + axis * dot(axis, v) * (1.0 - c);
}

@vertex fn vs(@location(0) unit: vec3f, @builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VO {
  let q = puffs[ii];
  let seed = u32(q.a.x);
  // Chunky facets: every unique vertex pushed in or out (indexed, so the ball stays watertight).
  let j = rand3(vec3u(vi, seed, 7u));
  var u = unit * (0.78 + 0.36 * j.x);
  u.y *= q.a.z;
  let ax = normalize(rand3(vec3u(seed, 3u, 11u)) - 0.5 + vec3f(0.0, 1e-3, 0.0));
  let w = q.p.xyz + rotate(u, ax, q.a.y) * q.p.w;
  var o: VO;
  o.pos = F.viewProj * vec4f(w, 1.0);
  o.world = w;
  o.c = q.c;
  o.h = q.h;
  o.cover = q.a.w;
  o.centre = q.p.xyz;
  o.seed = seed;
  return o;
}

${blackbodyFireWgsl}
/** Fire colour for heat 0..1: shared Planckian blackbody ramp from @arcade/kit/fx/particle-renderer. */
fn fire(h: f32) -> vec3f {
  return blackbodyFire(h * 1.42) * smoothstep(0.0, 0.1, h);
}

struct FO { @location(0) color: vec4f }

@fragment fn fs(o: VO) -> FO {
  var n = normalize(cross(dpdx(o.world), dpdy(o.world)));
  let rel = o.world - F.eye.xyz;
  let dist = length(rel);
  let V = -rel / max(dist, 1e-3);
  n = select(-n, n, dot(n, V) >= 0.0);
  let L = F.sunDir.xyz;
  let sun = F.sunColor.rgb * F.sunDir.w;
  // Smoke (soft) has gentler facets than spray: wrapped light, less contrast.
  let wrap = saturate(dot(n, L) * mix(0.6, 0.4, o.h.w) + mix(0.4, 0.6, o.h.w));
  let top = saturate(n.y * 0.5 + 0.5);
  // Lit like the clouds (sunny facets bright, shaded facets take the sky), dark smoke stays dark: albedo scales it all.
  let amb = cloudAmbient(mix(vec3f(0.42, 0.5, 0.72), vec3f(0.8, 0.88, 1.08), top), top) * mix(0.62, 1.0, top);
  // Each facet cools on its own: as the ball cools, more of its facets turn to soot (fire and smoke mixed), and the
  // ones still burning glow hotter toward the middle of the ball.
  let fh = rand3(vec3u(bitcast<vec3u>(floor(n * 5.0 + 0.5)) + vec3u(o.seed)));
  let heat = saturate(o.h.x * (1.25 + 0.5 * fh.y) - fh.x * 0.45);
  // A hot facet is its own light: the lit albedo gives way to the fire's glow.
  let lit = 1.0 - smoothstep(0.1, 0.5, heat) * 0.9;
  var c = o.c.rgb * (amb * 0.85 + sun * vec3f(1.0, 0.97, 0.92) * wrap * wrap * 0.9 * o.h.z) * lit;
  // Sunlit silhouette edge, so dark smoke against the sea reads as a soft mass, not a hole.
  c += o.c.rgb * sun * pow(1.0 - saturate(dot(n, V)), 3.0) * saturate(dot(n, L) + 0.3) * 0.8 * o.h.z;
  // The fire under it lights the smoke's belly; the glow of its own heat (stronger facing us: a hot core, cooler rim).
  let below = saturate(0.6 - n.y * 0.6);
  c += o.c.rgb * vec3f(4.0, 1.6, 0.45) * o.h.y * below;
  let facing = saturate(dot(n, V));
  // Damped close to the camera so a burst at arm's length doesn't white out the frame; brighter against the night.
  let keep = mix(0.3, 1.0, smoothstep(10.0, 80.0, dist)) * (1.0 + 0.6 * F.extra.x);
  let glow = fire(heat) * o.c.w * (0.5 + 0.5 * facing) * keep;
  c = applyFog(c, o.world) + glow * exp(-dist * F.horizon.w * 0.8);
  // Soft silhouettes (alpha-to-coverage, resolved by the MSAA): smoke thins at its edges so it reads as a volume.
  let edge = mix(1.0, smoothstep(0.0, 0.55, facing), o.h.w);
  // Thinned where the camera passes through it (a chase camera flying through its own jet's smoke).
  let near = smoothstep(6.0, 30.0, dist);
  var out: FO;
  out.color = vec4f(c, o.cover * edge * near);
  return out;
}
`

const PIECE_WGSL = /* wgsl */ `
${FRAME_BINDING_WGSL}
${ATMOSPHERE_WGSL}
${HASH_WGSL}
// m: model → world; a: accent rgb, char 0..1; e: ember 0..1, seed, scale for the ember facets, unused.
struct Piece { m: mat4x4f, a: vec4f, e: vec4f }
@group(1) @binding(0) var<storage, read> pieces: array<Piece>;

struct VIn { @location(0) pos: vec3f, @location(1) normal: vec4f, @location(2) color: vec4f, @location(3) matAux: vec2f }
struct VO {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) color: vec3f,
  @location(3) @interpolate(flat) mat: f32,
  @location(4) @interpolate(flat) a: vec4f,
  @location(5) @interpolate(flat) e: vec4f,
  @location(6) @interpolate(flat) local: vec3f,
}

@vertex fn vs(v: VIn, @builtin(instance_index) ii: u32) -> VO {
  let p = pieces[ii];
  let w = p.m * vec4f(v.pos, 1.0);
  var o: VO;
  o.pos = F.viewProj * w;
  o.world = w.xyz;
  o.normal = (p.m * vec4f(v.normal.xyz, 0.0)).xyz;
  o.color = pow(v.color.rgb, vec3f(2.2));
  o.mat = v.matAux.x;
  o.a = p.a;
  o.e = p.e;
  o.local = v.pos;
  return o;
}

@fragment fn fs(o: VO, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  var n = normalize(o.normal);
  n = select(-n, n, front);
  let sun = F.sunDir.xyz;
  let ndl = max(dot(n, sun), 0.0);
  let ambient = mix(ambientBounce(), ambientSky(n), n.y * 0.5 + 0.5) * F.sunColor.w;
  let below = saturate(0.35 - n.y * 0.65);
  let seaLight = ambientBounce() * F.sunColor.w * 0.6 * below;
  var albedo = o.color;
  if (o.mat > ${ACCENT - 0.5}) { albedo = o.a.rgb * o.color.r * 1.15; }
  // Charred: soot over the paint, patchy per facet.
  let f = rand3(vec3u(bitcast<vec3u>(floor(o.local * o.e.z * 4.0)) + vec3u(u32(o.e.y))));
  let char = saturate(o.a.w * (0.65 + 0.7 * f.x));
  albedo = mix(albedo, vec3f(0.035, 0.032, 0.03), char);
  var c = albedo * (F.sunColor.rgb * F.sunDir.w * ndl + ambient + seaLight);
  // Embers: some facets glow and flicker while it burns.
  let flick = 0.6 + 0.4 * sin(F.eye.w * (7.0 + 9.0 * f.z) + f.y * 6.28);
  let ember = o.e.x * step(0.62, f.y) * flick * (1.0 + 1.5 * F.extra.x);
  c += vec3f(3.0, 0.9, 0.18) * ember;
  return vec4f(applyFog(c, o.world), 1.0);
}
`

const SPRITE_WGSL = /* wgsl */ `
${FRAME_BINDING_WGSL}
${ATMOSPHERE_WGSL}
struct Sprite { p0: vec4f, p1: vec4f, c: vec4f } // ends (xyz, radius), rgb + alpha
@group(1) @binding(0) var<storage, read> sprites: array<Sprite>;
@group(1) @binding(1) var<uniform> P: vec4f; // x: metres per pixel per metre of distance, y: largest radius (px)

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) uv: vec2f,
  @location(2) @interpolate(flat) c: vec4f,
  @location(3) @interpolate(flat) fade: f32,
}

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let s = sprites[ii];
  let q = vi / 6u;
  let corner = vi % 6u;
  var al = array<f32, 6>(0.0, 1.0, 1.0, 0.0, 1.0, 0.0);
  var sd = array<f32, 6>(-1.0, -1.0, 1.0, -1.0, 1.0, 1.0);
  let a = al[corner];
  let side = sd[corner];
  let mid = (s.p0.xyz + s.p1.xyz) * 0.5;
  let toEye = normalize(F.eye.xyz - mid);
  var right = cross(F.forward.xyz, vec3f(0.0, 1.0, 0.0));
  if (dot(right, right) < 1e-6) { right = vec3f(1.0, 0.0, 0.0); }
  right = normalize(right);
  let axis = s.p1.xyz - s.p0.xyz;
  var sideDir = cross(axis, toEye);
  let sl = length(sideDir);
  var capDir: vec3f;
  if (sl < 1e-4 * max(length(axis), 1e-3) || length(axis) < 1e-4) {
    sideDir = right;
    capDir = normalize(cross(toEye, right));
  } else {
    sideDir = sideDir / sl;
    capDir = normalize(cross(toEye, sideDir));
    if (dot(capDir, axis) < 0.0) { capDir = -capDir; }
  }
  var w = s.p1.w;
  var base = s.p1.xyz;
  var e = 0.0;
  if (q == 0u) { w = s.p0.w; base = s.p0.xyz; e = a - 1.0; }
  else if (q == 1u) { w = mix(s.p0.w, s.p1.w, a); base = mix(s.p0.xyz, s.p1.xyz, a); }
  else { e = a; }
  let dist = length(F.eye.xyz - base);
  let wmin = P.x * dist * 1.3;
  let we = max(min(w, P.x * dist * P.y), wmin);
  let fade = min(1.0, w / max(we, 1e-6));
  var pos = base + sideDir * side * we;
  if (q == 0u) { pos = s.p0.xyz - capDir * we * (1.0 - a) + sideDir * side * we; }
  if (q == 2u) { pos = s.p1.xyz + capDir * we * a + sideDir * side * we; }
  var o: VOut;
  o.pos = F.viewProj * vec4f(pos, 1.0);
  o.world = pos;
  o.uv = vec2f(side, e);
  o.c = s.c;
  o.fade = fade;
  return o;
}

@fragment fn fs(o: VOut) -> @location(0) vec4f {
  let r2 = dot(o.uv, o.uv);
  if (r2 >= 1.0) { discard; }
  let k = 1.0 - r2;
  let near = smoothstep(2.0, 25.0, length(o.world - F.eye.xyz));
  let fog = exp(-length(o.world - F.eye.xyz) * F.horizon.w * 0.8);
  // Negative alpha: a fireball's light on the air around it, faint by day, strong against the night.
  let boost = select(1.0 + 0.5 * F.extra.x, 0.25 + 1.1 * F.extra.x, o.c.a < 0.0);
  return vec4f(o.c.rgb * abs(o.c.a) * o.fade * k * k * near * fog * boost, 0.0);
}
`

const SMOKE_WGSL = /* wgsl */ `
${FRAME_BINDING_WGSL}
${ATMOSPHERE_WGSL}
// A trail segment: tail and head (xyz, half width), colour, then tail alpha, head alpha, tail heat, head heat. Each
// end's width and alpha come from its own age, so a segment's tail matches the head of the one laid before it: the
// trail reads as one ribbon, never beads or a ladder.
struct Seg { p0: vec4f, p1: vec4f, c: vec4f, a: vec4f }
@group(1) @binding(0) var<storage, read> segs: array<Seg>;
@group(1) @binding(1) var<uniform> P: vec4f;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) side: f32,
  @location(2) a: f32,
  @location(3) heat: f32,
  @location(4) @interpolate(flat) c: vec3f,
}

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let s = segs[ii];
  var al = array<f32, 6>(0.0, 1.0, 1.0, 0.0, 1.0, 0.0);
  var sd = array<f32, 6>(-1.0, -1.0, 1.0, -1.0, 1.0, 1.0);
  let k = al[vi];
  let side = sd[vi];
  let base = mix(s.p0.xyz, s.p1.xyz, k);
  let toEye = normalize(F.eye.xyz - base);
  var axis = s.p1.xyz - s.p0.xyz;
  var dir = cross(axis, toEye);
  if (dot(dir, dir) < 1e-8) { dir = cross(vec3f(0.0, 1.0, 0.0), toEye); }
  dir = normalize(dir);
  let w = mix(s.p0.w, s.p1.w, k);
  let dist = length(F.eye.xyz - base);
  let we = max(w, P.x * dist * 1.3);
  var o: VOut;
  let pos = base + dir * side * we;
  o.pos = F.viewProj * vec4f(pos, 1.0);
  o.world = pos;
  o.side = side;
  o.a = mix(s.a.x, s.a.y, k) * min(1.0, w / we);
  o.heat = mix(s.a.z, s.a.w, k);
  o.c = s.c.rgb;
  return o;
}

@fragment fn fs(o: VOut) -> @location(0) vec4f {
  let x2 = o.side * o.side;
  let dist = length(o.world - F.eye.xyz);
  let a = o.a * smoothstep(1.0, 0.1, x2) * smoothstep(4.0, 30.0, dist);
  // Mostly sky light, a little sun; the fire inside it glows through near the head.
  let light = F.sunColor.rgb * (F.sunDir.w * 0.5 + F.sunColor.w * 0.75) + ambientSky(vec3f(0.0, 1.0, 0.0)) * F.sunColor.w * 0.9 * F.extra.x;
  let fire = vec3f(3.0, 1.1, 0.25) * o.heat * (1.0 - x2) * (1.0 + 1.3 * F.extra.x);
  let col = applyFog(o.c * light, o.world) + fire;
  return vec4f(col * a, a);
}
`

const DISC_WGSL = /* wgsl */ `
${FRAME_BINDING_WGSL}
${ATMOSPHERE_WGSL}
${HASH_WGSL}
struct Disc { p: vec4f, n: vec4f, c: vec4f } // centre, radius; up normal, seed; rgb, alpha
@group(1) @binding(0) var<storage, read> discs: array<Disc>;

struct VO {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) r: f32,
  @location(2) @interpolate(flat) c: vec4f,
}

const SIDES: u32 = 14u;

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VO {
  let d = discs[ii];
  let tri = vi / 3u;
  let k = vi % 3u;
  let n = normalize(d.n.xyz);
  var t = cross(n, vec3f(0.0, 0.0, 1.0));
  if (dot(t, t) < 1e-4) { t = cross(n, vec3f(1.0, 0.0, 0.0)); }
  t = normalize(t);
  let b = cross(n, t);
  var w = d.p.xyz;
  var r = 0.0;
  if (k > 0u) {
    let i = (tri + k - 1u) % SIDES;
    let a = f32(i) / f32(SIDES) * 6.2831853;
    let j = rand3(vec3u(i, u32(d.n.w), 5u));
    let rr = d.p.w * (0.72 + 0.4 * j.x);
    w = d.p.xyz + (t * cos(a) + b * sin(a)) * rr;
    r = 1.0;
  }
  var o: VO;
  o.pos = F.viewProj * vec4f(w, 1.0);
  o.world = w;
  o.r = r;
  o.c = d.c;
  return o;
}

@fragment fn fsScorch(o: VO) -> @location(0) vec4f {
  let a = o.c.a * (1.0 - smoothstep(0.55, 1.0, o.r));
  return vec4f(applyFog(o.c.rgb, o.world) * a, a);
}

@fragment fn fsPool(o: VO) -> @location(0) vec4f {
  let k = 1.0 - o.r;
  // Faint by day (the sun outshines it), strong at night.
  return vec4f(o.c.rgb * o.c.a * k * k * (0.3 + 1.7 * F.extra.x), 0.0);
}
`

const FOAM_WGSL = /* wgsl */ `
struct VIn { @location(0) pos: vec2f, @location(1) aas: vec3f }
struct VOut { @builtin(position) pos: vec4f, @location(0) aas: vec3f }

@vertex fn vs(v: VIn) -> VOut {
  var o: VOut;
  let half = ${WAKE_SIZE / 2}.0;
  o.pos = vec4f(v.pos.x / half, -v.pos.y / half, 0.0, 1.0);
  o.aas = v.aas;
  return o;
}

@fragment fn fs(o: VOut) -> @location(0) vec4f {
  let s = o.aas.z * (1.0 - smoothstep(0.3, 1.0, abs(o.aas.x)));
  return vec4f(s, o.aas.y * step(0.003, s), 0.0, 1.0);
}
`

/** Level-1 icosphere (42 vertices, 80 faces), indexed so per-vertex jitter keeps it watertight. */
function icosphere(): { pos: Float32Array<ArrayBuffer>; idx: Uint16Array<ArrayBuffer> } {
  const t = (1 + Math.sqrt(5)) / 2
  const v: number[][] = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map((p) => {
    const l = Math.hypot(p[0]!, p[1]!, p[2]!)
    return [p[0]! / l, p[1]! / l, p[2]! / l]
  })
  let f: number[][] = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]]
  const mids = new Map<string, number>()
  const mid = (a: number, b: number) => {
    const k = a < b ? `${a}_${b}` : `${b}_${a}`
    let i = mids.get(k)
    if (i === undefined) {
      const p = [(v[a]![0]! + v[b]![0]!) / 2, (v[a]![1]! + v[b]![1]!) / 2, (v[a]![2]! + v[b]![2]!) / 2]
      const l = Math.hypot(p[0]!, p[1]!, p[2]!)
      i = v.push([p[0]! / l, p[1]! / l, p[2]! / l]) - 1
      mids.set(k, i)
    }
    return i
  }
  f = f.flatMap(([a, b, c]) => {
    const ab = mid(a!, b!)
    const bc = mid(b!, c!)
    const ca = mid(c!, a!)
    return [[a!, ab, ca], [b!, bc, ab], [c!, ca, bc], [ab, bc, ca]]
  })
  return { pos: new Float32Array(v.flat()), idx: new Uint16Array(f.flat()) }
}

/** Small debris shapes (unit size): a bent panel, a wedge and a lump, flat-shaded grey (tinted per instance). */
function shardMeshes(): number[][] {
  const out: number[][] = []
  const grey: Rgb = [0.62, 0.64, 0.67]
  const dark: Rgb = [0.32, 0.33, 0.35]
  // Bent panel: two quads folded along x = 0.
  let m = new Mesh()
  const p = [[-1, 0.25, -0.7], [0, 0, -0.8], [0, 0, 0.8], [-1, 0.3, 0.6], [1, 0.35, -0.5], [1, 0.3, 0.7]]
  m.quadAuto(p[0]!, p[1]!, p[2]!, p[3]!, grey)
  m.quadAuto(p[1]!, p[4]!, p[5]!, p[2]!, grey)
  m.quadAuto(p[3]!, p[2]!, p[1]!, p[0]!, dark)
  m.quadAuto(p[2]!, p[5]!, p[4]!, p[1]!, dark)
  out.push(m.v)
  // Wedge: a triangular prism.
  m = new Mesh()
  const a = [[-0.8, -0.3, -0.6], [0.9, -0.3, -0.4], [0, 0.5, 0.1]]
  const b = a.map((q) => [q[0]! * 0.8, q[1]!, q[2]! + 1.2])
  m.facet(a[0]!, a[2]!, a[1]!, dark)
  m.facet(b[0]!, b[1]!, b[2]!, grey)
  for (let i = 0; i < 3; i++) m.quadAuto(a[i]!, a[(i + 1) % 3]!, b[(i + 1) % 3]!, b[i]!, i === 0 ? dark : grey)
  out.push(m.v)
  // Lump: an irregular octahedron.
  m = new Mesh()
  const o = [[1, 0.1, 0], [-0.8, -0.1, 0.1], [0, 0.9, 0.1], [0.1, -0.7, 0], [0, 0, 1.1], [0.1, 0.1, -0.9]]
  const faces = [[0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4], [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5]]
  for (const [i, j, k] of faces) m.facet(o[i!]!, o[j!]!, o[k!]!, i! % 2 ? dark : grey)
  out.push(m.v)
  return out
}

export type MeshRef = { first: number; count: number }

/** Particle pools for puffs and sparks (structure of arrays, recycled oldest first). */
class PuffPool {
  readonly x = new Float32Array(PUFF_POOL)
  readonly y = new Float32Array(PUFF_POOL)
  readonly z = new Float32Array(PUFF_POOL)
  readonly vx = new Float32Array(PUFF_POOL)
  readonly vy = new Float32Array(PUFF_POOL)
  readonly vz = new Float32Array(PUFF_POOL)
  readonly age = new Float32Array(PUFF_POOL).fill(1e9)
  readonly life = new Float32Array(PUFF_POOL).fill(1)
  readonly r0 = new Float32Array(PUFF_POOL)
  readonly r1 = new Float32Array(PUFF_POOL)
  /** Seconds to reach most of the final size (ease-out). */
  readonly grow = new Float32Array(PUFF_POOL)
  /** Slow growth after that (m/s): smoke keeps billowing out. */
  readonly swell = new Float32Array(PUFF_POOL)
  readonly drag = new Float32Array(PUFF_POOL)
  /** Buoyancy (m/s², up) and gravity (m/s², down). */
  readonly rise = new Float32Array(PUFF_POOL)
  readonly grav = new Float32Array(PUFF_POOL)
  /** How strongly the wind carries it (1/s toward the wind's velocity). */
  readonly wind = new Float32Array(PUFF_POOL)
  readonly seed = new Uint32Array(PUFF_POOL)
  readonly spin = new Float32Array(PUFF_POOL)
  readonly ang = new Float32Array(PUFF_POOL)
  readonly stretch = new Float32Array(PUFF_POOL)
  /** Heat at birth and how long it takes to cool (s). */
  readonly heat = new Float32Array(PUFF_POOL)
  readonly cool = new Float32Array(PUFF_POOL)
  /** Smoke albedo once cool, and the albedo it pales to by the end of its life (dispersing). */
  readonly r = new Float32Array(PUFF_POOL)
  readonly g = new Float32Array(PUFF_POOL)
  readonly b = new Float32Array(PUFF_POOL)
  readonly r2 = new Float32Array(PUFF_POOL)
  readonly g2 = new Float32Array(PUFF_POOL)
  readonly b2 = new Float32Array(PUFF_POOL)
  readonly emit = new Float32Array(PUFF_POOL)
  /** Peak coverage, the share of life spent fading out, and how sunlit it reads (spray 1, smoke ~0.8). */
  readonly cover = new Float32Array(PUFF_POOL)
  readonly fade = new Float32Array(PUFF_POOL)
  readonly sunlit = new Float32Array(PUFF_POOL)
  /** Edge softness 0 (crisp, spray) .. 1 (smoke). */
  readonly soft = new Float32Array(PUFF_POOL)
  /** Fire light on its belly (s it lasts). */
  readonly under = new Float32Array(PUFF_POOL)
  /** Lowest height it may sink to (a surface), or -1e9. */
  readonly floor = new Float32Array(PUFF_POOL)
  next = 0
  live = 0
}

/** Soft smoke capsules from a tail point to a head point (trails laid segment by segment, so they never bead). */
class StreakPool {
  readonly x0 = new Float32Array(STREAK_POOL)
  readonly y0 = new Float32Array(STREAK_POOL)
  readonly z0 = new Float32Array(STREAK_POOL)
  readonly x1 = new Float32Array(STREAK_POOL)
  readonly y1 = new Float32Array(STREAK_POOL)
  readonly z1 = new Float32Array(STREAK_POOL)
  readonly age = new Float32Array(STREAK_POOL).fill(1e9)
  readonly life = new Float32Array(STREAK_POOL).fill(1)
  readonly w0 = new Float32Array(STREAK_POOL)
  readonly w1 = new Float32Array(STREAK_POOL)
  readonly r = new Float32Array(STREAK_POOL)
  readonly g = new Float32Array(STREAK_POOL)
  readonly b = new Float32Array(STREAK_POOL)
  readonly a = new Float32Array(STREAK_POOL)
  readonly heat = new Float32Array(STREAK_POOL)
  readonly rise = new Float32Array(STREAK_POOL)
  /** How much older the tail is than the head (s). */
  readonly lag = new Float32Array(STREAK_POOL)
  next = 0
}

class SparkPool {
  readonly x = new Float32Array(SPARK_POOL)
  readonly y = new Float32Array(SPARK_POOL)
  readonly z = new Float32Array(SPARK_POOL)
  readonly vx = new Float32Array(SPARK_POOL)
  readonly vy = new Float32Array(SPARK_POOL)
  readonly vz = new Float32Array(SPARK_POOL)
  readonly age = new Float32Array(SPARK_POOL).fill(1e9)
  readonly life = new Float32Array(SPARK_POOL).fill(1)
  readonly size = new Float32Array(SPARK_POOL)
  readonly r = new Float32Array(SPARK_POOL)
  readonly g = new Float32Array(SPARK_POOL)
  readonly b = new Float32Array(SPARK_POOL)
  readonly drag = new Float32Array(SPARK_POOL)
  readonly grav = new Float32Array(SPARK_POOL)
  /** Streak length in seconds of travel. */
  readonly streak = new Float32Array(SPARK_POOL)
  next = 0
}

/** Options for one puff (see PuffPool). */
export type PuffSpec = {
  life: number
  r0: number
  r1: number
  grow?: number
  swell?: number
  drag?: number
  rise?: number
  grav?: number
  wind?: number
  stretch?: number
  heat?: number
  cool?: number
  /** Smoke albedo (cool colour), and what it pales to by the end of its life (default: unchanged). */
  col: Rgb
  pale?: Rgb
  emit?: number
  cover?: number
  fade?: number
  sunlit?: number
  soft?: number
  under?: number
  floor?: number
  spin?: number
}

/**
 * The explosion pass. Per frame: `begin(eye, t, dt, fov, viewportH, wind)` advances puffs and sparks, then the host
 * adds this frame's pieces, glows, discs and foam, then `upload()`. `opaque` (puffs, pieces) and `alpha` (sprites,
 * discs, foam) are the two ScenePasses to add.
 */
export class ExplosionFx {
  readonly opaque: ScenePass
  readonly alpha: ScenePass
  private d: GPUDevice
  private puffPipe: GPURenderPipeline
  private piecePipe: GPURenderPipeline
  private spritePipe: GPURenderPipeline
  private scorchPipe: GPURenderPipeline
  private poolPipe: GPURenderPipeline
  private foamPipe: GPURenderPipeline
  private icoV: GPUBuffer
  private icoI: GPUBuffer
  private icoCount: number
  private puffBuf: GPUBuffer
  private puffGroup: GPUBindGroup
  private puffData = new Float32Array(PUFF_POOL * PUFF_FLOATS)
  private puffs = 0
  private pieceBuf: GPUBuffer
  private pieceGroup: GPUBindGroup
  private pieceData = new Float32Array(MAX_PIECES * PIECE_FLOATS)
  /** This frame's piece draws: mesh ref per instance (instances grouped by mesh by the host is not required). */
  private pieceMesh: MeshRef[] = []
  private pieces = 0
  private meshBuf: GPUBuffer | null = null
  private spriteBuf: GPUBuffer
  private spriteGroup: GPUBindGroup
  private spriteData = new Float32Array(MAX_SPRITES * SPRITE_FLOATS)
  private sprites = 0
  private paramBuf: GPUBuffer
  private params = new Float32Array(4)
  private discBuf: GPUBuffer
  private discGroup: GPUBindGroup
  private discData = new Float32Array(MAX_DISCS * DISC_FLOATS)
  /** Scorch discs fill from the front, light pools from the back. */
  private scorches = 0
  private pools = 0
  private foamBuf: GPUBuffer
  private foamData = new Float32Array(MAX_FOAM_VERTS * FOAM_FLOATS)
  private foamVerts = 0
  private foamDrawn = 0
  private wake: WakeTarget
  private foamPass: GPURenderPassDescriptor
  private pp = new PuffPool()
  private sp = new SparkPool()
  private st = new StreakPool()
  readonly fxParticles = new Particles()
  private readonly fxRenderer: ParticleRenderer
  private smokeBuf: GPUBuffer
  private smokeGroup: GPUBindGroup
  private smokeData = new Float32Array(STREAK_POOL * SEG_FLOATS)
  private smokes = 0
  private smokePipe: GPURenderPipeline
  private dh = new Float64Array(3)
  private dtl = new Float64Array(3)
  readonly eye = new Float64Array(3)
  time = 0
  windX = 0
  windZ = 0
  /** Shard meshes (unit size), set by `setMeshes`. */
  shards: MeshRef[] = []

  constructor(private renderer: Renderer) {
    const ctx = renderer.context
    const d = (this.d = ctx.device)
    const storage = (label: string, size: number) => d.createBuffer({ label, size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
    const one = (label: string, vis: number) => d.createBindGroupLayout({ label, entries: [{ binding: 0, visibility: vis, buffer: { type: "read-only-storage" } }] })
    const premul: GPUBlendState = { color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" }, alpha: { srcFactor: "zero", dstFactor: "one", operation: "add" } }
    const add: GPUBlendState = { color: { srcFactor: "one", dstFactor: "one", operation: "add" }, alpha: { srcFactor: "zero", dstFactor: "one", operation: "add" } }
    const depthOn: GPUDepthStencilState = { format: ctx.depth, depthWriteEnabled: true, depthCompare: "greater-equal" }
    const depthRead: GPUDepthStencilState = { format: ctx.depth, depthWriteEnabled: false, depthCompare: "greater-equal" }

    // Puffs.
    const ico = icosphere()
    this.icoCount = ico.idx.length
    this.icoV = d.createBuffer({ label: "explo-ico", size: ico.pos.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    d.queue.writeBuffer(this.icoV, 0, ico.pos)
    this.icoI = d.createBuffer({ label: "explo-ico-idx", size: Math.ceil(ico.idx.byteLength / 4) * 4, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST })
    d.queue.writeBuffer(this.icoI, 0, ico.idx.buffer, 0, Math.ceil(ico.idx.byteLength / 4) * 4)
    this.puffBuf = storage("explo-puffs", this.puffData.byteLength)
    const puffLayout = one("explo-puffs", GPUShaderStage.VERTEX)
    this.puffGroup = d.createBindGroup({ layout: puffLayout, entries: [{ binding: 0, resource: { buffer: this.puffBuf } }] })
    const pm = renderer.module(PUFF_WGSL, "explo-puff")
    this.puffPipe = d.createRenderPipeline({
      label: "explo-puff",
      layout: d.createPipelineLayout({ bindGroupLayouts: [ctx.frameLayout, puffLayout] }),
      vertex: { module: pm, entryPoint: "vs", buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] }] },
      fragment: { module: pm, entryPoint: "fs", targets: [{ format: ctx.color }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: depthOn,
      multisample: { count: ctx.samples, alphaToCoverageEnabled: true },
    })

    // Pieces.
    this.pieceBuf = storage("explo-pieces", this.pieceData.byteLength)
    const pieceLayout = one("explo-pieces", GPUShaderStage.VERTEX)
    this.pieceGroup = d.createBindGroup({ layout: pieceLayout, entries: [{ binding: 0, resource: { buffer: this.pieceBuf } }] })
    const km = renderer.module(PIECE_WGSL, "explo-piece")
    this.piecePipe = d.createRenderPipeline({
      label: "explo-piece",
      layout: d.createPipelineLayout({ bindGroupLayouts: [ctx.frameLayout, pieceLayout] }),
      vertex: { module: km, entryPoint: "vs", buffers: [MESH_LAYOUT] },
      fragment: { module: km, entryPoint: "fs", targets: [{ format: ctx.color }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: depthOn,
      multisample: { count: ctx.samples },
    })

    // Sprites.
    this.spriteBuf = storage("explo-sprites", this.spriteData.byteLength)
    this.paramBuf = d.createBuffer({ label: "explo-params", size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    const spriteLayout = d.createBindGroupLayout({
      label: "explo-sprites",
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
      ],
    })
    this.spriteGroup = d.createBindGroup({ layout: spriteLayout, entries: [{ binding: 0, resource: { buffer: this.spriteBuf } }, { binding: 1, resource: { buffer: this.paramBuf } }] })
    const sm = renderer.module(SPRITE_WGSL, "explo-sprite")
    const spriteP = d.createPipelineLayout({ bindGroupLayouts: [ctx.frameLayout, spriteLayout] })
    const spritePipe = (entry: string, blend: GPUBlendState) =>
      d.createRenderPipeline({
        label: `explo-${entry}`,
        layout: spriteP,
        vertex: { module: sm, entryPoint: "vs" },
        fragment: { module: sm, entryPoint: entry, targets: [{ format: ctx.color, blend }] },
        primitive: { topology: "triangle-list", cullMode: "none" },
        depthStencil: depthRead,
        multisample: { count: ctx.samples },
      })
    this.spritePipe = spritePipe("fs", add)
    const om = renderer.module(SMOKE_WGSL, "explo-smoke")
    this.smokePipe = d.createRenderPipeline({
      label: "explo-smoke",
      layout: spriteP,
      vertex: { module: om, entryPoint: "vs" },
      fragment: { module: om, entryPoint: "fs", targets: [{ format: ctx.color, blend: premul }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: depthRead,
      multisample: { count: ctx.samples },
    })
    this.smokeBuf = storage("explo-smoke", this.smokeData.byteLength)
    this.smokeGroup = d.createBindGroup({ layout: spriteLayout, entries: [{ binding: 0, resource: { buffer: this.smokeBuf } }, { binding: 1, resource: { buffer: this.paramBuf } }] })

    // Discs.
    this.discBuf = storage("explo-discs", this.discData.byteLength)
    const discLayout = one("explo-discs", GPUShaderStage.VERTEX)
    this.discGroup = d.createBindGroup({ layout: discLayout, entries: [{ binding: 0, resource: { buffer: this.discBuf } }] })
    const dm = renderer.module(DISC_WGSL, "explo-disc")
    const disc = (entry: string, blend: GPUBlendState) =>
      d.createRenderPipeline({
        label: `explo-${entry}`,
        layout: d.createPipelineLayout({ bindGroupLayouts: [ctx.frameLayout, discLayout] }),
        vertex: { module: dm, entryPoint: "vs" },
        fragment: { module: dm, entryPoint: entry, targets: [{ format: ctx.color, blend }] },
        primitive: { topology: "triangle-list", cullMode: "none" },
        depthStencil: depthRead,
        multisample: { count: ctx.samples },
      })
    this.scorchPipe = disc("fsScorch", premul)
    this.poolPipe = disc("fsPool", add)

    // Foam into the wake field.
    this.wake = wakeTarget(d)
    this.foamBuf = d.createBuffer({ label: "explo-foam", size: this.foamData.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    const fm = renderer.module(FOAM_WGSL, "explo-foam")
    const max: GPUBlendComponent = { operation: "max", srcFactor: "one", dstFactor: "one" }
    this.foamPipe = d.createRenderPipeline({
      label: "explo-foam",
      layout: "auto",
      vertex: {
        module: fm,
        entryPoint: "vs",
        buffers: [{ arrayStride: FOAM_FLOATS * 4, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }, { shaderLocation: 1, offset: 8, format: "float32x3" }] }],
      },
      fragment: { module: fm, entryPoint: "fs", targets: [{ format: WAKE_FORMAT, blend: { color: max, alpha: max } }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
    })
    this.foamPass = { colorAttachments: [{ view: this.wake.view, loadOp: "load", storeOp: "store" }] }
    this.fxRenderer = new ParticleRenderer(d, {
      depthFormat: ctx.depth,
      samples: ctx.samples,
      depthCompare: "greater-equal",
      bindGroupIndex: 1,
      extraBindGroupLayouts: [ctx.frameLayout],
    })

    this.opaque = { draw: (pass) => this.drawOpaque(pass) }
    this.alpha = { draw: (pass) => this.drawAlpha(pass), prepare: (enc) => this.prepareFoam(enc) }
  }

  /**
   * Uploads every mesh pieces can use, in one vertex buffer: `groups` (each a list of build-vertex arrays, e.g. one jet
   * model's chunks) then the shard shapes. Returns each group's refs in order; `shards` holds the shard refs.
   */
  setMeshes(groups: number[][][]): MeshRef[][] {
    const all: number[][] = []
    const refs: MeshRef[][] = []
    let first = 0
    const take = (v: number[]): MeshRef => {
      const r = { first, count: v.length / FLOATS_PER_VERT }
      first += r.count
      all.push(v)
      return r
    }
    for (const g of groups) refs.push(g.map(take))
    this.shards = shardMeshes().map(take)
    const flat = new Float32Array(first * FLOATS_PER_VERT)
    let o = 0
    for (const v of all) {
      flat.set(v, o)
      o += v.length
    }
    const data = packVerts(flat)
    this.meshBuf?.destroy()
    this.meshBuf = this.d.createBuffer({ label: "explo-meshes", size: Math.max(16, data.byteLength), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    this.d.queue.writeBuffer(this.meshBuf, 0, data)
    return refs
  }

  /** Start of a frame: steps puffs and sparks and lays them out; clears the immediate lists. */
  begin(eye: ArrayLike<number>, t: number, dt: number, fov: number, viewportH: number): void {
    this.eye[0] = eye[0]!
    this.eye[1] = eye[1]!
    this.eye[2] = eye[2]!
    this.time = t
    this.params[0] = (2 * Math.tan(fov / 2)) / Math.max(1, viewportH)
    this.params[1] = Math.max(60, viewportH * 0.2)
    this.sprites = 0
    this.pieces = 0
    this.pieceMesh.length = 0
    this.scorches = 0
    this.pools = 0
    this.foamVerts = 0
    this.stepPuffs(dt)
    this.stepSparks(dt)
    this.stepStreaks(dt)
    this.fxParticles.update(dt, [], () => -1e9)
  }

  /** Live puffs (for budgets and scripts). */
  get puffCount(): number {
    return this.puffs
  }

  // ---- puffs ---------------------------------------------------------------------------------------------------------

  puff(x: number, y: number, z: number, vx: number, vy: number, vz: number, s: PuffSpec, seed: number): void {
    const p = this.pp
    const i = p.next
    p.next = (i + 1) % PUFF_POOL
    p.x[i] = x
    p.y[i] = y
    p.z[i] = z
    p.vx[i] = vx
    p.vy[i] = vy
    p.vz[i] = vz
    p.age[i] = 0
    p.life[i] = s.life
    p.r0[i] = s.r0
    p.r1[i] = s.r1
    p.grow[i] = s.grow ?? s.life * 0.35
    p.swell[i] = s.swell ?? 0
    p.drag[i] = s.drag ?? 1
    p.rise[i] = s.rise ?? 0
    p.grav[i] = s.grav ?? 0
    p.wind[i] = s.wind ?? 0.3
    p.seed[i] = seed >>> 0
    p.spin[i] = s.spin ?? 0.3
    p.ang[i] = (seed % 628) / 100
    p.stretch[i] = s.stretch ?? 1
    p.heat[i] = s.heat ?? 0
    p.cool[i] = s.cool ?? 1
    p.r[i] = s.col[0]
    p.g[i] = s.col[1]
    p.b[i] = s.col[2]
    const pale = s.pale ?? s.col
    p.r2[i] = pale[0]
    p.g2[i] = pale[1]
    p.b2[i] = pale[2]
    p.emit[i] = s.emit ?? 1
    p.cover[i] = s.cover ?? 1
    p.fade[i] = s.fade ?? 0.35
    p.sunlit[i] = s.sunlit ?? 0.8
    p.under[i] = s.under ?? 0
    p.soft[i] = s.soft ?? 0.8
    p.floor[i] = s.floor ?? -1e9
  }

  private stepPuffs(dt: number): void {
    const p = this.pp
    const out = this.puffData
    let n = 0
    for (let i = 0; i < PUFF_POOL; i++) {
      const age = p.age[i]!
      const life = p.life[i]!
      if (age >= life) continue
      const na = age + dt
      p.age[i] = na
      if (na >= life) continue
      const k = Math.exp(-p.drag[i]! * dt)
      const w = 1 - Math.exp(-p.wind[i]! * dt)
      p.vx[i] = p.vx[i]! * k + (this.windX - p.vx[i]!) * w
      p.vz[i] = p.vz[i]! * k + (this.windZ - p.vz[i]!) * w
      p.vy[i] = p.vy[i]! * k + (p.rise[i]! - p.grav[i]!) * dt
      p.x[i] = p.x[i]! + p.vx[i]! * dt
      p.y[i] = p.y[i]! + p.vy[i]! * dt
      p.z[i] = p.z[i]! + p.vz[i]! * dt
      if (p.y[i]! < p.floor[i]!) {
        p.y[i] = p.floor[i]!
        if (p.vy[i]! < 0) p.vy[i] = 0
      }
      p.ang[i] = p.ang[i]! + p.spin[i]! * dt
      const u = na / life
      const g = 1 - Math.exp(-na / Math.max(0.02, p.grow[i]!))
      const r = p.r0[i]! + (p.r1[i]! - p.r0[i]!) * g + p.swell[i]! * na
      const fade = p.fade[i]!
      const cover = p.cover[i]! * Math.min(1, na * 25) * (u > 1 - fade ? (1 - u) / fade : 1)
      const heat = p.heat[i]! > 0 ? p.heat[i]! * Math.max(0, 1 - na / p.cool[i]!) : 0
      const o = n * PUFF_FLOATS
      out[o] = p.x[i]!
      out[o + 1] = p.y[i]!
      out[o + 2] = p.z[i]!
      out[o + 3] = r
      out[o + 4] = p.seed[i]! & 0xffffff
      out[o + 5] = p.ang[i]!
      out[o + 6] = p.stretch[i]!
      out[o + 7] = cover
      out[o + 8] = p.r[i]! + (p.r2[i]! - p.r[i]!) * u
      out[o + 9] = p.g[i]! + (p.g2[i]! - p.g[i]!) * u
      out[o + 10] = p.b[i]! + (p.b2[i]! - p.b[i]!) * u
      out[o + 11] = p.emit[i]!
      out[o + 12] = heat
      out[o + 13] = p.under[i]! > 0 ? Math.max(0, 1 - na / p.under[i]!) ** 2 * 0.5 : 0
      out[o + 14] = p.sunlit[i]!
      out[o + 15] = p.soft[i]! * (1 - Math.min(1, heat * 2))
      n++
    }
    this.puffs = n
  }

  // ---- sparks and glows ----------------------------------------------------------------------------------------------

  /** A spark streaking along its velocity: life (s), size (m), colour (HDR), drag (1/s), gravity, streak (s of travel). */
  spark(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, r: number, g: number, b: number, drag: number, grav = 9.81, streak = 0.04): void {
    const p = this.sp
    const i = p.next
    p.next = (i + 1) % SPARK_POOL
    p.x[i] = x
    p.y[i] = y
    p.z[i] = z
    p.vx[i] = vx
    p.vy[i] = vy
    p.vz[i] = vz
    p.age[i] = 0
    p.life[i] = life
    p.size[i] = size
    p.r[i] = r
    p.g[i] = g
    p.b[i] = b
    p.drag[i] = drag
    p.grav[i] = grav
    p.streak[i] = streak
  }

  private stepSparks(dt: number): void {
    const p = this.sp
    for (let i = 0; i < SPARK_POOL; i++) {
      const age = p.age[i]!
      if (age >= p.life[i]!) continue
      const na = age + dt
      p.age[i] = na
      if (na >= p.life[i]!) continue
      const k = Math.exp(-p.drag[i]! * dt)
      p.vx[i] = p.vx[i]! * k
      p.vy[i] = p.vy[i]! * k - p.grav[i]! * dt
      p.vz[i] = p.vz[i]! * k
      p.x[i] = p.x[i]! + p.vx[i]! * dt
      p.y[i] = p.y[i]! + p.vy[i]! * dt
      p.z[i] = p.z[i]! + p.vz[i]! * dt
      const u = na / p.life[i]!
      // Cools from yellow-white to orange-red as it dies.
      const f = (1 - u) * (1 - u)
      const s = p.streak[i]!
      const sz = p.size[i]! * (1 - 0.5 * u)
      this.sprite(p.x[i]! - p.vx[i]! * s, p.y[i]! - p.vy[i]! * s, p.z[i]! - p.vz[i]! * s, p.x[i]!, p.y[i]!, p.z[i]!, sz * 0.5, sz, p.r[i]!, p.g[i]! * (1 - 0.5 * u), p.b[i]! * (1 - u), f)
    }
  }

  /**
   * A smoke trail segment from the tail (x0.., where the trail was laid `lag` s ago) to the head (x1.., laid now),
   * drifting with the wind and rising at `rise` m/s² (see `drift`), widening from w0 to w1 over `life` s while it fades
   * from alpha `a`; `heat` 0..1 glows fire through it for its first moments.
   */
  streak(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, lag: number, life: number, w0: number, w1: number, r: number, g: number, b: number, a: number, heat = 0, rise = 0.5): void {
    const p = this.st
    const i = p.next
    p.next = (i + 1) % STREAK_POOL
    p.x0[i] = x0
    p.y0[i] = y0
    p.z0[i] = z0
    p.x1[i] = x1
    p.y1[i] = y1
    p.z1[i] = z1
    p.age[i] = 0
    p.life[i] = life
    p.w0[i] = w0
    p.w1[i] = w1
    p.r[i] = r
    p.g[i] = g
    p.b[i] = b
    p.a[i] = Math.min(0.999, a)
    p.heat[i] = heat
    p.rise[i] = rise
    p.lag[i] = lag
  }

  /**
   * Every segment drifts by the same function of its age, D(age) (born at rest but for a little lift, then carried by the
   * wind and its rise against drag), so a segment's tail, as old as the previous segment's head, lands exactly on it:
   * the trail stays one unbroken ribbon however it drifts.
   */
  private drift(age: number, rise: number, out: Float64Array): void {
    const a = STREAK_DRAG + STREAK_WIND
    const h = (STREAK_WIND / a) * (age - (1 - Math.exp(-a * age)) / a)
    out[0] = this.windX * h
    out[2] = this.windZ * h
    const v = rise / STREAK_DRAG
    out[1] = v * age + (STREAK_LIFT - v) * (1 - Math.exp(-STREAK_DRAG * age)) / STREAK_DRAG
  }

  private stepStreaks(dt: number): void {
    const p = this.st
    const out = this.smokeData
    const dh = this.dh
    const dtl = this.dtl
    let n = 0
    for (let i = 0; i < STREAK_POOL; i++) {
      const age = p.age[i]!
      if (age >= p.life[i]!) continue
      const na = age + dt
      p.age[i] = na
      if (na >= p.life[i]!) continue
      const life = p.life[i]!
      const w0 = p.w0[i]!
      const dw = p.w1[i]! - w0
      const a = p.a[i]!
      const tail = na + p.lag[i]!
      this.drift(na, p.rise[i]!, dh)
      this.drift(tail, p.rise[i]!, dtl)
      const o = n++ * SEG_FLOATS
      out[o] = p.x0[i]! + dtl[0]!
      out[o + 1] = p.y0[i]! + dtl[1]!
      out[o + 2] = p.z0[i]! + dtl[2]!
      out[o + 3] = w0 + dw * Math.sqrt(Math.min(1, tail / life))
      out[o + 4] = p.x1[i]! + dh[0]!
      out[o + 5] = p.y1[i]! + dh[1]!
      out[o + 6] = p.z1[i]! + dh[2]!
      out[o + 7] = w0 + dw * Math.sqrt(Math.min(1, na / life))
      out[o + 8] = p.r[i]!
      out[o + 9] = p.g[i]!
      out[o + 10] = p.b[i]!
      out[o + 11] = 0
      out[o + 12] = a * Math.max(0, 1 - tail / life) * Math.min(1, tail * 8)
      out[o + 13] = a * Math.max(0, 1 - na / life) * Math.min(1, na * 8)
      // The fire glowing through dies within its first moments.
      out[o + 14] = p.heat[i]! * Math.max(0, 1 - tail * 5)
      out[o + 15] = p.heat[i]! * Math.max(0, 1 - na * 5)
    }
    this.smokes = n
  }

  /** An additive capsule (a point when both ends meet), radii w0/w1, colour (linear HDR) times alpha. */
  sprite(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, w0: number, w1: number, r: number, g: number, b: number, a: number): void {
    if (this.sprites >= MAX_SPRITES || Math.abs(a) <= 0.002) return
    const o = this.sprites++ * SPRITE_FLOATS
    const d = this.spriteData
    d[o] = x0
    d[o + 1] = y0
    d[o + 2] = z0
    d[o + 3] = w0
    d[o + 4] = x1
    d[o + 5] = y1
    d[o + 6] = z1
    d[o + 7] = w1
    d[o + 8] = r
    d[o + 9] = g
    d[o + 10] = b
    d[o + 11] = a
  }

  glow(x: number, y: number, z: number, radius: number, r: number, g: number, b: number, a: number): void {
    this.sprite(x, y, z, x, y, z, radius, radius, r, g, b, a)
  }

  // ---- pieces --------------------------------------------------------------------------------------------------------

  /**
   * A mesh piece: model matrix from position, unit quaternion and scale (sx, sy, sz), team accent (linear RGB), char
   * 0..1 and ember 0..1 (glowing facets), seed for its facet pattern.
   */
  piece(mesh: MeshRef, x: number, y: number, z: number, qx: number, qy: number, qz: number, qw: number, sx: number, sy: number, sz: number, ar: number, ag: number, ab: number, char: number, ember: number, seed: number): void {
    if (this.pieces >= MAX_PIECES) return
    const o = this.pieces * PIECE_FLOATS
    const m = this.pieceData
    const xx = qx * qx
    const yy = qy * qy
    const zz = qz * qz
    const xy = qx * qy
    const xz = qx * qz
    const yz = qy * qz
    const wx = qw * qx
    const wy = qw * qy
    const wz = qw * qz
    m[o] = (1 - 2 * (yy + zz)) * sx
    m[o + 1] = 2 * (xy + wz) * sx
    m[o + 2] = 2 * (xz - wy) * sx
    m[o + 3] = 0
    m[o + 4] = 2 * (xy - wz) * sy
    m[o + 5] = (1 - 2 * (xx + zz)) * sy
    m[o + 6] = 2 * (yz + wx) * sy
    m[o + 7] = 0
    m[o + 8] = 2 * (xz + wy) * sz
    m[o + 9] = 2 * (yz - wx) * sz
    m[o + 10] = (1 - 2 * (xx + yy)) * sz
    m[o + 11] = 0
    m[o + 12] = x
    m[o + 13] = y
    m[o + 14] = z
    m[o + 15] = 1
    m[o + 16] = ar
    m[o + 17] = ag
    m[o + 18] = ab
    m[o + 19] = char
    m[o + 20] = ember
    m[o + 21] = seed & 0xffff
    m[o + 22] = 1 / Math.max(0.05, Math.min(sx, sy, sz))
    m[o + 23] = 0
    this.pieceMesh[this.pieces++] = mesh
  }

  // ---- discs and foam ------------------------------------------------------------------------------------------------

  /** A flat disc at (x, y, z) facing (nx, ny, nz): `pool` adds light (rgb × a), else darkens (scorch, rgb soot colour). */
  disc(pool: boolean, x: number, y: number, z: number, radius: number, nx: number, ny: number, nz: number, r: number, g: number, b: number, a: number, seed: number): void {
    if (this.scorches + this.pools >= MAX_DISCS || a <= 0.002) return
    const slot = pool ? MAX_DISCS - 1 - this.pools++ : this.scorches++
    const o = slot * DISC_FLOATS
    const d = this.discData
    d[o] = x
    d[o + 1] = y
    d[o + 2] = z
    d[o + 3] = radius
    d[o + 4] = nx
    d[o + 5] = ny
    d[o + 6] = nz
    d[o + 7] = seed & 0xffff
    d[o + 8] = r
    d[o + 9] = g
    d[o + 10] = b
    d[o + 11] = a
  }

  /**
   * A ring of foam on the sea from radius r0 to r1 around (x, z) (r0 = 0: a disc), `strength` 0..1 and foam age 0..1,
   * drawn into the ocean's wake field (only near the field's window).
   */
  foam(x: number, z: number, r0: number, r1: number, strength: number, age: number): void {
    const c = this.wake.centre
    const fx = x - c[0]!
    const fz = z - c[1]!
    if (Math.abs(fx) > WAKE_SIZE / 2 + r1 || Math.abs(fz) > WAKE_SIZE / 2 + r1 || strength < 0.01) return
    const N = 24
    const d = this.foamData
    const put = (px: number, pz: number, across: number) => {
      const o = this.foamVerts++ * FOAM_FLOATS
      d[o] = px
      d[o + 1] = pz
      d[o + 2] = across
      d[o + 3] = age
      d[o + 4] = strength
    }
    if (this.foamVerts + N * 6 > MAX_FOAM_VERTS) return
    const mid = (r0 + r1) / 2
    for (let i = 0; i < N; i++) {
      const a0 = (i / N) * Math.PI * 2
      const a1 = ((i + 1) / N) * Math.PI * 2
      const c0 = Math.cos(a0)
      const s0 = Math.sin(a0)
      const c1 = Math.cos(a1)
      const s1 = Math.sin(a1)
      if (r0 <= 0) {
        put(fx, fz, 0)
        put(fx + c0 * r1, fz + s0 * r1, 1)
        put(fx + c1 * r1, fz + s1 * r1, 1)
        continue
      }
      // Two strips: inner edge → middle → outer edge, soft on both sides.
      for (const [ra, rb, ea, eb] of [
        [r0, mid, -1, 0],
        [mid, r1, 0, 1],
      ] as const) {
        put(fx + c0 * ra, fz + s0 * ra, ea)
        put(fx + c1 * ra, fz + s1 * ra, ea)
        put(fx + c1 * rb, fz + s1 * rb, eb)
        put(fx + c0 * ra, fz + s0 * ra, ea)
        put(fx + c1 * rb, fz + s1 * rb, eb)
        put(fx + c0 * rb, fz + s0 * rb, eb)
      }
    }
  }

  upload(): void {
    const q = this.d.queue
    q.writeBuffer(this.paramBuf, 0, this.params)
    if (this.puffs) q.writeBuffer(this.puffBuf, 0, this.puffData, 0, this.puffs * PUFF_FLOATS)
    if (this.pieces) q.writeBuffer(this.pieceBuf, 0, this.pieceData, 0, this.pieces * PIECE_FLOATS)
    if (this.sprites) q.writeBuffer(this.spriteBuf, 0, this.spriteData, 0, this.sprites * SPRITE_FLOATS)
    if (this.smokes) q.writeBuffer(this.smokeBuf, 0, this.smokeData, 0, this.smokes * SEG_FLOATS)
    if (this.scorches) q.writeBuffer(this.discBuf, 0, this.discData, 0, this.scorches * DISC_FLOATS)
    if (this.pools) q.writeBuffer(this.discBuf, (MAX_DISCS - this.pools) * DISC_FLOATS * 4, this.discData, (MAX_DISCS - this.pools) * DISC_FLOATS, this.pools * DISC_FLOATS)
    this.foamDrawn = this.foamVerts
    if (this.foamVerts) q.writeBuffer(this.foamBuf, 0, this.foamData, 0, this.foamVerts * FOAM_FLOATS)
    if (this.fxParticles.count > 0) {
      const f = this.renderer.currentFrame
      const u = this.fxRenderer.uniforms
      u.set(f.subarray(0, 16), 0)
      u[16] = this.eye[0]!
      u[17] = this.eye[1]!
      u[18] = this.eye[2]!
      u[19] = 0
      const sunW = f[FRAME.sunDir + 3]!
      const ambW = f[FRAME.sunColor + 3]!
      const scale = Math.max(0.28, sunW * 0.48 + ambW * 0.72)
      u[20] = f[FRAME.sunColor]! * scale
      u[21] = f[FRAME.sunColor + 1]! * scale
      u[22] = f[FRAME.sunColor + 2]! * scale
      u[23] = 0
      this.fxRenderer.upload(this.fxParticles)
    }
  }

  private prepareFoam(enc: GPUCommandEncoder): void {
    if (!this.foamDrawn) return
    const pass = enc.beginRenderPass(this.foamPass)
    pass.setPipeline(this.foamPipe)
    pass.setVertexBuffer(0, this.foamBuf)
    pass.draw(this.foamDrawn)
    pass.end()
  }

  private drawOpaque(pass: GPURenderPassEncoder): void {
    if (this.pieces && this.meshBuf) {
      pass.setPipeline(this.piecePipe)
      pass.setBindGroup(1, this.pieceGroup)
      pass.setVertexBuffer(0, this.meshBuf)
      // Consecutive instances of one mesh (shards) go in one draw.
      let i = 0
      while (i < this.pieces) {
        const m = this.pieceMesh[i]!
        let j = i + 1
        while (j < this.pieces && this.pieceMesh[j] === m) j++
        pass.draw(m.count, j - i, m.first, i)
        i = j
      }
    }
    if (this.puffs) {
      pass.setPipeline(this.puffPipe)
      pass.setBindGroup(1, this.puffGroup)
      pass.setVertexBuffer(0, this.icoV)
      pass.setIndexBuffer(this.icoI, "uint16")
      pass.drawIndexed(this.icoCount, this.puffs)
    }
  }

  private drawAlpha(pass: GPURenderPassEncoder): void {
    if (this.scorches || this.pools) {
      pass.setBindGroup(1, this.discGroup)
      if (this.scorches) {
        pass.setPipeline(this.scorchPipe)
        pass.draw(42, this.scorches)
      }
      if (this.pools) {
        pass.setPipeline(this.poolPipe)
        pass.draw(42, this.pools, 0, MAX_DISCS - this.pools)
      }
    }
    if (this.smokes) {
      pass.setPipeline(this.smokePipe)
      pass.setBindGroup(1, this.smokeGroup)
      pass.draw(6, this.smokes)
    }
    if (this.sprites) {
      pass.setPipeline(this.spritePipe)
      pass.setBindGroup(1, this.spriteGroup)
      pass.draw(18, this.sprites)
    }
    if (this.fxParticles.count > 0) {
      this.fxRenderer.draw(pass)
    }
  }
}

