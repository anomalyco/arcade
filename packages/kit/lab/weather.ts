import {
  SURFACE_TEX_UNIFORM_FLOATS,
  legacyMaterialComparisonWgsl,
  surfaceMaterialCoreWgsl,
} from "../gpu/surface-materials"
import type { LabControl } from "../lab-panel"
import { createFallbackMaterialTextureArray, createMaterialSampler } from "../textures/loader"
import {
  WEATHER_GROUPS,
  WEATHER_PRESETS,
  WEATHER_PRESET_IDS,
  WeatherRenderer,
  WeatherSimulation,
  applyWeatherPreset,
  createWeatherControls,
  createWeatherSettings,
  exportWeatherPreset,
  importWeatherPreset,
  isWeatherPresetId,
  randomizeWeatherSettings,
  resolveWeatherGroup,
  resolveWeatherPresetId,
  weatherSurfaceDeclarationsWgsl,
  type WeatherEave,
  type WeatherExcludeRect,
  type WeatherGroup,
  type WeatherLight,
  type WeatherPresetId,
  type WeatherSettings,
} from "../weather"
import { buildLookDebugRoomMesh } from "./looks-room"
import { frameShader } from "./stage-shader"
import type { LabContext, LabSection, LabWorldObject } from "./types"

export type WeatherEnvironmentId = "outbreak_street" | "getaway_alley" | "blackout_bay"

const WEATHER_STAGE_UNIFORM_FLOATS = 32

const weatherStageSceneShader =
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
  weatherSurfaceDeclarationsWgsl +
  /* wgsl */ `
struct WeatherStageUniforms {
  // u0: wetness, puddleCoverage, rippleIntensity, snowAmount
  u0: vec4f,
  // u1: flash, mist, windX, windZ
  u1: vec4f,
  // u2: compareMode, wipeSplit, flashlightOn, streetlampOn
  u2: vec4f,
  // u3: envMode (0=outbreak, 1=getaway, 2=blackout), time, skyScale, sunScale
  u3: vec4f,
  // u4: torchPos (xyz), torchRange
  u4: vec4f,
  // u5: torchAim (xyz), torchCosHalf
  u5: vec4f,
  // u6: streetlampPos (xyz), streetlampRadius
  u6: vec4f,
  // u7: streetlampCol (rgb), streetlampPower
  u7: vec4f,
}

@group(0) @binding(1) var<uniform> WS: WeatherStageUniforms;

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
  var world = v.pos;
  let rawKind = i32(round(v.matKind));
  // Subtle wind sway on yard foliage tufts (matKind == 5)
  if (rawKind == 5 && world.y > 0.05) {
    let t = WS.u3.y;
    let sway = sin(t * 2.4 + world.x * 1.7 + world.z * 1.3) * 0.045 * clamp(world.y, 0.0, 0.8);
    world.x += WS.u1.z * sway;
    world.z += WS.u1.w * sway;
  }
  o.world = world;
  o.pos = F.vp * vec4f(world, 1.0);
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
  RoomBox(vec3f(-4.82, 0.0, -4.25), vec3f(-4.48, 1.05, 0.85)),
  RoomBox(vec3f(-4.82, 2.42, -4.25), vec3f(-4.48, 2.95, 0.85)),
  RoomBox(vec3f(-4.82, 0.0, -4.25), vec3f(1.25, 2.95, -3.94)),
  RoomBox(vec3f(-3.45, 0.36, -2.85), vec3f(-2.35, 1.46, -1.75)),
  RoomBox(vec3f(-3.18, 1.46, -2.58), vec3f(-2.48, 2.16, -1.88)),
  RoomBox(vec3f(0.56, 0.0, -2.14), vec3f(1.14, 2.72, -1.56)),
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
  vis = min(vis, segSphereVis(p, dir, maxDist, vec3f(-1.15, 1.24, -0.85), 0.70));
  vis = min(vis, segSphereVis(p, dir, maxDist, vec3f(2.50, 1.50, -1.30), 0.54));
  vis = min(vis, segSphereVis(p, dir, maxDist, vec3f(-0.35, 1.15, 0.15), 0.36));
  return vis;
}

@fragment fn fs(o: VOut) -> @location(0) vec4f {
  surfaceFootprint = max(length(dpdx(o.world)), length(dpdy(o.world)));
  surfaceTime = WS.u3.y;
  var n = normalize(o.normal);
  let V = normalize(F.eye.xyz - o.world);
  let rawKind = i32(round(o.matKind));

  let screenUvX = o.pos.x / max(1.0, F.options.y);
  let compareMode = i32(round(WS.u2.x));
  let wipeSplit = WS.u2.y;
  let useWeather = select(compareMode == 1, screenUvX >= wipeSplit, compareMode == 2);

  let wetness = select(0.0, WS.u0.x, useWeather);
  let puddleCov = select(0.0, WS.u0.y, useWeather);
  let rippleStr = select(0.0, WS.u0.z, useWeather);
  let snowAmt = select(0.0, WS.u0.w, useWeather);
  let flash = select(0.0, WS.u1.x, useWeather);
  let mist = select(0.0, WS.u1.y, useWeather);
  let flashlightOn = WS.u2.z > 0.5;
  let streetlampOn = WS.u2.w > 0.5;

  // Emissive window glass (15) and practical lamp bulbs (14)
  if (rawKind == 15) {
    return vec4f(vec3f(0.45, 0.62, 0.95) * (1.25 + flash * 2.5), 1.0);
  }
  if (rawKind == 14) {
    return vec4f(vec3f(1.0, 0.58, 0.22) * 3.4, 1.0);
  }

  let evalWorld = select(
    vec3f(o.world.x + o.world.z * 0.35, o.world.y, o.world.y + o.world.z * 0.25),
    o.world,
    abs(n.y) > 0.52
  );
  let baseLinear = pow(max(o.color, vec3f(0.015)), vec3f(2.2));

  var sample: SurfaceSample;
  if (rawKind >= 0 && rawKind <= 5) {
    sample = evalRecipeById(rawKind, evalWorld, n, baseLinear, defaultMaterialRecipe(rawKind));
  } else if (rawKind == 11) {
    sample = SurfaceSample(baseLinear, vec2f(78.0, 0.48), 0.22, 1.0);
  } else if (rawKind == 12) {
    sample = SurfaceSample(baseLinear, vec2f(14.0, 0.08), 0.78, 1.0);
  } else if (rawKind == 13) {
    sample = SurfaceSample(baseLinear, vec2f(22.0, 0.16), 0.68, 1.0);
  } else {
    sample = SurfaceSample(baseLinear, vec2f(24.0, 0.15), 0.66, 1.0);
  }

  // Exclude indoor elevated room floor (x in [-4.8, 1.2], z in [-4.2, 0.75]) from outdoor rain puddles/snow
  let inIndoorRoom = o.world.x > -4.75 && o.world.x < 1.15 && o.world.z > -4.15 && o.world.z < 0.72 && o.world.y < 2.65;
  let outdoorWeight = select(1.0, 0.18, inIndoorRoom);
  let effWet = wetness * outdoorWeight;
  var puddleMask = 0.0;
  var rippleN = vec2f(0.0);

  if (effWet > 0.001 && n.y > 0.65 && (rawKind == 0 || rawKind == 1 || rawKind == 3 || rawKind == 4)) {
    puddleMask = evalWeatherPuddleMask(o.world.xz, puddleCov * outdoorWeight);
    let wetFactor = clamp(effWet * 0.65 + puddleMask * 0.65, 0.0, 1.0);
    // Porous darkening of wet stone, cobblestone, and asphalt
    sample.albedo *= 1.0 - 0.34 * wetFactor;
    sample.gloss = mix(sample.gloss, vec2f(140.0, 1.35), wetFactor);
    if (puddleMask > 0.08 && rippleStr > 0.01) {
      rippleN = evalWeatherPuddleRipple(o.world.xz, WS.u3.y, rippleStr * puddleMask, surfaceFootprint);
      n = normalize(vec3f(n.x + rippleN.x, n.y, n.z + rippleN.y));
    }
  }

  // Snow / frost accumulation on outdoor upward-facing surfaces
  if (snowAmt > 0.01 && !inIndoorRoom && n.y > 0.48) {
    let snowNoise = weatherNoise2(o.world.xz * 1.35 + vec2f(4.2, 1.9));
    let snowCover = clamp((n.y - 0.45) * 1.9 * snowAmt * (0.65 + 0.55 * snowNoise), 0.0, 0.92);
    let sparkle = step(0.94, weatherHash2(floor(o.world.xz * 28.0))) * 0.35 * snowCover;
    sample.albedo = mix(sample.albedo, vec3f(0.72, 0.80, 0.92) + sparkle, snowCover);
    sample.gloss = mix(sample.gloss, vec2f(36.0, 0.32), snowCover);
  }

  // 1. Night sky ambient + lightning flash
  let hemi = 0.35 + 0.65 * clamp(n.y * 0.5 + 0.5, 0.0, 1.0);
  let skyCol = vec3f(0.014, 0.022, 0.042) * WS.u3.z + vec3f(0.24, 0.30, 0.44) * flash;
  var diff = skyCol * hemi * sample.cavity;
  var spec = vec3f(0.0);

  // 2. Directional moonlight + lightning stroke
  let moonDir = normalize(vec3f(-0.62, 0.58, -0.52));
  let moonNdl = max(0.0, dot(n, moonDir));
  if (moonNdl > 0.001) {
    let mVis = roomShadowVis(o.world + n * 0.02, moonDir, 12.0);
    let moonCol = vec3f(0.11, 0.16, 0.28) * WS.u3.w + vec3f(0.65, 0.78, 1.05) * flash;
    diff += moonCol * moonNdl * mVis * sample.cavity;
    if (sample.gloss.x > 0.0) {
      let h = normalize(moonDir + V);
      let s = pow(max(0.0, dot(n, h)), sample.gloss.x) * (sample.gloss.x + 2.0) * 0.006;
      spec += moonCol * s * sample.gloss.y * mVis;
    }
  }

  // 3. Survivor flashlight cone cutting across the steps, cobblestone walk & wet asphalt street
  if (flashlightOn) {
    let torchPos = WS.u4.xyz;
    let torchRange = WS.u4.w;
    let torchAim = WS.u5.xyz;
    let toTorch = torchPos - o.world;
    let td = length(toTorch);
    if (td > 0.15 && td < torchRange) {
      let tdir = toTorch / td;
      let cosAng = dot(-tdir, torchAim);
      let cone = pow(smoothstep(WS.u5.w - 0.04, 0.992, cosAng), 1.45);
      let fade = pow(max(0.0, 1.0 - td / torchRange), 1.3);
      let vis = roomShadowVis(o.world + n * 0.02, tdir, td - 0.15);
      let tndl = max(0.0, (dot(n, tdir) + 0.18) / 1.18);
      let torchIntensity = 3.2 * cone * fade * vis;
      let torchCol = vec3f(0.96, 0.92, 0.84);
      diff += torchCol * torchIntensity * (0.18 + 0.82 * tndl);
      if (sample.gloss.x > 0.0) {
        let h = normalize(tdir + V);
        let s = pow(max(0.0, dot(n, h)), sample.gloss.x) * (sample.gloss.x + 2.0) * 0.011;
        spec += torchCol * torchIntensity * s * sample.gloss.y * 1.45;
      }
      if (effWet > 0.05 && n.y > 0.75) {
        spec += evalWeatherWetMirrorStreak(
          o.world,
          rippleN,
          F.eye.xyz,
          torchPos,
          torchCol,
          2.2 * cone * fade,
          mix(0.38, 0.18, puddleMask),
          vis
        ) * (0.45 + 0.75 * puddleMask) * effWet;
      }
    }
  }

  // 4. Practical lamps: interior sconce, threshold post lantern, and 2100K sodium streetlamp over the road
  let lampPos = array<vec3f, 3>(
    vec3f(-3.75, 1.82, -3.42),
    vec3f(1.45, 1.98, 1.15),
    WS.u6.xyz
  );
  let lampCol = array<vec3f, 3>(
    vec3f(1.05, 0.62, 0.26),
    vec3f(1.02, 0.58, 0.22),
    WS.u7.xyz
  );
  let lampRad = array<f32, 3>(4.6, 5.6, WS.u6.w);
  let lampPow = array<f32, 3>(1.65, 2.15, select(0.0, WS.u7.w, streetlampOn));

  for (var i = 0; i < 3; i++) {
    let lpos = lampPos[i];
    let power = lampPow[i];
    let rad = lampRad[i];
    let delta = lpos - o.world;
    let dist = length(delta);
    if (dist >= rad || power <= 0.001) { continue; }
    let ldir = delta / max(dist, 0.001);
    let x = dist / rad;
    let win = (1.0 - x * x) * (1.0 - x * x);
    let atten = power * win / (1.0 + dist * dist * 0.42);
    let vis = 0.04 + 0.96 * roomShadowVis(o.world + n * 0.02, ldir, dist - 0.18);
    let lcol = lampCol[i];
    let ndl = max(0.0, (dot(n, ldir) + 0.15) / 1.15);
    diff += lcol * atten * ndl * vis;
    if (sample.gloss.x > 0.0) {
      let h = normalize(ldir + V);
      let s = pow(max(0.0, dot(n, h)), sample.gloss.x) * (sample.gloss.x + 2.0) * 0.009;
      spec += lcol * atten * s * sample.gloss.y * vis;
      if (effWet > 0.05 && n.y > 0.78) {
        spec += evalWeatherWetMirrorStreak(
          o.world,
          rippleN,
          F.eye.xyz,
          lpos,
          lcol,
          power,
          mix(0.42, 0.20, puddleMask),
          vis
        ) * (0.42 + 0.85 * puddleMask) * effWet;
      }
    }
  }

  // 5. Grazing silhouette rim
  let ndv = clamp(dot(n, V), 0.0, 1.0);
  let rim = pow(1.0 - ndv, 2.6) * (0.18 + 0.35 * flash);
  let rimCol = vec3f(0.38, 0.52, 0.78) * rim;

  var color = sample.albedo * diff + spec + rimCol;

  // 6. Volumetric flashlight air cone + sodium streetlamp haze (boosted by mist & rain)
  let airDensity = 0.35 + 0.75 * mist + 0.45 * wetness;
  if (flashlightOn && o.world.y < 1.85) {
    let fOrig = WS.u4.xz;
    let fDir = normalize(WS.u5.xz + vec2f(1e-4));
    let fSide = vec2f(-fDir.y, fDir.x);
    let rel = o.world.xz - fOrig;
    let along = dot(rel, fDir);
    let across = abs(dot(rel, fSide));
    let coneR = 0.14 + max(0.0, along) * 0.32;
    if (along > -0.1 && along < WS.u4.w && across < coneR * 1.35) {
      let radial = exp(-pow(across / (coneR * 0.68), 2.0));
      let axial = smoothstep(-0.05, 0.25, along) * pow(clamp(1.0 - along / WS.u4.w, 0.0, 1.0), 1.35);
      color += vec3f(0.88, 0.86, 0.78) * (radial * axial * 0.22 * airDensity);
    }
  }
  if (streetlampOn && !inIndoorRoom) {
    let dLamp = length(o.world.xz - WS.u6.xz);
    let lampAir = exp(-(dLamp * dLamp) / 14.0) * smoothstep(3.6, 0.0, o.world.y);
    color += WS.u7.xyz * (lampAir * 0.16 * airDensity);
  }

  // 7. Split indicator line in A/B Wipe mode
  if (compareMode == 2) {
    let line = 1.0 - smoothstep(1.2, 2.8, abs(o.pos.x - wipeSplit * max(1.0, F.options.y)));
    color = mix(color, vec3f(0.9, 0.96, 1.0), line * 0.85);
  }

  if (F.options.z == 3.0) {
    color = diff + spec;
  } else if (F.options.z == 5.0) {
    color = n * 0.5 + 0.5;
  }
  return vec4f(color, 1.0);
}
`

function buildWeatherStageMesh(roomSeed: number): Float32Array {
  const base = Array.from(buildLookDebugRoomMesh(roomSeed))
  const pushTri = (
    a: readonly [number, number, number],
    b: readonly [number, number, number],
    c: readonly [number, number, number],
    n: readonly [number, number, number],
    col: readonly [number, number, number],
    matKind: number,
  ) => {
    for (const p of [a, b, c]) {
      base.push(p[0], p[1], p[2], n[0], n[1], n[2], col[0], col[1], col[2], matKind)
    }
  }
  const pushQuad = (
    a: readonly [number, number, number],
    b: readonly [number, number, number],
    c: readonly [number, number, number],
    d: readonly [number, number, number],
    n: readonly [number, number, number],
    col: readonly [number, number, number],
    matKind: number,
  ) => {
    pushTri(a, b, c, n, col, matKind)
    pushTri(a, c, d, n, col, matKind)
  }
  const pushBox = (
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    col: readonly [number, number, number],
    matKind: number,
  ) => {
    pushQuad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0], col, matKind)
    pushQuad([x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0], [-1, 0, 0], col, matKind)
    pushQuad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], [1, 0, 0], col, matKind)
    pushQuad([x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [x0, y0, z1], [0, 0, 1], col, matKind)
    pushQuad([x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [0, 0, -1], col, matKind)
  }

  // Wider wet asphalt street apron in front of the house steps (z = 2.8..6.2)
  pushBox(-5.6, -0.06, 2.85, 5.6, 0.0, 6.2, [0.22, 0.24, 0.27], 3)
  // Concrete curb along z = 2.82
  pushBox(-5.6, 0.0, 2.72, 5.6, 0.06, 2.88, [0.46, 0.45, 0.42], 1)
  // Roof eave fascia ledge along the front threshold (z = 0.72..0.96, y = 2.68..2.85) so eave drips have a physical overhang
  pushBox(-4.85, 2.68, 0.65, 1.28, 2.84, 0.96, [0.26, 0.23, 0.20], 10)
  // Cobra-head streetlamp pole + mast arm + glowing 2100K sodium luminaire at right curb (x = 3.35, z = 3.15, overhanging to x = 2.35, y = 3.75)
  pushBox(3.28, 0.0, 3.08, 3.42, 3.82, 3.22, [0.22, 0.25, 0.28], 10)
  pushBox(2.25, 3.74, 3.10, 3.38, 3.82, 3.20, [0.25, 0.28, 0.32], 10)
  pushBox(2.08, 3.68, 3.02, 2.46, 3.75, 3.28, [1.0, 0.62, 0.22], 14)

  return new Float32Array(base)
}

export type WeatherLabController = {
  section: LabSection
  getWeatherSettings: () => WeatherSettings
  applyPreset: (preset: WeatherPresetId) => WeatherSettings
  setParam: (key: string, value: number | string | boolean) => { key: string; before: unknown; value: unknown }
  randomizeGroup: (
    group?: WeatherGroup | "all",
    seed?: number,
  ) => { group: string; tuningSeed: number; roomSeed: number; settings: WeatherSettings }
  strikeNow: () => void
  exportPresetJson: () => string
  importPresetJson: (raw: string | unknown) => { ok: true } | { ok: false; error: string }
}

export function createWeatherSection(context: LabContext): WeatherLabController {
  const { device, stage } = context
  const weatherState: WeatherSettings = createWeatherSettings("rain")
  const sim = new WeatherSimulation(7)
  const weatherRenderer = new WeatherRenderer(device, "rgba16float", "depth24plus", 4, "less-equal")

  const settings: Record<string, string | number | boolean> = {
    preset: "rain",
    environment: "outbreak_street",
    flashlightOn: true,
    streetlampOn: true,
    compare: 1,
    wipeSplit: 0.5,
    roomSeed: 7,
    tuningSeed: 73,
    playing: true,
  }

  for (const key of Object.keys(weatherState) as (keyof WeatherSettings)[]) {
    if (key === "preset") continue
    Object.defineProperty(settings, key, {
      configurable: true,
      enumerable: true,
      get: () => weatherState[key],
      set: (val: number | boolean) => {
        ;(weatherState as Record<string, unknown>)[key] = val
      },
    })
  }
  Object.defineProperty(settings, "preset", {
    configurable: true,
    enumerable: true,
    get: () => weatherState.preset,
    set: (val: string) => {
      const pid = resolveWeatherPresetId(val) ?? "rain"
      weatherState.preset = pid
    },
  })

  const frameBuffer = device.createBuffer({
    size: 148 * 4,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  const stageUniformData = new Float32Array(WEATHER_STAGE_UNIFORM_FLOATS)
  const stageUniformBuffer = device.createBuffer({
    size: stageUniformData.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  const surfaceTexBuffer = device.createBuffer({
    size: SURFACE_TEX_UNIFORM_FLOATS * 4,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  const fallbackTex = createFallbackMaterialTextureArray(device)
  const materialSampler = createMaterialSampler(device)

  const sceneBindLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      { binding: 10, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: "2d-array" } },
      { binding: 11, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 12, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
    ],
  })
  const sceneBindGroup = device.createBindGroup({
    layout: sceneBindLayout,
    entries: [
      { binding: 0, resource: { buffer: frameBuffer } },
      { binding: 1, resource: { buffer: stageUniformBuffer } },
      { binding: 10, resource: fallbackTex.view },
      { binding: 11, resource: materialSampler },
      { binding: 12, resource: { buffer: surfaceTexBuffer } },
    ],
  })

  const sceneModule = device.createShaderModule({
    code: weatherStageSceneShader,
    label: "Lab weather stage scene",
  })
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

  let builtSeed = Number(settings.roomSeed) || 7
  const createRoomBuffer = (seed: number) => {
    const verts = buildWeatherStageMesh(seed)
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
    sim.seed = builtSeed
    roomMesh.buf.destroy()
    roomMesh = createRoomBuffer(builtSeed)
  }

  const stageEaves: readonly WeatherEave[] = [
    [-4.8, 0.92, 1.25, 0.92, 2.72],
    [-4.8, -4.15, -4.8, 0.92, 2.72],
  ]
  const stageExcludeRects: readonly WeatherExcludeRect[] = [[-4.75, -4.15, 1.15, 0.72]]

  const buildActiveWeatherLights = (): WeatherLight[] => {
    const env = String(settings.environment || "outbreak_street")
    const list: WeatherLight[] = [
      // Interior sconce & porch lantern
      { x: -3.75, y: 1.82, z: -3.42, radius: 4.8, r: 1.05, g: 0.62, b: 0.26, power: 1.5 },
      { x: 1.45, y: 1.98, z: 1.15, radius: 5.8, r: 1.02, g: 0.58, b: 0.22, power: 2.2 },
    ]
    if (settings.streetlampOn) {
      if (env === "getaway_alley") {
        list.push(
          { x: 2.25, y: 3.68, z: 3.15, radius: 8.5, r: 1.0, g: 0.22, b: 0.35, power: 3.1 },
          { x: -2.4, y: 2.8, z: 3.4, radius: 7.2, r: 0.18, g: 0.52, b: 1.1, power: 2.6 },
        )
      } else if (env === "blackout_bay") {
        list.push({ x: 2.25, y: 3.68, z: 3.15, radius: 9.0, r: 0.78, g: 0.92, b: 1.1, power: 3.2 })
      } else {
        // 2100K high-pressure sodium streetlamp over the road
        list.push({ x: 2.25, y: 3.68, z: 3.15, radius: 8.8, r: 1.05, g: 0.52, b: 0.12, power: 3.2 })
      }
    }
    if (settings.flashlightOn) {
      // Survivor flashlight cone cutting across the steps and wet street
      const aimX = 0.28
      const aimY = -0.26
      const aimZ = 0.92
      const lenXZ = Math.hypot(aimX, aimZ) || 1
      list.push({
        x: -0.22,
        y: 1.18,
        z: 0.22,
        radius: 7.6,
        r: 0.96,
        g: 0.94,
        b: 0.88,
        power: 3.6,
        dx: aimX / lenXZ,
        dz: aimZ / lenXZ,
        cosHalf: 0.85,
        isCone: true,
      })
      void aimY
    }
    return list
  }

  const applyPreset = (presetId: WeatherPresetId): WeatherSettings => {
    applyWeatherPreset(weatherState, presetId)
    context.sync()
    return weatherState
  }

  const randomizeGroup = (group: WeatherGroup | "all" = "all", explicitSeed?: number) => {
    const seed = Math.max(1, Math.min(9999, Math.round(explicitSeed ?? (Number(settings.tuningSeed) || 73))))
    const next = randomizeWeatherSettings(weatherState, seed, group)
    Object.assign(weatherState, next)
    settings.tuningSeed = (seed % 9999) + 1
    context.sync()
    return {
      group,
      tuningSeed: seed,
      roomSeed: builtSeed,
      settings: { ...weatherState },
    }
  }

  const setParam = (key: string, value: number | string | boolean) => {
    if (key === "preset") {
      const before = weatherState.preset
      const pid = resolveWeatherPresetId(value)
      if (!pid) {
        throw new Error(`Unknown weather preset "${String(value)}". Valid presets: ${WEATHER_PRESET_IDS.join(", ")}.`)
      }
      applyPreset(pid)
      return { key: "preset", before, value: pid }
    }
    if (key === "environment") {
      const before = settings.environment
      const s = String(value).trim().toLowerCase()
      const next: WeatherEnvironmentId =
        s.includes("getaway") || s.includes("alley")
          ? "getaway_alley"
          : s.includes("blackout") || s.includes("bay")
            ? "blackout_bay"
            : "outbreak_street"
      settings.environment = next
      context.sync()
      return { key: "environment", before, value: next }
    }
    if (key === "flashlightOn" || key === "streetlampOn" || key === "playing") {
      const before = settings[key]
      settings[key] = Boolean(value)
      context.sync()
      return { key, before, value: settings[key] }
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
      settings.tuningSeed = Math.max(1, Math.min(9999, Math.round(Number(value) || 73)))
      context.sync()
      return { key: "tuningSeed", before, value: settings.tuningSeed }
    }
    if (!(key in weatherState)) {
      throw new Error(`Unknown weather parameter "${key}".`)
    }
    const before = (weatherState as Record<string, unknown>)[key]
    if (key === "snowMode") {
      weatherState.snowMode = Boolean(value)
    } else {
      const num = Number(value)
      if (!Number.isFinite(num)) throw new Error(`Parameter "${key}" requires a finite number.`)
      ;(weatherState as Record<string, unknown>)[key] = num
    }
    context.sync()
    return { key, before, value: (weatherState as Record<string, unknown>)[key] }
  }

  const controls: LabControl[] = [
    {
      key: "preset",
      label: "Weather preset",
      group: "Weather Stage",
      type: "select",
      options: WEATHER_PRESET_IDS.map(id => ({ value: id, label: WEATHER_PRESETS[id].label })),
      change: val => {
        const pid = resolveWeatherPresetId(val) ?? "rain"
        applyPreset(pid)
      },
    },
    {
      key: "environment",
      label: "Test scene",
      group: "Weather Stage",
      type: "select",
      options: [
        { value: "outbreak_street", label: "Outbreak · Streetlamp & Flashlight" },
        { value: "getaway_alley", label: "Getaway · Neon Alley & Siren" },
        { value: "blackout_bay", label: "Blackout · Loading Bay & Spot" },
      ],
      change: () => context.sync(),
    },
    {
      key: "flashlightOn",
      label: "Flashlight beam",
      group: "Weather Stage",
      type: "toggle",
      change: () => context.sync(),
    },
    {
      key: "streetlampOn",
      label: "Overhead streetlamp",
      group: "Weather Stage",
      type: "toggle",
      change: () => context.sync(),
    },
    {
      key: "compare",
      label: "Comparison",
      group: "Weather Stage",
      type: "select",
      options: [
        { value: 1, label: "Active weather (After)" },
        { value: 0, label: "Clear dry baseline (Before)" },
        { value: 2, label: "A/B wipe vs Clear" },
      ],
      change: () => context.sync(),
    },
    {
      key: "wipeSplit",
      label: "Wipe split",
      group: "Weather Stage",
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
      group: "Weather Stage",
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
      group: "Weather Stage",
      type: "range",
      min: 1,
      max: 9999,
      step: 1,
      unit: "",
    },
    {
      key: "randomizeAll",
      label: "Randomize all weather groups",
      group: "Weather Stage",
      type: "action",
      run: () => {
        randomizeGroup("all")
      },
    },
    {
      key: "resetToRain",
      label: "Reset to Rain preset",
      group: "Weather Stage",
      type: "action",
      run: () => {
        applyPreset("rain")
      },
    },
    ...createWeatherControls(settings, {
      includePresetPicker: false,
      onChange: () => context.sync(),
      onRandomizeGroup: grp => {
        randomizeGroup(grp)
      },
      onTriggerLightning: () => {
        sim.strikeNow()
        context.sync()
      },
    }),
  ]

  const stageObjects: readonly LabWorldObject[] = [
    { id: "specimen:survivor-torch", label: "Survivor & flashlight cone", category: "specimen", x: -0.35, y: 0.36, z: 0.15, radius: 0.75 },
    { id: "light:streetlamp", label: "2100K Sodium streetlamp", category: "light", x: 2.25, y: 3.68, z: 3.15, radius: 0.9 },
    { id: "light:porch-lantern", label: "Porch post lantern", category: "light", x: 1.45, y: 1.98, z: 1.15, radius: 0.65 },
    { id: "specimen:wet-asphalt", label: "Wet asphalt puddle & ripples", category: "specimen", x: 0.6, y: 0.0, z: 3.6, radius: 1.2 },
    { id: "specimen:roof-eaves", label: "House roof eave drip line", category: "specimen", x: -1.5, y: 2.72, z: 0.92, radius: 1.0 },
  ]

  let savedStageGrade: { exposure: number; tone: number; saturation: number; temperature: number } | null = null

  const section: LabSection = {
    id: "weather",
    label: "Weather",
    settings,
    controls,
    library: {
      category: "effects",
      label: "Weather",
      tag: "Weather",
      items: () =>
        WEATHER_PRESET_IDS.map(pid => ({
          id: `preset-${pid}`,
          label: `${WEATHER_PRESETS[pid].label} weather`,
          tag: "Weather",
          group: "Weather Presets",
          select: () => {
            applyPreset(pid)
          },
          active: () => weatherState.preset === pid,
        })),
    },
    registerCommands(commands) {
      commands.registerAll([
        {
          id: "weather.preset",
          label: "Apply Weather Preset",
          shortLabel: "Weather Preset",
          category: "Preset",
          undoable: true,
          args: {
            preset: {
              type: "string",
              required: true,
              enum: [...WEATHER_PRESET_IDS],
              description: "Weather preset ID (clear, drizzle, rain, storm, fog, snow)",
            },
          },
          enabled: () => true,
          run: (_ctx, args) => {
            const raw = String(args?.preset ?? "rain")
            const pid = resolveWeatherPresetId(raw)
            if (!pid) {
              throw new Error(`Unknown weather preset "${raw}". Valid presets: ${WEATHER_PRESET_IDS.join(", ")}.`)
            }
            const next = applyPreset(pid)
            return { preset: pid, label: WEATHER_PRESETS[pid].label, settings: { ...next } }
          },
        },
        {
          id: "weather.set",
          label: "Set Weather Parameter",
          shortLabel: "Weather Set",
          category: "Inspector",
          undoable: true,
          args: {
            key: { type: "string", description: "Weather parameter key" },
            value: { type: "value", description: "Parameter value" },
          },
          enabled: () => true,
          run: (_ctx, args) => {
            if (typeof args?.key === "string" && args.key.trim() && args.value !== undefined) {
              return setParam(args.key.trim(), args.value as string | number | boolean)
            }
            const applied: Record<string, unknown> = {}
            for (const [k, v] of Object.entries(args ?? {})) {
              if (k !== "key" && k !== "value" && v !== undefined) {
                const res = setParam(k, v as string | number | boolean)
                applied[res.key] = res.value
              }
            }
            return { applied, settings: { ...weatherState } }
          },
        },
        {
          id: "weather.randomize",
          label: "Randomize Weather Parameters",
          shortLabel: "Weather Randomize",
          category: "Preset",
          undoable: true,
          args: {
            group: {
              type: "string",
              description: "Group to randomize (all, precipitation, splashes_wetness, wind_atmosphere)",
            },
            seed: {
              type: "number",
              min: 1,
              max: 9999,
              description: "Deterministic tuning seed (leaves roomSeed unchanged)",
            },
          },
          enabled: () => true,
          run: (ctx, args) => {
            const rawGroup = typeof args?.group === "string" ? args.group : "all"
            const resolved = resolveWeatherGroup(rawGroup)
            if (!resolved) {
              throw new Error(`Unknown weather group "${rawGroup}". Valid groups: all, ${WEATHER_GROUPS.join(", ")}.`)
            }
            const explicitSeed = typeof args?.seed === "number" ? args.seed : ctx?.seed
            return randomizeGroup(resolved, explicitSeed)
          },
        },
        {
          id: "weather.strike",
          label: "Trigger Lightning Strike",
          shortLabel: "Lightning Strike",
          category: "Scene",
          undoable: false,
          enabled: () => true,
          run: ctx => {
            const strike = sim.strikeNow(ctx?.seed)
            return { triggered: true, strike }
          },
        },
      ])
    },
    enter() {
      stage.sceneMode = 5
      savedStageGrade = {
        exposure: stage.lighting.exposure,
        tone: stage.lighting.tone,
        saturation: stage.lighting.saturation,
        temperature: stage.lighting.temperature,
      }
      stage.lighting.exposure = 0.05
      stage.lighting.tone = 1
      stage.lighting.saturation = 1.02
      stage.lighting.temperature = 0
      stage.frameTarget(0.2, 0.9, 1.4, 12.2)
      sim.step(1 / 60, weatherState, [stage.eye[0]!, stage.eye[1]!, stage.eye[2]!], [0.2, 1.4])
    },
    leave() {
      if (savedStageGrade) {
        stage.lighting.exposure = savedStageGrade.exposure
        stage.lighting.tone = savedStageGrade.tone
        stage.lighting.saturation = savedStageGrade.saturation
        stage.lighting.temperature = savedStageGrade.temperature
        savedStageGrade = null
      }
    },
    update(dt) {
      if (!settings.playing) return
      sim.step(dt, weatherState, [stage.eye[0]!, stage.eye[1]!, stage.eye[2]!], [0.2, 1.4])
    },
    retrigger() {
      sim.reset(builtSeed)
      sim.step(0.35, weatherState, [stage.eye[0]!, stage.eye[1]!, stage.eye[2]!], [0.2, 1.4])
    },
    reroll() {
      settings.roomSeed = (((Number(settings.roomSeed) * 1664525 + 1013904223) >>> 0) % 999) + 1
      rebuildRoomIfNeeded()
      context.sync()
    },
    frameTarget: () => ({ x: 0.2, y: 0.9, z: 1.4, dist: 12.2 }),
    objects: () => stageObjects,
    prepare() {
      stage.sceneMode = 5
      rebuildRoomIfNeeded()
      // Ensure simulation state reflects current settings even when paused or scrubbing sliders
      sim.step(0, weatherState, [stage.eye[0]!, stage.eye[1]!, stage.eye[2]!], [0.2, 1.4])

      const st = sim.state
      const cmp = Number(settings.compare) === 0 ? 0 : Number(settings.compare) === 2 ? 2 : 1
      const env = String(settings.environment || "outbreak_street")
      const envId = env === "getaway_alley" ? 1 : env === "blackout_bay" ? 2 : 0

      // Pack stage uniforms
      stageUniformData[0] = st.wetness
      stageUniformData[1] = st.puddleCoverage
      stageUniformData[2] = st.rippleIntensity
      stageUniformData[3] = st.snowAmount
      stageUniformData[4] = st.flash
      stageUniformData[5] = st.mist
      stageUniformData[6] = st.windX
      stageUniformData[7] = st.windZ
      stageUniformData[8] = cmp
      stageUniformData[9] = Number(settings.wipeSplit) || 0.5
      stageUniformData[10] = settings.flashlightOn ? 1 : 0
      stageUniformData[11] = settings.streetlampOn ? 1 : 0
      stageUniformData[12] = envId
      stageUniformData[13] = st.time
      stageUniformData[14] = st.skyScale
      stageUniformData[15] = st.sunScale
      // Torch pos & range
      stageUniformData[16] = -0.22
      stageUniformData[17] = 1.18
      stageUniformData[18] = 0.22
      stageUniformData[19] = 7.6
      // Torch aim & cosHalf
      const aimX = 0.28
      const aimY = -0.26
      const aimZ = 0.92
      const aimLen = Math.hypot(aimX, aimY, aimZ) || 1
      stageUniformData[20] = aimX / aimLen
      stageUniformData[21] = aimY / aimLen
      stageUniformData[22] = aimZ / aimLen
      stageUniformData[23] = 0.85
      // Streetlamp pos & radius
      stageUniformData[24] = 2.25
      stageUniformData[25] = 3.68
      stageUniformData[26] = 3.15
      stageUniformData[27] = 8.8
      // Streetlamp color & power
      if (env === "getaway_alley") {
        stageUniformData[28] = 1.05
        stageUniformData[29] = 0.26
        stageUniformData[30] = 0.42
        stageUniformData[31] = 2.9
      } else if (env === "blackout_bay") {
        stageUniformData[28] = 0.78
        stageUniformData[29] = 0.92
        stageUniformData[30] = 1.1
        stageUniformData[31] = 2.9
      } else {
        stageUniformData[28] = 1.05
        stageUniformData[29] = 0.52
        stageUniformData[30] = 0.12
        stageUniformData[31] = 2.9
      }
      device.queue.writeBuffer(stageUniformBuffer, 0, stageUniformData)

      const vpWidth = Math.max(1, (stage as unknown as { width: number }).width || 1000)
      const vpHeight = Math.max(1, (stage as unknown as { height: number }).height || 680)
      const effectiveSettings = cmp === 0 ? WEATHER_PRESETS.clear.settings : weatherState
      weatherRenderer.prepare({
        settings: effectiveSettings,
        state: st,
        viewProj: stage.viewProj,
        eye: stage.eye,
        focusXZ: [stage.focus[0]!, stage.focus[2]!],
        viewportWidth: vpWidth,
        viewportHeight: vpHeight,
        fovYRad: 0.65,
        groundY: 0,
        ambientLum: 0.25,
        lights: buildActiveWeatherLights(),
        excludeRects: stageExcludeRects,
        eaves: stageEaves,
        cameraDist: stage.camDist,
      })
    },
    draw(pass) {
      const frame = (stage as unknown as { frame: Float32Array }).frame
      if (frame) {
        const copy = frame.slice()
        copy[36] = sim.state.time
        copy[37] = Math.max(1, (stage as unknown as { width: number }).width || 1000)
        device.queue.writeBuffer(frameBuffer, 0, copy.buffer, copy.byteOffset, copy.byteLength)
      }
      pass.setPipeline(scenePipeline)
      pass.setBindGroup(0, sceneBindGroup)
      pass.setVertexBuffer(0, roomMesh.buf)
      pass.draw(roomMesh.count)

      if (Number(settings.compare) !== 0) {
        weatherRenderer.draw(pass, false)
      }
    },
    telemetry() {
      const def = WEATHER_PRESETS[weatherState.preset] ?? WEATHER_PRESETS.rain
      const drops = weatherRenderer.nearCount + weatherRenderer.farCount
      const splashes = weatherRenderer.splashCount + weatherRenderer.dripCount
      return `Weather · ${def.label} {"drops":${drops},"splashes":${splashes},"wetness":${sim.state.wetness.toFixed(2)},"litOnly":${weatherState.litOnly.toFixed(2)}}`
    },
  }

  return {
    section,
    getWeatherSettings: () => ({ ...weatherState }),
    applyPreset,
    setParam,
    randomizeGroup,
    strikeNow: () => {
      sim.strikeNow()
    },
    exportPresetJson: () =>
      JSON.stringify(
        exportWeatherPreset(weatherState, {
          tuningSeed: Number(settings.tuningSeed) || 73,
          roomSeed: builtSeed,
        }),
        null,
        2,
      ),
    importPresetJson: raw => {
      const res = importWeatherPreset(raw)
      if (!res.ok) return res
      Object.assign(weatherState, res.value.settings)
      settings.tuningSeed = res.value.tuningSeed
      settings.roomSeed = res.value.roomSeed
      rebuildRoomIfNeeded()
      context.sync()
      return { ok: true }
    },
  }
}

export { isWeatherPresetId }
