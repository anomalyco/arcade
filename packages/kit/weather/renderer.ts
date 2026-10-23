import { reactivePipelineDescriptor } from "../gpu/reactive"
import type { WeatherSettings } from "./settings"
import type { WeatherEave, WeatherExcludeRect, WeatherFrameState, WeatherLight } from "./state"
import type { RainLightingSettings } from "./rain-lighting"

export const MAX_WEATHER_LIGHTS = 12
export const MAX_WEATHER_EXCLUDES = 8
export const MAX_WEATHER_EAVES = 8
export const WEATHER_UNIFORM_FLOATS = 284

/** Hard instance budgets so even Storm preset stays well under 0.25 ms on Apple Silicon. */
const NEAR_BASE = 720
const NEAR_BOX = 24.0
const NEAR_HEIGHT = 11.0
const FAR_BASE = 480
const FAR_BOX = 42.0
const FAR_HEIGHT = 15.0
const SPLASH_BASE = 200
const SPLASH_BOX = 26.0
const SPLASH_PERIOD = 0.44
const DRIP_BASE = 56
const MIST_BASE = 8
const MIST_BOX = 28.0
const MAX_DENSITY_SCALE = 1.65

export type WeatherLodInfo = {
  tier: 0 | 1 | 2
  scale: number
  nearCount: number
  farCount: number
  splashCount: number
  dripCount: number
  mistCount: number
}

export function computeWeatherLod(
  settings: Readonly<WeatherSettings>,
  cameraDist = 34,
  hasEaves = false,
  viewportWidth = 1280,
): WeatherLodInfo {
  const intensity = Math.max(0, Math.min(1, settings.intensity))
  const density = Math.max(0, Math.min(3, settings.density))
  const distScale = cameraDist > 48 ? Math.max(0.55, 48 / cameraDist) : 1.0
  const hiDpiScale = viewportWidth > 2200 ? 0.34 : 1.0
  const effScale = distScale * hiDpiScale
  const rawAmount = Math.min(MAX_DENSITY_SCALE, intensity * density) * effScale
  const splashAmount = Math.min(MAX_DENSITY_SCALE, intensity * settings.splashRate) * effScale
  const mistAmount =
    viewportWidth > 2200
      ? 0
      : Math.max(0, Math.min(1.5, settings.mist * (0.35 + 0.65 * Math.max(intensity, 0.35))))
  const nearCount = Math.min(NEAR_BASE * MAX_DENSITY_SCALE, Math.ceil(NEAR_BASE * rawAmount))
  const farCount = Math.min(FAR_BASE * MAX_DENSITY_SCALE, Math.ceil(FAR_BASE * rawAmount))
  const splashCount = settings.snowMode
    ? 0
    : Math.min(SPLASH_BASE * MAX_DENSITY_SCALE, Math.ceil(SPLASH_BASE * splashAmount))
  const dripCount =
    settings.snowMode || !hasEaves
      ? 0
      : Math.min(DRIP_BASE * MAX_DENSITY_SCALE, Math.ceil(DRIP_BASE * splashAmount))
  const mistCount = Math.min(24, Math.ceil(MIST_BASE * mistAmount))
  const tier: 0 | 1 | 2 = effScale >= 0.85 ? 0 : effScale >= 0.55 ? 1 : 2
  return {
    tier,
    scale: effScale,
    nearCount,
    farCount,
    splashCount,
    dripCount,
    mistCount,
  }
}

export function makeWeatherShader(motionMrt = false): string {
  const outType = motionMrt ? "WeatherFragOut" : "@location(0) vec4f"
  const retStmt = (expr: string) =>
    motionMrt ? `return WeatherFragOut(${expr}, vec4f(0.0, 0.0, 1000.0, 0.0));` : `return ${expr};`

  return /* wgsl */ `
${motionMrt ? "struct WeatherFragOut { @location(0) color: vec4f, @location(1) velocity: vec4f }" : ""}

struct WeatherUniforms {
  viewProj: mat4x4f,
  eyeTime: vec4f,       // eye.xyz, time
  anchor: vec4f,        // focusX, groundY, focusZ, unused
  viewportFocal: vec4f, // width, height, focalPx, groundY
  offNear: vec4f,       // wrapped drift - anchor (xyz), NEAR_BOX
  offFar: vec4f,        // wrapped drift - anchor (xyz), FAR_BOX
  velExposure: vec4f,   // relative drop velocity (xyz), exposure (s)
  windGust: vec4f,      // windX, windZ, windSpeedMs, gust
  counts: vec4f,        // nearCap, nearAmount, farAmount, splashAmount
  counts2: vec4f,       // dripAmount, mistAmount, lightCount, excludeCount
  shape: vec4f,         // dropWidthM, minPx, splashSizeM, snowMode (0 or 1)
  lighting: vec4f,      // litOnly, flash, ambientLum, eaveCount
  baseColor: vec4f,     // rgb, nearAlpha
  splashColor: vec4f,   // rgb, splashAlpha
  lightsPos: array<vec4f, ${MAX_WEATHER_LIGHTS}>,
  lightsCol: array<vec4f, ${MAX_WEATHER_LIGHTS}>,
  lightsCone: array<vec4f, ${MAX_WEATHER_LIGHTS}>,
  excludeRects: array<vec4f, ${MAX_WEATHER_EXCLUDES}>,
  eaveSegs: array<vec4f, ${MAX_WEATHER_EAVES}>,
  eaveHeights: array<vec4f, 2>,
}

@group(0) @binding(0) var<uniform> W: WeatherUniforms;

fn rand3(s: vec3u) -> vec3f {
  var v = s * 1664525u + 1013904223u;
  v.x += v.y * v.z;
  v.y += v.z * v.x;
  v.z += v.x * v.y;
  v ^= v >> vec3u(16u);
  v.x += v.y * v.z;
  v.y += v.z * v.x;
  v.z += v.x * v.y;
  return vec3f(v) * (1.0 / 4294967296.0);
}

fn wrapBox3(p: vec3f, boxXZ: f32, boxY: f32) -> vec3f {
  let b = vec3f(boxXZ, boxY, boxXZ);
  return p - b * floor(p / b) - vec3f(0.5 * boxXZ, 0.0, 0.5 * boxXZ);
}

fn isExcludedInterior(xz: vec2f) -> bool {
  let n = i32(W.counts2.w);
  for (var i = 0; i < ${MAX_WEATHER_EXCLUDES}; i++) {
    if (i >= n) { break; }
    let r = W.excludeRects[i];
    if (xz.x > r.x + 0.15 && xz.x < r.z - 0.15 && xz.y > r.y + 0.15 && xz.y < r.w - 0.15) {
      return true;
    }
  }
  return false;
}

/**
 * Evaluates scene point lights & spotlight cones (streetlamps, porch lamps, windows, flashlight)
 * at world point p, returning HDR light radiance reaching the droplet/splash/mist.
 */
fn evalWeatherLightAt(world: vec3f) -> vec3f {
  var sum = vec3f(0.0);
  let nLights = i32(W.counts2.z);
  let V = normalize(W.eyeTime.xyz - world + vec3f(1e-4));
  for (var i = 0; i < ${MAX_WEATHER_LIGHTS}; i++) {
    if (i >= nLights) { break; }
    let lp = W.lightsPos[i];
    let lc = W.lightsCol[i];
    let lcone = W.lightsCone[i];
    let dv = world.xz - lp.xz;
    let dPlan2 = dot(dv, dv);
    let r = lp.w;
    if (dPlan2 >= r * r || lc.w <= 0.001) { continue; }
    let d3Vec = lp.xyz - world;
    let d3 = max(length(d3Vec), 0.25);
    let x = sqrt(dPlan2) / max(r, 0.1);
    let win = (1.0 - x * x) * (1.0 - x * x);
    var att = lc.w * win / (1.0 + d3 * d3 * 0.22);
    if (W.anchor.w > 0.5) {
      if (lcone.w >= -1.0) {
        let c = dot(-d3Vec / d3, lcone.xyz);
        att *= smoothstep(lcone.w, min(0.999, lcone.w + 0.15), c) * 2.85;
      }
    } else if (lcone.w > 0.5 && dPlan2 > 1e-4) {
      let dirXZ = dv / sqrt(dPlan2);
      let c = dot(dirXZ, lcone.xy);
      let coneFeather = smoothstep(lcone.z - 0.08, min(0.998, lcone.z + 0.12), c);
      let heightGate = 1.0 - smoothstep(2.4, 5.2, abs(world.y - lp.y));
      att *= coneFeather * heightGate * 2.85;
    } else {
      let underLamp = smoothstep(lp.y + 1.8, lp.y - 0.5, world.y);
      att *= 0.42 + 0.58 * underLamp;
    }
    if (att <= 0.001) { continue; }
    let ldir = d3Vec / d3;
    let scatter = 0.85 + 0.95 * pow(max(0.0, dot(V, -ldir)), 2.0);
    sum += lc.rgb * (att * scatter);
  }
  return sum;
}

struct StreakOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec3f,
  @location(2) alpha: f32,
}

@vertex fn streakVs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> StreakOut {
  var o: StreakOut;
  o.pos = vec4f(0.0, 0.0, -2.0, 1.0);
  o.uv = vec2f(0.0);
  o.color = vec3f(0.0);
  o.alpha = 0.0;

  let nearCap = u32(W.counts.x);
  let isFar = ii >= nearCap;
  let local = select(ii, ii - nearCap, isFar);
  let amount = select(W.counts.y, W.counts.z, isFar);
  let fade = saturate(amount - f32(local));
  if (fade <= 0.0) { return o; }

  let boxXZ = select(W.offNear.w, W.offFar.w, isFar);
  let boxY = select(${NEAR_HEIGHT}.0, ${FAR_HEIGHT}.0, isFar);
  let off = select(W.offNear.xyz, W.offFar.xyz, isFar);
  let h = rand3(vec3u(local, select(11u, 23u, isFar), 0x5eedu));
  var rel = wrapBox3(h * vec3f(boxXZ, boxY, boxXZ) + off, boxXZ, boxY);

  let isSnow = W.shape.w > 0.5;
  let t = W.eyeTime.w;
  if (isSnow) {
    let ph = h.x * 19.3 + h.y * 31.7 + t * (1.8 + 1.1 * h.z);
    rel.x += sin(ph) * (0.28 + 0.22 * W.windGust.w);
    rel.z += cos(ph * 0.87 + 1.3) * (0.28 + 0.22 * W.windGust.w);
  }

  let groundY = W.anchor.y;
  let world = vec3f(W.anchor.x + rel.x, groundY + rel.y, W.anchor.z + rel.z);
  if (world.y < groundY + 0.05 || isExcludedInterior(world.xz)) {
    return o;
  }

  // Smooth fade at wrap-box borders, ground plane, ceiling, and near camera lens
  let edgeXZ = max(abs(rel.x), abs(rel.z)) / (0.5 * boxXZ);
  let edgeY = abs(rel.y - 0.5 * boxY) / (0.5 * boxY);
  var a = fade * (1.0 - smoothstep(0.72, 1.0, max(edgeXZ, edgeY)));
  let distToEye = length(world - W.eyeTime.xyz);
  a *= smoothstep(1.2, 3.2, distToEye) * smoothstep(groundY + 0.05, groundY + 0.55, world.y);
  if (a <= 0.002) { return o; }

  // Evaluate scene light cones & pools at the droplet's 3D world position
  let vertexHead = vi % 6u == 1u || vi % 6u == 2u || vi % 6u == 4u;
  let sampleWorld = select(world - W.velExposure.xyz * W.velExposure.w * (0.85 + 0.30 * fract(h.z * 7.13)), world, vertexHead);
  let litRgb = evalWeatherLightAt(select(world, sampleWorld, W.anchor.w > 0.5));
  let litIntensity = max(litRgb.r, max(litRgb.g, litRgb.b));
  let litOnly = W.lighting.x;
  let flash = W.lighting.y;
  let unlitFloor = mix(0.62, select(0.14, 0.0, W.anchor.w > 0.5), litOnly);
  let lightGate = clamp(unlitFloor + litIntensity * (1.55 + 2.15 * litOnly) + flash * 1.85, 0.0, 3.6);
  a *= min(1.45, lightGate);
  if (a <= 0.003 && W.anchor.w < 0.5) { return o; }

  let dropSize = W.shape.x * (0.65 + 0.70 * h.x * h.y);
  let vScale = 0.85 + 0.30 * fract(h.z * 7.13);
  var v = W.velExposure.xyz * vScale;
  if (isSnow) {
    let ph = h.x * 19.3 + t * 2.1;
    v = vec3f(W.windGust.x * 1.8 + cos(ph) * 0.9, -2.2 * vScale, W.windGust.y * 1.8 - sin(ph) * 0.9);
  }
  let exposure = select(W.velExposure.w, W.velExposure.w * 0.22, isSnow);
  let head = world;
  let tail = world - v * exposure;
  let ch = W.viewProj * vec4f(head, 1.0);
  var ct = W.viewProj * vec4f(tail, 1.0);
  if (ch.w < 0.2 || ct.w < 0.2) { return o; }

  let vp = W.viewportFocal.xy;
  let sh = (ch.xy / ch.w) * vp * 0.5;
  var st = (ct.xy / ct.w) * vp * 0.5;
  let maxLen = select(vp.y * select(0.095, 0.022, isSnow), W.viewportFocal.w, W.anchor.w > 0.5 && !isSnow);
  let rawLen = length(sh - st);
  if (rawLen > maxLen && rawLen > 1e-3) {
    ct = mix(ch, ct, maxLen / rawLen);
    st = (ct.xy / ct.w) * vp * 0.5;
    a *= (maxLen / rawLen) * 0.5 + 0.5;
  }

  var d = sh - st;
  let len = length(d);
  d = select(vec2f(0.0, 1.0), d / len, len > 1e-3);
  let n = vec2f(-d.y, d.x);

  let wTrue = dropSize * W.viewportFocal.z / ch.w;
  let minPx = W.shape.y * select(1.0, 0.85, isFar) * select(1.0, 1.75, isSnow);
  let maxPx = select(2.1, 4.0, isSnow);
  let wPx = clamp(max(wTrue, minPx), 0.95, maxPx);
  a *= (min(1.0, wTrue / max(wPx, 1e-3)) * 0.55 + 0.45) * select(W.baseColor.w, W.baseColor.w * 0.62, isFar);

  let corner = vi % 6u;
  let end = select(0.0, 1.0, corner == 1u || corner == 2u || corner == 4u);
  let side = select(-1.0, 1.0, corner == 2u || corner == 4u || corner == 5u);
  var c = select(ct, ch, end > 0.5);
  let padLen = select(0.55, 1.15, isSnow);
  let px = n * side * wPx * 0.5 + d * (end - 0.5) * wPx * padLen;
  c = vec4f(c.xy + (px * 2.0 / vp) * c.w, c.z, c.w);

  let ambCol = W.baseColor.rgb * (0.48 + 0.52 * W.lighting.z + flash * 2.6);
  let finalCol = ambCol * mix(1.0, 0.32, litOnly) + litRgb * (1.75 + 1.65 * litOnly);

  o.pos = c;
  o.uv = vec2f(side, end * 2.0 - 1.0);
  o.color = finalCol;
  o.alpha = clamp(a, 0.0, 0.92);
  return o;
}

@fragment fn streakFs(o: StreakOut) -> ${outType} {
  let isSnow = W.shape.w > 0.5;
  var shape = 0.0;
  if (isSnow) {
    let r2 = dot(o.uv, o.uv);
    shape = max(0.0, 1.0 - r2) * max(0.0, 1.0 - r2);
  } else {
    let across = max(0.0, 1.0 - o.uv.x * o.uv.x);
    let along = o.uv.y * 0.5 + 0.5;
    shape = across * (0.24 + 0.76 * along);
  }
  let a = o.alpha * shape;
  ${retStmt("vec4f(o.color * a, a)")}
}

struct SplashOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec3f,
  @location(2) alpha: f32,
  @location(3) @interpolate(flat) kind: u32,
}

@vertex fn splashVs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> SplashOut {
  var o: SplashOut;
  o.pos = vec4f(0.0, 0.0, -2.0, 1.0);
  o.uv = vec2f(0.0);
  o.color = vec3f(0.0);
  o.alpha = 0.0;
  o.kind = 0u;

  let splashCap = u32(ceil(W.counts.w));
  let isDrip = ii >= splashCap;
  let local = select(ii, ii - splashCap, isDrip);
  let amount = select(W.counts.w, W.counts2.x, isDrip);
  let fade = saturate(amount - f32(local));
  if (fade <= 0.0) { return o; }

  let h0 = rand3(vec3u(local, select(37u, 53u, isDrip), 0x5eedu));
  var period = select(${SPLASH_PERIOD}, 0.36, isDrip);
  var dripFallTime = 0.0;
  if (isDrip && W.anchor.w > 0.5) {
    let e = local % max(1u,u32(W.lighting.w));
    let height = max(1.8,W.eaveHeights[e/4u][e%4u]-W.anchor.y);
    dripFallTime = sqrt(2.0*height/9.81);
    period = dripFallTime+0.28;
  }
  let phase = W.eyeTime.w / period + h0.x;
  let cycle = u32(floor(phase));
  let age = fract(phase);
  let h = rand3(vec3u(local, cycle, 0x5b1a5u));

  let groundY = W.anchor.y;
  let anchorXZ = W.anchor.xz;
  var base = vec3f(anchorXZ.x, groundY, anchorXZ.y);
  var eaveY = groundY + 2.65;

  if (!isDrip) {
    let cellXZ = floor(anchorXZ / ${SPLASH_BOX}.0) * ${SPLASH_BOX}.0 + h.xy * ${SPLASH_BOX}.0;
    let wrappedXZ = anchorXZ + (cellXZ - anchorXZ - ${SPLASH_BOX}.0 * floor((cellXZ - anchorXZ) / ${SPLASH_BOX}.0) - ${SPLASH_BOX * 0.5}.0);
    if (isExcludedInterior(wrappedXZ)) { return o; }
    base = vec3f(wrappedXZ.x, groundY + 0.03, wrappedXZ.y);
  } else {
    let nEaves = max(1u, u32(W.lighting.w));
    let eIdx = select(local+cycle,local,W.anchor.w>0.5) % min(${MAX_WEATHER_EAVES}u, nEaves);
    let seg = W.eaveSegs[eIdx];
    let eh = W.eaveHeights[eIdx / 4u][eIdx % 4u];
    let along = fract(h.x + h0.y * 0.37);
    let jitter = (h.y - 0.5) * 0.08;
    let dir = normalize(seg.zw - seg.xy + vec2f(1e-4));
    let nrm = vec2f(-dir.y, dir.x);
    let xz = mix(seg.xy, seg.zw, along) + nrm * jitter;
    base = vec3f(xz.x, groundY + 0.03, xz.y);
    eaveY = max(groundY + 1.8, eh);
  }

  let distToAnchor = length(base.xz - anchorXZ);
  var a = fade * (1.0 - smoothstep(${SPLASH_BOX * 0.38}, ${SPLASH_BOX * 0.52}, distToAnchor));
  if (a <= 0.002) { return o; }

  let dripTime = age*period;
  let dripHead = max(base.y,eaveY-0.5*9.81*dripTime*dripTime);
  let lightPoint = select(base+vec3f(0.0,0.25,0.0),vec3f(base.x,dripHead,base.z),isDrip && vi>=6u && W.anchor.w>0.5);
  let litRgb = evalWeatherLightAt(lightPoint);
  let litIntensity = max(litRgb.r, max(litRgb.g, litRgb.b));
  let litOnly = W.lighting.x;
  let flash = W.lighting.y;
  let lightGate = clamp(mix(0.52, select(0.12, 0.0, W.anchor.w > 0.5), litOnly) + litIntensity * (1.65 + 2.15 * litOnly) + flash * 1.8, 0.0, 3.6);
  a *= min(1.5, lightGate);
  if (a <= 0.003) { return o; }

  let size = W.shape.z * (0.72 + 0.78 * h.z);
  let corner = vi % 6u;
  let uv = vec2f(
    select(-1.0, 1.0, corner == 1u || corner == 2u || corner == 4u),
    select(-1.0, 1.0, corner == 2u || corner == 4u || corner == 5u)
  );

  var world = base;
  if (vi < 6u) {
    // Expanding horizontal ground ring (delicate thin water ripple)
    let ringAge = select(select(age, clamp((age - 0.35) / 0.65, 0.0, 1.0), isDrip),clamp((dripTime-dripFallTime)/0.28,0.0,1.0),isDrip && W.anchor.w>0.5);
    let r = size * (0.06 + 0.24 * ringAge);
    world = base + vec3f(uv.x * r, 0.02, uv.y * r);
    let impact = select(step(0.35,age),step(dripFallTime,dripTime),W.anchor.w>0.5);
    a *= (1.0 - ringAge) * (1.0 - ringAge) * select(0.75, impact * 0.85, isDrip);
    o.kind = 0u;
  } else if (!isDrip) {
    // Upward splash crown fleck (brief micro-spray at impact)
    let toCamXZ = normalize(W.eyeTime.xz - base.xz + vec2f(1e-4));
    let right = vec3f(-toCamXZ.y, 0.0, toCamXZ.x);
    let crownAge = clamp(age * 2.2, 0.0, 1.0);
    let arc = 4.0 * crownAge * (1.0 - crownAge);
    let hgt = size * 0.16 * arc;
    world = base + right * (uv.x * size * 0.028 * (0.5 + crownAge)) + vec3f(0.0, (uv.y * 0.5 + 0.5) * hgt + 0.01, 0.0);
    a *= smoothstep(0.0, 0.06, age) * (1.0 - smoothstep(0.14, 0.38, age)) * 0.48;
    o.kind = 1u;
  } else {
    // Falling eave drip streak from overhang (y = eaveY) to ground (y = base.y)
    let fallFrac = clamp(age / 0.45, 0.0, 1.0);
    let yHead = select(mix(eaveY, base.y, fallFrac * fallFrac),dripHead,W.anchor.w>0.5);
    let yTail = min(eaveY, yHead + select(0.46,9.81*dripTime*W.velExposure.w,W.anchor.w>0.5));
    let toCamXZ = normalize(W.eyeTime.xz - base.xz + vec2f(1e-4));
    let right = vec3f(-toCamXZ.y, 0.0, toCamXZ.x);
    let yCur = mix(yTail, yHead, uv.y * 0.5 + 0.5);
    world = vec3f(base.x, yCur, base.z) + right * (uv.x * 0.020);
    a *= select(1.0-smoothstep(0.38,0.48,age),1.0-smoothstep(dripFallTime-0.015,dripFallTime+0.015,dripTime),W.anchor.w>0.5) * 0.88;
    o.kind = 1u;
  }

  let ambCol = W.splashColor.rgb * (0.48 + 0.52 * W.lighting.z + flash * 2.5);
  let finalCol = ambCol * mix(1.0, 0.28, litOnly) + litRgb * (1.85 + 1.65 * litOnly);

  o.pos = W.viewProj * vec4f(world, 1.0);
  o.uv = uv;
  o.color = finalCol;
  o.alpha = clamp(a * W.splashColor.w, 0.0, 0.92);
  return o;
}

@fragment fn splashFs(o: SplashOut) -> ${outType} {
  var shape = 0.0;
  if (o.kind == 0u) {
    let r = length(o.uv);
    shape = smoothstep(0.62, 0.85, r) * (1.0 - smoothstep(0.85, 1.0, r)) * 0.52;
  } else {
    shape = max(0.0, 1.0 - o.uv.x * o.uv.x) * (0.35 + 0.65 * (o.uv.y * 0.5 + 0.5));
  }
  let a = o.alpha * shape;
  ${retStmt("vec4f(o.color * a, a)")}
}

struct MistOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec3f,
  @location(2) alpha: f32,
  @location(3) seed: f32,
}

@vertex fn mistVs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> MistOut {
  var o: MistOut;
  o.pos = vec4f(0.0, 0.0, -2.0, 1.0);
  o.uv = vec2f(0.0);
  o.color = vec3f(0.0);
  o.alpha = 0.0;
  o.seed = 0.0;

  let fade = saturate(W.counts2.y - f32(ii));
  if (fade <= 0.0) { return o; }

  let h = rand3(vec3u(ii, 71u, 0x5eedu));
  let box = ${MIST_BOX}.0;
  let driftXZ = vec2f(W.offNear.x, W.offNear.z) * 0.35;
  let relXZ = (h.xy * box + driftXZ) - box * floor((h.xy * box + driftXZ) / box) - 0.5 * box;
  let worldXZ = W.anchor.xz + relXZ;
  if (isExcludedInterior(worldXZ)) { return o; }

  let groundY = W.anchor.y;
  let center = vec3f(worldXZ.x, groundY + 0.55 + h.z * 0.85, worldXZ.y);
  let edge = max(abs(relXZ.x), abs(relXZ.y)) / (0.5 * box);
  var a = fade * (1.0 - smoothstep(0.58, 0.98, edge));
  let dist = length(center - W.eyeTime.xyz);
  a *= smoothstep(3.5, 8.5, dist);
  if (a <= 0.002) { return o; }

  let litRgb = evalWeatherLightAt(center);
  let flash = W.lighting.y;
  let ambCol = W.baseColor.rgb * (0.14 + 0.25 * W.lighting.z + flash * 0.75);
  let col = ambCol + litRgb * 0.68;

  let corner = vi % 6u;
  let uv = vec2f(
    select(-1.0, 1.0, corner == 1u || corner == 2u || corner == 4u),
    select(-1.0, 1.0, corner == 2u || corner == 4u || corner == 5u)
  );
  // Orient mist billows parallel to the ground plane (XZ) above groundY so they never clip the road in a hard depth line
  let radius = 1.65 + h.z * 1.15;
  let world = vec3f(center.x + uv.x * radius, groundY + 0.45 + h.z * 0.85, center.z + uv.y * radius);

  o.pos = W.viewProj * vec4f(world, 1.0);
  o.uv = uv;
  o.color = col;
  o.alpha = clamp(a * 0.085, 0.0, 0.15);
  o.seed = h.x * 17.3 + h.y * 31.1 + W.eyeTime.w * 0.25;
  return o;
}

@fragment fn mistFs(o: MistOut) -> ${outType} {
  let r2 = min(1.0, dot(o.uv, o.uv));
  let radial = (1.0 - r2) * (1.0 - r2);
  let a = o.alpha * radial;
  ${retStmt("vec4f(o.color * a, a)")}
}
`
}

export type WeatherPrepareInput = {
  settings: Readonly<WeatherSettings>
  state: Readonly<WeatherFrameState>
  viewProj: ArrayLike<number>
  eye: ArrayLike<number>
  /** World-space ground focus [focusX, focusZ] around which the rain/splash/mist volume is anchored. */
  focusXZ?: readonly [number, number]
  viewportWidth: number
  viewportHeight: number
  fovYRad?: number
  groundY?: number
  ambientLum?: number
  lights?: readonly WeatherLight[]
  /** Opt-in physical cone direction, light-gated visibility and shorter camera-relative streaks. */
  rainLighting?: Readonly<RainLightingSettings>
  excludeRects?: readonly WeatherExcludeRect[]
  eaves?: readonly WeatherEave[]
  cameraDist?: number
}

/** The host renderer's camera for this frame (see `WeatherRenderer.prepare`). */
export type WeatherCamera = { viewProj: ArrayLike<number>; width: number; height: number }

export class WeatherRenderer {
  private readonly uniformData = new Float32Array(WEATHER_UNIFORM_FLOATS)
  private readonly uniformBuf: GPUBuffer
  private readonly layout: GPUBindGroupLayout
  private readonly group: GPUBindGroup
  private readonly streakPipe: GPURenderPipeline
  private readonly splashPipe: GPURenderPipeline
  private readonly mistPipe: GPURenderPipeline
  private motionStreakPipe?: GPURenderPipeline
  private motionSplashPipe?: GPURenderPipeline
  private motionMistPipe?: GPURenderPipeline
  private readonly describe: (vs: string, fs: string) => GPURenderPipelineDescriptor
  private reactivePipes?: { streak: GPURenderPipeline; splash: GPURenderPipeline; mist: GPURenderPipeline }

  nearCount = 0
  farCount = 0
  splashCount = 0
  dripCount = 0
  mistCount = 0

  constructor(
    private readonly device: GPUDevice,
    private readonly colorFormat: GPUTextureFormat = "rgba16float",
    private readonly depthFormat: GPUTextureFormat = "depth24plus",
    private readonly sampleCount = 4,
    private readonly depthCompare: GPUCompareFunction = "less-equal",
  ) {
    const d = device
    this.uniformBuf = d.createBuffer({
      label: "weather-uniforms",
      size: this.uniformData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    this.layout = d.createBindGroupLayout({
      label: "weather-bind-layout",
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
      ],
    })
    this.group = d.createBindGroup({
      label: "weather-bind-group",
      layout: this.layout,
      entries: [{ binding: 0, resource: { buffer: this.uniformBuf } }],
    })

    const module = d.createShaderModule({
      label: "weather-shader",
      code: makeWeatherShader(false),
    })
    const blend: GPUBlendState = {
      color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
      alpha: { srcFactor: "zero", dstFactor: "one" },
    }
    const pipeLayout = d.createPipelineLayout({ bindGroupLayouts: [this.layout] })
    this.describe = (vs: string, fs: string, mod = module, mrt = false): GPURenderPipelineDescriptor => ({
        label: `weather-${vs}${mrt ? "-mrt" : ""}`,
        layout: pipeLayout,
        vertex: { module: mod, entryPoint: vs },
        fragment: {
          module: mod,
          entryPoint: fs,
          targets: [
            { format: this.colorFormat, blend },
            ...(mrt ? [{ format: this.colorFormat, writeMask: 0 as GPUColorWriteFlags }] : []),
          ],
        },
        primitive: { topology: "triangle-list", cullMode: "none" },
        depthStencil: {
          format: this.depthFormat,
          depthWriteEnabled: false,
          depthCompare: this.depthCompare,
        },
        multisample: { count: this.sampleCount },
      })
    const makePipe = (vs: string, fs: string) => d.createRenderPipeline(this.describe(vs, fs))

    this.streakPipe = makePipe("streakVs", "streakFs")
    this.splashPipe = makePipe("splashVs", "splashFs")
    this.mistPipe = makePipe("mistVs", "mistFs")
  }

  private ensureMotionPipes(): void {
    if (this.motionStreakPipe) return
    const mod = this.device.createShaderModule({
      label: "weather-shader-mrt",
      code: makeWeatherShader(true),
    })
    const blend: GPUBlendState = {
      color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
      alpha: { srcFactor: "zero", dstFactor: "one" },
    }
    const pipeLayout = this.device.createPipelineLayout({ bindGroupLayouts: [this.layout] })
    const makePipe = (vs: string, fs: string) =>
      this.createMotionPipe(mod, pipeLayout, blend, vs, fs)
    this.motionStreakPipe = makePipe("streakVs", "streakFs")
    this.motionSplashPipe = makePipe("splashVs", "splashFs")
    this.motionMistPipe = makePipe("mistVs", "mistFs")
  }

  private createMotionPipe(
    mod: GPUShaderModule,
    pipeLayout: GPUPipelineLayout,
    blend: GPUBlendState,
    vs: string,
    fs: string,
  ): GPURenderPipeline {
    return this.device.createRenderPipeline({
      label: `weather-${vs}-mrt`,
      layout: pipeLayout,
      vertex: { module: mod, entryPoint: vs },
      fragment: {
        module: mod,
        entryPoint: fs,
        targets: [
          { format: this.colorFormat, blend },
          { format: this.colorFormat, writeMask: 0 },
        ],
      },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: {
        format: this.depthFormat,
        depthWriteEnabled: false,
        depthCompare: this.depthCompare,
      },
      multisample: { count: this.sampleCount },
    })
  }

  /**
   * `camera` replaces the input's projection and pixel size in the shader only (LOD and density still follow
   * `input.viewportWidth`): the host renderer passes its jittered matrix and internal size under temporal AA, so rain
   * renders on the same sub-pixel grid as the scene it falls through.
   */
  prepare(input: WeatherPrepareInput, camera?: WeatherCamera): void {
    const { settings, state } = input
    const eaves = input.eaves ?? []
    const lod = computeWeatherLod(settings, input.cameraDist ?? 34, eaves.length > 0, input.viewportWidth)
    this.nearCount = lod.nearCount
    this.farCount = lod.farCount
    this.splashCount = lod.splashCount
    this.dripCount = lod.dripCount
    this.mistCount = lod.mistCount

    if (!this.nearCount && !this.farCount && !this.splashCount && !this.dripCount && !this.mistCount) {
      return
    }

    const u = this.uniformData
    u.fill(0)
    const viewProj = camera?.viewProj ?? input.viewProj
    for (let i = 0; i < 16; i++) u[i] = viewProj[i] ?? 0

    const ex = input.eye[0] ?? 0
    const ey = input.eye[1] ?? 10
    const ez = input.eye[2] ?? 0
    u[16] = ex
    u[17] = ey
    u[18] = ez
    u[19] = state.time

    const groundY = input.groundY ?? 0
    const focusX = input.focusXZ ? input.focusXZ[0] : ex
    const focusZ = input.focusXZ ? input.focusXZ[1] : ez
    u[20] = focusX
    u[21] = groundY
    u[22] = focusZ
    const rainLighting = input.rainLighting?.mode === "volume" ? input.rainLighting : null
    u[23] = rainLighting ? 1 : 0

    const vpW = Math.max(1, camera?.width ?? input.viewportWidth)
    const vpH = Math.max(1, camera?.height ?? input.viewportHeight)
    const fov = input.fovYRad ?? 0.65
    const focalPx = vpH / (2 * Math.tan(fov * 0.5))
    u[24] = vpW
    u[25] = vpH
    u[26] = focalPx
    u[27] = rainLighting ? Math.min(64, Math.max(4, rainLighting.maxPixels)) : groundY

    const wrap = (v: number, box: number) => v - box * Math.floor(v / box)
    u[28] = wrap(state.driftX - focusX, NEAR_BOX)
    u[29] = wrap(state.driftY - groundY, NEAR_HEIGHT)
    u[30] = wrap(state.driftZ - focusZ, NEAR_BOX)
    u[31] = NEAR_BOX

    u[32] = wrap(state.driftX - focusX, FAR_BOX)
    u[33] = wrap(state.driftY - groundY, FAR_HEIGHT)
    u[34] = wrap(state.driftZ - focusZ, FAR_BOX)
    u[35] = FAR_BOX

    const dropCarry = settings.snowMode ? 0.78 : 0.58
    const vx = state.windX * state.windSpeedMs * dropCarry - state.camVelX
    const vy = -(settings.snowMode ? Math.min(settings.dropSpeed, 4.2) : settings.dropSpeed) - state.camVelY
    const vz = state.windZ * state.windSpeedMs * dropCarry - state.camVelZ
    u[36] = vx
    u[37] = vy
    u[38] = vz
    u[39] = (rainLighting ? Math.min(0.05, Math.max(0.002, rainLighting.shutter)) : 0.048) * settings.dropLength

    u[40] = state.windX
    u[41] = state.windZ
    u[42] = state.windSpeedMs
    u[43] = state.gust

    const nearCap = NEAR_BASE * MAX_DENSITY_SCALE
    u[44] = nearCap
    u[45] = this.nearCount
    u[46] = this.farCount
    u[47] = this.splashCount

    const lights = input.lights ?? []
    const excludes = input.excludeRects ?? []
    const lightCount = Math.min(MAX_WEATHER_LIGHTS, lights.length)
    const excludeCount = Math.min(MAX_WEATHER_EXCLUDES, excludes.length)
    const eaveCount = Math.min(MAX_WEATHER_EAVES, eaves.length)

    u[48] = this.dripCount
    u[49] = this.mistCount
    u[50] = lightCount
    u[51] = excludeCount

    u[52] = 0.0085 * settings.dropSize
    u[53] = 1.15 * Math.sqrt(Math.max(0.4, settings.dropSize))
    u[54] = 0.56 * Math.sqrt(Math.max(0.4, settings.dropSize)) * (rainLighting ? Math.max(0.1, Math.min(1, rainLighting.splashScale)) : 1)
    u[55] = settings.snowMode ? 1 : 0

    u[56] = rainLighting ? 1 : settings.litOnly
    u[57] = state.flash
    u[58] = input.ambientLum ?? 0.35
    u[59] = eaveCount

    const hiDpiBoost = input.viewportWidth > 2200 ? 1.24 : 1.0
    if (settings.snowMode) {
      u[60] = 0.78
      u[61] = 0.85
      u[62] = 0.96
      u[63] = Math.min(0.92, 0.58 * (0.35 + 0.65 * settings.intensity) * hiDpiBoost)
    } else {
      u[60] = 0.45
      u[61] = 0.56
      u[62] = 0.74
      u[63] = Math.min(0.88, 0.54 * (0.35 + 0.65 * settings.intensity) * hiDpiBoost)
    }

    u[64] = 0.54
    u[65] = 0.64
    u[66] = 0.80
    u[67] = Math.min(0.86, 0.48 * (0.35 + 0.65 * settings.intensity) * hiDpiBoost)

    for (let i = 0; i < lightCount; i++) {
      const l = lights[i]!
      const pOff = 68 + i * 4
      const cOff = 116 + i * 4
      const kOff = 164 + i * 4
      u[pOff] = l.x
      u[pOff + 1] = l.y
      u[pOff + 2] = l.z
      u[pOff + 3] = l.radius
      u[cOff] = l.r
      u[cOff + 1] = l.g
      u[cOff + 2] = l.b
      u[cOff + 3] = l.power
      u[kOff] = l.dx ?? 0
      u[kOff + 1] = l.dz ?? 0
      u[kOff + 2] = l.cosHalf ?? -1
      u[kOff + 3] = l.isCone ? 1 : 0
      if (rainLighting) {
        const axis = l.axis ?? (l.isCone ? [l.dx ?? 0, 0, l.dz ?? 0] : null)
        const length = axis ? Math.hypot(...axis) : 0
        u[kOff] = length ? axis![0]! / length : 0
        u[kOff + 1] = length ? axis![1]! / length : 0
        u[kOff + 2] = length ? axis![2]! / length : 0
        u[kOff + 3] = length ? l.cosHalf ?? -1 : -2
      }
    }

    for (let i = 0; i < excludeCount; i++) {
      const r = excludes[i]!
      const off = 212 + i * 4
      u[off] = r[0]
      u[off + 1] = r[1]
      u[off + 2] = r[2]
      u[off + 3] = r[3]
    }

    for (let i = 0; i < eaveCount; i++) {
      const e = eaves[i]!
      const off = 244 + i * 4
      u[off] = e[0]
      u[off + 1] = e[1]
      u[off + 2] = e[2]
      u[off + 3] = e[3]
      u[276 + i] = e[4]
    }

    this.device.queue.writeBuffer(this.uniformBuf, 0, u)
  }

  draw(pass: GPURenderPassEncoder, motionMrt = false): void {
    const hasStreaks = this.nearCount > 0 || this.farCount > 0
    const hasSplashes = this.splashCount > 0 || this.dripCount > 0
    const hasMist = this.mistCount > 0
    if (!hasStreaks && !hasSplashes && !hasMist) return

    if (motionMrt) this.ensureMotionPipes()
    pass.setBindGroup(0, this.group)

    if (hasMist) {
      pass.setPipeline(motionMrt ? this.motionMistPipe! : this.mistPipe)
      pass.draw(6, this.mistCount)
    }
    if (hasSplashes) {
      pass.setPipeline(motionMrt ? this.motionSplashPipe! : this.splashPipe)
      pass.draw(12, this.splashCount + this.dripCount)
    }
    if (hasStreaks) {
      pass.setPipeline(motionMrt ? this.motionStreakPipe! : this.streakPipe)
      this.drawStreaks(pass)
    }
  }

  /** Redraws this frame's rain, splashes and mist into the temporal reactive mask (`@arcade/kit/gpu/reactive`). */
  drawReactive(pass: GPURenderPassEncoder): void {
    const hasStreaks = this.nearCount > 0 || this.farCount > 0
    const hasSplashes = this.splashCount > 0 || this.dripCount > 0
    if (!hasStreaks && !hasSplashes && !this.mistCount) return
    const twin = (vs: string, fs: string) => this.device.createRenderPipeline(reactivePipelineDescriptor(this.describe(vs, fs)))
    const p = (this.reactivePipes ??= { streak: twin("streakVs", "streakFs"), splash: twin("splashVs", "splashFs"), mist: twin("mistVs", "mistFs") })
    pass.setBindGroup(0, this.group)
    if (this.mistCount) {
      pass.setPipeline(p.mist)
      pass.draw(6, this.mistCount)
    }
    if (hasSplashes) {
      pass.setPipeline(p.splash)
      pass.draw(12, this.splashCount + this.dripCount)
    }
    if (hasStreaks) {
      pass.setPipeline(p.streak)
      this.drawStreaks(pass)
    }
  }

  private drawStreaks(pass: GPURenderPassEncoder): void {
    if (this.nearCount > 0) pass.draw(6, this.nearCount, 0, 0)
    if (this.farCount > 0) pass.draw(6, this.farCount, 0, NEAR_BASE * MAX_DENSITY_SCALE)
  }
}
