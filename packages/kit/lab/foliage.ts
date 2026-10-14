import {
  FOLIAGE_CROWN_SHAPES,
  FOLIAGE_PARAM_SPECS,
  FOLIAGE_PRESETS,
  FOLIAGE_PRESET_IDS,
  buildFoliageTree,
  buildLegacyFoliageTree,
  emitCurvedGrassBlade,
  emitGrassFurShells,
  emitGrassTuft,
  foliageSettings,
  foliageWindDeclarationsWgsl,
  isFoliageCrownShape,
  isFoliagePresetId,
  packFoliageUniforms,
  randomizeFoliageParams,
  resetFoliageParams,
  scatterGrassClumps,
  type FoliageCameraMode,
  type FoliageCompareMode,
  type FoliageParams,
  type FoliagePresetId,
  type FoliageStageMode,
} from "../gpu/foliage"
import { MAT, Mesh, VERT_BYTES, type Rgb } from "../gpu/mesh"
import {
  legacyMaterialComparisonWgsl,
  scatterClusteredGroundCover,
  surfaceMaterialCoreWgsl,
} from "../gpu/surface-materials"
import type { LabControl } from "../lab-panel"
import { Rng } from "../sim/rng"
import { lightingDefaults } from "./lighting"
import { frameShader } from "./stage-shader"
import type { LabContext, LabSection } from "./types"

const rgb = (v: number): Rgb => [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]

export const FOLIAGE_LIGHTING_PRESETS: Readonly<
  Record<string, { label: string; values: Partial<ReturnType<typeof lightingDefaults>> }>
> = {
  outbreak_dusk: {
    label: "Outbreak dusk (18:00)",
    values: {
      lamps: true,
      lampPower: 3.1,
      lampRadius: 14.5,
      lampHeight: 3.5,
      spot: true,
      spotPower: 3.8,
      spotAngle: 42,
      spotYaw: -118,
      spotPitch: 40,
      shadows: true,
      moon: true,
      moonPower: 0.48,
      moonAzimuth: -48,
      moonElevation: 38,
      count: 4,
      exposure: 0.12,
      tone: 1,
      temperature: 0.16,
      saturation: 1.05,
    },
  },
  outbreak_day: {
    label: "Outbreak day (14:00)",
    values: {
      lamps: false,
      lampPower: 0.5,
      lampRadius: 12,
      lampHeight: 3.5,
      spot: true,
      spotPower: 4.6,
      spotAngle: 48,
      spotYaw: -55,
      spotPitch: 56,
      shadows: true,
      moon: true,
      moonPower: 1.25,
      moonAzimuth: -42,
      moonElevation: 62,
      count: 2,
      exposure: 0.22,
      tone: 1,
      temperature: 0.12,
      saturation: 1.06,
    },
  },
  outbreak_night: {
    label: "Outbreak night (22:30)",
    values: {
      lamps: true,
      lampPower: 3.5,
      lampRadius: 14.5,
      lampHeight: 3.6,
      spot: true,
      spotPower: 5.2,
      spotAngle: 34,
      spotYaw: -102,
      spotPitch: 44,
      shadows: true,
      moon: true,
      moonPower: 0.24,
      moonAzimuth: -58,
      moonElevation: 46,
      count: 4,
      exposure: -0.02,
      tone: 1,
      temperature: -0.14,
      saturation: 1.02,
    },
  },
  cold_moon: {
    label: "Cold moonlight",
    values: {
      lamps: false,
      lampPower: 0.8,
      spot: true,
      spotPower: 3.2,
      spotAngle: 44,
      shadows: true,
      moon: true,
      moonPower: 0.88,
      moonAzimuth: -50,
      moonElevation: 60,
      count: 1,
      exposure: 0.06,
      tone: 1,
      temperature: -0.35,
      saturation: 0.92,
    },
  },
  stage: {
    label: "Current stage lighting",
    values: {},
  },
}

const foliageStageShader =
  frameShader +
  /* wgsl */ `
fn hash2(p: vec2f) -> f32 {
  let q = fract(p * vec2f(0.1031, 0.1030));
  let r = q + dot(q, q.yx + 33.33);
  return fract((r.x + r.y) * r.x);
}
` +
  surfaceMaterialCoreWgsl +
  legacyMaterialComparisonWgsl +
  foliageWindDeclarationsWgsl +
  /* wgsl */ `
struct FoliageStageUniforms {
  // x: time, y: compareMode (0=before, 1=after, 2=split), z: passSide (-1=before, 1=after, 0=full), w: stageMode (0=lot, 1=swatch)
  config: vec4f,
  // x: grassDryPatches, y: grassVariation, z: autumnMix, w: treeColorVariation
  extra: vec4f,
  wind: FoliageWindConfig,
}

@group(0) @binding(1) var<uniform> U: FoliageStageUniforms;

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
  @location(5) clipXW: vec2f,
}

@vertex fn vs(v: VIn) -> VOut {
  var o: VOut;
  var world = v.pos;
  var norm = normalize(v.normal.xyz);
  let mat = i32(round(v.matAux.x));
  let isAfterPass = U.config.z >= 0.0;
  if (mat == 22 && isAfterPass) {
    let fw = applyFoliageVertexWind(world, norm, v.matAux.y, U.config.x, F.eye.xyz, U.wind);
    world = fw[0];
    norm = fw[1];
  }
  o.world = world;
  let clip = F.vp * vec4f(world, 1.0);
  o.pos = clip;
  o.clipXW = vec2f(clip.x, clip.w);
  o.normal = norm;
  o.color = pow(max(v.color.rgb, vec3f(0.01)), vec3f(2.2));
  o.mat = v.matAux.x;
  o.aux = v.matAux.y;
  return o;
}

@fragment fn fs(o: VOut) -> @location(0) vec4f {
  surfaceFootprint = max(length(dpdx(o.world)), length(dpdy(o.world)));
  surfaceTime = U.config.x;
  surfaceNormalShift = vec3f(0.0);
  let ndcX = o.clipXW.x / max(o.clipXW.y, 0.0001);
  let ndcStep = max(abs(dpdx(ndcX)), 0.0008);

  let compareMode = i32(round(U.config.y));
  let passSide = U.config.z;
  // Perspective-correct screen-space NDC split (ndcX == 0.0) eliminates 3D polygon intersection seams.
  if (compareMode == 2) {
    if (passSide < -0.5 && ndcX >= 0.0) { discard; }
    if (passSide > 0.5 && ndcX < 0.0) { discard; }
  }

  let mat = i32(round(o.mat));
  var n = normalize(o.normal);
  let V = normalize(F.eye.xyz - o.world);
  let isAfter = select(compareMode == 1, passSide > 0.0, compareMode == 2);

  // Emissive lamps (window panes, porch lantern, streetlamp head)
  if (mat == 2) {
    return vec4f(o.color * 2.8, 1.0);
  }

  var albedo = o.color;
  var gloss = vec2f(0.0);
  var cavity = 1.0;
  var outAlpha = 1.0;

  if (mat == 20) {
    let kind = i32(round(o.aux));
    let p = o.world.xz;
    if (kind == 0) {
      if (isAfter) {
        var r = defaultMaterialRecipe(4);
        r.u2.x = clamp(0.42 + U.extra.y * 0.45, 0.0, 1.0);
        r.u2.z = clamp(U.extra.x * 0.52, 0.0, 1.0);
        r.u2.w = clamp(0.35 + U.extra.x * 0.45, 0.0, 1.0);
        let s = evalGrassSoil(p, albedo, false, r);
        albedo = mix(s.albedo, albedo * vec3f(0.62, 0.88, 0.42), 0.32 * (1.0 - U.extra.x * 0.5));
        gloss = s.gloss;
        cavity = s.cavity;
        n = normalize(n + surfaceNormalShift);
      } else {
        let s = evalLegacyMaterial(4, o.world, n, albedo);
        albedo = s.albedo;
        gloss = s.gloss;
      }
    } else if (kind == 1) {
      let s = evalAsphaltConcrete(p, albedo, false, defaultMaterialRecipe(3));
      albedo = s.albedo;
      gloss = s.gloss;
      cavity = s.cavity;
    } else if (kind == 2) {
      let inVerge = U.config.w < 0.5 && p.y > 3.32 && p.y < 3.76 && abs(p.x) > 0.9 && p.x > -7.6;
      if (inVerge) {
        if (isAfter) {
          let s = evalGrassSoil(p, vec3f(0.24, 0.32, 0.16), false, defaultMaterialRecipe(4));
          albedo = s.albedo;
          gloss = s.gloss;
          cavity = s.cavity;
          n = normalize(n + surfaceNormalShift);
        } else {
          let s = evalLegacyMaterial(4, o.world, n, vec3f(0.24, 0.30, 0.16));
          albedo = s.albedo;
        }
      } else {
        let s = evalAsphaltConcrete(p, albedo, true, defaultMaterialRecipe(3));
        albedo = s.albedo;
        gloss = s.gloss;
        cavity = s.cavity;
      }
    } else if (kind == 3) {
      let ruts = exp(-pow((fract(p.x * 0.38) - 0.32) * 5.5, 2.0)) + exp(-pow((fract(p.x * 0.38) - 0.72) * 5.5, 2.0));
      albedo *= 0.72 + grain(p, 16.0) * 0.65 + surfaceNoise(p * 3.0) * 0.35 + 0.08 * clamp(ruts, 0.0, 1.0);
    } else if (kind == 5) {
      let s = evalGrassSoil(p, albedo, true, defaultMaterialRecipe(4));
      albedo = s.albedo;
      gloss = s.gloss;
      cavity = s.cavity;
      n = normalize(n + surfaceNormalShift);
    }
  } else if (mat == 4 && o.aux > 19.5) {
    let row = floor(o.world.y / 0.18);
    let plank = floor((o.world.x + o.world.z + row * 0.43) / 2.2);
    albedo *= 0.95 + (hash2(vec2f(row, plank)) - 0.5) * 0.08;
    albedo *= mix(0.70, 1.0, seam(o.world.y / 0.18, 0.025, 5.55));
    albedo *= 0.97 + grain(vec2f(o.world.x + o.world.z, o.world.y * 3.5), 11.0) * 0.14;
  } else if (mat == 21) {
    let row = floor(o.world.z / 0.24);
    let q = vec2f(o.world.x / 0.36 + fract(row * 0.5), o.world.z / 0.24);
    let tabHash = hash2(floor(q)) - 0.5;
    albedo *= 0.97 + tabHash * 0.30 * (1.0 - smoothstep(0.12, 0.5, surfaceFootprint * 4.16));
    albedo *= mix(0.55, 1.0, seam(q.x, 0.018, 2.77) * seam(q.y, 0.035, 4.16));
  } else if (mat == 23) {
    let p = vec2f(o.world.x + o.world.z, o.world.y);
    let row = floor(p.y / 0.085);
    let q = vec2f(p.x / 0.25 + fract(row * 0.5), p.y / 0.085);
    albedo = mix(vec3f(0.32, 0.30, 0.26), albedo * (0.8 + 0.35 * hash2(floor(q))), seam(q.x, 0.025, 4.0) * seam(q.y, 0.06, 11.76));
  } else if (mat == 24) {
    albedo *= 0.84 + surfaceNoise(vec2f(o.world.x + o.world.z, o.world.y * 0.18) * 28.0) * 0.24;
  } else if (mat == 22) {
    if (!isAfter) {
      albedo *= 0.82 + surfaceNoise(o.world.xz * 4.0 + o.world.y) * 0.30;
    } else if (o.aux < -1.5) {
      // Volumetric grass fur shell layer (aux = -(2.0 + shellT))
      let shellT = clamp(-o.aux - 2.0, 0.0, 1.0);
      let p = o.world.xz;
      let cMound = surfaceNoise(p * 0.68 + vec2f(1.7, 4.3));
      let tuftG = surfaceNoiseGrad(p * 4.2 + vec2f(3.1, 6.7));
      let strand1 = surfaceNoise(p * 19.5 + vec2f(tuftG.x * 0.9, 2.3));
      let strand2 = surfaceNoise(p * 38.0 + vec2f(7.4, 1.9));
      let strandReach = (tuftG.x * 0.34 + strand1 * 0.40 + strand2 * 0.32) * (0.66 + 0.48 * cMound);
      outAlpha = clamp((strandReach - shellT * 0.76) * 3.8, 0.0, 1.0);
      let rootAO = mix(0.38, 1.18, pow(shellT, 0.62));
      let crestNoise = surfaceNoise(p * 0.30 + vec2f(U.config.x * 0.28, U.config.x * 0.16));
      let crestHighlight = smoothstep(0.38, 0.68, crestNoise) * 0.38 * shellT;
      albedo = mix(albedo * (0.90 + strand1 * 0.24), vec3f(0.54, 0.72, 0.18), crestHighlight) * rootAO;
      gloss = vec2f(42.0, 0.24 * shellT);
      cavity = mix(0.46, 1.0, shellT);
      n = normalize(n + vec3f(tuftG.y * 0.48, 0.0, tuftG.z * 0.48));
    } else if (o.aux < -0.02) {
      let bladeT = clamp(-o.aux, 0.0, 1.0);
      let rootAO = mix(0.28, 1.0, smoothstep(0.0, 0.28, bladeT));
      let vein = grain(o.world.xz * 2.4 + vec2f(o.world.y * 1.6), 16.0) * 0.18;
      let crestNoise = surfaceNoise(o.world.xz * 0.32 + vec2f(U.config.x * 0.28, U.config.x * 0.16));
      let crestHighlight = smoothstep(0.40, 0.68, crestNoise) * 0.38 * bladeT;
      albedo = mix(albedo * (0.94 + vein), vec3f(0.54, 0.72, 0.18), crestHighlight) * mix(0.84, 1.24, pow(bladeT, 0.62));
      gloss = vec2f(48.0, 0.32 * bladeT);
      cavity = rootAO;
      outAlpha = clamp(1.42 - bladeT * 0.48, 0.52, 1.0);
    } else {
      let s = evalFoliageCanopy(o.world, n, albedo, defaultMaterialRecipe(5));
      albedo = s.albedo;
      gloss = s.gloss;
      cavity = s.cavity;
      n = normalize(n + surfaceNormalShift);
      if (o.aux > 0.0) {
        let cardEdge = clamp(o.aux, 0.0, 1.0);
        let uv3 = vec2f(o.world.x + o.world.z * 0.73 + o.world.y * 0.41, o.world.y * 1.17 - o.world.x * 0.43 + o.world.z * 0.81);
        let brush1 = surfaceNoise(uv3 * 5.8 + vec2f(2.1, 4.7));
        let brush2 = surfaceNoise(uv3 * 13.5 + vec2f(brush1 * 0.7 + 6.3, 1.9));
        let brushField = brush1 * 0.58 + brush2 * 0.42;
        let edgeMask = smoothstep(0.015, 0.16, cardEdge);
        outAlpha = clamp((cardEdge * 1.32 + (brushField - 0.40) * 0.92 - 0.14) * 2.8, 0.0, 1.0) * edgeMask;
      }
    }
  }

  // Ground contact & dappled canopy shadow under trees, shrubs, and house walls
  if (mat == 20) {
    let dapple = 0.72 + 0.28 * surfaceNoise(o.world.xz * 2.8 + vec2f(U.config.x * 0.18, -U.config.x * 0.12));
    if (U.config.w < 0.5) {
      // Outbreak Lot stage tree & house contact shadows
      let dTreeL = length(o.world.xz - vec2f(-5.4, 0.55));
      let dTreeR = length(o.world.xz - vec2f(5.4, 0.55));
      let dTreeC = length(o.world.xz - vec2f(2.4, 0.85));
      let treeShadow = max(
        exp(-(dTreeL * dTreeL) / 3.8) * 0.56,
        max(exp(-(dTreeR * dTreeR) / 3.8) * 0.56, exp(-(dTreeC * dTreeC) / 3.4) * 0.52)
      ) * dapple;
      let houseShadow = exp(-max(0.0, o.world.z + 1.5) * 2.2) * step(abs(o.world.x), 7.6) * 0.48;
      cavity *= 1.0 - max(treeShadow, houseShadow);
    } else {
      let dHero = length(o.world.xz - vec2f(0.0, -0.35));
      let dLeft = length(o.world.xz - vec2f(-2.7, -1.5));
      let dRight = length(o.world.xz - vec2f(2.7, -1.5));
      let treeOcc = max(
        exp(-(dHero * dHero) / 3.4) * 0.56 * dapple,
        max(exp(-(dLeft * dLeft) / 1.1) * 0.42, exp(-(dRight * dRight) / 1.1) * 0.42)
      );
      cavity *= 1.0 - treeOcc;
    }
  }

  let isFoliage = mat == 22;
  let wrap = select(0.18, 0.40, isFoliage && isAfter);
  let tipWeight = clamp(abs(o.aux), 0.0, 1.2);
  let transStrength = select(0.0, U.wind.u0.w * (0.35 + 0.65 * tipWeight), isFoliage && isAfter);

  var diff = F.ambient.rgb * (0.52 + 0.48 * max(n.y, 0.0)) * cavity;
  let moonDir = normalize(F.moon.xyz);
  let moonNdl = max(0.0, (dot(n, moonDir) + wrap) / (1.0 + wrap));
  let moonBack = max(0.0, dot(-n, moonDir)) * transStrength * 0.65;
  diff += vec3f(0.52, 0.65, 0.92) * F.moon.w * (moonNdl * cavity + moonBack);

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
    var atten = pow(max(0.0, 1.0 - dist / lpos.w), 2.0) * lcol.w;
    if (lcone.w > -1.0) {
      atten *= smoothstep(lcone.w, min(1.0, lcone.w + 0.08), dot(-ldir, lcone.xyz));
    }
    let ndl = max(0.0, (dot(n, ldir) + wrap) / (1.0 + wrap));
    let back = max(0.0, dot(-n, ldir)) * transStrength * 0.58;
    diff += lcol.rgb * atten * (ndl * mix(0.65, 1.0, cavity) + back);
    if (gloss.x > 0.0 && gloss.y > 0.0) {
      let h = normalize(ldir + V);
      let s = pow(max(0.0, dot(n, h)), gloss.x) * (gloss.x + 2.0) * 0.008;
      spec += lcol.rgb * atten * s * gloss.y;
    }
  }

  var color = albedo * diff * 1.15 + spec;
  if (isFoliage && isAfter) {
    let fresnel = pow(1.0 - max(dot(n, V), 0.0), 4.0) * 0.24 * tipWeight;
    let chloro = mix(vec3f(0.16, 0.45, 0.04), vec3f(0.55, 0.85, 0.10), sqrt(clamp(tipWeight, 0.0, 1.0)));
    color += albedo * chloro * transStrength * 0.35 + albedo * vec3f(0.50, 0.85, 0.30) * fresnel;
  }

  // Crisp 1.5px screen-space split indicator line in A/B Split mode
  if (compareMode == 2) {
    let splitLine = 1.0 - smoothstep(ndcStep * 0.7, ndcStep * 1.8, abs(ndcX));
    color = mix(color, vec3f(0.90, 0.95, 1.0), splitLine * 0.82);
  }

  if (F.options.z == 3.0) {
    color = diff * 1.6 + spec * 2.5;
  } else if (F.options.z == 5.0) {
    color = n * 0.5 + 0.5;
  }
  return vec4f(color, outAlpha);
}
`

/**
 * Builds the Outbreak House Lot context stage:
 * - Bungalow facade (`x = -7.5..7.5, z = -6.5..-1.5`) with gabled porch, warm windows, and chimney
 * - Foundation mulch bed (`z = -1.5..-0.58`), front walkway (`x = -0.7..0.7`), gravel driveway (`x = -10.5..-7.85`)
 * - Concrete sidewalk (`z = 2.0..3.75`) with grass verge strip (`z = 3.32..3.76`), curb, street, storm grate, and streetlamp
 */
function addOutbreakLotArchitecture(m: Mesh, seed: number): void {
  const x = -7.5, r = 7.5, z = -6.5, e = -1.5
  const mid = (z + e) / 2
  const ridge = 4.35
  const trim = rgb(0xd4d2c8)
  const roof = rgb(0x3d4758)
  const brick = rgb(0x684339)
  const wallCol = rgb(0x767f78)

  // Lawn ground (-11.6..11.6 in X, -6.8..2.0 in Z)
  m.box(-11.6, -0.08, -6.8, 11.6, 0.0, 2.0, rgb(0x526438), MAT.ground, 0)
  // Sidewalk + verge + curb (z = 2.0..4.0)
  m.box(-11.6, -0.06, 2.0, 11.6, 0.08, 4.0, rgb(0x989ba4), MAT.ground, 2)
  // Street asphalt (z = 4.0..8.4)
  m.box(-11.6, -0.08, 4.0, 11.6, 0.014, 8.4, rgb(0x454d5c), MAT.ground, 1)
  // Dashed yellow street center lines
  for (const vx of [-9.5, -4.5, 0.5, 5.5]) {
    m.box(vx, 0.015, 6.1, vx + 2.4, 0.022, 6.22, rgb(0xb9ab7a))
  }
  // Storm drain grate at curb
  m.box(-3.8, 0.016, 3.86, -2.96, 0.024, 4.14, rgb(0x14181c))
  for (let i = 0; i < 7; i++) {
    m.box(-3.76 + i * 0.12, 0.024, 3.88, -3.71 + i * 0.12, 0.028, 4.12, rgb(0x454a52))
  }

  // Front walkway & porch stoop (centered at x = 0 so A/B split bisects porch & walk symmetrically)
  m.box(-1.35, 0.0, e, 1.35, 0.11, e + 1.3, rgb(0xa29d90), MAT.ground, 2)
  m.box(-0.72, 0.0, e + 1.3, 0.72, 0.09, 2.0, rgb(0xa6a194), MAT.ground, 2)
  // Gravel driveway on left side
  m.box(x - 3.0, 0.0, z, x - 0.35, 2.0, 0.032, rgb(0x646659), MAT.ground, 3)
  const gravelRng = new Rng(seed + 177)
  for (let k = 0; k < 36; k++) {
    const px = x - 3.0 + gravelRng.next() * 2.65
    const pz = z + gravelRng.next() * (2.0 - z)
    const sz = 0.025 + gravelRng.next() * 0.045
    m.prism(px, pz, sz, sz * 0.5, 0.033, 0.052, 5, rgb(gravelRng.pick([0x949084, 0x65685f, 0x79776a])))
  }

  // Bungalow walls & baseboard
  m.box(x, 0.12, z, r, 2.8, e, wallCol, MAT.wall, 20)
  m.box(x - 0.02, 0.02, z - 0.02, r + 0.02, 0.28, e + 0.02, brick, MAT.brick)
  m.box(x - 0.01, 0.28, z - 0.01, r + 0.01, 0.32, e + 0.01, trim, MAT.wall)

  // Pitched shingle roof & eave trim
  m.quadAuto([x - 0.42, 2.88, e + 0.42], [r + 0.42, 2.88, e + 0.42], [r + 0.42, ridge, mid], [x - 0.42, ridge, mid], roof, MAT.roof, 0)
  m.quadAuto([x - 0.42, ridge, mid], [r + 0.42, ridge, mid], [r + 0.42, 2.88, z - 0.42], [x - 0.42, 2.88, z - 0.42], roof, MAT.roof, 0)
  m.box(x - 0.45, 2.72, e + 0.34, r + 0.45, 2.87, e + 0.44, trim, MAT.roof, 0)
  m.box(x - 0.42, 2.63, e + 0.02, r + 0.42, 2.71, e + 0.40, rgb(0x282e38), MAT.roof, 0)
  m.box(x - 0.48, 2.76, e + 0.43, r + 0.48, 2.83, e + 0.50, rgb(0x9da4b0), MAT.roof, 0)
  m.box(x - 0.42, ridge - 0.04, mid - 0.1, r + 0.42, ridge + 0.04, mid + 0.1, rgb(0x4b5668), MAT.roof, 0)

  // Brick chimney
  m.box(r - 2.05, 3.20, mid + 0.55, r - 1.15, 4.78, mid + 1.45, brick, MAT.brick)
  m.box(r - 2.13, 4.74, mid + 0.47, r - 1.07, 4.86, mid + 1.53, rgb(0x888b90))

  // Gabled front porch centered at x = 0
  const cx = 0
  m.quadAuto([cx - 1.62, 2.46, e + 1.58], [cx, 3.22, e + 1.58], [cx, 3.22, e - 0.15], [cx - 1.62, 2.46, e - 0.15], roof, MAT.roof, 0)
  m.quadAuto([cx, 3.22, e + 1.58], [cx + 1.62, 2.46, e + 1.58], [cx + 1.62, 2.46, e - 0.15], [cx, 3.22, e - 0.15], roof, MAT.roof, 0)
  m.facet([cx - 1.52, 2.46, e + 1.48], [cx, 3.16, e + 1.48], [cx + 1.52, 2.46, e + 1.48], rgb(0x2c323d), MAT.roof, 0)
  m.quadAuto([cx - 1.64, 2.42, e + 1.60], [cx, 3.19, e + 1.60], [cx, 3.26, e + 1.56], [cx - 1.64, 2.49, e + 1.56], trim, MAT.roof, 0)
  m.quadAuto([cx, 3.19, e + 1.60], [cx + 1.64, 2.42, e + 1.60], [cx + 1.64, 2.49, e + 1.56], [cx, 3.26, e + 1.56], trim, MAT.roof, 0)
  m.box(cx - 1.58, 2.38, e + 1.36, cx + 1.58, 2.46, e + 1.52, trim, MAT.roof, 0)
  for (const px of [cx - 1.32, cx + 1.32]) {
    m.box(px - 0.09, 0.34, e + 1.20, px + 0.09, 2.42, e + 1.38, rgb(0xeae4d7), MAT.wall)
    m.box(px - 0.14, 0.11, e + 1.15, px + 0.14, 0.34, e + 1.43, rgb(0xd8d2c5), MAT.wall)
  }
  m.box(cx - 0.85, 0.06, e + 1.28, cx + 0.85, 0.12, e + 1.52, rgb(0xb8b2a4), MAT.wall)
  // Front door & warm porch lantern
  m.box(-0.68, 0.12, e - 0.04, 0.68, 2.32, e + 0.04, rgb(0x796045), MAT.wall)
  for (const px of [-0.74, 0.68]) m.box(px, 0.12, e - 0.08, px + 0.08, 2.38, e + 0.08, rgb(0xeae4d7), MAT.wall)
  m.box(-0.74, 2.32, e - 0.08, 0.76, 2.42, e + 0.08, rgb(0xeae4d7), MAT.wall)
  m.box(0.95, 1.72, e + 0.02, 1.15, 2.06, e + 0.16, rgb(0xffd49a), MAT.lamp, 0)

  // Warm multipane front windows (left & right of porch)
  for (const [wx0, wx1] of [
    [x + 1.4, x + 4.3],
    [r - 4.3, r - 1.4],
  ] as const) {
    m.box(wx0 - 0.08, 0.78, e - 0.04, wx1 + 0.08, 0.87, e + 0.12, rgb(0xd8d5cb), MAT.wall)
    m.box(wx0 - 0.07, 2.13, e - 0.04, wx1 + 0.07, 2.23, e + 0.08, rgb(0xd8d5cb), MAT.wall)
    m.box(wx0 + 0.04, 0.88, e + 0.01, wx1 - 0.04, 1.46, e + 0.03, rgb(0xc47e38), MAT.lamp, 0)
    m.box(wx0 + 0.04, 1.48, e + 0.01, wx1 - 0.04, 2.11, e + 0.03, rgb(0x8e5826), MAT.lamp, 0)
    const midX = (wx0 + wx1) / 2
    for (const [px, w] of [
      [wx0, 0.06],
      [midX - 0.05, 0.10],
      [wx1 - 0.06, 0.06],
    ] as const) {
      m.box(px, 0.85, e - 0.02, px + w, 2.20, e + 0.06, rgb(0xdcd9cf), MAT.wall)
    }
    m.box(wx0 + 0.04, 1.45, e - 0.02, wx1 - 0.04, 1.50, e + 0.06, rgb(0xdcd9cf), MAT.wall)
  }

  // Foundation soil beds flanking the porch
  for (const [a, d] of [
    [x + 0.15, -1.55],
    [1.55, r - 0.15],
  ] as const) {
    m.quad([a, 0.018, e + 0.92], [d, 0.018, e + 0.92], [d, 0.018, e + 0.04], [a, 0.018, e + 0.04], [0, 1, 0], rgb(0x28291f), MAT.ground, 5)
  }

  // Streetlamp pole & warm luminaire on the front-right curb verge
  const lx = 4.2, lz = 3.65
  m.prism(lx, lz, 0.12, 0.065, 0.08, 3.8, 8, rgb(0x353d3c))
  m.box(lx - 0.7, 3.65, lz - 0.08, lx + 0.08, 3.8, lz + 0.08, rgb(0x353d3c))
  m.box(lx - 0.8, 3.55, lz - 0.18, lx - 0.3, 3.65, lz + 0.18, rgb(0xffc980), MAT.lamp, 0)
}

function buildLotFoliageMesh(seed: number, params: Readonly<FoliageParams>, isLegacy: boolean): ArrayBuffer {
  const m = new Mesh()
  addOutbreakLotArchitecture(m, seed)

  const x = -7.5, r = 7.5, e = -1.5
  const plantFn = isLegacy
    ? (px: number, pz: number, ph: number, pr: number, s: number, shape?: any) => {
        void shape
        buildLegacyFoliageTree(m, px, pz, ph, pr, s, 0.018)
      }
    : (px: number, pz: number, ph: number, pr: number, s: number, shape?: any) => {
        buildFoliageTree(m, px, pz, ph, pr, s, 0.018, params, shape)
      }

  // 1. Symmetric left & right street/yard trees + foreground right yard tree (so A/B split compares matched trees)
  plantFn(-5.4, 0.55, params.treeHeight, params.crownRadius, seed * 31 + 7)
  plantFn(5.4, 0.55, params.treeHeight, params.crownRadius, seed * 31 + 7)
  plantFn(2.4, 0.85, params.treeHeight * 0.88, params.crownRadius * 0.88, seed * 47 + 13)
  plantFn(-9.4, -1.8, params.treeHeight * 0.92, params.crownRadius * 0.85, seed * 59 + 19)

  // 2. Foundation shrubs along the house front & porch
  const rng = new Rng(seed + 71)
  for (const [px, pz, ph, pr] of [
    [x + 0.55, e + 0.48, 1.12, 0.76],
    [x + 1.65, e + 0.44, 0.68, 0.48],
    [x + 2.85, e + 0.46, 0.56, 0.44],
    [x + 4.05, e + 0.40, 0.62, 0.46],
    [-2.05, e + 0.48, 0.88, 0.58],
    [2.05, e + 0.48, 0.88, 0.58],
    [3.25, e + 0.44, 0.58, 0.44],
    [4.45, e + 0.42, 0.56, 0.44],
    [r - 1.05, e + 0.58, 0.98, 0.78],
  ] as const) {
    plantFn(px, pz, ph, pr, Math.floor(rng.next() * 1e6), "spreading")
  }
  // Creamy-white hydrangea blooms on the front-right corner shrub
  for (let i = 0; i < 14; i++) {
    const a = i * 2.399
    const dist = 0.12 + (i % 4) * 0.15
    const px = r - 1.05 + Math.cos(a) * dist
    const pz = e + 0.58 + Math.sin(a) * dist * 0.82
    const py = 0.48 + (1 - (i % 4) * 0.18) * 0.42 + (i % 2) * 0.05
    m.prism(px, pz, 0.075, 0.055, py, py + 0.09, 6, rgb(i % 3 === 0 ? 0xdde3d5 : 0xc5cebc))
  }

  // 3. Lawn & verge grass
  if (isLegacy) {
    const tufts = scatterClusteredGroundCover({
      seed: seed ^ 0x453a,
      bounds: [-10.8, -1.2, 10.8, 1.9],
      clusterCount: Math.max(1, Math.round(28 * params.grassDensity)),
      tuftsPerCluster: 4,
      avoid: (gx, gz) => (gx > -1.4 && gx < 1.4) || (gx < -7.5 && gx > -10.6),
    })
    for (const t of tufts) {
      const { x: gx, z: gz, radius: gr, height: gh, tint: gc } = t
      m.facet([gx - gr * 0.7, 0, gz - gr * 0.3], [gx + gr * 0.2, gh, gz + gr * 0.3], [gx + gr * 0.8, 0, gz - gr * 0.2], gc, MAT.foliage, 0)
      m.facet([gx - gr * 0.2, 0, gz - gr * 0.8], [gx - gr * 0.3, gh * 0.85, gz + gr * 0.2], [gx + gr * 0.4, 0, gz + gr * 0.7], gc, MAT.foliage, 0)
    }
  } else {
    const grassRng = new Rng(seed ^ 0x73c9)
    // 4-layer volumetric grass fur shells covering the front lawns, side yards, and curb verge strip
    emitGrassFurShells(m, -7.45, -0.58, -0.82, 1.98, () => 0.0, params, 4, 2.0)
    emitGrassFurShells(m, 0.82, -0.58, 7.45, 1.98, () => 0.0, params, 4, 2.0)
    emitGrassFurShells(m, -11.4, -6.5, -10.55, 1.98, () => 0.0, params, 4, 2.2)
    emitGrassFurShells(m, 7.55, -6.5, 11.4, 1.98, () => 0.0, params, 4, 2.2)
    emitGrassFurShells(m, -7.4, 3.34, -0.95, 3.74, () => 0.08, params, 3, 2.0)
    emitGrassFurShells(m, 0.95, 3.34, 11.4, 3.74, () => 0.08, params, 3, 2.0)

    // Dense 3D curved grass tufts emerging above the fur carpet
    const clumps = scatterGrassClumps({
      seed: seed ^ 0x453a,
      bounds: [-11.0, -0.62, 11.0, 1.94],
      clusterCount: 165,
      tuftsPerCluster: 5,
      params,
      avoid: (gx, gz) =>
        (gx > -0.88 && gx < 0.88 && gz > -1.5) ||
        (gx < -7.75 && gx > -10.55) ||
        Math.hypot(gx + 5.4, gz - 0.55) < 0.30 ||
        Math.hypot(gx - 5.4, gz - 0.55) < 0.30 ||
        Math.hypot(gx - 2.4, gz - 0.85) < 0.26,
    })
    for (const c of clumps) {
      emitGrassTuft(m, c.x, 0.0, c.z, {
        bladeCount: c.blades + 1,
        radius: c.radius * 1.18,
        height: c.height * 1.14,
        width: c.width * 1.12,
        curvature: c.curvature,
        leanAngle: c.leanAngle,
        rootColor: c.rootColor,
        tipColor: c.tipColor,
        rng: grassRng,
      })
    }

    // Curb-verge & walkway-edge tufts
    const vergeRng = new Rng(seed ^ 0x91e1)
    for (let vx = -10.8; vx <= 10.8; vx += 0.38 + vergeRng.next() * 0.48) {
      if (Math.abs(vx) < 0.95 || (vx < -7.6 && vx > -10.6)) continue
      for (const zBase of [1.92, 3.44, 3.66]) {
        if (vergeRng.next() < 0.14) continue
        const lean = vergeRng.next() * Math.PI * 2
        for (let k = 0; k < 3; k++) {
          const gx = vx + (vergeRng.next() - 0.5) * 0.34
          const gz = zBase + (vergeRng.next() - 0.5) * 0.12
          const gh = (0.19 + vergeRng.next() * 0.14) * (params.bladeHeight / 0.30)
          emitCurvedGrassBlade(
            m,
            gx,
            zBase > 3.0 ? 0.08 : 0.0,
            gz,
            gh,
            params.bladeWidth * 1.12,
            params.bladeCurvature,
            lean + (vergeRng.next() - 0.5) * 0.5,
            [params.rootColorR, params.rootColorG, params.rootColorB],
            [params.tipColorR, params.tipColorG, params.tipColorB],
          )
        }
      }
    }
  }

  return m.pack()
}

function addGroundStage(m: Mesh): void {
  m.box(-5.2, -0.08, -3.8, 5.2, 0.0, 2.6, [0.32, 0.39, 0.23], MAT.ground, 0)
  m.prism(0, -0.35, 0.72, 0.68, 0.0, 0.015, 12, [0.20, 0.18, 0.13], MAT.ground, 5)
  m.prism(-2.7, -1.5, 0.58, 0.54, 0.0, 0.014, 10, [0.20, 0.18, 0.13], MAT.ground, 5)
  m.prism(2.7, -1.5, 0.58, 0.54, 0.0, 0.014, 10, [0.20, 0.18, 0.13], MAT.ground, 5)
  m.box(-5.2, -0.06, 2.6, 5.2, 0.05, 3.8, [0.60, 0.62, 0.65], MAT.ground, 2)
  m.box(-5.32, -0.12, -3.92, 5.32, -0.03, 3.92, [0.16, 0.18, 0.21], MAT.lit, 0)
}

function buildSwatchFoliageMesh(seed: number, params: Readonly<FoliageParams>, isLegacy: boolean): ArrayBuffer {
  const m = new Mesh()
  addGroundStage(m)
  const shrubH = Math.max(0.95, Math.min(1.85, params.treeHeight * 0.28))
  const shrubR = Math.max(0.65, Math.min(1.25, params.crownRadius * 0.42))

  if (isLegacy) {
    buildLegacyFoliageTree(m, 0, -0.35, params.treeHeight, params.crownRadius, seed * 31 + 7, 0.015)
    buildLegacyFoliageTree(m, -2.7, -1.5, shrubH, shrubR, seed * 17 + 3, 0.015)
    buildLegacyFoliageTree(m, 2.7, -1.5, shrubH, shrubR, seed * 17 + 3, 0.015)
    const tufts = scatterClusteredGroundCover({
      seed: seed ^ 0x2c91,
      bounds: [-4.8, -3.4, 4.8, 2.45],
      clusterCount: Math.max(1, Math.round(28 * params.grassDensity)),
      tuftsPerCluster: 4,
      avoid: (x, z) => Math.hypot(x, z + 0.35) < 0.75,
    })
    for (const t of tufts) {
      const { x, z, radius: r, height: h, tint: c } = t
      m.facet([x - r * 0.7, 0, z - r * 0.3], [x + r * 0.2, h, z + r * 0.3], [x + r * 0.8, 0, z - r * 0.2], c, MAT.foliage, 0)
      m.facet([x - r * 0.2, 0, z - r * 0.8], [x - r * 0.3, h * 0.85, z + r * 0.2], [x + r * 0.4, 0, z + r * 0.7], c, MAT.foliage, 0)
    }
    return m.pack()
  }

  buildFoliageTree(m, 0, -0.35, params.treeHeight, params.crownRadius, seed * 31 + 7, 0.015, params)
  buildFoliageTree(m, -2.7, -1.5, shrubH, shrubR, seed * 17 + 3, 0.015, params, "spreading")
  buildFoliageTree(m, 2.7, -1.5, shrubH, shrubR, seed * 17 + 3, 0.015, params, "spreading")

  // 4-layer volumetric grass fur shells across the swatch pad
  emitGrassFurShells(m, -5.0, -3.6, 5.0, 2.55, () => 0.0, params, 4, 2.0)

  const grassRng = new Rng(seed ^ 0x51a9)
  const clumps = scatterGrassClumps({
    seed: seed ^ 0x2c91,
    bounds: [-4.95, -3.55, 4.95, 2.54],
    clusterCount: 280,
    tuftsPerCluster: 6,
    params,
    avoid: (x, z) =>
      Math.hypot(x, z + 0.35) < 0.36 ||
      Math.hypot(x + 2.7, z + 1.5) < 0.32 ||
      Math.hypot(x - 2.7, z + 1.5) < 0.32,
  })
  for (const c of clumps) {
    emitGrassTuft(m, c.x, 0.0, c.z, {
      bladeCount: c.blades + 1,
      radius: c.radius * 1.18,
      height: c.height * 1.18,
      width: c.width,
      curvature: c.curvature,
      leanAngle: c.leanAngle,
      rootColor: c.rootColor,
      tipColor: c.tipColor,
      rng: grassRng,
    })
  }
  return m.pack()
}

export function createFoliage(context: LabContext): LabSection {
  const { device, stage } = context

  const settings: Record<string, string | number | boolean> = {
    playing: true,
    stageMode: "lot",
    cameraMode: "game",
    lightingPreset: "outbreak_dusk",
    compare: 1,
    seed: 7,
    tuningSeed: 41,
  }

  let meshDirty = true
  let simTime = 0

  Object.defineProperty(settings, "treePreset", {
    configurable: true,
    enumerable: true,
    get: () => foliageSettings.treePreset,
    set: (value: unknown) => {
      if (isFoliagePresetId(value)) {
        foliageSettings.treePreset = value
        meshDirty = true
      }
    },
  })

  Object.defineProperty(settings, "crownShape", {
    configurable: true,
    enumerable: true,
    get: () => foliageSettings.crownShape,
    set: (value: unknown) => {
      if (isFoliageCrownShape(value)) {
        foliageSettings.crownShape = value
        meshDirty = true
      }
    },
  })

  for (const spec of FOLIAGE_PARAM_SPECS) {
    Object.defineProperty(settings, spec.key, {
      configurable: true,
      enumerable: true,
      get: () => foliageSettings[spec.key],
      set: (value: number) => {
        if (typeof value === "number" && Number.isFinite(value)) {
          const clamped = Math.max(spec.min, Math.min(spec.max, value))
          if (foliageSettings[spec.key] !== clamped) {
            foliageSettings[spec.key] = clamped
            if (spec.boundary === "structural") meshDirty = true
          }
        }
      },
    })
  }

  const frameBuffer = device.createBuffer({
    size: 148 * 4,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  const uniformDataAfter = new Float32Array(16)
  const uniformDataBefore = new Float32Array(16)
  const uniformBufferAfter = device.createBuffer({
    size: uniformDataAfter.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  const uniformBufferBefore = device.createBuffer({
    size: uniformDataBefore.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })

  const bindLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
    ],
  })
  const bindGroupAfter = device.createBindGroup({
    layout: bindLayout,
    entries: [
      { binding: 0, resource: { buffer: frameBuffer } },
      { binding: 1, resource: { buffer: uniformBufferAfter } },
    ],
  })
  const bindGroupBefore = device.createBindGroup({
    layout: bindLayout,
    entries: [
      { binding: 0, resource: { buffer: frameBuffer } },
      { binding: 1, resource: { buffer: uniformBufferBefore } },
    ],
  })

  const module = device.createShaderModule({ code: foliageStageShader, label: "Lab foliage stage" })
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
    fragment: {
      module,
      entryPoint: "fs",
      targets: [{ format: "rgba16float" }],
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less-equal" },
    multisample: { count: 4, alphaToCoverageEnabled: true },
  })

  const uploadPackedMesh = (packed: ArrayBuffer, prev?: { buf: GPUBuffer; count: number }) => {
    prev?.buf.destroy()
    const buf = device.createBuffer({
      size: Math.max(64, packed.byteLength),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    })
    if (packed.byteLength) device.queue.writeBuffer(buf, 0, packed)
    return { buf, count: packed.byteLength / VERT_BYTES }
  }

  let afterMesh = uploadPackedMesh(buildLotFoliageMesh(7, foliageSettings, false))
  let beforeMesh = uploadPackedMesh(buildLotFoliageMesh(7, foliageSettings, true))
  let builtSeed = 7
  let builtStageMode: FoliageStageMode = "lot"

  const ensureMeshes = () => {
    const nextSeed = Math.max(1, Math.min(999, Math.round(Number(settings.seed) || 7)))
    const nextStage: FoliageStageMode = settings.stageMode === "swatch" ? "swatch" : "lot"
    if (!meshDirty && nextSeed === builtSeed && nextStage === builtStageMode) return
    builtSeed = nextSeed
    builtStageMode = nextStage
    meshDirty = false
    if (nextStage === "lot") {
      afterMesh = uploadPackedMesh(buildLotFoliageMesh(builtSeed, foliageSettings, false), afterMesh)
      beforeMesh = uploadPackedMesh(buildLotFoliageMesh(builtSeed, foliageSettings, true), beforeMesh)
    } else {
      afterMesh = uploadPackedMesh(buildSwatchFoliageMesh(builtSeed, foliageSettings, false), afterMesh)
      beforeMesh = uploadPackedMesh(buildSwatchFoliageMesh(builtSeed, foliageSettings, true), beforeMesh)
    }
  }

  const applyCameraMode = () => {
    const mode: FoliageCameraMode = settings.cameraMode === "game" ? "game" : "close"
    const isLot = settings.stageMode !== "swatch"
    if (mode === "game") {
      stage.camYaw = 0
      stage.camPitch = 0.80
      stage.frameTarget(0, 0.5, isLot ? 0.4 : 0, isLot ? 29 : 34)
    } else if (isLot) {
      stage.camYaw = -0.18
      stage.camPitch = 0.40
      stage.frameTarget(2.2, 1.35, 0.6, 8.8)
    } else {
      const focusY = Math.min(2.2, foliageSettings.treeHeight * 0.34)
      stage.camYaw = 0.24
      stage.camPitch = 0.42
      stage.frameTarget(0, focusY, -0.2, 8.8)
    }
  }

  const applyLightingPreset = () => {
    const key = String(settings.lightingPreset)
    const preset = FOLIAGE_LIGHTING_PRESETS[key]
    if (preset && Object.keys(preset.values).length > 0) {
      Object.assign(stage.lighting, preset.values)
    }
    const isLot = settings.stageMode !== "swatch"
    if (key === "outbreak_dusk") {
      stage.dynamicLights = isLot
        ? [
            // Warm sodium streetlamp on the right curb + left streetlamp fill + warm porch lantern + window spill
            { x: 3.6, y: 3.6, z: 3.65, radius: 14.5, r: 1.0, g: 0.78, b: 0.50, power: 3.2 },
            { x: -5.2, y: 3.6, z: 3.65, radius: 13.5, r: 1.0, g: 0.76, b: 0.48, power: 2.6 },
            { x: 0.9, y: 2.1, z: -0.4, radius: 9.5, r: 1.0, g: 0.66, b: 0.30, power: 2.2 },
            { x: -4.2, y: 1.6, z: -0.6, radius: 8.5, r: 1.0, g: 0.62, b: 0.26, power: 1.8 },
          ]
        : [
            { x: -3.2, y: 4.2, z: 2.8, radius: 14, r: 1.0, g: 0.76, b: 0.48, power: 2.8 },
            { x: 3.4, y: 2.6, z: -2.2, radius: 11, r: 1.0, g: 0.64, b: 0.34, power: 1.8 },
          ]
    } else if (key === "outbreak_day") {
      stage.dynamicLights = [
        { x: -3.5, y: 7.0, z: 4.0, radius: 22, r: 1.0, g: 0.95, b: 0.82, power: 3.2 },
        { x: 4.0, y: 5.5, z: 2.5, radius: 18, r: 0.74, g: 0.86, b: 1.0, power: 1.5 },
      ]
    } else if (key === "outbreak_night") {
      stage.dynamicLights = isLot
        ? [
            { x: 3.6, y: 3.6, z: 3.65, radius: 14.5, r: 1.0, g: 0.76, b: 0.46, power: 3.6 },
            { x: -5.2, y: 3.6, z: 3.65, radius: 13.5, r: 1.0, g: 0.74, b: 0.44, power: 2.8 },
            { x: 0.9, y: 2.1, z: -0.4, radius: 9.5, r: 1.0, g: 0.64, b: 0.28, power: 2.5 },
            { x: -4.2, y: 1.6, z: -0.6, radius: 8.5, r: 1.0, g: 0.58, b: 0.24, power: 2.0 },
          ]
        : [
            { x: -3.4, y: 3.8, z: 2.6, radius: 13, r: 1.0, g: 0.74, b: 0.44, power: 3.2 },
            { x: 2.8, y: 2.2, z: -1.8, radius: 9.5, r: 1.0, g: 0.58, b: 0.26, power: 2.1 },
          ]
    } else if (key === "cold_moon") {
      stage.dynamicLights = [
        { x: -3.0, y: 6.0, z: 3.5, radius: 18, r: 0.56, g: 0.74, b: 1.0, power: 1.8 },
      ]
    } else {
      stage.dynamicLights = null
    }
    context.sync()
  }

  const runRandomize = (scope: "all" | "tree" | "grass") => {
    const tSeed = Math.max(1, Math.min(9999, Math.round(Number(settings.tuningSeed) || 41)))
    const next = randomizeFoliageParams(foliageSettings, tSeed, scope)
    Object.assign(foliageSettings, next)
    settings.tuningSeed = (tSeed % 9999) + 1
    meshDirty = true
    ensureMeshes()
    context.sync()
  }

  const controls: LabControl[] = [
    {
      key: "stageMode",
      label: "Environment stage",
      group: "Stage & View",
      type: "select",
      options: [
        { value: "lot", label: "Outbreak house lot (in context)" },
        { value: "swatch", label: "Hero tree & turf pad" },
      ],
      change: () => {
        meshDirty = true
        ensureMeshes()
        applyLightingPreset()
        applyCameraMode()
        context.sync()
      },
    },
    {
      key: "treePreset",
      label: "Preset",
      group: "Stage & View",
      type: "select",
      options: FOLIAGE_PRESET_IDS.map(id => ({ value: id, label: FOLIAGE_PRESETS[id].label })),
      change: val => {
        const id: FoliagePresetId = isFoliagePresetId(val) ? val : "oak"
        resetFoliageParams(id, foliageSettings)
        meshDirty = true
        ensureMeshes()
        context.sync()
      },
    },
    {
      key: "crownShape",
      label: "Crown shape",
      group: "Stage & View",
      type: "select",
      options: [...FOLIAGE_CROWN_SHAPES],
      change: () => {
        meshDirty = true
        ensureMeshes()
        context.sync()
      },
    },
    {
      key: "cameraMode",
      label: "Camera view",
      group: "Stage & View",
      type: "select",
      options: [
        { value: "game", label: "Game camera (Outbreak view)" },
        { value: "close", label: "Close inspect (8.8 m)" },
      ],
      change: () => {
        applyCameraMode()
        context.sync()
      },
    },
    {
      key: "lightingPreset",
      label: "Lighting preset",
      group: "Stage & View",
      type: "select",
      options: Object.entries(FOLIAGE_LIGHTING_PRESETS).map(([value, p]) => ({ value, label: p.label })),
      change: applyLightingPreset,
    },
    {
      key: "compare",
      label: "Comparison",
      group: "Stage & View",
      type: "select",
      options: [
        { value: 1, label: "Improved foliage (After)" },
        { value: 0, label: "Shipped baseline (Before)" },
        { value: 2, label: "A/B split (Before | After)" },
      ],
      change: () => context.sync(),
    },
    {
      key: "seed",
      label: "Structure seed",
      group: "Stage & View",
      type: "range",
      min: 1,
      max: 999,
      step: 1,
      unit: "",
      change: () => {
        meshDirty = true
        ensureMeshes()
      },
    },
    {
      key: "tuningSeed",
      label: "Tuning seed",
      group: "Stage & View",
      type: "range",
      min: 1,
      max: 9999,
      step: 1,
      unit: "",
    },
    {
      key: "foliage.randomizeAll",
      label: "Randomize Tree + Grass",
      group: "Stage & View",
      type: "action",
      run: () => runRandomize("all"),
    },
    {
      key: "foliage.resetPreset",
      label: "Reset to preset defaults",
      group: "Stage & View",
      type: "action",
      run: () => {
        resetFoliageParams(foliageSettings.treePreset, foliageSettings)
        meshDirty = true
        ensureMeshes()
        context.sync()
      },
    },
  ]

  for (const spec of FOLIAGE_PARAM_SPECS) {
    controls.push({
      key: spec.key,
      label: spec.label,
      group: spec.group,
      type: "range",
      min: spec.min,
      max: spec.max,
      step: spec.step,
      unit: spec.unit,
      change: () => {
        if (spec.boundary === "structural") {
          meshDirty = true
          ensureMeshes()
        }
      },
    })
    if (spec.key === "porosity") {
      controls.push({
        key: "foliage.randomizeTree",
        label: "Randomize Tree",
        group: "Tree Structure",
        type: "action",
        run: () => runRandomize("tree"),
      })
    }
    if (spec.key === "grassClumping") {
      controls.push({
        key: "foliage.randomizeGrass",
        label: "Randomize Grass",
        group: "Grass Blades",
        type: "action",
        run: () => runRandomize("grass"),
      })
    }
  }

  return {
    id: "foliage",
    label: "Foliage",
    settings,
    controls,
    enter() {
      stage.sceneMode = 5
      applyLightingPreset()
      applyCameraMode()
      ensureMeshes()
    },
    leave() {
      stage.dynamicLights = null
    },
    update(dt) {
      if (settings.playing) {
        simTime += dt
      }
    },
    retrigger() {
      simTime = 0
      meshDirty = true
      ensureMeshes()
    },
    reroll() {
      settings.seed = (((Number(settings.seed) * 1664525 + 1013904223) >>> 0) % 999) + 1
      meshDirty = true
      ensureMeshes()
      context.sync()
    },
    frameTarget: () => {
      const mode: FoliageCameraMode = settings.cameraMode === "game" ? "game" : "close"
      const isLot = settings.stageMode !== "swatch"
      if (mode === "game") {
        return { x: 0, y: 0.5, z: isLot ? 0.4 : 0, dist: isLot ? 29 : 34 }
      }
      if (isLot) {
        return { x: 2.2, y: 1.35, z: 0.6, dist: 8.8 }
      }
      return { x: 0, y: Math.min(2.2, foliageSettings.treeHeight * 0.34), z: -0.2, dist: 8.8 }
    },
    prepare() {
      stage.sceneMode = 5
      ensureMeshes()
    },
    draw(pass) {
      const frame = (stage as unknown as { frame: Float32Array }).frame
      if (frame) {
        device.queue.writeBuffer(frameBuffer, 0, frame.buffer, frame.byteOffset, frame.byteLength)
      }
      const compareMode: FoliageCompareMode =
        Number(settings.compare) === 0 ? 0 : Number(settings.compare) === 2 ? 2 : 1
      const stageFlag = settings.stageMode === "swatch" ? 1.0 : 0.0

      const fillUniform = (arr: Float32Array<ArrayBuffer>, buf: GPUBuffer, passSide: number) => {
        arr[0] = simTime
        arr[1] = compareMode
        arr[2] = passSide
        arr[3] = stageFlag
        arr[4] = foliageSettings.dryPatches
        arr[5] = foliageSettings.grassVariation
        arr[6] = foliageSettings.autumnMix
        arr[7] = foliageSettings.treeColorVariation
        packFoliageUniforms(foliageSettings, arr, 8)
        device.queue.writeBuffer(buf, 0, arr)
      }

      pass.setPipeline(pipeline)

      if (compareMode === 0) {
        fillUniform(uniformDataBefore, uniformBufferBefore, -1)
        pass.setBindGroup(0, bindGroupBefore)
        pass.setVertexBuffer(0, beforeMesh.buf)
        pass.draw(beforeMesh.count)
      } else if (compareMode === 1) {
        fillUniform(uniformDataAfter, uniformBufferAfter, 1)
        pass.setBindGroup(0, bindGroupAfter)
        pass.setVertexBuffer(0, afterMesh.buf)
        pass.draw(afterMesh.count)
      } else {
        fillUniform(uniformDataBefore, uniformBufferBefore, -1)
        fillUniform(uniformDataAfter, uniformBufferAfter, 1)
        pass.setBindGroup(0, bindGroupBefore)
        pass.setVertexBuffer(0, beforeMesh.buf)
        pass.draw(beforeMesh.count)
        pass.setBindGroup(0, bindGroupAfter)
        pass.setVertexBuffer(0, afterMesh.buf)
        pass.draw(afterMesh.count)
      }
    },
    telemetry() {
      const preset = FOLIAGE_PRESETS[foliageSettings.treePreset]?.label ?? foliageSettings.treePreset
      const cmp = Number(settings.compare) === 0 ? "Before" : Number(settings.compare) === 2 ? "A/B Split" : "After"
      const stg = settings.stageMode === "swatch" ? "Swatch" : "Outbreak Lot"
      return `Foliage · ${stg} · ${preset} (${cmp}) {"verts":${afterMesh.count},"softness":${foliageSettings.normalSoftness.toFixed(2)},"wind":${foliageSettings.treeWindStrength.toFixed(2)}}`
    },
  }
}
