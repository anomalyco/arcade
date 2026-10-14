import { lookStructWgsl } from "./look"
import { makeSceneShader, postCommonWgsl, type SceneHooks } from "./shaders"

export type PostFinishOptions = {
  chromatic: number
  bloom: number
  grain: number
  vignette: number
  diagnostics?: boolean
  shadowLift?: number
  huePreserve?: number
  halation?: number
  saturation?: number
  shadowLiftColor?: readonly [number, number, number]
  shadowTint?: readonly [number, number, number]
  highlightTint?: readonly [number, number, number]
}

/**
 * Opt-in Look-enabled scene shader generator.
 * Binds `LookUniforms` at `@group(0) @binding(7)` (unused when motion blur is off).
 * Default `makeSceneShader` remains untouched for bit-exact identity under "Current".
 */
export const makeLookSceneShader = (hooks: SceneHooks = {}): string => {
  if (hooks.postLightMaterial) {
    // Fast-path for games with postLightMaterial (Outbreak): keep register pressure identical to makeSceneShader
    // while writing per-pixel flashlight irradiance into the HDR target's alpha channel.
    const base = makeSceneShader({
      ...hooks,
      declarations: `${hooks.declarations ?? ""}\n${lookStructWgsl}\n@group(0) @binding(7) var<uniform> LK: LookUniforms;\n`,
      surface: `${hooks.surface ?? ""}
  let lookCompare = i32(round(LK.u12.w));
  let lookUseAfter = select(lookCompare == 1, (o.pos.x / max(1.0, F.screen.x)) >= LK.u13.w, lookCompare == 2) && LK.u11.w > 0.5;
  let lookFlashIrradiance = select(0.0, clamp(outbreakFlashMask, 0.0, 1.0), lookUseAfter);
  if (lookUseAfter) {
    let presetIdx = i32(round(LK.u14.w));
    if (presetIdx == 1) {
      if (mat == 9) { col *= 0.14; }
      let moonRimDir = normalize(vec3f(-0.35, 0.82, -0.45));
      let topCatch = max(0.22, dot(n, moonRimDir));
      let surfBoost = select(select(0.48, 0.24, interior(o.world.xz)), 1.38, mat == 21 || mat == 22);
      col += o.color * vec3f(0.054, 0.074, 0.110) * topCatch * surfBoost * LK.u5.z;
      if (mat != 12) {
        col += (o.color * 0.85 + vec3f(0.072, 0.062, 0.044)) * lookFlashIrradiance * 0.58;
      } else {
        col += o.color * vec3f(0.65, 0.62, 0.52) * lookFlashIrradiance;
      }
    } else if (presetIdx == 2 || LK.u10.w > 0.35) {
      let dab = noise2(o.world.xz * 3.8 + vec2f(o.world.y * 1.8, 3.7)) - 0.5;
      let tint = select(vec3f(0.88, 0.94, 1.18), vec3f(1.22, 0.96, 0.68), interior(o.world.xz) && o.world.y < 2.8);
      col = mix(col, col * tint * (1.0 + dab * 0.22), clamp(LK.u10.w * 0.65, 0.0, 0.85));
    }
  }
`,
    })
    return base.replace(
      "return vec4f(select(col * a, col, mat == 22 && o.aux >= -1.5), a);",
      `let outRgb = select(col * a, col, mat == 22 && o.aux >= -1.5);
  let outAlpha = select(a, 1.0 - lookFlashIrradiance, a >= 0.999);
  return vec4f(outRgb, outAlpha);`,
    )
  }

  const postMat = `    if (lookUseAfter) {
      let wet = LK.u6.y;
      if (wet > 0.001 && n.y > 0.7 && (mat == 1 || mat == 20)) {
        let puddle = smoothstep(0.34, 0.68, noise2(o.world.xz * 0.65 + vec2f(2.1, 4.7)));
        let wMask = wet * (0.4 + 0.6 * puddle);
        albedo *= 1.0 - 0.28 * wMask;
        gloss = mix(gloss, vec2f(110.0, 1.1), wMask);
      }
      lookAlbedo = albedo;
    }\n`
  const base = makeSceneShader({
    ...hooks,
    declarations: `${hooks.declarations ?? ""}\n${lookStructWgsl}\n@group(0) @binding(7) var<uniform> LK: LookUniforms;\nvar<private> lookUseAfter: bool;\nvar<private> lookAlbedo: vec3f;\nvar<private> lookFlashIrradiance: f32;\n`,
    fragmentStart: `${hooks.fragmentStart ?? ""}\n  let lookScreenX = o.pos.x / max(1.0, F.screen.x);\n  let lookCompare = i32(round(LK.u12.w));\n  lookUseAfter = select(lookCompare == 1, lookScreenX >= LK.u13.w, lookCompare == 2) && LK.u11.w > 0.5;\n  lookAlbedo = o.color;\n  lookFlashIrradiance = 0.0;\n  if (lookUseAfter) { surfaceFootprint = max(surfaceFootprint, LK.u10.w * 0.012); }\n`,
    material: `${hooks.material ?? ""}\n    ${postMat}`,
    surface: `${hooks.surface ?? ""}\n  if (lookUseAfter) {
    if (u32(F.screen.z) > 1u && lights[1].cone.w > 0.5 && lights[1].extra.w < -0.5 && lights[1].color.w > 0.001) {
      let fOrig = lights[1].pos.xz;
      let fDir = lights[1].cone.xy;
      let rel = o.world.xz - fOrig;
      let d0 = length(rel);
      let along = dot(rel, fDir);
      let perp = abs(rel.x * (-fDir.y) + rel.y * fDir.x);
      let maxR = max(8.0, lights[1].pos.w * 1.15);
      if (along > 0.0 && d0 < maxR) {
        let halfW = 0.20 + along * 0.34;
        let beamMask = exp(-(perp * perp) / (halfW * halfW * 0.72)) * smoothstep(halfW * 1.5, halfW * 0.28, perp);
        let aF = (atan2(rel.y, rel.x) + TAU) % TAU;
        let rayF = u32(i32(floor(aF / TAU * f32(RAYS))) + i32(RAYS)) % RAYS;
        let hitF = polar[(RAYS + rayF) * 2u].x;
        let vis0 = 1.0 - smoothstep(hitF - 0.05, hitF + 0.20, d0);
        let fade0 = pow(max(0.0, 1.0 - d0 / maxR), 1.25);
        lookFlashIrradiance = max(lookFlashIrradiance, clamp(beamMask * fade0 * vis0 * 2.8, 0.0, 1.0));
      }
    }
    // Rim / silhouette light on characters, trees, props & wall edges
    let ndv = clamp(dot(n, V), 0.0, 1.0);
    let rimW = select(0.75, 1.85, mat == 12 || mat == 22 || mat == 0);
    let contourTerm = select(0.0, pow(clamp(length(n.xz), 0.0, 1.0), 1.45) * smoothstep(0.20, 1.62, o.world.y) * 1.15, mat == 12);
    let rim = max(pow(1.0 - ndv, 2.4), contourTerm) * LK.u5.w * rimW;
    let rimTint = mix(vec3f(0.68, 0.80, 1.0) * LK.u4.yzw, vec3f(1.0, 0.80, 0.52), clamp(LK.u1.w * 0.5 + 0.25, 0.0, 1.0));
    col += rimTint * rim * 0.075;

    // Extra contact / cavity shading
    if (LK.u6.x > 0.001 && mat != 2 && mat != 3 && mat != 11) {
      let fOcc = floorData(o.world.xz).r * (1.0 - smoothstep(0.0, 1.1, o.world.y));
      col *= 1.0 - clamp(fOcc * LK.u6.x * 0.62, 0.0, 0.78);
    }

    // Closed-form 3D settled height fog & localized east-window moonlight shaft
    let fogDens = LK.u6.z;
    let shaftStr = LK.u7.w;
    if (fogDens > 0.001 || shaftStr > 0.001) {
      let hFall = max(0.35, LK.u6.w);
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
      let fogCol = pow(max(LK.u7.xyz, vec3f(0.002)), vec3f(2.2)) * clamp(LK.u4.x * 0.45, 0.02, 1.0);
      var shaftAdd = vec3f(0.0);
      if (shaftStr > 0.001 && o.world.x > 30.5 && o.world.x < 34.8 && o.world.z > 24.5 && o.world.z < 33.5 && o.world.y < 2.2) {
        let eastDist = max(0.0, 34.3 - o.world.x);
        let winZ1 = exp(-pow((o.world.z - 26.8) / 0.95, 2.0));
        let winZ2 = exp(-pow((o.world.z - 30.8) / 0.95, 2.0));
        let winBeam = (winZ1 + winZ2) * exp(-eastDist * 0.65) * (1.0 - smoothstep(1.2, 2.2, o.world.y));
        let shaftCol = mix(vec3f(0.55, 0.76, 1.12), vec3f(1.05, 0.78, 0.45), clamp(LK.u1.w * 0.5 + 0.25, 0.0, 1.0));
        shaftAdd = shaftCol * winBeam * shaftStr * 0.042;
      }
      col = col * trans + fogCol * (1.0 - trans) + shaftAdd;
    }
    // Cold steel-blue moonlight rim and room wall-wash halos in Noir mode
    if (i32(round(LK.u14.w)) == 1) {
      if (mat == 9) {
        col *= 0.14;
      }
      if (mat == 4 && !interior(o.world.xz + n.xz * 0.3)) {
        let nearPorch = exp(-pow((o.world.x - 27.7) / 1.8, 2.0)) * step(33.2, o.world.z);
        col *= mix(0.26, 0.85, nearPorch) * (0.45 + 0.55 * lookFlashIrradiance);
      }
      if (mat == 2) {
        let isLitRoomBulb = (o.world.x < 27.5 && o.world.z < 28.5) || (o.world.x > 28.0 && o.world.z > 28.5 && o.world.z < 33.8);
        let isPorchBulb = abs(o.world.x - 27.7) < 2.0 && o.world.z > 33.8 && o.world.z < 36.2;
        if (!isLitRoomBulb && !isPorchBulb) {
          col *= 0.04;
        }
      }
      let moonRimDir = normalize(vec3f(-0.35, 0.82, -0.45));
      let topCatch = max(0.22, dot(n, moonRimDir));
      let isRoofOrTree = mat == 21 || mat == 22;
      let surfBoost = select(select(0.42, 0.18, interior(o.world.xz)), 1.35, isRoofOrTree);
      col += lookAlbedo * vec3f(0.048, 0.068, 0.102) * topCatch * surfBoost * LK.u5.z;
    }

    // Painterly gouache twilight choreography (only evaluated when preset == 2 or painterlySmooth > 0.35)
    if (i32(round(LK.u14.w)) == 2 || (LK.u10.w > 0.35 && LK.u10.y >= 2.0)) {
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
          col = mix(col, vec3f(1.75, 1.12, 0.42) * (0.85 + 0.3 * extScale), clamp(LK.u10.w, 0.0, 1.0));
        } else if (mat == 6) {
          col = mix(col, vec3f(1.35, 0.88, 0.36) * (0.75 + 0.25 * extScale), clamp(LK.u10.w * 0.7, 0.0, 1.0));
          alpha = max(alpha, 0.55 * clamp(LK.u10.w, 0.0, 1.0));
        } else {
          if (mat == 20) {
            let k = i32(round(o.aux));
            if (k == 1) {
              gouacheAlbedo = mix(lookAlbedo * vec3f(1.25, 1.42, 2.25), vec3f(0.105, 0.132, 0.248), 0.48) * (1.0 + brushStroke * 1.35);
            } else if (k == 2) {
              gouacheAlbedo = lookAlbedo * vec3f(1.22, 1.28, 1.62) * (1.0 + brushStroke * 0.75);
            } else if (k == 6) {
              gouacheAlbedo = lookAlbedo * vec3f(1.58, 1.32, 0.98) * (1.0 + brushStroke * 0.85);
            } else if (k == 0 || k == 5) {
              let lushShift = mix(vec3f(0.76, 1.18, 0.64), vec3f(1.26, 1.46, 0.62), clamp(0.5 + dabBroad * 1.4 + cellTone * 1.8, 0.0, 1.0));
              gouacheAlbedo = lookAlbedo * lushShift * (1.08 + brushStroke * 0.85);
            } else if (k == 3) {
              gouacheAlbedo = lookAlbedo * vec3f(1.26, 1.28, 1.46) * (1.0 + brushStroke);
            }
          } else if (mat == 21) {
            gouacheAlbedo = lookAlbedo * vec3f(1.38, 1.58, 2.45) * (1.0 + brushStroke * 0.65);
          } else if (mat == 22) {
            let crownH = clamp((o.world.y - 0.3) / 3.6, 0.0, 1.0);
            let sunSide = clamp(n.y * 0.55 - n.x * 0.25 + 0.35 + dab * 0.35, 0.0, 1.0);
            let bandF = lookQuantizeDiffuse(clamp(crownH * 0.5 + sunSide * 0.65, 0.0, 1.0), 0.18, max(3.0, LK.u10.y), LK.u10.z);
            let folTint = mix(vec3f(0.52, 0.92, 0.64), vec3f(1.46, 1.68, 0.68), bandF);
            gouacheAlbedo = lookAlbedo * folTint * (1.10 + cellTone * 0.9);
          } else if (mat == 4) {
            let lap = 0.72 + 0.28 * smoothstep(0.0, 0.22, fract(o.world.y / 0.18));
            gouacheAlbedo = lookAlbedo * vec3f(1.42, 1.36, 1.32) * lap;
          }
          let dWinL = length(o.world.xz - vec2f(24.5, 35.8));
          let dWinR = length(o.world.xz - vec2f(34.25, 35.8));
          let dPorch = length((o.world.xz - vec2f(27.7, 37.2)) * vec2f(0.82, 0.58));
          let warmSpill = clamp(exp(-(dWinL * dWinL) / 9.5) * 0.75 + exp(-(dWinR * dWinR) / 9.5) * 0.75 + exp(-(dPorch * dPorch) / 16.5) * 1.05, 0.0, 1.35) * step(o.world.y, 2.75);
          let peachLight = vec3f(1.28, 0.82, 0.36) * warmSpill * (0.55 + 0.45 * extScale);
          let hemiN = 0.62 + 0.38 * clamp(n.y * 0.5 + 0.5, 0.0, 1.0);
          let skyAmb = vec3f(0.62, 0.68, 0.90) * hemiN * ao * extScale;
          let paintedExt = col * 0.32 + gouacheAlbedo * (skyAmb + peachLight * 1.38) + peachLight * 0.045 * ao;
          col = mix(col, paintedExt, clamp(LK.u10.w, 0.0, 1.0));
        }
      } else {
        var intAlbedo = lookAlbedo * (1.0 + brushStroke * 0.65);
        if (n.y > 0.75 && o.world.y < 0.28) {
          intAlbedo = lookAlbedo * vec3f(1.22, 0.84, 0.46) * (1.0 + brushStroke * 0.5);
        } else if (mat == 4) {
          let isUpper = smoothstep(0.88, 1.12, o.world.y);
          intAlbedo = mix(lookAlbedo * vec3f(0.52, 0.62, 0.52), lookAlbedo * vec3f(1.08, 0.94, 0.80), isUpper) * (1.0 + brushStroke * 0.8);
        }
        let dNW = length(o.world.xz - vec2f(25.2, 25.4));
        let dSW = length(o.world.xz - vec2f(23.6, 32.6));
        let dSE = length(o.world.xz - vec2f(31.5, 30.6));
        let dNE = length(o.world.xz - vec2f(30.4, 26.8));
        let warmPool = exp(-(dNW * dNW) / 8.5) * 0.75 + exp(-(dSW * dSW) / 7.5) * 0.65 + exp(-(dSE * dSE) / 9.5) * 0.82 + exp(-(dNE * dNE) / 8.0) * 0.62;
        let hemiIn = 0.58 + 0.42 * clamp(n.y * 0.5 + 0.5, 0.0, 1.0);
        let roomLight = (vec3f(0.24, 0.22, 0.22) + vec3f(0.78, 0.50, 0.22) * warmPool) * hemiIn * ao;
        let paintedInt = col * 0.38 + intAlbedo * roomLight + vec3f(0.032, 0.018, 0.006) * warmPool * ao;
        col = mix(col, paintedInt, clamp(LK.u10.w, 0.0, 1.0));
      }
    }
  }\n`,
  })

  return base
    .replace(
      "let diffuse = max((ndl + wrap) / (1.0 + wrap), 0.0);",
      `let useLookLight = LK.u11.w > 0.5;
    let effWrap = select(wrap, wrap + LK.u10.x, useLookLight);
    let effBands = select(0.0, LK.u10.y, useLookLight);
    let effSoft = select(0.18, LK.u10.z, useLookLight);
    let diffuse = lookQuantizeDiffuse(ndl, effWrap, effBands, effSoft);`,
    )
    .replace(
      "col = albedo * (amb + direct + moon)",
      `if (lookUseAfter) {
      amb *= LK.u4.x * LK.u4.yzw;
    }
    let effMoon = select(moon, moon * LK.u5.z, lookUseAfter);
    col = albedo * (amb + direct + effMoon)`,
    )
    .replace(
      "return vec4f(select(col * a, col, mat == 22 && o.aux >= -1.5), a);",
      `let outRgb = select(col * a, col, mat == 22 && o.aux >= -1.5);
  let outAlpha = select(a, 1.0 - clamp(lookFlashIrradiance, 0.0, 1.0), a >= 0.999 && lookUseAfter);
  return vec4f(outRgb, outAlpha);`,
    )
}

/**
 * Opt-in Look-enabled post composite shader generator.
 * Binds `GradeAndLook` (8-float header + 64-float `LookUniforms`) at `@group(0) @binding(4)`.
 * Default `postShader` remains untouched for bit-exact identity under "Current".
 */
export const makeLookPostShader = (finish?: PostFinishOptions): string => /* wgsl */ `
${lookStructWgsl}
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

fn kuwaharaPost(uv: vec2f, texel: vec2f, strength: f32, center: vec3f) -> vec3f {
  let r1 = texel * (0.9 + strength * 0.7);
  let r2 = texel * (1.6 + strength * 1.1);
  let lw = vec3f(0.2126, 0.7152, 0.0722);
  let lC = dot(center, lw);
  var paintedSum = vec3f(0.0);
  var wSum = 0.0;
  for (var q = 0; q < 4; q++) {
    let sx = select(-1.0, 1.0, (q & 1) != 0);
    let sy = select(-1.0, 1.0, (q & 2) != 0);
    let d = vec2f(sx, sy);
    let c1 = clean(textureSampleLevel(src, samp, clamp(uv + d * r1, vec2f(0.002), vec2f(0.998)), 0.0)).rgb;
    let c2 = clean(textureSampleLevel(src, samp, clamp(uv + vec2f(d.x * r2.x, d.y * r1.y), vec2f(0.002), vec2f(0.998)), 0.0)).rgb;
    let c3 = clean(textureSampleLevel(src, samp, clamp(uv + vec2f(d.x * r1.x, d.y * r2.y), vec2f(0.002), vec2f(0.998)), 0.0)).rgb;
    let mean = (center + c1 + c2 + c3) * 0.25;
    let l1 = dot(c1, lw); let l2 = dot(c2, lw); let l3 = dot(c3, lw);
    let lm = (lC + l1 + l2 + l3) * 0.25;
    let v = (lC - lm)*(lC - lm) + (l1 - lm)*(l1 - lm) + (l2 - lm)*(l2 - lm) + (l3 - lm)*(l3 - lm);
    let w = 1.0 / (1.0 + v * 1400.0);
    paintedSum += mean * w;
    wSum += w;
  }
  return mix(center, paintedSum / max(wSum, 1e-5), clamp(strength, 0.0, 1.0));
}

@fragment fn composite(o: VO) -> @location(0) vec4f {
  let G = GL.G;
  let L = GL.L;
  let uv = o.uv;
  let dims = vec2f(textureDimensions(src));
  let texel = 1.0 / max(dims, vec2f(1.0));
  let fromC = uv - 0.5;

  let compareMode = i32(round(L.u12.w));
  let wipeSplit = L.u13.w;
  let useLook = select(compareMode == 1, uv.x >= wipeSplit, compareMode == 2) && L.u11.w > 0.5;

  let baseCA = ${finish ? finish.chromatic.toFixed(4) : "0.012"};
  let baseBloom = ${finish ? finish.bloom.toFixed(4) : "0.32"};
  let baseVig = ${finish ? finish.vignette.toFixed(4) : "0.45"};
  let baseGrain = ${finish ? finish.grain.toFixed(4) : "0.022"};
  let baseHuePres = ${finish?.huePreserve ? finish.huePreserve.toFixed(4) : "0.0"};
  let baseShadowLift = ${finish?.shadowLift === undefined ? "1.0" : finish.shadowLift.toFixed(4)};

  let bloom = textureSampleLevel(bloomTex, samp, uv, 0.0).rgb;
  ${finish?.diagnostics ? `if (G.y > 0.5) {
    var diagHdr = clean(textureSampleLevel(src, samp, uv, 0.0)).rgb;
    if (i32(G.y) == 5) { diagHdr = bloom * baseBloom; }
    return vec4f(pow(max(diagHdr, vec3f(0.0)), vec3f(1.0 / 2.2)), 1.0);
  }` : ""}

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

  // Active Look composite
  let centerSamp = clean(textureSampleLevel(src, samp, uv, 0.0));
  let flashMask = clamp(1.0 - centerSamp.a, 0.0, 1.0);
  let caAmt = baseCA + L.u9.w * 0.016;
  let ca = fromC * dot(fromC, fromC) * caAmt;
  var hdr: vec3f;
  if (L.u10.w > 0.01) {
    hdr = kuwaharaPost(uv, texel, L.u10.w, centerSamp.rgb);
  } else if (caAmt > 0.003) {
    hdr = vec3f(
      clean(textureSampleLevel(src, samp, clamp(uv + ca, vec2f(0.001), vec2f(0.999)), 0.0)).r,
      centerSamp.g,
      clean(textureSampleLevel(src, samp, clamp(uv - ca, vec2f(0.001), vec2f(0.999)), 0.0)).b,
    );
  } else {
    hdr = centerSamp.rgb;
  }

  // Ink / structural edge outlines
  if (L.u11.x > 0.001) {
    let stepUv = texel * L.u11.y;
    let cR = clean(textureSampleLevel(src, samp, clamp(uv + vec2f(stepUv.x, 0.0), vec2f(0.001), vec2f(0.999)), 0.0)).rgb;
    let cL = clean(textureSampleLevel(src, samp, clamp(uv - vec2f(stepUv.x, 0.0), vec2f(0.001), vec2f(0.999)), 0.0)).rgb;
    let cU = clean(textureSampleLevel(src, samp, clamp(uv - vec2f(0.0, stepUv.y), vec2f(0.001), vec2f(0.999)), 0.0)).rgb;
    let cD = clean(textureSampleLevel(src, samp, clamp(uv + vec2f(0.0, stepUv.y), vec2f(0.001), vec2f(0.999)), 0.0)).rgb;
    let grad = (length(cR - cL) + length(cU - cD)) / max(0.08, length(hdr) + 0.12);
    let edge = smoothstep(0.32, 0.95, grad) * clamp(L.u11.x, 0.0, 1.2);
    let inkCol = vec3f(0.03, 0.035, 0.055) * 0.66;
    hdr = mix(hdr, inkCol, clamp(edge, 0.0, 0.85));
  }

  var c = lookGradeColor(
    L,
    hdr * G.w,
    bloom,
    uv,
    o.pos.xy,
    G.x,
    clamp(L.u7.w * 0.35, 0.0, 1.0),
    baseBloom,
    baseVig,
    baseHuePres,
    flashMask,
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

@fragment fn compositeFast(o: VO) -> @location(0) vec4f {
  let G = GL.G;
  let L = GL.L;
  let uv = o.uv;
  let fromC = uv - 0.5;
  let baseBloom = ${finish ? finish.bloom.toFixed(4) : "0.32"};
  let baseVig = ${finish ? finish.vignette.toFixed(4) : "0.45"};
  let baseHuePres = ${finish?.huePreserve ? finish.huePreserve.toFixed(4) : "0.0"};

  let centerSamp = clean(textureSampleLevel(src, samp, uv, 0.0));
  let flashMask = clamp(1.0 - centerSamp.a, 0.0, 1.0);
  let bloom = textureSampleLevel(bloomTex, samp, uv, 0.0).rgb;
  ${finish?.diagnostics ? `if (G.y > 0.5) {
    var diagHdr = centerSamp.rgb;
    if (i32(G.y) == 5) { diagHdr = bloom * baseBloom; }
    return vec4f(pow(max(diagHdr, vec3f(0.0)), vec3f(1.0 / 2.2)), 1.0);
  }` : ""}

  let exposure = L.u0.x;
  let tonemapMode = i32(round(L.u0.y));
  let contrast = L.u0.z;
  let toe = L.u0.w;
  let shoulder = L.u1.x;
  let blackCrush = L.u1.y;
  let saturation = L.u1.z;
  let temperature = L.u1.w;
  let splitTone = L.u2.x;
  let shadowTint = L.u2.yzw;
  let highlightTint = L.u3.xyz;
  let bloomMult = L.u8.y;
  let halation = L.u8.z;
  let vigStrength = L.u8.w;
  let grainStrength = L.u9.x;
  let grainSeed = L.u9.y;
  let grainAnim = L.u9.z > 0.5;
  let selectiveColor = clamp(L.u15.w, 0.0, 1.5);
  let beamRetain = clamp(flashMask * selectiveColor, 0.0, 1.0);

  let halationTint = vec3f(1.08, 0.34, 0.10) * halation * 0.28;
  var hdr = centerSamp.rgb * G.w + bloom * (baseBloom * bloomMult + halationTint);
  let effTemp = mix(temperature, max(temperature, 0.06), beamRetain * 0.88);
  hdr = max(hdr * exposure * vec3f(1.0 + effTemp * 0.24, 1.0 + effTemp * 0.03, 1.0 - effTemp * 0.24), vec3f(0.0));
  if (abs(contrast - 1.0) > 0.001) {
    let hLum = max(dot(hdr, vec3f(0.2126, 0.7152, 0.0722)), 1e-4);
    hdr *= pow(hLum / 0.18, contrast - 1.0);
  }
  var c = lookApplyTonemapFast(hdr, tonemapMode, max(baseHuePres, beamRetain * 0.45));
  if (shoulder > 0.001) {
    let knee = 1.0 - shoulder * 0.45;
    let invSpan = 1.0 / max(1.0 - knee, 0.06);
    let over = max(c - vec3f(knee), vec3f(0.0)) * invSpan;
    let comp = min(c, vec3f(knee)) + (1.0 - knee) * (over / (vec3f(1.0) + over));
    c = mix(c, comp, clamp(shoulder, 0.0, 1.0));
  }
  let effToe = toe * (1.0 - 0.65 * beamRetain);
  if (effToe > 0.001) {
    let toeK = effToe * 0.055;
    let t = c * c / max(c + vec3f(toeK), vec3f(1e-5));
    c = mix(c, t * (1.0 + toeK * 0.5), clamp(effToe * 0.75, 0.0, 0.85));
  }
  let luma = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  let splitCurve = mix(shadowTint, highlightTint, smoothstep(0.02, 0.55, luma));
  let activeSplit = mix(vec3f(1.0), splitCurve, clamp(splitTone, 0.0, 1.5));
  let mono = vec3f(luma) * activeSplit;
  let hdrIn = centerSamp.rgb * G.w;
  let warmBias = clamp((hdrIn.r - hdrIn.b * 1.05) / max(hdrIn.r + 0.005, 1e-4) - 0.08, 0.0, 1.0) * clamp(L.u5.x * 1.6, 0.0, 1.0);
  let warmTinted = c * mix(activeSplit, vec3f(1.18, 0.88, 0.52), warmBias * 0.65);
  let effSat = mix(saturation, max(saturation, 0.88), warmBias * 0.82);
  let outsideCol = mix(mono, warmTinted, effSat);
  if (beamRetain > 0.001) {
    let beamSplit = mix(activeSplit, vec3f(1.05, 1.00, 0.94), beamRetain * 0.92);
    let beamSat = clamp(max(saturation, 1.15 * min(selectiveColor, 1.35)), 0.0, 1.55);
    let beamCol = mix(vec3f(luma) * beamSplit, c * beamSplit, beamSat);
    c = mix(outsideCol, beamCol, smoothstep(0.0, 1.0, beamRetain));
  } else {
    c = outsideCol;
  }
  let effCrush = blackCrush * (1.0 - 0.8 * beamRetain);
  if (effCrush > 0.0005) {
    let linearCrush = effCrush * 0.045;
    c = max(vec3f(0.0), (c - vec3f(linearCrush)) / max(1.0 - linearCrush, 0.1));
  }
  let vDist = length(fromC * vec2f(1.0, 0.82));
  let baseVigFactor = mix(1.0, baseVig, smoothstep(0.32, 0.85, vDist));
  let extraVig = 1.0 - clamp(vigStrength * 0.65, 0.0, 0.92) * smoothstep(0.20, 0.84, vDist);
  c *= baseVigFactor * extraVig;
  if (grainStrength > 0.001) {
    let timeSalt = select(0.0, floor(G.x * 24.0) * 19.37, grainAnim);
    let seedVec = vec2f(grainSeed * 1.13 + timeSalt, grainSeed * 2.71 - timeSalt * 0.63);
    let finePx = floor(o.pos.xy * 0.85) + seedVec;
    let grainVal = (hash(finePx) - 0.5) * 1.45;
    let midMask = smoothstep(0.004, 0.12, luma) * (1.0 - smoothstep(0.75, 1.0, luma));
    let amp = (0.026 + 0.008 * clamp(L.u7.w, 0.0, 1.0)) * grainStrength * (0.25 + 0.75 * midMask);
    c = max(vec3f(0.0), c + vec3f(grainVal * amp * max(luma * 2.2, 0.18)));
  }
  let v = length(fromC * vec2f(1.0, 0.8));
  c = mix(c, vec3f(0.55, 0.05, 0.06), G.z * smoothstep(0.25, 0.85, v));
  c = pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.2));
  return vec4f(clamp(c, vec3f(0.0), vec3f(1.0)), 1.0);
}
`
