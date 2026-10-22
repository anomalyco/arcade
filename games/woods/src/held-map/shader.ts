import { common } from "@arcade/kit/gpu/shaders"
import { physicalLightWgsl } from "@arcade/kit/gpu/lights/physical"
import { beamWgsl } from "@arcade/kit/gpu/lights/beam"
import { woodsUniformWgsl } from "@arcade/kit/forest/shaders"
import { COMPASS, PLATE_PX } from "./compass-face"
import { MAT } from "./mesh"
import { CAPSULE } from "./props"

/** Floats in the held props' uniform (`Held` below). */
export const HELD_FLOATS = 16 * 3 + 7 * 16 + 20 * 4
const f = (x: number) => x.toFixed(6)

/**
 * The held props' shading, lit like the forest: every scene light in the frame (your torch, friends' torches, the
 * camp's windows and bulbs, the bounce) with the forest's own windowed inverse-square falloff, torch beam profile
 * and GAIN, so the sheet is readable only where light falls on it. Group 0 is the scene's frame; group 1 the props.
 *
 * Paper: printed and pencil layers (graphite only on the paper's tooth), fibre and crease normals, a soft sheen,
 * graphite's dull metallic glint, translucency when lit from behind, torn edges by sample-mask coverage, analytic soft
 * shadows from the hands, the bezel and the clear plate (its printed markings cast fine shadows). Compass: clear
 * acrylic with Fresnel, a bevel that catches the torch and edges that refract the map beneath, a ridged bezel, the
 * capsule floor showing the map refracted through the liquid, a painted needle with luminous tip, a bubble. Gloves:
 * pebbled leather with creases at the joints, stitched seams, scuffed wear and a soft sheen. Your own torch's beam is
 * flattened on the props while reading (`own.w`) so its hot spot stays readable.
 */
export const heldShader = /* wgsl */ `
${common}
${woodsUniformWgsl}
${physicalLightWgsl}
${beamWgsl}
fn pbrStreetCone(ldir: vec3f, arm: vec2f) -> f32 { return 1.0; }
fn pbrBeamA() -> vec4f { return N.beamA; }
fn pbrBeamB() -> vec4f { return N.beamB; }

struct Held {
  proj: mat4x4f,
  invView: mat4x4f,
  plateInv: mat4x4f,   // world → compass-local (plate centre on its underside, m)
  obj: array<mat4x4f, 7>,
  eye: vec4f,          // world eye, time
  amb: vec4f,          // ambient rgb, own torch level
  paper: vec4f,        // sheet w, h (m), translucency, sheen
  look: vec4f,         // crease strength, fibre strength, pencil sheen, print mip bias
  floorU: vec4f,       // bezel-local (x, y) m → sheet uv: u = dot(xy1, floorU.xyz)
  floorV: vec4f,       // v = dot(xy1, floorV.xyz); w: paper depth below the capsule floor (m)
  bezelEye: vec4f,     // eye in bezel-local metres; w: luminous paint glow
  occ: array<vec4f, 5>, // occluder spheres: world centre, radius
  disk: vec4f,         // bezel occluder: world centre, outer radius
  diskN: vec4f,        // its world normal, inner radius
  glove: vec4f,        // glove albedo (linear rgb), lens glow
  own: vec4f,          // your torch's lens (world), beam profile exponent on the props
  plateU: vec4f,       // compass-local (x, y) m → sheet uv: u = dot(xy1, plateU.xyz)
  plateV: vec4f,       // v = dot(xy1, plateV.xyz)
  leather: vec4f,      // sheen, wear, your torch's near limit on the props (m)
}
@group(1) @binding(0) var<uniform> H: Held;
@group(1) @binding(1) var samp: sampler;
@group(1) @binding(2) var sampWrap: sampler;
@group(1) @binding(3) var printTex: texture_2d<f32>;
@group(1) @binding(4) var pencilTex: texture_2d<f32>;
@group(1) @binding(5) var fibreTex: texture_2d<f32>;
@group(1) @binding(6) var faceTex: texture_2d<f32>;

struct VOut {
  @builtin(position) clip: vec4f,
  @location(0) world: vec3f,
  @location(1) n: vec3f,
  @location(2) uv: vec2f,
  @location(3) t: vec3f,
  @location(4) @interpolate(flat) mat: u32,
  @location(5) local: vec3f,
}

@vertex fn vs(@location(0) p: vec3f, @location(1) n: vec3f, @location(2) uv: vec2f, @location(3) t: vec3f, @location(4) id: f32) -> VOut {
  let ids = u32(id + 0.5);
  let M = H.obj[ids / 32u];
  let cam = M * vec4f(p, 1.0);
  var o: VOut;
  o.clip = H.proj * cam;
  o.world = (H.invView * cam).xyz;
  o.n = (H.invView * (M * vec4f(n, 0.0))).xyz;
  o.t = (H.invView * (M * vec4f(t, 0.0))).xyz;
  o.uv = uv;
  o.mat = ids % 32u;
  o.local = p;
  return o;
}

struct Lit { diff: vec3f, back: vec3f, spec: vec3f }

// Screen derivatives taken at the top of each fragment entry (uniform control flow); every lookup inside a material
// branch samples with explicit gradients.
var<private> gdx: vec2f;
var<private> gdy: vec2f;
var<private> gmpp: f32;
var<private> gEdge: vec2f;

fn bias(k: f32) -> f32 { return exp2(H.look.w) * k; }
fn sampleSheet(tex: texture_2d<f32>, uv: vec2f, k: f32) -> vec4f { return textureSampleGrad(tex, samp, uv, gdx * bias(k), gdy * bias(k)); }
/** A lookup at uv whose footprint is about gmpp metres across, over a texture spanning \`span\` metres. */
fn sampleIso(tex: texture_2d<f32>, uv: vec2f, span: vec2f) -> vec4f {
  let d = gmpp / span;
  return textureSampleGrad(tex, samp, uv, vec2f(d.x, 0.0) * exp2(H.look.w), vec2f(0.0, d.y) * exp2(H.look.w));
}

/** Soft analytic shadow along ldir from p (length d): the hands' spheres and the bezel ring. */
fn heldShadow(p: vec3f, ldir: vec3f, d: f32, size: f32) -> f32 {
  var s = 1.0;
  for (var k = 0u; k < 5u; k++) {
    let o = H.occ[k];
    if (o.w <= 0.0) { continue; }
    let to = o.xyz - p;
    let t = dot(to, ldir);
    if (t <= 0.0 || t >= d) { continue; }
    let h = length(to - ldir * t);
    let pen = o.w * 0.25 + t * size / max(d - t, 0.02);
    s *= smoothstep(o.w - pen, o.w + pen, h);
  }
  let dn = dot(ldir, H.diskN.xyz);
  if (abs(dn) > 1e-3) {
    let t = dot(H.disk.xyz - p, H.diskN.xyz) / dn;
    if (t > 0.0005 && t < d) {
      let r = length(p + ldir * t - H.disk.xyz);
      let pen = 0.0004 + t * size / max(d - t, 0.02);
      let ring = smoothstep(H.diskN.w - pen, H.diskN.w + pen, r) * (1.0 - smoothstep(H.disk.w - pen, H.disk.w + pen, r));
      // The capsule lets most light through (a little lost to the liquid and the floor print).
      let inner = 1.0 - smoothstep(H.diskN.w - pen, H.diskN.w + pen, r);
      s *= 1.0 - ring * 0.97 - inner * 0.12;
    }
  }
  // The clear plate: a faint shadow, a dark line where its bevelled edge bends the light away, and its printed
  // markings' own fine shadows (the ink is on the underside, so they sit just off the lines).
  let q = (H.plateInv * vec4f(p, 1.0)).xyz;
  let lq = (H.plateInv * vec4f(ldir, 0.0)).xyz;
  if (lq.z > 1e-3) {
    let tp = (0.0002 - q.z) / lq.z;
    if (tp > -0.0005 && tp < d) {
      let h = q.xy + lq.xy * max(tp, 0.0);
      let hb = vec2f(${f(COMPASS.plate.w / 2000)}, ${f(COMPASS.plate.l / 2000)});
      let rr = ${f(COMPASS.plate.r / 1000)};
      let k = abs(h) - hb + vec2f(rr);
      let sd = length(max(k, vec2f(0.0))) + min(max(k.x, k.y), 0.0) - rr;
      let inside = 1.0 - smoothstep(-0.0001, 0.0001, sd);
      let mm = h * 1000.0;
      let ink = textureSampleLevel(faceTex, samp, vec2f((512.0 + mm.x * ${f(PLATE_PX)}) / 2048.0, (1024.0 - mm.y * ${f(PLATE_PX)}) / 2048.0), 1.0).a;
      // The ink lies on the paper, so its shadow only shows where raking light throws it a little aside; far-thrown
      // copies (the plate's left rulers under a low beam) fade, as the lens's penumbra would blur them.
      let off = length(lq.xy) * max(tp, 0.0);
      s *= 1.0 - inside * (0.06 + 0.55 * ink * exp(-off * off / 1.0e-6));
      // A thin contact shadow hugging the rim where the plate's edge meets the paper.
      let kq = abs(q.xy) - hb + vec2f(rr);
      let sdq = length(max(kq, vec2f(0.0))) + min(max(kq.x, kq.y), 0.0) - rr;
      s *= 1.0 - 0.3 * exp(-max(sdq, 0.0) / 0.0006) * smoothstep(-0.0002, 0.0, sdq) * smoothstep(0.002, 0.0, abs(q.z));
    }
  }
  return s;
}

/** Every scene light at p: Lambert front and back (for translucency) and GGX specular with roughness rough. */
fn heldLights(p: vec3f, n: vec3f, V: vec3f, rough: f32, shadows: bool) -> Lit {
  var out: Lit;
  out.diff = vec3f(0.0); out.back = vec3f(0.0); out.spec = vec3f(0.0);
  let count = u32(F.screen.z);
  pbrRough = rough;
  for (var i = 0u; i < count; i++) {
    let L = lights[i];
    let toL = L.pos.xyz - p;
    let d = max(length(toL), 1e-3);
    let ldir = toL / d;
    var cone = pbrCone(L, ldir, N.pbr.w);
    var dl = d;
    // Your torch on the props while reading: a flatter profile and no closer than the near limit, a local exposure
    // that keeps the raking pool's near end from burning out.
    if (distance(L.pos.xyz, H.own.xyz) < 0.01) { cone = pow(max(cone, 0.0), H.own.w); dl = max(d, H.leather.z); }
    var att = L.color.w * pbrLightFalloff(L, dl, L.pos.w) * cone;
    if (att <= 1e-7) { continue; }
    if (shadows) { att *= heldShadow(p, ldir, d, max(L.extra.z, 0.01)); }
    let ndl = dot(n, ldir);
    let c = L.color.rgb * att;
    out.diff += c * max(ndl, 0.0) / PI;
    out.back += c * max(-ndl, 0.0) / PI;
    let sp = pbrSpecular(n, V, ldir, 0.0, d, L.extra.z);
    out.spec += c * (sp.x + sp.y);
  }
  return out;
}

fn heldAmbient(n: vec3f) -> vec3f { return H.amb.rgb * N.sky.z * (0.6 + 0.4 * max(n.y, 0.0)); }

/** Round-the-tube coordinate made periodic for noise (uv.x wraps at 1). */
fn ux8(x: f32) -> f32 { return sin(x * 6.2831853) * 0.5 + 0.5; }

fn fresnel(nv: f32, f0: f32) -> f32 { let x = 1.0 - nv; let x2 = x * x; return f0 + (1.0 - f0) * x2 * x2 * x; }

fn hash3(p: vec3f) -> f32 { return fract(sin(dot(p, vec3f(127.1, 311.7, 74.7))) * 43758.5453); }
fn vnoise3(p: vec3f) -> f32 {
  let i = floor(p); let f = fract(p); let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash3(i), hash3(i + vec3f(1, 0, 0)), u.x), mix(hash3(i + vec3f(0, 1, 0)), hash3(i + vec3f(1, 1, 0)), u.x), u.y),
             mix(mix(hash3(i + vec3f(0, 0, 1)), hash3(i + vec3f(1, 0, 1)), u.x), mix(hash3(i + vec3f(0, 1, 1)), hash3(i + vec3f(1, 1, 1)), u.x), u.y), u.z);
}
/** Gradient of value noise by central differences (bump normals for leather and fabric). */
fn noiseGrad(p: vec3f) -> vec3f {
  let e = 0.35;
  return vec3f(vnoise3(p + vec3f(e, 0, 0)) - vnoise3(p - vec3f(e, 0, 0)), vnoise3(p + vec3f(0, e, 0)) - vnoise3(p - vec3f(0, e, 0)), vnoise3(p + vec3f(0, 0, e)) - vnoise3(p - vec3f(0, 0, e))) / (2.0 * e);
}

/** The printed sheet at uv with pencil over it: albedo, graphite share, alpha. */
fn sheetAt(uv: vec2f) -> vec4f {
  let pr = sampleSheet(printTex, uv, 1.0);
  var pc = sampleSheet(pencilTex, uv, 1.0);
  // Graphite catches only the fibre tops (fades to its average once a pixel spans several).
  let tooth = 0.62 + 0.38 * vnoise3(vec3f(uv * H.paper.xy * 7000.0, 0.0));
  pc.a *= mix(tooth, 0.81, smoothstep(0.00008, 0.00025, gmpp));
  return vec4f(mix(pr.rgb, pc.rgb, pc.a), pc.a);
}
/** The same through the capsule (refracted uv, no screen derivatives of its own). */
fn sheetIso(uv: vec2f) -> vec4f {
  let span = H.paper.xy;
  let pr = sampleIso(printTex, uv, span);
  let pc = sampleIso(pencilTex, uv, span);
  return vec4f(mix(pr.rgb, pc.rgb, pc.a), pc.a);
}

/** Paper normal: geometry, fibre tooth and the creases' crisp ridges and valleys. */
fn paperNormal(ng: vec3f, t: vec3f, uv: vec2f) -> vec3f {
  let b = normalize(cross(ng, t));
  let wmm = H.paper.x * 1000.0;
  let hmm = H.paper.y * 1000.0;
  let k = vec2f(wmm, hmm) / 30.0;
  let f = textureSampleGrad(fibreTex, sampWrap, uv * k, gdx * k, gdy * k).xy * 2.0 - 1.0;
  var dn = (t * f.x - b * f.y) * H.look.y;
  // Creases at thirds: across (u) a mountain then a valley, down (v) a valley then a mountain.
  let cu = array<f32, 2>(1.0 / 3.0, 2.0 / 3.0);
  for (var k = 0; k < 2; k++) {
    let du = (uv.x - cu[k]) * wmm;
    let su = select(-1.0, 1.0, k == 0);
    dn += t * su * H.look.x * (du / 0.45) * exp(-(du * du) / 0.2);
    let dv = (uv.y - cu[k]) * hmm;
    let sv = select(1.0, -1.0, k == 0);
    dn += b * sv * H.look.x * 0.7 * (dv / 0.45) * exp(-(dv * dv) / 0.2);
  }
  return normalize(ng + dn);
}

fn shadePaper(world: vec3f, ng0: vec3f, t: vec3f, uv: vec2f, front: bool, V: vec3f) -> vec4f {
  let s = sheetAt(uv);
  let a = gEdge.x;
  var ng = normalize(ng0);
  if (!front) { ng = -ng; }
  var albedo = s.rgb;
  var graphite = s.a;
  if (!front) {
    // The back is blank stock; the print shows through faintly.
    albedo = vec3f(0.78, 0.74, 0.64) * mix(vec3f(1.0), s.rgb / vec3f(0.8, 0.76, 0.66), 0.12);
    graphite = 0.0;
  }
  let n = paperNormal(ng, t, uv);
  let paperLit = heldLights(world, n, V, mix(0.72, 0.42, graphite), true);
  // Paper is rough with a faint sheen; graphite is a dull metal with a grey glint.
  let f0 = mix(0.035, 0.2, graphite * H.look.z);
  let spec = paperLit.spec * GAIN * f0 * mix(H.paper.w, 1.4, graphite);
  let trans = paperLit.back * H.paper.z * albedo;
  var col = albedo * (paperLit.diff * GAIN + heldAmbient(n)) + trans * GAIN + spec;
  // Coverage from the torn edges, sharpened (it becomes the sample mask).
  let cov = clamp((a - 0.5) / max(gEdge.y, 1e-4) + 0.5, 0.0, 1.0);
  return vec4f(col, cov);
}

const MAT_PAPER: u32 = ${MAT.paper}u;
const MAT_ACRYLIC: u32 = ${MAT.acrylic}u;
const MAT_BEZEL_TOP: u32 = ${MAT.bezelTop}u;
const MAT_FLOOR: u32 = ${MAT.floor}u;
const MAT_GLASS: u32 = ${MAT.glass}u;
const MAT_NEEDLE: u32 = ${MAT.needle}u;
const MAT_METAL: u32 = ${MAT.metal}u;
const MAT_GLOVE: u32 = ${MAT.glove}u;
const MAT_TORCH: u32 = ${MAT.torch}u;
const MAT_LENS: u32 = ${MAT.lens}u;
const MAT_CORD: u32 = ${MAT.cord}u;
const MAT_SLEEVE: u32 = ${MAT.sleeve}u;
const MAT_BUBBLE: u32 = ${MAT.bubble}u;
const MAT_BEZEL_SIDE: u32 = ${MAT.bezelSide}u;
const MAT_PLATE_EDGE: u32 = ${MAT.plateEdge}u;
const MAT_JEWEL: u32 = ${MAT.jewel}u;

/** Opaque surfaces: lit colour and coverage. */
fn shadeOpaque(o: VOut, front: bool) -> vec4f {
  let V = normalize(H.eye.xyz - o.world);
  var n = normalize(o.n);
  if (dot(n, V) < 0.0 && o.mat != MAT_PAPER) { n = -n; }
  if (o.mat == MAT_PAPER) { return shadePaper(o.world, o.n, normalize(o.t), o.uv, front, V); }

  var albedo = vec3f(0.5);
  var rough = 0.5;
  var f0 = 0.04;
  var metal = 0.0;
  var emit = vec3f(0.0);
  var shadows = false;
  var sheen = 0.0;
  if (o.mat == MAT_BEZEL_TOP) {
    albedo = textureSampleGrad(faceTex, samp, o.uv, gdx * bias(1.0), gdy * bias(1.0)).rgb;
    rough = 0.38;
    // Luminous dots at N, E, S, W.
    let r = length(o.local.xy);
    let ang = atan2(o.local.x, o.local.y);
    let q = fract(ang / (PI * 0.5) + 0.5) - 0.5;
    let dot4 = smoothstep(0.0009, 0.0006, length(vec2f(q * PI * 0.5 * r, r - 0.0215)));
    emit += vec3f(0.35, 0.75, 0.45) * dot4 * H.bezelEye.w;
    albedo = mix(albedo, vec3f(0.7, 0.85, 0.65), dot4);
  } else if (o.mat == MAT_BEZEL_SIDE) {
    albedo = vec3f(0.018, 0.018, 0.02);
    rough = 0.42;
    rough = 0.3;
  } else if (o.mat == MAT_FLOOR) {
    return shadeFloor(o, V);
  } else if (o.mat == MAT_NEEDLE) {
    let north = o.uv.y > 0.0;
    albedo = select(vec3f(0.78, 0.77, 0.72), vec3f(0.6, 0.035, 0.025), north);
    rough = 0.3;
    let tip = smoothstep(0.72, 0.8, o.uv.y) * (1.0 - smoothstep(0.9, 0.95, o.uv.y));
    emit += vec3f(0.35, 0.75, 0.45) * tip * H.bezelEye.w;
    albedo = mix(albedo, vec3f(0.75, 0.85, 0.7), tip * 0.8);
  } else if (o.mat == MAT_METAL || o.mat == MAT_JEWEL) {
    albedo = select(vec3f(0.75, 0.74, 0.72), vec3f(0.55, 0.06, 0.05), o.mat == MAT_JEWEL);
    metal = select(1.0, 0.0, o.mat == MAT_JEWEL);
    rough = select(0.22, 0.12, o.mat == MAT_JEWEL);
  } else if (o.mat == MAT_GLOVE) {
    // Worn leather. uv.y on fingers = joint index + share of the phalanx (creases at whole numbers), ≥ 10 on the cuff;
    // uv.x runs round the tube (seams at ¼ and ¾). Pebbled grain everywhere; bunched wrinkles across each joint on the
    // inside of the bend; raised welted seams with stitching; a turned cuff with a stitched band; scuffs where it rubs.
    let T = normalize(o.t - n * dot(o.t, n));
    let Bt = cross(n, T);
    let fingerish = step(o.uv.y, 9.0);
    let cuff = step(10.0, o.uv.y);
    let ux = fract(o.uv.x);
    let jf = fract(o.uv.y);
    let jd = min(jf, 1.0 - jf);
    let joint = exp(-jd * jd / 0.012) * fingerish * step(0.05, o.uv.y);
    // Grain: two octaves of pebbles, strong.
    var dn = noiseGrad(o.local * 3400.0) * 0.26 + noiseGrad(o.local * 900.0) * 0.16;
    // Joint wrinkles: 3–4 deep folds across the finger, strongest on the inside half, wandering a little.
    let inside = 0.5 + 0.5 * cos((ux - 0.5) * 6.2831853);
    let wob = vnoise3(o.local * 600.0) * 1.6;
    let phase = (o.uv.y - round(o.uv.y)) * 34.0 + wob;
    let fold = sin(phase) * joint * (0.35 + 0.65 * inside);
    dn += T * cos(phase) * joint * (0.35 + 0.65 * inside) * 1.1;
    // Fine wrinkles along the whole finger (leather that has been flexed for years).
    let fine = sin(o.uv.y * 140.0 + vnoise3(o.local * 300.0) * 5.0) * fingerish * 0.12;
    dn += T * fine;
    // Welted seams: a raised ridge with a groove each side and stitches along it.
    let c = select(0.75, 0.25, ux < 0.5);
    let sx = (ux - c) * 40.0;
    let welt = exp(-sx * sx * 4.0) - 0.6 * exp(-(abs(sx) - 0.6) * (abs(sx) - 0.6) * 30.0);
    dn += Bt * (-sx * 8.0 * exp(-sx * sx * 4.0)) * 0.25 * fingerish;
    let stitch = fingerish * step(0.5, fract(o.uv.y * 26.0)) * exp(-(abs(sx) - 0.45) * (abs(sx) - 0.45) * 60.0);
    // Cuff: a stitched band at the wrist and the turned edge.
    let band = cuff * exp(-pow((o.uv.y - 10.3) * 30.0, 2.0));
    let bandStitch = cuff * step(0.5, fract(ux * 90.0)) * exp(-pow((o.uv.y - 10.38) * 80.0, 2.0));
    dn += T * band * 0.8;
    n = normalize(n + dn - n * dot(dn, n));
    let wear = H.leather.y;
    let scuff = smoothstep(0.55, 0.85, vnoise3(o.local * 160.0)) * wear;
    let tone = 0.75 + 0.5 * vnoise3(o.local * 60.0);
    albedo = H.glove.rgb * tone;
    // Rubbed high spots and knuckles go lighter and duller; fold valleys and seams collect dirt.
    albedo = mix(albedo, albedo * 1.6 + vec3f(0.01, 0.008, 0.005), clamp(scuff * 0.6 + joint * (1.0 - inside) * 0.5 * wear + welt * 0.25 * fingerish, 0.0, 1.0));
    albedo *= 1.0 - 0.45 * max(-fold, 0.0) - 0.4 * stitch - 0.35 * bandStitch;
    rough = mix(0.62, 0.85, scuff) - 0.08 * max(fold, 0.0);
    f0 = 0.035;
    sheen = H.leather.x;
    shadows = false;
  } else if (o.mat == MAT_SLEEVE) {
    let g = noiseGrad(o.local * 2200.0) * 0.25;
    n = normalize(n + g - n * dot(g, n));
    albedo = vec3f(0.035, 0.04, 0.03) * (0.85 + 0.3 * vnoise3(o.local * 60.0));
    rough = 0.9;
  } else if (o.mat == MAT_TORCH) {
    albedo = vec3f(0.018, 0.018, 0.02);
    rough = 0.3;
    f0 = 0.06;
    // Knurled grip on the barrel.
    if (o.uv.y > 0.25 && o.uv.y < 0.62) {
      let a = o.uv.x * 6.2831853 * 40.0;
      let k = sin(a + o.local.y * 2400.0) + sin(a - o.local.y * 2400.0);
      n = normalize(n + normalize(o.t) * k * 0.35);
      rough = 0.45;
    }
    // The bezel ring at the head is bare aluminium.
    if (o.uv.y > 0.9) { albedo = vec3f(0.6); metal = 1.0; rough = 0.25; }
  } else if (o.mat == MAT_LENS) {
    albedo = vec3f(0.02);
    rough = 0.05;
    let r = length(o.local.xz) / 0.0168;
    // The reflector: bright rings and the LED, seen when you look into the beam.
    emit = vec3f(1.0, 0.97, 0.92) * H.glove.w * (smoothstep(0.35, 0.0, r) * 6.0 + 0.6 * (0.5 + 0.5 * sin(r * 40.0)) * smoothstep(1.0, 0.3, r));
  } else if (o.mat == MAT_CORD) {
    albedo = vec3f(0.02, 0.02, 0.022);
    rough = 0.65;
    let a = o.uv.x * 6.2831853 * 3.0 + o.uv.y * 2600.0;
    n = normalize(n + normalize(o.t) * sin(a) * 0.4);
  }
  let lit = heldLights(o.world, n, V, rough, shadows);
  let F = mix(vec3f(f0), albedo, metal);
  var col = albedo * (1.0 - metal) * (lit.diff * GAIN + heldAmbient(n)) + lit.spec * GAIN * F + emit;
  // Sheen: a dull lift at grazing angles (worn leather).
  let nv = max(dot(n, V), 0.0);
  col += (lit.diff * GAIN + heldAmbient(n)) * sheen * 0.5 * pow(1.0 - nv, 4.0) * vec3f(0.9, 0.82, 0.72);
  return vec4f(col, 1.0);
}

/**
 * The capsule floor: the map seen through it, refracted by the liquid (its rim magnified), under the floor's printed
 * meridians and orienting arrow.
 */
fn shadeFloor(o: VOut, V: vec3f) -> vec4f {
  let d = normalize(o.local - H.bezelEye.xyz);
  let top = ${f(CAPSULE.glass)};
  let floorZ = o.local.z;
  // Back along the view ray to the glass, then down through the liquid (n ≈ 1.4).
  let g = o.local - d * ((top - floorZ) / max(-d.z, 0.05));
  let dt = refract(d, vec3f(0.0, 0.0, 1.0), 1.0 / 1.4);
  var hit = g + dt * ((top - floorZ) / max(-dt.z, 0.05));
  let R = ${f(COMPASS.bezel.inner / 1000)};
  let rr = length(hit.xy) / R;
  hit = vec3f(hit.xy * (1.0 - 0.14 * pow(rr, 6.0)), floorZ);
  let paper = hit + dt * (H.floorV.w / max(-dt.z, 0.05));
  let uvMap = vec2f(dot(vec3f(paper.xy, 1.0), H.floorU.xyz), dot(vec3f(paper.xy, 1.0), H.floorV.xyz));
  let s = sheetIso(uvMap);
  var nUp = normalize(o.n);
  if (dot(nUp, V) < 0.0) { nUp = -nUp; }
  let lit = heldLights(o.world, nUp, V, 0.7, false);
  let liquid = vec3f(0.93, 0.94, 0.88);
  var col = s.rgb * (lit.diff * GAIN + heldAmbient(nUp)) * liquid * 0.92;
  // The floor print (its uv follows the refracted hit, so the arrow swims a little at an angle).
  let fuv = vec2f((1536.0 + hit.x * 1000.0 * ${(512 / 23.5).toFixed(6)}) / 2048.0, (1536.0 - hit.y * 1000.0 * ${(512 / 23.5).toFixed(6)}) / 2048.0);
  let ink = sampleIso(faceTex, fuv, vec2f(2.048 / ${(512 / 23.5).toFixed(6)}));
  col = mix(col, ink.rgb * (lit.diff * GAIN + heldAmbient(nUp)), ink.a);
  // Total internal reflection brightens the rim of the liquid.
  col += lit.diff * GAIN * 0.25 * smoothstep(0.85, 1.0, rr);
  return vec4f(col, 1.0);
}

/** Clear surfaces, premultiplied: acrylic plate and edges, capsule glass, the bubble. */
fn shadeClear(o: VOut) -> vec4f {
  let V = normalize(H.eye.xyz - o.world);
  var n = normalize(o.n);
  if (dot(n, V) < 0.0) { n = -n; }
  let nv = max(dot(n, V), 1e-3);
  if (o.mat == MAT_ACRYLIC) {
    let ink = textureSampleGrad(faceTex, samp, o.uv, gdx, gdy);
    let lit = heldLights(o.world, n, V, 0.05, false);
    let f = fresnel(nv, 0.04);
    let inkCol = ink.rgb * (lit.diff * GAIN + heldAmbient(n));
    let col = inkCol * ink.a + lit.spec * GAIN * 0.04 + heldAmbient(n) * f * 2.0;
    return vec4f(col, ink.a + (1.0 - ink.a) * (0.04 + f * 0.5));
  }
  if (o.mat == MAT_PLATE_EDGE) {
    // The bevel and polished side: the view ray refracts into the acrylic and lands on the map beside where it would
    // (the edge reads as a displaced, darker band of map), with a sharp highlight on the 45° bevel.
    let bevel = o.uv.y > 1.25;
    let lit = heldLights(o.world, n, V, select(0.08, 0.05, bevel), false);
    let vl = normalize((H.plateInv * vec4f(-V, 0.0)).xyz);
    let nl = normalize((H.plateInv * vec4f(n, 0.0)).xyz);
    let r = refract(vl, nl, 1.0 / 1.49);
    let q = (H.plateInv * vec4f(o.world, 1.0)).xyz;
    let up = H.diskN.xyz;
    var under = vec3f(0.0);
    var a = 0.55;
    if (r.z < -0.05 && dot(r, r) > 0.0) {
      let hit = q.xy + r.xy * (q.z / -r.z);
      let uv = vec2f(dot(vec3f(hit, 1.0), H.plateU.xyz), dot(vec3f(hit, 1.0), H.plateV.xyz));
      let pl = heldLights(o.world, up, V, 0.7, false);
      under = sheetIso(uv).rgb * (pl.diff * GAIN + heldAmbient(up)) * vec3f(0.8, 0.86, 0.84);
      a = 0.9;
    }
    let fr = fresnel(max(dot(n, V), 1e-3), 0.04);
    let piped = heldLights(o.world, up, V, 0.5, false).diff * GAIN * 0.1 * vec3f(0.75, 1.0, 0.95);
    let col = under * a * (1.0 - fr) + lit.spec * GAIN * select(0.06, 0.12, bevel) + piped + heldAmbient(n) * fr * 2.0;
    return vec4f(col, a);
  }
  if (o.mat == MAT_GLASS) {
    let lit = heldLights(o.world, n, V, 0.025, false);
    let f = fresnel(nv, 0.04);
    let col = lit.spec * GAIN * 0.04 + heldAmbient(n) * f * 3.0;
    return vec4f(col, 0.02 + f * 0.6);
  }
  // Bubble: a bright rim and a pin highlight.
  let lit = heldLights(o.world, n, V, 0.04, false);
  let rim = pow(1.0 - nv, 2.0);
  let col = lit.spec * GAIN * 0.06 + (lit.diff + lit.back) * GAIN * rim * 0.25;
  return vec4f(col, 0.12 + rim * 0.55);
}

fn derivatives(o: VOut) {
  gdx = dpdx(o.uv);
  gdy = dpdy(o.uv);
  gmpp = max(length(dpdx(o.world)), length(dpdy(o.world)));
  let a = textureSampleGrad(printTex, samp, o.uv, gdx * bias(1.0), gdy * bias(1.0)).a;
  gEdge = vec2f(a, fwidth(a));
}
struct OpaqueOut { @location(0) color: vec4f, @builtin(sample_mask) mask: u32 }
/** Opaque: coverage (the torn edges) becomes a sample mask of the 4× target, so edges resolve soft. */
@fragment fn fsOpaque(o: VOut, @builtin(front_facing) front: bool) -> OpaqueOut {
  derivatives(o);
  let c = shadeOpaque(o, front);
  let k = u32(clamp(c.a * 4.0 + 0.5, 0.0, 4.0));
  if (k == 0u) { discard; }
  var out: OpaqueOut;
  out.color = vec4f(c.rgb, 1.0);
  out.mask = (1u << k) - 1u;
  return out;
}
@fragment fn fsClear(o: VOut) -> @location(0) vec4f { derivatives(o); return shadeClear(o); }
`
