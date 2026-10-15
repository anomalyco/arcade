import type { StylePresentationModule } from "./types"

export const hotlineNeonStyle: StylePresentationModule = {
  id: "hotline-neon",
  index: 7,
  name: "Hotline Neon",
  shortName: "Hotline Neon",
  tagline: "Crushed black voids, electric magenta & cyan neon edge/floor bounce, pulsing synth grid & CRT scanlines",
  defaultPeople: "blocky",
  defaults: {
    pixelSize: 180,
    palette: 0,
    outlineWidth: 1.5,
    dither: 0.8,
    halftoneSize: 5.0,
    rampSteps: 4,
    fxPunch: 1.35,
    pixelSnap: false,
  },
  palettes: ["Miami Magenta & Cyan", "Cyberpunk Acid Yellow", "Outrun Sunset Purple", "Blood Moon Synth"],
  scaling: {
    verdict: "scales",
    summary: "Scales to full Outbreak at +0.21 ms GPU; polar shadow pools naturally gate the neon floor grid and rim glow.",
    whatItTakes:
      "Map lamp colour temperatures to magenta/cyan/amber neon channels in the look shader and add world-grid emission gated by light irradiance.",
  },
  wgsl: /* wgsl */ `
fn evalStyle_7(uv: vec2f) -> vec3f {
  let texel = SU.viewport.zw;
  let aspect = SU.viewport.x * SU.viewport.w;
  let palIdx = i32(round(SU.params0.z));
  let pix = uv * SU.viewport.xy;

  // VHS chromatic aberration near frame edges
  let ca = (uv - 0.5) * 0.0045 * SU.params1.x;
  let cR = sSampleSceneSrgb(uv + ca).r;
  let cG = sSampleSceneSrgb(uv).g;
  let cB = sSampleSceneSrgb(uv - ca).b;
  let base = vec3f(cR, cG, cB);

  let nd = sSampleNormalDepth(uv);
  let aux = sSampleAux(uv);
  let wPos = sReconstructWorld(uv, nd.a);
  let luma = sLuma(base);

  var neonA = vec3f(1.0, 0.10, 0.56); // Electric Magenta
  var neonB = vec3f(0.0, 0.94, 1.0);  // Laser Cyan
  var neonC = vec3f(1.0, 0.72, 0.08); // Hot Amber
  if (palIdx == 1) {
    neonA = vec3f(0.85, 1.0, 0.08);
    neonB = vec3f(0.0, 0.95, 0.65);
  } else if (palIdx == 2) {
    neonA = vec3f(1.0, 0.32, 0.12);
    neonB = vec3f(0.68, 0.18, 1.0);
  } else if (palIdx == 3) {
    neonA = vec3f(1.0, 0.08, 0.18);
    neonB = vec3f(1.0, 0.55, 0.08);
  }

  // Crush shadows to deep synthwave void (#06040c), push lit pools into vibrant neon gradient
  let lit = smoothstep(0.06, 0.62, luma);
  let warmRatio = clamp((base.r - base.b) * 2.2 + 0.5, 0.0, 1.0);
  let poolCol = mix(neonB, mix(neonA, neonC, warmRatio * 0.65), warmRatio);
  var col = mix(vec3f(0.024, 0.014, 0.048), base * poolCol * 1.65, lit);

  // Glowing neon synth grid on the floor inside lit pools
  if (nd.y > 0.72 && wPos.y < 0.45 && aux.g < 0.1) {
    let g = abs(fract(wPos.xz * 1.0) - vec2f(0.5));
    let line = 1.0 - smoothstep(0.015, 0.045, min(0.5 - g.x, 0.5 - g.y));
    let gridNeon = mix(neonB, neonA, clamp((wPos.x - 23.0) / 13.0, 0.0, 1.0));
    col += gridNeon * line * (0.12 + 0.55 * lit) * clamp(SU.params1.y / 6.0, 0.2, 1.5);
  }

  // Blazing neon edge contours on walls, furniture, survivor & zombies
  let edges = sSampleEdges(uv, texel * max(0.9, SU.params0.w));
  let wallEdge = max(edges.x, edges.y * 0.85);
  let wallNeon = mix(neonB, neonA, uv.x);
  col += wallNeon * wallEdge * 0.85 * SU.params0.w;

  // Actor neon silhouette rims: cyan/gold survivor vs hot-magenta zombies
  if (abs(aux.g - 0.25) < 0.1) {
    col += mix(neonB, neonC, 0.5) * (0.28 + edges.z * 1.35);
  } else if (abs(aux.g - 0.50) < 0.1) {
    col += neonA * (0.32 + edges.z * 1.45 + aux.b * 0.85);
  }

  // Blazing yellow-magenta neon laser shot beam & radial spark burst
  let punch = SU.shotMeta.x * SU.params1.w;
  if (punch > 0.02) {
    let seg = sSegmentDist(uv, SU.shotScreen.xy, SU.shotScreen.zw, aspect);
    if (seg.y > 0.0 && seg.y < 1.0) {
      let core = exp(-seg.x * seg.x / 0.000006);
      let halo = exp(-seg.x * seg.x / 0.00018);
      col += (vec3f(1.0, 0.98, 0.75) * core * 1.4 + neonC * halo * 0.85) * min(1.4, punch);
    }
    let dMuz = length((uv - SU.shotScreen.xy) * vec2f(aspect, 1.0));
    col += neonC * exp(-dMuz * dMuz / 0.0008) * 1.2 * min(1.4, punch);
    if (SU.shotMeta.y > 0.05) {
      let dHit = length((uv - SU.shotScreen.zw) * vec2f(aspect, 1.0));
      let ang = atan2(uv.y - SU.shotScreen.w, (uv.x - SU.shotScreen.z) * aspect);
      let rays = 0.5 + 0.5 * cos(ang * 14.0 + SU.shotMeta.w);
      let burst = exp(-dHit * dHit / (0.0012 * (0.5 + 0.8 * rays)));
      col += mix(neonA, vec3f(1.0, 0.95, 0.65), burst * 0.7) * burst * 1.55 * min(1.4, punch);
    }
  }

  // CRT phosphor scanlines
  let scan = 1.0 - 0.18 * SU.params1.x * (0.5 + 0.5 * cos(pix.y * 3.14159));
  return clamp(col * scan, vec3f(0.0), vec3f(1.0));
}
`,
}
