import type { StylePresentationModule } from "./types"

export const papercraftStyle: StylePresentationModule = {
  id: "papercraft",
  index: 3,
  name: "Papercraft Low-Poly",
  shortName: "Papercraft",
  tagline: "Flat-faceted geometric planes, white folded-paper ridge highlights, cut-paper drop shadows & cardstock grain",
  defaultPeople: "blocky",
  defaults: {
    pixelSize: 180,
    palette: 0,
    outlineWidth: 1.3,
    dither: 0.55,
    halftoneSize: 5.0,
    rampSteps: 5,
    fxPunch: 1.1,
    pixelSnap: false,
  },
  palettes: ["Warm Cardstock", "Pastel Origami", "Kraft & Charcoal", "Autumn Diorama"],
  scaling: {
    verdict: "scales",
    summary: "Scales to full Outbreak at +0.18 ms GPU; works natively with Outbreak's 24-byte procedural box/prism meshes.",
    whatItTakes:
      "Bake per-vertex bevel/bottom tone into v.color.a (as planned in rendering-techniques.md §1) and suppress high-frequency surface textures.",
  },
  wgsl: /* wgsl */ `
fn evalStyle_3(uv: vec2f) -> vec3f {
  let texel = SU.viewport.zw;
  let aspect = SU.viewport.x * SU.viewport.w;
  let palIdx = i32(round(SU.params0.z));

  // Sample smoothed base colour so procedural wood/plaster micro-grit turns into clean matte construction paper
  let c0 = sSampleSceneSrgb(uv);
  let cR = sSampleSceneSrgb(uv + vec2f(texel.x * 2.0, 0.0));
  let cL = sSampleSceneSrgb(uv - vec2f(texel.x * 2.0, 0.0));
  let cU = sSampleSceneSrgb(uv - vec2f(0.0, texel.y * 2.0));
  let cD = sSampleSceneSrgb(uv + vec2f(0.0, texel.y * 2.0));
  var paperCol = (c0 * 2.0 + cR + cL + cU + cD) / 6.0;

  // Reconstruct world position & screen-space flat facet normal via finite differences
  let ndC = sSampleNormalDepth(uv);
  let ndR = sSampleNormalDepth(uv + vec2f(texel.x, 0.0));
  let ndD = sSampleNormalDepth(uv + vec2f(0.0, texel.y));
  let wC = sReconstructWorld(uv, ndC.a);
  let wR = sReconstructWorld(uv + vec2f(texel.x, 0.0), ndR.a);
  let wD = sReconstructWorld(uv + vec2f(0.0, texel.y), ndD.a);
  let facetN = normalize(cross(wD - wC, wR - wC));
  let n = normalize(mix(ndC.xyz, facetN, 0.65));

  // Quantise directional paper facet shading into crisp folded steps
  let keyDir = normalize(vec3f(-0.45, 0.78, -0.42));
  let facetShade = clamp(dot(n, keyDir) * 0.5 + 0.5, 0.0, 1.0);
  let steps = max(3.0, round(SU.params1.z));
  let qFacet = floor(facetShade * steps) / (steps - 1.0);
  paperCol = mix(paperCol, pow(paperCol, vec3f(0.88)) * vec3f(1.06, 1.01, 0.93), 0.42);
  paperCol *= 0.78 + 0.34 * qFacet;

  if (palIdx == 1) {
    paperCol = mix(paperCol, vec3f(0.92, 0.89, 0.86), 0.25);
  } else if (palIdx == 2) {
    let l = sLuma(paperCol);
    paperCol = mix(vec3f(l) * vec3f(1.08, 0.96, 0.80), paperCol, 0.35);
  } else if (palIdx == 3) {
    paperCol *= vec3f(1.12, 0.95, 0.82);
  }

  // Cut-paper drop shadow offset below depth discontinuities (layered cardstock depth)
  let shadowOffsetUv = uv - texel * vec2f(2.4, 3.2) * max(0.5, SU.params0.w);
  let ndCaster = sSampleNormalDepth(shadowOffsetUv);
  let dropJump = clamp((ndC.a - ndCaster.a) / max(ndC.a * 0.035, 0.08), 0.0, 1.0);
  paperCol *= 1.0 - 0.42 * smoothstep(0.18, 0.65, dropJump);

  // White folded-paper crease highlight along convex normal edges + subtle dark seam in concave corners
  let edges = sSampleEdges(uv, texel * max(0.8, SU.params0.w));
  let ridge = edges.y * (1.0 - edges.x * 0.75);
  paperCol = mix(paperCol, vec3f(0.99, 0.97, 0.92), clamp(ridge * 0.55 * SU.params0.w, 0.0, 0.75));
  paperCol *= 1.0 - clamp(edges.x * 0.35 * SU.params0.w, 0.0, 0.55);

  // Fine matte cardstock paper fiber grain
  let fiber = (sNoise2(uv * SU.viewport.xy * 0.45) - 0.5) * 0.06 * SU.params1.x;
  paperCol = clamp(paperCol + fiber, vec3f(0.0), vec3f(1.0));

  // Folded-paper geometric muzzle flash & paper-strip tracer
  let punch = SU.shotMeta.x * SU.params1.w;
  if (punch > 0.02) {
    let seg = sSegmentDist(uv, SU.shotScreen.xy, SU.shotScreen.zw, aspect);
    if (seg.x < 0.0045 && seg.y > 0.02 && seg.y < 0.98) {
      paperCol = mix(paperCol, vec3f(1.0, 0.88, 0.52), 1.0 - smoothstep(0.0018, 0.0045, seg.x));
    }
    let dm = abs((uv - SU.shotScreen.xy) * vec2f(aspect, 1.0));
    let diamond = dm.x + dm.y;
    if (diamond < 0.026) {
      paperCol = select(vec3f(0.98, 0.68, 0.28), vec3f(1.0, 0.96, 0.84), diamond < 0.013);
    }
  }

  return paperCol;
}
`,
}
