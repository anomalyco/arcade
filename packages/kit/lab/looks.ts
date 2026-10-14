import {
  LOOK_GROUPS,
  LOOK_PRESETS,
  LOOK_PRESET_IDS,
  LOOK_UNIFORM_FLOATS,
  applyLookPreset,
  createLookControls,
  createLookSettings,
  exportLookPreset,
  importLookPreset,
  isLookPresetId,
  lookStructWgsl,
  packLookUniforms,
  randomizeLookSettings,
  resolveLookGroup,
  resolveLookPresetId,
  type LookCompareMode,
  type LookGroup,
  type LookPresetId,
  type LookSettings,
} from "../gpu/look"
import {
  legacyMaterialComparisonWgsl,
  scatterClusteredGroundCover,
  surfaceMaterialCoreWgsl,
} from "../gpu/surface-materials"
import type { LabControl } from "../lab-panel"
import { frameShader } from "./stage-shader"
import type { LabContext, LabSection, LabWorldObject } from "./types"

const lookRoomSceneShader =
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
  lookStructWgsl +
  /* wgsl */ `
@group(0) @binding(1) var<uniform> L: LookUniforms;

struct VIn {
  @location(0) pos: vec3f,
  @location(1) normal: vec3f,
  @location(2) color: vec3f,
  @location(3) matKind: f32,
}

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) color: vec3f,
  @location(3) @interpolate(flat) matKind: f32,
}

@vertex fn vs(v: VIn) -> VOut {
  var o: VOut;
  o.world = v.pos;
  o.pos = F.vp * vec4f(v.pos, 1.0);
  o.normal = normalize(v.normal);
  o.color = v.color;
  o.matKind = v.matKind;
  return o;
}

struct RoomBox {
  lo: vec3f,
  hi: vec3f,
}

const OCC_BOXES = array<RoomBox, 7>(
  // Left wall below and above window
  RoomBox(vec3f(-4.82, 0.0, -4.25), vec3f(-4.48, 1.05, 0.85)),
  RoomBox(vec3f(-4.82, 2.42, -4.25), vec3f(-4.48, 2.95, 0.85)),
  // Rear wall
  RoomBox(vec3f(-4.82, 0.0, -4.25), vec3f(1.25, 2.95, -3.94)),
  // Stacked room cubes
  RoomBox(vec3f(-3.45, 0.36, -2.85), vec3f(-2.35, 1.46, -1.75)),
  RoomBox(vec3f(-3.18, 1.46, -2.58), vec3f(-2.48, 2.16, -1.88)),
  // Threshold column
  RoomBox(vec3f(0.56, 0.0, -2.14), vec3f(1.14, 2.72, -1.56)),
  // Yard plinth cube
  RoomBox(vec3f(1.95, 0.0, -1.85), vec3f(3.05, 0.96, -0.75))
);

fn segBoxVis(p: vec3f, dir: vec3f, maxDist: f32, b: RoomBox) -> f32 {
  let safe = select(select(vec3f(-1e-6), vec3f(1e-6), dir >= vec3f(0.0)), dir, abs(dir) > vec3f(1e-6));
  let t0 = (b.lo - p) / safe;
  let t1 = (b.hi - p) / safe;
  let lo = min(t0, t1);
  let hi = max(t0, t1);
  let near = max(0.02, max(lo.x, max(lo.y, lo.z)));
  let far = min(maxDist, min(hi.x, min(hi.y, hi.z)));
  if (near >= far) { return 1.0; }
  let mid = p + dir * ((near + far) * 0.5);
  let d = min(mid - b.lo, b.hi - mid);
  let pen = min(d.x, min(d.y, d.z));
  return 1.0 - smoothstep(0.0, 0.09, pen);
}

fn segSphereVis(p: vec3f, dir: vec3f, maxDist: f32, c: vec3f, r: f32) -> f32 {
  let oc = c - p;
  let proj = dot(oc, dir);
  if (proj <= 0.02 || proj >= maxDist) { return 1.0; }
  let d2 = max(0.0, dot(oc, oc) - proj * proj);
  return smoothstep(r * 0.82, r * 1.12, sqrt(d2));
}

fn roomShadowVis(p: vec3f, dir: vec3f, maxDist: f32) -> f32 {
  var vis = 1.0;
  for (var i = 0; i < 7; i++) {
    vis = min(vis, segBoxVis(p, dir, maxDist, OCC_BOXES[i]));
  }
  // Hero spheres & character capsule
  vis = min(vis, segSphereVis(p, dir, maxDist, vec3f(-1.15, 1.24, -0.85), 0.70));
  vis = min(vis, segSphereVis(p, dir, maxDist, vec3f(2.50, 1.50, -1.30), 0.54));
  vis = min(vis, segSphereVis(p, dir, maxDist, vec3f(-0.35, 1.15, 0.15), 0.36));
  return vis;
}

// Window cookie for directional moonlight / sunlight entering through the left-wall clerestory window
fn windowApertureCookie(world: vec3f, lightDir: vec3f, slats: f32) -> f32 {
  if (world.x < -4.55 || world.z < -4.05) { return 1.0; }
  // Ray from world toward lightDir (-lightDir points from light to surface; lightDir points toward the moon/sun at -X, +Y, -Z)
  if (lightDir.x >= -0.05) { return 1.0; }
  let t = (-4.62 - world.x) / lightDir.x;
  if (t <= 0.0) { return 1.0; }
  let hit = world + lightDir * t;
  // If ray crosses the left wall plane (z in [-4.2, 0.85]), check if it passes through the window opening:
  // Window opening: y in [1.05, 2.42], z in [-3.15, -0.95]
  if (hit.z >= -4.2 && hit.z <= 0.85 && hit.y < 2.88) {
    let inY = smoothstep(1.02, 1.10, hit.y) * (1.0 - smoothstep(2.36, 2.44, hit.y));
    let inZ = smoothstep(-3.18, -3.08, hit.z) * (1.0 - smoothstep(-1.02, -0.92, hit.z));
    let open = inY * inZ;
    // Center vertical mullion at z = -2.05 and horizontal transom at y = 1.74
    let mullion = smoothstep(0.025, 0.055, abs(hit.z - (-2.05))) * smoothstep(0.02, 0.045, abs(hit.y - 1.74));
    let slatWave = 1.0 - slats * 0.65 * (0.5 + 0.5 * cos((hit.y - 1.05) * 42.0));
    return open * mullion * slatWave;
  }
  return 1.0;
}

fn contactCavity(p: vec3f, n: vec3f) -> f32 {
  var occ = 0.0;
  // Floor & step crease contact
  let floorDist = min(abs(p.y - 0.36), abs(p.y));
  if (abs(n.y) < 0.5) {
    occ = max(occ, (1.0 - smoothstep(0.0, 0.28, floorDist)) * 0.65);
  }
  // Wall corners
  let dRear = abs(p.z - (-3.94));
  let dLeft = abs(p.x - (-4.48));
  occ = max(occ, (1.0 - smoothstep(0.0, 0.35, dRear)) * 0.55);
  occ = max(occ, (1.0 - smoothstep(0.0, 0.35, dLeft)) * 0.55);
  // Under spheres & character feet
  let dSp1 = length(p.xz - vec2f(-1.15, -0.85));
  if (p.y < 0.62) { occ = max(occ, (1.0 - smoothstep(0.15, 0.82, dSp1)) * 0.72); }
  let dSp2 = length(p.xz - vec2f(2.50, -1.30));
  if (p.y > 0.88 && p.y < 1.12) { occ = max(occ, (1.0 - smoothstep(0.12, 0.64, dSp2)) * 0.72); }
  let dChar = length(p.xz - vec2f(-0.35, 0.15));
  if (p.y < 0.55) { occ = max(occ, (1.0 - smoothstep(0.10, 0.52, dChar)) * 0.78); }
  let dCol = length(p.xz - vec2f(0.85, -1.85));
  if (p.y < 0.50) { occ = max(occ, (1.0 - smoothstep(0.22, 0.65, dCol)) * 0.65); }
  return occ;
}

@fragment fn fs(o: VOut) -> @location(0) vec4f {
  surfaceFootprint = max(length(dpdx(o.world)), length(dpdy(o.world)));
  let n = normalize(o.normal);
  let V = normalize(F.eye.xyz - o.world);
  let rawKind = i32(round(o.matKind));

  let screenUvX = o.pos.x / max(1.0, F.options.y);
  let compareMode = i32(round(L.u12.w));
  let wipeSplit = L.u13.w;
  let useLook = select(compareMode == 1, screenUvX >= wipeSplit, compareMode == 2);

  // Extract active vs identity look surface parameters
  let paletteMix = select(0.0, L.u3.w, useLook);
  let foliageShift = select(0.0, L.u11.z, useLook);
  let ambientFill = select(1.0, L.u4.x, useLook);
  let shadowCol = select(vec3f(1.0), L.u4.yzw, useLook);
  let practicalWarmth = select(0.0, L.u5.x, useLook);
  let practicalInt = select(1.0, L.u5.y, useLook);
  let moonInt = select(1.0, L.u5.z, useLook);
  let rimStrength = select(0.0, L.u5.w, useLook);
  let contactStr = select(0.0, L.u6.x, useLook);
  let wetness = select(0.0, L.u6.y, useLook);
  let slats = select(0.35, L.u8.x, useLook);
  let wrap = select(0.12, L.u10.x + 0.12, useLook);
  let bands = select(0.0, L.u10.y, useLook);
  let bandSoft = select(0.18, L.u10.z, useLook);
  let painterly = select(0.0, L.u10.w, useLook);

  // Suppress high-frequency procedural noise when painterly brush smoothing is active
  surfaceFootprint = max(surfaceFootprint, painterly * 0.085);

  // Emissive window glass (15) and practical lamp bulbs (14)
  if (rawKind == 15) {
    let skyCol = mix(vec3f(0.55, 0.72, 1.05), L.u4.yzw * vec3f(0.75, 0.88, 1.15), select(0.0, 0.65, useLook));
    let slatMod = 1.0 - slats * 0.55 * (0.5 + 0.5 * cos((o.world.y - 1.05) * 42.0));
    return vec4f(skyCol * (1.85 * moonInt * slatMod), 1.0);
  }
  if (rawKind == 14) {
    let bulbCol = lookPracticalColor(vec3f(1.0, 0.68, 0.34), practicalWarmth);
    return vec4f(bulbCol * (2.8 * max(0.25, practicalInt)), 1.0);
  }

  let evalWorld = select(
    vec3f(o.world.x + o.world.z * 0.35, o.world.y, o.world.y + o.world.z * 0.25),
    o.world,
    abs(n.y) > 0.52
  );

  var baseLinear = pow(max(o.color, vec3f(0.015)), vec3f(2.2));
  if (paletteMix > 0.001) {
    var targetPal = o.color;
    if (rawKind == 0) { targetPal = L.u13.xyz; }
    else if (rawKind == 1) { targetPal = L.u14.xyz; }
    else if (rawKind == 2) { targetPal = L.u12.xyz; }
    else if (rawKind == 4 || rawKind == 5) { targetPal = L.u15.xyz; }
    let targetLinear = pow(max(targetPal, vec3f(0.015)), vec3f(2.2));
    baseLinear = mix(baseLinear, targetLinear, paletteMix);
  }
  if ((rawKind == 4 || rawKind == 5) && abs(foliageShift) > 0.001) {
    let warmFoliage = baseLinear * vec3f(1.38, 1.08, 0.55);
    let coolFoliage = vec3f(dot(baseLinear, vec3f(0.3, 0.5, 0.2))) * vec3f(0.72, 0.88, 0.96);
    if (foliageShift >= 0.0) {
      baseLinear = mix(baseLinear, warmFoliage, clamp(foliageShift, 0.0, 1.0));
    } else {
      baseLinear = mix(baseLinear, coolFoliage, clamp(-foliageShift, 0.0, 1.0));
    }
  }

  var sample: SurfaceSample;
  if (rawKind >= 0 && rawKind <= 5) {
    sample = evalRecipeById(rawKind, evalWorld, n, baseLinear, defaultMaterialRecipe(rawKind));
  } else if (rawKind == 11) {
    // Smooth calibration sphere
    sample = SurfaceSample(baseLinear, vec2f(72.0, 0.42), 0.24, 1.0);
  } else if (rawKind == 12) {
    // Matte ceramic/plaster sphere
    sample = SurfaceSample(baseLinear, vec2f(14.0, 0.08), 0.78, 1.0);
  } else if (rawKind == 13) {
    // Character silhouette (coat/hat/boots)
    sample = SurfaceSample(baseLinear, vec2f(18.0, 0.12), 0.72, 1.0);
  } else {
    // Trim / plinth / frames (10)
    sample = SurfaceSample(baseLinear, vec2f(22.0, 0.14), 0.68, 1.0);
  }

  // Apply surface wetness (Noir rain-slicked floor/steps/asphalt sheen)
  if (wetness > 0.001 && n.y > 0.65 && (rawKind == 0 || rawKind == 1 || rawKind == 3)) {
    let puddleNoise = smoothstep(0.32, 0.68, surfaceNoise(o.world.xz * 0.85 + vec2f(1.7, 3.1)));
    let wetMask = wetness * (0.45 + 0.55 * puddleNoise);
    sample.albedo *= 1.0 - 0.32 * wetMask;
    sample.gloss = mix(sample.gloss, vec2f(115.0, 1.15), wetMask);
  }

  // 1. Ambient / sky hemisphere fill + shadow colour tint
  let isNoirRoom = useLook && i32(round(L.u14.w)) == 1;
  let hemi = 0.35 + 0.65 * clamp(n.y * 0.5 + 0.5, 0.0, 1.0);
  let baseAmb = vec3f(0.032, 0.044, 0.072) * ambientFill * select(1.0, 0.35, isNoirRoom) * shadowCol;
  var diff = baseAmb * hemi * sample.cavity;
  var spec = vec3f(0.0);

  // 2. Directional cold moonlight / sunlight through window & over yard
  let moonDir = normalize(vec3f(-0.68, 0.54, -0.49));
  let moonNdl = lookQuantizeDiffuse(dot(n, moonDir), wrap * 0.5, bands, bandSoft);
  if (moonNdl > 0.001 && moonInt > 0.001) {
    let winCookie = windowApertureCookie(o.world, moonDir, slats);
    let mVis = roomShadowVis(o.world + n * 0.02, moonDir, 12.0) * winCookie;
    let moonCol = vec3f(0.48, 0.64, 0.94) * shadowCol * select(0.42, 0.24, isNoirRoom) * moonInt;
    diff += moonCol * moonNdl * mVis * sample.cavity;
    if (sample.gloss.x > 0.0) {
      let h = normalize(moonDir + V);
      let s = pow(max(0.0, dot(n, h)), sample.gloss.x) * (sample.gloss.x + 2.0) * 0.007;
      spec += moonCol * s * sample.gloss.y * mVis;
    }
  }

  // 2b. Character flashlight cone cutting across the steps & cobblestone walk in Noir / Rim mode
  if (rimStrength > 0.5) {
    let torchPos = vec3f(-0.22, 1.18, 0.22);
    let torchAim = normalize(vec3f(0.28, -0.34, 0.90));
    let toTorch = torchPos - o.world;
    let td = length(toTorch);
    if (td > 0.15 && td < 7.2) {
      let tdir = toTorch / td;
      let cosAng = dot(-tdir, torchAim);
      let cone = pow(smoothstep(0.84, 0.985, cosAng), 1.6);
      let fade = pow(max(0.0, 1.0 - td / 7.2), 1.35);
      let tndl = lookQuantizeDiffuse(dot(n, tdir), wrap, bands, bandSoft);
      let torchIntensity = clamp((rimStrength - 0.5) * 2.2, 0.0, 3.2) * cone * fade;
      let torchCol = vec3f(0.84, 0.94, 1.12);
      diff += torchCol * torchIntensity * (0.2 + 0.8 * tndl) * 2.1;
      if (sample.gloss.x > 0.0) {
        let h = normalize(tdir + V);
        let s = pow(max(0.0, dot(n, h)), sample.gloss.x) * (sample.gloss.x + 2.0) * 0.012;
        spec += torchCol * torchIntensity * s * sample.gloss.y * 1.6;
      }
    }
  }

  // 3. Two warm practical lamps (Interior sconce + Threshold post lamp) — tight pools that carve shapes out of darkness
  let lampPos = array<vec3f, 2>(
    vec3f(-3.75, 1.82, -3.42),
    vec3f(1.45, 1.98, 1.15)
  );
  let lampBaseCol = array<vec3f, 2>(
    vec3f(1.05, 0.66, 0.32),
    vec3f(1.02, 0.62, 0.28)
  );
  let lampRad = array<f32, 2>(4.6, 5.2);
  let lampPow = array<f32, 2>(1.85, 2.05);

  for (var i = 0; i < 2; i++) {
    let lpos = lampPos[i];
    let delta = lpos - o.world;
    let dist = length(delta);
    let rad = lampRad[i];
    if (dist >= rad || practicalInt <= 0.001) { continue; }
    let ldir = delta / max(dist, 0.001);
    let x = dist / rad;
    let win = (1.0 - x * x) * (1.0 - x * x);
    let atten = lampPow[i] * practicalInt * win / (1.0 + dist * dist * 0.55);
    let vis = 0.03 + 0.97 * roomShadowVis(o.world + n * 0.02, ldir, dist - 0.18);
    let lcol = lookPracticalColor(lampBaseCol[i], practicalWarmth);
    let ndl = lookQuantizeDiffuse(dot(n, ldir), wrap, bands, bandSoft);
    diff += lcol * atten * ndl * vis * mix(0.65, 1.0, sample.cavity);
    if (sample.gloss.x > 0.0 && sample.gloss.y > 0.0) {
      let h = normalize(ldir + V);
      let s = pow(max(0.0, dot(n, h)), sample.gloss.x) * (sample.gloss.x + 2.0) * 0.009;
      spec += lcol * atten * s * sample.gloss.y * vis;
      // Wet floor elongated mirror streak under practical lamps
      if (wetness > 0.05 && n.y > 0.8) {
        let k = lpos.y / max(0.1, lpos.y + F.eye.y);
        let pm = lpos.xz + (F.eye.xz - lpos.xz) * k;
        let q = o.world.xz - pm;
        let streak = exp(-dot(q, q) / 0.28) * wetness * 0.38;
        spec += lcol * practicalInt * streak * vis;
      }
    }
  }

  // 4. Silhouette / rim lighting (strongest on character, spheres, column & grazing edges)
  let ndv = clamp(dot(n, V), 0.0, 1.0);
  let rimWeight = select(1.0, 1.65, rawKind == 13 || rawKind == 11 || rawKind == 12);
  let rim = pow(1.0 - ndv, 2.8) * (0.35 + 0.65 * clamp(dot(n, moonDir) * 0.5 + 0.5, 0.0, 1.0));
  let rimCol = mix(vec3f(0.56, 0.72, 0.98) * shadowCol, vec3f(1.0, 0.78, 0.52), clamp(L.u1.w * 0.5 + 0.25, 0.0, 1.0));
  let rimAdd = rimCol * rim * rimStrength * rimWeight * 0.26;

  // 5. Contact shading in corners, step risers & under objects
  let cavityOcc = contactCavity(o.world, n);
  let contactMult = 1.0 - clamp(cavityOcc * (0.35 + 0.65 * contactStr), 0.0, 0.85);

  var color = (sample.albedo * diff + spec + rimAdd) * contactMult;

  if (F.options.z == 3.0) {
    color = diff * contactMult + spec;
  } else if (F.options.z == 5.0) {
    color = n * 0.5 + 0.5;
  }
  return vec4f(color, 1.0);
}

@fragment fn fsNormalDepth(o: VOut) -> @location(0) vec4f {
  let n = normalize(o.normal);
  let dist = length(o.world - F.eye.xyz);
  return vec4f(n * 0.5 + 0.5, dist);
}
`

const lookRoomPostShader =
  frameShader +
  lookStructWgsl +
  /* wgsl */ `
@group(0) @binding(1) var<uniform> L: LookUniforms;
@group(0) @binding(2) var tScene: texture_2d<f32>;
@group(0) @binding(3) var sLinear: sampler;
@group(0) @binding(4) var tNormalDepth: texture_2d<f32>;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
}

@vertex fn vs(@builtin(vertex_index) i: u32) -> VSOut {
  let c = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VSOut;
  o.pos = vec4f(c[i], 0.0, 1.0);
  o.uv = c[i] * vec2f(0.5, -0.5) + 0.5;
  return o;
}

struct RayHit {
  dist: f32,
  world: vec3f,
  normal: vec3f,
}

fn readMeshHit(uv: vec2f) -> RayHit {
  let q = F.inverse * vec4f(uv * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), 1.0, 1.0);
  let ray = normalize(q.xyz / q.w - F.eye.xyz);
  let origin = F.eye.xyz;
  let nd = textureSampleLevel(tNormalDepth, sLinear, clamp(uv, vec2f(0.001), vec2f(0.999)), 0.0);
  let hasMesh = nd.a > 0.05;
  let fallbackT = select(36.0, -origin.y / ray.y, ray.y < -1e-4 && -origin.y / ray.y > 0.0);
  let dist = select(fallbackT, nd.a, hasMesh);
  let normal = select(vec3f(0.0, 1.0, 0.0), normalize(nd.rgb * 2.0 - 1.0), hasMesh);
  return RayHit(dist, origin + ray * dist, normal);
}

// 4-quadrant edge-preserving Kuwahara-lite brush filter
fn kuwaharaSmooth(uv: vec2f, texel: vec2f, strength: f32) -> vec3f {
  let center = textureSampleLevel(tScene, sLinear, uv, 0.0).rgb;
  if (strength <= 0.01) {
    return center;
  }
  let r = texel * (1.0 + strength * 1.6);
  let cNW = textureSampleLevel(tScene, sLinear, uv + vec2f(-r.x, -r.y), 0.0).rgb;
  let cN  = textureSampleLevel(tScene, sLinear, uv + vec2f(0.0, -r.y), 0.0).rgb;
  let cNE = textureSampleLevel(tScene, sLinear, uv + vec2f(r.x, -r.y), 0.0).rgb;
  let cW  = textureSampleLevel(tScene, sLinear, uv + vec2f(-r.x, 0.0), 0.0).rgb;
  let cE  = textureSampleLevel(tScene, sLinear, uv + vec2f(r.x, 0.0), 0.0).rgb;
  let cSW = textureSampleLevel(tScene, sLinear, uv + vec2f(-r.x, r.y), 0.0).rgb;
  let cS  = textureSampleLevel(tScene, sLinear, uv + vec2f(0.0, r.y), 0.0).rgb;
  let cSE = textureSampleLevel(tScene, sLinear, uv + vec2f(r.x, r.y), 0.0).rgb;

  let lumaW = vec3f(0.2126, 0.7152, 0.0722);
  let lC  = dot(center, lumaW);
  let lNW = dot(cNW, lumaW); let lN = dot(cN, lumaW); let lNE = dot(cNE, lumaW);
  let lW  = dot(cW, lumaW);                           let lE  = dot(cE, lumaW);
  let lSW = dot(cSW, lumaW); let lS = dot(cS, lumaW); let lSE = dot(cSE, lumaW);

  let m0 = (center + cNW + cN + cW) * 0.25;
  let m1 = (center + cNE + cN + cE) * 0.25;
  let m2 = (center + cSW + cS + cW) * 0.25;
  let m3 = (center + cSE + cS + cE) * 0.25;

  let lm0 = (lC + lNW + lN + lW) * 0.25;
  let lm1 = (lC + lNE + lN + lE) * 0.25;
  let lm2 = (lC + lSW + lS + lW) * 0.25;
  let lm3 = (lC + lSE + lS + lE) * 0.25;

  let v0 = (lC - lm0)*(lC - lm0) + (lNW - lm0)*(lNW - lm0) + (lN - lm0)*(lN - lm0) + (lW - lm0)*(lW - lm0);
  let v1 = (lC - lm1)*(lC - lm1) + (lNE - lm1)*(lNE - lm1) + (lN - lm1)*(lN - lm1) + (lE - lm1)*(lE - lm1);
  let v2 = (lC - lm2)*(lC - lm2) + (lSW - lm2)*(lSW - lm2) + (lS - lm2)*(lS - lm2) + (lW - lm2)*(lW - lm2);
  let v3 = (lC - lm3)*(lC - lm3) + (lSE - lm3)*(lSE - lm3) + (lS - lm3)*(lS - lm3) + (lE - lm3)*(lE - lm3);

  let w0 = 1.0 / (1.0 + v0 * 240.0);
  let w1 = 1.0 / (1.0 + v1 * 240.0);
  let w2 = 1.0 / (1.0 + v2 * 240.0);
  let w3 = 1.0 / (1.0 + v3 * 240.0);
  let painted = (m0 * w0 + m1 * w1 + m2 * w2 + m3 * w3) / (w0 + w1 + w2 + w3);
  return mix(center, painted, clamp(strength, 0.0, 1.0));
}

// Multi-radius bloom & halation highlight gather
fn gatherBloom(uv: vec2f, texel: vec2f) -> vec3f {
  let offsets = array<vec2f, 8>(
    vec2f(1.0, 0.0), vec2f(-1.0, 0.0), vec2f(0.0, 1.0), vec2f(0.0, -1.0),
    vec2f(0.707, 0.707), vec2f(-0.707, 0.707), vec2f(0.707, -0.707), vec2f(-0.707, -0.707)
  );
  var sum = vec3f(0.0);
  for (var i = 0; i < 8; i++) {
    let c1 = textureSampleLevel(tScene, sLinear, clamp(uv + offsets[i] * texel * 3.5, vec2f(0.002), vec2f(0.998)), 0.0).rgb;
    let c2 = textureSampleLevel(tScene, sLinear, clamp(uv + offsets[i] * texel * 11.0, vec2f(0.002), vec2f(0.998)), 0.0).rgb;
    let p1 = max(c1.r, max(c1.g, c1.b));
    let p2 = max(c2.r, max(c2.g, c2.b));
    let k1 = clamp((p1 - 0.55) / 0.65, 0.0, 1.0);
    let k2 = clamp((p2 - 0.50) / 0.65, 0.0, 1.0);
    sum += c1 * (k1 * k1 * 0.6) + c2 * (k2 * k2 * 0.4);
  }
  return sum / 8.0;
}

// Volumetric window light shaft & Beer-Lambert height-settled fog (ported from Lamplight post.wgsl)
fn evaluateRoomAtmosphere(
  origin: vec3f,
  hit: RayHit,
  fogDensity: f32,
  fogHeight: f32,
  fogCol: vec3f,
  shaftStrength: f32,
  slats: f32,
  practicalWarmth: f32,
) -> vec4f {
  let rayVec = hit.world - origin;
  let rayLen = min(length(rayVec), 38.0);
  let dir = rayVec / max(rayLen, 1e-4);

  // Height-settled Beer-Lambert optical depth
  let hScale = max(0.3, fogHeight);
  let k = dir.y / hScale;
  let settled = select((1.0 - exp(-rayLen * k)) / k, rayLen, abs(k) < 1e-4);
  let opticalDepth = fogDensity * 0.045 * settled * exp(-max(origin.y - 0.5, 0.0) / hScale);
  let trans = exp(-opticalDepth);

  var shaftSum = 0.0;
  var warmAir = 0.0;
  if (shaftStrength > 0.001 || fogDensity > 0.001) {
    // Intersect camera ray with the window beam volume box [-4.62..1.5, 0.25..2.55, -3.4..1.0]
    let safe = select(select(vec3f(-1e-6), vec3f(1e-6), dir >= vec3f(0.0)), dir, abs(dir) > vec3f(1e-6));
    let bLo = (vec3f(-4.62, 0.25, -3.4) - origin) / safe;
    let bHi = (vec3f(1.5, 2.55, 1.0) - origin) / safe;
    let tMin = min(bLo, bHi);
    let tMax = max(bLo, bHi);
    let t0 = max(1.0, max(tMin.x, max(tMin.y, tMin.z)));
    let t1 = min(rayLen, min(tMax.x, min(tMax.y, tMax.z)));
    if (t1 > t0 && shaftStrength > 0.001) {
      let steps = 16;
      let dt = (t1 - t0) / f32(steps);
      let moonDir = normalize(vec3f(-0.68, 0.54, -0.49));
      for (var i = 0; i < 16; i++) {
        let t = t0 + (f32(i) + 0.5) * dt;
        let p = origin + dir * t;
        let tWin = (-4.62 - p.x) / moonDir.x;
        if (tWin > 0.0) {
          let q = p + moonDir * tWin;
          let inY = smoothstep(1.00, 1.24, q.y) * (1.0 - smoothstep(2.22, 2.46, q.y));
          let inZ = smoothstep(-3.20, -2.90, q.z) * (1.0 - smoothstep(-1.15, -0.88, q.z));
          let mullion = smoothstep(0.015, 0.085, abs(q.z - (-2.05))) * smoothstep(0.015, 0.075, abs(q.y - 1.74));
          let slatMod = 1.0 - slats * 0.58 * (0.5 + 0.5 * cos((q.y - 1.05) * 32.0));
          let heightFade = exp(-max(p.y - 0.36, 0.0) / hScale);
          let throwFade = 1.0 - smoothstep(0.8, 5.6, p.x - (-4.5));
          shaftSum += inY * inZ * mullion * slatMod * heightFade * throwFade * dt * 0.16;
        }
      }
    }
    // Analytic point-to-ray closest approach for the two warm practical lamp air spheres
    let lamps = array<vec3f, 2>(vec3f(-3.75, 1.72, -3.42), vec3f(1.45, 1.88, 1.15));
    for (var l = 0; l < 2; l++) {
      let oc = lamps[l] - origin;
      let proj = clamp(dot(oc, dir), 0.0, rayLen);
      let closest = origin + dir * proj;
      let d2 = dot(closest - lamps[l], closest - lamps[l]);
      warmAir += exp(-d2 * 1.15) * smoothstep(0.0, 0.4, rayLen - proj) * 0.32;
    }
  }
  let shaftLift = (1.0 - exp(-shaftSum * 1.45)) * shaftStrength;
  let warmCol = lookPracticalColor(vec3f(1.0, 0.62, 0.26), practicalWarmth);
  let shaftCol = mix(vec3f(0.68, 0.82, 1.08), vec3f(1.08, 0.84, 0.52), clamp(L.u1.w * 0.5 + 0.25, 0.0, 1.0));
  // Volumetric flashlight cone air haze in front of character when rim/flashlight is active
  var torchAir = 0.0;
  if (L.u5.w > 0.5) {
    let torchPos = vec3f(-0.22, 1.18, 0.22);
    let torchAim = normalize(vec3f(0.28, -0.34, 0.90));
    for (var ti = 0; ti < 8; ti++) {
      let t = 8.0 + f32(ti) * 1.1;
      if (t >= rayLen) { break; }
      let p = origin + dir * t;
      let v = p - torchPos;
      let along = dot(v, torchAim);
      if (along > 0.05 && along < 5.5) {
        let perp2 = max(0.0, dot(v, v) - along * along);
        let coneR = 0.08 + along * 0.22;
        torchAir += exp(-perp2 / (coneR * coneR)) * (1.0 - along / 5.5) * 0.045;
      }
    }
  }
  // Convert perceptual fogColor sliders to linear light so fog never washes dark Noir scenes grey
  let linearFogCol = pow(max(fogCol, vec3f(0.0)), vec3f(2.2)) * clamp(L.u4.x * 0.65, 0.04, 1.2);
  let inScatter = linearFogCol * (1.0 - trans) + shaftCol * (shaftLift * 0.36) + warmCol * (warmAir * (0.18 + fogDensity * 0.45)) + vec3f(0.75, 0.88, 1.08) * torchAir * clamp(L.u5.w - 0.5, 0.0, 1.5);
  return vec4f(inScatter, trans);
}

@fragment fn post(o: VSOut) -> @location(0) vec4f {
  let dims = vec2f(textureDimensions(tScene));
  let texel = 1.0 / max(dims, vec2f(1.0));
  let uv = o.uv;

  // Debug view 3 (Lighting only) or 5 (Normals): pass through without post grading
  if (F.options.z == 3.0 || F.options.z == 5.0) {
    return vec4f(textureSampleLevel(tScene, sLinear, uv, 0.0).rgb, 1.0);
  }

  let compareMode = i32(round(L.u12.w));
  let wipeSplit = L.u13.w;
  let useLook = select(compareMode == 1, uv.x >= wipeSplit, compareMode == 2);

  let hit = readMeshHit(uv);

  if (!useLook) {
    // Identity "Current" post pass: standard bloom + ACES tonemap
    let raw = textureSampleLevel(tScene, sLinear, uv, 0.0).rgb;
    let bloom = gatherBloom(uv, texel);
    let c = lookTonemapACES(raw + bloom * 0.18);
    if (compareMode == 2) {
      let line = 1.0 - smoothstep(texel.x * 1.2, texel.x * 2.8, abs(uv.x - wipeSplit));
      return vec4f(mix(c, vec3f(0.92, 0.96, 1.0), line * 0.85), 1.0);
    }
    return vec4f(c, 1.0);
  }

  // 1. Chromatic softness / aberration toward frame borders
  let fromC = uv - 0.5;
  let caOffset = fromC * dot(fromC, fromC) * (L.u9.w * 0.018);
  let painterly = L.u10.w;

  var sceneCol: vec3f;
  if (painterly > 0.01) {
    sceneCol = kuwaharaSmooth(uv, texel, painterly);
  } else if (L.u9.w > 0.001) {
    sceneCol = vec3f(
      textureSampleLevel(tScene, sLinear, clamp(uv + caOffset, vec2f(0.001), vec2f(0.999)), 0.0).r,
      textureSampleLevel(tScene, sLinear, uv, 0.0).g,
      textureSampleLevel(tScene, sLinear, clamp(uv - caOffset, vec2f(0.001), vec2f(0.999)), 0.0).b
    );
  } else {
    sceneCol = textureSampleLevel(tScene, sLinear, uv, 0.0).rgb;
  }

  // 2. Depth / normal ink outlines from true rendered mesh geometry (Painterly & Ink)
  let outlineStr = L.u11.x;
  let outlineWidth = L.u11.y;
  var inkFactor = 0.0;
  if (outlineStr > 0.001) {
    let stepUv = texel * outlineWidth;
    let hR = readMeshHit(uv + vec2f(stepUv.x, 0.0));
    let hL = readMeshHit(uv - vec2f(stepUv.x, 0.0));
    let hU = readMeshHit(uv - vec2f(0.0, stepUv.y));
    let hD = readMeshHit(uv + vec2f(0.0, stepUv.y));
    let depthGrad = (abs(hR.dist - hL.dist) + abs(hU.dist - hD.dist)) / max(hit.dist * 0.08, 0.12);
    let depthEdge = smoothstep(0.28, 0.78, depthGrad);
    let normGrad = length(hR.normal - hL.normal) + length(hU.normal - hD.normal);
    let normEdge = smoothstep(0.45, 1.15, normGrad);
    inkFactor = clamp(max(depthEdge, normEdge * 0.72) * outlineStr, 0.0, 0.85);
  }

  // 3. Volumetric height fog & window light shafts
  let atmos = evaluateRoomAtmosphere(
    F.eye.xyz,
    hit,
    L.u6.z,
    L.u6.w,
    L.u7.xyz,
    L.u7.w,
    L.u8.x,
    L.u5.x
  );
  var hdr = sceneCol * atmos.w + atmos.xyz;

  // Apply ink outlines before final film grade so outlines sit inside the graded palette
  if (inkFactor > 0.001) {
    let inkCol = vec3f(0.04, 0.04, 0.07) * (0.5 + L.u15.w);
    hdr = mix(hdr, inkCol, inkFactor);
  }

  // 4. Bloom & halation gather + full Look grade
  let bloom = gatherBloom(uv, texel);
  let shaftLift = clamp(length(atmos.xyz) * 1.4, 0.0, 1.0);
  var graded = lookGradeColor(
    L,
    hdr,
    bloom,
    uv,
    o.pos.xy,
    F.options.x,
    shaftLift,
    0.18,
    0.88,
    0.25
  );

  // 5. Split indicator line in A/B Wipe mode
  if (compareMode == 2) {
    let line = 1.0 - smoothstep(texel.x * 1.2, texel.x * 2.8, abs(uv.x - wipeSplit));
    graded = mix(graded, vec3f(0.92, 0.96, 1.0), line * 0.85);
  }

  return vec4f(graded, 1.0);
}
`

type VertexSink = number[]

function pushTri(
  out: VertexSink,
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  c: readonly [number, number, number],
  n: readonly [number, number, number],
  col: readonly [number, number, number],
  matKind: number,
) {
  for (const p of [a, b, c]) {
    out.push(p[0], p[1], p[2], n[0], n[1], n[2], col[0], col[1], col[2], matKind)
  }
}

function pushQuad(
  out: VertexSink,
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  c: readonly [number, number, number],
  d: readonly [number, number, number],
  n: readonly [number, number, number],
  col: readonly [number, number, number],
  matKind: number,
) {
  pushTri(out, a, b, c, n, col, matKind)
  pushTri(out, a, c, d, n, col, matKind)
}

function pushBox(
  out: VertexSink,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  col: readonly [number, number, number],
  matKind: number,
) {
  pushQuad(out, [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0], col, matKind)
  pushQuad(out, [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0], [-1, 0, 0], col, matKind)
  pushQuad(out, [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], [1, 0, 0], col, matKind)
  pushQuad(out, [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [x0, y0, z1], [0, 0, 1], col, matKind)
  pushQuad(out, [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [0, 0, -1], col, matKind)
}

function pushSphere(
  out: VertexSink,
  cx: number,
  cy: number,
  cz: number,
  radius: number,
  col: readonly [number, number, number],
  matKind: number,
  rings = 20,
  segments = 32,
) {
  for (let r = 0; r < rings; r++) {
    const th0 = (r / rings) * Math.PI
    const th1 = ((r + 1) / rings) * Math.PI
    for (let s = 0; s < segments; s++) {
      const u0 = (s / segments) * Math.PI * 2
      const u1 = ((s + 1) / segments) * Math.PI * 2
      const pt = (th: number, u: number): [[number, number, number], [number, number, number]] => {
        const nx = Math.sin(th) * Math.cos(u)
        const ny = Math.cos(th)
        const nz = Math.sin(th) * Math.sin(u)
        return [
          [cx + nx * radius, cy + ny * radius, cz + nz * radius],
          [nx, ny, nz],
        ]
      }
      const [p00, n00] = pt(th0, u0)
      const [p10, n10] = pt(th0, u1)
      const [p11, n11] = pt(th1, u1)
      const [p01, n01] = pt(th1, u0)
      for (const [p, nm] of [
        [p00, n00],
        [p11, n11],
        [p10, n10],
        [p00, n00],
        [p01, n01],
        [p11, n11],
      ] as const) {
        out.push(p[0], p[1], p[2], nm[0], nm[1], nm[2], col[0], col[1], col[2], matKind)
      }
    }
  }
}

function pushCylinder(
  out: VertexSink,
  cx: number,
  y0: number,
  y1: number,
  cz: number,
  radius: number,
  col: readonly [number, number, number],
  matKind: number,
  segments = 16,
) {
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2
    const a1 = ((i + 1) / segments) * Math.PI * 2
    const nx0 = Math.cos(a0)
    const nz0 = Math.sin(a0)
    const nx1 = Math.cos(a1)
    const nz1 = Math.sin(a1)
    const nxm = Math.cos((a0 + a1) * 0.5)
    const nzm = Math.sin((a0 + a1) * 0.5)
    pushQuad(
      out,
      [cx + nx0 * radius, y0, cz + nz0 * radius],
      [cx + nx1 * radius, y0, cz + nz1 * radius],
      [cx + nx1 * radius, y1, cz + nz1 * radius],
      [cx + nx0 * radius, y1, cz + nz0 * radius],
      [nxm, 0, nzm],
      col,
      matKind,
    )
    pushTri(
      out,
      [cx, y1, cz],
      [cx + nx1 * radius, y1, cz + nz1 * radius],
      [cx + nx0 * radius, y1, cz + nz0 * radius],
      [0, 1, 0],
      col,
      matKind,
    )
  }
}

/**
 * Deliberate Look Debug Room:
 * - Elevated hardwood room with plaster walls & baseboard
 * - Clerestory window aperture with mullions/transom & volumetric light shaft
 * - Stacked calibration cubes & yard plinth cube
 * - Two calibration spheres (smooth semi-gloss & matte ceramic)
 * - Fluted architectural column at the threshold
 * - Four stone steps descending into the yard
 * - Two warm practical lamps (interior wall sconce & porch post lantern)
 * - Character silhouette (hat, head, coat/cape, planted boots)
 * - Grass patch strip with seeded 3D foliage tufts, cobblestone walk & asphalt apron
 */
export function buildLookDebugRoomMesh(roomSeed: number): Float32Array {
  const out: number[] = []

  // 1. Elevated interior hardwood room floor (wood_planks = 0)
  pushBox(out, -4.8, 0.0, -4.2, 1.2, 0.36, 0.8, [0.55, 0.43, 0.31], 0)

  // 2. Rear plaster wall & baseboard (plaster_wall = 2, trim = 10)
  pushBox(out, -4.82, 0.36, -4.25, 1.25, 2.85, -3.94, [0.44, 0.4, 0.33], 2)
  pushBox(out, -4.5, 0.36, -3.94, 1.22, 0.52, -3.89, [0.22, 0.19, 0.16], 10)

  // 3. Left plaster wall with window aperture (z in [-3.15, -0.95], y in [1.05, 2.42])
  pushBox(out, -4.82, 0.36, -4.25, -4.48, 1.05, 0.8, [0.43, 0.39, 0.32], 2)
  pushBox(out, -4.82, 2.42, -4.25, -4.48, 2.85, 0.8, [0.43, 0.39, 0.32], 2)
  pushBox(out, -4.82, 1.05, -4.25, -4.48, 2.42, -3.15, [0.43, 0.39, 0.32], 2)
  pushBox(out, -4.82, 1.05, -0.95, -4.48, 2.42, 0.8, [0.43, 0.39, 0.32], 2)
  // Window sill, mullion, transom & emissive glazing (15)
  pushBox(out, -4.85, 0.99, -3.22, -4.42, 1.06, -0.88, [0.26, 0.23, 0.19], 10)
  pushBox(out, -4.68, 1.05, -2.09, -4.52, 2.42, -2.01, [0.22, 0.2, 0.18], 10)
  pushBox(out, -4.68, 1.71, -3.15, -4.52, 1.77, -0.95, [0.22, 0.2, 0.18], 10)
  pushBox(out, -4.74, 1.06, -3.14, -4.66, 2.41, -0.96, [0.65, 0.78, 0.98], 15)

  // 4. Four stone steps leading from room threshold (y=0.36) down to yard walk (y=0.0)
  pushBox(out, -1.55, 0.0, 0.78, 1.05, 0.30, 1.12, [0.48, 0.46, 0.41], 1)
  pushBox(out, -1.55, 0.0, 1.12, 1.05, 0.22, 1.46, [0.47, 0.45, 0.4], 1)
  pushBox(out, -1.55, 0.0, 1.46, 1.05, 0.14, 1.80, [0.46, 0.44, 0.39], 1)
  pushBox(out, -1.55, 0.0, 1.80, 1.05, 0.07, 2.12, [0.45, 0.43, 0.38], 1)

  // 5. Architectural column at threshold (x=0.85, z=-1.85)
  pushBox(out, 0.50, 0.36, -2.20, 1.20, 0.54, -1.50, [0.46, 0.44, 0.39], 1)
  pushCylinder(out, 0.85, 0.54, 2.52, -1.85, 0.27, [0.5, 0.48, 0.43], 1, 14)
  pushBox(out, 0.48, 2.52, -2.22, 1.22, 2.74, -1.48, [0.46, 0.44, 0.39], 1)

  // 6. Calibration cubes (room stacked cubes + dark crate + yard plinth cube)
  pushBox(out, -3.45, 0.36, -2.85, -2.35, 1.46, -1.75, [0.48, 0.44, 0.37], 2)
  pushBox(out, -3.18, 1.46, -2.58, -2.48, 2.16, -1.88, [0.56, 0.45, 0.32], 0)
  pushBox(out, -1.65, 0.36, -3.35, -0.75, 1.16, -2.45, [0.26, 0.28, 0.31], 10)
  pushBox(out, 1.95, 0.0, -1.85, 3.05, 0.96, -0.75, [0.47, 0.45, 0.4], 1)

  // 7. Two calibration spheres (smooth semi-gloss 11 & matte ceramic 12)
  pushBox(out, -1.68, 0.36, -1.38, -0.62, 0.52, -0.32, [0.2, 0.22, 0.25], 10)
  pushSphere(out, -1.15, 1.24, -0.85, 0.72, [0.64, 0.62, 0.58], 11)
  pushSphere(out, 2.5, 1.5, -1.3, 0.56, [0.58, 0.53, 0.46], 12)

  // 8. Two warm practical lamps (sconce on rear wall + post lantern by steps)
  // Lamp 1: rear wall sconce
  pushBox(out, -3.92, 1.72, -3.94, -3.58, 1.96, -3.52, [0.18, 0.16, 0.15], 10)
  pushSphere(out, -3.75, 1.74, -3.45, 0.13, [1.0, 0.72, 0.38], 14, 10, 16)
  // Lamp 2: porch/yard post lantern
  pushBox(out, 1.32, 0.0, 1.02, 1.58, 0.22, 1.28, [0.16, 0.18, 0.2], 10)
  pushBox(out, 1.39, 0.22, 1.09, 1.51, 1.84, 1.21, [0.16, 0.18, 0.2], 10)
  pushBox(out, 1.28, 2.08, 0.98, 1.62, 2.18, 1.32, [0.16, 0.18, 0.2], 10)
  pushSphere(out, 1.45, 1.95, 1.15, 0.15, [1.0, 0.7, 0.35], 14, 10, 16)

  // 9. Character silhouette standing near the threshold & window shaft (matKind = 13)
  const cx = -0.35
  const cy = 0.36
  const cz = 0.15
  const charDark: [number, number, number] = [0.11, 0.13, 0.16]
  const charCoat: [number, number, number] = [0.14, 0.17, 0.21]
  // Planted boots & legs
  pushBox(out, cx - 0.18, cy, cz - 0.08, cx - 0.04, cy + 0.68, cz + 0.1, charDark, 13)
  pushBox(out, cx + 0.04, cy, cz - 0.12, cx + 0.18, cy + 0.68, cz + 0.06, charDark, 13)
  // Coat / torso / cape flare
  pushBox(out, cx - 0.26, cy + 0.56, cz - 0.16, cx + 0.26, cy + 1.36, cz + 0.14, charCoat, 13)
  pushBox(out, cx - 0.32, cy + 0.82, cz - 0.12, cx - 0.22, cy + 1.32, cz + 0.08, charCoat, 13)
  pushBox(out, cx + 0.22, cy + 0.82, cz - 0.12, cx + 0.32, cy + 1.32, cz + 0.08, charCoat, 13)
  // Head & brimmed hat silhouette
  pushSphere(out, cx, cy + 1.54, cz, 0.16, [0.22, 0.2, 0.19], 13, 12, 18)
  pushCylinder(out, cx, cy + 1.62, cy + 1.66, cz, 0.28, charDark, 13, 16)
  pushCylinder(out, cx, cy + 1.66, cy + 1.78, cz, 0.16, charDark, 13, 16)

  // 10. Yard surfaces: cobblestone walk (1), grass patch strips (4 + 5), and street asphalt (3)
  pushBox(out, -1.6, -0.04, 2.08, 1.15, 0.02, 3.35, [0.47, 0.45, 0.4], 1)
  pushBox(out, -4.8, -0.05, 0.8, -1.6, 0.01, 3.35, [0.34, 0.39, 0.26], 4)
  pushBox(out, 1.2, -0.05, -4.2, 4.8, 0.01, 3.35, [0.34, 0.39, 0.26], 4)
  pushBox(out, -4.8, -0.07, 3.35, 4.8, -0.01, 4.5, [0.24, 0.26, 0.28], 3)

  // Seeded 3D grass & shrub clusters along the yard strip and front garden bed
  const rightTufts = scatterClusteredGroundCover({
    seed: roomSeed,
    bounds: [1.45, -3.7, 4.45, 3.05],
    clusterCount: 7,
    tuftsPerCluster: 6,
    avoid: (x, z) => x > 1.75 && x < 3.25 && z > -2.05 && z < -0.55,
  })
  const leftTufts = scatterClusteredGroundCover({
    seed: roomSeed + 31,
    bounds: [-4.45, 1.15, -1.85, 3.05],
    clusterCount: 4,
    tuftsPerCluster: 5,
  })
  for (const t of [...rightTufts, ...leftTufts]) {
    const r = t.radius * 1.25
    const h = t.height * 1.65
    const top: [number, number, number] = [t.x, 0.01 + h, t.z]
    for (let i = 0; i < 4; i++) {
      const a0 = (i / 4) * Math.PI * 2 + 0.25
      const a1 = ((i + 1) / 4) * Math.PI * 2 + 0.25
      const p0: [number, number, number] = [t.x + Math.cos(a0) * r, 0.01 + h * 0.2, t.z + Math.sin(a0) * r]
      const p1: [number, number, number] = [t.x + Math.cos(a1) * r, 0.01 + h * 0.2, t.z + Math.sin(a1) * r]
      const nx = Math.cos((a0 + a1) * 0.5) * 0.45
      const nz = Math.sin((a0 + a1) * 0.5) * 0.45
      pushTri(out, top, p0, p1, [nx, 0.88, nz], t.tint, 5)
    }
  }

  return new Float32Array(out)
}

export type LookLabController = {
  section: LabSection
  getLookSettings: () => LookSettings
  applyPreset: (preset: LookPresetId) => LookSettings
  setParam: (key: string, value: number | string | boolean) => { key: string; before: unknown; value: unknown }
  randomizeGroup: (group?: LookGroup | "all", seed?: number) => { group: string; tuningSeed: number; roomSeed: number; settings: LookSettings }
  exportPresetJson: () => string
  importPresetJson: (raw: string | unknown) => { ok: true } | { ok: false; error: string }
}

export function createLooksSection(context: LabContext): LookLabController {
  const { device, stage } = context
  const lookState: LookSettings = createLookSettings("current")

  const settings: Record<string, string | number | boolean> = {
    preset: "current",
    compare: 1,
    wipeSplit: 0.5,
    roomSeed: 7,
    tuningSeed: 108,
  }

  for (const key of Object.keys(lookState) as (keyof LookSettings)[]) {
    if (key === "preset") continue
    Object.defineProperty(settings, key, {
      configurable: true,
      enumerable: true,
      get: () => lookState[key],
      set: (val: number | boolean) => {
        ;(lookState as Record<string, unknown>)[key] = val
      },
    })
  }
  Object.defineProperty(settings, "preset", {
    configurable: true,
    enumerable: true,
    get: () => lookState.preset,
    set: (val: string) => {
      const pid = resolveLookPresetId(val) ?? "current"
      lookState.preset = pid
    },
  })

  const frameBuffer = device.createBuffer({
    size: 148 * 4,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  const lookUniformData = new Float32Array(LOOK_UNIFORM_FLOATS)
  const lookUniformBuffer = device.createBuffer({
    size: lookUniformData.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })

  const sceneBindLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
    ],
  })
  const sceneBindGroup = device.createBindGroup({
    layout: sceneBindLayout,
    entries: [
      { binding: 0, resource: { buffer: frameBuffer } },
      { binding: 1, resource: { buffer: lookUniformBuffer } },
    ],
  })

  const sceneModule = device.createShaderModule({ code: lookRoomSceneShader, label: "Lab looks debug room scene" })
  const scenePipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [sceneBindLayout] }),
    vertex: {
      module: sceneModule,
      entryPoint: "vs",
      buffers: [
        {
          arrayStride: 40,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
            { shaderLocation: 1, offset: 12, format: "float32x3" },
            { shaderLocation: 2, offset: 24, format: "float32x3" },
            { shaderLocation: 3, offset: 36, format: "float32" },
          ],
        },
      ],
    },
    fragment: {
      module: sceneModule,
      entryPoint: "fs",
      targets: [{ format: "rgba16float" }],
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less-equal" },
    multisample: { count: 4 },
  })

  const normalDepthPipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [sceneBindLayout] }),
    vertex: {
      module: sceneModule,
      entryPoint: "vs",
      buffers: [
        {
          arrayStride: 40,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
            { shaderLocation: 1, offset: 12, format: "float32x3" },
            { shaderLocation: 2, offset: 24, format: "float32x3" },
            { shaderLocation: 3, offset: 36, format: "float32" },
          ],
        },
      ],
    },
    fragment: {
      module: sceneModule,
      entryPoint: "fsNormalDepth",
      targets: [{ format: "rgba16float" }],
    },
    primitive: { topology: "triangle-list", cullMode: "none" },
    depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less-equal" },
  })

  const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" })
  const postBindLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: {} },
    ],
  })
  const postModule = device.createShaderModule({ code: lookRoomPostShader, label: "Lab looks post composite" })
  const postPipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [postBindLayout] }),
    vertex: { module: postModule, entryPoint: "vs" },
    fragment: { module: postModule, entryPoint: "post", targets: [{ format: "rgba16float" }] },
    primitive: { topology: "triangle-list" },
  })

  let copyTex: GPUTexture | null = null
  let normalDepthTex: GPUTexture | null = null
  let normalDepthView: GPUTextureView | null = null
  let auxDepthTex: GPUTexture | null = null
  let auxDepthView: GPUTextureView | null = null
  let copyBindGroup: GPUBindGroup | null = null
  let copyW = 0
  let copyH = 0

  const ensureCopyTexture = (w: number, h: number) => {
    if (copyTex && copyW === w && copyH === h) return
    copyTex?.destroy()
    normalDepthTex?.destroy()
    auxDepthTex?.destroy()
    copyW = w
    copyH = h
    copyTex = device.createTexture({
      size: [w, h],
      format: "rgba16float",
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
    })
    normalDepthTex = device.createTexture({
      size: [w, h],
      format: "rgba16float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    })
    normalDepthView = normalDepthTex.createView()
    auxDepthTex = device.createTexture({
      size: [w, h],
      format: "depth24plus",
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    })
    auxDepthView = auxDepthTex.createView()
    copyBindGroup = device.createBindGroup({
      layout: postBindLayout,
      entries: [
        { binding: 0, resource: { buffer: frameBuffer } },
        { binding: 1, resource: { buffer: lookUniformBuffer } },
        { binding: 2, resource: copyTex.createView() },
        { binding: 3, resource: sampler },
        { binding: 4, resource: normalDepthView },
      ],
    })
  }

  let builtSeed = Number(settings.roomSeed)
  const createRoomBuffer = (seed: number) => {
    const verts = buildLookDebugRoomMesh(seed)
    const buf = device.createBuffer({
      size: Math.max(40, verts.byteLength),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    })
    device.queue.writeBuffer(buf, 0, verts.buffer, verts.byteOffset, verts.byteLength)
    return { buf, count: verts.length / 10 }
  }
  let roomMesh = createRoomBuffer(builtSeed)

  const rebuildRoomIfNeeded = () => {
    const nextSeed = Math.max(1, Math.min(999, Math.round(Number(settings.roomSeed) || 7)))
    if (nextSeed === builtSeed) return
    builtSeed = nextSeed
    roomMesh.buf.destroy()
    roomMesh = createRoomBuffer(builtSeed)
  }

  let savedStageGrade: { exposure: number; tone: number; saturation: number; temperature: number } | null = null
  let elapsed = 0

  const applyPreset = (presetId: LookPresetId): LookSettings => {
    applyLookPreset(lookState, presetId)
    context.sync()
    return lookState
  }

  const randomizeGroup = (group: LookGroup | "all" = "all", explicitSeed?: number) => {
    const seed = Math.max(1, Math.min(9999, Math.round(explicitSeed ?? (Number(settings.tuningSeed) || 108))))
    const next = randomizeLookSettings(lookState, seed, group)
    Object.assign(lookState, next)
    settings.tuningSeed = (seed % 9999) + 1
    context.sync()
    return {
      group,
      tuningSeed: seed,
      roomSeed: builtSeed,
      settings: { ...lookState },
    }
  }

  const setParam = (key: string, value: number | string | boolean) => {
    if (key === "preset") {
      const before = lookState.preset
      const pid = resolveLookPresetId(value)
      if (!pid) throw new Error(`Unknown look preset "${String(value)}". Valid presets: ${LOOK_PRESET_IDS.join(", ")}.`)
      applyPreset(pid)
      return { key: "preset", before, value: pid }
    }
    if (key === "compare") {
      const before = settings.compare
      const num = Number(value)
      settings.compare = num === 0 ? 0 : num === 2 ? 2 : 1
      context.sync()
      return { key: "compare", before, value: settings.compare }
    }
    if (key === "wipeSplit") {
      const before = settings.wipeSplit
      settings.wipeSplit = Math.max(0.05, Math.min(0.95, Number(value) || 0.5))
      context.sync()
      return { key: "wipeSplit", before, value: settings.wipeSplit }
    }
    if (key === "roomSeed") {
      const before = settings.roomSeed
      settings.roomSeed = Math.max(1, Math.min(999, Math.round(Number(value) || 7)))
      rebuildRoomIfNeeded()
      context.sync()
      return { key: "roomSeed", before, value: settings.roomSeed }
    }
    if (key === "tuningSeed") {
      const before = settings.tuningSeed
      settings.tuningSeed = Math.max(1, Math.min(9999, Math.round(Number(value) || 108)))
      context.sync()
      return { key: "tuningSeed", before, value: settings.tuningSeed }
    }
    if (!(key in lookState)) {
      throw new Error(`Unknown look parameter "${key}".`)
    }
    const before = (lookState as Record<string, unknown>)[key]
    if (key === "grainAnimated") {
      lookState.grainAnimated = Boolean(value)
    } else {
      const num = Number(value)
      if (!Number.isFinite(num)) throw new Error(`Parameter "${key}" requires a finite number.`)
      ;(lookState as Record<string, unknown>)[key] = num
    }
    context.sync()
    return { key, before, value: (lookState as Record<string, unknown>)[key] }
  }

  const controls: LabControl[] = [
    {
      key: "preset",
      label: "Style preset",
      group: "Debug Room",
      type: "select",
      options: LOOK_PRESET_IDS.map(id => ({ value: id, label: LOOK_PRESETS[id].label })),
      change: val => {
        const pid = resolveLookPresetId(val) ?? "current"
        applyPreset(pid)
      },
    },
    {
      key: "compare",
      label: "Comparison",
      group: "Debug Room",
      type: "select",
      options: [
        { value: 1, label: "Active look (After)" },
        { value: 0, label: "Current identity (Before)" },
        { value: 2, label: "A/B wipe vs Current" },
      ],
      change: () => context.sync(),
    },
    {
      key: "wipeSplit",
      label: "Wipe split",
      group: "Debug Room",
      type: "range",
      min: 0.05,
      max: 0.95,
      step: 0.01,
      unit: "",
      visible: s => Number(s.compare) === 2,
      change: () => context.sync(),
    },
    {
      key: "roomSeed",
      label: "Room seed",
      group: "Debug Room",
      type: "range",
      min: 1,
      max: 999,
      step: 1,
      unit: "",
      change: rebuildRoomIfNeeded,
    },
    {
      key: "tuningSeed",
      label: "Tuning seed",
      group: "Debug Room",
      type: "range",
      min: 1,
      max: 9999,
      step: 1,
      unit: "",
    },
    {
      key: "randomizeAll",
      label: "Randomize all look groups",
      group: "Debug Room",
      type: "action",
      run: () => {
        randomizeGroup("all")
      },
    },
    {
      key: "resetToCurrent",
      label: "Reset to Current (Identity)",
      group: "Debug Room",
      type: "action",
      run: () => {
        applyPreset("current")
      },
    },
    ...createLookControls(settings, {
      includePresetPicker: false,
      onChange: () => context.sync(),
      onRandomizeGroup: grp => {
        randomizeGroup(grp)
      },
    }),
  ]

  const roomObjects: readonly LabWorldObject[] = [
    { id: "specimen:character", label: "Character silhouette", category: "specimen", x: -0.35, y: 0.36, z: 0.15, radius: 0.7 },
    { id: "specimen:sphere-gloss", label: "Gloss calibration sphere", category: "specimen", x: -1.15, y: 1.24, z: -0.85, radius: 0.85 },
    { id: "specimen:sphere-matte", label: "Matte calibration sphere", category: "specimen", x: 2.5, y: 1.5, z: -1.3, radius: 0.75 },
    { id: "specimen:column", label: "Threshold column", category: "specimen", x: 0.85, y: 1.2, z: -1.85, radius: 0.7 },
    { id: "specimen:cubes", label: "Room cubes & window shaft", category: "specimen", x: -2.9, y: 1.0, z: -2.3, radius: 0.9 },
    { id: "specimen:grass", label: "Yard grass strip", category: "specimen", x: 2.8, y: 0.1, z: 1.2, radius: 1.1 },
  ]

  const section: LabSection = {
    id: "looks",
    label: "Looks",
    settings,
    controls,
    enter() {
      stage.sceneMode = 5
      savedStageGrade = {
        exposure: stage.lighting.exposure,
        tone: stage.lighting.tone,
        saturation: stage.lighting.saturation,
        temperature: stage.lighting.temperature,
      }
      stage.lighting.exposure = 0
      stage.lighting.tone = 2
      stage.lighting.saturation = 1
      stage.lighting.temperature = 0
      stage.frameTarget(-0.3, 0.85, -0.5, 11.2)
      stage.afterScene = (encoder, hdrTexture, _depthView, width, height) => {
        ensureCopyTexture(width, height)
        if (!copyTex || !copyBindGroup || !normalDepthView || !auxDepthView) return
        const ndPass = encoder.beginRenderPass({
          colorAttachments: [
            {
              view: normalDepthView,
              loadOp: "clear",
              storeOp: "store",
              clearValue: { r: 0.5, g: 1, b: 0.5, a: 0 },
            },
          ],
          depthStencilAttachment: {
            view: auxDepthView,
            depthLoadOp: "clear",
            depthStoreOp: "discard",
            depthClearValue: 1,
          },
        })
        ndPass.setPipeline(normalDepthPipeline)
        ndPass.setBindGroup(0, sceneBindGroup)
        ndPass.setVertexBuffer(0, roomMesh.buf)
        ndPass.draw(roomMesh.count)
        ndPass.end()

        encoder.copyTextureToTexture({ texture: hdrTexture }, { texture: copyTex }, [width, height])
        const pass = encoder.beginRenderPass({
          colorAttachments: [
            {
              view: hdrTexture.createView(),
              loadOp: "clear",
              storeOp: "store",
              clearValue: { r: 0, g: 0, b: 0, a: 1 },
            },
          ],
        })
        pass.setPipeline(postPipeline)
        pass.setBindGroup(0, copyBindGroup)
        pass.draw(3)
        pass.end()
      }
    },
    leave() {
      stage.afterScene = undefined
      if (savedStageGrade) {
        stage.lighting.exposure = savedStageGrade.exposure
        stage.lighting.tone = savedStageGrade.tone
        stage.lighting.saturation = savedStageGrade.saturation
        stage.lighting.temperature = savedStageGrade.temperature
        savedStageGrade = null
      }
    },
    update(dt) {
      elapsed += dt
    },
    retrigger() {
      rebuildRoomIfNeeded()
    },
    reroll() {
      settings.roomSeed = ((Number(settings.roomSeed) * 1664525 + 1013904223) >>> 0) % 999 + 1
      rebuildRoomIfNeeded()
      context.sync()
    },
    frameTarget: () => ({ x: -0.3, y: 0.85, z: -0.5, dist: 11.2 }),
    objects: () => roomObjects,
    prepare() {
      stage.sceneMode = 5
      stage.lighting.exposure = 0
      stage.lighting.tone = 2
      stage.lighting.saturation = 1
      stage.lighting.temperature = 0
      rebuildRoomIfNeeded()
      const cmp: LookCompareMode =
        Number(settings.compare) === 0 ? 0 : Number(settings.compare) === 2 ? 2 : 1
      packLookUniforms(lookState, lookUniformData, 0, {
        compareMode: cmp,
        wipeSplit: Number(settings.wipeSplit) || 0.5,
        forceActive: true,
      })
      device.queue.writeBuffer(lookUniformBuffer, 0, lookUniformData)
    },
    draw(pass) {
      const frame = (stage as unknown as { frame: Float32Array }).frame
      if (frame) {
        const copy = frame.slice()
        // Pass elapsed time in options.x and viewport width in options.y for screen-space wipe & grain
        copy[36] = elapsed
        copy[37] = Math.max(1, (stage as unknown as { width: number }).width || 1000)
        device.queue.writeBuffer(frameBuffer, 0, copy.buffer, copy.byteOffset, copy.byteLength)
      }
      pass.setPipeline(scenePipeline)
      pass.setBindGroup(0, sceneBindGroup)
      pass.setVertexBuffer(0, roomMesh.buf)
      pass.draw(roomMesh.count)
    },
    telemetry() {
      const def = LOOK_PRESETS[lookState.preset] ?? LOOK_PRESETS.current
      const cmp = Number(settings.compare) === 0 ? "Before" : Number(settings.compare) === 2 ? "A/B Wipe" : "After"
      return `Looks · ${def.label} (${cmp}) {"exposure":${lookState.exposure.toFixed(2)},"contrast":${lookState.contrast.toFixed(2)},"shaft":${lookState.shaftStrength.toFixed(2)},"fog":${lookState.fogDensity.toFixed(2)}}`
    },
  }

  return {
    section,
    getLookSettings: () => ({ ...lookState }),
    applyPreset,
    setParam,
    randomizeGroup: (group, seed) => {
      const resolved = typeof group === "string" ? resolveLookGroup(group) : "all"
      if (!resolved) {
        throw new Error(`Unknown look group "${String(group)}". Valid groups: all, ${LOOK_GROUPS.join(", ")}.`)
      }
      return randomizeGroup(resolved, seed)
    },
    exportPresetJson: () =>
      JSON.stringify(
        exportLookPreset(lookState, {
          tuningSeed: Number(settings.tuningSeed) || 108,
          roomSeed: builtSeed,
        }),
        null,
        2,
      ),
    importPresetJson: raw => {
      const res = importLookPreset(raw)
      if (!res.ok) return res
      Object.assign(lookState, res.value.settings)
      settings.tuningSeed = res.value.tuningSeed
      settings.roomSeed = res.value.roomSeed
      rebuildRoomIfNeeded()
      context.sync()
      return { ok: true }
    },
  }
}
export { isLookPresetId }
