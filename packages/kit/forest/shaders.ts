/**
 * WGSL of the night forest. One scene shader (the kit's `makeSceneShader` with physical lights, spot shadows and the
 * fog port) draws every static surface from three texture arrays, by material:
 *
 * - terrain: needle litter at two scales and rotations (no visible tiling), height-blended with moss and trail scans
 *   by the vertex weights, shore mud darkened and smoothed;
 * - bark: scanned bark with a moss overlay that favours the north-facing lower trunk and the tops of logs;
 * - needles and ferns: cut-outs with alpha sharpened to the pixel and alpha-to-coverage (no shimmer, no hard
 *   aliased edges), coverage held up at far mips, thin-leaf translucency so a torch behind a frond lights it through;
 * - water, lit windows, bulbs, tape and paint.
 *
 * Wind is three layers in the vertex stage (RESEARCH.md): trunk sway 0.1–0.2 Hz on the square of the height share,
 * branch sway 0.3–0.6 Hz along each limb with a phase from its position, and needle flutter 2–4 Hz at card tips,
 * all scaled by a slow travelling gust.
 */
import type { SceneHooks } from "../gpu/shaders"
import { common } from "../gpu/shaders"
import { withPhysicalLights } from "../gpu/lights/physical"
import { fogParamsWgsl, fogSceneWgsl } from "../gpu/fog-scatter"
import { beamWgsl } from "../gpu/lights/beam"
import { spotShadowWgsl } from "../gpu/shadows/spot-shadows"
import { ALPHA_COVERAGE } from "./alpha-coverage"
import { LAYER } from "./assets"
import { MAT } from "./build"

/** Mip levels of the coverage table the shader uses: past 7 (8² texels a card) the atlas-wide share is noise. */
const COVERAGE_LEVELS = 8

/** Cells per side of the eye-centred ground grid in the custom uniform (the mist bank's floor), and their size (m). */
export const GROUND_CELLS = 18
export const GROUND_CELL = 10
/** Floats in the forest's custom uniform (binding 13): the named slots, the grid's origin, then its heights. */
export const WOODS_FLOATS = 84 + GROUND_CELLS * GROUND_CELLS

export const woodsUniformWgsl = /* wgsl */ `
struct Woods {
  wind: vec4f,        // dir x, dir z, strength, gust
  sway: vec4f,        // trunk, branch, flutter, exposure the post pass applies
  moon: vec4f,        // dir xyz, strength
  sky: vec4f,         // sky glow, stars, skylight, moss
  camp: vec4f,        // windows, string lights, water, lake level
  lake: vec4f,        // centre x, z, radii x, z
  field: vec4f,       // field map x0, z0, 1/size, -
  torch: vec4f,       // local torch position, on
  torchDir: vec4f,    // axis, half-angle (rad)
  torchCol: vec4f,    // colour × intensity, range
  motes: vec4f,       // strength, pixel angle (rad), frame light index of the torch, -
  pbr: vec4f,         // physical knobs (specular AA, sphere lights, env, spill)
  beamA: vec4f,
  beamB: vec4f,
  invViewProj: mat4x4f,
  misc: vec4f,        // texture size, alpha cutoff, mips below the coverage table's base, -
  pad: vec4f,         // clear air near the eye, distance density, clear distance, -
  groundAt: vec4f,    // ground grid x0, z0, 1/cell, -
  ground: array<vec4f, ${(GROUND_CELLS * GROUND_CELLS) / 4}>,
}
@group(0) @binding(13) var<uniform> N: Woods;
fn woodsGroundCell(i: i32, j: i32) -> f32 {
  let k = clamp(j, 0, ${GROUND_CELLS - 1}) * ${GROUND_CELLS} + clamp(i, 0, ${GROUND_CELLS - 1});
  return N.ground[k / 4][k % 4];
}
/** Ground height near the eye from the coarse grid (bilinear; clamped at its edge). */
fn woodsGround(xz: vec2f) -> f32 {
  let g = (xz - N.groundAt.xy) * N.groundAt.z - 0.5;
  let i = vec2i(floor(g));
  let f = fract(g);
  return mix(mix(woodsGroundCell(i.x, i.y), woodsGroundCell(i.x + 1, i.y), f.x), mix(woodsGroundCell(i.x, i.y + 1), woodsGroundCell(i.x + 1, i.y + 1), f.x), f.y);
}
`

/** Night sky: airglow, a faint town glow low in one direction, stars that stay one pixel wide, an optional moon. */
export const woodsSkyWgsl = /* wgsl */ `
fn woodsStarCell(g: vec2f, face: f32, pix: f32, cells: f32) -> vec3f {
  let id = floor(g);
  var sum = vec3f(0.0);
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let cid = id + vec2f(f32(x), f32(y));
      let h = hash2(cid * 0.7 + face * 17.31);
      if (h > 0.42) { continue; }
      let pos = cid + vec2f(hash2(cid * 1.7 + face * 3.1), hash2(cid * 2.3 + face * 5.7));
      let d = length(g - pos) / cells;
      let mag = pow(hash2(cid * 3.1 + face * 1.3), 9.0) * 0.9 + 0.012 * h;
      let sigma = max(pix * 0.65, 0.00018);
      let twinkle = 0.82 + 0.18 * sin(F.cam.w * (2.0 + 5.0 * h) + h * 60.0);
      let tint = mix(vec3f(0.75, 0.85, 1.15), vec3f(1.15, 0.95, 0.75), hash2(cid * 4.9 + face));
      sum += tint * mag * twinkle * exp(-d * d / (2.0 * sigma * sigma)) * (pix * pix) / (6.2831853 * sigma * sigma);
    }
  }
  return sum;
}
fn woodsStars(dir: vec3f, pix: f32) -> vec3f {
  let a = abs(dir);
  var uv: vec2f;
  var face: f32;
  if (a.x >= a.y && a.x >= a.z) { uv = dir.yz / a.x; face = sign(dir.x); }
  else if (a.y >= a.z) { uv = dir.xz / a.y; face = 2.0 + sign(dir.y); }
  else { uv = dir.xy / a.z; face = 4.0 + sign(dir.z); }
  let cells = 160.0;
  // Face-uv units are about radians near each face centre: enough for a sky seen through gaps in a canopy.
  return woodsStarCell(uv * cells, face, pix, cells) * 0.35;
}
fn woodsSkyRadiance(dir: vec3f, pix: f32) -> vec3f {
  let up = max(dir.y, 0.0);
  // Moonless airglow: deep blue overhead, a grey-green band towards the horizon where the path through it is longest.
  var c = vec3f(0.0018, 0.0026, 0.0048) * N.sky.x;
  c += vec3f(0.0032, 0.0040, 0.0046) * exp(-up * 4.0) * N.sky.x;
  let town = max(dot(normalize(dir.xz + vec2f(1e-4)), vec2f(0.6, -0.8)), 0.0);
  c += vec3f(0.0055, 0.0032, 0.0016) * pow(town, 3.0) * exp(-up * 8.0) * N.sky.x;
  if (N.sky.y > 0.0 && dir.y > -0.02) { c += woodsStars(dir, pix) * N.sky.y * smoothstep(-0.02, 0.15, dir.y); }
  if (N.moon.w > 0.0) {
    let m = dot(dir, N.moon.xyz);
    c += vec3f(0.9, 0.95, 1.0) * N.moon.w * (smoothstep(0.999985, 0.999992, m) * 30.0 + pow(max(m, 0.0), 400.0) * 0.08 + pow(max(m, 0.0), 12.0) * 0.004);
  }
  return c;
}
fn woodsSky(eye: vec3f, dir: vec3f, pix: f32) -> vec3f {
  let t = fogTransmittance(eye, eye + dir * 4000.0);
  return mix(fogColor(), woodsSkyRadiance(dir, pix), t);
}
`

/** Scene-side environment: the night sky (with stars) on glossy water and wet boards, the plain fog sky elsewhere. */
const woodsEnvWgsl = /* wgsl */ `
fn woodsEnv(dir: vec3f, rough: f32, n: vec3f) -> vec3f {
  var sky = fogEnv(dir);
  if (rough < 0.25 && dir.y > 0.0) { sky = woodsSky(F.cam.xyz, dir, 0.0015) * mix(0.25, 1.0, woodsOpen); }
  return mix(sky, fogAmbient(n), rough * rough);
}
`

const textures = /* wgsl */ `
@group(1) @binding(0) var baseArr: texture_2d_array<f32>;
@group(1) @binding(1) var normalArr: texture_2d_array<f32>;
@group(1) @binding(2) var ormArr: texture_2d_array<f32>;
@group(1) @binding(3) var texSamp: sampler;
@group(1) @binding(4) var fieldTex: texture_2d<f32>;
@group(1) @binding(5) var fieldSamp: sampler;
struct WS { base: vec4f, n: vec3f, orm: vec3f }
fn woodsTex(layer: i32, uv: vec2f, dx: vec2f, dy: vec2f) -> WS {
  var s: WS;
  s.base = textureSampleGrad(baseArr, texSamp, uv, layer, dx, dy);
  s.n = textureSampleGrad(normalArr, texSamp, uv, layer, dx, dy).xyz * 2.0 - 1.0;
  s.orm = textureSampleGrad(ormArr, texSamp, uv, layer, dx, dy).rgb;
  return s;
}
/** Tangent-space normal onto the surface, the frame from screen derivatives (no tangents stored). */
fn woodsPerturb(tn: vec3f, geo: vec3f, dpx: vec3f, dpy: vec3f, dux: vec2f, duy: vec2f, strength: f32) -> vec3f {
  let p1 = cross(dpy, geo);
  let p2 = cross(geo, dpx);
  let T = p1 * dux.x + p2 * duy.x;
  let B = p1 * dux.y + p2 * duy.y;
  let inv = inverseSqrt(max(max(dot(T, T), dot(B, B)), 1e-12));
  let t = normalize(tn);
  return normalize((T * t.x + B * t.y) * inv * strength + geo * t.z);
}
/** Mip-normal shortening as roughness variance (Toksvig), so far bark and litter go matte instead of sparkling. */
fn woodsVariance(tn: vec3f) -> f32 {
  let l = clamp(length(tn), 0.001, 1.0);
  return min((1.0 - l) / l, 1.0);
}
/** Cut-out coverage sharpened to about a pixel for alpha-to-coverage, held up at far mips. */
/** Coverage-preserving alpha scale per cut-out layer and mip (\`alpha-coverage.ts\`), levels 0..${COVERAGE_LEVELS - 1}. */
const woodsAlphaScale = array<f32, ${3 * COVERAGE_LEVELS}>(${(["twig-fir", "twig-pine", "fern"] as const).flatMap(k => ALPHA_COVERAGE[k].slice(0, COVERAGE_LEVELS).map(v => v.toFixed(3))).join(", ")});
fn woodsCoverage(a: f32, layer: i32, dux: vec2f, duy: vec2f) -> f32 {
  let texels = max(max(length(dux), length(duy)) * N.misc.x, 1e-4);
  let mip = clamp(log2(texels) + N.misc.z, 0.0, ${COVERAGE_LEVELS - 1}.0);
  // Alpha mips lose coverage as cut-outs average with the gaps; the scale from the textures' own coverage restores it
  // without filling cards into rectangles (Castaño, "Computing Alpha Mipmaps").
  let row = select(select(select(-1, 2, layer == ${LAYER.fern}), 1, layer == ${LAYER["twig-pine"]}), 0, layer == ${LAYER["twig-fir"]});
  var scale = 1.0;
  if (row >= 0) {
    let m0 = u32(floor(mip));
    let m1 = min(m0 + 1u, ${COVERAGE_LEVELS - 1}u);
    scale = mix(woodsAlphaScale[u32(row) * ${COVERAGE_LEVELS}u + m0], woodsAlphaScale[u32(row) * ${COVERAGE_LEVELS}u + m1], fract(mip));
  }
  let held = a * scale;
  // Edge width in alpha per pixel (Golus's sharpening without fwidth): a mip-filtered edge rises about 0.5 per screen
  // pixel once minified, less when magnified. Unbounded, distant cards fill their whole rectangle at half coverage.
  let width = clamp(texels * 0.5, 0.02, 0.5);
  return clamp((held - N.misc.y) / width + 0.5, 0.0, 1.0);
}
fn woodsField(p: vec3f) -> vec4f { return textureSampleLevel(fieldTex, fieldSamp, (p.xz - N.field.xy) * N.field.z, 0.0); }
fn woodsLum(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }
var<private> woodsEmit: vec3f = vec3f(0.0);
var<private> woodsAo: f32 = 1.0;
var<private> woodsMasked: bool = false;
var<private> woodsThin: bool = false;
var<private> woodsOpen: f32 = 1.0;
var<private> wDpx: vec3f;
var<private> wDpy: vec3f;
var<private> wDux: vec2f;
var<private> wDuy: vec2f;
`

/** Wind displacement of a vertex (world position before wind, its material and aux, colour weights, phase 0..1). */
const windWgsl = /* wgsl */ `
fn woodsWind(world: vec3f, matAux: vec2f, color: vec4f, phase01: f32) -> vec3f {
  let m = matAux.x;
  let foliage = (m > ${MAT.bark - 0.5} && m < ${MAT.needles + 0.5}) || (m > ${MAT.fern - 0.5} && m < ${MAT.fern + 0.5});
  let tapeTail = m > ${MAT.tape - 0.5} && m < ${MAT.tape + 0.5} && color.a > 0.5;
  if (!(foliage || tapeTail)) { return vec3f(0.0); }
  let t = F.cam.w;
  let ph = phase01 * 6.2831853;
  let wdir = N.wind.xy;
  let side = vec2f(-wdir.y, wdir.x);
  // A gust travels downwind across the stand.
  let g = 1.0 + N.wind.w * (0.5 * sin(dot(world.xz, wdir) * 0.045 - t * 0.55) + 0.35 * sin(dot(world.xz, side) * 0.031 + t * 0.23));
  let s = N.wind.z * max(g, 0.15);
  let h = color.g;
  if (m > ${MAT.fern - 0.5} && m < ${MAT.fern + 0.5}) {
    // Fronds bend from the crown of the clump.
    let a = sin(t * 1.6 + ph + world.x * 0.7) * 0.6 + sin(t * 2.7 + ph * 1.7) * 0.3;
    return vec3f(wdir.x, 0.0, wdir.y) * (0.03 + 0.05 * a) * h * h * s * N.sway.y
      + vec3f(side.x, 0.0, side.y) * sin(t * 3.1 + ph * 3.0 + world.z * 2.0) * 0.015 * h * s * N.sway.z;
  }
  if (tapeTail) {
    return vec3f(wdir.x, 0.0, wdir.y) * (0.06 + 0.05 * sin(t * 7.0 + world.x * 9.0)) * s + vec3f(side.x, 0.0, side.y) * sin(t * 11.0 + world.z * 7.0) * 0.03 * s;
  }
  // Trunk: a slow ellipse, its amplitude growing with the square of the height share.
  let trunk = h * h * N.sway.x * s;
  var d = vec3f(wdir.x, 0.0, wdir.y) * (0.16 + 0.12 * sin(t * 0.9 + ph)) * trunk + vec3f(side.x, 0.0, side.y) * sin(t * 0.63 + ph * 1.3) * 0.08 * trunk;
  // Limbs: each with its own phase from where it is.
  let b = color.b;
  let lp = ph + dot(world, vec3f(0.37, 0.21, 0.29));
  d += (vec3f(wdir.x, 0.0, wdir.y) * sin(t * 2.3 + lp) * 0.07 + vec3f(0.0, sin(t * 1.9 + lp * 1.3) * 0.05, 0.0)) * b * b * s * N.sway.y;
  // Needles: a fast flutter at the card tips.
  let f = color.a;
  d += vec3f(sin(t * 13.0 + lp * 7.0), sin(t * 17.0 + lp * 5.0) * 0.6, cos(t * 11.0 + lp * 9.0)) * 0.012 * f * s * N.sway.z;
  return d;
}
`

const vertex = "o.world += woodsWind(o.world, v.matAux, v.color, fract(v.matAux.y));"

const material = /* wgsl */ `
  let layer = i32(floor(o.aux + 0.001));
  let wts = pow(max(o.color, vec3f(0.0)), vec3f(1.0 / 2.2));
  let geo = normalize(o.normal);
  woodsOpen = woodsField(o.world).r;
  pbrMetal = 0.0;
  if (mat == ${MAT.terrain}) {
    let rot = mat2x2f(0.8, 0.6, -0.6, 0.8);
    let ta = 2.4;
    let a = woodsTex(${LAYER["ground-needles"]}, o.world.xz / ta, wDpx.xz / ta, wDpy.xz / ta);
    let uvB = rot * o.world.xz / 5.3 + vec2f(0.37, 0.71);
    let b = woodsTex(${LAYER["ground-needles"]}, uvB, rot * wDpx.xz / 5.3, rot * wDpy.xz / 5.3);
    let macroT = smoothstep(0.3, 0.7, fbm(o.world.xz * 0.09));
    let tm = 2.1;
    let ms = woodsTex(${LAYER["ground-moss"]}, rot * o.world.xz / tm, rot * wDpx.xz / tm, rot * wDpy.xz / tm);
    let tt = 2.7;
    let tr = woodsTex(${LAYER["ground-trail"]}, o.world.xz / tt, wDpx.xz / tt, wDpy.xz / tt);
    let na = woodsPerturb(a.n, geo, wDpx, wDpy, wDpx.xz / ta, wDpy.xz / ta, 1.0);
    let nb = woodsPerturb(b.n, geo, wDpx, wDpy, rot * wDpx.xz / 5.3, rot * wDpy.xz / 5.3, 1.0);
    let nm = woodsPerturb(ms.n, geo, wDpx, wDpy, rot * wDpx.xz / tm, rot * wDpy.xz / tm, 1.0);
    let nt = woodsPerturb(tr.n, geo, wDpx, wDpy, wDpx.xz / tt, wDpy.xz / tt, 1.0);
    var alb = mix(a.base.rgb, b.base.rgb, macroT * 0.6);
    var nn = normalize(mix(na, nb, macroT * 0.6));
    var rough = mix(a.orm.g, b.orm.g, macroT * 0.6);
    var ao = mix(a.orm.r, b.orm.r, macroT * 0.6);
    // Height blends: moss fills the litter's hollows first, the trail wears through where it is worn.
    let hl = woodsLum(alb);
    let wm = clamp((wts.r * N.sky.w * 1.6 - 0.35) + (woodsLum(ms.base.rgb) - hl) * 2.0, 0.0, 1.0) * step(0.02, wts.r);
    alb = mix(alb, ms.base.rgb * vec3f(0.92, 1.0, 0.85), wm);
    nn = normalize(mix(nn, nm, wm));
    rough = mix(rough, ms.orm.g, wm);
    ao = mix(ao, ms.orm.r, wm);
    let wt = clamp(wts.g * 1.5 - 0.25 + (hl - woodsLum(tr.base.rgb)) * 1.5, 0.0, 1.0) * step(0.02, wts.g);
    alb = mix(alb, tr.base.rgb, wt);
    nn = normalize(mix(nn, nt, wt));
    rough = mix(rough, tr.orm.g, wt);
    // Shore mud: dark, smooth and flatter.
    let wet = wts.b;
    alb *= mix(1.0, 0.45, wet);
    rough = mix(rough, 0.32, wet);
    nn = normalize(mix(nn, geo, wet * 0.6));
    // Large-scale tone variation: drier and wetter patches of litter.
    alb *= mix(0.78, 1.12, fbm(o.world.xz * 0.045 + 13.0));
    albedo = alb * mix(1.0, ao * ao, 0.6);
    n = nn;
    woodsAo = ao;
    pbrRough = clamp(rough + woodsVariance(a.n) * 0.3, 0.05, 1.0);
  } else if (mat == ${MAT.bark} || mat == ${MAT.prop} || mat == ${MAT.wood}) {
    let s = woodsTex(layer, o.uv, wDux, wDuy);
    var alb = s.base.rgb;
    var nn = woodsPerturb(s.n, geo, wDpx, wDpy, wDux, wDuy, 1.0);
    var rough = s.orm.g;
    // Moss: lower trunks on the shaded side, the tops of logs and boulders.
    var m = wts.r * N.sky.w;
    if (mat == ${MAT.bark}) {
      m *= smoothstep(0.42, 0.62, fbm(vec2f(atan2(geo.z, geo.x) * 1.6, o.world.y * 1.4) + o.world.xz * 0.3)) * 1.4;
      if (wts.r > 0.85) { m = smoothstep(0.15, 0.75, geo.y) * smoothstep(0.35, 0.6, fbm(o.world.xz * 2.1)) * N.sky.w; }
    } else if (mat == ${MAT.prop}) {
      m *= smoothstep(0.25, 0.8, geo.y) * smoothstep(0.35, 0.65, fbm(o.world.xz * 1.7 + o.world.y));
    } else { m = 0.0; }
    if (m > 0.01) {
      let ms = woodsTex(${LAYER["ground-moss"]}, o.uv * 1.7, wDux * 1.7, wDuy * 1.7);
      let mm = clamp(m, 0.0, 1.0);
      alb = mix(alb, ms.base.rgb * vec3f(0.85, 1.0, 0.75), mm);
      nn = normalize(mix(nn, woodsPerturb(ms.n, geo, wDpx, wDpy, wDux * 1.7, wDuy * 1.7, 1.0), mm));
      rough = mix(rough, 0.95, mm);
    }
    if (mat == ${MAT.bark}) {
      // Soil splash and damp at the foot of each trunk.
      alb *= mix(0.62, 1.0, smoothstep(0.0, 0.035, wts.g));
      alb *= mix(vec3f(0.92, 0.95, 1.0), vec3f(1.06, 1.0, 0.94), fract(o.aux));
    }
    // Wet boards on the dock and porch (blue channel): darker and glossier.
    let damp = select(0.0, wts.b, mat == ${MAT.wood});
    alb *= mix(1.0, 0.55, damp);
    rough = mix(rough, 0.28, damp);
    // Cavity: furrows hold their own shade even under a light from the eye, which flattens everything else.
    albedo = alb * mix(1.0, s.orm.r * s.orm.r, 0.75);
    n = nn;
    woodsAo = s.orm.r;
    pbrRough = clamp(rough + woodsVariance(s.n) * 0.35, 0.05, 1.0);
  } else if (mat == ${MAT.needles} || mat == ${MAT.fern}) {
    let s = woodsTex(layer, o.uv, wDux, wDuy);
    alpha = woodsCoverage(s.base.a, layer, wDux, wDuy);
    woodsMasked = true;
    woodsThin = true;
    var nn = select(geo, -geo, dot(geo, V) < 0.0 && mat == ${MAT.fern});
    if (mat == ${MAT.fern}) {
      nn = normalize(mix(nn, vec3f(0.0, 1.0, 0.0), 0.35));
      albedo = s.base.rgb * mix(0.55, 1.0, wts.g) * vec3f(0.95, 1.0, 0.9);
    } else {
      // Inner crown: limb bases sit in the crown's own shade.
      albedo = s.base.rgb * mix(0.3, 1.0, wts.r) * mix(vec3f(0.85, 0.95, 0.8), vec3f(1.05, 1.0, 0.85), fract(o.aux));
    }
    n = nn;
    woodsAo = mix(0.5, 1.0, wts.r);
    pbrRough = 0.62;
  } else if (mat == ${MAT.path}) {
    let t = woodsTex(layer, o.world.xz / 2.7, wDpx.xz / 2.7, wDpy.xz / 2.7);
    let edge = smoothstep(0.65, 0.96, abs(o.uv.x));
    albedo = t.base.rgb * mix(vec3f(0.48, 0.46, 0.43), vec3f(1.12, 1.04, 0.88), edge);
    n = normalize(mix(geo, woodsPerturb(t.n, geo, wDpx, wDpy, wDpx.xz / 2.7, wDpy.xz / 2.7, 1.0), mix(0.12, 0.5, edge)));
    woodsAo = mix(0.92, t.orm.r, edge);
    pbrRough = mix(0.38, 0.78, edge);
  } else if (mat == ${MAT.cable}) {
    albedo = vec3f(0.012, 0.014, 0.013);
    pbrRough = 0.24;
  } else if (mat == ${MAT.concrete}) {
    albedo = vec3f(0.17, 0.175, 0.16) * (0.8 + 0.3 * noise2(o.world.xz * 24.0));
    pbrRough = 0.92;
  } else if (mat == ${MAT.water}) {
    let t = F.cam.w;
    let p = o.world.xz;
    let e = 0.15;
    let h0 = noise2(p * 1.3 + vec2f(t * 0.05, t * 0.03)) * 0.6 + noise2(p * 3.7 - vec2f(t * 0.09, -t * 0.06)) * 0.3;
    let hx = noise2((p + vec2f(e, 0.0)) * 1.3 + vec2f(t * 0.05, t * 0.03)) * 0.6 + noise2((p + vec2f(e, 0.0)) * 3.7 - vec2f(t * 0.09, -t * 0.06)) * 0.3;
    let hz = noise2((p + vec2f(0.0, e)) * 1.3 + vec2f(t * 0.05, t * 0.03)) * 0.6 + noise2((p + vec2f(0.0, e)) * 3.7 - vec2f(t * 0.09, -t * 0.06)) * 0.3;
    let amp = 0.012;
    n = normalize(vec3f(-(hx - h0) / e * amp, 1.0, -(hz - h0) / e * amp));
    albedo = vec3f(0.004, 0.006, 0.006);
    pbrRough = 0.035;
  } else if (mat == ${MAT.glow}) {
    let lit = floor(o.aux * 10.0) / 10.0;
    let u = o.uv;
    let mull = max(1.0 - smoothstep(0.012, 0.025, abs(u.x - 0.5)), 1.0 - smoothstep(0.012, 0.025, abs(u.y - 0.5)));
    albedo = vec3f(0.01);
    pbrRough = 0.06;
    if (lit > 0.05) {
      let curtain = mix(0.25, 1.0, smoothstep(0.02, 0.24, u.x) * smoothstep(0.98, 0.76, u.x));
      let shade = 0.55 + 0.45 * smoothstep(0.0, 1.0, u.y) + 0.2 * noise2(u * 6.0 + fract(o.aux) * 40.0);
      woodsEmit = vec3f(1.0, 0.5, 0.2) * lit * curtain * shade * (1.0 - mull * 0.92) * 3.2 * N.camp.x;
    }
  } else if (mat == ${MAT.bulb}) {
    albedo = vec3f(0.0);
    woodsEmit = vec3f(1.0, 0.6, 0.28) * o.aux * 6.0 * N.camp.y;
  } else if (mat == ${MAT.tape}) {
    albedo = vec3f(0.95, 0.2, 0.012);
    pbrRough = 0.42;
  } else {
    albedo = o.color;
    pbrRough = 0.5;
  }
`

const sceneHooks: SceneHooks = {
  uv: true,
  lampGrid: false,
  declarations: woodsUniformWgsl + fogSceneWgsl + textures + woodsSkyWgsl + woodsEnvWgsl + windWgsl + /* wgsl */ `
fn forestMoon(world: vec3f, n: vec3f, open: f32) -> vec3f {
  if (N.misc.w < 0.5) { return vec3f(0.55, 0.66, 0.95) * N.moon.w * max(dot(n, N.moon.xyz), 0.0) * open * open * 0.35; }
  return vec3f(N.moon.w * max(dot(n, N.moon.xyz), 0.0) / 3.14159265) * spotShadowVis(65000u, world, n);
}
`,
  vertex,
  fragmentStart: `wDpx = dpdx(o.world); wDpy = dpdy(o.world); wDux = dpdx(o.uv); wDuy = dpdy(o.uv);`,
  material,
  bounce: "vec3f(0.0)",
  ambient: "fogAmbient(n) * N.sky.z * mix(0.22, 1.0, woodsOpen) * woodsAo",
  directional: "forestMoon(o.world, n, woodsOpen)",
  lightLeak: "0.0",
  wallDirectScale: "1.0",
  // Thin leaves pass about a third of what lands on their back to the front.
  // Micro-shadowing from the AO map (Chan, "Material Advances in Call of Duty: WWII"): grazing light falls off in the
  // texture's crevices before the surface turns away.
  diffuseTerm: "let diffuse = select(max(ndl, 0.0) * clamp(abs(ndl) + 2.0 * woodsAo * woodsAo - 1.0, 0.0, 1.0), max(ndl, 0.0) * 0.7 + max(-ndl, 0.0) * 0.35, woodsThin) / PI;",
  surface: /* wgsl */ `
    col += woodsEmit;
    col = fogApply(col, F.cam.xyz, o.world);
  `,
  fragmentReturn: /* wgsl */ `{
    if (woodsMasked) { return vec4f(col, a); }
    let reflectRough = clamp(select(1.0, pbrRough, pbrRough >= 0.0), 0.0, 1.0);
    // Alpha already carries surface metadata. Negative values reserve a bloom
    // source mask for nearby rough surfaces, which are outside SSR's .4 cutoff.
    // Emissive materials and glossy surfaces keep the existing roughness tag.
    let near = 1.0 - smoothstep(3.0, 6.0, distance(F.cam.xyz, o.world));
    if (N.motes.w > 0.5 && near > 0.0 && reflectRough >= 0.4 && mat != ${MAT.glow} && mat != ${MAT.bulb}) {
      return vec4f(col, -near);
    }
    return vec4f(col, 2.0 - reflectRough);
  }`,
}

/** The forest's scene hooks with the kit's physical lights, the torch beam profile and spot shadows. */
export const forestHooks: SceneHooks = withPhysicalLights(sceneHooks, {
  knobs: "N.pbr",
  spotShadows: true,
  beam: { a: "N.beamA", b: "N.beamB" },
  env: "woodsEnv(dir, rough, n)",
})

/**
 * Instanced entry point appended to the forest scene shader: template vertices scaled (xz, y), turned about +y and
 * moved by the instance, then the same wind as baked geometry with the instance's phase. Rocks and floor props take
 * the instance's param as their moss share; trees as a tint variation (aux fraction).
 */
export const treeVertexWgsl = /* wgsl */ `
struct TreeInst { @location(8) a: vec4f, @location(9) b: vec4f }
@vertex fn vsTree(v: VIn, inst: TreeInst) -> VOut {
  var o: VOut;
  let c = cos(inst.a.w);
  let s = sin(inst.a.w);
  // Trees pack their trunk-radius scale in the param's integer part (×256) and the tint in its fraction, so a thin
  // trunk keeps a full crown: trunk vertices (bark at branch share 0) take the trunk scale, the rest the crown's.
  let packed = inst.b.w >= 1.0;
  let trunk = packed && abs(v.matAux.x - ${MAT.bark}.0) < 0.5 && v.color.b < 0.002;
  let sxz = select(inst.b.x, floor(inst.b.w) / 256.0, trunk);
  let param = select(inst.b.w, fract(inst.b.w), packed);
  let q = vec3f(v.pos.x * sxz, v.pos.y * inst.b.y, v.pos.z * sxz);
  o.world = vec3f(q.x * c - q.z * s, q.y, q.x * s + q.z * c) + inst.a.xyz;
  let nn = vec3f(v.normal.x / sxz, v.normal.y / inst.b.y, v.normal.z / sxz);
  o.normal = vec3f(nn.x * c - nn.z * s, nn.y, nn.x * s + nn.z * c);
  o.uv = v.uv;
  o.world += woodsWind(o.world, v.matAux, v.color, inst.b.z);
  o.pos = F.viewProj * vec4f(o.world, 1.0);
  var col = v.color.rgb;
  if (abs(v.matAux.x - ${MAT.prop}.0) < 0.5) { col.r *= param; }
  o.color = pow(col, vec3f(2.2));
  o.mat = v.matAux.x;
  o.aux = floor(v.matAux.y + 0.001) + param * 0.9;
  o.extra = vec4f(0.0, 0.0, 1.0, 0.0);
  return o;
}
`

/** The torch shadow casters' instance transform (`SpotShadows`): the same packed trunk scale as `vsTree`, no wind. */
export const forestShadowInstanceWgsl = /* wgsl */ `
fn instanced(p: vec3f, a: vec4f, b: vec4f, mat: f32, color: vec4f) -> vec3f {
  let trunk = b.w >= 1.0 && abs(mat - ${MAT.bark}.0) < 0.5 && color.b < 0.002;
  let sxz = select(b.x, floor(b.w) / 256.0, trunk);
  let q = vec3f(p.x * sxz, p.y * b.y, p.z * sxz);
  let c = cos(a.w);
  let s = sin(a.w);
  return vec3f(q.x * c - q.z * s, q.y, q.x * s + q.z * c) + a.xyz;
}
`

/**
 * Depth-only entry for the cut-outs' prepass: the same coverage as the shading pass (same texture, derivatives and
 * sharpening), so alpha-to-coverage picks the same samples and the shading pass, at depth "equal", shades each
 * visible frond once instead of once per overlapping card.
 */
export const cutoutDepthWgsl = /* wgsl */ `
@fragment fn fsCut(o: VOut) -> @location(0) vec4f {
  let layer = i32(floor(o.aux + 0.001));
  let dux = dpdx(o.uv);
  let duy = dpdy(o.uv);
  let a = textureSampleGrad(baseArr, texSamp, o.uv, layer, dux, duy).a;
  return vec4f(0.0, 0.0, 0.0, woodsCoverage(a, layer, dux, duy) * o.extra.z);
}
`

/** Fullscreen night sky in the renderer's sky slot (depth untouched, so the fog volume treats it as sky). */
export const skyShader = /* wgsl */ `
${common}
${fogParamsWgsl}
${woodsUniformWgsl}
${woodsSkyWgsl}
struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f }
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: VO;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}
@fragment fn fs(o: VO) -> @location(0) vec4f {
  let h = N.invViewProj * vec4f(o.uv.x * 2.0 - 1.0, 1.0 - o.uv.y * 2.0, 1.0, 1.0);
  let dir = normalize(h.xyz / h.w - F.cam.xyz);
  return vec4f(woodsSky(F.cam.xyz, dir, N.motes.y), 1.0);
}
`

/**
 * Sparse dust in the beam: procedural instances wrapped in a box round the eye (world-stable), lit only by
 * the torch's beam profile and spot shadow, with forward scattering (dust sparkles looking down the beam) and
 * energy-conserving sprite size (a sub-pixel mote is a dim pixel, a near one a soft out-of-focus disc).
 */
export const moteShader = /* wgsl */ `
${common}
${fogParamsWgsl}
${woodsUniformWgsl}
${beamWgsl}
${spotShadowWgsl}
struct VO { @builtin(position) pos: vec4f, @location(0) q: vec2f, @location(1) @interpolate(flat) col: vec3f, @location(2) @interpolate(flat) p: vec3f }
fn h1(n: f32) -> f32 { return fract(sin(n * 127.1) * 43758.5453); }
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VO {
  var o: VO;
  let corner = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0))[vi];
  let fi = f32(ii);
  let t = F.cam.w;
  var p: vec3f;
  var size: f32;
  let eye = F.cam.xyz;
  {
    let box = 14.0;
    let seed = vec3f(h1(fi + 0.1), h1(fi + 0.2), h1(fi + 0.3)) * box;
    let drift = vec3f(N.wind.x, 0.0, N.wind.y) * t * 0.12 * N.wind.z + vec3f(sin(t * 0.3 + fi), sin(t * 0.21 + fi * 1.7) * 0.6 - t * 0.008, cos(t * 0.27 + fi * 0.7)) * 0.15;
    p = eye + (fract((seed + drift - eye) / box) - 0.5) * box;
    size = 0.0003 + 0.0004 * h1(fi + 0.4);
  }
  // Torch light at the mote.
  let toP = p - N.torch.xyz;
  let d = max(length(toP), 0.05);
  let ang = kitBeamAngle(dot(toP / d, N.torchDir.xyz)) / max(N.torchDir.w, 0.01);
  var light = kitBeamProfile(ang, N.beamA, N.beamB) / (d * d) * smoothstep(N.torchCol.w, N.torchCol.w * 0.6, d) * N.torch.w;
  let view = normalize(p - eye);
  let g = 0.6;
  let cosT = dot(toP / d, view);
  let phase = (1.0 - g * g) / pow(max(1.0 + g * g - 2.0 * g * cosT, 1e-4), 1.5);
  let dist = max(length(p - eye), 0.05);
  // Sprites never go below ~1.5 px; their energy spreads over what they cover. Close ones defocus.
  let pix = N.motes.y * dist;
  let defocus = select(0.0, 0.012 / dist, dist < 0.9);
  let r = max(max(size, pix * 1.5), defocus);
  let energy = (size * size) / (r * r);
  // Albedo × the share of the beam a speck intercepts (its cross-section over the sprite): dust is tiny and bright
  // only looking down the beam (phase); a moth is a dull grey-brown wing.
  let reflectance = 0.02;
  let rangeFade = smoothstep(0.3, 0.6, dist) * (1.0 - smoothstep(3.0, 6.0, dist));
  o.col = N.torchCol.rgb * light * phase * energy * reflectance * N.motes.x * rangeFade * fogTransmittance(eye, p);
  let right = normalize(cross(view, vec3f(0.0, 1.0, 0.0)));
  let up = cross(right, view);
  o.pos = F.viewProj * vec4f(p + (right * corner.x + up * corner.y) * r, 1.0);
  o.q = corner;
  o.p = p;
  if (dist < 0.15 || dot(o.col, vec3f(1.0)) < 1e-6) { o.pos = vec4f(0.0, 0.0, -1.0, 1.0); }
  return o;
}
@fragment fn fs(o: VO) -> @location(0) vec4f {
  let r2 = dot(o.q, o.q);
  if (r2 > 1.0) { discard; }
  // The torch's shadow (fragment stage only: the spot maps are bound to it).
  var vis = 1.0;
  if (N.motes.z >= 0.0) { vis = spotShadowVis(u32(N.motes.z), o.p, -N.torchDir.xyz); }
  return vec4f(o.col * (1.0 - r2) * 2.0 * vis, 0.0);
}
`

/** The renderer's own scene shader, for what a game draws through `FrameInput.batches` (players, props): same night. */
export const batchHooks: SceneHooks = withPhysicalLights({
  lampGrid: false,
  declarations: woodsUniformWgsl + fogSceneWgsl + /* wgsl */ `var<private> batchThin: f32 = 0.0;
/**
 * Fluorescent dye turns the light landing on it into its own colour, so bright tape stays saturated instead of
 * bleaching: past a level the result takes the dye's hue, and it rolls off below the post pass's white mix (which
 * starts at 1.5 after exposure).
 */
fn tapeFluoresce(col: vec3f, dye: vec3f) -> vec3f {
  let peak = max(max(col.r, col.g), col.b);
  let l = peak * max(N.sway.w, 1e-3);
  let hue = dye / max(max(max(dye.r, dye.g), dye.b), 1e-5);
  let k = 2.4 * (1.0 - exp(-l / 2.4)) / max(l, 1e-5);
  return mix(col, hue * peak, smoothstep(0.5, 2.0, l)) * k;
}`,
  // Flagging tape (the kit's MAT.tape): thin glossy plastic, lit from whichever face you see, passing ~40% of a torch
  // behind it through; aux > 1 is a game's readability gain on its fluorescent colour.
  material: /* wgsl */ `if (mat == 5) {
      if (dot(n, V) < 0.0) { n = -n; }
      pbrRough = 0.3;
      batchThin = 0.4;
      albedo *= max(o.aux, 1.0);
    }`,
  diffuseTerm: "let diffuse = (max(ndl, 0.0) + max(-ndl, 0.0) * batchThin) / PI;",
  bounce: "vec3f(0.0)",
  ambient: "fogAmbient(n) * N.sky.z * 0.5",
  directional: "vec3f(0.0)",
  lightLeak: "0.0",
  wallDirectScale: "1.0",
  surface: "if (mat == 5) { col = tapeFluoresce(col, o.color); } col = fogApply(col, F.cam.xyz, o.world);",
}, { knobs: "N.pbr", spotShadows: true, beam: { a: "N.beamA", b: "N.beamB" }, env: "mix(fogEnv(dir), fogAmbient(n), rough * rough)" })
