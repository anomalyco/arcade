import { resolveWgsl, wgslSnippet, wgslStruct } from "@arcade/kit/gpu/wgsl"

/**
 * Typed WGSL uniform struct for the Unseen effect, embedded in `OutbreakLightingUniforms` (`@group(0) @binding(13)`).
 * Aligned to 16 bytes (8 floats = 32 bytes).
 */
export const unseenUniformsStruct = wgslStruct("UnseenUniforms", {
  mode: "f32",
  strength: "f32",
  edgeSoftness: "f32",
  updateRate: "f32",
  nightFactor: "f32",
  flashCosHalf: "f32",
  flashActive: "f32",
  hideZombies: "f32",
})

/**
 * Visibility-field compute helper snippet (`visibilityFieldShader`):
 * - Counts anything inside the local survivor's active flashlight cone (unoccluded by walls/doors) as seen.
 * - Boosts the close 360-degree awareness circle around the survivor's body when Unseen is active.
 * - Computes `edgeDepth` (0..1 distance from the visible cone/blocker/awareness edge) for `.b` of `visField`.
 */
export const unseenFieldSnippet = wgslSnippet(
  "outbreakUnseenField",
  /* wgsl */ `
fn evalUnseenFlashCone(p: vec2f, soft: f32, eyeRayVis: f32) -> f32 {
  if (OL.unseen.flashActive < 0.5 || OL.u4.z <= 0.005) { return 0.0; }
  let fDelta = p - OL.u3.xy;
  let fDist = length(fDelta);
  let fRange = max(2.0, OL.u4.y);
  if (fDist >= fRange) { return 0.0; }
  if (fDist < 0.12) { return 1.0; }
  let fDir = fDelta / fDist;
  let fFacing = dot(fDir, OL.u3.zw);
  let fFeather = 0.04 + 0.16 * soft;
  let fCos = OL.unseen.flashCosHalf;
  let coneW = smoothstep(fCos - fFeather, fCos + fFeather * 0.75, fFacing);
  if (coneW <= 0.0) { return 0.0; }
  let rangeW = 1.0 - smoothstep(fRange - (1.0 + 2.0 * soft), fRange, fDist);
  var fOcc = eyeRayVis;
  if (OL.u4.w >= 1.0) {
    let fAng = (atan2(fDelta.y, fDelta.x) + TAU) % TAU;
    let fRay = u32(i32(floor(fAng / TAU * f32(RAYS))) + i32(RAYS)) % RAYS;
    let fHit = polar[(u32(OL.u4.w) * RAYS + fRay) * 2u].x;
    let slotVis = 1.0 - smoothstep(fHit - 0.04, fHit + 0.14, fDist);
    fOcc = max(eyeRayVis, slotVis);
  }
  return coneW * rangeW * fOcc;
}

fn evalUnseenEdgeDepth(sX: f32, sY: f32, p: vec2f) -> f32 {
  if (sX >= 0.998) { return 0.0; }
  let d = length(p - lights[0].pos.xz);
  let soft = clamp(OL.unseen.edgeSoftness, 0.1, 2.0);
  let awareMeters = max(0.0, d - F.effects.z);
  let span = max(1.0, 3.4 * soft);
  let ramp = smoothstep(0.0, span, awareMeters * 0.65 + (1.0 - sX) * 1.35 + (1.0 - sY) * 0.45);
  return clamp((1.0 - sX) * (0.30 + 0.70 * ramp), 0.0, 1.0);
}
`,
)

/**
 * Scene-shader snippet for the Unseen modes and combinable layers:
 * Keeps the 4x MSAA scene pass branch-free on `uMode` so VGPR pressure stays identical to `main`,
 * while encoding the MSAA-resolved normalized spatial unseen mask (`outbreakUnseenAlpha = wUnseen * 4.0`)
 * into `targets.hdr.a` (`1.0 + outbreakUnseenAlpha`).
 */
export const unseenSceneSnippet = wgslSnippet(
  "outbreakUnseenScene",
  /* wgsl */ `
var<private> outbreakUnseenAlpha: f32;

fn fieldSight3(world: vec3f, n: vec3f) -> vec3f {
  let uv = (world.xz + n.xz * 0.09 - OL.win.xy) * F.map.xy;
  let inWin = select(1.0, 0.0, OL.win.z > 0.5 && (any(uv < vec2f(0.003)) || any(uv > vec2f(0.997))));
  let fv = textureSampleLevel(visField, floorSamp, uv, 0.0).rgb * inWin;
  let dEyeV = world.xz - lights[0].pos.xz;
  let r0 = max(0.0, lights[0].pos.w - 0.6);
  let r1 = lights[0].pos.w + 0.4;
  let gate = 1.0 - smoothstep(r0 * r0, r1 * r1, dot(dEyeV, dEyeV));
  let vis = fv.x * gate;
  let edgeD = max(fv.z, 1.0 - gate);
  return vec3f(vis, fv.y, edgeD);
}

fn applyOutbreakUnseenScene(
  colIn: vec3f,
  baseFowCol: vec3f,
  world: vec3f,
  n: vec3f,
  inRoom: bool,
  mat: i32,
  visible: f32,
  explored: f32,
  edgeDepth: f32,
) -> vec3f {
  if (OL.unseen.mode < 0.5 || OL.unseen.strength <= 0.001 || visible >= 0.996) {
    outbreakUnseenAlpha = 0.0;
    return baseFowCol;
  }
  let unseenRaw = clamp(1.0 - visible, 0.0, 1.0);
  var distScale = mix(0.38, 1.0, clamp(edgeDepth, 0.0, 1.0));
  if (OL.rampOn.z > 0.5) { distScale = outbreakRamp(2u, edgeDepth); }
  let wUnseen = clamp(unseenRaw * distScale, 0.0, 1.0);
  outbreakUnseenAlpha = wUnseen * 4.0;
  return baseFowCol;
}

fn applyOutbreakUnseenActor(colIn: vec3f, world: vec3f, n: vec3f) -> vec3f {
  if (OL.unseen.mode < 0.5 || OL.unseen.strength <= 0.001) {
    outbreakUnseenAlpha = 0.0;
    return colIn;
  }
  if (length(world.xz - OL.u6.xy) < 0.55) {
    outbreakUnseenAlpha = 0.0;
    return colIn;
  }
  let sight = fieldSight3(world, n);
  outbreakSeen = sight.x;
  if (sight.x >= 0.996) {
    outbreakUnseenAlpha = 0.0;
    return colIn;
  }
  let unseenRaw = clamp(1.0 - sight.x, 0.0, 1.0);
  var distScale = mix(0.38, 1.0, clamp(sight.z, 0.0, 1.0));
  if (OL.rampOn.z > 0.5) { distScale = outbreakRamp(2u, sight.z); }
  let wUnseen = clamp(unseenRaw * distScale, 0.0, 1.0);
  outbreakUnseenAlpha = wUnseen * 4.0;
  let luma = dot(colIn, vec3f(0.2126, 0.7152, 0.0722));
  let dimCol = vec3f(luma) * vec3f(0.62, 0.74, 1.02) * 0.48;
  return mix(colIn, dimCol, clamp(unseenRaw * 0.85, 0.0, 0.95));
}
`,
)

/**
 * Post-process composite snippet for the 5 combinable Unseen layers (`makeLookPostShader` and `postShader`).
 * Unpacks the 5 layer weights (`wGlitch`, `wWarp`, `wShroud`, `wMemory`, `wNoise`), `uEdgeBand`, and `uRate`
 * from `postParam.yzw` (`GL.pad.yzw`), and reads the MSAA-resolved spatial mask `unseenMask` from `centerSamp.a`.
 * Even when Glitch and Warp are combined, they share a single displaced HDR sample (`lumaRatio = dispHdrLuma / centerHdrLuma`),
 * keeping full-Retina 3456×1894 GPU cost under 0.35 ms for any solo mode or multi-layer combination.
 */
export const unseenPostSnippet = wgslSnippet(
  "outbreakUnseenPost",
  /* wgsl */ `
fn applyOutbreakUnseenPost(
  cIn: vec3f,
  centerSamp: vec4f,
  uv: vec2f,
  fragPos: vec2f,
  G: vec4f,
  postParam: vec4f,
) -> vec3f {
  if (postParam.y <= 0.0 && postParam.z <= 0.0 && postParam.w <= 0.0) {
    return cIn;
  }
  let unseenMask = clamp((centerSamp.a - 1.0) * 0.25, 0.0, 1.0);
  if (unseenMask <= 0.001) {
    return cIn;
  }
  let py = u32(postParam.y + 0.5);
  let pz = u32(postParam.z + 0.5);
  let pw = u32(postParam.w + 0.5);
  let wGlitch = f32(py & 4095u) * (1.0 / 1024.0);
  let wWarp = f32((py >> 12u) & 4095u) * (1.0 / 1024.0);
  let wShroud = f32(pz & 4095u) * (1.0 / 1024.0);
  let wMemory = f32((pz >> 12u) & 4095u) * (1.0 / 1024.0);
  let wNoise = f32(pw & 1023u) * (1.0 / 256.0);
  if (wGlitch + wWarp + wShroud + wMemory + wNoise <= 0.001) {
    return cIn;
  }
  let uEdgeBand = f32((pw >> 10u) & 127u) * (1.0 / 127.0);
  let uRate = max(2.0, f32((pw >> 17u) & 63u));

  let mFull = unseenMask;
  let edgeBell = smoothstep(0.01, 0.16, unseenMask) * (1.0 - smoothstep(0.24, 0.68, unseenMask));
  let mGlitch = mix(mFull, edgeBell * 1.25, uEdgeBand);

  let aGlitch = clamp(mGlitch * wGlitch, 0.0, 1.4);
  let aWarp = clamp(mFull * wWarp, 0.0, 1.4);
  let aShroud = clamp(mFull * wShroud, 0.0, 1.4);
  let aMemory = clamp(mFull * wMemory, 0.0, 1.4);
  let aNoise = clamp(mFull * wNoise, 0.0, 1.4);

  var c = cIn;
  var lumaRatio = 1.0;
  var tearFine = 0.0;
  var tearCoarse = 0.0;
  var tearBlk = 0.0;
  var caustic = 1.0;

  // Combined spatial displacement (at most 1 texture fetch even when Acid Knife glitch + Warp wobble are layered)
  if (aGlitch > 0.002 || aWarp > 0.002) {
    var uvOffset = vec2f(0.0);
    if (aGlitch > 0.002) {
      let qTime = floor(G.x * uRate);
      let rowFine = floor(uv.y * 156.0);
      let rowCoarse = floor(uv.y * 34.0);
      let blk = floor(uv * vec2f(26.0, 44.0));
      tearFine = step(0.44, hash(vec2f(rowFine, qTime * 1.73)));
      tearCoarse = step(0.64, hash(vec2f(rowCoarse, qTime * 2.39)));
      tearBlk = step(0.56, hash(blk + vec2f(qTime * 0.91, -qTime * 1.47)));
      let dx = (
        (hash(vec2f(rowFine * 2.3, qTime * 3.1)) - 0.5) * 0.028 * tearFine +
        (hash(vec2f(rowCoarse * 1.9, qTime * 0.7)) - 0.5) * 0.056 * tearCoarse +
        (hash(blk * 1.3 + qTime) - 0.5) * 0.036 * tearBlk
      ) * aGlitch;
      let dy = (hash(blk * 2.1 - qTime * 1.3) - 0.5) * 0.015 * tearBlk * aGlitch;
      uvOffset += vec2f(dx, dy);
    }
    if (aWarp > 0.002) {
      let wTime = G.x * (0.16 * uRate);
      let p1 = uv * vec2f(15.0, 10.0);
      let w1 = vec2f(
        sin(p1.y * 1.35 + wTime) + cos(p1.x * 1.15 - wTime * 0.75),
        cos(p1.x * 1.25 + wTime * 0.85) - sin(p1.y * 1.15 + wTime * 0.65),
      ) * 0.5;
      let p2 = uv * vec2f(31.0, 20.0) + w1 * 1.85;
      let w2 = vec2f(sin(p2.y + wTime * 1.35), cos(p2.x - wTime * 1.15));
      caustic = 0.89 + 0.11 * sin(p2.x * 0.8 + p2.y * 0.8);
      uvOffset += (w1 * 0.015 + w2 * 0.006) * aWarp;
    }
    let uvDisp = clamp(uv + uvOffset, vec2f(0.002), vec2f(0.998));
    let sDisp = clean(textureSampleLevel(src, samp, uvDisp, 0.0));
    // Gate displaced tap so bright flashlight core pixels don't duplicate deep into unseen regions
    let wDisp = clamp((sDisp.a - 0.95) * 1.6, 0.20, 1.0);
    let centerHdrLuma = max(dot(centerSamp.rgb, vec3f(0.2126, 0.7152, 0.0722)), 2e-4);
    let dispHdrLuma = dot(mix(centerSamp.rgb, sDisp.rgb, wDisp), vec3f(0.2126, 0.7152, 0.0722));
    lumaRatio = clamp(dispHdrLuma / centerHdrLuma, 0.0, 2.2);
  }

  // Layer 4: Stale memory — faded archival snapshot tone curve with lifted dusty toe
  if (aMemory > 0.002) {
    let cLuma = dot(c, vec3f(0.2126, 0.7152, 0.0722));
    let memLuma = cLuma * mix(1.0, lumaRatio, clamp(aWarp * 0.85, 0.0, 1.0));
    let isExplored = smoothstep(0.001, 0.008, memLuma);
    let paperGrain = (hash(floor(fragPos * 0.5)) - 0.5) * 0.018 * isExplored;
    let snapTone = vec3f(0.012, 0.011, 0.0095) * isExplored + vec3f(max(0.0, memLuma * 0.66 + paperGrain)) * vec3f(1.08, 0.96, 0.82);
    c = mix(c, snapTone, clamp(aMemory * 0.88, 0.0, 0.95));
  }

  // Layer 2: Warp wobble — continuous two-octave domain-warped refraction outside the cone
  if (aWarp > 0.002) {
    let cLuma = dot(c, vec3f(0.2126, 0.7152, 0.0722));
    let wLuma = clamp(cLuma * lumaRatio, 0.0, 1.0);
    let prismDiff = (wLuma - cLuma) * 0.65;
    let warpTint = mix(vec3f(0.66, 0.88, 1.12) * 0.74, vec3f(0.92, 0.96, 1.04) * 0.86, clamp(aMemory * 0.75, 0.0, 0.75));
    let warpCol = (vec3f(wLuma) * warpTint + vec3f(-prismDiff * 0.4, prismDiff * 0.25, prismDiff * 0.85)) * caustic;
    c = mix(c, max(vec3f(0.0), warpCol), clamp(aWarp * 0.92, 0.0, 1.0));
  }

  // Layer 3: Dark shroud — classic darker & desaturated fog of war with soft penumbra fade
  if (aShroud > 0.002) {
    let cLuma = dot(c, vec3f(0.2126, 0.7152, 0.0722));
    let shroudDark = mix(1.0, 0.22, clamp(aShroud * 0.88, 0.0, 0.94));
    let shroudMono = vec3f(cLuma) * vec3f(0.80, 0.88, 1.06);
    c = mix(c, shroudMono, clamp(aShroud * 0.94, 0.0, 0.98)) * shroudDark;
  }

  // Layer 1: Acid Knife glitch — stepped low-Hz block & scanline UV tear, chroma split, cold slate-indigo wash
  if (aGlitch > 0.002) {
    let cLuma = dot(c, vec3f(0.2126, 0.7152, 0.0722));
    let gLuma = clamp(cLuma * lumaRatio, 0.0, 1.0);
    let tearActive = max(tearFine * 0.65, max(tearCoarse, tearBlk));
    let lumaDelta = (gLuma - cLuma) * tearActive;
    let chromaSplit = vec3f(lumaDelta * 1.65, abs(lumaDelta) * 0.22, -lumaDelta * 1.85);
    let scanMod = 0.86 + 0.14 * sin(fragPos.y * 1.85);
    let qLuma = mix(gLuma, floor(gLuma * 10.0 + 0.5) / 10.0, 0.35 * max(tearCoarse, tearBlk));
    let acidCol = (vec3f(qLuma) * vec3f(0.56, 0.70, 1.12) * 0.76 + chromaSplit) * scanMod;
    c = mix(c, max(vec3f(0.0), acidCol), clamp(aGlitch * 0.95, 0.0, 1.0));
  }

  // Layer 5: Noise film — heavy 16mm silver-halide grain and ordered Bayer dither thickening away from sight
  if (aNoise > 0.002) {
    let fTime = floor(G.x * uRate);
    let cLuma = dot(c, vec3f(0.2126, 0.7152, 0.0722));
    let gCoarse = hash(floor(fragPos * 0.5) + vec2f(fTime * 17.3, -fTime * 11.7)) - 0.5;
    let gFine = hash(floor(fragPos) + vec2f(-fTime * 23.1, fTime * 31.9)) - 0.5;
    let grain = gCoarse * 0.75 + gFine * 0.50;
    let bp = vec2u(fragPos) % 4u;
    let bIdx = bp.y * 4u + bp.x;
    let bayer = (f32(((bIdx & 1u) << 3u) | ((bIdx & 2u) << 1u) | ((bIdx & 4u) >> 1u) | ((bIdx & 8u) >> 3u)) + 0.5) / 16.0 - 0.5;
    let otherDark = clamp(aShroud * 0.75 + aMemory * 0.35 + aGlitch * 0.35, 0.0, 0.85);
    let silverDim = mix(1.0, mix(0.45, 0.88, otherDark), clamp(aNoise * 0.75, 0.0, 0.86));
    let silverBase = mix(c, vec3f(cLuma) * vec3f(0.86, 0.92, 1.04), clamp(aNoise * 0.85, 0.0, 0.95)) * silverDim;
    let noiseVeil = (grain * 0.16 + bayer * 0.10) * aNoise * (0.38 + 0.62 * smoothstep(0.0, 0.24, cLuma + 0.05));
    let noisyCol = max(vec3f(0.0), silverBase + vec3f(noiseVeil));
    c = mix(c, noisyCol, clamp(aNoise * 0.95, 0.0, 1.0));
  }

  return c;
}
`,
)

export const outbreakUnseenFieldWgsl = resolveWgsl(unseenFieldSnippet)
export const outbreakUnseenSceneWgsl = resolveWgsl(unseenSceneSnippet)
export const outbreakUnseenPostWgsl = resolveWgsl(unseenPostSnippet)
export const outbreakUnseenPostHookWgsl = "c = applyOutbreakUnseenPost(c, centerSamp, uv, o.pos.xy, G, GL.pad);"
export const outbreakUnseenPostBaselineHookWgsl =
  "c = applyOutbreakUnseenPost(c, clean(textureSampleLevel(src, samp, uv, 0.0)), uv, o.pos.xy, G, grade.look);"
