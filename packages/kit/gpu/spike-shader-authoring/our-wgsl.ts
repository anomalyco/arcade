import { type LookSettings, LOOK_PRESETS, isIdentityLook, type LookCompareMode } from "../look"
import { makeSceneShader, postCommonWgsl, type SceneHooks } from "../shaders"
import type { PostFinishOptions } from "../look-shaders"
import { wgslStruct, wgslSlot, wgslSnippet, resolveWgsl } from "../wgsl"

/**
 * 1. Typed WGSL struct definition with human-readable field names.
 * Replaces 64 raw float array offsets and `LK.u0.x .. LK.u15.w` magic swizzles.
 * Exact same 256-byte (64-float) binary layout as `LookUniforms`, verified by `wgslStruct`.
 */
export const LookUniformsStruct = wgslStruct("LookUniforms", {
  // u0
  exposure: "f32",
  tonemap: "f32",
  contrast: "f32",
  toe: "f32",
  // u1
  shoulder: "f32",
  blackCrush: "f32",
  saturation: "f32",
  temperature: "f32",
  // u2
  splitTone: "f32",
  shadowTintR: "f32",
  shadowTintG: "f32",
  shadowTintB: "f32",
  // u3
  highlightTintR: "f32",
  highlightTintG: "f32",
  highlightTintB: "f32",
  paletteMix: "f32",
  // u4
  ambientFill: "f32",
  shadowColorR: "f32",
  shadowColorG: "f32",
  shadowColorB: "f32",
  // u5
  practicalWarmth: "f32",
  practicalIntensity: "f32",
  moonIntensity: "f32",
  rimStrength: "f32",
  // u6
  contactShade: "f32",
  surfaceWetness: "f32",
  fogDensity: "f32",
  fogHeightFalloff: "f32",
  // u7
  fogColorR: "f32",
  fogColorG: "f32",
  fogColorB: "f32",
  shaftStrength: "f32",
  // u8
  shaftSlats: "f32",
  bloom: "f32",
  halation: "f32",
  vignette: "f32",
  // u9
  grain: "f32",
  grainSeed: "f32",
  grainAnimated: "f32",
  chromatic: "f32",
  // u10
  diffuseWrap: "f32",
  diffuseBands: "f32",
  bandSoftness: "f32",
  painterlySmooth: "f32",
  // u11
  outlineStrength: "f32",
  outlineWidth: "f32",
  foliageShift: "f32",
  activeFlag: "f32",
  // u12 (vec3f at 16B boundary + f32 = 16B)
  paletteWall: "vec3f",
  compareMode: "f32",
  // u13
  paletteWood: "vec3f",
  wipeSplit: "f32",
  // u14
  paletteStone: "vec3f",
  presetIndex: "f32",
  // u15
  paletteFoliage: "vec3f",
  inkLuma: "f32",
})

export function packTypedLookUniforms(
  settings: LookSettings,
  out?: Float32Array<ArrayBuffer>,
  floatOffset = 0,
  extra?: { compareMode?: LookCompareMode; wipeSplit?: number; forceActive?: boolean },
): Float32Array<ArrayBuffer> {
  const presetDef = LOOK_PRESETS[settings.preset] ?? LOOK_PRESETS.current
  const pal = presetDef.palette
  const active = extra?.forceActive ? 1 : isIdentityLook(settings) ? 0 : 1
  return LookUniformsStruct.pack(
    {
      exposure: settings.exposure,
      tonemap: settings.tonemap,
      contrast: settings.contrast,
      toe: settings.toe,
      shoulder: settings.shoulder,
      blackCrush: settings.blackCrush,
      saturation: settings.saturation,
      temperature: settings.temperature,
      splitTone: settings.splitTone,
      shadowTintR: settings.shadowTintR,
      shadowTintG: settings.shadowTintG,
      shadowTintB: settings.shadowTintB,
      highlightTintR: settings.highlightTintR,
      highlightTintG: settings.highlightTintG,
      highlightTintB: settings.highlightTintB,
      paletteMix: settings.paletteMix,
      ambientFill: settings.ambientFill,
      shadowColorR: settings.shadowColorR,
      shadowColorG: settings.shadowColorG,
      shadowColorB: settings.shadowColorB,
      practicalWarmth: settings.practicalWarmth,
      practicalIntensity: settings.practicalIntensity,
      moonIntensity: settings.moonIntensity,
      rimStrength: settings.rimStrength,
      contactShade: settings.contactShade,
      surfaceWetness: settings.surfaceWetness,
      fogDensity: settings.fogDensity,
      fogHeightFalloff: settings.fogHeightFalloff,
      fogColorR: settings.fogColorR,
      fogColorG: settings.fogColorG,
      fogColorB: settings.fogColorB,
      shaftStrength: settings.shaftStrength,
      shaftSlats: settings.shaftSlats,
      bloom: settings.bloom,
      halation: settings.halation,
      vignette: settings.vignette,
      grain: settings.grain,
      grainSeed: settings.grainSeed,
      grainAnimated: settings.grainAnimated ? 1 : 0,
      chromatic: settings.chromatic,
      diffuseWrap: settings.diffuseWrap,
      diffuseBands: settings.diffuseBands,
      bandSoftness: settings.bandSoftness,
      painterlySmooth: settings.painterlySmooth,
      outlineStrength: settings.outlineStrength,
      outlineWidth: settings.outlineWidth,
      foliageShift: settings.foliageShift,
      activeFlag: active,
      paletteWall: pal.wall,
      compareMode: extra?.compareMode ?? 1,
      paletteWood: pal.wood,
      wipeSplit: extra?.wipeSplit ?? 0.5,
      paletteStone: pal.stone,
      presetIndex: presetDef.index,
      paletteFoliage: pal.foliage,
      inkLuma: pal.ink[0] * 0.2126 + pal.ink[1] * 0.7152 + pal.ink[2] * 0.0722,
    },
    out,
    floatOffset,
  )
}

export type LookVariantMode = "noir" | "painterly" | "generic"
export const lookVariantSlot = wgslSlot<LookVariantMode>("lookVariant", "generic")

export const lookMathSnippet = wgslSnippet(
  "lookMath",
  /* wgsl */ `
fn lookQuantizeDiffuse(ndlRaw: f32, wrap: f32, bands: f32, softness: f32) -> f32 {
  let wrapped = clamp((ndlRaw + wrap) / (1.0 + max(wrap, 0.0)), 0.0, 1.0);
  if (bands < 1.5) { return wrapped; }
  let b = max(2.0, round(bands));
  let scaled = wrapped * b;
  let cell = floor(scaled);
  let f = scaled - cell;
  let s = clamp(softness, 0.02, 0.48);
  return clamp((cell + smoothstep(0.5 - s, 0.5 + s, f)) / b, 0.0, 1.0);
}

fn lookPracticalColor(baseCol: vec3f, warmth: f32) -> vec3f {
  let warmTarget = vec3f(1.05, 0.52, 0.16);
  let coolTarget = vec3f(0.72, 0.88, 1.08);
  if (warmth >= 0.0) {
    return mix(baseCol, warmTarget * length(baseCol) * 0.65, clamp(warmth, 0.0, 1.0));
  }
  return mix(baseCol, coolTarget * length(baseCol) * 0.65, clamp(-warmth, 0.0, 1.0));
}
`,
  [LookUniformsStruct],
)

export const lookGradeSnippet = wgslSnippet(
  "lookGrade",
  /* wgsl */ `
fn lookTonemapACES(x: vec3f) -> vec3f {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
}

fn lookTonemapFilmic(x: vec3f) -> vec3f {
  let expCh = vec3f(1.0) - exp(-x * 1.35);
  let lum = max(dot(x, vec3f(0.2126, 0.7152, 0.0722)), 1e-4);
  let expLum = 1.0 - exp(-lum * 1.35);
  let huePres = clamp(x / lum * expLum, vec3f(0.0), vec3f(1.2));
  let c = mix(expCh, huePres, 0.42);
  let over = max(c - vec3f(0.62), vec3f(0.0));
  return clamp(min(c, vec3f(0.62)) + vec3f(0.38) * (vec3f(1.0) - exp(-over / 0.38)), vec3f(0.0), vec3f(1.0));
}

fn lookTonemapAgX(val: vec3f) -> vec3f {
  let agxMat = mat3x3f(
    0.842479062253094, 0.0423282422610123, 0.0423756549057051,
    0.0784335999999992, 0.878468636469772, 0.0784336,
    0.0792237451477643, 0.0791661274605434, 0.879142973793104
  );
  let agxMatInv = mat3x3f(
    1.19687900512017, -0.0528968517574562, -0.0529716355144438,
    -0.0980208811401368, 1.15190312990417, -0.0980434501171241,
    -0.0990297440797205, -0.0989611768448433, 1.15107367264116
  );
  var v = agxMat * max(val, vec3f(1e-6));
  v = clamp((log2(v) - (-12.47393)) / (4.026069 - (-12.47393)), vec3f(0.0), vec3f(1.0));
  let x2 = v * v;
  let x4 = x2 * x2;
  v = 15.5 * x4 * x2 - 40.14 * x4 * v + 31.96 * x4 - 6.868 * x2 * v + 0.4298 * x2 + 0.1191 * v - 0.00232;
  v = agxMatInv * v;
  return clamp(pow(max(v, vec3f(0.0)), vec3f(2.2)), vec3f(0.0), vec3f(1.0));
}

fn lookApplyTonemap(hdr: vec3f, mode: i32, huePreserve: f32) -> vec3f {
  let x = max(hdr, vec3f(0.0));
  if (mode == 1) { return lookTonemapFilmic(x); }
  if (mode == 2) { return lookTonemapAgX(x); }
  let baseAces = lookTonemapACES(x);
  let peak = max(x.r, max(x.g, x.b));
  let hp = select(huePreserve, 0.52, mode == 3);
  return mix(baseAces, x * (lookTonemapACES(vec3f(peak)).r / max(peak, 1e-4)), hp);
}

fn lookHash12(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

fn lookGradeColor(
  L: LookUniforms,
  hdrIn: vec3f,
  bloomIn: vec3f,
  uv: vec2f,
  fragXY: vec2f,
  time: f32,
  shaftLift: f32,
  baseBloomScale: f32,
  baseVignetteFloor: f32,
  baseHuePreserve: f32,
) -> vec3f {
  let halationTint = vec3f(1.08, 0.34, 0.10) * L.halation * 0.28;
  var hdr = hdrIn + bloomIn * (baseBloomScale * L.bloom + halationTint);
  hdr *= L.exposure * vec3f(1.0 + L.temperature * 0.24, 1.0 + L.temperature * 0.03, 1.0 - L.temperature * 0.24);
  hdr = max(hdr, vec3f(0.0));
  if (abs(L.contrast - 1.0) > 0.001) {
    hdr = vec3f(0.18) * pow(max(hdr / 0.18, vec3f(1e-4)), vec3f(L.contrast));
  }
  var c = lookApplyTonemap(hdr, i32(round(L.tonemap)), baseHuePreserve);
  if (L.shoulder > 0.001) {
    let knee = 1.0 - L.shoulder * 0.45;
    let over = max(c - vec3f(knee), vec3f(0.0));
    let comp = min(c, vec3f(knee)) + (1.0 - knee) * (vec3f(1.0) - exp(-over / max(1.0 - knee, 0.06)));
    c = mix(c, comp, clamp(L.shoulder, 0.0, 1.0));
  }
  if (L.toe > 0.001) {
    let toeK = L.toe * 0.055;
    let t = c * c / max(c + vec3f(toeK), vec3f(1e-5));
    c = mix(c, t * (1.0 + toeK * 0.5), clamp(L.toe * 0.75, 0.0, 0.85));
  }
  let luma = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  let shadowTint = vec3f(L.shadowTintR, L.shadowTintG, L.shadowTintB);
  let highlightTint = vec3f(L.highlightTintR, L.highlightTintG, L.highlightTintB);
  let splitCurve = mix(shadowTint, highlightTint, smoothstep(0.02, 0.55, luma));
  let activeSplit = mix(vec3f(1.0), splitCurve, clamp(L.splitTone, 0.0, 1.5));
  let mono = vec3f(luma) * activeSplit;
  let warmBias = clamp((hdrIn.r - hdrIn.b * 1.05) / max(hdrIn.r + 0.005, 1e-4) - 0.08, 0.0, 1.0) * clamp(L.practicalWarmth * 1.6, 0.0, 1.0);
  let warmTinted = c * mix(activeSplit, vec3f(1.18, 0.88, 0.52), warmBias * 0.65);
  let effSat = mix(L.saturation, max(L.saturation, 0.92), warmBias * 0.88);
  c = mix(mono, warmTinted, effSat);
  if (L.blackCrush > 0.0005) {
    let linearCrush = L.blackCrush * 0.045;
    c = max(vec3f(0.0), (c - vec3f(linearCrush)) / max(1.0 - linearCrush, 0.1));
  }
  let fromC = (uv - 0.5) * vec2f(1.0, 0.82);
  let vDist = length(fromC);
  let baseVig = mix(1.0, baseVignetteFloor, smoothstep(0.32, 0.85, vDist));
  let extraVig = 1.0 - clamp(L.vignette * 0.65, 0.0, 0.92) * smoothstep(0.20, 0.84, vDist);
  c *= baseVig * extraVig;
  if (L.grain > 0.001) {
    let timeSalt = select(0.0, floor(time * 24.0) * 19.37, L.grainAnimated > 0.5);
    let seedVec = vec2f(L.grainSeed * 1.13 + timeSalt, L.grainSeed * 2.71 - timeSalt * 0.63);
    let finePx = floor(fragXY * 0.9) + seedVec;
    let coarsePx = floor(fragXY * 0.45) + seedVec * 1.7 + vec2f(53.0, 91.0);
    let gFine = lookHash12(finePx) + lookHash12(finePx + vec2f(71.0, 193.0)) - 1.0;
    let gCoarse = lookHash12(coarsePx) + lookHash12(coarsePx + vec2f(29.0, 113.0)) - 1.0;
    let grainVal = (gFine * 0.72 + gCoarse * 0.28) * 0.5;
    let midMask = smoothstep(0.004, 0.12, luma) * (1.0 - smoothstep(0.75, 1.0, luma));
    let amp = (0.026 + 0.024 * shaftLift) * L.grain * (0.25 + 0.75 * midMask);
    c = max(vec3f(0.0), c + vec3f(grainVal * amp * max(luma * 2.2, 0.18)));
  }
  return clamp(c, vec3f(0.0), vec3f(1.0));
}
`,
  [LookUniformsStruct],
)

/**
 * Generates the Look Scene WGSL using our typed WGSL module + slot specialization system:
 * 1. Moves palette & wetness material overrides into `postLightMaterial` (after `lightSum`) so VGPRs don't spill across `lightSum`.
 * 2. Specializes `noir` vs `painterly` via `lookVariantSlot`, stripping the 130-line `Painterly` gouache branch when compiling `Noir` (and vice versa).
 * 3. Uses named `LK.<field>` accessors throughout.
 */
export function makeOurTypedLookSceneShader(hooks: SceneHooks = {}, variant: LookVariantMode = "generic"): string {
  const includeNoir = variant === "noir" || variant === "generic"
  const includePainterly = variant === "painterly" || variant === "generic"

  const declBlock = resolveWgsl(
    wgslSnippet(
      "lookSceneDecl",
      () => /* wgsl */ `
${hooks.declarations ?? ""}
@group(0) @binding(7) var<uniform> LK: LookUniforms;
var<private> lookUseAfter: bool;
var<private> lookAlbedo: vec3f;
`,
      [ lookMathSnippet ],
    ),
    [[lookVariantSlot, variant]],
  )

  const postMatBlock = /* wgsl */ `
    ${hooks.postLightMaterial ?? ""}
    if (lookUseAfter) {
      let palMix = LK.paletteMix;
      if (palMix > 0.001) {
        if (mat == 4) { albedo = mix(albedo, pow(max(LK.paletteWall, vec3f(0.02)), vec3f(2.2)), palMix * 0.45); }
        else if (mat == 20) {
          let k = i32(round(o.aux));
          if (k == 4) { albedo = mix(albedo, pow(max(LK.paletteWood, vec3f(0.02)), vec3f(2.2)), palMix * 0.45); }
          else if (k == 6 || k == 2) { albedo = mix(albedo, pow(max(LK.paletteStone, vec3f(0.02)), vec3f(2.2)), palMix * 0.40); }
          else if (k == 1) {
            let roadTarget = select(pow(max(LK.paletteStone * 0.65, vec3f(0.02)), vec3f(2.2)), vec3f(0.115, 0.142, 0.255), i32(round(LK.presetIndex)) == 2);
            albedo = mix(albedo, roadTarget, palMix * 0.52);
          }
          else if (k == 0 || k == 5) { albedo = mix(albedo, pow(max(LK.paletteFoliage, vec3f(0.02)), vec3f(2.2)), palMix * 0.48); }
        } else if (mat == 22) {
          albedo = mix(albedo, pow(max(LK.paletteFoliage, vec3f(0.02)), vec3f(2.2)), palMix * 0.48);
        }
      }
      let folShift = LK.foliageShift;
      if ((mat == 22 || (mat == 20 && (i32(round(o.aux)) == 0 || i32(round(o.aux)) == 5))) && abs(folShift) > 0.001) {
        let warmFol = albedo * vec3f(1.38, 1.08, 0.52);
        let coolFol = vec3f(dot(albedo, vec3f(0.3, 0.5, 0.2))) * vec3f(0.70, 0.86, 0.96);
        albedo = select(mix(albedo, coolFol, clamp(-folShift, 0.0, 1.0)), mix(albedo, warmFol, clamp(folShift, 0.0, 1.0)), folShift >= 0.0);
      }
      let wet = LK.surfaceWetness;
      if (wet > 0.001 && n.y > 0.7 && (mat == 1 || mat == 20)) {
        let puddle = smoothstep(0.34, 0.68, noise2(o.world.xz * 0.65 + vec2f(2.1, 4.7)));
        let wMask = wet * (0.4 + 0.6 * puddle);
        albedo *= 1.0 - 0.28 * wMask;
        gloss = mix(gloss, vec2f(110.0, 1.1), wMask);
      }
      lookAlbedo = albedo;
    }`

  const noirSurfaceWgsl = includeNoir
    ? /* wgsl */ `
    if (i32(round(LK.presetIndex)) == 1) {
      if (mat == 9) { col *= 0.14; }
      if (mat == 4 && !interior(o.world.xz + n.xz * 0.3)) {
        let nearPorch = exp(-pow((o.world.x - 27.7) / 1.8, 2.0)) * step(33.2, o.world.z);
        col *= mix(0.26, 0.85, nearPorch);
      }
      if (mat == 2) {
        let isLitRoomBulb = (o.world.x < 27.5 && o.world.z < 28.5) || (o.world.x > 28.0 && o.world.z > 28.5 && o.world.z < 33.8);
        let isPorchBulb = abs(o.world.x - 27.7) < 2.0 && o.world.z > 33.8 && o.world.z < 36.2;
        if (!isLitRoomBulb && !isPorchBulb) { col *= 0.04; }
      }
      let moonRimDir = normalize(vec3f(-0.35, 0.82, -0.45));
      let topCatch = max(0.22, dot(n, moonRimDir));
      let isRoofOrTree = mat == 21 || mat == 22;
      let surfBoost = select(select(0.42, 0.18, interior(o.world.xz)), 1.35, isRoofOrTree);
      col += lookAlbedo * vec3f(0.048, 0.068, 0.102) * topCatch * surfBoost * LK.moonIntensity;

      if (interior(o.world.xz) && o.world.y < 2.75) {
        let inSW = smoothstep(28.5, 26.8, o.world.x) * smoothstep(28.2, 29.8, o.world.z);
        let inNE = smoothstep(28.0, 29.8, o.world.x) * smoothstep(28.5, 27.0, o.world.z);
        col *= 1.0 - 0.58 * max(inSW, inNE * 0.75);
        let dNW = length(o.world.xz - vec2f(25.1, 25.0));
        let nwWash = exp(-(dNW * dNW) / 4.8) * (0.35 + 0.65 * step(abs(n.y), 0.5));
        col += vec3f(0.036, 0.052, 0.082) * nwWash;
        let dSE = length(o.world.xz - vec2f(31.5, 29.3));
        let seWash = exp(-(dSE * dSE) / 5.8) * (0.3 + 0.7 * step(abs(n.y), 0.5));
        col += vec3f(0.145, 0.068, 0.016) * seWash;
        if (n.y > 0.8 && o.world.y < 0.3) {
          let plankSeam = smoothstep(0.0, 0.08, abs(fract(o.world.z / 0.165 + 0.5) - 0.5));
          col = col * (0.42 + 0.62 * plankSeam) + lookAlbedo * vec3f(0.016, 0.020, 0.026) * plankSeam;
        }
      }
      if (n.y > 0.85 && o.world.y < 0.25) {
        let dxWalk = (o.world.x - 27.7);
        let dzWalk = (o.world.z - 35.2);
        if (dzWalk > -0.5 && dzWalk < 7.2 && abs(dxWalk) < 2.2) {
          let streak = exp(-(dxWalk * dxWalk) / 0.55) * exp(-max(0.0, dzWalk) * 0.34);
          let grit = 0.65 + 0.7 * hash2(floor(o.world.xz * 28.0));
          col += vec3f(0.055, 0.052, 0.044) * streak * grit * LK.surfaceWetness;
        }
      }
      // Evaluate Noir player flashlight surface + volumetric scatter after lightSum (saving registers inside lightSum!)
      if (LK.rimStrength > 1.0 && u32(F.screen.z) > 0u && lights[0].color.w <= 0.001) {
        let pPos = lights[0].pos.xz;
        let isDefaultAim = abs(F.effects.x - (-1.5707963)) < 0.05;
        let aimDir = select(vec2f(cos(F.effects.x), sin(F.effects.x)), normalize(vec2f(0.67, 0.74)), isDefaultAim);
        let handOrigin = pPos + vec2f(0.18, 0.10);
        let dv0 = o.world.xz - handOrigin;
        let along = dot(dv0, aimDir);
        let halfW = 0.14 + along * 0.23;
        let perp = abs(dv0.x * (-aimDir.y) + dv0.y * aimDir.x);
        if (along > 0.05 && along < 14.5 && perp < halfW * 1.35) {
          let d0 = length(dv0);
          let beamMask = exp(-(perp * perp) / (halfW * halfW * 0.55)) * smoothstep(halfW * 1.35, halfW * 0.35, perp);
          if (beamMask > 0.001) {
            let vis0 = shadowAt(0u, pPos, lights[0].pos.y, 0.04, o.world.xz + n.xz * 0.04, o.world.y);
            let fade0 = pow(max(0.0, 1.0 - d0 / 14.5), 1.35) / (1.0 + d0 * 0.18);
            let l30 = normalize(vec3f(handOrigin.x, lights[0].pos.y - 0.35, handOrigin.y) - o.world);
            let ndl0 = max((dot(n, l30) + 0.25) / 1.25, 0.0);
            let torchStr = clamp((LK.rimStrength - 0.8) * 1.65, 0.0, 2.4) * beamMask * fade0 * vis0;
            let inHouse = pPos.y < 35.0;
            let torchCol = select(vec3f(0.76, 0.90, 1.12), vec3f(1.08, 0.92, 0.72), inHouse);
            col += lookAlbedo * torchCol * torchStr * (0.35 + 0.65 * ndl0) * GAIN * 0.5;
            if (o.world.y < 2.1) {
              let hotSpot = exp(-d0 * d0 * 0.55) * 0.85;
              let hazeCol = select(vec3f(0.075, 0.092, 0.118), vec3f(0.115, 0.092, 0.062), inHouse);
              let gritSpec = 0.75 + 0.5 * noise2(o.world.xz * 18.0);
              let plankMod = select(1.0, 0.45 + 0.65 * smoothstep(0.0, 0.08, abs(fract(o.world.z / 0.165 + 0.5) - 0.5)), inHouse && n.y > 0.8);
              col += hazeCol * (fade0 + hotSpot) * beamMask * vis0 * gritSpec * plankMod * (LK.rimStrength * 0.85);
            }
          }
        }
      }
    }`
    : ""

  const painterlySurfaceWgsl = includePainterly
    ? /* wgsl */ `
    if (i32(round(LK.presetIndex)) == 2 || (LK.painterlySmooth > 0.35 && LK.diffuseBands >= 2.0)) {
      let warp = vec2f(noise2(o.world.xz * 2.8 + 1.3) - 0.5, noise2(o.world.xz * 2.8 + 7.9) - 0.5) * 0.35;
      let brushCell = floor((o.world.xz + warp) * 3.6);
      let cellTone = (hash2(brushCell) - 0.5) * 0.22;
      let dab = noise2(o.world.xz * 4.5 + vec2f(o.world.y * 2.1, 3.7)) - 0.5;
      let dabBroad = noise2(o.world.xz * 1.15 + vec2f(7.1, 2.3)) - 0.5;
      let brushStroke = cellTone + dab * 0.16 + dabBroad * 0.14;
      let isIn = interior(o.world.xz) && o.world.y < 2.8;
      let fData = floorData(o.world.xz);
      let ao = 1.0 - fData.r * 0.82 * (1.0 - smoothstep(0.0, 1.1, o.world.y));
      let inCutawayView = F.eye.y < 34.0;
      let extScale = select(1.0, 0.28, inCutawayView);
      if (!isIn) {
        var gouacheAlbedo = lookAlbedo * (1.0 + brushStroke);
        if (mat == 2) {
          col = mix(col, vec3f(1.75, 1.12, 0.42) * (0.85 + 0.3 * extScale), clamp(LK.painterlySmooth, 0.0, 1.0));
        } else if (mat == 6) {
          col = mix(col, vec3f(1.35, 0.88, 0.36) * (0.75 + 0.25 * extScale), clamp(LK.painterlySmooth * 0.7, 0.0, 1.0));
          alpha = max(alpha, 0.55 * clamp(LK.painterlySmooth, 0.0, 1.0));
        } else {
          if (mat == 20) {
            let k = i32(round(o.aux));
            if (k == 1) {
              gouacheAlbedo = mix(lookAlbedo * vec3f(1.25, 1.42, 2.25), vec3f(0.105, 0.132, 0.248), 0.48) * (1.0 + brushStroke * 1.35);
            } else if (k == 2) {
              let jx = smoothstep(0.0, 0.035, abs(fract(o.world.x / 1.6 + 0.5) - 0.5));
              let jz = smoothstep(0.0, 0.035, abs(fract(o.world.z / 1.6 + 0.5) - 0.5));
              let joint = 0.55 + 0.45 * (jx * jz);
              gouacheAlbedo = lookAlbedo * vec3f(1.22, 1.28, 1.62) * joint * (1.0 + brushStroke * 0.75);
            } else if (k == 6) {
              gouacheAlbedo = lookAlbedo * vec3f(1.58, 1.32, 0.98) * (1.0 + brushStroke * 0.85);
            } else if (k == 0 || k == 5) {
              let lushShift = mix(vec3f(0.76, 1.18, 0.64), vec3f(1.26, 1.46, 0.62), clamp(0.5 + dabBroad * 1.4 + cellTone * 1.8, 0.0, 1.0));
              gouacheAlbedo = lookAlbedo * lushShift * (1.08 + brushStroke * 0.85);
            } else if (k == 3) {
              gouacheAlbedo = lookAlbedo * vec3f(1.26, 1.28, 1.46) * (1.0 + brushStroke);
            }
          } else if (mat == 21) {
            let sRow = floor(o.world.z / 0.26);
            let sCol = floor(o.world.x / 0.42 + fract(sRow * 0.5));
            let tileVar = (hash2(vec2f(sCol, sRow)) - 0.5) * 0.34;
            let rowLine = smoothstep(0.0, 0.14, fract(o.world.z / 0.26));
            let colLine = smoothstep(0.0, 0.09, abs(fract(o.world.x / 0.42 + fract(sRow * 0.5) + 0.5) - 0.5));
            let tileSeam = 0.52 + 0.48 * (rowLine * colLine);
            gouacheAlbedo = lookAlbedo * vec3f(1.38, 1.58, 2.45) * (1.0 + tileVar) * tileSeam;
          } else if (mat == 22) {
            let crownH = clamp((o.world.y - 0.3) / 3.6, 0.0, 1.0);
            let sunSide = clamp(n.y * 0.55 - n.x * 0.25 + 0.35 + dab * 0.35, 0.0, 1.0);
            let bandF = lookQuantizeDiffuse(clamp(crownH * 0.5 + sunSide * 0.65, 0.0, 1.0), 0.18, max(3.0, LK.diffuseBands), LK.bandSoftness);
            let folTint = mix(vec3f(0.52, 0.92, 0.64), vec3f(1.46, 1.68, 0.68), bandF);
            gouacheAlbedo = lookAlbedo * folTint * (1.10 + cellTone * 0.9);
          } else if (mat == 4) {
            let lap = 0.72 + 0.28 * smoothstep(0.0, 0.22, fract(o.world.y / 0.18));
            gouacheAlbedo = lookAlbedo * vec3f(1.42, 1.36, 1.32) * lap;
          } else if (mat == 5) {
            gouacheAlbedo = vec3f(0.112, 0.140, 0.258) * (1.0 + brushStroke);
          }
          let dWinL = length(o.world.xz - vec2f(24.5, 35.8));
          let dWinR = length(o.world.xz - vec2f(34.25, 35.8));
          let dPorch = length((o.world.xz - vec2f(27.7, 37.2)) * vec2f(0.82, 0.58));
          let warmSpill = clamp(exp(-(dWinL * dWinL) / 9.5) * 0.75 + exp(-(dWinR * dWinR) / 9.5) * 0.75 + exp(-(dPorch * dPorch) / 16.5) * 1.05, 0.0, 1.35) * step(o.world.y, 2.75);
          let peachLight = vec3f(1.28, 0.82, 0.36) * warmSpill * (0.55 + 0.45 * extScale);
          if (mat == 22 && o.world.z > 34.8 && o.world.z < 37.2 && o.world.x > 22.0 && o.world.x < 36.8) {
            let blossom = smoothstep(0.24, 0.44, hash2(floor(o.world.xz * 5.5)));
            gouacheAlbedo = mix(gouacheAlbedo, vec3f(0.68, 0.54, 0.26), blossom * 0.65);
          }
          let hemiN = 0.62 + 0.38 * clamp(n.y * 0.5 + 0.5, 0.0, 1.0);
          let skyAmb = vec3f(0.62, 0.68, 0.90) * hemiN * ao * extScale;
          let paintedExt = col * 0.32 + gouacheAlbedo * (skyAmb + peachLight * 1.38) + peachLight * 0.045 * ao;
          col = mix(col, paintedExt, clamp(LK.painterlySmooth, 0.0, 1.0));
        }
      } else {
        var intAlbedo = lookAlbedo * (1.0 + brushStroke * 0.65);
        if (n.y > 0.75 && o.world.y < 0.28) {
          let row = floor(o.world.z / 0.20);
          let plank = floor((o.world.x + fract(row * 0.37) * 1.4) / 1.45);
          let bTone = (hash2(vec2f(row, plank)) - 0.5) * 0.28;
          let seamZ = smoothstep(0.0, 0.08, abs(fract(o.world.z / 0.20 + 0.5) - 0.5));
          let seamX = smoothstep(0.0, 0.04, abs(fract((o.world.x + fract(row * 0.37) * 1.4) / 1.45 + 0.5) - 0.5));
          intAlbedo = lookAlbedo * vec3f(1.22, 0.84, 0.46) * (1.0 + bTone) * (0.42 + 0.58 * (seamZ * seamX));
        } else if (mat == 4) {
          let isUpper = smoothstep(0.88, 1.12, o.world.y);
          intAlbedo = mix(lookAlbedo * vec3f(0.52, 0.62, 0.52) * (1.0 + brushStroke * 0.8), lookAlbedo * vec3f(1.08, 0.94, 0.80) * (1.0 + brushStroke * 0.8), isUpper);
        } else if (mat == 0) {
          intAlbedo = lookAlbedo * vec3f(0.95, 0.90, 0.78) * (0.52 + 0.48 * clamp(n.y * 0.6 + 0.4, 0.0, 1.0));
        }
        let dNW = length(o.world.xz - vec2f(25.2, 25.4));
        let dSW = length(o.world.xz - vec2f(23.6, 32.6));
        let dSE = length(o.world.xz - vec2f(31.5, 30.6));
        let dNE = length(o.world.xz - vec2f(30.4, 26.8));
        let dHall = length(o.world.xz - vec2f(27.7, 29.5));
        let warmPool = exp(-(dNW * dNW) / 8.5) * 0.75 + exp(-(dSW * dSW) / 7.5) * 0.65 + exp(-(dSE * dSE) / 9.5) * 0.82 + exp(-(dNE * dNE) / 8.0) * 0.62 + exp(-(dHall * dHall) / 12.0) * 0.35;
        let hemiIn = 0.58 + 0.42 * clamp(n.y * 0.5 + 0.5, 0.0, 1.0);
        let roomLight = (vec3f(0.24, 0.22, 0.22) + vec3f(0.78, 0.50, 0.22) * warmPool) * hemiIn * ao;
        col = mix(col, col * 0.38 + intAlbedo * roomLight + vec3f(0.032, 0.018, 0.006) * warmPool * ao, clamp(LK.painterlySmooth, 0.0, 1.0));
      }
      if (mat == 9) { col = mix(col, vec3f(0.042, 0.050, 0.082) * (1.0 + dab * 0.16), clamp(LK.painterlySmooth, 0.0, 1.0)); }
      if (mat == 3) { col = mix(col, vec3f(1.55, 1.02, 0.42), clamp(LK.painterlySmooth * 0.85, 0.0, 1.0)); }
    }`
    : ""

  const base = makeSceneShader({
    ...hooks,
    declarations: declBlock,
    fragmentStart: `${hooks.fragmentStart ?? ""}\n  let lookScreenX = o.pos.x / max(1.0, F.screen.x);\n  let lookCompare = i32(round(LK.compareMode));\n  lookUseAfter = select(lookCompare == 1, lookScreenX >= LK.wipeSplit, lookCompare == 2) && LK.activeFlag > 0.5;\n  lookAlbedo = o.color;\n  if (lookUseAfter) { surfaceFootprint = max(surfaceFootprint, LK.painterlySmooth * 0.012); }\n`,
    material: hooks.material ?? "",
    postLightMaterial: postMatBlock,
    surface: `${hooks.surface ?? ""}\n  if (lookUseAfter) {
    let ndv = clamp(dot(n, V), 0.0, 1.0);
    let rimW = select(0.75, 1.65, mat == 12 || mat == 22 || mat == 0);
    let rim = pow(1.0 - ndv, 2.6) * LK.rimStrength * rimW;
    let shadowCol = vec3f(LK.shadowColorR, LK.shadowColorG, LK.shadowColorB);
    let rimTint = mix(vec3f(0.55, 0.72, 1.0) * shadowCol, vec3f(1.0, 0.80, 0.52), clamp(LK.temperature * 0.5 + 0.25, 0.0, 1.0));
    col += rimTint * rim * 0.065;
    if (LK.contactShade > 0.001 && mat != 2 && mat != 3 && mat != 11) {
      let fOcc = floorData(o.world.xz).r * (1.0 - smoothstep(0.0, 1.1, o.world.y));
      col *= 1.0 - clamp(fOcc * LK.contactShade * 0.62, 0.0, 0.78);
    }
    let fogDens = LK.fogDensity;
    let shaftStr = LK.shaftStrength;
    if (fogDens > 0.001 || shaftStr > 0.001) {
      let hFall = max(0.35, LK.fogHeightFalloff);
      let rayVec = o.world - F.cam.xyz;
      let rayDist = max(length(rayVec), 0.001);
      let kVert = (rayVec.y / rayDist) / hFall;
      let dPlanFocus = length(o.world.xz - F.eye.xy);
      let s0 = min(rayDist, max(0.0, rayDist - max(0.0, dPlanFocus - 12.0) * 1.25));
      let vertInt = select(
        (rayDist - s0) * exp(-0.5 * (F.cam.y + o.world.y) / hFall),
        exp(-F.cam.y / hFall) * (exp(-s0 * kVert) - exp(-rayDist * kVert)) / kVert,
        abs(kVert) > 1e-3
      );
      let fogTau = clamp(fogDens * 0.016 * max(0.0, vertInt), 0.0, 2.5);
      let trans = exp(-fogTau);
      let fogCol = pow(max(vec3f(LK.fogColorR, LK.fogColorG, LK.fogColorB), vec3f(0.002)), vec3f(2.2)) * clamp(LK.ambientFill * 0.45, 0.02, 1.0);
      var shaftAdd = vec3f(0.0);
      if (shaftStr > 0.001 && o.world.x > 30.5 && o.world.x < 34.8 && o.world.z > 24.5 && o.world.z < 33.5 && o.world.y < 2.2) {
        let eastDist = max(0.0, 34.3 - o.world.x);
        let winZ1 = exp(-pow((o.world.z - 26.8) / 0.95, 2.0));
        let winZ2 = exp(-pow((o.world.z - 30.8) / 0.95, 2.0));
        let winBeam = (winZ1 + winZ2) * exp(-eastDist * 0.65) * (1.0 - smoothstep(1.2, 2.2, o.world.y));
        let shaftCol = mix(vec3f(0.55, 0.76, 1.12), vec3f(1.05, 0.78, 0.45), clamp(LK.temperature * 0.5 + 0.25, 0.0, 1.0));
        shaftAdd = shaftCol * winBeam * shaftStr * 0.042;
      }
      col = col * trans + fogCol * (1.0 - trans) + shaftAdd;
    }
    ${noirSurfaceWgsl}
    ${painterlySurfaceWgsl}
  }\n`,
  })

  // Lightweight Look hooks inside lightSum (without the heavy 37-line shadowAt(0u) flashlight block that caused register spills!)
  return base
    .replace(
      "let diffuse = max((ndl + wrap) / (1.0 + wrap), 0.0);",
      includePainterly
        ? `let useLookLight = LK.activeFlag > 0.5;
    let effWrap = select(wrap, wrap + LK.diffuseWrap, useLookLight);
    let effBands = select(0.0, LK.diffuseBands, useLookLight);
    let effSoft = select(0.18, LK.bandSoftness, useLookLight);
    let diffuse = lookQuantizeDiffuse(ndl, effWrap, effBands, effSoft);`
        : `let effWrap = select(wrap, wrap + LK.diffuseWrap, LK.activeFlag > 0.5);
    let diffuse = max((ndl + effWrap) / (1.0 + max(effWrap, 0.0)), 0.0);`,
    )
    .replace(
      "if (L.extra.y > 0.5) { vis = shadowAt(i, lp, hl, L.extra.z, sp, world.y); }\n    out.diff += L.color.rgb * att * (diffuse * vis +",
      `if (L.extra.y > 0.5) { vis = shadowAt(i, lp, hl, L.extra.z, sp, world.y); }
    var lCol = select(L.color.rgb, lookPracticalColor(L.color.rgb, LK.practicalWarmth) * LK.practicalIntensity, LK.activeFlag > 0.5);
    ${
      includeNoir
        ? `if (LK.activeFlag > 0.5 && i32(round(LK.presetIndex)) == 1) {
      if (hl > 3.2) { lCol *= 0.08; }
      else if (L.cone.w < -0.5) {
        let isNWBedroom = lp.x < 27.5 && lp.y < 28.5;
        let isSEDining = lp.x > 28.0 && lp.y > 28.5;
        if (isNWBedroom) { lCol = vec3f(0.58, 0.76, 1.08) * 0.85; }
        else if (isSEDining) { lCol = vec3f(1.22, 0.68, 0.24) * 1.15; }
        else { lCol *= 0.06; }
      } else if (L.cone.w > 0.5 && lp.x < 26.5) { lCol *= 0.08; }
    }`
        : ""
    }
    out.diff += lCol * att * (diffuse * vis +`,
    )
    .replace("out.spec += L.color.rgb * att * s * vis;", "out.spec += lCol * att * s * vis;")
    .replace(
      "col = albedo * (amb + direct + moon)",
      `if (lookUseAfter) {
      amb *= LK.ambientFill * vec3f(LK.shadowColorR, LK.shadowColorG, LK.shadowColorB);
    }
    let effMoon = select(moon, moon * LK.moonIntensity, lookUseAfter);
    col = albedo * (amb + direct + effMoon)`,
    )
}

export function makeOurTypedLookPostShader(finish?: PostFinishOptions, variant: LookVariantMode = "generic"): string {
  const includeKuwahara = variant === "painterly" || variant === "generic"
  const postRoot = wgslSnippet(
    `lookPost_${variant}`,
    () => /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> P: vec4f;
@group(0) @binding(3) var bloomTex: texture_2d<f32>;

struct GradeAndLook {
  G: vec4f,
  pad: vec4f,
  L: LookUniforms,
}
@group(0) @binding(4) var<uniform> GL: GradeAndLook;
${postCommonWgsl}

${
  includeKuwahara
    ? `fn kuwaharaPost(uv: vec2f, texel: vec2f, strength: f32) -> vec3f {
  let center = clean(textureSampleLevel(src, samp, uv, 0.0)).rgb;
  if (strength <= 0.01) { return center; }
  let pxCoord = uv / max(texel, vec2f(1e-5));
  let dabAng = hash(floor(pxCoord * 0.28)) * 6.2831853;
  let dabWarp = vec2f(cos(dabAng), sin(dabAng)) * texel * (0.85 * strength);
  let uvW = clamp(uv + dabWarp, vec2f(0.002), vec2f(0.998));
  let r1 = texel * (0.9 + strength * 0.7);
  let r2 = texel * (1.6 + strength * 1.1);
  let lw = vec3f(0.2126, 0.7152, 0.0722);
  var m = array<vec3f, 4>(center, center, center, center);
  var s2 = array<f32, 4>(0.0, 0.0, 0.0, 0.0);
  let lC = dot(center, lw);
  for (var q = 0; q < 4; q++) {
    let sx = select(-1.0, 1.0, (q & 1) != 0);
    let sy = select(-1.0, 1.0, (q & 2) != 0);
    let d = vec2f(sx, sy);
    let c1 = clean(textureSampleLevel(src, samp, clamp(uvW + d * r1, vec2f(0.002), vec2f(0.998)), 0.0)).rgb;
    let c2 = clean(textureSampleLevel(src, samp, clamp(uvW + vec2f(d.x * r2.x, d.y * r1.y), vec2f(0.002), vec2f(0.998)), 0.0)).rgb;
    let c3 = clean(textureSampleLevel(src, samp, clamp(uvW + vec2f(d.x * r1.x, d.y * r2.y), vec2f(0.002), vec2f(0.998)), 0.0)).rgb;
    let c4 = clean(textureSampleLevel(src, samp, clamp(uvW + d * r2, vec2f(0.002), vec2f(0.998)), 0.0)).rgb;
    let mean = (center + c1 + c2 + c3 + c4) * 0.2;
    let l1 = dot(c1, lw); let l2 = dot(c2, lw); let l3 = dot(c3, lw); let l4 = dot(c4, lw);
    let lm = (lC + l1 + l2 + l3 + l4) * 0.2;
    let v = (lC - lm)*(lC - lm) + (l1 - lm)*(l1 - lm) + (l2 - lm)*(l2 - lm) + (l3 - lm)*(l3 - lm) + (l4 - lm)*(l4 - lm);
    m[q] = mean;
    s2[q] = v;
  }
  let w0 = 1.0 / (1.0 + s2[0] * 1400.0);
  let w1 = 1.0 / (1.0 + s2[1] * 1400.0);
  let w2 = 1.0 / (1.0 + s2[2] * 1400.0);
  let w3 = 1.0 / (1.0 + s2[3] * 1400.0);
  let painted = (m[0] * w0 + m[1] * w1 + m[2] * w2 + m[3] * w3) / (w0 + w1 + w2 + w3);
  return mix(center, painted, clamp(strength, 0.0, 1.0));
}`
    : ""
}

@fragment fn composite(o: VO) -> @location(0) vec4f {
  let G = GL.G;
  let L = GL.L;
  let uv = o.uv;
  let dims = vec2f(textureDimensions(src));
  let texel = 1.0 / max(dims, vec2f(1.0));
  let fromC = uv - 0.5;
  let compareMode = i32(round(L.compareMode));
  let wipeSplit = L.wipeSplit;
  let useLook = select(compareMode == 1, uv.x >= wipeSplit, compareMode == 2) && L.activeFlag > 0.5;

  let baseCA = ${finish ? finish.chromatic.toFixed(4) : "0.012"};
  let baseBloom = ${finish ? finish.bloom.toFixed(4) : "0.32"};
  let baseVig = ${finish ? finish.vignette.toFixed(4) : "0.45"};
  let baseGrain = ${finish ? finish.grain.toFixed(4) : "0.022"};
  let baseHuePres = ${finish?.huePreserve ? finish.huePreserve.toFixed(4) : "0.0"};
  let baseShadowLift = ${finish?.shadowLift === undefined ? "1.0" : finish.shadowLift.toFixed(4)};

  let bloom = textureSampleLevel(bloomTex, samp, uv, 0.0).rgb;
  if (!useLook) {
    let ca = fromC * dot(fromC, fromC) * baseCA;
    var hdr = vec3f(
      clean(textureSampleLevel(src, samp, uv + ca, 0.0)).r,
      clean(textureSampleLevel(src, samp, uv, 0.0)).g,
      clean(textureSampleLevel(src, samp, uv - ca, 0.0)).b,
    );
    hdr = hdr + bloom * ${finish?.halation ? `(baseBloom + vec3f(1.08, 0.36, 0.12) * ${finish.halation.toFixed(4)})` : "baseBloom"};
    var c = aces(hdr * G.w);
    if (baseHuePres > 0.0) {
      let exposed = max(hdr * G.w, vec3f(0.0));
      let peak = max(exposed.r, max(exposed.g, exposed.b));
      c = mix(c, exposed * (aces(vec3f(peak)).r / max(peak, 0.0001)), baseHuePres);
    }
    let l = dot(c, vec3f(0.2126, 0.7152, 0.0722));
    c = mix(vec3f(l), c, ${finish?.saturation !== undefined ? `${finish.saturation.toFixed(4)} * ` : ""}(1.0 - G.y));
    c += ${finish?.shadowLiftColor ? `vec3f(${finish.shadowLiftColor.map(v => v.toFixed(4)).join(", ")})` : "vec3f(0.006, 0.011, 0.028)"} * baseShadowLift * (1.0 - smoothstep(0.0, 0.25, l));
    c *= mix(${finish?.shadowTint ? `vec3f(${finish.shadowTint.map(v => v.toFixed(4)).join(", ")})` : "vec3f(0.93, 0.97, 1.06)"}, ${finish?.highlightTint ? `vec3f(${finish.highlightTint.map(v => v.toFixed(4)).join(", ")})` : "vec3f(1.04, 1.0, 0.95)"}, smoothstep(0.2, 0.8, l));
    let v = length(fromC * vec2f(1.0, 0.8));
    c *= mix(1.0, baseVig, smoothstep(0.32, 0.85, v));
    c = mix(c, vec3f(0.55, 0.05, 0.06), G.z * smoothstep(0.25, 0.85, v));
    c = pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.2));
    let px = o.pos.xy;
    let grain = hash(px + fract(G.x * 13.7) * 1000.0) + hash(px * 1.37 + fract(G.x * 7.3) * 500.0) - 1.0;
    ${finish?.shadowLiftColor ? `let midMask = smoothstep(0.02, 0.20, l) * (1.0 - smoothstep(0.75, 1.0, l));
    c += grain * baseGrain * (0.25 + 0.75 * midMask);
    let ign = fract(52.9829189 * fract(dot(floor(px), vec2f(0.06711056, 0.00583715))));
    c += (ign - 0.5) / 255.0 * step(0.001, l);` : `c += grain * baseGrain * (1.0 - l * 0.6);`}
    if (compareMode == 2) {
      let line = 1.0 - smoothstep(texel.x * 1.2, texel.x * 2.8, abs(uv.x - wipeSplit));
      c = mix(c, vec3f(0.92, 0.96, 1.0), line * 0.85);
    }
    return vec4f(c, 1.0);
  }

  let caAmt = baseCA + L.chromatic * 0.016;
  let ca = fromC * dot(fromC, fromC) * caAmt;
  var hdr: vec3f;
  ${
    includeKuwahara
      ? `if (L.painterlySmooth > 0.01) {
    hdr = kuwaharaPost(uv, texel, L.painterlySmooth);
  } else `
      : ""
  }if (caAmt > 0.0005) {
    hdr = vec3f(
      clean(textureSampleLevel(src, samp, clamp(uv + ca, vec2f(0.001), vec2f(0.999)), 0.0)).r,
      clean(textureSampleLevel(src, samp, uv, 0.0)).g,
      clean(textureSampleLevel(src, samp, clamp(uv - ca, vec2f(0.001), vec2f(0.999)), 0.0)).b,
    );
  } else {
    hdr = clean(textureSampleLevel(src, samp, uv, 0.0)).rgb;
  }

  if (L.outlineStrength > 0.001) {
    let stepUv = texel * L.outlineWidth;
    let cR = clean(textureSampleLevel(src, samp, clamp(uv + vec2f(stepUv.x, 0.0), vec2f(0.001), vec2f(0.999)), 0.0)).rgb;
    let cL = clean(textureSampleLevel(src, samp, clamp(uv - vec2f(stepUv.x, 0.0), vec2f(0.001), vec2f(0.999)), 0.0)).rgb;
    let cU = clean(textureSampleLevel(src, samp, clamp(uv - vec2f(0.0, stepUv.y), vec2f(0.001), vec2f(0.999)), 0.0)).rgb;
    let cD = clean(textureSampleLevel(src, samp, clamp(uv + vec2f(0.0, stepUv.y), vec2f(0.001), vec2f(0.999)), 0.0)).rgb;
    let grad = (length(cR - cL) + length(cU - cD)) / max(0.08, length(hdr) + 0.12);
    let edge = smoothstep(0.32, 0.95, grad) * clamp(L.outlineStrength, 0.0, 1.2);
    let inkCol = vec3f(0.03, 0.035, 0.055) * (0.45 + L.inkLuma);
    hdr = mix(hdr, inkCol, clamp(edge, 0.0, 0.85));
  }

  var c = lookGradeColor(
    L,
    hdr * G.w,
    bloom,
    uv,
    o.pos.xy,
    G.x,
    clamp(L.shaftStrength * 0.35, 0.0, 1.0),
    baseBloom,
    baseVig,
    baseHuePres,
  );
  let v = length(fromC * vec2f(1.0, 0.8));
  c = mix(c, vec3f(0.55, 0.05, 0.06), G.z * smoothstep(0.25, 0.85, v));
  c = pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.2));
  if (compareMode == 2) {
    let line = 1.0 - smoothstep(texel.x * 1.2, texel.x * 2.8, abs(uv.x - wipeSplit));
    c = mix(c, vec3f(0.92, 0.96, 1.0), line * 0.85);
  }
  return vec4f(clamp(c, vec3f(0.0), vec3f(1.0)), 1.0);
}
`,
    [lookGradeSnippet],
  )

  return resolveWgsl(postRoot, [[lookVariantSlot, variant]])
}
