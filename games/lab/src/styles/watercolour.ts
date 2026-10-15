import type { StylePresentationModule } from "./types"

export const watercolourStyle: StylePresentationModule = {
  id: "watercolour",
  index: 5,
  name: "Watercolour Wash",
  shortName: "Watercolour",
  tagline: "Cold-press cotton paper tooth, Kuwahara pigment pooling, darkened wet-edge rings & graphite under-drawing",
  defaultPeople: "capsule",
  defaults: {
    pixelSize: 160,
    palette: 0,
    outlineWidth: 1.1,
    dither: 0.75,
    halftoneSize: 6.5,
    rampSteps: 4,
    fxPunch: 1.2,
    pixelSnap: false,
  },
  palettes: ["Indigo & Burnt Sienna", "Warm Ochre Storybook", "Misty Prussian Blue", "Botanical Sepia Wash"],
  scaling: {
    verdict: "scales",
    summary: "Scales to full Outbreak at +0.32 ms GPU; builds directly on the existing Painterly Kuwahara post pass.",
    whatItTakes:
      "Add wet-edge pigment-ring darkening (colour-gradient edge accumulation) and cold-press paper granulation to look-shaders.ts.",
  },
  wgsl: /* wgsl */ `
fn evalStyle_5(uv: vec2f) -> vec3f {
  let texel = SU.viewport.zw;
  let aspect = SU.viewport.x * SU.viewport.w;
  let palIdx = i32(round(SU.params0.z));
  let pix = uv * SU.viewport.xy;

  // Organic watercolour bleed warp from multi-scale paper noise
  let bleedRadius = max(1.0, SU.params1.y * 0.45);
  let warp = vec2f(
    sNoise2(pix * 0.045 + vec2f(3.1, 7.4)) - 0.5,
    sNoise2(pix * 0.045 + vec2f(9.6, 1.8)) - 0.5
  ) * texel * bleedRadius * 2.2;
  let wUv = clamp(uv + warp, vec2f(0.002), vec2f(0.998));

  // 4-quadrant Kuwahara-lite wash pooling
  let r = texel * (1.2 + bleedRadius * 0.85);
  let cC  = sSampleSceneSrgb(wUv);
  let cNW = sSampleSceneSrgb(wUv + vec2f(-r.x, -r.y));
  let cNE = sSampleSceneSrgb(wUv + vec2f(r.x, -r.y));
  let cSW = sSampleSceneSrgb(wUv + vec2f(-r.x, r.y));
  let cSE = sSampleSceneSrgb(wUv + vec2f(r.x, r.y));
  var wash = (cC * 2.0 + cNW + cNE + cSW + cSE) / 6.0;

  // Pigment edge darkening (cauliflower wet-edge ring where wash transitions)
  let colorGrad = length(cNE - cSW) + length(cNW - cSE);
  let pigmentRing = smoothstep(0.08, 0.36, colorGrad);

  // Cold-press cotton paper granulation & warm cream paper reserve in highlights
  let paper = vec3f(0.95, 0.92, 0.85);
  let gran = (sNoise2(pix * 0.28) * 0.65 + sNoise2(pix * 0.09) * 0.35 - 0.5) * 0.14 * SU.params1.x;
  let luma = sLuma(wash);

  if (palIdx == 1) {
    wash *= vec3f(1.12, 1.02, 0.86);
  } else if (palIdx == 2) {
    wash = mix(wash, vec3f(luma) * vec3f(0.76, 0.90, 1.12), 0.45);
  } else if (palIdx == 3) {
    wash = mix(wash, vec3f(luma) * vec3f(1.08, 0.95, 0.78), 0.52);
  } else {
    // Indigo shadows + burnt sienna floorboards
    let sh = 1.0 - smoothstep(0.10, 0.48, luma);
    wash = mix(wash * vec3f(1.08, 0.96, 0.86), vec3f(0.18, 0.24, 0.38), sh * 0.48);
  }

  // Soften into paper base and darken wet pigment edges
  var col = mix(paper, wash, clamp(0.88 - pow(luma, 2.4) * 0.35, 0.25, 0.92));
  col *= 1.0 - pigmentRing * 0.26;
  col = clamp(col + gran, vec3f(0.0), vec3f(1.0));

  // Warm cadmium-orange watercolour bloom along active gunshot & zombie impact
  let punch = SU.shotMeta.x * SU.params1.w;
  if (punch > 0.02) {
    let seg = sSegmentDist(wUv, SU.shotScreen.xy, SU.shotScreen.zw, aspect);
    let bloomW = 0.032 * (0.7 + 0.6 * sNoise2(pix * 0.06));
    let washBeam = (1.0 - smoothstep(0.0, bloomW, seg.x)) * step(0.0, seg.y) * step(seg.y, 1.0);
    col = mix(col, vec3f(0.98, 0.58, 0.20), washBeam * 0.68 * min(1.2, punch));
    let dHit = length((wUv - SU.shotScreen.zw) * vec2f(aspect, 1.0));
    let hitWash = 1.0 - smoothstep(0.0, 0.055, dHit);
    col = mix(col, vec3f(0.86, 0.26, 0.18), hitWash * 0.65 * step(0.05, SU.shotMeta.y));
  }

  // Delicate graphite pencil under-drawing lines
  let outlineW = SU.params0.w;
  if (outlineW > 0.05) {
    let edges = sSampleEdges(wUv, texel * (0.9 + outlineW * 0.75));
    let pencil = max(edges.z * 0.9, max(edges.x * 0.75, edges.y * 0.55));
    let pencilBreak = 0.55 + 0.45 * sNoise2(pix * 0.35);
    col = mix(col, vec3f(0.20, 0.19, 0.22), clamp(pencil * pencilBreak * outlineW * 0.58, 0.0, 0.72));
  }

  return col;
}
`,
}
