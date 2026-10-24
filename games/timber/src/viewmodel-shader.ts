import { common } from "@arcade/kit/gpu/shaders"
import { physicalLightWgsl } from "@arcade/kit/gpu/lights/physical"
import { beamWgsl } from "@arcade/kit/gpu/lights/beam"
import { woodsUniformWgsl } from "@arcade/kit/forest/shaders"

/** Floats per vertex: position, normal, uv, path coordinate (chain links, the cord), part × 16 + material. */
export const VM_VERTEX_FLOATS = 10
/** Floats in the viewmodel's uniform (`Vm` below). */
export const VM_FLOATS = 16 * 5 + 4 * 9

/** Materials (the low four bits of a vertex's id); parts are the high bits. */
export const VM_MAT = { housing: 0, bar: 1, chain: 2, cord: 3, glove: 4, grip: 5, sleeve: 6 } as const
/** Parts: what a vertex moves with. 0 the saw (and the right hand on it), 1 the left hand and sleeve, 2 the T-grip. */
export const VM_PART = { saw: 0, left: 1, grip: 2 } as const

export type ChainPath = { x: number; z: number; rear: [number, number]; nose: [number, number] }
/** The pull cord at rest (glTF): where it leaves the starter and where it meets the T-grip. */
export type SawCord = { exit: readonly number[]; end: readonly number[] }

const f = (x: number) => x.toFixed(6)

/**
 * The first-person saw's shading, lit like the forest: every scene light in the frame through the kit's physical
 * falloff, beam profile and GAIN (BARBARA's held props), plus a wide spill from beams close by (a headlamp's ring
 * lights the hands under it) and a little sky. The chain's links ride the bar's path (`chain`), the cord stretches
 * from the starter to the grip in the hand. Group 0 is the scene's frame; group 1 the saw.
 *
 * Housing, bar and gloves use the asset's baked maps (the gloves' leather is packed under the bar in its maps); the
 * chain picks from a palette; sleeves, the T-grip and cord are procedural: brushed buffalo-check flannel, pebbled
 * rubber, braided cord.
 */
export function vmShader(chain: ChainPath, cord: SawCord): string {
  const v4 = (q: readonly number[]) => `vec4f(${f(q[0]!)}, ${f(q[1]!)}, ${f(q[2]!)}, 1.0)`
  const [y1, r1] = chain.rear
  const [y2, r2] = chain.nose
  const D = y2 - y1
  const PHI = Math.asin((r1 - r2) / D)
  const STRAIGHT = Math.sqrt(D * D - (r1 - r2) ** 2)
  const ARC2 = r2 * (Math.PI - 2 * PHI)
  const ARC1 = r1 * (Math.PI + 2 * PHI)
  const LOOP = 2 * STRAIGHT + ARC1 + ARC2
  return /* wgsl */ `
${common}
${woodsUniformWgsl}
${physicalLightWgsl}
${beamWgsl}
fn pbrStreetCone(ldir: vec3f, arm: vec2f) -> f32 { return 1.0; }
fn pbrBeamA() -> vec4f { return N.beamA; }
fn pbrBeamB() -> vec4f { return N.beamB; }

struct Vm {
  proj: mat4x4f,
  invView: mat4x4f,    // camera → world
  saw: mat4x4f,        // model → camera
  left: mat4x4f,
  grip: mat4x4f,
  cordA: vec4f,        // cord's exit (camera), chain offset along its loop (m)
  cordB: vec4f,        // cord's end at the grip (camera), chain blur 0..1
  eye: vec4f,          // world eye, time
  amb: vec4f,          // ambient rgb, beam spill on the saw
  look: vec4f,         // fov squeeze (world tan / vm tan), wear, glove sheen, sawdust
  trunk: vec4f,        // the trunk being cut: world x, z, radius, on
  cut: vec4f,          // depth the bar sits in the kerf, -, -, -
  pad0: vec4f,
  lampBack: vec4f,     // your helmet lamp, moved down its axis for the world (sawLampAhead): back to the helmet, and
                       // undo the level that makes up its shorter throw (0: not moved)
}
@group(1) @binding(0) var<uniform> V: Vm;
@group(1) @binding(1) var samp: sampler;
// Six maps: with the scene's ten that is WebGPU's sixteen per stage. The housing's occlusion is its ORM's red; the
// chain's 4 × 4 palette is in \`chainCell\` below.
@group(1) @binding(2) var housingBase: texture_2d<f32>;
@group(1) @binding(3) var housingOrm: texture_2d<f32>;
@group(1) @binding(4) var housingNormal: texture_2d<f32>;
@group(1) @binding(5) var barBase: texture_2d<f32>;
@group(1) @binding(6) var barOrm: texture_2d<f32>;
@group(1) @binding(7) var barNormal: texture_2d<f32>;

const MAT_HOUSING: u32 = ${VM_MAT.housing}u;
const MAT_BAR: u32 = ${VM_MAT.bar}u;
const MAT_CHAIN: u32 = ${VM_MAT.chain}u;
const MAT_CORD: u32 = ${VM_MAT.cord}u;
const MAT_GLOVE: u32 = ${VM_MAT.glove}u;
const MAT_GRIP: u32 = ${VM_MAT.grip}u;
const MAT_SLEEVE: u32 = ${VM_MAT.sleeve}u;

// The chain's path round the bar, in the bar's plane (saw y forward, z up = glTF -z, y): the drive sprocket's
// circle (rear), the nose sprocket's (nose), the straight runs tangent to both.
const Y1: f32 = ${f(y1)};
const R1: f32 = ${f(r1)};
const Y2: f32 = ${f(y2)};
const R2: f32 = ${f(r2)};
const BZ: f32 = ${f(chain.z)};
const PHI: f32 = ${f(PHI)};
const STRAIGHT: f32 = ${f(STRAIGHT)};
const ARC2: f32 = ${f(ARC2)};
const LOOP: f32 = ${f(LOOP)};
const PITCH: f32 = ${f(LOOP / 132)};

struct PathAt { p: vec2f, d: vec2f, n: vec2f }
fn chainPath(s0: f32) -> PathAt {
  let s = s0 - floor(s0 / LOOP) * LOOP;
  var o: PathAt;
  let nUp = vec2f(sin(PHI), cos(PHI));
  let nDn = vec2f(sin(PHI), -cos(PHI));
  if (s < STRAIGHT) {
    o.d = vec2f(cos(PHI), -sin(PHI));
    o.p = vec2f(Y1, BZ) + R1 * nUp + o.d * s;
    o.n = nUp;
  } else if (s < STRAIGHT + ARC2) {
    let th = (PI * 0.5 - PHI) - (s - STRAIGHT) / R2;
    o.n = vec2f(cos(th), sin(th));
    o.p = vec2f(Y2, BZ) + R2 * o.n;
    o.d = vec2f(sin(th), -cos(th));
  } else if (s < 2.0 * STRAIGHT + ARC2) {
    o.d = vec2f(-cos(PHI), -sin(PHI));
    o.p = vec2f(Y2, BZ) + R2 * nDn + o.d * (s - STRAIGHT - ARC2);
    o.n = nDn;
  } else {
    let th = -(PI * 0.5 - PHI) - (s - 2.0 * STRAIGHT - ARC2) / R1;
    o.n = vec2f(cos(th), sin(th));
    o.p = vec2f(Y1, BZ) + R1 * o.n;
    o.d = vec2f(sin(th), -cos(th));
  }
  return o;
}

struct VOut {
  @builtin(position) clip: vec4f,
  @location(0) world: vec3f,
  @location(1) n: vec3f,
  @location(2) uv: vec2f,
  @location(3) @interpolate(flat) mat: u32,
  @location(4) local: vec3f,
  @location(5) s: f32,
}

@vertex fn vs(@location(0) p0: vec3f, @location(1) n0: vec3f, @location(2) uv: vec2f, @location(3) s: f32, @location(4) id: f32) -> VOut {
  let ids = u32(id + 0.5);
  let mat = ids % 16u;
  let part = ids / 16u;
  var p = p0;
  var n = n0;
  if (mat == MAT_CHAIN) {
    // Each link is rigid: carried from its own spot on the path to the spot the chain has run on to.
    let a = chainPath(s * LOOP);
    let b = chainPath(s * LOOP + V.cordA.w);
    let q = vec2f(-p0.z, p0.y) - a.p;
    let lt = dot(q, a.d);
    let ln = dot(q, a.n);
    let q2 = b.p + b.d * lt + b.n * ln;
    let nq = vec2f(-n0.z, n0.y);
    let nq2 = b.d * dot(nq, a.d) + b.n * dot(nq, a.n);
    p = vec3f(p0.x, q2.y, -q2.x);
    n = vec3f(n0.x, nq2.y, -nq2.x);
  }
  var M = V.saw;
  if (part == ${VM_PART.left}u) { M = V.left; }
  if (part == ${VM_PART.grip}u) { M = V.grip; }
  var cam = (M * vec4f(p, 1.0)).xyz;
  if (mat == MAT_CORD) {
    // The cord stretches from where it leaves the starter to the grip, wherever the hand has it.
    let along = mix(V.cordA.xyz, V.cordB.xyz, s);
    let rest = (V.saw * vec4f(p, 1.0)).xyz - (V.saw * mix(${v4(cord.exit)}, ${v4(cord.end)}, s)).xyz;
    cam = along + rest;
  }
  var o: VOut;
  o.clip = V.proj * vec4f(cam, 1.0);
  // World position where the view puts it: the viewmodel's narrower lens squeezes x and y.
  let seen = vec3f(cam.xy * V.look.x, cam.z);
  o.world = (V.invView * vec4f(seen, 1.0)).xyz;
  o.n = (V.invView * (M * vec4f(n, 0.0))).xyz;
  o.uv = uv;
  o.mat = mat;
  o.local = p0;
  o.s = s;
  return o;
}

struct Lit { diff: vec3f, spec: vec3f }

var<private> gdx: vec2f;
var<private> gdy: vec2f;
var<private> gpx: vec3f;
var<private> gpy: vec3f;

/** Every scene light at p, and a wide spill from beams within a couple of metres (their lamp's side light). */
fn vmLights(p: vec3f, n: vec3f, V0: vec3f, rough: f32, F0: vec3f) -> Lit {
  var out: Lit;
  out.diff = vec3f(0.0); out.spec = vec3f(0.0);
  // The scene's own count clamp (lightSum): the dark slot 0, and the monitor lights only inside their bounds.
  var count = u32(F.screen.z);
  let first = select(0u, 1u, count > 0u && lights[0].color.w <= 0.001);
  if (u32(F.focus.w) < count && (any(p.xz < F.monitorBounds.xy) || any(p.xz > F.monitorBounds.zw))) { count = u32(F.focus.w); }
  pbrRough = rough;
  for (var i = first; i < count; i++) {
    let L = lights[i];
    // Your own helmet lamp shines on the world from down its axis; on the saw it shines from the helmet.
    let back = L.pos.xyz + V.lampBack.xyz;
    let beam = L.cone.w >= 4.5;
    let mine = beam && V.lampBack.w > 0.0 && length(back - V.eye.xyz) < 0.6;
    let toL = select(L.pos.xyz, back, mine) - p;
    let r = L.pos.w;
    if (dot(toL, toL) >= r * r) { continue; }
    let d0 = max(length(toL), 1e-3);
    let ldir = toL / d0;
    var cone = pbrCone(L, ldir, N.pbr.w);
    if (beam) {
      // A torch's own spill ring: close by, it lights what's beside and under it.
      let ax = dot(-ldir, L.cone.xzy);
      cone = max(cone, V.amb.w * smoothstep(-0.2, 0.75, ax) * smoothstep(3.0, 0.6, d0));
    }
    if (cone <= 0.0) { continue; }
    // The range window is the true distance's; the inverse square is never harder than something a couple of metres
    // off (a beam) or a metre (a flare): at a headlamp's 0.4 m it would put the saw far over the forest's exposure.
    let d = max(d0, select(V.pad0.y, V.pad0.x, beam));
    let x = d0 / max(r, 1e-3);
    let win = clamp(1.0 - x * x * x * x, 0.0, 1.0);
    let b = L.cone.w - 7.0;
    let inv = select(1.0 / max(d * d, max(L.extra.z * L.extra.z, 0.01)), 1.0 / (d * d + b * b), L.cone.w >= 6.5);
    let att = L.color.w * win * win * inv * cone * select(1.0, V.lampBack.w, mine);
    if (att <= 1e-7) { continue; }
    let ndl = dot(n, ldir);
    let c = L.color.rgb * att;
    // A little wrap, as the soft gear and the dusty housing scatter.
    out.diff += c * max(ndl * 0.85 + 0.15, 0.0) / PI;
    let sp = pbrSpecular(n, V0, ldir, 0.0, d, L.extra.z);
    out.spec += c * (F0 * sp.x + sp.y);
  }
  return out;
}

fn vmAmbient(n: vec3f) -> vec3f { return V.amb.rgb * N.sky.z * (0.55 + 0.45 * max(n.y, 0.0)); }

fn hash3(p: vec3f) -> f32 { return fract(sin(dot(p, vec3f(127.1, 311.7, 74.7))) * 43758.5453); }
fn vnoise3(p: vec3f) -> f32 {
  let i = floor(p); let f = fract(p); let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash3(i), hash3(i + vec3f(1, 0, 0)), u.x), mix(hash3(i + vec3f(0, 1, 0)), hash3(i + vec3f(1, 1, 0)), u.x), u.y),
             mix(mix(hash3(i + vec3f(0, 0, 1)), hash3(i + vec3f(1, 0, 1)), u.x), mix(hash3(i + vec3f(0, 1, 1)), hash3(i + vec3f(1, 1, 1)), u.x), u.y), u.z);
}
fn fbm3(p: vec3f) -> f32 { return vnoise3(p) * 0.55 + vnoise3(p * 2.03 + 7.1) * 0.3 + vnoise3(p * 4.1 + 3.3) * 0.15; }
fn noiseGrad(p: vec3f) -> vec3f {
  let e = 0.35;
  return vec3f(vnoise3(p + vec3f(e, 0, 0)) - vnoise3(p - vec3f(e, 0, 0)), vnoise3(p + vec3f(0, e, 0)) - vnoise3(p - vec3f(0, e, 0)), vnoise3(p + vec3f(0, 0, e)) - vnoise3(p - vec3f(0, 0, e))) / (2.0 * e);
}
fn bump(n: vec3f, g: vec3f) -> vec3f { return normalize(n + g - n * dot(g, n)); }

/** Tangent-space normal map through the screen-derivative cotangent frame (no tangents in the mesh). */
fn mapNormal(n: vec3f, t: vec3f) -> vec3f {
  let dp2perp = cross(gpy, n);
  let dp1perp = cross(n, gpx);
  let T = dp2perp * gdx.x + dp1perp * gdy.x;
  let B = dp2perp * gdx.y + dp1perp * gdy.y;
  let inv = inverseSqrt(max(max(dot(T, T), dot(B, B)), 1e-20));
  let m = t * 2.0 - 1.0;
  // glTF uv has v down, so the bitangent flips.
  return normalize(T * inv * m.x - B * inv * m.y + n * m.z);
}

fn sampleG(tex: texture_2d<f32>, uv: vec2f) -> vec4f { return textureSampleGrad(tex, samp, uv, gdx, gdy); }

struct Surf { albedo: vec3f, rough: f32, metal: f32, ao: f32, n: vec3f, sheen: f32, f0: f32 }

fn shade(o: VOut, front: bool) -> vec3f {
  let V0 = normalize(V.eye.xyz - o.world);
  var n = normalize(o.n);
  if (!front) { n = -n; }
  var s: Surf;
  s.albedo = vec3f(0.5); s.rough = 0.6; s.metal = 0.0; s.ao = 1.0; s.n = n; s.sheen = 0.0; s.f0 = 0.04;
  let lp = o.local;
  if (o.mat == MAT_HOUSING) {
    // The scan's paint, faded and dulled by years of sun, oil and dust.
    let paint = sampleG(housingBase, o.uv).rgb;
    s.albedo = mix(vec3f(dot(paint, vec3f(0.3, 0.59, 0.11))), paint, 0.75) * 0.8;
    let orm = sampleG(housingOrm, o.uv);
    s.rough = orm.g; s.metal = orm.b;
    s.ao = orm.r;
    s.n = mapNormal(n, sampleG(housingNormal, o.uv).rgb);
  } else if (o.mat == MAT_BAR) {
    s.albedo = sampleG(barBase, o.uv).rgb;
    let orm = sampleG(barOrm, o.uv);
    s.rough = orm.g; s.metal = orm.b;
    s.n = mapNormal(n, sampleG(barNormal, o.uv).rgb);
    // Oil film: a thin wet sheen everywhere the chain throws it.
    s.rough = mix(s.rough, s.rough * 0.6, 0.5 + 0.5 * vnoise3(lp * vec3f(30.0, 300.0, 6.0)));
  } else if (o.mat == MAT_CHAIN) {
    // The build's palette (its UV picks a cell): oily steel, ground chrome on the cutters' edges, dark drive links,
    // rivets; then each link's own dirt, packed sawdust and a dried fleck here and there.
    let cell = u32(o.uv.x * 4.0) + 4u * u32(o.uv.y * 4.0);
    s.albedo = vec3f(0.22, 0.22, 0.225); s.rough = 0.34; s.metal = 1.0;
    if (cell == 1u) { s.albedo = vec3f(0.86, 0.86, 0.87); s.rough = 0.12; }
    if (cell == 2u) { s.albedo = vec3f(0.11, 0.11, 0.115); s.rough = 0.4; }
    if (cell == 3u) { s.albedo = vec3f(0.42, 0.42, 0.43); s.rough = 0.28; }
    let link = hash3(vec3f(floor(o.s * 132.0), 3.1, 7.7));
    let caked = smoothstep(0.75, 0.97, link) * V.look.w * select(1.0, 0.25, cell == 1u);
    s.albedo = mix(s.albedo, vec3f(0.30, 0.22, 0.12), caked * 0.5);
    s.rough = mix(s.rough, 0.8, caked); s.metal = mix(s.metal, 0.2, caked);
    let fleck = step(0.93, hash3(vec3f(floor(o.s * 132.0), 9.2, 1.3))) * V.look.y;
    s.albedo = mix(s.albedo, vec3f(0.08, 0.008, 0.005), fleck * 0.8);
    s.metal = mix(s.metal, 0.2, fleck);
    // Running fast, the links smear into a dull band along the bar.
    let blur = V.cordB.w;
    s.albedo = mix(s.albedo, vec3f(0.2, 0.19, 0.18), blur * 0.85);
    s.rough = mix(s.rough, 0.45, blur);
    s.metal = mix(s.metal, 0.7, blur);
  } else if (o.mat == MAT_GLOVE) {
    // Worn tan leather work gloves, baked under the bar in its maps: creases, grime, oil-dark palms, pale knuckles.
    s.albedo = sampleG(barBase, o.uv).rgb;
    let orm = sampleG(barOrm, o.uv);
    s.ao = orm.r; s.rough = orm.g;
    s.n = mapNormal(n, sampleG(barNormal, o.uv).rgb);
    s.sheen = V.look.z;
    s.f0 = 0.04;
  } else if (o.mat == MAT_SLEEVE) {
    // Buffalo-check flannel: red and near-black blocks, the weave's twill and fuzz, dirt toward the cuff.
    let u = fract(o.uv.x) * 7.0;
    let v = o.uv.y * 9.0;
    // Band edges widen with the pixel footprint, so a sleeve seen edge-on fades to its mean instead of moiré.
    let wu = clamp((abs(gdx.x) + abs(gdy.x)) * 7.0 * 1.5, 0.08, 0.5);
    let wv = clamp((abs(gdx.y) + abs(gdy.y)) * 9.0 * 1.5, 0.08, 0.5);
    let su = smoothstep(0.5 - wu, 0.5 + wu, abs(fract(u) - 0.5) * 2.0);
    let sv = smoothstep(0.5 - wv, 0.5 + wv, abs(fract(v) - 0.5) * 2.0);
    let dark = su + sv;
    let red = vec3f(0.24, 0.022, 0.016);
    s.albedo = mix(red, mix(red * 0.35, vec3f(0.012, 0.01, 0.01), step(1.5, dark)), clamp(dark, 0.0, 1.0));
    let tw = sin((o.uv.x * 900.0 + o.uv.y * 600.0)) * 0.5 + 0.5;
    s.albedo *= 0.85 + 0.25 * mix(tw, 0.5, smoothstep(0.3, 1.0, abs(gdx.x * 900.0 + gdx.y * 600.0) + abs(gdy.x * 900.0 + gdy.y * 600.0)));
    s.n = bump(n, noiseGrad(lp * 1500.0) * 0.25);
    let grime = smoothstep(0.6, 0.0, o.uv.y) * fbm3(lp * 40.0);
    s.albedo = mix(s.albedo, vec3f(0.05, 0.035, 0.025), grime * 0.6);
    s.rough = 0.95;
    s.sheen = 1.2;
    s.f0 = 0.02;
  } else if (o.mat == MAT_GRIP) {
    s.albedo = vec3f(0.024, 0.023, 0.022) * (0.8 + 0.4 * fbm3(lp * 300.0));
    s.n = bump(n, noiseGrad(lp * 3000.0) * 0.3);
    s.rough = 0.72;
  } else if (o.mat == MAT_CORD) {
    let a = atan2(lp.x + lp.z, lp.y) * 3.0 + o.s * 160.0;
    s.albedo = vec3f(0.3, 0.28, 0.2) * (0.75 + 0.25 * sin(a * 2.0)) * 0.7;
    s.rough = 0.85;
  }
  // Sawdust packed into the kerf's mouth round the bar where it enters the wood.
  if (V.trunk.w > 0.5 && (o.mat == MAT_BAR || o.mat == MAT_CHAIN)) {
    let d = length(o.world.xz - V.trunk.xy) - V.trunk.z;
    let k = smoothstep(0.03, 0.0, d);
    s.albedo = mix(s.albedo, vec3f(0.45, 0.33, 0.18), k * 0.85);
    s.metal *= 1.0 - k;
    s.rough = mix(s.rough, 0.9, k);
  }
  let F0 = mix(vec3f(s.f0), s.albedo, s.metal);
  let lit = vmLights(o.world, s.n, V0, s.rough, F0);
  let amb = vmAmbient(s.n) * s.ao;
  var col = s.albedo * (1.0 - s.metal) * (lit.diff * GAIN * mix(1.0, s.ao, 0.6) + amb) + lit.spec * GAIN;
  // Metals need something to reflect: the dim sky, a hint of the ambient.
  col += F0 * amb * 0.6 * s.metal;
  let nv = max(dot(s.n, V0), 0.0);
  col += (lit.diff * GAIN + amb) * s.sheen * 0.35 * pow(1.0 - nv, 4.0) * vec3f(0.9, 0.82, 0.72);
  return col;
}

@fragment fn fs(o: VOut, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  gdx = dpdx(o.uv);
  gdy = dpdy(o.uv);
  gpx = dpdx(o.world);
  gpy = dpdy(o.world);
  pbrAAKernel = pbrSpecularAAKernel(normalize(o.n), 1.0);
  // The bar and chain disappear into the trunk they're cutting.
  if (V.trunk.w > 0.5 && (o.mat == MAT_BAR || o.mat == MAT_CHAIN) && length(o.world.xz - V.trunk.xy) < V.trunk.z) { discard; }
  return vec4f(shade(o, front), 1.0);
}
`
}

/** Premultiplied copy of the resolved overlay onto the scene, drawn over the saw's box (its corner at `at`). */
export const VM_COMPOSITE = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<uniform> at: vec4f;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f { return textureLoad(src, vec2i(pos.xy - at.xy), 0); }
`
