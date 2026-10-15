import type { StylePresentationModule } from "./types"

export const inkHatchStyle: StylePresentationModule = {
  id: "ink-hatch",
  index: 4,
  name: "Ink Sketch Hatch",
  shortName: "Ink Hatch",
  tagline: "Fineliner contour ink & 3-tier cross-hatching on warm ivory sketchbook paper with crimson combat ink",
  defaultPeople: "capsule",
  defaults: {
    pixelSize: 160,
    palette: 0,
    outlineWidth: 1.4,
    dither: 0.7,
    halftoneSize: 5.5,
    rampSteps: 4,
    fxPunch: 1.3,
    pixelSnap: false,
  },
  palettes: ["Ivory & Crimson Ink", "Aged Da Vinci Sepia", "Charcoal & Chalk", "Blue Ballpoint Notebook"],
  scaling: {
    verdict: "partial",
    summary: "Cheap on GPU (+0.24 ms), but screen-space hatching swims during fast camera pans unless world-locked.",
    whatItTakes:
      "Project hatch UVs from world.xz + world.y (triplanar object/world hatching) and gate lamp pools by polar shadow visibility.",
  },
  wgsl: /* wgsl */ `
fn evalStyle_4(uv: vec2f) -> vec3f {
  let texel = SU.viewport.zw;
  let aspect = SU.viewport.x * SU.viewport.w;
  let palIdx = i32(round(SU.params0.z));

  // Hand-drawn domain-warped UV jitter for sketchy pen wobble
  let pix = uv * SU.viewport.xy;
  let wobble = vec2f(
    sNoise2(pix * 0.08 + vec2f(1.7, 9.2)) - 0.5,
    sNoise2(pix * 0.08 + vec2f(8.3, 2.4)) - 0.5
  ) * texel * 1.45 * SU.params0.w;
  let wUv = clamp(uv + wobble, vec2f(0.002), vec2f(0.998));

  let sceneCol = sSampleSceneSrgb(wUv);
  let aux = sSampleAux(wUv);
  let nd = sSampleNormalDepth(wUv);
  let wPos = sReconstructWorld(wUv, nd.a);

  // Paper base colour & tooth
  var paper = vec3f(0.95, 0.91, 0.84);
  var inkCol = vec3f(0.11, 0.10, 0.12);
  var accentCol = vec3f(0.78, 0.15, 0.13);
  if (palIdx == 1) {
    paper = vec3f(0.91, 0.83, 0.69);
    inkCol = vec3f(0.24, 0.15, 0.09);
  } else if (palIdx == 2) {
    paper = vec3f(0.22, 0.23, 0.25);
    inkCol = vec3f(0.06, 0.06, 0.07);
    accentCol = vec3f(0.88, 0.24, 0.20);
  } else if (palIdx == 3) {
    paper = vec3f(0.94, 0.95, 0.97);
    inkCol = vec3f(0.10, 0.20, 0.56);
  }

  let tooth = (sNoise2(pix * 0.35) - 0.5) * 0.055 * SU.params1.x;
  let vig = length((uv - 0.5) * vec2f(1.1, 1.35));
  paper = clamp(paper + tooth - vig * vig * 0.09, vec3f(0.0), vec3f(1.0));

  // World-assisted + screen hatch coordinates so floor planks and shadow tiers read with architectural pen strokes
  let hatchSpacing = max(2.2, SU.params1.y);
  let pScreen = pix / hatchSpacing;
  let pWorld = (wPos.xz * 14.0 + vec2f(wPos.y * 8.0)) / (hatchSpacing * 0.22);
  let hCoord = mix(pScreen, pWorld, 0.55) + wobble * 120.0;

  let luma = clamp(sLuma(sceneCol) * 1.42, 0.0, 1.0);
  let darkness = 1.0 - luma;

  // Tier 1: 45-degree primary parallel pen hatch in midtones
  let s1 = abs(fract((hCoord.x + hCoord.y) * 0.7071) * 2.0 - 1.0);
  let h1 = 1.0 - smoothstep(0.18, 0.42, s1);
  // Tier 2: -45-degree cross-hatch in darker shadows
  let s2 = abs(fract((hCoord.x - hCoord.y) * 0.7071) * 2.0 - 1.0);
  let h2 = 1.0 - smoothstep(0.20, 0.44, s2);
  // Tier 3: horizontal wood-grain / deep shadow pen strokes
  let s3 = abs(fract(hCoord.y * 1.35) * 2.0 - 1.0);
  let h3 = 1.0 - smoothstep(0.18, 0.40, s3);

  var inkDensity = 0.0;
  if (darkness > 0.24) {
    inkDensity = max(inkDensity, h1 * smoothstep(0.24, 0.52, darkness) * 0.65);
  }
  if (darkness > 0.48) {
    inkDensity = max(inkDensity, h2 * smoothstep(0.48, 0.74, darkness) * 0.78);
  }
  if (darkness > 0.70) {
    inkDensity = max(inkDensity, h3 * smoothstep(0.70, 0.92, darkness) * 0.88);
  }

  // Darken actor silhouettes with dense ink cross-hatch
  if (aux.g > 0.15 && aux.g < 0.65) {
    inkDensity = max(inkDensity, 0.45 + 0.35 * h1);
  }

  // Fineliner contour ink lines from depth, normal & actor silhouettes
  let edges = sSampleEdges(wUv, texel * (0.95 + SU.params0.w * 0.85));
  let contour = clamp(max(edges.z * 1.2, max(edges.x * 1.05, edges.y * 0.72)), 0.0, 1.0);
  inkDensity = clamp(max(inkDensity, contour * clamp(SU.params0.w * 0.82, 0.0, 1.0)), 0.0, 0.96);

  var col = mix(paper, inkCol, inkDensity);

  // Chalk highlight in palette 2
  if (palIdx == 2 && luma > 0.55) {
    col = mix(col, vec3f(0.92, 0.90, 0.84), smoothstep(0.55, 0.92, luma) * 0.75);
  }

  // Crimson red ink splash on zombie hitFlash & active gunshot tracer
  var redInk = clamp(aux.b * 0.85, 0.0, 1.0);
    let punch = SU.shotMeta.x * SU.params1.w;
    if (punch > 0.02) {
      let seg = sSegmentDist(wUv, SU.shotScreen.xy, SU.shotScreen.zw, aspect);
      let streak = (1.0 - smoothstep(0.0, 0.0055, seg.x)) * step(0.02, seg.y) * step(seg.y, 0.99);
      redInk = max(redInk, streak * min(1.0, punch));
      let dHit = length((wUv - SU.shotScreen.zw) * vec2f(aspect, 1.0));
      if (dHit < 0.055 && SU.shotMeta.y > 0.05) {
        let spatterNoise = clamp(sNoise2(pix * 0.22 + SU.shotMeta.w), 0.25, 1.0);
        let outerR = 0.014 + 0.036 * spatterNoise;
        let splash = 1.0 - smoothstep(0.006, outerR, dHit);
        redInk = max(redInk, splash * 0.95);
      }
    }
  col = mix(col, accentCol, clamp(redInk, 0.0, 0.92));

  return col;
}
`,
}
