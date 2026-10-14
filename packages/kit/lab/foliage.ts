import {
  BUSH_PRESETS,
  BUSH_PRESET_IDS,
  FOLIAGE_ACTOR_FLOATS,
  FOLIAGE_CROWN_SHAPES,
  FOLIAGE_KIND_LABELS,
  FOLIAGE_PARAM_SPECS,
  FOLIAGE_WIND_FLOATS,
  GRASS_PRESETS,
  GRASS_PRESET_IDS,
  TREE_PRESETS,
  TREE_PRESET_IDS,
  applyFoliagePreset,
  buildFoliageBush,
  buildFoliageTree,
  emitGrassClump,
  emitGrassTuft,
  emitHydrangeaPanicles,
  foliagePresetFor,
  foliageSettings,
  foliageTextureUrls,
  foliageWindDeclarationsWgsl,
  getFoliageTexturesRevision,
  isFoliageCrownShape,
  packFoliageActors,
  packFoliageUniforms,
  randomizeFoliageParams,
  scatterGrassClumps,
  type FoliageKind,
  type FoliageLabTool,
  type FoliageLighting,
  type FoliageParams,
  type FoliageTextureSlot,
} from "../gpu/foliage"
import { LOOK_PRESETS, LOOK_UNIFORM_FLOATS, createLookSettings, lookStructWgsl, packLookUniforms, type LookPresetId } from "../gpu/look"
import { MAT, Mesh, VERT_BYTES, type Rgb } from "../gpu/mesh"
import { surfaceMaterialCoreWgsl } from "../gpu/surface-materials"
import type { LabControl } from "../lab-panel"
import { Rng } from "../sim/rng"
import { frameShader } from "./stage-shader"
import type { LabContext, LabLibraryItem, LabSection, LabWorldObject } from "./types"

const rgb = (v: number): Rgb => [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]

export const FOLIAGE_LIGHTINGS: Readonly<Record<FoliageLighting, { label: string; summary: string }>> = {
  night: { label: "Night: streetlamp + flashlight + moon", summary: "Outbreak 23:00 — 2100K sodium lamp, cool moon, walker's flashlight" },
  dusk: { label: "Dusk: low warm sun + lamp", summary: "Outbreak 18:00 — low amber key, lamp warming up" },
  day: { label: "Day: overcast sun", summary: "Neutral daylight for checking colour and silhouette" },
}

/** Look presets offered in the Vegetation room (post grade only; the games' scene-side look terms are not applied). */
export const FOLIAGE_LOOKS: readonly LookPresetId[] = ["current", "noir", "sodium_70s", "cozy_golden_hour", "cinematic_dusk", "painterly"]

const TOOLS: readonly { value: FoliageLabTool; label: string }[] = [
  { value: "tree", label: "Tree" },
  { value: "bush", label: "Bush" },
  { value: "grass", label: "Grass" },
  { value: "lot", label: "Outbreak lot (all three)" },
]

const MAX_OCCLUDERS = 16
type Occluder = readonly [x: number, z: number, radius: number, strength: number]
type Room = { mesh: ArrayBuffer; occluders: Occluder[]; lamp: readonly [number, number, number]; windows: readonly (readonly [number, number, number])[] }

const vegetationShader =
  frameShader +
  /* wgsl */ `
fn hash2(p: vec2f) -> f32 {
  let q = fract(p * vec2f(0.1031, 0.1030));
  let r = q + dot(q, q.yx + 33.33);
  return fract((r.x + r.y) * r.x);
}
` +
  surfaceMaterialCoreWgsl +
  foliageWindDeclarationsWgsl +
  /* wgsl */ `
struct VegUniforms {
  // x: time, y: daylight 0..1, z: room (0 lot, 1 tree, 2 bush, 3 grass), w: occluder count
  config: vec4f,
  // x: dryPatches, y: grassVariation, z: sun warmth 0..1, w: unused
  extra: vec4f,
  wind: FoliageWindConfig,
  actors: FoliageActors,
  occ: array<vec4f, ${MAX_OCCLUDERS}>,
}

@group(0) @binding(1) var<uniform> U: VegUniforms;
@group(0) @binding(2) var foliageTexArray: texture_2d_array<f32>;
@group(0) @binding(3) var foliageSamp: sampler;

struct VIn {
  @location(0) pos: vec3f,
  @location(1) normal: vec4f,
  @location(2) color: vec4f,
  @location(3) matAux: vec2f,
}

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) color: vec3f,
  @location(3) @interpolate(flat) mat: f32,
  @location(4) aux: f32,
}

@vertex fn vs(v: VIn) -> VOut {
  var o: VOut;
  var world = v.pos;
  var norm = normalize(v.normal.xyz);
  if (i32(round(v.matAux.x)) == 22) {
    let fw = applyFoliageVertexWind(world, norm, v.matAux.y, U.config.x, F.eye.xyz, U.wind, U.actors);
    world = fw[0];
    norm = fw[1];
  }
  o.world = world;
  o.pos = F.vp * vec4f(world, 1.0);
  o.normal = norm;
  o.color = pow(max(v.color.rgb, vec3f(0.01)), vec3f(2.2));
  o.mat = v.matAux.x;
  o.aux = v.matAux.y;
  return o;
}

fn contactOcclusion(p: vec2f) -> f32 {
  var occ = 0.0;
  let count = i32(U.config.w);
  for (var i = 0; i < ${MAX_OCCLUDERS}; i++) {
    if (i >= count) { break; }
    let c = U.occ[i];
    let d = length(p - c.xy) / max(c.z, 0.05);
    occ = max(occ, exp(-d * d * 1.6) * c.w);
  }
  return occ;
}

@fragment fn fs(o: VOut) -> @location(0) vec4f {
  surfaceFootprint = max(length(dpdx(o.world)), length(dpdy(o.world)));
  surfaceTime = U.config.x;
  surfaceNormalShift = vec3f(0.0);

  let mat = i32(round(o.mat));
  var n = normalize(o.normal);
  let V = normalize(F.eye.xyz - o.world);
  let day = U.config.y;

  let grassUv = o.world.xz * 0.42;
  let barkUv = vec2f(o.world.x + o.world.z, o.world.y * 0.48);
  let leafUv = vec2f(o.world.x + o.world.z * 0.73 + o.world.y * 0.41, o.world.y * 1.17 - o.world.x * 0.43 + o.world.z * 0.81) * 0.85;
  let texGrass = pow(max(textureSample(foliageTexArray, foliageSamp, grassUv, 0).rgb, vec3f(0.01)), vec3f(2.2));
  let texGrassNorm = textureSample(foliageTexArray, foliageSamp, grassUv * 1.6, 1).rgb * 2.0 - 1.0;
  let texBark = pow(max(textureSample(foliageTexArray, foliageSamp, barkUv, 2).rgb, vec3f(0.01)), vec3f(2.2));
  let texLeaf = pow(max(textureSample(foliageTexArray, foliageSamp, leafUv, 3).rgb, vec3f(0.01)), vec3f(2.2));

  if (mat == 2) {
    return vec4f(o.color * mix(2.8, 1.2, day), 1.0);
  }

  var albedo = o.color;
  var gloss = vec2f(0.0);
  var cavity = 1.0;
  let isFoliage = mat == 22;
  let tip = foliageTipWeight(o.aux);

  if (mat == 20) {
    let kind = i32(round(o.aux));
    let p = o.world.xz;
    let grassMod = clamp(texGrass / vec3f(0.045, 0.085, 0.022), vec3f(0.68), vec3f(1.36));
    if (kind == 0 || kind == 6) {
      var r = defaultMaterialRecipe(4);
      r.u2.x = clamp(0.42 + U.extra.y * 0.45, 0.0, 1.0);
      r.u2.z = clamp(U.extra.x * 0.52, 0.0, 1.0);
      r.u2.w = clamp(0.35 + U.extra.x * 0.45, 0.0, 1.0);
      let s = evalGrassSoil(p, albedo, kind == 6, r);
      albedo = s.albedo * mix(vec3f(1.0), grassMod, 0.55);
      gloss = s.gloss;
      cavity = s.cavity;
      n = normalize(n + surfaceNormalShift + vec3f(texGrassNorm.x * 0.24, 0.0, texGrassNorm.y * 0.24));
    } else if (kind == 1) {
      let s = evalAsphaltConcrete(p, albedo, false, defaultMaterialRecipe(3));
      albedo = s.albedo;
      gloss = s.gloss;
      cavity = s.cavity;
    } else if (kind == 2) {
      let s = evalAsphaltConcrete(p, albedo, true, defaultMaterialRecipe(3));
      albedo = s.albedo;
      gloss = s.gloss;
      cavity = s.cavity;
    } else if (kind == 3) {
      albedo *= 0.72 + grain(p, 16.0) * 0.65 + surfaceNoise(p * 3.0) * 0.35;
    } else if (kind == 5) {
      let s = evalGrassSoil(p, albedo, true, defaultMaterialRecipe(4));
      albedo = s.albedo;
      gloss = s.gloss;
      cavity = s.cavity;
      n = normalize(n + surfaceNormalShift);
    }
    cavity *= 1.0 - contactOcclusion(p);
  } else if (mat == 4 && o.aux > 19.5) {
    let row = floor(o.world.y / 0.18);
    let plank = floor((o.world.x + o.world.z + row * 0.43) / 2.2);
    albedo *= 0.95 + (hash2(vec2f(row, plank)) - 0.5) * 0.08;
    albedo *= mix(0.70, 1.0, seam(o.world.y / 0.18, 0.025, 5.55));
  } else if (mat == 21) {
    let row = floor(o.world.z / 0.24);
    let q = vec2f(o.world.x / 0.36 + fract(row * 0.5), o.world.z / 0.24);
    albedo *= 0.97 + (hash2(floor(q)) - 0.5) * 0.30 * (1.0 - smoothstep(0.12, 0.5, surfaceFootprint * 4.16));
    albedo *= mix(0.55, 1.0, seam(q.x, 0.018, 2.77) * seam(q.y, 0.035, 4.16));
  } else if (mat == 23) {
    let p = vec2f(o.world.x + o.world.z, o.world.y);
    let row = floor(p.y / 0.085);
    let q = vec2f(p.x / 0.25 + fract(row * 0.5), p.y / 0.085);
    albedo = mix(vec3f(0.32, 0.30, 0.26), albedo * (0.8 + 0.35 * hash2(floor(q))), seam(q.x, 0.025, 4.0) * seam(q.y, 0.06, 11.76));
  } else if (mat == 24) {
    albedo *= 0.84 + surfaceNoise(vec2f(o.world.x + o.world.z, o.world.y * 0.18) * 28.0) * 0.24;
    albedo *= mix(vec3f(1.0), clamp(texBark / vec3f(0.065, 0.048, 0.034), vec3f(0.60), vec3f(1.42)), 0.65);
  } else if (isFoliage) {
    if (o.aux < -1.5) {
      let shellT = clamp(-o.aux - 2.0, 0.0, 1.0);
      albedo *= mix(0.38, 1.18, pow(shellT, 0.62));
      cavity = mix(0.46, 1.0, shellT);
    } else if (o.aux < -0.02) {
      let bladeT = clamp(-o.aux, 0.0, 1.0);
      let vein = grain(o.world.xz * 2.4 + vec2f(o.world.y * 1.6), 16.0) * 0.10;
      albedo = albedo * (0.95 + vein) * mix(0.82, 1.04, pow(bladeT, 0.62));
      gloss = vec2f(48.0, 0.22 * bladeT);
      cavity = mix(0.3, 1.0, smoothstep(0.0, 0.32, bladeT)) * (1.0 - contactOcclusion(o.world.xz) * 0.55);
    } else {
      let s = evalFoliageCanopy(o.world, n, albedo, defaultMaterialRecipe(5));
      let leafMod = clamp(texLeaf / vec3f(0.048, 0.092, 0.024), vec3f(0.66), vec3f(1.36));
      albedo = s.albedo * mix(vec3f(1.0), leafMod, 0.48);
      gloss = s.gloss;
      cavity = s.cavity;
      n = normalize(n + surfaceNormalShift);
    }
  }

  let trans = select(0.0, foliageTranslucency(o.aux, U.wind) * (0.35 + 0.65 * tip), isFoliage);
  let wrap = select(0.18, 0.36, isFoliage);
  let skyAmb = mix(F.ambient.rgb * vec3f(0.56, 0.68, 0.88) * 0.62, vec3f(0.36, 0.4, 0.46), day);
  var diff = skyAmb * (0.44 + 0.48 * max(n.y, 0.0)) * cavity;
  var transAcc = vec3f(0.0);
  let keyDir = normalize(F.moon.xyz);
  let keyCol = mix(vec3f(0.46, 0.62, 0.92), mix(vec3f(1.0, 0.95, 0.86), vec3f(1.0, 0.72, 0.42), U.extra.z) * 1.8, day) * F.moon.w;
  let keyNdl = max(0.0, (dot(n, keyDir) + wrap) / (1.0 + wrap));
  diff += keyCol * keyNdl * cavity;
  transAcc += keyCol * max(0.0, dot(-n, keyDir)) * 0.5;

  var spec = vec3f(0.0);
  let lightCount = min(8, i32(F.options.x));
  for (var i = 0; i < lightCount; i++) {
    let lpos = F.lights[i * 3];
    let lcol = F.lights[i * 3 + 1];
    let lcone = F.lights[i * 3 + 2];
    let delta = lpos.xyz - o.world;
    let dist = length(delta);
    if (dist >= lpos.w || lcol.w <= 0.001) { continue; }
    let ldir = delta / max(dist, 0.001);
    var atten = pow(max(0.0, 1.0 - dist / lpos.w), 2.2) * lcol.w;
    if (lcone.w > -1.0) {
      atten *= smoothstep(lcone.w, min(1.0, lcone.w + 0.08), dot(-ldir, lcone.xyz));
    }
    let ndl = max(0.0, (dot(n, ldir) + wrap) / (1.0 + wrap));
    diff += lcol.rgb * atten * ndl * mix(0.62, 1.0, cavity);
    // Thin-lamina transmission: back-lit leaves glow, and any leaf inside a beam scatters some light forward.
    transAcc += lcol.rgb * atten * (max(0.0, dot(-n, ldir)) * 0.7 + 0.22);
    if (gloss.x > 0.0 && gloss.y > 0.0) {
      let h = normalize(ldir + V);
      spec += lcol.rgb * atten * pow(max(0.0, dot(n, h)), gloss.x) * (gloss.x + 2.0) * 0.008 * gloss.y;
    }
  }

  var color = albedo * diff + spec;
  if (isFoliage) {
    let chloro = mix(vec3f(1.05, 1.35, 0.45), vec3f(1.35, 1.6, 0.55), tip);
    color += albedo * chloro * transAcc * trans;
    let fresnel = pow(1.0 - max(dot(n, V), 0.0), 4.0) * 0.14 * tip * max(0.15, F.moon.w);
    color += albedo * vec3f(0.32, 0.52, 0.22) * fresnel;
  }
  if (F.options.z == 3.0) {
    color = diff * 1.6 + spec * 2.5;
  } else if (F.options.z == 5.0) {
    color = n * 0.5 + 0.5;
  }
  return vec4f(color, 1.0);
}
`

const lookPostShader =
  lookStructWgsl +
  /* wgsl */ `
@group(0) @binding(0) var<uniform> L: LookUniforms;
@group(0) @binding(1) var tScene: texture_2d<f32>;
@group(0) @binding(2) var sLin: sampler;
@group(0) @binding(3) var<uniform> P: vec4f;

struct VSOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f }

@vertex fn vs(@builtin(vertex_index) i: u32) -> VSOut {
  let c = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VSOut;
  o.pos = vec4f(c[i], 0.0, 1.0);
  o.uv = c[i] * vec2f(0.5, -0.5) + 0.5;
  return o;
}

@fragment fn fs(o: VSOut) -> @location(0) vec4f {
  let dims = vec2f(textureDimensions(tScene));
  let texel = 1.0 / max(dims, vec2f(1.0));
  let hdr = textureSampleLevel(tScene, sLin, o.uv, 0.0).rgb;
  var bloom = vec3f(0.0);
  for (var k = 0; k < 8; k++) {
    let a = f32(k) * 0.785398;
    let c = textureSampleLevel(tScene, sLin, clamp(o.uv + vec2f(cos(a), sin(a)) * texel * 6.0, vec2f(0.002), vec2f(0.998)), 0.0).rgb;
    let pk = max(c.r, max(c.g, c.b));
    bloom += c * pow(clamp((pk - 0.6) / 0.8, 0.0, 1.0), 2.0) * 0.125;
  }
  let graded = lookGradeColor(L, hdr, bloom, o.uv, o.pos.xy, P.x, 0.0, 0.32, 0.55, 0.0);
  return vec4f(graded, 1.0);
}
`

function addLawn(m: Mesh, x0: number, z0: number, x1: number, z1: number): void {
  m.box(x0, -0.08, z0, x1, 0.0, z1, rgb(0x303e22), MAT.ground, 0)
}

function addStreetEdge(m: Mesh, x0: number, x1: number, z: number): void {
  // Sidewalk (z .. z+1.6), straight grass verge (z+1.6 .. z+2.3), curb, asphalt
  m.box(x0, -0.06, z, x1, 0.08, z + 1.6, rgb(0x767b86), MAT.ground, 2)
  m.box(x0, -0.08, z + 1.6, x1, 0.02, z + 2.3, rgb(0x2c381e), MAT.ground, 6)
  m.box(x0, -0.06, z + 2.3, x1, 0.12, z + 2.45, rgb(0x8a8e96), MAT.ground, 2)
  m.box(x0, -0.1, z + 2.45, x1, 0.014, z + 7, rgb(0x343c4a), MAT.ground, 1)
}

function addStreetlamp(m: Mesh, lx: number, lz: number): void {
  m.prism(lx, lz, 0.12, 0.065, 0.08, 3.8, 8, rgb(0x353d3c))
  m.box(lx - 0.7, 3.65, lz - 0.08, lx + 0.08, 3.8, lz + 0.08, rgb(0x353d3c))
  m.box(lx - 0.8, 3.55, lz - 0.18, lx - 0.3, 3.65, lz + 0.18, rgb(0xffc980), MAT.lamp, 0)
}

function addLawnGrass(
  m: Mesh,
  seed: number,
  params: Readonly<FoliageParams>,
  bounds: readonly [number, number, number, number],
  clusters: number,
  avoid: (x: number, z: number) => boolean,
): void {
  const rng = new Rng(seed ^ 0x51a9)
  for (const c of scatterGrassClumps({ seed, bounds, clusterCount: clusters, tuftsPerCluster: 4, params, avoid })) {
    emitGrassClump(m, c, 0, rng, 1.12)
  }
}

function addVergeGrass(m: Mesh, seed: number, params: Readonly<FoliageParams>, x0: number, x1: number, z: number): void {
  const rng = new Rng(seed ^ 0x91e1)
  for (let vx = x0; vx <= x1; vx += 0.32 + rng.next() * 0.42) {
    emitGrassTuft(m, vx, 0.02, z + 0.1 + rng.next() * 0.5, {
      bladeCount: 3,
      radius: 0.14 + rng.next() * 0.08,
      height: params.bladeHeight * (0.8 + rng.next() * 0.5),
      width: params.bladeWidth,
      curvature: params.bladeCurvature,
      leanAngle: rng.next() * Math.PI * 2,
      rootColor: [params.rootColorR, params.rootColorG, params.rootColorB],
      tipColor: [params.tipColorR, params.tipColorG, params.tipColorB],
      rng,
    })
  }
}

/** Tree room: three trees of the current recipe on a lawn beside a street, with a streetlamp. */
function buildTreeRoom(seed: number, params: Readonly<FoliageParams>): Room {
  const m = new Mesh()
  addLawn(m, -12, -9, 12, 3)
  addStreetEdge(m, -12, 12, 3)
  addStreetlamp(m, 3.6, 4.7)
  const trees: [number, number, number, number][] = [
    [0, -1.2, 1, seed * 31 + 7],
    [-6.8, -4.5, 0.86, seed * 59 + 19],
    [6.6, -5.2, 0.92, seed * 47 + 13],
  ]
  const occluders: Occluder[] = []
  for (const [x, z, k, s] of trees) {
    buildFoliageTree(m, x, z, params.treeHeight * k, params.crownRadius * k, s, 0, params, params.crownShape)
    occluders.push([x, z, params.crownRadius * k * 0.95, 0.5], [x, z, 0.7, 0.35])
  }
  addLawnGrass(m, seed ^ 0x453a, params, [-11.5, -8.5, 11.5, 2.9], 110, (x, z) => trees.some(([tx, tz]) => Math.hypot(x - tx, z - tz) < 0.35))
  addVergeGrass(m, seed, params, -11.5, 11.5, 4.6)
  return { mesh: m.pack(), occluders, lamp: [3.0, 3.55, 4.7], windows: [] }
}

/** Bush room: a house front with lit windows, a foundation planting, a free-standing shrub and a hedge line. */
function buildBushRoom(seed: number, params: Readonly<FoliageParams>): Room {
  const m = new Mesh()
  addLawn(m, -9, -5, 9, 2)
  addStreetEdge(m, -9, 9, 2)
  addStreetlamp(m, 6.6, 3.7)
  const wall = rgb(0x667068), trim = rgb(0xc8c5ba)
  m.box(-8, 0.0, -6.2, 8, 2.8, -4.4, wall, MAT.wall, 20)
  m.box(-8.02, 0.0, -6.22, 8.02, 0.3, -4.38, rgb(0x5c3a30), MAT.brick)
  m.box(-8.4, 2.8, -6.5, 8.4, 3.0, -4.1, rgb(0x323b4a), MAT.roof, 0)
  const windows: [number, number, number][] = []
  for (const wx of [-5, 0, 5]) {
    m.box(wx - 1.2, 0.86, -4.42, wx + 1.2, 2.1, -4.36, rgb(0xc47e38), MAT.lamp, 0)
    m.box(wx - 1.28, 0.78, -4.42, wx + 1.28, 0.86, -4.32, trim, MAT.wall)
    windows.push([wx, 1.4, -4.0])
  }
  m.box(-8, -0.06, -4.4, 8, 0.012, -3.1, rgb(0x2a2016), MAT.ground, 5)
  const rng = new Rng(seed + 71)
  const occluders: Occluder[] = []
  const plant = (x: number, z: number, h: number, r: number) => {
    buildFoliageBush(m, x, z, h, r, Math.floor(rng.next() * 1e6), 0, params)
    occluders.push([x, z, r * params.bushSpread * 1.15, 0.55])
  }
  for (const [x, z, h, r] of [
    [-6.9, -3.75, 1.2, 0.8], [-5.6, -3.6, 0.72, 0.58], [-4.3, -3.7, 0.66, 0.55], [-2.8, -3.65, 1.05, 0.72],
    [-1.4, -3.7, 0.7, 0.56], [1.4, -3.7, 0.74, 0.58], [2.9, -3.65, 1.1, 0.74], [4.4, -3.7, 0.64, 0.52],
    [5.7, -3.6, 0.78, 0.6], [7.0, -3.75, 1.18, 0.82],
  ] as const) plant(x, z, h, r)
  plant(-3.2, -0.6, 1.35, 1.0)
  for (let x = 2.6; x <= 8.4; x += 1.1) plant(x, -0.4, 1.0, 0.62)
  addLawnGrass(m, seed ^ 0x2c91, params, [-8.8, -3.0, 8.8, 1.95], 70, (x, z) => occluders.some(([ox, oz, r]) => Math.hypot(x - ox, z - oz) < r * 0.6))
  addVergeGrass(m, seed, params, -8.8, 8.8, 3.6)
  return { mesh: m.pack(), occluders, lamp: [5.9, 3.55, 3.7], windows }
}

/** Grass room: a lawn running into a weedy verge, a mulch edge and a sidewalk, so blade, clump and colour read at game zoom. */
function buildGrassRoom(seed: number, params: Readonly<FoliageParams>): Room {
  const m = new Mesh()
  addLawn(m, -8, -6, 8, 1)
  addStreetEdge(m, -8, 8, 1)
  addStreetlamp(m, 4.4, 2.7)
  m.box(-8, -0.06, -6, -5.5, 0.012, 1, rgb(0x2a2016), MAT.ground, 5)
  m.box(-0.7, -0.06, -6, 0.7, 0.09, 1, rgb(0xa6a194), MAT.ground, 2)
  addLawnGrass(m, seed ^ 0x2c91, params, [-5.4, -5.8, 7.8, 0.95], 150, (x, z) => (x > -0.8 && x < 0.8) || z < -5.9)
  addVergeGrass(m, seed, params, -7.8, 7.8, 2.6)
  return { mesh: m.pack(), occluders: [], lamp: [3.8, 3.55, 2.7], windows: [] }
}

/** Outbreak-style house lot: bungalow facade, foundation planting, framing trees, lawn and verge. */
function buildLotRoom(seed: number, params: Readonly<FoliageParams>): Room {
  const m = new Mesh()
  const x = -7.5, r = 7.5, z = -6.5, e = -1.5
  const mid = (z + e) / 2
  const trim = rgb(0xc8c5ba), roof = rgb(0x323b4a), brick = rgb(0x5c3a30)
  addLawn(m, -11.6, -6.8, 11.6, 2.0)
  addStreetEdge(m, -11.6, 11.6, 2.0)
  m.box(-0.72, 0.0, e + 1.3, 0.72, 0.09, 2.0, rgb(0xa6a194), MAT.ground, 2)
  m.box(-1.35, 0.0, e, 1.35, 0.11, e + 1.3, rgb(0xa29d90), MAT.ground, 2)
  m.box(x - 3.0, 0.0, z, x - 0.35, 0.032, 2.0, rgb(0x646659), MAT.ground, 3)
  m.box(x, 0.12, z, r, 2.8, e, rgb(0x667068), MAT.wall, 20)
  m.box(x - 0.02, 0.02, z - 0.02, r + 0.02, 0.28, e + 0.02, brick, MAT.brick)
  m.quadAuto([x - 0.42, 2.88, e + 0.42], [r + 0.42, 2.88, e + 0.42], [r + 0.42, 4.35, mid], [x - 0.42, 4.35, mid], roof, MAT.roof, 0)
  m.quadAuto([x - 0.42, 4.35, mid], [r + 0.42, 4.35, mid], [r + 0.42, 2.88, z - 0.42], [x - 0.42, 2.88, z - 0.42], roof, MAT.roof, 0)
  m.box(-0.68, 0.12, e - 0.04, 0.68, 2.32, e + 0.04, rgb(0x796045), MAT.wall)
  m.box(0.95, 1.72, e + 0.02, 1.15, 2.06, e + 0.16, rgb(0xffd49a), MAT.lamp, 0)
  const windows: [number, number, number][] = []
  for (const [wx0, wx1] of [[x + 1.4, x + 4.3], [r - 4.3, r - 1.4]] as const) {
    m.box(wx0 - 0.08, 0.78, e - 0.04, wx1 + 0.08, 0.87, e + 0.12, trim, MAT.wall)
    m.box(wx0 + 0.04, 0.88, e + 0.01, wx1 - 0.04, 2.11, e + 0.03, rgb(0xc47e38), MAT.lamp, 0)
    windows.push([(wx0 + wx1) / 2, 1.5, e + 0.6])
  }
  addStreetlamp(m, 4.2, 3.65)
  const occluders: Occluder[] = []
  const rng = new Rng(seed + 71)
  for (const [px, pz, k, s] of [
    [-6.2, -0.25, 1.15, seed * 31 + 7], [6.2, -0.25, 1.15, seed * 31 + 11], [-9.2, -2.4, 1.1, seed * 59 + 19], [8.6, -2.4, 1.1, seed * 59 + 23],
  ] as const) {
    buildFoliageTree(m, px, pz, params.treeHeight * k, params.crownRadius * k, s, 0.018, params)
    occluders.push([px, pz, params.crownRadius * k * 0.95, 0.5])
  }
  for (const [px, pz, ph, pr] of [
    [x + 0.35, e + 0.56, 1.18, 0.8], [x + 1.65, e + 0.46, 0.72, 0.58], [x + 3.25, e + 0.44, 0.66, 0.54], [-1.95, e + 0.58, 1.08, 0.72],
    [1.95, e + 0.58, 1.08, 0.72], [3.75, e + 0.62, 0.66, 0.52], [5.45, e + 0.66, 0.66, 0.5], [r - 1.05, e + 0.62, 1.16, 0.84],
  ] as const) {
    buildFoliageBush(m, px, pz, ph, pr, Math.floor(rng.next() * 1e6), 0.018, params)
    occluders.push([px, pz, pr * params.bushSpread * 1.15, 0.55])
  }
  emitHydrangeaPanicles(m, r - 1.05, 0.018, e + 0.62, 1.16, 0.84, seed + 31)
  addLawnGrass(m, seed ^ 0x453a, params, [-11.0, -0.62, 11.0, 1.94], 115, (gx, gz) => (gx > -0.88 && gx < 0.88) || (gx < -7.75 && gx > -10.55))
  addVergeGrass(m, seed, params, -11, 11, 3.6)
  return { mesh: m.pack(), occluders, lamp: [3.6, 3.55, 3.65], windows }
}

const ROOM_BUILDERS: Record<FoliageLabTool, (seed: number, params: Readonly<FoliageParams>) => Room> = {
  tree: buildTreeRoom,
  bush: buildBushRoom,
  grass: buildGrassRoom,
  lot: buildLotRoom,
}

/** Walker loop per room: actors trample grass and part bushes; the lead actor carries the night flashlight. */
function walkerPath(tool: FoliageLabTool, t: number): { x: number; z: number; heading: number } {
  const loop = (cx: number, cz: number, rx: number, rz: number, speed: number) => {
    const a = (t * speed) / Math.max(rx, rz)
    return { x: cx + Math.cos(a) * rx, z: cz + Math.sin(a) * rz, heading: Math.atan2(Math.cos(a) * rz, -Math.sin(a) * rx) }
  }
  if (tool === "tree") return loop(0, -1.2, 3.6, 2.4, 1.3)
  if (tool === "bush") return loop(0, -2.2, 6.2, 1.25, 1.3)
  if (tool === "grass") return loop(2.6, -2.6, 3.6, 2.2, 1.2)
  return loop(0, 0.2, 7.5, 0.9, 1.3)
}

const CAMERAS: Record<FoliageLabTool, { game: [number, number, number, number]; close: [number, number, number, number] }> = {
  tree: { game: [0, 0.5, -1.0, 27], close: [0.6, 2.6, -0.6, 12] },
  bush: { game: [0, 0.4, -2.0, 19], close: [-3.0, 0.7, -2.6, 7.5] },
  grass: { game: [1.0, 0.1, -1.6, 15], close: [2.4, 0.1, -2.2, 4.8] },
  lot: { game: [0, 0.5, 0.4, 29], close: [2.2, 1.35, 0.6, 8.8] },
}

function buildActorMesh(actors: readonly { x: number; z: number; heading: number; zombie: boolean }[]): ArrayBuffer {
  const m = new Mesh()
  for (const a of actors) {
    const body = a.zombie ? rgb(0x4d5a3e) : rgb(0x3b4656)
    m.prism(a.x, a.z, 0.2, 0.17, 0.0, 1.32, 8, body, MAT.actor)
    m.prism(a.x, a.z, 0.12, 0.1, 1.38, 1.66, 8, rgb(0xb59a80), MAT.actor)
    const hx = a.x + Math.cos(a.heading) * 0.24, hz = a.z + Math.sin(a.heading) * 0.24
    if (!a.zombie) m.prism(hx, hz, 0.045, 0.045, 1.0, 1.14, 6, rgb(0x202020), MAT.actor)
  }
  return m.pack()
}

export function createFoliage(context: LabContext): LabSection {
  const { device, stage } = context

  const settings: Record<string, string | number | boolean> = {
    tool: "tree",
    lighting: "night",
    look: "sodium_70s",
    cameraMode: "game",
    walker: true,
    flashlight: true,
    playing: true,
    seed: 7,
    tuningSeed: 41,
  }

  let meshDirty = true
  let simTime = 0
  const tool = (): FoliageLabTool => {
    const t = settings.tool
    return t === "bush" || t === "grass" || t === "lot" ? t : "tree"
  }
  const kindOf = (t: FoliageLabTool): FoliageKind | "all" => (t === "lot" ? "all" : t)

  const defineParam = (key: string, get: () => unknown, set: (v: unknown) => void) =>
    Object.defineProperty(settings, key, { configurable: true, enumerable: true, get, set })
  defineParam("treePreset", () => foliageSettings.treePreset, v => {
    if (typeof v === "string" && v in TREE_PRESETS) applyFoliagePreset("tree", v), (meshDirty = true)
  })
  defineParam("bushPreset", () => foliageSettings.bushPreset, v => {
    if (typeof v === "string" && v in BUSH_PRESETS) applyFoliagePreset("bush", v), (meshDirty = true)
  })
  defineParam("grassPreset", () => foliageSettings.grassPreset, v => {
    if (typeof v === "string" && v in GRASS_PRESETS) applyFoliagePreset("grass", v), (meshDirty = true)
  })
  defineParam("crownShape", () => foliageSettings.crownShape, v => {
    if (isFoliageCrownShape(v)) (foliageSettings.crownShape = v), (meshDirty = true)
  })
  for (const s of FOLIAGE_PARAM_SPECS) {
    defineParam(s.key, () => foliageSettings[s.key], v => {
      if (typeof v !== "number" || !Number.isFinite(v)) return
      const clamped = Math.max(s.min, Math.min(s.max, v))
      if (foliageSettings[s.key] === clamped) return
      foliageSettings[s.key] = clamped
      if (s.boundary === "structural") meshDirty = true
    })
  }

  const frameBuffer = device.createBuffer({ size: 148 * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  const U_FLOATS = 8 + FOLIAGE_WIND_FLOATS + FOLIAGE_ACTOR_FLOATS + MAX_OCCLUDERS * 4
  const uniformData = new Float32Array(U_FLOATS)
  const uniformBuffer = device.createBuffer({ size: U_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })

  const TEX_SZ = 256
  const foliageTex = device.createTexture({
    label: "Lab vegetation texture array",
    size: [TEX_SZ, TEX_SZ, 4],
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
  })
  // Neutral layer means so the first frames are identity-modulated before the WebP maps decode.
  const neutralLayers: readonly [number, number, number, number][] = [
    [62, 82, 44, 255],
    [128, 128, 255, 255],
    [72, 62, 50, 255],
    [66, 90, 46, 255],
  ]
  for (let layer = 0; layer < 4; layer++) {
    const buf = new Uint8Array(TEX_SZ * TEX_SZ * 4)
    const c = neutralLayers[layer]!
    for (let i = 0; i < buf.length; i += 4) buf.set(c, i)
    device.queue.writeTexture({ texture: foliageTex, origin: [0, 0, layer] }, buf, { bytesPerRow: TEX_SZ * 4, rowsPerImage: TEX_SZ }, [TEX_SZ, TEX_SZ, 1])
  }
  const foliageView = foliageTex.createView({ dimension: "2d-array", arrayLayerCount: 4 })
  const foliageSamp = device.createSampler({ addressModeU: "repeat", addressModeV: "repeat", magFilter: "linear", minFilter: "linear", mipmapFilter: "linear" })

  let loadedTexRev = 0
  const slotOrder: readonly FoliageTextureSlot[] = ["grassAlbedo", "grassNormal", "barkAlbedo", "leafAtlas"]
  const ensureFoliageTextures = () => {
    const rev = getFoliageTexturesRevision()
    if (rev === loadedTexRev || typeof fetch === "undefined" || typeof createImageBitmap === "undefined") return
    loadedTexRev = rev
    for (const [layer, slot] of slotOrder.entries()) {
      const url = foliageTextureUrls[slot]
      if (!url) continue
      void fetch(url)
        .then(r => (r.ok ? r.blob() : null))
        .then(b => (b ? createImageBitmap(b, { resizeWidth: TEX_SZ, resizeHeight: TEX_SZ }) : null))
        .then(bmp => {
          if (!bmp) return
          device.queue.copyExternalImageToTexture({ source: bmp }, { texture: foliageTex, origin: [0, 0, layer] }, [TEX_SZ, TEX_SZ])
          bmp.close()
        })
        .catch(() => {})
    }
  }
  ensureFoliageTextures()

  const bindLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: "2d-array" } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
    ],
  })
  const bindGroup = device.createBindGroup({
    layout: bindLayout,
    entries: [
      { binding: 0, resource: { buffer: frameBuffer } },
      { binding: 1, resource: { buffer: uniformBuffer } },
      { binding: 2, resource: foliageView },
      { binding: 3, resource: foliageSamp },
    ],
  })
  const module = device.createShaderModule({ code: vegetationShader, label: "Lab vegetation room" })
  const pipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bindLayout] }),
    vertex: {
      module,
      entryPoint: "vs",
      buffers: [
        {
          arrayStride: VERT_BYTES,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
            { shaderLocation: 1, offset: 12, format: "snorm8x4" },
            { shaderLocation: 2, offset: 16, format: "unorm8x4" },
            { shaderLocation: 3, offset: 20, format: "float16x2" },
          ],
        },
      ],
    },
    fragment: { module, entryPoint: "fs", targets: [{ format: "rgba16float" }] },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less-equal" },
    multisample: { count: 4 },
  })

  // Look post grade (the shared lookGradeColor) applied after the scene, as the Looks room does.
  const lookState = createLookSettings("current")
  const lookData = new Float32Array(LOOK_UNIFORM_FLOATS)
  const lookBuffer = device.createBuffer({ size: lookData.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  const postParams = new Float32Array(4)
  const postParamBuffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  const postModule = device.createShaderModule({ code: lookPostShader, label: "Lab vegetation look grade" })
  const postLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
    ],
  })
  const postPipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [postLayout] }),
    vertex: { module: postModule, entryPoint: "vs" },
    fragment: { module: postModule, entryPoint: "fs", targets: [{ format: "rgba16float" }] },
    primitive: { topology: "triangle-list" },
  })
  const postSampler = device.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" })
  let copyTex: GPUTexture | null = null
  let postGroup: GPUBindGroup | null = null
  let copyW = 0, copyH = 0
  const ensureCopy = (w: number, h: number) => {
    if (copyTex && copyW === w && copyH === h) return
    copyTex?.destroy()
    copyW = w
    copyH = h
    copyTex = device.createTexture({ size: [w, h], format: "rgba16float", usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING })
    postGroup = device.createBindGroup({
      layout: postLayout,
      entries: [
        { binding: 0, resource: { buffer: lookBuffer } },
        { binding: 1, resource: copyTex.createView() },
        { binding: 2, resource: postSampler },
        { binding: 3, resource: { buffer: postParamBuffer } },
      ],
    })
  }
  const afterScene = (encoder: GPUCommandEncoder, hdr: GPUTexture, _depth: GPUTextureView, w: number, h: number) => {
    ensureCopy(w, h)
    if (!copyTex || !postGroup) return
    encoder.copyTextureToTexture({ texture: hdr }, { texture: copyTex }, [w, h])
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: hdr.createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }] })
    pass.setPipeline(postPipeline)
    pass.setBindGroup(0, postGroup)
    pass.draw(3)
    pass.end()
  }

  const upload = (packed: ArrayBuffer, prev?: { buf: GPUBuffer; count: number }) => {
    prev?.buf.destroy()
    const buf = device.createBuffer({ size: Math.max(64, packed.byteLength), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
    if (packed.byteLength) device.queue.writeBuffer(buf, 0, packed)
    return { buf, count: packed.byteLength / VERT_BYTES }
  }
  let room: Room = buildTreeRoom(7, foliageSettings)
  let roomMesh = upload(room.mesh)
  let builtKey = ""
  const ACTOR_CAP = 4096 * VERT_BYTES
  const actorBuf = device.createBuffer({ size: ACTOR_CAP, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
  let actorCount = 0

  const structuralKey = () =>
    [tool(), settings.seed, foliageSettings.crownShape, ...FOLIAGE_PARAM_SPECS.filter(s => s.boundary === "structural").map(s => foliageSettings[s.key])].join(":")

  const ensureMeshes = () => {
    const key = structuralKey()
    if (!meshDirty && key === builtKey) return
    meshDirty = false
    builtKey = key
    const seed = Math.max(1, Math.min(999, Math.round(Number(settings.seed) || 7)))
    room = ROOM_BUILDERS[tool()](seed, foliageSettings)
    roomMesh = upload(room.mesh, roomMesh)
  }

  const actorsNow = () => {
    if (!settings.walker) return []
    const lead = walkerPath(tool(), simTime)
    const follow = walkerPath(tool(), simTime - 2.2)
    return [
      { ...lead, zombie: false },
      { ...follow, zombie: true },
    ]
  }

  const applyCamera = () => {
    const c = CAMERAS[tool()][settings.cameraMode === "close" ? "close" : "game"]
    stage.camYaw = settings.cameraMode === "close" ? -0.22 : 0
    stage.camPitch = settings.cameraMode === "close" ? 0.42 : 0.82
    stage.frameTarget(c[0], c[1], c[2], c[3])
  }

  const lighting = (): FoliageLighting => (settings.lighting === "day" || settings.lighting === "dusk" ? settings.lighting : "night")

  const applyLighting = () => {
    const l = lighting()
    Object.assign(stage.lighting, {
      moon: true,
      moonPower: l === "day" ? 1.0 : l === "dusk" ? 0.55 : 0.2,
      moonAzimuth: l === "dusk" ? -150 : -52,
      moonElevation: l === "day" ? 58 : l === "dusk" ? 16 : 46,
      shadows: false,
      exposure: 0,
      tone: 2,
      saturation: 1,
      temperature: 0,
    })
    context.sync()
  }

  const updateLights = () => {
    const l = lighting()
    const lights: NonNullable<typeof stage.dynamicLights> = []
    const [lx, ly, lz] = room.lamp
    if (l !== "day") lights.push({ x: lx, y: ly, z: lz, radius: 13, r: 1.0, g: 0.62, b: 0.3, power: l === "night" ? 3.0 : 1.4 })
    if (l !== "day") for (const [wx, wy, wz] of room.windows.slice(0, 3)) lights.push({ x: wx, y: wy, z: wz, radius: 5.5, r: 1.0, g: 0.6, b: 0.26, power: l === "night" ? 1.3 : 0.6 })
    const actors = actorsNow()
    if (l === "night" && settings.flashlight && actors[0]) {
      const a = actors[0]
      const pitch = 0.32
      lights.push({
        x: a.x + Math.cos(a.heading) * 0.24, y: 1.1, z: a.z + Math.sin(a.heading) * 0.24,
        radius: 11, r: 1.0, g: 0.86, b: 0.66, power: 5.5,
        dx: Math.cos(a.heading) * Math.cos(pitch), dy: -Math.sin(pitch), dz: Math.sin(a.heading) * Math.cos(pitch),
        cone: Math.cos((24 * Math.PI) / 180),
      })
    }
    stage.dynamicLights = lights.slice(0, 8)
  }

  const randomize = (kind: FoliageKind | "all") => {
    const seed = Math.max(1, Math.min(9999, Math.round(Number(settings.tuningSeed) || 41)))
    Object.assign(foliageSettings, randomizeFoliageParams(foliageSettings, seed, kind))
    settings.tuningSeed = (seed % 9999) + 1
    meshDirty = true
    ensureMeshes()
    context.sync()
    return seed
  }

  const resetPreset = (kind: FoliageKind | "all") => {
    for (const k of kind === "all" ? (["tree", "bush", "grass"] as const) : [kind]) {
      applyFoliagePreset(k, k === "tree" ? foliageSettings.treePreset : k === "bush" ? foliageSettings.bushPreset : foliageSettings.grassPreset)
    }
    meshDirty = true
    ensureMeshes()
    context.sync()
  }

  const onTool = (t: FoliageKind) => (s: Readonly<Record<string, unknown>>) => s.tool === t || s.tool === "lot"
  const rebuild = () => {
    meshDirty = true
    ensureMeshes()
    context.sync()
  }

  const controls: LabControl[] = [
    {
      key: "tool",
      label: "Tool",
      group: "Vegetation",
      type: "select",
      options: TOOLS,
      change: () => {
        rebuild()
        applyCamera()
      },
    },
    { key: "treePreset", label: "Tree preset", group: "Vegetation", type: "select", options: TREE_PRESET_IDS.map(id => ({ value: id, label: TREE_PRESETS[id].label })), visible: onTool("tree"), change: rebuild },
    { key: "crownShape", label: "Crown shape", group: "Vegetation", type: "select", options: FOLIAGE_CROWN_SHAPES, visible: onTool("tree"), change: rebuild },
    { key: "bushPreset", label: "Bush preset", group: "Vegetation", type: "select", options: BUSH_PRESET_IDS.map(id => ({ value: id, label: BUSH_PRESETS[id].label })), visible: onTool("bush"), change: rebuild },
    { key: "grassPreset", label: "Grass preset", group: "Vegetation", type: "select", options: GRASS_PRESET_IDS.map(id => ({ value: id, label: GRASS_PRESETS[id].label })), visible: onTool("grass"), change: rebuild },
    { key: "foliage.randomize", label: "Randomize this look", group: "Vegetation", type: "action", run: () => void randomize(kindOf(tool())) },
    { key: "foliage.resetPreset", label: "Reset to preset", group: "Vegetation", type: "action", run: () => resetPreset(kindOf(tool())) },
    {
      key: "lighting",
      label: "Lighting",
      group: "Test room",
      type: "select",
      options: (Object.keys(FOLIAGE_LIGHTINGS) as FoliageLighting[]).map(value => ({ value, label: FOLIAGE_LIGHTINGS[value].label })),
      change: applyLighting,
    },
    {
      key: "look",
      label: "Look (post grade)",
      group: "Test room",
      type: "select",
      options: FOLIAGE_LOOKS.map(value => ({ value, label: LOOK_PRESETS[value].label })),
      change: () => context.sync(),
    },
    {
      key: "cameraMode",
      label: "Camera",
      group: "Test room",
      type: "select",
      options: [
        { value: "game", label: "Game camera (Outbreak zoom)" },
        { value: "close", label: "Close inspect" },
      ],
      change: applyCamera,
    },
    { key: "walker", label: "Walkers (trample test)", group: "Test room" },
    { key: "flashlight", label: "Walker flashlight (night)", group: "Test room", enabled: s => Boolean(s.walker) && s.lighting === "night" },
    { key: "seed", label: "Structure seed", group: "Test room", type: "range", min: 1, max: 999, step: 1, unit: "", change: rebuild },
    { key: "tuningSeed", label: "Randomize seed", group: "Test room", type: "range", min: 1, max: 9999, step: 1, unit: "" },
  ]
  for (const s of FOLIAGE_PARAM_SPECS) {
    controls.push({
      key: s.key,
      label: s.label,
      group: s.group,
      type: "range",
      min: s.min,
      max: s.max,
      step: s.step,
      unit: s.unit,
      visible: onTool(s.kind),
      change: () => {
        if (s.boundary === "structural") ensureMeshes()
      },
    })
  }

  const groupsFor = (t: FoliageLabTool): string[] => {
    const kinds: FoliageKind[] = t === "lot" ? ["tree", "bush", "grass"] : [t]
    const groups = FOLIAGE_PARAM_SPECS.filter(s => kinds.includes(s.kind)).map(s => s.group)
    return ["Vegetation", "Test room", ...new Set(groups)]
  }

  const selectTool = (t: FoliageLabTool, preset?: string) => {
    settings.tool = t
    if (preset && t !== "lot") applyFoliagePreset(t, preset)
    rebuild()
    applyCamera()
  }

  const libraryItems = (): LabLibraryItem[] => {
    const items: LabLibraryItem[] = TOOLS.map(t => ({
      id: `vegetation-tool:${t.value}`,
      label: t.label,
      tag: "tool",
      group: "Tools",
      select: () => selectTool(t.value),
      active: () => tool() === t.value,
    }))
    const presetItems = (kind: FoliageKind, ids: readonly string[]) =>
      ids.map(id => ({
        id: `vegetation-preset:${kind}:${id}`,
        label: foliagePresetFor(kind, id)!.label,
        tag: FOLIAGE_KIND_LABELS[kind].toLowerCase(),
        group: `${FOLIAGE_KIND_LABELS[kind]} presets`,
        select: () => selectTool(kind, id),
        active: () => tool() === kind && (kind === "tree" ? foliageSettings.treePreset : kind === "bush" ? foliageSettings.bushPreset : foliageSettings.grassPreset) === id,
      }))
    return [...items, ...presetItems("tree", TREE_PRESET_IDS), ...presetItems("bush", BUSH_PRESET_IDS), ...presetItems("grass", GRASS_PRESET_IDS)]
  }

  return {
    id: "foliage",
    label: "Vegetation",
    settings,
    controls,
    library: { category: "foliage", label: "Vegetation", tag: "foliage", items: libraryItems },
    detailsGroups: () => groupsFor(tool()),
    enter() {
      stage.sceneMode = 5
      stage.afterScene = afterScene
      ensureMeshes()
      applyLighting()
      applyCamera()
    },
    leave() {
      stage.dynamicLights = null
      if (stage.afterScene === afterScene) stage.afterScene = undefined
      Object.assign(stage.lighting, { tone: 0, shadows: true })
    },
    update(dt) {
      if (settings.playing) simTime += dt
    },
    retrigger() {
      simTime = 0
      rebuild()
    },
    reroll() {
      settings.seed = (((Number(settings.seed) * 1664525 + 1013904223) >>> 0) % 999) + 1
      rebuild()
    },
    frameTarget: () => {
      const c = CAMERAS[tool()][settings.cameraMode === "close" ? "close" : "game"]
      return { x: c[0], y: c[1], z: c[2], dist: c[3] }
    },
    objects: (): readonly LabWorldObject[] => {
      const out: LabWorldObject[] = [{ id: "veg:lamp", label: "Streetlamp", category: "light", x: room.lamp[0], y: room.lamp[1], z: room.lamp[2], radius: 0.4 }]
      for (const [i, a] of actorsNow().entries()) out.push({ id: `veg:walker:${i}`, label: a.zombie ? "Zombie walker" : "Survivor walker", category: "character", x: a.x, y: 0.8, z: a.z, radius: 0.4 })
      return out
    },
    prepare() {
      stage.sceneMode = 5
      if (stage.afterScene !== afterScene) stage.afterScene = afterScene
      stage.lighting.tone = 2
      stage.lighting.exposure = 0
      ensureFoliageTextures()
      ensureMeshes()
      updateLights()
      const look = FOLIAGE_LOOKS.includes(settings.look as LookPresetId) ? (settings.look as LookPresetId) : "current"
      if (lookState.preset !== look) Object.assign(lookState, createLookSettings(look))
      packLookUniforms(lookState, lookData, 0, { compareMode: 1, wipeSplit: 0.5, forceActive: true })
      device.queue.writeBuffer(lookBuffer, 0, lookData)
      postParams[0] = simTime
      device.queue.writeBuffer(postParamBuffer, 0, postParams)
      const actors = actorsNow()
      const packed = buildActorMesh(actors)
      actorCount = Math.min(packed.byteLength, ACTOR_CAP) / VERT_BYTES
      if (actorCount) device.queue.writeBuffer(actorBuf, 0, packed, 0, actorCount * VERT_BYTES)
      const l = lighting()
      uniformData[0] = simTime
      uniformData[1] = l === "day" ? 1 : l === "dusk" ? 0.55 : 0
      uniformData[2] = ["lot", "tree", "bush", "grass"].indexOf(tool())
      uniformData[3] = Math.min(MAX_OCCLUDERS, room.occluders.length)
      uniformData[4] = foliageSettings.dryPatches
      uniformData[5] = foliageSettings.grassVariation
      uniformData[6] = l === "dusk" ? 1 : 0
      uniformData[7] = 0
      packFoliageUniforms(foliageSettings, uniformData, 8)
      packFoliageActors(actors, uniformData, 8 + FOLIAGE_WIND_FLOATS)
      const occBase = 8 + FOLIAGE_WIND_FLOATS + FOLIAGE_ACTOR_FLOATS
      uniformData.fill(0, occBase)
      room.occluders.slice(0, MAX_OCCLUDERS).forEach((o, i) => uniformData.set(o, occBase + i * 4))
      device.queue.writeBuffer(uniformBuffer, 0, uniformData)
    },
    draw(pass) {
      const frame = (stage as unknown as { frame: Float32Array }).frame
      if (frame) device.queue.writeBuffer(frameBuffer, 0, frame.buffer, frame.byteOffset, frame.byteLength)
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, bindGroup)
      pass.setVertexBuffer(0, roomMesh.buf)
      pass.draw(roomMesh.count)
      if (actorCount) {
        pass.setVertexBuffer(0, actorBuf)
        pass.draw(actorCount)
      }
    },
    telemetry() {
      const t = tool()
      const preset =
        t === "tree" ? TREE_PRESETS[foliageSettings.treePreset].label : t === "bush" ? BUSH_PRESETS[foliageSettings.bushPreset].label : t === "grass" ? GRASS_PRESETS[foliageSettings.grassPreset].label : "Outbreak lot"
      return `Vegetation · ${preset} · ${lighting()} · ${LOOK_PRESETS[lookState.preset].label} {"verts":${roomMesh.count}}`
    },
  }
}
