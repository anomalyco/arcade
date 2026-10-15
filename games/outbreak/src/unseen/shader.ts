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
 * Scene-shader snippet for the 5 Unseen modes:
 * Keeps the 4x MSAA scene pass branch-free on `uMode` so VGPR pressure stays identical to `main`,
 * while encoding the MSAA-resolved per-pixel unseen weight (`outbreakUnseenAlpha = wUnseen * 4.0`)
 * into `targets.hdr.a` and preserving subtle architectural silhouette contrast in explored rooms.
 */
export const unseenSceneSnippet = wgslSnippet(
  "outbreakUnseenScene",
  /* wgsl */ `
var<private> outbreakUnseenAlpha: f32;

fn fieldSight3(world: vec3f, n: vec3f) -> vec3f {
  let fv = textureSampleLevel(visField, floorSamp, (world.xz + n.xz * 0.09 - OL.win.xy) * F.map.xy, 0.0).rgb;
  let dEye = length(world.xz - lights[0].pos.xz);
  let gate = 1.0 - smoothstep(lights[0].pos.w - 0.6, lights[0].pos.w + 0.4, dEye);
  let vis = fv.x * gate;
  let edgeD = max(fv.z, 1.0 - gate);
  return vec3f(vis, fv.y, edgeD);
}

fn applyOutbreakUnseenScene(
  colIn: vec3f,
  baseFowCol: vec3f,
  world: vec3f,
  n: vec3f,
  baseColor: vec3f,
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
  let distScale = mix(0.38, 1.0, clamp(edgeDepth, 0.0, 1.0));
  let wUnseen = clamp(unseenRaw * distScale * OL.unseen.strength, 0.0, 1.5);
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
  let distScale = mix(0.38, 1.0, clamp(sight.z, 0.0, 1.0));
  let wUnseen = clamp(unseenRaw * distScale * OL.unseen.strength, 0.0, 1.5);
  outbreakUnseenAlpha = wUnseen * 4.0;
  let luma = dot(colIn, vec3f(0.2126, 0.7152, 0.0722));
  let dimCol = vec3f(luma) * vec3f(0.62, 0.74, 1.02) * 0.48;
  return mix(colIn, dimCol, clamp(unseenRaw * 0.85, 0.0, 0.95));
}
`,
)

/**
 * Post-process composite snippet for the 5 Unseen modes (`makeLookPostShader` and `postShader`).
 * Reads `unseenMask` from `centerSamp.a` (`(centerSamp.a - 1.0) * 0.25`) and `postParam.yzw` (`[mode, strength, updateRate]`).
 * Modes 1 and 2 use a single displaced HDR sample (deriving chromatic edge split from `sDisp - centerSamp`),
 * and Modes 3–5 use 0 extra texture samples, keeping 3456×1894 GPU cost well under 0.5 ms.
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
  if (postParam.y < 0.5 || postParam.z <= 0.001) {
    return cIn;
  }
  let unseenMask = clamp((centerSamp.a - 1.0) * 0.25, 0.0, 1.5);
  if (unseenMask <= 0.001) {
    return cIn;
  }
  let uMode = i32(round(postParam.y));
  let uRate = max(2.0, postParam.w);
  let amt = clamp(unseenMask, 0.0, 1.35);
  let blendW = clamp(unseenMask * 0.95, 0.0, 1.0);
  var c = cIn;

  // Mode 1: Acid Knife glitch — stepped low-Hz block & scanline UV tear, chroma split, cold slate-indigo wash
  if (uMode == 1) {
    let qTime = floor(G.x * uRate);
    let rowFine = floor(uv.y * 156.0);
    let rowCoarse = floor(uv.y * 34.0);
    let blk = floor(uv * vec2f(26.0, 44.0));
    let tearFine = step(0.44, hash(vec2f(rowFine, qTime * 1.73)));
    let tearCoarse = step(0.64, hash(vec2f(rowCoarse, qTime * 2.39)));
    let tearBlk = step(0.56, hash(blk + vec2f(qTime * 0.91, -qTime * 1.47)));
    let dx = (
      (hash(vec2f(rowFine * 2.3, qTime * 3.1)) - 0.5) * 0.028 * tearFine +
      (hash(vec2f(rowCoarse * 1.9, qTime * 0.7)) - 0.5) * 0.056 * tearCoarse +
      (hash(blk * 1.3 + qTime) - 0.5) * 0.036 * tearBlk
    ) * amt;
    let dy = (hash(blk * 2.1 - qTime * 1.3) - 0.5) * 0.015 * tearBlk * amt;
    let uvDisp = clamp(uv + vec2f(dx, dy), vec2f(0.002), vec2f(0.998));
    let sDisp = clean(textureSampleLevel(src, samp, uvDisp, 0.0));
    // Gate displaced tap so bright flashlight core pixels don't duplicate deep into unseen regions
    let wDisp = clamp((sDisp.a - 0.95) * 1.6, 0.20, 1.0);
    let cLuma = dot(c, vec3f(0.2126, 0.7152, 0.0722));
    let centerHdrLuma = max(dot(centerSamp.rgb, vec3f(0.2126, 0.7152, 0.0722)), 2e-4);
    let dispHdrLuma = dot(mix(centerSamp.rgb, sDisp.rgb, wDisp), vec3f(0.2126, 0.7152, 0.0722));
    let lumaRatio = clamp(dispHdrLuma / centerHdrLuma, 0.0, 2.2);
    let gLuma = clamp(cLuma * lumaRatio, 0.0, 1.0);
    let tearActive = max(tearFine * 0.65, max(tearCoarse, tearBlk));
    let lumaDelta = (gLuma - cLuma) * tearActive;
    let chromaSplit = vec3f(lumaDelta * 1.65, abs(lumaDelta) * 0.22, -lumaDelta * 1.85);
    let scanMod = 0.86 + 0.14 * sin(fragPos.y * 1.85);
    let qLuma = mix(gLuma, floor(gLuma * 10.0 + 0.5) / 10.0, 0.35 * max(tearCoarse, tearBlk));
    let acidCol = (vec3f(qLuma) * vec3f(0.56, 0.70, 1.12) * 0.76 + chromaSplit) * scanMod;
    return mix(c, max(vec3f(0.0), acidCol), blendW);
  }

  // Mode 2: Warp wobble — continuous two-octave domain-warped refraction outside the cone
  if (uMode == 2) {
    let wTime = G.x * (0.16 * uRate);
    let p1 = uv * vec2f(15.0, 10.0);
    let w1 = vec2f(
      sin(p1.y * 1.35 + wTime) + cos(p1.x * 1.15 - wTime * 0.75),
      cos(p1.x * 1.25 + wTime * 0.85) - sin(p1.y * 1.15 + wTime * 0.65),
    ) * 0.5;
    let p2 = uv * vec2f(31.0, 20.0) + w1 * 1.85;
    let w2 = vec2f(sin(p2.y + wTime * 1.35), cos(p2.x - wTime * 1.15));
    let warp = (w1 * 0.015 + w2 * 0.006) * amt;
    let sWarp = clean(textureSampleLevel(src, samp, clamp(uv + warp, vec2f(0.002), vec2f(0.998)), 0.0));
    let wGate = clamp((sWarp.a - 0.95) * 1.6, 0.20, 1.0);
    let cLuma = dot(c, vec3f(0.2126, 0.7152, 0.0722));
    let centerHdrLuma = max(dot(centerSamp.rgb, vec3f(0.2126, 0.7152, 0.0722)), 2e-4);
    let warpHdrLuma = dot(mix(centerSamp.rgb, sWarp.rgb, wGate), vec3f(0.2126, 0.7152, 0.0722));
    let wLuma = clamp(cLuma * clamp(warpHdrLuma / centerHdrLuma, 0.0, 2.2), 0.0, 1.0);
    let prismDiff = (wLuma - cLuma) * 0.65;
    let caustic = 0.89 + 0.11 * sin(p2.x * 0.8 + p2.y * 0.8);
    let warpCol = (vec3f(wLuma) * vec3f(0.66, 0.88, 1.12) * 0.74 + vec3f(-prismDiff * 0.4, prismDiff * 0.25, prismDiff * 0.85)) * caustic;
    return mix(c, max(vec3f(0.0), warpCol), clamp(unseenMask * 0.92, 0.0, 1.0));
  }

  // Mode 3: Dark shroud — classic darker & desaturated fog of war with soft edges
  if (uMode == 3) {
    let cLuma = dot(c, vec3f(0.2126, 0.7152, 0.0722));
    let shroudDark = mix(1.0, 0.22, clamp(amt * 0.88, 0.0, 0.94));
    let shroudMono = vec3f(cLuma) * vec3f(0.80, 0.88, 1.06);
    let shroudCol = mix(c, shroudMono, clamp(amt * 0.94, 0.0, 0.98)) * shroudDark;
    return shroudCol;
  }

  // Mode 4: Stale memory — faded archival snapshot tone curve with lifted dusty toe and static stillness
  if (uMode == 4) {
    let cLuma = dot(c, vec3f(0.2126, 0.7152, 0.0722));
    let isExplored = smoothstep(0.001, 0.008, cLuma);
    let paperGrain = (hash(floor(fragPos * 0.5)) - 0.5) * 0.018 * isExplored;
    let snapTone = vec3f(0.012, 0.011, 0.0095) * isExplored + vec3f(max(0.0, cLuma * 0.66 + paperGrain)) * vec3f(1.08, 0.96, 0.82);
    return mix(c, snapTone, clamp(unseenMask * 0.88, 0.0, 0.95));
  }

  // Mode 5: Noise film — heavy 16mm grain and ordered Bayer dither thickening away from sight
  let fTime = floor(G.x * uRate);
  let cLuma = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  let gCoarse = hash(floor(fragPos * 0.5) + vec2f(fTime * 17.3, -fTime * 11.7)) - 0.5;
  let gFine = hash(floor(fragPos) + vec2f(-fTime * 23.1, fTime * 31.9)) - 0.5;
  let grain = gCoarse * 0.75 + gFine * 0.50;
  let bp = vec2u(fragPos) % 4u;
  let bIdx = bp.y * 4u + bp.x;
  let bayer = (f32(((bIdx & 1u) << 3u) | ((bIdx & 2u) << 1u) | ((bIdx & 4u) >> 1u) | ((bIdx & 8u) >> 3u)) + 0.5) / 16.0 - 0.5;
  let silverBase = vec3f(cLuma) * vec3f(0.86, 0.92, 1.04) * mix(1.0, 0.45, clamp(amt * 0.75, 0.0, 0.86));
  let noiseVeil = (grain * 0.16 + bayer * 0.10) * amt * (0.35 + 0.65 * smoothstep(0.0, 0.24, cLuma + 0.04));
  let noisyCol = max(vec3f(0.0), silverBase + vec3f(noiseVeil));
  return mix(c, noisyCol, blendW);
}
`,
)

export const outbreakUnseenFieldWgsl = resolveWgsl(unseenFieldSnippet)
export const outbreakUnseenSceneWgsl = resolveWgsl(unseenSceneSnippet)
export const outbreakUnseenPostWgsl = resolveWgsl(unseenPostSnippet)
export const outbreakUnseenPostHookWgsl = "c = applyOutbreakUnseenPost(c, centerSamp, uv, o.pos.xy, G, GL.pad);"
export const outbreakUnseenPostBaselineHookWgsl =
  "c = applyOutbreakUnseenPost(c, clean(textureSampleLevel(src, samp, uv, 0.0)), uv, o.pos.xy, G, grade.look);"
