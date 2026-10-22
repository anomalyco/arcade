import { ATMOSPHERE_WGSL } from "./atmosphere"
import { CLOUD_SHADOW_WGSL } from "./clouds"
import { FRAME_BINDING_WGSL } from "./frame"
import { HASH_WGSL } from "./ocean-hash"
import { WATER_WGSL } from "@arcade/kit/water/shader"
import { WATER_WAKE_WGSL } from "@arcade/kit/water/wake"

/** Lattice levels (0.5 m to 2048 m cells), waves the shader holds (16 sea + 8 detail), look slots. */
export const OCEAN_LEVELS = 13
export const OCEAN_WAVES = 24
export const OCEAN_LOOK = 13
/**
 * Each level is 2N x 2N cells drawn as T x T-quad tiles; the morph band runs from N/2 + T/2 to N - T cells (brief §1).
 * N = 32 rather than the brief's 64: facets subtend 1/18-1/28 rad, about 40-60 px at 1536 x 1024, the chunky facets of
 * the concepts. T = 4 keeps the morph band 10 cells wide (N must be a multiple of 2T).
 */
export const OCEAN_N = 32
export const OCEAN_TILE = 4

/** Float offsets of `struct Ocean`. */
export const OCEAN_LAYOUT = {
  viewProjRel: 0,
  originToEye: 16,
  cam: 20,
  bed: 24,
  anchor: 28,
  foam: 32,
  sun: 36,
  wind: 40,
  level: 44,
  levelG: 44 + OCEAN_LEVELS * 4,
  waves: 44 + OCEAN_LEVELS * 8,
  shape: 44 + OCEAN_LEVELS * 8 + OCEAN_WAVES * 4,
  mem: 44 + OCEAN_LEVELS * 8 + OCEAN_WAVES * 8,
  mem2: 44 + OCEAN_LEVELS * 8 + OCEAN_WAVES * 12,
  look: 44 + OCEAN_LEVELS * 8 + OCEAN_WAVES * 16,
  cloud: 44 + OCEAN_LEVELS * 8 + OCEAN_WAVES * 16 + OCEAN_LOOK * 4,
} as const
export const OCEAN_FLOATS = OCEAN_LAYOUT.cloud + 12

const MORPH_LO = OCEAN_N / 2 + OCEAN_TILE / 2
const MORPH_HI = OCEAN_N - OCEAN_TILE
const f = (v: number) => (Number.isInteger(v) ? `${v}.0` : `${v}`)

/** The Today source keeps its original expressions. The continuous pipeline is compiled only on opt-in. */
export function oceanShader(continuous = false): string { return /* wgsl */ `
${FRAME_BINDING_WGSL}
${ATMOSPHERE_WGSL}
${HASH_WGSL}
${CLOUD_SHADOW_WGSL}
${continuous ? WATER_WGSL : ""}
${continuous ? WATER_WAKE_WGSL : ""}

const PI: f32 = 3.14159265;
const TAU: f32 = 6.2831853;

struct Ocean {
  viewProjRel: mat4x4f,
  originToEye: vec4f, // sea.origin - eye (xyz), w = significant wave height
  cam: vec4f,         // camera x, z relative to the origin, scaled camera height (morph), sea time (wrapped at 3600 s)
  bed: vec4f,         // bake x0, z0 relative to the origin, 1 / size, 1 when baked
  anchor: vec4f,      // origin x, z in world metres (stable noise frame), wave count, seed (as f32 of u16 parts)
  foam: vec4f,        // swell Jacobian deviation, swell foam threshold, crest-top bonus, chop foam threshold
  sun: vec4f,         // x = seabed texel size (m), y = rms horizontal displacement, z = sun radius (rad), w = swell shading boost
  wind: vec4f,        // wind xz, swell xz
  level: array<vec4f, ${OCEAN_LEVELS}>,  // centre x, z relative to the origin, cell size, unused
  levelG: array<vec4i, ${OCEAN_LEVELS}>, // centre lattice index x, z (in that level's cells)
  waves: array<vec4f, ${OCEAN_WAVES}>,   // dirX, dirZ, k, phase at the origin and this frame's time
  shape: array<vec4f, ${OCEAN_WAVES}>,   // A, Q*A, Q*A*k, A*k
  mem: array<vec4f, ${OCEAN_WAVES}>,     // cos/sin(w dt) for foam taps 0, 1 (dt < 0: just ahead of the crest)
  mem2: array<vec4f, ${OCEAN_WAVES}>,    // cos/sin(w dt) for foam taps 2, 3 (a few seconds after the crest)
  look: array<vec4f, ${OCEAN_LOOK}>,
  cloud: vec4f,                          // sea origin minus cloud drift (xz), seed bits, shadow strength
  sunView: vec4f,                        // direction of the sun disc (glitter, reflections)
  wake: vec4f,                           // wake field centre minus sea origin (xz), 1 / field size, strength
}
@group(1) @binding(0) var<uniform> O: Ocean;
@group(1) @binding(1) var bedTex: texture_2d<f32>;
@group(1) @binding(2) var bedSamp: sampler;
@group(1) @binding(3) var wakeTex: texture_2d<f32>;

fn seedU() -> u32 { return u32(O.anchor.w); }

fn jitter(g: vec2i, L: u32) -> vec2f {
  return (rand3(vec3u(bitcast<vec2u>(g), (L * 0x9E3779B9u) ^ seedU())).xy - 0.5) * 0.6;
}

fn bedAt(wp: vec2f) -> vec4f {
  let uv = (wp - O.bed.xy) * O.bed.z;
  let t = textureSampleLevel(bedTex, bedSamp, uv, 0.0);
  let inside = all(uv > vec2f(0.0)) && all(uv < vec2f(1.0)) && O.bed.w > 0.5;
  return select(vec4f(1.0, 0.0, 1.0, 0.0), t, inside);
}

/** Per-wave LOD weight: 1 when the wavelength spans enough cells to be drawn by the facets, 0 when it would alias. */
fn waveFilter(k: f32, cell: f32) -> f32 {
  let cells = TAU / (k * cell);
  return saturate((cells - O.look[11].w) / 1.2);
}

fn wavePhase(w: vec4f, p: vec2f) -> f32 {
  let th = w.z * dot(w.xy, p) + w.w;
  return th - TAU * round(th / TAU);
}

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) rel: vec3f,
  @location(1) p: vec2f,
  @location(2) wp: vec2f,
  @location(3) y: f32,
  @location(4) foam: f32,
  @location(5) sigma2: f32,
  @location(6) nSmooth: vec3f,
  @location(7) cell: f32,
  @location(8) @interpolate(flat) facet: u32,
  @location(9) ${continuous ? "" : "@interpolate(flat) "}peak: f32,
  @location(10) age: f32,
  @location(11) morph: f32,
  @location(12) @interpolate(flat) swell: vec2f,
  @location(14) shadow: f32,
}

/**
 * Crest foam from the geometry: the Jacobian squeeze (1 - det J, in deviations of the waves this vertex keeps, so it
 * means the same at every LOD) plus a bonus that only the top of a swell crest gets (height over the local
 * significant height), so foam sits ON the crest line, thicker and longer on big sets, and spills down the front face
 * through the memory taps. j = (Jxx, Jxz, Jzz, swell height); lo = threshold in deviations.
 */
fn foamOf(j: vec4f, sd: f32, lo: f32) -> f32 {
  let det = (1.0 + j.x) * (1.0 + j.z) - j.y * j.y;
  let top = smoothstep(0.3, 0.6, j.w / max(O.originToEye.w, 0.3));
  let x = (1.0 - det) / sd + O.foam.z * top;
  return smoothstep(lo, lo + 0.8, x);
}

@vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) inst: vec4i) -> VOut {
  let L = u32(inst.z);
  let lv = O.level[L];
  let s = lv.z;
  let off = inst.xy + vec2i(i32(vi % ${OCEAN_TILE + 1}u), i32(vi / ${OCEAN_TILE + 1}u));
  let g = O.levelG[L].xy + off;
  let pLat = lv.xy + vec2f(off) * s;

  // CDLOD morph from the continuous camera position: 0 inside ${MORPH_LO} cells, 1 past ${MORPH_HI}.
  let dc = abs(pLat - O.cam.xy);
  let d = max(max(dc.x, dc.y), O.cam.z);
  let m = saturate((d / s - ${f(MORPH_LO)}) / ${f(MORPH_HI - MORPH_LO)});
  let odd = g & vec2i(1);
  let gc = (g - odd) >> vec2u(1u);
  let pFine = pLat + s * jitter(g, L);
  let pCoarse = (pLat - vec2f(odd) * s) + 2.0 * s * jitter(gc, L + 1u);
  let p = pFine * (1.0 - m) + pCoarse * m;
  let cell = s * (1.0 + m);

  // Shallow water calms the waves (longer waves feel the bottom sooner).
  let depth = bedAt(p).r * 40.0;

  var D = vec3f(0.0);
  var J = vec3f(0.0);
  var G = vec2f(0.0);
  var Gs = vec2f(0.0);
  var J0 = vec4f(0.0);
  var Ysw = 0.0;
  var J1 = vec4f(0.0);
  var J2 = vec4f(0.0);
  var J3 = vec4f(0.0);
  var lost = 0.0;
  var kept = 0.0;
  let n = u32(O.anchor.z);
  for (var i = 0u; i < n; i = i + 1u) {
    let w = O.waves[i];
    let sh = O.shape[i];
    let fw = waveFilter(w.z, cell);
    lost += (1.0 - fw * fw) * 0.5 * sh.w * sh.w;
    let a = fw * saturate(depth / clamp(1.57 / w.z, 1.5, 14.0));
    if (a <= 0.0) { continue; }
    let th = wavePhase(w, p);
    let c = cos(th);
    let sn = sin(th);
    D += a * vec3f(w.x * sh.y * c, sh.x * sn, w.y * sh.y * c);
    let dd = vec3f(w.x * w.x, w.x * w.y, w.y * w.y);
    let j = a * sh.z;
    J -= j * sn * dd;
    G += a * sh.w * c * w.xy;
    let isSwell = w.z < 0.126;
    Gs += select(vec2f(0.0), a * sh.w * c * w.xy, isSwell);
    // Deviation over the waves this LOD keeps, before shallow-water damping: calm shallows stay calm instead of the
    // normalisation blowing their tiny residual squeeze up into foam.
    kept += fw * fw * 0.5 * sh.z * sh.z;
    // Foam taps: the same water parcel dt seconds away. sin(th + w dt) from the per-wave cos/sin(w dt).
    let mm = O.mem[i];
    let m2 = O.mem2[i];
    let s0 = sn * mm.x + c * mm.y;
    let s1 = sn * mm.z + c * mm.w;
    let s2 = sn * m2.x + c * m2.y;
    let s3 = sn * m2.z + c * m2.w;
    let hy = select(0.0, sh.x, isSwell);
    J0 += a * vec4f(-sh.z * s0 * dd, hy * s0);
    J1 += a * vec4f(-sh.z * s1 * dd, hy * s1);
    J2 += a * vec4f(-sh.z * s2 * dd, hy * s2);
    J3 += a * vec4f(-sh.z * s3 * dd, hy * s3);
    Ysw += hy * a * sn;
  }
  let xx = 1.0 + J.x;
  let zz = 1.0 + J.z;
  let det = xx * zz - J.y * J.y;
  let hx = (zz * G.x - J.y * G.y) / det;
  let hz = (xx * G.y - J.y * G.x) / det;

  // Crest foam (geometry, brief §2 and SoT §4.4): now, a moment ahead (foam spilling down the front face as the crest
  // arrives) and the crest that passed this parcel a few seconds ago (older taps: lower threshold, wider, like SoT's
  // blur, reported as age for the fresh/old texture blend).
  let sd = sqrt(kept) + 1e-3;
  let lo = O.foam.w;
  var foam = foamOf(vec4f(J, Ysw), sd, lo);
  var age = 0.0;
  let f0 = 0.8 * foamOf(J0, sd, lo + 0.1);
  if (f0 > foam) { foam = f0; age = 0.1; }
  let f1 = 0.75 * foamOf(J1, sd, lo - 0.15);
  if (f1 > foam) { foam = f1; age = 0.35; }
  let f2 = 0.5 * foamOf(J2, sd, lo - 0.3);
  if (f2 > foam) { foam = f2; age = 0.65; }
  let f3 = 0.3 * foamOf(J3, sd, lo - 0.45);
  if (f3 > foam) { foam = f3; age = 1.0; }

  var o: VOut;
  o.rel = O.originToEye.xyz + vec3f(p.x + D.x, D.y, p.y + D.z);
  o.pos = O.viewProjRel * vec4f(o.rel, 1.0);
  o.p = p;
  o.wp = p + D.xz;
  o.y = D.y;
  o.foam = foam;
  o.sigma2 = lost;
  o.nSmooth = vec3f(-hx, 1.0, -hz);
  o.cell = cell;
  o.age = age;
  o.swell = Gs;
  // Cloud shadows vary over hundreds of metres: per vertex is plenty.
  let wpos = p + D.xz;
  o.shadow = select(cloudShadow(O.cloud.xy + wpos, bitcast<u32>(O.cloud.z), F.sunDir.xyz) * O.cloud.w, 0.0, O.cloud.w <= 0.0);
  o.morph = m;
  // SoT wave-peak mask: horizontal (choppy) offset times height marks the upper flanks just below the crests.
  let crestH = saturate(D.y / max(O.originToEye.w, 0.3) + 0.3);
  o.peak = saturate(length(D.xz) / max(O.sun.y, 0.05) * 0.7 * crestH + crestH * crestH * 0.5);
  // Per-facet identity from the provoking vertex; a collapsing vertex takes its coarse identity so tints match the
  // next level where they meet.
  let id = select(vec3u(bitcast<vec2u>(g), L), vec3u(bitcast<vec2u>(gc), L + 1u), m > 0.5);
  o.facet = pcg3d(vec3u(id.xy, (id.z * 0x9E3779B9u) ^ seedU())).x;
  return o;
}

// ---- fragment helpers (all deterministic in stable world plan coordinates) ----

/** Nearest jittered feature point: x = F1 distance, y = cell id hash, z = F2 - F1. */
fn worley(q: vec2f, salt: u32) -> vec3f {
  let fl = floor(q);
  let c = vec2i(fl);
  let fr = q - fl;
  var b1 = 9.0;
  var b2 = 9.0;
  var id = 0.0;
  for (var j = -1; j <= 1; j = j + 1) {
    for (var i = -1; i <= 1; i = i + 1) {
      let o = vec2i(i, j);
      let h = rand3i(c + o, salt);
      let dv = vec2f(o) + h.xy * 0.85 + 0.075 - fr;
      let dd = dot(dv, dv);
      let better = dd < b1;
      b2 = select(min(b2, dd), b1, better);
      id = select(id, h.z, better);
      b1 = min(b1, dd);
    }
  }
  let d1 = sqrt(b1);
  return vec3f(d1, id, sqrt(b2) - d1);
}

fn valueNoise(q: vec2f, salt: u32) -> f32 {
  let fl = floor(q);
  let c = vec2i(fl);
  let u = q - fl;
  let w = u * u * (3.0 - 2.0 * u);
  let a = rand3i(c, salt).x;
  let b = rand3i(c + vec2i(1, 0), salt).x;
  let cc = rand3i(c + vec2i(0, 1), salt).x;
  let dn = rand3i(c + vec2i(1, 1), salt).x;
  return mix(mix(a, b, w.x), mix(cc, dn, w.x), w.y);
}

/**
 * Chunky foam (the concepts' crunchy white clusters), in the swell frame (stretched along the crests):
 * - Clusters: Voronoi cells of 6 m and up (growing with the pixel footprint so they stay bold at any distance), each
 *   switched on when its random rank falls under the coverage, eaten from the edges by distance to the cell centre,
 *   so thin coverage is scattered chunks and dense coverage merges into solid white.
 * - Structure near the camera: 1-2 m cells inside the clusters make holes where coverage is thinner, and give each
 *   cell its own brightness with soft blue creases between them.
 * - Old foam keeps only the big clusters and thins out (SoT's fresh/old blend).
 * Returns (mask 0..1, shade 0..1: 1 lit foam, lower = the blue-shadowed inside of a cluster).
 */
fn foamMask(q: vec2f, cover: f32, footprint: f32, age: f32, t: f32) -> vec2f {
  let sw = O.wind.zw;
  let qs = vec2f(dot(q, vec2f(-sw.y, sw.x)) * 0.6, dot(q, sw)) + vec2f(0.0, t * 0.1);
  let c = cover * mix(1.0, 0.75, age);
  // Cluster size grows with the footprint, but slower than it: far foam is many small flecks, not big slabs.
  let lv = max(0.0, log2(footprint * 0.9) * 0.6);
  let l0 = floor(lv);
  let s0 = 6.0 * exp2(l0);
  let li = u32(l0);
  let fa = clusterMask(worley(qs / s0, 11u + li), c);
  let fb = clusterMask(worley(qs / (s0 * 2.0), 12u + li), c);
  var m = mix(fa, fb, smoothstep(0.3, 1.0, fract(lv)) * step(0.001, lv));
  var shade = 1.0;
  let wS = smoothstep(1.0, 3.0, 1.2 / footprint);
  if (wS > 0.0) {
    let f = worley(qs / 1.6, 13u);
    // Holes where the coverage is thinner (none in the dense core), then per-cell light and blue creases.
    // Holes everywhere but the densest core; thinner foam and older foam get more of them.
    let hole = step(0.3 + 0.55 * c - 0.3 * age, f.y);
    m *= 1.0 - hole * wS * 0.95;
    let cell = 0.72 + 0.28 * fract(f.y * 7.13);
    let crease = smoothstep(0.0, 0.22, f.z);
    shade = mix(1.0, cell * mix(0.62, 1.0, crease), wS);
  }
  return vec2f(m, shade);
}

fn clusterMask(w: vec3f, cover: f32) -> f32 {
  // Rank picks which cells are foamy; the centre distance rounds them into chunks that grow with the coverage. Even
  // full coverage leaves gaps between some chunks, so a crest never turns into one flat sheet.
  let v = cover * 1.05 - w.y * 0.7 - w.x * 0.55;
  return saturate(v / 0.06 + 0.5);
}

/**
 * Coral seen through the water. The islands bake coral cover into the seabed's A channel (clustered blobs on reef
 * shelves and in lagoons); near the camera Worley cells break the blob edges into faceted heads. x = mask, y = id.
 */
fn coral(q: vec2f, cover: f32, footprint: f32) -> vec2f {
  let c = worley(q / 4.5, 37u);
  let heads = (1.0 - smoothstep(0.45, 0.85, c.x)) - 0.5 + (c.y - 0.5) * 0.4;
  let aa = 1.0 - smoothstep(0.6, 2.0, footprint);
  let crisp = saturate((cover - 0.45) * 4.0 + heads * 1.6);
  return vec2f(mix(smoothstep(0.2, 0.8, cover), crisp, aa), c.y);
}

/** Star-like sun sparkles: one random micro-normal per power-of-two cell, flickering with sea time. */
fn glitter(q: vec2f, n: vec3f, V: vec3f, L: vec3f, footprint: f32, t: f32) -> f32 {
  // Small cells (about a pixel) so each sparkle is a sharp point, many of them, instead of a few big soft blobs.
  let cs = exp2(ceil(log2(max(0.12, 0.9 * footprint))));
  let id = vec2i(floor(q / cs));
  let h = rand3i(id, u32(cs * 64.0) + 7u);
  let mn = normalize(n + vec3f(h.x - 0.5, 0.0, h.y - 0.5) * 0.35);
  // Whole cycles per 3600 s, so the time wrap never pops.
  let rate = (1.0 + floor(h.z * 4.0)) * (TAU / 0.9);
  let flick = saturate(sin(h.z * 40.0 + t * rate) * 2.0 - 1.0);
  let r = dot(reflect(-V, mn), L);
  // Sparse: only a fraction of cells host a sparkle at all.
  let on = step(mix(0.5, 0.85, smoothstep(0.5, 8.0, footprint)), fract(h.z * 13.7));
  return smoothstep(0.9975, 0.9995, r) * flick * on * (1.0 - smoothstep(4.0, 20.0, footprint));
}

/**
 * Breaking surf, from the seabed and the swell actually arriving (all world-anchored and seeded, so clients agree):
 * - Height: the analytic-signal envelope |sum A e^(i theta)| of the swell gives the height of the current set and
 *   where its crests are, undamped by the shallows, so the surf grows with sets and pulses as each crest arrives.
 * - Exposure: a short march up-swell through the seabed; land or shallow reef in the way shelters the point (lee
 *   sides, lagoons, behind other islands), and shores facing away from the swell get less.
 * - Break line: where the depth falls to about 1.3 x the local wave height, so it follows the real reef edge with its
 *   spurs, gaps and channels; whitewater thins inshore of it. A thin, softer wash runs along the beach; rock and
 *   cliff shores take a wider churning band when exposed.
 * - Breakup: low-frequency noise cuts the line into irregular segments of varying width and brightness, and with
 *   distance it thins to a few flecks on the windward edges.
 */
fn surfCover(p: vec2f, wp: vec2f, wq: vec2f, depth: f32, shore: f32, slope: f32, seaward: vec2f, footprint: f32, t: f32) -> f32 {
  let swd = O.wind.zw;
  var ec = 0.0;
  var es = 0.0;
  let ns = u32(O.look[12].y);
  for (var i = 0u; i < ns; i = i + 1u) {
    let w = O.waves[i];
    let th = wavePhase(w, p);
    ec += O.shape[i].x * cos(th);
    es += O.shape[i].x * sin(th);
  }
  let env = sqrt(ec * ec + es * es);
  let crest = smoothstep(-0.2, 0.85, es / max(env, 1e-3));

  // Water up-swell that is already shallower than this point's break depth means the waves broke out there: this
  // point is sheltered (inside the reef, in a lagoon, in the lee of land or of another reef).
  let h0 = 2.0 * env;
  let db0 = max(1.3 * h0, 0.8);
  // Only water clearly shallower than here (and than the break depth) counts, so the break band shelters nothing of
  // itself but a lagoon behind a reef crest, or the lee of land, does go calm.
  // The march starts past the break band, so the band never shelters itself; the shelf behind it does go calm.
  let shelterAt = db0 * 0.85;
  var block = 0.0;
  var d = 70.0;
  for (var k = 0; k < 5; k = k + 1) {
    let up = bedAt(wp - swd * d).r * 40.0;
    block = max(block, (1.0 - smoothstep(shelterAt * 0.7, shelterAt + 0.3, up)) * (1.0 - f32(k) * 0.1));
    d *= 1.8;
  }
  let facing = dot(seaward, -swd);
  // Lee sides keep a little broken surf (swell refracts round the reef), never a full ring.
  let exposure = (1.0 - 0.82 * block) * mix(0.3, 1.0, smoothstep(-0.5, 0.45, facing));

  let far = smoothstep(2.0, 9.0, footprint);
  let n1 = valueNoise(wq / 85.0, 81u);
  let n2 = valueNoise(wq / 27.0, 83u);
  let n3 = valueNoise(wq / 9.0, 85u);

  // Reef-edge break line.
  let hl = 2.0 * env * mix(0.25, 1.0, exposure) * (0.8 + 0.4 * n2);
  let db = max(1.3 * hl, 0.8);
  // Metres inshore of the break line (depth / bed slope): the line is a band of 8-30 m (wider on bigger sets), with a
  // fading whitewater trail behind it, whatever the shelf's slope.
  let x = (db - depth) / max(slope, 0.015);
  let wB = (8.0 + 22.0 * n3) * (0.6 + 0.5 * smoothstep(0.6, 1.6, env));
  let brk = smoothstep(-5.0, 1.0, x) * (1.0 - smoothstep(wB, wB + 6.0, x));
  let trail = 0.35 * smoothstep(-2.0, 2.0, x) * (1.0 - smoothstep(wB, wB * 3.0 + 20.0, x)) * step(0.0, depth - 0.5);
  let segN = n1 + 0.35 * (n2 - 0.5);
  let seg = smoothstep(0.2 + 0.14 * far, 0.4 + 0.14 * far, segN);
  let pulse = mix(0.5, 1.0, crest);
  var reef = max(brk, trail) * seg * pulse * smoothstep(0.08, 0.55, exposure) * (0.8 + 0.6 * n2);

  // Shore wash: thin and soft on beaches; wider, churning against exposed rock and cliff.
  let steep = max(smoothstep(0.12, 0.5, slope), smoothstep(0.12, 0.25, depth / max(shore, 4.0)));
  // Swell refracts round reefs and still slaps rock and cliff, so the wash sees the shelter only partly.
  let washExp = (1.0 - 0.6 * block) * mix(0.35, 1.0, smoothstep(-0.5, 0.45, facing));
  // On rock the churn surges with each crest and grows with the set (env): a big set throws a wide white skirt.
  let rock = steep * washExp;
  let setGain = smoothstep(0.6, 2.2, env);
  let surge = mix(0.7 + 0.6 * crest, 0.45 + 1.4 * crest * crest, rock) * mix(1.0, 0.7 + 0.8 * setGain, rock);
  // Big swell breaks on every exposed shore: the wash scales with the set height (env) there too, wider on rock.
  let beachReach = (2.0 + 1.5 * n2) + 7.0 * env * washExp * (0.5 + 0.8 * n1);
  let reach = mix(beachReach, O.look[10].x * washExp * (0.6 + 0.7 * n1), steep) * surge;
  let wobble = 0.2 * sin(TAU * (t / 9.0 + valueNoise(wq / 30.0, 67u)));
  let washSeg = mix(0.35, 1.0, smoothstep(0.25, 0.6, n1 + 0.3 * (n3 - 0.5)));
  let washSegR = mix(washSeg, 1.0, rock * 0.7);
  var wash = (1.0 - smoothstep(0.0, 1.0, shore / max(reach, 0.5) + wobble)) * washSegR * mix(0.75 + 0.5 * washExp * setGain, 1.6, rock);
  wash *= mix(0.4, 1.0, washExp);

  // Thin out with distance: the far view keeps a few broken flecks on the windward edges.
  reef *= mix(1.0, 0.75, far);
  wash *= mix(1.0, mix(0.3, 0.6, rock), far);
  return max(reef, wash);
}

/**
 * Wind-streak foam (storms): long thin lines along the wind, broken into runs, in rest-space plan coordinates so they
 * ride the water. Ridged value noise stretched ~40x along the wind gives the lines; density widens them and lets more
 * runs through. The line spacing grows in octaves with the pixel footprint (like the foam clusters), so far streaks
 * stay a pixel or two wide instead of shimmering away. Returns (mask 0..1, coarse ridge 0..1 for carving the crests).
 */
fn streakAt(a: f32, c: f32, sc: f32, density: f32) -> vec2f {
  let cc = c / sc + (valueNoise(vec2f(a / (160.0 * sc), c / (40.0 * sc)), 97u) - 0.5) * 2.0;
  let r1 = 1.0 - abs(2.0 * valueNoise(vec2f(cc / 1.3, a / (55.0 * sc)), 91u) - 1.0);
  let r2 = 1.0 - abs(2.0 * valueNoise(vec2f(cc / 3.4, a / (140.0 * sc)), 93u) - 1.0);
  let ridge = max(r1, r2 * 0.95);
  let width = mix(0.035, 0.15, density);
  let line = smoothstep(1.0 - width, 1.0 - width * 0.4, ridge);
  let runs = valueNoise(vec2f(cc / 9.0, a / (120.0 * sc)), 99u);
  return vec2f(line * smoothstep(0.66 - 0.4 * density, 0.8 - 0.4 * density, runs), r2);
}

fn windStreaks(q: vec2f, wd: vec2f, density: f32, footprint: f32) -> vec2f {
  let a = dot(q, wd);
  let c = dot(q, vec2f(-wd.y, wd.x));
  let lv = max(0.0, log2(footprint / 0.12));
  let s0 = exp2(floor(lv));
  let k = smoothstep(0.2, 1.0, fract(lv)) * step(0.001, lv);
  let l0 = streakAt(a, c, s0, density);
  let l1 = streakAt(a, c, s0 * 2.0, density);
  return vec2f(mix(l0.x, l1.x, k), l0.y) * vec2f(mix(1.0, 0.7, smoothstep(2.0, 8.0, footprint)), 1.0);
}

/**
 * Rain dimples near the camera: in each 0.45 m cell a drop's ring spreads and fades, tilting the normal radially.
 * Whole cycles per 3600 s so the time wrap never pops. Returns the plan tilt.
 */
fn rainDimple(q: vec2f, t: f32) -> vec2f {
  let cs = 0.45;
  let cell = vec2i(floor(q / cs));
  var tilt = vec2f(0.0);
  for (var k = 0u; k < 2u; k = k + 1u) {
    let h = rand3i(cell, 71u + k * 13u);
    let ph = fract(t * (1.0 + floor(h.z * 3.0)) + h.x + f32(k) * 0.5);
    let centre = (vec2f(cell) + 0.2 + 0.6 * vec2f(h.y, fract(h.x * 7.3))) * cs;
    let d = q - centre;
    let r = length(d);
    let ring = exp(-pow((r - ph * 0.2) / 0.03, 2.0)) * (1.0 - ph) * (1.0 - ph);
    tilt += d / max(r, 1e-3) * ring;
  }
  return tilt;
}

/** Karis representative point: the direction to the nearest point of a sun disc of angular radius r to the ray R. */
fn sunAreaDir(L: vec3f, R: vec3f, r: f32) -> vec3f {
  let toRay = dot(L, R) * R - L;
  return normalize(L + toRay * saturate(tan(r) / max(length(toRay), 1e-5)));
}

@fragment fn fs(v: VOut) -> @location(0) vec4f {
  // 1) Every derivative first, in uniform control flow. Everything expensive below sits in branches that only the
  //    pixels needing it take (foam, coral, glitter, shallows), so no derivative is taken after them.
  let dX = dpdx(v.rel);
  let dY = dpdy(v.rel);
  let fpx = length(dpdx(v.p));
  let fpy = length(dpdy(v.p));
  let footprint = max(max(fpx, fpy), 1e-4);
  // Area-equivalent footprint: grazing views stretch one axis only; foam cells size by this so they don't turn to slabs.
  let footIso = max(sqrt(fpx * fpy), 1e-4);
  let t = O.cam.w;
  let q = v.p + O.anchor.xy;
  let wq = v.wp + O.anchor.xy;
  let dbg = u32(O.look[12].x);
  if ((dbg & 64u) != 0u) {
    // Debug: height bands (red) and facet slope (green) only.
    var nd = normalize(cross(dX, dY));
    nd = select(-nd, nd, nd.y >= 0.0);
    return vec4f(saturate(v.y / 4.0 + 0.5) * 0.6, saturate(1.0 - nd.y) * 6.0 * 0.6, 0.1, 1.0);
  }

  let deep = O.look[0].rgb;
  let scatter = O.look[1].rgb;
  let sand = O.look[2].rgb;
  let coralCol = O.look[3].rgb;
  let foamCol = O.look[4].rgb;
  let absorb = O.look[5].rgb;
  let k6 = O.look[6];
  let k7 = O.look[7];
  let k8 = O.look[8];
  let k9 = O.look[9];

  // 2) Faceted normal: the exact plane of this triangle.
  var nF = cross(dX, dY);
  nF = select(-nF, nF, nF.y >= 0.0);
  let lenF = length(nF);
  ${continuous ? "var" : "let"} nS = normalize(v.nSmooth);
  nF = select(nS, nF / max(lenF, 1e-20), lenF > 1e-5 * length(dX) * length(dY));
  let facetPx = v.cell / footprint;
  let facetFade = ${continuous ? "1.0" : "smoothstep(2.0, 6.0, facetPx)"};
  var n = normalize(mix(nS, nF, facetFade));
  // Facet identity switches when a vertex passes half-morph; fade the per-facet jitter to zero there so it never pops.
  let jit = ${continuous ? "0.0" : "facetFade * abs(v.morph * 2.0 - 1.0)"};
  let h = rand3(vec3u(v.facet, 0x2545f491u, 7u));
  let spin = h.z * TAU + t * (1.0 + floor(h.y * 3.0)) * (TAU / 60.0);
  n = normalize(n + vec3f(cos(spin), 0.0, sin(spin)) * (O.look[0].w * h.x * jit));
  let tint = 1.0 + (h.y - 0.5) * O.look[2].w * jit;

  // 3) Seabed at the displaced plan position. Near islands only: warp it (two octaves) so the bake's texels and its
  //    smooth contours never show, and take its slope and the seaward direction (gradient of the shore distance).
  var bed = bedAt(v.wp);
  var slope = 0.0;
  var seaward = vec2f(0.0);
  if (bed.r < 0.99 && (dbg & 32u) == 0u) {
    let warp = (vec2f(valueNoise(wq / 23.0, 51u), valueNoise(wq / 23.0 + 17.0, 53u)) - 0.5) * 7.0
             + (vec2f(valueNoise(wq / 120.0, 55u), valueNoise(wq / 120.0 + 9.0, 57u)) - 0.5) * 26.0;
    let bwp = v.wp + warp;
    bed = bedAt(bwp);
    let tx = O.sun.x * 1.5;
    let bedX = bedAt(bwp + vec2f(tx, 0.0));
    let bedZ = bedAt(bwp + vec2f(0.0, tx));
    slope = length(vec2f(bedX.r - bed.r, bedZ.r - bed.r)) * 40.0 / tx;
    let gB = vec2f(bedX.b - bed.b, bedZ.b - bed.b);
    seaward = gB / max(length(gB), 1e-6);
  }
  let depth = bed.r * 40.0;
  let shore = bed.b * 300.0;
${continuous ? /* wgsl */ `
  // Evaluate the same packed sea at the interpolated material coordinate, independent of mesh facets.
  // Displacement and buoyancy remain unchanged. All unresolved normal energy becomes roughness.
  var waterG = vec2f(0.0);
  var waterJ = vec3f(0.0);
  var waterVariance = 0.0;
  for (var i = 0u; i < u32(O.anchor.z); i++) {
    let w = O.waves[i];
    let sh = O.shape[i];
    let wavelength = TAU / w.z;
    let bandWeight = 1.0 - smoothstep(0.12, 0.45, footprint / wavelength);
    let damp = saturate(depth / clamp(1.57 / w.z, 1.5, 14.0));
    let phase = wavePhase(w, v.p);
    waterG += w.xy * sh.w * cos(phase) * bandWeight * damp;
    waterJ -= vec3f(w.x * w.x, w.x * w.y, w.y * w.y) * sh.z * sin(phase) * bandWeight * damp;
    waterVariance += 0.5 * sh.w * sh.w * damp * damp * (1.0 - bandWeight * bandWeight);
  }
  let waterDet = max((1.0 + waterJ.x) * (1.0 + waterJ.z) - waterJ.y * waterJ.y, 0.05);
  let waterSlope = vec2f((1.0 + waterJ.z) * waterG.x - waterJ.y * waterG.y,
    (1.0 + waterJ.x) * waterG.y - waterJ.y * waterG.x) / waterDet;
  let detail = waterDetail(q, t, footprint, O.look[9].w, O.look[8].w);
  let slopeWater = waterSlope * O.look[3].w + detail.xy + waterKelvin(v.wp, footprint);
  waterVariance = waterVariance * O.look[3].w * O.look[3].w + detail.z;
  n = normalize(vec3f(-slopeWater.x, 1.0, -slopeWater.y));
  nS = n;
` : ""}

  // Fragment band-split (brief §1, "high" option): swell waves the mesh filtered away but the pixel still resolves
  // come back as smooth shading, so the long swell bands stay readable from altitude and toward the horizon.
  // The same loop also evaluates the swell's crest foam per pixel, independent of the mesh LOD (which filters the
  // shorter swell pair out of distant facets): Jacobian squeeze and crest height now and at the memory taps, so long
  // swell crests carry broken white across the whole view, not only near the camera.
  var swG = v.swell;
  var Jn = vec3f(0.0);
  var Ja = vec4f(0.0);
  var Jb = vec4f(0.0);
  var Jc = vec4f(0.0);
  var Yn = 0.0;
  let ns = select(u32(O.look[12].y), 0u, (dbg & 4u) != 0u);
  for (var i = 0u; i < ns; i = i + 1u) {
    let w = O.waves[i];
    let sh = O.shape[i];
    let fMesh = waveFilter(w.z, v.cell);
    let fPix = saturate(PI / (w.z * 4.0 * footprint) - 1.0);
    let damp = saturate(depth / clamp(1.57 / w.z, 1.5, 14.0));
    let th = wavePhase(w, v.p);
    let c = cos(th);
    let sn = sin(th);
    swG += (1.0 - fMesh) * fPix * damp * sh.w * c * w.xy;
    let a = fPix * damp;
    let dd = vec3f(w.x * w.x, w.x * w.y, w.y * w.y);
    let mm = O.mem[i];
    let s0 = sn * mm.x + c * mm.y;
    let s1 = sn * mm.z + c * mm.w;
    let s2 = sn * O.mem2[i].x + c * O.mem2[i].y;
    Jn -= a * sh.z * sn * dd;
    Ja += a * vec4f(-sh.z * s0 * dd, sh.x * s0);
    Jb += a * vec4f(-sh.z * s1 * dd, sh.x * s1);
    Jc += a * vec4f(-sh.z * s2 * dd, sh.x * s2);
    Yn += a * sh.x * sn;
  }
  let sdS = O.foam.x;
  let loS = O.foam.y;
  var swellFoam = foamOf(vec4f(Jn, Yn), sdS, loS);
  var swellAge = 0.0;
  let fa0 = 0.85 * foamOf(Ja, sdS, loS + 0.1);
  if (fa0 > swellFoam) { swellFoam = fa0; swellAge = 0.1; }
  let fa1 = 0.75 * foamOf(Jb, sdS, loS - 0.15);
  if (fa1 > swellFoam) { swellFoam = fa1; swellAge = 0.4; }
  let fa2 = 0.5 * foamOf(Jc, sdS, loS - 0.3);
  if (fa2 > swellFoam) { swellFoam = fa2; swellAge = 0.7; }
  // Shading-only slope boost: the swell is gentle (kA ~ 0.01), so its tilt is exaggerated for shading (never for the
  // geometry, which must match physics) until the swell bands read like the concepts.
  let sb = O.sun.w;
  var nB = ${continuous ? "n" : "normalize(vec3f(n.x * k9.x - swG.x * sb, n.y, n.z * k9.x - swG.y * sb))"};
  // Rain dimples the water near the camera: rings break up the reflections.
  let rain = O.look[10].z;
  let dimpleNear = rain * (1.0 - smoothstep(0.03, 0.12, footprint));
  if (dimpleNear > 0.01) {
    let dt = rainDimple(wq, t) * dimpleNear * 0.35;
    nB = normalize(nB + vec3f(dt.x, 0.0, dt.y));
    n = normalize(n + vec3f(dt.x, 0.0, dt.y));
  }

  let V = normalize(-v.rel);
  let L = F.sunDir.xyz;
  // Where the sun disc sits (low, like the concepts): its glitter path and reflection glow. Lighting uses L.
  let Lv = O.sunView.xyz;
  let sun = F.sunColor.rgb * F.sunDir.w * (1.0 - v.shadow);
  let skyAmb = F.zenith.rgb * 0.6 + F.horizon.rgb * 0.25;

  // 4) Water body (SoT colour model): deep colour blended toward the subsurface colour by the wave-peak mask, the
  //    sun/view angle and the facet's tilt away from the sun, with the scatter boosted beyond realistic.
  let backlit = pow(saturate(dot(-V, Lv) * 0.5 + 0.5), 3.0);
  let away = pow(saturate(0.5 - 0.5 * dot(L, nB)), 2.0);
  let sss = v.peak * (k9.y + k9.z * backlit) * (0.3 + 1.2 * away) * mix(0.35, 1.0, facetFade)${continuous ? " * 0.35" : ""};
  // Stylised facet lighting: facets turned toward the sun read lighter, like a lit low-poly mesh.
  let facetLit = ${continuous ? "1.0" : "mix(1.0, saturate(0.5 + 0.65 * dot(nB, L) / max(L.y, 0.2)), O.look[7].w)"};
  let lightDeep = (sun * k6.z + skyAmb * k6.w) * facetLit;
  var body = mix(deep, scatter, saturate(sss)) * lightDeep;
  body += scatter * sun * O.look[1].w * v.peak * v.peak * backlit * away${continuous ? " * 0.25" : ""};
  body *= mix(0.85, 1.15, saturate(v.peak * 1.6));
  // Shallows: Beer-Lambert down to the bed and back up over sand and coral.
  if (depth < 39.0) {
    let cosT = sqrt(max(1.0 - (1.0 - V.y * V.y) / 1.777, 0.0));
    let path = depth * (1.0 + 1.0 / max(cosT, 0.35));
    let T = exp(-absorb * path);
    var cor = vec2f(0.0);
    if (bed.a > 0.01 && (dbg & 8u) == 0u) { cor = coral(wq, bed.a, footprint); }
    let bedAlb = mix(sand, coralCol * (0.7 + 0.6 * fract(cor.y * 7.31)), cor.x * k8.x);
    let bedLight = sun * max(L.y, 0.0) * k8.y + skyAmb * F.sunColor.w * 0.5;
    let inscatter = vec3f(0.0, 0.25, 0.37) * lightDeep;
    body = bedAlb * bedLight * T + mix(inscatter, body, smoothstep(6.0, 30.0, depth)) * (1.0 - T);
  }
  body *= tint;

  // 5) Sky reflection without the sun disc, Fresnel from a flattened normal (SoT recreations: facets shade the body
  //    strongly but the reflection doesn't flicker facet to facet at grazing angles).
  var R = reflect(-V, nB);
  R.y = abs(R.y);
  // Without the sun's horizon glow: a facet mirroring it at grazing angles turned the far sea under the sun into a
  // blown-out disc. The glints and the area-sun specular draw the sun path instead.
  let Rf = normalize(vec3f(R.x, 0.0, R.z) + vec3f(0.0, 1e-4, 0.0));
  let glowR = F.sunColor.rgb * sunGlow(Rf) * vec3f(0.74, 1.1, 1.55) * (1.0 - smoothstep(0.0, 0.38, R.y));
  let skyR = max(skyNoSunAt(R, Lv) - glowR * 0.85, vec3f(0.0)) * k6.x;
  let fl = O.look[12].z;
  let nFl = ${continuous ? "nB" : "normalize(vec3f(nB.x * fl, nB.y, nB.z * fl))"};
  let Fr = 0.02 + 0.98 * pow(1.0 - max(dot(nFl, V), 0.0), 5.0);
  var col = mix(body, skyR, ${continuous ? "min(Fr * O.look[12].w, 0.58)" : "min(Fr, k6.y * (1.0 - 0.3 * rain))"});

  // 6) Sun specular: GGX with a big area sun (SoT / Karis representative point), widened by the slope the mesh
  //    filtered away; far facets glitter instead of mirroring.
  let NoV = max(dot(n, V), 1e-3);
  let sunR = ${continuous ? "0.00465" : "O.sun.z"};
  let Ls = sunAreaDir(Lv, reflect(-V, n), sunR);
  let Hs = normalize(Ls + V);
  let a2 = k7.z + min(v.sigma2, 0.0004) + (1.0 - facetFade) * 0.0005;
  let ap = saturate(sqrt(a2) + tan(sunR) / 3.0);
  let NoH = saturate(dot(n, Hs));
  let dd = NoH * NoH * (a2 - 1.0) + 1.0;
  let Dg = a2 / (PI * dd * dd) * (a2 / (ap * ap));
  let FrS = 0.02 + 0.98 * pow(1.0 - NoV, 5.0);
  // The disc sits low: its reflection needs a view ray dipping only a little below the horizon. Looking steeply down
  // (from altitude) no facet can reflect it, so the broad lobe must not paint a light shaft across the sea.
  let dip = smoothstep(0.55, 0.3, -V.y + Lv.y);
  // Distant facets are many to a pixel: a smooth lobe there smears into a glowing disc, so it fades out with the
  // footprint and the glitter (sharp points) carries the sun path instead.
  let broad = mix(0.05, 1.0, facetFade * facetFade) * dip * mix(1.0, 0.04, smoothstep(0.35, 1.6, footprint));
  // Capped well below the bloom's knee on distant facets: the path is a streak of glints, not a glowing disc.
  // Under the moon (Frame extra.w) the area specular is lifted: its light is ~20x dimmer than the sun's.
  col += sun * (1.0 + 5.0 * F.extra.w) * sunVeil() * ${continuous
    ? "(0.12 * (1.0 - exp(-waterSpecular(n, V, Ls, O.look[11].z, waterVariance, sunR))) + 4.0 * waterGlints(wq, n, V, Lv, footIso)) * O.look[5].w"
    : "min(Dg * FrS * saturate(dot(n, Ls)) / (4.0 * max(NoV, 0.05)), k7.y * mix(0.08, 1.0, facetFade * facetFade) * mix(1.0, 0.25, smoothstep(0.6, 4.0, footprint))) * broad"};

  // 7) Glitter sparkles in the broad sun path.
  let wide = pow(saturate(dot(nS, normalize(Lv + V))), 10.0);
  ${continuous ? "// Continuous water's resolved normals carry the highlights; no random per-cell sparkles." : "if (wide * dip * sunVeil() > 0.01 && (dbg & 16u) == 0u) { col += sun * sunVeil() * glitter(q, n, V, Lv, footprint, t) * O.look[5].w * wide * dip; }"}

  // 8) Foam coverage: crest foam from the geometry, plus breaking surf near islands.
  var surf = 0.0;
  if (depth < 30.0 && (dbg & 128u) == 0u) {
    surf = surfCover(v.p, v.wp, wq, depth, shore, slope, seaward, footIso, t);
  }
  if ((dbg & 256u) != 0u) { return vec4f(surf, depth / 40.0, saturate(slope * 3.0), 1.0); }
  // Far away the crest foam thins to broken flecks (the clusters stay a few pixels, coverage drops).
  let crestCover = max(v.foam, swellFoam * mix(1.0, 0.6, smoothstep(1.0, 3.0, footprint)) * (1.0 - smoothstep(3.0, 6.0, footprint))) * O.look[4].w;
  let surfC = saturate(surf * k7.x);
  // Ship wakes: foam strength drawn into the camera-centred wake field by the hulls (src/render/ocean-wake.ts).
  let wuv = (v.wp - O.wake.xy) * O.wake.z + 0.5;
  let wk = textureSampleLevel(wakeTex, bedSamp, wuv, 0.0).rg * O.wake.w;
  let cover = saturate(max(max(crestCover, surfC), wk.x));
  if ((dbg & 512u) != 0u) { return vec4f(crestCover, wk.x, surfC, 1.0); }
  // Storm: wind-streak foam over the whole sea, densest on the crests (spindrift) and the backs of the swell (old foam
  // left behind), and the crest clusters carved into streaks along the wind.
  let st = O.look[10].y;
  var streak = vec2f(0.0, 1.0);
  if (st > 0.01) {
    let back = saturate(dot(swG, O.wind.zw) * 5.0);
    let crestTop = saturate(v.peak * 1.6 - 0.6);
    let dens = saturate(st * (0.08 + 0.6 * saturate(crestCover * 2.0) + 0.4 * back + 0.55 * crestTop));
    streak = windStreaks(wq, O.look[11].xy, dens, footIso);
    streak.x *= st;
  }
  if (cover > 0.03 || streak.x > 0.01) {
    let age = mix(select(v.age, swellAge, swellFoam > v.foam), wk.y, step(crestCover, wk.x));
    var fm = ${continuous ? "waterFoam(wq, cover, footIso, age)" : "foamMask(q, cover, footIso, age, t)"};
${continuous ? /* wgsl */ `
    // Wake coverage remains continuous even where crest foam breaks into isolated filaments.
    // The trajectory texture keeps the prop wash and arms on the displaced water surface.
    let churn = waterNoise(wq * vec2f(0.37, 0.81)).x;
    let bubbles = waterNoise(wq * 2.7 + churn).x;
    let filaments = smoothstep(0.24, 0.72, 0.65 * churn + 0.35 * bubbles);
    let wakeFoam = smoothstep(0.015, 0.55, wk.x) * (0.13 + 0.72 * filaments);
    fm.x = max(fm.x * (1.0 - smoothstep(0.0, 0.25, wk.x)), wakeFoam);
` : ""}
    // The storm wind tears the crest clusters into streaks (wake and surf foam keep their shapes).
    let carve = st * 0.85 * step(max(surfC, wk.x), crestCover);
    fm.x *= mix(1.0, smoothstep(0.35, 0.8, streak.y), carve);
    let m = max(fm.x, streak.x);
    let shade = select(fm.y, 0.85, streak.x > fm.x);
    // Foam lit by the facet it sits on (lighter and darker facets), with soft blue shadow inside the clusters.
    let lit = 0.3 + 0.7 * max(dot(n, L), 0.0);
    let shadowTint = mix(vec3f(0.55, 0.72, 0.92), vec3f(1.0), shade);
    let foamLit = foamCol * shadowTint * (sun * lit * shade + skyAmb * F.sunColor.w * 1.3) + nightSurf(surfC);
    col = mix(col, foamLit, m);
  }

  // 9) Haze toward the same colour the sky paints below the horizon, so the far plane cut is invisible.
  let dist = length(v.rel);
  // Under an overcast the far sea melts into the grey horizon a little sooner (no fog: only the far kilometres).
  col = mix(col, ${continuous ? "mix(seaHazeAt(-V, Lv), hazeColor(-V), 0.5 * (1.0 - smoothstep(0.0, 0.08, V.y)))" : "seaHazeAt(-V, Lv)"}, 1.0 - exp(-dist * F.horizon.w * k8.z * (1.0 + 1.5 * overcast())));
  return vec4f(col, 1.0);
}
` }

export const OCEAN_WGSL = oceanShader()
